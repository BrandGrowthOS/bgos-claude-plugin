"use strict";
// The one owner of what a browser answer may carry. Byte identical on the desktop and the machine host.
//
// While a secret field holds a value, or has held one in this document, the page belongs to
// the person. Tools and cards receive one fixed line until a real navigation releases it.
// Empty fields remain readable, but the agent cannot type into a secret field.
//
// The isolated-world seal and each frame's random proof remain a second wall. A frame without
// proof loses its contents. A final net holds values of at least 6 characters, longest first,
// scoped to this site. Opaque control identities replace typed prefixes without removing a
// different field's shorter value. Gates judge original facts and display filtered facts.
//
// A failed read fails that one call. A filled secret locks its document until a real navigation.
// No em dashes or en dashes anywhere in this file.

const { randomBytes } = require("crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

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
// A tool that acts on an element waits for a good read. These do not: they are how an agent leaves a stuck page.
const MOVES_AWAY = new Set(["browser_navigate", "browser_navigate_back", "browser_tabs", "browser_close", "browser_handle_dialog", "browser_resize"]);

const READ_MS = 8000; // the page in use, including a busy main thread
const FRAME_MS = 800; // one child frame: it costs that reply its contents, never the page
const READY_MS = 50; // an existing world answers at once, so a frame still loading is known quickly
const TREE_MS = 15000; // one tree. A slow frame is not entered at all, so this bounds a very large or stuck page
const DESCRIBE_MS = 1500;
const WAIT_MS = 5000;
const WAIT_MAX_MS = 30000;
const WAIT_STEP_MS = 150;
const NET_MIN = 6;
const NET_VALUES = 64;
const NET_VALUE_MAX = 4096;
const NAMES_MAX = 64;
const PAINT = "#808080";
const SETTLE_MS = 80; // a new document's first read waits this long, so a burst of frames is one read

const UNREADABLE = "This page could not be read safely just now. Nothing from it was released. Try again.";
const FAILED = "Browser command failed. No page details were released.";
const HANDOFF = "A password is on this page. You finish it here, and I will carry on when the page changes.";
const PERSON = "You finish this password field here. I cannot type into it.";
const QUESTION = "Is this filled field private? Finish it here if it is. Allow once only if it is an ordinary field.";
const COPY = Object.freeze({
  en: Object.freeze({ handoff: HANDOFF, person: PERSON, question: QUESTION }),
  ar: Object.freeze({ handoff: "توجد كلمة مرور في هذه الصفحة. أكملها هنا، وسأتابع عندما تتغير الصفحة.", person: "أكمل حقل كلمة المرور هنا بنفسك. لا يمكنني الكتابة فيه.", question: "هل هذا الحقل المعبأ خاص؟ أكمله هنا إن كان كذلك. اسمح مرة واحدة فقط إذا كان حقلا عاديا." }),
});
const WITHHELD = "Image withheld: this page shows a protected field. Use browser_snapshot to read the page.";
const DIALOG = "A browser dialog is waiting. Answer it with browser_handle_dialog before anything else on this page.";
const CHOOSER = "A file chooser is open on this page. Answer it with browser_file_upload before anything else.";
const failure = () => Object.assign(new Error(UNREADABLE), { code: "privacy_unavailable" });

// Password style parameter names, masked in any address whatever their value. Exact names, so pageToken stays.
const SECRET_PARAM = /^(?:pass|passwd|password|passcode|pwd|pin|otp|cvv|cvc|secret|api_?key|access_?token|client_?secret)$/i;

// ── Everything below this line up to the next rule runs in the isolated world ─────────────────────

function sealTheWorld(nonce) {
  const key = Symbol.for("hoai.browser.answerPrivacy");
  if (globalThis[key]) { globalThis[key].proof = nonce; return globalThis[key]; }
  const state = globalThis[key] = { proof: nonce, fields: new WeakSet(), unread: new WeakSet(), pending: new Set(), names: new Set(), capturing: 0, sealedCache: null, held: false, uncertain: false, structure: 0, anySeal: false, documentId: crypto.randomUUID?.() || String(Math.random()), roots: new Set() };
  const MASK = "(masked)", MIN = 6, MAX = 4096, COUNT = 64;
  const trueStyle = window.getComputedStyle.bind(window);
  const styles = new WeakMap();
  state.agentFields = new WeakSet();
  state.agentWriting = false;
  const getters = new Map();
  const trueGet = (proto, prop) => {
    const found = Object.getOwnPropertyDescriptor(proto, prop);
    if (!found?.get) return null;
    getters.set(`${proto.constructor?.name}.${prop}`, found.get);
    return found;
  };
  const parentOf = node => node.assignedSlot || node.parentNode || node.host || null;
  // Sealed: the element, a text node under it, or anything inside it. The answer is kept for one build.
  const sealedOf = node => {
    if (!state.anySeal) return false;
    const cache = state.sealedCache;
    if (cache?.has(node)) return cache.get(node);
    let answer = state.fields.has(node);
    if (!answer) { const up = parentOf(node); answer = !!up && sealedOf(up); }
    cache?.set(node, answer);
    return answer;
  };
  state.sealedOf = sealedOf;
  // A sealed read says it holds something, or nothing, and what it holds stays where it is.
  const seal = (proto, prop) => {
    const found = trueGet(proto, prop);
    if (!found) return;
    Object.defineProperty(proto, prop, { ...found, get() {
      const value = found.get.call(this);
      if (!state.capturing || !state.anySeal || !sealedOf(this)) return value;
      if (typeof value === "number") return 0;
      return typeof value === "string" && value.trim() ? MASK : "";
    } });
  };
  for (const [proto, prop] of [[HTMLInputElement.prototype, "value"], [HTMLInputElement.prototype, "defaultValue"], [HTMLTextAreaElement.prototype, "value"], [HTMLTextAreaElement.prototype, "defaultValue"], [HTMLSelectElement.prototype, "value"], [HTMLOptionElement.prototype, "value"], [HTMLOptionElement.prototype, "text"], [HTMLOptionElement.prototype, "label"], [HTMLButtonElement.prototype, "value"], [HTMLOutputElement.prototype, "value"], [HTMLDataElement.prototype, "value"], [HTMLMeterElement.prototype, "value"], [HTMLProgressElement.prototype, "value"], [HTMLLIElement.prototype, "value"], [Node.prototype, "nodeValue"], [CharacterData.prototype, "data"], [Text.prototype, "wholeText"], [Element.prototype, "innerHTML"], [Element.prototype, "outerHTML"]]) seal(proto, prop);
  // A parent's whole text is built from its children, so a sealed child cannot ride along in it.
  const trueText = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  const composed = node => {
    if (sealedOf(node)) return trueText.get.call(node)?.trim() ? MASK : "";
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return trueText.get.call(node);
    let text = "";
    for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType !== Node.COMMENT_NODE) text += composed(child);
    return text;
  };
  Object.defineProperty(Node.prototype, "textContent", { ...trueText, get() { return state.capturing && state.anySeal ? composed(this) : trueText.get.call(this); } });
  for (const prop of ["innerText", "outerText"]) {
    const found = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    if (found?.get) Object.defineProperty(HTMLElement.prototype, prop, { ...found, get() { return state.capturing && state.anySeal ? composed(this) : found.get.call(this); } });
  }
  // CSS content can quote an attribute, so a sealed element keeps only the attributes that say what it is.
  const STRUCTURAL = new Set(["role", "type", "id", "class", "name", "style", "hidden", "disabled", "tabindex", "contenteditable", "slot", "for", "form", "autocomplete", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-disabled", "aria-expanded", "aria-checked", "aria-pressed", "aria-selected", "aria-level", "aria-owns", "aria-invalid", "aria-required", "placeholder"]);
  const getAttribute = Element.prototype.getAttribute;
  Element.prototype.getAttribute = function(name) {
    const value = getAttribute.call(this, name);
    return value !== null && state.capturing && state.anySeal && sealedOf(this) && !STRUCTURAL.has(String(name).toLowerCase()) ? "" : value;
  };
  window.getComputedStyle = function(element, pseudo) {
    const style = trueStyle(element, pseudo);
    if (!state.capturing || !state.anySeal || !element || !sealedOf(element)) return style;
    return new Proxy(style, { get(target, prop) { if (prop === "content") return "none"; const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value; } });
  };

  const trueValue = element => {
    const proto = element.constructor?.prototype;
    for (let up = proto; up; up = Object.getPrototypeOf(up)) {
      const found = getters.get(`${up.constructor?.name}.value`);
      if (found) { const value = found.call(element); return typeof value === "string" ? value : ""; }
    }
    return "";
  };
  const trueContent = element => trueText.get.call(element) || "";
  const description = element => [getAttribute.call(element, "name"), element.id, getAttribute.call(element, "autocomplete"), getAttribute.call(element, "aria-label"), getAttribute.call(element, "title"), getAttribute.call(element, "placeholder"),
    ...(getAttribute.call(element, "aria-labelledby") || "").split(/\s+/).filter(Boolean).map(id => trueContent(element.getRootNode().getElementById?.(id) || document.getElementById(id) || document.createTextNode(""))),
    ...Array.from(element.labels || [], label => trueContent(label))]
    .join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ");
  const SECRET = /\b(?:pass ?words?|passphrases?|passwd|passcodes?|pwd|one time|totp|otp|secrets?|(?:access|auth|api|bearer|refresh|id) tokens?|api ?keys?|credentials?|card ?numbers?|cc (?:number|num|csc|exp)|cvc|cvv|csc|(?:security|verification|recovery) codes?|recovery keys?|seed phrases?|private keys?|social security number)\b|كلمة (?:المرور|مرور)|رمز (?:التحقق|الأمان)|مفتاح (?:خاص|سري)/i;
  const HOLDS = "input:not([type=hidden],[type=button],[type=submit],[type=reset],[type=image],[type=checkbox],[type=radio],[type=file],[type=range],[type=color]),textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=searchbox],[role=combobox]";
  const hidden = element => element.localName === "input" && element.type === "hidden";
  // This decision reads descriptions and styles, never a field's words.
  const judge = element => {
    if (state.fields.has(element)) return true;
    if (hidden(element)) return false;
    let style = styles.get(element);
    if (!style) { style = trueStyle(element); styles.set(element, style); }
    const security = style.webkitTextSecurity;
    if (element.localName === "input" && element.type === "password" || (security && security !== "none") || /text[-_ ]?security|password[-_ ]?(?:disc|dot)|dotsfont/i.test(style.fontFamily) || (Element.prototype.matches.call(element, HOLDS) && SECRET.test(description(element)))) {
      state.anySeal = true; state.fields.add(element);
      noteName(element);
      return true;
    }
    return false;
  };
  const noteName = element => { const name = element.name || getAttribute.call(element, "name"); if (name && state.names.size < COUNT) state.names.add(String(name)); };
  const remember = (value, element) => {
    const held = typeof value === "string" ? value.trim() : "";
    if (held.length >= MIN) {
      if (element) {
        const prior = state.previous.get(element); if (prior) state.pending.delete(prior);
        state.previous.set(element, held.slice(0, MAX));
        if (!state.fieldIds.has(element)) state.fieldIds.set(element, `${state.documentId}:${++nextField}`);
        const id = state.fieldIds.get(element);
        if (state.pendingFields.has(id) || state.pendingFields.size < COUNT) state.pendingFields.set(id, held.slice(0, MAX));
      }
      if (state.pending.size < COUNT) state.pending.add(held.slice(0, MAX));
    }
  };
  state.previous = new WeakMap();
  state.fieldIds = new WeakMap();
  state.pendingFields = new Map();
  state.uncertainIds = new Set();
  state.approvedIds = new Set();
  let nextField = 0;
  const walk = (root, visit) => {
    const roots = [root];
    if (root !== document && root.nodeType === Node.ELEMENT_NODE) visit(root);
    while (roots.length) {
      const next = roots.pop();
      for (const element of next.querySelectorAll("*")) {
        visit(element);
        if (element.shadowRoot) { state.observe?.(element.shadowRoot); roots.push(element.shadowRoot); }
      }
      if (next.shadowRoot && !roots.includes(next.shadowRoot)) roots.push(next.shadowRoot);
    }
  };
  const judgeAll = (root = document) => walk(root, judge);
  // What a sealed element holds, or the empty string. A subtree is read once, from its top.
  const holding = element => {
    const held = element.matches("input,textarea,select") ? trueValue(element) : element.localName === "slot" ? element.assignedNodes({flatten:true}).map(trueContent).join("") : trueContent(element);
    return typeof held === "string" ? held : "";
  };
  // One read of one tree: the values for the last net, the names of masked fields, and what pixels may show.
  state.read = (root = document, known = [], { scan = true, resetUnread = true, drain = true, approved } = {}) => {
    if (approved) state.approvedIds = new Set(approved);
    // Which child frames this reply skips is decided afresh, so a frame that recovers comes back.
    if (resetUnread) state.unread = new WeakSet();
    state.watch();
    let filled = false, frames = 0;
    const shadowTags = new Set();
    walk(root, element => {
      if (element.localName.includes("-")) shadowTags.add(CSS.escape(element.localName));
      if (element.localName === "iframe" || element.localName === "frame") frames += 1;
      if (!scan) return;
      if (judge(element)) {
        const held = holding(element);
        if (held.length) { filled = true; state.held = true; remember(held, element); }
      } else if (!state.agentFields.has(element) && element.matches(HOLDS)) {
        // Only emptiness is inspected for an uncertain field, never its words.
        const words = description(element).trim();
        if ((/^(?:pin|code|key|token|recovery|رمز|مفتاح)$/i.test([...new Set(words.toLowerCase().split(/\s+/))].join(" ")) || root.host && root.mode === "closed") && holding(element).length) {
          state.uncertain = true;
          if (!state.fieldIds.has(element)) state.fieldIds.set(element, `${state.documentId}:${++nextField}`);
          if (state.uncertainIds.size < COUNT || state.uncertainIds.has(state.fieldIds.get(element))) state.uncertainIds.add(state.fieldIds.get(element));
          else state.uncertainOverflow = true;
        }
      }
    });
    state.agentWriting = false;
    // A value that left its element, for the pixel rule. It is only compared here, never carried.
    let echoed = false;
    if (known.length) {
      const text = root === document ? trueContent(document.documentElement || document) : trueContent(root);
      const seen = [text];
      walk(root, element => { if (!state.fields.has(element) && element.matches("input:not([type=hidden]),textarea")) seen.push(trueValue(element)); });
      echoed = known.some(value => seen.some(held => held && held.includes(value)));
    }
    const values = drain ? [...state.pending] : [];
    const fields = drain ? [...state.pendingFields].map(([id, value]) => ({ id, value })) : [];
    if (drain) { state.pending.clear(); state.pendingFields.clear(); }
    const privateNow = state.held || state.uncertainOverflow || [...state.uncertainIds].some(id => !state.approvedIds.has(id));
    return { title: privateNow ? null : document.title, values, fields, uncertainIds: [...state.uncertainIds], uncertainOverflow: !!state.uncertainOverflow, names: [...state.names], shadowTags: [...shadowTags], structure: state.structure, documentId: state.documentId, language: /^ar(?:-|$)/i.test(document.documentElement?.lang || "") ? "ar" : "en", held: state.held, uncertain: state.uncertain, filled, echoed, frames, loading: document.readyState !== "complete" };
  };
  // After the first read, a flip of a masked field and every typed value are seen as they happen.
  const track = element => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || !judge(element)) return;
    const held = holding(element);
    if (held.length) { state.held = true; remember(held, element); }
  };
  const trackInput = event => {
    const element = event.composedPath?.()[0] || event.target;
    if (!state.agentWriting) state.agentFields.delete(element);
    track(element);
  };
  const watcher = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "childList") state.structure += 1;
      if (record.type === "attributes") {
        if (record.attributeName === "type" && record.oldValue === "password") { state.anySeal = true; state.fields.add(record.target); }
        if (record.attributeName === "style" && /text-security\s*:\s*(?!none)|text-security-disc/i.test(record.oldValue || "")) { state.anySeal = true; state.fields.add(record.target); }
        track(record.target);
      }
      for (const added of record.addedNodes || []) if (added.nodeType === Node.ELEMENT_NODE) walk(added, track);
    }
  });
  state.observe = root => {
    root.addEventListener("input", trackInput, true);
    root.addEventListener("change", trackInput, true);
    watcher.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["type", "style", "class", "autocomplete", "aria-label", "aria-labelledby", "name"], attributeOldValue: true });
    state.roots.add(root);
  };
  const watch = () => { state.observe(document); for (const root of state.roots) state.observe(root); };
  watch();
  state.watch = watch;

  // Same turn, same element map: a node the build could not place is treated as sealed.
  const sealNodes = (nodes, info) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (typeof node === "string") { nodes[index] = node.replace(/\(masked\)(?:\s*\(masked\))+/g, MASK); continue; }
      if (typeof node.text === "string") node.text = node.text.replace(/\(masked\)(?:\s*\(masked\))+/g, MASK);
      const element = node.ref ? info?.get(node.ref)?.element : null;
      if (node.ref && (!element || state.fields.has(element) || sealedOf(element))) {
        const holds = !!(node.text || node.children?.length);
        delete node.children; delete node.url; delete node.placeholder; delete node.name;
        if (holds) node.text = MASK; else delete node.text;
        continue;
      }
      if (node.children) sealNodes(node.children, info);
    }
  };
  state.install = injected => {
    const capture = injected.ariaSnapshotJSON;
    if (typeof capture !== "function") throw new Error("privacy unavailable");
    const during = work => {
      state.capturing += 1;
      state.sealedCache = new WeakMap();
      try { return work(); } finally { state.capturing -= 1; if (!state.capturing) state.sealedCache = null; }
    };
    state.sealedSnapshot = function(...args) {
      return during(() => {
        const result = capture.apply(this, args);
        const info = this._lastAriaSnapshotForQuery?.info;
        sealNodes(result.json, info);
        // A frame this reply cannot wait for is not entered, so a slow one costs nothing.
        result.iframeRefs = (result.iframeRefs || []).filter(ref => { const element = info?.get(ref)?.element; return !element || !state.unread.has(element); });
        result.json.unshift({ role: "generic", name: `hoai-proof-${state.proof}` });
        return result;
      });
    };
    injected.ariaSnapshotJSON = function(...args) {
      const facts = state.read(document, [], { resetUnread: false, drain: false });
      if (facts.held || facts.uncertainOverflow || facts.uncertainIds.some(id => !state.approvedIds.has(id))) {
        return { json: [{ role: "generic", name: `hoai-proof-${state.proof}` }, { role: "generic", name: `hoai-private-${state.proof}-${facts.language}` }], iframeRefs: [] };
      }
      return state.sealedSnapshot.apply(this, args);
    };
    // What a control does, from the world that cannot be lied to. The saved map means a read never costs a ref.
    const ACTIONS = "button,a[href],summary,input,select,textarea,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[contenteditable]:not([contenteditable=false])";
    const upward = element => { for (let at = element; at; at = at.parentNode || at.host) if (at.nodeType === Node.ELEMENT_NODE && at.matches(ACTIONS)) return at; return element; };
    const read = element => {
      const saved = injected._lastAriaSnapshotForQuery;
      let node = null;
      try { node = during(() => capture.call(injected, element, { mode: "default" }).json[0]); }
      catch { node = null; } finally { injected._lastAriaSnapshotForQuery = saved; }
      if (!node) return null;
      // A control's name, or a plain element's own text. A field's value is what it holds, never its name.
      const holdsValue = element.matches("input:not([type=submit],[type=button],[type=reset],[type=image]),textarea,select,[contenteditable],[role=textbox],[role=searchbox],[role=combobox]");
      const own = holdsValue ? "" : [node.text, ...(node.children || []).filter(child => typeof child === "string")].filter(Boolean).join(" ");
      // What it says as well as what it is called: a label can call a Delete button Continue.
      const flat = text => String(text || "").replace(/\s+/g, " ").trim();
      const called = flat(node.name), says = flat(own);
      const name = called && says && !called.toLowerCase().includes(says.toLowerCase()) ? `${called} ${says}` : called || says;
      return { role: node.role, ...(name ? { name: name.slice(0, 200) } : {}) };
    };
    state.describe = (start, { form = false } = {}) => {
      judgeAll();
      if (!start || start.nodeType !== Node.ELEMENT_NODE) return { readable: false };
      const label = start.localName === "label" ? start : start.closest?.("label");
      const control = label?.control && !start.matches(ACTIONS) ? label.control : upward(start);
      if (sealedOf(control) || sealedOf(start)) return control.matches(HOLDS) ? { readable: true, sealed: true, role: "textbox", name: "Protected credential field" } : { readable: false };
      if (form) {
        const owner = control.form || control.closest?.("form");
        if (!owner) return control.matches("input[type=search],[role=searchbox]") || /\bsearch\b|بحث/i.test(description(control)) ? { readable: true, nothing: true } : { readable: false };
        const button = Array.from(owner.elements || []).find(element => element.matches("button:not([type]),button[type=submit],input[type=submit],input[type=image]"));
        if (button && !sealedOf(button)) { const named = read(button); if (named?.name) return { readable: true, ...named }; return { readable: false }; }
        if (button) return { readable: false };
        const action = getAttribute.call(owner, "aria-label") || getAttribute.call(owner, "action");
        return action ? { readable: true, role: "form", name: String(action).split(/[?#]/)[0].slice(0, 200) } : { readable: false };
      }
      const named = read(control);
      return named?.name ? { readable: true, ordinary: control.matches(HOLDS), ...named } : { readable: false, role: named?.role };
    };
    state.focused = () => {
      let at = document.activeElement;
      for (;;) {
        const root = at?.shadowRoot || [...state.roots].find(root => root.host === at);
        if (!root?.activeElement || root.activeElement === at) break;
        at = root.activeElement;
      }
      return !at || at === document.body || at === document.documentElement ? null : at;
    };
    // Enter on a form control submits the form; on anything else it presses what has the focus.
    state.describeFocused = () => {
      const focused = state.focused();
      if (!focused) return { readable: true, nothing: true };
      if (focused.localName === "iframe") return { readable: false };
      const typed = focused.matches("input:not([type=submit],[type=button],[type=reset],[type=image]),select,textarea");
      return state.describe(focused, { form: typed });
    };
  };
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

const installed = new WeakSet();
const timed = (work, ms) => {
  let timer;
  const bound = Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), ms); timer.unref?.(); })]);
  return bound.finally(() => clearTimeout(timer));
};

