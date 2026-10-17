/**
 * PERSON LANES, the pure core (shared agents Phase 3, P3; design
 * docs/superpowers/specs/2026-10-15-shared-agents-per-person-sessions-design.md
 * sections 3, 4, 5 and 7.2 in BGOS, measured by the spikes in
 * docs/reports/2026-10-16-phase3-spikes/).
 *
 * A lane is one person's mind on one agent: the key is (assistant, person).
 * The owner's lane is the agent as it runs today and is untouched by this
 * file. A RECIPIENT's lane is its own Claude Code process, started by its own
 * supervisor (bin/hoai-lane.mjs) on that person's first turn, stopped when
 * idle, relaunched after a crash, and launched LOCKED:
 *
 *   --restricted                built in tools that run code are gone, file
 *                               tools confined to the working folder, user,
 *                               project and local settings ignored, bypass
 *                               refused by the CLI itself (spike S2)
 *   --strict-mcp-config --mcp-config <lane>/mcp.json
 *                               only the lane's own BGOS server, named `bgos`
 *   --settings <lane>/settings.json
 *                               the allow list, the AskUserQuestion deny,
 *                               Remote Control off, the lane floor hook
 *   --permission-mode dontAsk   anything not allowed is refused, never asked
 *   --tools Read,Edit,Write,Glob,Grep
 *                               written out in full (WebSearch stays absent)
 *   --dangerously-load-development-channels server:bgos
 *
 * and NEVER `--dangerously-skip-permissions`. Everything here is pure: paths,
 * argv, settings, environment, the stamp check, path confinement, the idle,
 * crash and cap decisions, and the reading of the CLI probe. The processes
 * that use it are bin/hoai-lane.mjs (the supervisor), lane-server.ts (the
 * lane's own daemon), lib/lane-owner.ts (the owner's daemon side) and
 * bin/hoai-lane-floor-hook.mjs.
 *
 * Plain JavaScript (no TypeScript syntax) because the supervisor and the floor
 * hook run on a bare `node`.
 *
 * No em or en dashes in this file.
 */
import { createHash } from 'node:crypto'
import { posix as posixPath, win32 as win32Path } from 'node:path'

// ── The capability, the stamp, the frames ───────────────────────────────────

/** The capability token a lane capable connector declares (BGOS PERSON_LANES_TOKEN). */
export const PERSON_LANES_TOKEN = 'person_lanes'

/** The owner's lane stamp, as the backend writes it on every delivery once lanes are on. */
export const OWNER_LANE_STAMP = 'owner'

const PERSON_PREFIX = 'person:'

/** A person's lane stamp. */
export function personLaneStamp(userId) {
  return `${PERSON_PREFIX}${userId}`
}

/**
 * A person's user id as it may be used in a folder name, a tmux socket, a
 * hook argument or a file key: the characters Clerk and the fixture rig use,
 * nothing that can climb a path or break a command line.
 */
export const LANE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isSafeLaneUserId(value) {
  return typeof value === 'string' && LANE_USER_ID_RE.test(value)
}

/** An assistant id as the plugin keys its folders: a positive integer, as text. */
export function isSafeAssistantId(value) {
  const text = String(value ?? '')
  return /^[1-9][0-9]{0,15}$/.test(text)
}

/** A short, stable, path safe key for a person (tmux sockets, log names). */
export function laneUserHash(userId) {
  return createHash('sha256').update(String(userId)).digest('hex').slice(0, 12)
}

/**
 * The stamp a delivery carries, read from a socket frame or a poll row. null
 * when the delivery carries none (the backend's switch is off, or an old
 * backend), which is the owner's path exactly as today.
 */
export function readLaneStamp(delivery) {
  if (!delivery || typeof delivery !== 'object') return null
  const raw = delivery.lane
  if (raw === undefined || raw === null) return null
  return typeof raw === 'string' ? raw : `unreadable:${typeof raw}`
}

