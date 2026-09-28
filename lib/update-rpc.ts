/**
 * update_rpc frame handler: the plugin side of one-click updates (wire
 * contract v1, BrandGrowthOS/BGOS branch design/one-click-plugin-update,
 * docs/handoff/one-click-plugin-update/wire-contract.md).
 *
 * The backend pushes `update_rpc {rpcId, op}` frames to the pairing:<id>
 * room. The frame carries NOTHING beyond the rpc id and the op name: no
 * version, no url, no script, ever. The daemon resolves what to install
 * from its own pinned source, so a compromised backend cannot point an
 * update anywhere:
 *
 *   clone installs        SelfUpdater's origin/main inspection, with the
 *                         same-major gate, dirty-tree brake, checkout lock,
 *                         and rollback latches all staying authoritative;
 *   marketplace installs  the shared planner + executor over the Claude
 *                         config dir (lib/marketplace-update.mjs, zero-
 *                         terminal lifecycle design 1.4), intent 'update',
 *                         agents = [this daemon]. This used to be a dead
 *                         end (`marketplace_install_manual_update`).
 *
 * Lifecycle (the DoctorRpcService posture): ack immediately over REST
 * (suppresses the backend's 1.5s re-emit), then report progress stages:
 *
 *   draining -> installing -> restarting   a restart authority exists (an
 *                                          always-on service, the hoai
 *                                          launcher's supervise loop, or a
 *                                          live keepalive script whose session
 *                                          is signalled)
 *   draining -> installing -> staged       no authority: the update is on
 *                                          disk, the daemon keeps serving,
 *                                          and pendingRestartVersion rides
 *                                          the next heartbeat
 *   error <message>                        terminal, always descriptive
 *
 * Marketplace runs report every planner/executor step as an `installing`
 * stage whose `message` is the step kind token (register_marketplace,
 * refresh_marketplace, install_plugin, update_plugin, reinstall_plugin,
 * verify_installed, rollback); a failure is `error <failedStep.kind>:<token>`
 * with the scrubbed diagnostics bundle posted to the P3 intake.
 *
 * Drain is bounded (UPDATE_DRAIN_TIMEOUT_MS, lib/self-update.ts). A clone
 * update that times out un-drains and fails `drain_timeout` (it would
 * rewrite the directory this process runs from). A marketplace update
 * proceeds with `installing drain_timeout_proceeding`: the install lands in
 * a different versioned cache directory and the running code is in memory.
 * Either way the daemon is never left muted: after every terminal outcome
 * except a real `restarting`, the last drain call is setDrainMode(false).
 *
 * Two guards added after the 2026-09-11 forced update muted 9 of 21 daemons
 * (each reported 'restarting', drained, and sat deaf for 50 minutes because
 * its declared launchd job was a keepalive SCRIPT that did not hold the
 * daemon's process, so the kickstart killed nothing):
 *   - ownership pre-flight: a service authority counts only when the job's
 *     main pid is an ancestor of this process (serviceOwnsProcess); otherwise
 *     it is `no_restart_authority` before any drain or pull, and the ladder
 *     stages rather than restarting through it;
 *   - un-drain watchdog: RESTART_WATCHDOG_MS after 'restarting', if this
 *     process is still running the restart did not arrive: drain off, error
 *     `restart_did_not_arrive` (terminal), heartbeat, loud log.
 *
 * Completion truth stays with the backend: only a heartbeat from this same
 * pairing carrying the new daemonVersion flips 'done'. This handler never
 * fakes success, and the daemon NEVER exits itself: restart is always an
 * external authority (kc-server invariant, lib/self-update.ts).
 */

import {
  decideDrainWait,
  UPDATE_DRAIN_POLL_MS,
  UPDATE_DRAIN_TIMEOUT_MS,
  type DrainSnapshot,
  type UpdateNowOutcome,
} from './self-update.js'
import {
  serviceOwnsProcess,
  type RestartAuthority,
  type RestartAuthorityService,
  type ServiceOwnershipReading,
} from './update-readiness.js'
import { failureToken } from './update-diagnostics.mjs'

