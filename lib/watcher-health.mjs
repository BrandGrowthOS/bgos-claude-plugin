/**
 * watcher-health: the watcher reports its own health, and a crash loop is
 * visible instead of silent (design 8; fact 5; G6).
 *
 * Fact 5, measured: a 0.61.1 watcher crash looped every 5 s on a missing
 * known-good-store.mjs and nobody was told. bin/hoai-watcher.mjs imported
 * lib/watcher-core.mjs STATICALLY, so the import failure killed the process
 * before the logger or the heartbeat existed, and systemd (Restart=always,
 * RestartSec=5) / launchd (KeepAlive, ThrottleInterval 10) restarted it for
 * ever. The heartbeat had no health field at all.
 *
 * This module is the part that must still work when the rest of the bundle
 * does not, so it imports NOTHING but node builtins (and nothing imports it
 * statically but watcher-core). The entry imports it DYNAMICALLY inside its
 * own try: a bundle an older installer copied without this file (a 0.61.4
 * daemon's list has none, e2e E4) then reaches the entry's builtins-only
 * stand in, bin/hoai-watcher.mjs runFallbackGuard, which keeps the same
 * files and wire shape. It provides:
 *
 *   runGuarded      the crash-safe entry: record the start in boots.json (a ring
 *                   of 20), dynamic-import the watcher inside a try, run it; on
 *                   a failure write crash.json ({at, message}, scrubbed), send a
 *                   MINIMAL heartbeat built from credentials.json with node's own
 *                   fetch, and when it is a crash loop wait before exiting.
 *   repair          a `repair` hook the entry passes (e2e E4): a module missing
 *                   INSIDE the bundle is restored from the plugin root and the
 *                   process exits for the service to start the repaired bundle,
 *                   with no wait; when no repair is possible the reason rides
 *                   the fatal line and the crash loop rule below applies.
 *   crash loop      3 or more starts within 10 minutes with no successful poll
 *                   recorded between them (state.json lastPollOkAt, written by
 *                   watcher-core). The wait is 30 s, doubling per looped start,
 *                   at most 10 minutes, so the service manager stops restarting
 *                   it every 5 to 10 s. A wait is recorded on its boot, so the
 *                   loop stays a loop (and keeps doubling) until a poll succeeds.
 *   watcherHealth   the heartbeat field: {status ok | degraded | crash_loop,
 *                   bootsLastHour, lastFatal?, keepAlive?}, strings bounded to
 *                   120 characters and the agent list to 64 (the backend DTO).
 *
 * The app shows a red row for crash_loop, and the existing "watcher offline
 * since" covers a watcher that dies before it can say anything at all.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const BOOTS_FILE_NAME = 'boots.json'
export const CRASH_FILE_NAME = 'crash.json'
export const BOOTS_RING_SIZE = 20
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000
export const CRASH_LOOP_MIN_BOOTS = 3
export const CRASH_BACKOFF_MIN_MS = 30_000
export const CRASH_BACKOFF_MAX_MS = 10 * 60_000
/** A fatal younger than this makes the running watcher report `degraded`. */
export const DEGRADED_WINDOW_MS = 60 * 60_000
export const HEALTH_STRING_MAX = 120
export const HEALTH_MAX_AGENTS = 64
export const CRASH_MESSAGE_MAX = 500
export const FATAL_HEARTBEAT_TIMEOUT_MS = 10_000
export const EXIT_FATAL = 1

const VERSION_RE = /^\d+\.\d+\.\d+[-\w.]*$/

// -- Paths (mirror of lib/watcher-bundle.mjs, pinned by test/watcher-health.test.ts) --------

function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** ~/.bgos-agent/watcher (lib/watcher-bundle.mjs watcherHome). */
export function healthHome(home) {
  return joinDir(joinDir(home, '.bgos-agent'), 'watcher')
}

export function bootsPath(home) {
  return joinDir(healthHome(home), BOOTS_FILE_NAME)
}

export function crashPath(home) {
  return joinDir(healthHome(home), CRASH_FILE_NAME)
}

function statePath(home) {
  return joinDir(healthHome(home), 'state.json')
}

function logPath(home) {
  return joinDir(joinDir(healthHome(home), 'logs'), 'watcher.log')
}

// -- A builtins-only fs (the WatcherFs subset this module needs) ----------------------------

/** Reads never throw (null / []), writes create the parent and may throw. */
export function builtinFs() {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    appendFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, text)
    },
    listDir: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
  }
}

function readJson(fs, path) {
  try {
    return JSON.parse(fs.readFile(path) ?? 'null')
  } catch {
    return null
  }
}

