/**
 * update_rpc frame handler: the plugin side of one-click updates (wire
 * contract v1, BrandGrowthOS/BGOS branch design/one-click-plugin-update,
 * docs/handoff/one-click-plugin-update/wire-contract.md).
 *
 * The backend pushes `update_rpc {rpcId, op}` frames to the pairing:<id>
 * room. The frame carries NOTHING beyond the rpc id and the op name: no
 * version, no url, no script, ever. The daemon resolves what to install
 * from its own pinned source (SelfUpdater's origin/main inspection, with
 * the same-major gate, dirty-tree brake, checkout lock, and rollback
 * latches all staying authoritative), so a compromised backend cannot
 * point an update anywhere.
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
 * Completion truth stays with the backend: only a heartbeat from this same
 * pairing carrying the new daemonVersion flips 'done'. This handler never
 * fakes success, and the daemon NEVER exits itself: restart is always an
 * external authority (kc-server invariant, lib/self-update.ts).
 */

import type { UpdateNowOutcome } from './self-update.js'
import type { RestartAuthority } from './update-readiness.js'

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

export interface UpdateRpcDeps {
  postAck: (rpcId: string) => Promise<unknown>
  postProgress: (rpcId: string, body: Record<string, unknown>) => Promise<unknown>
  log: (msg: string) => void
  installMethod: () => 'marketplace' | 'clone'
  autoUpdateEnabled: () => boolean
  updater: () => TriggeredUpdater | null
  restartAuthority: () => RestartAuthority
  spawnDetached: (file: string, args: string[]) => void
  writeMarker: (path: string) => boolean
  setDrainMode: (enabled: boolean) => void
  requestHeartbeat: () => void
}

/** Bounded dedupe memory; updates are rare (the backend enforces a 60s
 *  per-pairing cooldown), so a small FIFO cap is plenty. */
const HANDLED_RPC_CAP = 200

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
      await this.progress(frame.rpcId, { stage: 'error', message: errText(err) })
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
    return this.progress(rpcId, { stage: 'error', message })
  }

  private async updateNow(rpcId: string): Promise<void> {
    if (this.deps.installMethod() === 'marketplace') {
      // v1: the marketplace cache is not a git checkout, so SelfUpdater
      // cannot apply there; the app shows the manual update path instead.
      return this.fail(rpcId, 'marketplace_install_manual_update')
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
        // updateNow restored intake itself unless the checkout latched
        // drained (that state deliberately stays drained, exactly like a
        // failed scheduled run).
        return this.fail(rpcId, outcome.message)
      }
      targetVersion = outcome.targetVersion
    }

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
