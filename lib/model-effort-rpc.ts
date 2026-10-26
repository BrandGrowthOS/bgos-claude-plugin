/**
 * The owner's model and effort picker on the BGOS wire (BGOS #3060, merged and
 * live, AUTHORITATIVE). The transaction is lib/model-effort-control.ts; this
 * file is the contract around it.
 *
 * THE WIRE (BGOS main, backend/src/integrations/assistant-sessions.service.ts
 * modelEffort and model-effort-picker.model.ts). The backend sends voice_rpc
 * frames, the rail the Sessions ops ride (lib/voice-rpc.ts routes them here):
 *
 *   list_model_effort  payload {}
 *     answered { ok: true, payload: <catalog> }, the catalog BGOS's
 *     readModelEffortCatalog accepts (lib/model-effort-catalog.ts
 *     buildPickerCatalog, read back through the vendored reader first);
 *   apply_model_effort payload { sessionId, model, effort }
 *     answered { ok: true, payload: { current: { model, effort }, sessionId } }
 *     only when the session's OWN latest report holds both values; BGOS
 *     refuses any other answer as invalid_answer;
 *   a refusal { ok: false, error: { code, message } }, code busy, not_allowed
 *     or failed: BGOS passes busy and not_allowed (and its own timeout) to the
 *     app, which words them, and turns anything else into switch_failed.
 *
 * The rules, in order:
 *  1. A frame for another agent gets nothing (`mine`): several daemons can
 *     share a pairing room, and the first result wins.
 *  2. Owner only, main chat only. The frame names no sender: BGOS's gate
 *     admits only the signed in owner in this agent's own main chat (gate
 *     steps 1 to 3). The daemon checks again from its own records
 *     (pickerChatAllowed): the chat is one of this agent's main chats, never
 *     one known to be a share recipient's, and on a shared agent one PROVEN
 *     the owner's. One session serves every chat of the agent, so a
 *     recipient's change would change the owner's.
 *  3. A list types nothing. It is refused while the owner has not opted in on
 *     this machine, and when there is nothing honest to offer.
 *  4. An apply is a typed selection of three strings, handed to the control
 *     as is, under a deadline counted from the frame's arrival that beats
 *     BGOS's 20 s wait. The confirmed state, or the true state after a
 *     refusal, is reported on the session settings rail for the pill, and a
 *     confirmed switch (or a model switched before the effort was refused) is
 *     noted in the chat (the canon's "post a switched-to note"); neither holds
 *     the answer back.
 *  5. Always an answer: a throw is answered failed.
 */

import { createHash } from 'node:crypto'

import type { ApplySelection, ControlOutcome, ControlSnapshot, RefusalCode } from './model-effort-control.ts'
import {
  buildPickerCatalog,
  effortLabel,
  familyLabel,
  pickerModelOf,
  readModelEffortCatalog,
  type ModelEffortReport,
} from './model-effort-catalog.ts'
import { isModelFamily } from './compact-inject.ts'

/** model-effort-picker.model.ts:1, the token BGOS's gate reads. */
export const MODEL_EFFORT_PICKER = 'model_effort_picker'
/** model-effort-picker.model.ts:2. */
export const LIST_MODEL_EFFORT = 'list_model_effort'
export const APPLY_MODEL_EFFORT = 'apply_model_effort'
export const MODEL_EFFORT_OPS = Object.freeze([LIST_MODEL_EFFORT, APPLY_MODEL_EFFORT] as const)
export type ModelEffortOp = (typeof MODEL_EFFORT_OPS)[number]

export function isModelEffortOp(op: unknown): op is ModelEffortOp {
  return op === LIST_MODEL_EFFORT || op === APPLY_MODEL_EFFORT
}

/**
 * The whole apply answer's budget, counted from the frame's ARRIVAL. BGOS
 * waits 20 000 ms from its emit (assistant-sessions.service.ts modelEffort)
 * and drops a result that lands later, so the daemon stops well inside it,
 * leaving room for the socket hop and the result POST (review M1 of round 3).
 */
export const APPLY_BUDGET_MS = 15_000

/** The codes the app maps (modelEffortQuery.ts pickerError), and failed for the rest. */
export const PICKER_REFUSAL_CODES = Object.freeze(['busy', 'not_allowed', 'failed'] as const)
export type PickerRefusalCode = (typeof PICKER_REFUSAL_CODES)[number]

