import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountRoom, agentLimitFrom, limitScope, mostWeekRoom, roomBlocked } from '../lib/helper-account-limits.mjs'

const NOW = Date.UTC(2026, 10, 20, 12)
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()
const line = (value: object) => JSON.stringify(value)
const turn = (at: number, model = 'claude-opus-5-5') =>
  line({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', model, content: [{ type: 'text', text: 'Done.' }] } })
const owner = (at: number) =>
  line({ type: 'user', timestamp: iso(at), message: { role: 'user', content: '<channel chat_id="1" sender_type="user">hi</channel>' } })
const refusal = (at: number, words: string, resetsAt?: number) =>
  line({
    type: 'assistant',
    timestamp: iso(at),
    isApiErrorMessage: true,
    error: 'rate_limit',
    ...(resetsAt ? { apiErrorParams: { rate_limit_info: { resetsAt: resetsAt / 1000 } } } : {}),
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: words }] },
  })

test('limitScope names the model a limit line is about, or the whole account', () => {
  assert.deepEqual(limitScope("You've hit your session limit · resets 7:40pm (Asia/Dubai)"), { model: null })
  assert.deepEqual(limitScope("You've hit your weekly limit · resets Nov 6, 8pm (Asia/Dubai)"), { model: null })
  assert.deepEqual(limitScope("You've hit your limit · resets 11pm (Asia/Dubai)"), { model: null })
  assert.deepEqual(limitScope("You've reached your Fable limit."), { model: 'fable' })
  assert.deepEqual(limitScope("You’ve hit your Opus limit · resets 4am"), { model: 'opus' })
  assert.deepEqual(limitScope("You've hit your weekly Opus limit · resets Jul 10 at 10pm"), { model: 'opus' })
  assert.deepEqual(limitScope("You've hit your Sonnet 4.5 weekly limit"), { model: 'sonnet' })
})

test('limitScope refuses transient throttling and text that is not the CLI line', () => {
  assert.equal(limitScope("Server busy: you've hit your rate limit, retrying automatically"), null)
  assert.equal(limitScope('API Error: 429 rate limited'), null)
  assert.equal(limitScope('the owner wrote about a limit'), null)
  assert.equal(limitScope(''), null)
  assert.equal(limitScope(undefined), null)
})

test('agentLimitFrom reads the newest refusal, its model and the reset Claude gave', () => {
  const tail = [turn(NOW - 30 * MIN), owner(NOW - 5 * MIN), refusal(NOW - 4 * MIN, "You've hit your Opus limit · resets 4pm", NOW + 4 * HOUR)].join('\n')
  assert.deepEqual(agentLimitFrom(tail, NOW), {
    atMs: NOW - 4 * MIN,
    resetsAtMs: NOW + 4 * HOUR,
    model: 'opus',
    agentModel: 'opus',
  })
})

test('a real turn after the refusal ends the limit', () => {
  const tail = [refusal(NOW - 10 * MIN, "You've hit your session limit", NOW + HOUR), turn(NOW - 2 * MIN)].join('\n')
  assert.equal(agentLimitFrom(tail, NOW), null)
})

test('an old refusal, a throttle or no refusal is not a limit', () => {
  assert.equal(agentLimitFrom(turn(NOW - MIN), NOW), null)
  assert.equal(agentLimitFrom(refusal(NOW - 6 * HOUR, "You've hit your session limit"), NOW), null)
  assert.equal(agentLimitFrom(refusal(NOW - MIN, "Server busy: you've hit your rate limit, retrying automatically"), NOW), null)
  assert.equal(agentLimitFrom(null, NOW), null)
})

test('without a reset from Claude the block lasts the window the line names', () => {
  const session = agentLimitFrom(refusal(NOW - MIN, "You've hit your session limit"), NOW)
  assert.equal(session?.resetsAtMs, NOW - MIN + 5 * HOUR)
  const model = agentLimitFrom(refusal(NOW - MIN, "You've reached your Fable limit."), NOW)
  assert.equal(model?.resetsAtMs, NOW - MIN + 7 * 24 * HOUR)
  assert.equal(model?.model, 'fable')
})

