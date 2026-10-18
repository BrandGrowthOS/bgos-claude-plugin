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
 *      server knows which of them a Claude of this lane was already handed
 *      (the lane acked it, `deliveryState: acknowledged` on the person's chat
 *      history), so the boot poll asks it and hands over only the rest; when
 *      the server cannot say, it hands over nothing yet and asks again.
 *
 * And what must not change: a relaunch WITH its note still re-offers the turn
 * its last life left unanswered (the server has that one acknowledged too),
 * once, and a `/new` performed during the boot fetch still keeps that turn
 * out of the new conversation.
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

import { laneDaemonEnv, lanePaths, personLaneStamp } from '../lib/lane-core.mjs'

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
    // Her chat history, the route a lane may read for its own chats; each
    // row carries the server's delivery state.
    const history = /^chats\/(\d+)\/messages$/.exec(path)
    if (req.method === 'GET' && history) {
      const afterId = url.searchParams.get('afterId')
      const beforeId = url.searchParams.get('beforeId')
      if (opts.forbiddenChats?.includes(Number(history[1]))) {
        state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 403 })
        return json(res, { message: 'not this lane' }, 403)
      }
      if (historyFailuresLeft > 0) {
        historyFailuresLeft -= 1
        state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 500 })
        return json(res, { message: 'stand in failure' }, 500)
      }
      state.historyReads.push({ chatId: Number(history[1]), afterId, beforeId, status: 200 })
      const after = afterId === null ? 0 : Number(afterId)
      const before = beforeId === null ? Number.POSITIVE_INFINITY : Number(beforeId)
      const messages = opts.rows
        .filter((r) => Number(r.chat_id) === Number(history[1]) && Number(r.id) > after && Number(r.id) < before)
        .map((r) => ({ id: Number(r.id), chatId: Number(r.chat_id), sender: 'user', text: r.text, deliveryState: opts.deliveryStates?.[Number(r.id)] ?? 'delivered' }))
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

test('bug 2: when the server cannot say what was handed over, the lane hands over nothing yet and asks again', async () => {
  const OLD_ID = 601
  const NEW_ID = 603
  const backend = await startBackend({
    rows: [inboundRow(OLD_ID, 6, 'An earlier question, already answered'), inboundRow(NEW_ID, 1, 'A new question')],
    deliveryStates: { [OLD_ID]: 'acknowledged', [NEW_ID]: 'delivered' },
    historyFailures: 1,
  })
  const rig = await startLane(backend)
  try {
    await waitFor(() => backend.historyReads.some((h) => h.status === 500), 'the failed history read')
    // Past the settle: a turn that was going to go out has gone out.
    await sleep(3_000)
    assert.equal(rig.channel.length, 0, 'nothing handed over while the server could not say')
    assert.equal(backend.acks.length, 0, 'and nothing acknowledged')
    // The next boot poll (here: the server cuts the socket and the lane
    // reconnects, which polls at once) asks again and hands over the new one.
    backend.io.disconnectSockets(true)
    await waitFor(() => rig.channel.length > 0, 'the new turn after the retry')
    await waitFor(() => backend.acks.length > 0, 'the ack')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NEW_ID)])
    assert.deepEqual(backend.acks, [NEW_ID])
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
