"use strict";

const { targetOfRef } = require("./snapshot-target");

const MASKED = "(masked)";
const REF = /^(?:f\d+)?e\d+$/;
// An affirmative roster: a newly installed tool cannot acquire a new output path.
const SAFE_TOOLS = new Set([
  "browser_snapshot", "browser_find", "browser_take_screenshot", "browser_wait_for",
  "browser_navigate", "browser_navigate_back", "browser_tabs", "browser_close",
  "browser_click", "browser_type", "browser_fill_form", "browser_select_option",
  "browser_press_key", "browser_hover", "browser_drag", "browser_handle_dialog",
  "browser_resize", "browser_file_upload", "browser_drop",
]);
const bounded = async work => {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), 2000); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
};
const failure = () => new Error("Browser privacy could not be verified. No page output was released.");

// This state belongs to the isolated utility world, never to page JavaScript.
function privacyState() {
  const key = Symbol.for("hoai.browser.answerPrivacy");
  const state = globalThis[key] ||= { fields: new WeakSet(), pending: new Set() };
  state.hosts ||= new WeakSet();
  return state;
}

// Runs in the page, using element identity rather than its ARIA role or text layout.
function inspectElement(element) {
  if (privacyState().hosts.has(element)) return { control: false, safe: false };
  const security = getComputedStyle(element).webkitTextSecurity;
  const masked = element.type === "password" || !!security && security !== "none";
  const control = masked || privacyState().fields.has(element) || element.matches('input,textarea,select,button,output,[contenteditable],[role=textbox],[role=searchbox],[role=combobox]');
  if (!control) return { control: false, safe: true };
  const description = [element.name, element.id, element.getAttribute("autocomplete"), element.getAttribute("aria-label"), element.getAttribute("placeholder"), ...Array.from(element.labels || [], label => label.textContent)].join(" ");
  const secret = /password|passcode|one.time.code|otp|secret|token|api.?key|credential|card.?number|cc-|cvc|cvv|security.?code|recovery|seed.?phrase|\bpin\b/i.test(description);
  const label = element.getAttribute("aria-label") || Array.from(element.labels || [], label => label.textContent).join(" ") || element.getAttribute("placeholder") || "";
  const state = privacyState();
  if (masked || secret || element.type === "hidden") state.fields.add(element);
  return { control, label, safe: !state.fields.has(element) };
}

// One frame read, including shadow trees. Both the current value and the value
// attribute are private. No truncation, role exemption, or swallowed read failure.
function collectProtected(includeProofs, initialRoot = document) {
  const state = privacyState(), values = [], proofs = {}, roots = [initialRoot];
  let size = 0, protectedControl = false;
  while (roots.length) {
    const root = roots.pop();
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
      const proof = inspectElement(element);
      if (includeProofs && element._ariaRef?.ref) proofs[element._ariaRef.ref] = proof;
      if (proof.safe) continue;
      protectedControl = true;
      for (const value of [element.value, element.getAttribute("value"), element.textContent]) {
        if (!value) continue;
        size += value.length;
        if (size > 1024 * 1024) throw new Error("privacy capacity");
        state.pending.add(value);
      }
    }
  }
  let pendingSize = 0;
  for (const value of state.pending) {
    values.push(value);
    pendingSize += value.length;
    if (pendingSize > 1024 * 1024) throw new Error("privacy capacity");
  }
  return { values, proofs, protected: protectedControl };
}

