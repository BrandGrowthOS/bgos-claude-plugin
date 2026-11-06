/**
 * AFTER A RESTART, AN AGENT CAN STILL WRITE IN A GROUP IT SITS IN.
 *
 * After an agent restarts it cannot post into a group chat until somebody
 * else writes there first.
 *
 * The cause is the daemon's chat membership authority (monitoredChatSet in
 * server.ts). It refuses a reply, rename or ask to any chat id it has not been
 * told about, and it is told about a chat in two ways only: discoverChats(),
 * which reads `GET /peers/inbox`, and an inbound message. The inbox never lists
 * a group (kind 'room') or a channel: in those chats `chats.assistant_id` is the
 * creator's carrier agent, not this agent's claim, so the backend hides them
 * there on purpose (PEER_INBOX_VISIBILITY in chat-kind-authorship.ts). The set
 * lives in memory, so a restart empties it, and the only thing that refilled it
 * for a group was somebody else's next message. The reply tool answered the
 * agent "chat_id ... is not one this assistant is a participant of".
 *
 * The fix: discoverChats() also reads `GET /peers/seats`, the groups and
 * channels where THIS agent holds a live seat and its owner an active
 * membership (the backend's own write rule, assertRoomWrite plus the seat
 * check in send-message), and admits those. It adds nothing else: a group the
 * agent is not seated in, a group its owner was removed from, and a group where
 * only another person's agent sits are still refused before any POST, and a
 * backend without the route (404) behaves exactly as before.
 *
 * Everything runs against the REAL daemon (a copy of server.ts under bun), a
 * stand in BGOS backend (http and socket.io) and a stand in for Claude Code (an
 * MCP client that calls the reply tool).
 *
 * Run with: npx tsx --test test/group-write-after-restart.e2e.test.ts
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
const OPTS = { skip: SKIP, timeout: 180_000 }

const ASSISTANT_ID = 42
const USER_ID = 'u1'
const MAIN = 501
/** A group this agent sits in, its owner an active member. */
const ROOM = 33503
/** A channel this agent sits in. */
const CHANNEL = 33600
/** A group this agent is not seated in (its owner may or may not be in it). */
const NOT_SEATED = 33504
/** A group the owner was removed from: the backend cleared the seat with the membership. */
const REMOVED = 33505
/** A group where only ANOTHER person's agent sits. */
const OTHERS_AGENT = 33506

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, what: string, ms = 25_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

interface Post {
  path: string
  body: Record<string, unknown>
}

interface Backend {
  url: string
  /** What `GET /peers/seats` answers; null answers 404, as a backend without the route. */
  seats: { chats: Array<Record<string, unknown>> } | null
  /** Every send-message POST, as received. */
  posts: Post[]
  /** How many times the daemon asked for its seats. */
  seatReads: () => number
  /** Push one live message into a chat, as the backend does for a new row. */
  pushLive: (chatId: number, messageId: number, chatKind: string) => void
  /** How many daemon sockets are connected. */
  connected: () => number
  close: () => Promise<void>
}

