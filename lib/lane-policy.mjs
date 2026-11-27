/**
 * PERSON LANES, the share's tool policy and a person's own model and effort
 * (shared agents Phase 3: P7 for the policy, P5 for model and effort; design
 * 7.2 "The options" and "How a running lane learns", section 6 rows Model and
 * Effort, decision K7).
 *
 * THE POLICY. The backend serves a share's `toolPolicy` (BGOS P6,
 * backend/src/common/share-tool-policy.ts) on `GET lanes/me` and on every
 * `POST lanes/heartbeat` answer. ABSENT MEANS LOCKED: a missing, malformed or
 * unknown version policy, and any option that is not literally `true`, reads
 * as off, so every path that loses the term can only tighten a lane. What each
 * option does at launch, on top of the locked base (lib/lane-core.mjs):
 *
 *   webFetch         `WebFetch` and `WebSearch` in `--tools` and allowed.
 *   readAgentFolder  the agent's own folder readable, never writable: listed in
 *                    the lane settings' `additionalDirectories`, `Read` allowed
 *                    and `Edit` denied there. NEVER `--add-dir` on the command
 *                    line, where findAgentClaudePids would take the lane for
 *                    the owner's Claude (spike S5). Refused outright for the
 *                    home folder, a folder that holds the agent state folders,
 *                    or one inside them.
 *   shell            refused for every person lane at launch.
 *   ownerMcpServers  refused until person lanes run as a separate OS user.
 *   browser          the lane daemon (lane-server.ts, lib/lane-browser.ts)
 *                    serves the Agent Browser tools under `bgos`, calling the
 *                    relay with its OWN lane session (BGOS admits a lane on
 *                    POST integrations/browser/mcp since the shared vault,
 *                    plan 2026-11-13 section 4.2), never the pairing and never
 *                    the shim, whose local door is the owner's own desktop
 *                    browser (D3). Allowed by name, a fixed list
 *                    (LANE_BROWSER_TOOL_NAMES), plus the two vault tools.
 *                    Never in a thread.
 *   ownerBoards      the backend's own option (CORE-CONTRACTS 7.7); nothing
 *                    here.
 *
 * A change: TIGHTER (anything the running lane was launched with is now off)
 * restarts the lane at once onto the stricter launch; LOOSER waits for the
 * lane's next idle moment. Launch flags are fixed for a process's life, so a
 * restart is the only way either can apply.
 *
 * MODEL AND EFFORT (K7): the agent's own by default; a person may switch only
 * to models and effort levels on the owner's list for that agent. BGOS main
 * serves no such list, so the owner keeps it on this machine
 * (`hoai-lane models`, `people/lane-models.json`); with no list, nothing but
 * the agent's default is allowed.
 *
 * Plain JavaScript: the supervisor runs on a bare `node`.
 *
 * No em or en dashes in this file.
 */
import { posix as posixPath, win32 as win32Path } from 'node:path'

import { isInsideFolder, LANE_EFFORT_LEVELS, LANE_MODEL_RE, permissionRulePath, personLaneStamp } from './lane-core.mjs'

// ── The tool policy ─────────────────────────────────────────────────────────

/** The only policy shape this file reads (BGOS TOOL_POLICY_VERSION). */
export const TOOL_POLICY_VERSION = 1

/** The options that change how a lane is launched. */
export const LAUNCH_POLICY_OPTIONS = Object.freeze(['webFetch', 'readAgentFolder', 'browser'])

/** Every option this file reads. */
export const TOOL_POLICY_OPTIONS = Object.freeze([...LAUNCH_POLICY_OPTIONS, 'shell', 'ownerMcpServers'])

/**
 * The Agent Browser tools a person's lane serves and allows, by name: the
 * agent host's roster (bin/hoai-browser-host.mjs SESSION_TOOLS and
 * FORM_TOOL_CLASSES) MINUS the two that move a file from the owner's
 * computer into a page (browser_file_upload, browser_drop). A fixed list, so
 * a tool a newer host adds never widens a lane until it is named here.
 */
export const LANE_BROWSER_TOOL_NAMES = Object.freeze([
  'hoai_browser_open_session',
  'hoai_browser_close_session',
  'hoai_browser_status',
  'hoai_browser_wait_gate',
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_find',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_handle_dialog',
  'browser_resize',
  'browser_tabs',
  'browser_close',
])

