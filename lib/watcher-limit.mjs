/**
 * watcher-limit: the watcher frees an agent stuck on Claude Code's usage limit screen, the moment
 * usage is available again, and tells the owner (Kc 2026-11-01, chat 4465 msg 180081;
 * docs/notes/feat/watcher-frees-limit-stuck.md).
 *
 * Ares, 2026-11-01: the weekly limit at 16:39:03Z opened the CLI's rate limit options picker; Kc
 * switched the Claude account at 16:53Z, but the picker held 29 queued messages until a person
 * pressed Enter at 20:02Z. This pass would have pressed it at the first sweep after 16:53Z.
 *
 * After every keep-alive sweep (the switch ON, for the agents it cleared), and from the checkup's
 * `free_limit` step, per agent:
 *   1. the transcript tail ends in a `rate_limit` record (lib/watcher-checkup.mjs parseTranscriptTail);
 *   2. usage is back, by proof (lib/limit-screen.mjs usageBackFrom): the reset time passed, or the
 *      Claude credential file's mtime moved after the limit (stat only; it is never opened). Option A
 *      (Ares, 2026-11-02): once a press on the login proof met the limit again, only the reset time
 *      counts for that agent, until it passes or a real turn ends the episode (loginProofOff);
 *   3. no Enter on this agent in the last hour: the later of ~/.bgos-agent/watcher/limit-watch.json
 *      and the agent's own copy ~/.bgos-agent/<id>/limit-enter.json counts, and a record that cannot
 *      be read counts as an Enter at the moment that was seen (the bad copy is kept as <file>.lost);
 *   4. a key path here (lib/limit-keys.mjs: tmux, or the Windows console helper; on Windows only the
 *      console of a hoai launcher proven by the process table read now, never a daemon declared record);
 *   5. the screen, READ now, is the limit picker with its only pointer on "Stop and wait for limit
 *      to reset" (readLimitScreen);
 * then the Enter is recorded on disk in both, each written whole (temp file, then rename) and read
 * back, and only then ONE Enter is sent, on the screen read again
 * and unchanged. Verify: a real turn after the Enter (freed), a new limit record (still limited),
 * or the picker gone with nothing waiting (closed). The owner is told through the agent's daemon:
 * ~/.bgos-agent/<id>/limit-notice.json carries tokens and times only, and the daemon builds the
 * words from fixed templates (lib/limit-notice.ts).
 *
 * Never a second key, never text, never a restart: C9 still blocks restarts (lib/agent-checkup.mjs).
 */

import { claudeConfigDir } from '../bin/bgos-install-method.mjs'
import { SUPERVISOR_FILE_NAME, isSupervisorWriter, joinDir, listAgents, parseSupervisorRecord, readLauncherProcesses } from './agent-inventory.mjs'
import { limitKeyPath, pressEnterOnce, readAgentScreen } from './limit-keys.mjs'
import {
  LIMIT_ENTER_MIN_INTERVAL_MS,
  LIMIT_NOTICE_FILE_NAME,
  NOTICE_SCHEMA_VERSION,
  RESET_GRACE_MS,
  UNSAFE_DIALOG_REASONS,
  decideLimitFree,
  noticeWhyForScreen,
  readLimitScreen,
  usageBackFrom,
} from './limit-screen.mjs'
import { AGENT_STATE_FILE_NAME, parseAgentState } from './keepalive-plan.mjs'
import { defaultExecSync } from './service-supervision.mjs'
import { watcherHome } from './watcher-bundle.mjs'
import { USAGE_LIMIT_FRESH_MS, parseTranscriptTail, readTail } from './watcher-checkup.mjs'
import { transcriptPathFor } from './watcher-keepalive.mjs'

export const LIMIT_WATCH_FILE_NAME = 'limit-watch.json'
export const LIMIT_ENTER_FILE_NAME = 'limit-enter.json'
export { LIMIT_NOTICE_FILE_NAME }
/** How long a sweep watches for the agent to come back after its Enter. */
export const LIMIT_VERIFY_MS = 120_000
export const LIMIT_POLL_MS = 5_000
const WATCH_SCHEMA_VERSION = 1
const ENTER_SCHEMA_VERSION = 1
const NOTIFIED_KEEP = 8

