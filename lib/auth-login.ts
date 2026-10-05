/**
 * /login, answered by the DAEMON, so an agent whose Anthropic session expired
 * can be signed back in from the HOAI chat.
 *
 * WHY THE DAEMON AND NOT THE MODEL. When the CLI is logged out the model
 * cannot think, so a model-handled /login is dead exactly when it is needed.
 * The daemon is an MCP stdio child of that CLI and keeps running. So the
 * daemon runs `claude auth login` itself, as a child process, and relays the
 * one URL and the one code the flow needs through the chat.
 *
 * THE MECHANISM, measured on Claude Code 2.1.289 (2026-10-05), not reasoned
 * about:
 *   - `claude auth login --claudeai` (or `--console`) runs as a non-TTY child
 *     with piped stdio. stdout says "Opening browser to sign in", then
 *     "If the browser didn't open, visit: " and the URL wrapped in an OSC-8
 *     hyperlink (ESC ] 8 ; ; URL BEL URL ESC ] 8 ; ; BEL), so the URL is on the
 *     line TWICE and a naive regex captures a doubled string. stripOsc8 runs
 *     first, always.
 *   - then "Paste code here if prompted > " with no newline, and it blocks
 *     reading one line from stdin. The line is `<authorizationCode>#<state>`:
 *     the CLI splits on `#` and, when either half is missing, prints
 *     "Invalid code. Please make sure the full code was copied." and KEEPS
 *     WAITING. So a code without `#` would leave the child hanging, which is
 *     why validateAuthCode requires the separator.
 *   - exit 0 is success. A bad code exits 1 with stderr
 *     "Login failed: Request failed with status code 400".
 *   - `claude auth status --json` prints loggedIn, authMethod, email and
 *     subscriptionType (exit 1 when logged out, with the same JSON shape).
 *   - the CLI opens a browser with `$BROWSER` when it is set, else `open`.
 *     buildLoginEnv sets BROWSER to `true` (a no-op command; on Windows the
 *     spawn fails, which the CLI treats as "browser did not open"). That is a
 *     SECURITY choice, not a nicety: the browser it would open carries the
 *     AUTOMATIC flow, whose localhost callback completes the login without any
 *     code. On an unattended desktop that tab would let whoever sits there sign
 *     the agent into THEIR account. With it suppressed, the only way to finish
 *     is the code the owner pastes into the owner's own chat.
 *
 * NOT tmux injection. lib/compact-inject.ts forbids a second free-string
 * parameter and the auth code is a free string. The child-process path needs
 * none of that and works on Windows and where there is no tmux.
 *
 * SECURITY, all enforced here and pinned by test/auth-login.test.ts:
 *   - Owner only. The /login command goes through runDaemonCommand
 *     (lib/daemon-command-sender.ts), which refuses before `act`, so a
 *     stranger never reaches spawn. A code message is taken only from a sender
 *     isOwnerSender proves is the owner. A method tap is refused when it names
 *     someone else (null aware, like the plan card: today's backend stamps no
 *     clicker id on a tap).
 *   - The code is never logged, echoed or replied. Log lines about the URL
 *     carry its origin and path only, never the query (state, challenge).
 *     Child stderr is passed through redactLoginText before it is logged or
 *     replied.
 *   - One login in flight per daemon (there is one credential store).
 *   - awaiting_code times out at LOGIN_CODE_WINDOW_MS and kills the child.
 *   - A message that is not a plausible code is not consumed: the owner is
 *     told, the message goes on its normal way, the window stays open.
 *   - A message that CARRIES a code is never passed on, in any phase: a
 *     re-paste after a failure, a second send, a paste after the window
 *     closed, a code with text around it. carriesSignInCode decides, from the
 *     states of this process's recent attempts (anywhere in the text) and,
 *     for the owner, from a message that is nothing but a code, so the rails
 *     drop it before anything logs or forwards it, and the sender is told
 *     why. Its gap: after a daemon restart the old states are gone, so a code
 *     from before the restart is caught only when it is pasted on its own.
 *   - A sign-in is never started from a room or a meeting, where the link
 *     would be posted to every member (isRoomContext).
 *   - One login in flight PER DAEMON. Several agents on one machine can share
 *     one credential store, so a sign-in here signs those in as well, and two
 *     daemons could run two at once; nothing here can see the others.
 *   - argv exec only, never a shell (buildLoginArgv; resolveClaudeExecutable
 *     refuses a Windows .cmd/.bat, which would need one).
 *
 * The pure half (no I/O): stripOsc8, extractLoginUrl, validateAuthCode,
 * buildLoginArgv, buildLoginEnv, parseAuthStatusJson, parseLoginArgs and the
 * reducer reduceLogin. The LoginController below wires the reducer to
 * injected I/O (spawn, send, clock, timers), so every rule above is driven by
 * a test with fakes rather than read off source text.
 */

import { isOwnerSender, readSlashSender } from './daemon-command-sender.js'

// ── timing ───────────────────────────────────────────────────────────────────

/** How long the owner has to paste the code once the URL is out. */
export const LOGIN_CODE_WINDOW_MS = 10 * 60_000
/** How long the method buttons stay live. Same window: nothing is running yet. */
export const LOGIN_METHOD_WINDOW_MS = 10 * 60_000
/** The CLI printed its URL in ~100 ms when measured; a minute is generous. */
export const LOGIN_URL_WAIT_MS = 60_000
/** The token exchange took ~600 ms when measured. */
export const LOGIN_VERIFY_WAIT_MS = 90_000

// ── OSC-8 and the URL ────────────────────────────────────────────────────────

/**
 * Remove OSC-8 hyperlink wrappers, keeping the visible text. An OSC-8 link is
 * `ESC ] 8 ; params ; URI ST text ESC ] 8 ; ; ST`, with ST either BEL or
 * `ESC \`. The CLI prints the URL as both the URI and the text, so without
 * this the line carries it twice, glued together by control bytes that `\S`
 * happily matches.
 */
