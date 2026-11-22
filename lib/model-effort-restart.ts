/**
 * The restart route of the owner's model picker: how an agent with no tmux
 * pane (every Windows agent, and a Linux one started without tmux) is switched
 * to another model and effort.
 *
 * The typing route (lib/model-effort-control.ts) types `/model` and `/effort`
 * into the agent's pane. With no pane, the switch is a restart of that one
 * agent through the Helper's own launcher, on its own pinned conversation:
 *
 *  1. ModelEffortControl.apply checks everything it checks for typing (opt in,
 *     proven session, fresh status, catalog, idle by the hook turn signal, no
 *     permission question, nothing else typing), then that a launcher which
 *     reads the launch choice supervises THIS session (supervisor.json with
 *     `launch-choice`, its pid an ancestor). It writes model-switch.json
 *     (pending) and launch-choice.json (lib/launch-choice.mjs) and answers
 *     `restarting` at once: BGOS waits 20 s and a restart takes longer.
 *  2. RESTART_DELAY_MS later, when the answer has gone out, intake is drained
 *     (the update ladder's own drain: the socket is closed, so a message that
 *     arrives now is read by the next daemon from the server) and the restart
 *     marker is written: the first rung of lib/agent-restart.mjs, the same
 *     restart the Helper's Fix and the app's Restart use. The control's lock
 *     stays held, so no card opens a turn in a session about to end.
 *  3. hoai-core ends claude and relaunches the pinned session with
 *     `--model` and `--effort` (bin/hoai-core.mjs). A relaunch that dies at
 *     once with them puts the previous choice back there.
 *  4. The daemon that comes back (finishPendingSwitch) asks the session for
 *     one reply (the liveness check card) and confirms only from a REAL reply
 *     on the target model in the session's own transcript, written after the
 *     launch, with the status line on the target. The status line alone proves
 *     nothing: it repeats --model, so a model the API refuses reads there all
 *     the same. Only then "Switched to".
 *  5. A refusal (`model_not_found`) or no reply on the target in time: the
 *     previous choice goes back, the record says `restoring` (the picker stays
 *     busy, since the session still reads the new model) and the agent is
 *     restarted onto it. The daemon after that restart tells the chat once
 *     the session reads the old model: "Could not switch ... The agent stays
 *     on <old>." If that restart cannot happen, the chat is told so; if it
 *     has not happened by RESTART_WATCH_MS, the chat is told it has not yet,
 *     and that the agent starts on the old model when it does.
 *
 * Each wait for the session runs from the session being up, not from the
 * launch: a cold start (a Windows boot) can take minutes before it is. A
 * session that is not up SWITCH_START_MAX_MS after the launch never answered.
 *
 * If the launcher never restarts the agent (RESTART_WATCH_MS), this daemon is
 * still alive: it puts the previous choice back, opens intake and the lock, and
 * tells the chat the agent stays on its model.
 */

import { join } from 'node:path'

import {
  LAUNCH_CHOICE_FILE_NAME,
  MODEL_SWITCH_FILE_NAME,
  launchChoiceBody,
  modelSwitchBody,
  parseLaunchChoice,
  parseModelSwitch,
  type ModelSwitch,
} from './launch-choice.mjs'
import { isModelFamily } from './compact-inject.ts'
import { effortLabel, familyLabel, modelFamilyOf } from './model-effort-catalog.ts'
import type { ModelObservation } from './model-control-store.mjs'

/** After the answer, before the drain and the marker: the result POST goes out first. */
export const RESTART_DELAY_MS = 2_000
/** A launcher that has not ended this session by then never will (it polls the marker every 3 s). */
export const RESTART_WATCH_MS = 45_000
/** How long the daemon that comes back waits, once the session is up, for a real reply on the target (and the daemon after a restart back for the old model). */
export const SWITCH_CONFIRM_MS = 120_000
/** How long after the launch the session may take to be up at all: a cold start (a Windows boot) is slow. */
export const SWITCH_START_MAX_MS = 4 * 60_000
/**
 * A pending switch older than this is not in flight any more (a dead agent, a
 * lost daemon). It covers a switch and the restart back, each with its whole
 * start and confirm wait.
 */
