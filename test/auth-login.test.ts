/**
 * Regression guard for lib/auth-login.ts: /login answered by the daemon.
 *
 * Every behaviour the brief names is driven here against the REAL exported
 * code with fakes for the I/O (the child process, the chat, the clock):
 *   - the OSC-8 doubled URL, from the byte sequence measured on Claude Code
 *     2.1.289 (`claude auth login` prints the URL as an OSC-8 hyperlink, so
 *     the URL is on the line twice);
 *   - code validation: empty, multiline, control characters, a leading slash;
 *   - the 10 minute timeout, which kills the child;
 *   - single flight;
 *   - owner only, refused before the child is spawned or the sign-in state is
 *     read, driven through the real runDaemonCommand seam;
 *   - the non-zero exit reply.
 * Plus the properties that make it safe: the code and the URL's query never
 * reach a log line, the code is written to stdin once and only once, a
 * message that is not a code is not consumed, and nothing about /login is
 * routed to the model.
 *
 * The server.ts wiring is module scoped and not exported, so the last section
 * pins its SHAPE by reading the source. Green there is text, not runtime; the
 * section says what it cannot catch.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  INITIAL_LOGIN_STATE,
  LOGIN_CODE_WINDOW_MS,
  LOGIN_METHOD_BUTTONS,
  LoginController,
  buildLoginArgv,
  buildLoginEnv,
  carriesSignInCode,
  isRoomContext,
  mustDropMessage,
  extractLoginUrl,
  parseAuthStatusJson,
  parseLoginArgs,
  redactLoginText,
  reduceLogin,
  resolveClaudeExecutable,
  stripOsc8,
  validateAuthCode,
  type AuthStatus,
  type ChildCommand,
  type LoginButton,
  type LoginChildHandlers,
} from '../lib/auth-login.ts'
import { runDaemonCommand } from '../lib/daemon-command-sender.ts'
import {
  BUILTIN_COMMANDS,
  catalogForCapabilities,
  prepareSlashCommands,
  routeSlashCommand,
} from '../lib/slash-catalog.ts'
import { RESERVED_VALUE_PREFIXES, escapeAgentButtonValue } from '../lib/message-text.ts'
import * as inboundChannel from '../lib/inbound-channel.ts'
import * as slashCatalog from '../lib/slash-catalog.ts'
import * as authLogin from '../lib/auth-login.ts'
import ts from 'typescript'

const OWNER = 'user_2owner000000000000000000000'
const RECIPIENT = 'user_2recip000000000000000000000'
const CHAT = '6053'

// Fake values in the measured shape. Nothing here is a real credential.
const STATE = 'FAKEstate_0123456789abcdefghijklmnopqrstuvw'
const URL_ = [
  'https://claude.com/cai/oauth/authorize?code=true',
  'client_id=00000000-fake-0000-0000-000000000000',
  'response_type=code',
  'redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback',
  'scope=user%3Aprofile+user%3Ainference',
  'code_challenge=FAKEchallenge_abcdefghijklmnopqrstuvwxyz012',
  'code_challenge_method=S256',
  `state=${STATE}`,
].join('&')
const CODE = `FAKEauthcode_abcdefghijklmnopqrstuvwxyz0123456789#${STATE}`
/** A code from an EARLIER attempt: same shape, another 43 character state. */
const OLD_STATE = 'OLDstate_zyxwvutsrqponmlkjihgfedcba98765432'
const OLD_CODE = `FAKEoldcode_abcdefghijklmnopqrstuvwxyz012345#${OLD_STATE}`

/** stdout exactly as `claude auth login` 2.1.289 wrote it, URL swapped for the fake. */
const MEASURED_STDOUT =
  'Opening browser to sign in\u2026\n' +
  `If the browser didn't open, visit: \u001b]8;;${URL_}\u0007${URL_}\u001b]8;;\u0007\n` +
  'Paste code here if prompted > '

// The poll row and WS payload shapes test/daemon-command-sender.test.ts pins.
const POLL_OWNER_MSG = { id: 77, text: CODE, sender: 'user', user_id: OWNER, sender_user_id: OWNER, sender_relationship: 'owner' }
const WS_RECIPIENT_MSG = {
  chatId: 6053,
  messageId: 78,
  userId: OWNER,
  text: CODE,
  sender: { userId: RECIPIENT, relationship: 'shared_recipient' },
  isSharedRecipient: true,
  shareOwnerUserId: OWNER,
}
const WS_OWNER_LOGIN = {
  chatId: 6053,
  messageId: 42,
  userId: OWNER,
  messageType: 'slash_command',
  commandName: 'login',
  commandArgs: '',
  text: '/login',
  sender: { userId: OWNER, relationship: 'owner' },
  isSharedRecipient: false,
  shareOwnerUserId: null,
}
const WS_RECIPIENT_LOGIN = {
  ...WS_OWNER_LOGIN,
  chatId: 7001,
  sender: { userId: RECIPIENT, relationship: 'shared_recipient' },
  isSharedRecipient: true,
  shareOwnerUserId: OWNER,
}

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeClock {
  nowMs = 1_000_000
  private timers: Array<{ id: number; at: number; fn: () => void }> = []
  private nextId = 1
  now = (): number => this.nowMs
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++
    this.timers.push({ id, at: this.nowMs + ms, fn })
    return id
  }
  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }
  advance(ms: number): void {
    this.nowMs += ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.nowMs).sort((a, b) => a.at - b.at)[0]
      if (!due) return
      this.timers = this.timers.filter((t) => t.id !== due.id)
      due.fn()
    }
  }
}

interface FakeChild {
  cmd: ChildCommand
  handlers: LoginChildHandlers
  writes: string[]
  killed: boolean
}

