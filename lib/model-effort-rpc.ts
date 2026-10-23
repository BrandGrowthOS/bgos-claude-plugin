/**
 * model_effort_rpc: the owner's model and effort picker asks this daemon what
 * its session runs and changes it (Route A). The transaction is
 * lib/model-effort-control.ts; this file is the wire contract around it, the
 * lib/changes-rpc.ts shape with the owner rule of lib/daemon-command-sender.ts.
 *
 * THE WIRE (assumed for BGOS #3060; its DTO was not readable from this
 * worktree, see RESULT.md). The backend emits to the pairing room
 *
 *   model_effort_rpc {
 *     rpcId, op: 'describe' | 'set_model' | 'set_effort', assistantId,
 *     chatId, chatKind, value,
 *     sender: { userId, relationship }, isSharedRecipient, shareOwnerUserId
 *   }
 *
 * where `value` is a family alias for set_model (opus, sonnet, haiku, fable)
 * or a level for set_effort (low, medium, high, xhigh, max). Never a slash
 * command and never text: the control looks the value up in a frozen table
 * and refuses anything else. The answer goes to
 * POST integrations/model-effort-rpc/:rpcId/result as
 *
 *   { ok: true, payload: { applied, report } }
 *   { ok: false, error: { code, message }, payload: { report } }
 *
 * with `report` the true state now (lib/model-effort-catalog.ts
 * ModelEffortReport, or null when the session has reported nothing), and the
 * confirmed model and effort are also written through the EXISTING session
 * settings rail, PATCH integrations/assistants/:assistantId/chats/:chatId/
 * session-settings, so the app's pill shows what really runs.
 *
 * The rules, in order:
 *  1. A frame with no rpcId cannot be answered, so it is dropped.
 *  2. A frame for another agent gets nothing: several daemons can share one
 *     pairing room, and the first result wins.
 *  3. A re sent frame never types twice. The ids of the last 256 frames are
 *     remembered: an id still running is ignored, an id already answered is
 *     answered again from memory for RESULT_HOLD_MS.
 *  4. The sender must be provably the OWNER (readSlashSender and
 *     isOwnerSender, the daemon command rule): a share recipient, a malformed
 *     sender and a frame naming nobody are refused before the control runs.
 *     One session serves every chat of the agent, so a recipient changing the
 *     model would change the owner's.
 *  5. Only a main chat (an absent kind reads as main, the backend's own
 *     rule): the session settings rail admits nothing else.
 *  6. A result is ALWAYS posted; a throw answers control_failed.
 */

import { isOwnerSender, readSlashSender } from './daemon-command-sender.ts'
import type { ControlOutcome, ControlRequest } from './model-effort-control.ts'
import type { ModelEffortReport } from './model-effort-catalog.ts'

export const MODEL_EFFORT_RPC_EVENT = 'model_effort_rpc'

/** The BGOS report route's own patterns (backend report-session-settings.dto.ts). */
export const SESSION_REPORT_MODEL_PATTERN = /^[\w./:-]{1,160}$/
export const SESSION_REPORT_EFFORT_PATTERN = /^[a-z]{1,20}$/

const REMEMBERED_IDS = 256
const RESULT_HOLD_MS = 60_000

export type ModelEffortRpcFrame = {
  rpcId: string
  op: unknown
  assistantId: string
  chatId: string
  chatKind: string | null
  value: unknown
  /** The frame itself, read for the sender fields only. */
  senderPayload: Record<string, unknown>
}

export type ModelEffortRpcResult =
  | { ok: true; payload: { applied: boolean; report: ModelEffortReport } }
  | { ok: false; error: { code: string; message: string }; payload?: { report: ModelEffortReport | null } }

export type SessionSettingsBody = {
  model: string
  effort: string | null
  serviceTier: null
  rerouted: false
  reportedAt: string
}

export function normalizeModelEffortRpc(payload: unknown): ModelEffortRpcFrame | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  const rpcId = typeof p.rpcId === 'string' ? p.rpcId.trim() : ''
  if (rpcId === '' || rpcId.length > 128) return null
  return {
    rpcId,
    op: p.op,
    assistantId: p.assistantId == null ? '' : String(p.assistantId),
    chatId: p.chatId == null ? '' : String(p.chatId),
    chatKind: typeof p.chatKind === 'string' ? p.chatKind : null,
    value: p.value,
    senderPayload: p,
  }
}

