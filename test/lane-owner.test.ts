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
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { lanePaths, laneDaemonEnv, LANE_NOTICES, laneEventLine, laneNoticeSentence, parseLaneEventLine } from '../lib/lane-core.mjs'
import * as laneOwner from '../lib/lane-owner.ts'
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
    assert.deepEqual(posts, [[777, LANE_NOTICES.login_token_missing]])
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
  assert.deepEqual(parseLaneEventLine(JSON.stringify({ event: 'notice', notice: 'login_token_failed', text: 'evil', chatIds: [9, 9, '10', 0, -3, 2.5, 'x', 11, 12, 13, 14] })), { event: 'notice', notice: 'login_token_failed', chatIds: [9, 11, 12, 13, 14] })
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

test('a refused shell launch tells the owner and the person with fixed text', async () => {
  const r = rig()
  try {
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice: 'shell_refused', chatIds: [777] }))
    const owners: string[] = []
    const people: Array<[number, string]> = []
    await drainLaneEvents(r.deps, {
      report: async () => {},
      notify: async (id: number, sentence: string) => { people.push([id, sentence]) },
      notifyOwner: async (sentence: string) => { owners.push(sentence) },
    } as never)
    assert.deepEqual(people, [[777, LANE_NOTICES.shell_refused]])
    assert.equal(owners.length, 1)
    assert.equal(owners[0], 'Running commands is not available for people you share with yet.')
  } finally { r.cleanup() }
})

test('notice sinks are independent', async () => {
  const r = rig()
  try {
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice: 'shell_refused', chatIds: [777, 778] }))
    const attempts: number[] = []
    await drainLaneEvents(r.deps, {
      report: async () => {},
      notifyOwner: async () => { throw new Error('fixture unavailable') },
      notify: async (id) => { attempts.push(id); if (id === 777) throw new Error('fixture unavailable') },
    })
    assert.deepEqual(attempts, [777, 778])
  } finally { r.cleanup() }
})

test('server.ts wires the owner notice sink to a confirmed main chat', () => {
  const start = SERVER.indexOf('async function drainLaneEventsOnce')
  const drain = SERVER.slice(start, SERVER.indexOf('// AN AGENT DELETED', start))
  assert.match(drain, /notifyOwner: async \(sentence\) =>/)
  assert.match(drain, /chatOwnership\.ownerChats\(\)\.find\(\(id\) => mainChatIds\.includes\(id\) && chatOwnership\.isOwners\(id\)\)/)
  assert.match(drain, /if \(chatId === null\) \{ log\(sentence\); return \}/)
  const sink = drain.slice(drain.indexOf('notifyOwner:'), drain.indexOf('report:'))
  assert.match(sink, /await bgosPost\('send-message',/)
  assert.match(sink, /chatId: Number\(chatId\).*text: sentence/)
})

test('notice mode records its outcome without a session', () => {
  const r = rig()
  try {
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.workDir, { recursive: true })
    mkdirSync(paths.stateDir, { recursive: true })
    const child = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'bgos-launch.mjs'), join(import.meta.dirname, '..', 'lane-server.ts')], {
      cwd: paths.workDir,
      env: {
        HOME: r.home, PATH: process.env.PATH,
        ...laneDaemonEnv({ assistantId: '1076', userId: 'user_ana', workDir: paths.workDir, laneDir: paths.laneDir, stateDir: paths.stateDir, backendUrl: 'http://127.0.0.1:9', loginMode: 'own_token' }),
        HOAI_LANE_NOTICE: 'shell_refused',
      },
      encoding: 'utf8', timeout: 15_000,
    })
    assert.equal(child.status, 2, child.stderr)
    const events = readFileSync(paths.eventsPath, 'utf8').trim().split('\n').map((line) => { const e = parseLaneEventLine(line)!; return { event: e.event, notice: e.notice, chatIds: e.chatIds } })
    assert.deepEqual(events, [{ event: 'notice', notice: 'shell_refused', chatIds: [] }])
  } finally { r.cleanup() }
})