function harness(opts: { status?: AuthStatus | null; executable?: string | null; onSignedIn?: () => void } = {}) {
  const clock = new FakeClock()
  const children: FakeChild[] = []
  const sent: Array<{ chatId: string; text: string; buttons?: readonly LoginButton[] }> = []
  const logs: string[] = []
  let statusReads = 0
  let nextMessageId = 500
  const status: AuthStatus | null =
    opts.status === undefined
      ? { loggedIn: false, authMethod: 'none', email: null, subscriptionType: null }
      : opts.status
  const controller = new LoginController({
    ownerUserId: OWNER,
    executable: () => (opts.executable === undefined ? '/opt/claude/bin/claude' : opts.executable),
    spawn: (cmd, handlers) => {
      const child: FakeChild = { cmd, handlers, writes: [], killed: false }
      children.push(child)
      return {
        write: (text) => child.writes.push(text),
        kill: () => {
          child.killed = true
        },
      }
    },
    readAuthStatus: async () => {
      statusReads++
      return status
    },
    send: async (chatId, text, buttons) => {
      sent.push({ chatId, text, ...(buttons ? { buttons } : {}) })
      return nextMessageId++
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (line) => logs.push(line),
    ...(opts.onSignedIn ? { onSignedIn: opts.onSignedIn } : {}),
  })
  return {
    clock,
    children,
    sent,
    logs,
    controller,
    statusReads: () => statusReads,
    get child(): FakeChild {
      const c = children[children.length - 1]
      assert.ok(c, 'a child was spawned')
      return c
    },
  }
}

/** Let the controller's detached replies (status read, card post) settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** /login, a tap on Claude subscription, and the URL printed: awaiting_code. */
async function toAwaitingCode(h: ReturnType<typeof harness>) {
  await h.controller.command(CHAT, '')
  await settle()
  const card = h.sent[h.sent.length - 1]!
  assert.ok(card.buttons, 'the offer carries buttons')
  assert.equal(
    h.controller.button({ chatId: CHAT, messageId: 500, callbackData: 'login:claudeai', clickerUserId: null }),
    'consumed',
  )
  h.child.handlers.onStdout(MEASURED_STDOUT)
  await settle()
  assert.equal(h.controller.phase, 'awaiting_code')
}

function ownerCode(h: ReturnType<typeof harness>, text: unknown = CODE, messageId = 77) {
  return h.controller.message({
    chatId: CHAT,
    messageId,
    payload: { ...POLL_OWNER_MSG, id: messageId, text },
    text,
    isSlash: false,
    fromHuman: true,
  })
}

/** Neither the code nor the URL's secrets may appear in any of these. */
function assertNoSecrets(lines: readonly string[], label: string): void {
  for (const line of lines) {
    assert.ok(!line.includes(CODE), `${label}: the code leaked: ${line}`)
    assert.ok(!line.includes('FAKEauthcode'), `${label}: the code's first half leaked: ${line}`)
  }
}

// ── OSC-8 and the URL ────────────────────────────────────────────────────────

test('the measured OSC-8 line yields the URL ONCE, where a naive regex captures it doubled', () => {
  // The hazard, stated: without stripping, the hyperlink's URI and its visible
  // text run together through BEL and ESC, which \S matches.
  const naive = MEASURED_STDOUT.match(/https:\/\/\S+/)?.[0] ?? ''
  assert.ok(naive.length > URL_.length * 2 - 1, 'a naive match swallows both copies')
  assert.equal(extractLoginUrl(MEASURED_STDOUT), URL_)
  assert.equal(stripOsc8(`a \u001b]8;;${URL_}\u0007text\u001b]8;;\u0007 b`), 'a text b')
  assert.equal(stripOsc8(`\u001b]8;id=1;${URL_}\u001b\\text\u001b]8;;\u001b\\`), 'text', 'the ESC \\ terminator too')
})

test('a URL is relayed only once its line is complete', () => {
  const cut = MEASURED_STDOUT.indexOf(`${URL_}\u001b]8;;`) + 40
  assert.equal(extractLoginUrl(MEASURED_STDOUT.slice(0, cut)), null, 'a chunk ending mid URL yields nothing')
  assert.equal(extractLoginUrl('Opening browser to sign in\u2026\n'), null)
})

test('only an Anthropic sign-in URL is ever relayed', () => {
  for (const bad of [
    `visit: https://evil.example/cai/oauth/authorize?state=x\n`,
    `visit: http://claude.com/cai/oauth/authorize?state=x\n`,
    `visit: https://claude.com.evil.example/oauth/authorize?state=x\n`,
    `visit: https://claude.com/somewhere/else?state=x\n`,
  ]) {
    assert.equal(extractLoginUrl(bad), null, bad)
  }
  assert.ok(extractLoginUrl(`visit: https://platform.claude.com/oauth/authorize?state=x\n`), 'the Console host')
})

// ── the code ─────────────────────────────────────────────────────────────────

test('code validation rejects empty, multiline, control characters and a leading slash', () => {
  const cases: Array<[unknown, string]> = [
    ['', 'empty'],
    ['   \n  ', 'empty'],
    [undefined, 'empty'],
    [42, 'empty'],
    [`${CODE}\nsecond line`, 'multiline'],
    [`first line\r${CODE}`, 'multiline'],
    [`${CODE.slice(0, 10)}\u2028${CODE.slice(10)}`, 'multiline'],
    [`${CODE.slice(0, 10)}\u0000${CODE.slice(10)}`, 'control_chars'],
    [`${CODE.slice(0, 10)}\u001b[2J${CODE.slice(10)}`, 'control_chars'],
    [`${CODE.slice(0, 10)}\u200b${CODE.slice(10)}`, 'control_chars'],
    [`/${CODE}`, 'leading_slash'],
    ['/login cancel', 'leading_slash'],
    [`${CODE.slice(0, 10)} ${CODE.slice(10)}`, 'whitespace'],
    ['FAKEauthcode_no_separator', 'no_separator'],
    [`#${STATE}`, 'no_separator'],
    ['FAKEauthcode#', 'no_separator'],
    [`FAKE"code#${STATE}`, 'bad_charset'],
    [`${'a'.repeat(3000)}#${STATE}`, 'too_long'],
  ]
  for (const [raw, reason] of cases) {
    const v = validateAuthCode(raw, { expectedState: STATE })
    assert.equal(v.ok, false, `${JSON.stringify(raw)?.slice(0, 40)} must be refused`)
    if (!v.ok) assert.equal(v.reason, reason, JSON.stringify(raw)?.slice(0, 40))
  }
})

test('a real-shaped code is accepted, trimmed, and checked against the link it came from', () => {
  const ok = validateAuthCode(`  ${CODE}\n`, { expectedState: STATE })
  assert.deepEqual(ok, { ok: true, code: CODE })
  const older = validateAuthCode(`FAKEauthcode_old#OLDstate_zzzzzzzz`, { expectedState: STATE })
  assert.deepEqual(older, { ok: false, reason: 'state_mismatch' })
})

// ── argv, env, executable, status ────────────────────────────────────────────

test('the child is argv exec of auth login with the chosen method, and BROWSER is a no-op', () => {
  assert.deepEqual(buildLoginArgv('/x/claude', 'claudeai'), { command: '/x/claude', args: ['auth', 'login', '--claudeai'] })
  assert.deepEqual(buildLoginArgv('/x/claude', 'console'), { command: '/x/claude', args: ['auth', 'login', '--console'] })
  const env = buildLoginEnv({ PATH: '/bin', BROWSER: 'firefox', KEEP: 'x', GONE: undefined })
  assert.equal(env.BROWSER, 'true', 'the automatic localhost flow must not open on this machine')
  assert.equal(env.KEEP, 'x')
  assert.equal('GONE' in env, false)
  assert.equal('CLAUDE_CONFIG_DIR' in buildLoginEnv({ PATH: '/bin' }), false, 'never filled in when unset')
  assert.equal(buildLoginEnv({ CLAUDE_CONFIG_DIR: '/c' }).CLAUDE_CONFIG_DIR, '/c', 'inherited when set')
})

test('the executable is the session binary first, then PATH, and never a shell shim', () => {
  const files = new Set(['/v/2.1.289', '/usr/local/bin/claude', 'C:\\bin\\claude.exe', 'C:\\shim\\claude.cmd'])
  const isFile = (p: string) => files.has(p)
  assert.equal(resolveClaudeExecutable({ env: { CLAUDE_CODE_EXECPATH: '/v/2.1.289', PATH: '/usr/local/bin' }, platform: 'darwin', isFile }), '/v/2.1.289')
  assert.equal(resolveClaudeExecutable({ env: { PATH: '/nope:/usr/local/bin' }, platform: 'linux', isFile }), '/usr/local/bin/claude')
  assert.equal(resolveClaudeExecutable({ env: { CLAUDE_CODE_EXECPATH: 'C:\\shim\\claude.cmd', Path: 'C:\\shim;C:\\bin' }, platform: 'win32', isFile }), 'C:\\bin\\claude.exe')
  assert.equal(resolveClaudeExecutable({ env: { PATH: '/nope' }, platform: 'linux', isFile }), null)
})

test('auth status parses the measured JSON, logged in and logged out', () => {
  assert.deepEqual(
    parseAuthStatusJson('{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'),
    { loggedIn: false, authMethod: 'none', email: null, subscriptionType: null },
  )
  assert.deepEqual(
    parseAuthStatusJson('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.co","subscriptionType":"max"}'),
    { loggedIn: true, authMethod: 'claude.ai', email: 'a@b.co', subscriptionType: 'max' },
  )
  assert.equal(parseAuthStatusJson('Not logged in'), null)
  assert.equal(parseAuthStatusJson('{"authMethod":"none"}'), null, 'no loggedIn answer is no answer')
})

test('redaction strips URL queries and every known secret', () => {
  const out = redactLoginText(`see ${URL_} and ${CODE} and ${STATE}`, [CODE, STATE])
  assert.ok(!out.includes(STATE))
  assert.ok(!out.includes('FAKEauthcode'))
  assert.ok(!out.includes('FAKEchallenge'))
  assert.match(out, /https:\/\/claude\.com\/cai\/oauth\/authorize\?<redacted>/)
})

// ── the happy path, end to end through the controller ────────────────────────

test('/login offers two method buttons; a tap starts the child; the URL goes out; the next owner message is the code', async () => {
  const h = harness()
  await toAwaitingCode(h)
  assert.deepEqual(
    h.sent[0]!.buttons!.map((b) => b.text),
    ['Claude subscription', 'Anthropic Console'],
  )
  assert.deepEqual(h.child.cmd.args, ['auth', 'login', '--claudeai'])
  assert.equal(h.child.cmd.command, '/opt/claude/bin/claude')
  const urlReply = h.sent[h.sent.length - 1]!.text
  assert.equal(urlReply.split(URL_).length - 1, 1, 'the URL appears exactly once in the reply')
  assert.match(urlReply, /paste the code/i)

  assert.equal(ownerCode(h), 'consumed')
  assert.deepEqual(h.child.writes, [`${CODE}\n`], 'written to stdin once, as one line')
  assert.equal(h.controller.phase, 'verifying')

  h.child.handlers.onExit(0)
  await settle()
  assert.equal(h.controller.phase, 'done')
  assertNoSecrets(h.sent.map((m) => m.text), 'replies')
  assertNoSecrets(h.logs, 'logs')
  assert.ok(!h.logs.some((l) => l.includes(STATE)), 'the state never reaches a log line')
  assert.ok(!h.logs.some((l) => l.includes('FAKEchallenge')), 'the challenge never reaches a log line')
})

test('on exit 0 the reply carries the email and the plan from auth status', async () => {
  // The status the fake answers with is the one read after the child exits 0.
  const after: AuthStatus = { loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', subscriptionType: 'max' }
  const h = harness({ status: after })
  await toAwaitingCode(h)
  ownerCode(h)
  h.child.handlers.onExit(0)
  await settle()
  const last = h.sent[h.sent.length - 1]!.text
  assert.match(last, /^Signed in as owner@example\.com \(Claude Max\)\./)
  assert.doesNotMatch(last, /not a Claude subscription/)
})

test('a completed sign-in tells the login state at once, a failed one does not (board e5d0fb3a)', async () => {
  let told = 0
  const ok = harness({ onSignedIn: () => told++ })
  await toAwaitingCode(ok)
  ownerCode(ok)
  ok.child.handlers.onExit(0)
  await settle()
  assert.equal(told, 1, 'a sign-in that exits 0 clears the reported login failure')

  let toldOnFail = 0
  const bad = harness({ onSignedIn: () => toldOnFail++ })
  await toAwaitingCode(bad)
  ownerCode(bad)
  bad.child.handlers.onExit(1)
  await settle()
  assert.equal(toldOnFail, 0, 'a failed sign-in leaves the failure standing')

  const throws = harness({
    onSignedIn: () => {
      throw new Error('boom')
    },
  })
  await toAwaitingCode(throws)
  ownerCode(throws)
  throws.child.handlers.onExit(0)
  await settle()
  assert.equal(throws.controller.phase, 'done', 'a throwing listener never breaks the sign-in')
  assert.match(throws.sent[throws.sent.length - 1]!.text, /sign-in/i, 'the owner still gets the outcome reply')
})

test('a Console sign-in succeeds but says plainly that HOAI chat needs a subscription', async () => {
  const h = harness({ status: { loggedIn: true, authMethod: 'console', email: 'o@example.com', subscriptionType: null } })
  await toAwaitingCode(h)
  ownerCode(h)
  h.child.handlers.onExit(0)
  await settle()
  assert.match(h.sent[h.sent.length - 1]!.text, /not a Claude subscription sign-in/)
})

test('/login when already signed in says so, and still offers to sign in again', async () => {
  const h = harness({ status: { loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', subscriptionType: 'pro' } })
  await h.controller.command(CHAT, '')
  await settle()
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0]!.text, /already signed in as owner@example\.com \(Claude Pro\)\. Sign in again anyway\?/)
  assert.equal(h.sent[0]!.buttons?.length, 2, 'the buttons are still offered')
  assert.equal(h.children.length, 0, 'nothing runs until a method is picked')
})

test('/login console starts the Console flow directly, with no card', async () => {
  const h = harness()
  await h.controller.command(CHAT, 'console')
  await settle()
  assert.deepEqual(h.child.cmd.args, ['auth', 'login', '--console'])
  assert.equal(h.sent.some((m) => m.buttons), false)
})

// ── non-zero exit ────────────────────────────────────────────────────────────

test('a bad code: exit 1 is answered with the stderr reason and how to retry, and never with the code', async () => {
  const h = harness()
  await toAwaitingCode(h)
  ownerCode(h)
  // Exactly what 2.1.289 printed for a bad code.
  h.child.handlers.onStderr('Login failed: Request failed with status code 400\n')
  h.child.handlers.onExit(1)
  await settle()
  assert.equal(h.controller.phase, 'failed')
  const reply = h.sent[h.sent.length - 1]!.text
  assert.match(reply, /^The sign-in did not complete: Login failed: Request failed with status code 400/)
  assert.match(reply, /Send \/login to try again/)
  assertNoSecrets([reply, ...h.logs], 'failure path')
})

test('child stderr that echoes the code or the URL is redacted before it is replied or logged', async () => {
  const h = harness()
  await toAwaitingCode(h)
  ownerCode(h)
  const urlReplies = h.sent.length
  h.child.handlers.onStderr(`Login failed: bad code ${CODE} for ${URL_}\n`)
  h.child.handlers.onExit(1)
  await settle()
  // Everything said AFTER the one URL reply, which is the only text that may
  // carry the URL (and so its state): the owner has to open it.
  const after = [...h.sent.slice(urlReplies).map((m) => m.text), ...h.logs]
  assert.equal(after.length > h.logs.length, true, 'a failure reply was sent')
  assertNoSecrets(after, 'echoing stderr')
  assert.ok(!after.some((l) => l.includes(STATE)), 'the state is redacted out of the echo')
  assert.ok(!after.some((l) => l.includes('FAKEchallenge')), 'and so is the challenge')
})

test('a child that dies before printing a URL is a start failure, with its reason', async () => {
  const h = harness()
  await h.controller.command(CHAT, 'subscription')
  h.child.handlers.onStderr('Managed settings on this machine configure a Cloud gateway sign-in\n')
  h.child.handlers.onExit(1)
  await settle()
  assert.match(h.sent[h.sent.length - 1]!.text, /^The sign-in could not start: Managed settings/)
})

// ── the timeout ──────────────────────────────────────────────────────────────

test('awaiting_code gives up at 10 minutes: the child is killed and the owner told', async () => {
  const h = harness()
  await toAwaitingCode(h)
  h.clock.advance(LOGIN_CODE_WINDOW_MS - 1)
  assert.equal(h.child.killed, false, 'still open one millisecond before the deadline')
  assert.equal(h.controller.phase, 'awaiting_code')
  h.clock.advance(1)
  assert.equal(h.child.killed, true, 'killed at the deadline')
  assert.equal(h.controller.phase, 'failed')
  await settle()
  assert.match(h.sent[h.sent.length - 1]!.text, /No code arrived within 10 minutes/)
  // The killed child's own exit afterwards must not produce a second reply.
  const before = h.sent.length
  h.child.handlers.onExit(null)
  await settle()
  assert.equal(h.sent.length, before)
  // And a code after the window is not taken, and not passed on either.
  assert.equal(ownerCode(h, CODE, 99), 'withheld')
  assert.deepEqual(h.child.writes, [])
})

// ── single flight ────────────────────────────────────────────────────────────

test('a second /login while one is running says so and starts nothing', async () => {
  const h = harness()
  await toAwaitingCode(h)
  const before = h.sent.length
  await h.controller.command(CHAT, '')
  await h.controller.command('9999', 'console')
  await settle()
  assert.equal(h.children.length, 1, 'still exactly one child')
  const replies = h.sent.slice(before).map((m) => m.text)
  assert.equal(replies.length, 2)
  for (const r of replies) assert.match(r, /^A sign-in is already running/)
  assert.equal(h.controller.phase, 'awaiting_code', 'the running sign-in is untouched')
})

test('single flight holds in the reducer itself, from every in-flight phase', () => {
  for (const phase of ['awaiting_method', 'starting', 'awaiting_code', 'verifying'] as const) {
    const t = reduceLogin({ ...INITIAL_LOGIN_STATE, phase, chatId: CHAT }, { type: 'open', chatId: CHAT, nowMs: 0 })
    assert.equal(t.state.phase, phase, phase)
    assert.deepEqual(t.effects.map((e) => e.kind), ['busy'], phase)
  }
  for (const phase of ['idle', 'done', 'failed'] as const) {
    const t = reduceLogin({ ...INITIAL_LOGIN_STATE, phase }, { type: 'open', chatId: CHAT, nowMs: 0 })
    assert.equal(t.state.phase, 'awaiting_method', phase)
  }
})

test('/login cancel kills a running child and frees the slot', async () => {
  const h = harness()
  await toAwaitingCode(h)
  await h.controller.command(CHAT, 'cancel')
  assert.equal(h.child.killed, true)
  assert.equal(h.controller.phase, 'idle')
  await h.controller.command(CHAT, 'claudeai')
  assert.equal(h.children.length, 2, 'a new sign-in can start')
})

// ── owner only ───────────────────────────────────────────────────────────────

test('a non-owner /login is refused before the child spawns or the sign-in state is read', async () => {
  for (const payload of [
    WS_RECIPIENT_LOGIN,
    { ...WS_OWNER_LOGIN, sender: undefined },
    { ...WS_OWNER_LOGIN, sender: { userId: 42 } },
  ]) {
    const h = harness()
    const refusals: Array<[string, string]> = []
    const outcome = await runDaemonCommand({
      command: 'login',
      payload,
      ownerUserId: OWNER,
      chatId: '7001',
      send: async (chatId, text) => {
        refusals.push([chatId, text])
      },
      log: () => {},
      // Exactly what server.ts passes as act.
      act: () => h.controller.command('7001', ''),
    })
    await settle()
    assert.equal(outcome, 'refused')
    assert.equal(h.children.length, 0, 'no child for a non-owner')
    assert.equal(h.statusReads(), 0, "the owner's sign-in state is not even read")
    assert.equal(h.sent.length, 0, 'the controller said nothing')
    assert.equal(refusals.length, 1)
    assert.match(refusals[0]![1], /^\/login was not run/)
  }
  // The owner, through the same seam, reaches the offer.
  const h = harness()
  const outcome = await runDaemonCommand({
    command: 'login',
    payload: WS_OWNER_LOGIN,
    ownerUserId: OWNER,
    chatId: CHAT,
    send: async () => {},
    act: () => h.controller.command(CHAT, ''),
  })
  await settle()
  assert.equal(outcome, 'acted')
  assert.equal(h.statusReads(), 1)
  assert.equal(h.sent[0]!.buttons?.length, 2)
})

test('while awaiting the code, only the OWNER, in THAT chat, as a human, is ever taken', async () => {
  const h = harness()
  await toAwaitingCode(h)
  const msg = (over: Record<string, unknown>) => ({
    chatId: CHAT,
    messageId: 90,
    payload: POLL_OWNER_MSG,
    text: CODE,
    isSlash: false,
    fromHuman: true,
    ...over,
  })
  // None of these is TAKEN as the code. Each still carries it, so each is
  // WITHHELD: dropped by the rail, never forwarded or logged.
  let id = 90
  const next = (over: Record<string, unknown>) => h.controller.message(msg({ messageId: id++, ...over }))
  assert.equal(next({ payload: WS_RECIPIENT_MSG }), 'withheld', 'a share recipient')
  assert.equal(next({ payload: { text: CODE, user_id: OWNER } }), 'withheld', 'no sender at all')
  assert.equal(next({ chatId: '9999' }), 'withheld', 'another chat')
  assert.equal(next({ isSlash: true }), 'withheld', 'a slash command carrying it')
  // A peer agent's row is neither taken nor sieved: it is not a human paste.
  assert.equal(next({ fromHuman: false }), 'not_mine', 'a peer agent or a system row')
  assert.deepEqual(h.child.writes, [], 'nothing reached stdin')
  assert.equal(next({}), 'consumed', 'the owner')
  assert.equal(h.child.writes.length, 1)
  await settle()
  assert.ok(h.sent.some((m) => /started in another chat/.test(m.text)), 'the other chat is told where to paste')
  assertNoSecrets(h.sent.map((m) => m.text), 'withheld replies')
})

test('a sign-in is never started from a room, where the link would be posted to every member', async () => {
  // The owner IS the owner inside a room (identity is the id), so the seam
  // allows them; the room rule is the controller's, read off the same message.
  const roomOwner = { ...WS_OWNER_LOGIN, sender: { userId: OWNER, relationship: 'room_member' } }
  delete (roomOwner as Record<string, unknown>).isSharedRecipient
  delete (roomOwner as Record<string, unknown>).shareOwnerUserId
  const h = harness()
  const outcome = await runDaemonCommand({
    command: 'login',
    payload: roomOwner,
    ownerUserId: OWNER,
    chatId: CHAT,
    send: async () => {},
    // Exactly what server.ts passes as act.
    act: (verdict) =>
      h.controller.command(CHAT, '', { inRoom: verdict.sender.relationship === 'room_member' }),
  })
  await settle()
  assert.equal(outcome, 'acted', 'the owner passes the seam')
  assert.equal(h.statusReads(), 0)
  assert.equal(h.children.length, 0)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0]!.buttons, undefined, 'no method card in a room')
  assert.match(h.sent[0]!.text, /not from a room/)
  await h.controller.command(CHAT, 'console', { inRoom: true })
  assert.equal(h.children.length, 0, 'nor a direct method')
})

test('a tap on the login card that names someone else starts nothing', async () => {
  const h = harness()
  await h.controller.command(CHAT, '')
  await settle()
  assert.equal(
    h.controller.button({ chatId: CHAT, messageId: 500, callbackData: 'login:claudeai', clickerUserId: RECIPIENT }),
    'consumed',
  )
  assert.equal(h.children.length, 0)
  assert.equal(h.controller.phase, 'awaiting_method')
})

// ── a message that is not a code ─────────────────────────────────────────────

test('a message that is not a plausible code is NOT swallowed: the owner is told, the window stays open', async () => {
  const h = harness()
  await toAwaitingCode(h)
  const before = h.sent.length
  assert.equal(ownerCode(h, 'are you there?', 80), 'rejected', 'not a code: delivered as usual, owner told')
  assert.equal(ownerCode(h, OLD_CODE, 81), 'withheld', 'an older code: not used, and NOT passed on')
  assert.deepEqual(h.child.writes, [], 'nothing was written')
  assert.equal(h.controller.phase, 'awaiting_code', 'still waiting')
  await settle()
  const told = h.sent.slice(before).map((m) => m.text)
  assert.equal(told.length, 2)
  assert.match(told[0]!, /did not look like a sign-in code/)
  assert.match(told[1]!, /different sign-in attempt/)
  for (const t of told) assert.ok(!t.includes('are you there'), 'the message is never quoted back')
  assert.equal(ownerCode(h, CODE, 82), 'consumed', 'the real code still works afterwards')
})

test('a code is never passed on outside its window: re-paste, second send, late paste, after a restart', async () => {
  // Re-paste after a failure.
  const h = harness()
  await toAwaitingCode(h)
  assert.equal(ownerCode(h, CODE, 77), 'consumed')
  assert.equal(ownerCode(h, CODE, 78), 'withheld', 'a second send while the first is being checked')
  h.child.handlers.onStderr('Login failed: Request failed with status code 400\n')
  h.child.handlers.onExit(1)
  await settle()
  assert.equal(h.controller.phase, 'failed')
  assert.equal(ownerCode(h, CODE, 79), 'withheld', 'the same code pasted again after the failure')
  // Too short a first half for the shape rule: only the remembered state catches it.
  assert.equal(ownerCode(h, `ab#${STATE}`, 76), 'withheld', 'a fragment carrying a known state')
  assert.equal(h.child.writes.length, 1, 'still written exactly once')

  // A paste after the window closed.
  const late = harness()
  await toAwaitingCode(late)
  late.clock.advance(LOGIN_CODE_WINDOW_MS)
  assert.equal(late.controller.phase, 'failed')
  assert.equal(ownerCode(late, CODE, 80), 'withheld')
  assert.deepEqual(late.child.writes, [])

  // After a restart: no state is known, so only a message that is NOTHING BUT
  // a code is caught. The same code inside other text is the documented gap:
  // the shape rule is not applied inside text, because inside text it dropped
  // ordinary links (see the next test).
  const fresh = harness()
  assert.equal(ownerCode(fresh, CODE, 81), 'withheld', 'a bare code with no sign-in at all')
  assert.equal(ownerCode(fresh, `  ${CODE}\n`, 84), 'withheld', 'with surrounding whitespace')
  assert.equal(ownerCode(fresh, `here it is ${CODE} thanks`, 82), 'not_mine', 'the gap, pinned: inside text after a restart')
  assert.equal(ownerCode(fresh, 'see issue #42, and C# is fine', 83), 'not_mine', 'ordinary text with a # is not')
  await settle()
  for (const m of [...h.sent, ...late.sent, ...fresh.sent]) {
    assert.ok(!m.text.includes('FAKEauthcode'), `never echoed: ${m.text}`)
  }
  assert.equal(fresh.sent.length, 2, 'one reply per withheld message, none for the rest')
  assert.match(fresh.sent[0]!.text, /No sign-in is waiting for a code right now/)
  assertNoSecrets([...h.logs, ...late.logs, ...fresh.logs], 'withheld logs')
})

test('in the window, the code with other text around it is withheld, not used, and the owner told to paste it alone', async () => {
  const h = harness()
  await toAwaitingCode(h)
  assert.equal(ownerCode(h, `here it is: ${CODE}`, 85), 'withheld')
  assert.equal(ownerCode(h, `\`${CODE}\``, 86), 'withheld', 'in backticks')
  assert.deepEqual(h.child.writes, [])
  assert.equal(h.controller.phase, 'awaiting_code', 'the window stays open')
  await settle()
  assert.match(h.sent[h.sent.length - 1]!.text, /Paste just the code, on its own/)
  assert.equal(ownerCode(h, CODE, 87), 'consumed')
})

/** Real messages that look like `x#y` and must reach the model untouched (found in review). */
const ORDINARY_HASH_MESSAGES = [
  'https://docs.example.com/en/settings#environment-variables-and-configuration',
  'see https://github.com/org/repo/blob/main/README.md#installing-the-desktop-app-on-windows',
  'git+https://github.com/org/pkg.git#0123456789abcdef0123456789abcdef01234567',
  'github.com/org/pkg.git#0123456789abcdef0123456789abcdef01234567',
  'https://www.notion.so/team/Page-0123456789abcdef0123456789abcdef#0123456789abcdef0123456789abcdef',
  'issue #42',
  'C# and F#',
]

test('the sieve: a known state anywhere, or from the owner a bare code; never ordinary text', () => {
  assert.equal(carriesSignInCode(CODE, { fromOwner: true }), true, 'the owner pastes a bare code')
  assert.equal(carriesSignInCode(CODE), false, 'a bare code from someone not proven the owner: shape alone is not enough')
  assert.equal(carriesSignInCode(`x ${STATE} y`, { knownStates: [STATE] }), true, 'a known state anywhere, from anyone')
  assert.equal(carriesSignInCode(`here ${CODE}`, { fromOwner: true }), false, 'the shape rule is whole-message only')
  for (const ordinary of [...ORDINARY_HASH_MESSAGES, 'hello', 'abc#def', '']) {
    assert.equal(carriesSignInCode(ordinary, { fromOwner: true }), false, ordinary)
  }
  assert.equal(carriesSignInCode(undefined), false)
  assert.deepEqual(['consumed', 'withheld', 'rejected', 'not_mine'].map((o) => mustDropMessage(o as never)), [true, true, false, false])
})

test('ordinary messages with a # are never dropped: idle, or while a code is awaited', async () => {
  const idle = harness()
  let id = 700
  for (const text of ORDINARY_HASH_MESSAGES) {
    assert.equal(ownerCode(idle, text, id++), 'not_mine', `idle: ${text}`)
  }
  await settle()
  assert.equal(idle.sent.length, 0, 'and nobody is told anything')
  const h = harness()
  await toAwaitingCode(h)
  for (const text of ORDINARY_HASH_MESSAGES) {
    // In the window the owner is told it was not a code, and it goes on its way.
    assert.equal(ownerCode(h, text, id++), 'rejected', `awaiting: ${text}`)
  }
  assert.deepEqual(h.child.writes, [])
})

test('a non-owner is never sieved on shape, and is told only why when a known state is withheld', async () => {
  const h = harness()
  const asRecipient = (text: string, messageId: number) =>
    h.controller.message({ chatId: '7001', messageId, payload: WS_RECIPIENT_MSG, text, isSlash: false, fromHuman: true })
  assert.equal(asRecipient(CODE, 710), 'not_mine', 'no state known: shape alone does not drop a stranger')
  await toAwaitingCode(h)
  assert.equal(asRecipient(`look ${STATE}`, 711), 'withheld')
  await settle()
  const told = h.sent[h.sent.length - 1]!
  assert.equal(told.chatId, '7001')
  assert.equal(told.text, 'That message was not passed on to the agent: it contains a sign-in code.')
})

test('a message with no id is never recorded, so it cannot stand for later ones', async () => {
  const h = harness()
  const noId = (text: string) =>
    h.controller.message({ chatId: CHAT, messageId: Number.NaN, payload: POLL_OWNER_MSG, text, isSlash: false, fromHuman: true })
  assert.equal(noId(CODE), 'withheld')
  assert.equal(noId('an ordinary message'), 'not_mine', 'not dropped as an already consumed id')
})

test('a tap on an OLDER login card starts nothing once the open card is known', async () => {
  const h = harness()
  await h.controller.command(CHAT, '')
  await settle()
  // The open card is message 500; 499 is an older card in the same chat.
  assert.equal(h.controller.button({ chatId: CHAT, messageId: 499, callbackData: 'login:claudeai', clickerUserId: null }), 'consumed')
  assert.equal(h.children.length, 0)
  assert.equal(h.controller.button({ chatId: CHAT, messageId: 500, callbackData: 'login:claudeai', clickerUserId: null }), 'consumed')
  assert.equal(h.children.length, 1)
})

test('room context: relationship, chat kind, or a meeting chat', () => {
  assert.equal(isRoomContext({ relationship: 'room_member', payload: {}, isMeetingChat: false }), true)
  assert.equal(isRoomContext({ relationship: null, payload: { chat_kind: 'room' }, isMeetingChat: false }), true)
  assert.equal(isRoomContext({ relationship: null, payload: { chatKind: 'Room' }, isMeetingChat: false }), true)
  assert.equal(isRoomContext({ relationship: null, payload: {}, isMeetingChat: true }), true)
  assert.equal(isRoomContext({ relationship: 'owner', payload: { chat_kind: 'main' }, isMeetingChat: false }), false)
  assert.equal(isRoomContext({ relationship: null, payload: null, isMeetingChat: false }), false)
})

test('the code half alone is redacted too, if the CLI ever echoes it', async () => {
  const h = harness()
  await toAwaitingCode(h)
  ownerCode(h)
  const urlReplies = h.sent.length
  h.child.handlers.onStderr(`Login failed: {"code":"${CODE.slice(0, CODE.indexOf('#'))}"}\n`)
  h.child.handlers.onExit(1)
  await settle()
  const after = [...h.sent.slice(urlReplies).map((m) => m.text), ...h.logs]
  assert.ok(!after.some((l) => l.includes('FAKEauthcode')), 'the authorization code half never appears')
})

test('cancel and ask again while the first status read is pending: only the latest offer posts a card', async () => {
  const clock = new FakeClock()
  const sent: Array<{ text: string; buttons?: readonly LoginButton[] }> = []
  const pending: Array<(s: AuthStatus | null) => void> = []
  const controller = new LoginController({
    ownerUserId: OWNER,
    executable: () => '/opt/claude/bin/claude',
    spawn: () => ({ write: () => {}, kill: () => {} }),
    readAuthStatus: () => new Promise((resolve) => pending.push(resolve)),
    send: async (_c, text, buttons) => {
      sent.push({ text, ...(buttons ? { buttons } : {}) })
      return 600 + sent.length
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
  })
  await controller.command(CHAT, '')
  await controller.command(CHAT, 'cancel')
  await controller.command(CHAT, '')
  assert.equal(pending.length, 2)
  const status: AuthStatus = { loggedIn: false, authMethod: 'none', email: null, subscriptionType: null }
  pending[0]!(status)
  pending[1]!(status)
  await settle()
  assert.equal(sent.filter((m) => m.buttons).length, 1, 'exactly one card')
})

test('a second delivery of the consumed code message is still dropped, never forwarded', async () => {
  const h = harness()
  await toAwaitingCode(h)
  assert.equal(ownerCode(h, CODE, 77), 'consumed')
  assert.equal(ownerCode(h, CODE, 77), 'consumed', 'the same id again, now in verifying')
  assert.equal(h.child.writes.length, 1, 'and written once')
})

// ── routing: never the model ─────────────────────────────────────────────────

test('/login routes to the daemon on both payload shapes and never becomes a model directive', () => {
  const prepared = prepareSlashCommands(catalogForCapabilities({ remoteCompact: false, daemonLogin: true }))
  for (const payload of [
    { messageType: 'slash_command', commandName: 'login', commandArgs: '' },
    { message_type: 'slash_command', command_name: 'login', command_args: 'console' },
    { messageType: 'slash_command', text: '/login console' },
    { messageType: 'slash_command', commandName: '/LOGIN' },
  ]) {
    const r = routeSlashCommand({ payload, registry: prepared.registry, legacyAliases: prepared.legacyAliases })
    assert.equal(r.kind, 'login', JSON.stringify(payload))
  }
  // A project command called /login cannot shadow it.
  const shadow = prepareSlashCommands([{ command: '/login', description: 'x', scope: 'all', prompt: 'do it' }])
  const r = routeSlashCommand({ payload: { messageType: 'slash_command', commandName: 'login' }, registry: shadow.registry })
  assert.equal(r.kind, 'login')
})

test('/login is advertised only when a claude executable was found, and carries no prompt', () => {
  assert.ok(!BUILTIN_COMMANDS.some((c) => c.command === '/login'), 'never a model builtin')
  const on = catalogForCapabilities({ remoteCompact: false, daemonLogin: true }).find((c) => c.command === '/login')
  assert.ok(on, 'advertised with the capability')
  assert.equal(on.prompt, undefined)
  for (const opts of [{ remoteCompact: true }, { remoteCompact: false, daemonLogin: false }]) {
    assert.ok(!catalogForCapabilities(opts).some((c) => c.command === '/login'), JSON.stringify(opts))
  }
})

test('the login chip prefix is reserved, so an agent button can never pose as one', () => {
  assert.ok(RESERVED_VALUE_PREFIXES.includes('login:'))
  assert.equal(escapeAgentButtonValue('login:claudeai'), 'u:login:claudeai')
  const h = harness()
  assert.equal(
    h.controller.button({ chatId: CHAT, messageId: 1, callbackData: 'u:login:claudeai', clickerUserId: null }),
    'not_mine',
  )
  for (const b of LOGIN_METHOD_BUTTONS) assert.ok(b.callbackData.startsWith('login:'))
})

test('the arguments parse to an offer, a method, a cancel, or a usage reply that never echoes them', async () => {
  assert.deepEqual(parseLoginArgs(''), { kind: 'offer' })
  assert.deepEqual(parseLoginArgs('Subscription'), { kind: 'method', method: 'claudeai' })
  assert.deepEqual(parseLoginArgs('console'), { kind: 'method', method: 'console' })
  assert.deepEqual(parseLoginArgs('cancel'), { kind: 'cancel' })
  const h = harness()
  await h.controller.command(CHAT, CODE)
  assert.equal(h.children.length, 0)
  assertNoSecrets(h.sent.map((m) => m.text), 'usage reply')
  assert.match(h.sent[0]!.text, /^Usage: \/login/)
})

test('no claude executable: /login says so instead of pretending', async () => {
  const h = harness({ executable: null })
  await h.controller.command(CHAT, '')
  assert.equal(h.children.length, 0)
  assert.match(h.sent[0]!.text, /no claude executable was found/)
})

// ── server.ts wiring: SHAPE PINS ─────────────────────────────────────────────
//
// What these cannot catch: a rail that forwards the message by some other
// means before reaching the pinned call, a controller instance other than
// `loginController`, and anything that depends on runtime values. The
// behaviour above is what runs; this is where it is plugged in.

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const SHAPE = 'pins SHAPE only: the source text, not that this code runs'

test('the code is offered to the sign-in flow on every rail that forwards human text, before anything logs or forwards it (shape pin)', () => {
  assert.equal((src.match(/consumedAsLoginCode\(\{/g) ?? []).length, 4, `poll, ws, stream and meeting; ${SHAPE}`)
  // As the WHOLE condition of an if, at the start of a statement: a counted
  // call can be disarmed with `false && ` and still be counted (measured: that
  // mutation of the stream site stayed green against the count alone).
  assert.equal(
    (src.match(/\n[ ]+if \(consumedAsLoginCode\(\{\n/g) ?? []).length,
    4,
    `each site is a bare \`if (consumedAsLoginCode({\`; ${SHAPE}`,
  )
  // Poll: before the permission parse and the content log.
  const pollAt = src.indexOf("via: 'poll',\n      })) continue")
  assert.ok(pollAt > 0, 'the poll site drops a consumed code')
  assert.ok(pollAt < src.indexOf('isPermissionVerdict = VERDICT_RE.test(text)'), 'poll: before the permission parse')
  assert.ok(pollAt < src.indexOf("message in chat ${chatId}: \"${content.slice(0, 100)}"), 'poll: before the content log')
  // WS: before the turn is noted with the text.
  const wsAt = src.indexOf("via: 'ws',\n      })) return")
  assert.ok(wsAt > 0, 'the ws site drops a consumed code')
  const wsTurn = src.indexOf('turnChat.note({', wsAt - 4000)
  assert.ok(wsAt < wsTurn, 'ws: before turnChat.note records the text')
  // Stream: right after the id claim, before the permission parse and its content log.
  const streamAt = src.indexOf("via: 'stream',\n  })) return")
  assert.ok(streamAt > 0, 'the stream site drops a consumed code')
  assert.ok(streamAt < src.indexOf('isPermissionVerdict = VERDICT_RE.test(view.text)'), 'stream: before the permission parse')
  assert.ok(streamAt < src.indexOf('Stream replay message in chat'), 'stream: before the content log')
  // Meeting: before the meeting card that carries the text.
  const meetingAt = src.indexOf("via: 'meeting',\n      })) return")
  assert.ok(meetingAt > 0, 'the meeting site drops a withheld code')
  const meetingHandler = src.indexOf("realtimeSocket.on('meeting_message'")
  assert.ok(meetingAt > meetingHandler, 'inside the meeting_message handler')
  assert.ok(meetingAt < src.indexOf('const card = buildMeetingCard({', meetingHandler), 'meeting: before the card is built')
})

test('both click intakes hand a tap to the sign-in card before the plan half (shape pin)', () => {
  const taps = [...src.matchAll(/loginController\.button\(\{/g)].map((m) => m.index ?? -1)
  assert.equal(taps.length, 2, `poll and stream; ${SHAPE}`)
  const planCalls = [...src.matchAll(/const planAnswer = applyPlanAnswer\(\{/g)].map((m) => m.index ?? -1)
  assert.equal(planCalls.length, 3, 'poll, stream and the boot sweep')
  // Each intake's login check precedes its own plan half.
  for (const tap of taps) assert.ok(planCalls.some((p) => p > tap && p - tap < 2500), SHAPE)
})

test('the sign-in child is never left behind on shutdown (shape pin)', () => {
  const shutdownBody = src.slice(src.indexOf('const shutdown = (cause'), src.indexOf("process.on('exit', () => {"))
  assert.match(shutdownBody, /loginController\.dispose\(\)/)
  const exitHook = src.slice(src.indexOf("process.on('exit', () => {"), src.indexOf("for (const signal of ['SIGINT', 'SIGTERM'] as const)"))
  assert.match(exitHook, /loginController\.dispose\(\)/)
})

test('the child is spawned by argv with no shell, and the arguments are never logged (shape pin)', () => {
  const spawnBody = src.slice(src.indexOf('function spawnLoginChild('), src.indexOf('/** The one sign-in flow of this daemon.'))
  assert.match(spawnBody, /spawnProcess\(cmd\.command, cmd\.args, \{/)
  assert.match(spawnBody, /shell: false,/)
  assert.doesNotMatch(src, /login requested via [^`]*\$\{[^}]*commandArgs/, 'a rail log line must not carry the arguments')
})

// ── the stream rail, RUN (behavioural) ───────────────────────────────────────
//
// The shape pins above read text. This runs the real source of
// forwardStreamInbound and consumedAsLoginCode, transpiled out of server.ts,
// against the real LoginController and the real inbound and slash helpers.
// Every other free name resolves through a recorder, so the function runs to
// whichever end it reaches. The CONTROL case proves the harness can see a
// forward at all: without it, "the code was not forwarded" would be vacuous.

function serverFunction(header: string): string {
  const start = src.indexOf(`\n${header}`)
  assert.ok(start >= 0, `${header} exists in server.ts`)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start + 1, end + 3)
}

function streamRail(controller: LoginController) {
  const source = [
    serverFunction('function consumedAsLoginCode('),
    serverFunction('async function forwardStreamInbound('),
  ].join('\n')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const notifications: Array<{ content: string }> = []
  const logs: string[] = []
  const recorder: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : recorder),
    apply: () => undefined,
  })
  const known: Record<string, unknown> = {
    ...inboundChannel,
    ...slashCatalog,
    ...authLogin,
    loginController: controller,
    log: (line: string) => logs.push(line),
    USER_ID: OWNER,
    ASSISTANT_ID: '900',
    VERDICT_RE: /(?!)/,
    pendingPermissions: new Map(),
    forwardedMessageIds: new Set<number>(),
    registeredSlashCommands: new Map(),
    registeredSlashCommandAliases: new Map(),
    planPolicyMemo: { learn: () => undefined, recall: () => undefined },
    trackMessageOperation: (op: () => Promise<unknown>) => op(),
    // The steer gate (0.64.0): an ordinary message is delivered at once.
    deliverInbound: (_steer: unknown, deliver: (interrupted: boolean) => Promise<void>) => deliver(false),
    mcp: {
      notification: async (n: { params: { content: string } }) => {
        notifications.push({ content: n.params.content })
      },
    },
  }
  const scope = new Proxy(known, {
    has: (target, key) => key in target || !(key in globalThis),
    // A symbol read is the engine asking for Symbol.unscopables: answering it
    // with the recorder would mark every name unscopable and resolve nothing.
    get: (target, key) =>
      typeof key === 'symbol' ? undefined : key in target ? target[key] : recorder,
    set: (target, key, value) => {
      target[key as string] = value
      return true
    },
  })
  // eslint-disable-next-line no-new-func
  const factory = new Function('scope', `with (scope) {\n${js}\nreturn forwardStreamInbound\n}`)
  const forward = factory(scope) as (view: Record<string, unknown>, isSystem: boolean) => Promise<void>
  return { forward, notifications, logs }
}

function streamView(text: string, messageId: number, sender: Record<string, unknown> = {}) {
  return {
    chatId: CHAT,
    messageId,
    text,
    files: [],
    senderKind: 'user',
    agentOrigin: null,
    sentDate: new Date(0).toISOString(),
    sessionHandle: null,
    peerConversationId: null,
    turnState: null,
    messageType: 'text',
    eventMetaRaw: null,
    raw: { id: messageId, text, sender: 'user', user_id: OWNER, sender_user_id: OWNER, sender_relationship: 'owner', ...sender },
  }
}

test('the stream rail, run: the owner code goes to the sign-in child and is NOT forwarded; ordinary text still is', async () => {
  // CONTROL: no sign-in running, an ordinary message reaches the model.
  const idle = harness()
  const railIdle = streamRail(idle.controller)
  await railIdle.forward(streamView('hello there', 300), false)
  assert.equal(railIdle.notifications.length, 1, 'the harness sees an ordinary forward')
  assert.match(railIdle.notifications[0]!.content, /hello there/)

  // The code, while awaiting it.
  const h = harness()
  await toAwaitingCode(h)
  const rail = streamRail(h.controller)
  await rail.forward(streamView(CODE, 301), false)
  assert.equal(rail.notifications.length, 0, 'the code must not reach the model')
  assert.deepEqual(h.child.writes, [`${CODE}\n`], 'it went to the child instead')
  assertNoSecrets(rail.logs, 'stream rail logs')

  // A recipient's ordinary message in the same window is forwarded as usual.
  await rail.forward(streamView('from someone else', 302, { sender_user_id: RECIPIENT, sender_relationship: 'shared_recipient' }), false)
  assert.equal(rail.notifications.length, 1)
  assert.match(rail.notifications[0]!.content, /from someone else/)

  // The bad code fails; the owner pastes it again. Withheld, not forwarded.
  h.child.handlers.onStderr('Login failed: Request failed with status code 400\n')
  h.child.handlers.onExit(1)
  await settle()
  await rail.forward(streamView(CODE, 303), false)
  assert.equal(rail.notifications.length, 1, 'the re-pasted code must not reach the model')
  assertNoSecrets(rail.logs, 'stream rail logs after the re-paste')
})
