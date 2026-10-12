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
 *     written means no restart, since one restart could not be guaranteed. Nothing
 *     removes it; deleting it by hand re-arms the next registration.
 *   - only the pairing lock holder, never during shutdown (active), only after
 *     HOOK_RESTART_MIN_UP_MS of uptime, and only when idle and not already
 *     draining for an update, so no turn is cut and no update restart is
 *     doubled. Intake is drained before the ladder runs, as the scheduled
 *     update does; the ladder lifts it when it stages, its watchdog when the
 *     restart never arrives, and this module when the ladder throws.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; every effect is
 * injected so tests run it on a fake disk and clock.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { MIN_SESSION_UP_MS } from './marker-takeover.mjs'

/** The single-use record, in ~/.bgos-agent/<id>/. */
export const HOOK_RESTART_FILE_NAME = 'hook-restart.json'
/** The same floor as the marker takeover (lib/marker-takeover.mjs): this
 *  daemon's uptime bounds claude's from below, so the launcher never sees the
 *  exit inside its RELAUNCH_HEALTHY_MS (25 s) window, where it retries with a
 *  NEW session id, and keepalive.sh's "resumed session died in <25s" rule
 *  never fires either. */
export const HOOK_RESTART_MIN_UP_MS = MIN_SESSION_UP_MS
export const HOOK_RESTART_POLL_MS = 5_000

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
 * May an armed daemon ask now? Pure.
 * @param {{ now: number, bootAtMs: number, active: boolean, draining: boolean,
 *   snapshot: { activeOperations: number, pendingMessages: number, pendingPermissions: number } }} f
 * @returns {'ask' | 'passive' | 'young' | 'busy'}
 */
export function hookRestartStep(f) {
  if (!f.active) return 'passive'
  if (f.now - f.bootAtMs < HOOK_RESTART_MIN_UP_MS) return 'young'
  const s = f.snapshot
  if (f.draining || s.activeOperations !== 0 || s.pendingMessages !== 0 || s.pendingPermissions !== 0) return 'busy'
  return 'ask'
}

/**
 * The daemon's controller: armed once at boot, it polls until it may ask,
 * asks once, and stops.
 * @param {{
 *   outcomes: readonly string[], folders: readonly string[], recordPath: string,
 *   fs: { exists: (p: string) => boolean, readFile: (p: string) => string | null,
 *     createExclusive: (p: string, text: string) => 'ok' | 'exists' | 'error' },
 *   bootAtMs: number, now: () => number, ownPid: number,
 *   active: () => boolean, draining: () => boolean,
 *   drainSnapshot: () => { activeOperations: number, pendingMessages: number, pendingPermissions: number },
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
  let interval = null
  const stop = () => {
    done = true
    if (interval !== null) deps.clearInterval(interval)
    interval = null
  }

  const tick = async () => {
    if (done) return 'done'
    const step = hookRestartStep({
      now: deps.now(),
      bootAtMs: deps.bootAtMs,
      active: deps.active(),
      draining: deps.draining(),
      snapshot: deps.drainSnapshot(),
    })
    if (step !== 'ask') return step
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
    log('asking the restart ladder for ONE restart so this session loads the private turn hook')
    deps.drain(true)
    let took = false
    try {
      took = await deps.requestRestart()
    } catch (err) {
      deps.drain(false)
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
        `armed: this daemon registered the private turn hook in ${deps.folders.join(', ')}; it asks for ONE restart once it holds the pairing lock, ` +
          `has run ${HOOK_RESTART_MIN_UP_MS / 1000} s and is idle (record: ${deps.recordPath})`,
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
