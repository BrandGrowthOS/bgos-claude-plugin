/**
 * PERSON LANES, a person's lane hands each inbound message to Claude exactly
 * once (mission 161 pilot readiness; 0.71.2).
 *
 * Two ways a turn reached Claude twice, both run here against the REAL lane
 * daemon (`lane-server.ts` under `bin/bgos-launch.mjs`, as the lane's mcp.json
 * starts it), a stand in backend and a stand in for Claude Code:
 *
 *   1. A message that arrives over the lane socket while the daemon's first
 *      poll is fetching its backlog. The socket path notes it as delivered and
 *      waiting for an answer; the boot poll then read its re-offer set AFTER
 *      the fetch, found the message waiting, and re-offered it in the same
 *      life: two channel events and two acks for one message.
 *   2. A lane whose inbox note is gone (its folders deleted) started as if
 *      brand new and re-answered every message of the last 15 minutes. The
 *      server knows which of them were already picked up (the lane acked
 *      them: `deliveryState: acknowledged` on the person's chat history, in
 *      the backend's own envelope), so a boot with no note asks it and hands
 *      over only the rest; a failed read is retried, and a server that keeps
 *      failing gets the backlog offered as before, never a stall.
 *
 * And what must not change: a relaunch WITH its note never asks the server
 * and still re-offers the turn its last life left unanswered (the server has
 * that one acknowledged too), once; a turn the socket hands over while the
 * server is asked keeps its note; and a `/new` performed during the boot
 * fetch still keeps the old waiting turn out of the new conversation.
 *
 * Run with: npx tsx --test test/lane-dedupe.test.ts
 */
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

import { LANE_NOTICES, laneDaemonEnv, lanePaths, personLaneStamp } from '../lib/lane-core.mjs'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32).
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS, timeout: 60_000 }, fn as never)

const ROOT = join(import.meta.dirname, '..')
const ASSISTANT_ID = '1076'
const USER_ID = 'user_ana'
const CHAT_ID = 77
const STAMP = personLaneStamp(USER_ID)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, what: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

function inboundRow(id: number, minutesAgo: number, text: string): Record<string, unknown> {
  return {
    id,
    message_id: id,
    chat_id: CHAT_ID,
    chat_kind: 'main',
    text,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    lane: STAMP,
    assistantId: Number(ASSISTANT_ID),
    sender_user_id: USER_ID,
  }
}

interface BackendOpts {
  /** What `GET lanes/inbound` serves (filtered by since_message_id). */
  rows: Array<Record<string, unknown>>
  /** The server's delivery state of each row, as her chat history shows it. */
  deliveryStates?: Record<number, string>
  /** Runs while the FIRST `GET lanes/inbound` is held, before it is answered. */
  duringFirstInbound?: (io: SocketServer) => Promise<void>
  /** How many history reads fail with a 500 before they are answered. */
  historyFailures?: number
  /** Chats whose history a lane may not read (the real backend answers 403). */
  forbiddenChats?: number[]
  /** Runs while the FIRST history read is held, before it is answered. */
  duringFirstHistory?: (io: SocketServer) => Promise<void>
  /** Per message id: how many of its history reads fail with a 500. */
  failReadsOf?: Record<number, number>
  /** Per message id: how many of its history reads are never answered. */
  hangReadsOf?: Record<number, number>
  /** Agent rows in her chat history (answers, or the lane notices the owner's daemon posts as the agent). */
  agentRows?: Array<{ id: number; text: string }>
  /** Per message id: how many reads of the page AFTER it fail with a 500. */
  failAfterReadsOf?: Record<number, number>
}

interface Backend {
  url: string
  io: SocketServer
  acks: number[]
  inboundGets: number
  historyReads: Array<{ chatId: number; afterId: string | null; beforeId: string | null; status: number }>
  close: () => Promise<void>
}

