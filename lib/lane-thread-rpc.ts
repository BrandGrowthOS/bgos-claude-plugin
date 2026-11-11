/**
 * PERSON LANES, a person's THREADS run in that person's own lane (KC,
 * 2026-11-11: a person an agent is shared with can open a thread with it;
 * BGOS backend/src/common/share-threads.ts, CORE-CONTRACTS 7.8).
 *
 * The owner's threads are lib/thread-lanes.ts in the owner's daemon: a
 * headless `claude -p` forked from the owner's main session. A RECIPIENT's
 * thread must never be that: it is a fork of THAT PERSON's lane session, it
 * runs inside the lane (the lane's credential, the lane's folder, at most the
 * lane's tools), and the owner's daemon never runs it. So the lane daemon
 * (lane-server.ts) carries its own ThreadLaneManager, built here from the
 * lane's own facts and nothing else.
 *
 * THE WIRE (fixed by the server half). Server to lane, on the lane's own
 * socket, event `voice_rpc`, stamped for the lane exactly as its memory
 * frames are (`actorUserId` and `lane: 'person:<id>'` at the top):
 *   thread_turn  {chatId, rootId, replyId, mode, text, title, rootText}
 *                -> {accepted: true, state: 'working' | 'waiting'} at once
 *   thread_close {chatId, rootId, removeWorktree} -> {stopped: true}
 * Lane to server, all with the LANE SESSION and never the pairing:
 *   POST integrations/voice-rpc/<rpcId>/ack and .../result
 *   POST integrations/threads/state, .../reply, .../summary (the bodies the
 *        owner's manager posts)
 *   GET  integrations/threads/pending on connect
 *
 * WHAT A FRAME MUST BE to be taken: for this agent, stamped exactly for this
 * lane's person, `thread_turn` or `thread_close`, with an rpcId. Anything
 * else (the owner's own unstamped frame, another person, another agent, any
 * other op) gets nothing, not even an ack. Every answer, an error included,
 * echoes the stamp the way the memory answers do (lib/lane-memory-rpc.ts):
 * `lane` at the top, `actorUserId` and `lane` inside `payload`.
 *
 * WHAT THE THREAD GETS (laneThreadDeps):
 *   - the session it forks is the lane's own pin (`<lane>/session-id`, the id
 *     the supervisor launches the lane's Claude with), read fresh, so a
 *     `/new` is followed; never the owner's session, which this file is
 *     never given;
 *   - its folder is `<lane>/work/.hoai/threads/<root>`, a plain folder: the
 *     manager's git is a stub that always fails, so no lane can get a
 *     worktree of any repository, and a thread is always READ ONLY;
 *   - a start whose folder resolves outside the lane's work folder (a planted
 *     link) is refused before any process starts;
 *   - its state is `<lane state>/threads`, outside the lane's file tools;
 *   - its tools are the read only thread tools cut to what the lane itself
 *     was launched with (Read, Glob, Grep, and the web tools only under the
 *     share's web option); never Bash, whatever the share's shell option
 *     says, never an editing tool, no HOAI tool, no email files folder, and
 *     not the agent folder (a `readAgentFolder` share does not open it to a
 *     thread in this version);
 *   - its hooks are the lane's own floor hook (bin/hoai-lane-floor-hook.mjs,
 *     fails closed), not the owner's plugin hooks;
 *   - its Claude login and config dir are the lane's own
 *     (laneThreadLoginEnv), so the fork finds the transcript it resumes;
 *   - its answers go out through `post`, which lane-server.ts wires to
 *     `laneFetch` (the lane session);
 *   - one thread runs at a time per lane (LANE_THREAD_MAX_RUNNING).
 *
 * Every effect is injected, so the whole of it is unit tested with fakes
 * (test/lane-thread-rpc.test.ts). Erasable TypeScript only.
 *
 * No em or en dashes in this file.
 */
import { join } from 'node:path'

import {
  isInsideFolder,
  isSafeLaneUserId,
  LANE_BUILTIN_TOOLS,
  LANE_LOGIN_ENV,
  lanePaths,
  laneSettingsBody,
  personLaneStamp,
  readLaneStamp,
} from './lane-core.mjs'
import { laneAllowAdditions, laneToolsFor, readToolPolicy } from './lane-policy.mjs'
import type { SpawnStreamJson } from './stream-json-child.ts'
import { isSessionId, THREAD_LANE_READ_ONLY_TOOLS, type ThreadLaneConfinement } from './thread-lane-args.ts'
import type { ThreadLaneDeps, ThreadLaneFs, ThreadTurnInput } from './thread-lanes.ts'
import { THREAD_CLOSE, THREAD_TURN, threadClosePayload, threadRefusal, threadTurnPayload } from './thread-rpc.ts'

