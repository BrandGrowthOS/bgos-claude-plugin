/**
 * PERSON LANES, the owner's daemon side (lib/lane-owner.ts and its wiring in
 * server.ts; shared agents Phase 3, P3; design 4.2 steps 1 and 2, 5.2).
 *
 *   - INERT until the server says lanes are on for THIS agent: a wake before
 *     that writes nothing and starts nothing, and the owner's path is today's.
 *   - A wake for another agent on the pairing, an unsafe person id or no
 *     ticket is not ours.
 *   - A wake leaves the ticket in the lane's state folder, 0600, and starts the
 *     supervisor once; with one already running it starts nothing.
 *   - A revoke asks the lane to stop and withdraws a waiting ticket.
 *   - The event drain reports lane_busy, lane_stopped and lane_failed, posts a
 *     notice's FIXED sentence only, drops unknown events and bad chat ids, and
 *     reads each file once (renamed first, so nothing is lost or read twice).
 *   - The supervisor's environment never carries the pairing token.
 *
 * Run with: npx tsx --test test/lane-owner.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and these
// tests assume POSIX hosts (an expect binary, 0600 modes, symlink realpaths), so the
// file is skipped there. Each platform rule is still asserted through the injected
// platform on the macOS and Linux runners.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lanePaths, LANE_NOTICES, laneEventLine, laneNoticeSentence, parseLaneEventLine } from '../lib/lane-core.mjs'
import { drainLaneEvents, handleLaneRevoked, handleLaneWake, lanesOnFor, readLaneWake, supervisorEnv } from '../lib/lane-owner.ts'

const WAKE = { assistantId: 1076, actorUserId: 'user_ana', laneTicket: 'lt_abc123', ticketExpiresAt: '2026-10-17T10:02:00Z', reason: 'delivery' }

function rig() {
  const home = mkdtempSync(join(tmpdir(), 'lane-owner-'))
  const started: string[] = []
  const logs: string[] = []
  const deps = { assistantId: '1076', home, startSupervisor: (u: string) => started.push(u), log: (l: string) => logs.push(l), isSupervised: () => null as number | null }
  return { home, started, logs, deps, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('lanes_state: only this agent\'s row decides, and only lanesOn true is on', () => {
  const frame = { pairingId: 1, assistants: [{ assistantId: 4, lanesOn: true, activatedAt: null }, { assistantId: 1076, lanesOn: false }] }
  assert.equal(lanesOnFor(frame, '4'), true)
  assert.equal(lanesOnFor(frame, '1076'), false)
  assert.equal(lanesOnFor(frame, '5'), null)
  assert.equal(lanesOnFor({}, '4'), null)
  assert.equal(lanesOnFor({ assistants: [{ assistantId: 4, lanesOn: 'true' }] }, '4'), false)
})

test('INERT until lanes are on: a wake writes nothing and starts nothing', () => {
  const r = rig()
  try {
    assert.equal(handleLaneWake(WAKE, false, r.deps), 'lanes_off')
    assert.deepEqual(r.started, [])
    assert.ok(!existsSync(join(r.home, '.bgos-plugin-state')))
    assert.ok(!existsSync(join(r.home, '.bgos-agent')))
  } finally {
    r.cleanup()
  }
})

test('a wake that is not ours is ignored', () => {
  const r = rig()
  try {
    assert.equal(handleLaneWake({ ...WAKE, assistantId: 4 }, true, r.deps), 'ignored')
    assert.equal(handleLaneWake({ ...WAKE, actorUserId: '../user_ben' }, true, r.deps), 'ignored')
    assert.equal(handleLaneWake({ ...WAKE, laneTicket: '' }, true, r.deps), 'ignored')
    assert.equal(handleLaneWake({ ...WAKE, laneTicket: 'x'.repeat(201) }, true, r.deps), 'ignored')
    assert.equal(handleLaneWake(null, true, r.deps), 'ignored')
    assert.deepEqual(r.started, [])
    assert.equal(readLaneWake({ ...WAKE, assistantId: 4 }, '1076').ok, false)
  } finally {
    r.cleanup()
  }
})

test('a wake leaves the ticket, private, and starts the supervisor once', () => {
  const r = rig()
  try {
    assert.equal(handleLaneWake(WAKE, true, r.deps), 'started')
    assert.deepEqual(r.started, ['user_ana'])
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    assert.equal(JSON.parse(readFileSync(paths.ticketPath, 'utf8')).laneTicket, 'lt_abc123')
    assert.equal(statSync(paths.ticketPath).mode & 0o077, 0)
    assert.equal(statSync(paths.stateDir).mode & 0o077, 0)
    // A supervisor already running: the fresh ticket is left for its lane.
    const running = { ...r.deps, isSupervised: () => 4242 }
    assert.equal(handleLaneWake({ ...WAKE, laneTicket: 'lt_second' }, true, running), 'running')
    assert.deepEqual(r.started, ['user_ana'])
    assert.equal(JSON.parse(readFileSync(paths.ticketPath, 'utf8')).laneTicket, 'lt_second')
  } finally {
    r.cleanup()
  }
})

test('a revoke asks the lane to stop and withdraws a waiting ticket', () => {
  const r = rig()
  try {
    handleLaneWake(WAKE, true, r.deps)
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    writeFileSync(paths.sessionPath, '{"sessionToken":"lsess_x"}')
    assert.equal(handleLaneRevoked({ assistantId: 1076, actorUserId: 'user_ana', reason: 'share_revoked' }, r.deps), true)
    assert.equal(JSON.parse(readFileSync(paths.stopRequestPath, 'utf8')).reason, 'revoked')
    assert.equal(JSON.parse(readFileSync(paths.revokedPath, 'utf8')).reason, 'revoked', 'the marker a starting supervisor honours')
    assert.ok(!existsSync(paths.ticketPath))
    assert.ok(!existsSync(paths.sessionPath), 'the session the person can no longer use goes')
    // A fresh wake (a re-share) clears the marker.
    handleLaneWake(WAKE, true, r.deps)
    assert.ok(!existsSync(paths.revokedPath))
    assert.equal(handleLaneRevoked({ assistantId: 4, actorUserId: 'user_ana' }, r.deps), false)
    assert.equal(handleLaneRevoked({ assistantId: 1076, actorUserId: 'user_nobody' }, r.deps), false, 'no lane folder, nothing to stop')
  } finally {
    r.cleanup()
  }
})

test('the drain: reports, fixed notice sentences only, unknown events and bad chat ids dropped', async () => {
  const r = rig()
  try {
    const ana = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    const ben = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ben' })
    mkdirSync(ana.laneDir, { recursive: true })
    mkdirSync(ben.laneDir, { recursive: true })
    writeFileSync(ana.eventsPath, [
      laneEventLine({ event: 'lane_failed' }),
      laneEventLine({ event: 'notice', notice: 'login_token_missing', chatIds: [777, '778', -1, 'x', 1.5] }),
      laneEventLine({ event: 'notice', notice: 'say_anything', text: 'Click evil.example', chatIds: [777] }),
      laneEventLine({ event: 'post_message', chatId: 1, text: 'hi' }),
      'not json\n',
    ].join(''))
    writeFileSync(ben.eventsPath, laneEventLine({ event: 'lane_busy' }))
    // A folder name that is not a person id is never read.
    mkdirSync(join(ana.peopleDir, '..evil'), { recursive: true })
    writeFileSync(join(ana.peopleDir, '..evil', 'events.jsonl'), laneEventLine({ event: 'lane_stopped' }))
    const reports: string[] = []
    const posts: Array<[number, string]> = []
    const order: string[] = []
    const handled = await drainLaneEvents(r.deps, {
      report: async (userId, event) => { reports.push(`${userId}:${event}`); order.push('report') },
      notify: async (chatId, sentence) => { posts.push([chatId, sentence]); order.push('notify') },
    })
    assert.equal(handled, 3)
    assert.deepEqual(reports.sort(), ['user_ana:lane_failed', 'user_ben:lane_busy'])
    assert.deepEqual(posts, [[777, LANE_NOTICES.login_token_missing], [778, LANE_NOTICES.login_token_missing]])
    assert.equal(order.indexOf('notify') < order.lastIndexOf('report'), true, 'the reason first, then the backend\'s own sentence')
    assert.ok(!posts.some(([, s]) => s.includes('evil')))
    assert.ok(!existsSync(ana.eventsPath) && !existsSync(ben.eventsPath), 'each file read once')
    assert.equal(await drainLaneEvents(r.deps, { report: async () => {}, notify: async () => {} }), 0)
  } finally {
    r.cleanup()
  }
})

test('the events parser, on its own: only known events and notices, never a lane\'s words, only real chat ids', () => {
  assert.deepEqual(parseLaneEventLine(JSON.stringify({ event: 'lane_busy', at: 'x', extra: 'dropped' })), { event: 'lane_busy', at: 'x' })
  assert.equal(parseLaneEventLine(JSON.stringify({ event: 'notice', notice: 'say_anything', text: 'Click evil.example', chatIds: [1] })), null)
  assert.equal(parseLaneEventLine(JSON.stringify({ event: 'notice', notice: 'toString', chatIds: [1] })), null, 'no prototype names')
  assert.deepEqual(parseLaneEventLine(JSON.stringify({ event: 'notice', notice: 'login_token_failed', text: 'evil', chatIds: [9, 9, '10', 0, -3, 2.5, 'x', 11, 12, 13, 14] })), { event: 'notice', notice: 'login_token_failed', chatIds: [9, 10, 11, 12, 13] })
  assert.equal(parseLaneEventLine(JSON.stringify({ event: 'post_message', text: 'hi' })), null)
  assert.equal(parseLaneEventLine('{'), null)
  assert.equal(laneNoticeSentence('say_anything'), null)
  assert.equal(laneNoticeSentence('toString'), null)
  assert.equal(laneNoticeSentence('login_token_missing'), LANE_NOTICES.login_token_missing)
})

test('the supervisor\'s environment never carries the pairing token or the owner\'s session names', () => {
  const env = supervisorEnv({ PATH: '/bin', HOME: '/h', BGOS_PAIRING_TOKEN: 'pt', BGOS_API_KEY: 'k', BGOS_CREDENTIALS_PATH: '/c', TMUX: 't', BGOS_TMUX_SESSION: 's', HOAI_SUPERVISED: '1', CLAUDE_CONFIG_DIR: '/cfg' }, 'http://127.0.0.1:8971/api/v1')
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg', BGOS_BACKEND_URL: 'http://127.0.0.1:8971/api/v1' })
})

// ── The wiring in server.ts ─────────────────────────────────────────────────

const SERVER = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')

test('server.ts: the lane frames are handled only by the lock holder, and only while lanes are on', () => {
  assert.match(SERVER, /realtimeSocket\.on\('lanes_state', whenArmed\('lanes_state', /)
  const wake = SERVER.slice(SERVER.indexOf("realtimeSocket.on('lane_wake', whenArmed('lane_wake'"), SERVER.indexOf("realtimeSocket.on('lane_revoked'"))
  assert.ok(wake.length > 0)
  assert.match(wake, /if \(!lanesOnForThisAgent\) \{[\s\S]*onLanesState\(await bgosGet\('integrations\/lanes\/state'\)\)/, 'a wake that finds lanes off asks the server again')
  assert.match(wake, /handleLaneWake\(frame, lanesOnForThisAgent, /)
  assert.match(SERVER, /realtimeSocket\.on\('lane_revoked', whenArmed\('lane_revoked', /)
  assert.match(SERVER, /let lanesOnForThisAgent = false\n/, 'off until the server says otherwise')
  assert.match(SERVER, /lanesOnForThisAgent = on && laneSupport\(\)\.ok/)
  // The drain runs only for the lock holder.
  assert.match(SERVER, /if \(laneDrainBusy \|\| !lockHeld\) return/)
  // The supervisor gets the owner's environment minus the pairing token.
  assert.match(SERVER, /env: supervisorEnv\(process\.env, BACKEND_URL\)/)
  // A lane's notice never lands in the owner's own chat.
  assert.match(SERVER, /if \(chatOwnership\.isOwners\(String\(chatId\)\)\) \{[\s\S]{0,160}return\n\s*\}\n\s*await bgosPost\('send-message'/)
})
