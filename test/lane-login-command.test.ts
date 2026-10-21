/**
 * PERSON LANES, `/login` in a person's lane (board row 01a15904, with row
 * d8dd64b4 and decision K2; lib/lane-slash.ts, lib/lane-controls.ts,
 * lib/lane-core.mjs LANE_NOTICES, lane-server.ts).
 *
 * Once lanes are on for an agent, a share recipient's turns are stamped for
 * their lane: the owner's daemon drops them before its own /login sees them
 * (ownerLaneVerdict), and the person's lane daemon gets them. A lane cannot
 * post free text into the chat, only the fixed sentences the owner's daemon
 * posts for it, so it can neither relay a sign in link nor take a code. Which
 * Claude sign in the lane runs on is the share's login mode:
 *   - inherit (the default): the OWNER's own sign in, the one the owner's own
 *     chats use. A sign in from here would sign the owner's login in to
 *     whatever account the person used.
 *   - own_token: the person's own long lived token, which the owner installed
 *     (`hoai-lane token set`). `claude auth login` cannot change it, and the
 *     owner's login is never touched for it.
 * So the lane daemon answers `/login` itself, never the model: it signs
 * nothing in, starts nothing, reads no sign in state, and tells the person in
 * one fixed sentence for its mode which sign in our conversations use and
 * what to do instead.
 *
 * A person the owner allowed to sign the agent back in ("Can sign this agent
 * back in", the backend's labelled `sender_may_login` on their message) is
 * told so: under inherit their grant does not apply in a lane, and the
 * sentence says it plainly rather than answering as if they had none
 * (login_lane_shared_granted). Honouring the grant from a lane is not done
 * here: the lane still signs nothing in. Under their own token the grant
 * changes nothing, because /login cannot change that token.
 *
 * The last section runs the REAL lane daemon (`lane-server.ts` under
 * `bin/bgos-launch.mjs`, as the lane's mcp.json starts it) against a stand in
 * backend and a stand in for Claude Code, in both modes, with and without the
 * grant.
 *
 * Run with: npx tsx --test test/lane-login-command.test.ts
 */
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

import {
  LANE_LOGIN_INHERIT,
  LANE_LOGIN_OWN_TOKEN,
  LANE_NOTICES,
  laneDaemonEnv,
  laneEventLine,
  laneNoticeSentence,
  lanePaths,
  parseLaneEventLine,
  personLaneStamp,
} from '../lib/lane-core.mjs'
import * as laneControls from '../lib/lane-controls.ts'
// Off the module object, so a missing export fails the assertion that uses it
// rather than the whole file's import.
import * as senderModule from '../lib/daemon-command-sender.ts'
import { LANE_NOTICE_SENTENCES } from '../lib/lane-daemon.ts'
import { drainLaneEvents } from '../lib/lane-owner.ts'
import { requestLaneRestart, type RestartAsk } from '../lib/lane-controls.ts'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32).
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS, timeout: 60_000 }, fn as never)

const ROOT = join(import.meta.dirname, '..')
const ASSISTANT_ID = '1076'
const USER_ID = 'user_ana'
const CHAT_ID = 77
const STAMP = personLaneStamp(USER_ID)

/**
 * The three sentences, byte for byte. The own token one says the owner can
 * set a NEW sign in up with the person, never that the owner renews it: the
 * token comes from the person's own `claude setup-token`, so the owner cannot
 * renew it alone.
 */
const OWN_TOKEN_SENTENCE =
  "I can't run /login here. Our conversations use your own Claude sign in, which my owner set up on their computer, and /login cannot change it. It never signs in my owner's login for you either, so nothing was changed. If your sign in stopped working, ask my owner to set up a new one with you."
const SHARED_SENTENCE =
  "I can't run /login here. Our conversations use my owner's Claude sign in, the same one my owner's own chats use, and a sign in cannot be finished from our conversation, so nothing was changed. If I have stopped answering, tell my owner: they can send /login in their own chat with me."
const GRANTED_SENTENCE =
  "My owner allowed you to sign me back in, but /login can't run from our conversation yet: a sign in link and its code can't pass through it, so nothing was changed. Our conversations use my owner's Claude sign in, the same one my owner's own chats use. If I have stopped answering, tell my owner: they can send /login in their own chat with me."
