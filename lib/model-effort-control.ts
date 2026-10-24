/**
 * model-effort-control: the checked transaction that changes a RUNNING Claude
 * Code session's model or effort from the owner's app (Route A, approved by
 * KC 2026-10-23: "Two typed operations only, set_model and set_effort, built
 * from the frozen literal tables in compact-inject.ts ... Every precondition
 * you listed before typing").
 *
 * The wire (lib/model-effort-rpc.ts) has already proven the sender is the
 * owner in a main chat. This file decides everything else, in this order, and
 * types NOTHING unless every step passes:
 *
 *   1. the op is set_model, set_effort or describe, and the value is an own
 *      key of the frozen table (Ultra Code: "This host cannot confirm Ultra
 *      Code remotely.");
 *   2. the control lock is free (one change at a time; the lock is also held
 *      against compact, goal typing, steer and incoming deliveries by
 *      server.ts, through `busy` and `whenIdle`);
 *   3. the owner opted this agent in on its machine (lib/model-control-store.mjs);
 *   4. a tmux target, a PROVEN session id, and a fresh observation of that
 *      session from the status line bridge exist;
 *   5. the installed CLI offers the value (lib/model-effort-catalog.ts), and
 *      an effort change has a model that reports effort;
 *   6. the agent is idle by the hook turn signal (unknown is refused), no
 *      permission question is open, no other injection is running;
 *   7. the pane is alive and not in a tmux mode, the agent's own CLI is in
 *      front in it, and its composer is EMPTY (a draft is never discarded,
 *      and a screen with no recognisable composer is refused). The proof
 *      reads the pane's own id (%N), and every later read and key names that
 *      id, never the configured target: a session name resolves to whatever
 *      pane is active at each call (REVIEW-275 M2);
 *   8. the turn, dialog and session are checked again right before typing,
 *      and the baseline observation is taken.
 *
 * Then the fixed literal is typed, ONCE, and the composer read again: only
 * when it holds exactly the literal is the one Enter pressed. Anything else
 * (a key the owner pressed meanwhile, a dialog) is refused with no Enter, and
 * the literal is cleared off the composer only where it certainly sits at its
 * end (REVIEW-275 L5). Confirmation is a
 * NEWER observation (a higher sequence number) from the SAME session that
 * reports the requested value; echoed input, a refresh that still reports the
 * old value, the request itself or a success exit code never confirm. A
 * session that changes mid confirmation is reported as such, and a timeout
 * says whether the literal is still sitting in the composer. Nothing is ever
 * retried into a terminal in an uncertain state.
 *
 * Each frame carries ONE operation, so there is no partial state to roll
 * back: a picker that changes both sends set_model, waits for its answer,
 * then sends set_effort, and every answer carries the true report.
 */

import {
  buildClearTypedArgs,
  buildPaneCaptureArgs,
  buildPaneStateArgs,
  buildSetEffortInjectionSteps,
  buildSetModelInjectionSteps,
  EFFORT_LITERALS,
  isEffortLevel,
  isModelFamily,
  MODEL_LITERALS,
  type InjectionStep,
  type TmuxTarget,
} from './compact-inject.ts'
import {
  buildModelEffortReport,
  modelFamilyOf,
  parseHelpCatalog,
  ULTRACODE_UNCONFIRMABLE,
  type CanChange,
  type HostCatalog,
  type ModelEffortReport,
} from './model-effort-catalog.ts'
import type { ModelObservation } from './model-control-store.mjs'
import { agentOwnsPane, composerHolds, composerText, parsePaneState, readComposer, type ProcessEntry } from './model-effort-pane.ts'

export type ControlOp = 'describe' | 'set_model' | 'set_effort'

export interface ControlRequest {
  op: unknown
  value?: unknown
}

