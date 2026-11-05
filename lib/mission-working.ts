/** Hook-driven leases for goals explicitly selected by set_goal_working.
 * The daemon supplies transport and only forwards admitted hook events.
 * Queues follow backend goals, so an old session cannot clear its successor.
 */
export const MISSION_WORKING_REFRESH_MS = 3 * 60_000
export const MISSION_WORKING_IDLE_MS = 15 * 60_000
export const MISSION_WORKING_SWEEP_MS = 30_000
const CLEAR_RETRY_MAX_MS = 10 * 60_000

export interface WorkingScope {
  sessionId: string
  missionId: number
  goalId: number
  headers: Record<string, string>
}

export interface WorkingContext {
  readonly sessionId: string
  readonly startedAt: number
  isCurrent(): boolean
  stoppedAt(): number | null
}

type Entry = {
  scope: WorkingScope
  generation?: string
  ownerSession: string
  wanted: boolean
  marked: boolean
  uncertain: boolean
  lastActivity: number
  selectedAt: number
  boundaryAt: number
  suspended: boolean
  clearRequested: boolean
  lastAttempt: number
  clearRetryAt: number
  clearRetryDelay: number
  pending: number
  tail: Promise<unknown>
}

export function createMissionWorkingTracker(opts: {
  patch(scope: WorkingScope, working: boolean): Promise<unknown>
  now?: () => number
  isArmed(): boolean
  hasAuthority?(): boolean
  hasUnconfirmedWrite?(scope: WorkingScope): boolean
  generation?: { read(scope: WorkingScope): string; advance(scope: WorkingScope): string }
  withWriteLock?<T>(work: () => Promise<T>, scope: WorkingScope, working: boolean): Promise<T>
  onMission?(mission: unknown): void
}) {
  const now = opts.now ?? Date.now
  const withWriteLock = opts.withWriteLock ?? (<T>(work: () => Promise<T>) => work())
  const entries = new Map<string, Entry>()
  const contexts = new Set<{ sessionId: string; startedAt: number; live: boolean }>()
  const boundaries = new Map<string, { at: number; event: unknown }>()
  let authorityEpoch = 0
  const capture = (sessionId: string): WorkingContext => {
    const token = { sessionId, startedAt: now(), live: true }
    const admittedBoundary = boundaries.get(sessionId)
    contexts.add(token)
    return { sessionId, startedAt: token.startedAt, isCurrent: () => token.live,
      stoppedAt: () => admittedBoundary?.event === 'Stop' ? admittedBoundary.at : null,
    }
  }
  const invalidate = (sessionId: string | null, at: number) => {
    for (const token of contexts) {
      if ((sessionId === null || token.sessionId === sessionId) && token.startedAt <= at) {
        token.live = false
        contexts.delete(token)
      }
    }
  }
  const keyOf = (scope: WorkingScope) => JSON.stringify([scope.missionId, scope.goalId])
  const finalRefusal = (error: unknown) => [400, 403, 404, 409].includes((error as { status?: number } | null)?.status ?? 0) ||
    (error as { workingWriteFenced?: boolean } | null)?.workingWriteFenced === true
  const retire = (entry: Entry) => { entry.wanted = false; entry.marked = false; entry.uncertain = false; entry.clearRequested = false }
  const enqueue = <T>(entry: Entry, work: () => Promise<T>): Promise<T> => {
    entry.pending++
    const next = entry.tail.then(work).finally(() => { entry.pending-- })
    // An explicit call may reject to its caller; the queue must still drain.
    entry.tail = next.catch(() => {})
    return next
  }
  const write = async (entry: Entry, working: boolean, scope = entry.scope, check?: () => void) => {
    const epoch = authorityEpoch
    try {
      return await withWriteLock(async () => {
        // Recheck after acquiring the cross-daemon gate, not before waiting for it.
        try {
          // Fresh unbound tool intent remains available in passive daemons.
          // Automatic work has no admission check and still needs authority.
          const manual = !!check && !scope.sessionId
          if (epoch !== authorityEpoch || (!manual && opts.hasAuthority && !opts.hasAuthority())) {
            retire(entry)
            throw new Error('The daemon no longer owns this pairing.')
          }
          check?.()
          // A hook can wait behind another daemon's write. Stop or an idle
          // interval during that wait must cancel a refresh before it sends.
          if (!check && working && (!entry.wanted || entry.suspended || !opts.isArmed() ||
            now() - entry.lastActivity >= MISSION_WORKING_IDLE_MS)) return
          const generation = opts.generation?.read(scope)
          // A manual clear cannot settle an older remote write that may
          // still land. Its independent receipt keeps cleanup necessary.
          const unresolved = !working && opts.hasUnconfirmedWrite?.(scope)
          if (!check && entry.generation !== generation && !unresolved) {
            retire(entry)
            return
          }
          // Only success may replace an existing selection's generation.
          entry.generation ??= generation
        } catch (error) {
          throw Object.assign(error as Error, { workingWriteNotSent: true })
        }
        entry.scope = scope
        if (working) {
          entry.lastAttempt = now()
          // A lost response is not a confirmed selection, but its write may land.
          entry.uncertain = true
        }
        const result = await opts.patch(scope, working)
        if (check) entry.generation = opts.generation?.advance(scope)
        if (epoch !== authorityEpoch) {
          retire(entry)
          return result
        }
        entry.marked = working
        entry.uncertain = !working && !!opts.hasUnconfirmedWrite?.(scope)
        if (entry.uncertain) {
          entry.wanted = false
          entry.clearRetryAt = now() + entry.clearRetryDelay
          entry.clearRetryDelay = Math.min(entry.clearRetryDelay * 2, CLEAR_RETRY_MAX_MS)
        } else {
          entry.clearRetryAt = 0
          entry.clearRetryDelay = MISSION_WORKING_SWEEP_MS
        }
        const mission = (result as { mission?: unknown } | null)?.mission
        if (mission) {
          try { opts.onMission?.(mission) } catch { /* bookkeeping cannot lose a landed write */ }
        }
        return result
      }, scope, working)
    } catch (error) {
      if (epoch !== authorityEpoch) {
        retire(entry)
      } else if ((error as { workingWriteFenced?: boolean } | null)?.workingWriteFenced && opts.hasUnconfirmedWrite?.(scope)) {
        entry.wanted = false
        entry.uncertain = true
      } else if (finalRefusal(error)) {
        retire(entry)
      } else if (!working) {
        // Reserve failed clear attempts across both sweeps and hook bursts.
        entry.clearRetryAt = now() + entry.clearRetryDelay
        entry.clearRetryDelay = Math.min(entry.clearRetryDelay * 2, CLEAR_RETRY_MAX_MS)
      }
      throw error
    }
  }
  const maintain = (entry: Entry, refresh = true, stopping = false) => enqueue(entry, async () => {
    if (!stopping && !opts.isArmed()) return
    // Stop suspends a confirmed lease without losing knowledge of it. An
    // explicit clear or an unknown write still carries a cleanup obligation.
    if (!stopping && entry.suspended && !entry.clearRequested && !entry.uncertain) return
    const busy = entry.wanted && !entry.suspended && now() - entry.lastActivity < MISSION_WORKING_IDLE_MS
    try {
      if (!busy) {
        // Stand-down removes the sweep timer, so give its final clear a
        // chance even when an earlier failure reserved a retry window.
        if ((entry.marked || entry.uncertain) && (stopping || now() >= entry.clearRetryAt)) await write(entry, false)
      } else if (refresh && now() - entry.lastAttempt >= MISSION_WORKING_REFRESH_MS) {
        await write(entry, true)
      }
    } catch {
      // Never emit the error: an upstream response can contain private data.
    }
  })
  const sweep = async (stopping = false) => {
    await Promise.all([...entries.values()].map(entry => maintain(entry, false, stopping)))
    for (const [key, entry] of entries) {
      if (!entry.wanted && !entry.marked && !entry.uncertain && entry.pending === 0) entries.delete(key)
    }
  }

  return {
    /** Capture once at tool admission, before mission lookup or any goal write. */
    capture,
    /** Explicit writes are not throttled. Only successful choices are kept.
     * Register before awaiting so a simultaneous boundary invalidates the call.
     */
    async mark(input: WorkingScope & { working: boolean; context?: WorkingContext }): Promise<unknown> {
      const scope: WorkingScope = { sessionId: input.sessionId, missionId: input.missionId, goalId: input.goalId, headers: { ...input.headers } }
      const context = input.context ?? capture(scope.sessionId)
      const check = () => {
        if (!context.isCurrent() || context.sessionId !== scope.sessionId) throw new Error('The session ended before this working mark could be sent.')
      }
      check()
      const key = keyOf(scope)
      let entry = entries.get(key)
      if (!entry) {
        entry = { scope, ownerSession: scope.sessionId, wanted: false, marked: false, uncertain: false, lastActivity: now(), selectedAt: context.startedAt, boundaryAt: context.startedAt, suspended: false, clearRequested: false, lastAttempt: -Infinity, clearRetryAt: 0, clearRetryDelay: MISSION_WORKING_SWEEP_MS, pending: 0, tail: Promise.resolve() }
        entries.set(key, entry)
      }
      const held = entry
      return enqueue(held, async () => {
        check()
        const previousScope = held.scope
        // A failed reselection must not erase a previously confirmed choice.
        // Explicit deselection takes effect even if its clear needs a retry.
        if (!input.working) { held.wanted = false; held.clearRequested = true }
        try {
          const result = await write(held, input.working, scope, check)
          if (context.isCurrent()) {
            const stoppedAt = context.stoppedAt()
            held.ownerSession = scope.sessionId
            held.selectedAt = context.startedAt
            held.boundaryAt = stoppedAt ?? context.startedAt
            held.suspended = stoppedAt !== null
            held.clearRequested = !input.working
            held.marked = input.working
            held.wanted = !!scope.sessionId && input.working && !!(result as { mission?: unknown } | null)?.mission
            // A successful manual write replaces old cleanup without becoming
            // owned by a session that has not bound to the intake yet.
            if (!scope.sessionId) held.marked = false
            held.lastActivity = now()
          } else if (held.wanted && held.ownerSession === scope.sessionId) {
            held.scope = previousScope
          } else {
            // A boundary-invalidated choice cannot be adopted after its
            // PATCH lands. Keep its cleanup even if a later Stop arrived.
            held.wanted = false
            held.ownerSession = scope.sessionId
            held.suspended = false
            held.clearRequested = true
            if (held.marked && opts.isArmed()) {
              try { await write(held, false, scope) } catch { /* sweep retries */ }
            }
          }
          return result
        } catch (error) {
          if (held.wanted) {
            held.scope = previousScope
          }
          throw error
        }
      })
    },
    /** Daemon callers fire and forget; transport work never holds a hook. */
    async onHook(payload: Record<string, unknown>, at = now()): Promise<void> {
      const sessionId = String(payload.session_id ?? '')
      const event = payload.hook_event_name
      const stop = event === 'Stop'
      const end = event === 'SessionEnd'
      const prompt = event === 'UserPromptSubmit'
      const tool = event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure'
      if (!sessionId || (!stop && !end && !prompt && !tool)) return
      if (stop || end || prompt) {
        const previous = boundaries.get(sessionId)
        if (!previous || at >= previous.at) boundaries.set(sessionId, { at, event })
        invalidate(sessionId, at)
      }
      const work: Promise<unknown>[] = []
      for (const entry of entries.values()) {
        if (entry.ownerSession !== sessionId) continue
        if (at < entry.selectedAt || at < entry.boundaryAt) continue
        if (stop) {
          entry.boundaryAt = at
          entry.suspended = true
          // Keep the explicit choice for the next prompt. Confirmed marks
          // lapse; explicit clears and unknown writes retain their cleanup.
        } else if (end) {
          entry.boundaryAt = at
          entry.suspended = false
          entry.clearRequested = true
          entry.wanted = false
        } else {
          if (prompt) {
            entry.boundaryAt = at
            entry.suspended = false
          } else if (entry.suspended) continue
          // A delayed spool line cannot make a silent/dead session look busy.
          entry.lastActivity = Math.max(entry.lastActivity, Math.min(at, now()))
        }
        work.push(maintain(entry))
      }
      await Promise.all(work)
    },
    sweep: () => sweep(),
    async stop(): Promise<void> {
      invalidate(null, Infinity)
      const lostAuthority = opts.hasAuthority && !opts.hasAuthority()
      if (lostAuthority) authorityEpoch++
      for (const entry of entries.values()) {
        entry.wanted = false
        entry.clearRequested = true
        // Losing a spell retires local ownership even if the file queue is
        // unavailable. A later re-arm must not revive its cleanup.
        if (lostAuthority) retire(entry)
      }
      // Stand-down disarms the channel before stopping intake. Only this
      // final cleanup may clear confirmed marks after authority is disabled.
      await sweep(true)
    },
  }
}