async function startBackend(opts: BackendOpts): Promise<Backend> {
  const state: Backend = {
    url: '',
    io: null as unknown as SocketServer,
    acks: [],
    inboundGets: 0,
    historyReads: [],
    close: async () => {},
  }
  let historyFailuresLeft = opts.historyFailures ?? 0
  let historyReadsSeen = 0
  const failsLeft: Record<number, number> = { ...(opts.failReadsOf ?? {}) }
  const hangsLeft: Record<number, number> = { ...(opts.hangReadsOf ?? {}) }
  const hung: ServerResponse[] = []
  const afterFailsLeft: Record<number, number> = { ...(opts.failAfterReadsOf ?? {}) }
  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/api\/v1\//, '')
    req.resume()
    if (req.method === 'POST' && path === 'integrations/lanes/session') {
      return json(res, {
        sessionToken: 'lsess_dedupe_standin_00001',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        lane: { actorUserId: USER_ID, assistantId: ASSISTANT_ID, stamp: STAMP, pairingId: '9' },
      })
    }
    if (req.method === 'GET' && path === 'integrations/lanes/me') return json(res, { actorUserId: USER_ID, assistantId: ASSISTANT_ID, lane: STAMP })
    if (req.method === 'GET' && path === 'integrations/lanes/inbound') {
      state.inboundGets += 1
      if (state.inboundGets === 1 && opts.duringFirstInbound) await opts.duringFirstInbound(state.io)
      const since = Number(url.searchParams.get('since_message_id') ?? 0)
      return json(res, { messages: opts.rows.filter((r) => Number(r.id) > since) })
    }
    // Her chat history, the route a lane may read for its own chats, in the
    // backend's own envelope (MessagesDto: each entry is { message,
    // messageFiles, messageOptions }); the message carries the server's
    // delivery state.
    const history = /^chats\/(\d+)\/messages$/.exec(path)
    if (req.method === 'GET' && history) {
      const afterId = url.searchParams.get('afterId')
      const beforeId = url.searchParams.get('beforeId')
      if (opts.forbiddenChats?.includes(Number(history[1]))) {
        state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 403 })
        return json(res, { message: 'not this lane' }, 403)
      }
      const asked = Number(afterId) + 1
      if ((hangsLeft[asked] ?? 0) > 0) {
        hangsLeft[asked] -= 1
        state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 0 })
        hung.push(res)
        return
      }
      if ((failsLeft[asked] ?? 0) > 0) {
        failsLeft[asked] -= 1
        state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 500 })
        return json(res, { message: 'stand in failure' }, 500)
      }
      // A read of the page after a message (afterId = that message, no beforeId).
      if (beforeId === null && (afterFailsLeft[Number(afterId)] ?? 0) > 0) {
        afterFailsLeft[Number(afterId)] -= 1
        state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 500 })
        return json(res, { message: 'stand in failure' }, 500)
      }
      if (historyFailuresLeft > 0) {
        historyFailuresLeft -= 1
        state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 500 })
        return json(res, { message: 'stand in failure' }, 500)
      }
      historyReadsSeen += 1
      if (historyReadsSeen === 1 && opts.duringFirstHistory) await opts.duringFirstHistory(state.io)
      state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 200 })
      const after = afterId === null ? 0 : Number(afterId)
      const before = beforeId === null ? Number.POSITIVE_INFINITY : Number(beforeId)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const all = [
        ...opts.rows.map((r) => ({
          // As the real server: a row this lane acked shows acknowledged.
          id: Number(r.id), chatId: Number(r.chat_id), sender: 'user', text: r.text,
          deliveryState: state.acks.includes(Number(r.id)) ? 'acknowledged' : (opts.deliveryStates?.[Number(r.id)] ?? 'delivered'),
        })),
        ...(opts.agentRows ?? []).map((a) => ({ id: a.id, chatId: CHAT_ID, sender: 'assistant', text: a.text, deliveryState: null })),
      ]
      // As the backend's chat page: the NEWEST `limit` rows in the range, oldest first.
      const inRange = all
        .filter((m) => m.chatId === Number(history[1]) && m.id > after && m.id < before)
        .sort((a, b) => a.id - b.id)
      const messages = inRange.slice(Math.max(0, inRange.length - limit)).map((message) => ({ message, messageFiles: [], messageOptions: [] }))
      return json(res, { messages })
    }
    const ack = /^integrations\/messages\/(\d+)\/ack$/.exec(path)
    if (req.method === 'POST' && ack) {
      state.acks.push(Number(ack[1]))
      return json(res, { ok: true })
    }
    return json(res, {})
  }
  const http: HttpServer = createServer((req, res) => { void handler(req, res) })
  state.io = new SocketServer(http)
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  state.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  state.close = () => new Promise<void>((r) => {
    for (const res of hung) res.destroy()
    state.io.close()
    http.close(() => r())
  })
  return state
}