/** The lane's own vault tools (lib/lane-browser.ts), with the browser: a fill is a browser act. */
export const LANE_VAULT_TOOL_NAMES = Object.freeze(['vault_items', 'vault_fill'])

/**
 * The allow rules of the lane's own `bgos` tools that the browser option
 * adds, for the lane's settings only (lib/lane-supervisor.mjs). Never for a
 * thread: a thread has no `bgos` server at all.
 *
 * @param {unknown} policy
 * @returns {string[]}
 */
export function laneBrowserAllowAdditions(policy) {
  if (!readToolPolicy(policy).browser) return []
  return [...LANE_BROWSER_TOOL_NAMES, ...LANE_VAULT_TOOL_NAMES].map((name) => `mcp__bgos__${name}`)
}

export const LOCKED_TOOL_POLICY = Object.freeze({
  v: 1,
  webFetch: false,
  readAgentFolder: false,
  browser: false,
  shell: false,
  ownerMcpServers: false,
})

/**
 * @typedef {{ v: 1, webFetch: boolean, readAgentFolder: boolean, browser: boolean, shell: boolean, ownerMcpServers: boolean }} LaneToolPolicy
 */

/**
 * Read a served policy. Absent, malformed or another version: the locked one.
 * @param {unknown} raw
 * @returns {LaneToolPolicy}
 */
export function readToolPolicy(raw) {
  const r = /** @type {Record<string, unknown>} */ (raw)
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.v !== TOOL_POLICY_VERSION) return { ...LOCKED_TOOL_POLICY }
  const out = /** @type {Record<string, unknown>} */ ({ v: 1 })
  for (const option of TOOL_POLICY_OPTIONS) out[option] = r[option] === true
  return /** @type {LaneToolPolicy} */ (out)
}

/**
 * The policy a `lanes/heartbeat` answer carries, or null when it carries none
 * (a database error on the server: keep the launch flags).
 */
export function heartbeatToolPolicy(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'toolPolicy')) return null
  return readToolPolicy(body.toolPolicy)
}

/**
 * `lanes/me`, read for one lane: its policy only when the answer names
 * exactly this lane, else null.
 */
export function laneMePolicy(body, lane) {
  if (!body || typeof body !== 'object') return null
  if (body.actorUserId !== lane?.userId || String(body.assistantId) !== String(lane?.assistantId)) return null
  if (body.lane !== personLaneStamp(lane.userId)) return null
  return readToolPolicy(body.toolPolicy)
}

/**
 * How the policy now served compares with the one the running lane was
 * launched with. `tighter` wins when both an option went off and another came
 * on: anything less would keep a revoked tool until the lane idles.
 *
 * @param {unknown} launched
 * @param {unknown} current
 * @returns {'same' | 'tighter' | 'looser'}
 */
export function compareToolPolicy(launched, current) {
  const a = readToolPolicy(launched)
  const b = readToolPolicy(current)
  if (LAUNCH_POLICY_OPTIONS.some((o) => a[o] && !b[o])) return 'tighter'
  if (LAUNCH_POLICY_OPTIONS.some((o) => !a[o] && b[o])) return 'looser'
  return 'same'
}

// ── What each option adds at launch ─────────────────────────────────────────

/**
 * The built in tools of a lane, written out in full (never "add to").
 * @param {unknown} policy
 * @param {readonly string[]} baseTools
 * @returns {string[]}
 */
export function laneToolsFor(policy, baseTools) {
  const p = readToolPolicy(policy)
  return [
    ...baseTools,
    ...(p.webFetch ? ['WebFetch', 'WebSearch'] : []),
  ]
}

/**
 * The allow rules each option adds (the locked base's own rules come first, elsewhere).
 * @param {unknown} policy
 * @param {{ agentFolder?: string | null, ownerServerNames?: string[], platform?: string }} [opts]
 * @returns {string[]}
 */
export function laneAllowAdditions(policy, { agentFolder = null, platform = process.platform } = {}) {
  const p = readToolPolicy(policy)
  return [
    ...(p.webFetch ? ['WebFetch', 'WebSearch'] : []),
    ...(p.readAgentFolder && agentFolder ? [`Read(${permissionRulePath(agentFolder, platform)}/**)`] : []),
  ]
}

