/**
 * claude-account-id: WHICH Claude account is signed in, the only proof that usage came back on a
 * login change. A credential file that moved (a token refresh, a touched file) or a second saved
 * login on the same account is not a new account, so it is never proof.
 *
 *   accountTokenFrom(stdout)   the account a `claude auth status --json` answer names, as a one way
 *                              token. The CLI (2.1.330) prints no account id for a claude.ai login,
 *                              only the organization (orgId) and the seat's email, so the account
 *                              is the seat: "seat:<hash of orgId and email>", and two seats of one
 *                              Team organization are two accounts. A missing or empty email or
 *                              orgId is unknown (null), like a failed read. If a CLI prints an
 *                              accountUuid, "account:<hash>" is used instead; the two kinds are
 *                              never compared. Neither the ids nor the email leave this function.
 *   accountChanged(a, b)       true only when both tokens are known, of the same kind, and differ.
 *   agentAccountDir(dir, env)  the config folder the limit watch reads an agent's transcript from,
 *                              so its login from the same: its recipe's folder, else the
 *                              CLAUDE_CONFIG_DIR the watcher runs under, else none (the default).
 *   accountEnv(input)          the environment the agent launched with, for a status read.
 *   statusInput(input)         one status read's folder key, environment and working folder.
 *   boundedExec(file, args)    one CLI run under a timeout; on Windows a timeout also ends what a
 *                              `cmd /c claude.cmd` shim started (its node child runs on otherwise).
 *   endStartedTree(pid)        that walk: only children born after the shim (lib/process-tree.mjs
 *                              win32ShimTargets). Never `taskkill /T`, which follows stale parent ids.
 *   createStatusReader(input)  ONE status read per config folder a minute inside the watcher (the
 *                              switcher's snapshot, its limit look, the limit watch), failures
 *                              included, never two at once. `read` waits for it; `peek` never
 *                              blocks: it answers from a read of the last minute, else the last one
 *                              to answer while it is under two minutes old, and starts one when due.
 *                              An owner's Switch press asks for a read started since the press.
 *                              Every answer goes to ONE read log (`log`), with when it started and
 *                              when it answered: the switcher and the limit watch both ask it who
 *                              was signed in before a limit and who first after it.
 *   peekAccount(reader)        the limit watch's view of `peek`: { ok: true, token, readAt } or
 *                              { ok: false, why }. A read counts at a limit only if it began after it.
 *
 * It only ever runs `claude --version` and `claude auth status --json`. Never a sign in or a sign
 * out, never a credential file or Keychain item opened here. Only stable CLI releases >= 2.1.317 run
 * auth status (lib/claude-subscription-status.mjs says why). The token is never logged; it lives
 * only in this computer's watch record and account registry. Plain JavaScript, node >= 18.
 */

import { createHash } from 'node:crypto'
import { delimiter, join, resolve, win32 } from 'node:path'
import { accountChanged, createReadLog } from './limit-screen.mjs'
import { spawnCollect } from './plugin-cli.mjs'
import { WIN32_PROCESS_ROWS_SCRIPT, parseWin32ProcessRows, win32ShimTargets } from './process-tree.mjs'

export const ACCOUNT_READ_TIMEOUT_MS = 5_000
export const ACCOUNT_READ_EVERY_MS = 60_000
/** An agent with no limit keeps a read of its login this fresh, for the next limit to compare with. */
export const ACCOUNT_KEEP_EVERY_MS = 5 * 60_000
/** Those background reads run this many at a time, whatever the number of folders. */
export const ACCOUNT_KEEP_AT_ONCE = 2
/** While a newer read runs, `peek` answers from the last one to answer for this long (two heartbeats):
 *  the watcher's looks come 60 s plus a heartbeat apart, so a read started on one look has to be
 *  collected on the next. */
export const ACCOUNT_LAST_READ_KEEPS_MS = 2 * 60_000

/** Login and provider settings that would make a status read answer for something else. */
const LOGIN_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_GATEWAY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN',
])

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const token = (kind, id) => `${kind}:${createHash('sha256').update(`${kind}:${id}`).digest('hex').slice(0, 32)}`