const LOGIN_SENTENCES = [
  ['login_lane_own_token', OWN_TOKEN_SENTENCE],
  ['login_lane_shared', SHARED_SENTENCE],
  ['login_lane_shared_granted', GRANTED_SENTENCE],
] as const

/** The labelled value the backend stamps on a granted person's message (the contract's constant). */
const MAY_LOGIN =
  "This agent's owner allows the person writing to send /login, to sign this agent back in when its Claude sign in expires."
/** What a granted person's lane row carries besides the base row: the labelled grant, in a main chat. */
const GRANTED = { sender_relationship: 'shared_recipient', sender_may_login: MAY_LOGIN }

// ── The three sentences ─────────────────────────────────────────────────────

test('LANE_NOTICES carries every /login sentence exactly, in the agent\'s voice, with no dashes and nothing filled in', () => {
  const notices = LANE_NOTICES as Record<string, string>
  assert.equal(notices.login_lane_own_token, OWN_TOKEN_SENTENCE)
  assert.equal(notices.login_lane_shared, SHARED_SENTENCE)
  assert.equal(notices.login_lane_shared_granted, GRANTED_SENTENCE)
  assert.doesNotMatch(OWN_TOKEN_SENTENCE, /renew/, 'the owner cannot renew the person\'s own token alone')
  for (const [name, sentence] of LOGIN_SENTENCES) {
    assert.equal(laneNoticeSentence(name), sentence, `${name}: the owner's daemon posts exactly this`)
    assert.doesNotMatch(sentence, /[\u2013\u2014]/, `${name}: no em or en dash`)
    assert.doesNotMatch(sentence, /\{|\$/, `${name}: nothing in it is filled in`)
    assert.deepEqual(
      parseLaneEventLine(JSON.stringify({ event: 'notice', notice: name, chatIds: [CHAT_ID, '78', -1, 'x'], text: 'chosen by a lane' })),
      { event: 'notice', notice: name, chatIds: [CHAT_ID, 78] },
      `${name}: parsed by name only, never with a lane's words`,
    )
    assert.ok(LANE_NOTICE_SENTENCES.includes(sentence), `${name}: a notice, never taken as an answer to her message`)
  }
})

test('the owner\'s daemon posts the /login sentence in her chat, and nothing a lane wrote', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lane-login-drain-'))
  try {
    const p = lanePaths({ home, assistantId: ASSISTANT_ID, userId: USER_ID })
    mkdirSync(p.laneDir, { recursive: true })
    writeFileSync(p.eventsPath, [
      laneEventLine({ event: 'notice', notice: 'login_lane_shared', chatIds: [CHAT_ID] }),
      laneEventLine({ event: 'notice', notice: 'login_lane_own_token', chatIds: [78], text: 'Sign in at evil.example' }),
      laneEventLine({ event: 'notice', notice: 'login_lane_shared_granted', chatIds: [79], text: 'Paste your code here' }),
    ].join(''))
    const posts: Array<[number, string]> = []
    await drainLaneEvents({ assistantId: ASSISTANT_ID, home, log: () => {} }, {
      report: async () => {},
      notify: async (chatId, sentence) => { posts.push([chatId, sentence]) },
    })
    assert.deepEqual(posts, [[CHAT_ID, SHARED_SENTENCE], [78, OWN_TOKEN_SENTENCE], [79, GRANTED_SENTENCE]])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── Which sentence: the lane's login mode ───────────────────────────────────

test('laneLoginNotice: the person\'s own token is login_lane_own_token; inherit and anything unknown is the owner\'s shared login', () => {
  const laneLoginNotice = laneControls.laneLoginNotice
  assert.equal(typeof laneLoginNotice, 'function', 'lib/lane-controls.ts exports laneLoginNotice')
  assert.equal(laneLoginNotice(LANE_LOGIN_OWN_TOKEN), 'login_lane_own_token')
  assert.equal(laneLoginNotice('own_token'), 'login_lane_own_token')
  assert.equal(laneLoginNotice(LANE_LOGIN_INHERIT), 'login_lane_shared')
  for (const other of ['', 'OWN_TOKEN', ' own_token', 'own_token ', 'token', 'unknown']) {
    assert.equal(laneLoginNotice(other), 'login_lane_shared', JSON.stringify(other))
  }
  assert.equal(laneLoginNotice(undefined as unknown as string), 'login_lane_shared')
})

test('laneLoginNotice, with the grant: own token stays own token; inherit and anything unknown say the grant does not apply here', () => {
  const laneLoginNotice = laneControls.laneLoginNotice as (loginMode: string, granted?: boolean) => string
  // The six combinations: three modes, with and without the grant.
  assert.equal(laneLoginNotice(LANE_LOGIN_OWN_TOKEN, true), 'login_lane_own_token', 'her own token: /login cannot change it, grant or not')
  assert.equal(laneLoginNotice(LANE_LOGIN_OWN_TOKEN, false), 'login_lane_own_token')
  assert.equal(laneLoginNotice(LANE_LOGIN_INHERIT, true), 'login_lane_shared_granted')
  assert.equal(laneLoginNotice(LANE_LOGIN_INHERIT, false), 'login_lane_shared')
  assert.equal(laneLoginNotice('unknown', true), 'login_lane_shared_granted', 'a mode this file does not know is inherit')
  assert.equal(laneLoginNotice('unknown', false), 'login_lane_shared')
  // Only `true` is the grant.
  for (const notGranted of [undefined, null, 'true', 1, MAY_LOGIN]) {
    assert.equal(laneLoginNotice(LANE_LOGIN_INHERIT, notGranted as unknown as boolean), 'login_lane_shared', JSON.stringify(notGranted))
  }
})

test('carriesLoginGrant: the exact grant on a share recipient\'s own main chat delivery, and nothing else', () => {
  const carriesLoginGrant = senderModule.carriesLoginGrant as (payload: unknown) => boolean
  assert.equal(typeof carriesLoginGrant, 'function', 'lib/daemon-command-sender.ts exports carriesLoginGrant')
  assert.equal(senderModule.SENDER_MAY_LOGIN_VALUE, MAY_LOGIN, 'the same constant')
  const row = inboundRow(900, 0, '/login', GRANTED)
  assert.equal(carriesLoginGrant(row), true, 'the lane poll row')
  assert.equal(carriesLoginGrant({ ...row, sender_may_login: `  ${MAY_LOGIN}\n` }), true, 'trimmed, like the daemon')
  // The camel case socket shape, nested sender block.
  const frame = {
    chatId: CHAT_ID, messageId: 901, text: '/login', lane: STAMP,
    sender: { userId: USER_ID, relationship: 'shared_recipient' }, isSharedRecipient: true, senderMayLogin: MAY_LOGIN,
  }
  assert.equal(carriesLoginGrant(frame), true, 'the lane socket frame')
  const noGrant: Array<[string, unknown]> = [
    ['no field', inboundRow(902, 0, '/login', { sender_relationship: 'shared_recipient' })],
    ['true', { ...row, sender_may_login: true }],
    ['the string true', { ...row, sender_may_login: 'true' }],
    ['another sentence', { ...row, sender_may_login: 'You may sign this agent in.' }],
    ['the two spellings disagreeing', { ...row, senderMayLogin: 'true' }],
    ['the owner', { ...row, sender_relationship: 'owner' }],
    ['a room member', { ...row, sender_relationship: 'room_member' }],
    ['no relationship', { ...row, sender_relationship: undefined }],
    ['no sender id', { ...row, sender_user_id: undefined }],
    ['not a share recipient', { ...frame, isSharedRecipient: false }],
    ['a group', { ...row, chat_kind: 'group' }],
    ['a channel', { ...frame, chatKind: 'channel' }],
    ['a kind that is not a string', { ...row, chat_kind: 7 }],
    ['nothing', null],
  ]
  for (const [label, payload] of noGrant) assert.equal(carriesLoginGrant(payload), false, label)
})

function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'lane-login-'))
  const paths = lanePaths({ home, assistantId: ASSISTANT_ID, userId: USER_ID })
  mkdirSync(paths.memoryDir, { recursive: true })
  mkdirSync(paths.peopleDir, { recursive: true })
  const notices: Array<{ name: string; chatIds: string[] }> = []
  const restarts: RestartAsk[] = []
  // A /login in a lane reads and writes no file at all: any touch throws.
  const noFiles = new Proxy({}, { get: (_t, name) => () => { throw new Error(`a lane /login touched the file system (${String(name)})`) } })
  const deps = {
    paths,
    notice: (name: string, chatIds: string[]) => notices.push({ name, chatIds }),
    requestRestart: (next: RestartAsk) => { restarts.push(next); requestLaneRestart(paths.restartRequestPath, next) },
    log: () => {},
    fs: noFiles as never,
  }
  return { home, paths, notices, restarts, deps, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('/login in a lane: the person is told which sign in our conversations use, and nothing else happens', () => {
  const s = scratch()
  try {
    const perform = laneControls.performLaneCommand as (route: { kind: string; commandArgs: string }, chatId: string, deps: unknown) => string
    assert.equal(perform({ kind: 'login', commandArgs: '' }, '5', { ...s.deps, loginMode: LANE_LOGIN_OWN_TOKEN }), 'refused')
    assert.deepEqual(s.notices, [{ name: 'login_lane_own_token', chatIds: ['5'] }])
    assert.equal(perform({ kind: 'login', commandArgs: 'console' }, '6', { ...s.deps, loginMode: LANE_LOGIN_INHERIT }), 'refused')
    assert.deepEqual(s.notices.at(-1), { name: 'login_lane_shared', chatIds: ['6'] })
    assert.equal(perform({ kind: 'login', commandArgs: '' }, '7', s.deps), 'refused', 'no mode given')
    assert.deepEqual(s.notices.at(-1), { name: 'login_lane_shared', chatIds: ['7'] })
    assert.equal(s.notices.length, 3, 'one sentence per /login')
    assert.equal(s.restarts.length, 0, 'no restart')
    assert.equal(existsSync(s.paths.restartRequestPath), false)
    assert.equal(existsSync(s.paths.choicesPath), false)
  } finally {
    s.cleanup()
  }
})

test('/login in a lane from a person the owner allowed: told the grant does not apply here, and still nothing happens', () => {
  const s = scratch()
  try {
    const perform = laneControls.performLaneCommand as (route: { kind: string; commandArgs: string; granted?: boolean }, chatId: string, deps: unknown) => string
    assert.equal(perform({ kind: 'login', commandArgs: '', granted: true }, '5', { ...s.deps, loginMode: LANE_LOGIN_INHERIT }), 'refused')
    assert.deepEqual(s.notices, [{ name: 'login_lane_shared_granted', chatIds: ['5'] }])
    assert.equal(perform({ kind: 'login', commandArgs: 'console', granted: true }, '6', s.deps), 'refused', 'no mode given')
    assert.deepEqual(s.notices.at(-1), { name: 'login_lane_shared_granted', chatIds: ['6'] })
    assert.equal(perform({ kind: 'login', commandArgs: '', granted: true }, '7', { ...s.deps, loginMode: LANE_LOGIN_OWN_TOKEN }), 'refused')
    assert.deepEqual(s.notices.at(-1), { name: 'login_lane_own_token', chatIds: ['7'] }, 'her own token: the grant changes nothing')
    assert.equal(perform({ kind: 'login', commandArgs: '', granted: false }, '8', { ...s.deps, loginMode: LANE_LOGIN_INHERIT }), 'refused')
    assert.deepEqual(s.notices.at(-1), { name: 'login_lane_shared', chatIds: ['8'] })
    assert.equal(s.notices.length, 4, 'one sentence per /login')
    assert.equal(s.restarts.length, 0, 'no restart')
    assert.equal(existsSync(s.paths.restartRequestPath), false)
    assert.equal(existsSync(s.paths.choicesPath), false)
  } finally {
    s.cleanup()
  }
})

// ── The REAL lane daemon ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, what: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

function inboundRow(id: number, minutesAgo: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...extra,
  }
}

/** /login picked from the app's picker: a slash_command row. */
function pickedLogin(id: number, minutesAgo: number, args = ''): Record<string, unknown> {
  return inboundRow(id, minutesAgo, `/login${args ? ` ${args}` : ''}`, { message_type: 'slash_command', command_name: 'login', command_args: args })
}

interface Backend {
  url: string
  acks: number[]
  sends: unknown[]
  historyReads: number
  close: () => Promise<void>
}

async function startBackend(opts: { rows: Array<Record<string, unknown>>; deliveryStates?: Record<number, string>; agentRows?: Array<{ id: number; text: string }> }): Promise<Backend> {
  const state: Backend = { url: '', acks: [], sends: [], historyReads: 0, close: async () => {} }
  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/api\/v1\//, '')
    let body = ''
    for await (const chunk of req) body += String(chunk)
    if (req.method === 'POST' && path === 'integrations/lanes/session') {
      return json(res, {
        sessionToken: 'lsess_login_standin_000001',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        lane: { actorUserId: USER_ID, assistantId: ASSISTANT_ID, stamp: STAMP, pairingId: '9' },
      })
    }
    if (req.method === 'GET' && path === 'integrations/lanes/me') return json(res, { actorUserId: USER_ID, assistantId: ASSISTANT_ID, lane: STAMP })
    if (req.method === 'GET' && path === 'integrations/lanes/inbound') {
      const since = Number(url.searchParams.get('since_message_id') ?? 0)
      return json(res, { messages: opts.rows.filter((r) => Number(r.id) > since) })
    }
    // Her chat history, in the backend's own envelope, as test/lane-dedupe.test.ts serves it.
    const history = /^chats\/(\d+)\/messages$/.exec(path)
    if (req.method === 'GET' && history) {
      state.historyReads += 1
      const after = Number(url.searchParams.get('afterId') ?? 0)
      const beforeId = url.searchParams.get('beforeId')
      const before = beforeId === null ? Number.POSITIVE_INFINITY : Number(beforeId)
      const all = [
        ...opts.rows.map((r) => ({
          id: Number(r.id), chatId: Number(r.chat_id), sender: 'user', text: r.text,
          deliveryState: state.acks.includes(Number(r.id)) ? 'acknowledged' : (opts.deliveryStates?.[Number(r.id)] ?? 'delivered'),
        })),
        ...(opts.agentRows ?? []).map((a) => ({ id: a.id, chatId: CHAT_ID, sender: 'assistant', text: a.text, deliveryState: null })),
      ]
      const messages = all
        .filter((m) => m.chatId === Number(history[1]) && m.id > after && m.id < before)
        .sort((a, b) => a.id - b.id)
        .map((message) => ({ message, messageFiles: [], messageOptions: [] }))
      return json(res, { messages })
    }
    const ack = /^integrations\/messages\/(\d+)\/ack$/.exec(path)
    if (req.method === 'POST' && ack) {
      state.acks.push(Number(ack[1]))
      return json(res, { ok: true })
    }
    if (req.method === 'POST' && path === 'send-message') {
      state.sends.push(JSON.parse(body || 'null'))
      return json(res, { ok: true })
    }
    return json(res, {})
  }
  const http: HttpServer = createServer((req, res) => { void handler(req, res) })
  const io = new SocketServer(http)
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  state.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  state.close = () => new Promise<void>((r) => { io.close(); http.close(() => r()) })
  return state
}

