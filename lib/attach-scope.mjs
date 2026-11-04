/**
 * attach-scope: does this daemon's session belong to the agent it resolved?
 *
 * Board row bab90cdb. Design: BGOS docs/superpowers/specs/
 * 2026-08-29-mcp-daemon-attach-gating-design.md (#1244), "attach on explicit
 * intent, not on folder residency": fail open, telemetry first, a measured flip.
 *
 * THE DEFECT. On a computer that runs several agents, the machine wide
 * marketplace copy of the plugin starts a daemon for EVERY Claude Code session,
 * and the daemon becomes whichever agent the env, the folder pin or the
 * credentials files resolve to. An inherited BGOS_ASSISTANT_ID (a worker started
 * from an agent's Bash tool, in another agent's folder) beats the folder pin, so
 * that session attaches as the wrong agent and answers in its name. Intent
 * exists only in the launcher, and until now the launcher never said it.
 *
 * THE SCOPE. The launcher (bin/hoai-core.mjs) names the agent it launches in
 * HOAI_ATTACH_SCOPE=<assistant id> and the folder it launches it in, in
 * HOAI_ATTACH_SCOPE_DIR, overriding anything inherited. Without an explicit
 * identity, only the folder is handed over: the daemon resolves the agent
 * after Claude applies its configuration. The env rides into every
 * child, so a scope seen in ANOTHER folder than the one it names was inherited
 * (a plain `claude` started from an agent's Bash tool) and says nothing about
 * this session. The daemon compares the scope with the agent it resolved:
 *   match        the launcher meant this agent, or explicitly launched this
 *                folder without naming an agent: attach, in every mode;
 *   wrong-agent  the launcher meant ANOTHER agent (by 'scope'), or this
 *                folder's .bgos-agent-id pin names another agent than the one
 *                resolved (by 'folder': an inherited BGOS_ASSISTANT_ID beat it);
 *   unscoped     no launcher named this session's agent: a hand typed `claude`,
 *                a generation one keepalive, a .mcp.json launch, an inherited
 *                scope;
 *   unreadable   the scope, the identity or the env could not be read: attach,
 *                in every mode. A safety check that cannot see must never be
 *                the reason a real agent goes dark (design section 5).
 * Which launcher it was is recorded too ('hoai', 'gen1' for BGOS_CONTINUE,
 * 'inherited', 'env' for a scope set by hand, 'none'), because the strict flip
 * must tell a real agent whose launcher has not learned the scope from a stray.
 *
 * KNOWN LIMIT, a discipline boundary and not a cryptographic one (design
 * section 3): a child started in the SAME folder as its parent agent inherits a
 * scope that still names that folder, and reads as a match.
 *
 * THE LEGACY SETTING, which starts OFF for clone installs (design phase 1).
 * Marketplace installs now use lib/marketplace-attach.ts with a home default.
 * HOAI_ATTACH_SCOPE_MODE for one
 * process, else ~/.bgos-agent/attach-scope.json {"mode": ...} for the computer:
 *   off          refuse nothing; record what WOULD have been refused (default);
 *   wrong-agent  refuse a session scoped to another agent;
 *   strict       also refuse an unscoped session (the design's end state).
 * Anything unreadable or unknown is off. The staged middle step exists because
 * the two would-refuse classes carry very different risk: a wrong-agent session
 * is wrong by construction, an unscoped one may be a real agent whose launcher
 * has not learned the scope yet (design section 4, "who breaks").
 *
 * THE TELEMETRY. Every evaluation appends one JSON line to
 * <plugin state>/attach-scope-events.jsonl (rotated at a cap), and the summary
 * says how many sessions each mode WOULD have refused. The heartbeat cannot
 * carry it yet: the backend's HeartbeatEnvDto whitelist strips unknown fields
 * and its shadow interceptor counts them as offenders against the strict
 * validation flip, so a new field needs the backend first (a follow up). The
 * check up row (lib/doctor-rpc.ts) and bin/hoai-attach-scope.mjs read the file.
 * Two daemons rotating at the same instant can lose one rotated generation;
 * that is telemetry, and the live file is never lost.
 *
 * Plain JavaScript, no top level side effects, all IO injectable or bounded.
 * Never throws out of a public function. Every text is dash free.
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Set by the launcher: the assistant id the session is launched for. */
export const ATTACH_SCOPE_ENV = 'HOAI_ATTACH_SCOPE'
/** Set by the launcher: the folder it launched the session in. */
export const ATTACH_SCOPE_DIR_ENV = 'HOAI_ATTACH_SCOPE_DIR'
/** The setting, for one process. Wins over the machine file. */
export const ATTACH_SCOPE_MODE_ENV = 'HOAI_ATTACH_SCOPE_MODE'
/** The setting, for every agent on this computer, under ~/.bgos-agent. */
export const ATTACH_SCOPE_SETTINGS_FILE = 'attach-scope.json'
/** The telemetry, under the plugin state dir. */
export const ATTACH_SCOPE_EVENTS_FILE = 'attach-scope-events.jsonl'
/** Rotate the events file past this many bytes (one generation kept as .1). */
export const ATTACH_SCOPE_EVENTS_MAX_BYTES = 256 * 1024

