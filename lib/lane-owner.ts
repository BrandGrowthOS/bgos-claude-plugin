/**
 * PERSON LANES, the OWNER's daemon side (shared agents Phase 3, P3; design
 * 4.2 steps 1 and 2, 5.2 "When lanes are on for an agent").
 *
 * The owner's daemon (server.ts) is the one socket that stands in
 * `pairing:<id>`, so it is the one that hears `lane_wake`. It does very
 * little with it, all of it here, so server.ts carries only the wiring:
 *
 *   - `lanes_state` tells it which of the pairing's agents run lanes. Until
 *     the server says lanes are on for THIS agent, a wake is ignored and the
 *     owner's chat path is exactly today's.
 *   - `lane_wake` (for this agent only, for a safe person id) leaves the
 *     single use ticket in that lane's state folder (0600) and starts the
 *     lane's supervisor, detached, unless one is already running; the running
 *     lane daemon picks the fresh ticket up when it needs a session.
 *   - `lane_revoked` asks that lane's supervisor to stop.
 *   - The supervisors and lane daemons leave events in each lane folder; the
 *     owner's daemon reports `lane_busy`, `lane_stopped` and `lane_failed`
 *     to the backend with its pairing credential, and posts a notice's FIXED
 *     sentence (lib/lane-core.mjs LANE_NOTICES) in the person's chat: nothing
 *     a lane writes can choose the words, only which of the agent's chats.
 *
 * The owner's own deliveries are guarded by ownerLaneVerdict
 * (lib/lane-core.mjs): a delivery stamped for a person never runs here.
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { join } from 'node:path'

import {
  isSafeAssistantId,
  isSafeLaneUserId,
  lanePaths,
  laneNoticeSentence,
  parseLaneEventLine,
  peopleDirOf,
} from './lane-core.mjs'
import { liveLaneSupervisor } from './lane-registry.mjs'

/** A lane wake as the backend sends it (BGOS LaneWakeFrame). */
export interface LaneWake {
  userId: string
  laneTicket: string
  ticketExpiresAt: string | null
  reason: string
}

/**
 * Read a `lane_wake` frame for THIS agent. Anything addressed to another agent
 * on the pairing, an unsafe person id or a missing ticket is not ours.
 */
export function readLaneWake(frame: unknown, assistantId: string): { ok: true; wake: LaneWake } | { ok: false; why: string } {
  if (!frame || typeof frame !== 'object') return { ok: false, why: 'unreadable' }
  const f = frame as Record<string, unknown>
  if (String(f.assistantId) !== String(assistantId)) return { ok: false, why: 'other_agent' }
  if (!isSafeLaneUserId(f.actorUserId)) return { ok: false, why: 'unsafe_person' }
  if (typeof f.laneTicket !== 'string' || f.laneTicket.length === 0 || f.laneTicket.length > 200) return { ok: false, why: 'no_ticket' }
  return {
    ok: true,
    wake: {
      userId: f.actorUserId as string,
      laneTicket: f.laneTicket,
      ticketExpiresAt: typeof f.ticketExpiresAt === 'string' ? f.ticketExpiresAt : null,
      reason: typeof f.reason === 'string' ? f.reason : 'delivery',
    },
  }
}

/**
 * Which agents of the pairing run lanes, from `lanes_state` (or
 * `GET lanes/state`). Null when the frame says nothing about this agent.
 */
export function lanesOnFor(frame: unknown, assistantId: string): boolean | null {
  const assistants = (frame as { assistants?: unknown } | null)?.assistants
  if (!Array.isArray(assistants)) return null
  const row = assistants.find((a) => String((a as Record<string, unknown>)?.assistantId) === String(assistantId)) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return row.lanesOn === true
}

export interface LaneOwnerDeps {
  assistantId: string
  home: string
  stateRoot?: string
  platform?: string
  fs?: typeof nodeFs
  /** Start `hoai-lane run --assistant <id> --lane <userId>`, detached. */
  startSupervisor: (userId: string) => void
  isSupervised?: (lockPath: string) => number | null
  log: (line: string) => void
}

function writePrivate(fs: typeof nodeFs, path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, { mode: 0o600 })
  fs.renameSync(tmp, path)
  try { fs.chmodSync(path, 0o600) } catch { /* best effort */ }
}

/**
 * Handle one `lane_wake`. Returns what happened, for the log and the tests.
 */
