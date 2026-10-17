/**
 * PERSON LANES, a running lane learns its share's policy changed (shared
 * agents Phase 3, P7; design 7.2 "How a running lane learns", R9;
 * lib/lane-controls.ts and its wiring in lane-server.ts).
 *
 *   - TIGHTER than the launch restarts the lane NOW (the supervisor's
 *     restart request, `when: now`), and a turn in flight is cut with the
 *     fixed sentence to its person; nothing in flight, no sentence.
 *   - LOOSER waits for the lane's next idle moment (`when: idle`).
 *   - The same policy asks nothing, and one change is asked once, not on
 *     every heartbeat.
 *   - What the lane compares with is what its Claude was launched with
 *     (`launch-policy.json`); none, or a P3 launch, is the locked base.
 *   - A restart request already waiting is merged, never overwritten: a
 *     policy change cannot swallow a `/new`.
 *   - The wiring: `lane_policy_changed` reads `lanes/me`, every heartbeat
 *     answer is read, and the boot `lanes/me` too; the lane socket declares
 *     `lane_memory_rpc` in its own handshake and answers only its own
 *     person's memory frames.
 *
 * Run with: npx tsx --test test/lane-policy-watch.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and these
// tests write 0600 files in a scratch lane, so the file is skipped there.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lanePaths } from '../lib/lane-core.mjs'
import { LOCKED_TOOL_POLICY, readLaneRestartRequest } from '../lib/lane-policy.mjs'
import { launchedFacts, LanePolicyWatch, requestLaneRestart, type RestartAsk } from '../lib/lane-controls.ts'

const ROOT = join(import.meta.dirname, '..')
const SERVER = readFileSync(join(ROOT, 'lane-server.ts'), 'utf8').replace(/\r\n/g, '\n')

function watch(launched: Record<string, unknown>, inFlight: string[] = []) {
  const notices: Array<{ name: string; chatIds: string[] }> = []
  const restarts: RestartAsk[] = []
  const w = new LanePolicyWatch({
    launchedPolicy: () => ({ ...LOCKED_TOOL_POLICY, ...launched }),
    inFlightChats: () => inFlight,
    notice: (name, chatIds) => notices.push({ name, chatIds }),
    requestRestart: (next) => restarts.push(next),
    log: () => {},
  })
  return { w, notices, restarts }
}

test('tighter restarts NOW and cuts the turn in flight with the fixed sentence', () => {
  const { w, notices, restarts } = watch({ shell: true, webFetch: true }, ['5'])
  assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY, webFetch: true }, 'lane_policy_changed'), 'tighter')
  assert.deepEqual(restarts, [{ reasons: ['policy_tightened'], when: 'now', fresh: false, chatId: null }])
  assert.deepEqual(notices, [{ name: 'policy_tightened', chatIds: ['5'] }])
})

test('tighter with nothing in flight restarts now and tells nobody', () => {
  const { w, notices, restarts } = watch({ shell: true })
  assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY }, 'heartbeat'), 'tighter')
  assert.equal(restarts[0]!.when, 'now')
  assert.deepEqual(notices, [])
})

test('looser waits for the lane\'s next idle moment', () => {
  const { w, notices, restarts } = watch({}, ['5'])
  assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY, webFetch: true }, 'heartbeat'), 'looser')
  assert.deepEqual(restarts, [{ reasons: ['policy_loosened'], when: 'idle', fresh: false, chatId: null }])
  assert.deepEqual(notices, [], 'a looser policy cuts nothing')
})

test('the same policy asks nothing; one change is asked once, a new one again', () => {
  const { w, restarts } = watch({ webFetch: true })
  assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY, webFetch: true }, 'boot'), 'same')
  assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY, webFetch: true, browser: true }, 'heartbeat'), 'same', 'browser alone changes no launch')
  assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY, webFetch: true, shell: true }, 'heartbeat'), 'looser')
  assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY, webFetch: true, shell: true }, 'heartbeat'), 'already_asked')
  assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY }, 'lane_policy_changed'), 'tighter')
  assert.equal(restarts.length, 2)
})

test('the launch it compares with: the daemon\'s own environment, never a file the lane could rewrite (review M1)', () => {
  assert.deepEqual(launchedFacts({}), { policy: { ...LOCKED_TOOL_POLICY }, model: null, effort: null }, 'a P3 launch is the locked base')
  assert.deepEqual(launchedFacts({ HOAI_LANE_LAUNCH_POLICY: JSON.stringify({ v: 1, shell: true }), HOAI_LANE_LAUNCH_MODEL: 'haiku', HOAI_LANE_LAUNCH_EFFORT: 'low' }), { policy: { ...LOCKED_TOOL_POLICY, shell: true }, model: 'haiku', effort: 'low' })
  assert.deepEqual(launchedFacts({ HOAI_LANE_LAUNCH_POLICY: 'garbage' }).policy, { ...LOCKED_TOOL_POLICY })
  assert.deepEqual(launchedFacts({ HOAI_LANE_LAUNCH_MODEL: 'x y', HOAI_LANE_LAUNCH_EFFORT: 'warp' }), { policy: { ...LOCKED_TOOL_POLICY }, model: null, effort: null }, 'model and effort checked before any report (review M2)')
  // A forged launch-policy.json changes nothing: the watch reads the environment.
  const home = mkdtempSync(join(tmpdir(), 'lane-watch-'))
  try {
    const paths = lanePaths({ home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    writeFileSync(paths.launchPolicyPath, JSON.stringify({ v: 1, policy: { v: 1 } }))
    const env = { HOAI_LANE_LAUNCH_POLICY: JSON.stringify({ v: 1, shell: true }) }
    const restarts: RestartAsk[] = []
    const w = new LanePolicyWatch({ launchedPolicy: () => launchedFacts(env).policy, inFlightChats: () => [], notice: () => {}, requestRestart: (n) => restarts.push(n), log: () => {} })
    assert.equal(w.onPolicy({ ...LOCKED_TOOL_POLICY }, 'heartbeat'), 'tighter')
    assert.equal(restarts[0]!.when, 'now')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a restart request already waiting is merged: a policy change never swallows a /new', () => {
  const home = mkdtempSync(join(tmpdir(), 'lane-watch-'))
  try {
    const paths = lanePaths({ home, assistantId: '1076', userId: 'user_ana' })
    requestLaneRestart(paths.restartRequestPath, { reasons: ['new'], when: 'now', fresh: true, chatId: '5' })
    requestLaneRestart(paths.restartRequestPath, { reasons: ['policy_loosened'], when: 'idle', fresh: false, chatId: null })
    assert.deepEqual(readLaneRestartRequest(readFileSync(paths.restartRequestPath, 'utf8')), { reasons: ['new', 'policy_loosened'], when: 'now', fresh: true, chatId: '5' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── The wiring in lane-server.ts ────────────────────────────────────────────

function body(name: string): string {
  const at = SERVER.indexOf(name)
  assert.ok(at >= 0, `${name} is in lane-server.ts`)
  return SERVER.slice(at, SERVER.indexOf('\n  })', at) + 5)
}

test('lane-server.ts: lane_policy_changed reads lanes/me, every heartbeat answer is read, and the boot lanes/me too', () => {
  const frame = body("socket.on('lane_policy_changed'")
  assert.match(frame, /if \(!frameIsMine\(frame\)\) return/)
  assert.match(frame, /readPolicyNow\('lane_policy_changed'\)/)
  assert.match(SERVER, /async function readPolicyNow[\s\S]*?laneMePolicy\(await laneFetch\('GET', 'integrations\/lanes\/me'\), LANE\)[\s\S]*?onPolicy\(policy, where\)/)
  assert.match(SERVER, /const policy = heartbeatToolPolicy\(answer\)\n\s*if \(policy\) onPolicy\(policy, 'heartbeat'\)/)
  assert.match(SERVER, /const policy = laneMePolicy\(me, LANE\)\n\s*if \(policy\) onPolicy\(policy, 'boot'\)/)
  assert.match(SERVER, /launchedPolicy: \(\) => launchedFacts\(LAUNCHED_ENV\)\.policy/)
  assert.match(SERVER, /HOAI_LANE_LAUNCH_POLICY: process\.env\.HOAI_LANE_LAUNCH_POLICY,/)
  assert.doesNotMatch(SERVER, /launchPolicyPath/, 'the lane daemon never reads the launch file')
  assert.match(SERVER, /inFlightChats: \(\) => \(inFlight \? \[\.\.\.inFlightChats\] : \[\]\)/)
})

test('lane-server.ts: the lane socket declares lane_memory_rpc in its own handshake, beside the session alone', () => {
  assert.match(SERVER, /cb\(\{ laneSession: session\?\.sessionToken \?\? '', capabilities: \[LANE_MEMORY_RPC_TOKEN\] \}\)/)
  assert.doesNotMatch(SERVER, /pairingToken|X-BGOS-Pairing|apiKey:/)
})

test('lane-server.ts: a memory frame is answered only when stamped for THIS lane\'s person, with the lane session', () => {
  const handler = body("socket.on('memory_rpc'")
  assert.match(handler, /const sorted = classifyMemoryFrame\(payload\)/)
  assert.match(handler, /if \(sorted\.kind !== 'person'\)/)
  assert.match(SERVER, /accepts: \(userId\) => userId === LANE\.userId,/)
  assert.match(SERVER, /postResult: \(rpcId, body\) => laneFetch\('POST', `integrations\/memory-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/result`, body\)/)
})

test('lane-server.ts: a command is routed before anything reaches Claude, and a handled one never does', () => {
  const deliver = SERVER.slice(SERVER.indexOf('async function deliverRaw'), SERVER.indexOf('async function ackDelivery'))
  const routed = deliver.indexOf('routeLaneSlash(')
  const notified = deliver.indexOf("mcp.notification(")
  assert.ok(routed > 0 && notified > routed, 'routed before the channel event')
  const handled = deliver.slice(routed, deliver.indexOf('return\n', routed))
  assert.match(handled, /performLaneCommand\(/)
  assert.match(handled, /inboxNoteHandled\(inbox, d\)/)
  assert.doesNotMatch(handled, /mcp\.notification/)
  assert.match(SERVER, /const merged = requestLaneRestart\(PATHS\.restartRequestPath, next\)/)
})
