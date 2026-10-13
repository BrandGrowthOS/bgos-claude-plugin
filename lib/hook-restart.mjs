/**
 * hook-restart: the ONE restart a daemon asks for itself, right after it
 * registered the private turn hook at boot (Data via Ares, PR #220).
 *
 * WHY THIS EXISTS. A daemon that boots without the private turn hook writes it
 * into its clone workspace (server.ts, lib/clone-hooks.mjs registerCloneHooks),
 * but the CLI reads its hooks once, at launch: the session that wrote them
 * never has them, and every boards, schedule or browser call keeps refusing
 * until a person restarts the agent. So the daemon asks its own restart ladder
 * (lib/update-rpc.ts restartAfterHookRegistration, the ladder a scheduled
 * update walks) for exactly one restart.
 *
 * THE RULES, all here so they are tested in one place:
 *   - only when THIS boot registered the hook (outcome 'registered'). A plain
 *     fresh start, where the hook was found and nothing ran, a registration
 *     that was already in place, a folder that is not this clone, or a failed
 *     write never asks: the 2-byte restart loop of 2026-10-12 was a restart
 *     requested after a fresh start, and this must not become another.
 *   - single use, durably: a record (HOOK_RESTART_FILE_NAME in the agent's
 *     state folder) is created exclusively BEFORE the ladder is asked, so the
 *     daemon the restart brings up, or any later one, or a second daemon
 *     racing this one, finds it and never asks again. A record that cannot be
 *     written means no restart, since one restart could not be guaranteed.
 *     Nothing removes it; deleting it by hand re-arms the next registration.
 *   - only the pairing lock holder, never during shutdown (active), never
 *     before HOOK_RESTART_MIN_UP_MS of uptime, never while an update holds the
 *     shared checkout's lock or drains this daemon, and only at the safe moment
 *     the watcher itself waits for before a restart nobody asked for
 *     (lib/keepalive-plan.mjs decideSafeMoment): no turn in flight, nothing
 *     owed, no background job under claude, and 10 minutes of quiet (30 when
 *     the hook turn signal is missing, which is likely here: a folder without
 *     the private turn hook often lacks the whole rail). Boot counts as
 *     activity. Nothing is urgent: the agent was refusing private calls
 *     already, and a cut turn would cost more. The process tree is listed only
 *     once everything else says safe, and after it said wait, not again for
 *     HOOK_RESTART_LIST_BACKOFF_MS. Each reason to wait is logged once.
 *   - intake is drained before the ladder runs, as for a scheduled update; the
 *     ladder lifts it when it stages, its watchdog when the restart never
 *     arrives, and this module when the drain or the ladder throws.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; every effect is
 * injected so tests run it on a fake disk and clock.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { decideSafeMoment } from './keepalive-plan.mjs'
import { MIN_SESSION_UP_MS } from './marker-takeover.mjs'
import { descendantsOf } from './process-tree.mjs'

/** The single-use record, in ~/.bgos-agent/<id>/. */
export const HOOK_RESTART_FILE_NAME = 'hook-restart.json'
/** The same floor as the marker takeover (lib/marker-takeover.mjs). This
 *  daemon's uptime bounds claude's from below, so a keepalive.sh session is
 *  never ended inside its "resumed session died in <25s, retrying fresh"
 *  window, and a session that crash loops is never restarted on top. */
export const HOOK_RESTART_MIN_UP_MS = MIN_SESSION_UP_MS
/** The quiet windows are minutes long; a half-minute poll is plenty. */
export const HOOK_RESTART_POLL_MS = 30_000
/** After the process tree said wait (a job under claude, or no listing), the
 *  next look is this far off: on Windows a listing is a hidden PowerShell
 *  process, and a dev server can sit under claude for hours. */
export const HOOK_RESTART_LIST_BACKOFF_MS = 5 * 60_000

/**
 * Does this boot arm the one restart? Pure.
 * @param {{ outcomes: readonly string[], recordPresent: boolean }} input
 * @returns {{ arm: boolean, reason: 'registered' | 'nothing_registered' | 'already_requested' }}
 */