export const SWITCH_PENDING_MAX_MS = 15 * 60_000
const CONFIRM_POLL_MS = 2_000

export interface RestartRouteDeps {
  /** This agent's own state folder (~/.bgos-agent/<id>). */
  stateDir: string
  /** Cheap, for the declaration: a live supervisor.json that names `relaunch` and `launch-choice`. */
  launcherDeclared: () => boolean
  /** Before a restart: that launcher is proven to supervise THIS session (lib/idle-update.mjs proveOwnLauncher). */
  launcherProven: () => Promise<boolean>
  readFile: (path: string) => string | null
  /** Whole file by rename; throws when it cannot. */
  writeFile: (path: string, text: string) => void
  removeFile: (path: string) => void
  /** The restart marker for this agent's own launcher (lib/agent-restart.mjs restartAgent, marker tier): true once written. */
  requestRestart: () => Promise<boolean> | boolean
  /** The update ladder's drain: intake closed while true. */
  drain: (on: boolean) => void
  /** A note in the chat, sent and not awaited. */
  note: (chatId: string, text: string) => void
  setTimer: (fn: () => void, ms: number) => void
}

export type Choice = { model: string; effort: string | null }

const choicePath = (deps: RestartRouteDeps) => join(deps.stateDir, LAUNCH_CHOICE_FILE_NAME)
const switchPath = (deps: RestartRouteDeps) => join(deps.stateDir, MODEL_SWITCH_FILE_NAME)

export function readLaunchChoice(deps: RestartRouteDeps): Choice | null {
  return parseLaunchChoice(deps.readFile(choicePath(deps)))
}

export function readSwitch(deps: RestartRouteDeps): ModelSwitch | null {
  return parseModelSwitch(deps.readFile(switchPath(deps)))
}

function writeSwitch(deps: RestartRouteDeps, record: ModelSwitch): void {
  deps.writeFile(switchPath(deps), modelSwitchBody(record))
}

/** Put a choice (or none) back as what the agent starts on. Never throws. */
function restoreChoice(deps: RestartRouteDeps, previous: Choice | null): void {
  try {
    if (previous) deps.writeFile(choicePath(deps), launchChoiceBody(previous))
    else deps.removeFile(choicePath(deps))
  } catch {
    // The record still says failed; the next switch writes the file whole.
  }
}

/**
 * Is a switch in flight for this agent now, or being undone? The list answers
 * busy while it is, so the app never reads a model that did not work as
 * switched to.
 */
export function switchPendingNow(deps: RestartRouteDeps, nowMs: number): boolean {
  const record = readSwitch(deps)
  return (
    record !== null &&
    (record.state === 'pending' || record.state === 'restoring') &&
    nowMs - record.requestedAtMs < SWITCH_PENDING_MAX_MS
  )
}

/** The words a model goes by in a note: a family's name, else its own id. */
export function modelName(model: string): string {
  return isModelFamily(model) ? familyLabel(model) : model
}

/** The ending the API adds to an id for its dated snapshot: a dash and eight digits. */
const SNAPSHOT_DATE = /^-\d{8}$/
const DATED = /-\d{8}$/

/**
 * Does an observed model meet a target? A family alias: any model of that
 * family. An exact id: that id, or its dated snapshot (a reply on a session
 * started with `--model claude-haiku-4-5` may name claude-haiku-4-5 plus a
 * dash and its date); nothing looser, and a dated target only itself.
 */
export function modelMeets(target: string, observed: string): boolean {
  if (isModelFamily(target)) return modelFamilyOf(observed) === target
  if (observed === target) return true
  return !DATED.test(target) && observed.startsWith(target) && SNAPSHOT_DATE.test(observed.slice(target.length))
}