export { LANE_THREADS_TOKEN } from './lane-core.mjs'

/** Thread lanes running at once in one person's lane. */
export const LANE_THREAD_MAX_RUNNING = 1

/** How many answered rpcIds a lane remembers, so a frame sent again runs once. */
const SEEN_RPC_MAX = 200

export interface LaneIdentity {
  userId: string
  assistantId: string
}

export interface LaneThreadFrame {
  rpcId: string
  op: typeof THREAD_TURN | typeof THREAD_CLOSE
  chatId: string | number | null
  payload: Record<string, unknown>
}

/**
 * Is this `voice_rpc` frame a thread op for THIS lane? `thread` only when it
 * names this agent, is stamped exactly for this lane's person (the person
 * named and the stamp, both), is `thread_turn` or `thread_close` and carries
 * an rpcId. Anything else is `drop`, and the caller answers nothing.
 */
export function classifyLaneThreadFrame(
  raw: unknown,
  lane: LaneIdentity,
): { kind: 'thread'; frame: LaneThreadFrame } | { kind: 'drop'; why: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'drop', why: 'unreadable' }
  const r = raw as Record<string, unknown>
  const rpcId = typeof r.rpcId === 'string' ? r.rpcId : ''
  if (rpcId === '') return { kind: 'drop', why: 'no_rpc_id' }
  if (r.op !== THREAD_TURN && r.op !== THREAD_CLOSE) return { kind: 'drop', why: 'op' }
  if (!isSafeLaneUserId(lane?.userId)) return { kind: 'drop', why: 'lane_unknown' }
  const stamp = readLaneStamp(r)
  if (r.actorUserId !== lane.userId || stamp !== personLaneStamp(lane.userId)) {
    return { kind: 'drop', why: stamp === null ? 'not stamped for a person' : 'stamped for another lane' }
  }
  const target = r.assistantId
  if ((typeof target !== 'string' && typeof target !== 'number') || String(target) !== String(lane.assistantId)) {
    return { kind: 'drop', why: 'another agent' }
  }
  return {
    kind: 'thread',
    frame: {
      rpcId,
      op: r.op,
      chatId: typeof r.chatId === 'number' || typeof r.chatId === 'string' ? r.chatId : null,
      payload: r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload) ? (r.payload as Record<string, unknown>) : {},
    },
  }
}

export type LaneThreadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } }

/** The answer body for a lane's thread frame: the result plus the echo. */
export function laneThreadAnswer(result: LaneThreadResult, userId: string): Record<string, unknown> {
  const lane = personLaneStamp(userId)
  const echo = { actorUserId: userId, lane }
  return result.ok
    ? { ok: true, payload: { ...result.payload, ...echo }, lane }
    : { ok: false, error: result.error, payload: echo, lane }
}

export interface LaneThreadRpcDeps {
  /** This lane: its person and its agent. */
  lane: LaneIdentity
  /** The lane's own thread manager (laneThreadDeps). */
  threads: {
    turn(input: ThreadTurnInput): { accepted: true; state: 'working' | 'waiting' }
    close(input: { rootId: string; removeWorktree: boolean }): Promise<{ stopped: true }>
  }
  /** POST integrations/voice-rpc/<rpcId>/ack with the lane session. */
  postAck: (rpcId: string) => Promise<unknown>
  /** POST integrations/voice-rpc/<rpcId>/result with the lane session. */
  postResult: (rpcId: string, body: Record<string, unknown>) => Promise<unknown>
  log: (msg: string) => void
}

export class LaneThreadRpcHandler {
  private readonly deps: LaneThreadRpcDeps
  private readonly seen = new Set<string>()

  constructor(deps: LaneThreadRpcDeps) {
    this.deps = deps
  }