/**
 * @param {unknown} stdout
 * @returns {string | null}
 */
export function accountTokenFrom(stdout) {
  const raw = String(stdout ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let status
  try {
    status = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!status || typeof status !== 'object' || Array.isArray(status) || status.loggedIn !== true) return null
  const account = text(status.accountUuid) ?? text(status.account?.uuid) ?? text(status.oauthAccount?.accountUuid)
  if (account) return token('account', account)
  // The seat: its organization and its email, both required. One without the other is unknown.
  const org = text(status.orgId) ?? text(status.organizationUuid) ?? text(status.organization?.uuid) ?? text(status.oauthAccount?.organizationUuid)
  const email = text(status.email) ?? text(status.oauthAccount?.emailAddress)
  return org && email ? token('seat', `${org}\n${email.toLowerCase()}`) : null
}

/** Did the signed in account change? The rule lives with the other limit rules. */
export { accountChanged }

/** The folder the limit watch reads an agent's transcript from, so its login from the same: the
 *  recipe's CLAUDE_CONFIG_DIR, else the one the watcher (and so the agent) runs under, else null. */
export function agentAccountDir(recipeDir, env = {}) {
  return text(recipeDir == null ? null : String(recipeDir)) ?? text(env?.CLAUDE_CONFIG_DIR == null ? null : String(env.CLAUDE_CONFIG_DIR))
}

/** The agent's login as it launched: CLAUDE_CONFIG_DIR exactly as its recipe recorded it (none when
 *  it had none: on macOS the folder picks the Keychain item), and no key or token from this process.
 *  @param {{ env?: Record<string, string | undefined>, configDir?: string | null }} input
 *  @returns {Record<string, string>} */
export function accountEnv({ env = {}, configDir = null }) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!LOGIN_ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string') out[key] = value
  }
  const dir = text(configDir)
  if (dir) out.CLAUDE_CONFIG_DIR = dir
  return out
}

/**
 * One status read of a config folder: its key (the resolved folder, '' for the default one; case
 * folded on Windows), the environment it launched with plus the usual `claude` install folders on
 * PATH, and home as its working folder (never inside a saved login: Windows looks for `claude` in
 * the working folder first).
 * @param {{ env?: Record<string, string | undefined>, home: string, configDir?: string | null, platform?: string }} input
 */
export function statusInput({ env = {}, home, configDir = null, platform = process.platform }) {
  const dir = text(configDir)
  const resolved = dir ? resolve(dir) : ''
  const cliEnv = accountEnv({ env, configDir: dir })
  // Windows spells the key `Path` and treats every spelling as one: keep the one a child would see.
  const pathKeys = platform === 'win32' ? Object.keys(cliEnv).filter((key) => key.toUpperCase() === 'PATH') : []
  const machinePath = platform === 'win32' ? cliEnv[pathKeys.includes('PATH') ? 'PATH' : pathKeys[0]] : cliEnv.PATH
  for (const key of pathKeys) delete cliEnv[key]
  cliEnv.PATH = [join(home, '.local', 'bin'), join(home, '.bun', 'bin'), machinePath].filter(Boolean).join(delimiter)
  return { key: platform === 'win32' ? resolved.toLowerCase() : resolved, env: cliEnv, cwd: home }
}

/** Every Windows process through the System32 powershell by its full path, or null. */
async function listWin32Rows(env, run) {
  const root = text(env?.SystemRoot ?? env?.SYSTEMROOT)
  if (!root) return null
  const powershell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const listing = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', WIN32_PROCESS_ROWS_SCRIPT], { env, timeoutMs: 5_000 })
  return listing.spawnError || listing.timedOut || listing.code !== 0 ? null : parseWin32ProcessRows(listing.stdout)
}

/**
 * End what the shim `pid` started (Windows), never the shim itself: the caller ends that through its
 * own process handle. Not `taskkill /T`: a process still names a parent that died, and Windows reuses
 * ids, so /T can follow a stale id to a process this call did not start. win32ShimTargets takes only
 * children born after their parent, through cmd.exe layers. Nothing is ended when the listing fails
 * or the root has exited since. Never throws.
 * @param {number} pid
 * @param {{ alive?: () => boolean, env?: Record<string, string | undefined>, run?: typeof spawnCollect,
 *   list?: () => Promise<any>, kill?: (target: number) => unknown }} [opts]
 * @returns {Promise<boolean>} true when the listing named the root and its children were ended
 */