export function stripOsc8(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\]8;[^\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

/** Remove CSI sequences (colour, cursor moves) and any stray ESC. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b/g, '')
}

/**
 * Hosts a sign-in URL may point at. The CLI is the real Claude Code binary, so
 * this is defence in depth: the daemon relays a link into a chat, and the one
 * kind of link it has any business relaying is Anthropic's own sign-in page.
 * Measured hosts: claude.com (subscription), platform.claude.com (Console).
 */
const SIGN_IN_DOMAINS = ['claude.com', 'claude.ai', 'anthropic.com']

function isSignInHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return SIGN_IN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
}

/**
 * The sign-in URL in the CLI's stdout so far, or null until a COMPLETE one is
 * there. Only finished lines are read, because a pipe chunk can end in the
 * middle of the URL and a truncated link would be relayed as if it were whole.
 */
export function extractLoginUrl(stdout: string): string | null {
  const lastNewline = stdout.lastIndexOf('\n')
  if (lastNewline < 0) return null
  const complete = stripAnsi(stripOsc8(stdout.slice(0, lastNewline)))
  for (const token of complete.match(/https:\/\/[^\s"'<>]+/g) ?? []) {
    let parsed: URL
    try {
      parsed = new URL(token)
    } catch {
      continue
    }
    if (parsed.protocol !== 'https:') continue
    if (!isSignInHost(parsed.hostname)) continue
    if (!/\/oauth\/authorize\/?$/.test(parsed.pathname)) continue
    // The token as printed, not parsed.toString(): a re-serialised URL may
    // differ by an escape, and the link relayed must be the one the CLI made.
    return token
  }
  return null
}

/** The `state` parameter of a sign-in URL, used to validate the pasted code. */
export function loginUrlState(url: string): string | null {
  try {
    return new URL(url).searchParams.get('state') || null
  } catch {
    return null
  }
}

/** A URL as it may appear in a log line: origin and path, never the query. */
export function describeUrlForLog(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname} (query redacted)`
  } catch {
    return '<unparseable url redacted>'
  }
}

/**
 * Make child output safe to log or to put in a reply: every URL loses its
 * query, and every known secret (the code, the state) is replaced wherever it
 * appears. Secrets shorter than four characters are skipped, because
 * replacing every `a` in a message protects nothing and destroys the message.
 */
export function redactLoginText(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = stripAnsi(stripOsc8(String(text ?? '')))
  out = out.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1?<redacted>')
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue
    out = out.split(secret).join('<redacted>')
  }
  return out
}

// ── the code ─────────────────────────────────────────────────────────────────

export type CodeRejection =
  | 'empty'
  | 'multiline'
  | 'control_chars'
  | 'leading_slash'
  | 'whitespace'
  | 'too_long'
  | 'no_separator'
  | 'bad_charset'
  | 'state_mismatch'

export type CodeVerdict = { ok: true; code: string } | { ok: false; reason: CodeRejection }

/** Generous: a real code was ~100 characters. Anything past this is not one. */
export const MAX_AUTH_CODE_LENGTH = 2048

// One half of `<code>#<state>`: base64, base64url and URL-unreserved characters.
const CODE_HALF = /^[A-Za-z0-9._~+/=-]+$/

/**
 * Is this message plausibly the code the sign-in page showed? Shape only: the
 * CLI and Anthropic decide whether it is RIGHT. Surrounding whitespace is
 * trimmed (a paste often carries a trailing newline); everything else that
 * could change what reaches the child's stdin is refused, so the one line
 * written is exactly the one line pasted.
 *
 * `expectedState` is the URL's state. The code's second half is that state,
 * so a mismatch means a code from an OLDER sign-in attempt: the CLI would burn
 * this attempt on it, so it is refused here and the window stays open.
 */
export function validateAuthCode(raw: unknown, opts: { expectedState?: string | null } = {}): CodeVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  const text = raw.trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (/[\r\n\u2028\u2029]/.test(text)) return { ok: false, reason: 'multiline' }
  if (/[\p{Cc}\p{Cf}]/u.test(text)) return { ok: false, reason: 'control_chars' }
  if (text.startsWith('/')) return { ok: false, reason: 'leading_slash' }
  if (/\s/.test(text)) return { ok: false, reason: 'whitespace' }
  if (text.length > MAX_AUTH_CODE_LENGTH) return { ok: false, reason: 'too_long' }
  const hash = text.indexOf('#')
  if (hash <= 0 || hash === text.length - 1) return { ok: false, reason: 'no_separator' }
  const code = text.slice(0, hash)
  const state = text.slice(hash + 1)
  if (!CODE_HALF.test(code) || !CODE_HALF.test(state)) return { ok: false, reason: 'bad_charset' }
  if (opts.expectedState && state !== opts.expectedState) return { ok: false, reason: 'state_mismatch' }
  return { ok: true, code: text }
}

/** What the owner is told about a rejected message. Never quotes the message. */
export function describeCodeRejection(reason: CodeRejection): string {
  const tail =
    'I did not use it, and I am still waiting for the code: paste just the code from the sign-in ' +
    'page as one message, or send /login cancel to stop.'
  switch (reason) {
    case 'state_mismatch':
      return `That code belongs to a different sign-in attempt, not the link I sent last. ${tail}`
    case 'no_separator':
      return `That does not look like a whole sign-in code (it should contain a #). ${tail}`
    case 'multiline':
      return `That message has more than one line, so it is not a sign-in code. ${tail}`
    case 'empty':
      return `That message has no text, so it is not a sign-in code. ${tail}`
    default:
      return `That did not look like a sign-in code. ${tail}`
  }
}

/**
 * A message that is NOTHING BUT a code: a base64url code half, `#`, and a
 * state of exactly 43 base64url characters, which is what the CLI's state is
 * (32 random bytes, base64url, read off its source). Whole message only: a
 * shape rule applied INSIDE text dropped ordinary messages (a docs link with a
 * long anchor, a README section link, a git dependency pinned to a sha, a
 * Notion block link all match a loose `x#y`), so it was cut back to this.
 */
const BARE_CODE = /^[A-Za-z0-9_-]{16,}#[A-Za-z0-9_-]{43}$/

/**
 * Does this text carry a sign-in code? Used to keep such a message away from
 * the model and the log in EVERY phase, not only while a code is awaited.
 *
 * Two rules. A state from one of this process's recent attempts, ANYWHERE in
 * the text and from anyone: a code's second half IS that state, and 43 random
 * characters do not occur by accident. And, from the owner only, a message
 * that is a bare code token, which is what covers a paste after a restart,
 * when no state is remembered any more.
 */
export function carriesSignInCode(
  text: unknown,
  opts: { knownStates?: readonly string[]; fromOwner?: boolean } = {},
): boolean {
  if (typeof text !== 'string' || !text) return false
  for (const state of opts.knownStates ?? []) {
    if (state && state.length >= 16 && text.includes(state)) return true
  }
  return opts.fromOwner === true && BARE_CODE.test(text.trim())
}

/**
 * Is this /login from a room or a meeting? A sign-in started there would post
 * the link where every member sees it. Three signals, any one enough, because
 * no single one is on every rail: the sender's relationship (`room_member`,
 * stamped on live messages), the row's `chat_kind` (poll and stream rows), and
 * whether this daemon knows the chat as a meeting's.
 */
export function isRoomContext(input: {
  relationship: string | null
  payload: unknown
  isMeetingChat: boolean
}): boolean {
  if (input.isMeetingChat) return true
  if (input.relationship === 'room_member') return true
  const p = (input.payload && typeof input.payload === 'object' ? input.payload : {}) as Record<string, unknown>
  const kind = p.chat_kind ?? p.chatKind
  return typeof kind === 'string' && kind.toLowerCase() === 'room'
}

/** How long a used state is remembered, to keep a late re-paste out of the log. */
export const RECENT_STATE_TTL_MS = 60 * 60_000

// ── argv, env and the executable ─────────────────────────────────────────────

export type LoginMethod = 'claudeai' | 'console'

export interface ChildCommand {
  command: string
  args: string[]
}

/** argv for the login child. Exec'd directly: no shell ever sees it. */
export function buildLoginArgv(executable: string, method: LoginMethod): ChildCommand {
  return {
    command: executable,
    args: ['auth', 'login', method === 'console' ? '--console' : '--claudeai'],
  }
}

/** argv for the status read. */
export function buildAuthStatusArgv(executable: string): ChildCommand {
  return { command: executable, args: ['auth', 'status', '--json'] }
}

/**
 * The child's environment: the daemon's own, plus BROWSER pointed at a no-op
 * (see the header for why that is a security choice).
 *
 * CLAUDE_CONFIG_DIR is deliberately INHERITED, never set. The child must write
 * the credentials the running agent reads, and the agent read them with
 * whatever this process inherited. Setting it to the resolved default when it
 * was unset is not the same thing: the CLI keys its credential store on
 * whether the variable is set, so "filling in" the default could sign a
 * different store in and leave the agent exactly as logged out as before.
 */
export function buildLoginEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v
  env.BROWSER = 'true'
  return env
}