/**
 * The deny rules each option adds: the agent folder is read only.
 * @param {unknown} policy
 * @param {{ agentFolder?: string | null, platform?: string }} [opts]
 * @returns {string[]}
 */
export function laneDenyAdditions(policy, { agentFolder = null, platform = process.platform } = {}) {
  const p = readToolPolicy(policy)
  return p.readAgentFolder && agentFolder
    ? [`Edit(${permissionRulePath(agentFolder, platform)}/**)`, ...laneAgentFolderSecretDenies(agentFolder, platform)]
    : []
}

// ── What a lane must never read, whatever the policy opens ───────────────────

/**
 * Inside the agent folder a `readAgentFolder` share opens, the files that
 * hold credentials (security review H1): an MCP config with the owner's keys,
 * the git config (remote URLs can carry tokens), the folder's own Claude
 * settings, any `.env*` and any credentials file. Read is DENIED there, which
 * the CLI ranks above the folder's Read allow.
 *
 * @param {string} agentFolder
 * @param {string} [platform]
 * @returns {string[]}
 */
export function laneAgentFolderSecretDenies(agentFolder, platform = process.platform) {
  const root = permissionRulePath(agentFolder, platform)
  return [
    `Read(${root}/.mcp.json)`,
    `Read(${root}/**/.mcp.json)`,
    `Read(${root}/.git/**)`,
    `Read(${root}/**/.git/**)`,
    `Read(${root}/.claude/**)`,
    `Read(${root}/**/.env*)`,
    `Read(${root}/.env*)`,
    `Read(${root}/**/credentials*.json)`,
  ]
}

/**
 * Can this host run the CLI Bash sandbox for the owner's own thread lanes?
 * Person lanes never use this check and never receive Bash.
 *
 * @param {{ platform?: string, exists: (p: string) => boolean, onPath?: (name: string) => boolean }} deps
 */
export function laneShellSandboxAvailable({ platform = process.platform, exists, onPath }) {
  if (platform === 'darwin') return exists('/usr/bin/sandbox-exec')
  if (platform === 'linux') return Boolean(onPath?.('bwrap') && onPath?.('socat'))
  return false
}

// ── readAgentFolder: which folder, and when it is refused ───────────────────

const RULE_UNSAFE_RE = /[\0\n\r()[\]{}*?"'`\\]/

function flavor(platform) {
  return platform === 'win32' ? win32Path : posixPath
}

/**
 * May a lane read this agent folder? It must be an absolute folder that
 * exists, and it is refused when it is the home folder, holds either agent
 * state folder (they hold every lane, the browser profiles and the agent's
 * credentials), lies inside one, or carries a character a permission rule
 * cannot hold.
 *
 * @param {unknown} folder
 * @param {{ home: string, stateRoots: string[], realpath: (p: string) => string, platform?: string }} deps
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function agentFolderVerdict(folder, { home, stateRoots, realpath, platform = process.platform }) {
  const p = flavor(platform)
  if (typeof folder !== 'string' || folder.trim() === '') return { ok: false, reason: 'none' }
  if (!p.isAbsolute(folder)) return { ok: false, reason: 'not_absolute' }
  if (RULE_UNSAFE_RE.test(folder)) return { ok: false, reason: 'unsafe_characters' }
  let real
  let realHome
  try {
    real = realpath(folder)
    realHome = realpath(home)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (RULE_UNSAFE_RE.test(real)) return { ok: false, reason: 'unsafe_characters' }
  if (isInsideFolder(realHome, real, platform)) return { ok: false, reason: 'home_or_above' }
  for (const root of stateRoots) {
    let realRoot = root
    try { realRoot = realpath(root) } catch { /* not created yet: compare as given */ }
    if (isInsideFolder(realRoot, real, platform)) return { ok: false, reason: 'holds_agent_state' }
    if (isInsideFolder(real, realRoot, platform)) return { ok: false, reason: 'inside_agent_state' }
  }
  return { ok: true, path: real }
}

// ── ownerMcpServers: which of the owner's servers a lane may load ───────────