export async function endStartedTree(pid, { alive = () => true, env = process.env, run = spawnCollect, list, kill = (target) => process.kill(target) } = {}) {
  let processes
  try {
    processes = await (list ? list() : listWin32Rows(env, run))
  } catch {
    return false
  }
  if (!Array.isArray(processes) || !processes.some((p) => p.pid === pid) || !alive()) return false
  for (const target of win32ShimTargets(processes, pid)) {
    try {
      kill(target)
    } catch {
      // Already gone.
    }
  }
  return true
}

/**
 * One CLI run with execFile's answers (a non zero exit or a timeout rejects with `code`, `stdout`),
 * through the repo's collector. On a timeout on Windows what its shim started is ended too.
 * @param {string} file
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, timeout?: number, maxBuffer?: number,
 *   platform?: string, spawnImpl?: any, killTree?: (pid: number, state: { alive: () => boolean }) => Promise<unknown> }} [opts]
 */
export async function boundedExec(file, args, { env, cwd, timeout = ACCOUNT_READ_TIMEOUT_MS, maxBuffer = 16 * 1024, platform = process.platform, spawnImpl, killTree = (pid, state) => endStartedTree(pid, { ...state, env }) } = {}) {
  const run = await spawnCollect(file, args, {
    env, cwd, timeoutMs: timeout, ...(spawnImpl ? { spawnImpl } : {}),
    ...(platform === 'win32' ? { killTree } : {}),
  })
  if (run.spawnError) throw run.spawnError
  if (run.timedOut) throw Object.assign(new Error(`${file} timed out`), { code: 'ETIMEDOUT', killed: true, stdout: run.stdout })
  if (run.stdout.length > maxBuffer) throw Object.assign(new Error(`${file} said too much`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '' })
  if (run.code !== 0) throw Object.assign(new Error(`${file} exited ${run.code}`), { code: run.code, signal: run.signal, stdout: run.stdout })
  return { stdout: run.stdout, stderr: run.stderr }
}

/**
 * One status read per config folder a minute, whatever path asks, failures included; never two at
 * once for one folder. `read(input)` answers a { read, signedIn, account } value (a failed read is
 * { read: false }); every answer carries `readAt`, when its read started. `read(input, { after })`
 * answers only from a read started at or after that time: it joins one, waits out an older one still
 * running and then starts one, so a folder never has two at once.
 * @param {{ read: (input: { key: string, env: Record<string, string>, cwd: string }) => Promise<any>,
 *   now?: () => number, everyMs?: number }} input
 */