/**
 * The claude executable this daemon should run, or null when none can be
 * found (then /login is not advertised and says so if typed).
 *
 * CLAUDE_CODE_EXECPATH first: the CLI exports it to its children and it is the
 * exact binary of the session this daemon serves, so the login is performed by
 * the same version that will read the credentials. Then PATH. A Windows `.cmd`
 * or `.bat` shim is refused, because running one needs a shell.
 */
export function resolveClaudeExecutable(opts: {
  env: Record<string, string | undefined>
  platform: string
  isFile: (path: string) => boolean
}): string | null {
  const execPath = opts.env.CLAUDE_CODE_EXECPATH?.trim()
  if (execPath && !/\.(cmd|bat)$/i.test(execPath) && opts.isFile(execPath)) return execPath
  const win = opts.platform === 'win32'
  const sep = win ? ';' : ':'
  const names = win ? ['claude.exe'] : ['claude']
  for (const dir of (opts.env.PATH ?? opts.env.Path ?? '').split(sep)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = `${dir.replace(/[\\/]+$/, '')}${win ? '\\' : '/'}${name}`
      if (opts.isFile(candidate)) return candidate
    }
  }
  return null
}

// ── auth status ──────────────────────────────────────────────────────────────

export interface AuthStatus {
  loggedIn: boolean
  /** 'claude.ai', 'console', 'none', ... exactly as the CLI says it. */
  authMethod: string
  email: string | null
  subscriptionType: string | null
}

/** Parse `claude auth status --json`. Null when no JSON object answers. */
export function parseAuthStatusJson(stdout: string): AuthStatus | null {
  const raw = String(stdout ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (typeof o.loggedIn !== 'boolean') return null
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    loggedIn: o.loggedIn,
    authMethod: str(o.authMethod) ?? 'unknown',
    email: str(o.email),
    subscriptionType: str(o.subscriptionType),
  }
}

/** Does this sign-in carry HOAI channel messages? Only a subscription does. */
export function isSubscriptionAuthMethod(authMethod: string): boolean {
  return authMethod.toLowerCase().replace(/[^a-z0-9]/g, '').includes('claudeai')
}

/** "you@example.com (Claude Max)", from what the CLI reported. */
export function describeAccount(status: AuthStatus): string {
  const plan = status.subscriptionType
    ? `Claude ${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)}`
    : isSubscriptionAuthMethod(status.authMethod)
      ? 'Claude subscription'
      : status.authMethod === 'console'
        ? 'Anthropic Console'
        : status.authMethod
  return status.email ? `${status.email} (${plan})` : plan
}

// ── the command's arguments ──────────────────────────────────────────────────

export type LoginArgs =
  | { kind: 'offer' }
  | { kind: 'method'; method: LoginMethod }
  | { kind: 'cancel' }
  | { kind: 'unknown' }

