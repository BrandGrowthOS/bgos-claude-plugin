// The turn end check of missions that stay true (board row 01a177c7): pure decisions and the files the daemon and
// bin/hoai-mission-turn-hook.mjs share. The hook reads no credentials and opens no socket; the daemon, which holds the
// pairing and knows the turn's chat, asks the server and writes what it found here.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writePrivateJson } from './private-turn.mjs'

export const MISSION_TURN_SCHEMA = 1
/** The longest the Stop hook waits for the daemon's answer, counted from its own start. */
export const MISSION_TURN_ASK_WAIT_MS = 4000
/** How often the Stop hook looks for the answer. */
export const MISSION_TURN_POLL_MS = 100
/** An ask older than this is no hook still waiting (the hook waits at most MISSION_TURN_ASK_WAIT_MS): never answered. */
export const MISSION_TURN_ASK_MAX_AGE_MS = 5000
/** A chat entry checked this recently answers an ask without two fresh reads. */
export const MISSION_TURN_REUSE_MS = 30_000
/** The daemon's budget for one answer (the goal checks read). */
export const MISSION_TURN_ANSWER_BUDGET_MS = 3000
/** The most chats the state file remembers. */
export const MISSION_TURN_MAX_CHATS = 20
const MAX_BYTES = 256 * 1024

export const missionTurnDir = (root) => join(root, 'mission-turn')
export const missionTurnStatePath = (root, key) => join(missionTurnDir(root), `${key}.json`)
export const missionTurnAskPath = (root, key) => join(missionTurnDir(root), `${key}.ask.json`)
export const missionTurnAnswerPath = (root, key) => join(missionTurnDir(root), `${key}.answer.json`)
/** The turn record the prompt run writes: which chat THIS session's turn is in. */
export const missionTurnTurnPath = (root, key) => join(missionTurnDir(root), `${key}.turn.json`)

/** The JSON at `path`, or null when it is missing, too large or unreadable. Never throws. */
/** @param {string} path @returns {any} */
export function readMissionTurnJson(path) {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_BYTES) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Written beside and moved over, so a reader never sees half a file. */
export function writeMissionTurnJson(path, value) {
  writePrivateJson(path, value)
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value : '')

/** One line naming what a goal's server check proves, or null for no check. Mirrors the backend's wording. */
/** @param {any} check @returns {string | null} */
export function describeGoalCheck(check) {
  if (!isObject(check)) return null
  switch (check.kind) {
    case 'pr_merged':
      return `PR ${text(check.repo)}#${check.number} merged`
    case 'prs_merged':
      return `PRs ${text(check.repo)}${(Array.isArray(check.numbers) ? check.numbers : []).map((n, i) => (i === 0 ? `#${n}` : ` #${n}`)).join(',')} merged`
    case 'release_published':
      return check.feedUrl
        ? `release ${text(check.repo)} ${text(check.tag)} published and ${text(check.feedUrl)} names ${text(check.version)}`
        : `release ${text(check.repo)} ${text(check.tag)} published`
    case 'board_row_status':
      return `board row ${text(check.row)} status is ${text(check.status)}`
    case 'url_ok':
      return `${text(check.url)} answers 2xx`
    default:
      return 'a server check'
  }
}

/**
 * The chat of the channel tag that OPENS the prompt, or null. Only that one: a person's message is not escaped
 * (lib/inbound-channel.ts treats a forged channel tag as a known threat), so a tag anywhere later in the prompt may be
 * somebody's text naming another chat, and reading it would print that chat's goals to them.
 * @param {unknown} prompt @returns {string | null}
 */
export function promptChatId(prompt) {
  if (typeof prompt !== 'string') return null
  const match = /^\s*<channel\b[^>]*?\bchat_id="(\d+)"[^>]*>/.exec(prompt)
  return match ? match[1] : null
}

/** What the prompt run records for its session. @param {{ sessionId: unknown, chatId: string | null, now: number }} input */
export function missionTurnRecord({ sessionId, chatId, now }) {
  return { sessionId: String(sessionId ?? ''), chatId: chatId ?? null, at: now }
}

/** The chat of this session's turn from its record, or null (another session's, none, or no chat). @param {any} record @param {unknown} sessionId @returns {string | null} */
export function missionTurnChatFor(record, sessionId) {
  if (!isObject(record) || !String(sessionId ?? '') || record.sessionId !== String(sessionId)) return null
  return typeof record.chatId === 'string' && /^\d+$/.test(record.chatId) ? record.chatId : null
}