test('the next owner check retires unmarked supervisors, including locked launches, once', async () => {
  const r = rig()
  const people: string[] = []
  try {
    for (const [userId, launch] of Object.entries({
      user_bash: { tools: ['Read', 'Bash'], policy: { v: 1, shell: true } },
      user_mcp: { tools: ['Read'], ownerServers: ['runner'], policy: { v: 1, ownerMcpServers: true } },
      user_locked: { tools: ['Read'], policy: { v: 1 } },
      user_current: { supervisorVersion: 2, tools: ['Read'], policy: { v: 1 } },
      user_dead: { tools: ['Bash'], policy: { v: 1, shell: true } },
    })) {
      const paths = lanePaths({ home: r.home, assistantId: '1076', userId })
      mkdirSync(paths.laneDir, { recursive: true })
      writeFileSync(paths.launchPolicyPath, JSON.stringify({ ...launch, at: 'made-up-start' }))
      writeFileSync(paths.laneJsonPath, JSON.stringify({ inFlight: true, lastActivityAtMs: Date.now() }))
    }
    const deps = { ...r.deps, isSupervised: (p: string) => p.includes('user_dead') ? null : 4242 }
    assert.equal(typeof laneOwner.sweepUnsafePersonLanes, 'function')
    assert.equal(laneOwner.sweepUnsafePersonLanes(deps), 3)
    for (const userId of ['user_bash', 'user_mcp', 'user_locked']) {
      const paths = lanePaths({ home: r.home, assistantId: '1076', userId })
      assert.equal(JSON.parse(readFileSync(paths.stopRequestPath, 'utf8')).reason, 'sharing_update')
    }
    assert.equal(existsSync(lanePaths({ home: r.home, assistantId: '1076', userId: 'user_current' }).stopRequestPath), false, 'a marked locked launch stays running')
    assert.equal(existsSync(lanePaths({ home: r.home, assistantId: '1076', userId: 'user_dead' }).stopRequestPath), false)
    assert.equal(laneOwner.sweepUnsafePersonLanes(deps), 3, 'the stop stays requested until the old supervisor ends')
    const sinks = { report: async () => {}, notify: async () => {}, notifyPerson: async (id: string, sentence: string) => { people.push(`${id}:${sentence}`) } }
    await drainLaneEvents(r.deps, sinks)
    await drainLaneEvents(r.deps, sinks)
    assert.deepEqual(people.sort(), ['user_bash', 'user_locked', 'user_mcp'].map((id) => `${id}:I stopped our conversation to apply updated sharing permissions. Please send your message again.`))
  } finally { r.cleanup() }
})

test('the owner checks legacy launches immediately and on every event drain, with a verified person chat sink', () => {
  const state = SERVER.slice(SERVER.indexOf('async function onLanesState'), SERVER.indexOf('let laneDrainBusy'))
  assert.match(state, /await drainLaneEventsOnce\(\)/)
  const drain = SERVER.slice(SERVER.indexOf('async function drainLaneEventsOnce'), SERVER.indexOf('// AN AGENT DELETED'))
  assert.ok(drain.indexOf('sweepUnsafePersonLanes(LANE_OWNER_DEPS)') < drain.indexOf('await drainLaneEvents('))
  assert.match(drain, /notifyPerson: async \(userId, sentence\) =>/)
  assert.match(drain, /bgosPeerGet\('peers\/inbox'\)/)
  assert.match(drain, /String\(c\.userId \?\? c\.user_id\) === userId/)
  assert.match(drain, /String\(c\.assistantId\) === String\(ASSISTANT_ID\)/)
  assert.match(drain, /c\.kind === 'main'/)
})

test('an update notice survives a temporary backend failure and is delivered once', async () => {
  const r = rig()
  try {
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice: 'sharing_update' }))
    let attempts = 0
    const delivered: string[] = []
    const sinks = { report: async () => {}, notify: async () => {}, notifyPerson: async (_id: string, sentence: string) => {
      if (++attempts === 1) throw new Error('made-up temporary outage')
      delivered.push(sentence)
    } }
    await drainLaneEvents(r.deps, sinks)
    await drainLaneEvents(r.deps, sinks)
    await drainLaneEvents(r.deps, sinks)
    assert.equal(attempts, 2)
    assert.deepEqual(delivered, ['I stopped our conversation to apply updated sharing permissions. Please send your message again.'])
  } finally { r.cleanup() }
})

test('legacy lane checks start on both owner lock acquisition paths without waiting for the backend', () => {
  const acquisitions = [...SERVER.matchAll(/lockHeld = true\n/g)]
  assert.equal(acquisitions.length, 2)
  for (const acquisition of acquisitions) {
    const startup = SERVER.slice(acquisition.index!, acquisition.index! + 500)
    const check = startup.indexOf('startLaneChecks()')
    assert.ok(check > startup.indexOf('armIdleUpdate()'))
    assert.doesNotMatch(startup.slice(0, check), /await /, 'checks start before any backend wait')
  }
  const checks = SERVER.slice(SERVER.indexOf('function startLaneChecks()'), SERVER.indexOf('let laneDrainBusy'))
  assert.match(checks, /if \(!laneDrainTimer\)/)
  assert.match(checks, /setInterval\(\(\) => void drainLaneEventsOnce\(\), LANE_DRAIN_MS\)/)
  assert.match(checks, /void drainLaneEventsOnce\(\)/)
  assert.doesNotMatch(checks, /lanesOnForThisAgent|laneSupport|bgosGet/)
})