export type RefusalCode =
  | 'unsupported_op'
  | 'unsupported_value'
  | 'ultracode_unconfirmable'
  | 'control_busy'
  | 'not_opted_in'
  | 'no_terminal'
  | 'session_unknown'
  | 'no_status_source'
  | 'stale_status'
  | 'not_in_catalog'
  | 'effort_unsupported'
  | 'busy_turn'
  | 'turn_unknown'
  | 'dialog_open'
  | 'pane_lost'
  | 'pane_in_mode'
  | 'pane_not_agent'
  | 'composer_not_empty'
  | 'composer_unknown'
  | 'session_changed'
  | 'composer_changed'
  | 'inject_failed'
  | 'not_confirmed'

/** One plain sentence per refusal, at most 300 characters, dash free. */
export const REFUSAL_MESSAGES: Readonly<Record<RefusalCode, string>> = Object.freeze({
  unsupported_op: 'Only set_model and set_effort can change this agent\'s session.',
  unsupported_value: 'That is not a model or effort this agent can be switched to.',
  ultracode_unconfirmable: ULTRACODE_UNCONFIRMABLE,
  control_busy: 'Another command is being typed into the agent\'s terminal. Try again in a moment.',
  not_opted_in:
    'Remote model and effort control is off for this agent. Its owner can turn it on on the agent\'s machine with hoai-model-control on.',
  no_terminal: 'This agent\'s terminal is not under tmux control, so its model and effort can only be changed in the terminal.',
  session_unknown: 'The daemon has not yet proven which session it serves, so it will not type into it.',
  no_status_source: 'This agent\'s session has not reported its model and effort yet, so a change could not be confirmed.',
  stale_status: 'This agent\'s session has not reported its model and effort recently, so a change could not be confirmed.',
  not_in_catalog: 'This agent\'s Claude Code does not offer that model.',
  effort_unsupported: 'The model this agent runs reports no effort setting.',
  busy_turn: 'The agent is working on a turn. Try again when it is idle.',
  turn_unknown: 'The daemon cannot tell whether the agent is idle, so it will not type into it.',
  dialog_open: 'The agent is waiting on a permission question. Answer it first.',
  pane_lost: 'The agent\'s terminal pane is gone.',
  pane_in_mode: 'The agent\'s terminal pane is in a tmux mode that would take the keys.',
  pane_not_agent: 'The agent\'s own Claude Code is not in front in its terminal pane.',
  composer_not_empty: 'The agent\'s message box has a draft in it. It was left as it is; send or clear it first.',
  composer_unknown: 'The agent\'s screen does not show its message box (a menu or a question may be open).',
  session_changed: 'The agent\'s session changed while the change was being confirmed, so its state is not known.',
  composer_changed: 'Something reached the agent\'s message box while the command was being typed, so it was not sent.',
  inject_failed: 'Typing into the agent\'s terminal failed part way. Nothing was retried; check the terminal.',
  not_confirmed: 'The command was typed but the session did not report the change in time.',
})

export type ControlOutcome =
  | { ok: true; op: ControlOp; applied: boolean; report: ModelEffortReport }
  | { ok: false; op: ControlOp | null; code: RefusalCode; message: string; report: ModelEffortReport | null }

export interface ControlDeps {
  /** The owner's opt in for THIS agent, read per call. */
  optedIn: () => boolean
  target: () => TmuxTarget | null
  /** The session id the daemon has PROVEN it serves, or null. */
  sessionId: () => string | null
  turnState: () => 'idle' | 'live' | 'unknown'
  dialogOpen: () => boolean
  /** Compact, goal typing or a steer is running. */
  otherInjectionBusy: () => boolean
  /** The daemon's own process chain, itself first (lib/model-effort-pane.ts processAncestry). */
  ancestry: () => Promise<ProcessEntry[]>
  readObservation: (sessionId: string) => ModelObservation | null
  /** `claude --help` of the CLI at this version, or null. */
  helpText: (version: string | null) => Promise<string | null>
  /** Runs one argv; resolves stdout, rejects on any failure. */
  exec: (argv: string[]) => Promise<string>
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (msg: string) => void
}