// The frame's existing world and a sealed reader for it, or null for a frame that is not ready.
async function sealFrame(page, frame, nonce, skipClient) {
  const impl = page._connection?.toImpl?.(frame);
  if (typeof impl?.utilityContext !== "function") throw failure();
  const pending = impl.utilityContext();
  pending.catch?.(() => {});
  const utility = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), READY_MS))]);
  if (!utility) return null;
  const client = utility.delegate?._client;
  // A fence refuses a cross process frame's session, and a refusal must not read as this call's failure.
  if (skipClient && client && client !== skipClient) return null;
  const injected = await utility.injectedScript();
  if (!installed.has(utility)) {
    await injected.evaluate((injected, { source, nonce }) => {
      const state = (0, eval)(`(${source})`)(nonce);
      if (state.hooked !== injected) { state.hooked = injected; state.install(injected); }
    }, { source: sealTheWorld.toString(), nonce });
    installed.add(utility);
  }
  return { injected, client, frame: impl };
}

// Every frame read in parallel. Only the main frame can fail the call. `unread` are the frames that lost their contents.
async function readPage(page, nonce, { fenced = false, known = [], closed = true, scan = true, approved = [] } = {}) {
  const main = page.mainFrame?.() || page.frames()[0];
  if (!main) throw failure();
  const mainClient = fenced ? (await timed(page._connection.toImpl(main).utilityContext(), READ_MS)).delegate?._client : null;
  const reads = await Promise.all(page.frames().map(async frame => {
    const isMain = frame === main;
    try {
      return await timed((async () => {
        const sealed = await sealFrame(page, frame, nonce, isMain ? null : mainClient);
        if (!sealed) return { frame, unread: true };
        const data = await sealed.injected.evaluate((injected, { known, scan, approved }) => {
          void injected;
          return globalThis[Symbol.for("hoai.browser.answerPrivacy")].read(document, known, { scan, approved });
        }, { known, scan, approved });
        return { frame, sealed, data };
      })(), isMain ? READ_MS : FRAME_MS);
    } catch (error) {
      if (isMain) throw error;
      return { frame, unread: true };
    }
  }));
  const facts = { values: [], fields: [], uncertainIds: new Set(), names: [], held: false, filled: false, echoed: false, unread: [], loading: false };
  for (const entry of reads) {
    if (entry.unread) { facts.unread.push(entry.frame); continue; }
    facts.values.push(...entry.data.values);
    facts.fields.push(...entry.data.fields || []);
    for (const id of entry.data.uncertainIds || []) facts.uncertainIds.add(id);
    facts.uncertainOverflow ||= entry.data.uncertainOverflow;
    facts.names.push(...entry.data.names);
    facts.filled ||= entry.data.filled;
    facts.held ||= entry.data.held;
    facts.uncertain ||= entry.data.uncertain;
    facts.echoed ||= entry.data.echoed;
    facts.loading ||= entry.data.loading === true;
  }
  const mainRead = reads.find(entry => entry.frame === main);
  if (!mainRead?.data) throw failure();
  facts.documentId = mainRead.data.documentId;
  facts.language = mainRead.data.language;
  facts.title = mainRead.data.title;
  // A frame that is not read is not entered by the tree, and so never holds the tree up.
  await Promise.all(facts.unread.map(frame => timed(markUnread(page, frame), FRAME_MS).catch(() => {})));
  if (closed) await readClosed(page, reads, facts).catch(() => { facts.closedUnread = true; });
  return facts;
}