/**
 * Step 1's writes: the switch record first, then the choice the launcher
 * reads. Throws when either cannot be written; the record is then failed.
 */
export function beginSwitch(
  deps: RestartRouteDeps,
  input: { target: Choice; from: Choice; sessionId: string; chatId: string; nowMs: number },
): ModelSwitch {
  const record: ModelSwitch = {
    state: 'pending',
    target: input.target,
    previous: readLaunchChoice(deps),
    from: input.from,
    sessionId: input.sessionId,
    chatId: input.chatId,
    requestedAtMs: input.nowMs,
    launchedAtMs: null,
    reason: null,
    noted: false,
  }
  writeSwitch(deps, record)
  try {
    deps.writeFile(choicePath(deps), launchChoiceBody(input.target))
  } catch (err) {
    writeSwitch(deps, { ...record, state: 'failed', reason: 'not_restarted', noted: true })
    throw err
  }
  return record
}

/** End a switch that failed: the previous choice back, the record failed, the chat told once. */
export function failSwitch(deps: RestartRouteDeps, record: ModelSwitch, reason: string, text: string): void {
  restoreChoice(deps, record.previous)
  try {
    writeSwitch(deps, { ...record, state: 'failed', reason, noted: true })
  } catch {
    // Told below all the same.
  }
  deps.note(record.chatId, text)
}

/**
 * Steps 2 and the watch: after the answer, drain and write the marker; if the
 * agent is not restarted, undo it all and call `release` (the control's lock).
 */
export function scheduleRestart(deps: RestartRouteDeps, record: ModelSwitch, release: () => void, log: (line: string) => void): void {
  const notRestarted = () =>
    `Could not switch to ${modelName(record.target.model)}. The agent was not restarted, so it stays on ${modelName(record.from.model)}.`
  deps.setTimer(() => {
    void Promise.resolve()
      .then(() => deps.requestRestart())
      .catch(() => false)
      .then((asked) => afterAsk(asked === true))
  }, RESTART_DELAY_MS)
  const afterAsk = (asked: boolean) => {
    if (!asked) {
      log('model control: restart route could not write the restart marker')
      failSwitch(deps, record, 'not_restarted', notRestarted())
      release()
      return
    }
    deps.drain(true)
    log('model control: restart route asked the launcher to restart this session')
    deps.setTimer(() => {
      // Still here: the launcher did not end this session.
      log('model control: restart route was not restarted in time')
      deps.drain(false)
      failSwitch(deps, record, 'not_restarted', notRestarted())
      release()
    }, RESTART_WATCH_MS)
  }
}

/**
 * A wait that runs from the session being up: SWITCH_CONFIRM_MS from the first
 * time it is (never before the launch), and SWITCH_START_MAX_MS after the
 * launch while it is not up yet.
 */
function waitFromUp(launchedAt: number): { up: (nowMs: number) => void; over: (nowMs: number) => boolean } {
  let upAt: number | null = null
  return {
    up: (nowMs) => {
      if (upAt === null) upAt = Math.max(nowMs, launchedAt)
    },
    over: (nowMs) => nowMs >= (upAt === null ? launchedAt + SWITCH_START_MAX_MS : upAt + SWITCH_CONFIRM_MS),
  }
}

/** What the session's transcript says about the new model so far. */
type ReplyVerdict = 'works' | 'refused' | null

/**
 * Read appended transcript lines for the first word on the target model,
 * after the launch: a real reply on it (`works`), or the API's refusal of the
 * model (`refused`). A side chain, a line from before the launch, a reply on
 * another model and a passing API error (a rate limit, an overload) say
 * nothing. Never throws.
 */
