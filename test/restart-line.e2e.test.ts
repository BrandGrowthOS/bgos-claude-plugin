/**
 * THE AGENT KNOWS IT WAS RESTARTED (board row b7276b5a), end to end on the REAL daemon.
 *
 * KC pressed Restart on an agent in the Helper on 2026-11-13; the restart was real, but asked "were you
 * restarted?" the agent said no: a resumed session carries nothing that says so. Now the restarter (the
 * owner's Restart, the Helper's check up, the watcher) leaves ~/.bgos-agent/<id>/restart-notice.json
 * (lib/restart-notice.mjs), and the daemon the restart brings up puts one line on the first card.
 *
 * Here: a copy of server.ts under bun, a stand in BGOS backend (http and socket.io) and a stand in for
 * Claude Code (an MCP client that collects the channel cards), as test/first-read-cursor-zero.e2e.test.ts.
 *   1. a notice the owner's Restart left 5 s before the daemon booted: KC's first message after the
 *      restart reaches the session with the line in front of it, the meta all strings and nothing added
 *      to it; the notice is gone; KC's next message has no line;
 *   2. no notice (a first start, a crash relaunch): no line;
 *   3. a notice written after the daemon booted (the next restart's): no line, and it stays for that
 *      session.
 *
 * Run with: npx tsx --test test/restart-line.e2e.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

import { RESTART_NOTICE_FILE_NAME, restartLine, restartNoticeBody } from '../lib/restart-notice.mjs'

const ROOT = join(import.meta.dirname, '..')
const BUN = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout ?? ''
const SKIP = process.platform === 'win32' ? 'posix only' : BUN ? false : 'needs bun'
const OPTS = { skip: SKIP, timeout: 120_000 }

const ASSISTANT_ID = 42
const USER_ID = 'u1'
const MAIN = 501

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, what: string, ms = 25_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

type Row = { id: number; chatId: number; sender: 'user'; text: string; senderUserId: string; senderAssistantId: null; messageType: 'standard'; sentDate: string }

/** The backend the daemon needs to arm and receive a live message: the inbox, the chat history, the socket. */
async function startBackend() {
  const rows: Row[] = []
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    const path = new URL(req.url ?? '/', 'http://backend').pathname.replace(/^\/api\/v1\//, '')
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && path === 'peers/inbox') return json({ chats: [{ id: MAIN, assistantId: ASSISTANT_ID, kind: 'main', userId: USER_ID }] })
    if (req.method === 'GET' && path === 'meetings') return json([])
    const history = /^chats\/(\d+)\/messages$/.exec(path)
    if (req.method === 'GET' && history) {
      const after = Number(new URL(req.url ?? '/', 'http://backend').searchParams.get('afterId') ?? 0)
      const page = rows.filter((r) => r.chatId === Number(history[1]) && r.id > after).sort((a, b) => a.id - b.id)
      return json({ messages: page.map((message) => ({ message, messageFiles: [], messageOptions: [] })) })
    }
    return json({})
  }
  const http = createServer(handle)
  const io = new SocketServer(http)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`,
    connected: () => io.of('/').sockets.size,
    /** KC writes in the agent's main chat: stored, and pushed live as the backend does. */
    ownerSays: (id: number, text: string) => {
      const row: Row = { id, chatId: MAIN, sender: 'user', text, senderUserId: USER_ID, senderAssistantId: null, messageType: 'standard', sentDate: new Date().toISOString() }
      rows.push(row)
      io.emit('inbound_message', { assistantId: ASSISTANT_ID, userId: USER_ID, chatId: MAIN, messageId: id, text, files: [], messageType: 'standard' })
    },
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  }
}

type Backend = Awaited<ReturnType<typeof startBackend>>

function makeRig(backendUrl: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'restart-line-')))
  const pluginRoot = join(root, 'plugin')
  const home = join(root, 'home')
  const folder = join(root, 'agent')
  const stateDir = join(home, '.bgos-agent', String(ASSISTANT_ID))
  for (const dir of [pluginRoot, folder, stateDir]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json', '.claude-plugin']) {
    cpSync(join(ROOT, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(pluginRoot, 'node_modules'))
  writeFileSync(
    join(home, '.bgos-agent', `credentials-${ASSISTANT_ID}.json`),
    JSON.stringify({ backendUrl, pairingToken: 'TESTTOKEN', pairingId: 420, userId: USER_ID, assistantId: ASSISTANT_ID, homeDir: folder, homeSource: 'pairing' }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), `${ASSISTANT_ID}\n`)
  // An agent that has run before (a restart resumes one): its cursor file is on disk.
  const cursorPath = join(home, '.bgos-plugin-state', String(ASSISTANT_ID), 'chat-cursors.json')
  mkdirSync(dirname(cursorPath), { recursive: true })
  writeFileSync(cursorPath, JSON.stringify({ v: 1, cursors: { [MAIN]: 100 } }))
  return { root, pluginRoot, home, folder, notice: join(stateDir, RESTART_NOTICE_FILE_NAME) }
}

type Rig = ReturnType<typeof makeRig>
type Card = { content: string; meta: Record<string, unknown> }

async function startDaemon(rig: Rig) {
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
    const params = (n.params ?? {}) as { meta?: Record<string, unknown>; content?: unknown }
    cards.push({ content: String(params.content ?? ''), meta: { ...(params.meta ?? {}) } })
  }
  try {
    await client.connect(transport)
    await client.listTools()
    await waitFor(() => stderr.some((l) => l.includes('startup complete: polling armed')), 'the daemon to arm', 60_000)
  } catch (err) {
    await client.close().catch(() => {})
    throw new Error(`${String(err)}; daemon stderr tail:\n${stderr.slice(-20).join('\n')}`)
  }
  return { cards, stderr, stop: () => client.close() }
}

/** KC's message, as the session receives it: the card that names it. */
async function cardFor(backend: Backend, daemon: Awaited<ReturnType<typeof startDaemon>>, id: number, text: string): Promise<Card> {
  backend.ownerSays(id, text)
  await waitFor(() => daemon.cards.some((c) => c.meta.message_id === String(id)), `the card for message ${id}`)
  return daemon.cards.find((c) => c.meta.message_id === String(id))!
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

test('after the owner\'s Restart, KC\'s first message reaches the session with the restart line in front; the next one does not', OPTS, async () => {
  await withWorld(async (backend, rig) => {
    const pressedAt = Date.now() - 5_000
    writeFileSync(rig.notice, restartNoticeBody({ by: 'owner', atMs: pressedAt })!)
    const daemon = await startDaemon(rig)
    try {
      await waitFor(() => backend.connected() > 0, 'the socket')
      assert.equal(existsSync(rig.notice), false, 'taken by the daemon on its first arm')
      const line = restartLine({ by: 'owner', atMs: pressedAt })
      const first = await cardFor(backend, daemon, 101, 'were you restarted?')
      assert.ok(first.content.startsWith(`${line}\n\n`), `the first card starts with the line:\n${first.content}`)
      assert.match(first.content, /were you restarted\?/)
      for (const [k, v] of Object.entries(first.meta)) assert.equal(typeof v, 'string', `meta.${k} is a string`)
      assert.equal(Object.values(first.meta).some((v) => String(v).includes('restarted')), false, 'nothing about the restart in the meta')
      const second = await cardFor(backend, daemon, 102, 'ok, carry on')
      assert.equal(second.content.includes('You were restarted'), false, `once only:\n${second.content}`)
      assert.equal(daemon.cards.filter((c) => c.content.includes('You were restarted')).length, 1)
      assert.ok(daemon.stderr.some((l) => l.includes('restart line: restarted by the owner')), 'the daemon logs what it took')
    } finally {
      await daemon.stop()
    }
  })
})

test('no notice (a first start or a crash relaunch nobody asked for): no line', OPTS, async () => {
  await withWorld(async (backend, rig) => {
    const daemon = await startDaemon(rig)
    try {
      await waitFor(() => backend.connected() > 0, 'the socket')
      const first = await cardFor(backend, daemon, 101, 'hello')
      assert.equal(first.content.includes('You were restarted'), false, first.content)
    } finally {
      await daemon.stop()
    }
  })
})

test('a notice written after this daemon booted is the next session\'s: no line here, and it stays', OPTS, async () => {
  await withWorld(async (backend, rig) => {
    writeFileSync(rig.notice, restartNoticeBody({ by: 'helper', atMs: Date.now() + 10 * 60_000 })!)
    const daemon = await startDaemon(rig)
    try {
      await waitFor(() => backend.connected() > 0, 'the socket')
      const first = await cardFor(backend, daemon, 101, 'hello')
      assert.equal(first.content.includes('You were restarted'), false, first.content)
      assert.equal(existsSync(rig.notice), true)
    } finally {
      await daemon.stop()
    }
  })
})
