import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  MISSION_TURN_STATE_FRESH_MS,
  answerMissionTurnAsk,
  describeGoalCheck,
  entryFromMission,
  entryFromReport,
  mergeMissionTurnEntry,
  missionTurnAnswerPath,
  missionTurnAskPath,
  missionTurnContext,
  missionTurnNeedsAsk,
  missionTurnStopDecision,
  openPassing,
  promptChatId,
  readMissionTurnJson,
  writeMissionTurnJson,
} from '../lib/mission-turn.mjs'

/**
 * THE TURN END CHECK (missions that stay true, board row 01a177c7). Pure
 * decisions behind bin/hoai-mission-turn-hook.mjs and the daemon's answer.
 *
 * The rule: a turn in a chat with an open mission may not end while a goal
 * whose server check now PASSES sits unticked. The agent ticks it, or says
 * why not; the second stop of the same turn (Claude Code's
 * stop_hook_active) always goes through, so a session is never trapped. Any
 * missing, stale or unreadable answer lets the turn end. Each block test here
 * is mutation proven (MUTATIONS-plugin.md).
 */

const NOW = Date.now()
const CHECK = { kind: 'pr_merged', repo: 'BrandGrowthOS/BGOS', number: 3306 }

function report(goals: any[]) {
  return { missionId: 12, status: 'active', checkedAt: new Date(NOW).toISOString(), goals }
}

const PASS_GOAL = {
  id: 2,
  name: 'Merge',
  doneWhen: 'PR 3306 is merged',
  done: false,
  check: CHECK,
  result: { outcome: 'pass', evidence: 'Checked by the server: PR BrandGrowthOS/BGOS#3306 merged' },
}

test('describeGoalCheck names each kind in one line, and nothing for no check', () => {
  assert.equal(describeGoalCheck(CHECK), 'PR BrandGrowthOS/BGOS#3306 merged')
  assert.equal(describeGoalCheck({ kind: 'prs_merged', repo: 'a/b', numbers: [1, 2] }), 'PRs a/b#1, #2 merged')
  assert.equal(describeGoalCheck({ kind: 'release_published', repo: 'a/b', tag: 'v1' }), 'release a/b v1 published')
  assert.equal(describeGoalCheck({ kind: 'board_row_status', board: 'x', row: '0000abcd', status: 'Done' }), 'board row 0000abcd status is Done')
  assert.equal(describeGoalCheck({ kind: 'url_ok', url: 'https://hoai.app/health' }), 'https://hoai.app/health answers 2xx')
  assert.equal(describeGoalCheck(undefined), null)
  assert.equal(describeGoalCheck({ kind: 'mystery' }), 'a server check')
})

test('promptChatId reads the LAST channel card of the prompt, and nothing without one', () => {
  assert.equal(promptChatId('<channel source="plugin:hoai:bgos" chat_id="12" message_id="7">hi</channel>'), '12')
  assert.equal(
    promptChatId('<channel source="bgos" chat_id="1">a</channel>\n<channel source="bgos" chat_id="2">b</channel>'),
    '2',
  )
  assert.equal(promptChatId('please look at chat_id="99" in the logs'), null)
  assert.equal(promptChatId(undefined), null)
})

test('the daemon keeps only goals that passed and are still open', () => {
  const entry = entryFromReport(
    report([PASS_GOAL, { ...PASS_GOAL, id: 3, done: true }, { ...PASS_GOAL, id: 4, result: { outcome: 'error', detail: 'x' } }]),
    'Ship it',
    NOW,
  )
  assert.deepEqual(entry.passing, [{ id: 2, name: 'Merge', evidence: PASS_GOAL.result.evidence }])
  assert.equal(entry.missionId, 12)
  assert.equal(entry.goals.length, 3)
  assert.equal(entry.goals[0].check.kind, 'pr_merged')
  assert.equal('result' in entry.goals[0], false)
})

test('a mission frame refreshes the goals and drops a passing goal the agent has since ticked', () => {
  const before = entryFromReport(report([PASS_GOAL]), 'Ship it', NOW)
  const ticked = entryFromMission(
    { id: 12, title: 'Ship it', status: 'active', miniGoals: [{ ...PASS_GOAL, done: true, doneAt: 'x', evidence: 'by hand' }] },
    before,
  )
  assert.equal(ticked.goals[0].done, true)
  assert.deepEqual(openPassing(ticked), [])
})