/**
 * THE SECOND LOCK, in the OWNER's daemon (design rule 5). With no stamp the
 * delivery is today's, and it is delivered. With a stamp it is delivered only
 * when it is exactly the owner's: a person's stamp, or anything this file
 * cannot read, is refused, logged as `lane_misroute` by the caller, and never
 * acknowledged, so the row stays for its own lane.
 *
 * @returns {{ deliver: true } | { deliver: false, stamp: string }}
 */
export function ownerLaneVerdict(delivery) {
  const stamp = readLaneStamp(delivery)
  if (stamp === null || stamp === OWNER_LANE_STAMP) return { deliver: true }
  return { deliver: false, stamp }
}

/**
 * A button tap is a turn too. Once lanes run for the agent, a tap in a chat
 * the daemon knows is a share recipient's is that person's turn, and the
 * owner's daemon never announces it into the owner's session (security
 * review finding 1: the poll and the stream announce taps outside the
 * message paths the stamp covers). A chat it does not know stays today's.
 *
 * @param {{ lanesOn: boolean, chatIsOthers: boolean }} s
 */
export function ownerAnnounceRefused({ lanesOn, chatIsOthers }) {
  return lanesOn === true && chatIsOthers === true
}

/**
 * THE SECOND LOCK, in a PERSON's lane daemon. Strict equality and nothing
 * else: a missing, malformed, owner or other person's stamp never matches, so
 * a routing bug needs this check to fail too before a turn runs in the wrong
 * lane. A delivery addressed to another agent is refused as well.
 *
 * @param {unknown} delivery
 * @param {{ userId: string, assistantId: string | number }} lane
 * @returns {{ deliver: true } | { deliver: false, reason: string, stamp: string | null }}
 */
export function personLaneVerdict(delivery, lane) {
  const stamp = readLaneStamp(delivery)
  if (!isSafeLaneUserId(lane?.userId)) return { deliver: false, reason: 'lane_unknown', stamp }
  if (stamp !== personLaneStamp(lane.userId)) return { deliver: false, reason: 'stamp', stamp }
  const target = delivery?.assistantId ?? delivery?.assistant_id
  if (target !== undefined && target !== null && String(target) !== String(lane.assistantId)) {
    return { deliver: false, reason: 'assistant', stamp }
  }
  return { deliver: true }
}

// ── Folders ─────────────────────────────────────────────────────────────────

function flavor(platform) {
  return platform === 'win32' ? win32Path : posixPath
}

/**
 * Every path a lane uses. The lane folder sits under the agent's state folder
 * (`~/.bgos-agent/<id>/people/<userId>/`, the floor's own-lane key) and holds
 * NO `.bgos-agent-id` pin; its secrets (the ticket, the lane session) live in
 * the plugin state folder, which rules version 4 treats as a secret for every
 * lane. The working folder is the only folder the lane's file tools reach.
 *
 * @param {{ home: string, assistantId: string | number, userId: string,
 *   stateRoot?: string, platform?: string }} params
 */
export function lanePaths({ home, assistantId, userId, stateRoot, platform = process.platform }) {
  if (!isSafeAssistantId(assistantId)) throw new Error(`lane: unsafe assistant id ${JSON.stringify(assistantId)}`)
  if (!isSafeLaneUserId(userId)) throw new Error('lane: unsafe person id')
  const p = flavor(platform)
  const id = String(assistantId)
  const agentDir = p.join(home, '.bgos-agent', id)
  const peopleDir = p.join(agentDir, 'people')
  const laneDir = p.join(peopleDir, userId)
  const workDir = p.join(laneDir, 'work')
  const pluginState = stateRoot && String(stateRoot).trim() !== '' ? String(stateRoot) : p.join(home, '.bgos-plugin-state')
  const stateDir = p.join(pluginState, id, 'lanes', userId)
  return {
    agentDir,
    peopleDir,
    laneDir,
    workDir,
    sessionIdPath: p.join(laneDir, 'session-id'),
    laneJsonPath: p.join(laneDir, 'lane.json'),
    settingsPath: p.join(laneDir, 'settings.json'),
    mcpPath: p.join(laneDir, 'mcp.json'),
    configDir: p.join(laneDir, 'claude-config'),
    wakePath: p.join(laneDir, 'wake.json'),
    stopRequestPath: p.join(laneDir, 'stop-request.json'),
    revokedPath: p.join(laneDir, 'revoked.json'),
    claudeDebugPath: p.join(laneDir, 'claude-debug.log'),
    eventsPath: p.join(laneDir, 'events.jsonl'),
    launcherLockPath: p.join(laneDir, 'launcher.lock'),
    launcherLogPath: p.join(laneDir, 'launcher.log'),
    stateDir,
    ticketPath: p.join(stateDir, 'ticket.json'),
    sessionPath: p.join(stateDir, 'session.json'),
    cursorPath: p.join(stateDir, 'cursor.json'),
    daemonLockPath: p.join(stateDir, 'daemon.lock'),
    registryPath: p.join(peopleDir, 'registry.json'),
    loginModesPath: p.join(peopleDir, 'login-modes.json'),
    machineRegistryPath: p.join(home, '.bgos-agent', 'lanes-machine.json'),
  }
}

