/**
 * A TAP THAT BEATS THE DAEMON'S NEXT POLL IS STILL HEARD.
 *
 * A card can be answered before any read sees it unanswered. Without an
 * immediate baseline, the transition detector loses that tap and sign-in
 * waits for a method the owner already picked.
 *
 * The daemon tracks its sign-in card independently of ordinary button baselines. Every
 * case here posts a card through the REAL daemon (a copy of server.ts under
 * bun) to a stand in backend that stamps the card answered before it even
 * answers the post, so no read can ever see it unanswered, and asserts the
 * tap still does what it is for:
 *   - the sign-in card, both chips: the chip's method starts (the stand in
 *     `claude` records its arguments, and its link is relayed to the chat).
 *
 * The real `claude` is never run: the stand in sits first on PATH and in
 * CLAUDE_CODE_EXECPATH, and the case asserts on the stand in's own record of
 * its arguments, which only the stand in writes.
 *
 * Run with: npx tsx --test test/own-card-fast-tap.e2e.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

import { LOGIN_METHOD_BUTTONS } from '../lib/auth-login.ts'

const ROOT = join(import.meta.dirname, '..')
const BUN = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout ?? ''
const SKIP = process.platform === 'win32' ? 'posix only' : BUN ? false : 'needs bun'
const OPTS = { skip: SKIP, timeout: 150_000 }

const ASSISTANT_ID = 42
const USER_ID = 'u1'
const MAIN = 501
/** The card's text as the daemon posts it to an owner whose agent is signed out. */
const SIGNED_OUT_LEAD = 'This agent is not signed in. Pick how to sign in.'

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

