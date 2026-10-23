/**
 * Source guard: doctor_rpc is wired into server.ts (BGOS board row 01a16795).
 * The changes-wiring.test.ts pattern.
 *
 * THE BUG THIS GUARDS. The BGOS backend sends the owner's check up as a
 * `doctor_rpc` frame to the pairing room and waits 10 s for an ack. Up to
 * 0.74.0 server.ts registered no `doctor_rpc` listener at all, so the frame
 * reached a connected, healthy daemon and was dropped on the floor: every
 * check up of every Claude Code agent read "the agent host did not respond".
 * lib/doctor-rpc.ts is tested on its own; what it cannot see is whether
 * server.ts ever hands it a frame, and where its answers go.
 *
 * 1. The registration, through whenArmed (only the lock holder answers).
 * 2. The lane: ack and result on integrations/doctor-rpc/:rpcId/{ack,result}.
 *    A copy of the changes block posting to changes-rpc would be dropped by
 *    the backend as unknown and the owner would see the same silence.
 * 3. The checks come from the daemon's own state: the login and usage watchers
 *    the heartbeat already reads, and the running version.
 * 4. Unlike the neighbouring lanes, a draining daemon STILL answers: the check
 *    up is read only, and "an update is being applied" is exactly what the
 *    owner should be told instead of silence.
 * 5. doctor_rpc is declared, so the backend can tell a connector that answers
 *    from one that predates the lane.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { declaredCapabilities } from '../lib/declared-capabilities.ts'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const REGISTRATION = "realtimeSocket.on('doctor_rpc', whenArmed('doctor_rpc',"

function handlerSlice(): string {
  const at = server.indexOf(REGISTRATION)
  assert.ok(at > 0, 'doctor_rpc is not registered on the realtime socket: the check up is never answered')
  const next = server.indexOf('realtimeSocket.on(', at + REGISTRATION.length)
  return server.slice(at, next > at ? next : at + 1200)
}

function constructionSlice(): string {
  const at = server.indexOf('new DoctorRpcHandler(')
  assert.ok(at > 0, 'server.ts never constructs a DoctorRpcHandler')
  const end = server.indexOf('\n})\n', at)
  assert.ok(end > at, 'the DoctorRpcHandler construction is not closed at the top level')
  return server.slice(at, end)
}

test('doctor_rpc is registered through the stand-down gate', () => {
  handlerSlice()
})

test('the handler answers on the doctor lane and nowhere else', () => {
  const built = constructionSlice()
  assert.match(built, /bgosPost\(`integrations\/doctor-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/ack`/)
  assert.match(built, /bgosPost\(\s*`integrations\/doctor-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/result`/)
  assert.doesNotMatch(built, /memory-rpc|changes-rpc|skills-rpc|voice-rpc/)
  const handler = handlerSlice()
  assert.ok(handler.includes('normalizeDoctorRpc('), 'the frame is normalised before it is handled')
  assert.ok(
    handler.includes('trackMessageOperation(() => doctorRpc.handle(frame))'),
    'the frame is handed to the handler as a tracked operation',
  )
})

test('the checks read the daemon state the heartbeat already reports', () => {
  const built = constructionSlice()
  assert.ok(built.includes('buildDoctorChecks('), 'the rows are built by the tested pure builder')
  assert.match(built, /login: claudeLoginState,/, 'the login watcher state')
  assert.match(built, /resting: observedResting,/, 'the usage cap episode')
  assert.match(built, /runningVersion: RUNNING_VERSION,/)
  assert.match(built, /pendingRestartVersion: daemonPendingRestartVersion\(\),/)
  assert.match(built, /updateDraining: updateDrainMode,/)
  assert.match(built, /\n\s*homeConfirmed: HOME_CONFIRMED,\n/)
  assert.ok(!/spawn|execFile|exec\(/.test(built), 'no child process runs inside the daemon for a check up')
})

test('a draining daemon still answers the check up (read only, and the drain is the answer)', () => {
  assert.doesNotMatch(handlerSlice(), /updateDrainMode\) return/)
})

test('doctor_rpc is declared on every host and every connection', () => {
  for (const canInjectGoal of [true, false]) {
    for (const authMode of ['pairing', 'apikey'] as const) {
      assert.ok(
        declaredCapabilities({ canInjectGoal, floorHook: false, authMode }).includes('doctor_rpc'),
        `declared with canInjectGoal=${canInjectGoal} authMode=${authMode}`,
      )
    }
  }
})