/**
 * The people folder of an agent, for the owner's event drain.
 * @param {{ home: string, assistantId: string | number, platform?: string }} params
 */
export function peopleDirOf({ home, assistantId, platform = process.platform }) {
  if (!isSafeAssistantId(assistantId)) throw new Error('lane: unsafe assistant id')
  return flavor(platform).join(home, '.bgos-agent', String(assistantId), 'people')
}

// ── The locked launch ───────────────────────────────────────────────────────

/** The built in tools a locked lane has, written out in full (never "add to"). */
export const LANE_BUILTIN_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep'])

/** The lane server's tools. The allow list names each, and nothing else of `bgos`. */
export const LANE_BGOS_TOOLS = Object.freeze(['reply'])

/** The MCP server name the lane's channel and the floor's exemptions key on. */
export const LANE_MCP_SERVER_NAME = 'bgos'

/** The channel spec in server form: the plugin itself is not enabled under --restricted. */
export const LANE_CHANNEL_SPEC = `server:${LANE_MCP_SERVER_NAME}`

/** The one permission mode a lane runs in. */
export const LANE_PERMISSION_MODE = 'dontAsk'

/** Flags a lane must never carry, whatever builds its argv. */
export const LANE_FORBIDDEN_FLAGS = Object.freeze([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--add-dir',
  '--continue',
])

/**
 * The lane's argv for `claude`. A NEW builder, never the owner's
 * `launchArgsFor`: it cannot emit the skip permissions flag. `debugFile`
 * (the person's own sign in only) is where the CLI names a refused token:
 * with one, a session comes up with its channels switched off and never takes
 * a turn, so the transcript the login watch reads is never written (measured
 * on 2.1.302).
 *
 * @param {{ mcpConfigPath: string, settingsPath: string, sessionArgs?: readonly string[], debugFile?: string }} params
 * @returns {string[]}
 */
export function laneLaunchArgsFor({ mcpConfigPath, settingsPath, sessionArgs = [], debugFile }) {
  if (!mcpConfigPath || !settingsPath) throw new Error('lane: launch needs its mcp config and settings files')
  const session = [...sessionArgs]
  if (session.some((arg) => LANE_FORBIDDEN_FLAGS.includes(String(arg)))) {
    throw new Error('lane: a forbidden flag reached the session args')
  }
  return [
    '--restricted',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--settings', settingsPath,
    '--permission-mode', LANE_PERMISSION_MODE,
    '--tools', LANE_BUILTIN_TOOLS.join(','),
    '--dangerously-load-development-channels', LANE_CHANNEL_SPEC,
    ...(debugFile ? ['--debug-file', debugFile] : []),
    ...session,
  ]
}

/** `--resume` when the transcript exists, else `--session-id` (never `--continue`). */
export function laneSessionArgs(sessionId, transcriptExists) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId ?? ''))) {
    throw new Error('lane: the session pin is not a session id')
  }
  return transcriptExists ? ['--resume', sessionId] : ['--session-id', sessionId]
}

/**
 * The CLI's permission rule form of an absolute path: `//abs/path` on POSIX,
 * `//c/abs/path` for `C:\abs\path` on Windows (measured, spike S2 and S5).
 */