async function fixtureDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fixture timed out waiting for ${what}`)), 25_000)
  })
  try { return await Promise.race([work, deadline]) }
  finally { clearTimeout(timer!) }
}

async function startHeldRead(backend: Backend, entered: () => boolean): Promise<void> {
  const until = Date.now() + 20_000
  while (!entered()) {
    if (Date.now() > until) throw new Error('fixture could not start the held read')
    // A reconnect catch-up can coalesce with read A before A has finished.
    // Keep triggering the normal catch-up path until read B really enters.
    backend.reconnect()
    await waitQuietly(entered, 2_000)
  }
}

interface StoredOption {
  id: number
  text: string
  callbackData: string
  style: string | null
}

interface StoredRow {
  id: number
  chatId: number
  sender: 'user' | 'assistant' | 'system'
  text: string
  messageType: string
  renderMode: string | null
  eventMeta: unknown
  senderUserId: string | null
  senderAssistantId: number | null
  sentDate: string
  options: StoredOption[]
  answeredAt: string | null
  answerPayload: Record<string, unknown> | null
}

/** What the daemon posted, as the stand in received it. */
interface Post {
  route: 'send-message' | 'messages'
  id: number
  body: Record<string, unknown>
}

interface Backend {
  url: string
  rows: StoredRow[]
  posts: Post[]
  /**
   * The owner's tap, decided the moment the daemon posts a card with buttons:
   * the index of the option tapped, or null to leave the card open. Stamped
   * before the post is answered, so no read can ever see the card unanswered.
   */
  tapOnPost: ((body: Record<string, unknown>) => number | null) | null
  anchoredReads: Array<{ id: number; conditional: boolean }>
  pollRequests: Array<{ afterId: number; conditional: boolean; status: number }>
  failAnchoredReads: number
  honorEtags: boolean
  holdPost: ((row: StoredRow) => Promise<void>) | null
  readsOf: (chatId: number) => number
  /**
   * Hold the NEXT poll read of a chat: its page is taken when the read
   * arrives, `during` runs, and only then is that page answered, so the daemon
   * gets a read that began before whatever `during` did.
   */
  holdNextRead: (chatId: number, during: (afterId: number) => Promise<void>) => void
  /** Errors thrown inside a hold; the read is answered anyway. */
  holdErrors: string[]
  /** The next message id, from the same sequence the stored posts use. */
  allocateId: () => number
  connected: () => number
  reconnect: () => void
  emit: (event: string, payload: Record<string, unknown>) => void
  close: () => Promise<void>
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function historyRow(id: number, sender: 'user' | 'assistant', text: string): StoredRow {
  return {
    id,
    chatId: MAIN,
    sender,
    text,
    messageType: 'standard',
    renderMode: null,
    eventMeta: null,
    senderUserId: sender === 'user' ? USER_ID : null,
    senderAssistantId: sender === 'assistant' ? ASSISTANT_ID : null,
    sentDate: new Date().toISOString(),
    options: [],
    answeredAt: null,
    answerPayload: null,
  }
}

async function startBackend(): Promise<Backend> {
  // A chat with history, like the one in production: the boot reads see it,
  // so the daemon starts with a baseline for this chat and nothing open in it.
  const rows: StoredRow[] = [historyRow(101, 'user', 'morning'), historyRow(102, 'assistant', 'morning to you')]
  const posts: Post[] = []
  const reads = new Map<number, number>()
  const holds = new Map<number, (afterId: number) => Promise<void>>()
  const holdErrors: string[] = []
  let nextMessageId = 1000
  let nextOptionId = 15537

  const backend: Backend = {
    url: '',
    rows,
    posts,
    tapOnPost: null,
    anchoredReads: [],
    pollRequests: [],
    failAnchoredReads: 0,
    honorEtags: false,
    holdPost: null,
    readsOf: (chatId) => reads.get(chatId) ?? 0,
    holdNextRead: (chatId, during) => {
      holds.set(chatId, during)
    },
    holdErrors,
    allocateId: () => nextMessageId++,
    connected: () => 0,
    reconnect: () => {},
    emit: () => {},
    close: async () => {},
  }

  function store(route: Post['route'], body: Record<string, unknown>): StoredRow {
    const id = nextMessageId++
    const options = (Array.isArray(body.options) ? body.options : []).map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>
      return {
        id: nextOptionId++,
        text: String(o.text ?? ''),
        callbackData: String(o.callbackData ?? ''),
        style: typeof o.style === 'string' ? o.style : null,
      }
    })
    const row: StoredRow = {
      id,
      chatId: Number(body.chatId),
      sender: 'assistant',
      text: String(body.text ?? ''),
      messageType: String(body.messageType ?? 'standard'),
      renderMode: typeof body.renderMode === 'string' ? body.renderMode : null,
      eventMeta: body.eventMeta ?? null,
      senderUserId: null,
      senderAssistantId: ASSISTANT_ID,
      sentDate: new Date().toISOString(),
      options,
      answeredAt: null,
      answerPayload: null,
    }
    rows.push(row)
    posts.push({ route, id, body })
    const tapped = options.length > 0 && backend.tapOnPost ? backend.tapOnPost(body) : null
    const option = tapped === null ? undefined : options[tapped]
    if (option) {
      // The backend's own stamp (message.service.ts handleCallback).
      row.answeredAt = new Date().toISOString()
      row.answerPayload = {
        optionId: option.id,
        callbackData: option.callbackData,
        buttonText: option.text,
        skipped: false,
        answeredByUserId: USER_ID,
      }
    }
    return row
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://backend')
    const path = url.pathname.replace(/^\/api\/v1\//, '')
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : (req.resume(), {})
    if (req.method === 'GET' && path === 'peers/inbox') {
      return json({ chats: [{ id: MAIN, assistantId: ASSISTANT_ID, kind: 'main', userId: USER_ID }] })
    }
    if (req.method === 'GET' && path === 'meetings') return json([])
    const history = /^chats\/(\d+)\/messages$/.exec(path)
    if (req.method === 'GET' && history) {
      const chatId = Number(history[1])
      const isPoll = req.headers['x-caller-assistant-id'] !== undefined
      if (isPoll) reads.set(chatId, (reads.get(chatId) ?? 0) + 1)
      const afterParam = url.searchParams.get('afterId')
      const afterId = afterParam === null ? 0 : Number(afterParam)
      const beforeId = Number(url.searchParams.get('beforeId') ?? Infinity)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const anchored = limit === 1 && beforeId === afterId + 2
      if (anchored) backend.anchoredReads.push({ id: afterId + 1, conditional: req.headers['if-none-match'] !== undefined })
      if (anchored && backend.failAnchoredReads > 0) {
        backend.failAnchoredReads--
        return json({ error: 'transient fixture failure' }, 503)
      }
      // The real route: the NEWEST 50 rows above the cursor, oldest first.
      // Taken NOW, as the read arrives, and copied, so a held read answers
      // with the chat as it was when the read began.
      const page = JSON.parse(
        JSON.stringify(
          rows
            .filter((r) => r.chatId === chatId && r.id > afterId && r.id < beforeId)
            .sort((a, b) => a.id - b.id)
            .slice(-limit),
        ),
      ) as StoredRow[]
      const hold = isPoll ? holds.get(chatId) : undefined
      if (hold) {
        holds.delete(chatId)
        await hold(afterId).catch((err: unknown) => {
          holdErrors.push(String(err))
        })
      }
      const response = {
        messages: page.map((r) => ({
          message: {
            id: r.id,
            chatId: r.chatId,
            sender: r.sender,
            text: r.text,
            messageType: r.messageType,
            renderMode: r.renderMode,
            eventMeta: r.eventMeta,
            senderUserId: r.senderUserId,
            senderAssistantId: r.senderAssistantId,
            sentDate: r.sentDate,
            answeredAt: r.answeredAt,
            answerPayload: r.answerPayload,
          },
          messageFiles: [],
          messageOptions: r.options.map((o) => ({ ...o, messageId: r.id })),
        })),
      }
      const etag = `"${Buffer.from(JSON.stringify(response)).toString('base64url')}"`
      const status = backend.honorEtags && req.headers['if-none-match'] === etag ? 304 : 200
      if (isPoll && !anchored) backend.pollRequests.push({ afterId, conditional: req.headers['if-none-match'] !== undefined, status })
      if (backend.honorEtags) res.setHeader('ETag', etag)
      if (status === 304) { res.writeHead(304); res.end(); return }
      return json(response)
    }
    if (req.method === 'POST' && path === 'send-message') {
      const row = store('send-message', body)
      if (backend.holdPost) await fixtureDeadline(backend.holdPost(row), 'send-message POST release')
      return json({ message: { id: row.id, chatId: row.chatId, text: row.text } })
    }
    if (req.method === 'POST' && path === 'messages') {
      const row = store('messages', body)
      if (backend.holdPost) await fixtureDeadline(backend.holdPost(row), 'messages POST release')
      return json({ id: row.id, chatId: row.chatId, text: row.text })
    }
    return json({})
  }

  const http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  const io = new SocketServer(http)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  backend.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`
  backend.connected = () => io.of('/').sockets.size
  backend.reconnect = () => {
    for (const socket of io.of('/').sockets.values()) socket.conn.close()
  }
  backend.emit = (event, payload) => {
    io.emit(event, payload)
  }
  backend.close = () => new Promise<void>((resolve) => {
    io.close(() => resolve())
    http.closeAllConnections()
  })
  return backend
}