/** A server name the CLI and a permission rule both take. */
export const OWNER_MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Never copied: this channel and the Agent Browser shim, whatever they are called. */
const OWNER_MCP_NAME_REFUSED_RE = /bgos|hoai/i
const OWNER_MCP_BODY_REFUSED_RE = /server\.ts|lane-server|bgos-launch|claude-channel-bgos|BGOS_|HOAI_RELAY|hoai-browser/i

export const OWNER_MCP_MAX = 20

function serverShapeOk(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return false
  if (typeof def.command === 'string' && def.command.trim() !== '') return true
  return typeof def.url === 'string' && /^https?:\/\//.test(def.url)
}

/**
 * The owner's MCP servers a lane may load, from the owner's Claude Code
 * config (`.claude.json`): user scope, then the agent folder's local scope
 * (which wins on a shared name). A server is skipped when its name is not
 * plain, names this channel or the browser shim, or its definition points at
 * this channel's server or carries its credentials: those would hand a
 * recipient's lane the owner's pairing.
 *
 * @returns {{ servers: Record<string, object>, skipped: string[] }}
 */
/**
 * @param {any} claudeJson
 * @param {{ agentFolder?: string | null }} [opts]
 * @returns {{ servers: Record<string, object>, skipped: string[] }}
 */
export function ownerMcpServersFrom(claudeJson, { agentFolder = null } = {}) {
  const merged = {}
  const add = (block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return
    for (const [name, def] of Object.entries(block)) merged[name] = def
  }
  add(claudeJson?.mcpServers)
  if (agentFolder) add(claudeJson?.projects?.[agentFolder]?.mcpServers)
  const servers = {}
  const skipped = []
  for (const [name, def] of Object.entries(merged)) {
    const body = (() => { try { return JSON.stringify(def) } catch { return '' } })()
    if (
      !OWNER_MCP_NAME_RE.test(name) ||
      OWNER_MCP_NAME_REFUSED_RE.test(name) ||
      !serverShapeOk(def) ||
      body === '' ||
      OWNER_MCP_BODY_REFUSED_RE.test(body) ||
      Object.keys(servers).length >= OWNER_MCP_MAX
    ) {
      skipped.push(name)
      continue
    }
    servers[name] = def
  }
  return { servers, skipped }
}

// ── Model and effort (K7) ───────────────────────────────────────────────────

export { LANE_EFFORT_LEVELS, LANE_MODEL_RE }

/** The word that puts a lane back on the agent's own model or effort. */
export const LANE_CHOICE_DEFAULT = 'default'

/**
 * The owner's list for an agent (`people/lane-models.json`). Anything
 * unreadable is an empty list: only the agent's default is allowed.
 *
 * @returns {{ models: string[], efforts: string[] }}
 */
export function readLaneAllowedChoices(text) {
  let raw
  try {
    raw = JSON.parse(String(text))
  } catch {
    return { models: [], efforts: [] }
  }
  const list = (value, ok) => (Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && ok(v)))] : [])
  return {
    models: list(raw?.models, (m) => LANE_MODEL_RE.test(m)),
    efforts: list(raw?.efforts, (e) => LANE_EFFORT_LEVELS.includes(e)),
  }
}

/**
 * A person's ask, judged against the owner's list.
 *
 * @param {{ kind: 'model' | 'effort', value: unknown, allowed: { models: readonly string[], efforts: readonly string[] } }} ask
 * @returns {{ ok: true, value: string | null } | { ok: false, reason: 'empty' | 'not_allowed' }}
 *   `value: null` is the agent's own default.
 */
export function laneChoiceVerdict({ kind, value, allowed }) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return { ok: false, reason: 'empty' }
  if (text.toLowerCase() === LANE_CHOICE_DEFAULT) return { ok: true, value: null }
  const list = kind === 'model' ? allowed?.models ?? [] : allowed?.efforts ?? []
  const shapeOk = kind === 'model' ? LANE_MODEL_RE.test(text) : LANE_EFFORT_LEVELS.includes(text)
  return shapeOk && list.includes(text) ? { ok: true, value: text } : { ok: false, reason: 'not_allowed' }
}

/**
 * The person's pinned choices (`<lane>/choices.json`, written by the lane
 * daemon on `/model` and `/effort`, outside the lane's working folder).
 *
 * @returns {{ model: string | null, effort: string | null, chatId: string | null }}
 */