export function permissionRulePath(absPath, platform = process.platform) {
  if (platform === 'win32') {
    return `/${String(absPath).replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')}`
  }
  return `/${absPath}`
}

/**
 * The allow list (design 7.2 item 3, with spike S2's correction: only
 * `Read(path)` and `Edit(path)` rules match files; `Glob` and `Grep` read
 * under the Read rule, `Write` under the Edit rule). `reply` is ALWAYS allowed:
 * a lane whose reply is refused goes silent.
 */
export function laneAllowList(workDir, platform = process.platform) {
  const rule = permissionRulePath(workDir, platform)
  return [
    ...LANE_BGOS_TOOLS.map((tool) => `mcp__${LANE_MCP_SERVER_NAME}__${tool}`),
    `Read(${rule}/**)`,
    `Edit(${rule}/**)`,
  ]
}

/** One POSIX shell word, single quoted: nothing inside expands (security review finding 4). */
function quoteArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * The lane's settings file. `remoteControlAtStartup: false` because a
 * restricted lane otherwise opened a Remote Control session on the owner's
 * account (spike S2 finding 2); the floor hook runs on every tool call and
 * fails CLOSED in a lane.
 *
 * @param {{ workDir: string, userId: string, nodePath: string, floorHookPath: string, platform?: string }} params
 */
