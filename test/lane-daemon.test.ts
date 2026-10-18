/**
 * PERSON LANES, the lane daemon (lane-server.ts and lib/lane-daemon.ts;
 * shared agents Phase 3, P3; design 4.2 step 5, 5.2, 7.2 item 7).
 *
 *   - Its environment must name exactly THIS lane's folders, or it refuses
 *     to start (a forged environment cannot point it at another lane).
 *   - It never holds the pairing token: the source never reads the
 *     credentials file, never builds a pairing header, never takes the
 *     agent's lock, and presents its lane session ALONE on the socket.
 *   - It declares no permission relay and never approves anything.
 *   - PATH CONFINEMENT: every path `reply` is handed resolves through
 *     realpath inside the working folder; outside, `..` climbs and a symlink
 *     that lands outside are all refused, and so is a chat it was never
 *     handed a turn in.
 *   - The channel event is the shared builder plus the lane stamp, and EVERY
 *     meta value is a string (the wake card contract), sparse or full.
 *   - The inbox: a relaunch re-offers a turn that was handed over and not
 *     answered, never one that was answered, never one twice.
 *   - The mint answer and `lanes/me` must name exactly this lane.
 *
 * Run with: npx tsx --test test/lane-daemon.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and these
// tests assume POSIX hosts (an expect binary, 0600 modes, symlink realpaths), so the
// file is skipped there. Each platform rule is still asserted through the injected
// platform on the macOS and Linux runners.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { confineLanePath, laneDaemonEnv, lanePaths } from '../lib/lane-core.mjs'
import {
  buildLaneChannelEvent,
  checkLaneReply,
  debugLogSaysTokenRefused,
  inboxAdvanceCursor,
  inboxForNewConversation,
  inboxNoteDelivered,
  inboxNoteReplied,
  inboxPollFrom,
  inboxShouldDeliver,
  LaneDeliveryClaims,
  laneHistoryDeliveryState,
  laneHistoryPathFor,
  laneInstructions,
  laneMeMatches,
  LANE_SERVER_ACKNOWLEDGED,
  LANE_TOOLS,
  normaliseLaneDelivery,
  readLaneDaemonConfig,
  readLaneInbox,
  readMintAnswer,
  readTicketFile,
  scrubLaneDaemonEnv,
  selectLaneBacklog,
  storedSessionUsable,
} from '../lib/lane-daemon.ts'

const ROOT = join(import.meta.dirname, '..')
const LANE = { userId: 'user_ana', assistantId: '1076' }

function laneEnv(home: string, overrides: Record<string, string> = {}) {
  const p = lanePaths({ home, assistantId: '1076', userId: 'user_ana' })
  return {
    ...laneDaemonEnv({ assistantId: '1076', userId: 'user_ana', workDir: p.workDir, laneDir: p.laneDir, stateDir: p.stateDir, backendUrl: 'http://127.0.0.1:8971/api/v1', loginMode: 'inherit' }),
    ...overrides,
  }
}

test('the daemon refuses an environment that does not name exactly this lane', () => {
  const ok = readLaneDaemonConfig(laneEnv('/Users/o'), '/Users/o', 'darwin')
  assert.ok(ok.ok)
  if (ok.ok) {
    assert.equal(ok.config.apiBase, 'http://127.0.0.1:8971/api/v1')
    assert.equal(ok.config.backendUrl, 'http://127.0.0.1:8971')
    assert.equal(ok.config.notice, null)
  }
  const ben = lanePaths({ home: '/Users/o', assistantId: '1076', userId: 'user_ben' })
  const bads: Array<Record<string, string>> = [
    { BGOS_LAUNCH_CWD: ben.workDir },
    { BGOS_LANE_DIR: ben.laneDir },
    { BGOS_LANE_STATE_DIR: ben.stateDir },
    { BGOS_LANE_USER_ID: '../user_ben' },
    { BGOS_ASSISTANT_ID: '' },
    { BGOS_BACKEND_URL: '' },
  ]
  for (const bad of bads) {
    assert.equal(readLaneDaemonConfig(laneEnv('/Users/o', bad), '/Users/o', 'darwin').ok, false, JSON.stringify(bad))
  }
})

test('the daemon drops every Claude and BGOS secret from its own environment', () => {
  const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', BGOS_PAIRING_TOKEN: 'p', BGOS_API_KEY: 'a', BGOS_CREDENTIALS_PATH: '/c', PATH: '/bin' }
  scrubLaneDaemonEnv(env)
  assert.deepEqual(env, { PATH: '/bin' })
})

const LANE_SERVER = readFileSync(join(ROOT, 'lane-server.ts'), 'utf8')
const LANE_LIB = readFileSync(join(ROOT, 'lib', 'lane-daemon.ts'), 'utf8')

test('the lane daemon never holds the pairing token or the agent lock (source pins)', () => {
  for (const source of [LANE_SERVER, LANE_LIB]) {
    assert.ok(!/agent-credentials/.test(source), 'never imports the credentials loader')
    assert.ok(!/X-BGOS-Pairing|X-API-Key|pairingToken|authHeaders|wsAuthOptions/.test(source), 'never builds a pairing or API key header')
    assert.ok(!/pairing-lock/.test(source), 'never touches the agent\'s pairing lock')
  }
  // The only credential it sends.
  assert.match(LANE_SERVER, /headers\['X-BGOS-Session'\] = session\.sessionToken/)
  // The socket presents the lane session alone.
  // The lane session ALONE as its credential; since 0.71.0 (P5) the same
  // handshake also declares lane_memory_rpc, a capability and no credential.
  assert.match(LANE_SERVER, /auth: \(cb: \(auth: Record<string, unknown>\) => void\) => cb\(\{ laneSession: session\?\.sessionToken \?\? '', capabilities: \[LANE_MEMORY_RPC_TOKEN\] \}\)/)
  // The mint is the ticket alone, with no credential at all.
  assert.match(LANE_SERVER, /laneFetch\('POST', 'integrations\/lanes\/session', \{ laneTicket: ticket \}, \{ auth: false \}\)/)
})

test('the lane daemon declares no permission relay and never approves', () => {
  assert.match(LANE_SERVER, /experimental: \{ 'claude\/channel': \{\} \}/)
  const code = LANE_SERVER.replace(/\/\/.*$/gm, '')
  assert.ok(!code.includes("'claude/channel/permission'"))
  assert.ok(!/PermissionRequest/.test(code))
  assert.ok(!/behavior: 'allow'/.test(code))
  assert.deepEqual(LANE_TOOLS.map((t) => t.name), ['reply'], 'one tool, the one the allow list names')
})

test('PATH CONFINEMENT: inside the working folder only, after realpath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-paths-'))
  try {
    const work = join(dir, 'people', 'user_ana', 'work')
    mkdirSync(join(work, 'sub'), { recursive: true })
    writeFileSync(join(work, 'sub', 'ok.txt'), 'fine')
    const secrets = join(dir, 'ssh')
    mkdirSync(secrets)
    writeFileSync(join(secrets, 'id_ed25519'), 'PRIVATE')
    symlinkSync(join(secrets, 'id_ed25519'), join(work, 'innocent.txt'))
    symlinkSync(secrets, join(work, 'dirlink'))
    const deps = { workDir: work, realpath: realpathSync, platform: 'darwin' as const }
    const inside = confineLanePath(join(work, 'sub', 'ok.txt'), deps)
    assert.ok(inside.ok && inside.path === realpathSync(join(work, 'sub', 'ok.txt')))
    assert.ok(confineLanePath('sub/ok.txt', deps).ok, 'relative to the working folder')
    for (const [input, reason] of [
      [join(secrets, 'id_ed25519'), 'outside'],
      [join(work, '..', '..', '..', 'ssh', 'id_ed25519'), 'outside'],
      ['../../../ssh/id_ed25519', 'outside'],
      [join(work, 'innocent.txt'), 'outside'],
      [join(work, 'dirlink', 'id_ed25519'), 'outside'],
      [join(work, 'missing.txt'), 'missing'],
      ['', 'empty'],
      ['a\0b', 'nul'],
    ] as Array<[string, string]>) {
      const verdict = confineLanePath(input, deps)
      assert.equal(verdict.ok, false, input)
      if (!verdict.ok) assert.equal(verdict.reason, reason, input)
    }
    // A sibling whose name merely starts with "work" is not inside.
    mkdirSync(join(dir, 'people', 'user_ana', 'work2'))
    writeFileSync(join(dir, 'people', 'user_ana', 'work2', 'x.txt'), 'x')
    assert.equal(confineLanePath(join(dir, 'people', 'user_ana', 'work2', 'x.txt'), deps).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reply: every file confined, only chats this lane was handed, no URLs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-reply-'))
  try {
    const work = join(dir, 'work')
    mkdirSync(work)
    writeFileSync(join(work, 'a.png'), 'png')
    const deps = { workDir: work, realpath: realpathSync, deliveredChats: new Set(['777']), platform: 'darwin' }
    const ok = checkLaneReply({ chat_id: '777', text: 'here', files: [{ path: 'a.png' }] }, deps)
    assert.ok(ok.ok && ok.paths.length === 1)
    assert.equal(checkLaneReply({ chat_id: '778', text: 'x' }, deps).ok, false, 'a chat this lane was never handed')
    assert.equal(checkLaneReply({ chat_id: '777', text: 'x', files: [{ path: '/etc/hosts' }] }, deps).ok, false)
    assert.equal(checkLaneReply({ chat_id: '777', text: 'x', files: [{ path: '../../etc/hosts' }] }, deps).ok, false)
    assert.equal(checkLaneReply({ chat_id: '777', text: 'x', files: [{ url: 'file:///etc/hosts', path: 'a.png' }] }, deps).ok, false)
    assert.equal(checkLaneReply({ chat_id: '777', text: '   ' }, deps).ok, false)
    assert.equal(checkLaneReply({ chat_id: 'abc', text: 'x' }, deps).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function assertAllStrings(meta: Record<string, unknown>) {
  for (const [key, value] of Object.entries(meta)) {
    assert.equal(typeof value, 'string', `meta.${key} must be a string (got ${value === null ? 'null' : typeof value}); Claude Code drops the card otherwise`)
  }
}

test('the channel event: every meta value a string, sparse or full, with the lane stamp', () => {
  const sparse = normaliseLaneDelivery({ chatId: 777, messageId: 42, lane: 'person:user_ana' })!
  const sparseEvent = buildLaneChannelEvent(sparse, LANE, 'lane-socket')
  assertAllStrings(sparseEvent.meta)
  assert.equal(sparseEvent.meta.lane, 'person:user_ana')
  assert.equal(sparseEvent.meta.chat_id, '777')
  assert.equal(sparseEvent.meta.message_id, '42')
  assert.equal(sparseEvent.meta.transport, 'lane-socket')
  assert.equal('backlog' in sparseEvent.meta, false, 'absent optionals omitted, not false')
  const full = normaliseLaneDelivery({
    id: 43, message_id: 43, chat_id: 777, text: 'hi there', chat_kind: 'main', created_at: '2026-10-17T10:00:00Z',
    user_id: 'user_owner', sender_user_id: 'user_ana', sender_display_name: 'Ana', sender_relationship: 'shared_recipient',
    sender_guardrail: 'Be brief.', lane: 'person:user_ana', files: [{ id: 9, filename: 'a.png', mime: 'image/png', url: 'https://s3/x' }],
  })!
  const fullEvent = buildLaneChannelEvent(full, LANE, 'lane-poll', { backlog: true })
  assertAllStrings(fullEvent.meta)
  assert.equal(fullEvent.meta.user_id, 'user_ana', 'the speaker, never the owner the row\'s user_id names')
  assert.equal(fullEvent.meta.backlog, 'true')
  assert.ok(fullEvent.content.includes('hi there'))
})

test('the inbox: a relaunch re-offers an unanswered turn once, never an answered one, never twice', () => {
  let inbox = readLaneInbox(null)
  assert.deepEqual(inbox, { cursor: 0, delivered: [], pending: [] })
  assert.ok(inboxShouldDeliver(inbox, 10, { reoffer: false }))
  inbox = inboxNoteDelivered(inbox, { messageId: 10, chatId: '777' })
  inbox = inboxNoteDelivered(inbox, { messageId: 11, chatId: '778' })
  inbox = inboxAdvanceCursor(inbox, 11)
  assert.equal(inboxShouldDeliver(inbox, 10, { reoffer: false }), false, 'never twice in one life')
  inbox = inboxNoteReplied(inbox, '778')
  // A relaunch: the state as persisted.
  const relaunched = readLaneInbox(JSON.parse(JSON.stringify(inbox)))
  assert.equal(inboxShouldDeliver(relaunched, 10, { reoffer: true }), true, 'the unanswered turn is re-offered')
  assert.equal(inboxShouldDeliver(relaunched, 11, { reoffer: true }), false, 'the answered one is not')
  assert.equal(inboxPollFrom(relaunched), 9, 'the poll asks from before the waiting turn')
  assert.equal(inboxPollFrom(inboxNoteReplied(relaunched, '777')), 11)
  assert.deepEqual(readLaneInbox({ cursor: -5, delivered: ['x', 3], pending: [{ id: 'y' }, { id: 4, chatId: '0' }] }), { cursor: 0, delivered: [3], pending: [] })
})

test('one decision per message id: two paths that both check before either notes cannot both hand a turn over (0.71.2)', () => {
  const inbox = readLaneInbox(null)
  const claims = new LaneDeliveryClaims(inbox)
  // The socket path and the poll both decide from the same, not yet noted, inbox.
  assert.equal(claims.take(inbox, 701, { reoffer: false }), true, 'the first path hands it over')
  assert.equal(claims.take(inbox, 701, { reoffer: false }), false, 'the second path, from the same inbox, does not')
  assert.equal(claims.take(inbox, 701, { reoffer: true }), false, 'nor as a re-offer')
  assert.equal(claims.take(inbox, 702, { reoffer: false }), true, 'another id is its own decision')
})

test('a re-offer is only a turn the inbox held at launch, once (0.71.2)', () => {
  // The last life handed 10 over and it is still waiting for an answer.
  const atLaunch = readLaneInbox({ cursor: 10, delivered: [10], pending: [{ id: 10, chatId: '777' }] })
  const claims = new LaneDeliveryClaims(atLaunch)
  // In this life the socket path notes 11 (delivered, waiting) without this claims object, as main's daemon did.
  const now = inboxNoteDelivered(atLaunch, { messageId: 11, chatId: '777' })
  assert.equal(claims.mayReoffer(11), false, 'a turn noted in this life is not a re-offer')
  assert.equal(claims.take(now, 11, { reoffer: true }), false, 'and the re-offer flag does not let it through')
  assert.equal(claims.mayReoffer(10), true)
  assert.equal(claims.take(now, 10, { reoffer: true }), true, 'the turn waiting since the last life is re-offered')
  assert.equal(claims.take(now, 10, { reoffer: true }), false, 'once')
  // `/new` empties the waiting list: a turn waiting at launch is no longer re-offered.
  const fresh = new LaneDeliveryClaims(atLaunch)
  assert.equal(fresh.take(inboxForNewConversation(atLaunch), 10, { reoffer: true }), false)
})

test('the server\'s record of a hand over: the history page for exactly one message, and its delivery state (0.71.2)', () => {
  assert.equal(laneHistoryPathFor({ chatId: '77', messageId: 601 }), 'chats/77/messages?afterId=600&beforeId=602&limit=1')
  const page = { messages: [{ id: 600, deliveryState: 'delivered' }, { id: 601, deliveryState: LANE_SERVER_ACKNOWLEDGED }] }
  assert.equal(laneHistoryDeliveryState(page, 601), 'acknowledged')
  assert.equal(laneHistoryDeliveryState(page, 600), 'delivered')
  assert.equal(laneHistoryDeliveryState({ messages: [{ id: '601', deliveryState: 'acknowledged' }] }, 601), 'acknowledged', 'an id as a string')
  assert.equal(laneHistoryDeliveryState(page, 602), null, 'a row the page does not carry')
  assert.equal(laneHistoryDeliveryState({ messages: [{ id: 601, deliveryState: null }] }, 601), null)
  assert.equal(laneHistoryDeliveryState([{ id: 601, deliveryState: 'queued' }], 601), 'queued', 'a bare array')
  assert.equal(laneHistoryDeliveryState(null, 601), null)
  assert.equal(laneHistoryDeliveryState({ messages: 'nope' }, 601), null)
})

test('the first start offers only the turn that woke the lane; a relaunch offers what came after', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  const row = (id: number, minutesAgo: number) => normaliseLaneDelivery({ id, chat_id: 777, lane: 'person:user_ana', created_at: new Date(now - minutesAgo * 60_000).toISOString() })!
  const history = [row(1, 60 * 24 * 3), row(2, 120), row(3, 2)]
  assert.deepEqual(selectLaneBacklog(history, { cursor: 0, nowMs: now }).map((d) => d.messageId), [3])
  assert.deepEqual(selectLaneBacklog(history, { cursor: 1, nowMs: now }).map((d) => d.messageId), [2, 3])
})

test('the mint answer and lanes/me must name exactly this lane', () => {
  const minted = { sessionToken: 'lsess_abcdefghijkl', expiresAt: '2026-10-18T10:00:00Z', lane: { pairingId: 1, assistantId: 1076, actorUserId: 'user_ana', stamp: 'person:user_ana' } }
  assert.deepEqual(readMintAnswer(minted, LANE), { sessionToken: 'lsess_abcdefghijkl', expiresAt: '2026-10-18T10:00:00Z', actorUserId: 'user_ana', assistantId: '1076', pairingId: '1' })
  assert.equal(readMintAnswer({ ...minted, lane: { ...minted.lane, actorUserId: 'user_ben' } }, LANE), null)
  assert.equal(readMintAnswer({ ...minted, lane: { ...minted.lane, assistantId: 9 } }, LANE), null)
  assert.equal(readMintAnswer({ ...minted, lane: { ...minted.lane, stamp: 'owner' } }, LANE), null)
  assert.equal(readMintAnswer({ ...minted, sessionToken: 'pt_owner_token' }, LANE), null)
  assert.ok(laneMeMatches({ actorUserId: 'user_ana', assistantId: 1076, lane: 'person:user_ana' }, LANE))
  assert.ok(!laneMeMatches({ actorUserId: 'user_ana', assistantId: 1076, lane: 'owner' }, LANE))
  const now = Date.parse('2026-10-17T10:00:00Z')
  assert.ok(storedSessionUsable(readMintAnswer(minted, LANE), LANE, now))
  assert.ok(!storedSessionUsable(readMintAnswer(minted, LANE), LANE, Date.parse('2026-10-18T09:59:30Z')), 'a minute of margin')
  assert.ok(!storedSessionUsable(readMintAnswer(minted, LANE), { userId: 'user_ben', assistantId: '1076' }, now))
  assert.equal(readTicketFile(JSON.stringify({ laneTicket: 'lt_1', ticketExpiresAt: '2026-10-17T10:02:00Z' }), now), 'lt_1')
  assert.equal(readTicketFile(JSON.stringify({ laneTicket: 'lt_1', ticketExpiresAt: '2026-10-17T09:59:00Z' }), now), null, 'expired')
  assert.equal(readTicketFile('garbage', now), null)
})

test('a refused own token is read from the CLI\'s own debug line (measured on 2.1.302)', () => {
  const measured = [
    '2026-10-17T14:12:16.002Z [ERROR] OAuth 401: keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN instead of adopting the stored credential. Mint a fresh token with `claude setup-token` and restart with it, or unset the variable and run /login.',
    '2026-10-17T14:12:16.002Z [DEBUG] Remote settings: Fetch attempt failed (http_401)',
  ].join('\n')
  assert.ok(debugLogSaysTokenRefused(measured))
  assert.ok(!debugLogSaysTokenRefused('2026-10-17T14:12:16.002Z [DEBUG] Remote settings: Fetch attempt failed (http_401)'))
  assert.ok(!debugLogSaysTokenRefused(''))
  // The daemon reads it only under the person's own token, and tells the person.
  assert.match(LANE_SERVER, /if \(CFG\.loginMode === LANE_LOGIN_OWN_TOKEN && Date\.now\(\) - DAEMON_STARTED_AT_MS < TOKEN_CHECK_WINDOW_MS && debugLogSaysTokenRefused\(debugLogTail\(\)\)\)/)
  // Only the tail is read, never the whole log.
  assert.match(LANE_SERVER, /readSync\(fd, buf, 0, length, size - length\)/)
  assert.match(LANE_SERVER, /appendEvent\(\{ event: 'notice', notice: 'login_token_failed', chatIds: await noticeChatIds\(\) \}\)\n\s*endLane\('login_failed'\)/)
})

test('the lane\'s instructions fit the CLI\'s 4,096 character cut', () => {
  assert.ok(laneInstructions('A very long agent name '.repeat(5)).length < 4096)
})