export interface UpdateRpcFrame {
  rpcId: string
  op: 'update_now'
}

/**
 * Validate an update_rpc control frame. Only {rpcId, op:'update_now'} is
 * accepted; every other field is deliberately ignored (SECURITY: the frame
 * can never carry a version, a url, or a script). Malformed frames drop;
 * the backend's own ack timeout surfaces the failure as 'unreachable'.
 */
export function normalizeUpdateRpc(raw: unknown): UpdateRpcFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const rpcId = typeof r.rpcId === 'string' ? r.rpcId : ''
  if (!rpcId || r.op !== 'update_now') return null
  return { rpcId, op: 'update_now' }
}

export type UpdateRpcStage = 'draining' | 'installing' | 'restarting' | 'staged' | 'error'

export interface UpdateRpcProgress {
  stage: UpdateRpcStage
  targetVersion?: string
  message?: string
}

/** The SelfUpdater surface this handler needs (structural, so tests can
 *  fake it without a git checkout). */
export interface TriggeredUpdater {
  isRollbackLatched(): boolean
  pendingRestartVersion(): string | null
  updateNow(
    report: (stage: 'draining' | 'installing', targetVersion: string | null) => Promise<void>,
  ): Promise<UpdateNowOutcome>
}

/** One planner/executor step as lib/marketplace-update.mjs reports it. */
export interface MarketplaceStepReport {
  id: string
  kind: string
  state: string
  message?: string
  targetVersion?: string | null
}

export interface MarketplaceFailedStep {
  id: string
  kind: string
  message: string
}

/** What a marketplace run produced (lib/marketplace-update.mjs). */
export type MarketplaceUpdateOutcome =
  | { kind: 'installed'; targetVersion: string | null }
  | { kind: 'no-update'; latestVersion: string | null }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'failed'
      failedStep: MarketplaceFailedStep
      rolledBack: boolean
      diagnostics: Record<string, unknown> | null
    }

/** Step kinds that surface as `installing <kind>` progress. Snapshot and the
 *  agent restart/verify steps stay silent: the daemon's own ladder reports
 *  `restarting`/`staged` itself, and a snapshot is not something a person
 *  waits on. */
export const INSTALLING_STEP_KINDS: ReadonlySet<string> = new Set([
  'register_marketplace',
  'refresh_marketplace',
  'install_plugin',
  'update_plugin',
  'reinstall_plugin',
  'verify_installed',
  'rollback',
])

/** Progress message when a marketplace update proceeds past the drain deadline. */
export const DRAIN_TIMEOUT_PROCEEDING = 'drain_timeout_proceeding'

/** How long after 'restarting' this process may still be alive before the
 *  restart is declared missing. A real restart kills the process, and the
 *  timer with it; a service restart is delayed SELF_RESTART_DELAY_SECONDS and
 *  a marker relaunch is one supervisor poll away, so three minutes is
 *  generous, and a daemon deaf for three minutes beats one deaf for fifty. */
export const RESTART_WATCHDOG_MS = 3 * 60 * 1000

/** The terminal error the watchdog reports (wire contract v1.1 machine token). */
export const RESTART_DID_NOT_ARRIVE = 'restart_did_not_arrive'

/**
 * The rpc id a SCHEDULED restart runs under. There is no rpc: the nightly
 * update was not asked for by anyone, so there is no caller waiting on
 * progress. The ladder is shared with the clicked path, so it still wants an
 * id; this one means "report to the log, not to the backend".
 */
export const SCHEDULED_RESTART_RPC = 'scheduled-auto-update' 

/** The backend caps progress messages at 300 chars (design 2.2). */
export const PROGRESS_MESSAGE_MAX_CHARS = 300

