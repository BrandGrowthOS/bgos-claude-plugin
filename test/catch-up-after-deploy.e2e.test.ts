/**
 * THE PLUGIN CATCHES UP AFTER EVERY DEPLOY (D04-1, board row 62fa8e83).
 *
 * When the server restarts or the daemon reconnects, every message the agent
 * missed reaches it exactly once, in order, however many there are. The cases
 * follow the D04 report's measurements (PL1 to PL4), which another lane took
 * on the real routes before any of this was fixed:
 *
 *   HOLE 1, the reconnect skip (PL2): a live message after a reconnect moved
 *   the cursor over rows no read had returned, 0 of N.
 *   HOLE 2, the newest 50 (PL1): the daemon never paged and the cursor went to
 *   the newest id returned, so 51 rows lost 1 and 80 lost 30, on the delta read
 *   and on the boot read.
 *   HOLE 3, a chat that started empty (PL4): a chat read empty got no cursor,
 *   so its next read was a first read, capped by the newest 50, stopped by any
 *   agent row, and for a group capped at 10 across a restart.
 *   HOLE 4, a row never pushed (PL3): one live message moved the read position
 *   over it, with no outage at all.
 *
 * Everything runs against the REAL daemon (a copy of server.ts under bun), a
 * stand in BGOS inside this file (http and socket.io) and a stand in for Claude
 * Code (an MCP client that collects the channel cards, in arrival order). No
 * real service is called.
 *
 * THE STAND IN'S READ IS THE REAL ROUTE'S, each rule from BGOS fc9e3bc853:
 *   - the NEWEST `limit` rows in the range, returned oldest first
 *     (backend/src/repository/message.repository.ts:4916-4919: inner ORDER BY
 *     m.id DESC LIMIT n, outer ORDER BY id ASC);
 *   - limit defaults to 50 and is clamped to 1..200 (:3996);
 *   - afterId and beforeId combine, and afterId 0 means no bound (:4582-4589);
 *   - withPagination adds hasMore from a probe row, and nextCursor, the page's
 *     oldest id or null (:4017, services/message.service.ts getMessages);
 *   - ids come from one counter shared by every chat (the report's rule for
 *     agent experiments);
 *   - a read answers 304 to its own If-None-Match (report PL2, Express's weak
 *     ETag over the body), so a rig with no 304 would hide a validator bug.
 *
 * Run with: npx tsx --test test/catch-up-after-deploy.e2e.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

const ROOT = join(import.meta.dirname, '..')
const BUN = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout ?? ''
const SKIP = process.platform === 'win32' ? 'posix only' : BUN ? false : 'needs bun'
const OPTS = { skip: SKIP, timeout: 240_000 }

const ASSISTANT_ID = 42
const PEER_ID = 947
const USER_ID = 'u1'
const MAIN = 501
const SECOND = 502
const A2A = 601
const GROUP = 801

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, what: string, ms = 60_000): Promise<void> {
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

const nowIso = () => new Date().toISOString()

function ownerRow(chatId: number, id: number, sentDate = nowIso()): Row {
  return { id, chatId, sender: 'user', text: `owner ${id}`, senderUserId: USER_ID, senderAssistantId: null, messageType: 'standard', sentDate }
}

/** Another person in a group chat, not the owner. */
function otherPersonRow(chatId: number, id: number, userId: string): Row {
  return { id, chatId, sender: 'user', text: `${userId} says ${id}`, senderUserId: userId, senderAssistantId: null, messageType: 'standard', sentDate: nowIso() }
}

/** This agent's own answer, as the backend stores it. */
function replyRow(chatId: number, id: number, sentDate = nowIso()): Row {
  return { id, chatId, sender: 'assistant', text: `answer ${id}`, senderAssistantId: ASSISTANT_ID, messageType: 'standard', sentDate }
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
    sentDate: nowIso(),
  }
}

/** A machine card written by a route that never pushes it live (report PL3). */
function systemRow(chatId: number, id: number, text: string): Row {
  return { id, chatId, sender: 'system', text, messageType: 'event', sentDate: nowIso() }
}

interface Read {
  chatId: number
  afterId: number | null
  beforeId: number | null
  limit: number | null
  paged: boolean
  ifNoneMatch: string | null
  status: number
  ids: number[]
  startedAt: number
}

const isContinuation = (r: Pick<Read, 'beforeId'>) => r.beforeId !== null

interface Backend {
  url: string
  rows: Row[]
  inbox: Array<Record<string, unknown>>
  /** The daemon's poll reads (the ones that name the caller agent), as answered. */
  reads: Read[]
  readsOf: (chatId: number) => Read[]
  /**
   * Hold the next poll read of a chat that matches, and run `during` before
   * answering it. Its rows are taken when it ARRIVES, as a database read
   * would, so a row written during the hold is one this read did not see.
   */
  holdRead: (chatId: number, match: (r: Read) => boolean, during: () => Promise<void>) => void
  /** Answer the next poll read of a chat that matches with a 500. */
  failRead: (chatId: number, match: (r: Read) => boolean) => void
  pending: () => { holds: number; failures: number; holdErrors: string[] }
  refuseSocket: (refuse: boolean) => void
  connected: () => number
  lastConnectAt: () => number
  /** Run once, as soon as the daemon's socket next connects. */
  onNextConnect: (run: () => void) => void
  /** Store a row and push it live, as the backend does for a new message. */
  pushLive: (row: Row) => void
  /** Drop the daemon's socket at the transport, as a deploy does. */
  cutSocket: () => void
  /** Stop outgoing packets without notifying the connected daemon. */
  silenceSocket: () => void
  close: () => Promise<void>
}

