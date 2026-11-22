/**
 * The server's Claude model catalog in the owner's picker (the plugin
 * half) and the `restarting` answer of the restart route. BGOS sends
 * `claudeModels` [{ id, label }] in both picker frames, from its own held copy
 * of the public list, and `restartOk: true` on an apply when the app can show
 * a restart.
 *
 * Kept from the hand typed table (the safety lock): only
 * ids from our catalog, a strict id format, never free text, and never typed
 * into a pane (the restart route passes them as one argv element).
 *
 * Run: npx tsx --test test/model-effort-server-catalog.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPickerCatalog, mergeServerModels, readServerModels, readModelEffortCatalog } from '../lib/model-effort-catalog.ts'
import { ModelEffortPickerHandler, type PickerFrame } from '../lib/model-effort-rpc.ts'
import type { ApplyOptions, ApplySelection, ControlOutcome, ControlSnapshot } from '../lib/model-effort-control.ts'

const SID = 'b1f3c0de-0000-4000-8000-0000c0ffee01'
const EXACT = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }
/** The model names the installed CLI's own file carries (lib/cli-model-names.ts). */
const CLI_NAMES: ReadonlySet<string> = new Set(['claude-opus-6', 'claude-opus-4-1', 'claude-opus-5-5', 'claude-sonnet-5-5'])
const OBS = { sessionId: SID, modelId: 'claude-opus-5-5', modelDisplayName: 'Opus 5.5', effort: 'high', version: '2.1.330', seq: 3, observedAtMs: 1 }

test('readServerModels keeps strict ids with plain labels and drops everything else', () => {
  const read = readServerModels([
    { id: 'claude-opus-6', label: 'Opus 6' },
    { id: 'claude-opus-6', label: 'Opus 6 again' },
    { id: 'opus', label: 'Opus' },
    { id: 'claude-x&calc', label: 'x' },
    { id: 'claude-opus-4-1', label: 'Opus 4.1' },
    { id: 'claude-haiku-6', label: 'Haiku‮6' },
    { id: 'claude-haiku-6-1', label: 'x'.repeat(101) },
    { id: 'claude-sonnet-6', label: '' },
    'claude-sonnet-6',
    null,
  ])
  assert.deepEqual(read, [
    { id: 'claude-opus-6', label: 'Opus 6' },
    { id: 'claude-opus-4-1', label: 'Opus 4.1' },
  ])
  assert.deepEqual(readServerModels('claude-opus-6'), [])
  assert.deepEqual(readServerModels(undefined), [])
  assert.equal(readServerModels(Array.from({ length: 200 }, (_, i) => ({ id: `claude-opus-${i}`, label: `Opus ${i}` }))).length, 60)
})

test('mergeServerModels adds new ids to an exact catalog, never a retired one, never to an alias catalog', () => {
  assert.deepEqual(mergeServerModels({ efforts: [...EXACT.efforts], models: [...EXACT.models] }, ['claude-opus-6', 'claude-opus-4-1', 'claude-sonnet-5-5'], CLI_NAMES).models, [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-opus-6',
  ])
  const alias = { efforts: [...EXACT.efforts], models: ['opus', 'sonnet'] }
  assert.deepEqual(mergeServerModels(alias, ['claude-opus-6'], CLI_NAMES).models, ['opus', 'sonnet'])
  assert.deepEqual(mergeServerModels({ efforts: [], models: [] }, ['claude-opus-6'], CLI_NAMES).models, [])
  assert.deepEqual(mergeServerModels({ efforts: [...EXACT.efforts], models: [...EXACT.models] }, undefined, CLI_NAMES).models, EXACT.models)
})

// The server's ids come from a public list of names, which need not be names the
// installed CLI knows. One is offered only when the CLI's own file names it, and never when that
// file could not be read.
test('a server id the installed CLI does not name is never offered, and none is when its names are unknown', () => {
  const exact = () => ({ efforts: [...EXACT.efforts], models: [...EXACT.models] })
  assert.deepEqual(mergeServerModels(exact(), ['claude-opus-6', 'claude-opus-4-8'], new Set(['claude-opus-4-8'])).models, [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-opus-4-8',
  ])
  assert.deepEqual(mergeServerModels(exact(), ['claude-opus-6'], new Set()).models, EXACT.models)
  assert.deepEqual(mergeServerModels(exact(), ['claude-opus-6'], null).models, EXACT.models)
})

test('a server id gets the server label in the picker, never the running model\'s', () => {
  const catalog = mergeServerModels({ efforts: [...EXACT.efforts], models: [...EXACT.models] }, ['claude-opus-6'], CLI_NAMES)
  const built = buildPickerCatalog({ catalog, observation: OBS as never, sessionId: SID, serverLabels: new Map([['claude-opus-6', 'Opus 6']]) })
  assert.ok(built)
  const entry = built.models.find((m) => m.id === 'claude-opus-6')
  assert.equal(entry?.label, 'Opus 6')
  assert.equal(built.models.find((m) => m.id === 'claude-opus-5-5')?.label, 'Opus 5.5')
  assert.ok(readModelEffortCatalog(JSON.parse(JSON.stringify(built))), 'BGOS reads it back')
  const unlabeled = buildPickerCatalog({ catalog, observation: OBS as never, sessionId: SID })
  assert.equal(unlabeled?.models.find((m) => m.id === 'claude-opus-6')?.label, 'claude-opus-6')
})

