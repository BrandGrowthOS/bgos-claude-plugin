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
 *      console of a proven hoai launcher, row.launcherLive and not a daemon declared record);
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
import { SUPERVISOR_FILE_NAME, joinDir, listAgents, parseSupervisorRecord } from './agent-inventory.mjs'
import { limitKeyPath, pressEnterOnce, readAgentScreen } from './limit-keys.mjs'
import {
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
import { parseTranscriptTail, readTail } from './watcher-checkup.mjs'
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

function readRaw(fs, path) {
  try {
    return { raw: fs.readFile(path), threw: false }
  } catch {
    return { raw: null, threw: true }
  }
}

/**
 * The watcher's record of every Enter, as it is on disk:
 *   ok       a record
 *   missing  no file: never written, or gone (the agent's copy then holds the hour)
 *   lost     a file that is not a record (torn, empty, the wrong shape) or cannot be read
 */
function readWatch(home, fs) {
  const { raw, threw } = readRaw(fs, limitWatchPath(home))
  if (!threw && raw == null) return { state: 'missing', file: { schemaVersion: WATCH_SCHEMA_VERSION, agents: {} } }
  try {
    const parsed = threw ? null : JSON.parse(raw)
    if (isRecordObject(parsed) && isRecordObject(parsed.agents)) return { state: 'ok', file: parsed }
  } catch {
    // not a record
  }
  return { state: 'lost', file: null }
}

/** The agent's copy: { lastEnterAt } after an Enter, { lostAt } after an unreadable copy was set aside. */
function readEnterCopy(row, fs) {
  const { raw, threw } = readRaw(fs, limitEnterPath(row))
  if (!threw && raw == null) return { state: 'missing', heldSinceMs: null }
  try {
    const parsed = threw ? null : JSON.parse(raw)
    const heldSinceMs = isRecordObject(parsed) ? latest(isoMs(parsed.lastEnterAt), isoMs(parsed.lostAt)) : null
    if (heldSinceMs !== null) return { state: 'ok', heldSinceMs, lastEnterAtMs: isoMs(parsed.lastEnterAt) }
  } catch {
    // not a record
  }
  return { state: 'lost', heldSinceMs: null }
}

/** Never paper over a record that cannot be read with one agent's: a lost file refuses the write. */
function writeWatchRecord(home, fs, id, record) {
  const watch = readWatch(home, fs)
  if (watch.state === 'lost') return false
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
    if (fs.exists(path)) fs.rename(path, `${path}.lost`)
    writeWhole(fs, path, `${JSON.stringify(fresh, null, 2)}\n`)
    log?.(`limit-watch ${row.assistantId}: the Enter record ${path} could not be read; kept as ${path}.lost, no Enter for an hour`)
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
 * Windows: the console the helper attaches to must be the hoai launcher's, proven the way the agent
 * window viewer proves it (lib/agent-windows.mjs): the row's launcherLive (the pid is alive AND still
 * the launcher that wrote supervisor.json, by the process table), and never the record the agent's
 * daemon declares for itself (its pid is the daemon, whose console is not the agent's). Reads
 * process identity only; lib/limit-keys.mjs, which presses, is unchanged.
 */
function provenConsole(row, fs, keyPath) {
  if (!keyPath.ok || keyPath.kind !== 'console') return keyPath
  if (row.launcherLive !== true) return { ok: false, reason: 'no_console' }
  const record = parseSupervisorRecord(fs.readFile(joinDir(row.stateDir, SUPERVISOR_FILE_NAME)))
  if (!record || record.declaredLauncher || record.pid !== keyPath.consolePid) return { ok: false, reason: 'no_console' }
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
  const loginProofSpent = off !== null && !loginProofEnded
  const usage = usageBackFrom({ now: at, limit, credentialsMtimeMs, loginProofSpent })
  const keyPath = provenConsole(row, fs, limitKeyPath({ platform, row, home, fs, pidAlive: ctx.pidAlive, tmuxPath: ctx.tmuxPath ?? null, helperDir: ctx.helperDir ?? null }))
  // The later of the two records counts; a record that cannot be read counts as an Enter just now.
  const lost = watch.state === 'lost' || copy.state === 'lost'
  const lastEnterAtMs = latest(isoMs(record?.lastEnterAt), isoMs(watch.file?.lostAt), copy.heldSinceMs, lost ? at : null)
  return { transcriptPath, limit, usage, keyPath, record, watchState: watch.state, copyState: copy.state, lastEnterAtMs, loginProofEnded }
}

/** The checkup observation's `limitFree` (lib/agent-checkup.mjs), or null when there is no limit. */
export function limitFreeObservation(row, ctx) {
  const seen = observeLimit(row, ctx)
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
  let seen = observeLimit(row, ctx)
  if (seen.watchState === 'lost' || seen.copyState === 'lost') {
    setLostRecordsAside(ctx, row, seen)
    seen = observeLimit(row, ctx)
  }
  let record = seen.record ?? {}
  if (seen.loginProofEnded) {
    const { loginProofOff: _ended, ...rest } = record
    record = rest
    writeWatchRecord(ctx.home, ctx.fs, id, record)
    log?.(`limit-watch ${id}: the reset passed or it worked again; a login change counts as proof again`)
  }
  const gate = (screen) => decideLimitFree({ now: now(), limit: seen.limit, usage: seen.usage, lastEnterAtMs: seen.lastEnterAtMs, keyPath: seen.keyPath, screen })

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
  record = { ...record, lastEnterAt: iso(pressedAtMs), limitAt: iso(seen.limit.atMs) }
  if (!spendEnter(ctx, row, record)) {
    log?.(`limit-watch ${id}: the Enter could not be recorded on disk; no key`)
    return { outcome: 'not_pressed', reason: 'record_unsaved' }
  }
  const press = await pressEnterOnce(seen.keyPath, screen, { exec })
  if (!press.sent) {
    log?.(`limit-watch ${id}: Enter NOT sent (${press.why}); the next try is an hour away`)
    return { outcome: 'not_pressed', reason: press.why }
  }
  log?.(`limit-watch ${id}: pressed Enter once on the limit screen (usage back: ${how})`)

  // Verify: a real turn after the Enter, or Claude refusing again.
  const until = Math.min(pressedAtMs + (ctx.verifyMs ?? LIMIT_VERIFY_MS), opts.deadlineAt ?? Number.POSITIVE_INFINITY)
  let outcome = null
  let answeredAtMs = null
  // The reset Claude gives with a new refusal is the time the watcher waits for next.
  let refusedResetsAtMs = seen.limit.resetsAtMs
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
      refusedResetsAtMs = tail.error.resetsAtMs ?? seen.limit.resetsAtMs
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
  if (outcome === 'still_limited' && how === 'login_changed') {
    // Option A: this login change was not proof. Only the reset time counts now, for this agent.
    record = { ...record, loginProofOff: { since: iso(pressedAtMs), until: refusedResetsAtMs !== null ? iso(refusedResetsAtMs) : null } }
    writeWatchRecord(ctx.home, ctx.fs, id, record)
    log?.(`limit-watch ${id}: the login change did not lift the limit; only the reset time counts now (${record.loginProofOff.until ?? 'not known'})`)
  }
  const told = outcome === 'still_limited' ? { atMs: seen.limit.atMs, resetsAtMs: refusedResetsAtMs } : seen.limit
  notifyOnce(ctx, row, record, noticeFor(row, told, how, outcome, { pressedAt: iso(pressedAtMs) }))
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
