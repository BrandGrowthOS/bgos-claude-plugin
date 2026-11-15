/**
 * The pill follows the session (lib/model-effort-live-report.ts).
 *
 * KC, HOAI chat 4875 msg 228420 (2026-11-15), agent Autonomee (assistant 863,
 * plugin 0.88.0): the chip under the message box shows the model the server
 * last stored for the chat. This daemon sent that report from one place only,
 * the picker's apply (lib/model-effort-rpc.ts), so the stored value was the
 * outcome of the last switch made THROUGH the picker (9 Nov, claude-opus-5).
 * A model changed in the agent's own terminal, or by a restart, never reached
 * the app, although the daemon reads the live model from the status line
 * bridge all the time. The app's own refusal text tells the owner to type
 * /model in that terminal.
 *
 * The reporter looks at the bridge's observation on a tick and sends the
 * session settings report when the model or the effort differs from the last
 * report the server accepted for that chat. Same gates as the picker: the
 * owner's opt in, the proven session, a fresh observation, the owner's own
 * main chat.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SessionSettingsLiveReporter, type LiveReportDeps } from '../lib/model-effort-live-report.ts'
import type { ModelObservation } from '../lib/model-control-store.mjs'

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const T0 = Date.parse('2026-11-15T08:00:00.000Z')
const STALE_MS = 15_000

function observation(over: Partial<ModelObservation> = {}): ModelObservation {
  return {
    sessionId: SID,
    modelId: 'claude-opus-5',
    modelDisplayName: 'Opus 5',
    effort: 'high',
    version: '2.1.325',
    seq: 1,
    observedAtMs: T0 - 1_000,
    ...over,
  }
}

function rig(over: Partial<LiveReportDeps> = {}) {
  const state = {
    now: T0,
    optedIn: true,
    sessionId: SID as string | null,
    observation: observation() as ModelObservation | null,
    chats: ['804'],
    /** What the next PATCH does: answer, fail, or never answer. */
    answer: 'ok' as 'ok' | 'fail' | 'hang',
  }
  const reports: Array<{ chatId: string; body: Record<string, unknown> }> = []
  const logs: string[] = []
  const hung: Array<() => void> = []
  const reporter = new SessionSettingsLiveReporter(
    {
      optedIn: () => state.optedIn,
      sessionId: () => state.sessionId,
      readObservation: (sessionId) => (state.observation && state.observation.sessionId === sessionId ? state.observation : null),
      chats: () => state.chats,
      reportSettings: (chatId, body) => {
        reports.push({ chatId, body: body as unknown as Record<string, unknown> })
        if (state.answer === 'fail') return Promise.reject(new Error('PATCH 503'))
        if (state.answer === 'hang') return new Promise<void>((resolve) => { hung.push(resolve) })
        return Promise.resolve({ ok: true })
      },
      now: () => state.now,
      log: (msg) => logs.push(msg),
      ...over,
    },
    { staleMs: STALE_MS, timeoutMs: 50 },
  )
  /** The session's status line is seen again `ms` later, with these facts. */
  const see = (ms: number, facts: Partial<ModelObservation> = {}) => {
    state.now += ms
    state.observation = observation({ ...(state.observation ?? {}), ...facts, observedAtMs: state.now - 500 })
  }
  return { state, reports, logs, hung, reporter, see }
}

test('the first look reports what the session runs, in the route\'s own shape', async () => {
  const r = rig()
  await r.reporter.tick()
  assert.equal(r.reports.length, 1)
  assert.equal(r.reports[0]!.chatId, '804')
  assert.deepEqual(r.reports[0]!.body, {
    model: 'claude-opus-5',
    effort: 'high',
    serviceTier: null,
    rerouted: false,
    reportedAt: new Date(T0).toISOString(),
  })
})

test('nothing changed: nothing is sent again, however many looks', async () => {
  const r = rig()
  await r.reporter.tick()
  for (let i = 0; i < 5; i++) {
    r.see(15_000)
    await r.reporter.tick()
  }
  assert.equal(r.reports.length, 1)
})

test('KC\'s case: the model changed outside the picker reaches the app on the next look', async () => {
  const r = rig()
  await r.reporter.tick()
  // The owner types /model claude-opus-5-5 in the agent's own terminal.
  r.see(15_000, { modelId: 'claude-opus-5-5', modelDisplayName: 'Opus 5.5', seq: 2 })
  await r.reporter.tick()
  assert.equal(r.reports.length, 2)
  assert.equal(r.reports[1]!.body.model, 'claude-opus-5-5')
  assert.equal(r.reports[1]!.body.effort, 'high')
})

test('a model that moves back is reported too: the pill tells the truth both ways', async () => {
  const r = rig()
  r.state.observation = observation({ modelId: 'claude-opus-5-5' })
  await r.reporter.tick()
  // A restart with --resume keeps the conversation's older model.
  r.see(15_000, { modelId: 'claude-opus-5', seq: 9 })
  await r.reporter.tick()
  assert.deepEqual(r.reports.map((x) => x.body.model), ['claude-opus-5-5', 'claude-opus-5'])
})

test('an effort changed alone is a change', async () => {
  const r = rig()
  await r.reporter.tick()
  r.see(15_000, { effort: 'xhigh', seq: 2 })
  await r.reporter.tick()
  assert.equal(r.reports.length, 2)
  assert.deepEqual([r.reports[1]!.body.model, r.reports[1]!.body.effort], ['claude-opus-5', 'xhigh'])
})

