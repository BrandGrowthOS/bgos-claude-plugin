/**
 * agent-windows-plan: the PURE rules of Show agent windows (board row d133ddb2). No imports, no
 * effects; lib/agent-windows.mjs runs them against the machine.
 *
 * Every agent always runs hidden. A window is only a VIEWER opened beside a running agent: a
 * read only Terminal on its tmux session on a Mac or Linux computer, a watch only mirror of its
 * hidden console on Windows. Visibility is never a launch setting, so nothing here starts, stops
 * or restarts an agent, and switching the setting either way restarts nothing.
 *
 *   setting off   no viewer is opened; every open viewer is closed (only viewers are listed).
 *   setting on    every running agent without a viewer gets one, oldest agent first, at most
 *                 VIEWER_OPENS_PER_MINUTE a minute (a computer with 9 agents fills in over three).
 *   owner closed  a viewer this watcher opened that is gone while its agent session runs on was
 *                 closed by the owner: it stays closed for that session. It comes back at the
 *                 agent's next start (a new session) or when the setting goes off and on.
 *
 * What the computer can do rides the heartbeat as watcherHealth.windows {mode, reason}, both from
 * the fixed lists below; the backend keeps only these values (never free text).
 *
 * Plain JavaScript, node >= 18, import-safe.
 */

/** What this computer opens for Show agent windows. */
export const WINDOW_MODES = Object.freeze(['tmux', 'viewer', 'none'])

/**
 * Why: setting_off (the owner's setting is off, or absent), showing (on and applied),
 * no_tmux / no_screen / no_terminal (nothing can be opened here), open_failed (a viewer could not
 * be opened, or the process table could not be read), unsupported (any other platform).
 */
export const WINDOW_REASONS = Object.freeze(['setting_off', 'showing', 'no_tmux', 'no_screen', 'no_terminal', 'open_failed', 'unsupported'])

export const VIEWER_OPENS_PER_MINUTE = 4
export const VIEWER_OPEN_WINDOW_MS = 60_000

/**
 * What this computer can show, before the setting is looked at. Windows always has the watch only
 * viewer; a Mac needs tmux; Linux needs tmux, a screen (DISPLAY or WAYLAND_DISPLAY in the
 * watcher's environment) and a terminal emulator.
 * @param {{ platform: string, hasTmux?: boolean, hasScreen?: boolean, hasTerminal?: boolean }} input
 * @returns {{ mode: 'tmux' | 'viewer' | 'none', reason: 'no_tmux' | 'no_screen' | 'no_terminal' | 'unsupported' | null }}
 */
export function windowsCapability({ platform, hasTmux = false, hasScreen = false, hasTerminal = false }) {
  if (platform === 'win32') return { mode: 'viewer', reason: null }
  if (platform === 'darwin') return hasTmux ? { mode: 'tmux', reason: null } : { mode: 'none', reason: 'no_tmux' }
  if (platform === 'linux') {
    if (!hasTmux) return { mode: 'none', reason: 'no_tmux' }
    if (!hasScreen) return { mode: 'none', reason: 'no_screen' }
    if (!hasTerminal) return { mode: 'none', reason: 'no_terminal' }
    return { mode: 'tmux', reason: null }
  }
  return { mode: 'none', reason: 'unsupported' }
}

/**
 * The heartbeat's windows block: only listed values ever leave the machine.
 * @param {{ mode?: unknown, reason?: unknown } | null | undefined} report
 * @returns {{ mode: string, reason: string }}
 */
export function windowsHealth(report) {
  const mode = report?.mode
  const reason = report?.reason
  if (WINDOW_MODES.includes(/** @type {any} */ (mode)) && WINDOW_REASONS.includes(/** @type {any} */ (reason))) return { mode: String(mode), reason: String(reason) }
  return { mode: 'none', reason: 'unsupported' }
}

/**
 * The windows pass's memory between passes (the watcher keeps opened, closed, lastShow and
 * lastOpenAt in its state.json, so a watcher restart does not reopen what the owner closed).
 *   opened      agent id -> the session a viewer was opened (or found) for
 *   closed      agent id -> the session whose viewer the owner closed
 *   lastOpenAt  agent id -> when a viewer was last opened for it (the per agent cool-down)
 *   opens       when the recent opens happened (the per minute bound)
 *   lastShow    the setting at the last pass (null before the first)
 *   scanned     this watcher has looked for viewers left open at least once
 *   consolesChecked  launcher pids already looked at for hide in place (Windows)
 *   openFailed  a viewer could not be opened since the setting last changed
 */
/**
 * @typedef {{ opened: Record<string, string>, closed: Record<string, string>, lastOpenAt: Record<string, number>,
 *   opens: number[], lastShow: boolean | null, scanned: boolean, consolesChecked: number[], openFailed: boolean }} ViewerMemory
 */

/** @returns {ViewerMemory} */
export function emptyViewerMemory() {
  return { opened: {}, closed: {}, lastOpenAt: {}, opens: [], lastShow: null, scanned: false, consolesChecked: [], openFailed: false }
}

/** A viewer is opened again for the same agent (a new session) no sooner than this: an agent that
 *  restarts in a loop must not put a new window on the screen every minute. */