interface Rig {
  client: Client
  channel: Array<{ messageId: string; content: string }>
  home: string
  backend: Backend
}

/** The real daemon in a brand new lane folder (no inbox note), in the given login mode. */
async function startLane(backend: Backend, loginMode: string): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), 'lane-login-run-'))
  const p = lanePaths({ home, assistantId: ASSISTANT_ID, userId: USER_ID })
  mkdirSync(p.workDir, { recursive: true, mode: 0o700 })
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(p.ticketPath, JSON.stringify({ laneTicket: 'lt_login_standin', ticketExpiresAt: new Date(Date.now() + 120_000).toISOString() }), { mode: 0o600 })
  const env: Record<string, string> = {
    ...laneDaemonEnv({ assistantId: ASSISTANT_ID, userId: USER_ID, workDir: p.workDir, laneDir: p.laneDir, stateDir: p.stateDir, backendUrl: backend.url, loginMode }),
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
    channel.push({ messageId: String(params.meta?.message_id ?? ''), content: String(params.content ?? '') })
  }
  await client.connect(transport)
  // Claude Code asks for the tool list straight after the handshake.
  await client.listTools()
  return { client, channel, home, backend }
}

async function stopLane(rig: Rig): Promise<void> {
  const p = lanePaths({ home: rig.home, assistantId: ASSISTANT_ID, userId: USER_ID })
  let daemonPid: number | null = null
  try { daemonPid = JSON.parse(readFileSync(p.laneJsonPath, 'utf8')).pid ?? null } catch { /* never wrote it */ }
  await rig.client.close().catch(() => {})
  if (daemonPid) {
    const alive = () => { try { process.kill(daemonPid as number, 0); return true } catch { return false } }
    const until = Date.now() + 5_000
    while (alive() && Date.now() < until) await sleep(50)
    if (alive()) try { process.kill(daemonPid, 'SIGKILL') } catch { /* exited meanwhile */ }
  }
  await rig.backend.close()
  rmSync(rig.home, { recursive: true, force: true })
}