async function markUnread(page, frame) {
  const handle = await frame.frameElement();
  try {
    await page._connection.toImpl(handle).evaluateInUtility(([injected, element]) => {
      void injected;
      globalThis[Symbol.for("hoai.browser.answerPrivacy")].unread.add(element);
    }, {});
  } finally { await handle.dispose().catch(() => {}); }
}

// Closed component trees are inspected on every read. Only booleans and the bounded final net leave their world.
const shadowWatches = new WeakMap();
async function readClosed(page, reads, facts) {
  for (const client of new Set(reads.filter(entry => entry.sealed?.client).map(entry => entry.sealed.client))) {
    const entries = reads.filter(entry => entry.sealed?.client === client);
    const contextOf = new Map();
    for (const entry of entries) {
      const delegate = (await entry.sealed.frame.utilityContext()).delegate;
      contextOf.set(entry.sealed.frame._id, delegate._contextId);
    }
    let watch = shadowWatches.get(client);
    if (!watch) {
      watch = { contexts: new Map(), closed: [], dirty: true };
      for (const event of ["DOM.documentUpdated", "DOM.childNodeInserted", "DOM.childNodeRemoved", "DOM.childNodeCountUpdated", "DOM.shadowRootPushed", "DOM.shadowRootPopped"]) client.on?.(event, () => { watch.dirty = true; });
      shadowWatches.set(client, watch);
      client.on?.("DOM.shadowRootPushed", event => {
        const executionContextId = watch.contexts.get(event.hostId);
        if (!executionContextId) return;
        // Observe a new shadow tree on arrival using the existing authorized session.
        void (async () => {
          const { object } = await client.send("DOM.resolveNode", { backendNodeId: event.root.backendNodeId, executionContextId });
          if (!object?.objectId) return;
          try { await client.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
            functionDeclaration: `function() { const s=globalThis[Symbol.for("hoai.browser.answerPrivacy")]; s.observe(this); s.read(this); }` }); }
          finally { await client.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {}); }
        })().catch(() => {});
      });
    }
    const identity = entries.map(entry => `${entry.sealed.frame._id}:${contextOf.get(entry.sealed.frame._id)}:${entry.data.structure}`).sort().join(",");
    if (watch.identity !== identity) { watch.dirty = true; watch.identity = identity; }
    if (watch.dirty || typeof client.on !== "function") {
      watch.dirty = false;
      try {
        await client.send("DOM.enable");
        watch.contexts.clear();
        watch.closed = [];
        const scan = (root, frameId) => {
          const nodes = [{ node: root, frameId }];
          while (nodes.length) {
            const { node, frameId } = nodes.pop();
            watch.contexts.set(node.nodeId, contextOf.get(frameId));
            if (node.shadowRootType === "closed") watch.closed.push({ backendNodeId: node.backendNodeId, frameId });
            for (const child of [...node.children || [], ...node.shadowRoots || []]) nodes.push({ node: child, frameId });
            if (node.contentDocument) nodes.push({ node: node.contentDocument, frameId: node.contentDocument.frameId || node.frameId || frameId });
          }
        };
        // Only these HTML hosts and custom elements can own a shadow root. Query their identities,
        // then inspect them shallowly. A large table does not serialize every text node just to
        // prove that it has no closed component. Dense component pages use the bounded full walk.
        const { root } = await client.send("DOM.getDocument", { depth: 0, pierce: true });
        if (!root) throw failure();
        let dense = false;
        for (const entry of entries) {
          const frameId = entry.sealed.frame._id;
          let documentId = root.nodeId;
          if (frameId !== root.frameId && frameId !== entries[0].sealed.frame._id) {
            const evaluated = await client.send("Runtime.evaluate", { expression: "document", contextId: contextOf.get(frameId), returnByValue: false });
            if (!evaluated.result?.objectId) throw failure();
            try { documentId = (await client.send("DOM.describeNode", { objectId: evaluated.result.objectId, depth: 0, pierce: true })).node.nodeId; }
            finally { await client.send("Runtime.releaseObject", { objectId: evaluated.result.objectId }).catch(() => {}); }
          }
          const tags = entry.data.shadowTags || [];
          if (tags.length > 32) { dense = true; break; }
          const selector = ["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span", ...tags].join(",");
          const { nodeIds } = await client.send("DOM.querySelectorAll", { nodeId: documentId, selector });
          if (nodeIds.length > 32) { dense = true; break; }
          for (const nodeId of nodeIds) {
            const { node } = await client.send("DOM.describeNode", { nodeId, depth: 0, pierce: true });
            watch.contexts.set(nodeId, contextOf.get(frameId));
            for (const shadow of node.shadowRoots || []) {
              const { node: contents } = await client.send("DOM.describeNode", { backendNodeId: shadow.backendNodeId, depth: -1, pierce: true });
              scan(contents, frameId);
            }
          }
        }
        if (dense) {
          const { root: whole } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
          if (!whole) throw failure();
          watch.contexts.clear(); watch.closed = [];
          scan(whole, whole.frameId || entries[0].sealed.frame._id);
        }
      } catch (error) { watch.dirty = true; throw error; }
    }
    const closed = watch.closed;
    for (const entry of closed) {
      const executionContextId = contextOf.get(entry.frameId);
      if (!Number.isInteger(executionContextId)) throw failure();
      const { object } = await client.send("DOM.resolveNode", { backendNodeId: entry.backendNodeId, executionContextId });
      if (!object?.objectId) throw failure();
      try {
        const reply = await client.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
          functionDeclaration: `function() { const s=globalThis[Symbol.for("hoai.browser.answerPrivacy")]; s.observe(this); return s.read(this); }` });
        const data = reply.result?.value;
        if (reply.exceptionDetails || !data) throw failure();
        facts.values.push(...data.values);
        facts.fields.push(...data.fields || []);
        for (const id of data.uncertainIds || []) facts.uncertainIds.add(id);
        facts.uncertainOverflow ||= data.uncertainOverflow;
        facts.names.push(...data.names);
        facts.filled ||= data.filled;
        facts.held ||= data.held;
        facts.uncertain ||= data.uncertain;
        // A frame inside a closed tree cannot be painted over, so it counts as filled.
        facts.filled ||= data.frames > 0;
      } finally { await client.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {}); }
    }
  }
}

