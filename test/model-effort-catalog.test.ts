/**
 * Owner model and effort control (Route A): what the picker may offer, read
 * from what Claude Code itself reports (lib/model-effort-catalog.ts).
 *
 * Never a hard coded list: the efforts are the installed CLI's own `--effort`
 * choices and the models are the aliases its own `--model` help names, each
 * kept only where the frozen literal table can type it. So a family the CLI
 * stops naming disappears from the picker, and a family the CLI starts naming
 * appears only after a deliberate change to the table. The fixture is the
 * real `claude --help` of Claude Code 2.1.309.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildModelEffortReport, modelFamilyOf, parseHelpCatalog } from '../lib/model-effort-catalog.ts'

const HELP = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-help-2.1.309.txt'),
  'utf8',
)

test('the real help of 2.1.309 offers its own efforts and the aliases it names', () => {
  assert.deepEqual(parseHelpCatalog(HELP), {
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    models: ['fable', 'opus', 'sonnet'],
  })
})

test('an effort the CLI lists but the table cannot type is not offered, and the order is the CLI\'s', () => {
  const help = [
    '  --effort <level>    Effort level for the current session',
    '                      (max, high, ultracode, low)',
    "  --model <model>     Model. Provide an alias (e.g. 'sonnet', 'haiku', 'gpt-9' or 'opus')",
    '  -n, --name <name>   Name',
  ].join('\n')
  assert.deepEqual(parseHelpCatalog(help), { efforts: ['max', 'high', 'low'], models: ['sonnet', 'haiku', 'opus'] })
})

test('a help text without the options offers nothing (the capability then stays absent)', () => {
  assert.deepEqual(parseHelpCatalog(''), { efforts: [], models: [] })
  assert.deepEqual(parseHelpCatalog('Usage: claude [options]\n  -p, --print  Print'), { efforts: [], models: [] })
  assert.deepEqual(parseHelpCatalog(null), { efforts: [], models: [] })
})

test('a quoted alias in ANOTHER option is not a model', () => {
  const help = [
    "  --model <model>          Model for the session (e.g. 'opus')",
    "  --fallback-model <m>     Fallback (e.g. 'sonnet')",
  ].join('\n')
  assert.deepEqual(parseHelpCatalog(help).models, ['opus'])
})

test('a resolved model id maps to exactly one family, or none', () => {
  assert.equal(modelFamilyOf('claude-opus-5-5'), 'opus')
  assert.equal(modelFamilyOf('claude-sonnet-5-5[1m]'), 'sonnet')
  assert.equal(modelFamilyOf('us.anthropic.claude-haiku-5-5-v1:0'), 'haiku')
  assert.equal(modelFamilyOf('claude-fable-5-1'), 'fable')
  assert.equal(modelFamilyOf('opus'), 'opus')
  assert.equal(modelFamilyOf('gpt-5'), null)
  assert.equal(modelFamilyOf('claude-opusplan'), null)
  assert.equal(modelFamilyOf('opus-sonnet-mix'), null, 'two families is not one')
  assert.equal(modelFamilyOf(''), null)
})

test('the report says what runs now, what may be chosen, and that Ultra Code cannot be confirmed', () => {
  const report = buildModelEffortReport({
    catalog: parseHelpCatalog(HELP),
    observation: {
      sessionId: 's', modelId: 'claude-opus-5-5', modelDisplayName: 'Opus', effort: 'high',
      version: '2.1.309', seq: 3, observedAtMs: 10,
    },
    canChange: { ok: true },
  })
  assert.deepEqual(report, {
    model: 'claude-opus-5-5',
    modelFamily: 'opus',
    modelDisplayName: 'Opus',
    effort: 'high',
    runtimeVersion: '2.1.309',
    availableModels: ['fable', 'opus', 'sonnet'],
    availableEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    ultracode: { available: false, reason: 'This host cannot confirm Ultra Code remotely.' },
    canChange: true,
    cannotChangeCode: null,
    cannotChangeReason: null,
    observedAt: new Date(10).toISOString(),
  })
})

test('a model that reports no effort offers no efforts', () => {
  const report = buildModelEffortReport({
    catalog: parseHelpCatalog(HELP),
    observation: {
      sessionId: 's', modelId: 'claude-haiku-5-5', modelDisplayName: 'Haiku', effort: null,
      version: '2.1.309', seq: 3, observedAtMs: 10,
    },
    canChange: { ok: false, code: 'not_opted_in', reason: 'off' },
  })
  assert.deepEqual(report!.availableEfforts, [])
  assert.equal(report!.effort, null)
  assert.equal(report!.canChange, false)
  assert.equal(report!.cannotChangeCode, 'not_opted_in')
})

test('with no observation there is no report: nothing is guessed', () => {
  assert.equal(buildModelEffortReport({ catalog: parseHelpCatalog(HELP), observation: null, canChange: { ok: true } }), null)
})