export function createStatusReader({ read, now = Date.now, everyMs = ACCOUNT_READ_EVERY_MS }) {
  const kept = new Map()
  const lastAnswer = new Map()
  const answered = createReadLog()
  const start = (input) => {
    const at = now()
    const entry = { at, done: false, value: null, promise: null }
    // Started now (not on a later tick), so two looks in one sweep can never start two reads.
    let running
    try {
      running = Promise.resolve(read(input))
    } catch (error) {
      running = Promise.reject(error)
    }
    entry.promise = running
      .then(
        (v) => (v && typeof v === 'object' && v.read === true
          ? { read: true, signedIn: v.signedIn === true, account: typeof v.account === 'string' ? v.account : null, readAt: at }
          : { read: false, signedIn: false, account: null, readAt: at }),
        () => ({ read: false, signedIn: false, account: null, readAt: at }),
      )
      .then((value) => {
        entry.done = true
        entry.value = value
        lastAnswer.set(input.key, value)
        if (value.read) answered.note(input.key, value.readAt, value.signedIn ? value.account : null, now())
        return value
      })
    kept.set(input.key, entry)
    return entry
  }
  // A read still running is never doubled, however old; a finished one stands for its minute.
  const current = (input) => {
    const entry = kept.get(input.key)
    if (entry && (!entry.done || (now() - entry.at >= 0 && now() - entry.at < everyMs))) return entry
    return null
  }
  const readSince = async (input, after) => {
    for (;;) {
      const entry = kept.get(input.key)
      if (entry && !entry.done) {
        if (entry.at >= after && now() - entry.at >= 0) return entry.promise
        await entry.promise
        continue
      }
      const standing = current(input)
      if (standing && standing.at >= after) return standing.value
      return start(input).promise
    }
  }
  // The background reads (keepFresh) wait their turn in one lane, ACCOUNT_KEEP_AT_ONCE wide.
  const keepQueue = new Map()
  let keeping = 0
  const keepDue = (key) => {
    const last = kept.get(key)
    return !(last && (!last.done || (now() - last.at >= 0 && now() - last.at < ACCOUNT_KEEP_EVERY_MS)))
  }
  const pumpKeep = () => {
    for (const [key, input] of keepQueue) {
      if (keeping >= ACCOUNT_KEEP_AT_ONCE) return
      keepQueue.delete(key)
      if (!keepDue(key)) continue
      keeping++
      start(input).promise.then(() => {
        keeping--
        pumpKeep()
      })
    }
  }
  return {
    read: (input, { after } = {}) => (Number.isFinite(after) ? readSince(input, after) : (current(input) ?? start(input)).promise),
    /** Never blocks: the answer of a read started in the last minute; while a newer one runs, the last
     *  one to answer if it is under ACCOUNT_LAST_READ_KEEPS_MS old; else null. */
    peek: (input) => {
      const entry = current(input) ?? start(input)
      if (entry.done) return entry.value
      const last = lastAnswer.get(input.key)
      return last && now() - last.readAt >= 0 && now() - last.readAt < ACCOUNT_LAST_READ_KEEPS_MS ? last : null
    },
    /** The last read that answered before `atMs`, at most ten minutes before it, or null. */
    before: (input, atMs) => answered.before(input.key, atMs),
    /** The first answered read started since `atMs`, within five minutes of it, or null. */
    after: (input, atMs) => answered.after(input.key, atMs),
    /** The read log itself, for the switcher (lib/helper-accounts.mjs), keyed by statusInput's key. */
    log: answered,
    /** Never waits: queues a read only when the last one is ACCOUNT_KEEP_EVERY_MS old, so the next limit
     *  has a read from before it to compare with. */
    keepFresh: (input) => {
      if (!keepDue(input.key)) return
      keepQueue.set(input.key, input)
      pumpKeep()
    },
  }
}

/** The limit watch's synchronous view of a reader: never blocks, never throws. */
/** @param {{ peek: (input: any) => any, before?: (input: any, atMs: number) => any, after?: (input: any, atMs: number) => any, keepFresh?: (input: any) => void }} reader */
export function peekAccount(reader) {
  /** @param {{ env?: Record<string, string | undefined>, home: string, configDir?: string | null, platform?: string }} input
   *  @returns {{ ok: true, token: string, readAt: number } | { ok: false, why: string }} */
  const inputOf = ({ env = {}, home, configDir = null, platform = process.platform }) => statusInput({ env, home, configDir, platform })
  const peek = (/** @type {any} */ asked) => {
    let value
    try {
      value = reader.peek(inputOf(asked))
    } catch {
      return { ok: false, why: 'failed' }
    }
    if (!value) return { ok: false, why: 'pending' }
    if (!value.read) return { ok: false, why: 'failed' }
    if (!value.signedIn) return { ok: false, why: 'signed_out' }
    return value.account ? { ok: true, token: value.account, readAt: value.readAt } : { ok: false, why: 'no_account' }
  }
  return Object.assign(peek, {
    /** @param {any} asked @param {number} atMs */
    before: (asked, atMs) => reader.before?.(inputOf(asked), atMs) ?? null,
    /** @param {any} asked */
    keepFresh: (asked) => reader.keepFresh?.(inputOf(asked)),
  }, typeof reader.after === 'function' ? {
    /** The first read since a limit, from the reader's log. @param {any} asked @param {number} atMs */
    after: (asked, atMs) => reader.after?.(inputOf(asked), atMs) ?? null,
  } : {})
}