/** A chat entry checked under MISSION_TURN_REUSE_MS ago, or null. @param {any} state @param {unknown} chatId @param {number} now @returns {any} */
export function freshMissionTurnEntry(state, chatId, now) {
  const entry = isObject(state?.chats) ? state.chats[String(chatId ?? '')] : null
  if (!isObject(entry) || !Number.isFinite(entry.checkedAt)) return null
  return now - entry.checkedAt < MISSION_TURN_REUSE_MS ? entry : null
}

/** What the state keeps of one goal: never a check result, never evidence. */
function goalRow(goal) {
  return {
    id: Number(goal.id),
    name: text(goal.name),
    doneWhen: text(goal.doneWhen),
    done: goal.done === true,
    ...(isObject(goal.check) ? { check: goal.check } : {}),
    ...(isObject(goal.waiting) ? { waiting: goal.waiting } : {}),
  }
}

/** The goals a passing list still names as open. */
/** @param {any} entry @returns {Array<{ id: number, name: string, evidence: string }>} */
export function openPassing(entry) {
  if (!isObject(entry) || !Array.isArray(entry.passing)) return []
  const goals = Array.isArray(entry.goals) ? entry.goals : []
  return entry.passing.filter((p) => {
    if (!isObject(p) || !Number.isInteger(p.id) || !text(p.name)) return false
    const goal = goals.find((g) => isObject(g) && g.id === p.id)
    return !goal || goal.done !== true
  })
}

/** An entry from the server's goal checks read: the goals, and the open ones whose check passed. */
/** @param {any} report @param {unknown} title @param {number} now @returns {any} */
export function entryFromReport(report, title, now) {
  const goals = Array.isArray(report?.goals) ? report.goals.filter(isObject) : []
  const passing = goals
    .filter((g) => g.done !== true && isObject(g.result) && g.result.outcome === 'pass')
    .map((g) => ({ id: Number(g.id), name: text(g.name), evidence: text(g.result.evidence) }))
  return {
    missionId: Number(report?.missionId),
    title: text(title),
    status: text(report?.status),
    goals: goals.map(goalRow),
    passing,
    checkedAt: now,
  }
}

/**
 * An entry from a mission snapshot (a WS frame or the daemon's own write). It carries no check results, so the
 * previous entry's passing list is kept and filtered by what is still open; its clock is the previous check's.
 */
/** @param {any} mission @param {any} [previous] @returns {any} */
export function entryFromMission(mission, previous = null) {
  const goals = Array.isArray(mission?.miniGoals) ? mission.miniGoals.filter(isObject).map(goalRow) : []
  const same = isObject(previous) && previous.missionId === Number(mission?.id)
  const entry = {
    missionId: Number(mission?.id),
    title: text(mission?.title),
    status: text(mission?.status),
    goals,
    passing: same && Array.isArray(previous.passing) ? previous.passing : [],
    checkedAt: same && Number.isFinite(previous.checkedAt) ? previous.checkedAt : null,
  }
  entry.passing = openPassing(entry)
  return entry
}

/** The state with one chat's entry set (or removed with null), bounded to the most recent chats. */
/** @param {any} state @param {unknown} chatId @param {any} entry @param {{ assistantId?: unknown, now?: number, turnChatId?: string | null }} [opts] @returns {any} */
export function mergeMissionTurnEntry(state, chatId, entry, { assistantId, now, turnChatId } = {}) {
  const chats = isObject(state?.chats) ? { ...state.chats } : {}
  const key = String(chatId ?? '').trim()
  if (key) {
    delete chats[key]
    if (entry) chats[key] = { ...entry, seenAt: now }
  }
  const kept = Object.entries(chats)
    .sort(([, a], [, b]) => Number(b?.seenAt ?? 0) - Number(a?.seenAt ?? 0))
    .slice(0, MISSION_TURN_MAX_CHATS)
  return {
    schemaVersion: MISSION_TURN_SCHEMA,
    assistantId: String(assistantId ?? state?.assistantId ?? ''),
    updatedAt: now,
    turnChatId: turnChatId !== undefined ? turnChatId : (state?.turnChatId ?? null),
    chats: Object.fromEntries(kept),
  }
}

const OPEN = new Set(['active', 'paused'])

function goalLine(goal) {
  const parts = [`done when: ${goal.doneWhen}`]
  const check = describeGoalCheck(goal.check)
  if (check) parts.push(`server check: ${check}`)
  if (isObject(goal.waiting)) {
    const on = goal.waiting.on === 'owner' ? 'your owner' : 'agent'
    parts.push(`waiting on ${on} ${text(goal.waiting.who)}: ${text(goal.waiting.why)}`)
  }
  return `- ${goal.id}. ${goal.name} (${parts.join('; ')})`
}