// -- the Stop decision ------------------------------------------------------

test('BLOCKS while a goal whose check passes is unticked, naming it and its evidence', () => {
  const decision = missionTurnStopDecision({
    stopHookActive: false,
    answer: { askId: 'a', chatId: '12', missionId: 12, passing: [{ id: 2, name: 'Merge', evidence: 'Checked by the server: merged' }] },
    state: null,
    now: NOW,
  })
  assert.equal(decision.block, true)
  assert.match(decision.reason ?? "", /2\. Merge/)
  assert.match(decision.reason ?? "", /Checked by the server: merged/)
  assert.match(decision.reason ?? "", /tick_mini_goal/)
  assert.match(decision.reason ?? "", /why/)
})

test('ALLOWS the second stop of the same turn (stop_hook_active): the agent already answered', () => {
  const decision = missionTurnStopDecision({
    stopHookActive: true,
    answer: { askId: 'a', missionId: 12, passing: [{ id: 2, name: 'Merge', evidence: 'x' }] },
    state: null,
    now: NOW,
  })
  assert.equal(decision.block, false)
})

test('ALLOWS when nothing passes, and when the answer says the daemon could not ask', () => {
  assert.equal(missionTurnStopDecision({ stopHookActive: false, answer: { askId: 'a', passing: [] }, state: null, now: NOW }).block, false)
  assert.equal(
    missionTurnStopDecision({ stopHookActive: false, answer: { askId: 'a', passing: [], error: 'GET 404' }, state: null, now: NOW }).block,
    false,
  )
})

test('with no answer, falls back to the state file only while it is fresh', () => {
  const entry = entryFromReport(report([PASS_GOAL]), 'Ship it', NOW)
  const state = { schemaVersion: 1, turnChatId: '12', chats: { '12': entry } }
  assert.equal(missionTurnStopDecision({ stopHookActive: false, answer: null, state, now: NOW + 1000 }).block, true)
  assert.equal(
    missionTurnStopDecision({ stopHookActive: false, answer: null, state, now: NOW + MISSION_TURN_STATE_FRESH_MS + 1 }).block,
    false,
  )
})

test('ALLOWS on a missing or malformed state and answer', () => {
  assert.equal(missionTurnStopDecision({ stopHookActive: false, answer: null, state: null, now: NOW }).block, false)
  assert.equal(missionTurnStopDecision({ stopHookActive: false, answer: { passing: 'nope' } as any, state: { chats: 7 } as any, now: NOW }).block, false)
  assert.equal(
    missionTurnStopDecision({ stopHookActive: false, answer: null, state: { turnChatId: '12', chats: { '12': { passing: [{}] } } } as any, now: NOW }).block,
    false,
  )
})

// -- the turn start context -------------------------------------------------