test('roomBlocked: a model limit blocks only that model until its reset, an account limit blocks all', () => {
  const blocks = { opus: iso(NOW + HOUR) }
  assert.equal(roomBlocked(blocks, 'opus', NOW), true)
  assert.equal(roomBlocked(blocks, 'sonnet', NOW), false)
  // An agent whose model is not known could be on the blocked one.
  assert.equal(roomBlocked(blocks, null, NOW), true)
  assert.equal(roomBlocked(blocks, 'opus', NOW + HOUR + 1), false)
  assert.equal(roomBlocked({ '*': iso(NOW + HOUR) }, 'sonnet', NOW), true)
  assert.equal(roomBlocked(undefined, 'opus', NOW), false)
  assert.equal(roomBlocked({ opus: 'not a time' }, 'opus', NOW), false)
})

test('accountRoom is week room from the statusline reading; a passed week reset is a full week', () => {
  const windows = (used: number, resetAt = NOW + 24 * HOUR, readAt = NOW - MIN) => ({ readAt: iso(readAt), week: { used, resetAt: iso(resetAt) } })
  assert.equal(accountRoom(windows(30), NOW), 70)
  assert.equal(accountRoom(windows(30, NOW - MIN), NOW), 100)
  assert.equal(accountRoom(undefined, NOW), null)
  assert.equal(accountRoom({ readAt: iso(NOW - MIN) }, NOW), null)
  // A reading more than a day old says nothing about this week.
  assert.equal(accountRoom(windows(30, NOW + 24 * HOUR, NOW - 25 * HOUR), NOW), null)
  // A reading from the future is not trusted.
  assert.equal(accountRoom(windows(30, NOW + 24 * HOUR, NOW + 10 * MIN), NOW), null)
})

test('mostWeekRoom picks the signed in account with the most week room, never a blocked one', () => {
  const accounts = [
    { id: 'a', signedIn: true, room: 20, blocks: {} },
    { id: 'b', signedIn: true, room: 64, blocks: {} },
    { id: 'c', signedIn: true, room: 86, blocks: { opus: iso(NOW + HOUR) } },
    { id: 'd', signedIn: false, room: 99, blocks: {} },
  ]
  assert.equal(mostWeekRoom({ accounts, model: 'opus', current: 'a', now: NOW }), 'b')
  // Sonnet is not blocked on c.
  assert.equal(mostWeekRoom({ accounts, model: 'sonnet', current: 'a', now: NOW }), 'c')
})

test('mostWeekRoom: a tie keeps the current account, no room or no reading waits', () => {
  const tie = [
    { id: 'a', signedIn: true, room: 50, blocks: {} },
    { id: 'b', signedIn: true, room: 50, blocks: {} },
  ]
  assert.equal(mostWeekRoom({ accounts: tie, model: 'opus', current: 'b', now: NOW }), 'b')
  assert.equal(mostWeekRoom({ accounts: tie, model: 'opus', current: null, now: NOW }), 'a')
  const full = [{ id: 'a', signedIn: true, room: 0, blocks: {} }]
  assert.equal(mostWeekRoom({ accounts: full, model: 'opus', current: null, now: NOW }), null)
  // A signed in account with no reading yet is a last resort, behind any known room.
  const unread = [
    { id: 'a', signedIn: true, room: null, blocks: {} },
    { id: 'b', signedIn: true, room: 5, blocks: {} },
  ]
  assert.equal(mostWeekRoom({ accounts: unread, model: 'opus', current: null, now: NOW }), 'b')
  assert.equal(mostWeekRoom({ accounts: [unread[0]], model: 'opus', current: null, now: NOW }), 'a')
  // The account that just hit the limit is never picked again for that model.
  const hit = [{ id: 'a', signedIn: true, room: 90, blocks: { '*': iso(NOW + HOUR) } }]
  assert.equal(mostWeekRoom({ accounts: hit, model: 'opus', current: 'a', now: NOW }), null)
})
