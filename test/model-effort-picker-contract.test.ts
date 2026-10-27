/**
 * The BGOS model and effort picker CONTRACT, pinned to BGOS main (merged
 * #3060, read at 1ec6bbf4). BGOS is authoritative: it is merged and live, so
 * every value here is copied from its source, file and line cited, and a
 * change on either side fails this file.
 *
 *   backend/src/integrations/model-effort-picker.model.ts
 *     1     MODEL_EFFORT_PICKER = 'model_effort_picker'
 *     2     ModelEffortOp = 'list_model_effort' | 'apply_model_effort'
 *     3-8   EffortOption { id, label, enabled, reason }
 *     9-17  ModelOption { id, label, description, enabled, defaultEffort,
 *           efforts, fastModeAvailable? }
 *     23-28 ModelEffortCatalog { runtime, sessionId, current, models }
 *     46-120 readModelEffortCatalog, vendored in lib/model-effort-catalog.ts
 *   backend/src/integrations/assistant-sessions.service.ts
 *     126   op: selection ? 'apply_model_effort' : 'list_model_effort'
 *     128-134 the apply payload { sessionId, model, effort }
 *     138-144 the apply answer must carry sessionId and current.model and
 *           current.effort equal to the selection, else invalid_answer
 *     155-158 only busy, not_allowed and timeout pass through; anything else
 *           is switch_failed
 *   frontend/expo-app/src/queries/modelEffortQuery.ts
 *     10-11 the app's own words for not_allowed and busy
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPickerCatalog,
  readModelEffortCatalog,
  MODEL_EFFORT_MODEL_PATTERN,
  PICKER_RUNTIME,
} from '../lib/model-effort-catalog.ts'
import {
  APPLY_MODEL_EFFORT,
  LIST_MODEL_EFFORT,
  MODEL_EFFORT_PICKER,
  PICKER_REFUSAL_CODES,
  pickerRefusalCode,
} from '../lib/model-effort-rpc.ts'
import { MODEL_EFFORT_PICKER_TOKEN } from '../lib/declared-capabilities.ts'
import { REFUSAL_MESSAGES, type RefusalCode } from '../lib/model-effort-control.ts'
import type { ModelObservation } from '../lib/model-control-store.mjs'

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const HOST = { models: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } as const

function observation(over: Partial<ModelObservation> = {}): ModelObservation {
  return {
    sessionId: SID,
    modelId: 'claude-opus-5-5',
    modelDisplayName: 'Opus 5.5',
    effort: 'high',
    version: '2.1.310',
    seq: 4,
    observedAtMs: 1_000,
    ...over,
  }
}

test('the capability token and both op names are BGOS\'s own (model-effort-picker.model.ts:1-2)', () => {
  assert.equal(MODEL_EFFORT_PICKER, 'model_effort_picker')
  assert.equal(MODEL_EFFORT_PICKER_TOKEN, MODEL_EFFORT_PICKER, 'the heartbeat declares the very token the gate reads')
  assert.equal(LIST_MODEL_EFFORT, 'list_model_effort')
  assert.equal(APPLY_MODEL_EFFORT, 'apply_model_effort')
})

test('the catalog carries exactly BGOS\'s keys (model-effort-picker.model.ts:3-28)', () => {
  const catalog = buildPickerCatalog({ catalog: { models: [...HOST.models], efforts: [...HOST.efforts] }, observation: observation(), sessionId: SID })
  assert.ok(catalog)
  assert.deepEqual(Object.keys(catalog).sort(), ['current', 'models', 'runtime', 'sessionId'])
  assert.equal(catalog.runtime, PICKER_RUNTIME)
  assert.equal(PICKER_RUNTIME, 'claude-code', 'the runtime name BGOS\'s own spec uses for Claude (model-effort-picker.spec.ts:69)')
  assert.deepEqual(Object.keys(catalog.current!).sort(), ['effort', 'model'])
  for (const m of catalog.models) {
    assert.deepEqual(Object.keys(m).sort(), ['defaultEffort', 'description', 'efforts', 'enabled', 'id', 'label'])
    for (const e of m.efforts) assert.deepEqual(Object.keys(e).sort(), ['enabled', 'id', 'label', 'reason'])
  }
})

test('BGOS\'s reader accepts what the daemon builds, unchanged', () => {
  const built = buildPickerCatalog({ catalog: { models: [...HOST.models], efforts: [...HOST.efforts] }, observation: observation(), sessionId: SID })
  assert.deepEqual(readModelEffortCatalog(JSON.parse(JSON.stringify(built))), built)
  assert.equal(built!.sessionId, SID)
  assert.deepEqual(built!.current, { model: 'opus', effort: 'high' }, 'current names the picker row, so the app highlights it')
  assert.deepEqual(built!.models.map((m) => m.id), ['fable', 'opus', 'sonnet'])
  assert.deepEqual(built!.models.map((m) => m.label), ['Fable', 'Opus', 'Sonnet'])
})

test('every effort the CLI offers is enabled; Ultra Code is listed disabled with the host\'s reason', () => {
  const built = buildPickerCatalog({ catalog: { models: [...HOST.models], efforts: [...HOST.efforts] }, observation: observation(), sessionId: SID })!
  const opus = built.models.find((m) => m.id === 'opus')!
  assert.deepEqual(opus.efforts.filter((e) => e.enabled).map((e) => e.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  const ultra = opus.efforts.find((e) => e.id === 'ultracode')!
  assert.equal(ultra.enabled, false)
  assert.equal(ultra.reason, 'This host cannot confirm Ultra Code remotely.')
  assert.equal(opus.defaultEffort, 'high', 'the session\'s own effort')
})

test('a running model that reports no effort lists its efforts disabled, with the reason', () => {
  const built = buildPickerCatalog({ catalog: { models: [...HOST.models], efforts: [...HOST.efforts] }, observation: observation({ modelId: 'claude-sonnet-5-5', effort: null }), sessionId: SID })!
  assert.deepEqual(built.current, { model: 'sonnet', effort: null })
  const sonnet = built.models.find((m) => m.id === 'sonnet')!
  assert.ok(sonnet.efforts.every((e) => !e.enabled && typeof e.reason === 'string' && e.reason.length > 0))
  const opus = built.models.find((m) => m.id === 'opus')!
  assert.ok(opus.efforts.some((e) => e.enabled), 'switching away stays possible')
  assert.ok(readModelEffortCatalog(JSON.parse(JSON.stringify(built))))
})

test('a running model outside the frozen table is listed by its own id, so an effort change stays possible', () => {
  const built = buildPickerCatalog({ catalog: { models: ['opus'], efforts: [...HOST.efforts] }, observation: observation({ modelId: 'claude-mythic-9', modelDisplayName: 'Mythic' }), sessionId: SID })!
  assert.deepEqual(built.current, { model: 'claude-mythic-9', effort: 'high' })
  assert.deepEqual(built.models.map((m) => m.id), ['opus', 'claude-mythic-9'])
  assert.ok(readModelEffortCatalog(JSON.parse(JSON.stringify(built))))
})

test('nothing to offer, no proven session or a session id BGOS refuses: no catalog at all', () => {
  assert.equal(buildPickerCatalog({ catalog: { models: [], efforts: [] }, observation: null, sessionId: SID }), null)
  assert.equal(buildPickerCatalog({ catalog: { models: [...HOST.models], efforts: [...HOST.efforts] }, observation: observation(), sessionId: null }), null)
  for (const bad of ['../x\n', 'a b', 'x'.repeat(201)]) {
    assert.equal(buildPickerCatalog({ catalog: { models: [...HOST.models], efforts: [...HOST.efforts] }, observation: observation({ sessionId: bad }), sessionId: bad }), null, bad)
  }
  assert.equal(buildPickerCatalog({ catalog: { models: [...HOST.models], efforts: [...HOST.efforts] }, observation: observation({ sessionId: 'other' }), sessionId: SID }), null, 'a report of another session')
})

test('a model id that would carry text is never the current model (model-effort-picker.model.ts:43)', () => {
  for (const modelId of ['opus;whoami', 'opus\n/model sonnet', 'opus[]', 'opus[1m][2m]']) {
    assert.doesNotMatch(modelId, MODEL_EFFORT_MODEL_PATTERN)
    const built = buildPickerCatalog({ catalog: { models: [...HOST.models], efforts: [...HOST.efforts] }, observation: observation({ modelId }), sessionId: SID })!
    assert.equal(built.current, null, modelId)
    assert.ok(readModelEffortCatalog(JSON.parse(JSON.stringify(built))))
  }
})

test('the vendored reader is BGOS\'s: its own spec cases (model-effort-picker.spec.ts:59-83)', () => {
  const base = {
    runtime: 'claude-code',
    sessionId: 'thread-1',
    current: { model: 'opus[1m]', effort: 'high' },
    models: [{ id: 'opus[1m]', label: 'Opus', description: '', enabled: true, defaultEffort: 'high', efforts: [{ id: 'high', label: 'High', enabled: true, reason: null }] }],
  }
  assert.deepEqual(readModelEffortCatalog(base), base)
  for (const model of ['opus[1m];whoami', 'opus[1m]\n/model sonnet', 'opus[]', 'opus[1m][2m]']) {
    assert.equal(readModelEffortCatalog({ ...base, current: { model, effort: 'high' } }), null, model)
  }
  const disabledNoReason = { ...base, models: [{ ...base.models[0]!, efforts: [{ id: 'high', label: 'High', enabled: false, reason: null }] }] }
  assert.equal(readModelEffortCatalog(disabledNoReason), null, 'a disabled effort must say why')
  assert.equal(readModelEffortCatalog({ ...base, models: [] }), null)
  assert.equal(readModelEffortCatalog({ ...base, models: [{ ...base.models[0]!, fastModeAvailable: 'true' }] }), null)
})

test('every refusal maps to a code the app understands, or to failed (assistant-sessions.service.ts:155-158)', () => {
  assert.deepEqual([...PICKER_REFUSAL_CODES].sort(), ['busy', 'failed', 'not_allowed'])
  for (const code of Object.keys(REFUSAL_MESSAGES) as RefusalCode[]) {
    assert.ok(PICKER_REFUSAL_CODES.includes(pickerRefusalCode(code)), code)
  }
  for (const code of ['busy_turn', 'control_busy', 'dialog_open', 'turn_unknown'] as RefusalCode[]) {
    assert.equal(pickerRefusalCode(code), 'busy', code)
  }
  for (const code of ['unsupported_value', 'ultracode_unconfirmable', 'not_in_catalog', 'effort_unsupported', 'not_opted_in', 'session_mismatch', 'not_owner_main_chat'] as RefusalCode[]) {
    assert.equal(pickerRefusalCode(code), 'not_allowed', code)
  }
  for (const code of ['not_confirmed', 'inject_failed', 'composer_changed', 'session_changed', 'composer_not_empty', 'out_of_time'] as RefusalCode[]) {
    assert.equal(pickerRefusalCode(code), 'failed', code)
  }
})