export const ATTACH_SCOPE_MODES = Object.freeze(['off', 'wrong-agent', 'strict'])
export const DEFAULT_ATTACH_SCOPE_MODE = 'off'

const ID_RE = /^\d{1,12}$/

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** An id as a number would read it: '0900' and '900' are one agent. */
function normId(id) {
  return id.replace(/^0+(?=\d)/, '')
}

/** One env value, '' when absent; throws only when the env itself throws. */
function envText(env, key) {
  const raw = env?.[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Are two folder spellings one folder? Through realpath when both resolve (a
 * symlinked or junction spelling), then trimmed of trailing separators and case
 * folded where the filesystem is case insensitive (macOS, Windows), the same
 * normalization the home check uses (lib/agent-credentials.ts normalizeHomeDir).
 */
export function sameFolder(a, b, { platform = process.platform, realpath = defaultRealpath } = {}) {
  const norm = (dir) => {
    let out = clean(dir)
    if (!out) return ''
    try {
      out = realpath(out) || out
    } catch {
      // Unresolvable (gone, no permission): compare the spelling.
    }
    const trimmed = out.replace(/[\\/]+$/, '') || out.slice(0, 1)
    return platform === 'win32' || platform === 'darwin' ? trimmed.toLowerCase() : trimmed
  }
  const x = norm(a)
  return x !== '' && x === norm(b)
}

function defaultRealpath(path) {
  return realpathSync(path)
}

/**
 * What the launcher said, read from `env`.
 * @param {Record<string, string | undefined>} env
 * @returns {{ state: 'absent' } | { state: 'scoped', assistantId: string } | { state: 'unreadable' }}
 */
export function readAttachScope(env) {
  let raw
  try {
    raw = env?.[ATTACH_SCOPE_ENV]
  } catch {
    return { state: 'unreadable' }
  }
  if (raw === undefined || raw === null) return { state: 'absent' }
  if (typeof raw !== 'string') return { state: 'unreadable' }
  const value = raw.trim()
  if (!value) return { state: 'absent' }
  if (!ID_RE.test(value)) return { state: 'unreadable' }
  return { state: 'scoped', assistantId: value }
}

function normalizeMode(value) {
  const mode = clean(value).toLowerCase()
  return ATTACH_SCOPE_MODES.includes(mode) ? mode : null
}

/**
 * The setting: the env var, else the machine file, else the default (off).
 * An unreadable or unknown value is off, with `invalid` saying what was seen.
 * @param {{ env?: Record<string, string | undefined>, readText?: (path: string) => string | null,
 *   settingsPath?: string }} input
 * @returns {{ mode: 'off' | 'wrong-agent' | 'strict', source: 'env' | 'file' | 'default', invalid?: string }}
 */
export function resolveAttachScopeMode({ env = {}, readText, settingsPath = '' } = {}) {
  let fromEnv
  try {
    fromEnv = env?.[ATTACH_SCOPE_MODE_ENV]
  } catch {
    return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'env', invalid: 'the environment could not be read' }
  }
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    const mode = normalizeMode(fromEnv)
    if (mode) return { mode, source: 'env' }
    return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'env', invalid: `${ATTACH_SCOPE_MODE_ENV}=${oneLine(fromEnv, 40)}` }
  }
  if (!readText || !settingsPath) return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'default' }
  let text
  try {
    text = readText(settingsPath)
  } catch (err) {
    return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'file', invalid: `unreadable: ${oneLine(err?.code ?? err?.message ?? err, 60)}` }
  }
  if (text === null || text === undefined) return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'default' }
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch {
    return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'file', invalid: 'not JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'file', invalid: 'not an object' }
  }
  const mode = normalizeMode(parsed.mode)
  if (mode) return { mode, source: 'file' }
  return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'file', invalid: `mode ${oneLine(JSON.stringify(parsed.mode ?? null), 40)}` }
}

