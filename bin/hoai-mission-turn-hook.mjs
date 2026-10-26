#!/usr/bin/env node
// The mission turn check (missions that stay true, board row 01a177c7). SYNCHRONOUS, registered for UserPromptSubmit
// and Stop. It reads no credentials and opens no socket: it finds THIS session's own daemon by its attached entry
// (lib/floor-state.mjs findOwnAttachedKey, as the private turn hook does), and talks to it only through the files in
// <state>/mission-turn (lib/mission-turn.mjs). Every error, timeout or missing file lets the turn go on: exit 0, nothing
// printed. The one thing it ever refuses is the END of a turn while a goal whose server check passes sits unticked, and
// only once per turn (Claude Code's stop_hook_active marks the second stop, which always goes through).
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findOwnAttachedKey, floorStateRoot, sessionFolders } from '../lib/floor-state.mjs'
import { privateMarkerPath, readPrivateJson } from '../lib/private-turn.mjs'
import {
  MISSION_TURN_ASK_WAIT_MS,
  MISSION_TURN_POLL_MS,
  missionTurnAnswerPath,
  missionTurnAskPath,
  missionTurnChatFor,
  missionTurnContext,
  missionTurnNeedsAsk,
  missionTurnRecord,
  missionTurnStatePath,
  missionTurnTurnPath,
  missionTurnStopDecision,
  promptChatId,
  readMissionTurnJson,
  writeMissionTurnJson,
} from '../lib/mission-turn.mjs'

const STARTED_AT = Date.now()
const envText = (env, name) => (env && typeof env[name] === 'string' ? env[name].trim() : '')

/** This session's own daemon key, or null (no daemon of this session attached: stay silent). */
export function ownMissionTurnKey(payload, env = process.env) {
  const root = floorStateRoot(env)
  const projectFolder = envText(env, 'CLAUDE_PROJECT_DIR')
  const transcriptPath = typeof payload?.transcript_path === 'string' ? payload.transcript_path : ''
  const base = projectFolder || (typeof payload?.cwd === 'string' ? payload.cwd : '')
  const sessionId = String(payload?.session_id ?? '').trim()
  const endedSession = (candidate) => {
    const marker = readPrivateJson(privateMarkerPath(root, candidate), 2048)
    return typeof marker?.ended === 'string' ? marker.ended : ''
  }
  const { key } = findOwnAttachedKey({
    root,
    folders: sessionFolders(payload, env),
    transcriptPath,
    projectFolder,
    base,
    sessionId,
    endedSession,
  })
  return key ? { root, key } : null
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))

/** Ask the daemon about THIS turn's chat and wait for ITS answer to THIS ask, until the deadline. Null when none came. */
function askDaemon(root, key, chatId) {
  const askId = randomUUID()
  writeMissionTurnJson(missionTurnAskPath(root, key), { askId, chatId, at: Date.now() })
  const answerPath = missionTurnAnswerPath(root, key)
  const deadline = STARTED_AT + MISSION_TURN_ASK_WAIT_MS
  while (Date.now() < deadline) {
    const answer = readMissionTurnJson(answerPath)
    if (answer && answer.askId === askId) return answer
    sleep(Math.min(MISSION_TURN_POLL_MS, deadline - Date.now()))
  }
  return null
}

/** What the hook prints for one payload ('' for nothing). Never throws. */
export function missionTurnHookOutput(payload, env = process.env) {
  try {
    const event = payload?.hook_event_name
    if (event !== 'UserPromptSubmit' && event !== 'Stop') return ''
    if (event === 'Stop' && payload?.stop_hook_active === true) return ''
    const own = ownMissionTurnKey(payload, env)
    if (!own) return ''
    const state = readMissionTurnJson(missionTurnStatePath(own.root, own.key))
    const sessionId = String(payload?.session_id ?? '').trim()
    if (event === 'UserPromptSubmit') {
      // Only the channel tag that OPENS the prompt names the turn's chat (promptChatId): a tag inside a person's
      // message is theirs to forge. The chat is recorded for this session, so its Stop asks about this turn's chat
      // rather than whatever the daemon last bound, which can lag a turn.
      const chatId = promptChatId(payload?.prompt)
      try {
        writeMissionTurnJson(missionTurnTurnPath(own.root, own.key), missionTurnRecord({ sessionId, chatId, now: Date.now() }))
      } catch {
        /* no record: this turn's Stop simply asks nothing */
      }
      if (!chatId || !state?.chats) return ''
      return missionTurnContext(state.chats[chatId]) ?? ''
    }
    const chatId = missionTurnChatFor(readMissionTurnJson(missionTurnTurnPath(own.root, own.key)), sessionId)
    if (!missionTurnNeedsAsk(state, chatId)) return ''
    const answer = askDaemon(own.root, own.key, chatId)
    // From the answer to THIS ask only: no answer in time allows (the state on disk is never a reason to block).
    const decision = missionTurnStopDecision({ stopHookActive: false, answer })
    return decision.block ? JSON.stringify({ decision: 'block', reason: decision.reason }) : ''
  } catch {
    return ''
  }
}

function readStdin() {
  return new Promise((resolveInput) => {
    let data = ''
    let size = 0
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      size += chunk.length
      if (size <= 16 * 1024 * 1024) data += chunk
    })
    process.stdin.on('end', () => resolveInput(data))
    process.stdin.on('error', () => resolveInput(''))
  })
}

async function main() {
  let payload = null
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    return
  }
  const out = missionTurnHookOutput(payload)
  if (out) process.stdout.write(out)
}

const self = (() => {
  try {
    return pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
  } catch {
    return import.meta.url
  }
})()
const invoked = (() => {
  try {
    return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ''
  } catch {
    return ''
  }
})()
if (self === invoked) {
  main()
    .catch(() => {})
    .finally(() => {
      process.exitCode = 0
    })
}