  /** One `voice_rpc` frame as the socket handed it over. Never throws. */
  async handle(raw: unknown): Promise<void> {
    const { log, lane } = this.deps
    const sorted = classifyLaneThreadFrame(raw, lane)
    if (sorted.kind === 'drop') {
      log(`voice_rpc dropped: ${sorted.why}`)
      return
    }
    const frame = sorted.frame
    // The server sends a frame again until it is acknowledged: run it once.
    if (this.seen.has(frame.rpcId)) {
      log(`voice_rpc ${frame.op} sent again; it already ran`)
      return
    }
    this.seen.add(frame.rpcId)
    if (this.seen.size > SEEN_RPC_MAX) this.seen.delete(this.seen.values().next().value as string)
    try {
      await this.deps.postAck(frame.rpcId)
    } catch (err) {
      log(`voice_rpc ack failed (non-fatal): ${errorKind(err)}`)
    }
    let result: LaneThreadResult
    try {
      if (frame.op === THREAD_TURN) {
        const answer = this.deps.threads.turn(threadTurnPayload(frame.payload, frame.chatId))
        result = { ok: true, payload: { accepted: true, state: answer.state } }
      } else {
        await this.deps.threads.close(threadClosePayload(frame.payload))
        result = { ok: true, payload: { stopped: true } }
      }
    } catch (err) {
      const refusal = threadRefusal(err)
      log(`voice_rpc ${frame.op} refused: ${refusal?.code ?? errorKind(err)}`)
      result = { ok: false, error: refusal ?? { code: 'failed', message: 'The thread could not be handled on the agent host.' } }
    }
    try {
      await this.deps.postResult(frame.rpcId, laneThreadAnswer(result, lane.userId))
    } catch (err) {
      // The server's own timeout tells the person; the turn itself still runs.
      log(`voice_rpc result failed: ${errorKind(err)}`)
    }
  }
}

function errorKind(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status === 'number') return `HTTP ${status}`
  return err instanceof Error ? err.name : 'error'
}

// ── The login the fork runs on ──────────────────────────────────────────────

/**
 * The Claude login of the lane's own Claude, read from the lane daemon's
 * environment BEFORE it drops those names (lib/lane-daemon.ts
 * scrubLaneDaemonEnv), for the thread's `claude` alone: the login variables
 * the lane was launched with (the person's own token, or whichever the
 * owner's process passed through under `inherit`), and the config dir the
 * lane's Claude uses, where its transcript is. The default config dir is
 * never spelled out: an explicit CLAUDE_CONFIG_DIR changes where the CLI
 * keeps its sign in.
 */
export function laneThreadLoginEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of LANE_LOGIN_ENV) {
    const value = env[name]
    if (typeof value === 'string' && value !== '') out[name] = value
  }
  const configDir = env.HOAI_LANE_CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR
  if (typeof configDir === 'string' && configDir !== '') out.CLAUDE_CONFIG_DIR = configDir
  return out
}

// ── The lane's own thread manager ───────────────────────────────────────────

/** What a lane knows about itself. It holds no agent folder and no owner session, on purpose. */
export interface LaneThreadFacts {
  lane: LaneIdentity
  home: string
  /** BGOS_PLUGIN_STATE_DIR when set. */
  stateRoot?: string
  /** The Claude config dir the lane's own Claude uses, '' for ~/.claude. */
  configDir: string
  /** The policy THIS launch of the lane was given (lib/lane-controls.ts launchedFacts). */
  launchPolicy: unknown
  /** This plugin's bin/hoai-lane-floor-hook.mjs. */
  floorHookPath: string
  /** The node that runs the floor hook. */
  nodePath: string
  /** laneThreadLoginEnv, read before the daemon's environment was scrubbed. */
  loginEnv: Record<string, string>
  platform?: NodeJS.Platform
}

export interface LaneThreadEffects {
  spawn: SpawnStreamJson
  claudeBin(): string | null
  cliProblem(): string | null | Promise<string | null>
  processes: ThreadLaneDeps['processes']
  fs: ThreadLaneFs
  transcripts?: ThreadLaneDeps['transcripts']
  realpath(path: string): string
  /** POST one of integrations/threads/state, reply, summary with the lane session. */
  post(path: string, body: Record<string, unknown>): Promise<unknown>
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(msg: string): void
}

/** The lane's own floor hook, as the lane's settings file registers it, and nothing else. */
export function laneThreadHooks(input: { workDir: string; userId: string; nodePath: string; floorHookPath: string; platform?: NodeJS.Platform }): Record<string, unknown> {
  const body = laneSettingsBody({
    workDir: input.workDir,
    userId: input.userId,
    nodePath: input.nodePath,
    floorHookPath: input.floorHookPath,
    platform: input.platform ?? process.platform,
  })
  return { PreToolUse: body.hooks.PreToolUse }
}