/** The notice events the lane left for the owner's daemon, as that daemon reads them. */
function noticesLeft(home: string): Array<{ notice?: string; chatIds?: number[] }> {
  const p = lanePaths({ home, assistantId: ASSISTANT_ID, userId: USER_ID })
  let text = ''
  try { text = readFileSync(p.eventsPath, 'utf8') } catch { return [] }
  return text.split('\n').map((line) => parseLaneEventLine(line)).filter((e) => e !== null && e.event === 'notice')
    .map((e) => ({ notice: e!.notice, chatIds: e!.chatIds }))
}

function savedInbox(home: string): { delivered: number[]; pending: Array<{ id: number }> } {
  const p = lanePaths({ home, assistantId: ASSISTANT_ID, userId: USER_ID })
  try { return JSON.parse(readFileSync(p.cursorPath, 'utf8')) } catch { return { delivered: [], pending: [] } }
}

test('lane-server.ts, inherit: a typed /login never reaches Claude; it is acked and the owner\'s shared sign in sentence goes to her chat', async () => {
  const LOGIN_ID = 801
  const backend = await startBackend({ rows: [inboundRow(LOGIN_ID, 0, '/login')] })
  const rig = await startLane(backend, LANE_LOGIN_INHERIT)
  try {
    await waitFor(() => backend.acks.includes(LOGIN_ID), 'the /login acknowledged')
    // Past the settle (lib/lane-daemon.ts LANE_CLAUDE_SETTLE_MS is 2 s): a turn that was going out has gone out.
    await sleep(3_000)
    assert.deepEqual(rig.channel, [], 'nothing about /login reaches the model')
    assert.deepEqual(backend.acks, [LOGIN_ID], 'acknowledged once')
    assert.deepEqual(backend.sends, [], 'the lane itself posts nothing')
    assert.deepEqual(noticesLeft(rig.home), [{ notice: 'login_lane_shared', chatIds: [CHAT_ID] }])
    const p = lanePaths({ home: rig.home, assistantId: ASSISTANT_ID, userId: USER_ID })
    assert.equal(existsSync(p.restartRequestPath), false, 'no restart asked')
    assert.ok(savedInbox(rig.home).delivered.includes(LOGIN_ID) && !savedInbox(rig.home).pending.some((x) => x.id === LOGIN_ID), 'handled, never waiting for a reply')
    // And the owner's daemon posts exactly the fixed sentence in her chat.
    const posts: Array<[number, string]> = []
    await drainLaneEvents({ assistantId: ASSISTANT_ID, home: rig.home, log: () => {} }, { report: async () => {}, notify: async (chatId, sentence) => { posts.push([chatId, sentence]) } })
    assert.deepEqual(posts, [[CHAT_ID, SHARED_SENTENCE]])
  } finally {
    await stopLane(rig)
  }
})