/** `/login`, `/login console`, `/login subscription`, `/login cancel`. */
export function parseLoginArgs(args: string): LoginArgs {
  const word = String(args ?? '').trim().toLowerCase()
  if (!word) return { kind: 'offer' }
  if (['claudeai', 'claude.ai', 'claude', 'subscription', 'sub'].includes(word)) {
    return { kind: 'method', method: 'claudeai' }
  }
  if (['console', 'anthropic', 'api'].includes(word)) return { kind: 'method', method: 'console' }
  if (['cancel', 'stop', 'abort'].includes(word)) return { kind: 'cancel' }
  return { kind: 'unknown' }
}

// ── the buttons ──────────────────────────────────────────────────────────────

/**
 * The callback prefix of this daemon's own login chips. Listed in
 * RESERVED_VALUE_PREFIXES (lib/message-text.ts), and every agent authored
 * button goes out as `u:` + its value anyway, so a raw `login:` value can only
 * come off a card this daemon posted.
 */
export const LOGIN_CALLBACK_PREFIX = 'login:'

export interface LoginButton {
  text: string
  callbackData: string
  style?: 'primary' | 'default'
}

export const LOGIN_METHOD_BUTTONS: readonly LoginButton[] = [
  { text: 'Claude subscription', callbackData: `${LOGIN_CALLBACK_PREFIX}claudeai`, style: 'primary' },
  { text: 'Anthropic Console', callbackData: `${LOGIN_CALLBACK_PREFIX}console` },
]

/** The method a login chip carries, or null when the value is not one. */
export function loginMethodFromCallback(callbackData: string): LoginMethod | null {
  if (callbackData === `${LOGIN_CALLBACK_PREFIX}claudeai`) return 'claudeai'
  if (callbackData === `${LOGIN_CALLBACK_PREFIX}console`) return 'console'
  return null
}

// ── the state machine ────────────────────────────────────────────────────────

/**
 * idle: nothing running. awaiting_method: the buttons are out. starting: the
 * child is spawned and has not printed its URL yet. awaiting_code: the URL is
 * out and the owner's next message in that chat is the code. verifying: the
 * code was written and the child is exchanging it. done / failed: the last
 * attempt's outcome, which a new /login may replace.
 *
 * starting and verifying are the two moments a child is running but no
 * message may be taken as the code: before the owner has a URL, and after the
 * one code was used. They are states, rather than flags on awaiting_code, so
 * that "ONLY while awaiting_code" is one comparison.
 */
export type LoginPhase =
  | 'idle'
  | 'awaiting_method'
  | 'starting'
  | 'awaiting_code'
  | 'verifying'
  | 'done'
  | 'failed'

export interface LoginState {
  phase: LoginPhase
  /** The chat the login belongs to. */
  chatId: string | null
  method: LoginMethod | null
  /** When the current phase gives up, or null when it never does. */
  deadlineMs: number | null
  /** Which child this is, so a late exit from a killed one is ignored. */
  attempt: number
  /** The URL's state, held in memory only, to validate the pasted code. */
  expectedState: string | null
  /** The card the method buttons went out on, once its id is known. */
  cardMessageId: number | null
}

export const INITIAL_LOGIN_STATE: LoginState = {
  phase: 'idle',
  chatId: null,
  method: null,
  deadlineMs: null,
  attempt: 0,
  expectedState: null,
  cardMessageId: null,
}

export type LoginEvent =
  | { type: 'open'; chatId: string; nowMs: number }
  | { type: 'card_posted'; messageId: number }
  | { type: 'choose'; chatId: string; method: LoginMethod; nowMs: number }
  | { type: 'url'; attempt: number; url: string; nowMs: number }
  | { type: 'message'; chatId: string; text: unknown; fromOwner: boolean; isSlash: boolean; nowMs: number }
  | { type: 'exit'; attempt: number; code: number | null; stderr: string; nowMs: number }
  | { type: 'tick'; nowMs: number }
  | { type: 'cancel'; chatId: string }

export type LoginEffect =
  | { kind: 'offer'; chatId: string }
  | { kind: 'busy'; chatId: string; phase: LoginPhase }
  | { kind: 'spawn'; attempt: number; method: LoginMethod }
  | { kind: 'send_url'; chatId: string; url: string }
  | { kind: 'write_code'; attempt: number; code: string }
  | { kind: 'reject_code'; chatId: string; reason: CodeRejection }
  | { kind: 'kill'; attempt: number }
  | { kind: 'succeeded'; chatId: string }
  | { kind: 'failed'; chatId: string; stage: 'start' | 'code' | 'verify'; reason: string }
  | { kind: 'timed_out'; chatId: string; phase: LoginPhase }
  | { kind: 'cancelled'; chatId: string }
  | { kind: 'nothing_to_cancel'; chatId: string }

/**
 * What a message event meant, for the rail that asked. 'consumed' and
 * 'withheld' both mean the rail must DROP the message: the first was the code,
 * the second carried one and was not used. 'rejected' means it was not a code
 * and goes on its normal way, with the owner told.
 */
export type MessageOutcome = 'consumed' | 'withheld' | 'rejected' | 'not_mine'

/** True when the rail must not log or forward the message. */
export function mustDropMessage(outcome: MessageOutcome): boolean {
  return outcome === 'consumed' || outcome === 'withheld'
}

export interface LoginTransition {
  state: LoginState
  effects: LoginEffect[]
  /** Set on a `message` event: whether the rail must stop delivering it. */
  message?: MessageOutcome
}

/** A child is running in these phases; one is the single flight. */
export function isLoginInFlight(phase: LoginPhase): boolean {
  return phase === 'awaiting_method' || phase === 'starting' || phase === 'awaiting_code' || phase === 'verifying'
}

function childRunning(phase: LoginPhase): boolean {
  return phase === 'starting' || phase === 'awaiting_code' || phase === 'verifying'
}

/** The first meaningful line of child stderr, already redacted by the caller. */
function failureReason(stderr: string, fallback: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return (line ?? fallback).slice(0, 300)
}

/**
 * The whole lifecycle as a pure function: the same state and event always give
 * the same next state and effects, so every rule in the header is a test.
 */