/** Marketplace enforcement has a home default; explicit settings retain their meaning. */
export function effectiveAttachScopeMode(setting, installMethod) {
  return installMethod === 'marketplace' && setting.source === 'default'
    ? { ...setting, mode: 'home' } : setting
}

/**
 * THE SCOPE DECISION. Pure (realpath is injectable).
 *
 * `refusedFrom` is the first mode that would refuse this session ('wrong-agent'
 * for a wrong agent, 'strict' for an unscoped one, null when no mode would):
 * what the telemetry counts while the mode is off. `by` says which signal named
 * the wrong agent ('scope' or 'folder'), `launcher` who launched the session.
 *
 * @param {{ mode?: string, env?: Record<string, string | undefined>, assistantId?: string,
 *   cwd?: string, folderPinId?: string, platform?: string, realpath?: (p: string) => string }} input
 * @returns {{ verdict: 'attach' | 'refuse', outcome: 'match' | 'wrong-agent' | 'unscoped' | 'unreadable',
 *   refusedFrom: 'wrong-agent' | 'strict' | null, by: 'scope' | 'folder' | null,
 *   launcher: 'hoai' | 'gen1' | 'inherited' | 'env' | 'none', mode: string, scopeId: string,
 *   folderPinId: string, assistantId: string }}
 */