function msOf(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function clip(value, max = HEALTH_STRING_MAX) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

// -- boots.json, crash.json, lastPollOkAt ----------------------------------------------------

/** @typedef {{ startedAt: string, startedAtMs: number, pid: number | null, version: string | null, backoffMs?: number }} Boot */

/** @returns {Boot[]} oldest first; junk entries (and a junk file) are dropped. */
export function readBoots(home, fs = builtinFs()) {
  const raw = readJson(fs, bootsPath(home))
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    const startedAtMs = msOf(entry?.startedAt)
    if (startedAtMs === null) continue
    out.push({
      startedAt: entry.startedAt,
      startedAtMs,
      pid: Number.isInteger(entry.pid) ? entry.pid : null,
      version: typeof entry.version === 'string' ? entry.version : null,
      ...(Number.isFinite(entry.backoffMs) && entry.backoffMs > 0 ? { backoffMs: entry.backoffMs } : {}),
    })
  }
  return out
}

function writeBoots(home, boots, fs) {
  const body = boots.slice(-BOOTS_RING_SIZE).map((b) => ({
    startedAt: b.startedAt,
    pid: b.pid,
    version: b.version,
    ...(b.backoffMs ? { backoffMs: b.backoffMs } : {}),
  }))
  fs.writeFile(bootsPath(home), `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * Append this start to boots.json, keeping the last 20.
 * @param {string} home
 * @param {{ startedAt: string, pid: number | null, version: string | null }} entry
 * @returns {Boot[]} the ring after the append
 */
export function recordBoot(home, entry, fs = builtinFs()) {
  const boots = [...readBoots(home, fs), { ...entry, startedAtMs: msOf(entry.startedAt) ?? 0 }].slice(-BOOTS_RING_SIZE)
  writeBoots(home, boots, fs)
  return boots
}

/** Record that THIS start waited (so the next one knows the loop is still on). */
export function markBootBackoff(home, { pid, startedAt }, backoffMs, fs = builtinFs()) {
  const boots = readBoots(home, fs)
  const mine = [...boots].reverse().find((b) => b.pid === pid && b.startedAt === startedAt)
  if (!mine) return
  mine.backoffMs = backoffMs
  writeBoots(home, boots, fs)
}

/** @returns {{ at: string, message: string } | null} */
export function readCrash(home, fs = builtinFs()) {
  const raw = readJson(fs, crashPath(home))
  if (!raw || typeof raw !== 'object' || typeof raw.at !== 'string' || typeof raw.message !== 'string') return null
  return { at: raw.at, message: raw.message }
}

export function writeCrash(home, crash, fs = builtinFs()) {
  fs.writeFile(crashPath(home), `${JSON.stringify({ at: crash.at, message: crash.message }, null, 2)}\n`)
}

/** The last successful long-poll the loop recorded (state.json lastPollOkAt), or null. */
export function readLastPollOkAtMs(home, fs = builtinFs()) {
  return msOf(readJson(fs, statePath(home))?.lastPollOkAt)
}

// -- Pure decisions ----------------------------------------------------------------------------

/**
 * Is this a crash loop, and how long to wait before exiting?
 * @param {{ boots: Boot[], lastPollOkAtMs: number | null, now: number }} input
 * @returns {{ crashLoop: boolean, failingBoots: number, backoffMs: number }}
 */
export function crashLoopVerdict({ boots, lastPollOkAtMs, now }) {
  const floor = typeof lastPollOkAtMs === 'number' ? lastPollOkAtMs : -Infinity
  // "no successful poll between them": only the starts after the last good poll.
  const failing = (Array.isArray(boots) ? boots : []).filter((b) => b.startedAtMs > floor)
  const inWindow = failing.filter((b) => now - b.startedAtMs <= CRASH_LOOP_WINDOW_MS)
  // Once the guard has waited, the starts are spread out BY that wait; the loop
  // is still a loop until a poll succeeds, and each further wait doubles.
  const waited = failing.filter((b) => (b.backoffMs ?? 0) > 0).length
  const crashLoop = inWindow.length >= CRASH_LOOP_MIN_BOOTS || waited > 0
  const backoffMs = crashLoop ? Math.min(CRASH_BACKOFF_MIN_MS * 2 ** waited, CRASH_BACKOFF_MAX_MS) : 0
  return { crashLoop, failingBoots: failing.length, backoffMs }
}

export function bootsInLastHour(boots, now) {
  return (Array.isArray(boots) ? boots : []).filter((b) => now - b.startedAtMs >= 0 && now - b.startedAtMs < 60 * 60_000).length
}

/**
 * env.watcherHealth (design 8 shape).
 * @param {{ boots: Boot[], crash: { at: string, message: string } | null, now: number,
 *   keepAlive?: { enabled: boolean, agents: object[] } | null, status?: 'ok' | 'degraded' | 'crash_loop' | null }} input
 * @returns {{ status: 'ok' | 'degraded' | 'crash_loop', bootsLastHour: number,
 *   lastFatal?: { at: string, message: string }, keepAlive?: { enabled: boolean, agents: object[] } }}
 */
export function buildWatcherHealth({ boots, crash, now, keepAlive = null, status = null }) {
  const bootsLastHour = bootsInLastHour(boots, now)
  const crashAtMs = msOf(crash?.at)
  const recentFatal = crashAtMs !== null && now - crashAtMs < DEGRADED_WINDOW_MS
  const out = {
    status: status ?? (recentFatal || bootsLastHour >= CRASH_LOOP_MIN_BOOTS ? 'degraded' : 'ok'),
    bootsLastHour,
  }
  if (crash) out.lastFatal = { at: clip(crash.at), message: clip(crash.message) }
  if (keepAlive) {
    out.keepAlive = {
      enabled: Boolean(keepAlive.enabled),
      agents: (Array.isArray(keepAlive.agents) ? keepAlive.agents : []).slice(0, HEALTH_MAX_AGENTS),
    }
  }
  return out
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scrub a fatal message before it is written or sent: explicit secrets (the
 * pairing token), header and bearer values, key=value secrets, then the home
 * path (-> ~) and the username (-> <user>). A compact port of watcher-core's
 * scrubLine, kept here because this runs when watcher-core may not load.
 * @param {unknown} message
 * @param {{ home?: string, username?: string, secrets?: string[] }} [opts]
 * @returns {string}
 */
export function scrubFatal(message, { home = '', username = '', secrets = [] } = {}) {
  let out = String(message ?? '')
  for (const secret of secrets) {
    const value = String(secret ?? '')
    if (value.length >= 6) out = out.split(value).join('<redacted>')
  }
  out = out.replace(/(X-BGOS-Pairing\s*[:=]\s*)\S+/gi, '$1<redacted>')
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer <redacted>')
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, '<redacted>')
  out = out.replace(/((?:api[_-]?key|secret|token|password|pairingToken)["']?\s*[:=]\s*["']?)([^\s"',}]{8,})/gi, '$1<redacted>')
  const homeValue = String(home ?? '').replace(/[\\/]+$/, '')
  if (homeValue) {
    const alt = homeValue.includes('\\') ? homeValue.split('\\').join('/') : homeValue.split('/').join('\\')
    for (const spelling of [homeValue, alt]) out = out.replace(new RegExp(escapeRegExp(spelling), /^[A-Za-z]:/.test(spelling) ? 'gi' : 'g'), '~')
  }
  const user = String(username ?? '').trim()
  if (user.length >= 2) out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(user)}(?![A-Za-z0-9])`, 'gi'), '$1<user>')
  return out
}

