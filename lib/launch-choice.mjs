/**
 * launch-choice: the model and effort the Helper's launcher (bin/hoai-core.mjs)
 * starts one agent on, and the one model switch in flight for it.
 *
 * WHY. The app's model picker switches a Claude Code agent by typing `/model`
 * into its tmux pane (lib/model-effort-control.ts). An agent with no pane (every
 * Windows agent, and a Linux one started without tmux) cannot be typed into, so
 * it is switched by a restart of that one agent on its own pinned session with
 * `--model <id> --effort <level>`: the daemon writes the choice and the same
 * restart marker the Helper Fix writes, and hoai-core relaunches with it. Claude
 * Code 2.1.330 takes both flags at launch, and `--resume <id> --model X --effort
 * Y` keeps the conversation (checked on a throwaway session against a local
 * fake API).
 *
 * Both files live in the agent's own state folder (~/.bgos-agent/<id>/):
 *
 *   launch-choice.json  { version: 1, model, effort | null }
 *     what this agent starts on, every launch and relaunch, until changed;
 *   model-switch.json   the one switch in flight or last finished (state
 *     pending, confirmed or failed), so a failed start, the daemon that asked
 *     and the daemon that comes back all read the same record.
 *
 * STRICT, because every value becomes one argv element of `claude`, which on
 * Windows runs as `cmd.exe /c claude.cmd ...`: a model is a family alias or a
 * `claude-` id of the backend catalog's own pattern (claude-model-catalog.ts
 * CLAUDE_MODEL_ID_PATTERN), at most 48 characters; an effort is one of the five
 * the CLI takes at launch. Lowercase letters, digits and single dashes pass
 * cmd.exe, VBS and every shell untouched, and can never read as a flag. Anything
 * else reads as no choice at all. Pure: no fs, no clock; callers join the paths.
 */

export const LAUNCH_CHOICE_FILE_NAME = 'launch-choice.json'
export const MODEL_SWITCH_FILE_NAME = 'model-switch.json'
/** In supervisor.json `capabilities`: this launcher applies the launch choice. */
export const LAUNCH_CHOICE_CAPABILITY = 'launch-choice'

export const LAUNCH_MODEL_FAMILIES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable'])
export const LAUNCH_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
/** The backend catalog's id pattern (backend claude-model-catalog.ts), and its length cap. */
export const LAUNCH_MODEL_ID_PATTERN = /^claude(?:-[a-z0-9]{1,16}){1,4}$/
export const LAUNCH_MODEL_ID_MAX = 48

const FILE_MAX_CHARS = 4096
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const REASON_RE = /^[a-z_]{1,64}$/
/** A model as the session's own status line names it (lib/model-control-store.mjs MODEL_ID_RE). */
const OBSERVED_MODEL_RE = /^[\w./:[\]-]{1,160}$/
/**
 * `restoring`: the new model did not work (the API refused it, or no reply
 * came on it in time), the previous choice is back and the agent is being
 * restarted onto it; the picker stays busy until the session reads it.
 */
const SWITCH_STATES = Object.freeze(['pending', 'confirmed', 'failed', 'restoring'])

/** A family alias or a catalog `claude-` id. */
export function isLaunchModel(x) {
  if (typeof x !== 'string') return false
  if (LAUNCH_MODEL_FAMILIES.includes(x)) return true
  return x.length <= LAUNCH_MODEL_ID_MAX && LAUNCH_MODEL_ID_PATTERN.test(x)
}

/** One of the five efforts the CLI takes at launch (never ultracode). */
export function isLaunchEffort(x) {
  return typeof x === 'string' && LAUNCH_EFFORTS.includes(x)
}

function readJson(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > FILE_MAX_CHARS) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function readChoice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isLaunchModel(value.model)) return null
  if (!(value.effort === null || isLaunchEffort(value.effort))) return null
  return { model: value.model, effort: value.effort }
}

/**
 * The launch choice in a file's text, or null.
 * @param {string | null | undefined} raw
 * @returns {{ model: string, effort: string | null } | null}
 */
export function parseLaunchChoice(raw) {
  const v = readJson(raw)
  if (!v || v.version !== 1) return null
  return readChoice(v)
}

/**
 * The file text for a choice. Throws on a choice the reader would refuse, so
 * nothing unreadable is ever written.
 * @param {{ model: string, effort: string | null }} choice
 */
export function launchChoiceBody(choice) {
  const c = readChoice(choice)
  if (!c) throw new Error('not a launch choice')
  return `${JSON.stringify({ version: 1, model: c.model, effort: c.effort })}\n`
}

/**
 * The claude flags for a choice: `--model` and, when there is one, `--effort`.
 * Nothing for no choice or an invalid one.
 * @param {{ model: string, effort: string | null } | null | undefined} choice
 * @returns {string[]}
 */
export function launchChoiceArgs(choice) {
  const c = readChoice(choice)
  if (!c) return []
  return c.effort ? ['--model', c.model, '--effort', c.effort] : ['--model', c.model]
}

function readObserved(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.model !== 'string' || !OBSERVED_MODEL_RE.test(value.model)) return null
  if (!(value.effort === null || (typeof value.effort === 'string' && /^[a-z]{1,20}$/.test(value.effort)))) return null
  return { model: value.model, effort: value.effort }
}

const isTime = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0

/**
 * @typedef {{
 *   state: 'pending' | 'confirmed' | 'failed' | 'restoring',
 *   target: { model: string, effort: string | null },
 *   previous: { model: string, effort: string | null } | null,
 *   from: { model: string, effort: string | null },
 *   sessionId: string,
 *   chatId: string,
 *   requestedAtMs: number,
 *   launchedAtMs: number | null,
 *   reason: string | null,
 *   noted: boolean,
 * }} ModelSwitch
 */

function readSwitch(v) {
  if (!v || v.version !== 1 || !SWITCH_STATES.includes(v.state)) return null
  const target = readChoice(v.target)
  if (!target) return null
  const previous = v.previous === null ? null : readChoice(v.previous)
  if (v.previous !== null && !previous) return null
  const from = readObserved(v.from)
  if (!from) return null
  if (typeof v.sessionId !== 'string' || !SESSION_ID_RE.test(v.sessionId)) return null
  if (typeof v.chatId !== 'string' || !CHAT_ID_RE.test(v.chatId)) return null
  if (!isTime(v.requestedAtMs)) return null
  if (!(v.launchedAtMs === null || isTime(v.launchedAtMs))) return null
  if (!(v.reason === null || (typeof v.reason === 'string' && REASON_RE.test(v.reason)))) return null
  if (typeof v.noted !== 'boolean') return null
  return {
    state: v.state,
    target,
    previous,
    from,
    sessionId: v.sessionId,
    chatId: v.chatId,
    requestedAtMs: v.requestedAtMs,
    launchedAtMs: v.launchedAtMs,
    reason: v.reason,
    noted: v.noted,
  }
}

/**
 * The model switch in a file's text, or null.
 * @param {string | null | undefined} raw
 * @returns {ModelSwitch | null}
 */
export function parseModelSwitch(raw) {
  return readSwitch(readJson(raw))
}

/**
 * The file text for a switch record. Throws on one the reader would refuse.
 * @param {ModelSwitch} record
 */
export function modelSwitchBody(record) {
  const r = readSwitch({ version: 1, ...record })
  if (!r) throw new Error('not a model switch record')
  return `${JSON.stringify({ version: 1, ...r })}\n`
}