interface Rig {
  client: Client
  channel: Array<{ at: number; messageId: string; content: string }>
  home: string
  backend: Backend
}

/**
 * The real daemon under a stand in Claude Code, by default with NO inbox note
 * (a brand new folder, or one that was deleted); `inbox` is the note a
 * relaunch finds.
 */
async function startLane(backend: Backend, opts: { inbox?: Record<string, unknown> } = {}): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), 'lane-dedupe-'))
  const p = lanePaths({ home, assistantId: ASSISTANT_ID, userId: USER_ID })
  mkdirSync(p.workDir, { recursive: true, mode: 0o700 })
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
  if (opts.inbox) writeFileSync(p.cursorPath, JSON.stringify(opts.inbox), { mode: 0o600 })
  writeFileSync(p.ticketPath, JSON.stringify({ laneTicket: 'lt_dedupe_standin', ticketExpiresAt: new Date(Date.now() + 120_000).toISOString() }), { mode: 0o600 })
  const env: Record<string, string> = {
    ...laneDaemonEnv({ assistantId: ASSISTANT_ID, userId: USER_ID, workDir: p.workDir, laneDir: p.laneDir, stateDir: p.stateDir, backendUrl: backend.url, loginMode: 'inherit' }),
    HOME: home,
    PATH: process.env.PATH ?? '',
    ...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'bin', 'bgos-launch.mjs'), join(ROOT, 'lane-server.ts')],
    env,
    cwd: p.workDir,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'claude-code-standin', version: '0.0.0' }, { capabilities: {} })
  const channel: Rig['channel'] = []
  client.fallbackNotificationHandler = async (n) => {
    if (n.method !== 'notifications/claude/channel') return
    const params = (n.params ?? {}) as { content?: unknown; meta?: Record<string, string> }
    channel.push({ at: Date.now(), messageId: String(params.meta?.message_id ?? ''), content: String(params.content ?? '') })
  }
  await client.connect(transport)
  // Claude Code asks for the tool list straight after the handshake.
  await client.listTools()
  return { client, channel, home, backend }
}

async function stopLane(rig: Rig): Promise<void> {
  // Closing stdin ends the daemon; the lane.json pid is the daemon this test started.
  const p = lanePaths({ home: rig.home, assistantId: ASSISTANT_ID, userId: USER_ID })
  let daemonPid: number | null = null
  try { daemonPid = JSON.parse(readFileSync(p.laneJsonPath, 'utf8')).pid ?? null } catch { /* never wrote it */ }
  await rig.client.close().catch(() => {})
  if (daemonPid) {
    const alive = () => { try { process.kill(daemonPid as number, 0); return true } catch { return false } }
    const until = Date.now() + 5_000
    while (alive() && Date.now() < until) await sleep(50)
    // Only a daemon still running at the deadline, never a pid it has given up.
    if (alive()) try { process.kill(daemonPid, 'SIGKILL') } catch { /* exited meanwhile */ }
  }
  await rig.backend.close()
  rmSync(rig.home, { recursive: true, force: true })
}

function savedInbox(home: string): { delivered: number[]; pending: Array<{ id: number }> } {
  const p = lanePaths({ home, assistantId: ASSISTANT_ID, userId: USER_ID })
  try { return JSON.parse(readFileSync(p.cursorPath, 'utf8')) } catch { return { delivered: [], pending: [] } }
}