export function reduceLogin(state: LoginState, event: LoginEvent): LoginTransition {
  const stay = (effects: LoginEffect[] = [], message?: MessageOutcome): LoginTransition => ({
    state,
    effects,
    ...(message ? { message } : {}),
  })

  switch (event.type) {
    case 'open': {
      if (isLoginInFlight(state.phase)) {
        return stay([{ kind: 'busy', chatId: event.chatId, phase: state.phase }])
      }
      return {
        state: {
          ...INITIAL_LOGIN_STATE,
          attempt: state.attempt,
          phase: 'awaiting_method',
          chatId: event.chatId,
          deadlineMs: event.nowMs + LOGIN_METHOD_WINDOW_MS,
        },
        effects: [{ kind: 'offer', chatId: event.chatId }],
      }
    }

    case 'card_posted': {
      if (state.phase !== 'awaiting_method') return stay()
      return { state: { ...state, cardMessageId: event.messageId }, effects: [] }
    }

    case 'choose': {
      // Only the chat the offer went to, and only while the offer is open. A
      // tap on a stale card, or on one in another chat, starts nothing.
      if (state.phase !== 'awaiting_method' || state.chatId !== event.chatId) return stay()
      const attempt = state.attempt + 1
      return {
        state: {
          ...state,
          phase: 'starting',
          method: event.method,
          attempt,
          deadlineMs: event.nowMs + LOGIN_URL_WAIT_MS,
        },
        effects: [{ kind: 'spawn', attempt, method: event.method }],
      }
    }

    case 'url': {
      if (state.phase !== 'starting' || event.attempt !== state.attempt || !state.chatId) return stay()
      return {
        state: {
          ...state,
          phase: 'awaiting_code',
          expectedState: loginUrlState(event.url),
          deadlineMs: event.nowMs + LOGIN_CODE_WINDOW_MS,
        },
        effects: [{ kind: 'send_url', chatId: state.chatId, url: event.url }],
      }
    }

    case 'message': {
      // ONLY while awaiting_code, ONLY in that chat, ONLY from the owner.
      if (state.phase !== 'awaiting_code' || state.chatId !== event.chatId || !event.fromOwner) {
        return stay([], 'not_mine')
      }
      // A slash command is a command, not a code: it goes on to its own route
      // (that is how /login cancel and /status still work), and saying "that
      // was not a code" on top of its answer would be noise.
      if (event.isSlash) return stay([], 'not_mine')
      const verdict = validateAuthCode(event.text, { expectedState: state.expectedState })
      if (!verdict.ok) {
        return stay([{ kind: 'reject_code', chatId: event.chatId, reason: verdict.reason }], 'rejected')
      }
      return {
        state: { ...state, phase: 'verifying', deadlineMs: event.nowMs + LOGIN_VERIFY_WAIT_MS },
        effects: [{ kind: 'write_code', attempt: state.attempt, code: verdict.code }],
        message: 'consumed',
      }
    }

    case 'exit': {
      // A child this state no longer owns (killed on a timeout, superseded) is
      // over already: its exit must not produce a second reply.
      if (!childRunning(state.phase) || event.attempt !== state.attempt || !state.chatId) return stay()
      const chatId = state.chatId
      const ended: LoginState = { ...state, deadlineMs: null, expectedState: null }
      if (event.code === 0) {
        return { state: { ...ended, phase: 'done' }, effects: [{ kind: 'succeeded', chatId }] }
      }
      const stage = state.phase === 'starting' ? 'start' : state.phase === 'awaiting_code' ? 'code' : 'verify'
      const fallback =
        event.code === null ? 'the sign-in process stopped unexpectedly' : `the sign-in process exited with code ${event.code}`
      return {
        state: { ...ended, phase: 'failed' },
        effects: [{ kind: 'failed', chatId, stage, reason: failureReason(event.stderr, fallback) }],
      }
    }

    case 'tick': {
      if (state.deadlineMs === null || event.nowMs < state.deadlineMs || !state.chatId) return stay()
      const chatId = state.chatId
      const ended: LoginState = { ...state, deadlineMs: null, expectedState: null }
      if (state.phase === 'awaiting_method') {
        return { state: { ...ended, phase: 'idle' }, effects: [{ kind: 'timed_out', chatId, phase: state.phase }] }
      }
      if (childRunning(state.phase)) {
        return {
          state: { ...ended, phase: 'failed' },
          effects: [
            { kind: 'kill', attempt: state.attempt },
            { kind: 'timed_out', chatId, phase: state.phase },
          ],
        }
      }
      return stay()
    }

    case 'cancel': {
      if (!isLoginInFlight(state.phase)) return stay([{ kind: 'nothing_to_cancel', chatId: event.chatId }])
      const effects: LoginEffect[] = []
      if (childRunning(state.phase)) effects.push({ kind: 'kill', attempt: state.attempt })
      effects.push({ kind: 'cancelled', chatId: event.chatId })
      return {
        state: { ...state, phase: 'idle', deadlineMs: null, expectedState: null, cardMessageId: null },
        effects,
      }
    }
  }
}

// ── the controller: the reducer wired to injected I/O ────────────────────────

/** The one running child, as the controller needs it. */
export interface LoginChild {
  /** Write to the child's stdin. */
  write(text: string): void
  kill(): void
}

export interface LoginChildHandlers {
  onStdout(chunk: string): void
  onStderr(chunk: string): void
  /** Exactly once: a spawn failure arrives here with code null and the error. */
  onExit(code: number | null, error?: string): void
}

export interface LoginDeps {
  ownerUserId: string
  /** The resolved claude executable, or null when there is none. */
  executable: () => string | null
  /** argv exec of `command args`. Never a shell. */
  spawn: (cmd: ChildCommand, handlers: LoginChildHandlers) => LoginChild
  readAuthStatus: () => Promise<AuthStatus | null>
  /** Send text to a chat, with optional buttons; resolves to the message id when known. */
  send: (chatId: string, text: string, buttons?: readonly LoginButton[]) => Promise<number | null>
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  log: (line: string) => void
}

