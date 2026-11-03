/** Hook-driven leases for goals explicitly selected by set_goal_working.
 * The daemon supplies transport and only forwards admitted hook events.
 * Queues follow backend goals, so an old session cannot clear its successor.
 */
export const MISSION_WORKING_REFRESH_MS = 10 * 60_000
export const MISSION_WORKING_IDLE_MS = 15 * 60_000
export const MISSION_WORKING_SWEEP_MS = 30_000

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
}

type Entry = {
  scope: WorkingScope
  ownerSession: string
  wanted: boolean
  marked: boolean
  uncertain: boolean
  lastActivity: number
  selectedAt: number
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
  withWriteLock?<T>(work: () => Promise<T>, scope: WorkingScope, working: boolean): Promise<T>
  onMission?(mission: unknown): void
}) {
  const now = opts.now ?? Date.now
  const withWriteLock = opts.withWriteLock ?? (<T>(work: () => Promise<T>) => work())
  const entries = new Map<string, Entry>()
  const contexts = new Set<{ sessionId: string; startedAt: number; live: boolean }>()
  let authorityEpoch = 0
  const capture = (sessionId: string): WorkingContext => {
    const token = { sessionId, startedAt: now(), live: true }
    contexts.add(token)
    return { sessionId, startedAt: token.startedAt, isCurrent: () => token.live }
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
  const retire = (entry: Entry) => { entry.wanted = false; entry.marked = false; entry.uncertain = false }
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
          if (epoch !== authorityEpoch || (opts.hasAuthority && !opts.hasAuthority())) {
            retire(entry)
            throw new Error('The daemon no longer owns this pairing.')
          }
          check?.()
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
        if (epoch !== authorityEpoch) {
          retire(entry)
          return result
        }
        entry.marked = working
        entry.uncertain = !working && !!opts.hasUnconfirmedWrite?.(scope)
        if (entry.uncertain) {
          entry.wanted = false
          entry.clearRetryAt = now() + entry.clearRetryDelay
          entry.clearRetryDelay = Math.min(entry.clearRetryDelay * 2, MISSION_WORKING_REFRESH_MS)
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
        entry.clearRetryDelay = Math.min(entry.clearRetryDelay * 2, MISSION_WORKING_REFRESH_MS)
      }
      throw error
    }
  }
  const maintain = (entry: Entry, refresh = true, stopping = false) => enqueue(entry, async () => {
    if (!stopping && !opts.isArmed()) return
    const busy = entry.wanted && now() - entry.lastActivity < MISSION_WORKING_IDLE_MS
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
     * Register before awaiting so a simultaneous Stop can queue its clear.
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
        entry = { scope, ownerSession: scope.sessionId, wanted: false, marked: false, uncertain: false, lastActivity: now(), selectedAt: context.startedAt, lastAttempt: -Infinity, clearRetryAt: 0, clearRetryDelay: MISSION_WORKING_SWEEP_MS, pending: 0, tail: Promise.resolve() }
        entries.set(key, entry)
      }
      const held = entry
      return enqueue(held, async () => {
        check()
        const previousScope = held.scope
        // A failed reselection must not erase a previously confirmed choice.
        // Explicit deselection takes effect even if its clear needs a retry.
        if (!input.working) held.wanted = false
        try {
          const result = await write(held, input.working, scope, check)
          if (context.isCurrent()) {
            held.ownerSession = scope.sessionId
            held.selectedAt = context.startedAt
            held.wanted = !!scope.sessionId && input.working && !!(result as { mission?: unknown } | null)?.mission
            // A successful manual write replaces old cleanup without becoming
            // owned by a session that has not bound to the intake yet.
            if (!scope.sessionId) held.marked = false
            held.lastActivity = now()
          } else if (held.wanted) {
            held.scope = previousScope
          } else if (held.marked && opts.isArmed()) {
            // A different session's pending choice may have stopped while
            // this HTTP request was in flight, before it owned the entry.
            try { await write(held, false, scope) } catch { /* sweep retries */ }
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
      const stop = event === 'Stop' || event === 'SessionEnd' || event === 'UserPromptSubmit'
      const tool = event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure'
      if (!sessionId || (!stop && !tool)) return
      if (stop) invalidate(sessionId, at)
      const work: Promise<unknown>[] = []
      for (const entry of entries.values()) {
        if (entry.ownerSession !== sessionId) continue
        if (stop && at < entry.selectedAt) continue
        if (stop) {
          entry.wanted = false
        } else {
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