for (const notice of ['shell_refused', 'owner_mcp_refused']) {
  test(`a failed ${notice} delivery stays pending and retries only unfinished recipients`, async () => {
    const r = rig()
    try {
      const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
      mkdirSync(paths.laneDir, { recursive: true })
      writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice, noticeId: 'fixture-grant', chatIds: [777, 778] }))
      let ownerAttempts = 0
      const attempts: number[] = []
      const delivered: number[] = []
      const sinks = {
        report: async () => {},
        notifyOwner: async () => { ownerAttempts += 1 },
        notify: async (id: number) => {
          attempts.push(id)
          if (attempts.length === 1) throw new Error('made-up temporary outage')
          delivered.push(id)
        },
      }
      assert.equal(await drainLaneEvents(r.deps, sinks), 0, 'failed delivery is not handled')
      assert.equal(await drainLaneEvents(r.deps, sinks), 1)
      assert.equal(await drainLaneEvents(r.deps, sinks), 0)
      assert.deepEqual(attempts, [777, 778, 777])
      assert.deepEqual(delivered.sort(), [777, 778], 'each person chat receives exactly one notice')
      assert.equal(ownerAttempts, 1, 'a successful owner send is not repeated')
      const receipts = JSON.parse(readFileSync(join(paths.laneDir, 'notice-delivery.json'), 'utf8'))
      assert.deepEqual(Object.keys(receipts), [notice])
      assert.deepEqual(receipts[notice], { ownerDelivered: true, personDelivered: false, chatIds: [778, 777] })
    } finally { r.cleanup() }
  })
}

test('a failed owner refusal send retries without repeating the successful person send', async () => {
  const r = rig()
  try {
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice: 'owner_mcp_refused', noticeId: 'owner-retry', chatIds: [777] }))
    let ownerAttempts = 0
    const delivered: number[] = []
    const sinks = {
      report: async () => {},
      notifyOwner: async () => { if (++ownerAttempts === 1) throw new Error('made-up temporary outage') },
      notify: async (id: number) => { delivered.push(id) },
    }
    assert.equal(await drainLaneEvents(r.deps, sinks), 0)
    assert.equal(await drainLaneEvents(r.deps, sinks), 1)
    assert.equal(await drainLaneEvents(r.deps, sinks), 0)
    assert.equal(ownerAttempts, 2)
    assert.deepEqual(delivered, [777])
  } finally { r.cleanup() }
})

test('a refusal without known chats waits for the person sink and delivers once', async () => {
  const r = rig()
  try {
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    const event = laneEventLine({ event: 'notice', notice: 'shell_refused', noticeId: 'no-chats', chatIds: [] })
    writeFileSync(paths.eventsPath, event)
    let attempts = 0
    const delivered: string[] = []
    const sinks = { report: async () => {}, notify: async () => { assert.fail('no claimed chat') }, notifyPerson: async (id: string) => {
      if (++attempts === 1) throw new Error('made-up temporary outage')
      delivered.push(id)
    } }
    assert.equal(await drainLaneEvents(r.deps, sinks), 0)
    assert.equal(await drainLaneEvents(r.deps, sinks), 1)
    // Another copy of the same generated event must use the delivery receipt.
    writeFileSync(paths.eventsPath, event)
    await drainLaneEvents(r.deps, sinks)
    assert.equal(attempts, 2)
    assert.deepEqual(delivered, ['user_ana'])
  } finally { r.cleanup() }
})

test('an old refusal event without an id keeps its identity while retrying', async () => {
  const r = rig()
  try {
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice: 'owner_mcp_refused', chatIds: [777] }))
    let attempts = 0
    const sinks = { report: async () => {}, notify: async () => { if (++attempts === 1) throw new Error('made-up temporary outage') } }
    assert.equal(await drainLaneEvents(r.deps, sinks), 0)
    const pending = parseLaneEventLine(readFileSync(paths.eventsPath, 'utf8'))!
    assert.equal(pending.notice, 'owner_mcp_refused')
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths.eventsPath, 'utf8')), 'noticeId'), false)
    assert.equal(await drainLaneEvents(r.deps, sinks), 1)
    assert.equal(await drainLaneEvents(r.deps, sinks), 0)
    assert.equal(attempts, 2)
  } finally { r.cleanup() }
})