// The existing in-process connection is the authority. Native node resolution
// also inspects closed component trees, with no page-forgeable exemptions.
// No additional CDP session, endpoint, or bridge permission is introduced.
const installedHooks = new WeakSet();
async function prepareFrame(page, frame) {
  const impl = page._connection?.toImpl?.(frame);
  if (typeof impl?.utilityContext !== "function") throw failure();
  const utility = await impl.utilityContext(), client = utility?.delegate?._client;
  if (typeof client?.send !== "function" || typeof impl._id !== "string" || !Number.isInteger(utility.delegate._contextId)) throw failure();
  if (!installedHooks.has(utility)) {
    const injected = await utility.injectedScript();
    const source = `(injected => {
      const privacyState = ${privacyState.toString()};
      const inspectElement = ${inspectElement.toString()};
      const collectProtected = ${collectProtected.toString()};
      const state = privacyState();
      state.read = (includeProofs, root) => {
        const data = collectProtected(includeProofs, root);
        if (root?.host && data.protected) { state.fields.add(root.host); state.hosts.add(root.host); }
        state.pending.clear();
        return data;
      };
      injected[Symbol.for("hoai.browser.privateRead")] = state.read;
      const capture = injected.ariaSnapshotJSON;
      if (typeof capture !== "function") throw new Error("privacy unavailable");
      injected.ariaSnapshotJSON = function(...args) {
        collectProtected(false);
        const result = capture.apply(this, args);
        collectProtected(false);
        return result;
      };
    })`;
    await injected.evaluate((injected, source) => (0, eval)(source)(injected), source);
    installedHooks.add(utility);
  }
  return { client, frameId: impl._id, contextId: utility.delegate._contextId, injected: await utility.injectedScript() };
}
async function closedRoots(client, defaultFrameId) {
  await client.send("DOM.enable");
  const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  if (!root) throw failure();
  const nodes = [{ node: root, frameId: root.frameId || defaultFrameId }], closed = [];
  while (nodes.length) {
    const { node, frameId } = nodes.pop();
    if (node.shadowRootType === "closed") closed.push({ backendNodeId: node.backendNodeId, frameId });
    for (const child of [...node.children || [], ...node.shadowRoots || []]) nodes.push({ node: child, frameId });
    if (node.contentDocument) nodes.push({ node: node.contentDocument, frameId: node.contentDocument.frameId || node.frameId || frameId });
  }
  return closed;
}
async function inspectClosed(prepared) {
  const data = [];
  for (const client of new Set(prepared.map(item => item.client))) {
    const contexts = prepared.filter(item => item.client === client);
    for (const root of (await closedRoots(client, contexts[0].frameId)).reverse()) {
      const context = contexts.find(item => item.frameId === root.frameId);
      if (!context || !Number.isInteger(root.backendNodeId)) throw failure();
      const { object } = await client.send("DOM.resolveNode", { backendNodeId: root.backendNodeId, executionContextId: context.contextId });
      if (!object?.objectId) throw failure();
      try {
        const reply = await client.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
          functionDeclaration: 'function() { return globalThis[Symbol.for("hoai.browser.answerPrivacy")].read(false, this); }' });
        if (reply.exceptionDetails || !reply.result?.value) throw failure();
        data.push(reply.result.value);
      } finally { await client.send("Runtime.releaseObject", { objectId: object.objectId }); }
    }
  }
  return data;
}

// Fixed host code reads the same isolated world that creates the snapshot.
// Calling the existing server-side handle avoids selector registry timing and
// never registers a model-accessible evaluation or writes a page artifact.
async function pageFacts(page, includeProofs = true) {
  const values = [], proofs = {};
  let protectedControl = false;
  const frames = page.frames();
  if (!frames.length) throw failure();
  const prepared = [];
  for (const frame of frames) prepared.push(await prepareFrame(page, frame));
  const reads = await inspectClosed(prepared);
  for (const { injected } of prepared) reads.push(await injected.evaluate((injected, includeProofs) => injected[Symbol.for("hoai.browser.privateRead")](includeProofs), includeProofs));
  for (const data of reads) {
    if (!Array.isArray(data.values) || !data.proofs || typeof data.proofs !== "object") throw failure();
    values.push(...data.values);
    protectedControl ||= data.protected === true;
    Object.assign(proofs, data.proofs);
  }
  return { values, proofs, protected: protectedControl };
}

class AnswerPrivacy {
  #values = new Set();
  #pages = new WeakSet();
  #tabs = new WeakSet();
  #failed = false;
  #protectedSeen = false;