/**
 * A person's thread, whatever the manager worked out: read only, no Bash,
 * the lane's work folder as the one folder it reads, the read only thread
 * tools cut to the lane's own launch tools, the web rules only under the
 * share's web option, and the lane's floor hook.
 */
export function laneThreadConfinement(
  base: ThreadLaneConfinement,
  lane: { workDir: string; launchPolicy: unknown; hooks: Record<string, unknown>; platform?: NodeJS.Platform },
): ThreadLaneConfinement {
  // The supervisor never launches a lane with a shell or the owner's servers
  // (lib/lane-supervisor.mjs prepareLaneLaunch); nor does a thread get them.
  const policy = { ...readToolPolicy(lane.launchPolicy), shell: false, ownerMcpServers: false, readAgentFolder: false }
  const laneTools = laneToolsFor(policy, LANE_BUILTIN_TOOLS)
  return {
    root: base.root,
    readOnly: true,
    shellSandbox: false,
    readDirs: [lane.workDir],
    tools: THREAD_LANE_READ_ONLY_TOOLS.filter((tool) => laneTools.includes(tool)),
    allowExtra: laneAllowAdditions(policy, { agentFolder: null, platform: lane.platform ?? process.platform }),
    hooks: lane.hooks,
    platform: lane.platform ?? base.platform,
  }
}

/**
 * The ThreadLaneManager dependencies of ONE person's lane, from the lane's
 * own facts. See the file header for what each one guarantees.
 */
export function laneThreadDeps(facts: LaneThreadFacts, effects: LaneThreadEffects): ThreadLaneDeps {
  const platform = facts.platform ?? process.platform
  const paths = lanePaths({ home: facts.home, assistantId: facts.lane.assistantId, userId: facts.lane.userId, stateRoot: facts.stateRoot, platform })
  const stateDir = join(paths.stateDir, 'threads')
  const threadsRoot = join(paths.workDir, '.hoai', 'threads')
  const hooks = laneThreadHooks({ workDir: paths.workDir, userId: facts.lane.userId, nodePath: facts.nodePath, floorHookPath: facts.floorHookPath, platform })
  const emptyMcp = join(stateDir, 'empty-mcp.json')
  return {
    spawn: (command, args, opts) => {
      // The second lock on the folder: the thread starts inside the lane's
      // own work folder or not at all (a link planted at its folder would
      // otherwise make another folder the fork's working directory).
      let inside = false
      try {
        const real = effects.realpath(opts.cwd)
        const root = join(effects.realpath(paths.workDir), '.hoai', 'threads')
        inside = real !== root && isInsideFolder(real, root, platform) && isInsideFolder(opts.cwd, threadsRoot, platform)
      } catch {
        inside = false
      }
      if (!inside) {
        effects.log('threads: a thread folder resolves outside this lane\'s work folder; not started')
        throw Object.assign(new Error('the thread folder is outside the lane'), { code: 'OUTSIDE_LANE_FOLDER' })
      }
      return effects.spawn(command, args, { cwd: opts.cwd, env: { ...facts.loginEnv } })
    },
    claudeBin: effects.claudeBin,
    cliProblem: effects.cliProblem,
    mainSessionId: () => {
      try {
        const id = effects.fs.readFile(paths.sessionIdPath).trim()
        return isSessionId(id) ? id : null
      } catch {
        return null
      }
    },
    // The folder the LANE's own session runs in: its transcript is looked up
    // from here, and the thread's folder is made under it.
    agentFolder: paths.workDir,
    stateDir,
    home: facts.home,
    configDir: facts.configDir,
    emptyMcpConfigPath: () => {
      if (!effects.fs.exists(emptyMcp)) {
        effects.fs.mkdir(stateDir)
        effects.fs.writeFile(emptyMcp, '{"mcpServers":{}}\n')
      }
      return emptyMcp
    },
    pluginStateDir: facts.stateRoot,
    processes: effects.processes,
    shellSandbox: () => false,
    platform,
    // Never git: no lane gets a worktree of any repository, so every thread
    // of a lane is a plain folder and read only.
    git: async () => ({ ok: false, stdout: '' }),
    confine: (base) => laneThreadConfinement(base, { workDir: paths.workDir, launchPolicy: facts.launchPolicy, hooks, platform }),
    ...(effects.transcripts ? { transcripts: effects.transcripts } : {}),
    fs: effects.fs,
    post: effects.post,
    now: effects.now,
    setTimer: effects.setTimer,
    clearTimer: effects.clearTimer,
    log: effects.log,
    maxRunning: LANE_THREAD_MAX_RUNNING,
  }
}
