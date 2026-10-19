/**
 * A CHAT THE DAEMON FIRST READS AT CURSOR 0 LOSES NOTHING (0.71.10).
 *
 * Found by Data's review of architecture packet D04 (round 2, 2026-10-19),
 * confirmed on main 0375387. A chat whose cursor is 0 when the daemon reads it
 * (empty at boot, or an agent-to-agent or meeting chat that discoverChats adds
 * later) took the FIRST POLL branch of pollChat. That branch forwarded at most
 * 10 rows and then moved the cursor to the newest row, so every older row was
 * skipped without a word. A live message made it worse in three ways:
 *
 *   1. The socket treated a cursor of 0 as safe to jump, so one live message
 *      moved the cursor over rows no read had returned, and the next read
 *      could only re-offer 10 of them through restart recovery (and none at
 *      all once the agent had answered the live message).
 *   2. A live message that landed while a read was in flight moved the cursor
 *      under that read, which then dropped the rows it had just fetched (the
 *      cursor was read again AFTER the fetch).
 *   3. The agent's answer to that live message, written before the chat's
 *      next scheduled read (five minutes away with a healthy socket), ends the
 *      first read's walk back, so the rows under it were never forwarded.
 *      Reading the chat at once narrows that; the chat's live floor (every row
 *      from the first live message up is owed) closes it, for a read that
 *      fails and for a chat the inbox does not list yet as well.
 *   4. In any chat, a live message moved the cursor over an empty wake card
 *      (body not landed yet) that a read had returned and parked under.
 *
 * The rule every case here checks: each row a chat read reaches is forwarded
 * exactly once, whether the chat was empty at boot or primed, after a live
 * message and across a restart.
 *
 * Everything runs against the REAL daemon (a copy of server.ts under bun), a
 * stand in BGOS backend (http and socket.io) and a stand in for Claude Code
 * (an MCP client that collects the channel cards).
 *
 * Run with: npx tsx --test test/first-read-cursor-zero.e2e.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

const ROOT = join(import.meta.dirname, '..')
const BUN = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout ?? ''
const SKIP = process.platform === 'win32' ? 'posix only' : BUN ? false : 'needs bun'
const OPTS = { skip: SKIP, timeout: 150_000 }

const ASSISTANT_ID = 42
const PEER_ID = 947
const USER_ID = 'u1'
const MAIN = 501
const A2A = 601
const MEETING = 701
/** A chat the inbox never lists: the socket can still deliver into it. */
const ELSEWHERE = 888

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, what: string, ms = 25_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

/** Like waitFor, but a timeout is an outcome the assertions report, not an error. */
async function waitQuietly(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await sleep(25)
}

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

type Row = Record<string, unknown> & { id: number; chatId: number; sender: 'user' | 'assistant' | 'system'; text: string }

function ownerRow(chatId: number, id: number): Row {
  return { id, chatId, sender: 'user', text: `owner ${id}`, senderUserId: USER_ID, senderAssistantId: null, messageType: 'standard', sentDate: new Date().toISOString() }
}

/** This agent's own answer, as the backend stores it. */
function replyRow(chatId: number, id: number): Row {
  return { id, chatId, sender: 'assistant', text: `answer ${id}`, senderAssistantId: ASSISTANT_ID, messageType: 'standard', sentDate: new Date().toISOString() }
}

/** A peer agent's send_to_peer into the side thread: stored as sender 'user'. */
function peerRow(id: number): Row {
  return {
    id,
    chatId: A2A,
    sender: 'user',
    text: `peer ${id}`,
    senderAssistantId: PEER_ID,
    senderUserId: null,
    senderType: 'agent',
    agentOrigin: { sourceAssistantId: PEER_ID, sourceName: 'Milba', targetAssistantId: ASSISTANT_ID, peerConversationId: 4595, messageId: id },
    peerConversationId: 4595,
    turnState: 'expecting_reply',
    messageType: 'standard',
    sentDate: new Date().toISOString(),
  }
}

interface Read {
  chatId: number
  afterId: number | null
  ids: number[]
}