  async collect(pages) {
    if (this.#failed) throw failure();
    try {
      for (const page of pages) {
        const data = await bounded(pageFacts(page, false));
        this.#protectedSeen ||= data.protected === true;
        this.#remember(data.values);
      }
      if ([...this.#values].reduce((size, value) => size + value.length, 0) > 2 * 1024 * 1024) throw failure();
    } catch { this.#failed = true; throw failure(); }
  }

  #remember(values) {
    for (const value of values) {
      const json = JSON.stringify(value).slice(1, -1);
      const variants = [value, json, JSON.stringify(json).slice(1, -1), encodeURIComponent(value), encodeURI(value),
        Buffer.from(value).toString("base64"), value.replaceAll("'", "''"),
        value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"),
        ...value.split(/\r?\n/)];
      for (const variant of variants) if (variant) this.#values.add(variant);
    }
    if ([...this.#values].reduce((size, value) => size + value.length, 0) > 2 * 1024 * 1024) throw failure();
  }

  text(text) {
    if (this.#failed) throw failure();
    for (const value of [...this.#values].sort((a, b) => b.length - a.length)) text = text.split(value).join(MASKED);
    return text;
  }

  error(message) {
    if (this.#failed) throw failure();
    return (this.#protectedSeen || this.#values.size) ? "Browser command failed. Protected page details were withheld." : this.text(message);
  }

  value(value, { trustedRefusal = false } = {}) {
    if (this.#failed) throw failure();
    if (value?.isError === true && !trustedRefusal) return { isError: true, content: [{ type: "text", text: "Browser command failed. No page details were released." }] };
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map(part => this.value(part));
    if (!value || typeof value !== "object") return value;
    // Image bytes cannot be string-redacted. Once a protected control was seen,
    // no pixels are released for the rest of this driver connection.
    if (value.type === "image" && (this.#protectedSeen || this.#values.size)) return { type: "text", text: "Image withheld to protect form values." };
    if (value.type && !["text", "image"].includes(value.type)) return { type: "text", text: "Unsupported browser output withheld." };
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.value(child)]));
  }

  validate(args) {
    if (args && Object.hasOwn(args, "isolatedContext")) throw new Error("Named browser contexts are not available.");
    const targets = [args?.target, args?.startTarget, args?.endTarget, ...(args?.fields || []).map(field => field.target)].filter(value => value !== undefined);
    if (targets.some(value => typeof value !== "string" || !REF.test(value))) throw new Error("Browser targets must be host element refs. Read a snapshot first.");
  }

  async tree(text, page) {
    try {
      const lines = text.split("\n"), result = [];
      let hiddenIndent = -1;
      const { values, proofs, protected: protectedControl } = await bounded(pageFacts(page, true));
      this.#protectedSeen ||= protectedControl;
      this.#remember(values);
      for (const line of lines) {
        const indent = line.search(/\S/);
        if (hiddenIndent >= 0 && indent > hiddenIndent) continue;
        hiddenIndent = -1;
        const ref = [...line.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map(match => match[1]).find(candidate => targetOfRef(line, candidate));
        if (ref) {
          const proof = proofs[ref];
          if (proof?.safe !== true) {
            const role = proof?.control === true ? targetOfRef(line, ref)?.role || "generic" : "generic";
            const label = proof?.control === true && proof.label ? ` ${JSON.stringify(this.text(proof.label).slice(0, 200))}` : "";
            result.push(`${" ".repeat(Math.max(0, indent))}- ${role}${label} [ref=${ref}]: ${MASKED}`);
            hiddenIndent = indent;
            continue;
          }
        }
        result.push(line);
      }
      return this.text(result.join("\n"));
    } catch { this.#failed = true; throw failure(); }
  }

  protectPage(page) {
    if (this.#pages.has(page)) return;
    this.#pages.add(page);
    const read = page.ariaSnapshot.bind(page);
    page.ariaSnapshot = async options => { await this.collect([page]); return this.tree(await read(options), page); };
    // The output boundary accepts the guarded textual tree only.
    page.ariaSnapshotJSON = async () => { throw failure(); };
  }

  protectTab(tab) {
    if (this.#tabs.has(tab)) return;
    this.#tabs.add(tab);
    this.protectPage(tab.page);
    const capture = tab.captureSnapshot;
    if (typeof capture !== "function") throw failure();
    tab.captureSnapshot = async (...args) => {
      if (args[0]) await this.collect([tab.page]);
      const snapshot = await capture.apply(tab, args);
      if (snapshot) { snapshot.events = []; delete snapshot.consoleLink; }
      if (args[0] && typeof snapshot?.ariaSnapshot === "string") snapshot.ariaSnapshot = await this.tree(snapshot.ariaSnapshot, tab.page);
      if (snapshot?.ariaSnapshotJSON) throw failure();
      return snapshot;
    };
  }

  guardResponse(name, params, response) {
    if (typeof response?._writeFile !== "function" || typeof response?.addFileResult !== "function" || typeof response?.addCode !== "function" || typeof response?.addError !== "function") throw failure();
    response._writeFile = async () => { throw failure(); };
    response.addFileResult = async () => {};
    response.addCode = () => {};
    const addError = response.addError.bind(response);
    response.addError = () => addError("Browser command failed. No page details were released.");
    const { filename, ...safe } = params || {};
    if (safe.json) throw new Error("Use the protected textual browser snapshot.");
    return safe;
  }
}
module.exports = { AnswerPrivacy, SAFE_TOOLS, MASKED, inspectElement, pageFacts };