test('bug 1: a message that arrives over the socket while the boot poll fetches the backlog reaches Claude once and is acked once', async () => {
  const MESSAGE_ID = 701
  const row = inboundRow(MESSAGE_ID, 0, 'Sent while my lane was starting')
  let homeOf: () => string = () => ''
  const backend = await startBackend({
    rows: [row],
    // The deterministic interleaving: the message is pushed over the lane
    // socket while the boot poll's fetch is in flight, and the fetch is
    // answered (with the same row) only once the daemon has noted the socket
    // delivery in its saved inbox.
    duringFirstInbound: async (io) => {
      io.emit('inbound_message', row)
      await waitFor(() => homeOf() !== '' && savedInbox(homeOf()).delivered.includes(MESSAGE_ID), 'the daemon to note the socket delivery')
    },
  })
  const rig = await startLane(backend)
  homeOf = () => rig.home
  try {
    await waitFor(() => rig.channel.length > 0, 'the turn')
    await waitFor(() => backend.acks.length > 0, 'the ack')
    // Both paths release together once Claude has the tools; give a second
    // delivery every chance to show.
    await sleep(1_500)
    assert.equal(backend.inboundGets >= 1, true)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(MESSAGE_ID)], 'handed to Claude exactly once')
    assert.deepEqual(backend.acks, [MESSAGE_ID], 'acknowledged exactly once')
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a lane with no inbox note hands over only what the server says no Claude of this lane was handed', async () => {
  // Her earlier message, answered by this lane before its folders were
  // deleted: acknowledged at the server. Her new message, which woke the
  // lane: not acknowledged yet. Both inside the first start's 15 minutes.
  const OLD_ID = 601
  const NEW_ID = 603
  const backend = await startBackend({
    rows: [inboundRow(OLD_ID, 6, 'An earlier question, already answered'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [OLD_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
    // An agent answered her earlier message.
    agentRows: [{ id: OLD_ID + 1, text: 'Here is the answer to your earlier question.' }],
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => rig.channel.length > 0, 'the new turn')
    await waitFor(() => backend.acks.length > 0, 'the ack')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NEW_ID)], 'only the message no Claude of this lane was handed')
    assert.ok(!rig.channel.some((c) => c.content.includes('already answered')))
    assert.deepEqual(backend.acks, [NEW_ID])
    assert.ok(backend.historyReads.some((h) => h.chatId === CHAT_ID && h.status === 200), 'the lane asked the server')
    // What it learned is kept: the earlier message is noted as handled, so
    // it is never offered nor asked about again.
    const saved = savedInbox(rig.home)
    assert.ok(saved.delivered.includes(OLD_ID))
    assert.ok(!saved.pending.some((p) => p.id === OLD_ID))
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a history read that fails once is asked again after a second, and the answer still decides', async () => {
  const OLD_ID = 601
  const NEW_ID = 603
  const backend = await startBackend({
    rows: [inboundRow(OLD_ID, 6, 'An earlier question, already answered'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [OLD_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
    // An agent answered her earlier message.
    agentRows: [{ id: OLD_ID + 1, text: 'Here is the answer to your earlier question.' }],
    // The read about the ANSWERED message fails once: without the retry it
    // would be offered again.
    failReadsOf: { [OLD_ID]: 1 },
  })
  const rig = await startLane(backend)
  try {
    // No reconnect and no 30 s poll: the retry is the lane's own, within seconds.
    await waitFor(() => rig.channel.length > 0, 'the new turn', 12_000)
    await waitFor(() => backend.acks.length > 0, 'the ack')
    await sleep(1_500)
    assert.ok(backend.historyReads.some((h) => h.status === 500 && h.afterId === String(OLD_ID - 1)), 'its read failed once')
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NEW_ID)], 'the retried answer still keeps the answered message out')
    assert.deepEqual(backend.acks, [NEW_ID])
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: when the server keeps failing, the lane stops asking and offers the backlog as before: it never stalls', async () => {
  const OLD_ID = 601
  const NEW_ID = 603
  const backend = await startBackend({
    rows: [inboundRow(OLD_ID, 6, 'An earlier question, already answered'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [OLD_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
    historyFailures: 1_000,
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => rig.channel.length >= 2, 'the backlog offered as before', 15_000)
    await sleep(1_500)
    // The server could not say, so main's rule applies: the turn that woke
    // the lane goes over, and so does the one it could not vouch for.
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(OLD_ID), String(NEW_ID)])
    const failedReads = backend.historyReads.filter((h) => h.status === 500)
    assert.ok(failedReads.length >= 2 && failedReads.length <= 2 * 3, `a bounded number of reads (${failedReads.length})`)
  } finally {
    await stopLane(rig)
  }
})

test('a relaunch with its inbox note re-offers the turn its last life left unanswered, once, though the server has it acknowledged', async () => {
  // The last life handed 601 over and acked it (so the server says
  // acknowledged), then stopped before its reply. 603 came after, unseen.
  const WAITING_ID = 601
  const NEW_ID = 603
  const backend = await startBackend({
    rows: [inboundRow(WAITING_ID, 6, 'Handed over, never answered'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [WAITING_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
  })
  const rig = await startLane(backend, { inbox: { cursor: WAITING_ID, delivered: [WAITING_ID], pending: [{ id: WAITING_ID, chatId: String(CHAT_ID) }] } })
  try {
    await waitFor(() => rig.channel.length >= 2, 'the re-offer and the new turn')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(WAITING_ID), String(NEW_ID)], 'the waiting turn once, then the new one')
    assert.deepEqual(backend.acks, [WAITING_ID, NEW_ID])
  } finally {
    await stopLane(rig)
  }
})

test('a /new that arrives over the socket during the boot fetch: the new conversation is never handed the last life\'s waiting turn', async () => {
  const WAITING_ID = 601
  const NEW_COMMAND_ID = 605
  const command = inboundRow(NEW_COMMAND_ID, 0, '/new')
  let homeOf: () => string = () => ''
  const backend = await startBackend({
    rows: [inboundRow(WAITING_ID, 6, 'Handed over, never answered'), command],
    deliveryStates: { [WAITING_ID]: 'acknowledged' },
    duringFirstInbound: async (io) => {
      io.emit('inbound_message', command)
      await waitFor(() => homeOf() !== '' && savedInbox(homeOf()).delivered.includes(NEW_COMMAND_ID), 'the daemon to perform the /new')
    },
  })
  const rig = await startLane(backend, { inbox: { cursor: WAITING_ID, delivered: [WAITING_ID], pending: [{ id: WAITING_ID, chatId: String(CHAT_ID) }] } })
  homeOf = () => rig.home
  try {
    await waitFor(() => backend.acks.includes(NEW_COMMAND_ID), 'the /new acknowledged')
    // Past the settle: a re-offer that was going to go out has gone out.
    await sleep(3_500)
    assert.equal(rig.channel.length, 0, 'the old conversation\'s waiting turn is not handed to the new one')
    assert.deepEqual(backend.acks, [NEW_COMMAND_ID])
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a backlog row stamped for another person is never asked about at the server, and does not hold back the lane\'s own turn', async () => {
  // A backend fault hands this lane a row of Ben's chat. The second lock
  // refuses it at hand over; the server check must not ask about Ben's chat
  // (the real backend refuses that read with 403), or the boot backlog would
  // be postponed for good.
  const BEN_ID = 602
  const BEN_CHAT_ID = 78
  const NEW_ID = 603
  const bensRow = { ...inboundRow(BEN_ID, 2, 'For Ben only'), chat_id: BEN_CHAT_ID, lane: personLaneStamp('user_ben'), sender_user_id: 'user_ben' }
  const backend = await startBackend({
    rows: [bensRow, inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [NEW_ID]: 'delivered' },
    forbiddenChats: [BEN_CHAT_ID],
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => rig.channel.length > 0, 'her new turn')
    await waitFor(() => backend.acks.length > 0, 'the ack')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NEW_ID)])
    assert.deepEqual(backend.acks, [NEW_ID], 'Ben\'s row is never acknowledged by her lane')
    assert.ok(!backend.historyReads.some((h) => h.chatId === BEN_CHAT_ID), 'her lane never asks about Ben\'s chat')
  } finally {
    await stopLane(rig)
  }
})

test('a relaunch WITH its inbox note never asks the server: a message the note does not list goes over, though an owner notice acked it', async () => {
  // She sent /model, the lane restarted, and she sent 611 before it was back.
  // The owner's daemon then posted the lane's notice as an assistant row,
  // which marks her latest message acknowledged (the backend's reply hook),
  // though no Claude was handed it. Her lane's own note says it never was.
  const COMMAND_ID = 610
  const MISSED_ID = 611
  const backend = await startBackend({
    rows: [inboundRow(COMMAND_ID, 3, '/model opus'), inboundRow(MISSED_ID, 2, 'Sent while my lane restarted')],
    deliveryStates: { [COMMAND_ID]: 'acknowledged', [MISSED_ID]: 'acknowledged' },
  })
  const rig = await startLane(backend, { inbox: { cursor: COMMAND_ID, delivered: [COMMAND_ID], pending: [] } })
  try {
    await waitFor(() => rig.channel.length > 0, 'the missed turn')
    await waitFor(() => backend.acks.length > 0, 'the ack')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(MISSED_ID)], 'her note is the authority: 611 was never handed over')
    assert.deepEqual(backend.acks, [MISSED_ID])
    assert.equal(backend.historyReads.length, 0, 'a lane with its note does not ask the server')
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a turn the socket hands over (and acks) while the server is asked stays waiting for its answer', async () => {
  const MESSAGE_ID = 621
  const row = inboundRow(MESSAGE_ID, 1, 'Sent while my lane asked the server')
  let homeOf: () => string = () => ''
  let markedWhileAsking: unknown
  const backend: Backend = await startBackend({
    rows: [row],
    // The history read for 621 is answered only after the socket path handed
    // 621 to Claude and acked it, so the server then says acknowledged: by
    // this life's own hand over, not an earlier one.
    duringFirstHistory: async (io) => {
      io.emit('inbound_message', row)
      await waitFor(() => backend.acks.includes(MESSAGE_ID), 'the socket path to hand 621 over and ack it')
      markedWhileAsking = (savedInbox(homeOf()) as Record<string, unknown>).unverified
    },
  })
  const rig = await startLane(backend)
  homeOf = () => rig.home
  try {
    await waitFor(() => backend.historyReads.length > 0, 'the history read')
    await sleep(1_500)
    assert.equal(markedWhileAsking, true, 'a note saved before the boot poll finished asking says so')
    assert.equal((savedInbox(rig.home) as Record<string, unknown>).unverified, undefined, 'and the note saved after it does not')
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(MESSAGE_ID)], 'handed over once')
    assert.deepEqual(backend.acks, [MESSAGE_ID])
    const saved = savedInbox(rig.home)
    assert.ok(saved.pending.some((p) => p.id === MESSAGE_ID), 'still waiting for its answer, so a relaunch re-offers it')
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a history read that hangs is given up after a few seconds and asked again, never the HTTP client\'s 20 s', async () => {
  const OLD_ID = 601
  const NEW_ID = 603
  const backend = await startBackend({
    rows: [inboundRow(OLD_ID, 6, 'An earlier question, already answered'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [OLD_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
    // An agent answered her earlier message.
    agentRows: [{ id: OLD_ID + 1, text: 'Here is the answer to your earlier question.' }],
    hangReadsOf: { [OLD_ID]: 1 },
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => rig.channel.length > 0, 'the new turn', 12_000)
    await sleep(1_500)
    assert.ok(backend.historyReads.some((h) => h.status === 0), 'one read hung')
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NEW_ID)], 'the retried answer still keeps the answered message out')
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a note saved by a first boot that never finished asking the server is not trusted at the next launch', async () => {
  // The last life had no note, saved one (a socket hand over) while its boot
  // poll was still asking the server, and stopped before it finished.
  const OLD_ID = 601
  const NEW_ID = 603
  const backend = await startBackend({
    rows: [inboundRow(OLD_ID, 6, 'An earlier question, already answered'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [OLD_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
    // An agent answered her earlier message.
    agentRows: [{ id: OLD_ID + 1, text: 'Here is the answer to your earlier question.' }],
  })
  const rig = await startLane(backend, { inbox: { cursor: 0, delivered: [], pending: [], unverified: true } })
  try {
    await waitFor(() => rig.channel.length > 0, 'the new turn')
    await waitFor(() => backend.acks.length > 0, 'the ack')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NEW_ID)], 'asked the server, as with no note')
    assert.ok(backend.historyReads.length > 0)
    assert.equal((savedInbox(rig.home) as Record<string, unknown>).unverified, undefined, 'and once the boot poll asked, the note is trusted again')
  } finally {
    await stopLane(rig)
  }
})

test('a /new handled while the boot poll asks the server: the older waking turn is never handed to Claude, in this life or the next', async () => {
  // Review pass 3, finding 1. Her turn 631 woke the lane; while the lane asked
  // the server about it, her /new (632) arrived over the socket and was
  // performed. 631 belongs to the conversation she just left.
  const WAITING_ID = 631
  const NEW_COMMAND_ID = 632
  const command = inboundRow(NEW_COMMAND_ID, 0, '/new')
  let homeOf: () => string = () => ''
  const backend: Backend = await startBackend({
    rows: [inboundRow(WAITING_ID, 1, 'From the conversation she is leaving'), command],
    duringFirstHistory: async (io) => {
      io.emit('inbound_message', command)
      await waitFor(() => homeOf() !== '' && savedInbox(homeOf()).delivered.includes(NEW_COMMAND_ID), 'the daemon to perform the /new')
    },
  })
  const rig = await startLane(backend)
  homeOf = () => rig.home
  try {
    await waitFor(() => backend.acks.includes(NEW_COMMAND_ID), 'the /new acknowledged')
    // Past the settle: a turn that was going to go out has gone out.
    await sleep(3_500)
    assert.equal(rig.channel.length, 0, 'the older turn is not handed to Claude')
    const saved = savedInbox(rig.home)
    assert.ok(saved.delivered.includes(WAITING_ID), 'it is noted as handled, so it is never offered')
    assert.ok(!saved.pending.some((p) => p.id === WAITING_ID), 'and nothing waits, so the next life does not re-offer it')
    assert.equal((saved as Record<string, unknown>).newFrom, NEW_COMMAND_ID, 'the /new is in the note, for a next life that starts before this one recorded the older turn')
  } finally {
    await stopLane(rig)
  }
})

test('a next life whose last life performed a /new before it recorded the older turn still keeps that turn out', async () => {
  // Review pass 5, finding 1: the supervisor restarted the lane for the /new
  // (632) while its boot poll was still asking the server about 631, so the
  // note holds the /new but not 631, and it is unverified.
  const WAITING_ID = 631
  const NEW_COMMAND_ID = 632
  const backend = await startBackend({
    rows: [inboundRow(WAITING_ID, 1, 'From the conversation she left'), inboundRow(NEW_COMMAND_ID, 0, '/new')],
    deliveryStates: { [WAITING_ID]: 'delivered', [NEW_COMMAND_ID]: 'acknowledged' },
  })
  const rig = await startLane(backend, { inbox: { cursor: 0, delivered: [NEW_COMMAND_ID], pending: [], unverified: true, newFrom: NEW_COMMAND_ID } })
  try {
    await waitFor(() => backend.inboundGets > 0, 'the boot poll')
    // Past the settle: a turn that was going to go out has gone out.
    await sleep(3_500)
    assert.equal(rig.channel.length, 0, 'the older turn never reaches the new conversation')
    assert.equal(backend.acks.length, 0)
    assert.ok(savedInbox(rig.home).delivered.includes(WAITING_ID), 'and it is noted as handled')
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a message only a lane notice marked acknowledged was never answered, so a lane with no note offers it', async () => {
  // The lane could not sign in; the owner's daemon posted the fixed notice as
  // the agent, and the backend's reply hook marked her message acknowledged.
  // No Claude was handed it, and nothing answered it.
  const NOTICED_ID = 641
  const NEW_ID = 643
  const backend = await startBackend({
    rows: [inboundRow(NOTICED_ID, 6, 'Sent while my lane could not sign in'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [NOTICED_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
    agentRows: [{ id: NOTICED_ID + 1, text: LANE_NOTICES.login_token_missing }],
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => rig.channel.length >= 2, 'both turns')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NOTICED_ID), String(NEW_ID)], 'a notice is not an answer')
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a message handed over and never answered (acknowledged, no answer after it) is offered again by a lane with no note', async () => {
  const HANDED_ID = 651
  const backend = await startBackend({
    rows: [inboundRow(HANDED_ID, 3, 'Handed over, then the lane and its folders were gone')],
    deliveryStates: { [HANDED_ID]: 'acknowledged' },
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => rig.channel.length > 0, 'the unanswered turn')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(HANDED_ID)], 'not answered, so offered once more')
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: a lane with no note after a /new it performed keeps the older turn out and does not perform the /new again', async () => {
  // Her /new (662) was performed and acknowledged, the lane posted its notice,
  // then the lane's folders were deleted. 661, from the conversation she left,
  // was never handed over and is not acknowledged.
  const OLD_ID = 661
  const NEW_COMMAND_ID = 662
  const backend = await startBackend({
    rows: [inboundRow(OLD_ID, 4, 'From the conversation she left'), inboundRow(NEW_COMMAND_ID, 3, '/new')],
    deliveryStates: { [OLD_ID]: 'delivered', [NEW_COMMAND_ID]: 'acknowledged' },
    agentRows: [{ id: NEW_COMMAND_ID + 1, text: LANE_NOTICES.new_session }],
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => backend.historyReads.length >= 2, 'the server asked')
    await sleep(3_500)
    assert.equal(rig.channel.length, 0, 'neither the older turn nor the /new reaches Claude')
    assert.equal(backend.acks.length, 0)
    const p = lanePaths({ home: rig.home, assistantId: ASSISTANT_ID, userId: USER_ID })
    assert.throws(() => readFileSync(p.restartRequestPath, 'utf8'), 'the /new is not performed again (no restart asked)')
    const saved = savedInbox(rig.home) as unknown as { delivered: number[]; newFrom?: number }
    assert.equal(saved.newFrom, NEW_COMMAND_ID, 'the /new is in the note again')
    assert.ok(saved.delivered.includes(OLD_ID) && saved.delivered.includes(NEW_COMMAND_ID))
  } finally {
    await stopLane(rig)
  }
})

test('bug 2: an acknowledged message whose answer the server cannot show is kept out, never re-answered', async () => {
  const OLD_ID = 671
  const NEW_ID = 673
  const backend = await startBackend({
    rows: [inboundRow(OLD_ID, 6, 'An earlier question'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [OLD_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
    agentRows: [{ id: OLD_ID + 1, text: 'The answer.' }],
    failAfterReadsOf: { [OLD_ID]: 1_000 },
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => rig.channel.length > 0, 'the new turn', 15_000)
    await sleep(1_500)
    assert.ok(backend.historyReads.some((h) => h.status === 500 && h.afterId === String(OLD_ID) && h.beforeId === null), 'the page after it could not be read')
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NEW_ID)], 'picked up, answer unknown: kept out')
  } finally {
    await stopLane(rig)
  }
})