test('a new session on the same model and effort sends nothing new', async () => {
  const r = rig()
  await r.reporter.tick()
  const next = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  r.state.now += 15_000
  r.state.sessionId = next
  r.state.observation = observation({ sessionId: next, observedAtMs: r.state.now - 500 })
  await r.reporter.tick()
  assert.equal(r.reports.length, 1)
})

test('not opted in: nothing leaves this machine, and opting in later reports', async () => {
  const r = rig()
  r.state.optedIn = false
  await r.reporter.tick()
  assert.equal(r.reports.length, 0)
  r.state.optedIn = true
  r.see(15_000)
  await r.reporter.tick()
  assert.equal(r.reports.length, 1)
})

test('opting out forgets what was sent, so opting in again reports even an unchanged model', async () => {
  const r = rig()
  await r.reporter.tick()
  r.state.optedIn = false
  r.see(15_000)
  await r.reporter.tick()
  r.state.optedIn = true
  r.see(15_000)
  await r.reporter.tick()
  assert.equal(r.reports.length, 2)
})

test('no proven session, no observation, or a stale one: nothing is sent', async () => {
  const none = rig()
  none.state.sessionId = null
  await none.reporter.tick()
  assert.equal(none.reports.length, 0)

  const blind = rig()
  blind.state.observation = null
  await blind.reporter.tick()
  assert.equal(blind.reports.length, 0)

  // The status line last ran longer ago than the picker itself would trust.
  const stale = rig()
  stale.state.observation = observation({ observedAtMs: T0 - STALE_MS - 1 })
  await stale.reporter.tick()
  assert.equal(stale.reports.length, 0)
  // The control: one millisecond fresher is sent.
  const fresh = rig()
  fresh.state.observation = observation({ observedAtMs: T0 - STALE_MS })
  await fresh.reporter.tick()
  assert.equal(fresh.reports.length, 1)
})

test('another session\'s observation is never reported as this one\'s', async () => {
  const r = rig()
  r.state.observation = observation({ sessionId: 'someone-else' })
  await r.reporter.tick()
  assert.equal(r.reports.length, 0)
})

test('a model id the report route would refuse is not sent', async () => {
  const r = rig()
  // The route's pattern has no square brackets (report-session-settings.dto.ts).
  r.state.observation = observation({ modelId: 'claude-opus-5-5[1m]' })
  await r.reporter.tick()
  assert.equal(r.reports.length, 0)
})

test('only the owner\'s own main chats are told, each once, and a chat that appears later catches up', async () => {
  const r = rig()
  r.state.chats = ['804', '805']
  await r.reporter.tick()
  assert.deepEqual(r.reports.map((x) => x.chatId).sort(), ['804', '805'])
  r.state.chats = ['804', '805', '900']
  r.see(15_000)
  await r.reporter.tick()
  // The two chats already told are not told again; the new one is.
  assert.equal(r.reports.length, 3)
  assert.equal(r.reports[2]!.chatId, '900')
  assert.equal(r.reports[2]!.body.model, 'claude-opus-5')
})

test('no chat: nothing is sent and nothing is remembered', async () => {
  const r = rig()
  r.state.chats = []
  await r.reporter.tick()
  assert.equal(r.reports.length, 0)
  r.state.chats = ['804']
  r.see(15_000)
  await r.reporter.tick()
  assert.equal(r.reports.length, 1)
})

test('a refused report is tried again on the next look, and the look never throws', async () => {
  const r = rig()
  r.state.answer = 'fail'
  await assert.doesNotReject(r.reporter.tick())
  assert.equal(r.reports.length, 1)
  assert.ok(r.logs.some((l) => l.includes('session settings report failed')))
  r.state.answer = 'ok'
  r.see(15_000)
  await r.reporter.tick()
  assert.equal(r.reports.length, 2)
  // Accepted now: no third send.
  r.see(15_000)
  await r.reporter.tick()
  assert.equal(r.reports.length, 2)
})

test('a failure is logged without the error\'s text', async () => {
  const r = rig({
    reportSettings: () => Promise.reject(new Error('PATCH 500: secret\nforged log line')),
  })
  await r.reporter.tick()
  assert.equal(r.logs.length, 1)
  assert.ok(!r.logs[0]!.includes('secret'))
  assert.ok(!r.logs[0]!.includes('\n'))
})

test('a report that never answers is given up on in bounded time, and the next look sends again', async () => {
  const r = rig()
  r.state.answer = 'hang'
  const started = Date.now()
  await r.reporter.tick()
  // The rig's bound is 50 ms; a look must not wait for an answer that never comes.
  assert.ok(Date.now() - started < 2_000)
  assert.equal(r.reports.length, 1)
  r.state.answer = 'ok'
  r.see(15_000)
  await r.reporter.tick()
  assert.equal(r.reports.length, 2)
})

test('looks never overlap: a second look during a slow one does nothing', async () => {
  const r = rig()
  r.state.answer = 'hang'
  const first = r.reporter.tick()
  await r.reporter.tick()
  assert.equal(r.reports.length, 1)
  for (const release of r.hung) release()
  await first
})

test('noteReported: a report the picker\'s apply already sent is not sent again', async () => {
  const r = rig()
  r.reporter.noteReported('804', { model: 'claude-opus-5', effort: 'high' })
  await r.reporter.tick()
  assert.equal(r.reports.length, 0)
  // A different value is still a change.
  r.see(15_000, { modelId: 'claude-opus-5-5', seq: 2 })
  await r.reporter.tick()
  assert.equal(r.reports.length, 1)
})