export function clipProgressMessage(text: string): string {
  const value = String(text ?? '')
  return value.length > PROGRESS_MESSAGE_MAX_CHARS
    ? value.slice(0, PROGRESS_MESSAGE_MAX_CHARS)
    : value
}

export interface UpdateRpcDeps {
  postAck: (rpcId: string) => Promise<unknown>
  postProgress: (rpcId: string, body: Record<string, unknown>) => Promise<unknown>
  log: (msg: string) => void
  installMethod: () => 'marketplace' | 'clone'
  autoUpdateEnabled: () => boolean
  /** Clone installs: the SelfUpdater (null when not a git checkout). */
  updater: () => TriggeredUpdater | null
  /** Marketplace installs: plan + execute (lib/marketplace-update.mjs
   *  runMarketplaceUpdate over observeMarketplaceState, agents = [self]). */
  marketplaceUpdate: (
    report: (step: MarketplaceStepReport) => Promise<void>,
  ) => Promise<MarketplaceUpdateOutcome>
  /** The daemon's live drain counters, for the marketplace path's bounded drain. */
  drainSnapshot: () => DrainSnapshot
  restartAuthority: () => RestartAuthority
  spawnDetached: (file: string, args: string[]) => void
  writeMarker: (path: string) => boolean
  /** Send a signal to a pid on this host; false when it could not be
   *  delivered (gone already, or another user's). The keepalive authority's
   *  whole restart: SIGTERM the session, the script relaunches it. */
  signalProcess: (pid: number, signal: NodeJS.Signals) => boolean
  setDrainMode: (enabled: boolean) => void
  requestHeartbeat: () => void
  /** Ownership readings for a SERVICE authority: this process's pid ancestry
   *  and the job's main pid, raw (lib/update-readiness.ts
   *  probeServiceOwnership); the handler decides with serviceOwnsProcess. */
  serviceOwnership: (service: RestartAuthorityService) => ServiceOwnershipReading
  /** Watchdog timer: run `fn` after `ms`, return a cancel. Injectable so the
   *  suite fires it by hand; the default is an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => () => void
  /** P3 intake (lib/update-diagnostics.mjs postFailureDiagnostics); fire-and-forget. */
  postFailureDiagnostics?: (diagnostics: Record<string, unknown>) => Promise<unknown>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Bounded dedupe memory; updates are rare (the backend enforces a 60s
 *  per-pairing cooldown), so a small FIFO cap is plenty. */
const HANDLED_RPC_CAP = 200

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Unref'd: the watchdog must never be what keeps a dying process alive. */
function defaultSetTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export class UpdateRpcHandler {
  private readonly deps: UpdateRpcDeps
  /** rpcId dedupe. Unlike voice_rpc's in-flight set, entries SURVIVE
   *  completion: a re-emitted frame arriving after 'restarting' must never
   *  start a second update of the same request. */
  private readonly handled = new Set<string>()
  /** Cancel for the armed un-drain watchdog, if any (one at a time: a later
   *  restart supersedes an earlier one). */
  private cancelWatchdog: (() => void) | null = null

  constructor(deps: UpdateRpcDeps) {
    this.deps = deps
  }

  async handle(frame: UpdateRpcFrame): Promise<void> {
    if (!frame?.rpcId) return
    if (this.handled.has(frame.rpcId)) {
      // A re-emit means our ack may not have landed; re-ack, never re-run.
      this.deps.log(`update_rpc duplicate frame re-acked (rpc=${frame.rpcId})`)
      await this.ack(frame.rpcId)
      return
    }
    this.handled.add(frame.rpcId)
    if (this.handled.size > HANDLED_RPC_CAP) {
      const oldest = this.handled.values().next().value
      if (oldest !== undefined) this.handled.delete(oldest)
    }
    await this.ack(frame.rpcId)
    try {
      await this.updateNow(frame.rpcId)
    } catch (err) {
      // Fail closed but never silent: whatever broke, the backend gets a
      // terminal error and intake is restored so the daemon keeps serving.
      this.deps.setDrainMode(false)
      // Tokenized like every other failure: a raw fs error carries the home
      // path (and so the username) and this message leaves the machine.
      await this.progress(frame.rpcId, { stage: 'error', message: clipProgressMessage(`update_failed:${failureToken(errText(err))}`) })
    }
  }

  private async ack(rpcId: string): Promise<void> {
    try {
      await this.deps.postAck(rpcId)
    } catch (err) {
      // Non-fatal: the backend re-emits and the dedupe above re-acks.
      this.deps.log(`update_rpc ack failed (non-fatal, rpc=${rpcId}): ${errText(err)}`)
    }
  }

  /** Progress is reporting, never control flow: a failed POST is logged and
   *  the update continues (the backend's own timeouts cover a silent rpc). */
  private async progress(rpcId: string, body: UpdateRpcProgress): Promise<void> {
    if (rpcId === SCHEDULED_RESTART_RPC) {
      // Nobody asked, so there is nobody to answer. Posting would be a
      // progress report for an rpc the backend never issued.
      this.deps.log(`auto-update restart: ${body.stage}`)
      return
    }
    try {
      await this.deps.postProgress(rpcId, body as unknown as Record<string, unknown>)
    } catch (err) {
      this.deps.log(`update_rpc progress '${body.stage}' failed (rpc=${rpcId}): ${errText(err)}`)
    }
  }

  private fail(rpcId: string, message: string): Promise<void> {
    return this.progress(rpcId, { stage: 'error', message: clipProgressMessage(message) })
  }

  private async updateNow(rpcId: string): Promise<void> {
    if (this.deps.installMethod() === 'marketplace') {
      return this.marketplaceUpdateNow(rpcId)
    }
    if (!this.deps.autoUpdateEnabled()) {
      return this.fail(rpcId, 'updates_disabled')
    }
    const updater = this.deps.updater()
    if (!updater) {
      return this.fail(rpcId, 'updater_unavailable')
    }
    if (updater.isRollbackLatched()) {
      return this.fail(rpcId, 'rollback_latched')
    }

    // Pre-flight (one-click-update fix): a CLONE install we have no way to
    // restart into is limbo, not a stage. `git pull` swaps the checkout on
    // disk, but this long-lived process keeps the OLD code in memory until
    // something restarts it, and for a bespoke-launched clone daemon whose
    // supervisor never got declared, nothing will; the app then shows
    // restart-pending forever. So abort BEFORE draining or pulling: keep
    // serving the CURRENT version and report no_restart_authority, a loud,
    // recoverable failure the operator can act on (declare the launcher's
    // supervisor via BGOS_SUPERVISOR_*, or restart by hand). Marketplace
    // installs stage into a versioned cache the next launch picks up on its
    // own, so that path keeps its legitimate 'staged' outcome.
    const authority = this.deps.restartAuthority()
    if (authority.kind === 'staged') {
      return this.fail(rpcId, 'no_restart_authority')
    }
    // A service authority is only an authority when the job HOLDS this
    // process. Nine daemons were muted on 2026-09-11 by a kickstart at a
    // keepalive script that had never been their parent: the restart went
    // through, nothing died, and the drained daemon sat deaf. Refuse it here,
    // before any drain or pull, exactly like 'staged'.
    if (authority.kind === 'service' && !this.serviceOwnsUs(authority.service)) {
      return this.fail(rpcId, 'no_restart_authority')
    }

    let targetVersion = updater.pendingRestartVersion()
    if (targetVersion) {
      // An update is already installed and waiting for a restart; there is
      // nothing to pull, go straight to the restart ladder.
      this.deps.log(
        `update_rpc: ${targetVersion} is already installed and pending restart; running the restart ladder`,
      )
    } else {
      const outcome = await updater.updateNow(async (stage, version) => {
        await this.progress(rpcId, {
          stage,
          ...(version ? { targetVersion: version } : {}),
        })
      })
      if (outcome.kind === 'busy') return this.fail(rpcId, 'update_in_flight')
      if (outcome.kind === 'latched') return this.fail(rpcId, 'rollback_latched')
      if (outcome.kind === 'no-update') return this.fail(rpcId, 'no_update_available')
      if (outcome.kind === 'dirty-tree') return this.fail(rpcId, 'dirty_tree')
      if (outcome.kind === 'not-fast-forward') return this.fail(rpcId, 'not_fast_forward')
      if (outcome.kind === 'failed') {
        // updateNow restored intake itself (including on 'drain_timeout')
        // unless the checkout latched drained (that state deliberately
        // stays drained, exactly like a failed scheduled run).
        return this.fail(rpcId, outcome.message)
      }
      targetVersion = outcome.targetVersion
    }
    await this.restartLadder(rpcId, targetVersion)
  }

  /**
   * Marketplace installs: bounded drain, then the planner + executor run
   * (agents = [self]); the daemon's own ladder restarts afterwards. Every
   * terminal outcome except a real restart ends with setDrainMode(false).
   */
  private async marketplaceUpdateNow(rpcId: string): Promise<void> {
    if (!this.deps.autoUpdateEnabled()) {
      return this.fail(rpcId, 'updates_disabled')
    }
    await this.progress(rpcId, { stage: 'draining' })
    this.deps.setDrainMode(true)
    if ((await this.waitForDrain()) === 'timeout') {
      // The install lands in a different versioned cache directory and the
      // running code is in memory, so proceeding over live work is safe;
      // staying drained behind a wedged operation is not.
      this.deps.log(
        `update_rpc: intake did not drain within ${UPDATE_DRAIN_TIMEOUT_MS / 1000}s; proceeding (marketplace install)`,
      )
      await this.progress(rpcId, { stage: 'installing', message: DRAIN_TIMEOUT_PROCEEDING })
    }

    let outcome: MarketplaceUpdateOutcome
    try {
      outcome = await this.deps.marketplaceUpdate(async (step) => {
        if (step.state !== 'running' || !INSTALLING_STEP_KINDS.has(step.kind)) return
        await this.progress(rpcId, {
          stage: 'installing',
          message: step.kind,
          ...(step.targetVersion ? { targetVersion: step.targetVersion } : {}),
        })
      })
    } catch (err) {
      this.deps.setDrainMode(false)
      return this.fail(rpcId, errText(err))
    }

    if (outcome.kind === 'no-update') {
      this.deps.setDrainMode(false)
      return this.fail(rpcId, 'no_update_available')
    }
    if (outcome.kind === 'blocked') {
      this.deps.setDrainMode(false)
      return this.fail(rpcId, outcome.reason)
    }
    if (outcome.kind === 'failed') {
      this.deps.setDrainMode(false)
      const cause = `${outcome.failedStep.kind}:${failureToken(outcome.failedStep.message)}`
      this.deps.log(
        `update_rpc: marketplace update failed at ${outcome.failedStep.id} (${cause})` +
          `${outcome.rolledBack ? ', rolled back' : ''}: ${outcome.failedStep.message}`,
      )
      if (outcome.diagnostics) this.postDiagnostics(outcome.diagnostics)
      return this.fail(rpcId, cause)
    }
    await this.restartLadder(rpcId, outcome.targetVersion)
  }

  /** Bounded wait on the daemon's own counters (drain mode already on). */
  private async waitForDrain(): Promise<'ready' | 'timeout'> {
    const now = this.deps.now ?? Date.now
    const sleep = this.deps.sleep ?? defaultSleep
    const startedAt = now()
    while (true) {
      const decision = decideDrainWait({
        startedAt,
        now: now(),
        timeoutMs: UPDATE_DRAIN_TIMEOUT_MS,
        snapshot: this.deps.drainSnapshot(),
      })
      if (decision !== 'wait') return decision
      await sleep(UPDATE_DRAIN_POLL_MS)
    }
  }

  private postDiagnostics(diagnostics: Record<string, unknown>): void {
    const post = this.deps.postFailureDiagnostics
    if (!post) return
    try {
      void post(diagnostics).catch((err: unknown) => {
        this.deps.log(`update_rpc: failure diagnostics post failed (non-fatal): ${errText(err)}`)
      })
    } catch (err) {
      this.deps.log(`update_rpc: failure diagnostics post failed (non-fatal): ${errText(err)}`)
    }
  }

  /**
   * The restart ladder (wire contract v1 section 3), shared by both install
   * methods: keepalive signal > service restart > launcher marker > staged.
   * The update is on disk; only how this process gets replaced differs.
   *
   * The keepalive rung is first because it is the only one whose ownership was
   * PROVEN when the authority was resolved (a live script plus a pid-ancestry
   * walk, lib/update-readiness.ts resolveKeepalive); the service rung is a name
   * that is checked for ownership here, one rung later.
   */
  private async restartLadder(rpcId: string, targetVersion: string | null): Promise<boolean> {
    const versionField = targetVersion ? { targetVersion } : {}
    const authority = this.deps.restartAuthority()
    if (authority.kind === 'keepalive') {
      // The same mechanism five sessions were recovered with by hand on
      // 2026-09-13: SIGTERM the claude session and the keepalive script
      // relaunches it on the new version. Not the same SITUATION, though, and
      // the difference is the reason the watchdog below still matters: those
      // were signalled at an idle prompt, while an update rpc can land
      // mid-turn and take whatever claude was doing with it.
      // NEVER a kickstart here: the launchd job for these sessions IS the
      // keepalive script, and killing it restarts nothing while leaving the
      // daemon drained (the 2026-09-11 mute).
      // Progress FIRST: the signal kills this very process.
      await this.progress(rpcId, { stage: 'restarting', ...versionField })
      this.deps.log(
        `update_rpc: signalling the keepalive's session (SIGTERM pid ${authority.sessionPid}, ` +
          `keepalive pid ${authority.keepalivePid}` +
          `${authority.tmuxSession ? `, tmux ${authority.tmuxSession}` : ''})`,
      )
      if (this.deps.signalProcess(authority.sessionPid, 'SIGTERM')) {
        // Drain stays on: no new work between now and the relaunch. The
        // watchdog lifts it if the keepalive never brings the session back.
        this.armRestartWatchdog(rpcId)
        return true
      }
      this.deps.log(
        `update_rpc: could not signal the session (pid ${authority.sessionPid}); staging instead`,
      )
    }
    if (authority.kind === 'service' && this.serviceOwnsUs(authority.service)) {
      // Progress FIRST: the detached restart kills this very process, and a
      // 'restarting' the backend never received would read as unreachable.
      await this.progress(rpcId, { stage: 'restarting', ...versionField })
      this.deps.log(
        `update_rpc: triggering detached service restart (${authority.command.file} ${authority.command.args.join(' ')})`,
      )
      this.deps.spawnDetached(authority.command.file, authority.command.args)
      // Drain stays on: no new work between now and the restart. The
      // watchdog lifts it if the restart never comes.
      this.armRestartWatchdog(rpcId)
      return true
    }
    if (authority.kind === 'service') {
      // Re-resolved after the drain and the install: a job that does not hold
      // this process must never be kicked (the mute of 2026-09-11). Staging is
      // the safe outcome; the update is on disk for the next real restart.
      this.deps.log('update_rpc: staging instead of restarting through a job that does not own this process')
    }
    if (authority.kind === 'launcher') {
      await this.progress(rpcId, { stage: 'restarting', ...versionField })
      if (this.deps.writeMarker(authority.markerPath)) {
        this.deps.log(
          `update_rpc: restart marker written for the hoai launcher (${authority.markerPath})`,
        )
        this.armRestartWatchdog(rpcId)
        return true
      }
      this.deps.log('update_rpc: could not write the restart marker; staging instead')
    }
    // No restart authority: NEVER exit. Keep serving the old code; 'staged'
    // is daemon-terminal and the immediate heartbeat carries
    // pendingRestartVersion so the app can show restart_pending.
    this.deps.setDrainMode(false)
    await this.progress(rpcId, { stage: 'staged', ...versionField })
    this.deps.requestHeartbeat()
    return false
  }

  /**
   * Restart this process after a SCHEDULED (nightly) update, by exactly the
   * ladder a clicked update uses (KC, 2026-09-26: "our auto update of the
   * plugin is working but the restart is still manual").
   *
   * THE SAME LADDER ON PURPOSE. Every safety on this path was paid for by an
   * outage: the ownership pre-flight after 9 daemons were muted on 2026-09-11
   * by a kickstart at a job that never held them, and the refusal to exit
   * after 5 agents died overnight on 2026-08-06. A second implementation for
   * the nightly path would be a second place for those to be forgotten.
   *
   * Returns true when the ladder took the restart on (this process is expected
   * to die), false when it staged. A false is not a failure: it is the ladder
   * correctly refusing to act on an authority it cannot prove owns us, and the
   * caller then keeps serving the old code exactly as it does today.
   */
  async restartAfterScheduledUpdate(targetVersion: string | null): Promise<boolean> {
    return this.restartLadder(SCHEDULED_RESTART_RPC, targetVersion)
  }

  /** Is the job a service authority names actually holding this process?
   *  Pure decision over raw readings; a refusal logs the handle and both
   *  pids so the operator sees what was declared and what really holds us. */
  private serviceOwnsUs(service: RestartAuthorityService): boolean {
    const reading = this.deps.serviceOwnership(service)
    if (serviceOwnsProcess(reading.ancestorPids, reading.servicePid)) return true
    this.deps.log(
      `update_rpc: ${service.kind} job ${service.handle} does not own this process ` +
        `(job pid ${reading.servicePid ?? 'none'}, our pid ${reading.ownPid}, ` +
        `ancestry ${reading.ancestorPids.join(' > ') || 'unreadable'}); ` +
        'a restart addressed to it would not reach us, so it is no restart authority',
    )
    return false
  }

  /** Arm the un-drain watchdog after 'restarting'. A real restart kills this
   *  process, and the timer with it; if the timer fires we are still here. */
  private armRestartWatchdog(rpcId: string): void {
    this.cancelWatchdog?.()
    const setTimer = this.deps.setTimer ?? defaultSetTimer
    this.cancelWatchdog = setTimer(() => {
      this.cancelWatchdog = null
      void this.restartDidNotArrive(rpcId)
    }, RESTART_WATCHDOG_MS)
  }

  /** The restart never came: this process is still running the old code,
   *  drained. Lift the drain (the daemon must never be left deaf), report the
   *  terminal error, and heartbeat so the app shows restart_pending from
   *  pendingRestartVersion rather than a restart that is not happening. */
  private async restartDidNotArrive(rpcId: string): Promise<void> {
    this.deps.log(
      `update_rpc: RESTART DID NOT ARRIVE within ${RESTART_WATCHDOG_MS / 1000}s of 'restarting' (rpc=${rpcId}); ` +
        'this process is still running the OLD code. Un-draining so the daemon is not left deaf; ' +
        'the update stays on disk as pendingRestartVersion until something really restarts this process',
    )
    this.deps.setDrainMode(false)
    await this.progress(rpcId, { stage: 'error', message: RESTART_DID_NOT_ARRIVE })
    this.deps.requestHeartbeat()
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
