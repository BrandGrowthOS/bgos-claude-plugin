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
 *      Claude credential file's mtime moved after the limit (stat only; it is never opened);
 *   3. no Enter on this agent in the last hour (~/.bgos-agent/watcher/limit-watch.json);
 *   4. a key path here (lib/limit-keys.mjs: tmux, or the Windows console helper);
 *   5. the screen, READ now, is the limit picker with its only pointer on "Stop and wait for limit
 *      to reset" (readLimitScreen);
 * then the Enter is recorded on disk, and only then ONE Enter is sent, on the screen read again
 * and unchanged. Verify: a real turn after the Enter (freed), a new limit record (still limited),
 * or the picker gone with nothing waiting (closed). The owner is told through the agent's daemon:
 * ~/.bgos-agent/<id>/limit-notice.json carries tokens and times only, and the daemon builds the
 * words from fixed templates (lib/limit-notice.ts).
 *
 * Never a second key, never text, never a restart: C9 still blocks restarts (lib/agent-checkup.mjs).
 */

import { claudeConfigDir } from '../bin/bgos-install-method.mjs'
import { joinDir, listAgents } from './agent-inventory.mjs'
import { limitKeyPath, pressEnterOnce, readAgentScreen } from './limit-keys.mjs'
import {
  LIMIT_NOTICE_FILE_NAME,
  NOTICE_SCHEMA_VERSION,
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
export { LIMIT_NOTICE_FILE_NAME }
/** How long a sweep watches for the agent to come back after its Enter. */
export const LIMIT_VERIFY_MS = 120_000
export const LIMIT_POLL_MS = 5_000
const WATCH_SCHEMA_VERSION = 1
const NOTIFIED_KEEP = 8

const iso = (ms) => new Date(ms).toISOString()
const isoMs = (value) => {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

export function limitWatchPath(home) {
  return joinDir(watcherHome(home), LIMIT_WATCH_FILE_NAME)
}

function readWatch(home, fs) {
  try {
    const parsed = JSON.parse(fs.readFile(limitWatchPath(home)) ?? 'null')
    if (parsed && typeof parsed === 'object' && parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)) return parsed
  } catch {
    // unreadable: start over (the hour gate then errs toward no key only if the file is lost)
  }
  return { schemaVersion: WATCH_SCHEMA_VERSION, agents: {} }
}

function writeWatchRecord(home, fs, id, record) {
  const all = readWatch(home, fs)
  all.schemaVersion = WATCH_SCHEMA_VERSION
  all.agents[id] = record
  fs.mkdir?.(watcherHome(home))
  fs.writeFile(limitWatchPath(home), `${JSON.stringify(all, null, 2)}\n`)
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
  const usage = usageBackFrom({ now: at, limit, credentialsMtimeMs })
  const keyPath = limitKeyPath({ platform, row, home, fs, pidAlive: ctx.pidAlive, tmuxPath: ctx.tmuxPath ?? null, helperDir: ctx.helperDir ?? null })
  const record = readWatch(home, fs).agents[row.assistantId] ?? null
  return { transcriptPath, limit, usage, keyPath, record, lastEnterAtMs: isoMs(record?.lastEnterAt) }
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
  const path = joinDir(row.stateDir, LIMIT_NOTICE_FILE_NAME)
  const tmp = `${path}.tmp`
  // Whole or nothing: the daemon drops a file it cannot parse, so it never sees half of one.
  fs.writeFile(tmp, `${JSON.stringify({ schemaVersion: NOTICE_SCHEMA_VERSION, ...notice })}\n`)
  fs.rename(tmp, path)
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
  const seen = observeLimit(row, ctx)
  let record = seen.record ?? {}
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

  // The Enter is spent on disk BEFORE the key: a watcher killed after this line never presses twice.
  const pressedAtMs = now()
  record = { ...record, lastEnterAt: iso(pressedAtMs), limitAt: iso(seen.limit.atMs) }
  writeWatchRecord(ctx.home, ctx.fs, id, record)
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
  while (outcome === null && now() < until) {
    await sleep(Math.max(0, Math.min(LIMIT_POLL_MS, until - now())))
    try {
      await ctx.keepOnline?.()
    } catch {
      // staying online is best effort
    }
    const tail = seen.transcriptPath ? parseTranscriptTail(readTail(ctx.fs, seen.transcriptPath), now()) : null
    if (tail?.error?.kind === 'rate_limit' && tail.error.atMs >= pressedAtMs) outcome = 'still_limited'
    else if (typeof tail?.lastActivityAtMs === 'number' && tail.lastActivityAtMs >= pressedAtMs) {
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
  notifyOnce(ctx, row, record, noticeFor(row, seen.limit, how, outcome, { pressedAt: iso(pressedAtMs) }))
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