const MAX_CAPTURE = 64 * 1024

export class LoginController {
  private state: LoginState = INITIAL_LOGIN_STATE
  private child: LoginChild | null = null
  private stdout = ''
  private stderr = ''
  private timer: unknown = null
  /** The code written this attempt, kept only to redact it from child output. */
  private secrets: string[] = []
  /**
   * Message ids taken as a code. Every rail already dedupes on message id
   * before it gets here; this is the second lock on the one door that matters,
   * because a duplicate that slipped through after the phase moved on would be
   * forwarded to the model, code and all.
   */
  private readonly consumedIds = new Set<string>()
  /** The states of recent attempts, with when each is forgotten. */
  private readonly recentStates = new Map<string, number>()
  /** Bumped by every offer, so a slow status read cannot post a stale card. */
  private offerSeq = 0

  constructor(private readonly deps: LoginDeps) {}

  get phase(): LoginPhase {
    return this.state.phase
  }

  get chatId(): string | null {
    return this.state.chatId
  }

  /**
   * The owner's /login. Reached only through runDaemonCommand's allow arm.
   *
   * `inRoom` is the sender's relationship read off the same message
   * (`room_member`, which a persistent group stamps on everyone, the owner
   * included). A sign-in is never STARTED from a room: the link would be posted
   * where every member sees it, and a tap on the method card, which today's
   * backend does not attribute, could come from any of them. Cancelling is
   * still allowed there, because it only ever takes something away.
   */
  async command(chatId: string, rawArgs: string, opts: { inRoom?: boolean } = {}): Promise<void> {
    const args = parseLoginArgs(rawArgs)
    if (args.kind === 'cancel') {
      this.dispatch({ type: 'cancel', chatId })
      return
    }
    if (opts.inRoom) {
      await this.reply(
        chatId,
        'Send /login from your own chat with this agent, not from a room: the sign-in link would be ' +
          'visible to everyone here.',
      )
      return
    }
    if (args.kind === 'unknown') {
      await this.reply(
        chatId,
        'Usage: /login to pick a sign-in method, /login subscription or /login console to start one ' +
          'directly, /login cancel to stop a sign-in that is running.',
      )
      return
    }
    if (!this.deps.executable()) {
      await this.reply(
        chatId,
        'I cannot sign this agent in from here: no claude executable was found on this machine. ' +
          'Run `claude auth login` in a terminal on the agent machine.',
      )
      return
    }
    if (args.kind === 'method' && this.state.phase === 'awaiting_method' && this.state.chatId === chatId) {
      this.dispatch({ type: 'choose', chatId, method: args.method, nowMs: this.deps.now() })
      return
    }
    this.dispatch({ type: 'open', chatId, nowMs: this.deps.now() }, args.kind === 'method' ? args.method : null)
  }

  /**
   * A button tap. 'consumed' means it was this daemon's login card (or a login
   * chip) and the rail must not forward it to the model.
   */
  button(input: {
    chatId: string
    messageId: number
    callbackData: string
    /** senderUserIdCandidate of the answer: null when the tap names nobody. */
    clickerUserId: string | null
  }): 'consumed' | 'not_mine' {
    const method = loginMethodFromCallback(input.callbackData)
    const onCard = this.state.cardMessageId !== null && this.state.cardMessageId === input.messageId
    if (method === null && !onCard) return 'not_mine'
    // Null aware, the plan card's rule: a tap that NAMES someone else is
    // refused; an unstamped tap, which is every tap on today's backend, is
    // taken, because the card went only to the owner's chat.
    if (input.clickerUserId !== null && input.clickerUserId !== this.deps.ownerUserId) {
      this.deps.log(`/login: ignoring a tap on message ${input.messageId} from someone other than the owner`)
      return 'consumed'
    }
    if (method === null) {
      // Skip or a custom reply on the login card: the owner backed out.
      if (this.state.phase === 'awaiting_method') this.dispatch({ type: 'cancel', chatId: input.chatId })
      return 'consumed'
    }
    // The tap must be on THE card of the open offer, once its id is known: a
    // chip on an older card, or on another agent's, starts nothing.
    const staleCard = this.state.cardMessageId !== null && !onCard
    if (this.state.phase !== 'awaiting_method' || this.state.chatId !== input.chatId || staleCard) {
      void this.reply(input.chatId, 'That sign-in offer is no longer open. Send /login to start again.')
      return 'consumed'
    }
    this.dispatch({ type: 'choose', chatId: input.chatId, method, nowMs: this.deps.now() })
    return 'consumed'
  }