/** The session settings body for a report, or null when the route would refuse it. */
export function sessionSettingsBody(report: ModelEffortReport | null, nowMs: number): SessionSettingsBody | null {
  if (!report || !SESSION_REPORT_MODEL_PATTERN.test(report.model)) return null
  const effort = report.effort !== null && SESSION_REPORT_EFFORT_PATTERN.test(report.effort) ? report.effort : null
  return { model: report.model, effort, serviceTier: null, rerouted: false, reportedAt: new Date(nowMs).toISOString() }
}

export type ModelEffortRpcDeps = {
  assistantId: () => string
  ownerUserId: () => string
  control: { handle: (request: ControlRequest) => Promise<ControlOutcome> }
  postResult: (rpcId: string, body: ModelEffortRpcResult) => Promise<unknown>
  reportSettings: (chatId: string, body: SessionSettingsBody) => Promise<unknown>
  log: (msg: string) => void
  now: () => number
}

function refusal(code: string, message: string): ModelEffortRpcResult {
  return { ok: false, error: { code, message } }
}

export class ModelEffortRpcHandler {
  private readonly running = new Set<string>()
  private readonly answered = new Map<string, { body: ModelEffortRpcResult; atMs: number }>()
  private readonly seen: string[] = []

  constructor(private readonly deps: ModelEffortRpcDeps) {}

  async handle(frame: ModelEffortRpcFrame): Promise<void> {
    const own = this.deps.assistantId()
    if (own === '' || frame.assistantId !== own) return
    if (this.running.has(frame.rpcId)) return
    const held = this.answered.get(frame.rpcId)
    if (held) {
      if (this.deps.now() - held.atMs <= RESULT_HOLD_MS) await this.post(frame.rpcId, held.body)
      return
    }
    if (this.seen.includes(frame.rpcId)) return
    this.remember(frame.rpcId)
    this.running.add(frame.rpcId)
    let body: ModelEffortRpcResult
    try {
      body = await this.answer(frame)
    } catch (err) {
      this.deps.log(`model_effort_rpc: control failed (${err instanceof Error ? err.name : 'error'})`)
      body = refusal('control_failed', 'The daemon could not run that request.')
    } finally {
      this.running.delete(frame.rpcId)
    }
    this.answered.set(frame.rpcId, { body, atMs: this.deps.now() })
    await this.post(frame.rpcId, body)
  }

  private async answer(frame: ModelEffortRpcFrame): Promise<ModelEffortRpcResult> {
    if (!isOwnerSender(readSlashSender(frame.senderPayload), this.deps.ownerUserId())) {
      this.deps.log(`model_effort_rpc: refused not_owner (rpc ${frame.rpcId})`)
      return refusal('not_owner', 'Only the agent\'s owner can change its model and effort.')
    }
    if (frame.chatKind !== null && frame.chatKind !== 'main') {
      return refusal('not_main_chat', 'The model and effort are changed from the agent\'s main chat only.')
    }
    const outcome = await this.deps.control.handle({ op: frame.op, value: frame.value })
    const report = outcome.report
    const settings = sessionSettingsBody(report, this.deps.now())
    if (settings && frame.chatId !== '') {
      await this.deps.reportSettings(frame.chatId, settings).catch((err) => {
        this.deps.log(`model_effort_rpc: session settings report failed: ${err}`)
      })
    }
    if (outcome.ok) return { ok: true, payload: { applied: outcome.applied, report: outcome.report } }
    return { ok: false, error: { code: outcome.code, message: outcome.message }, payload: { report } }
  }

  private remember(rpcId: string): void {
    this.seen.push(rpcId)
    while (this.seen.length > REMEMBERED_IDS) {
      const old = this.seen.shift()!
      this.answered.delete(old)
    }
  }

  private async post(rpcId: string, body: ModelEffortRpcResult): Promise<void> {
    try {
      await this.deps.postResult(rpcId, body)
    } catch (err) {
      this.deps.log(`model_effort_rpc: result post failed (rpc ${rpcId}): ${err}`)
    }
  }
}