for (const notice of ['shell_refused', 'owner_mcp_refused']) {
  test(`laneenv9: an old ${notice} event beside a saved true sends once`, async () => {
    const r = rig()
    try {
      const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
      mkdirSync(paths.laneDir, { recursive: true })
      writeFileSync(join(paths.laneDir, 'refused-grants.json'), JSON.stringify({ [notice]: true }))
      const event = laneEventLine({ event: 'notice', notice, chatIds: [777] })
      let owners = 0
      const chats: number[] = []
      const sinks = { report: async () => {}, notifyOwner: async () => { owners++ }, notify: async (id: number) => { chats.push(id) } }
      for (let copy = 0; copy < 2; copy++) {
        writeFileSync(paths.eventsPath, event)
        assert.equal(await drainLaneEvents(r.deps, sinks), 1)
      }
      assert.equal(owners, 1)
      assert.deepEqual(chats, [777])
    } finally { r.cleanup() }
  })

  test(`laneenv9: a second chat added after ${notice} finished gets it once`, async () => {
    const r = rig()
    try {
      const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
      mkdirSync(paths.laneDir, { recursive: true })
      let owners = 0
      const chats: number[] = []
      const sinks = { report: async () => {}, notifyOwner: async () => { owners++ }, notify: async (id: number) => { chats.push(id) } }
      for (const chatIds of [[777], [777, 778], [777, 778]]) {
        writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice, noticeId: 'old-id', chatIds }))
        await drainLaneEvents(r.deps, sinks)
      }
      assert.equal(owners, 1)
      assert.deepEqual(chats, [777, 778])
    } finally { r.cleanup() }
  })

  for (const bad of [
    { delivered: 'false', ownerDelivered: false, personDelivered: false, chatIds: [] },
    { delivered: false, ownerDelivered: 'false', personDelivered: 'false', chatIds: ['777', null, true, -1, 1.5] },
    { delivered: false, ownerDelivered: 1, personDelivered: 1, chatIds: [] },
  ]) {
    test(`laneenv9: malformed ${notice} receipt sends rather than drops ${JSON.stringify(bad)}`, async () => {
      const r = rig()
      try {
        const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
        mkdirSync(paths.laneDir, { recursive: true })
        writeFileSync(join(paths.laneDir, 'notice-delivery.json'), JSON.stringify({ [notice]: { notice, ...bad }, 'old-id': { notice, ...bad } }))
        let owners = 0, people = 0
        const chats: number[] = []
        const sinks = { report: async () => {}, notifyOwner: async () => { owners++ }, notifyPerson: async () => { people++ }, notify: async (id: number) => { chats.push(id) } }
        for (const chatIds of [[777], [], [777], []]) {
          writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice, noticeId: 'old-id', chatIds }))
          await drainLaneEvents(r.deps, sinks)
        }
        assert.equal(owners, 1)
        assert.equal(people, 1)
        assert.deepEqual(chats, [777])
        const receipts = JSON.parse(readFileSync(join(paths.laneDir, 'notice-delivery.json'), 'utf8'))
        assert.deepEqual(Object.keys(receipts), [notice])
        assert.deepEqual(receipts[notice].chatIds, [777])
      } finally { r.cleanup() }
    })
  }
}

test('old id receipts merge by refusal kind and preserve only proven recipients', async () => {
  const r = rig()
  try {
    const paths = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    mkdirSync(paths.laneDir, { recursive: true })
    const old = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`old-${n}`, { notice: 'shell_refused', ownerDelivered: true, chatIds: [777], delivered: true }]))
    writeFileSync(join(paths.laneDir, 'notice-delivery.json'), JSON.stringify({ ...old, other: { notice: 'owner_mcp_refused', personDelivered: true, chatIds: [] }, junk: { notice: 'unknown', delivered: true } }))
    const chats: number[] = []
    const sinks = { report: async () => {}, notifyOwner: async () => { assert.fail('owner already heard this refusal') }, notify: async (id: number) => { chats.push(id) } }
    for (const noticeId of [undefined, 'different-old-id']) {
      writeFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice: 'shell_refused', noticeId, chatIds: [777, 778] }))
      await drainLaneEvents(r.deps, sinks)
    }
    assert.deepEqual(chats, [778])
    const receipts = JSON.parse(readFileSync(join(paths.laneDir, 'notice-delivery.json'), 'utf8'))
    assert.deepEqual(Object.keys(receipts).sort(), ['owner_mcp_refused', 'shell_refused'])
    assert.equal(receipts.owner_mcp_refused.personDelivered, true)
    assert.deepEqual(receipts.shell_refused.chatIds, [777, 778])
  } finally { r.cleanup() }
})

test('event chat ids must be real positive numbers', () => {
  assert.deepEqual(parseLaneEventLine(JSON.stringify({ event: 'notice', notice: 'shell_refused', noticeId: 'ignored-old-id', chatIds: ['777', true, null, {}, 777, 777, 0, -1, 1.5] })), { event: 'notice', notice: 'shell_refused', chatIds: [777] })
})