  /**
   * An inbound message, offered BEFORE it is logged or forwarded anywhere, in
   * every phase. See MessageOutcome; mustDropMessage says what the rail does.
   */
  message(input: {
    chatId: string
    messageId: string | number
    payload: unknown
    text: unknown
    isSlash: boolean
    /** False for a peer agent's or a system message: neither is ever the code. */
    fromHuman: boolean
  }): MessageOutcome {
    const id = String(input.messageId)
    // A message with no id (the meeting rail allows one) is never recorded or
    // matched: one such id would otherwise stand for every later one.
    const trackable = Number.isFinite(Number(input.messageId)) && id !== ''
    if (trackable && this.consumedIds.has(id)) return 'consumed'
    const fromOwner =
      input.fromHuman && isOwnerSender(readSlashSender(input.payload), this.deps.ownerUserId)
    const carries =
      input.fromHuman && carriesSignInCode(input.text, { knownStates: this.knownStates(), fromOwner })
    if (this.state.phase === 'awaiting_code') {
      const t = reduceLogin(this.state, {
        type: 'message',
        chatId: input.chatId,
        text: input.text,
        fromOwner,
        isSlash: input.isSlash,
        nowMs: this.deps.now(),
      })
      if (t.message === 'consumed') {
        this.apply(t)
        if (trackable) this.remember(id)
        return 'consumed'
      }
      if (t.message === 'rejected') {
        if (!carries) {
          this.apply(t)
          return 'rejected'
        }
        // The owner's message carries the code but is not just the code (text
        // around it, a stray space). Not used, and NOT passed on.
        const reason = t.effects.find((e) => e.kind === 'reject_code')
        this.deps.log(`/login: a message in chat ${input.chatId} carried a code with other text; withheld`)
        void this.reply(
          input.chatId,
          reason?.kind === 'reject_code' && reason.reason === 'state_mismatch'
            ? describeCodeRejection('state_mismatch')
            : 'That message contains the sign-in code but also something else, so I did not use it and ' +
                'did not pass it on. Paste just the code, on its own, as one message, or send /login cancel to stop.',
        )
        if (trackable) this.remember(id)
        return 'withheld'
      }
    }
    if (!carries) return 'not_mine'
    // A code outside its window: a re-paste after a failure, a second send, a
    // paste after the timeout, or from someone who is not the owner. Never
    // passed on.
    this.deps.log(`/login: a message in chat ${input.chatId} looked like a sign-in code outside a sign-in; withheld`)
    const phase = this.state.phase
    const elsewhere = this.state.chatId !== null && this.state.chatId !== input.chatId
    if (trackable) this.remember(id)
    if (!fromOwner) {
      // Only a remembered state gets here for a non-owner. They cannot run
      // /login, so they are told only why their message went nowhere.
      void this.reply(input.chatId, 'That message was not passed on to the agent: it contains a sign-in code.')
      return 'withheld'
    }
    void this.reply(
      input.chatId,
      phase === 'verifying' && !elsewhere
        ? 'That looks like a sign-in code. I am already checking the one you sent, so I did not use this one and did not pass it on.'
        : phase === 'awaiting_code' && elsewhere
          ? 'That looks like a sign-in code, so I did not pass it on. The sign-in waiting for a code was started in ' +
              'another chat with this agent: paste it there.'
          : phase === 'awaiting_code'
            ? 'That looks like a sign-in code, so I did not pass it on.'
            : 'That looks like a sign-in code, so I did not pass it on to the agent. No sign-in is waiting for a code ' +
                'right now: send /login to start one. A code only works with the link it came from.',
    )
    return 'withheld'
  }

  private remember(id: string): void {
    this.consumedIds.add(id)
    if (this.consumedIds.size > 50) {
      const first = this.consumedIds.values().next().value
      if (first !== undefined) this.consumedIds.delete(first)
    }
  }

  private knownStates(): string[] {
    const now = this.deps.now()
    for (const [state, until] of this.recentStates) if (until <= now) this.recentStates.delete(state)
    return [...this.recentStates.keys()]
  }

  /** Fire any deadline that has passed. The timer calls this; so may a test. */
  tick(): void {
    this.dispatch({ type: 'tick', nowMs: this.deps.now() })
  }