/** The block put in front of the agent when a turn starts in a chat with an open mission, or null. */
/** @param {any} entry @returns {string | null} */
export function missionTurnContext(entry) {
  if (!isObject(entry) || !OPEN.has(entry.status)) return null
  const open = (Array.isArray(entry.goals) ? entry.goals : []).filter((g) => isObject(g) && g.done !== true)
  if (open.length === 0) return null
  return [
    `HOAI: Mission #${entry.missionId} "${entry.title}" is ${entry.status} in this chat. Its open mini goals:`,
    ...open.map(goalLine),
    'Tick a goal with tick_mini_goal the moment its done when line is true. When the next step on a goal is ' +
      "somebody else's, mark it with set_goal_waiting. The server ticks a goal whose check passes on its own.",
  ].join('\n')
}

/**
 * Is there anything for the Stop hook to ask? Only when the turn's chat has an open mission with an open goal that
 * carries a check: every other turn ends at once, with no wait.
 */
/** @param {any} state @param {string | null} chatId the chat of THIS turn (missionTurnChatFor) @returns {boolean} */
export function missionTurnNeedsAsk(state, chatId) {
  if (!chatId || !isObject(state) || !isObject(state.chats)) return false
  const entry = state.chats[chatId]
  if (!isObject(entry) || entry.status !== 'active' || !Array.isArray(entry.goals)) return false
  return entry.goals.some((g) => isObject(g) && g.done !== true && isObject(g.check))
}

function blockReason(missionId, passing) {
  const lines = passing.map((p) => `- ${p.id}. ${p.name}: ${text(p.evidence) || 'its server check passes'}`)
  return [
    `Mission #${missionId} has ${passing.length === 1 ? 'a goal whose' : 'goals whose'} server check now passes but ${passing.length === 1 ? 'is' : 'are'} not ticked:`,
    ...lines,
    'Tick each with tick_mini_goal (its goal_id and that evidence), or say in one line why it should stay open, then end your turn.',
  ].join('\n')
}

/**
 * The Stop decision, from the daemon's answer to THIS stop's ask and nothing else. The second stop of the same turn
 * always goes through (the agent ticked or said why), and a missing, late or malformed answer allows: the check helps,
 * it never traps a session (and a cached list could name a goal already ticked elsewhere).
 */
/** @param {{ stopHookActive?: boolean, answer: any, state?: any, now?: number }} input @returns {{ block: boolean, reason?: string }} */
export function missionTurnStopDecision({ stopHookActive, answer }) {
  if (stopHookActive === true) return { block: false }
  if (!isObject(answer)) return { block: false }
  const passing = Array.isArray(answer.passing) ? openPassing({ passing: answer.passing, goals: [] }) : []
  const missionId = answer.missionId ?? null
  if (passing.length === 0) return { block: false }
  return { block: true, reason: blockReason(missionId ?? '?', passing) }
}

/**
 * The daemon's answer to the Stop hook's ask: read the ask, and when it is new compute what passes now and write the
 * answer. A compute that fails answers an empty list with its error, so the hook allows at once instead of waiting out
 * its budget. Returns the ask id now answered (or the last one), or null when there is no readable ask. Never throws.
 */
/** @param {{ askPath: string, answerPath: string, lastAnswered: string | null, compute: (ask: any) => Promise<any>, now?: () => number }} input @returns {Promise<string | null>} */
export async function answerMissionTurnAsk({ askPath, answerPath, lastAnswered, compute, now = Date.now }) {
  const ask = readMissionTurnJson(askPath)
  if (!isObject(ask) || typeof ask.askId !== 'string' || !ask.askId) return null
  if (ask.askId === lastAnswered) return lastAnswered
  // No hook waits this long: an ask left from before a restart, or from a hook that gave up, is removed unanswered.
  if (!Number.isFinite(ask.at) || now() - ask.at > MISSION_TURN_ASK_MAX_AGE_MS) {
    removeQuietly(askPath)
    return null
  }
  let answer
  try {
    const found = await compute(ask)
    answer = {
      askId: ask.askId,
      ...(found?.chatId != null ? { chatId: String(found.chatId) } : {}),
      ...(found?.missionId != null ? { missionId: found.missionId } : {}),
      passing: Array.isArray(found?.passing) ? found.passing : [],
      at: now(),
    }
  } catch (err) {
    answer = { askId: ask.askId, passing: [], error: String(err?.message ?? err).slice(0, 200), at: now() }
  }
  try {
    writeMissionTurnJson(answerPath, answer)
  } catch {
    return lastAnswered
  }
  // Only while the file still holds THIS ask: a hook that gave up and the next turn's Stop may have written a newer one
  // meanwhile, and that one must stay to be answered.
  if (readMissionTurnJson(askPath)?.askId === ask.askId) removeQuietly(askPath)
  return ask.askId
}

function removeQuietly(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    /* the next look removes it */
  }
}