const reEscape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HEADER = /^(\s*-\s+['"]?)([A-Za-z][\w-]*)((?:\s+"(?:[^"\\]|\\.)*")?)((?:\s+\[[^\]\n]*\])*)(.*)$/s;
const FIXED_ERRORS = [
  [/could not be read safely/, () => UNREADABLE],
  [/^Ref \S+ not found in the current page snapshot/, text => { const ref = /^Ref (\S+)/.exec(text)[1]; return `Ref ${REF.test(ref) ? ref : "that"} not found in the current page snapshot. Try capturing new snapshot.`; }],
  [/\bTimeout (\d+)ms exceeded\b/, text => `Timeout ${/\bTimeout (\d+)ms exceeded\b/.exec(text)[1]}ms exceeded. The page did not respond in time.`],
  [/Creating tabs is not supported/, () => "Creating tabs is not supported in this session."],
  [/No dialog visible/, () => "No dialog is waiting on this page."],
  [/does not handle the modal state/, text => /file chooser/i.test(text) ? CHOOSER : "A browser dialog or file chooser is waiting on this page. Answer it before anything else."],
  [/Target page, context or browser has been closed|Target closed|page has been closed/i, () => "The page closed during this action."],
  [/^The text (?:did not appear|is still on the page)\b/, text => text.split("\n")[0]],
  [/^Invalid arguments for tool/, () => "The arguments for this tool were not valid."],
  [/^Tool "[^"]*" not found/, () => "This browser tool is not available."],
  [/^Provide (?:either|only one of) "text" or "regex"/, text => text.split("\n")[0]],
  [/Either time, text or textGone/, () => "Either time, text or textGone must be provided."],
  [/fullPage cannot be used/, () => "fullPage cannot be used with element screenshots."],
  [/net::ERR_[A-Z_]+/, text => `The page could not be opened: ${/net::ERR_[A-Z_]+/.exec(text)[0]}.`],
  [/is not (?:visible|enabled|stable|editable)|intercepts pointer events|element is outside of the viewport/, () => "That element could not be acted on right now. Read the page again before retrying."],
];

class AnswerPrivacy {
  #nonce = randomBytes(16).toString("hex");
  #proof = `generic "hoai-proof-${this.#nonce}"`;
  #responses = new AsyncLocalStorage();
  #fallback = null;
  #emptyNet = new Map();
  #emptyNames = new Set();
  #emptyFields = new Map();
  #readVersions = new WeakMap();
  #sites = new Map();
  #activeResponses = new WeakMap();
  get #current() { const scope = this.#responses.getStore(); return scope ? scope.record : this.#fallback; }
  get #net() { return this.#current?.net || this.#emptyNet; }
  get #names() { return this.#current?.names || this.#emptyNames; }
  get #fieldValues() { return this.#current?.fields || this.#emptyFields; }
  get #orderedNet() { return this.#current?.site?.orderedNet || []; }
  set #orderedNet(value) { if (this.#current) this.#current.site.orderedNet = value; }

  // Each observation and response carries its own page through every await. A background
  // read updates its page's record, never another request's privacy state or final net.
  #joinResponse(scope) {
    if (!scope.page) return;
    let active = this.#activeResponses.get(scope.page);
    if (!active) { active = new Set(); this.#activeResponses.set(scope.page, active); }
    active.add(scope);
  }
  response(page, work) {
    const scope = { page, record: this.#documents.get(page) || null, response: true };
    this.#joinResponse(scope);
    return this.#responses.run(scope, async () => {
      try { return await work(); }
      finally { if (scope.page) this.#activeResponses.get(scope.page)?.delete(scope); }
    });
  }
  forPage(page, work) {
    const scope = this.#responses.getStore();
    if (page && scope?.response && !scope.page) { scope.page = page; scope.record = this.#documents.get(page) || null; this.#joinResponse(scope); }
    if (!page || scope?.page === page) return work();
    return this.#responses.run({ page, record: this.#documents.get(page) || null }, work);
  }
  get #verdict() {
    const scope = this.#responses.getStore();
    if (scope?.denied) return scope;
    return scope?.page ? [...this.#activeResponses.get(scope.page) || []].find(active => active.denied && active.deniedDoc === scope.record?.id) : null;
  }
  #denyResponse(page, language) {
    const scope = this.#responses.getStore();
    const documentId = this.#verdict?.deniedDoc || this.#current?.id;
    if (scope?.page === page) { scope.denied = true; scope.language = language; scope.deniedDoc = documentId; }
    for (const active of this.#activeResponses.get(page) || []) { active.denied = true; active.language = language; active.deniedDoc = documentId; }
  }

  #pages = new WeakSet();
  #tabs = new WeakSet();
  #released = new WeakSet();
  #documents = new WeakMap();

  privacyState() { return { blocked: this.blocked, uncertain: this.#current?.uncertain === true && !this.#current.confirmed && !this.#current.secret, question: this.copy.question, handoff: this.copy.handoff }; }
  takeQuestion() { if (!this.#current || this.#current.question) return null; this.#current.question = true; return { id: this.#current.id, fields: [...this.#current.uncertainIds] }; }
  confirmOrdinary(token) {
    if (!this.#current || this.#current.id !== token?.id || this.#current.secret) return;
    for (const id of token.fields) this.#current.approvedIds.add(id);
    this.#current.confirmed = !this.#current.uncertainOverflow && [...this.#current.uncertainIds].every(id => this.#current.approvedIds.has(id));
    this.#current.blocked = !this.#current.confirmed;
  }

  get copy() { return COPY[(this.#verdict?.language || this.#current?.language) === "ar" ? "ar" : "en"]; }
  get blocked() { return !!this.#verdict || this.#current?.blocked === true; }
  handoff() { return this.keep({ content: [{ type: "text", text: this.copy.handoff }] }); }

  // The last whole page tree read: proved, with nothing removed. Gates read this, never the model's copy.
  get lastTree() { return this.#current?.tree || null; }
  set lastTree(value) { if (this.#current) this.#current.tree = value; }

  // A bound desktop call: a fence refuses a cross process frame's session, so that frame is not asked.
  fenced = false;

  // True while a call runs.
  busy = false;

  // ── reading ─────────────────────────────────────────────────────────────────────────────────

  async read(page, options = {}) {
    let version = this.#readVersions.get(page);
    if (!version) { version = { next: 0, committed: 0 }; this.#readVersions.set(page, version); }
    const ordinal = ++version.next;
    const facts = await readPage(page, this.#nonce, { fenced: this.fenced, approved: [...this.#documents.get(page)?.approvedIds || []], ...options }).catch(error => { throw this.#plain(error); });
    const response = this.#responses.getStore();
    if (ordinal < version.committed) {
      const latest = this.#documents.get(page) || null;
      if (response?.page === page) response.record = latest;
      for (const active of this.#activeResponses.get(page) || []) active.record = latest;
      return facts;
    }
    version.committed = ordinal;
    let current = this.#documents.get(page);
    if (!current || current.id !== facts.documentId) {
      let origin = null;
      try { origin = new URL(page.url()).origin; } catch {}
      let site = origin && origin !== "null" ? this.#sites.get(origin) : null;
      if (!site) { site = { net: new Map(), names: new Set(), fields: new Map(), orderedNet: [] }; if (origin && origin !== "null") this.#sites.set(origin, site); }
      current = { id: facts.documentId, origin, site, blocked: false, net: site.net, names: site.names, fields: site.fields, uncertainIds: new Set(), approvedIds: new Set() };
      this.#documents.set(page, current);
    }
    current.language = facts.language;
    current.secret ||= facts.held || facts.filled;
    current.uncertain ||= facts.uncertain;
    for (const id of facts.uncertainIds) current.uncertainIds.add(id);
    current.uncertainOverflow ||= facts.uncertainOverflow;
    current.confirmed = !current.uncertainOverflow && [...current.uncertainIds].every(id => current.approvedIds.has(id));
    current.blocked = current.secret || current.uncertain && !current.confirmed;
    if (current.blocked) current.tree = null;
    for (const name of facts.names) if (current.names.size < NAMES_MAX || current.names.has(name)) current.names.add(name);
    this.#responses.run({ page, record: current }, () => this.#remember(facts.values, facts.fields));
    if (response?.page === page) response.record = current;
    else if (!response) this.#fallback = current;
    for (const active of this.#activeResponses.get(page) || []) active.record = current;
    return facts;
  }

  // Before a call. Only a call that acts on the page needs a good read: leaving a stuck page must always work.
  async before(page, toolName) {
    if (!page) return null;
    try { return await this.read(page); }
    catch (error) {
      if (MOVES_AWAY.has(toolName)) return null;
      throw this.#plain(error);
    }
  }

  async preflight(page, tab, name, args = {}) {
    if (!page) return null;
    await this.before(page, name);
    if (this.blocked && !MOVES_AWAY.has(name)) return this.handoff();
    if (this.blocked) return null;
    const typing = ["browser_type", "browser_fill_form", "browser_press_key"].includes(name);
    if (!typing) return null;
    const targets = name === "browser_fill_form" ? (args.fields || []).map(field => field.target) : args.target ? [args.target] : [];
    const read = await this.describeAction(page, tab, name, args, { targets, reads: name === "browser_press_key" ? "focused" : "target" });
    if ([...(read?.targets || []), read?.actuated].some(item => item?.sealed)) return { content: [{ type: "text", text: this.copy.person }] };
    // Record the provenance of a permitted ordinary fill. A person's next input removes it;
    // a later password type/style still overrides it in judge().
    for (const target of targets) {
      const { locator } = await tab.targetLocator({ target });
      const handle = await locator.elementHandle({ timeout: DESCRIBE_MS });
      try { await page._connection.toImpl(handle).evaluateInUtility(([injected, element]) => {
        void injected; const state = globalThis[Symbol.for("hoai.browser.answerPrivacy")];
        state.agentFields.add(element); state.agentWriting = true;
      }, {}); } finally { await handle.dispose().catch(() => {}); }
    }
    const key = String(args.key || "").split("+").pop();
    if (name === "browser_press_key" && !/(?:Control|Meta|Alt)\+/.test(args.key || "") && (key.length === 1 || /^(?:Key[A-Z]|Digit[0-9]|Space|Backspace|Delete)$/.test(key))) {
      const main = await sealFrame(page, page.mainFrame(), this.#nonce, null);
      await main.injected.evaluate(injected => {
        void injected; const state = globalThis[Symbol.for("hoai.browser.answerPrivacy")];
        const focused = state.focused();
        if (focused && !state.sealedOf(focused)) { state.agentFields.add(focused); state.agentWriting = true; }
      });
    }
    return null;
  }

  // After an action, briefly: a new document is sealed before anything can happen on it. A slow page just waits for the next read.
  async after(page) {
    if (page) await timed(this.read(page), FRAME_MS).catch(() => {});
  }

  #plain(error) { return error?.code === "privacy_unavailable" ? error : failure(); }

  // ── the last net ────────────────────────────────────────────────────────────────────────────

  #remember(values, fields = []) {
    // Replace a typed prefix only for the very same control. Another field can legitimately
    // hold that shorter value, and its final-net protection must remain intact.
    const updates = new Map(), previous = new Set();
    for (const { id, value } of fields) {
      if (typeof id !== "string" || typeof value !== "string" || value.length < NET_MIN) continue;
      const prior = updates.get(id) ?? this.#fieldValues.get(id);
      if (prior) previous.add(prior);
      updates.set(id, value.slice(0, NET_VALUE_MAX));
    }
    for (const [id, value] of updates) {
      this.#fieldValues.set(id, value);
      if (this.#fieldValues.size > NET_VALUES) this.#fieldValues.delete(this.#fieldValues.keys().next().value);
    }
    const heldByFields = new Set(this.#fieldValues.values());
    const superseded = new Set([...previous].filter(value => !heldByFields.has(value)));
    for (const value of superseded) this.#net.delete(value);
    for (const value of values) {
      if (typeof value !== "string" || value.length < NET_MIN) continue;
      const held = value.slice(0, NET_VALUE_MAX);
      if (superseded.has(held)) continue;
      if (this.#net.has(held)) { const again = this.#net.get(held); this.#net.delete(held); this.#net.set(held, again); continue; }
      this.#net.set(held, this.#netPattern(held));
      if (this.#net.size > NET_VALUES) this.#net.delete(this.#net.keys().next().value);
    }
    this.#orderedNet = [...this.#net].sort((a, b) => b[0].length - a[0].length).map(entry => entry[1]);
  }

  // Whitespace and URL forms: the value as written, as a tree collapses it, and as an address or a form encodes it.
  #netPattern(value) {
    const flat = value.replace(/[​­]/g, "");
    const words = flat.trim().split(/\s+/).filter(Boolean);
    const loose = words.map(reEscape).join("\\s+");
    const form = new URLSearchParams({ v: flat }).toString().slice(2);
    const json = JSON.stringify(flat).slice(1, -1);
    const html = flat.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    const percent = text => text.replace(/%[0-9A-Fa-f]{2}/g, hex => `%${hex.slice(1).toUpperCase()}`);
    const forms = new Set([flat, json, JSON.stringify(json).slice(1, -1), html, flat.replaceAll("'", "''"), Buffer.from(flat).toString("base64")]);
    const encoded = new Set([encodeURIComponent(flat), encodeURI(flat), form, form.replaceAll("+", "%20"), encodeURIComponent(flat).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)].map(percent));
    const parts = [loose, ...[...forms].map(reEscape), ...[...encoded].map(text => reEscape(text).replace(/%[0-9A-F]{2}/g, hex => `%[${hex[1]}${hex[1].toLowerCase()}][${hex[2]}${hex[2].toLowerCase()}]`))];
    return new RegExp(parts.sort((a, b) => b.length - a.length).join("|"), "g");
  }

  // Page text only. Never a role, a ref, an attribute, a key or a host sentence.
  text(text) {
    if (!this.#net.size) return text;
    let out = text;
    for (const pattern of this.#orderedNet) { pattern.lastIndex = 0; out = out.replace(pattern, MASKED); }
    return out;
  }

  // A parameter a masked field filled, or one spelled like a password, by its name and in any value.
  address(text) {
    if (!/[?&#;]/.test(String(text))) return String(text);
    return String(text).replace(/([?&#;])([^=&#;\s]+)=([^&#;\s)\]]*)/g, (whole, mark, name, value) => {
      let plain = name;
      try { plain = decodeURIComponent(name); } catch {}
      if (!value || value.startsWith("(masked")) return whole;
      return this.#names.has(plain) || SECRET_PARAM.test(plain) ? `${mark}${name}=${MASKED}` : whole;
    });
  }

  page(text) { return this.blocked ? this.copy.handoff : this.text(this.address(text)); }

  // One tree line: the role and attributes are the host's words, the name and what follows are the page's.
  #line(line) {
    if ((!this.#net.size && !/[?&#;]/.test(line)) || !line.trim() || line.startsWith("```")) return line;
    const url = /^(\s*-\s+\/url:\s*)(.*)$/.exec(line);
    if (url) return url[1] + this.page(url[2]);
    const parts = HEADER.exec(line);
    if (!parts) return this.page(line);
    return `${parts[1]}${parts[2]}${this.text(parts[3])}${parts[4]}${this.page(parts[5])}`;
  }

  #section(section) {
    const end = section.indexOf("\n");
    const title = end < 0 ? section : section.slice(0, end);
    const body = end < 0 ? "" : section.slice(end + 1);
    switch (title.trim()) {
      case "### Snapshot": if (!this.#net.size) return `${title}\n${this.address(body)}`; return `${title}\n${body.split("\n").map(line => this.#line(line)).join("\n")}`;
      case "### Result": return `${title}\n${body.split("\n").map(line => this.#line(line)).join("\n")}`;
      case "### Page": case "### Open tabs": return `${title}\n${this.page(body)}`;
      case "### Error": return `${title}\n${this.error(body)}`;
      // A dialog's words stay with the page. A file chooser has none, and an agent must know it is open.
      case "### Modal state": return /file chooser/i.test(body) ? `${title}\n${CHOOSER}` : `${title}\n${DIALOG}`;
      default: return null; // generated code, events, a modal's text, anything added later
    }
  }

  // ── the answer ──────────────────────────────────────────────────────────────────────────────

  // A result the host wrote itself says what it says: the gate's id, the do not retry. Only the net runs
  // over it, because a card's words can repeat a name. A reply already released here passes untouched.
  host(result) {
    if (result && typeof result === "object" && this.#released.has(result)) return result;
    if (this.blocked) return typeof result === "string" ? this.copy.handoff : this.handoff();
    if (typeof result === "string") return this.page(result);
    if (!result || typeof result !== "object" || !Array.isArray(result.content) || this.#released.has(result)) return result;
    return { ...result, content: result.content.map(part => part?.type === "text" && typeof part.text === "string" ? { ...part, text: part.text.split("\n").map(line => this.#line(line)).join("\n") } : part) };
  }

  // For a host that passes a released reply through one more of its own filters.
  keep(result) { if (result && typeof result === "object") this.#released.add(result); return result; }

  error(message) {
    const text = String(message ?? "").replace(/^(?:Error: )+/, "").trim();
    for (const [pattern, words] of FIXED_ERRORS) if (pattern.test(text)) return words(text);
    return FAILED;
  }

  isUnreadable(error) { return error?.code === "privacy_unavailable"; }

  value(value) {
    if (this.blocked) return this.handoff();
    if (!value || typeof value !== "object" || !Array.isArray(value.content)) return value;
    const content = [];
    for (const part of value.content) {
      if (part?.type === "image") { content.push(part); continue; }
      if (part?.type !== "text" || typeof part.text !== "string") { content.push({ type: "text", text: "Unsupported browser output withheld." }); continue; }
      const sections = part.text.split(/^(?=### )/m);
      const kept = [];
      for (const section of sections) {
        if (!section) continue;
        if (section.startsWith("### ")) { const safe = this.#section(section.replace(/\n$/, "")); if (safe !== null) kept.push(safe); }
        else if (value.isError) kept.push(this.error(section));
        else kept.push(section.split("\n").map(line => this.#line(line)).join("\n"));
      }
      content.push({ type: "text", text: kept.join("\n") });
    }
    // Generated code was the only thing some actions had to say. Silence reads as a failure, so it says so.
    if (!value.isError && !content.some(part => part.type === "image" || part.text?.trim())) return this.keep({ content: [{ type: "text", text: "### Result\nDone." }] });
    const released = { content, ...(value.isError ? { isError: true } : {}) };
    this.#released.add(released);
    return released;
  }

  validate(args) {
    if (args && Object.hasOwn(args, "isolatedContext")) throw new Error("Named browser contexts are not available.");
    const targets = [args?.target, args?.startTarget, args?.endTarget, ...(args?.fields || []).map(field => field.target)].filter(value => value !== undefined);
    if (targets.some(value => typeof value !== "string" || !REF.test(value))) throw new Error("Browser targets must be host element refs. Read a snapshot first.");
  }

  // ── the tree ────────────────────────────────────────────────────────────────────────────────

  // Strips the proof lines. A frame with no proof line keeps its iframe line and loses its contents.
  tree(text) {
    const privateLine = new RegExp(`^\\s*-\\s+generic "hoai-private-${this.#nonce}-(en|ar)"\\s*$`, "m");
    const capturedPrivate = () => {
      const found = privateLine.exec(String(text));
      if (!found) return null;
      const response = this.#responses.getStore();
      if (response) this.#denyResponse(response.page, found[1]);
      else if (this.#current) { this.#current.blocked = true; this.#current.secret = true; }
      return COPY[found[1]].handoff;
    };
    const prefix = `- ${this.#proof}\n`;
    if (String(text).startsWith(prefix)) {
      const body = String(text).slice(prefix.length);
      const held = capturedPrivate(); if (held) return held;
      if (!/^\s*-\s+iframe\b/m.test(body)) return body;
    }
    const lines = String(text).split("\n");
    const first = lines.findIndex(line => line.trim());
    if (first < 0) return text;
    if (lines[first].trim() !== `- ${this.#proof}`) throw failure();
    const held = capturedPrivate(); if (held) return held;
    const out = [];
    for (let index = first + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const indent = line.search(/\S/);
      if (line.trim() === `- ${this.#proof}`) continue;
      if (/^\s*-\s+iframe\b/.test(line) && /:\s*$/.test(line)) {
        const next = lines[index + 1];
        const proved = next?.trim() === `- ${this.#proof}`;
        const contents = [];
        let at = index + 1;
        while (at < lines.length && lines[at].search(/\S/) > indent) contents.push(lines[at++]);
        if (!proved || contents.length <= 1) {
          out.push(line.replace(/:\s*$/, ""));
          index = at - 1;
          continue;
        }
      }
      out.push(line);
    }
    return out.join("\n");
  }

  // The same read a tool gets, for a host that needs the tree for itself.
  protectPage(page) {
    if (this.#pages.has(page)) return;
    this.#pages.add(page);
    const read = page.ariaSnapshot.bind(page);
    page.ariaSnapshot = options => this.forPage(page, async () => {
      // The capture hook still judges every node before building the tree. Before it, only
      // install the world and inspect closed roots; the post-read collects the flags latched atomically during capture.
      try { await this.read(page, { scan: false }); } catch (error) { throw this.#plain(error); }
      if (this.blocked) { if (this.#current?.blocked) this.#denyResponse(page, this.copy === COPY.ar ? "ar" : "en"); return this.copy.handoff; }
      try {
        const tree = this.tree(await read({ timeout: TREE_MS, ...options }));
        if (options?.depth === undefined) this.lastTree = tree;
        // Capture inspected and latched the light tree in the same isolated-world turn that
        // built it. Collect those flags and pending net entries without scanning it a second time.
        // Closed roots still get a live inspection on this read.
        await this.read(page, { scan: false });
        return this.blocked ? this.copy.handoff : !this.#net.size ? this.address(tree) : tree.split("\n").map(line => this.#line(line)).join("\n");
      } catch (error) { throw this.#plain(error); }
    });
    // The output boundary accepts the guarded textual tree only.
    page.ariaSnapshotJSON = async () => { throw failure(); };
    // A new document is read as soon as it can be, so a person's typing and a Show click are seen from the start.
    // Never during a call: the call reads for itself, and on the desktop a read must not meet another call's fence.
    let settle = null;
    const newDocument = () => {
      clearTimeout(settle);
      settle = setTimeout(() => { if (!this.busy && !page.isClosed?.()) this.read(page).catch(() => {}); }, SETTLE_MS);
      settle.unref?.();
    };
    for (const event of ["domcontentloaded", "load", "framenavigated"]) page.on?.(event, newDocument);
    const shot = page.screenshot.bind(page);
    // A frame that could not be read is painted over: the page keeps its picture without it.
    page.screenshot = options => this.forPage(page, async () => {
      const facts = await this.read(page, { closed: true });
      if (this.blocked) { if (this.#current?.blocked) this.#denyResponse(page, this.copy === COPY.ar ? "ar" : "en"); throw failure(); }
      if (facts.closedUnread) throw failure();
      const shown = facts.unread.length ? { ...options, mask: [page.locator("iframe,frame")], maskColor: PAINT } : options;
      // Playwright waits for document.fonts.ready, which waits for the load a slow frame holds back, and then gives up.
      // A page that has not finished loading gets its picture as it stands. This is the only knob, and it is read per call.
      if (!facts.loading && !facts.unread.length) return shot(shown);
      const before = process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
      process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
      try { return await shot(shown); }
      finally { if (before === undefined) delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY; else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = before; }
    });
  }

  protectTab(tab) {
    if (this.#tabs.has(tab)) return;
    this.#tabs.add(tab);
    this.protectPage(tab.page);
    const capture = tab.captureSnapshot;
    if (typeof capture !== "function") throw failure();
    tab.captureSnapshot = (...args) => this.forPage(tab.page, async () => {
      const snapshot = await capture.apply(tab, args);
      if (snapshot) { snapshot.events = []; delete snapshot.consoleLink; }
      // The page's own read is proved above. A target's read arrives here with its own proof line.
      if (args[0] && typeof snapshot?.ariaSnapshot === "string" && snapshot.ariaSnapshot) snapshot.ariaSnapshot = this.tree(snapshot.ariaSnapshot);
      if (this.blocked) return { ariaSnapshot: this.copy.handoff, events: [] };
      if (snapshot?.ariaSnapshotJSON) throw failure();
      return snapshot;
    });
  }

  async tabList(tabs, activePage) {
    const rows = [];
    for (const [index, tab] of tabs.entries()) {
      const page = tab.page;
      const row = await this.forPage(page, async () => {
        const prefix = `- ${index}:${page === activePage ? " (current)" : ""} `;
        if (tab.modalStates?.().some(state => state.type === "dialog")) return prefix + (this.blocked ? this.copy.handoff : DIALOG);
        try {
          const facts = await timed(this.read(page), FRAME_MS);
          if (this.blocked) return prefix + this.copy.handoff;
          return `${prefix}[${this.page(facts.title || "")}](${this.page(page.url())})`;
        } catch { return prefix + UNREADABLE; }
      });
      rows.push(row);
    }
    return this.forPage(activePage, () => this.blocked && tabs.length ? this.handoff() : this.keep({ content: [{ type: "text", text: `### Open tabs\n${rows.join("\n") || "No open tabs."}` }] }));
  }

  // ── pixels ──────────────────────────────────────────────────────────────────────────────────

  // Checked at capture and after, for the current document of the page in use, for this one call.
  async image(reply, page, { element = false } = {}) {
    if (!reply?.content?.some(part => part?.type === "image")) return reply;
    let verdict = false;
    try {
      const facts = await this.read(page, { closed: true, known: [...this.#net.keys()].slice(-NET_VALUES) });
      verdict = !facts.filled && !facts.echoed && !facts.closedUnread && !(element && facts.unread.length);
    } catch { verdict = false; }
    return verdict ? reply : { ...reply, content: reply.content.map(part => part?.type === "image" ? { type: "text", text: WITHHELD } : part) };
  }

  // ── waiting ─────────────────────────────────────────────────────────────────────────────────

  // Polls the sealed tree. It cannot test a masked value, because the tree does not hold one.
  async waitFor(tab, params, response, signal) {
    const flat = text => String(text).replace(/\s+/g, " ").trim();
    // The tree writes text as YAML, so a quote in it may be escaped or doubled.
    const inTree = (tree, text) => tree.includes(text) || tree.includes(JSON.stringify(text).slice(1, -1)) || tree.includes(text.replaceAll("'", "''"));
    const wanted = params.text ? flat(params.text) : null, gone = params.textGone ? flat(params.textGone) : null;
    const limit = Math.min(WAIT_MAX_MS, params.time ? params.time * 1000 : WAIT_MS);
    const end = Date.now() + limit;
    for (;;) {
      signal?.throwIfAborted?.();
      if (tab.modalStates?.().some(state => state.type === "dialog")) return;
      let tree = null;
      try { tree = await tab.page.ariaSnapshot({ mode: "ai", timeout: Math.max(1000, end - Date.now()) }); } catch {}
      if (this.blocked) return;
      if (tree !== null && (wanted ? inTree(tree, wanted) : !inTree(tree, gone))) { response.addTextResult(`Waited for ${params.text || params.textGone}`); return; }
      const left = end - Date.now();
      if (left <= 0) { response.addError(wanted ? "The text did not appear in time. Read the page before retrying." : "The text is still on the page. Read the page before retrying."); return; }
      await new Promise(resolve => setTimeout(resolve, Math.min(WAIT_STEP_MS, left)));
    }
  }

  // ── what a gate reads ───────────────────────────────────────────────────────────────────────

  // What the host read of this call, never the agent's words. A read that fails is a read that says so.
  async describeAction(page, tab, name, args, { targets = [], reads } = {}) {
    if (!page || !tab) return null;
    if (!tab.modalStates?.().some(state => state.type === "dialog")) await this.read(page);
    if (this.blocked) return { ...this.privacyState(), blocked: true, targets: [], actuated: null, dialog: null };
    const dialog = tab.modalStates?.().find(state => state.type === "dialog")?.dialog;
    // A page with a dialog up answers nothing until the dialog does.
    if (dialog) return { targets: targets.map(() => ({ readable: false })), actuated: null, dialog: { type: dialog.type(), message: this.text(dialog.message()) } };
    // Going back, resizing and the like name nothing, so there is nothing to read.
    if (!targets.length && reads !== "focused") return { targets: [], actuated: null, dialog: null };
    await this.read(page).catch(() => {});
    const toImpl = page._connection.toImpl;
    const out = { targets: [], actuated: null, dialog: null };
    const form = reads === "form";
    for (const target of targets) {
      let handle = null;
      try {
        const { locator } = await tab.targetLocator({ target });
        handle = await locator.elementHandle({ timeout: DESCRIBE_MS });
        const read = await timed(toImpl(handle).evaluateInUtility(([injected, element, options]) => {
          void injected;
          return globalThis[Symbol.for("hoai.browser.answerPrivacy")].describe(element, options);
        }, { form }), DESCRIBE_MS);
        out.targets.push(read);
      } catch (error) {
        // A ref no page answers for presses nothing: the tool says so, and nobody is asked about it.
        out.targets.push(/not found in the current page snapshot/.test(String(error?.message)) ? { readable: true, stale: true } : { readable: false });
      } finally { await handle?.dispose?.().catch(() => {}); }
    }
    if (reads === "focused") {
      try {
        const main = await sealFrame(page, page.mainFrame(), this.#nonce, null);
        out.actuated = await timed(main.injected.evaluate(injected => { void injected; return globalThis[Symbol.for("hoai.browser.answerPrivacy")].describeFocused(); }), DESCRIBE_MS);
      } catch { out.actuated = { readable: false }; }
    }
    return out;
  }

  guardResponse(name, params, response) {
    if (typeof response?._writeFile !== "function" || typeof response?.addFileResult !== "function") throw failure();
    response._writeFile = async () => { throw failure(); };
    response.addFileResult = async () => {};
    const { filename, ...safe } = params || {};
    if (safe.json) throw new Error("Use the protected textual browser snapshot.");
    return safe;
  }
}

module.exports = { AnswerPrivacy, SAFE_TOOLS, MASKED, DIALOG, UNREADABLE, HANDOFF, PERSON, QUESTION, COPY };