  /** Daemon shutdown: never leave a sign-in child behind. */
  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    this.killChild()
  }

  private dispatch(event: LoginEvent, directMethod: LoginMethod | null = null): void {
    const t = reduceLogin(this.state, event)
    this.apply(t, directMethod)
  }

  private apply(t: LoginTransition, directMethod: LoginMethod | null = null): void {
    this.state = t.state
    this.armTimer()
    for (const effect of t.effects) this.run(effect, directMethod)
  }

  private armTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    const deadline = this.state.deadlineMs
    if (deadline === null) return
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      this.tick()
    }, Math.max(0, deadline - this.deps.now()))
  }

  private reply(chatId: string, text: string, buttons?: readonly LoginButton[]): Promise<number | null> {
    return this.deps.send(chatId, text, buttons).catch((err) => {
      this.deps.log(`/login: reply failed (chat ${chatId}): ${redactLoginText(String(err), this.secrets)}`)
      return null
    })
  }

  private run(effect: LoginEffect, directMethod: LoginMethod | null): void {
    const { log } = this.deps
    switch (effect.kind) {
      case 'offer':
        if (directMethod) {
          // `/login console`: the owner already chose, so there is no card.
          log(`/login: ${directMethod} sign-in requested directly (chat ${effect.chatId})`)
          this.dispatch({ type: 'choose', chatId: effect.chatId, method: directMethod, nowMs: this.deps.now() })
          return
        }
        void this.offer(effect.chatId)
        return
      case 'busy':
        void this.reply(
          effect.chatId,
          `A sign-in is already running (${describePhase(effect.phase)}). Only one can run at a time. ` +
            'Send /login cancel to stop it, then /login to start again.',
        )
        return
      case 'spawn':
        this.spawnChild(effect.attempt, effect.method)
        return
      case 'send_url': {
        const state = loginUrlState(effect.url)
        if (state) this.recentStates.set(state, this.deps.now() + RECENT_STATE_TTL_MS)
        log(`/login: sign-in URL relayed to chat ${effect.chatId}: ${describeUrlForLog(effect.url)}`)
        void this.reply(
          effect.chatId,
          [
            'Open this link, sign in, and paste the code the page shows back here as your next message:',
            '',
            effect.url,
            '',
            'The code goes straight to the sign-in process on this machine and is never shown back. ' +
              'This closes in 10 minutes. Send /login cancel to stop.',
          ].join('\n'),
        )
        return
      }
      case 'write_code': {
        // The ONE place the code goes: the child's stdin. Not logged, not echoed.
        const hash = effect.code.indexOf('#')
        this.secrets.push(effect.code, effect.code.slice(0, hash), effect.code.slice(hash + 1))
        log(`/login: a code was received from the owner and written to the sign-in process (attempt ${effect.attempt})`)
        try {
          this.child?.write(`${effect.code}\n`)
        } catch (err) {
          log(`/login: writing the code failed: ${redactLoginText(String(err), this.secrets)}`)
          this.killChild()
        }
        return
      }
      case 'reject_code':
        log(`/login: a message in chat ${effect.chatId} was not taken as the code (${effect.reason})`)
        void this.reply(effect.chatId, describeCodeRejection(effect.reason))
        return
      case 'kill':
        this.killChild()
        return
      case 'succeeded':
        this.endChild()
        void this.reportSuccess(effect.chatId)
        return
      case 'failed': {
        this.endChild()
        // Already redacted: child stderr is redacted where it is taken in
        // (onExit in spawnChild), so nothing unredacted ever enters the
        // reducer. One redaction point, which the echo test proves.
        const reason = effect.reason
        log(`/login: sign-in failed at ${effect.stage}: ${reason}`)
        const lead =
          effect.stage === 'start'
            ? 'The sign-in could not start'
            : 'The sign-in did not complete'
        void this.reply(
          effect.chatId,
          `${lead}: ${reason}\n\nSend /login to try again. Each attempt makes a new link, and a code only works with the link it came from.`,
        )
        this.secrets = []
        return
      }
      case 'timed_out': {
        log(`/login: ${effect.phase} timed out (chat ${effect.chatId})`)
        this.secrets = []
        const text =
          effect.phase === 'awaiting_method'
            ? 'The sign-in offer expired. Send /login to start again.'
            : effect.phase === 'awaiting_code'
              ? 'No code arrived within 10 minutes, so I stopped the sign-in. Send /login to start again.'
              : effect.phase === 'starting'
                ? 'The sign-in process did not produce a link in time, so I stopped it. Send /login to try again.'
                : 'The sign-in process did not finish in time, so I stopped it. Send /login to try again.'
        void this.reply(effect.chatId, text)
        return
      }
      case 'cancelled':
        log(`/login: cancelled by the owner (chat ${effect.chatId})`)
        this.secrets = []
        void this.reply(effect.chatId, 'Sign-in cancelled. Nothing was changed.')
        return
      case 'nothing_to_cancel':
        void this.reply(effect.chatId, 'No sign-in is running.')
        return
    }
  }

  private async offer(chatId: string): Promise<void> {
    const seq = ++this.offerSeq
    const status = await this.deps.readAuthStatus().catch(() => null)
    // The owner may have cancelled, or the offer expired, while the status was
    // read; or cancelled and asked again, which started a NEWER offer that
    // posts its own card. Only the latest offer may post.
    if (seq !== this.offerSeq) return
    if (this.state.phase !== 'awaiting_method' || this.state.chatId !== chatId) return
    const consoleNote =
      'A Claude subscription is what HOAI chat needs: with an Anthropic Console sign-in, chat messages may not reach the agent.'
    const lead = !status
      ? 'I could not read whether this agent is signed in. Pick how to sign in.'
      : status.loggedIn
        ? `This agent is already signed in as ${describeAccount(status)}. Sign in again anyway? Pick a method.`
        : 'This agent is not signed in. Pick how to sign in.'
    const text = `${lead}\n\n${consoleNote}`
    const messageId = await this.reply(chatId, text, LOGIN_METHOD_BUTTONS)
    if (messageId !== null) this.dispatch({ type: 'card_posted', messageId })
  }

  private spawnChild(attempt: number, method: LoginMethod): void {
    const executable = this.deps.executable()
    this.stdout = ''
    this.stderr = ''
    this.secrets = []
    if (!executable) {
      this.dispatch({ type: 'exit', attempt, code: null, stderr: 'no claude executable was found', nowMs: this.deps.now() })
      return
    }
    const cmd = buildLoginArgv(executable, method)
    this.deps.log(`/login: starting ${cmd.args.join(' ')} (attempt ${attempt})`)
    let exited = false
    const handlers: LoginChildHandlers = {
      onStdout: (chunk) => {
        if (attempt !== this.state.attempt || this.state.phase !== 'starting') return
        this.stdout = (this.stdout + chunk).slice(-MAX_CAPTURE)
        const url = extractLoginUrl(this.stdout)
        if (url) {
          this.stdout = ''
          this.dispatch({ type: 'url', attempt, url, nowMs: this.deps.now() })
        }
      },
      onStderr: (chunk) => {
        if (attempt !== this.state.attempt) return
        this.stderr = (this.stderr + chunk).slice(-MAX_CAPTURE)
      },
      onExit: (code, error) => {
        if (exited) return
        exited = true
        if (attempt === this.state.attempt) this.child = null
        const stderr = redactLoginText(error ? `${this.stderr}\n${error}` : this.stderr, this.secrets)
        this.dispatch({ type: 'exit', attempt, code, stderr, nowMs: this.deps.now() })
      },
    }
    try {
      this.child = this.deps.spawn(cmd, handlers)
    } catch (err) {
      handlers.onExit(null, `could not start the claude CLI: ${String(err)}`)
    }
  }

  private async reportSuccess(chatId: string): Promise<void> {
    this.secrets = []
    const status = await this.deps.readAuthStatus().catch(() => null)
    this.deps.log(`/login: sign-in succeeded (chat ${chatId}, method ${status?.authMethod ?? 'unknown'})`)
    if (!status?.loggedIn) {
      await this.reply(
        chatId,
        'The sign-in process reported success, but I could not confirm the new sign-in. Send /status, or /login to try again.',
      )
      return
    }
    const warn = isSubscriptionAuthMethod(status.authMethod)
      ? ''
      : '\n\nThis is not a Claude subscription sign-in, so HOAI chat messages may not reach the agent. Send /login and pick Claude subscription to switch.'
    await this.reply(
      chatId,
      `Signed in as ${describeAccount(status)}. If the agent still says it is logged out, restart it.${warn}`,
    )
  }

  private endChild(): void {
    this.child = null
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill()
    } catch (err) {
      this.deps.log(`/login: killing the sign-in process failed: ${String(err)}`)
    }
  }
}

function describePhase(phase: LoginPhase): string {
  switch (phase) {
    case 'awaiting_method':
      return 'waiting for a sign-in method to be picked'
    case 'starting':
      return 'starting the sign-in process'
    case 'awaiting_code':
      return 'waiting for the code from the sign-in page'
    case 'verifying':
      return 'checking the code'
    default:
      return phase
  }
}