export const VIEWER_REOPEN_MIN_MS = 5 * 60_000

/**
 * One pass of the rules. `agents` are the RUNNING agents a viewer can attach to, each with the key
 * of its current session (a new key at every agent start); `viewers` are the viewers open now,
 * each with the session it shows. Returns what to open and what to close; it never names an agent
 * to stop, start or restart.
 * @param {{ show: boolean, agents: Array<{ id: string, session: string, startedAtMs?: number | null }>,
 *   viewers: Array<{ id: string, session?: string | null, handle: unknown }>,
 *   memory: Partial<ViewerMemory> | null | undefined, now: number }} input
 * @returns {{ open: Array<{ id: string, session: string, startedAtMs?: number | null }>,
 *   close: Array<{ id: string, session?: string | null, handle: any }>, memory: ViewerMemory }}
 */
export function planViewers({ show, agents, viewers, memory, now }) {
  const prior = { ...emptyViewerMemory(), ...(memory ?? {}) }
  if (!show) {
    return {
      open: [],
      close: [...viewers],
      memory: { ...prior, opened: {}, closed: {}, lastOpenAt: {}, lastShow: false, openFailed: false },
    }
  }
  const turnedOn = prior.lastShow !== true
  const running = new Map(agents.map((a) => [a.id, a]))
  // A viewer counts for its agent only while it shows that agent's CURRENT session; one left on a
  // session that ended (the agent restarted, or stopped) is closed, never mistaken for the new one.
  const seen = new Map()
  const close = []
  for (const viewer of viewers) {
    const agent = running.get(viewer.id)
    const current = agent && (viewer.session == null || viewer.session === agent.session)
    if (!current || seen.has(viewer.id)) close.push(viewer)
    else seen.set(viewer.id, viewer)
  }
  const opened = {}
  const closed = {}
  const lastOpenAt = {}
  if (!turnedOn) {
    for (const [id, session] of Object.entries(prior.closed ?? {})) {
      if (running.get(id)?.session === session) closed[id] = session
    }
    // A viewer opened for a session that still runs, now gone: the owner closed it.
    for (const [id, session] of Object.entries(prior.opened ?? {})) {
      if (running.get(id)?.session === session && !seen.has(id)) closed[id] = session
    }
    for (const [id, at] of Object.entries(prior.lastOpenAt ?? {})) {
      if (typeof at === 'number' && at <= now && now - at < VIEWER_REOPEN_MIN_MS) lastOpenAt[id] = at
    }
  }
  for (const id of seen.keys()) opened[id] = running.get(id).session
  const candidates = agents
    .filter((a) => !seen.has(a.id) && closed[a.id] !== a.session && lastOpenAt[a.id] === undefined)
    .sort((a, b) => (a.startedAtMs ?? Number.MAX_SAFE_INTEGER) - (b.startedAtMs ?? Number.MAX_SAFE_INTEGER) || Number(a.id) - Number(b.id))
  const recent = (prior.opens ?? []).filter((at) => typeof at === 'number' && at <= now && now - at < VIEWER_OPEN_WINDOW_MS)
  const budget = Math.max(0, VIEWER_OPENS_PER_MINUTE - recent.length)
  const open = candidates.slice(0, budget)
  for (const agent of open) {
    opened[agent.id] = agent.session
    lastOpenAt[agent.id] = now
  }
  return {
    open,
    close,
    memory: {
      ...prior,
      opened,
      closed,
      lastOpenAt,
      opens: [...recent, ...open.map(() => now)],
      lastShow: true,
      openFailed: turnedOn ? false : prior.openFailed === true,
    },
  }
}

/**
 * The part of the memory the watcher keeps in its state.json across its own restarts (a bundle
 * refresh, a crash): what was opened and closed for which agent session, the cool-down, and the
 * setting it last applied. Only well formed values survive the round trip.
 * @param {Partial<ViewerMemory> | null | undefined} memory
 */
export function viewerMemoryForState(memory) {
  return {
    opened: { ...(memory?.opened ?? {}) },
    closed: { ...(memory?.closed ?? {}) },
    lastOpenAt: { ...(memory?.lastOpenAt ?? {}) },
    lastShow: typeof memory?.lastShow === 'boolean' ? memory.lastShow : null,
  }
}

/**
 * @param {any} raw what state.json holds under `viewers` (anything)
 * @returns {ViewerMemory}
 */
export function viewerMemoryFromState(raw) {
  const memory = emptyViewerMemory()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return memory
  const sessions = (value) => {
    const out = {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out
    for (const [id, session] of Object.entries(value)) {
      if (/^\d+$/.test(id) && typeof session === 'string' && session.length > 0 && session.length <= 200) out[id] = session
    }
    return out
  }
  memory.opened = sessions(raw.opened)
  memory.closed = sessions(raw.closed)
  if (raw.lastOpenAt && typeof raw.lastOpenAt === 'object' && !Array.isArray(raw.lastOpenAt)) {
    for (const [id, at] of Object.entries(raw.lastOpenAt)) {
      if (/^\d+$/.test(id) && typeof at === 'number' && Number.isFinite(at)) memory.lastOpenAt[id] = at
    }
  }
  if (typeof raw.lastShow === 'boolean') memory.lastShow = raw.lastShow
  return memory
}