export function handleLaneWake(
  frame: unknown,
  lanesOn: boolean,
  deps: LaneOwnerDeps,
): 'ignored' | 'lanes_off' | 'running' | 'started' | 'failed' {
  const read = readLaneWake(frame, deps.assistantId)
  if (!read.ok) {
    if (read.why !== 'other_agent') deps.log(`lane_wake ignored: ${read.why}`)
    return 'ignored'
  }
  if (!lanesOn) {
    deps.log('lane_wake ignored: the server has not said lanes are on for this agent')
    return 'lanes_off'
  }
  const fs = deps.fs ?? nodeFs
  const { wake } = read
  try {
    const paths = lanePaths({ home: deps.home, assistantId: deps.assistantId, userId: wake.userId, stateRoot: deps.stateRoot, platform: deps.platform })
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
    // A fresh wake means the backend admits the person again (a re-share):
    // the revoke marker a past revoke left goes.
    try { fs.unlinkSync(paths.revokedPath) } catch { /* none */ }
    writePrivate(fs, paths.ticketPath, `${JSON.stringify({ laneTicket: wake.laneTicket, ticketExpiresAt: wake.ticketExpiresAt, reason: wake.reason, at: new Date().toISOString() })}\n`)
    const live = (deps.isSupervised ?? ((p) => liveLaneSupervisor(p)))(paths.launcherLockPath)
    if (live !== null) {
      deps.log(`lane_wake for ${wake.userId} (${wake.reason}): supervisor ${live} already running; ticket left for it`)
      return 'running'
    }
    deps.startSupervisor(wake.userId)
    deps.log(`lane_wake for ${wake.userId} (${wake.reason}): supervisor started`)
    return 'started'
  } catch (err) {
    deps.log(`lane_wake for ${wake.userId} failed: ${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
}

/** Handle one `lane_revoked` for this agent: ask that lane to stop. */
export function handleLaneRevoked(frame: unknown, deps: Omit<LaneOwnerDeps, 'startSupervisor'>): boolean {
  const f = (frame ?? {}) as Record<string, unknown>
  if (String(f.assistantId) !== String(deps.assistantId) || !isSafeLaneUserId(f.actorUserId)) return false
  const fs = deps.fs ?? nodeFs
  try {
    const paths = lanePaths({ home: deps.home, assistantId: deps.assistantId, userId: f.actorUserId as string, stateRoot: deps.stateRoot, platform: deps.platform })
    if (!fs.existsSync(paths.laneDir)) return false
    const body = `${JSON.stringify({ reason: 'revoked', at: new Date().toISOString(), by: 'owner-daemon' })}\n`
    // The marker a starting supervisor honours (it clears stop requests at
    // start, so a revoke landing mid start would otherwise be lost; security
    // review finding 3). Only a fresh wake removes it.
    writePrivate(fs, paths.revokedPath, body)
    writePrivate(fs, paths.stopRequestPath, body)
    // The ticket and the session the person can no longer use go too.
    try { fs.unlinkSync(paths.ticketPath) } catch { /* none */ }
    try { fs.unlinkSync(paths.sessionPath) } catch { /* none */ }
    deps.log(`lane_revoked for ${String(f.actorUserId)}: asked the lane to stop`)
    return true
  } catch (err) {
    deps.log(`lane_revoked failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export interface LaneEventSinks {
  /** POST lanes/report with the owner's pairing credential. */
  report: (userId: string, event: 'lane_busy' | 'lane_stopped' | 'lane_failed') => Promise<void>
  /** Post one fixed sentence in one of the agent's chats, as the agent. */
  notify: (chatId: number, sentence: string) => Promise<void>
}

/**
 * Drain every lane's events file once. Each file is renamed before it is
 * read, so a line written meanwhile lands in a fresh file and is drained on
 * the next pass, never lost and never read twice. Notices go first, so the
 * person reads the reason before the backend's own failure sentence.
 */
export async function drainLaneEvents(
  deps: Omit<LaneOwnerDeps, 'startSupervisor'>,
  sinks: LaneEventSinks,
): Promise<number> {
  const fs = deps.fs ?? nodeFs
  if (!isSafeAssistantId(deps.assistantId)) return 0
  const peopleDir = peopleDirOf({ home: deps.home, assistantId: deps.assistantId, platform: deps.platform })
  let names: string[]
  try {
    names = fs.readdirSync(peopleDir)
  } catch {
    return 0
  }
  let handled = 0
  for (const userId of names) {
    if (!isSafeLaneUserId(userId)) continue
    const eventsPath = join(peopleDir, userId, 'events.jsonl')
    const draining = `${eventsPath}.draining-${process.pid}`
    try {
      fs.renameSync(eventsPath, draining)
    } catch {
      continue
    }
    let text = ''
    try {
      text = String(fs.readFileSync(draining, 'utf8'))
    } finally {
      try { fs.unlinkSync(draining) } catch { /* gone */ }
    }
    const events = text.split('\n').map((line) => parseLaneEventLine(line)).filter((e) => e !== null)
    const ordered = [...events.filter((e) => e.event === 'notice'), ...events.filter((e) => e.event !== 'notice')]
    for (const e of ordered) {
      try {
        if (e.event === 'notice') {
          const sentence = laneNoticeSentence(e.notice)
          if (!sentence) continue
          for (const chatId of e.chatIds ?? []) await sinks.notify(chatId, sentence)
          deps.log(`lane notice ${e.notice} for ${userId} posted in ${(e.chatIds ?? []).length} chat(s)`)
        } else {
          await sinks.report(userId, e.event as 'lane_busy' | 'lane_stopped' | 'lane_failed')
          deps.log(`lane ${e.event} reported for ${userId}`)
        }
        handled += 1
      } catch (err) {
        deps.log(`lane event ${e.event} for ${userId} not delivered: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return handled
}

/** The owner's daemon environment, minus what a supervisor never needs. */
export const SUPERVISOR_ENV_DROP = Object.freeze([
  'BGOS_PAIRING_TOKEN',
  'BGOS_API_KEY',
  'BGOS_CREDENTIALS_PATH',
  'BGOS_TMUX_SESSION',
  'BGOS_TMUX_SOCKET',
  'TMUX',
  'TMUX_PANE',
  'CLAUDE_PROJECT_DIR',
  'HOAI_SUPERVISED',
  'HOAI_SUPERVISED_ASSISTANT_ID',
  'BGOS_LAUNCH_CWD',
])

export function supervisorEnv(ownerEnv: Record<string, string | undefined>, backendUrl: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(ownerEnv)) {
    if (typeof value !== 'string') continue
    if ((SUPERVISOR_ENV_DROP as readonly string[]).includes(name)) continue
    env[name] = value
  }
  env.BGOS_BACKEND_URL = backendUrl
  return env
}
