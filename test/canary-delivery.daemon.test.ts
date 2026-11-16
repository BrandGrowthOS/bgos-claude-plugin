/**
 * THE CANARY'S PROOF READS A DELIVERY, NOT A LOOP (board row 42499778).
 *
 * A build whose poll loop runs but hands no message to the session used to pass
 * every proof the follower wait reads: the beacon is touched by the loop, a
 * version heartbeat lands, and no deaf verdict comes until a delivery has gone
 * unanswered. Every other agent on the computer then walked onto it.
 *
 * These cases run the REAL daemon (a copy of server.ts under bun) and its real
 * idle update controller on a scaled clock, against a stand in BGOS backend and
 * a stand in for Claude Code (an MCP client that collects the channel cards).
 * What is read is the file the followers read, `<version>/alive`. A "deaf build"
 * is the same source with one fault patched into the copy, so no test hook
 * ships in the daemon.
 *
 * Run with: npx tsx --test test/canary-delivery.daemon.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

import { IDLE_UPDATE_SCHEMA_VERSION } from '../lib/idle-update.mjs'

const ROOT = join(import.meta.dirname, '..')
const BUN = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout ?? ''
const SKIP = process.platform === 'win32' ? 'posix only' : BUN ? false : 'needs bun'
const OPTS = { skip: SKIP, timeout: 150_000 }

const ASSISTANT_ID = 42
const USER_ID = 'u1'
const MAIN = 501
/** At this scale a poll is 0.5 s and the wait a message gets before it counts as not delivered is 3 s. */
const SCALE = 60
const POLL_MS = 500
const GRACE_MS = 3_000
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, what: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

type Row = Record<string, unknown> & { id: number; chatId: number; sender: 'user' | 'assistant' | 'system'; text: string }

function ownerRow(id: number, extra: Record<string, unknown> = {}): Row {
  return { id, chatId: MAIN, sender: 'user', text: `owner ${id}`, senderUserId: USER_ID, senderAssistantId: null, messageType: 'standard', sentDate: new Date().toISOString(), ...extra }
}

function emptyWakeRow(id: number): Row {
  return { id, chatId: MAIN, sender: 'system', text: '', senderUserId: null, senderAssistantId: null, messageType: 'event', sentDate: new Date().toISOString() }
}

function replyRow(id: number): Row {
  return { id, chatId: MAIN, sender: 'assistant', text: `answer ${id}`, senderAssistantId: ASSISTANT_ID, messageType: 'standard', sentDate: new Date().toISOString() }
}

interface Backend {
  url: string
  /** Store a row with no frame: a push the socket missed, or one that never goes out. */
  rows: Row[]
  /** Store a row and push it live, as the backend does for a new message. */
  pushLive: (row: Row) => void
  connected: () => number
  /** The proof's reads and the poll's: what each asked, and whether it named the agent. */
  reads: Array<{ query: string; namedAgent: boolean }>
  close: () => Promise<void>
}

