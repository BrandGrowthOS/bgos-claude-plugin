/**
 * PERSON LANES, a person's THREADS run in that person's own lane
 * (lib/lane-thread-rpc.ts; KC 2026-11-11 "the thread is also available to the
 * shared agent").
 *
 *   - The lane daemon takes `thread_turn` and `thread_close` on `voice_rpc`
 *     only when the frame is for this agent and stamped EXACTLY for this
 *     lane's person. Anything else (the owner's own unstamped frame, another
 *     person, another agent, any other op, no rpcId) gets nothing, not even
 *     an ack.
 *   - Every answer echoes the stamp, like the memory answers.
 *   - The thread forks the LANE's own session (the lane's pin), in a plain
 *     folder under the lane's own work folder, with the lane's own Claude
 *     login, read only, no Bash, the lane's floor hook, and never more tools
 *     than the lane was launched with. It never sees the owner's session or
 *     the agent folder, and never runs git.
 *   - Its answers go out through the lane's own post (the lane session).
 *   - The OWNER's daemon drops a `thread_turn` or `thread_close` stamped for
 *     a person: it never runs one in the owner's session.
 *
 * Every dependency is a fake: no claude, no git, no disk, no network.
 *
 * Run with: node --import tsx --test-reporter=tap test/lane-thread-rpc.test.ts
 *
 * No em or en dashes in this file.
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32).
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { lanePaths } from '../lib/lane-core.mjs'
import {
  classifyLaneThreadFrame,
  laneThreadAnswer,
  laneThreadDeps,
  laneThreadLoginEnv,
  LaneThreadRpcHandler,
  LANE_THREAD_MAX_RUNNING,
  LANE_THREADS_TOKEN,
  type LaneThreadEffects,
  type LaneThreadFacts,
} from '../lib/lane-thread-rpc.ts'
import { buildSenderGuardrailMarker } from '../lib/inbound-channel.ts'
import { threadTurnPrompt } from '../lib/thread-lane-args.ts'
import { ThreadLaneManager, threadsPendingPath, type ThreadTurnInput } from '../lib/thread-lanes.ts'
import { assertConfined, threadLaneArgs } from '../lib/thread-lane-args.ts'
import { normalizeVoiceRpc } from '../lib/voice-rpc.ts'
import type { StreamJsonChild } from '../lib/stream-json-child.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

const AGENT = '1076'
const ANA = 'user_ana'
const BEN = 'user_ben'
const HOME = resolve('/home/owner')
const PLUGIN = resolve('/opt/hoai-plugin')
const FLOOR_HOOK = join(PLUGIN, 'bin', 'hoai-lane-floor-hook.mjs')
// The OWNER's facts: nothing below may ever carry them.
const OWNER_FOLDER = resolve('/work/atlas')
const OWNER_SESSION = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
// The LANE's own session (its pin) and the thread's fork.
const LANE_SESSION = 'dbd3b62b-f099-4f95-be1d-4687b4af9042'
const FORK = '060f0349-719c-4450-aab2-189517f87a76'
const PATHS = lanePaths({ home: HOME, assistantId: AGENT, userId: ANA })
const LANE_CONFIG = PATHS.configDir
const THREADS_STATE = join(PATHS.stateDir, 'threads')
const wt = (root: string) => join(PATHS.workDir, '.hoai', 'threads', root)

class FakeChild implements StreamJsonChild {
  pid?: number
  stdin: string[] = []
  killed: string[] = []
  private out: Array<(c: string) => void> = []
  private exits: Array<(code: number | null, signal: string | null) => void> = []
  write(c: string) { this.stdin.push(c) }
  end() {}
  kill(s: 'SIGTERM' | 'SIGKILL') { this.killed.push(s) }
  onStdout(cb: (c: string) => void) { this.out.push(cb) }
  onExit(cb: (code: number | null, signal: string | null) => void) { this.exits.push(cb) }
  frame(f: Record<string, unknown>) { for (const cb of this.out) cb(`${JSON.stringify(f)}\n`) }
  exit(code: number | null = 0) { for (const cb of this.exits) cb(code, null) }
  init(id: string) { this.frame({ type: 'system', subtype: 'init', session_id: id }) }
  result(text: string) { this.frame({ type: 'result', subtype: 'success', is_error: false, result: text }) }
}

function rig(opts: { policy?: unknown; pin?: string | null; realpath?: (p: string) => string; loginEnv?: Record<string, string>; configDir?: string } = {}) {
  const configDir = opts.configDir ?? LANE_CONFIG
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const spawned: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> | undefined; child: FakeChild }> = []
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const logs: string[] = []
  if (opts.pin !== null) files.set(PATHS.sessionIdPath, `${opts.pin ?? LANE_SESSION}\n`)
  // The lane's own transcript, in the config dir the lane's own Claude uses.
  files.set(sessionTranscriptPath(HOME, PATHS.workDir, LANE_SESSION, configDir), '{"lane":true}\n')
  // The owner's transcript exists on the same machine: a decoy no thread of a lane may touch.
  files.set(sessionTranscriptPath(HOME, OWNER_FOLDER, OWNER_SESSION, ''), '{"owner":true}\n')
  let lastPid = 7000
  const facts: LaneThreadFacts = {
    lane: { userId: ANA, assistantId: AGENT },
    home: HOME,
    configDir,
    launchPolicy: opts.policy ?? null,
    floorHookPath: FLOOR_HOOK,
    nodePath: 'node',
    loginEnv: opts.loginEnv ?? { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: 'tok-ana' },
    platform: 'darwin',
  }
  const effects: LaneThreadEffects = {
    spawn: (command, args, o) => {
      const child = new FakeChild()
      child.pid = ++lastPid
      spawned.push({ command, args, cwd: o.cwd, env: o.env, child })
      return child
    },
    claudeBin: () => '/bin/claude',
    cliProblem: async () => null,
    processes: { stamp: async () => null, runsIn: async () => false, kill: () => {} },
    fs: {
      exists: (p) => files.has(p) || dirs.has(p),
      mkdir: (p) => { dirs.add(p) },
      readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
      writeFile: (p, s) => { files.set(p, s) },
      appendFile: (p, s) => { files.set(p, (files.get(p) ?? '') + s) },
      copyFile: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error(`ENOENT ${a}`); files.set(b, v) },
      unlink: (p) => { if (!files.delete(p)) throw new Error(`ENOENT ${p}`) },
      rmrf: (p) => { dirs.delete(p) },
      createExclusive: (p, s) => { if (files.has(p)) throw new Error(`EEXIST ${p}`); files.set(p, s) },
      rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error(`ENOENT ${a}`); files.delete(a); files.set(b, v) },
      list: (d) => [...files.keys()].filter((k) => dirname(k) === d).map((k) => k.slice(d.length + 1)),
    },
    realpath: opts.realpath ?? ((p) => p),
    post: async (path, body) => { posts.push({ path, body }) },
    now: () => 1_000_000,
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: () => {},
    log: (l) => logs.push(l),
  }
  const deps = laneThreadDeps(facts, effects)
  const manager = new ThreadLaneManager(deps)
  return { manager, deps, facts, files, dirs, spawned, posts, logs }
}

const turn = (rootId: string, over: Partial<ThreadTurnInput> = {}): ThreadTurnInput => ({
  chatId: '55', rootId, replyId: `${rootId}0`, mode: 'start', text: `look at ${rootId}`, title: `T${rootId}`, rootText: `root ${rootId}`, ...over,
})

function frame(userId: string | null, op: string, payload: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    rpcId: `rpc-${op}-${userId ?? 'owner'}`,
    op,
    assistantId: AGENT,
    agentRoute: '',
    chatId: '55',
    payload,
    timeoutMs: 15_000,
    ...(userId ? { actorUserId: userId, lane: `person:${userId}` } : {}),
    ...over,
  }
}

const TURN_PAYLOAD = { chatId: '55', rootId: '101', replyId: '202', mode: 'start', text: 'hello', title: 'A thread', rootText: 'the root' }

function handler(lane = { userId: ANA, assistantId: AGENT }) {
  const acks: string[] = []
  const results: Array<{ rpcId: string; body: Record<string, unknown> }> = []
  const turns: ThreadTurnInput[] = []
  const closes: Array<{ rootId: string; removeWorktree: boolean }> = []
  const logs: string[] = []
  const order: string[] = []
  const handle = new LaneThreadRpcHandler({
    lane,
    threads: {
      turn: (input) => { order.push('turn'); turns.push(input); return { accepted: true, state: 'working' } },
      close: async (input) => { order.push('close'); closes.push(input); return { stopped: true } },
    },
    postAck: async (rpcId) => { order.push('ack'); acks.push(rpcId) },
    postResult: async (rpcId, body) => { order.push('result'); results.push({ rpcId, body }) },
    log: (l) => logs.push(l),
  })
  return { handle, acks, results, turns, closes, logs, order }
}

// ── The token and the frame ─────────────────────────────────────────────────

test('the token is the backend\'s spelling (backend/src/common/share-threads.ts LANE_THREADS)', () => {
  assert.equal(LANE_THREADS_TOKEN, 'lane_threads')
})

test('a frame is this lane\'s only when it is for this agent and stamped exactly for this person', () => {
  const lane = { userId: ANA, assistantId: AGENT }
  const mine = classifyLaneThreadFrame(frame(ANA, 'thread_turn', TURN_PAYLOAD), lane)
  assert.equal(mine.kind, 'thread')
  assert.deepEqual(mine.kind === 'thread' && mine.frame, { rpcId: 'rpc-thread_turn-user_ana', op: 'thread_turn', chatId: '55', payload: TURN_PAYLOAD })
  assert.equal(classifyLaneThreadFrame(frame(ANA, 'thread_close', { rootId: '101' }), lane).kind, 'thread')
  const dropped: Array<[string, unknown]> = [
    ['the owner\'s own frame (no stamp)', frame(null, 'thread_turn', TURN_PAYLOAD)],
    ['an owner stamp', frame(null, 'thread_turn', TURN_PAYLOAD, { lane: 'owner' })],
    ['an owner stamp naming this person', frame(null, 'thread_turn', TURN_PAYLOAD, { lane: 'owner', actorUserId: ANA })],
    ['this person named with no stamp', frame(null, 'thread_turn', TURN_PAYLOAD, { actorUserId: ANA })],
    ['a stamp with no person named', frame(null, 'thread_turn', TURN_PAYLOAD, { lane: `person:${ANA}` })],
    ['another person', frame(BEN, 'thread_turn', TURN_PAYLOAD)],
    ['another person\'s stamp under this person\'s name', frame(ANA, 'thread_turn', TURN_PAYLOAD, { lane: `person:${BEN}` })],
    ['this person\'s stamp under another name', frame(BEN, 'thread_turn', TURN_PAYLOAD, { lane: `person:${ANA}` })],
    ['a stamp that is no string', frame(ANA, 'thread_turn', TURN_PAYLOAD, { lane: { person: ANA } })],
    ['another agent', frame(ANA, 'thread_turn', TURN_PAYLOAD, { assistantId: '9' })],
    ['no agent named', frame(ANA, 'thread_turn', TURN_PAYLOAD, { assistantId: undefined })],
    ['no rpcId', frame(ANA, 'thread_turn', TURN_PAYLOAD, { rpcId: '' })],
    ['a rpcId that is no string', frame(ANA, 'thread_turn', TURN_PAYLOAD, { rpcId: 7 })],
    ['aside', frame(ANA, 'aside', { question: 'q' })],
    ['stop_turn', frame(ANA, 'stop_turn')],
    ['group_thread_end', frame(ANA, 'group_thread_end', { chatId: '55' })],
    ['consult', frame(ANA, 'consult')],
    ['not an object', 'thread_turn'],
    ['null', null],
  ]
  for (const [what, raw] of dropped) assert.equal(classifyLaneThreadFrame(raw, lane).kind, 'drop', what)
  // A numeric agent id is the same agent.
  assert.equal(classifyLaneThreadFrame(frame(ANA, 'thread_turn', TURN_PAYLOAD, { assistantId: 1076 }), lane).kind, 'thread')
})

test('every answer echoes the stamp: lane at the top, actorUserId and lane in the payload', () => {
  assert.deepEqual(laneThreadAnswer({ ok: true, payload: { accepted: true, state: 'working' } }, ANA), {
    ok: true,
    payload: { accepted: true, state: 'working', actorUserId: ANA, lane: `person:${ANA}` },
    lane: `person:${ANA}`,
  })
  assert.deepEqual(laneThreadAnswer({ ok: false, error: { code: 'bad_request', message: 'no' } }, ANA), {
    ok: false,
    error: { code: 'bad_request', message: 'no' },
    payload: { actorUserId: ANA, lane: `person:${ANA}` },
    lane: `person:${ANA}`,
  })
})

// ── The handler: ack, run, answer ───────────────────────────────────────────

test('a frame for another person or another agent gets nothing: no ack, no answer, no turn', async () => {
  const h = handler()
  await h.handle.handle(frame(BEN, 'thread_turn', TURN_PAYLOAD))
  await h.handle.handle(frame(ANA, 'thread_turn', TURN_PAYLOAD, { assistantId: '9' }))
  await h.handle.handle(frame(ANA, 'thread_turn', TURN_PAYLOAD, { lane: `person:${BEN}` }))
  assert.deepEqual(h.acks, [])
  assert.deepEqual(h.results, [])
  assert.deepEqual(h.turns, [])
  assert.equal(h.logs.length, 3, 'each drop is one log line')
})

test('an unstamped (owner) frame gets nothing in the lane', async () => {
  const h = handler()
  await h.handle.handle(frame(null, 'thread_turn', TURN_PAYLOAD))
  await h.handle.handle(frame(null, 'thread_close', { rootId: '101', removeWorktree: true }))
  await h.handle.handle(frame(null, 'thread_turn', TURN_PAYLOAD, { lane: 'owner' }))
  assert.deepEqual([h.acks, h.results, h.turns, h.closes], [[], [], [], []])
})

test('any other op gets nothing in the lane, also when stamped for it', async () => {
  const h = handler()
  for (const op of ['aside', 'stop_turn', 'consult', 'mint', 'dispatch', 'group_thread_end', 'group_thread_level', 'list_model_effort', 'apply_model_effort', 'list_sessions']) {
    await h.handle.handle(frame(ANA, op, { chatId: '55' }))
  }
  assert.deepEqual([h.acks, h.results, h.turns, h.closes], [[], [], [], []])
})

test('thread_turn is acked, handed to the lane\'s threads, and answered accepted at once with the echo', async () => {
  const h = handler()
  await h.handle.handle(frame(ANA, 'thread_turn', TURN_PAYLOAD))
  assert.deepEqual(h.order, ['ack', 'turn', 'result'])
  assert.deepEqual(h.acks, ['rpc-thread_turn-user_ana'])
  assert.deepEqual(h.turns, [{ chatId: '55', rootId: '101', replyId: '202', mode: 'start', text: 'hello', title: 'A thread', rootText: 'the root' }])
  assert.deepEqual(h.results, [{
    rpcId: 'rpc-thread_turn-user_ana',
    body: { ok: true, payload: { accepted: true, state: 'working', actorUserId: ANA, lane: `person:${ANA}` }, lane: `person:${ANA}` },
  }])
})

test('thread_close stops the thread and answers stopped with the echo', async () => {
  const h = handler()
  await h.handle.handle(frame(ANA, 'thread_close', { chatId: '55', rootId: '101', removeWorktree: true }))
  assert.deepEqual(h.closes, [{ rootId: '101', removeWorktree: true }])
  assert.deepEqual(h.results[0]!.body, { ok: true, payload: { stopped: true, actorUserId: ANA, lane: `person:${ANA}` }, lane: `person:${ANA}` })
})

test('a refusal is answered with its code and the echo, never silence', async () => {
  const h = handler()
  await h.handle.handle(frame(ANA, 'thread_turn', { ...TURN_PAYLOAD, mode: 'steer' }))
  assert.deepEqual(h.acks.length, 1)
  assert.deepEqual(h.turns, [])
  const body = h.results[0]!.body as { ok: boolean; error: { code: string; message: string }; payload: unknown; lane: string }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'bad_request')
  assert.deepEqual(body.payload, { actorUserId: ANA, lane: `person:${ANA}` })
  assert.equal(body.lane, `person:${ANA}`)
})

test('a frame sent again (the same rpcId) runs once', async () => {
  const h = handler()
  await h.handle.handle(frame(ANA, 'thread_turn', TURN_PAYLOAD))
  await h.handle.handle(frame(ANA, 'thread_turn', TURN_PAYLOAD))
  assert.equal(h.turns.length, 1)
  assert.equal(h.results.length, 1)
})

test('an ack that fails does not stop the turn or its answer', async () => {
  const turns: ThreadTurnInput[] = []
  const results: unknown[] = []
  const handle = new LaneThreadRpcHandler({
    lane: { userId: ANA, assistantId: AGENT },
    threads: { turn: (input) => { turns.push(input); return { accepted: true, state: 'waiting' } }, close: async () => ({ stopped: true }) },
    postAck: async () => { throw new Error('HTTP 502') },
    postResult: async (_rpcId, body) => { results.push(body) },
    log: () => {},
  })
  await handle.handle(frame(ANA, 'thread_turn', TURN_PAYLOAD))
  assert.equal(turns.length, 1)
  assert.equal((results[0] as { payload: { state: string } }).payload.state, 'waiting')
})

// ── The lane's own thread manager ───────────────────────────────────────────

test('the manager is built from the lane\'s own facts: its work folder, its state folder, its pin, one thread at a time', () => {
  const r = rig()
  assert.equal(r.deps.agentFolder, PATHS.workDir, 'the folder the lane\'s own session runs in, never the agent\'s')
  assert.equal(r.deps.stateDir, THREADS_STATE)
  assert.equal(r.deps.home, HOME)
  assert.equal(r.deps.configDir, LANE_CONFIG)
  assert.equal(r.deps.mainSessionId(), LANE_SESSION)
  assert.equal(r.deps.maxRunning, 1)
  assert.equal(LANE_THREAD_MAX_RUNNING, 1)
  assert.equal(r.deps.shellSandbox(), false, 'a person\'s thread never has Bash')
  assert.equal(r.deps.emailFilesDir ?? null, null)
  assert.equal(r.deps.checkoutTooLarge, undefined)
  // The facts hold no agent folder and no owner session at all.
  assert.deepEqual(Object.keys(r.facts).sort(), ['configDir', 'floorHookPath', 'home', 'lane', 'launchPolicy', 'loginEnv', 'nodePath', 'platform'])
})

test('the session a thread forks is the lane\'s pin, read fresh, and nothing when the pin is missing or no session id', () => {
  const r = rig()
  assert.equal(r.deps.mainSessionId(), LANE_SESSION)
  // `/new` repins the lane: the next thread forks the new conversation.
  r.files.set(PATHS.sessionIdPath, `${FORK}\n`)
  assert.equal(r.deps.mainSessionId(), FORK)
  r.files.set(PATHS.sessionIdPath, '../../etc/passwd\n')
  assert.equal(r.deps.mainSessionId(), null)
  assert.equal(rig({ pin: null }).deps.mainSessionId(), null)
})

test('a lane never runs git: no worktree of any repository, whatever the folder is', async () => {
  const r = rig()
  assert.deepEqual(await r.deps.git(['-C', PATHS.workDir, 'rev-parse', '--show-prefix'], PATHS.workDir), { ok: false, stdout: '' })
  assert.deepEqual(await r.deps.git(['-C', OWNER_FOLDER, 'worktree', 'add', 'x'], OWNER_FOLDER), { ok: false, stdout: '' })
})

test('thread_turn forks the LANE\'s session, in a plain folder under the lane\'s work folder, with the lane\'s login', async () => {
  const r = rig()
  assert.deepEqual(r.manager.turn(turn('101')), { accepted: true, state: 'working' })
  await r.manager.idle()
  assert.equal(r.spawned.length, 1)
  const s = r.spawned[0]!
  assert.equal(s.command, '/bin/claude')
  assert.equal(s.cwd, wt('101'), 'the lane\'s folder')
  assert.ok(r.dirs.has(wt('101')), 'a plain folder, made by the daemon')
  // The fork: the lane's own session, with --fork-session, never the owner's.
  const at = s.args.indexOf('--resume')
  assert.deepEqual(s.args.slice(at, at + 3), ['--resume', LANE_SESSION, '--fork-session'])
  // The lane's transcript was copied where the CLI looks the id up from the thread's folder, in the LANE's config dir.
  assert.equal(r.files.get(sessionTranscriptPath(HOME, wt('101'), LANE_SESSION, LANE_CONFIG)), '{"lane":true}\n')
  // The login is the lane's own, handed to the fork alone.
  assert.deepEqual(s.env, { CLAUDE_CONFIG_DIR: LANE_CONFIG, CLAUDE_CODE_OAUTH_TOKEN: 'tok-ana' })
  // Lane state under the lane's own state folder.
  const state = JSON.parse(r.files.get(join(THREADS_STATE, '101.json'))!)
  assert.equal(state.folder, wt('101'))
  assert.equal(state.worktree, false)
  assert.equal(state.readOnly, true)
  assert.equal(s.args[s.args.indexOf('--mcp-config') + 1], join(THREADS_STATE, 'empty-mcp.json'))
  assert.equal(r.files.get(join(THREADS_STATE, 'empty-mcp.json')), '{"mcpServers":{}}\n')
})

test('the thread never receives the agent folder or the owner\'s session', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const s = r.spawned[0]!
  const everything = JSON.stringify([s.command, s.args, s.cwd, s.env, s.child.stdin])
  assert.equal(everything.includes(OWNER_FOLDER), false, 'the agent folder is named nowhere')
  assert.equal(everything.includes(OWNER_SESSION), false, 'the owner\'s session is named nowhere')
  // No copy of the owner's transcript was made anywhere, and it was not touched.
  const copies = [...r.files.keys()].filter((k) => k.endsWith(`${OWNER_SESSION}.jsonl`))
  assert.deepEqual(copies, [sessionTranscriptPath(HOME, OWNER_FOLDER, OWNER_SESSION, '')])
  // Every path in the command is the lane's own folder, its state folder or the plugin's floor hook.
  const settings = JSON.parse(s.args[s.args.indexOf('--settings') + 1]!) as { permissions: { allow: string[]; additionalDirectories: string[] } }
  assert.deepEqual(settings.permissions.additionalDirectories, [PATHS.workDir])
  assert.deepEqual(settings.permissions.allow, [`Read(/${PATHS.workDir}/**)`])
})

test('a person\'s thread is confined: read only, no Bash, the lane\'s floor hook, never more tools than the lane has', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const args = r.spawned[0]!.args
  assert.ok(args.includes('--restricted'))
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep', 'a locked lane has no web tools, so its thread has none')
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk')
  for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir']) assert.equal(args.includes(forbidden), false, forbidden)
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as Record<string, any>
  assert.deepEqual(settings.permissions.deny, ['Bash', 'Edit', 'Write', 'NotebookEdit'])
  assert.equal(settings.sandbox, undefined)
  assert.equal(settings.remoteControlAtStartup, false)
  // The lane's own floor hook (fails closed, a hold is a deny), and none of the owner's plugin hooks.
  assert.deepEqual(settings.hooks, {
    PreToolUse: [{
      matcher: '*',
      hooks: [{ type: 'command', command: `'node' '${FLOOR_HOOK}' --lane ${ANA}`, onFailure: 'block', timeout: 5 }],
    }],
  })
  assert.doesNotThrow(() => assertConfined(args, settings.hooks))
  assert.throws(() => assertConfined(args), /hook/, 'the lane\'s hooks pass only where a caller names them')
  // The first user message says it is read only and names the lane's own folder.
  assert.match(r.spawned[0]!.child.stdin.join(''), /read only/)
})

test('a lane launched with web access gives its thread the web tools; a shell grant never gives Bash', async () => {
  const web = rig({ policy: { v: 1, webFetch: true, readAgentFolder: true, shell: true, ownerMcpServers: true, browser: true } })
  web.manager.turn(turn('101'))
  await web.manager.idle()
  const args = web.spawned[0]!.args
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,WebFetch,WebSearch')
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as Record<string, any>
  assert.deepEqual(settings.permissions.allow, [`Read(/${PATHS.workDir}/**)`, 'WebFetch', 'WebSearch'])
  assert.deepEqual(settings.permissions.deny, ['Bash', 'Edit', 'Write', 'NotebookEdit'])
  assert.deepEqual(settings.permissions.additionalDirectories, [PATHS.workDir], 'readAgentFolder does not open the agent folder to a thread')
  // An unreadable policy is the locked base.
  const junk = rig({ policy: 'everything' })
  junk.manager.turn(turn('101'))
  await junk.manager.idle()
  assert.equal(junk.spawned[0]!.args[junk.spawned[0]!.args.indexOf('--tools') + 1], 'Read,Glob,Grep')
})

test('a thread folder that resolves outside the lane\'s work folder is never started', async () => {
  // A link planted at the thread's folder, pointing at the agent folder.
  const r = rig({ realpath: (p) => (p === wt('101') ? OWNER_FOLDER : p) })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(r.spawned.length, 0, 'no claude was started there')
  const reply = r.posts.find((p) => p.path === 'integrations/threads/reply')
  assert.match(String(reply?.body.text), /^I could not open this thread:/)
  assert.equal(JSON.stringify(r.posts).includes(OWNER_FOLDER), false, 'the reply names no path')
})

test('with no session of its own yet the thread says so, and never falls back to another session', async () => {
  const r = rig({ pin: null })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(r.spawned.length, 0)
  assert.match(String(r.posts.find((p) => p.path === 'integrations/threads/reply')?.body.text), /no running session to fork yet/)
})

test('replies, state and the summary go through the lane\'s own post, with the owner\'s bodies', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const child = r.spawned[0]!.child
  child.init(FORK)
  child.result('Done, it is in notes.md.')
  await r.manager.idle()
  assert.deepEqual(r.posts, [
    { path: 'integrations/threads/state', body: { chatId: '55', rootId: '101', state: 'working' } },
    { path: 'integrations/threads/reply', body: { chatId: '55', rootId: '101', text: 'Done, it is in notes.md.', final: true } },
  ])
  // The fork's own id is kept: the next turn resumes it, never the lane's session again.
  assert.equal(JSON.parse(r.files.get(join(THREADS_STATE, '101.json'))!).forkSessionId, FORK)
  r.manager.turn(turn('101', { mode: 'summary', replyId: '1019', text: '' }))
  await r.manager.idle()
  child.result('- asked for notes\n- wrote them')
  await r.manager.idle()
  assert.deepEqual(r.posts.at(-1), { path: 'integrations/threads/summary', body: { chatId: '55', rootId: '101', summary: '- asked for notes\n- wrote them' } })
})

test('one thread runs at a time per lane: a second waits and says so', async () => {
  const r = rig()
  assert.deepEqual(r.manager.turn(turn('101')), { accepted: true, state: 'working' })
  assert.deepEqual(r.manager.turn(turn('102')), { accepted: true, state: 'waiting' })
  await r.manager.idle()
  assert.equal(r.spawned.length, 1)
  assert.ok(r.posts.some((p) => p.path === 'integrations/threads/state' && p.body.rootId === '102' && p.body.state === 'waiting'))
})

test('the pending replay reads the lane\'s own route and runs only this agent\'s rows', async () => {
  const r = rig()
  assert.equal(threadsPendingPath([AGENT]), `integrations/threads/pending?assistantIds=${AGENT}`)
  const started = await r.manager.reconcile(
    async () => ({ turns: [
      { chatId: '55', rootId: '101', replyId: '303', mode: 'reply', text: 'still there?', title: 'T', rootText: 'root', assistantId: AGENT },
      { chatId: '56', rootId: '900', replyId: '304', mode: 'reply', text: 'not yours', title: 'T', rootText: 'root', assistantId: '9' },
    ] }),
    { assistantIds: [AGENT] },
  )
  assert.equal(started, 1)
  await r.manager.idle()
  assert.equal(r.spawned.length, 1)
  assert.equal(r.spawned[0]!.cwd, wt('101'))
})

test('the pending replay has its own second lock: a row stamped for anyone else never runs', async () => {
  const row = (rootId: string, lane?: unknown) => ({ chatId: '55', rootId, replyId: `${rootId}9`, mode: 'reply', text: 'hi', title: 'T', rootText: 'root', assistantId: AGENT, ...(lane === undefined ? {} : { lane }) })
  // A person's lane: its own stamp or none (today's rows carry none); never the owner's or another person's.
  const mine = rig()
  const started = await mine.manager.reconcile(
    async () => ({ turns: [row('101', `person:${BEN}`), row('102', 'owner'), row('103', { person: ANA }), row('104', `person:${ANA}`)] }),
    { assistantIds: [AGENT], lane: `person:${ANA}` },
  )
  assert.equal(started, 1)
  await mine.manager.idle()
  assert.deepEqual(mine.spawned.map((s) => s.cwd), [wt('104')])
  // The owner's daemon (no lane named): a row stamped for a person is that person's lane's, never the owner's session.
  const owner = rig()
  assert.equal(await owner.manager.reconcile(async () => ({ turns: [row('201', `person:${ANA}`), row('202', 'owner')] }), { assistantIds: [AGENT] }), 1)
  await owner.manager.idle()
  assert.deepEqual(owner.spawned.map((s) => s.cwd), [wt('202')])
})

// ── The login the fork runs on ──────────────────────────────────────────────

test('the fork\'s login is the lane\'s own: its token and its config dir, and nothing else of the environment', () => {
  assert.deepEqual(
    laneThreadLoginEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'tok-ana',
      HOAI_LANE_CLAUDE_CONFIG_DIR: LANE_CONFIG,
      CLAUDE_CONFIG_DIR: '/elsewhere',
      BGOS_PAIRING_TOKEN: 'pair_secret',
      BGOS_API_KEY: 'key',
      PATH: '/usr/bin',
      HOAI_LANE_LOGIN_MODE: 'own_token',
    }),
    { CLAUDE_CODE_OAUTH_TOKEN: 'tok-ana', CLAUDE_CONFIG_DIR: LANE_CONFIG },
  )
  // The owner's sign in (inherit): whichever login variable the lane's Claude was given, and the default config dir is not forced.
  assert.deepEqual(laneThreadLoginEnv({ ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: '' }), { ANTHROPIC_API_KEY: 'sk-x' })
  assert.deepEqual(laneThreadLoginEnv({ CLAUDE_CONFIG_DIR: '/custom' }), { CLAUDE_CONFIG_DIR: '/custom' })
  assert.deepEqual(laneThreadLoginEnv({}), {})
})

// ── The owner's daemon ──────────────────────────────────────────────────────

test('the owner\'s daemon drops a thread_turn or thread_close stamped for a person, and keeps its own', () => {
  assert.equal(normalizeVoiceRpc(frame(ANA, 'thread_turn', TURN_PAYLOAD)), null)
  assert.equal(normalizeVoiceRpc(frame(ANA, 'thread_close', { rootId: '101' })), null)
  assert.equal(normalizeVoiceRpc(frame(null, 'thread_turn', TURN_PAYLOAD, { lane: `person:${ANA}` })), null, 'a stamp alone')
  assert.equal(normalizeVoiceRpc(frame(null, 'thread_turn', TURN_PAYLOAD, { actorUserId: ANA })), null, 'a person named with no stamp')
  assert.equal(normalizeVoiceRpc(frame(null, 'thread_turn', TURN_PAYLOAD, { lane: { person: ANA } })), null, 'a stamp that cannot be read')
  // The owner's own frame: no stamp, or `owner`.
  assert.equal(normalizeVoiceRpc(frame(null, 'thread_turn', TURN_PAYLOAD))?.op, 'thread_turn')
  assert.equal(normalizeVoiceRpc(frame(null, 'thread_close', { rootId: '101' }))?.op, 'thread_close')
  assert.equal(normalizeVoiceRpc(frame(null, 'thread_turn', TURN_PAYLOAD, { lane: 'owner' }))?.op, 'thread_turn')
})

test('server.ts runs a voice_rpc frame only after normalizeVoiceRpc, so a dropped frame is never acked or run', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.match(server, /realtimeSocket\.on\('voice_rpc', whenArmed\('voice_rpc', \(payload: any\) => \{\n\s+if \(updateDrainMode\) return\n\s+try \{\n\s+const frame = normalizeVoiceRpc\(payload\)\n\s+if \(!frame\) return\n/)
  assert.equal((server.match(/voiceRpc\.handle\(/g) ?? []).length, 1, 'the one place a voice_rpc frame is run')
})

// ── lane-server.ts wiring (a source read: the file boots a whole lane daemon) ─

const LANE_SERVER = readFileSync(join(import.meta.dirname, '..', 'lane-server.ts'), 'utf8').replace(/\r\n/g, '\n')

test('lane-server.ts answers voice_rpc through the lane handler, with the lane session alone', () => {
  assert.match(LANE_SERVER, /socket\.on\('voice_rpc', \(payload: unknown\) => \{\n\s+void laneThreadRpc\.handle\(payload\)\.catch\(/)
  assert.match(LANE_SERVER, /postAck: \(rpcId\) => laneFetch\('POST', `integrations\/voice-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/ack`, \{\}\),/)
  assert.match(LANE_SERVER, /postResult: \(rpcId, body\) => laneFetch\('POST', `integrations\/voice-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/result`, body\),/)
  assert.match(LANE_SERVER, /lane: LANE,\n\s+threads: \{/)
  // The lane never holds the pairing: nothing here can post as the owner.
  for (const forbidden of ['bgosPost', 'X-BGOS-Pairing', 'pairingToken']) assert.equal(LANE_SERVER.includes(forbidden), false, forbidden)
})

test('lane-server.ts builds the thread manager from the lane\'s own facts and posts through laneFetch', () => {
  assert.match(LANE_SERVER, /new ThreadLaneManager\(laneThreadDeps\(\{\n\s+lane: LANE,\n\s+home: HOME,\n\s+stateRoot: process\.env\.BGOS_PLUGIN_STATE_DIR,\n\s+configDir: LANE_CLAUDE_CONFIG_DIR,\n\s+launchPolicy: launchedFacts\(LAUNCHED_ENV\)\.policy,/)
  assert.match(LANE_SERVER, /post: \(path, body\) => laneFetch\('POST', path, body\),/)
  // The login is read BEFORE the daemon drops it from its own environment.
  const captured = LANE_SERVER.indexOf('laneThreadLoginEnv(process.env)')
  const scrubbed = LANE_SERVER.indexOf('scrubLaneDaemonEnv(process.env)')
  assert.ok(captured > 0 && captured < scrubbed, 'captured before the scrub')
  assert.match(LANE_SERVER, /loginEnv: LANE_THREAD_LOGIN_ENV,/)
})

test('lane-server.ts replays pending thread turns on every connect, from the lane\'s own route', () => {
  assert.match(LANE_SERVER, /socket\.on\('connect', \(\) => \{\n\s+log\('lane socket connected'\)\n\s+void poll\(\)\n\s+reconcileLaneThreads\('connect'\)\n/)
  assert.match(LANE_SERVER, /laneThreads\.reconcile\(\(\) => laneFetch\('GET', threadsPendingPath\(assistantIds\)\), \{ assistantIds, lane: personLaneStamp\(LANE\.userId\) \}\)/)
  assert.match(LANE_SERVER, /const assistantIds = \[String\(LANE\.assistantId\)\]/)
})

test('lane-server.ts stops the thread lanes on shutdown and at once on a revoke', () => {
  const end = LANE_SERVER.slice(LANE_SERVER.indexOf('function endLane(reason: string): void {'), LANE_SERVER.indexOf('function appendEvent('))
  assert.match(end, /void laneThreads\.stopAll\(\)/, 'a revoke, a lost session or a refused login stops them at once')
  const down = LANE_SERVER.slice(LANE_SERVER.indexOf('function shutdown(code: number): void {'), LANE_SERVER.indexOf("process.on('SIGTERM'"))
  assert.match(down, /stopLaneThreadChildren\(\)/)
  assert.match(down, /laneThreads\.killAll\(\)/)
  assert.match(LANE_SERVER, /socket\.on\('lane_revoked', \(frame: unknown\) => \{\n\s+if \(frameIsMine\(frame\)\) endLane\('revoked'\)/)
})

test('a thread at work keeps the lane from its idle stop', () => {
  const tick = LANE_SERVER.slice(LANE_SERVER.indexOf('function tick(): void {'), LANE_SERVER.indexOf('const transport = new StdioServerTransport()'))
  assert.match(tick, /if \(laneThreads\.activeWork\(\) > 0\) \{\n\s+lastActivityAtMs = Date\.now\(\)\n\s+writeLaneState\(\)/)
})

test('the command builder refuses a person\'s confinement that lost its floor hook or carries a Stop hook', () => {
  const base = { root: wt('101'), readOnly: true, shellSandbox: false, readDirs: [PATHS.workDir], tools: ['Read'], platform: 'darwin' as const }
  const build = (hooks: Record<string, unknown>) => threadLaneArgs({ mainSessionId: LANE_SESSION, forkSessionId: null, emptyMcpConfigPath: '/x/empty.json', confinement: { ...base, hooks } })
  const floor = [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook', onFailure: 'block', timeout: 5 }] }]
  assert.doesNotThrow(() => build({ PreToolUse: floor }))
  assert.throws(() => build({}), /hook/)
  assert.throws(() => build({ PreToolUse: [] }), /hook/)
  assert.throws(() => build({ PreToolUse: floor, Stop: [] }), /hook/)
})

// ── The owner's guardrail for this person rides their thread turn (review F5) ──

const RIDER = "Standing instruction from this agent's owner about the person you are talking to: only finance questions."

test('a thread turn frame\'s senderGuardrail is handed to the lane\'s threads; none, no key', async () => {
  const h = handler()
  await h.handle.handle(frame(ANA, 'thread_turn', { ...TURN_PAYLOAD, senderGuardrail: `  ${RIDER}  ` }))
  assert.deepEqual(h.turns, [{ chatId: '55', rootId: '101', replyId: '202', mode: 'start', text: 'hello', title: 'A thread', rootText: 'the root', senderGuardrail: RIDER }])
  const plain = handler()
  await plain.handle.handle(frame(ANA, 'thread_turn', { ...TURN_PAYLOAD, senderGuardrail: '   ' }))
  assert.equal('senderGuardrail' in plain.turns[0]!, false)
})

test('the guardrail is put in front of the person\'s thread turn exactly as the main chat puts it, never in their words', async () => {
  const r = rig()
  r.manager.turn(turn('101', { senderGuardrail: RIDER }))
  await r.manager.idle()
  const sent = r.spawned[0]!.child.stdin.join('')
  const marker = buildSenderGuardrailMarker(RIDER)
  assert.ok(sent.includes(JSON.stringify(marker).slice(1, -1)), 'the main chat\'s own marker')
  const content = JSON.parse(sent.trim().split('\n')[0]!).message.content as string | Array<{ text: string }>
  const textSent = typeof content === 'string' ? content : content.map((c) => c.text).join('')
  assert.ok(textSent.startsWith(`${marker}\n\n`), 'in front of the turn')
  assert.ok(textSent.endsWith('look at 101'), 'the person\'s words follow unchanged')
  // A reply in the thread carries it too.
  assert.ok(threadTurnPrompt({ mode: 'reply', text: 'and now?', title: 'T', rootText: 'r', senderGuardrail: RIDER }).startsWith(`${marker}\n\n`))
  assert.equal(threadTurnPrompt({ mode: 'reply', text: 'and now?', title: 'T', rootText: 'r' }), 'and now?', 'without one, exactly as before')
})

test('a replayed turn keeps its guardrail in a person\'s lane, and the owner\'s daemon reads none', async () => {
  const row = { chatId: '55', rootId: '104', replyId: '1049', mode: 'reply', text: 'hi', title: 'T', rootText: 'root', assistantId: AGENT, lane: `person:${ANA}`, senderGuardrail: RIDER }
  const mine = rig()
  assert.equal(await mine.manager.reconcile(async () => ({ turns: [row] }), { assistantIds: [AGENT], lane: `person:${ANA}` }), 1)
  await mine.manager.idle()
  assert.ok(mine.spawned[0]!.child.stdin.join('').includes(JSON.stringify(buildSenderGuardrailMarker(RIDER)).slice(1, -1)))
  const owner = rig()
  const { lane: _drop, ...unstamped } = row
  assert.equal(await owner.manager.reconcile(async () => ({ turns: [unstamped] }), { assistantIds: [AGENT] }), 1)
  await owner.manager.idle()
  assert.equal(owner.spawned[0]!.child.stdin.join('').includes('Guardrail from this agent'), false)
})