export function decideHookRestart({ outcomes, recordPresent }) {
  if (!outcomes.includes('registered')) return { arm: false, reason: 'nothing_registered' }
  if (recordPresent) return { arm: false, reason: 'already_requested' }
  return { arm: true, reason: 'registered' }
}

/**
 * May an armed daemon ask now? Pure. `descendants` are the command lines under
 * claude, null when they could not be listed (decideSafeMoment: unsafe).
 * @param {{ now: number, bootAtMs: number, active: boolean, draining: boolean, updateLockHeld: boolean,
 *   claudeKnown: boolean, descendants: string[] | null, activityMs: Array<number | null | undefined>,
 *   state: { turnInFlight: boolean, turnSignal: string, pendingMessages: number,
 *     pendingPermissions: number, activeOperations: number } }} f
 * @returns {{ step: 'ask' | 'passive' | 'young' | 'busy', reason: string }}
 */
export function hookRestartStep(f) {
  if (!f.active) return { step: 'passive', reason: 'passive' }
  if (f.now - f.bootAtMs < HOOK_RESTART_MIN_UP_MS) return { step: 'young', reason: 'young' }
  if (f.draining || f.updateLockHeld) return { step: 'busy', reason: 'update_in_flight' }
  const safe = decideSafeMoment({
    running: f.claudeKnown ? true : null,
    stateFresh: true,
    state: f.state,
    descendants: f.descendants,
    activityMs: f.activityMs,
    now: f.now,
  })
  return safe.safe ? { step: 'ask', reason: safe.reason } : { step: 'busy', reason: safe.reason }
}

/**
 * The daemon's controller: armed once at boot, it polls until the safe moment,
 * asks once, and stops.
 * @param {{
 *   outcomes: readonly string[], folders: readonly string[], recordPath: string,
 *   fs: { exists: (p: string) => boolean, readFile: (p: string) => string | null,
 *     createExclusive: (p: string, text: string) => 'ok' | 'exists' | 'error' },
 *   bootAtMs: number, now: () => number, ownPid: number,
 *   active: () => boolean, draining: () => boolean, updateLockHeld: () => boolean,
 *   safeState: () => { turnInFlight: boolean, turnSignal: string, pendingMessages: number,
 *     pendingPermissions: number, activeOperations: number },
 *   activityMs: () => Array<number | null | undefined>,
 *   claudePid: () => number | null,
 *   listProcesses: () => Promise<{ ok: boolean, processes?: Array<{ pid: number, ppid: number, command: string }> }>,
 *   drain: (on: boolean) => void, requestRestart: () => Promise<boolean>,
 *   log: (line: string) => void,
 *   setInterval: (fn: () => void, ms: number) => any, clearInterval: (handle: any) => void,
 * }} deps
 */
