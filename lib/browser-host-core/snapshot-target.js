// The host derived facts for the intent check (P3 stage 3, slice c2; spec
// section 7 and gates.md gate 7). Pure: no Electron, no engine, no state.
//
// WHY. The intent check compares a sensitive action with the owner's last
// request. The host's action phrase carries the element text the AGENT wrote
// when it called the tool, so an agent steered by an injection can describe
// "Make /finance public" as "Send the invoice to finance". Where the host has
// them, the call also carries facts the agent did not write: the tool, and
// the target's ARIA role and accessible name as the host's OWN last snapshot
// names them. The accessible name comes from the page, which an attacker may
// also control, so this narrows the limit and does not close it (spec 7).
//
// THE SNAPSHOT TEXT. Playwright MCP writes every element it can act on as
//   - button "Pay AED 120" [ref=e29] [cursor=pointer]
// i.e. a dash, the role, an optional quoted name (with \" and \\ escapes),
// then bracketed attributes, one of which is the ref. The ref must sit among
// the attributes of THAT line's header: a ref written inside a line's text
// (after the colon) or inside a quoted name is page text, not the ref's line.
//
// WHAT IS TAKEN AS THE SNAPSHOT. A browser_snapshot result, or any other
// tool's result that carries a snapshot section (an action's reply carries
// the page as it now is), and never a browser_evaluate result: that is what
// the page's own script returned, so it could forge a whole section. An error
// result is never kept. The real engine's bound path hands the host the WHOLE
// page tree it read (engine.js, onPageTree), so a ref the agent read from a
// later window of a large page keeps its name after an action's reply showed
// the first window again. The text above is what an unbound or Chrome call has.
//
// WHAT NAMES A TARGET. The pinned Playwright tools take `target` (click, type,
// hover, select), `startTarget` and `endTarget` (drag) and `fields[].target`
// (fill form); there is no `ref` argument. The roster guard in
// snapshot-target.test.js fails when a new tool names one more. `target` also
// takes a selector, which names no ref and so gives the tool alone. A call
// that names several gets them all (targetsOf).
//
// No em dashes or en dashes anywhere in this file.

const { isSensitive } = require("./policy");

/** The most snapshot text the host keeps; a ref past the cut is simply not found. */
const SNAPSHOT_MAX_CHARS = 8 * 1024 * 1024;
/** The top level arguments the real tools name a target in, in the order they are tried. */
const TARGET_ARGS = ["target", "startTarget", "endTarget"];
/** The route's tool rule (backend BROWSER_INTENT_TOOL_PATTERN). */
const TOOL_PATTERN = /^browser_[a-z_]{1,52}$/;
/** A snapshot ref: e29, or a frame's f1e3. Nothing a regex could read as syntax. */
const REF_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** The name the host hands on, at most; the renderer cuts to the route's 80. */
const NAME_MAX_CHARS = 200;
const ROLE_MAX_CHARS = 60;
/** A line's header: the role, the optional quoted name, the bracketed attributes. */
const HEADER = /^\s*-\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]\n]*\])*)/;
/** A section heading that says the text carries the page's snapshot. */
const SNAPSHOT_SECTION = /^(?:#{1,6}\s*(?:Page\s+)?Snapshot\b|-\s*Page Snapshot:)/m;

function unescapeName(raw) {
  return raw.replace(/\\(.)/g, "$1");
}

/**
 * The role and accessible name of `ref` in the snapshot text, or null when
 * the text does not carry that ref. `name` is absent for a line with none.
 */
function targetOfRef(snapshotText, ref) {
  if (typeof snapshotText !== "string" || snapshotText === "") return null;
  if (typeof ref !== "string" || !REF_PATTERN.test(ref)) return null;
  const tag = `[ref=${ref}]`;
  for (const line of snapshotText.split("\n")) {
    if (!line.includes(tag)) continue;
    const m = HEADER.exec(line);
    if (!m) continue;
    const attrs = m[3] || "";
    if (!attrs.includes(tag)) continue;
    const out = { role: m[1].slice(0, ROLE_MAX_CHARS) };
    if (m[2] !== undefined) {
      const name = unescapeName(m[2]).trim();
      if (name !== "") out.name = name.slice(0, NAME_MAX_CHARS);
    }
    return out;
  }
  return null;
}

/**
 * The text of a tool result when it is a snapshot the host may keep, else
 * null: a browser_snapshot result, or another tool's result carrying a
 * snapshot section, never an error and never browser_evaluate. Bounded.
 */
function snapshotTextOf(toolName, result) {
  if (toolName === "browser_evaluate") return null;
  if (!result || typeof result !== "object" || result.isError) return null;
  if (!Array.isArray(result.content)) return null;
  const text = result.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  if (text === "") return null;
  if (toolName !== "browser_snapshot" && !SNAPSHOT_SECTION.test(text)) return null;
  return text.slice(0, SNAPSHOT_MAX_CHARS);
}

/**
 * Every target this call names that the snapshot carries, in the order a reader should meet them:
 * a drag's destination before what it moves, and anything sensitive before anything else. A steered
 * agent can list a harmless field first, and what the owner reads is cut to a length.
 */
function targetsOf(args, snapshotText) {
  if (!args || typeof args !== "object") return [];
  const named = [args.endTarget, args.target, args.startTarget];
  if (Array.isArray(args.fields)) for (const field of args.fields) named.push(field && field.target);
  const targets = named.map((ref) => targetOfRef(snapshotText, ref)).filter(Boolean);
  const sensitive = (target) => typeof target.name === "string" && isSensitive("browser_click", { element: target.name });
  return [...targets.filter(sensitive), ...targets.filter((target) => !sensitive(target))];
}

/**
 * The facts a gate raised by this call carries for the intent check: the tool
 * always (when the route would take its name), and the target's role and name
 * only when the call names a ref the last snapshot carries. Null when the tool
 * is not a browser tool the route accepts.
 */
function gateFactsFor(toolName, args, snapshotText) {
  if (typeof toolName !== "string" || !TOOL_PATTERN.test(toolName)) return null;
  const facts = { tool: toolName };
  const targets = targetsOf(args, snapshotText);
  if (targets.length) {
    facts.targetRole = targets[0].role;
    const names = [...new Set(targets.map((target) => target.name).filter(Boolean))];
    if (names.length) facts.targetName = names.join(", ").slice(0, NAME_MAX_CHARS);
  }
  return facts;
}

/** The tree the engine read, as the host keeps it, or null when it read none. */
function pageTreeText(tree) {
  return typeof tree === "string" && tree !== "" ? tree.slice(0, SNAPSHOT_MAX_CHARS) : null;
}

module.exports = { targetOfRef, snapshotTextOf, gateFactsFor, pageTreeText, SNAPSHOT_MAX_CHARS, TARGET_ARGS };