function handler(o: { snapshot?: Partial<ControlSnapshot>; outcome?: ControlOutcome } = {}) {
  const seen: { snapshotOpts: unknown[]; apply: { sel: ApplySelection; opts: ApplyOptions }[]; notes: string[]; reports: unknown[] } = {
    snapshotOpts: [],
    apply: [],
    notes: [],
    reports: [],
  }
  const h = new ModelEffortPickerHandler({
    assistantId: () => '888',
    chatAllowed: () => true,
    control: {
      snapshot: async (opts?: unknown) => {
        seen.snapshotOpts.push(opts)
        return {
          optedIn: true,
          sessionId: SID,
          observation: OBS as never,
          catalog: { efforts: [...EXACT.efforts], models: [...EXACT.models, 'claude-opus-6'] },
          switchPending: false,
          ...o.snapshot,
        }
      },
      apply: async (sel, opts) => {
        seen.apply.push({ sel, opts })
        return o.outcome ?? { ok: false, op: 'apply', code: 'no_terminal', message: 'x', report: null }
      },
    },
    reportSettings: async (_c, body) => {
      seen.reports.push(body)
    },
    sendNote: async (_c, text) => {
      seen.notes.push(text)
    },
    log: () => {},
    now: () => 1_000,
  })
  return { h, seen }
}

const frame = (op: string, payload: Record<string, unknown>): PickerFrame => ({ op, assistantId: '888', chatId: '4821', payload, receivedAtMs: 1_000 })
const CLAUDE_MODELS = [{ id: 'claude-opus-6', label: 'Opus 6' }, { id: 'bad id', label: 'x' }]

test('the list hands the server ids to the snapshot and labels them from the frame', async () => {
  const { h, seen } = handler()
  const answer = await h.answer(frame('list_model_effort', { claudeModels: CLAUDE_MODELS }))
  assert.equal(answer.ok, true)
  assert.deepEqual(seen.snapshotOpts, [{ serverModels: ['claude-opus-6'] }])
  const models = (answer.ok ? answer.payload.models : []) as { id: string; label: string }[]
  assert.equal(models.find((m) => m.id === 'claude-opus-6')?.label, 'Opus 6')
})

test('the list answers busy while a restart route switch is in flight', async () => {
  const { h } = handler({ snapshot: { switchPending: true } })
  const answer = await h.answer(frame('list_model_effort', {}))
  assert.equal(answer.ok, false)
  assert.equal(!answer.ok && answer.code, 'busy')
  assert.equal(!answer.ok && answer.message, 'The agent is restarting to switch its model. Try again in a moment.')
})

test('an apply hands the chat, the restart permission and the server ids to the control', async () => {
  const { h, seen } = handler()
  await h.answer(frame('apply_model_effort', { sessionId: SID, model: 'claude-opus-6', effort: 'high', restartOk: true, claudeModels: CLAUDE_MODELS }))
  assert.equal(seen.apply.length, 1)
  assert.equal(seen.apply[0]!.opts.chatId, '4821')
  assert.equal(seen.apply[0]!.opts.restartOk, true)
  assert.deepEqual(seen.apply[0]!.opts.serverModels, ['claude-opus-6'])
  assert.equal(seen.apply[0]!.opts.deadlineAtMs, 16_000)
})

test('restartOk is only ever the boolean true', async () => {
  const { h, seen } = handler()
  await h.answer(frame('apply_model_effort', { sessionId: SID, model: 'claude-opus-5-5', effort: 'high', restartOk: 'true' }))
  assert.equal(seen.apply[0]!.opts.restartOk, false)
})

test('a restarting outcome is answered restarting with the target, and no note or pill goes out yet', async () => {
  const report = { model: 'claude-opus-5-5', effort: 'high' } as never
  const { h, seen } = handler({ outcome: { ok: true, op: 'apply', applied: true, report, restarting: { model: 'claude-sonnet-5-5', effort: 'low' } } })
  const answer = await h.answer(frame('apply_model_effort', { sessionId: SID, model: 'claude-sonnet-5-5', effort: 'low', restartOk: true }))
  assert.deepEqual(answer, { ok: true, payload: { state: 'restarting', sessionId: SID, target: { model: 'claude-sonnet-5-5', effort: 'low' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen.notes, [])
  assert.deepEqual(seen.reports, [])
})

test('switch_pending is a busy refusal on the wire', async () => {
  const { h } = handler({ outcome: { ok: false, op: 'apply', code: 'switch_pending', message: 'm', report: null } })
  const answer = await h.answer(frame('apply_model_effort', { sessionId: SID, model: 'claude-sonnet-5-5', effort: 'low' }))
  assert.equal(!answer.ok && answer.code, 'busy')
})
