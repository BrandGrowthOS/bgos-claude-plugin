/**
 * when_it_runs on the schedule tool (When a routine runs, 2026-11-22).
 *
 * The owner picks in Settings how a routine's runs show in their chat with the agent: Show nothing, One line a day,
 * or A card every run. One routine may also keep its own choice. The agent's schedule tool can set that choice when
 * the owner asked for it on this routine, as when_it_runs: show_nothing, one_line_a_day or card_every_run, sent to the
 * server as runDisplay inbox, timeline or cards (the same three words the Settings choice is stored as). Left out,
 * nothing is sent and the routine follows the owner's Settings, including a later change there.
 *
 * An older strict server refuses the unknown field with 400 "property runDisplay should not exist". That refusal made
 * nothing, so the same create goes once more without it, the way the request id already does, and the agent is told
 * the routine follows the owner's Settings. The 30 minute "tell me if nothing came" switch is the owner's alone: the
 * tool has no argument for it.
 *
 * Everything here runs against fakes: a fake post, never a real server.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import {
  WHEN_IT_RUNS_CHOICES,
  WHEN_IT_RUNS_TO_RUN_DISPLAY,
  buildScheduleCancelPath,
  buildScheduleCreateBody,
  buildScheduleListPath,
} from '../lib/schedule.ts'
import { httpFailure, newScheduleRequestId, sendScheduleCreate, whenItRunsNote } from '../lib/schedule-send.ts'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const BASE = { kind: 'wake', topic: 'Check the deploy', when: '2026-11-23T09:00:00+04:00' }

function body(extra: Record<string, unknown> = {}) {
  const built = buildScheduleCreateBody({ ...BASE, ...extra })
  assert.equal(built.ok, true, JSON.stringify(built))
  return (built as Extract<typeof built, { ok: true }>).body
}

// ── the builder ─────────────────────────────────────────────────────────────

test('each when_it_runs choice maps to the Settings word the server stores', () => {
  assert.deepEqual([...WHEN_IT_RUNS_CHOICES], ['show_nothing', 'one_line_a_day', 'card_every_run'])
  assert.deepEqual({ ...WHEN_IT_RUNS_TO_RUN_DISPLAY }, { show_nothing: 'inbox', one_line_a_day: 'timeline', card_every_run: 'cards' })
  assert.equal(body({ whenItRuns: 'show_nothing' }).runDisplay, 'inbox')
  assert.equal(body({ whenItRuns: 'one_line_a_day' }).runDisplay, 'timeline')
  assert.equal(body({ whenItRuns: 'card_every_run' }).runDisplay, 'cards')
  assert.equal(body({ whenItRuns: ' card_every_run ' }).runDisplay, 'cards', 'spaces round it are forgiven')
})

test('left out, empty or null sends nothing, so the routine follows the owner\'s Settings', () => {
  for (const whenItRuns of [undefined, null, '', '   ']) {
    assert.equal('runDisplay' in body({ whenItRuns }), false, JSON.stringify(whenItRuns))
  }
  assert.equal('runDisplay' in body(), false)
})

test('an unknown choice is refused with a plain sentence that names the three', () => {
  for (const whenItRuns of ['inbox', 'cards', 'quiet', 'Show nothing', 5, true, {}]) {
    const built = buildScheduleCreateBody({ ...BASE, whenItRuns })
    assert.equal(built.ok, false, JSON.stringify(whenItRuns))
    assert.match((built as { error: string }).error, /^when_it_runs must be show_nothing, one_line_a_day or card_every_run/)
    assert.match((built as { error: string }).error, /Leave it out to follow your owner's When a routine runs setting\.$/)
  }
})

test('a call shows no run in the chat, so it takes no when_it_runs', () => {
  const built = buildScheduleCreateBody({ ...BASE, kind: 'call', whenItRuns: 'show_nothing' })
  assert.equal(built.ok, false)
  assert.match((built as { error: string }).error, /when_it_runs is for wakes only/)
  assert.equal(buildScheduleCreateBody({ ...BASE, kind: 'call', whenItRuns: null }).ok, true)
})

// ── the older strict server ─────────────────────────────────────────────────

function fakePost(answers: Array<'ok' | string>, seen: Array<Record<string, unknown>>) {
  let n = 0
  return async (sent: Record<string, unknown>) => {
    seen.push({ ...sent })
    const answer = answers[n++] ?? 'ok'
    if (answer === 'ok') return { id: 7, ...(sent.runDisplay !== undefined ? { runDisplay: sent.runDisplay } : {}) }
    throw httpFailure('POST', 400, answer)
  }
}

test('an older server that refuses runDisplay still gets the routine: sent once more without it, the request id kept', async () => {
  const seen: Array<Record<string, unknown>> = []
  const first = body({ whenItRuns: 'show_nothing', clientRequestId: newScheduleRequestId() })
  const sent = await sendScheduleCreate({ body: first, post: fakePost(['property runDisplay should not exist'], seen) as never, sleep: async () => {} })
  assert.equal(sent.ok, true)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].runDisplay, 'inbox')
  assert.equal('runDisplay' in seen[1], false, 'the second send has no runDisplay')
  assert.equal(seen[1].clientRequestId, first.clientRequestId, 'and keeps the request id this server knows')
  assert.equal((sent as { note?: string }).note, whenItRunsNote({ sent: 'inbox', dropped: true, result: { id: 7 } }))
  assert.match(String((sent as { note?: string }).note), /follows your owner's When a routine runs setting/)
})

test('a server that refuses both new fields in one answer gets one resend without both', async () => {
  const seen: Array<Record<string, unknown>> = []
  const sent = await sendScheduleCreate({
    body: body({ whenItRuns: 'card_every_run', clientRequestId: newScheduleRequestId() }),
    post: fakePost(['property clientRequestId should not exist; property runDisplay should not exist'], seen) as never,
    sleep: async () => {},
  })
  assert.equal(sent.ok, true)
  assert.equal(seen.length, 2)
  assert.equal('runDisplay' in seen[1], false)
  assert.equal('clientRequestId' in seen[1], false)
})

test('the resend happens once, and never for a field the create did not carry or another refusal of it', async () => {
  const twice: Array<Record<string, unknown>> = []
  const again = await sendScheduleCreate({
    body: body({ whenItRuns: 'show_nothing' }),
    post: fakePost(['property runDisplay should not exist', 'property runDisplay should not exist'], twice) as never,
    sleep: async () => {},
  })
  assert.equal(again.ok, false)
  assert.equal(twice.length, 2, 'one resend, then the refusal stands')
  const absent: Array<Record<string, unknown>> = []
  const none = await sendScheduleCreate({ body: body(), post: fakePost(['property runDisplay should not exist'], absent) as never, sleep: async () => {} })
  assert.equal(none.ok, false)
  assert.equal(absent.length, 1)
  const other: Array<Record<string, unknown>> = []
  const wrong = await sendScheduleCreate({
    body: body({ whenItRuns: 'show_nothing' }),
    post: fakePost(['runDisplay must be one of the following values: inbox, timeline, cards'], other) as never,
    sleep: async () => {},
  })
  assert.equal(wrong.ok, false)
  assert.equal(other.length, 1)
})

test('the note says what the server kept, from its own answer', () => {
  assert.equal(whenItRunsNote({ sent: undefined, dropped: false, result: { id: 7 } }), '', 'nothing chosen, nothing said')
  assert.equal(whenItRunsNote({ sent: 'inbox', dropped: false, result: { id: 7, runDisplay: 'inbox' } }), 'When it runs: show nothing, kept for this routine.')
  assert.equal(whenItRunsNote({ sent: 'timeline', dropped: false, result: { id: 7, runDisplay: 'timeline' } }), 'When it runs: one line a day, kept for this routine.')
  assert.equal(whenItRunsNote({ sent: 'cards', dropped: false, result: { id: 7, runDisplay: 'cards' } }), 'When it runs: a card every run, kept for this routine.')
  assert.equal(
    whenItRunsNote({ sent: 'cards', dropped: false, result: { id: 7, runDisplay: null } }),
    "The server did not keep the when_it_runs choice, so this routine follows your owner's When a routine runs setting.",
  )
  assert.equal(whenItRunsNote({ sent: 'cards', dropped: false, result: { id: 7 } }), 'The server did not say whether it kept the when_it_runs choice.')
  assert.equal(
    whenItRunsNote({ sent: 'cards', dropped: true, result: { id: 7 } }),
    "This server cannot keep a when_it_runs choice yet, so this routine follows your owner's When a routine runs setting.",
  )
})

// ── the real handler ────────────────────────────────────────────────────────

const scheduleCase = server.slice(server.indexOf("    case 'schedule': {"), server.indexOf("    case 'list_schedules': {"))

function runScheduleCase(rawArgs: Record<string, unknown>, post: (path: string, body: any, headers: any) => Promise<unknown>) {
  const bindings = {
    name: 'schedule',
    rawArgs,
    privateCall: { actingUserId: 'user_recipient', chatId: '200', headers: { 'X-BGOS-Acting-User': 'user_recipient' } },
    buildScheduleCancelPath,
    buildScheduleCreateBody,
    buildScheduleListPath,
    newScheduleRequestId,
    sendScheduleCreate: (opts: Parameters<typeof sendScheduleCreate>[0]) => sendScheduleCreate({ ...opts, sleep: async () => {} }),
    log: () => {},
    resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
    bgosPeerPost: post,
    bgosPeerGet: async () => [],
    bgosPeerDelete: async () => ({ ok: true }),
  }
  const js = ts.transpileModule(`return (async () => { switch(name) { ${scheduleCase} } })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>
}

test('the real schedule case sends when_it_runs as runDisplay, with the frozen private headers, and says it was kept', async () => {
  const calls: Array<{ path: string; body: any; headers: any }> = []
  const result = await runScheduleCase({ ...BASE, when_it_runs: 'one_line_a_day' }, async (path, sent, headers) => {
    calls.push({ path, body: sent, headers })
    return { id: 9, runDisplay: sent.runDisplay }
  })
  assert.notEqual(result.isError, true, result.content[0].text)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, 'scheduled-tasks/agent')
  assert.equal(calls[0].body.runDisplay, 'timeline')
  assert.deepEqual(calls[0].headers, { 'X-BGOS-Acting-User': 'user_recipient' })
  assert.match(result.content[0].text, /^Scheduled\. When it runs: one line a day, kept for this routine\.\n/)
})

test('the real schedule case with no when_it_runs sends no runDisplay and says nothing about it', async () => {
  const calls: Array<{ body: any }> = []
  const result = await runScheduleCase({ ...BASE }, async (_path, sent) => { calls.push({ body: sent }); return { id: 9 } })
  assert.notEqual(result.isError, true, result.content[0].text)
  assert.equal('runDisplay' in calls[0].body, false)
  assert.match(result.content[0].text, /^Scheduled\.\n/)
})

test('the real schedule case on an older strict server makes the routine and says it follows Settings', async () => {
  const calls: Array<{ body: any }> = []
  const result = await runScheduleCase({ ...BASE, when_it_runs: 'show_nothing' }, async (_path, sent) => {
    calls.push({ body: { ...sent } })
    if ('runDisplay' in sent) throw httpFailure('POST', 400, 'property runDisplay should not exist')
    return { id: 9 }
  })
  assert.notEqual(result.isError, true, result.content[0].text)
  assert.equal(calls.length, 2)
  assert.match(result.content[0].text, /^Scheduled\. This server cannot keep a when_it_runs choice yet, so this routine follows your owner's When a routine runs setting\.\n/)
})

// ── what the model reads ────────────────────────────────────────────────────

test('the schedule tool offers when_it_runs, optional, with the three choices and when to leave it out', () => {
  const at = server.indexOf("      name: 'schedule',")
  const schema = server.slice(at, server.indexOf("required: ['kind', 'topic', 'when']", at))
  assert.ok(at > 0 && schema.length > 0)
  const prop = schema.slice(schema.indexOf('          when_it_runs: {'))
  assert.ok(schema.includes('          when_it_runs: {'), 'the schedule tool has a when_it_runs property')
  assert.match(prop, /type: 'string',\n\s+enum: \['show_nothing', 'one_line_a_day', 'card_every_run'\],/)
  const words = (prop.slice(0, prop.indexOf('\n          },')).match(/'(?:[^'\\]|\\.)*'/g) ?? []).map((l) => l.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
  assert.match(words, /Wakes only\./)
  assert.match(words, /Leave it out unless your owner asked/)
  assert.match(words, /When a routine runs setting/)
  // Groups keep their one line a day (When a routine runs, 2026-11-22: the server never applies a routine's choice in a group),
  // so the agent must not believe show_nothing worked on a group routine.
  assert.match(words, /It applies only to your own chat with your owner; a group chat keeps its one line a day whatever you choose\./)
  assert.doesNotMatch(words, /[\u2013\u2014]/)
  // The 30 minute switch is the owner's alone.
  assert.doesNotMatch(schema, /alert_if_silent|alertIfSilent|30 minutes/)
  // And the case passes it on.
  assert.match(scheduleCase, /\n\s+whenItRuns: rawArgs\.when_it_runs,\n/)
})