async function startBackend(): Promise<Backend> {
  const rows: Row[] = []
  const inbox: Array<Record<string, unknown>> = [{ id: MAIN, assistantId: ASSISTANT_ID, kind: 'main', userId: USER_ID }]
  const reads: Read[] = []
  const holds: Array<{ chatId: number; match: (r: Read) => boolean; during: () => Promise<void> }> = []
  const failures: Array<{ chatId: number; match: (r: Read) => boolean }> = []
  const holdErrors: string[] = []
  let connectHook: (() => void) | null = null
  let refuse = false
  let lastConnectAt = 0

  /** The real route's page. See the file header for the lines each rule comes from. */
  function historyPage(chatId: number, q: { afterId: number | null; beforeId: number | null; limit: number | null; paged: boolean }) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
    const inRange = rows
      .filter((r) => r.chatId === chatId && (!q.afterId || r.id > q.afterId) && (!q.beforeId || r.id < q.beforeId))
      .sort((a, b) => a.id - b.id)
    const wire = (list: Row[]) => list.map((message) => ({ message, messageFiles: [], messageOptions: (message.options as unknown[] | undefined) ?? [] }))
    if (!q.paged) return { list: inRange.slice(-limit), body: (list: Row[]) => ({ messages: wire(list) }) }
    const probe = inRange.slice(-(limit + 1))
    const hasMore = probe.length === limit + 1
    const page = hasMore ? probe.slice(1) : probe
    return {
      list: page,
      body: (list: Row[]) => ({ messages: wire(list), hasMore, nextCursor: hasMore && list.length > 0 ? list[0]!.id : null }),
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume()
    const url = new URL(req.url ?? '/', 'http://backend')
    const path = url.pathname.replace(/^\/api\/v1\//, '')
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && path === 'peers/inbox') return json({ chats: inbox })
    if (req.method === 'GET' && path === 'meetings') return json([])
    const history = /^chats\/(\d+)\/messages$/.exec(path)
    if (req.method === 'GET' && history) {
      const chatId = Number(history[1])
      const numberParam = (name: string) => {
        const raw = url.searchParams.get(name)
        return raw === null ? null : Number(raw)
      }
      const withPagination = url.searchParams.get('withPagination')
      const q = {
        afterId: numberParam('afterId'),
        beforeId: numberParam('beforeId'),
        limit: numberParam('limit'),
        paged: withPagination === '1' || withPagination === 'true',
      }
      // The poll names its agent; the boot sweeps for permission and plan
      // cards read the same route without it.
      const isPoll = req.headers['x-caller-assistant-id'] !== undefined
      const ifNoneMatch = (req.headers['if-none-match'] as string | undefined) ?? null
      const startedAt = Date.now()
      const page = historyPage(chatId, q)
      const list = [...page.list]
      const record: Read = { chatId, ...q, ifNoneMatch, status: 0, ids: list.map((r) => r.id), startedAt }
      if (isPoll) {
        const held = holds.findIndex((h) => h.chatId === chatId && h.match(record))
        if (held >= 0) {
          const [hold] = holds.splice(held, 1)
          // A hold that throws must still let the read be answered, or the
          // daemon waits on it; the test then fails on the recorded error.
          await hold!.during().catch((err: unknown) => {
            holdErrors.push(String(err))
          })
        }
        const failing = failures.findIndex((f) => f.chatId === chatId && f.match(record))
        if (failing >= 0) {
          failures.splice(failing, 1)
          record.status = 500
          reads.push(record)
          return json({ message: 'stand in failure' }, 500)
        }
      }
      const body = JSON.stringify(page.body(list))
      const etag = `W/"${Buffer.byteLength(body).toString(16)}-${createHash('sha1').update(body).digest('base64').slice(0, 27)}"`
      record.status = ifNoneMatch === etag ? 304 : 200
      if (isPoll) reads.push(record)
      if (record.status === 304) {
        res.writeHead(304, { ETag: etag })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag })
      res.end(body)
      return
    }
    return json({})
  }

  const http = createServer((req, res) => {
    void handle(req, res)
  })
  // A refused handshake, which the client retries with backoff, like a backend
  // that is down.
  const io = new SocketServer(http, { pingInterval: 10_000, pingTimeout: 30_000, allowRequest: (_req, callback) => callback(null, !refuse) })
  io.on('connection', () => {
    lastConnectAt = Date.now()
    const run = connectHook
    connectHook = null
    run?.()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`,
    rows,
    inbox,
    reads,
    readsOf: (chatId) => reads.filter((r) => r.chatId === chatId),
    holdRead: (chatId, match, during) => {
      holds.push({ chatId, match, during })
    },
    failRead: (chatId, match) => {
      failures.push({ chatId, match })
    },
    pending: () => ({ holds: holds.length, failures: failures.length, holdErrors: [...holdErrors] }),
    refuseSocket: (value) => {
      refuse = value
    },
    connected: () => io.of('/').sockets.size,
    lastConnectAt: () => lastConnectAt,
    onNextConnect: (run) => {
      connectHook = run
    },
    pushLive: (row) => {
      rows.push(row)
      const { senderType, agentOrigin, peerConversationId, turnState } = row
      const peer = agentOrigin ? { senderType, agentOrigin, peerConversationId, turnState } : {}
      io.emit('inbound_message', { assistantId: ASSISTANT_ID, userId: USER_ID, chatId: row.chatId, messageId: row.id, text: row.text, files: [], messageType: 'standard', ...peer })
    },
    // Not io.disconnectSockets(): a server side disconnect is one the
    // socket.io client never reconnects from on its own.
    cutSocket: () => {
      for (const socket of io.of('/').sockets.values()) socket.conn.close()
    },
    silenceSocket: () => {
      for (const socket of io.of('/').sockets.values()) {
        socket.conn.transport.send = () => {}
      }
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

/** `cursors` null: no cursor file at all, a genuine first install. */
function makeRig(backendUrl: string, cursors: Record<string, number> | null): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'catch-up-')))
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
  if (cursors) {
    const cursorPath = join(home, '.bgos-plugin-state', String(ASSISTANT_ID), 'chat-cursors.json')
    mkdirSync(dirname(cursorPath), { recursive: true })
    writeFileSync(cursorPath, JSON.stringify({ v: 1, cursors }))
  }
  return { root, home, folder, pluginRoot }
}

interface Card {
  chatId: number
  messageId: number
  transport: string
  content: string
  backlog: boolean
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
      // A held read must not hit the daemon's own HTTP deadline while a case
      // waits on a reconnect backoff.
      BGOS_HTTP_TIMEOUT_MS: '120000',
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
    const params = (n.params ?? {}) as { meta?: Record<string, string>; content?: unknown }
    const meta = params.meta ?? {}
    cards.push({ chatId: Number(meta.chat_id), messageId: Number(meta.message_id), transport: String(meta.transport), content: String(params.content ?? ''), backlog: meta.backlog === 'true' })
  }
  try {
    await client.connect(transport)
    await client.listTools()
    await waitFor(() => stderr.some((l) => l.includes('startup complete: polling armed')), 'the daemon to arm', 60_000)
  } catch (err) {
    await client.close().catch(() => {})
    throw new Error(`${String(err)}; daemon stderr tail:\n${stderr.slice(-20).join('\n')}`)
  }
  return { cards, stderr, client, stop: () => client.close() }
}

/** Every message id handed to Claude in one chat, in the order it arrived. */
function arrived(cards: Card[], chatId: number): number[] {
  return cards.filter((c) => c.chatId === chatId).map((c) => c.messageId)
}

/** 101,102,103,150 reads as 101-103,150, so a red run says what was lost. */
function ranges(list: number[]): string {
  const sorted = [...list].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    out.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return out.join(',') || 'none'
}

/** The rule every case checks: each wanted row once, oldest first, nothing else. */
function assertExactlyOnceInOrder(got: number[], want: number[], label: string): void {
  const wanted = new Set(want)
  const seen = new Set<number>()
  const repeated: number[] = []
  for (const id of got) {
    if (seen.has(id)) repeated.push(id)
    seen.add(id)
  }
  const inOrder = got.every((id, i) => i === 0 || got[i - 1]! < id)
  assert.deepEqual(
    {
      label,
      forwarded: `${seen.size} of ${want.length}`,
      missing: ranges(want.filter((id) => !seen.has(id))),
      unexpected: ranges([...seen].filter((id) => !wanted.has(id))),
      twice: ranges(repeated),
      oldestFirst: inOrder,
    },
    { label, forwarded: `${want.length} of ${want.length}`, missing: 'none', unexpected: 'none', twice: 'none', oldestFirst: true },
  )
}

function hasAll(cards: Card[], chatId: number, want: number[]): boolean {
  const got = new Set(arrived(cards, chatId))
  return want.every((id) => got.has(id))
}

/**
 * Wait for every wanted id (or give up and let the assertion show what
 * arrived), then keep listening so a second copy of any of them is caught too.
 */
async function settle(cards: () => Card[], chatId: number, want: number[], ms = 45_000): Promise<void> {
  await waitQuietly(() => hasAll(cards(), chatId, want), ms)
  await sleep(1_500)
}

/**
 * A healthy daemon reads each chat three times right after boot: the boot
 * sweep, the first tick's full cycle and the catch up after the socket
 * connects. After that the next full cycle is five minutes away, so a row
 * written now is read only when the test makes a read happen.
 */
async function quietAfterBoot(backend: Backend, ...chatIds: number[]): Promise<void> {
  await waitFor(
    () => backend.connected() > 0 && chatIds.every((chatId) => backend.readsOf(chatId).filter((r) => !isContinuation(r)).length >= 3),
    'the boot reads to finish',
  )
  await sleep(300)
}

/** Drop the socket, and wait until a read that started after it came back has been answered. */
async function reconnectAndRead(backend: Backend, chatId: number, ms = 45_000): Promise<void> {
  const cutAt = Date.now()
  backend.cutSocket()
  await waitQuietly(() => {
    const back = backend.lastConnectAt()
    return back > cutAt && backend.readsOf(chatId).some((r) => r.startedAt >= back)
  }, ms)
}

/** Every hold and planned failure was used, and no hold threw. */
function assertHarnessRan(backend: Backend): void {
  assert.deepEqual(backend.pending(), { holds: 0, failures: 0, holdErrors: [] }, 'the read hooks of this case all ran')
}

interface World {
  backend: Backend
  rig: Rig
  boot: () => Promise<Daemon>
  end: () => Promise<void>
}

async function world(cursors: Record<string, number> | null = { '999': 5 }): Promise<World> {
  const backend = await startBackend()
  let rig: Rig
  try {
    rig = makeRig(backend.url, cursors)
  } catch (err) {
    await backend.close()
    throw err
  }
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

const lockOf = (rig: Rig) => join(rig.home, '.bgos-agent', `credentials-${ASSISTANT_ID}.json.lock`)

/** Another daemon holding the pairing lock, its heartbeat fresh until `stop`. */
function rivalForLock(rig: Rig): { start: () => void; stop: () => Promise<void> } {
  let alive = false
  let beating: Promise<void> = Promise.resolve()
  const write = () => writeFileSync(lockOf(rig), JSON.stringify({ pid: process.pid, heartbeatAt: Date.now(), bootedAt: Date.now() }))
  return {
    start: () => {
      alive = true
      write()
      beating = (async () => {
        while (alive) {
          write()
          await sleep(1_000)
        }
      })()
    },
    stop: async () => {
      alive = false
      await beating
    },
  }
}

/** A chat with a cursor at 100: one answered exchange at or below it. */
function primed(backend: Backend, chatId: number, first: number): void {
  backend.rows.push(ownerRow(chatId, first), replyRow(chatId, first + 1))
}

describe('hole 1: the reconnect skip', { concurrency: 3 }, () => {
  test('a silent link triggers recovery and overlapping replay delivers every missed row once', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      w.backend.pushLive(ownerRow(MAIN, 101))
      await waitFor(() => hasAll(d.cards, MAIN, [101]), 'the live row before silence')
      w.backend.silenceSocket()
      const missed = ids(102, 108)
      for (const id of missed) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.onNextConnect(() => {
        // Replay a previously delivered row and race a fresh live row against
        // the actual daemon's reconnect catch-up read.
        w.backend.pushLive(ownerRow(MAIN, 101))
        w.backend.pushLive(ownerRow(MAIN, 200))
      })
      await waitFor(() => d.stderr.some((line) => line.includes('WS dead link:')), 'client liveness detection', 17_000)
      await settle(() => d.cards, MAIN, [101, ...missed, 200])
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), [101, ...missed, 200], 'silent transport catch-up')
      assert.equal(d.stderr.filter((line) => line.includes('WS dead link:')).length, 1)
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('rows missed around a deploy, then a live message beats the catch up read: every row once, oldest first', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const missed = ids(101, 107)
      for (const id of missed) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.onNextConnect(() => w.backend.pushLive(ownerRow(MAIN, 200)))
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, [...missed, 200])
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), [...missed, 200], 'PL2: 7 missed rows and one live')
    } finally {
      await w.end()
    }
  })

  test('the catch up read fails, then a live message: the rows under it are still read, every row once', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const missed = ids(101, 107)
      for (const id of missed) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.failRead(MAIN, () => true)
      w.backend.cutSocket()
      await waitFor(() => w.backend.pending().failures === 0, 'the failed catch up read')
      await sleep(200)
      assert.deepEqual(arrived(d.cards, MAIN), [], 'nothing has been read yet')
      w.backend.pushLive(ownerRow(MAIN, 200))
      await settle(() => d.cards, MAIN, [...missed, 200])
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), [...missed, 200], 'a failed read is not a catch up')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('the read a live message waits for fails: the message goes through, and the rows under it still arrive, each once', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 99)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const missed = ids(101, 107)
      for (const id of missed) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.failRead(MAIN, () => true)
      w.backend.onNextConnect(() => w.backend.pushLive(ownerRow(MAIN, 200)))
      w.backend.cutSocket()
      await settle(() => d.cards, MAIN, [...missed, 200])
      // The one case that gives up the order: a live message does not wait on a
      // server that cannot answer. Nothing is lost and nothing comes twice.
      assert.deepEqual([...arrived(d.cards, MAIN)].sort((a, b) => a - b), [...missed, 200])
      assert.equal(d.cards.find((c) => c.messageId === 200)?.transport, 'ws', 'it did not wait')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('a read that started before the socket came back is not the catch up: rows it could not see still arrive before a live message', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const missed = ids(101, 107)
      let backAt = 0
      // The socket down sweep's read takes its rows (none) and is held. The
      // rows land after that, the socket comes back, and only then is the read
      // answered: it finishes on the new connection and saw none of them.
      w.backend.holdRead(MAIN, () => true, async () => {
        for (const id of missed) w.backend.rows.push(ownerRow(MAIN, id))
        const heldAt = Date.now()
        w.backend.refuseSocket(false)
        await waitFor(() => w.backend.lastConnectAt() > heldAt && w.backend.connected() > 0, 'the socket to be back', 90_000)
        backAt = Date.now()
      })
      w.backend.refuseSocket(true)
      w.backend.cutSocket()
      await waitFor(() => backAt > 0, 'the held read to be released', 120_000)
      await sleep(50)
      w.backend.pushLive(ownerRow(MAIN, 200))
      await settle(() => d.cards, MAIN, [...missed, 200])
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), [...missed, 200], 'a read from before the reconnect')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('a live message does not overtake one that still waits for a read', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    let openSweep = () => {}
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const waits = (id: number) => waitFor(() => d.stderr.some((l) => l.includes(`Live message ${id} `)), `message ${id} to wait`, 30_000)
      const cutAt = Date.now()
      // The connect's own read stays open, so the chat stays behind this
      // connection until the first live message starts a read of its own.
      const sweepOpen = new Promise<void>((resolve) => {
        openSweep = resolve
      })
      w.backend.holdRead(MAIN, () => w.backend.lastConnectAt() > cutAt, () => sweepOpen)
      w.backend.cutSocket()
      await waitFor(() => w.backend.pending().holds === 0, 'the read the connect starts', 90_000)
      // 201 starts a read. 202 lands during it, so it waits for the next read.
      // That read starts with the chat caught up, and 203 lands during it.
      w.backend.holdRead(MAIN, (r) => r.ids.includes(201), async () => {
        w.backend.pushLive(ownerRow(MAIN, 202))
        await waits(202)
        w.backend.holdRead(MAIN, (r) => r.ids.includes(202), async () => {
          w.backend.pushLive(ownerRow(MAIN, 203))
          await sleep(500)
        })
      })
      w.backend.pushLive(ownerRow(MAIN, 201))
      const want = [201, 202, 203]
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'three live messages, each landing during the last one\'s read')
      openSweep()
      assertHarnessRan(w.backend)
    } finally {
      openSweep()
      await w.end()
    }
  })

  test('a daemon that stood down and took the lock back: a row of the passive spell goes before the next live message', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const rival = rivalForLock(w.rig)
      rival.start()
      await waitFor(() => d.stderr.some((l) => l.includes('standing down to passive')), 'the daemon to stand down', 30_000)
      // Written while this daemon ignored its socket. The socket never dropped,
      // so nothing else says this chat is behind.
      w.backend.rows.push(ownerRow(MAIN, 101))
      await rival.stop()
      rmSync(lockOf(w.rig), { force: true })
      await waitFor(() => d.stderr.some((l) => l.includes('delivery re-armed')), 'the daemon to take the lock back', 60_000)
      w.backend.pushLive(ownerRow(MAIN, 102))
      await settle(() => d.cards, MAIN, [101, 102])
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), [101, 102], 'a passive spell, then a live message')
    } finally {
      await w.end()
    }
  })

  test('a live message behind a failed boot read is framed live, and the rows under it as backlog', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const missed = ids(101, 120)
      for (const id of missed) w.backend.rows.push(ownerRow(MAIN, id))
      // The boot read fails, so the socket comes up with this chat still unread
      // and the read the live message waits for is a boot read.
      w.backend.failRead(MAIN, () => w.backend.connected() === 0)
      w.backend.onNextConnect(() => w.backend.pushLive(ownerRow(MAIN, 900)))
      // The read answers only once the frame has reached the daemon.
      let booted: Daemon | null = null
      w.backend.holdRead(MAIN, () => w.backend.connected() > 0, async () => {
        await waitFor(() => booted?.stderr.some((l) => l.includes('Live message 900 ')) === true, 'the live message to wait for this read', 30_000)
      })
      const d = await w.boot()
      booted = d
      const want = [...missed, 900]
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'a live message behind a boot read')
      assert.deepEqual(
        d.cards.filter((c) => c.chatId === MAIN && c.backlog).map((c) => c.messageId),
        missed,
        'only the rows the daemon missed are framed as backlog',
      )
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })
})

describe('the healthy path stays as it was', { concurrency: 3 }, () => {
  test('a chat caught up on this connection: a live message goes straight over the socket, and costs no read', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 99)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      await waitFor(() => w.backend.lastConnectAt() > 0, 'the socket')
      const readsBefore = w.backend.readsOf(MAIN).length
      for (const id of ids(201, 205)) w.backend.pushLive(ownerRow(MAIN, id))
      await settle(() => d.cards, MAIN, ids(201, 205), 15_000)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), ids(201, 205), 'live traffic')
      assert.ok(
        d.cards.filter((c) => c.chatId === MAIN).every((c) => c.transport === 'ws'),
        'over the socket',
      )
      assert.equal(w.backend.readsOf(MAIN).length, readsBefore, 'a live message into a caught up chat starts no read')
    } finally {
      await w.end()
    }
  })
})

describe('hole 2: the newest 50', { concurrency: 3 }, () => {
  test('a deploy with more than 50 missed rows in each of several chats: every row once, oldest first, in every chat', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100, [A2A]: 100, [GROUP]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      primed(w.backend, A2A, 93)
      primed(w.backend, GROUP, 95)
      w.backend.inbox.push({ id: A2A, assistantId: ASSISTANT_ID, kind: 'a2a' }, { id: GROUP, assistantId: ASSISTANT_ID, kind: 'group', userId: USER_ID })
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN, A2A, GROUP)
      // One id counter across the chats, the rows interleaved, as in production.
      const want = new Map<number, number[]>([[MAIN, []], [A2A, []], [GROUP, []]])
      let id = 1000
      const left = new Map<number, number>([[MAIN, 120], [A2A, 51], [GROUP, 260]])
      while ([...left.values()].some((n) => n > 0)) {
        for (const [chatId, n] of left) {
          if (n === 0) continue
          id += 1
          left.set(chatId, n - 1)
          want.get(chatId)!.push(id)
          w.backend.rows.push(chatId === A2A ? peerRow(id) : chatId === GROUP ? otherPersonRow(GROUP, id, id % 2 ? 'u7' : 'u8') : ownerRow(MAIN, id))
        }
      }
      w.backend.cutSocket()
      const everyChat = () => [...want].every(([chatId, rows]) => hasAll(d.cards, chatId, rows))
      await waitQuietly(everyChat, 60_000)
      await sleep(1_500)
      for (const [chatId, rows] of want) assertExactlyOnceInOrder(arrived(d.cards, chatId), rows, `chat ${chatId}`)
    } finally {
      await w.end()
    }
  })

  test('the boot read: 120 rows above a persisted cursor all arrive once, oldest first, framed as backlog', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const want = ids(101, 220)
      for (const id of want) w.backend.rows.push(ownerRow(MAIN, id))
      const d = await w.boot()
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'PL1: the first poll after a restart')
      assert.ok(d.cards.every((c) => c.backlog), 'handed over as offline backlog')
    } finally {
      await w.end()
    }
  })

  test('the limit is 50 rows of any sender: 60 rows of owner and agent turns lose no owner row', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const want: number[] = []
      for (const id of ids(101, 160)) {
        if (id % 2 === 1) {
          want.push(id)
          w.backend.rows.push(ownerRow(MAIN, id))
        } else {
          w.backend.rows.push(replyRow(MAIN, id))
        }
      }
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'PL1: 30 owner rows among 60')
    } finally {
      await w.end()
    }
  })

  test('a chat with open buttons, which every poll reads in full: 120 missed rows all arrive once', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      w.backend.rows.push({ ...replyRow(MAIN, 93), options: [{ id: 1, buttonText: 'Yes', callbackData: 'u:yes' }] })
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const want = ids(101, 220)
      for (const id of want) w.backend.rows.push(ownerRow(MAIN, id))
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'a full read')
    } finally {
      await w.end()
    }
  })

  test('an idle chat with a long history costs one conditional read: no page below the cursor, ever', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 500 })
    try {
      // 400 rows of answered history at or below the cursor, so the boot's full
      // read is told there are older rows, and has no reason to fetch them.
      for (const id of ids(101, 500)) w.backend.rows.push(id % 2 === 1 ? ownerRow(MAIN, id) : replyRow(MAIN, id))
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      await reconnectAndRead(w.backend, MAIN)
      await sleep(500)
      assert.deepEqual(w.backend.readsOf(MAIN).filter(isContinuation).map((r) => r.beforeId), [], 'no page below the cursor')
      assert.deepEqual(arrived(d.cards, MAIN), [], 'nothing to hand over')
      const back = w.backend.lastConnectAt()
      assert.deepEqual(
        w.backend.readsOf(MAIN).filter((r) => r.startedAt >= back).map((r) => r.status),
        [304],
        'a reconnect costs this chat one read, answered 304',
      )
    } finally {
      await w.end()
    }
  })
})

describe('hole 3: a chat that started empty', { concurrency: 3 }, () => {
  test('empty at its first read, then 120 rows: every row once, oldest first', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const want = ids(101, 220)
      for (const id of want) w.backend.rows.push(ownerRow(MAIN, id))
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'PL4 past one page')
    } finally {
      await w.end()
    }
  })

  test('empty at its first read: an agent row among the rows does not hide the rows under it', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      // The agent wrote on its own (a scheduled check in) right after 14 rows
      // that never reached it. To the first read's walk back that row looks
      // like an answer to all of them.
      for (const id of ids(101, 114)) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.rows.push(replyRow(MAIN, 115), ownerRow(MAIN, 116))
      const want = [...ids(101, 114), 116]
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'the chat was empty, so nothing in it has been answered')
    } finally {
      await w.end()
    }
  })

  test('a group empty at its first read, more than 10 rows land while the daemon is down: not capped at the newest 10', OPTS, async () => {
    const w = await world()
    try {
      w.backend.inbox.push({ id: GROUP, assistantId: ASSISTANT_ID, kind: 'group', userId: USER_ID })
      const first = await w.boot()
      await quietAfterBoot(w.backend, GROUP)
      // A live session, so the cursor store persists on the way out.
      await first.client.callTool({ name: 'channel_ack', arguments: {} })
      await first.stop()
      const want = ids(3101, 3114)
      for (const id of want) w.backend.rows.push(otherPersonRow(GROUP, id, id % 2 ? 'u7' : 'u8'))
      const second = await w.boot()
      await settle(() => second.cards, GROUP, want)
      assertExactlyOnceInOrder(arrived(second.cards, GROUP), want, 'the group had no history, so every row is owed')
    } finally {
      await w.end()
    }
  })

  test('a chat this daemon has never read: 120 unanswered rows above a long answered history, and the walk stops at the reply', OPTS, async () => {
    const w = await world()
    try {
      for (const id of ids(1, 1000)) w.backend.rows.push(id % 2 === 1 ? ownerRow(MAIN, id) : replyRow(MAIN, id))
      const want = ids(1001, 1120)
      for (const id of want) w.backend.rows.push(ownerRow(MAIN, id))
      const d = await w.boot()
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'unanswered rows only')
      const pages = w.backend.readsOf(MAIN).filter(isContinuation)
      assert.ok(pages.length <= 3, `the answered history is not read: ${pages.length} older pages`)
    } finally {
      await w.end()
    }
  })

  test('a genuine first install: 60 recent rows above 300 dormant ones, only the recent arrive, and the walk stops at the window', OPTS, async () => {
    const w = await world(null)
    try {
      const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
      for (const id of ids(1, 300)) w.backend.rows.push(ownerRow(MAIN, id, old))
      const want = ids(301, 360)
      for (const id of want) w.backend.rows.push(ownerRow(MAIN, id))
      const d = await w.boot()
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'the first run gate holds past one page')
      const pages = w.backend.readsOf(MAIN).filter(isContinuation)
      assert.ok(pages.length <= 3, `dormant history is not read: ${pages.length} older pages`)
    } finally {
      await w.end()
    }
  })

  test('a group this agent is added to mid run, with 300 rows of history: the newest 10, and no walk through the rest', OPTS, async () => {
    const w = await world()
    try {
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const history = ids(3001, 3300)
      for (const id of history) w.backend.rows.push(otherPersonRow(GROUP, id, id % 2 ? 'u7' : 'u8'))
      await sleep(5)
      w.backend.inbox.push({ id: GROUP, assistantId: ASSISTANT_ID, kind: 'group', userId: USER_ID })
      // With the socket down the next full cycle lists the group and reads it.
      w.backend.refuseSocket(true)
      w.backend.cutSocket()
      const want = ids(3291, 3300)
      await settle(() => d.cards, GROUP, want)
      assertExactlyOnceInOrder(arrived(d.cards, GROUP), want, "Data's gate of #265 holds")
      assert.deepEqual(w.backend.readsOf(GROUP).filter(isContinuation).map((r) => r.beforeId), [], 'no page below the history the cap keeps')
    } finally {
      await w.end()
    }
  })
})

describe('hole 4: a row the server never pushes', { concurrency: 3 }, () => {
  test('a live message right after it, no outage: it still reaches the agent, once, on the next read', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      w.backend.rows.push(systemRow(MAIN, 101, 'wake: rotate the keys'))
      w.backend.pushLive(ownerRow(MAIN, 102))
      await waitFor(() => d.cards.some((c) => c.messageId === 102), 'the live card')
      assert.equal(d.cards.find((c) => c.messageId === 102)?.transport, 'ws', 'a chat that is caught up gets its live message at once')
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, [101, 102])
      // The one case in this file not oldest first, on purpose: nothing told
      // the daemon a row was owed until the next read, and holding every live
      // message for a read would cost the fleet a read per message.
      assert.deepEqual(arrived(d.cards, MAIN).sort((a, b) => a - b), [101, 102], 'PL3: forwarded once each')
      const continued = w.backend.readsOf(MAIN).filter((r) => r.ids.includes(101))
      assert.ok(continued.length > 0 && continued.every((r) => r.afterId === null || r.afterId <= 100), 'the read started under the live message')
      await reconnectAndRead(w.backend, MAIN)
      // Full edit reconciliation may read older rows again; the persisted
      // delivery cursor must still reach the live message, without a rewind.
      await d.client.callTool({ name: 'channel_ack', arguments: {} })
      await d.stop()
      const saved = JSON.parse(readFileSync(join(w.rig.home, '.bgos-plugin-state', String(ASSISTANT_ID), 'chat-cursors.json'), 'utf8'))
      assert.equal(saved.cursors[MAIN], 102, 'the delivery cursor reached the live message')
    } finally {
      await w.end()
    }
  })

  test('a typed permission answer does not move the place over rows under it: they still arrive, once, and the answer itself never does', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 99)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      await d.client.notification({
        method: 'notifications/claude/channel/permission_request',
        params: { request_id: 'abcde', tool_name: 'Bash', description: 'run a thing', input_preview: '{}' },
      })
      await waitFor(() => d.stderr.some((l) => l.includes('Permission request: Bash [abcde]')), 'the request', 15_000)
      // An open request's chat is also read every 2 s, and a read that sees these
      // rows first leaves nothing owed. That read stays open, holding what it saw
      // when it arrived, until the request's own watch has acted.
      const answered = () => d.stderr.some((l) => l.includes('Verdict for Bash [abcde]: once'))
      w.backend.holdRead(MAIN, () => true, () => waitFor(answered, 'the answer to be read', 30_000))
      await waitFor(() => w.backend.pending().holds === 0, 'the 2 s read', 15_000)
      // Two rows the socket never pushed, then the owner's answer, which the
      // watch reads and acts on with no read of the chat behind it. Only the label,
      // which nothing but the open request can recognise.
      w.backend.rows.push(ownerRow(MAIN, 101), ownerRow(MAIN, 102), { ...ownerRow(MAIN, 103), text: 'Yes, this once' })
      await waitFor(answered, 'the answer to be read', 30_000)
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, [101, 102])
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), [101, 102], 'rows under a typed permission answer')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })
})

describe('a reconnect or a failure in the middle of a page', { concurrency: 3 }, () => {
  test('the socket drops and comes back while an older page is in flight, a live message lands: every row once, oldest first', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const missed = ids(101, 400)
      for (const id of missed) w.backend.rows.push(ownerRow(MAIN, id))
      w.backend.holdRead(MAIN, isContinuation, async () => {
        const cutAt = Date.now()
        w.backend.cutSocket()
        await waitFor(() => w.backend.lastConnectAt() > cutAt && w.backend.connected() > 0, 'the socket to be back', 90_000)
        w.backend.pushLive(ownerRow(MAIN, 900))
        await sleep(300)
      })
      w.backend.cutSocket()
      const want = [...missed, 900]
      await settle(() => d.cards, MAIN, want, 120_000)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'a reconnect in the middle of a page')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('an older page fails: nothing is lost or repeated, and the next read starts over without a validator on any page', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const want = ids(101, 400)
      for (const id of want) w.backend.rows.push(ownerRow(MAIN, id))
      // The second older page, so the first was answered and thrown away. The next
      // read asks for that page again, and a 304 there would be a page with no rows.
      w.backend.failRead(MAIN, (r) => r.beforeId === 151)
      w.backend.cutSocket()
      await waitFor(() => w.backend.pending().failures === 0, 'the failed page', 60_000)
      await sleep(300)
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'a failed page')
      const pages = w.backend.readsOf(MAIN).filter(isContinuation)
      assert.ok(pages.filter((r) => r.beforeId === 351).length >= 2, 'the page before the failed one was read again')
      assert.deepEqual(pages.filter((r) => r.ifNoneMatch !== null).map((r) => r.beforeId), [], 'an older page never rides a validator: a 304 there is a page with no rows')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('the daemon restarts while an older page is in flight: every row once, oldest first, across both lives', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const first = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      await first.client.callTool({ name: 'channel_ack', arguments: {} })
      const want = ids(101, 400)
      for (const id of want) w.backend.rows.push(ownerRow(MAIN, id))
      let stopped = false
      w.backend.holdRead(MAIN, isContinuation, async () => {
        await first.stop()
        stopped = true
      })
      w.backend.cutSocket()
      await waitFor(() => stopped, 'the daemon to stop in the middle of a page', 60_000)
      const second = await w.boot()
      const both = () => [...first.cards, ...second.cards]
      await settle(both, MAIN, want)
      assertExactlyOnceInOrder(arrived(both(), MAIN), want, 'a restart in the middle of a page')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('a read that starts during a walk is not answered 304 by the walk\'s first page: a live message after it does not overtake the walk', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const missed = ids(101, 400)
      for (const id of missed) w.backend.rows.push(ownerRow(MAIN, id))
      let readDuringWalk: Read | undefined
      w.backend.holdRead(MAIN, isContinuation, async () => {
        const cutAt = Date.now()
        w.backend.cutSocket()
        await waitFor(() => w.backend.lastConnectAt() > cutAt, 'the socket to be back', 90_000)
        const back = w.backend.lastConnectAt()
        await waitFor(() => {
          readDuringWalk = w.backend.readsOf(MAIN).find((r) => !isContinuation(r) && r.startedAt >= back)
          return readDuringWalk !== undefined
        }, 'the read the connect starts', 30_000)
        await sleep(300)
        w.backend.pushLive(ownerRow(MAIN, 900))
        await sleep(500)
      })
      w.backend.cutSocket()
      const want = [...missed, 900]
      await settle(() => d.cards, MAIN, want, 120_000)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'a live message after a read that started during a walk')
      assert.equal(readDuringWalk?.status, 200, 'the rows under this read are not delivered yet, so it cannot be told nothing changed')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })
})

describe('what a long read must not break', { concurrency: 3 }, () => {
  test('a walk that outlasts the lock\'s 15 seconds inside a tick keeps the lock fresh', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 99)
      await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      // Socket down: the sweep runs inside the tick, the one thing that refreshes
      // the lock, and the tick waits for it.
      w.backend.refuseSocket(true)
      w.backend.cutSocket()
      for (const id of ids(101, 200)) w.backend.rows.push(ownerRow(MAIN, id))
      let oldestAge = -1
      w.backend.holdRead(MAIN, isContinuation, async () => {
        const until = Date.now() + 20_000
        while (Date.now() < until) {
          oldestAge = Math.max(oldestAge, Date.now() - JSON.parse(readFileSync(lockOf(w.rig), 'utf8')).heartbeatAt)
          await sleep(250)
        }
      })
      await waitFor(() => w.backend.readsOf(MAIN).some(isContinuation), 'the walk inside the tick', 90_000)
      assert.ok(oldestAge >= 0, 'the lock was sampled')
      assert.ok(oldestAge < 15_000, `the lock's heartbeat was ${oldestAge} ms old, and it goes stale at 15000`)
      assertHarnessRan(w.backend)
    } finally {
      w.backend.refuseSocket(false)
      await w.end()
    }
  })

  test('a daemon that stands down during a walk reads no further page and delivers nothing', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 99)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      for (const id of ids(101, 600)) w.backend.rows.push(ownerRow(MAIN, id))
      // A rival takes the lock while the first older page is in flight. It stays
      // fresh until the end of the case, so this daemon does not take it back.
      const rival = rivalForLock(w.rig)
      w.backend.holdRead(MAIN, isContinuation, async () => {
        rival.start()
        await waitFor(() => d.stderr.some((l) => l.includes('standing down to passive')), 'the daemon to stand down', 30_000)
      })
      await reconnectAndRead(w.backend, MAIN)
      await waitFor(() => w.backend.pending().holds === 0, 'the walk to reach the held page', 30_000)
      await waitFor(() => w.backend.readsOf(MAIN).some(isContinuation), 'the held page to be answered', 40_000)
      await sleep(3_000)
      await rival.stop()
      assert.equal(w.backend.readsOf(MAIN).filter(isContinuation).length, 1, 'no page after the stand down')
      assert.deepEqual(arrived(d.cards, MAIN), [], 'nothing delivered by a daemon that lost the lock')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('a daemon that stands down during the last older page delivers nothing', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 99)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      // The newest 50 and one older page, which reaches the cursor: no page comes
      // after the stand down to notice it.
      for (const id of ids(101, 200)) w.backend.rows.push(ownerRow(MAIN, id))
      const rival = rivalForLock(w.rig)
      w.backend.holdRead(MAIN, isContinuation, async () => {
        rival.start()
        await waitFor(() => d.stderr.some((l) => l.includes('standing down to passive')), 'the daemon to stand down', 30_000)
      })
      await reconnectAndRead(w.backend, MAIN)
      await waitFor(() => w.backend.readsOf(MAIN).some(isContinuation), 'the held page to be answered', 70_000)
      await sleep(3_000)
      await rival.stop()
      assert.equal(w.backend.readsOf(MAIN).filter(isContinuation).length, 1, 'one older page was enough')
      assert.deepEqual(arrived(d.cards, MAIN), [], 'nothing delivered by a daemon that lost the lock')
      assertHarnessRan(w.backend)
    } finally {
      await w.end()
    }
  })

  test('a wake card that never fills does not pin the delivery cursor: the rows above it arrive once', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      w.backend.rows.push(systemRow(MAIN, 101, ''))
      const want = ids(102, 170)
      for (const id of want) w.backend.rows.push(ownerRow(MAIN, id))
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, want)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'rows above an abandoned card')
      await reconnectAndRead(w.backend, MAIN)
      await sleep(500)
      await d.client.callTool({ name: 'channel_ack', arguments: {} })
      await d.stop()
      const saved = JSON.parse(readFileSync(join(w.rig.home, '.bgos-plugin-state', String(ASSISTANT_ID), 'chat-cursors.json'), 'utf8'))
      assert.equal(saved.cursors[MAIN], 170, 'the abandoned card no longer holds the delivery cursor down')
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), want, 'edit reconciliation does not redeliver originals')
    } finally {
      await w.end()
    }
  })

  test('a wake card inside the newest page still waits for its body, and arrives once with it', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN)
      const wake = systemRow(MAIN, 101, '')
      w.backend.rows.push(wake)
      const above = ids(102, 110)
      for (const id of above) w.backend.rows.push(ownerRow(MAIN, id))
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, above)
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), above, 'the card waits')
      wake.text = 'wake: rotate the keys'
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, [...above, 101])
      assert.deepEqual(arrived(d.cards, MAIN), [...above, 101], 'the card once, the rows above it not again')
    } finally {
      await w.end()
    }
  })

  test('a drain of 600 rows in one chat does not make the daemon forget what it handed over in another', OPTS, async () => {
    const w = await world({ '999': 5, [MAIN]: 100, [SECOND]: 100 })
    try {
      primed(w.backend, MAIN, 91)
      primed(w.backend, SECOND, 93)
      w.backend.inbox.push({ id: SECOND, assistantId: ASSISTANT_ID, kind: 'main', userId: USER_ID })
      const d = await w.boot()
      await quietAfterBoot(w.backend, MAIN, SECOND)
      // MAIN parks under a wake card, so every read of it reads the rows above
      // the card again and only the forwarded ids keep them from going twice.
      w.backend.rows.push(systemRow(MAIN, 101, ''))
      const above = ids(102, 110)
      for (const id of above) w.backend.rows.push(ownerRow(MAIN, id))
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, above)
      const drain = ids(1001, 1600)
      for (const id of drain) w.backend.rows.push(ownerRow(SECOND, id))
      await reconnectAndRead(w.backend, SECOND)
      await settle(() => d.cards, SECOND, drain, 120_000)
      assertExactlyOnceInOrder(arrived(d.cards, SECOND), drain, 'a drain past the old 500 id bound')
      // A new row, because an unchanged window answers 304 and never reaches the
      // dedupe: the rows above the card must really be handed to it again.
      w.backend.rows.push(ownerRow(MAIN, 2000))
      await reconnectAndRead(w.backend, MAIN)
      await settle(() => d.cards, MAIN, [...above, 2000])
      assertExactlyOnceInOrder(arrived(d.cards, MAIN), [...above, 2000], 'the parked chat, read again after the drain')
    } finally {
      await w.end()
    }
  })
})