export function replyVerdict(text: string, target: string, afterMs: number): ReplyVerdict {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (e.type !== 'assistant' || e.isSidechain === true) continue
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    if (!Number.isFinite(at) || at <= afterMs) continue
    if (e.isApiErrorMessage === true) {
      if (e.error === 'model_not_found') return 'refused'
      continue
    }
    const message = e.message && typeof e.message === 'object' ? (e.message as Record<string, unknown>) : null
    const model = message && typeof message.model === 'string' ? message.model : null
    if (model && model !== '<synthetic>' && modelMeets(target, model)) return 'works'
  }
  return null
}

/** Why a switch is being undone, in the chat's words. */
function whyNot(reason: string | null): string {
  return reason === 'model_refused' ? 'the model was refused' : 'the agent did not answer on it in time'
}

/**
 * Step 5: the new model did not work. The previous choice back, the record
 * `restoring` (the list stays busy), and the agent restarted onto it. If the
 * restart cannot happen, the chat is told so and the record is closed for the
 * launcher (noted), while the list stays busy for the rest of the window: the
 * session still reads the model that did not work.
 */
async function goBack(deps: RestartRouteDeps, record: ModelSwitch, reason: 'model_refused' | 'not_confirmed', log: (line: string) => void): Promise<void> {
  restoreChoice(deps, record.previous)
  const restoring: ModelSwitch = { ...record, state: 'restoring', reason, launchedAtMs: null, noted: false }
  try {
    writeSwitch(deps, restoring)
  } catch {
    // The launcher reads the choice all the same; the next daemon finds no record to finish.
  }
  const back = modelName(record.from.model)
  const tell = (after: string) => {
    try {
      writeSwitch(deps, { ...restoring, noted: true })
    } catch {
      // Told below all the same.
    }
    deps.note(record.chatId, `Could not switch to ${modelName(record.target.model)}: ${whyNot(reason)}. ${after}`)
  }
  // The marker could not be written: no restart is coming.
  const notRestarted = () => tell(`The agent could not be restarted, so it starts on ${back} next time.`)
  // Asked for and not done yet: it may still come, and the old choice is what it starts on.
  const notYet = () => tell(`The agent has not restarted yet, and starts on ${back} when it does.`)
  let asked = false
  try {
    asked = (await deps.requestRestart()) === true
  } catch {
    asked = false
  }
  if (!asked) {
    log('model control: could not write the restart marker to go back to the previous model')
    notRestarted()
    return
  }
  deps.drain(true)
  log(`model control: the new model did not work (${reason}); restarting onto the previous choice`)
  deps.setTimer(() => {
    log('model control: the restart back to the previous model did not happen in time')
    deps.drain(false)
    notYet()
  }, RESTART_WATCH_MS)
}

/**
 * The daemon that comes back: finish a pending switch from a real reply on
 * the new model, or undo it (step 5), or finish an undo, or tell a failed one
 * once. Resolves 'confirmed', 'restoring' (undoing it now), 'failed', or null
 * when there was nothing to finish. Never throws.
 */