export function readLaneChoices(text) {
  let raw
  try {
    raw = JSON.parse(String(text))
  } catch {
    return { model: null, effort: null, chatId: null }
  }
  return {
    model: typeof raw?.model === 'string' && LANE_MODEL_RE.test(raw.model) ? raw.model : null,
    effort: typeof raw?.effort === 'string' && LANE_EFFORT_LEVELS.includes(raw.effort) ? raw.effort : null,
    chatId: typeof raw?.chatId === 'string' && /^[1-9][0-9]*$/.test(raw.chatId) ? raw.chatId : null,
  }
}

/**
 * What a launch passes: only a pinned choice that is STILL on the owner's
 * list, so a list the owner narrowed takes effect at the next start.
 *
 * @param {{ model?: string | null, effort?: string | null } | null | undefined} choices
 * @param {{ models?: readonly string[], efforts?: readonly string[] } | null | undefined} allowed
 * @returns {{ model: string | null, effort: string | null }}
 */
export function effectiveLaneChoices(choices, allowed) {
  const c = choices ?? {}
  return {
    model: c.model && (allowed?.models ?? []).includes(c.model) && LANE_MODEL_RE.test(c.model) ? c.model : null,
    effort: c.effort && (allowed?.efforts ?? []).includes(c.effort) && LANE_EFFORT_LEVELS.includes(c.effort) ? c.effort : null,
  }
}

// ── Restart requests (/new, /model, /effort, a policy change) ───────────────

export const LANE_RESTART_REASONS = Object.freeze(['new', 'model', 'effort', 'policy_tightened', 'policy_loosened', 'lane_list_changed'])

/** How long a lane must be quiet, with no turn in flight, before an `idle` restart. */
export const LANE_IDLE_RESTART_QUIET_MS = 60_000

/**
 * Read a restart request (`<lane>/restart-request.json`). `fresh` means a
 * new session pin (`/new`); `when: 'now'` cuts whatever runs, `idle` waits.
 *
 * @returns {null | { reasons: string[], when: 'now' | 'idle', fresh: boolean, chatId: string | null }}
 */
export function readLaneRestartRequest(text) {
  let raw
  try {
    raw = JSON.parse(String(text))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter((r) => LANE_RESTART_REASONS.includes(r)) : []
  if (reasons.length === 0) return null
  return {
    reasons,
    when: raw.when === 'now' ? 'now' : 'idle',
    fresh: raw.fresh === true,
    chatId: typeof raw.chatId === 'string' && /^[1-9][0-9]*$/.test(raw.chatId) ? raw.chatId : null,
  }
}

/**
 * @typedef {{ reasons: string[], when: 'now' | 'idle', fresh: boolean, chatId: string | null }} LaneRestartRequest
 */

/**
 * Two requests in one: `now` beats `idle`, a fresh pin is never dropped, and
 * every reason is kept, so a policy change cannot swallow a `/new`.
 * @param {LaneRestartRequest | null} existing
 * @param {LaneRestartRequest | null} next
 * @returns {LaneRestartRequest | null}
 */
export function mergeLaneRestartRequests(existing, next) {
  if (!existing) return next
  if (!next) return existing
  return {
    reasons: [...new Set([...existing.reasons, ...next.reasons])],
    when: existing.when === 'now' || next.when === 'now' ? 'now' : 'idle',
    fresh: existing.fresh === true || next.fresh === true,
    chatId: next.chatId ?? existing.chatId ?? null,
  }
}

/**
 * Restart the running lane now, or wait? `idle` waits for no turn in flight
 * and LANE_IDLE_RESTART_QUIET_MS without activity.
 *
 * @param {{ request: LaneRestartRequest | null, inFlight: boolean, lastActivityAtMs: number | null,
 *   startedAtMs?: number, nowMs: number, quietMs?: number }} s
 * @returns {'now' | 'wait'}
 */
export function decideLaneRestart({ request, inFlight, lastActivityAtMs, startedAtMs, nowMs, quietMs = LANE_IDLE_RESTART_QUIET_MS }) {
  if (!request) return 'wait'
  if (request.when === 'now') return 'now'
  if (inFlight) return 'wait'
  const last = Number.isFinite(lastActivityAtMs) ? Math.max(lastActivityAtMs, startedAtMs ?? 0) : startedAtMs ?? 0
  return nowMs - last >= quietMs ? 'now' : 'wait'
}