test('the turn start block lists the open goals with their check and waiting state', () => {
  const entry = entryFromMission({
    id: 12,
    title: 'Ship it',
    status: 'active',
    miniGoals: [
      { id: 1, name: 'Draft', doneWhen: 'a draft exists', done: true },
      { id: 2, name: 'Merge', doneWhen: 'PR 3306 is merged', done: false, check: CHECK },
      { id: 3, name: 'Announce', doneWhen: 'posted', done: false, waiting: { on: 'owner', who: 'KC', why: 'picks the date', since: 'x' } },
    ],
  })
  const text = missionTurnContext(entry)
  assert.ok(text)
  assert.match(text!, /Mission #12 "Ship it"/)
  assert.match(text!, /2\. Merge \(done when: PR 3306 is merged; server check: PR BrandGrowthOS\/BGOS#3306 merged\)/)
  assert.match(text!, /3\. Announce \(done when: posted; waiting on your owner KC: picks the date\)/)
  assert.doesNotMatch(text!, /Draft/)
  assert.doesNotMatch(text!, /[\u2013\u2014]/)
})

test('no block without an open mission or without an open goal', () => {
  assert.equal(missionTurnContext(null), null)
  assert.equal(missionTurnContext(entryFromMission({ id: 1, title: 't', status: 'completed', miniGoals: [{ id: 1, name: 'a', doneWhen: 'b', done: false }] })), null)
  assert.equal(missionTurnContext(entryFromMission({ id: 1, title: 't', status: 'active', miniGoals: [{ id: 1, name: 'a', doneWhen: 'b', done: true }] })), null)
})

test('mergeMissionTurnEntry keeps other chats, drops a closed one, and bounds the file', () => {
  let state: any = null
  for (let i = 0; i < 30; i++) {
    state = mergeMissionTurnEntry(state, String(i), entryFromMission({ id: i + 1, title: 't', status: 'active', miniGoals: [] }), { assistantId: '7', now: NOW + i })
  }
  assert.ok(Object.keys(state.chats).length <= 20)
  assert.ok(state.chats['29'])
  state = mergeMissionTurnEntry(state, '29', null, { assistantId: '7', now: NOW + 99 })
  assert.equal(state.chats['29'], undefined)
  assert.equal(state.schemaVersion, 1)
})

// -- the daemon's answer to an ask ------------------------------------------

test('answerMissionTurnAsk answers a new ask once, with what compute found', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-mission-turn-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const key = 'k1'
  const ask = missionTurnAskPath(root, key)
  const answerPath = missionTurnAnswerPath(root, key)
  writeMissionTurnJson(ask, { askId: 'ask-1', at: NOW })
  let computed = 0
  const compute = async () => {
    computed++
    return { chatId: '12', missionId: 12, passing: [{ id: 2, name: 'Merge', evidence: 'e' }] }
  }
  const first = await answerMissionTurnAsk({ askPath: ask, answerPath, lastAnswered: null, compute, now: () => NOW })
  assert.equal(first, 'ask-1')
  assert.deepEqual(readMissionTurnJson(answerPath), { askId: 'ask-1', chatId: '12', missionId: 12, passing: [{ id: 2, name: 'Merge', evidence: 'e' }], at: NOW })
  // The same ask again is not answered twice.
  assert.equal(await answerMissionTurnAsk({ askPath: ask, answerPath, lastAnswered: 'ask-1', compute, now: () => NOW }), 'ask-1')
  assert.equal(computed, 1)
})

test('answerMissionTurnAsk answers an empty list when compute fails, so the hook allows at once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-mission-turn-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ask = missionTurnAskPath(root, 'k')
  const answerPath = missionTurnAnswerPath(root, 'k')
  writeMissionTurnJson(ask, { askId: 'ask-2', at: NOW })
  await answerMissionTurnAsk({
    askPath: ask,
    answerPath,
    lastAnswered: null,
    compute: async () => {
      throw new Error('GET 404: not found')
    },
    now: () => NOW,
  })
  const answer = readMissionTurnJson(answerPath)
  assert.equal(answer.askId, 'ask-2')
  assert.deepEqual(answer.passing, [])
  assert.match(answer.error, /404/)
})

test('answerMissionTurnAsk ignores a missing or malformed ask', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-mission-turn-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ask = missionTurnAskPath(root, 'k')
  const answerPath = missionTurnAnswerPath(root, 'k')
  assert.equal(await answerMissionTurnAsk({ askPath: ask, answerPath, lastAnswered: null, compute: async () => ({ passing: [] }), now: () => NOW }), null)
  mkdirSync(dirname(ask), { recursive: true })
  writeFileSync(ask, 'not json')
  assert.equal(await answerMissionTurnAsk({ askPath: ask, answerPath, lastAnswered: null, compute: async () => ({ passing: [] }), now: () => NOW }), null)
  assert.equal(existsSync(answerPath), false)
})

test('the Stop hook asks the daemon only when the turn chat has an open goal with a check', () => {
  const withCheck = entryFromMission({ id: 12, title: 't', status: 'active', miniGoals: [{ id: 2, name: 'Merge', doneWhen: 'm', done: false, check: CHECK }] })
  const noCheck = entryFromMission({ id: 12, title: 't', status: 'active', miniGoals: [{ id: 2, name: 'Merge', doneWhen: 'm', done: false }] })
  const closed = entryFromMission({ id: 12, title: 't', status: 'completed', miniGoals: [{ id: 2, name: 'Merge', doneWhen: 'm', done: false, check: CHECK }] })
  assert.equal(missionTurnNeedsAsk({ turnChatId: '12', chats: { '12': withCheck } }), true)
  assert.equal(missionTurnNeedsAsk({ turnChatId: '12', chats: { '12': noCheck } }), false)
  assert.equal(missionTurnNeedsAsk({ turnChatId: '12', chats: { '12': closed } }), false)
  assert.equal(missionTurnNeedsAsk({ turnChatId: '13', chats: { '12': withCheck } }), false)
  assert.equal(missionTurnNeedsAsk(null), false)
})
