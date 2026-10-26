import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The daemon half of the mission turn check (missions that stay true), pinned
 * at the source: the pure parts are proven in test/mission-turn.test.ts, and
 * these are the places server.ts must call them from, or the hook reads a
 * file nobody writes and every turn simply ends (silent, never wrong, but the
 * check would be gone).
 */

const source = readFileSync('server.ts', 'utf8')
const between = (start: string, end: string) => {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `missing: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `missing end: ${end}`)
  return source.slice(from, to)
}

test('the turn start binds the turn chat into the mission turn state and refreshes it', () => {
  const prompt = between("if (event.name === 'UserPromptSubmit') {", 'const { next, effects } = applyHookEventToTurn(')
  const begin = prompt.indexOf('turnChat.beginTurn(')
  const note = prompt.indexOf('noteMissionTurnStart(')
  assert.ok(begin >= 0 && note > begin, 'noteMissionTurnStart runs after the turn chat is bound')
})

test('every mission frame and every own mission write updates the state, with no network call', () => {
  const frame = between('function handleMissionEvent(', 'function ')
  assert.match(frame, /noteMissionTurnSnapshot\(event\.mission\)/)
  const own = between('function rememberMissionSelfWrite(', '\n}\n')
  assert.match(own, /noteMissionTurnSnapshot\(mission\)/)
  const snapshot = between('function noteMissionTurnSnapshot(', '\n}\n')
  assert.doesNotMatch(snapshot, /bgos(Get|Post|Patch|Put|Delete)|fetch\(/)
})

test('the ask is answered only by the pairing lock holder, within its budget, through the pure writer', () => {
  const answer = between('async function answerMissionTurnAsks(', '\n}\n')
  assert.match(answer, /if \(!lockHeld\) return/)
  assert.match(answer, /answerMissionTurnAsk\(/)
  assert.match(answer, /MISSION_TURN_ANSWER_BUDGET_MS/)
})

test('the watcher never keeps the process alive and has a polling fallback', () => {
  const start = between('function startMissionTurnWatch(', '\n}\n')
  assert.match(start, /persistent: false/)
  assert.match(start, /setInterval\([\s\S]*\.unref\(\)/)
  assert.match(source, /startMissionTurnWatch\(\)/)
})

test('the state is written only by the lock holder', () => {
  const write = between('function writeMissionTurnState(', '\n}\n')
  assert.match(write, /if \(!lockHeld\) return/)
})

test("the answer is for the ASK's chat, only one this daemon delivered to recently, from a fresh entry when it has one (review fixes 4 and 6)", () => {
  const answerFor = between('async function missionTurnAnswerFor(', '\n}\n')
  assert.match(answerFor, /ask\?\.chatId/)
  assert.match(answerFor, /turnChat\.deliveredRecently\(/)
  assert.match(answerFor, /freshMissionTurnEntry\(/)
  // The daemon's own idea of the turn chat, which can lag a turn, is not read here.
  assert.doesNotMatch(answerFor, /turnChatId|turnChat\.current\(/)
  const answer = between('async function answerMissionTurnAsks(', '\n}\n')
  assert.match(answer, /missionTurnAnswerFor\(ask\)/)
})
