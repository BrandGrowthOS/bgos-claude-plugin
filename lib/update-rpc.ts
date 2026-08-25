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
 *                                          always-on service, or the hoai
 *                                          launcher's supervise loop)
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
import type { RestartAuthority } from './update-readiness.js'
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
  setDrainMode: (enabled: boolean) => void
  requestHeartbeat: () => void
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

export class UpdateRpcHandler {
  private readonly deps: UpdateRpcDeps
  /** rpcId dedupe. Unlike voice_rpc's in-flight set, entries SURVIVE
   *  completion: a re-emitted frame arriving after 'restarting' must never
   *  start a second update of the same request. */
  private readonly handled = new Set<string>()

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
   * The restart ladder (wire contract v1 section 3), shared by both
   * install methods: service restart > launcher marker > staged. The
   * update is on disk; only how this process gets replaced differs.
   */
  private async restartLadder(rpcId: string, targetVersion: string | null): Promise<void> {
    const versionField = targetVersion ? { targetVersion } : {}
    const authority = this.deps.restartAuthority()
    if (authority.kind === 'service') {
      // Progress FIRST: the detached restart kills this very process, and a
      // 'restarting' the backend never received would read as unreachable.
      await this.progress(rpcId, { stage: 'restarting', ...versionField })
      this.deps.log(
        `update_rpc: triggering detached service restart (${authority.command.file} ${authority.command.args.join(' ')})`,
      )
      this.deps.spawnDetached(authority.command.file, authority.command.args)
      // Drain stays on: no new work between now and the restart.
      return
    }
    if (authority.kind === 'launcher') {
      await this.progress(rpcId, { stage: 'restarting', ...versionField })
      if (this.deps.writeMarker(authority.markerPath)) {
        this.deps.log(
          `update_rpc: restart marker written for the hoai launcher (${authority.markerPath})`,
        )
        return
      }
      this.deps.log('update_rpc: could not write the restart marker; staging instead')
    }
    // No restart authority: NEVER exit. Keep serving the old code; 'staged'
    // is daemon-terminal and the immediate heartbeat carries
    // pendingRestartVersion so the app can show restart_pending.
    this.deps.setDrainMode(false)
    await this.progress(rpcId, { stage: 'staged', ...versionField })
    this.deps.requestHeartbeat()
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
