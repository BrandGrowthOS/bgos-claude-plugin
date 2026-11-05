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
  LANE_ENV_KEEP,
  LANE_SUPERVISOR_VERSION,
  LANE_ENV_KEEP_WIN32,
  LANE_LOGIN_ENV,
  LANE_LOGIN_CONFIG_ENV,
  laneNoticeSentence,
  laneEventLine,
  parseLaneEventLine,
  peopleDirOf,
} from './lane-core.mjs'
import { liveLaneSupervisor } from './lane-registry.mjs'
import { readRefusalReceipts } from './lane-notices.mjs'

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
  notifyOwner?: (sentence: string) => Promise<void>
  /** Resolve this person's chats from the backend, never from a local claim. */
  notifyPerson?: (userId: string, sentence: string) => Promise<void>
}

/** Stop old person launches at the next owner check, even during a turn. */
export function sweepUnsafePersonLanes(deps: Omit<LaneOwnerDeps, 'startSupervisor'>): number {
  if (!isSafeAssistantId(deps.assistantId)) return 0
  const fs = deps.fs ?? nodeFs
  const peopleDir = peopleDirOf({ home: deps.home, assistantId: deps.assistantId, platform: deps.platform })
  let names: string[]
  try { names = fs.readdirSync(peopleDir) } catch { return 0 }
  let stopped = 0
  for (const userId of names) {
    if (!isSafeLaneUserId(userId)) continue
    try {
      const paths = lanePaths({ home: deps.home, assistantId: deps.assistantId, userId, stateRoot: deps.stateRoot, platform: deps.platform })
      if (!fs.lstatSync(paths.laneDir).isDirectory()) continue
      const launch = JSON.parse(fs.readFileSync(paths.launchPolicyPath, 'utf8'))
      // A locked record does not prove that the running code is current.
      // Retire unmarked supervisors before their old launch loop can restart.
      if (launch?.supervisorVersion === LANE_SUPERVISOR_VERSION && !launch?.tools?.includes('Bash') && launch?.policy?.shell !== true &&
          launch?.policy?.ownerMcpServers !== true && !(Array.isArray(launch?.ownerServers) && launch.ownerServers.length > 0)) continue
      const pid = (deps.isSupervised ?? ((p) => liveLaneSupervisor(p)))(paths.launcherLockPath)
      if (pid === null) continue
      // The old supervisor already understands a stop request and exits its
      // launch loop, so the next wake uses the updated code too.
      writePrivate(fs, paths.stopRequestPath, `${JSON.stringify({ reason: 'sharing_update', by: 'owner-daemon' })}\n`)
      stopped += 1
      const marker = join(paths.laneDir, 'sharing-update-notice.json')
      const key = JSON.stringify([pid, launch.at ?? null])
      let prior = ''
      try { prior = fs.readFileSync(marker, 'utf8').trim() } catch { /* first check */ }
      if (prior !== key) {
        fs.appendFileSync(paths.eventsPath, laneEventLine({ event: 'notice', notice: 'sharing_update' }), { mode: 0o600 })
        writePrivate(fs, marker, `${key}\n`)
        deps.log(`stopping ${userId} to apply updated sharing permissions`)
      }
    } catch (err) {
      deps.log(`lane update check for ${userId} failed: ${String(err)}`)
    }
  }
  return stopped
}

/** Persist successful recipients independently of the supervisor's generated flag. */
async function deliverRefusalNotice(
  fs: typeof nodeFs, laneDir: string, userId: string,
  event: { notice?: string; chatIds?: number[] },
  sentence: string, sinks: LaneEventSinks, log: (line: string) => void,
): Promise<void> {
  const path = join(laneDir, 'notice-delivery.json')
  const receipts = readRefusalReceipts(fs, path)
  const receipt = receipts[event.notice!] ??= { ownerDelivered: false, personDelivered: false, chatIds: [] }
  const save = () => {
    writePrivate(fs, path, `${JSON.stringify(receipts)}\n`)
  }
  let pending = false
  log(sentence)
  if (sinks.notifyOwner && !receipt.ownerDelivered) {
    try {
      await sinks.notifyOwner(sentence)
      receipt.ownerDelivered = true
      save()
    } catch (err) {
      pending = true
      log(`lane owner notice for ${userId} not delivered: ${String(err)}`)
    }
  }
  for (const chatId of event.chatIds ?? []) {
    if (receipt.chatIds.includes(chatId)) continue
    try {
      await sinks.notify(chatId, sentence)
      receipt.chatIds.push(chatId)
      save()
    } catch (err) {
      pending = true
      log(`lane notice for ${userId} in chat ${chatId} not delivered: ${String(err)}`)
    }
  }
  if (!(event.chatIds ?? []).length && !receipt.personDelivered) {
    try {
      if (!sinks.notifyPerson) throw new Error('person notice sink unavailable')
      await sinks.notifyPerson(userId, sentence)
      receipt.personDelivered = true
      save()
    } catch (err) {
      pending = true
      log(`lane person notice for ${userId} not delivered: ${String(err)}`)
    }
  }
  if (pending) throw new Error('notice delivery pending')
  save()
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
          if (e.notice === 'shell_refused' || e.notice === 'owner_mcp_refused') {
            await deliverRefusalNotice(fs, join(peopleDir, userId), userId, e, sentence, sinks, deps.log)
            handled += 1
            continue
          }
          if (e.notice === 'sharing_update') {
            if (!sinks.notifyPerson) throw new Error('person notice sink unavailable')
            await sinks.notifyPerson(userId, sentence)
          }
          for (const chatId of e.chatIds ?? []) {
            try {
              await sinks.notify(chatId, sentence)
            } catch (err) {
              deps.log(`lane notice for ${userId} in chat ${chatId} not delivered: ${String(err)}`)
            }
          }
          deps.log(`lane notice ${e.notice} for ${userId} attempted in ${(e.chatIds ?? []).length} chat(s)`)
        } else {
          await sinks.report(userId, e.event as 'lane_busy' | 'lane_stopped' | 'lane_failed')
          deps.log(`lane ${e.event} reported for ${userId}`)
        }
        handled += 1
      } catch (err) {
        deps.log(`lane event ${e.event} for ${userId} not delivered: ${err instanceof Error ? err.message : String(err)}`)
        if (e.event === 'notice' && ['sharing_update', 'shell_refused', 'owner_mcp_refused'].includes(e.notice ?? '')) {
          try { fs.appendFileSync(eventsPath, laneEventLine(e), { mode: 0o600 }) } catch (retryError) {
            deps.log(`lane notice for ${userId} could not be kept: ${String(retryError)}`)
          }
        }
      }
    }
  }
  return handled
}

/** Explicit supervisor inputs, including login entries for locked inherit lanes. */
export const SUPERVISOR_ENV_KEEP = Object.freeze([
  ...LANE_ENV_KEEP, ...LANE_ENV_KEEP_WIN32,
  'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
  ...LANE_LOGIN_ENV, ...LANE_LOGIN_CONFIG_ENV,
])

export function supervisorEnv(ownerEnv: Record<string, string | undefined>, backendUrl: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of SUPERVISOR_ENV_KEEP) {
    const value = ownerEnv[name]
    if (typeof value === 'string') env[name] = value
  }
  env.BGOS_BACKEND_URL = backendUrl
  return env
}