interface Backend {
  url: string
  rows: Row[]
  inbox: Array<Record<string, unknown>>
  meetings: Array<Record<string, unknown>>
  /** The daemon's poll reads (the ones that name the caller agent), as answered. */
  reads: Read[]
  readsOf: (chatId: number) => Read[]
  /** How many poll reads of a chat have ARRIVED (answered or not). */
  readsStarted: (chatId: number) => number
  /** Hold the NEXT poll read of a chat and run `during` before answering it. */
  holdNextRead: (chatId: number, during: () => Promise<void>) => void
  /** Answer the NEXT poll read of a chat with a 500. */
  failNextRead: (chatId: number) => void
  refuseSocket: (refuse: boolean) => void
  connected: () => number
  /** Store a row and push it live, as the backend does for a new message. */
  pushLive: (row: Row) => void
  /** Drop the daemon's socket: it reconnects and runs its catch up read. */
  cutSocket: () => void
  close: () => Promise<void>
}

async function startBackend(): Promise<Backend> {
  const rows: Row[] = []
  const inbox: Array<Record<string, unknown>> = [{ id: MAIN, assistantId: ASSISTANT_ID, kind: 'main', userId: USER_ID }]
  const meetings: Array<Record<string, unknown>> = []
  const reads: Read[] = []
  const started = new Map<number, number>()
  const holds = new Map<number, () => Promise<void>>()
  const failures = new Set<number>()
  let refuse = false

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume()
    const url = new URL(req.url ?? '/', 'http://backend')
    const path = url.pathname.replace(/^\/api\/v1\//, '')
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && path === 'peers/inbox') return json({ chats: inbox })
    if (req.method === 'GET' && path === 'meetings') return json(meetings)
    const history = /^chats\/(\d+)\/messages$/.exec(path)
    if (req.method === 'GET' && history) {
      const chatId = Number(history[1])
      // The poll names its agent; the boot sweeps for permission and plan
      // cards read the same route without it.
      const isPoll = req.headers['x-caller-assistant-id'] !== undefined
      if (isPoll) started.set(chatId, (started.get(chatId) ?? 0) + 1)
      const hold = isPoll ? holds.get(chatId) : undefined
      if (hold) {
        holds.delete(chatId)
        await hold()
      }
      if (isPoll && failures.delete(chatId)) return json({ message: 'stand in failure' }, 500)
      const afterParam = url.searchParams.get('afterId')
      const afterId = afterParam === null ? null : Number(afterParam)
      // The real route: the NEWEST 50 rows above the cursor, oldest first.
      const page = rows
        .filter((r) => r.chatId === chatId && r.id > (afterId ?? 0))
        .sort((a, b) => a.id - b.id)
        .slice(-50)
      if (isPoll) reads.push({ chatId, afterId, ids: page.map((r) => r.id) })
      return json({ messages: page.map((message) => ({ message, messageFiles: [], messageOptions: [] })) })
    }
    return json({})
  }

  const http = createServer((req, res) => {
    void handle(req, res)
  })
  // A refused handshake, which the client retries with backoff, like a
  // backend that is down. Not a namespace middleware error: the socket.io
  // client never retries one of those on its own.
  const io = new SocketServer(http, { allowRequest: (_req, callback) => callback(null, !refuse) })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`,
    rows,
    inbox,
    meetings,
    reads,
    readsOf: (chatId) => reads.filter((r) => r.chatId === chatId),
    readsStarted: (chatId) => started.get(chatId) ?? 0,
    holdNextRead: (chatId, during) => {
      holds.set(chatId, during)
    },
    failNextRead: (chatId) => {
      failures.add(chatId)
    },
    refuseSocket: (value) => {
      refuse = value
    },
    connected: () => io.of('/').sockets.size,
    pushLive: (row) => {
      rows.push(row)
      // A peer agent's message carries its origin on the socket as well.
      const { senderType, agentOrigin, peerConversationId, turnState } = row
      const peer = agentOrigin ? { senderType, agentOrigin, peerConversationId, turnState } : {}
      io.emit('inbound_message', { assistantId: ASSISTANT_ID, userId: USER_ID, chatId: row.chatId, messageId: row.id, text: row.text, files: [], messageType: 'standard', ...peer })
    },
    // A transport close, as a network drop or a proxy reload looks to the
    // daemon. Not io.disconnectSockets(): a server side disconnect is one the
    // socket.io client never reconnects from on its own.
    cutSocket: () => {
      for (const socket of io.of('/').sockets.values()) socket.conn.close()
    },
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  }
}

interface Rig {
  root: string
  home: string
  folder: string
  pluginRoot: string
}

function makeRig(backendUrl: string, cursors: Record<string, number>): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'first-read-')))
  const pluginRoot = join(root, 'plugin')
  const home = join(root, 'home')
  const folder = join(root, 'agent')
  for (const dir of [pluginRoot, folder, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json', '.claude-plugin']) {
    cpSync(join(ROOT, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(pluginRoot, 'node_modules'))
  writeFileSync(
    join(home, '.bgos-agent', `credentials-${ASSISTANT_ID}.json`),
    JSON.stringify({ backendUrl, pairingToken: 'TESTTOKEN', pairingId: 420, userId: USER_ID, assistantId: ASSISTANT_ID, homeDir: folder, homeSource: 'pairing' }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), `${ASSISTANT_ID}\n`)
  // A cursor file from an earlier life: this daemon has run before, so the
  // first-run gate (a genuine first install) is off, and a chat with no
  // cursor is one it has simply never read a row from.
  const cursorPath = join(home, '.bgos-plugin-state', String(ASSISTANT_ID), 'chat-cursors.json')
  mkdirSync(dirname(cursorPath), { recursive: true })
  writeFileSync(cursorPath, JSON.stringify({ v: 1, cursors }))
  return { root, home, folder, pluginRoot }
}

interface Card {
  chatId: number
  messageId: number
  transport: string
}

interface Daemon {
  cards: Card[]
  stderr: string[]
  client: Client
  stop: () => Promise<void>
}

async function startDaemon(rig: Rig): Promise<Daemon> {
  const cards: Card[] = []
  const stderr: string[] = []
  const transport = new StdioClientTransport({
    command: BUN,
    args: [join(rig.pluginRoot, 'server.ts')],
    cwd: rig.folder,
    env: {
      PATH: [dirname(BUN), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      HOME: rig.home,
      CLAUDE_CONFIG_DIR: join(rig.home, '.claude'),
      BGOS_LAUNCH_CWD: rig.folder,
      HOAI_BROWSER_HOST: 'off',
      BGOS_BOOT_HELLO: 'off',
      BGOS_AUTO_UPDATE: 'disabled',
    },
    stderr: 'pipe',
  })
  let partial = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const lines = (partial + String(chunk)).split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) if (line) stderr.push(line)
  })
  const client = new Client({ name: 'claude-code-stand-in', version: '0.0.0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async (n) => {
    if (n.method !== 'notifications/claude/channel') return
    const meta = ((n.params as { meta?: Record<string, string> } | undefined)?.meta ?? {})
    cards.push({ chatId: Number(meta.chat_id), messageId: Number(meta.message_id), transport: String(meta.transport) })
  }
  try {
    await client.connect(transport)
    await client.listTools()
    await waitFor(() => stderr.some((l) => l.includes('startup complete: polling armed')), 'the daemon to arm', 60_000)
  } catch (err) {
    // Never leave a daemon behind: it would keep the test file running.
    await client.close().catch(() => {})
    throw new Error(`${String(err)}; daemon stderr tail:\n${stderr.slice(-20).join('\n')}`)
  }
  return { cards, stderr, client, stop: () => client.close() }
}

/** Every message id handed to Claude in one chat, sorted, duplicates kept. */
function delivered(cards: Card[], chatId: number): number[] {
  return cards.filter((c) => c.chatId === chatId).map((c) => c.messageId).sort((a, b) => a - b)
}

function hasAll(cards: Card[], chatId: number, want: number[]): boolean {
  const got = new Set(delivered(cards, chatId))
  return want.every((id) => got.has(id))
}

/**
 * Wait for every wanted id (or give up after 30 s and let the assertion show
 * what arrived), then keep listening 1.5 s more so a second copy of any of
 * them would be caught too.
 */
async function settle(cards: () => Card[], chatId: number, want: number[]): Promise<void> {
  await waitQuietly(() => hasAll(cards(), chatId, want), 30_000)
  await sleep(1_500)
}

/**
 * A healthy daemon reads each chat three times right after boot: the boot
 * sweep, the first tick's full cycle and the catch up after the socket
 * connects. After that the next full cycle is five minutes away, so a row
 * written now is read only when the test makes a read happen.
 */
async function quietAfterBoot(backend: Backend, chatId: number): Promise<void> {
  await waitFor(() => backend.connected() > 0 && backend.readsOf(chatId).length >= 3, 'the boot reads to finish', 30_000)
  await sleep(300)
}

interface World {
  backend: Backend
  rig: Rig
  boot: () => Promise<Daemon>
  end: () => Promise<void>
}

async function world(cursors: Record<string, number> = { '999': 5 }): Promise<World> {
  const backend = await startBackend()
  const rig = makeRig(backend.url, cursors)
  const daemons: Daemon[] = []
  return {
    backend,
    rig,
    boot: async () => {
      const daemon = await startDaemon(rig)
      daemons.push(daemon)
      return daemon
    },
    end: async () => {
      for (const daemon of daemons) await daemon.stop().catch(() => {})
      await backend.close()
      rmSync(rig.root, { recursive: true, force: true })
    },
  }
}

describe('a chat first read at cursor 0 forwards every row it reaches, once', { concurrency: true }, () => {
  test('a chat empty at boot: 14 rows land unpushed, the next read forwards all 14', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, ids(101, 114))
      assert.deepEqual(delivered(d.cards, MAIN), ids(101, 114))
    } finally {
      await w.end()
    }
  })

  test('a chat empty at boot: a live message lands while the read is in flight, all 14 rows and the live one arrive once', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      w.backend.holdNextRead(MAIN, async () => {
        await waitFor(() => w.backend.connected() > 0, 'the socket to be back')
        w.backend.pushLive(ownerRow(MAIN, 200))
        await waitFor(() => d.cards.some((c) => c.messageId === 200), 'the live card')
      })
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, [...ids(101, 114), 200])
      assert.deepEqual(delivered(d.cards, MAIN), [...ids(101, 114), 200])
    } finally {
      await w.end()
    }
  })

  test('a chat empty at boot: a live message arrives before any read, it does not move the cursor over the 14 rows', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.pushLive(ownerRow(MAIN, 200))
      // And one into a chat this daemon never polls: delivered live, and it
      // must not start a read of a chat the inbox does not list.
      w.backend.pushLive(ownerRow(ELSEWHERE, 300))
      await waitFor(() => d.cards.some((c) => c.messageId === 200) && d.cards.some((c) => c.messageId === 300), 'the live cards')
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, [...ids(101, 114), 200])
      assert.deepEqual(delivered(d.cards, MAIN), [...ids(101, 114), 200])
      assert.deepEqual(delivered(d.cards, ELSEWHERE), [300])
      assert.equal(w.backend.readsOf(ELSEWHERE).length, 0, 'a live message never starts a read of a chat the daemon does not poll')
    } finally {
      await w.end()
    }
  })

  test('a chat empty at boot: the agent answers the live message before the next scheduled read, the 14 rows under it still arrive', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.pushLive(ownerRow(MAIN, 200))
      await waitFor(() => d.cards.some((c) => c.messageId === 200), 'the live card')
      // A model turn takes at least a second; the answer lands then.
      await sleep(1_000)
      w.backend.rows.push(replyRow(MAIN, 201))
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, [...ids(101, 114), 200])
      assert.deepEqual(delivered(d.cards, MAIN), [...ids(101, 114), 200])
    } finally {
      await w.end()
    }
  })

  test('a chat empty at boot: the read the live message starts fails, the agent answers, the next read still forwards all 14', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.failNextRead(MAIN)
      w.backend.pushLive(ownerRow(MAIN, 200))
      await waitFor(() => d.cards.some((c) => c.messageId === 200), 'the live card')
      await sleep(1_000)
      w.backend.rows.push(replyRow(MAIN, 201))
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, [...ids(101, 114), 200])
      assert.deepEqual(delivered(d.cards, MAIN), [...ids(101, 114), 200])
    } finally {
      await w.end()
    }
  })

  test('a chat empty at boot: a burst of live messages starts one read, and every row arrives once', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      let readsStartedDuringBurst = -1
      // The first live message starts a read, held here while five more
      // arrive: they must not start a read each.
      w.backend.holdNextRead(MAIN, async () => {
        const before = w.backend.readsStarted(MAIN)
        for (const id of ids(200, 204)) w.backend.pushLive(ownerRow(MAIN, id))
        await waitFor(() => hasAll(d.cards, MAIN, ids(200, 204)), 'the burst of live cards')
        await sleep(500)
        readsStartedDuringBurst = w.backend.readsStarted(MAIN) - before
      })
      w.backend.pushLive(ownerRow(MAIN, 199))
      await settle(() => d.cards, MAIN, [...ids(101, 114), ...ids(199, 204)])
      assert.deepEqual(delivered(d.cards, MAIN), [...ids(101, 114), ...ids(199, 204)])
      assert.equal(readsStartedDuringBurst, 0, 'one read in flight per chat, not one per live message')
    } finally {
      await w.end()
    }
  })

  test('a chat empty at boot: two reads overlap, the slower one still forwards a row that landed after the faster one', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      // Read A is the socket-down cycle's read, held here. Meanwhile the
      // socket comes back and its catch-up read B forwards the 14. Then a row
      // the socket misses lands, and the agent's answer to 114 right after
      // it, before A is answered.
      w.backend.holdNextRead(MAIN, async () => {
        w.backend.refuseSocket(false)
        await waitFor(() => hasAll(d.cards, MAIN, ids(101, 114)), 'the overlapping read to forward the 14', 60_000)
        w.backend.rows.push(ownerRow(MAIN, 115))
        w.backend.rows.push(replyRow(MAIN, 116))
      })
      w.backend.refuseSocket(true)
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, ids(101, 115))
      assert.deepEqual(delivered(d.cards, MAIN), ids(101, 115))
    } finally {
      await w.end()
    }
  })

  test('restart: a chat that had no cursor gets more than 10 rows while the daemon is down, the boot read forwards all of them', OPTS, async () => {
    const w = await world()
    try {
      const first = await w.boot()
      await waitFor(() => w.backend.readsOf(MAIN).length >= 1, 'the first life to read the empty chat')
      await first.stop()
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      const second = await w.boot()
      await settle(() => second.cards, MAIN, ids(101, 114))
      assert.deepEqual(delivered(second.cards, MAIN), ids(101, 114))
    } finally {
      await w.end()
    }
  })

  test('restart: after a live message into a chat nothing had read, and its answer, no row is lost across the restart', OPTS, async () => {
    const w = await world()
    try {
      const first = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.pushLive(ownerRow(MAIN, 200))
      await waitFor(() => first.cards.some((c) => c.messageId === 200), 'the live card')
      await sleep(1_000)
      w.backend.rows.push(replyRow(MAIN, 201))
      // A live session (one bgos tool call), so the cursor store persists on
      // the way out, then the restart.
      await first.client.callTool({ name: 'channel_ack', arguments: {} })
      await first.stop()
      const second = await w.boot()
      const both = () => [...first.cards, ...second.cards]
      await settle(both, MAIN, [...ids(101, 114), 200])
      assert.deepEqual(delivered(both(), MAIN), [...ids(101, 114), 200])
    } finally {
      await w.end()
    }
  })

  test('an agent-to-agent chat and a meeting chat that discoverChats adds mid run forward all 14 rows each', OPTS, async () => {
    const w = await world()
    try {
      // Socket refused: the daemon polls on its 10 s cycle, and every cycle
      // runs discoverChats.
      w.backend.refuseSocket(true)
      const d = await w.boot()
      await waitFor(() => w.backend.readsOf(MAIN).length >= 1, 'the boot read')
      for (const id of ids(1001, 1014)) w.backend.rows.push(peerRow(id))
      for (const id of ids(2001, 2014)) w.backend.rows.push(ownerRow(MEETING, id))
      w.backend.meetings.push({
        id: 55,
        chatId: MEETING,
        status: 'open',
        speakerPolicy: 'parallel',
        currentSpeakerId: null,
        title: 'Standup',
        participants: [{ id: ASSISTANT_ID, name: 'Echo' }, { id: PEER_ID, name: 'Milba' }],
      })
      w.backend.inbox.push({ id: A2A, assistantId: ASSISTANT_ID, kind: 'a2a' }, { id: MEETING, assistantId: PEER_ID, kind: 'meeting' })
      await waitQuietly(() => hasAll(d.cards, A2A, ids(1001, 1014)) && hasAll(d.cards, MEETING, ids(2001, 2014)), 30_000)
      await sleep(1_500)
      assert.deepEqual(
        { a2a: delivered(d.cards, A2A), meeting: delivered(d.cards, MEETING) },
        { a2a: ids(1001, 1014), meeting: ids(2001, 2014) },
      )
    } finally {
      await w.end()
    }
  })

  test('an agent-to-agent chat the inbox does not list yet: the rows the socket missed around its answered live messages arrive once discoverChats lists it', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      // The peer writes five messages the socket misses, then one it pushes;
      // the agent answers that one. Then one more the socket misses, one it
      // pushes, and the answer to it. The daemon polls none of this yet.
      for (const id of ids(101, 105)) w.backend.rows.push(peerRow(id))
      w.backend.pushLive(peerRow(200))
      await waitFor(() => d.cards.some((c) => c.messageId === 200), 'the first live card')
      w.backend.rows.push(replyRow(A2A, 201))
      w.backend.rows.push(peerRow(202))
      w.backend.pushLive(peerRow(203))
      await waitFor(() => d.cards.some((c) => c.messageId === 203), 'the second live card')
      w.backend.rows.push(replyRow(A2A, 204))
      assert.equal(w.backend.readsOf(A2A).length, 0, 'nothing has read the chat yet')
      // Now the inbox lists it. With the socket down the daemon runs a full
      // cycle (discoverChats, then every chat) every 10 s.
      w.backend.inbox.push({ id: A2A, assistantId: ASSISTANT_ID, kind: 'a2a' })
      w.backend.refuseSocket(true)
      w.backend.cutSocket()
      await settle(() => d.cards, A2A, [...ids(101, 105), 200, 202, 203])
      assert.deepEqual(delivered(d.cards, A2A), [...ids(101, 105), 200, 202, 203])
    } finally {
      await w.end()
    }
  })

  /** A chat with a cursor: ten rows of answered history up to 100. */
  function primedHistory(w: World): void {
    for (const id of ids(91, 100)) w.backend.rows.push(id % 2 === 1 ? ownerRow(MAIN, id) : replyRow(MAIN, id))
  }

  test('control, a primed chat: 14 rows land unpushed, the next read forwards all 14 once', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primedHistory(w)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, ids(101, 114))
      assert.deepEqual(delivered(d.cards, MAIN), ids(101, 114))
    } finally {
      await w.end()
    }
  })

  test('a primed chat: a read returned a wake card whose body had not landed, a live message does not move the cursor over it', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primedHistory(w)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      // A scheduler wake card in its first write: the row exists, its body
      // does not yet. The read returns it and parks the cursor under it.
      const wake: Row = { id: 101, chatId: MAIN, sender: 'system', text: '', messageType: 'event', sentDate: new Date().toISOString() }
      w.backend.rows.push(wake)
      w.backend.cutSocket()
      await waitFor(() => w.backend.readsOf(MAIN).some((r) => r.ids.includes(101)), 'a read that returns the empty wake card')
      await sleep(300)
      w.backend.pushLive(ownerRow(MAIN, 102))
      await waitFor(() => d.cards.some((c) => c.messageId === 102), 'the live card')
      // The body lands (same row id), and the next read must pick it up.
      wake.text = 'wake: check the build'
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, [101, 102])
      assert.deepEqual(delivered(d.cards, MAIN), [101, 102])
    } finally {
      await w.end()
    }
  })

  test('a primed chat: a live message lands while the read is in flight, the rows that read fetched are still forwarded', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primedHistory(w)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      w.backend.holdNextRead(MAIN, async () => {
        await waitFor(() => w.backend.connected() > 0, 'the socket to be back')
        w.backend.pushLive(ownerRow(MAIN, 200))
        await waitFor(() => d.cards.some((c) => c.messageId === 200), 'the live card')
      })
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, [...ids(101, 114), 200])
      assert.deepEqual(delivered(d.cards, MAIN), [...ids(101, 114), 200])
    } finally {
      await w.end()
    }
  })
})