export function laneSettingsBody({ workDir, userId, nodePath, floorHookPath, platform = process.platform }) {
  if (!isSafeLaneUserId(userId)) throw new Error('lane: unsafe person id')
  return {
    permissions: {
      allow: laneAllowList(workDir, platform),
      deny: ['AskUserQuestion'],
    },
    remoteControlAtStartup: false,
    autoMemoryEnabled: false,
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${quoteArg(nodePath)} ${quoteArg(floorHookPath)} --lane ${userId}`,
              timeout: 5,
            },
          ],
        },
      ],
    },
  }
}

/**
 * The lane's MCP config: the lane server alone, under the name `bgos`. The
 * Agent Browser shim is not loaded in a P3 lane (the policy options, the
 * browser among them, are P7's; until then every lane is the locked base).
 *
 * @param {{ nodePath: string, pluginRoot: string, env: Record<string, string>, platform?: string }} params
 */
export function laneMcpConfigBody({ nodePath, pluginRoot, env, platform = process.platform }) {
  const p = flavor(platform)
  return {
    mcpServers: {
      [LANE_MCP_SERVER_NAME]: {
        command: nodePath,
        args: [p.join(pluginRoot, 'bin', 'bgos-launch.mjs'), p.join(pluginRoot, 'lane-server.ts')],
        env: { ...env },
      },
    },
  }
}

// ── The environment ─────────────────────────────────────────────────────────

/** Names a lane keeps from the owner's environment (an allow list, never "all minus"). */
export const LANE_ENV_KEEP = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ',
  'TMPDIR', 'TEMP', 'TMP',
  'BUN_INSTALL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'BGOS_PLUGIN_STATE_DIR',
])

/** Windows needs these to run anything at all. */
export const LANE_ENV_KEEP_WIN32 = Object.freeze([
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec',
  'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'ProgramData',
])

/**
 * The Claude Code login variables (design 4.3). Under option (a) each is
 * passed through only if the owner's process had it, byte for byte; under
 * option (b) every one is dropped and the lane gets its own.
 */
export const LANE_LOGIN_ENV = Object.freeze([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
])

/** Login modes, per share (decision K2). */
export const LANE_LOGIN_INHERIT = 'inherit'
export const LANE_LOGIN_OWN_TOKEN = 'own_token'
export const LANE_LOGIN_MODES = Object.freeze([LANE_LOGIN_INHERIT, LANE_LOGIN_OWN_TOKEN])

/**
 * The lane's environment, built from an allow list. It never carries the
 * owner's tmux names, the project dir, the supervision variables, the pairing
 * token, the API key or anything else the owner's shell exported.
 *
 * @param {{ ownerEnv: Record<string, string | undefined>, platform?: string,
 *   login: { mode: 'inherit' } | { mode: 'own_token', token: string, configDir: string },
 *   assistantId: string | number, userId: string, workDir: string, laneDir: string,
 *   stateDir: string, backendUrl: string }} params
 * @returns {Record<string, string>}
 */
export function laneChildEnv({ ownerEnv, platform = process.platform, login, assistantId, userId, workDir, laneDir, stateDir, backendUrl }) {
  if (!isSafeLaneUserId(userId)) throw new Error('lane: unsafe person id')
  if (!isSafeAssistantId(assistantId)) throw new Error('lane: unsafe assistant id')
  const env = {}
  const source = ownerEnv ?? {}
  const keep = platform === 'win32' ? [...LANE_ENV_KEEP, ...LANE_ENV_KEEP_WIN32] : LANE_ENV_KEEP
  for (const name of keep) {
    const value = source[name]
    if (typeof value === 'string' && value !== '') env[name] = value
  }
  for (const [name, value] of Object.entries(source)) {
    if (/^LC_[A-Z_]+$/.test(name) && typeof value === 'string' && value !== '') env[name] = value
  }
  if (login?.mode === LANE_LOGIN_INHERIT) {
    for (const name of LANE_LOGIN_ENV) {
      const value = source[name]
      if (typeof value === 'string') env[name] = value
    }
  } else if (login?.mode === LANE_LOGIN_OWN_TOKEN) {
    if (typeof login.token !== 'string' || login.token.trim() === '') throw new Error('lane: own token login without a token')
    if (typeof login.configDir !== 'string' || login.configDir === '') throw new Error('lane: own token login without its config folder')
    env.CLAUDE_CONFIG_DIR = login.configDir
    env.CLAUDE_CODE_OAUTH_TOKEN = login.token
  } else {
    throw new Error('lane: unknown login mode')
  }
  Object.assign(env, laneDaemonEnv({ assistantId, userId, workDir, laneDir, stateDir, backendUrl, loginMode: login.mode }))
  return env
}

/**
 * The variables that make the BGOS server a lane daemon. Also written into
 * the lane's mcp.json, so they hold whatever Claude Code passes its children.
 */
export function laneDaemonEnv({ assistantId, userId, workDir, laneDir, stateDir, backendUrl, loginMode }) {
  return {
    BGOS_LANE_USER_ID: String(userId),
    BGOS_ASSISTANT_ID: String(assistantId),
    BGOS_LAUNCH_CWD: String(workDir),
    BGOS_LANE_DIR: String(laneDir),
    BGOS_LANE_STATE_DIR: String(stateDir),
    BGOS_BACKEND_URL: String(backendUrl ?? ''),
    BGOS_AUTO_APPROVE: 'false',
    HOAI_LANE_LOGIN_MODE: String(loginMode),
  }
}

// ── Path confinement (design 7.2 item 7) ────────────────────────────────────

/**
 * Is `candidate` (already resolved through realpath) inside `root` (also
 * resolved)? Case folded on macOS and Windows, whose file systems are.
 */
export function isInsideFolder(candidate, root, platform = process.platform) {
  const p = flavor(platform)
  const fold = (s) => (platform === 'darwin' || platform === 'win32' ? s.toLowerCase() : s)
  const rel = p.relative(fold(root), fold(candidate))
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))
}

/**
 * Confine one local path a tool was handed to the lane's working folder. The
 * path is made absolute against the working folder, then resolved with
 * `realpath` (so a symlink cannot escape), and refused unless it lands inside.
 * A path that does not exist is refused too: nothing outside can be probed.
 *
 * @param {string} input
 * @param {{ workDir: string, realpath: (p: string) => string, platform?: string }} deps
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function confineLanePath(input, { workDir, realpath, platform = process.platform }) {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, reason: 'empty' }
  if (input.includes('\0')) return { ok: false, reason: 'nul' }
  const p = flavor(platform)
  let root
  try {
    root = realpath(workDir)
  } catch {
    return { ok: false, reason: 'no_work_folder' }
  }
  const absolute = p.isAbsolute(input) ? input : p.join(root, input)
  let resolved
  try {
    resolved = realpath(absolute)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!isInsideFolder(resolved, root, platform)) return { ok: false, reason: 'outside' }
  return { ok: true, path: resolved }
}

// ── Idle, crash, caps ───────────────────────────────────────────────────────

/** Idle stop (decision K6): 20 minutes with no turn in flight. */
export const LANE_IDLE_MS = 20 * 60_000

/** A turn counted in flight longer than this is treated as stuck, so the lane can still stop. */
export const LANE_TURN_STUCK_MS = 2 * 60 * 60_000

/** Crash relaunch budget, as the owner's (bin/hoai-core.mjs MAX_RELAUNCHES_PER_WINDOW). */
export const LANE_MAX_RELAUNCHES = 3
export const LANE_RELAUNCH_WINDOW_MS = 60 * 60_000

/** Recipient lanes running at once per agent (decision K6). */
export const LANE_PER_AGENT_CAP = 2

/** The memory one lane is budgeted at in the machine ceiling (spike S4: 1 GiB stays). */
export const LANE_BUDGET_BYTES = 1024 ** 3
/** Kept free for the owner's own work before any lane counts. */
export const LANE_RESERVE_BYTES = 4 * 1024 ** 3

/**
 * Should a running lane stop for idleness?
 *
 * @param {{ lastActivityAtMs: number | null, inFlight: boolean, inFlightSinceMs?: number | null,
 *   startedAtMs: number, nowMs: number, idleMs?: number, stuckMs?: number }} s
 * @returns {{ stop: boolean, reason?: 'idle' | 'stuck' }}
 */
export function decideLaneIdle({ lastActivityAtMs, inFlight, inFlightSinceMs = null, startedAtMs, nowMs, idleMs = LANE_IDLE_MS, stuckMs = LANE_TURN_STUCK_MS }) {
  if (inFlight) {
    const since = Number.isFinite(inFlightSinceMs) ? inFlightSinceMs : lastActivityAtMs
    if (Number.isFinite(since) && nowMs - since >= stuckMs) return { stop: true, reason: 'stuck' }
    return { stop: false }
  }
  const last = Number.isFinite(lastActivityAtMs) ? Math.max(lastActivityAtMs, startedAtMs) : startedAtMs
  return nowMs - last >= idleMs ? { stop: true, reason: 'idle' } : { stop: false }
}

/**
 * After the lane's Claude exited on its own (no stop was asked for): relaunch
 * with the same pin, at most LANE_MAX_RELAUNCHES times an hour.
 *
 * @param {{ relaunchesAtMs: readonly number[], nowMs: number }} s
 * @returns {{ relaunch: boolean, recent: number[] }}
 */
export function decideLaneRelaunch({ relaunchesAtMs, nowMs, max = LANE_MAX_RELAUNCHES, windowMs = LANE_RELAUNCH_WINDOW_MS }) {
  const recent = (relaunchesAtMs ?? []).filter((t) => Number.isFinite(t) && nowMs - t < windowMs)
  return recent.length < max ? { relaunch: true, recent: [...recent, nowMs] } : { relaunch: false, recent }
}

/**
 * The machine ceiling: floor((available - 4 GiB) / 1 GiB), at least 1.
 * Available is the operating system's own figure, never os.freemem().
 */
export function laneMachineCeiling(availableBytes) {
  if (!Number.isFinite(availableBytes) || availableBytes <= 0) return 1
  return Math.max(1, Math.floor((availableBytes - LANE_RESERVE_BYTES) / LANE_BUDGET_BYTES))
}

/**
 * May a lane start? Over a cap, the least recently used IDLE lane of the
 * cap that binds is stopped first; with every lane busy the answer is busy
 * and the wake is never handed to another lane.
 *
 * @param {{ lanes: ReadonlyArray<{ assistantId: string, userId: string, lastActivityAtMs: number, inFlight: boolean }>,
 *   assistantId: string, userId: string, perAgentCap?: number, machineCeiling: number }} s
 * @returns {{ action: 'running' } | { action: 'start' } | { action: 'evict', victim: { assistantId: string, userId: string } } | { action: 'busy', cap: 'agent' | 'machine' }}
 */
export function decideLaneCaps({ lanes, assistantId, userId, perAgentCap = LANE_PER_AGENT_CAP, machineCeiling }) {
  const all = lanes ?? []
  if (all.some((l) => String(l.assistantId) === String(assistantId) && l.userId === userId)) return { action: 'running' }
  const mine = all.filter((l) => String(l.assistantId) === String(assistantId))
  const lru = (list) => list
    .filter((l) => !l.inFlight)
    .sort((a, b) => (a.lastActivityAtMs ?? 0) - (b.lastActivityAtMs ?? 0))[0]
  if (mine.length >= perAgentCap) {
    const victim = lru(mine)
    return victim ? { action: 'evict', victim: { assistantId: String(victim.assistantId), userId: victim.userId } } : { action: 'busy', cap: 'agent' }
  }
  if (all.length >= Math.max(1, machineCeiling)) {
    const victim = lru(all)
    return victim ? { action: 'evict', victim: { assistantId: String(victim.assistantId), userId: victim.userId } } : { action: 'busy', cap: 'machine' }
  }
  return { action: 'start' }
}

/**
 * macOS available memory from `vm_stat`: free plus inactive plus purgeable
 * pages, times the page size it states.
 */
export function availableBytesFromVmStat(text) {
  const raw = String(text ?? '')
  const page = Number(/page size of (\d+) bytes/.exec(raw)?.[1] ?? 0)
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(raw)?.[1] ?? 0)
  if (!page) return 0
  return (pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable')) * page
}

/** Linux available memory from /proc/meminfo's MemAvailable (kB). */
export function availableBytesFromMeminfo(text) {
  const kb = Number(/MemAvailable:\s+(\d+)\s+kB/.exec(String(text ?? ''))?.[1] ?? 0)
  return kb * 1024
}

// ── The CLI probe ───────────────────────────────────────────────────────────

/** Flags the locked launch needs that `claude --help` lists. */
export const LANE_HELP_FLAGS = Object.freeze([
  '--restricted',
  '--strict-mcp-config',
  '--mcp-config',
  '--settings',
  '--permission-mode',
  '--tools',
  '--session-id',
  '--resume',
  '--debug-file',
])

/** A flag the help hides, probed bare: a known flag with no value answers "argument missing". */
export const LANE_HIDDEN_VALUE_FLAGS = Object.freeze(['--dangerously-load-development-channels'])

/** The probe value that asks the CLI to list the permission modes it knows. */
export const LANE_MODE_PROBE_VALUE = 'hoai-lane-probe'

function outputText(out) {
  return `${out?.stdout ?? ''}\n${out?.stderr ?? ''}`
}

/**
 * Read the probe's outputs into one answer. Every flag must be known, and
 * `--permission-mode` must list `dontAsk`; anything unread is a no.
 *
 * @param {{ help: { stdout?: string, stderr?: string }, mode: { stdout?: string, stderr?: string },
 *   hidden: Record<string, { stdout?: string, stderr?: string }> }} outs
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function classifyLaneCliProbe({ help, mode, hidden }) {
  const missing = []
  const helpText = outputText(help)
  for (const flag of LANE_HELP_FLAGS) {
    // Only where an option is DEFINED (the start of a help line, after an
    // optional short alias), never inside another option's description.
    const re = new RegExp(`^\\s+(?:-[A-Za-z], )?${flag.replace(/[-]/g, '\\-')}(?=[\\s,<=[]|$)`, 'm')
    if (!re.test(helpText)) missing.push(flag)
  }
  const modeText = outputText(mode)
  const choices = /Allowed choices are ([^\n]+)/i.exec(modeText)?.[1] ?? ''
  if (!choices.split(/[\s,.]+/).includes(LANE_PERMISSION_MODE)) missing.push(`--permission-mode ${LANE_PERMISSION_MODE}`)
  for (const flag of LANE_HIDDEN_VALUE_FLAGS) {
    const text = outputText(hidden?.[flag]).toLowerCase()
    const known = /argument missing|missing required argument|requires an argument|expected an argument/.test(text) && !/unknown option/.test(text)
    if (!known) missing.push(flag)
  }
  return { ok: missing.length === 0, missing }
}

// ── Events the supervisor and the lane hand to the owner's daemon ───────────

/** What the owner's daemon reports to the backend (BGOS LANE_REPORT_EVENTS). */
export const LANE_REPORT_EVENTS = Object.freeze(['lane_busy', 'lane_stopped', 'lane_failed'])

/**
 * Plain sentences a person reads in their own chat when their lane cannot sign
 * in (K2 option b). FIXED text, in the agent's own voice (the owner's daemon
 * posts them as the agent): nothing a lane writes chooses a word of them.
 */
export const LANE_NOTICES = Object.freeze({
  login_token_missing:
    "I can't answer you yet. My owner set our conversations to use your own Claude sign in, and it is not set up on this computer. Your message is saved; once my owner adds it, send your message again.",
  login_token_failed:
    "I can't answer you right now. The Claude sign in set up for our conversations was refused (it may have expired). Your message is saved; once my owner renews it, send your message again.",
})

/** The sentence for a notice, or null for a notice this file does not know. */
export function laneNoticeSentence(notice) {
  return Object.prototype.hasOwnProperty.call(LANE_NOTICES, notice) ? LANE_NOTICES[notice] : null
}

/**
 * One line of a lane's events file, validated. Unknown events, unknown
 * notices and chat ids that are not positive integers are dropped, so a lane
 * cannot make the owner's daemon post anything but a fixed sentence.
 *
 * @returns {null | { event: string, notice?: string, chatIds?: number[], at?: string }}
 */
export function parseLaneEventLine(line) {
  let raw
  try {
    raw = JSON.parse(String(line))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  if (LANE_REPORT_EVENTS.includes(raw.event)) {
    return { event: raw.event, ...(typeof raw.at === 'string' ? { at: raw.at } : {}) }
  }
  if (raw.event === 'notice' && Object.prototype.hasOwnProperty.call(LANE_NOTICES, raw.notice)) {
    const chatIds = Array.isArray(raw.chatIds)
      ? [...new Set(raw.chatIds.map((c) => Number(c)).filter((c) => Number.isSafeInteger(c) && c > 0))].slice(0, 5)
      : []
    return { event: 'notice', notice: raw.notice, chatIds, ...(typeof raw.at === 'string' ? { at: raw.at } : {}) }
  }
  return null
}

/** The bytes of one events line. */
export function laneEventLine(event, nowIso = new Date().toISOString()) {
  return `${JSON.stringify({ ...event, at: nowIso })}\n`
}

// ── The lane's state file (lane.json) ───────────────────────────────────────

/**
 * What the lane daemon writes and the supervisor reads. Never anything secret:
 * the folder is the lane's own.
 * @param {{ userId: string, assistantId: string | number, lastActivityAtMs: number | null,
 *   inFlight: boolean, inFlightSinceMs?: number | null, loginMode?: string, pid?: number }} params
 */
export function laneStateBody({ userId, assistantId, lastActivityAtMs, inFlight, inFlightSinceMs = null, loginMode, pid }) {
  return {
    v: 1,
    actorUserId: String(userId),
    assistantId: String(assistantId),
    lastActivityAt: Number.isFinite(lastActivityAtMs) ? new Date(lastActivityAtMs).toISOString() : null,
    inFlight: inFlight === true,
    inFlightSince: Number.isFinite(inFlightSinceMs) ? new Date(inFlightSinceMs).toISOString() : null,
    loginMode: String(loginMode ?? ''),
    pid: Number.isFinite(pid) ? pid : null,
  }
}

/** Read lane.json leniently: anything unreadable is "no activity known". */
export function readLaneState(text) {
  try {
    const raw = JSON.parse(String(text))
    const ms = (v) => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN
      return Number.isFinite(t) ? t : null
    }
    return {
      lastActivityAtMs: ms(raw?.lastActivityAt),
      inFlight: raw?.inFlight === true,
      inFlightSinceMs: ms(raw?.inFlightSince),
    }
  } catch {
    return { lastActivityAtMs: null, inFlight: false, inFlightSinceMs: null }
  }
}