interface Rig {
  root: string
  home: string
  folder: string
  pluginRoot: string
  /** Where the stand in `claude` records every argument list it is run with. */
  claudeCalls: string
  claudeBin: string
}

/**
 * A stand in for the claude CLI: signed out, and a sign-in that prints its
 * link the way 2.1.289 does and then waits for the code (never sent here).
 */
function writeStandInClaude(binDir: string, callsPath: string): string {
  const bin = join(binDir, 'claude')
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${callsPath}'`,
      'if [ "$1" = auth ] && [ "$2" = status ]; then',
      `  echo '{"loggedIn": false, "authMethod": "none", "email": null, "subscriptionType": null}'`,
      '  exit 1',
      'fi',
      'if [ "$1" = auth ] && [ "$2" = login ]; then',
      '  host=claude.ai',
      '  [ "$3" = --console ] && host=platform.claude.com',
      '  echo "Opening browser to sign in"',
      `  echo "If the browser didn't open, visit: https://$host/oauth/authorize?code=true&client_id=stand-in&state=standinstate$3"`,
      "  printf 'Paste code here if prompted > '",
      // Plain `read`: dash (Ubuntu's sh) has no -t. It ends when the daemon,
      // and with it this pipe, goes away.
      '  read code',
      '  exit 1',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

function makeRig(backendUrl: string): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'own-card-tap-')))
  const pluginRoot = join(root, 'plugin')
  const home = join(root, 'home')
  const folder = join(root, 'agent')
  const binDir = join(root, 'bin')
  for (const dir of [pluginRoot, folder, binDir, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json', '.claude-plugin']) {
    cpSync(join(ROOT, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(pluginRoot, 'node_modules'))
  writeFileSync(
    join(home, '.bgos-agent', `credentials-${ASSISTANT_ID}.json`),
    JSON.stringify({ backendUrl, pairingToken: 'TESTTOKEN', pairingId: 420, userId: USER_ID, assistantId: ASSISTANT_ID, homeDir: folder, homeSource: 'pairing' }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), `${ASSISTANT_ID}\n`)
  // Not a first install: the daemon has read chats before.
  const cursorPath = join(home, '.bgos-plugin-state', String(ASSISTANT_ID), 'chat-cursors.json')
  mkdirSync(dirname(cursorPath), { recursive: true })
  writeFileSync(cursorPath, JSON.stringify({ v: 1, cursors: { [String(MAIN)]: 102 } }))
  const claudeCalls = join(root, 'claude-calls.log')
  const claudeBin = writeStandInClaude(binDir, claudeCalls)
  return { root, home, folder, pluginRoot, claudeCalls, claudeBin }
}

interface Card {
  chatId: number
  messageId: number
  content: string
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
      // The stand in claude FIRST. No directory here holds the real one
      // (it lives under ~/.local/bin), and CLAUDE_CODE_EXECPATH, which the
      // daemon reads before PATH, names the stand in as well.
      PATH: [dirname(rig.claudeBin), dirname(BUN), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      CLAUDE_CODE_EXECPATH: rig.claudeBin,
      HOME: rig.home,
      CLAUDE_CONFIG_DIR: join(rig.home, '.claude'),
      BGOS_LAUNCH_CWD: rig.folder,
      HOAI_BROWSER_HOST: 'off',
      BGOS_BOOT_HELLO: 'off',
      BGOS_AUTO_UPDATE: 'disabled',
      TMPDIR: rig.root,
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
    cards.push({ chatId: Number(meta.chat_id), messageId: Number(meta.message_id), content: String(params.content ?? '') })
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

interface World {
  backend: Backend
  rig: Rig
  daemon: Daemon
  end: () => Promise<void>
}

/** A booted daemon whose boot reads of the chat are done and whose socket is up. */
async function world(): Promise<World> {
  const backend = await startBackend()
  let rig: Rig | null = null
  let daemon: Daemon | null = null
  const end = async () => {
    if (daemon) await daemon.stop().catch(() => {})
    await backend.close()
    if (rig) rmSync(rig.root, { recursive: true, force: true })
  }
  try {
    rig = makeRig(backend.url)
    daemon = await startDaemon(rig)
    await waitFor(() => backend.connected() > 0 && backend.readsOf(MAIN) >= 2, 'the boot reads and the socket', 30_000)
    await sleep(300)
    return { backend, rig, daemon, end }
  } catch (err) {
    await end()
    throw err
  }
}

function claudeCalls(rig: Rig): string[] {
  return existsSync(rig.claudeCalls) ? readFileSync(rig.claudeCalls, 'utf8').split('\n').filter(Boolean) : []
}

/**
 * The owner's /login, as the backend pushes a slash command on the socket. Its
 * id comes from the backend's own sequence, so it sorts after every row before
 * it and before the card the daemon posts in answer, as in production.
 */
function ownerSendsLogin(backend: Backend): void {
  const messageId = backend.allocateId()
  backend.rows.push({ ...historyRow(messageId, 'user', '/login'), messageType: 'slash_command' })
  backend.emit('inbound_message', {
    assistantId: ASSISTANT_ID,
    userId: USER_ID,
    chatId: MAIN,
    messageId,
    text: '/login',
    files: [],
    messageType: 'slash_command',
    commandName: 'login',
    commandArgs: '',
    sender: { userId: USER_ID, relationship: 'owner' },
  })
}

function loginCardOf(backend: Backend): Post | undefined {
  return backend.posts.find((p) => String(p.body.text ?? '').startsWith(SIGNED_OUT_LEAD))
}

/** An open card of the agent's own (nobody taps it): it keeps the chat on the fast read. */
const OPEN_CARD_TEXT = 'Anything else before I start?'

async function postOpenCard(w: World): Promise<void> {
  const result = await w.daemon.client.callTool({
    name: 'reply',
    arguments: {
      chat_id: String(MAIN),
      text: OPEN_CARD_TEXT,
      buttons: [
        { label: 'No', value: 'no' },
        { label: 'Yes', value: 'yes' },
      ],
    },
  })
  assert.notEqual(result.isError, true, `the open card was sent: ${JSON.stringify(result.content)}`)
}

/**
 * Make the daemon read the chat `count` more times: an announced tap must stay
 * announced once however often the chat is read after it. Without this, a tap
 * announced once takes the chat off the fast read, nothing reads it again, and
 * "never twice" holds whatever the code does.
 */
async function forceReads(w: World, count: number): Promise<void> {
  const before = w.backend.readsOf(MAIN)
  await postOpenCard(w)
  await waitFor(() => w.backend.readsOf(MAIN) >= before + count, `${count} more reads of the chat`, 30_000)
}

function evidence(w: World): string {
  return [
    `claude calls: ${JSON.stringify(claudeCalls(w.rig))}`,
    `daemon posts: ${JSON.stringify(w.backend.posts.map((p) => String(p.body.text ?? '').slice(0, 70)))}`,
    `daemon log tail:\n${w.daemon.stderr
      .filter((l) => /login|button|click|plan answer|reply sent|propose_plan/i.test(l) && !l.includes(w.rig.root))
      .slice(-12)
      .join('\n')}`,
  ].join('\n')
}

describe('a tap on a card this daemon posted is heard when it lands before the next read', { concurrency: 1 }, () => {
  for (const [index, chip] of LOGIN_METHOD_BUTTONS.entries()) {
    const flag = chip.callbackData === 'login:console' ? '--console' : '--claudeai'
    test(`/login, then "${chip.text}" tapped at once: that sign-in starts and its link is relayed`, OPTS, async () => {
      const w = await world()
      try {
        // The owner taps this chip the moment the card exists.
        w.backend.tapOnPost = (body) => (String(body.text ?? '').startsWith(SIGNED_OUT_LEAD) ? index : null)
        ownerSendsLogin(w.backend)
        await waitFor(() => loginCardOf(w.backend) !== undefined, 'the sign-in card')

        const cardId = loginCardOf(w.backend)!.id
        // The card exactly as production received it: same words, both chips,
        // the first marked primary, inline.
        const card = loginCardOf(w.backend)!
        assert.deepEqual(
          card.body.options,
          [
            { text: 'Claude subscription', callbackData: 'login:claudeai', style: 'primary' },
            { text: 'Anthropic Console', callbackData: 'login:console' },
          ],
          'the card carries both methods',
        )
        assert.equal(card.body.renderMode, 'inline')
        assert.equal(card.route, 'send-message')
        const stamped = w.backend.rows.find((r) => r.id === card.id)
        assert.equal(stamped?.answerPayload?.callbackData, chip.callbackData, 'the stand in stamped the tap at once')

        await waitQuietly(
          () =>
            claudeCalls(w.rig).includes(`auth login ${flag}`) &&
            w.backend.posts.some((p) => String(p.body.text ?? '').startsWith('Open this link')),
          20_000,
        )
        assert.ok(
          claudeCalls(w.rig).includes(`auth login ${flag}`),
          `the tap on "${chip.text}" started \`claude auth login ${flag}\`\n${evidence(w)}`,
        )
        assert.deepEqual(w.backend.anchoredReads.filter((r) => r.id === cardId), [{ id: cardId, conditional: false }], 'one unconditional direct read of this sign-in card')
        assert.equal(
          claudeCalls(w.rig).filter((c) => c.startsWith('auth login')).length,
          1,
          `exactly one sign-in started\n${evidence(w)}`,
        )
        const link = w.backend.posts.find((p) => String(p.body.text ?? '').startsWith('Open this link'))
        assert.ok(link, `the sign-in link was relayed to the chat\n${evidence(w)}`)
        assert.match(String(link.body.text), new RegExp(`state=standinstate${flag}`), 'the link of the method tapped')
        // Read the chat again and again: the tap is heard once, so no second
        // sign-in and no "no longer open" for a tap already taken.
        await forceReads(w, 2)
        assert.equal(claudeCalls(w.rig).filter((c) => c.startsWith('auth login')).length, 1, `still one sign-in\n${evidence(w)}`)
        assert.ok(
          !w.backend.posts.some((p) => /no longer open/.test(String(p.body.text ?? ''))),
          `the tap was never taken twice\n${evidence(w)}`,
        )
      } finally {
        await w.end()
      }
    })
  }

  test('review: a completed answered full read and repeated ETag 304s cannot hide a delayed POST answer', OPTS, async () => {
    const w = await world()
    try {
      await postOpenCard(w)
      w.backend.honorEtags = true
      w.backend.tapOnPost = (body) => String(body.text ?? '').startsWith(SIGNED_OUT_LEAD) ? 0 : null
      let completed = false
      w.backend.holdPost = async (row) => {
        if (!row.text.startsWith(SIGNED_OUT_LEAD)) return
        const reads = w.backend.pollRequests.length
        await waitFor(() => w.backend.pollRequests.length > reads, 'full read A of the already answered card')
        await waitFor(() => w.backend.pollRequests.slice(reads).some((r) => r.status === 304), 'a cached full read returning 304')
        completed = true
      }
      ownerSendsLogin(w.backend)
      await waitQuietly(() => claudeCalls(w.rig).includes('auth login --claudeai'), 15_000)
      assert.equal(completed, true, 'the POST returned only after the answered body and a 304 were processed')
      assert.ok(w.backend.pollRequests.some((r) => r.afterId === 0 && r.status === 304), 'the backend honored a full-read validator')
      assert.ok(claudeCalls(w.rig).includes('auth login --claudeai'), `the direct read delivered the cached answer\n${evidence(w)}`)
      assert.equal(w.backend.anchoredReads.filter((r) => r.id === loginCardOf(w.backend)!.id).length, 1)
    } finally { await w.end() }
  })

  test('review: cached answered history recovers after the one direct request fails with 503', OPTS, async () => {
    const w = await world()
    try {
      await postOpenCard(w)
      w.backend.honorEtags = true
      w.backend.failAnchoredReads = 1
      w.backend.tapOnPost = (body) => String(body.text ?? '').startsWith(SIGNED_OUT_LEAD) ? 0 : null
      let completed = false
      w.backend.holdPost = async (row) => {
        if (!row.text.startsWith(SIGNED_OUT_LEAD)) return
        const reads = w.backend.pollRequests.length
        await waitFor(() => w.backend.pollRequests.length > reads, 'full read A of the already answered card')
        await waitFor(() => w.backend.pollRequests.slice(reads).some((r) => r.status === 304), 'a cached full read returning 304')
        completed = true
      }
      ownerSendsLogin(w.backend)
      await waitQuietly(() => claudeCalls(w.rig).includes('auth login --claudeai'), 15_000)
      assert.equal(completed, true, 'the POST returned only after the answered body and a 304 were processed')
      assert.ok(w.backend.pollRequests.some((r) => r.afterId === 0 && r.status === 304), 'the backend honored a full-read validator')
      assert.ok(claudeCalls(w.rig).includes('auth login --claudeai'), `a fresh history body delivered the cached answer after direct failure\n${evidence(w)}`)
      assert.equal(w.backend.anchoredReads.filter((r) => r.id === loginCardOf(w.backend)!.id).length, 1)
      assert.equal(w.backend.failAnchoredReads, 0, 'the single direct request actually failed')
      const cached = w.backend.pollRequests.findIndex((r) => r.status === 304)
      assert.ok(w.backend.pollRequests.slice(cached + 1).some((r) => r.afterId === 0 && !r.conditional && r.status === 200), 'ordinary polling obtained a fresh covering body after the cached read')
      await forceReads(w, 2)
      assert.equal(claudeCalls(w.rig).filter((c) => c.startsWith('auth login')).length, 1)
      assert.ok(!w.backend.posts.some((p) => /no longer open/.test(String(p.body.text ?? ''))))
    } finally { await w.end() }
  })

  test('review: answered read A, delta B above the card, POST during B and a failed direct read recover on full read C', OPTS, async () => {
    const w = await world()
    try {
      const before = w.backend.readsOf(MAIN)
      await postOpenCard(w)
      await waitFor(() => w.backend.readsOf(MAIN) > before, 'the unrelated open-card baseline')
      w.backend.rows.find((r) => r.text === OPEN_CARD_TEXT)!.options = []
      w.backend.failAnchoredReads = 1
      w.backend.tapOnPost = (body) => String(body.text ?? '').startsWith(SIGNED_OUT_LEAD) ? 0 : null
      let deltaFloor = -1
      let releasePost!: () => void
      w.backend.holdPost = async (row) => {
        if (!row.text.startsWith(SIGNED_OUT_LEAD)) return
        const reads = w.backend.pollRequests.length
        await waitFor(() => w.backend.pollRequests.slice(reads).some((r) => r.afterId === 0 && r.status === 200), 'read A of the answered card before POST returns')
        w.backend.rows.push(historyRow(w.backend.allocateId(), 'assistant', 'A newer row for delta B'))
        w.backend.holdNextRead(MAIN, async (afterId) => {
          deltaFloor = afterId
          releasePost()
          await waitFor(() => w.daemon.stderr.some((l) => /\/login: sign-in card \d+ posted to chat 501/.test(l)), 'POST to return while delta B is in flight')
        })
        const postRelease = new Promise<void>((resolve) => { releasePost = resolve })
        await startHeldRead(w.backend, () => deltaFloor >= 0)
        await postRelease
      }
      ownerSendsLogin(w.backend)
      await waitQuietly(() => claudeCalls(w.rig).includes('auth login --claudeai'), 25_000)
      assert.equal(deltaFloor, loginCardOf(w.backend)!.id, 'B explicitly excluded the sign-in card')
      assert.equal(w.backend.failAnchoredReads, 0)
      assert.deepEqual(w.backend.holdErrors, [])
      assert.ok(claudeCalls(w.rig).includes('auth login --claudeai'), evidence(w))
      assert.ok(w.backend.pollRequests.some((r) => r.afterId === 0 && !r.conditional && r.status === 200), 'C fetched a fresh covering body')
      assert.equal(w.backend.anchoredReads.filter((r) => r.id === loginCardOf(w.backend)!.id).length, 1)
    } finally { await w.end() }
  })

  test('a read already in flight when the sign-in card is posted does not erase it: the tap is heard on the next read', OPTS, async () => {
    const w = await world()
    try {
      // The chat is on the fast read (an open card of the agent's own), and
      // the owner taps the sign-in card the moment it exists.
      w.backend.tapOnPost = (body) => (String(body.text ?? '').startsWith(SIGNED_OUT_LEAD) ? 0 : null)
      await postOpenCard(w)
      // The next read begins, and while it is in flight the owner sends /login
      // and the card is posted and tapped. That read then answers with the chat
      // as it was before the card: the card is not in it.
      let heldReadAnswered = false
      w.backend.holdNextRead(MAIN, async () => {
        ownerSendsLogin(w.backend)
        await waitFor(() => loginCardOf(w.backend) !== undefined, 'the sign-in card, posted during the held read')
        // Released only once the daemon has taken the post's answer and noted
        // the card open (its log line follows the note), so this read is
        // certain to land after the note: the order the keep rule exists for,
        // however slow the machine.
        await waitFor(
          () => w.daemon.stderr.some((l) => /\/login: sign-in card \d+ posted to chat 501/.test(l)),
          'the daemon to note the card it posted',
        )
        heldReadAnswered = true
      })
      await waitQuietly(() => claudeCalls(w.rig).includes('auth login --claudeai'), 25_000)
      await waitFor(() => heldReadAnswered, 'the stale held read to finish after the direct answer')
      assert.equal(heldReadAnswered, true, `the held read ran\n${evidence(w)}`)
      assert.deepEqual(w.backend.holdErrors, [], 'the hold itself did not fail')
      assert.ok(
        claudeCalls(w.rig).includes('auth login --claudeai'),
        `the tap on the card posted during a read in flight started the sign-in\n${evidence(w)}`,
      )
    } finally {
      await w.end()
    }
  })
})

const FAST_CARD_TEXT = 'Review the sample change'
type FastCardKind = 'reply' | 'plan'

function isFastCard(body: Record<string, unknown>): boolean {
  return String(body.text ?? '').includes(FAST_CARD_TEXT)
}

async function postFastCard(w: World, kind: FastCardKind): Promise<void> {
  const result = await w.daemon.client.callTool(kind === 'reply' ? {
    name: 'reply',
    arguments: { chat_id: String(MAIN), text: FAST_CARD_TEXT, buttons: [{ label: 'Continue', value: 'continue' }] },
  } : {
    name: 'propose_plan',
    arguments: { chat_id: String(MAIN), title: FAST_CARD_TEXT, steps: [{ text: 'Update the sample' }], door: 'decided' },
  })
  assert.notEqual(result.isError, true, JSON.stringify(result.content))
}

async function assertFastCardDelivered(w: World, kind: FastCardKind): Promise<number> {
  const post = w.backend.posts.find((p) => isFastCard(p.body))!
  assert.ok(post, 'the card was posted')
  await waitQuietly(() => w.daemon.cards.some((c) => c.messageId === post.id), 12_000)
  const delivered = w.daemon.cards.filter((c) => c.messageId === post.id)
  assert.equal(delivered.length, 1, `the ${kind} tap reaches the model exactly once\n${evidence(w)}`)
  assert.match(delivered[0].content, kind === 'plan' ? /Go ahead/ : /Clicked: Continue/)
  if (kind === 'plan') assert.match(delivered[0].content, /proceed|approved/i, 'the plan directive reaches the model')
  assert.deepEqual(w.backend.anchoredReads.filter((r) => r.id === post.id), [{ id: post.id, conditional: false }], 'one unconditional read by card ID')
  await forceReads(w, 2)
  assert.equal(w.daemon.cards.filter((c) => c.messageId === post.id).length, 1, 'later history reads do not replay the tap')
  return post.id
}

describe('reply and plan cards recover fast taps', { concurrency: 1 }, () => {
  for (const kind of ['reply', 'plan'] as const) {
    test(`${kind}: a tap between history reads is delivered by the direct card read`, OPTS, async () => {
      const w = await world()
      try {
        w.backend.tapOnPost = (body) => isFastCard(body) ? 0 : null
        await postFastCard(w, kind)
        await assertFastCardDelivered(w, kind)
      } finally { await w.end() }
    })

    test(`${kind}: delayed POST after answered history and ETag 304 still delivers once`, OPTS, async () => {
      const w = await world()
      try {
        await postOpenCard(w)
        w.backend.honorEtags = true
        w.backend.tapOnPost = (body) => isFastCard(body) ? 0 : null
        let completed = false
        w.backend.holdPost = async (row) => {
          if (!row.text.includes(FAST_CARD_TEXT)) return
          const reads = w.backend.pollRequests.length
          await waitFor(() => w.backend.pollRequests.length > reads, 'answered history before POST returns')
          await waitFor(() => w.backend.pollRequests.slice(reads).some((r) => r.status === 304), 'cached history before POST returns')
          completed = true
        }
        await postFastCard(w, kind)
        assert.equal(completed, true)
        await assertFastCardDelivered(w, kind)
      } finally { await w.end() }
    })

    test(`${kind}: an in-flight delta cannot erase a posted card after its direct read fails`, OPTS, async () => {
      const w = await world()
      try {
        const before = w.backend.readsOf(MAIN)
        await postOpenCard(w)
        await waitFor(() => w.backend.readsOf(MAIN) > before, 'the unrelated card baseline')
        w.backend.rows.find((r) => r.text === OPEN_CARD_TEXT)!.options = []
        w.backend.honorEtags = true
        w.backend.tapOnPost = (body) => isFastCard(body) ? 0 : null
        w.backend.failAnchoredReads = 1
        let deltaFloor = -1
        let releasePost!: () => void
        w.backend.holdPost = async (row) => {
          if (!row.text.includes(FAST_CARD_TEXT)) return
          const reads = w.backend.pollRequests.length
          await waitFor(() => w.backend.pollRequests.slice(reads).some((r) => r.afterId === 0 && r.status === 200), 'answered read A before POST returns')
          w.backend.rows.push(historyRow(w.backend.allocateId(), 'assistant', 'A newer sample row'))
          w.backend.holdNextRead(MAIN, async (afterId) => {
            deltaFloor = afterId
            releasePost()
            await waitFor(() => w.backend.failAnchoredReads === 0, 'the direct read to fail while delta B is in flight')
          })
          const postRelease = new Promise<void>((resolve) => { releasePost = resolve })
          // Retiring the unrelated card removes its fast scope. A local
          // reconnect starts read B without waiting for the global sweep.
          await startHeldRead(w.backend, () => deltaFloor >= 0)
          await postRelease
        }
        await postFastCard(w, kind)
        const id = await assertFastCardDelivered(w, kind)
        assert.equal(deltaFloor, id, 'delta B explicitly excluded this card')
        assert.deepEqual(w.backend.holdErrors, [])
        const deltaRead = w.backend.pollRequests.findIndex((r) => r.afterId === id)
        assert.ok(deltaRead >= 0, 'the excluding delta response completed')
        assert.ok(w.backend.pollRequests.slice(deltaRead + 1).some((r) => r.afterId === 0 && !r.conditional && r.status === 200), 'after delta B, a fresh full read C bypassed the cached full body and recovered the answer')
      } finally { await w.end() }
    })
  }
})
