/**
 * PERSON LANES, the owner's daemon side of P5 and P7 (server.ts,
 * lib/declared-capabilities.ts, lib/agent-credentials.ts, lib/lane-owner.ts,
 * bin/hoai-lane.mjs; shared agents Phase 3, design section 6 "As built in
 * P4" and 7.2).
 *
 *   - `lane_memory_rpc` is declared with `person_lanes` on the pairing
 *     heartbeat (only on a pairing whose CLI can run lanes), and in the
 *     owner's daemon's OWN socket handshake (`auth.capabilities`), beside an
 *     otherwise unchanged pairing handshake; an API key handshake is today's.
 *   - A memory frame stamped for a PERSON reaching the owner's daemon (her
 *     stopped lane) is answered from her lane's folder with the echo, never
 *     from the owner's memory; unstamped is the owner's own, as before; and
 *     before lanes are on it is refused, with the echo, never guessed.
 *   - The supervisor is told the agent folder only from the launcher's own
 *     BGOS_LAUNCH_CWD, never process.cwd().
 *   - The notices P5 and P7 add are fixed sentences the drain posts; a lane
 *     cannot choose a word of them.
 *   - `hoai-lane models` keeps the owner's list (K7): valid names only.
 *
 * Run with: npx tsx --test test/lane-owner-controls.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and these
// tests run the lane command in a scratch POSIX home, so the file is skipped there.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { wsAuthOptions } from '../lib/agent-credentials.ts'
import { declaredCapabilities } from '../lib/declared-capabilities.ts'
import { LANE_MEMORY_RPC_TOKEN, LANE_NOTICES, laneNoticeSentence, parseLaneEventLine, PERSON_LANES_TOKEN } from '../lib/lane-core.mjs'

const ROOT = join(import.meta.dirname, '..')
const SERVER = readFileSync(join(ROOT, 'server.ts'), 'utf8').replace(/\r\n/g, '\n')

test('lane_memory_rpc rides with person_lanes on the pairing heartbeat, and nowhere else', () => {
  const base = { canInjectGoal: false, floorHook: true } as const
  const on = declaredCapabilities({ ...base, personLanes: true, authMode: 'pairing' })
  assert.ok(on.includes(PERSON_LANES_TOKEN) && on.includes(LANE_MEMORY_RPC_TOKEN))
  assert.ok(on.includes('memory_rpc'), 'the panel needs memory_rpc too')
  assert.ok(!declaredCapabilities({ ...base, personLanes: false, authMode: 'pairing' }).includes(LANE_MEMORY_RPC_TOKEN))
  assert.ok(!declaredCapabilities({ ...base, authMode: 'pairing' }).includes(LANE_MEMORY_RPC_TOKEN))
  assert.ok(!declaredCapabilities({ ...base, personLanes: true, authMode: 'apikey' }).includes(LANE_MEMORY_RPC_TOKEN))
  assert.equal(LANE_MEMORY_RPC_TOKEN, 'lane_memory_rpc')
  for (const token of on) assert.match(token, /^[a-z][a-z0-9_]{0,63}$/, 'the backend token grammar')
  assert.ok(on.length <= 32)
})

test('the owner\'s handshake declares it in auth.capabilities; nothing else in the handshake changes', () => {
  const pairing = { mode: 'pairing', pairingToken: 'pair_secret' } as never
  assert.deepEqual(wsAuthOptions(pairing, [LANE_MEMORY_RPC_TOKEN]), { query: { pairingToken: 'pair_secret' }, auth: { capabilities: ['lane_memory_rpc'] } })
  assert.deepEqual(wsAuthOptions(pairing), { query: { pairingToken: 'pair_secret' } }, 'no capability: today\'s handshake byte for byte')
  const apikey = { mode: 'apikey', apiKey: 'k', assistantId: '7' } as never
  assert.deepEqual(wsAuthOptions(apikey, [LANE_MEMORY_RPC_TOKEN]), { auth: { apiKey: 'k', assistantId: '7' } }, 'an API key socket declares nothing')
  assert.match(SERVER, /\.\.\.wsAuthOptions\(AUTH, laneSupport\(\)\.ok \? \[LANE_MEMORY_RPC_TOKEN\] : \[\]\),/)
})

test('server.ts: a person\'s stamped memory frame goes to her stopped lane\'s folder, never the owner\'s memory', () => {
  const at = SERVER.indexOf("realtimeSocket.on('memory_rpc', whenArmed('memory_rpc'")
  const handler = SERVER.slice(at, SERVER.indexOf('\n  }))', at))
  const person = handler.indexOf("if (sorted.kind === 'person')")
  const owner = handler.indexOf('memoryRpc.handle(frame)')
  assert.ok(person > 0 && owner > person, 'a person\'s frame is taken off before the owner\'s handler')
  const branch = handler.slice(person, owner)
  assert.match(branch, /answerStoppedLaneMemory\(laneFrame\)/)
  assert.match(branch, /\n\s*return\n/, 'and never falls through to the owner\'s memory')
  assert.match(handler, /if \(sorted\.kind === 'drop'\) \{[\s\S]*?return\n/)
  // The stopped lane's answer: inert until lanes are on, then the person's folder with the echo.
  const answer = SERVER.slice(SERVER.indexOf('async function answerStoppedLaneMemory'), SERVER.indexOf('function startLaneSupervisor'))
  assert.match(answer, /if \(!lanesOnForThisAgent\) \{[\s\S]*?laneMemoryAnswer\(memoryRpcFailure\('unavailable'/)
  assert.match(answer, /await stoppedLaneMemory\.handle\(frame\)/)
  assert.match(SERVER, /const stoppedLaneMemory = new LaneMemoryRpcHandler\(\{[\s\S]*?home: homedir\(\),[\s\S]*?postResult: \(rpcId, body\) => bgosPost\(`integrations\/memory-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/result`, body\)/)
})

test('server.ts: the supervisor learns the agent folder only from the launcher\'s BGOS_LAUNCH_CWD', () => {
  const start = SERVER.slice(SERVER.indexOf('function startLaneSupervisor'), SERVER.indexOf('function onLanesState'))
  assert.match(start, /const agentFolder = String\(process\.env\.BGOS_LAUNCH_CWD \?\? ''\)\.trim\(\)/)
  assert.match(start, /\.\.\.\(agentFolder \? \['--agent-folder', agentFolder\] : \[\]\)/)
  assert.doesNotMatch(start.replace(/\/\/.*$/gm, ''), /process\.cwd\(\)|[^_]LAUNCH_CWD\b/, 'never the process folder or the resolved LAUNCH_CWD')
})

test('the notices P5 and P7 add are fixed sentences, parsed only by name, no dashes', () => {
  for (const name of ['new_session', 'model_changed', 'effort_changed', 'choice_refused', 'policy_tightened']) {
    const sentence = laneNoticeSentence(name)
    assert.ok(typeof sentence === 'string' && sentence.length > 20, `${name} has its sentence`)
    assert.doesNotMatch(sentence!, /[\u2013\u2014]/)
    assert.deepEqual(parseLaneEventLine(JSON.stringify({ event: 'notice', notice: name, chatIds: [5, '6', -1, 'x'], text: 'chosen by a lane' })), { event: 'notice', notice: name, chatIds: [5, 6] })
  }
  assert.equal(parseLaneEventLine(JSON.stringify({ event: 'notice', notice: 'model_set_to', chatIds: [5] })), null)
  assert.ok(!Object.values(LANE_NOTICES).some((s) => /\{|\$/.test(String(s))), 'nothing in them is filled in')
})

test('hoai-lane models keeps the owner\'s list: valid model names and effort levels only', () => {
  const home = mkdtempSync(join(tmpdir(), 'lane-models-'))
  try {
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'bin', 'hoai-lane.mjs'), 'models', '--assistant', '1076', ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } })
    assert.match(cli().stdout, /\(none: the agent's own only\)/)
    assert.equal(cli('--set', 'sonnet,opus[1m]', '--efforts', 'low,high').status, 0)
    const file = JSON.parse(readFileSync(join(home, '.bgos-agent', '1076', 'people', 'lane-models.json'), 'utf8'))
    assert.deepEqual({ models: file.models, efforts: file.efforts }, { models: ['sonnet', 'opus[1m]'], efforts: ['low', 'high'] })
    assert.equal(cli('--set', 'sonnet;rm -rf ~').status, 1)
    assert.equal(cli('--efforts', 'warp').status, 1)
    assert.equal(cli('--clear').status, 0)
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.bgos-agent', '1076', 'people', 'lane-models.json'), 'utf8')).models, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