export async function finishPendingSwitch(input: {
  deps: RestartRouteDeps
  sessionId: () => string | null
  readObservation: (sessionId: string) => ModelObservation | null
  /** The proven session's transcript lines appended since the last call (lib/goal-tail.ts). */
  readTranscript: () => string
  /** Ask the session for one reply that tells the owner nothing (the liveness check card). */
  askForReply: (chatId: string) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}): Promise<'confirmed' | 'restoring' | 'failed' | null> {
  const { deps } = input
  let record: ModelSwitch | null
  try {
    record = readSwitch(deps)
  } catch {
    record = null
  }
  if (!record || record.noted) return null
  const target = modelName(record.target.model)
  if (record.state === 'failed') {
    const text = record.reason === 'start_failed'
      ? `Could not switch to ${target}. The agent did not start on it, so it was started again on the model it had.`
      : `Could not switch to ${target}. The agent stays on ${modelName(record.from.model)}.`
    try {
      writeSwitch(deps, { ...record, noted: true })
    } catch {
      return 'failed'
    }
    deps.note(record.chatId, text)
    return 'failed'
  }
  if (record.state === 'restoring') return finishRestore(input, record)
  if (record.state !== 'pending') return null
  if (record.launchedAtMs === null) {
    input.log('model control: a pending switch was never relaunched for')
    failSwitch(deps, record, 'not_restarted', `Could not switch to ${target}. The agent was not restarted, so it stays on ${modelName(record.from.model)}.`)
    return 'failed'
  }
  const launchedAt = record.launchedAtMs
  const wait = waitFromUp(launchedAt)
  let asked = false
  let works = false
  while (true) {
    const sid = input.sessionId()
    if (sid !== null && sid !== record.sessionId) {
      failSwitch(deps, record, 'session_changed', `Could not confirm the switch to ${target}. The agent came back on another conversation.`)
      return 'failed'
    }
    if (sid !== null) {
      wait.up(input.now())
      if (!asked) {
        asked = true
        input.askForReply(record.chatId)
      }
      const verdict = replyVerdict(input.readTranscript(), record.target.model, launchedAt)
      if (verdict === 'refused') {
        input.log('model control: the API refused the new model')
        await goBack(deps, record, 'model_refused', input.log)
        return 'restoring'
      }
      if (verdict === 'works') works = true
      const o = input.readObservation(sid)
      if (works && o && o.observedAtMs > launchedAt && modelMeets(record.target.model, o.modelId) && (o.effort === null || o.effort === record.target.effort)) {
        try {
          writeSwitch(deps, { ...record, state: 'confirmed', noted: true })
        } catch {
          // Confirmed all the same: the session answered on it.
        }
        // A model that reports no effort is named alone: its effort is not known.
        const effort = o.effort === null ? null : record.target.effort
        deps.note(record.chatId, effort ? `Switched to ${target}, effort ${effortLabel(effort)}.` : `Switched to ${target}.`)
        input.log('model control: restart route confirmed by a reply on the new model')
        return 'confirmed'
      }
    }
    if (wait.over(input.now())) break
    await input.sleep(CONFIRM_POLL_MS)
  }
  input.log('model control: no reply on the new model in time')
  await goBack(deps, record, 'not_confirmed', input.log)
  return 'restoring'
}

/** The daemon after the restart back: tell the chat once the session reads the old model. */
async function finishRestore(
  input: Parameters<typeof finishPendingSwitch>[0],
  record: ModelSwitch,
): Promise<'failed'> {
  const { deps } = input
  const since = record.launchedAtMs ?? input.now()
  const wait = waitFromUp(since)
  const target = modelName(record.target.model)
  const why = whyNot(record.reason)
  const back = (id: string) => modelMeets(record.from.model, id) || (record.previous !== null && modelMeets(record.previous.model, id))
  const settle = (text: string): 'failed' => {
    try {
      writeSwitch(deps, { ...record, state: 'failed', noted: true })
    } catch {
      // Told below all the same.
    }
    deps.note(record.chatId, text)
    return 'failed'
  }
  while (true) {
    const sid = input.sessionId()
    if (sid !== null && sid !== record.sessionId) {
      return settle(`Could not switch to ${target}: ${why}. The agent came back on another conversation.`)
    }
    if (sid !== null) {
      wait.up(input.now())
      const o = input.readObservation(sid)
      if (o && o.observedAtMs > since && back(o.modelId)) {
        input.log('model control: back on the previous model')
        return settle(`Could not switch to ${target}: ${why}. The agent stays on ${modelName(o.modelId)}.`)
      }
    }
    if (wait.over(input.now())) break
    await input.sleep(CONFIRM_POLL_MS)
  }
  return settle(
    `Could not switch to ${target}: ${why}. The agent was started again on ${modelName(record.from.model)}, and has not reported its model since.`,
  )
}