const BUSY: ReadonlySet<RefusalCode> = new Set<RefusalCode>(['control_busy', 'busy_turn', 'turn_unknown', 'dialog_open'])
const NOT_ALLOWED: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
  'unsupported_op',
  'unsupported_value',
  'ultracode_unconfirmable',
  'not_opted_in',
  'no_terminal',
  'not_in_catalog',
  'effort_unsupported',
  'session_mismatch',
  'not_owner_main_chat',
])

/**
 * A control refusal as the app hears it: busy ("Wait for this response to
 * finish"), not_allowed ("That model or effort is not allowed. Open the
 * picker again."), or failed ("The switch could not be confirmed").
 */
export function pickerRefusalCode(code: RefusalCode): PickerRefusalCode {
  if (BUSY.has(code)) return 'busy'
  if (NOT_ALLOWED.has(code)) return 'not_allowed'
  return 'failed'
}

/** The BGOS report route's own patterns (backend report-session-settings.dto.ts). */
export const SESSION_REPORT_MODEL_PATTERN = /^[\w./:-]{1,160}$/
export const SESSION_REPORT_EFFORT_PATTERN = /^[a-z]{1,20}$/

/**
 * An rpcId as the daemon log carries it: a short hash, never the id itself.
 * The id is the sender's text (no character check), so logged raw a newline
 * in it would forge log lines (REVIEW-275 L6).
 */
export function rpcLogTag(rpcId: string): string {
  return createHash('sha256').update(String(rpcId)).digest('hex').slice(0, 12)
}

/**
 * A frame's op as the daemon log carries it: the op itself when it is one
 * plain word, else `?`. Several rails log the op before checking it, and it
 * is the sender's text as much as the rpcId is (round 2 on PR #275, L2).
 */
export function rpcLogOp(op: unknown): string {
  return typeof op === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(op) ? op : '?'
}

export type SessionSettingsBody = {
  model: string
  effort: string | null
  serviceTier: null
  rerouted: false
  reportedAt: string
}

/** The session settings body for a report, or null when the route would refuse it. */
export function sessionSettingsBody(report: ModelEffortReport | null, nowMs: number): SessionSettingsBody | null {
  if (!report || !SESSION_REPORT_MODEL_PATTERN.test(report.model)) return null
  const effort = report.effort !== null && SESSION_REPORT_EFFORT_PATTERN.test(report.effort) ? report.effort : null
  return { model: report.model, effort, serviceTier: null, rerouted: false, reportedAt: new Date(nowMs).toISOString() }
}

/**
 * Owner only, main chat only, from the daemon's own records: one of this
 * agent's main chats (the inbox's kinds), never one known to be a share
 * recipient's (lib/chat-ownership.ts), and, when the agent has more than one
 * main chat (a shared agent: each recipient has her own), one proven the
 * owner's. An unproven chat on a shared agent is refused: fail closed.
 */
export function pickerChatAllowed(input: {
  chatId: string
  mainChatIds: readonly string[]
  isOwners: (chatId: string) => boolean
  isOthers: (chatId: string) => boolean
}): boolean {
  const { chatId, mainChatIds } = input
  if (chatId === '' || !mainChatIds.includes(chatId)) return false
  if (input.isOthers(chatId)) return false
  return mainChatIds.length === 1 || input.isOwners(chatId)
}

export type PickerSnapshot = ControlSnapshot

export type PickerAnswer =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: PickerRefusalCode; message: string }

export interface PickerFrame {
  op: unknown
  assistantId: unknown
  chatId: unknown
  payload: Record<string, unknown>
  /** When the frame reached this daemon (lib/voice-rpc.ts), the apply deadline's start. */
  receivedAtMs?: number
}

export interface ModelEffortPickerDeps {
  assistantId: () => string
  /** Is this chat the owner's own main chat (pickerChatAllowed)? */
  chatAllowed: (chatId: string) => boolean
  control: {
    snapshot: () => Promise<ControlSnapshot>
    apply: (selection: ApplySelection, opts: { deadlineAtMs: number }) => Promise<ControlOutcome>
  }
  reportSettings: (chatId: string, body: SessionSettingsBody) => Promise<unknown>
  sendNote: (chatId: string, text: string) => Promise<unknown>
  log: (msg: string) => void
  now: () => number
}

const refuse = (code: RefusalCode, message: string): PickerAnswer => ({ ok: false, code: pickerRefusalCode(code), message })

const SELECTION_SESSION_MAX = 200

export class ModelEffortPickerHandler {
  constructor(private readonly deps: ModelEffortPickerDeps) {}