test('lane-server.ts, inherit, granted: a typed /login carrying the grant is told the grant does not apply here; never reaches Claude, acked once', async () => {
  const LOGIN_ID = 805
  const backend = await startBackend({ rows: [inboundRow(LOGIN_ID, 0, '/login', GRANTED)] })
  const rig = await startLane(backend, LANE_LOGIN_INHERIT)
  try {
    await waitFor(() => backend.acks.includes(LOGIN_ID), 'the /login acknowledged')
    // Past the settle (lib/lane-daemon.ts LANE_CLAUDE_SETTLE_MS is 2 s): a turn that was going out has gone out.
    await sleep(3_000)
    assert.deepEqual(rig.channel, [], 'nothing about /login reaches the model')
    assert.deepEqual(backend.acks, [LOGIN_ID], 'acknowledged once')
    assert.deepEqual(backend.sends, [], 'the lane itself posts nothing')
    assert.deepEqual(noticesLeft(rig.home), [{ notice: 'login_lane_shared_granted', chatIds: [CHAT_ID] }])
    const p = lanePaths({ home: rig.home, assistantId: ASSISTANT_ID, userId: USER_ID })
    assert.equal(existsSync(p.restartRequestPath), false, 'no restart asked')
    const posts: Array<[number, string]> = []
    await drainLaneEvents({ assistantId: ASSISTANT_ID, home: rig.home, log: () => {} }, { report: async () => {}, notify: async (chatId, sentence) => { posts.push([chatId, sentence]) } })
    assert.deepEqual(posts, [[CHAT_ID, GRANTED_SENTENCE]])
  } finally {
    await stopLane(rig)
  }
})