async function startBackend(): Promise<Backend> {
  const rows: Row[] = []
  const reads: Backend['reads'] = []
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume()
    const url = new URL(req.url ?? '/', 'http://backend')
    const path = url.pathname.replace(/^\/api\/v1\//, '')
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && path === 'peers/inbox') return json({ chats: [{ id: MAIN, assistantId: ASSISTANT_ID, kind: 'main', userId: USER_ID }] })
    if (req.method === 'GET' && path === 'meetings') return json([])
    const history = /^chats\/(\d+)\/messages$/.exec(path)
    if (req.method === 'GET' && history) {
      reads.push({ query: url.search, namedAgent: req.headers['x-caller-assistant-id'] !== undefined })
      const chatId = Number(history[1])
      const afterParam = url.searchParams.get('afterId')
      const limitParam = url.searchParams.get('limit')
      // The real route: the NEWEST rows above the cursor (50 by default), oldest first.
      const page = rows
        .filter((r) => r.chatId === chatId && r.id > Number(afterParam ?? 0))
        .sort((a, b) => a.id - b.id)
        .slice(-Number(limitParam ?? 50))
      // The real route's conditional GET: an unchanged body is a 304, on the proof's read as on the poll's.
      const body = JSON.stringify({ messages: page.map((message) => ({ message, messageFiles: [], messageOptions: [] })) })
      const etag = `W/"${createHash('sha1').update(body).digest('hex')}"`
      if (req.headers['if-none-match'] === etag) {
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
  const io = new SocketServer(http)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`,
    rows,
    pushLive: (row) => {
      rows.push(row)
      io.emit('inbound_message', { assistantId: ASSISTANT_ID, userId: USER_ID, chatId: row.chatId, messageId: row.id, text: row.text, files: [], messageType: row.messageType, sentDate: row.sentDate })
    },
    connected: () => io.of('/').sockets.size,
    reads,
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  }
}

/** One fault in the copy of the source: `find` must occur exactly once. */
interface Fault {
  find: string
  replace: string
}

/** The loop runs, reads and moves its cursor, and no message reaches the hand-off. */
const DROPS_EVERY_ROW: Fault[] = [
  { find: 'for (const { row: msg, edit } of deliveries) {', replace: 'for (const { row: msg, edit } of [] as typeof deliveries) {' },
  {
    find: "      const messageId = Number(payload?.messageId ?? payload?.message_id)\n      if (!Number.isFinite(messageId)) return\n      if (forwardedMessageIds.has(messageId)) return",
    replace: "      const messageId = Number(payload?.messageId ?? payload?.message_id)\n      if (Number.isFinite(messageId)) return\n      if (forwardedMessageIds.has(messageId)) return",
  },
]

/** The loop runs and picks each row up; the write to Claude Code fails every time. */
const HAND_OFF_FAILS: Fault[] = [
  { find: 'writeToClaudeCode(...args).then(', replace: "((args[0] as any)?.method === 'notifications/claude/channel' ? Promise.reject(new Error('stand in hand-off fault')) : writeToClaudeCode(...args)).then(" },
]

/** Every read of the chat's messages comes back empty: nothing is ever seen to deliver. */
const POLL_READS_NOTHING: Fault[] = [
  { find: 'const firstPage = raw as ChatHistoryResponse\n    if (!firstPage.messages?.length) {', replace: 'const firstPage = { messages: [] } as ChatHistoryResponse\n    if (!firstPage.messages?.length) {' },
]

/** Each card goes out in a shape Claude Code silently drops: a meta value that is not a string. */
const CARDS_THE_HOST_DROPS: Fault[] = [
  { find: 'writeToClaudeCode(...args).then(', replace: "((args[0] as any)?.params?.meta ? ((args[0] as any).params.meta.retries = 3, writeToClaudeCode(...args)) : writeToClaudeCode(...args)).then(" },
]

interface Rig {
  root: string
  home: string
  folder: string
  pluginRoot: string
}

function makeRig(backendUrl: string, faults: Fault[]): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'canary-delivery-')))
  const pluginRoot = join(root, 'plugin')
  const home = join(root, 'home')
  const folder = join(root, 'agent')
  for (const dir of [pluginRoot, folder, join(home, '.bgos-agent', String(ASSISTANT_ID)), join(home, '.bgos-agent', 'idle-update', VERSION)]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json', '.claude-plugin']) {
    cpSync(join(ROOT, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(pluginRoot, 'node_modules'))
  if (faults.length > 0) {
    let source = readFileSync(join(pluginRoot, 'server.ts'), 'utf8')
    for (const fault of faults) {
      assert.equal(source.split(fault.find).length, 2, `the fault anchor is not unique in server.ts: ${fault.find}`)
      source = source.replace(fault.find, fault.replace)
    }
    writeFileSync(join(pluginRoot, 'server.ts'), source)
  }
  writeFileSync(
    join(home, '.bgos-agent', `credentials-${ASSISTANT_ID}.json`),
    JSON.stringify({ backendUrl, pairingToken: 'TESTTOKEN', pairingId: 420, userId: USER_ID, assistantId: ASSISTANT_ID, homeDir: folder, homeConfirmed: true }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), `${ASSISTANT_ID}\n`)
  const cursorPath = join(home, '.bgos-plugin-state', String(ASSISTANT_ID), 'chat-cursors.json')
  mkdirSync(dirname(cursorPath), { recursive: true })
  writeFileSync(cursorPath, JSON.stringify({ v: 1, cursors: { [String(MAIN)]: 100 } }))
  // This boot is the canary coming back on the version it asked for: the file the real controller wrote before it asked.
  const at = new Date().toISOString()
  writeFileSync(join(home, '.bgos-agent', 'idle-update', VERSION, 'canary-1'), JSON.stringify({ assistantId: String(ASSISTANT_ID), at }))
  writeFileSync(
    join(home, '.bgos-agent', String(ASSISTANT_ID), 'idle-update.json'),
    JSON.stringify({
      schema: IDLE_UPDATE_SCHEMA_VERSION,
      target: VERSION,
      from: '0.1.0',
      fromRoot: null,
      fromCommit: null,
      installMethod: 'marketplace',
      pin: null,
      pinBefore: null,
      nonce: 'canary-delivery',
      canaryN: 1,
      state: 'requested',
      attempts: [{ at, outcome: 'requested' }],
      lockBoots: 0,
      arrivedAt: null,
      validatedAt: null,
      contextLost: false,
      reportedAt: null,
    }),
  )
  return { root, home, folder, pluginRoot }
}

interface Daemon {
  cardIds: number[]
  stderr: string[]
  stop: () => Promise<void>
}

async function startDaemon(rig: Rig): Promise<Daemon> {
  const cardIds: number[] = []
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
      BGOS_IDLE_UPDATE_SCALE: String(SCALE),
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
    const meta = ((n.params ?? {}) as { meta?: Record<string, string> }).meta ?? {}
    if (meta.message_id !== undefined) cardIds.push(Number(meta.message_id))
  }
  try {
    await client.connect(transport)
    await client.listTools()
  } catch (err) {
    await client.close().catch(() => {})
    throw new Error(`${String(err)}; daemon stderr tail:\n${stderr.slice(-20).join('\n')}`)
  }
  return { cardIds, stderr, stop: () => client.close() }
}

interface World {
  backend: Backend
  rig: Rig
  daemon: Daemon
  /** What the followers read: the canary's last stamp, or null before the first. */
  alive: () => { at: string; provedMs: number } | null
  /** How old the stamp is, in ms. */
  aliveAge: () => number
  end: () => Promise<void>
}

/** A canary that came back, validated and has started to stamp. */
async function canaryOn(faults: Fault[] = []): Promise<World> {
  const backend = await startBackend()
  let rig: Rig
  try {
    rig = makeRig(backend.url, faults)
  } catch (err) {
    await backend.close()
    throw err
  }
  const dir = join(rig.home, '.bgos-agent', 'idle-update', VERSION)
  const alive = () => {
    const path = join(dir, 'alive')
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  }
  let daemon: Daemon
  try {
    daemon = await startDaemon(rig)
  } catch (err) {
    await backend.close()
    rmSync(rig.root, { recursive: true, force: true })
    throw err
  }
  const end = async () => {
    await daemon.stop().catch(() => {})
    await backend.close()
    rmSync(rig.root, { recursive: true, force: true })
  }
  try {
    await waitFor(() => daemon.stderr.some((l) => l.includes('startup complete: polling armed')), 'the daemon to arm')
    await waitFor(() => backend.connected() > 0, 'the socket')
    await waitFor(() => alive() !== null, 'the canary to validate and stamp')
  } catch (err) {
    const tail = daemon.stderr.slice(-30).join('\n')
    await end()
    throw new Error(`${String(err)}; daemon stderr tail:\n${tail}`)
  }
  return { backend, rig, daemon, alive, aliveAge: () => Date.now() - Date.parse(alive()?.at ?? '1970-01-01'), end }
}

/** The stamp moves on for this long: it never falls further behind than a few polls. */
async function staysFresh(w: World, ms: number): Promise<void> {
  const until = Date.now() + ms
  let worst = 0
  while (Date.now() < until) {
    worst = Math.max(worst, w.aliveAge())
    await sleep(100)
  }
  // Wide for a loaded machine, and still far under the window a build that stopped would fall behind by.
  assert.ok(worst < 12 * POLL_MS, `the stamp fell ${worst} ms behind\n${w.daemon.stderr.slice(-15).join('\n')}`)
}

const FAR_PAST_GRACE = 3 * GRACE_MS

describe('the canary stamps alive only while it delivers', { concurrency: 4 }, () => {
  test('a healthy quiet build, with no traffic at all, stays live', OPTS, async () => {
    const w = await canaryOn()
    try {
      const before = w.alive()!.provedMs
      await staysFresh(w, FAR_PAST_GRACE)
      assert.ok(w.alive()!.provedMs > before, 'and it goes on proving minutes')
    } finally {
      await w.end()
    }
  })

  test('a healthy build with traffic stays live, and each message reached the session', OPTS, async () => {
    const w = await canaryOn()
    try {
      for (let id = 201; id <= 203; id += 1) {
        w.backend.pushLive(ownerRow(id))
        await sleep(GRACE_MS)
        await staysFresh(w, POLL_MS)
      }
      assert.deepEqual([...w.daemon.cardIds].sort(), [201, 202, 203])
      await staysFresh(w, FAR_PAST_GRACE)
    } finally {
      await w.end()
    }
  })

  test('a push the socket missed is read at once and delivered, so a healthy build does not read as deaf', OPTS, async () => {
    const w = await canaryOn()
    try {
      w.backend.rows.push(ownerRow(301))
      await waitFor(() => w.daemon.cardIds.includes(301), 'the missed message to arrive long before the 5 minute sweep', 2 * GRACE_MS)
      await staysFresh(w, FAR_PAST_GRACE)
    } finally {
      await w.end()
    }
  })

  test('rows a healthy daemon rightly does not hand over never read as deaf', OPTS, async () => {
    const w = await canaryOn()
    try {
      await staysFresh(w, POLL_MS)
      // Daemon answered, the agent's own answer, a wake whose body has not landed, and an empty row.
      w.backend.pushLive(ownerRow(401, { text: '/status', messageType: 'slash_command' }))
      w.backend.rows.push(replyRow(402))
      w.backend.rows.push(emptyWakeRow(403))
      await staysFresh(w, FAR_PAST_GRACE)
      assert.deepEqual(w.daemon.cardIds, [], 'none of them reached the session')
    } finally {
      await w.end()
    }
  })

  test('the proof\'s read never names the agent, so the backend records no wake as handed off that was not delivered', OPTS, async () => {
    const w = await canaryOn()
    try {
      await waitFor(() => w.backend.reads.some((r) => r.query.includes('limit=1')), 'the first read of what waits')
      w.backend.pushLive(ownerRow(450))
      await waitFor(() => w.daemon.cardIds.includes(450), 'the message')
      await waitFor(() => w.backend.reads.some((r) => r.query.includes('afterId=450') && !r.namedAgent), 'a later read of what waits')
      const proofReads = w.backend.reads.filter((r) => r.query.includes('limit=1'))
      assert.ok(proofReads.length > 0)
      assert.ok(proofReads.every((r) => !r.namedAgent), JSON.stringify(proofReads))
      assert.ok(w.backend.reads.some((r) => r.namedAgent), 'the poll still does')
    } finally {
      await w.end()
    }
  })

  test('a build that keeps polling but drops every message stops stamping, and the followers read a stale stamp', OPTS, async () => {
    const w = await canaryOn(DROPS_EVERY_ROW)
    try {
      await staysFresh(w, 2 * POLL_MS)
      w.backend.pushLive(ownerRow(501))
      await sleep(FAR_PAST_GRACE)
      assert.deepEqual(w.daemon.cardIds, [], 'the fault is in: nothing reached the session')
      // Everything else this build shows still reads as healthy.
      assert.ok(w.backend.connected() > 0, 'still connected')
      assert.ok(w.aliveAge() >= GRACE_MS, `still stamping, ${w.aliveAge()} ms old\n${w.daemon.stderr.slice(-15).join('\n')}`)
      assert.ok(w.daemon.stderr.some((l) => /not delivered/.test(l) && l.includes('501')), 'and it says which message')
    } finally {
      await w.end()
    }
  })

  test('a build whose hand-off to Claude Code fails stops stamping', OPTS, async () => {
    const w = await canaryOn(HAND_OFF_FAILS)
    try {
      await staysFresh(w, 2 * POLL_MS)
      w.backend.pushLive(ownerRow(601))
      await sleep(FAR_PAST_GRACE)
      assert.ok(w.aliveAge() >= GRACE_MS, `still stamping, ${w.aliveAge()} ms old\n${w.daemon.stderr.slice(-15).join('\n')}`)
    } finally {
      await w.end()
    }
  })

  test('a build whose cards are in a shape Claude Code silently drops stops stamping, though each write resolves', OPTS, async () => {
    const w = await canaryOn(CARDS_THE_HOST_DROPS)
    try {
      await staysFresh(w, 2 * POLL_MS)
      w.backend.pushLive(ownerRow(651))
      await sleep(FAR_PAST_GRACE)
      assert.ok(w.daemon.cardIds.includes(651), 'the write went out')
      assert.ok(w.aliveAge() >= GRACE_MS, `still stamping, ${w.aliveAge()} ms old\n${w.daemon.stderr.slice(-15).join('\n')}`)
    } finally {
      await w.end()
    }
  })

  test('a build whose poll reads nothing, with a socket that missed the push, stops stamping', OPTS, async () => {
    const w = await canaryOn(POLL_READS_NOTHING)
    try {
      await staysFresh(w, 2 * POLL_MS)
      w.backend.rows.push(ownerRow(701))
      await sleep(FAR_PAST_GRACE)
      assert.deepEqual(w.daemon.cardIds, [])
      assert.ok(w.aliveAge() >= GRACE_MS, `still stamping, ${w.aliveAge()} ms old\n${w.daemon.stderr.slice(-15).join('\n')}`)
    } finally {
      await w.end()
    }
  })

  test('the build that dropped a message takes the stamp back up as soon as a later one gets through', OPTS, async () => {
    const w = await canaryOn(HAND_OFF_FAILS.map((f) => ({
      ...f,
      // Only the first card fails: a blip, and the next message gets through.
      replace: "((args[0] as any)?.method === 'notifications/claude/channel' && !(globalThis as any).__blipped && ((globalThis as any).__blipped = true) ? Promise.reject(new Error('stand in blip')) : writeToClaudeCode(...args)).then(",
    })))
    try {
      w.backend.pushLive(ownerRow(801))
      await waitFor(() => w.aliveAge() >= 6 * POLL_MS, 'the stamp to stop on the lost message', 4 * GRACE_MS)
      w.backend.pushLive(ownerRow(802))
      await waitFor(() => w.daemon.cardIds.includes(802), 'the next message')
      await waitFor(() => w.aliveAge() < 3 * POLL_MS, 'the stamp to come back', 4 * GRACE_MS)
    } finally {
      await w.end()
    }
  })

  test('history the canary found on arrival is not traffic it owes: the first read only takes the chat\'s tip', OPTS, async () => {
    const backend = await startBackend()
    const rig = makeRig(backend.url, [])
    // Old rows the cursor already passed, as the chat stood before this boot: answered, so the boot hands nothing over.
    backend.rows.push(ownerRow(50))
    backend.rows.push(replyRow(51))
    const daemon = await startDaemon(rig)
    try {
      await waitFor(() => existsSync(join(rig.home, '.bgos-agent', 'idle-update', VERSION, 'alive')), 'the canary to stamp')
      const path = join(rig.home, '.bgos-agent', 'idle-update', VERSION, 'alive')
      const age = () => Date.now() - Date.parse(JSON.parse(readFileSync(path, 'utf8')).at)
      await sleep(FAR_PAST_GRACE)
      assert.ok(age() < 12 * POLL_MS, `the stamp stopped on old history, ${age()} ms old`)
      assert.deepEqual(daemon.cardIds, [], 'nothing was handed over, so only the tip rule keeps this live')
    } finally {
      await daemon.stop().catch(() => {})
      await backend.close()
      rmSync(rig.root, { recursive: true, force: true })
    }
  })
})