// -- The minimal heartbeat --------------------------------------------------------------------

function readCredentials(home, fs) {
  const raw = readJson(fs, joinDir(healthHome(home), 'credentials.json'))
  if (!raw || typeof raw !== 'object') return null
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  const backendUrl = typeof raw.backendUrl === 'string' ? raw.backendUrl.trim() : ''
  const machineId = typeof raw.machineId === 'string' ? raw.machineId.trim() : ''
  return token && backendUrl && machineId ? { token, backendUrl, machineId } : null
}

function readManifestVersion(home, fs) {
  const version = String(readJson(fs, joinDir(healthHome(home), 'manifest.json'))?.version ?? '').trim()
  return VERSION_RE.test(version) ? version : null
}

/** Mirror of watcher-core normalizeApiBase: exactly one trailing /api/v1. */
function apiBase(url) {
  let base = String(url ?? '').trim().replace(/\/+$/, '')
  if (base && !/\/api\/v1$/.test(base)) base = `${base}/api/v1`
  return base
}

/**
 * POST the minimal heartbeat with node's own fetch: daemonVersion, and env
 * {platform, machineId, role, agents (from the credentials file names), watcherHealth}.
 * Never throws.
 */
export async function postFatalHeartbeat({ home, platform, fetch: fetchImpl, fs = builtinFs(), health, version = null, timeoutMs = FATAL_HEARTBEAT_TIMEOUT_MS }) {
  const creds = readCredentials(home, fs)
  if (!creds) return { ok: false, status: 0, error: 'no_credentials' }
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, error: 'no_fetch' }
  const agents = fs
    .listDir(joinDir(home, '.bgos-agent'))
    .map((name) => /^credentials-(\d+)\.json$/.exec(String(name))?.[1])
    .filter((id) => Boolean(id))
    .sort((a, b) => Number(a) - Number(b))
  const body = {
    daemonVersion: version ?? '0.0.0',
    env: { platform, machineId: creds.machineId, role: 'watcher', agents, watcherHealth: health },
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  if (timer && typeof timer.unref === 'function') timer.unref()
  try {
    const res = await fetchImpl(`${apiBase(creds.backendUrl)}/integrations/heartbeat`, {
      method: 'POST',
      headers: { 'X-BGOS-Pairing': creds.token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    })
    return { ok: Boolean(res?.ok), status: Number(res?.status ?? 0), error: null }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// -- The guard ---------------------------------------------------------------------------------

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ''
}

/**
 * The crash-safe entry. `load` dynamic-imports the watcher (so a missing module
 * is a catchable rejection here, not a dead process), `run` runs it with what
 * was loaded and resolves to the exit code. Anything thrown by either is a
 * fatal: recorded, reported, and slowed down when it repeats.
 * A `repair` hook (the entry's bundle self repair) is asked first: when it
 * repaired, the fatal is still recorded (crash.json, the log) and the process
 * leaves with the hook's exit code at once, no heartbeat and no wait, so the
 * service starts the repaired bundle; otherwise its message joins the fatal
 * line and the failure is reported exactly as before.
 * @param {{ home: string, env?: Record<string, string | undefined>, platform: string,
 *   load: () => Promise<any>, run: (loaded: any) => Promise<number>,
 *   fetch?: typeof fetch, fs?: ReturnType<typeof builtinFs>, now?: () => number,
 *   sleep?: (ms: number) => Promise<unknown>, pid?: number, err?: (line: string) => void, username?: string,
 *   repair?: ((error: unknown) => Promise<{ repaired: boolean, message: string, exitCode?: number } | null>) | null }} params
 * @returns {Promise<number>}
 */
export async function runGuarded({
  home,
  env = {},
  platform,
  load,
  run,
  fetch: fetchImpl = globalThis.fetch,
  fs = builtinFs(),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pid = process.pid,
  err = () => {},
  username = '',
  repair = null,
}) {
  const startedAt = new Date(now()).toISOString()
  const version = readManifestVersion(home, fs)
  let boots
  try {
    boots = recordBoot(home, { startedAt, pid, version }, fs)
  } catch {
    // A read-only watcher home must not stop the watcher; the loop rule then
    // simply sees fewer starts.
    boots = [...readBoots(home, fs), { startedAt, startedAtMs: msOf(startedAt) ?? 0, pid, version }]
  }
  try {
    const loaded = await load()
    return await run(loaded)
  } catch (error) {
    const at = new Date(now()).toISOString()
    const creds = readCredentials(home, fs)
    const message = clip(
      scrubFatal(firstLine(error?.message ?? error) || 'unknown error', {
        home,
        username: username || String(env?.USER ?? env?.USERNAME ?? '').trim(),
        secrets: creds ? [creds.token] : [],
      }),
      CRASH_MESSAGE_MAX,
    )
    try {
      writeCrash(home, { at, message }, fs)
    } catch {
      // still report it below
    }
    const writeLine = (line) => {
      try {
        fs.appendFile(logPath(home), `${at} ${line}\n`)
      } catch {
        // stderr still carries it (the service log)
      }
    }
    let repaired = null
    if (typeof repair === 'function') {
      try {
        repaired = await repair(error)
      } catch {
        repaired = null
      }
    }
    if (repaired?.repaired) {
      const line = `fatal before the loop: ${message}; ${repaired.message}`
      writeLine(line)
      err(`[hoai-watcher] ${line}`)
      return typeof repaired.exitCode === 'number' ? repaired.exitCode : EXIT_FATAL
    }
    const verdict = crashLoopVerdict({ boots, lastPollOkAtMs: readLastPollOkAtMs(home, fs), now: now() })
    const line = `fatal before the loop: ${message}${repaired?.message ? `; ${repaired.message}` : ''}${verdict.crashLoop ? `; crash loop (${verdict.failingBoots} starts with no successful poll), waiting ${verdict.backoffMs / 1000}s before exiting` : ''}`
    writeLine(line)
    err(`[hoai-watcher] ${line}`)
    const health = buildWatcherHealth({ boots, crash: { at, message }, now: now(), status: verdict.crashLoop ? 'crash_loop' : 'degraded' })
    const sent = await postFatalHeartbeat({ home, platform, fetch: fetchImpl, fs, health, version })
    writeLine(`crash heartbeat: ${sent.ok ? 'delivered' : 'not delivered'}${sent.status ? ` (HTTP ${sent.status})` : ''}${sent.error ? `: ${sent.error}` : ''}`)
    if (verdict.crashLoop) {
      try {
        markBootBackoff(home, { pid, startedAt }, verdict.backoffMs, fs)
      } catch {
        // the wait still happens
      }
      await sleep(verdict.backoffMs)
    }
    return EXIT_FATAL
  }
}