async function startBackend(): Promise<Backend> {
  const posts: Post[] = []
  let seatReads = 0
  let nextId = 900_000
  const backend = {} as Backend
  backend.seats = { chats: [] }
  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return {}
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://backend')
    const path = url.pathname.replace(/^\/api\/v1\//, '')
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && path === 'send-message') {
      const body = await readBody(req)
      posts.push({ path, body })
      nextId += 1
      return json({ message: { id: nextId, chatId: body.chatId, sender: 'assistant' } })
    }
    req.resume()
    if (req.method === 'GET' && path === 'peers/inbox') {
      return json({ chats: [{ id: MAIN, assistantId: ASSISTANT_ID, kind: 'main', userId: USER_ID }] })
    }
    if (req.method === 'GET' && path === 'peers/seats') {
      seatReads += 1
      if (backend.seats === null) return json({ message: 'Cannot GET /api/v1/peers/seats', statusCode: 404 }, 404)
      return json(backend.seats)
    }
    if (req.method === 'GET' && path === 'meetings') return json([])
    if (req.method === 'GET' && /^chats\/\d+\/messages$/.test(path)) return json({ messages: [] })
    return json({})
  }
  const http = createServer((req, res) => {
    void handle(req, res)
  })
  const io = new SocketServer(http)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  backend.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`
  backend.posts = posts
  backend.seatReads = () => seatReads
  backend.pushLive = (chatId, messageId, chatKind) => {
    io.emit('inbound_message', {
      assistantId: ASSISTANT_ID,
      userId: 'u2',
      chatId,
      chatKind,
      messageId,
      text: `@agent hello from u2 (${messageId})`,
      files: [],
      messageType: 'standard',
      senderUserId: 'u2',
    })
  }
  backend.connected = () => io.of('/').sockets.size
  backend.close = () => new Promise<void>((resolve) => io.close(() => resolve()))
  return backend
}

interface Rig {
  root: string
  home: string
  folder: string
  pluginRoot: string
}

function makeRig(backendUrl: string): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'group-write-')))
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
  // An earlier life: not a first install, so the first-run gate is off.
  const cursorPath = join(home, '.bgos-plugin-state', String(ASSISTANT_ID), 'chat-cursors.json')
  mkdirSync(dirname(cursorPath), { recursive: true })
  writeFileSync(cursorPath, JSON.stringify({ v: 1, cursors: { [MAIN]: 0 } }))
  return { root, home, folder, pluginRoot }
}

interface Daemon {
  stderr: string[]
  /** The chat ids of the channel cards handed to Claude Code. */
  cardChats: number[]
  client: Client
  stop: () => Promise<void>
}

async function startDaemon(rig: Rig): Promise<Daemon> {
  const stderr: string[] = []
  const cardChats: number[] = []
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
    const meta = ((n.params ?? {}) as { meta?: Record<string, string> }).meta ?? {}
    cardChats.push(Number(meta.chat_id))
  }
  try {
    await client.connect(transport)
    await client.listTools()
    await waitFor(() => stderr.some((l) => l.includes('startup complete: polling armed')), 'the daemon to arm', 60_000)
  } catch (err) {
    await client.close().catch(() => {})
    throw new Error(`${String(err)}; daemon stderr tail:\n${stderr.slice(-20).join('\n')}`)
  }
  return { stderr, cardChats, client, stop: () => client.close() }
}

/** The reply tool's text answer. */
async function reply(daemon: Daemon, chatId: number, text: string): Promise<string> {
  const result = (await daemon.client.callTool({ name: 'reply', arguments: { chat_id: String(chatId), text } })) as {
    content?: Array<{ type: string; text?: string }>
  }
  return (result.content ?? []).map((c) => c.text ?? '').join('\n')
}

const REFUSED = /is not one this assistant is a participant of/

function postsTo(backend: Backend, chatId: number): Post[] {
  return backend.posts.filter((p) => Number(p.body.chatId) === chatId)
}

async function withWorld(run: (backend: Backend, rig: Rig) => Promise<void>): Promise<void> {
  const backend = await startBackend()
  const rig = makeRig(backend.url)
  try {
    await run(backend, rig)
  } finally {
    await backend.close()
    rmSync(rig.root, { recursive: true, force: true })
  }
}

describe('a restarted agent writes in a group it sits in', () => {
  test('restart, then reply into the group: sent, with no inbound since the restart', OPTS, async () => {
    await withWorld(async (backend, rig) => {
      backend.seats = { chats: [{ id: ROOM, kind: 'room' }] }

      // First life: somebody writes in the group, so the agent may answer.
      const first = await startDaemon(rig)
      try {
        await waitFor(() => backend.connected() > 0, 'the daemon socket to connect')
        backend.pushLive(ROOM, 7001, 'room')
        await waitFor(() => first.cardChats.includes(ROOM), 'the live group message to reach the agent')
        const before = await reply(first, ROOM, 'answer before the restart')
        assert.doesNotMatch(before, REFUSED, 'the first life answers the group')
      } finally {
        await first.stop()
      }
      assert.equal(postsTo(backend, ROOM).length, 1, 'one reply reached the backend before the restart')

      // The restart. Nobody writes in the group afterwards.
      const second = await startDaemon(rig)
      try {
        const after = await reply(second, ROOM, 'a status update after the restart')
        assert.doesNotMatch(after, REFUSED, `the restarted agent may write in its group; tool said: ${after}`)
        assert.equal(postsTo(backend, ROOM).length, 2, 'the reply after the restart reached the backend')
        const sent = postsTo(backend, ROOM)[1]!.body
        assert.equal(sent.assistantId, ASSISTANT_ID)
        assert.equal(sent.sender, 'assistant')
        assert.ok(backend.seatReads() >= 2, 'each life asked for its seats at boot')
      } finally {
        await second.stop()
      }
    })
  })

  test('a channel the agent sits in is admitted the same way', OPTS, async () => {
    await withWorld(async (backend, rig) => {
      backend.seats = { chats: [{ id: CHANNEL, kind: 'channel' }] }
      const daemon = await startDaemon(rig)
      try {
        const answer = await reply(daemon, CHANNEL, 'posting into the channel')
        assert.doesNotMatch(answer, REFUSED, `tool said: ${answer}`)
        assert.equal(postsTo(backend, CHANNEL).length, 1)
      } finally {
        await daemon.stop()
      }
    })
  })

  test('negative controls: not seated, owner removed, another person\'s agent: refused before any POST', OPTS, async () => {
    await withWorld(async (backend, rig) => {
      // The backend lists the agent's OWN live member seats only. The other
      // three groups are absent from the answer, and a malformed row, a row
      // of a kind that is not a group and a row the seat list could never
      // name (the main chat as a room) admit nothing new either.
      backend.seats = {
        chats: [
          { id: ROOM, kind: 'room' },
          { id: 'not-a-number', kind: 'room' },
          { id: -4, kind: 'room' },
          { id: 123456, kind: 'main' },
          { id: 123457 },
        ],
      }
      const daemon = await startDaemon(rig)
      try {
        for (const chatId of [NOT_SEATED, REMOVED, OTHERS_AGENT, 123456, 123457]) {
          const answer = await reply(daemon, chatId, 'should never be sent')
          assert.match(answer, REFUSED, `chat ${chatId} is refused`)
          assert.equal(postsTo(backend, chatId).length, 0, `nothing was posted to chat ${chatId}`)
        }
        // Positive control in the same daemon: the seat it does hold is admitted.
        const ok = await reply(daemon, ROOM, 'the seat it does hold')
        assert.doesNotMatch(ok, REFUSED)
        assert.equal(postsTo(backend, ROOM).length, 1)
      } finally {
        await daemon.stop()
      }
    })
  })

  test('removed from the group while running: the next discovery admits nothing new, the backend still decides', OPTS, async () => {
    await withWorld(async (backend, rig) => {
      // Seated at boot, then the owner is removed (the backend clears the seat).
      backend.seats = { chats: [{ id: ROOM, kind: 'room' }] }
      const daemon = await startDaemon(rig)
      try {
        backend.seats = { chats: [] }
      } finally {
        await daemon.stop()
      }
      // After a restart the removed group is not admitted at all.
      const restarted = await startDaemon(rig)
      try {
        const answer = await reply(restarted, ROOM, 'should never be sent')
        assert.match(answer, REFUSED)
        assert.equal(postsTo(backend, ROOM).length, 0)
      } finally {
        await restarted.stop()
      }
    })
  })

  test('a backend without the route (404): boots, and refuses an unseen group exactly as before', OPTS, async () => {
    await withWorld(async (backend, rig) => {
      backend.seats = null
      const daemon = await startDaemon(rig)
      try {
        const answer = await reply(daemon, ROOM, 'should never be sent')
        assert.match(answer, REFUSED)
        assert.equal(postsTo(backend, ROOM).length, 0)
        // The main chat, from the inbox, is untouched by the missing route.
        const main = await reply(daemon, MAIN, 'the main chat still works')
        assert.doesNotMatch(main, REFUSED)
        assert.equal(postsTo(backend, MAIN).length, 1)
      } finally {
        await daemon.stop()
      }
    })
  })
})