export function createHookRestart(deps) {
  const log = (text) => {
    try {
      deps.log(`hook restart: ${text}`)
    } catch {
      // A log that throws must never stop the session.
    }
  }
  let recordPresent = true
  try {
    recordPresent = deps.fs.exists(deps.recordPath)
  } catch {
    // Unreadable reads as present: fail closed, never a second restart.
  }
  const decision = decideHookRestart({ outcomes: deps.outcomes, recordPresent })
  if (!decision.arm && decision.reason === 'already_requested') {
    log(
      `not asking: a restart for a hook registration was already requested (${deps.recordPath}: ${oneLine(deps.fs.readFile(deps.recordPath))}); ` +
        'restart this agent by hand to load the hook',
    )
  }
  let done = !decision.arm
  let looking = false
  let listAfterMs = 0
  let interval = null
  // Each reason to wait is said once, so a restart that cannot happen is
  // visible; the first minute is not news.
  const said = new Set()
  const waiting = (reason) => {
    if (reason === 'young' || said.has(reason)) return
    said.add(reason)
    log(`waiting: ${reason}`)
  }
  const stop = () => {
    done = true
    if (interval !== null) deps.clearInterval(interval)
    interval = null
  }
  const step = (descendants) =>
    hookRestartStep({
      now: deps.now(),
      bootAtMs: deps.bootAtMs,
      active: deps.active(),
      draining: deps.draining(),
      updateLockHeld: deps.updateLockHeld(),
      claudeKnown: deps.claudePid() !== null,
      descendants,
      activityMs: deps.activityMs(),
      state: deps.safeState(),
    })

  const tick = async () => {
    if (done) return 'done'
    // One look at a time: the listing below is awaited.
    if (looking) return 'busy'
    // Everything but the process tree first; the tree is listed only when that says safe.
    const first = step([])
    if (first.step !== 'ask') {
      waiting(first.reason)
      return first.step
    }
    if (deps.now() < listAfterMs) return 'busy'
    looking = true
    let descendants = null
    try {
      const claude = deps.claudePid()
      const listing = claude === null ? null : await deps.listProcesses()
      if (listing?.ok && Array.isArray(listing.processes)) descendants = descendantsOf(listing.processes, claude).map((p) => p.command)
    } catch {
      descendants = null
    } finally {
      looking = false
    }
    if (done) return 'done'
    // Again, after the await: the moment has to still be safe, with the tree.
    const now = step(descendants)
    if (now.step !== 'ask') {
      listAfterMs = deps.now() + HOOK_RESTART_LIST_BACKOFF_MS
      waiting(now.reason)
      return now.step
    }
    // Single use from here on, whatever happens next.
    stop()
    const record = JSON.stringify({ requestedAt: new Date(deps.now()).toISOString(), pid: deps.ownPid, folders: [...deps.folders] })
    let created = 'error'
    try {
      created = deps.fs.createExclusive(deps.recordPath, record)
    } catch {
      created = 'error'
    }
    if (created === 'exists') {
      log(`not asking: another daemon already asked (${deps.recordPath})`)
      return 'exists'
    }
    if (created !== 'ok') {
      log(`could not write ${deps.recordPath}, so a single restart cannot be guaranteed; not asking. Restart this agent by hand to load the hook`)
      return 'record_failed'
    }
    log(`asking the restart ladder for ONE restart so this session loads the private turn hook (${now.reason})`)
    let took = false
    try {
      deps.drain(true)
      took = await deps.requestRestart()
    } catch (err) {
      try {
        deps.drain(false)
      } catch {
        // Nothing more to lift.
      }
      log(`the restart request failed (${err instanceof Error ? err.message : String(err)}); restart this agent by hand to load the hook`)
      return 'failed'
    }
    if (took) {
      log('the restart ladder took it; the agent comes back on its pinned session with the hook loaded')
      return 'requested'
    }
    log(`no restart authority took it; restart this agent by hand to load the hook (single use: ${deps.recordPath})`)
    return 'staged'
  }

  return {
    armed: decision.arm,
    tick,
    stop,
    start: () => {
      if (done || interval !== null) return
      log(
        `armed: this daemon registered the private turn hook in ${deps.folders.join(', ')}; it asks for ONE restart once it holds the pairing lock ` +
          `and the agent is idle and quiet (the watcher's safe moment) (record: ${deps.recordPath})`,
      )
      interval = deps.setInterval(() => {
        void tick()
      }, HOOK_RESTART_POLL_MS)
      interval?.unref?.()
    },
  }
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'empty'
}

/**
 * The record on the real disk: exclusive create, so two daemons cannot both ask.
 * @returns {{ exists: (p: string) => boolean, readFile: (p: string) => string | null,
 *   createExclusive: (p: string, text: string) => 'ok' | 'exists' | 'error' }}
 */
export function nodeHookRestartFs() {
  return {
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    createExclusive: (p, text) => {
      try {
        mkdirSync(dirname(p), { recursive: true })
        const fd = openSync(p, 'wx')
        try {
          writeSync(fd, text)
        } finally {
          closeSync(fd)
        }
        return 'ok'
      } catch (err) {
        return err?.code === 'EEXIST' ? 'exists' : 'error'
      }
    },
  }
}