export interface ControlOptions {
  /** How long to wait for the session to report the change. */
  confirmTimeoutMs?: number
  pollMs?: number
  /** An observation older than this is not a live status source. */
  staleMs?: number
}

const DEFAULTS = { confirmTimeoutMs: 20_000, pollMs: 250, staleMs: 15_000 }

class Refusal {
  constructor(readonly code: RefusalCode, readonly message: string = REFUSAL_MESSAGES[code]) {}
}

export class ModelEffortControl {
  private inFlight = false
  private idleWaiters: Array<() => void> = []
  private readonly opts: Required<ControlOptions>

  constructor(readonly deps: ControlDeps, opts: ControlOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  /** True while a change is being checked, typed or confirmed. */
  get busy(): boolean {
    return this.inFlight
  }

  /** Resolves at once when no change is in flight, else when it ends. */
  whenIdle(): Promise<void> {
    if (!this.inFlight) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  async handle(request: ControlRequest): Promise<ControlOutcome> {
    const op = request.op
    if (op !== 'describe' && op !== 'set_model' && op !== 'set_effort') {
      return this.refused(null, new Refusal('unsupported_op'), null)
    }
    if (op === 'describe') return this.describe()
    const value = request.value
    if (op === 'set_effort' && value === 'ultracode') {
      return this.refused(op, new Refusal('ultracode_unconfirmable'), null)
    }
    if (op === 'set_model' ? !isModelFamily(value) : !isEffortLevel(value)) {
      return this.refused(op, new Refusal('unsupported_value'), null)
    }
    if (this.inFlight || this.deps.otherInjectionBusy()) {
      return this.refused(op, new Refusal('control_busy'), null)
    }
    // Held from here, synchronously, so a second request is refused before
    // this one's first await.
    this.inFlight = true
    let sessionId: string | null = null
    let catalog: HostCatalog = { efforts: [], models: [] }
    try {
      const pre = await this.preflight()
      sessionId = pre.sessionId
      catalog = pre.catalog
      const outcome = await this.change(op, value as string, pre)
      this.deps.log(`model control: ${op} ${String(value)} ${outcome.ok ? (outcome.applied ? 'applied' : 'already') : outcome.code}`)
      return outcome
    } catch (err) {
      if (!(err instanceof Refusal)) throw err
      this.deps.log(`model control: ${op} ${String(value)} ${err.code}`)
      return { ok: false, op, code: err.code, message: err.message, report: this.report(catalog, sessionId) }
    } finally {
      this.inFlight = false
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }

  /** What runs now and what may be chosen. Types nothing. */
  private async describe(): Promise<ControlOutcome> {
    const sessionId = this.deps.sessionId()
    const observation = sessionId ? this.deps.readObservation(sessionId) : null
    const catalog = parseHelpCatalog(await this.deps.helpText(observation?.version ?? null))
    const report = buildModelEffortReport({ catalog, observation, canChange: this.canChange(catalog) })
    if (!report) {
      const blocked = this.canChange(catalog)
      return this.refused('describe', new Refusal(blocked.ok ? 'no_status_source' : (blocked.code as RefusalCode)), null)
    }
    return { ok: true, op: 'describe', applied: false, report }
  }

  /** The checks that need no pane read, in the order a refusal names them. */
  private checkSync(catalog: HostCatalog | null): Refusal | null {
    if (!this.deps.optedIn()) return new Refusal('not_opted_in')
    if (!this.deps.target()) return new Refusal('no_terminal')
    const sessionId = this.deps.sessionId()
    if (!sessionId) return new Refusal('session_unknown')
    const observation = this.deps.readObservation(sessionId)
    if (!observation) return new Refusal('no_status_source')
    if (this.deps.now() - observation.observedAtMs > this.opts.staleMs) return new Refusal('stale_status')
    if (catalog && catalog.models.length === 0 && catalog.efforts.length === 0) return new Refusal('not_in_catalog')
    return this.checkIdle()
  }

  private checkIdle(): Refusal | null {
    if (this.deps.otherInjectionBusy()) return new Refusal('control_busy')
    const turn = this.deps.turnState()
    if (turn === 'live') return new Refusal('busy_turn')
    if (turn !== 'idle') return new Refusal('turn_unknown')
    if (this.deps.dialogOpen()) return new Refusal('dialog_open')
    return null
  }

  private canChange(catalog: HostCatalog): CanChange {
    if (this.inFlight) return { ok: false, code: 'control_busy', reason: REFUSAL_MESSAGES.control_busy }
    const r = this.checkSync(catalog)
    return r ? { ok: false, code: r.code, reason: r.message } : { ok: true }
  }

  private report(catalog: HostCatalog, sessionId: string | null): ModelEffortReport | null {
    const sid = sessionId ?? this.deps.sessionId()
    const observation = sid ? this.deps.readObservation(sid) : null
    // Computed with the lock released in mind: the report says whether a
    // NEXT change could be attempted.
    const held = this.inFlight
    this.inFlight = false
    try {
      return buildModelEffortReport({ catalog, observation, canChange: this.canChange(catalog) })
    } finally {
      this.inFlight = held
    }
  }

  private async preflight(): Promise<{ sessionId: string; target: TmuxTarget; observation: ModelObservation; catalog: HostCatalog }> {
    const refusal = this.checkSync(null)
    if (refusal) throw refusal
    const sessionId = this.deps.sessionId()!
    const target = this.deps.target()!
    const observation = this.deps.readObservation(sessionId)!
    let help: string | null = null
    try {
      help = await this.deps.helpText(observation.version)
    } catch {
      help = null
    }
    return { sessionId, target, observation, catalog: parseHelpCatalog(help) }
  }

  private async change(
    op: 'set_model' | 'set_effort',
    value: string,
    pre: { sessionId: string; target: TmuxTarget; observation: ModelObservation; catalog: HostCatalog },
  ): Promise<ControlOutcome> {
    const { sessionId, target, catalog } = pre
    if (op === 'set_model' && !catalog.models.includes(value as keyof typeof MODEL_LITERALS)) throw new Refusal('not_in_catalog')
    if (op === 'set_effort') {
      if (!catalog.efforts.includes(value as keyof typeof EFFORT_LITERALS)) throw new Refusal('not_in_catalog')
      if (pre.observation.effort === null) throw new Refusal('effort_unsupported')
    }
    const matches = (o: ModelObservation) =>
      op === 'set_model' ? modelFamilyOf(o.modelId) === value : o.effort === value
    if (matches(pre.observation)) {
      return { ok: true, op, applied: false, report: this.report(catalog, sessionId)! }
    }

    const pane = await this.checkPane(target)

    // Again, right before typing: the pane reads above took time.
    const late = this.checkIdle()
    if (late) throw late
    if (this.deps.sessionId() !== sessionId) throw new Refusal('session_changed')
    const baseline = this.deps.readObservation(sessionId)
    if (!baseline) throw new Refusal('no_status_source')
    if (matches(baseline)) return { ok: true, op, applied: false, report: this.report(catalog, sessionId)! }

    const steps = op === 'set_model' ? buildSetModelInjectionSteps(pane, value) : buildSetEffortInjectionSteps(pane, value)
    if (!steps) throw new Refusal('unsupported_value')
    const literal = op === 'set_model' ? MODEL_LITERALS[value as keyof typeof MODEL_LITERALS] : EFFORT_LITERALS[value as keyof typeof EFFORT_LITERALS]
    const [typeLiteral, enter] = steps as [InjectionStep, InjectionStep]
    await this.run(typeLiteral)
    if (enter.delayMsBefore > 0) await this.deps.sleep(enter.delayMsBefore)
    await this.checkTyped(pane, literal)
    await this.run({ ...enter, delayMsBefore: 0 })

    const deadline = this.deps.now() + this.opts.confirmTimeoutMs
    while (this.deps.now() < deadline) {
      await this.deps.sleep(this.opts.pollMs)
      if (this.deps.sessionId() !== sessionId) throw new Refusal('session_changed')
      const o = this.deps.readObservation(sessionId)
      if (o && o.seq > baseline.seq && matches(o)) {
        return { ok: true, op, applied: true, report: this.report(catalog, sessionId)! }
      }
    }
    let still = false
    try {
      still = composerHolds(await this.deps.exec(buildPaneCaptureArgs(pane)), literal)
    } catch {
      still = false
    }
    throw new Refusal(
      'not_confirmed',
      still
        ? `${REFUSAL_MESSAGES.not_confirmed} It is still in the agent's message box.`
        : REFUSAL_MESSAGES.not_confirmed,
    )
  }

  private async run(step: InjectionStep): Promise<void> {
    if (step.delayMsBefore > 0) await this.deps.sleep(step.delayMsBefore)
    try {
      await this.deps.exec(step.argv)
    } catch {
      throw new Refusal('inject_failed')
    }
  }

  /**
   * Between the literal and the Enter: the composer must hold exactly the
   * literal. Otherwise no Enter. The literal is cleared only when the composer
   * ends with it (the cursor right after it), so a BSpace can only remove what
   * this daemon typed; a key typed after it, or a screen with no composer,
   * gets no key at all, and the answer says where the literal was left.
   */
  private async checkTyped(pane: TmuxTarget, literal: string): Promise<void> {
    let text: string | null
    try {
      text = composerText(await this.deps.exec(buildPaneCaptureArgs(pane)))
    } catch {
      text = null
    }
    if (text === literal) return
    let where = ' The agent\'s screen no longer shows its message box; check the terminal.'
    if (text !== null) {
      where = ' It is still in the agent\'s message box; check the terminal.'
      if (text.endsWith(literal)) {
        try {
          await this.deps.exec(buildClearTypedArgs(pane, literal))
          const left = composerText(await this.deps.exec(buildPaneCaptureArgs(pane)))
          if (left === text.slice(0, -literal.length).replace(/\s+$/u, '')) where = ' What was typed was cleared.'
        } catch {
          // The message box is unknown now: said as is.
        }
      }
    }
    throw new Refusal('composer_changed', `${REFUSAL_MESSAGES.composer_changed}${where}`)
  }

  /**
   * Step 7: alive, not in a mode, the agent's own CLI in front, composer
   * empty. Resolves the PROVEN pane, by its own id, for every later read and
   * key (REVIEW-275 M2).
   */
  private async checkPane(target: TmuxTarget): Promise<TmuxTarget> {
    let stateOut: string
    try {
      stateOut = await this.deps.exec(buildPaneStateArgs(target))
    } catch {
      throw new Refusal('pane_lost')
    }
    const pane = parsePaneState(stateOut)
    if (!pane || pane.dead) throw new Refusal('pane_lost')
    if (pane.inMode) throw new Refusal('pane_in_mode')
    let chain: ProcessEntry[] = []
    try {
      chain = await this.deps.ancestry()
    } catch {
      chain = []
    }
    if (!agentOwnsPane(pane.tty, pane.pid, chain)) throw new Refusal('pane_not_agent')
    const proven: TmuxTarget = { ...target, target: pane.paneId }
    let capture: string
    try {
      capture = await this.deps.exec(buildPaneCaptureArgs(proven))
    } catch {
      throw new Refusal('pane_lost')
    }
    const composer = readComposer(capture)
    if (composer === 'draft') throw new Refusal('composer_not_empty')
    if (composer !== 'empty') throw new Refusal('composer_unknown')
    return proven
  }

  private refused(op: ControlOp | null, r: Refusal, report: ModelEffortReport | null): ControlOutcome {
    this.deps.log(`model control: ${op ?? 'unknown op'} refused ${r.code}`)
    return { ok: false, op, code: r.code, message: r.message, report }
  }
}