test('lane-server.ts, own_token: a /login picked from the picker gets her own sign in sentence, and her next message still reaches Claude', async () => {
  const LOGIN_ID = 811
  const NEXT_ID = 812
  const backend = await startBackend({ rows: [pickedLogin(LOGIN_ID, 1, 'console'), inboundRow(NEXT_ID, 0, 'Are you there?')] })
  const rig = await startLane(backend, LANE_LOGIN_OWN_TOKEN)
  try {
    await waitFor(() => rig.channel.length > 0, 'her next turn')
    await waitFor(() => backend.acks.includes(NEXT_ID), 'its ack')
    await sleep(1_500)
    assert.deepEqual(rig.channel.map((c) => c.messageId), [String(NEXT_ID)], 'only her message, never the /login')
    assert.ok(!rig.channel.some((c) => c.content.includes('/login')))
    assert.deepEqual([...backend.acks].sort(), [LOGIN_ID, NEXT_ID])
    assert.deepEqual(noticesLeft(rig.home), [{ notice: 'login_lane_own_token', chatIds: [CHAT_ID] }])
  } finally {
    await stopLane(rig)
  }
})

test('lane-server.ts: a /login the server shows already answered is not answered again by a lane with no inbox note', async () => {
  // Her two /login messages were answered (acknowledged; the first one's
  // sentence is posted after it, the second's was still in the lane's events
  // file), then the lane's folders were deleted. Neither is answered twice.
  const POSTED_ID = 821
  const UNPOSTED_ID = 823
  const backend = await startBackend({
    rows: [inboundRow(POSTED_ID, 4, '/login'), pickedLogin(UNPOSTED_ID, 3)],
    deliveryStates: { [POSTED_ID]: 'acknowledged', [UNPOSTED_ID]: 'acknowledged' },
    agentRows: [{ id: POSTED_ID + 1, text: SHARED_SENTENCE }],
  })
  const rig = await startLane(backend, LANE_LOGIN_INHERIT)
  try {
    await waitFor(() => backend.historyReads >= 2, 'the server asked about both')
    await sleep(3_500)
    assert.deepEqual(rig.channel, [], 'neither is handed to Claude')
    assert.deepEqual(backend.acks, [], 'neither is acknowledged again')
    assert.deepEqual(noticesLeft(rig.home), [], 'and no sentence is posted a second time')
    const saved = savedInbox(rig.home)
    assert.ok(saved.delivered.includes(POSTED_ID) && saved.delivered.includes(UNPOSTED_ID), 'both noted as handled')
  } finally {
    await stopLane(rig)
  }
})