export function decideAttachScope({ mode, env, assistantId, cwd = '', folderPinId = '', platform, realpath } = {}) {
  // Exact: the setting reader (resolveAttachScopeMode) already normalized it,
  // so anything else reaching here is a caller's bug and counts as off.
  const effective = ATTACH_SCOPE_MODES.includes(mode) ? mode : DEFAULT_ATTACH_SCOPE_MODE
  const rawSelf = clean(assistantId)
  const self = ID_RE.test(rawSelf) ? normId(rawSelf) : ''
  const scope = readAttachScope(env)
  const scopeId = scope.state === 'scoped' ? normId(scope.assistantId) : ''
  const pin = ID_RE.test(clean(folderPinId)) ? normId(clean(folderPinId)) : ''
  let scopeDir = ''
  let continued = false
  let envReadable = scope.state !== 'unreadable'
  if (envReadable) {
    try {
      scopeDir = envText(env, ATTACH_SCOPE_DIR_ENV)
      continued = envText(env, 'BGOS_CONTINUE') === '1'
    } catch {
      envReadable = false
    }
  }
  // Who launched it. A scope folder that is not this folder came down the env
  // from a parent, so the scope in it is the parent's, not this session's.
  let launcher = 'none'
  let ownScope = scope.state === 'scoped'
  if (scopeDir) {
    const here = clean(cwd)
    if (!here || sameFolder(scopeDir, here, { platform, realpath })) launcher = 'hoai'
    else {
      launcher = 'inherited'
      ownScope = false
    }
  } else if (scope.state === 'scoped') launcher = 'env'
  else if (continued) launcher = 'gen1'
  const base = { mode: effective, scopeId, folderPinId: pin, assistantId: rawSelf, launcher }
  const decide = (verdict, outcome, refusedFrom, by = null) => ({ ...base, verdict, outcome, refusedFrom, by })
  // FAIL OPEN: what cannot be read cannot be judged.
  if (!envReadable || !self) return decide('attach', 'unreadable', null)
  const refuseWrong = effective === 'wrong-agent' || effective === 'strict'
  // The folder declares another agent: whatever the env says, this session
  // is in another agent's folder speaking as this one.
  if (pin && pin !== self) return decide(refuseWrong ? 'refuse' : 'attach', 'wrong-agent', 'wrong-agent', 'folder')
  // A fresh unpinned hoai launch names its folder, leaving identity to the
  // daemon's effective configuration. Inherited markers and numeric scope
  // mismatches cannot use this path, and a wrong folder pin was checked above.
  if (launcher === 'hoai' && clean(cwd) && scope.state === 'absent') return decide('attach', 'match', null)
  if (ownScope && scopeId === self) return decide('attach', 'match', null)
  if (ownScope) return decide(refuseWrong ? 'refuse' : 'attach', 'wrong-agent', 'wrong-agent', 'scope')
  return decide(effective === 'strict' ? 'refuse' : 'attach', 'unscoped', 'strict')
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/**
 * Append one evaluation to the machine's events file. Never throws: false when
 * nothing could be written. Rotates the file aside (one generation, `.1`) once
 * it passes `maxBytes`, so a crash looping daemon cannot fill a disk.
 *
 * @param {{ dir: string, decision: ReturnType<typeof decideAttachScope>, mode?: string,
 *   route?: string, version?: string | null, cwd?: string, pid?: number, now?: number,
 *   maxBytes?: number }} input
 * @returns {boolean}
 */
export function recordAttachScopeEvent({
  dir,
  decision,
  mode,
  route = '',
  version = null,
  cwd = '',
  pid = process.pid,
  now = Date.now(),
  maxBytes = ATTACH_SCOPE_EVENTS_MAX_BYTES,
}) {
  try {
    if (!dir || !decision) return false
    mkdirSync(dir, { recursive: true })
    const path = join(dir, ATTACH_SCOPE_EVENTS_FILE)
    try {
      if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`)
    } catch {
      // No file yet, or a concurrent daemon rotated it first: append below.
    }
    const event = {
      at: new Date(now).toISOString(),
      outcome: decision.outcome,
      verdict: decision.verdict,
      refusedFrom: decision.refusedFrom,
      by: decision.by ?? null,
      launcher: decision.launcher ?? 'none',
      folderPin: decision.folderPinId ?? '',
      mode: normalizeMode(mode) ?? decision.mode,
      scope: decision.scopeId,
      assistantId: decision.assistantId,
      route: oneLine(route, 32),
      version: version ? oneLine(version, 40) : null,
      cwd: oneLine(cwd, 512),
      pid,
    }
    // One write of one short line with O_APPEND: concurrent daemons booting
    // together interleave whole lines, never halves.
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Every readable event in the events file (and its rotated generation), oldest
 * first. A torn or foreign line is skipped; a missing file is empty.
 * @param {{ dir: string, readText?: (path: string) => string | null }} input
 * @returns {Array<Record<string, unknown>>}
 */
export function readAttachScopeEvents({ dir, readText = defaultReadText }) {
  const out = []
  if (!dir) return out
  const path = join(dir, ATTACH_SCOPE_EVENTS_FILE)
  for (const file of [`${path}.1`, path]) {
    let text = null
    try {
      text = readText(file)
    } catch {
      text = null
    }
    if (!text) continue
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (event && typeof event === 'object' && !Array.isArray(event) && typeof event.outcome === 'string') {
          out.push(event)
        }
      } catch {
        // A torn line from a crash mid write: skip it.
      }
    }
  }
  return out
}

/**
 * Count the events inside the window. `wouldRefuseWrongAgent` is how many
 * starts mode wrong-agent would have refused, `wouldRefuseStrict` how many
 * strict would have (it includes the first). `refused` is how many WERE. The
 * `distinct` counts key a start by (agent, folder), so one crash looping
 * stray that booted forty times is one session, not forty. Unscoped starts are
 * split by launcher and wrong agents by the signal that named them, which is
 * what tells a real agent whose launcher has not learned the scope (gen1) from
 * a stray (none, inherited) before the strict flip.
 *
 * @param {Array<Record<string, unknown>>} events
 * @param {{ now?: number, windowMs?: number }} [opts]
 */
export function summarizeAttachScopeEvents(events, { now = Date.now(), windowMs = 7 * 24 * 3600_000 } = {}) {
  const summary = {
    windowMs,
    total: 0,
    match: 0,
    wrongAgent: 0,
    unscoped: 0,
    unreadable: 0,
    refused: 0,
    wouldRefuseWrongAgent: 0,
    wouldRefuseStrict: 0,
    distinctWouldRefuseWrongAgent: 0,
    distinctWouldRefuseStrict: 0,
    unscopedByLauncher: { hoai: 0, gen1: 0, inherited: 0, none: 0, env: 0 },
    wrongAgentBy: { scope: 0, folder: 0 },
    lastWouldRefuseAt: null,
  }
  const wrongKeys = new Set()
  const strictKeys = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    const at = Date.parse(String(event.at ?? ''))
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > windowMs) continue
    const outcome = event.outcome
    if (outcome === 'match') summary.match += 1
    else if (outcome === 'wrong-agent') summary.wrongAgent += 1
    else if (outcome === 'unscoped') summary.unscoped += 1
    else if (outcome === 'unreadable') summary.unreadable += 1
    else continue
    summary.total += 1
    if (event.verdict === 'refuse') summary.refused += 1
    if (outcome !== 'wrong-agent' && outcome !== 'unscoped' && !(outcome === 'match' && event.refusedFrom === 'strict')) continue
    const key = `${String(event.assistantId ?? '')}|${String(event.cwd ?? '')}`
    if (outcome === 'wrong-agent') {
      summary.wouldRefuseWrongAgent += 1
      wrongKeys.add(key)
      const by = event.by === 'folder' ? 'folder' : 'scope'
      summary.wrongAgentBy[by] += 1
    } else if (outcome === 'unscoped') {
      const launcher = Object.hasOwn(summary.unscopedByLauncher, String(event.launcher)) ? String(event.launcher) : 'none'
      summary.unscopedByLauncher[launcher] += 1
    }
    summary.wouldRefuseStrict += 1
    strictKeys.add(key)
    if (summary.lastWouldRefuseAt === null || at > Date.parse(summary.lastWouldRefuseAt)) {
      summary.lastWouldRefuseAt = new Date(at).toISOString()
    }
  }
  summary.distinctWouldRefuseWrongAgent = wrongKeys.size
  summary.distinctWouldRefuseStrict = strictKeys.size
  return summary
}

// ── What people read ─────────────────────────────────────────────────────────

function describeOutcome(d) {
  if (d.outcome === 'match' && !d.scopeId) return `agent ${d.assistantId}: matching home or explicit opt in`
  if (d.outcome === 'match') return `launched for agent ${d.scopeId}, resolved agent ${d.assistantId}: the right agent`
  if (d.outcome === 'wrong-agent' && d.by === 'folder') {
    return `this folder is pinned to agent ${d.folderPinId}, resolved agent ${d.assistantId}: the WRONG agent`
  }
  if (d.outcome === 'wrong-agent') return `launched for agent ${d.scopeId}, resolved agent ${d.assistantId}: the WRONG agent`
  if (d.outcome === 'unscoped' && d.launcher === 'inherited') {
    return `the launcher scope was inherited from another folder, resolved agent ${d.assistantId || 'unknown'}`
  }
  if (d.outcome === 'unscoped') {
    return `no launcher named the agent (launcher ${d.launcher ?? 'none'}), resolved agent ${d.assistantId || 'unknown'}`
  }
  return `scope or identity unreadable, failing open (resolved agent ${d.assistantId || 'unknown'})`
}

/**
 * The one boot log line: the mode, where it came from, the scope, the agent,
 * and what this daemon does (or would do, when the mode is off).
 */
export function formatAttachScopeBootLine(decision, modeInfo) {
  const d = decision ?? {}
  const info = modeInfo ?? { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'default' }
  const setting = `mode=${info.mode} (${info.source}${info.invalid ? `, ignored ${info.invalid}` : ''})`
  let act
  if (d.verdict === 'refuse') act = 'REFUSING to attach'
  else if (d.refusedFrom) act = `attaching; mode ${d.refusedFrom} WOULD refuse this session`
  else act = 'attaching'
  return oneLine(`attach scope: ${setting}; ${describeOutcome(d)}; ${act}`, 600)
}

/** The refusal a refused session reads (through the notice tool). */
export function formatAttachScopeRefusal(decision) {
  const d = decision ?? {}
  const off = `To stop refusing, set ${ATTACH_SCOPE_MODE_ENV}=off (or remove ~/.bgos-agent/${ATTACH_SCOPE_SETTINGS_FILE}).`
  if (d.outcome === 'wrong-agent' && d.by === 'folder') {
    return (
      `REFUSING to attach: this folder is pinned to agent ${d.folderPinId} (its .bgos-agent-id), but ` +
      `the HOAI channel resolved agent ${d.assistantId}, most likely from a BGOS_ASSISTANT_ID this ` +
      `session inherited from the process that started it. Attaching would answer in agent ` +
      `${d.assistantId}'s name from agent ${d.folderPinId}'s folder. Start agent ${d.folderPinId} with ` +
      `hoai in this folder, or start this session without BGOS_ASSISTANT_ID. ${off}`
    )
  }
  if (d.outcome === 'wrong-agent') {
    return (
      `REFUSING to attach: this session was launched for agent ${d.scopeId}, but the HOAI channel ` +
      `resolved agent ${d.assistantId} (an inherited BGOS_ASSISTANT_ID, a folder pin or a credentials ` +
      `file named it). Attaching would answer in agent ${d.assistantId}'s name. Start agent ` +
      `${d.assistantId} from its own launcher (hoai, in its folder), or launch agent ${d.scopeId} ` +
      `with its own identity. ${off}`
    )
  }
  if (d.outcome === 'unscoped') {
    return (
      `REFUSING to attach: no launcher named the agent this session is for (${ATTACH_SCOPE_ENV} is ` +
      `unset, or was inherited from another folder), and this computer requires one (strict mode). If this session is meant to be agent ` +
      `${d.assistantId || '<id>'}, start it with hoai from the agent's folder, which sets ` +
      `${ATTACH_SCOPE_ENV}. ${off}`
    )
  }
  return ''
}

/**
 * The check up row (lib/doctor-rpc.ts DoctorCheck shape): this daemon's own
 * verdict plus the machine's tally in the summary window. WARN only for a
 * wrong agent, which is wrong by construction; an unscoped session is the
 * normal state of a launcher that has not learned the scope yet, so it is
 * OK while the mode is off.
 */
export function attachScopeDoctorCheck({ decision, mode, summary }) {
  const d = decision ?? {}
  const s = summary ?? summarizeAttachScopeEvents([])
  const days = Math.max(1, Math.round((s.windowMs ?? 0) / (24 * 3600_000)))
  const tally =
    `This computer, last ${days} day${days === 1 ? '' : 's'}: ${s.total} session start${s.total === 1 ? '' : 's'}, ` +
    `${s.wrongAgent} wrong agent, ${s.unscoped} unscoped, ${s.unreadable} unreadable, ${s.refused} refused.`
  const effectiveMode = mode === 'home' ? mode : normalizeMode(mode) ?? DEFAULT_ATTACH_SCOPE_MODE
  const own = `Mode ${effectiveMode}; this session: ${describeOutcome(d)}.`
  if (d.outcome === 'wrong-agent') {
    return {
      name: 'Attach scope',
      status: 'WARN',
      detail: oneLine(`${own} ${tally}`, 400),
      fix: oneLine(
        `Start agent ${d.assistantId} from its own folder with hoai, and do not start other agents from inside it.`,
        400,
      ),
    }
  }
  return { name: 'Attach scope', status: 'OK', detail: oneLine(`${own} ${tally}`, 400) }
}

/** The machine tally as one line (bin/hoai-attach-scope.mjs): what to read before the flip. */
export function formatAttachScopeSummary(summary, modeInfo) {
  const s = summary ?? summarizeAttachScopeEvents([])
  const info = modeInfo ?? { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'default' }
  const days = Math.max(1, Math.round((s.windowMs ?? 0) / (24 * 3600_000)))
  return oneLine(
    `attach scope: mode ${info.mode} (${info.source}${info.invalid ? `, ignored ${info.invalid}` : ''}); ` +
      `last ${days} days: ${s.total} starts, ${s.match} right agent, ${s.wrongAgent} wrong agent, ` +
      `${s.unscoped} unscoped, ${s.unreadable} unreadable, ${s.refused} refused; ` +
      `mode wrong-agent would refuse ${s.wouldRefuseWrongAgent}, strict would refuse ${s.wouldRefuseStrict}` +
      ` (distinct agent and folder: ${s.distinctWouldRefuseWrongAgent ?? 0} and ${s.distinctWouldRefuseStrict ?? 0}); ` +
      `wrong agent by scope ${s.wrongAgentBy?.scope ?? 0}, by folder pin ${s.wrongAgentBy?.folder ?? 0}; ` +
      `unscoped by launcher: hoai ${s.unscopedByLauncher?.hoai ?? 0}, generation one ${s.unscopedByLauncher?.gen1 ?? 0}, ` +
      `inherited ${s.unscopedByLauncher?.inherited ?? 0}, by hand ${s.unscopedByLauncher?.env ?? 0}, ` +
      `none ${s.unscopedByLauncher?.none ?? 0}` +
      (s.lastWouldRefuseAt ? `; last ${s.lastWouldRefuseAt}` : ''),
    1000,
  )
}

function oneLine(value, max) {
  const text = String(value ?? '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? text.slice(0, max) : text
}

function defaultReadText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