  /** Is this frame this daemon's to answer at all? */
  mine(frame: Pick<PickerFrame, 'assistantId'>): boolean {
    const own = this.deps.assistantId()
    return own !== '' && (typeof frame.assistantId === 'string' || typeof frame.assistantId === 'number') && String(frame.assistantId) === own
  }

  async answer(frame: PickerFrame): Promise<PickerAnswer> {
    try {
      const chatId = typeof frame.chatId === 'string' || typeof frame.chatId === 'number' ? String(frame.chatId) : ''
      if (!this.deps.chatAllowed(chatId)) {
        this.deps.log(`model effort picker: refused not_owner_main_chat (${rpcLogOp(frame.op)})`)
        return refuse('not_owner_main_chat', 'The model and effort are changed by the agent\'s owner, from the agent\'s main chat only.')
      }
      if (frame.op === LIST_MODEL_EFFORT) return await this.list()
      if (frame.op === APPLY_MODEL_EFFORT) return await this.apply(chatId, frame.payload, frame.receivedAtMs ?? this.deps.now())
      return refuse('unsupported_op', 'Only the model or the effort of this agent\'s session can be changed.')
    } catch (err) {
      this.deps.log(`model effort picker: ${rpcLogOp(frame.op)} failed (${err instanceof Error ? err.name : 'error'})`)
      return { ok: false, code: 'failed', message: 'The daemon could not run that request.' }
    }
  }

  private async list(): Promise<PickerAnswer> {
    const snap = await this.deps.control.snapshot()
    if (!snap.optedIn) {
      return refuse('not_opted_in', 'Remote model and effort control is off for this agent. Its owner can turn it on on the agent\'s machine with hoai-model-control on.')
    }
    const built = buildPickerCatalog({ catalog: snap.catalog, observation: snap.observation, sessionId: snap.sessionId })
    // Read back through BGOS's own reader: never send what it would refuse.
    const catalog = built ? readModelEffortCatalog(JSON.parse(JSON.stringify(built))) : null
    if (!catalog) {
      return refuse('no_status_source', 'This agent\'s session has not reported its model and effort yet, so the picker cannot be filled.')
    }
    return { ok: true, payload: { ...catalog } }
  }

  private async apply(chatId: string, payload: Record<string, unknown>, receivedAtMs: number): Promise<PickerAnswer> {
    const { sessionId, model, effort } = payload
    if (
      typeof sessionId !== 'string' || sessionId === '' || sessionId.length > SELECTION_SESSION_MAX ||
      typeof model !== 'string' || typeof effort !== 'string'
    ) {
      return refuse('unsupported_value', 'Choose a model and effort from this session\'s picker.')
    }
    const outcome = await this.deps.control.apply({ sessionId, model, effort }, { deadlineAtMs: receivedAtMs + APPLY_BUDGET_MS })
    // The pill and the note never hold the answer back: they are sent, not
    // awaited, and the result is posted at once (review M1 of round 3).
    const settings = sessionSettingsBody(outcome.report, this.deps.now())
    if (settings) {
      void this.deps.reportSettings(chatId, settings).catch((err) => {
        this.deps.log(`model effort picker: session settings report failed (${err instanceof Error ? err.name : 'error'})`)
      })
    }
    const name = isModelFamily(model) ? familyLabel(model) : model
    if (!outcome.ok) {
      if (!outcome.modelSwitched) return refuse(outcome.code, outcome.message)
      // The model DID change before the effort step was refused: said in the
      // chat and answered failed ("could not be confirmed, open the picker
      // again"), never not_allowed, which would read as nothing happened.
      this.note(chatId, `Switched to ${name}. The effort was not changed: ${outcome.message}`)
      return { ok: false, code: 'failed', message: `The model was switched to ${name}, but the effort was not changed. ${outcome.message}` }
    }
    // The answer is the session's own report, never the selection echoed.
    const current = { model: pickerModelOf(outcome.report.model), effort: outcome.report.effort }
    if (current.model !== model || current.effort !== effort) {
      return refuse('not_confirmed', 'The command was typed but the session did not report the change in time.')
    }
    if (outcome.applied) this.note(chatId, `Switched to ${name}, effort ${effortLabel(effort)}.`)
    return { ok: true, payload: { current: { model: current.model, effort: current.effort }, sessionId } }
  }

  /** A chat note, sent and not awaited: a failed note cannot undo a confirmed switch. */
  private note(chatId: string, text: string): void {
    void this.deps.sendNote(chatId, text).catch((err) => {
      this.deps.log(`model effort picker: switched note failed (${err instanceof Error ? err.name : 'error'})`)
    })
  }
}