const iso = (ms) => new Date(ms).toISOString()
const isoMs = (value) => {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

export function limitWatchPath(home) {
  return joinDir(watcherHome(home), LIMIT_WATCH_FILE_NAME)
}

/** The agent's own copy of its last Enter, a second witness beside the notice. */
export function limitEnterPath(row) {
  return joinDir(row.stateDir, LIMIT_ENTER_FILE_NAME)
}

const latest = (...values) => {
  const known = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  return known.length ? Math.max(...known) : null
}
const isRecordObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Write a file whole: a temp file beside it, then a rename over it. A crash leaves the old or the new, never half. */
function writeWhole(fs, path, text) {
  const tmp = `${path}.tmp`
  fs.writeFile(tmp, text)
  fs.rename(tmp, path)
}

/** The file's text, or why there is none: missing (no file) or unreadable (there, but it reads as nothing). */
function readRaw(fs, path) {
  try {
    const raw = fs.readFile(path)
    // The real fs reads ANY error as null (lib/watcher-bundle.mjs nodeFs): a file that is there but
    // reads as null is unreadable, never "missing", or a locked record would read as "never pressed".
    if (raw == null) return { raw: null, unreadable: fs.exists?.(path) === true }
    return { raw, unreadable: false }
  } catch {
    return { raw: null, unreadable: true }
  }
}

/**
 * The watcher's record of every Enter, as it is on disk:
 *   ok          a record
 *   missing     no file: never written, or gone (the agent's copy then holds the hour)
 *   lost        a file that is not a record (torn, empty, the wrong shape): set aside, the hour held
 *   unreadable  a file that is there but cannot be read (on Windows often a short lock): the key is
 *               held while it lasts, and the file is left as it is
 */
function readWatch(home, fs) {
  const { raw, unreadable } = readRaw(fs, limitWatchPath(home))
  if (unreadable) return { state: 'unreadable', file: null }
  if (raw == null) return { state: 'missing', file: { schemaVersion: WATCH_SCHEMA_VERSION, agents: {} } }
  try {
    const parsed = JSON.parse(raw)
    if (isRecordObject(parsed) && isRecordObject(parsed.agents)) return { state: 'ok', file: parsed }
  } catch {
    // not a record
  }
  return { state: 'lost', file: null }
}

/** The agent's copy: { lastEnterAt } after an Enter, { lostAt } after an unreadable copy was set aside. */
function readEnterCopy(row, fs) {
  const { raw, unreadable } = readRaw(fs, limitEnterPath(row))
  if (unreadable) return { state: 'unreadable', heldSinceMs: null }
  if (raw == null) return { state: 'missing', heldSinceMs: null }
  try {
    const parsed = JSON.parse(raw)
    const heldSinceMs = isRecordObject(parsed) ? latest(isoMs(parsed.lastEnterAt), isoMs(parsed.lostAt)) : null
    if (heldSinceMs !== null) return { state: 'ok', heldSinceMs, lastEnterAtMs: isoMs(parsed.lastEnterAt) }
  } catch {
    // not a record
  }
  return { state: 'lost', heldSinceMs: null }
}

/** Never paper over a record that cannot be read with one agent's: only a record or no file is written. */
function writeWatchRecord(home, fs, id, record) {
  const watch = readWatch(home, fs)
  if (watch.state !== 'ok' && watch.state !== 'missing') return false
  const file = { ...watch.file, schemaVersion: WATCH_SCHEMA_VERSION, agents: { ...watch.file.agents, [id]: record } }
  fs.mkdir?.(watcherHome(home))
  writeWhole(fs, limitWatchPath(home), `${JSON.stringify(file, null, 2)}\n`)
  return true
}

/**
 * A record that cannot be read may have held an Enter from a minute ago. Keep the bad copy aside for a
 * person (<file>.lost), start the file over, and count the moment the loss was seen as an Enter: no
 * key for the next hour (on every agent, when it is the watcher's file), then the gate works again.
 */
function setLostRecordsAside(ctx, row, seen) {
  const { home, fs, now, log } = ctx
  const lostAt = iso(now())
  const aside = (path, fresh) => {
    // Copy, then write the fresh file over the bad one: a failure anywhere leaves the bad file in
    // place, and it keeps holding the key.
    let kept = true
    try {
      fs.copyFile(path, `${path}.lost`)
    } catch {
      kept = false
    }
    writeWhole(fs, path, `${JSON.stringify(fresh, null, 2)}\n`)
    log?.(`limit-watch ${row.assistantId}: the Enter record ${path} could not be read; ${kept ? `kept as ${path}.lost` : 'no copy could be kept'}, no Enter for an hour`)
  }
  if (seen.watchState === 'lost') {
    fs.mkdir?.(watcherHome(home))
    aside(limitWatchPath(home), { schemaVersion: WATCH_SCHEMA_VERSION, lostAt, agents: {} })
  }
  if (seen.copyState === 'lost') aside(limitEnterPath(row), { schemaVersion: ENTER_SCHEMA_VERSION, lostAt })
}

/**
 * Spend the Enter on disk BEFORE the key, in both records, each written whole and read back. False
 * when either did not land as written: then no key.
 */
function spendEnter(ctx, row, record) {
  const { home, fs } = ctx
  const id = row.assistantId
  try {
    if (!writeWatchRecord(home, fs, id, record)) return false
    writeWhole(fs, limitEnterPath(row), `${JSON.stringify({ schemaVersion: ENTER_SCHEMA_VERSION, lastEnterAt: record.lastEnterAt })}\n`)
  } catch {
    return false
  }
  const watch = readWatch(home, fs)
  const copy = readEnterCopy(row, fs)
  return watch.state === 'ok' && watch.file.agents[id]?.lastEnterAt === record.lastEnterAt && copy.state === 'ok' && copy.lastEnterAtMs === isoMs(record.lastEnterAt)
}

/**
 * Windows: the console the helper attaches to must be the hoai launcher's, and that is PROVEN, never
 * assumed. The row's launcherLive, never a record the agent's daemon declares for itself (its pid is
 * the daemon, whose console is not the agent's), a start stamp in the record, and the process table
 * read NOW for that one pid (the row may be minutes old): an entry must be there, dated, started no
 * later than the stamp, and, when its command line is readable, running hoai-core.mjs
 * (isSupervisorWriter). An unreadable table proves nothing here, as in lib/agent-windows.mjs. Reads
 * process identity only; lib/limit-keys.mjs, which presses, is unchanged.
 */
function provenConsole(row, ctx, keyPath) {
  if (!keyPath.ok || keyPath.kind !== 'console') return keyPath
  const refuse = { ok: false, reason: 'no_console' }
  if (row.launcherLive !== true) return refuse
  const record = parseSupervisorRecord(ctx.fs.readFile(joinDir(row.stateDir, SUPERVISOR_FILE_NAME)))
  if (!record || record.declaredLauncher || record.pid !== keyPath.consolePid || record.startedAtMs === null) return refuse
  const table = readLauncherProcesses({ platform: ctx.platform, pids: [record.pid], execSync: ctx.execSync ?? defaultExecSync, now: ctx.now() })
  const proc = table.get(record.pid) ?? null
  if (!proc || proc.startedAtMs === null || !isSupervisorWriter(record, proc)) return refuse
  return keyPath
}

/**
 * What this agent's limit looks like now: the limit record, whether usage is back, the key path,
 * the hour gate. Reads the transcript tail and stats the credential file; touches nothing.
 */
export function observeLimit(row, ctx) {
  const { home, env, platform, fs, now } = ctx
  const at = now()
  const configDir = String(row.recipe?.claudeConfigDir ?? '').trim() || claudeConfigDir({ env, home })
  const agentState = row.pluginStateDir ? parseAgentState(fs.readFile(joinDir(row.pluginStateDir, AGENT_STATE_FILE_NAME)), row.assistantId) : null
  const sessionId = agentState?.sessionId || row.sessionId || null
  const transcriptPath = sessionId && row.cwd ? transcriptPathFor({ configDir, cwd: row.cwd, sessionId }) : null
  const tail = transcriptPath ? parseTranscriptTail(readTail(fs, transcriptPath), at) : null
  const error = tail?.error?.kind === 'rate_limit' ? tail.error : null
  const limit = error ? { atMs: error.atMs, resetsAtMs: error.resetsAtMs ?? null } : null
  // macOS keeps the login in the Keychain: a credential file there is not the agent's login.
  const credentialsMtimeMs = platform === 'darwin' ? null : fs.stat(joinDir(configDir, '.credentials.json'))?.mtimeMs ?? null
  const watch = readWatch(home, fs)
  const copy = readEnterCopy(row, fs)
  const record = watch.file?.agents?.[row.assistantId] ?? null
  // Option A (Ares, 2026-11-02): a press on the login proof that met the limit again spends that
  // proof for this agent, until the reset passes or a real turn after the miss ends the episode.
  const off = isRecordObject(record?.loginProofOff) ? record.loginProofOff : null
  const offUntilMs = isoMs(off?.until)
  const offSinceMs = isoMs(off?.since)
  const realTurnAtMs = typeof tail?.lastActivityAtMs === 'number' ? tail.lastActivityAtMs : null
  const loginProofEnded =
    off !== null && ((offUntilMs !== null && at - offUntilMs >= RESET_GRACE_MS) || (offSinceMs !== null && realTurnAtMs !== null && realTurnAtMs > offSinceMs))
  // A miss seen after the verify: the last Enter was on the login proof, and Claude refused again
  // soon after it with no real turn in between (the press closed the picker; the next message failed).
  // Soon: inside the shortest usage window (a session limit) and before that limit's reset. A later
  // refusal is a new limit, and once the current reset passed there is nothing left to wait for.
  const lastEnterMs = isoMs(record?.lastEnterAt)
  const lastEnterResetsMs = isoMs(record?.lastEnterResetsAt)
  const missWindowEndMs = lastEnterMs === null ? null : Math.min(lastEnterMs + USAGE_LIMIT_FRESH_MS, lastEnterResetsMs ?? Number.POSITIVE_INFINITY)
  const resetPassed = limit !== null && limit.resetsAtMs !== null && at - limit.resetsAtMs >= RESET_GRACE_MS
  const loginProofMissedLater =
    off === null &&
    record?.lastEnterHow === 'login_changed' &&
    limit !== null &&
    !resetPassed &&
    lastEnterMs !== null &&
    limit.atMs >= lastEnterMs &&
    limit.atMs < missWindowEndMs &&
    !(realTurnAtMs !== null && realTurnAtMs >= lastEnterMs)
  const loginProofSpent = (off !== null && !loginProofEnded) || loginProofMissedLater
  const usage = usageBackFrom({ now: at, limit, credentialsMtimeMs, loginProofSpent })
  const anyKeyPath = limitKeyPath({ platform, row, home, fs, pidAlive: ctx.pidAlive, tmuxPath: ctx.tmuxPath ?? null, helperDir: ctx.helperDir ?? null })
  // The later of the two records counts; a record that cannot be read counts as an Enter just now.
  const lost = [watch.state, copy.state].some((state) => state === 'lost' || state === 'unreadable')
  const lastEnterAtMs = latest(isoMs(record?.lastEnterAt), isoMs(watch.file?.lostAt), copy.heldSinceMs, lost ? at : null)
  // The Windows proof reads the process table, so it runs only when a key could go out now: usage is
  // back and the hour gate is open (decideLimitFree checks both before any screen is read).
  const gateOpen = lastEnterAtMs === null || at - lastEnterAtMs >= LIMIT_ENTER_MIN_INTERVAL_MS
  const keyPath = usage.back && gateOpen ? provenConsole(row, ctx, anyKeyPath) : anyKeyPath
  const consoleProven = keyPath.ok === true && keyPath.kind === 'console' && usage.back && gateOpen
  return { atMs: at, transcriptPath, limit, usage, keyPath, consoleProven, record, watchState: watch.state, copyState: copy.state, lastEnterAtMs, loginProofEnded, loginProofMissedLater }
}

/**
 * observeLimit, after setting aside a record that cannot be read, so its hour starts once, now, on
 * either path (the checkup's planner holds the key on a lost record and never reaches freeLimitFor).
 * If even that write fails, the lost reading stands: it holds the key.
 */
function observeSettled(row, ctx) {
  const seen = observeLimit(row, ctx)
  if (seen.watchState !== 'lost' && seen.copyState !== 'lost') return seen
  try {
    setLostRecordsAside(ctx, row, seen)
  } catch (err) {
    ctx.log?.(`limit-watch ${row.assistantId}: could not set the unreadable Enter record aside: ${String(err?.message ?? err).slice(0, 200)}`)
    return seen
  }
  return observeLimit(row, ctx)
}

/** The checkup observation's `limitFree` (lib/agent-checkup.mjs), or null when there is no limit. */
export function limitFreeObservation(row, ctx) {
  const seen = observeSettled(row, ctx)
  if (!seen.limit) return null
  return {
    usageBack: seen.usage.back,
    how: seen.usage.how,
    keyPath: seen.keyPath.ok ? { ok: true, reason: seen.keyPath.kind } : { ok: false, reason: seen.keyPath.reason },
    lastEnterAtMs: seen.lastEnterAtMs,
  }
}

/** Write the owner notice for the daemon, once per key (the watch record remembers the last few). */
function notifyOnce(ctx, row, record, notice) {
  const { home, fs, log } = ctx
  const notified = Array.isArray(record.notified) ? record.notified : []
  if (notified.includes(notice.key)) return record
  // Whole or nothing: the daemon drops a file it cannot parse, so it never sees half of one.
  writeWhole(fs, joinDir(row.stateDir, LIMIT_NOTICE_FILE_NAME), `${JSON.stringify({ schemaVersion: NOTICE_SCHEMA_VERSION, ...notice })}\n`)
  const next = { ...record, notified: [...notified, notice.key].slice(-NOTIFIED_KEEP) }
  writeWatchRecord(home, fs, row.assistantId, next)
  log?.(`limit-watch ${row.assistantId}: owner told (${notice.outcome}${notice.why ? `:${notice.why}` : ''})`)
  return next
}

function noticeFor(row, limit, how, outcome, extra = {}) {
  const limitAt = iso(limit.atMs)
  const resetsAt = limit.resetsAtMs !== null ? iso(limit.resetsAtMs) : null
  const why = extra.why ?? null
  // Still limited is told once per reset time, not once per Enter: a token refresh that moves the
  // credential file again must not repeat it every hour.
  const key = outcome === 'still_limited' ? `${row.assistantId}:${resetsAt ?? limitAt}:still_limited` : `${row.assistantId}:${limitAt}:${outcome}${why ? `:${why}` : ''}`
  return { key, outcome, how, why, limitAt, resetsAt, pressedAt: extra.pressedAt ?? null }
}

/**
 * Free ONE agent if, and only if, every gate says so. Returns the outcome:
 *   none | limited | waiting | cannot_press | no_picker | not_pressed | freed | closed | still_limited | not_taken
 * @param {Record<string, any>} row an agent row (lib/agent-inventory.mjs listAgents)
 * @param {Record<string, any>} ctx
 * @param {{ deadlineAt?: number }} [opts] the checkup bounds the verify by its own deadline
 */
export async function freeLimitFor(row, ctx, opts = {}) {
  const { exec, now, sleep, log } = ctx
  const id = row.assistantId
  const seen = observeSettled(row, ctx)
  let record = seen.record ?? {}
  if (seen.loginProofEnded) {
    // The episode is over: forget the spent proof, and the proof the last Enter was on.
    const { loginProofOff: _ended, lastEnterHow: _how, lastEnterResetsAt: _resets, ...rest } = record
    record = rest
    writeWatchRecord(ctx.home, ctx.fs, id, record)
    log?.(`limit-watch ${id}: the reset passed or it worked again; a login change counts as proof again`)
  }
  if (seen.loginProofMissedLater) {
    // Option A, the miss seen late: from this refusal on, only the reset time counts. Told once.
    record = { ...record, loginProofOff: { since: iso(seen.limit.atMs), until: seen.limit.resetsAtMs !== null ? iso(seen.limit.resetsAtMs) : null } }
    writeWatchRecord(ctx.home, ctx.fs, id, record)
    log?.(`limit-watch ${id}: Claude refused again after the Enter on the login change; only the reset time counts now (${record.loginProofOff.until ?? 'not known'})`)
    record = notifyOnce(ctx, row, record, noticeFor(row, { atMs: isoMs(record.limitAt) ?? seen.limit.atMs, resetsAtMs: seen.limit.resetsAtMs }, 'login_changed', 'still_limited', { pressedAt: record.lastEnterAt ?? null }))
  }
  // Decided at the observation's own time: the Windows proof ran for exactly that gate (observeLimit).
  const gate = (screen) => decideLimitFree({ now: seen.atMs, limit: seen.limit, usage: seen.usage, lastEnterAtMs: seen.lastEnterAtMs, keyPath: seen.keyPath, screen })

  const first = gate(undefined)
  if (first.act === 'none') return { outcome: 'none' }
  if (first.act === 'report' && first.reason === 'still_limited') return { outcome: 'limited' }
  if (first.act === 'wait') return { outcome: 'waiting', retryAtMs: first.retryAtMs }
  const how = seen.usage.how
  if (first.act === 'report') {
    const why = seen.keyPath.reason === 'no_tmux' || seen.keyPath.reason === 'no_console' ? seen.keyPath.reason : 'unsupported'
    notifyOnce(ctx, row, record, noticeFor(row, seen.limit, how, 'cannot_press', { why }))
    return { outcome: 'cannot_press', reason: why }
  }

  // A console is never read unless this observation proved it (belt and braces for the gate above).
  if (seen.keyPath.kind === 'console' && !seen.consoleProven) {
    log?.(`limit-watch ${id}: the console was not proven in this look; nothing read or pressed`)
    return { outcome: 'not_pressed', reason: 'console_unproven' }
  }
  // Usage is back and nothing has been read yet: read the screen.
  const screen = await readAgentScreen(seen.keyPath, { exec })
  if (!screen.ok) {
    notifyOnce(ctx, row, record, noticeFor(row, seen.limit, how, 'cannot_press', { why: screen.why }))
    return { outcome: 'cannot_press', reason: screen.why }
  }
  const read = readLimitScreen(screen.text)
  const decided = gate(read)
  if (decided.act !== 'press') {
    if (UNSAFE_DIALOG_REASONS.includes(read.reason)) {
      // The picker is up but the pointer is not on the safe choice: no key, the owner is told.
      notifyOnce(ctx, row, record, noticeFor(row, seen.limit, how, 'cannot_press', { why: noticeWhyForScreen(read.reason) }))
      return { outcome: 'cannot_press', reason: read.reason }
    }
    // Not the picker (an idle prompt, the auto continue line): nothing is stuck on a key.
    log?.(`limit-watch ${id}: usage is back (${how}) but the limit screen is not up (${read.reason}); nothing pressed`)
    return { outcome: 'no_picker', reason: read.reason }
  }

  // The Enter is spent on disk BEFORE the key: a watcher killed after this line never presses twice,
  // and a record that did not land never allows the key.
  const pressedAtMs = now()
  const lastEnterResetsAt = seen.limit.resetsAtMs !== null ? iso(seen.limit.resetsAtMs) : null
  record = { ...record, lastEnterAt: iso(pressedAtMs), lastEnterHow: how, lastEnterResetsAt, limitAt: iso(seen.limit.atMs) }
  if (!spendEnter(ctx, row, record)) {
    log?.(`limit-watch ${id}: the Enter could not be recorded on disk; no key`)
    return { outcome: 'not_pressed', reason: 'record_unsaved' }
  }
  const press = await pressEnterOnce(seen.keyPath, screen, { exec })
  if (!press.sent) {
    // A helper cut off by its timeout may have delivered the key before it was stopped.
    const said =
      press.why === 'helper_timed_out' || press.why === 'inject_failed' ? `the Enter could not be confirmed sent (${press.why})` : `Enter NOT sent (${press.why})`
    log?.(`limit-watch ${id}: ${said}; the next try is an hour away`)
    return { outcome: 'not_pressed', reason: press.why }
  }
  log?.(`limit-watch ${id}: pressed Enter once on the limit screen (usage back: ${how})`)

  // Verify: a real turn after the Enter, or Claude refusing again.
  const until = Math.min(pressedAtMs + (ctx.verifyMs ?? LIMIT_VERIFY_MS), opts.deadlineAt ?? Number.POSITIVE_INFINITY)
  let outcome = null
  let answeredAtMs = null
  // The reset Claude gives with a new refusal is the time the watcher waits for next.
  let refusedResetsAtMs = seen.limit.resetsAtMs
  let refusedAtMs = null
  while (outcome === null && now() < until) {
    await sleep(Math.max(0, Math.min(LIMIT_POLL_MS, until - now())))
    try {
      await ctx.keepOnline?.()
    } catch {
      // staying online is best effort
    }
    const tail = seen.transcriptPath ? parseTranscriptTail(readTail(ctx.fs, seen.transcriptPath), now()) : null
    if (tail?.error?.kind === 'rate_limit' && tail.error.atMs >= pressedAtMs) {
      outcome = 'still_limited'
      refusedAtMs = tail.error.atMs
      // Never a reset that already passed: that is not a time the watcher can wait for.
      const earlier = seen.limit.resetsAtMs !== null && seen.limit.resetsAtMs > now() ? seen.limit.resetsAtMs : null
      refusedResetsAtMs = tail.error.resetsAtMs ?? earlier
    } else if (typeof tail?.lastActivityAtMs === 'number' && tail.lastActivityAtMs >= pressedAtMs) {
      outcome = 'freed'
      answeredAtMs = tail.lastActivityAtMs
    }
  }
  if (outcome === null) {
    // No turn yet: is the picker gone (nothing was waiting) or still up (the Enter did not take)?
    const after = await readAgentScreen(seen.keyPath, { exec })
    const still = after.ok ? readLimitScreen(after.text) : null
    const pickerUp = still !== null && !['empty', 'no_limit_line', 'no_picker'].includes(still.reason)
    outcome = !after.ok ? 'not_taken' : pickerUp ? 'not_taken' : 'closed'
  }
  log?.(`limit-watch ${id}: ${outcome}`)
  // The key went out: a write failing now must never turn that into an error (the report must say an
  // Enter was pressed), and is never silent. A lost option A write is found again on the next look
  // (loginProofMissedLater) only when no real turn came between the press and the refusal.
  const afterKey = (what, write) => {
    try {
      if (write() === false) log?.(`limit-watch ${id}: the Enter went out, but ${what} could not be written (the record could not be read)`)
    } catch (err) {
      log?.(`limit-watch ${id}: the Enter went out, but ${what} could not be written: ${String(err?.message ?? err).slice(0, 200)}`)
    }
  }
  if (outcome === 'freed') {
    // It works again: the proof this Enter was on can never be blamed for a later limit.
    const { lastEnterHow: _how, lastEnterResetsAt: _resets, ...rest } = record
    record = rest
    afterKey('the record', () => writeWatchRecord(ctx.home, ctx.fs, id, record))
  }
  if (outcome === 'still_limited' && how === 'login_changed') {
    // Option A: this login change was not proof. Only the reset time counts now, for this agent.
    // Counted from the refusal, not the press: a turn the drained queue got just before it is not the end.
    record = { ...record, loginProofOff: { since: iso(refusedAtMs ?? pressedAtMs), until: refusedResetsAtMs !== null ? iso(refusedResetsAtMs) : null } }
    afterKey('the spent login proof', () => writeWatchRecord(ctx.home, ctx.fs, id, record))
    log?.(`limit-watch ${id}: the login change did not lift the limit; only the reset time counts now (${record.loginProofOff.until ?? 'not known'})`)
  }
  const told = outcome === 'still_limited' ? { atMs: seen.limit.atMs, resetsAtMs: refusedResetsAtMs } : seen.limit
  afterKey('the owner notice', () => notifyOnce(ctx, row, record, noticeFor(row, told, how, outcome, { pressedAt: iso(pressedAtMs) })))
  return { outcome, how, pressedAtMs, ...(answeredAtMs !== null ? { answeredAtMs } : {}) }
}

/**
 * The sweep's pass: every agent the keep-alive switch cleared, in id order. Never throws.
 * @param {Record<string, any>} ctx { home, env, platform, fs, exec, execSync?, now, sleep, log?,
 *   pidAlive, uid, assistantIds, tmuxPath, helperDir, keepOnline?, verifyMs? }
 */
export async function runLimitPass(ctx) {
  const ids = new Set((Array.isArray(ctx.assistantIds) ? ctx.assistantIds : []).map((id) => String(id)))
  if (ids.size === 0) return { agents: [] }
  let rows
  try {
    rows = listAgents({
      home: ctx.home,
      env: ctx.env,
      platform: ctx.platform,
      fs: ctx.fs,
      pidAlive: ctx.pidAlive,
      execSync: ctx.execSync ?? defaultExecSync,
      now: ctx.now(),
      uid: Number.isInteger(ctx.uid) ? ctx.uid : null,
    }).filter((row) => ids.has(row.assistantId))
  } catch (err) {
    ctx.log?.(`limit-watch: could not list agents: ${String(err?.message ?? err).slice(0, 200)}`)
    return { agents: [] }
  }
  const agents = []
  for (const row of rows) {
    try {
      agents.push({ id: row.assistantId, ...(await freeLimitFor(row, ctx)) })
    } catch (err) {
      ctx.log?.(`limit-watch ${row.assistantId}: failed: ${String(err?.message ?? err).slice(0, 200)}`)
      agents.push({ id: row.assistantId, outcome: 'error' })
    }
  }
  return { agents }
}
