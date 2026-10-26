/**
 * A TAP THAT BEATS THE DAEMON'S NEXT POLL IS STILL HEARD (feedback 0984e340).
 *
 * Production, 2026-10-26 (chat 1146, agent 911, plugin 0.69.12): the owner
 * sent /login and the daemon posted its sign-in card at 09:53:47.600. The
 * owner tapped "Claude subscription" and the backend stamped the card answered
 * at 09:53:49.362. The daemon's first read of that chat after posting the card
 * ran at 09:53:49.560, 198 ms after the tap. A tap reaches this daemon only
 * through that read, and only as a TRANSITION: a card some earlier read saw
 * unanswered that is answered now (selectClickTransitions). No read had seen
 * the new card unanswered, so the tap was never announced, the sign-in sat in
 * "waiting for a sign-in method to be picked" until it expired, and the app
 * honestly showed the card as answered ("✓ Claude subscription"). A second
 * /login got "A sign-in is already running".
 *
 * The daemon knows its own card is unanswered the moment it posts it. Every
 * case here posts a card through the REAL daemon (a copy of server.ts under
 * bun) to a stand in backend that stamps the card answered before it even
 * answers the post, so no read can ever see it unanswered, and asserts the
 * tap still does what it is for:
 *   - the sign-in card, both chips: the chip's method starts (the stand in
 *     `claude` records its arguments, and its link is relayed to the chat);
 *   - a `reply` with buttons: the click reaches the session;
 *   - a `propose_plan` card: the answer reaches the session.
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
  readsOf: (chatId: number) => number
  /**
   * Hold the NEXT poll read of a chat: its page is taken when the read
   * arrives, `during` runs, and only then is that page answered, so the daemon
   * gets a read that began before whatever `during` did.
   */
  holdNextRead: (chatId: number, during: () => Promise<void>) => void
  /** Errors thrown inside a hold; the read is answered anyway. */
  holdErrors: string[]
  connected: () => number
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
  const holds = new Map<number, () => Promise<void>>()
  const holdErrors: string[] = []
  let nextMessageId = 1000
  let nextOptionId = 15537

  const backend: Backend = {
    url: '',
    rows,
    posts,
    tapOnPost: null,
    readsOf: (chatId) => reads.get(chatId) ?? 0,
    holdNextRead: (chatId, during) => {
      holds.set(chatId, during)
    },
    holdErrors,
    connected: () => 0,
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
      // The real route: the NEWEST 50 rows above the cursor, oldest first.
      // Taken NOW, as the read arrives, and copied, so a held read answers
      // with the chat as it was when the read began.
      const page = JSON.parse(
        JSON.stringify(
          rows
            .filter((r) => r.chatId === chatId && r.id > afterId)
            .sort((a, b) => a.id - b.id)
            .slice(-50),
        ),
      ) as StoredRow[]
      const hold = isPoll ? holds.get(chatId) : undefined
      if (hold) {
        holds.delete(chatId)
        await hold().catch((err: unknown) => {
          holdErrors.push(String(err))
        })
      }
      return json({
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
      })
    }
    if (req.method === 'POST' && path === 'send-message') {
      const row = store('send-message', body)
      return json({ message: { id: row.id, chatId: row.chatId, text: row.text } })
    }
    if (req.method === 'POST' && path === 'messages') {
      const row = store('messages', body)
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
  backend.emit = (event, payload) => {
    io.emit(event, payload)
  }
  backend.close = () => new Promise<void>((resolve) => io.close(() => resolve()))
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

/** The owner's /login, as the backend pushes a slash command on the socket. */
function ownerSendsLogin(backend: Backend, messageId: number): void {
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

describe('a tap on a card this daemon posted is heard when it lands before the next read', { concurrency: true }, () => {
  for (const [index, chip] of LOGIN_METHOD_BUTTONS.entries()) {
    const flag = chip.callbackData === 'login:console' ? '--console' : '--claudeai'
    test(`/login, then "${chip.text}" tapped at once: that sign-in starts and its link is relayed`, OPTS, async () => {
      const w = await world()
      try {
        // The owner taps this chip the moment the card exists.
        w.backend.tapOnPost = (body) => (String(body.text ?? '').startsWith(SIGNED_OUT_LEAD) ? index : null)
        ownerSendsLogin(w.backend, 300)
        await waitFor(() => loginCardOf(w.backend) !== undefined, 'the sign-in card')

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

  test('a reply with buttons, a button tapped at once: the click reaches the session once', OPTS, async () => {
    const w = await world()
    try {
      w.backend.tapOnPost = (body) => (String(body.text ?? '') === 'Ship it now?' ? 0 : null)
      const result = await w.daemon.client.callTool({
        name: 'reply',
        arguments: {
          chat_id: String(MAIN),
          text: 'Ship it now?',
          buttons: [
            { label: 'Ship it', value: 'ship' },
            { label: 'Wait', value: 'wait' },
          ],
        },
      })
      assert.notEqual(result.isError, true, `the reply was sent: ${JSON.stringify(result.content)}`)
      const posted = w.backend.posts.find((p) => p.body.text === 'Ship it now?')
      assert.ok(posted, 'the reply reached the backend')
      await waitQuietly(() => w.daemon.cards.some((c) => c.messageId === posted.id), 20_000)
      const clicks = w.daemon.cards.filter((c) => c.messageId === posted.id)
      assert.equal(clicks.length, 1, `the click reached the session once\n${evidence(w)}`)
      assert.match(clicks[0]!.content, /Ship it/, 'the click names the button tapped')
      // Later reads must not announce it a second time.
      await forceReads(w, 2)
      assert.equal(w.daemon.cards.filter((c) => c.messageId === posted.id).length, 1, 'never twice')
    } finally {
      await w.end()
    }
  })

  test('a plan card, Go ahead tapped at once: the answer reaches the session once', OPTS, async () => {
    const w = await world()
    try {
      w.backend.tapOnPost = (body) => {
        const options = Array.isArray(body.options) ? (body.options as Array<{ callbackData?: string }>) : []
        const go = options.findIndex((o) => o.callbackData === 'plan:go')
        return go >= 0 ? go : null
      }
      const result = await w.daemon.client.callTool({
        name: 'propose_plan',
        arguments: {
          chat_id: String(MAIN),
          title: 'Rename the status field',
          steps: [{ text: 'Rename the column' }, { text: 'Update the two readers' }],
        },
      })
      assert.notEqual(result.isError, true, `the plan was posted: ${JSON.stringify(result.content)}`)
      const posted = w.backend.posts.find((p) => p.route === 'messages')
      assert.ok(posted, 'the plan card reached the backend')
      await waitQuietly(() => w.daemon.cards.some((c) => c.messageId === posted.id), 20_000)
      const answers = w.daemon.cards.filter((c) => c.messageId === posted.id)
      assert.equal(answers.length, 1, `the plan answer reached the session once\n${evidence(w)}`)
      await forceReads(w, 2)
      assert.equal(w.daemon.cards.filter((c) => c.messageId === posted.id).length, 1, 'never twice')
    } finally {
      await w.end()
    }
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
        ownerSendsLogin(w.backend, 300)
        await waitFor(() => loginCardOf(w.backend) !== undefined, 'the sign-in card, posted during the held read')
        await sleep(300)
        heldReadAnswered = true
      })
      await waitQuietly(() => claudeCalls(w.rig).includes('auth login --claudeai'), 25_000)
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
