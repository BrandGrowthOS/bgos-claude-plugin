/**
 * Usage self-report (BGOS capability #18, Fleet Pulse): transcript JSONL
 * summing + billing-mode rules + the UsageTracker cursor accounting.
 *
 * Run with:  npm test      (node --test, no extra deps)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildUsageReport,
  mungeCwd,
  sumUsageFromJsonl,
  UsageTracker,
} from '../lib/usage-report.ts'

const assistantLine = (over: {
  id?: string
  model?: string
  usage?: Record<string, unknown>
}): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: 'u-' + Math.random().toString(36).slice(2),
    message: {
      id: over.id ?? 'msg_' + Math.random().toString(36).slice(2),
      model: over.model ?? 'claude-opus-4-8',
      usage: over.usage ?? {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 2,
      },
    },
  }) + '\n'

test('sumUsageFromJsonl sums assistant usage blocks and keeps the last model', () => {
  const chunk =
    assistantLine({ id: 'a', model: 'claude-sonnet-5' }) +
    JSON.stringify({ type: 'user', message: { role: 'user' } }) + '\n' +
    assistantLine({
      id: 'b',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 90, output_tokens: 45, cache_read_input_tokens: 900 },
    })
  const totals = sumUsageFromJsonl(chunk)
  assert.equal(totals.entries, 2)
  assert.equal(totals.inputTokens, 100)
  assert.equal(totals.outputTokens, 50)
  assert.equal(totals.cacheReadTokens, 1000)
  assert.equal(totals.cacheCreationTokens, 2)
  assert.equal(totals.model, 'claude-opus-4-8')
})

test('sumUsageFromJsonl dedupes streamed content-block lines sharing one message id', () => {
  // One API turn = one billed usage, but the transcript repeats the usage
  // object on each content-block line of the same message id.
  const chunk =
    assistantLine({ id: 'same', usage: { input_tokens: 7, output_tokens: 3 } }) +
    assistantLine({ id: 'same', usage: { input_tokens: 7, output_tokens: 3 } }) +
    assistantLine({ id: 'same', usage: { input_tokens: 7, output_tokens: 3 } })
  const totals = sumUsageFromJsonl(chunk)
  assert.equal(totals.entries, 1)
  assert.equal(totals.inputTokens, 7)
  assert.equal(totals.outputTokens, 3)
})

test('sumUsageFromJsonl skips malformed and partial lines', () => {
  const chunk =
    'not json at all\n' +
    '{"type":"assistant","message":{"usage":' + // truncated tail
    ''
  const totals = sumUsageFromJsonl(chunk)
  assert.equal(totals.entries, 0)
})

test('buildUsageReport defaults to subscription (Claude Max) and never carries dollars', () => {
  const report = buildUsageReport(
    sumUsageFromJsonl(assistantLine({})),
    {},
  )
  assert.ok(report)
  assert.equal(report.billingMode, 'subscription')
  assert.equal(report.source, 'claude-code-jsonl')
  assert.ok(!('costUsd' in report))
})

test('buildUsageReport honors BGOS_USAGE_BILLING_MODE=api and BGOS_USAGE_REPORT=off', () => {
  const totals = sumUsageFromJsonl(assistantLine({}))
  assert.equal(buildUsageReport(totals, { BGOS_USAGE_BILLING_MODE: 'api' })?.billingMode, 'api')
  assert.equal(buildUsageReport(totals, { BGOS_USAGE_REPORT: 'off' }), null)
  assert.equal(
    buildUsageReport(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: null, entries: 0 },
      {},
    ),
    null,
  )
})

test('mungeCwd matches Claude Code project-dir naming', () => {
  assert.equal(
    mungeCwd('/Users/kc/Projects/BGOS/worktrees/fleet-pulse'),
    '-Users-kc-Projects-BGOS-worktrees-fleet-pulse',
  )
  assert.equal(
    mungeCwd('/Users/kc/Library/Marketing Data - Documents'),
    '-Users-kc-Library-Marketing-Data---Documents',
  )
})

test('UsageTracker reports only appended-after-startup usage, exactly once', () => {
  const home = mkdtempSync(join(tmpdir(), 'bgos-usage-'))
  const cwd = '/tmp/agent-workspace'
  const projectDir = join(home, 'projects', mungeCwd(cwd))
  mkdirSync(projectDir, { recursive: true })
  const transcript = join(projectDir, 'session-1.jsonl')
  // History that predates the server: must NOT be re-reported.
  writeFileSync(transcript, assistantLine({ usage: { input_tokens: 99999, output_tokens: 99999 } }))

  const tracker = new UsageTracker(cwd, home)
  assert.equal(tracker.collect({}), null, 'startup history is not re-reported')

  // A new turn lands.
  appendFileSync(transcript, assistantLine({ id: 'turn1', usage: { input_tokens: 120, output_tokens: 30 } }))
  const first = tracker.collect({})
  assert.ok(first)
  assert.equal(first.inputTokens, 120)
  assert.equal(first.outputTokens, 30)
  assert.equal(first.billingMode, 'subscription')

  // Nothing new -> nothing reported (no double count).
  assert.equal(tracker.collect({}), null)

  // Two more turns accumulate into the NEXT report (turns that end without
  // a reply are deferred, not lost).
  appendFileSync(transcript, assistantLine({ id: 'turn2', usage: { input_tokens: 10, output_tokens: 1 } }))
  appendFileSync(transcript, assistantLine({ id: 'turn3', usage: { input_tokens: 20, output_tokens: 2 } }))
  const second = tracker.collect({})
  assert.ok(second)
  assert.equal(second.inputTokens, 30)
  assert.equal(second.outputTokens, 3)

  // A brand-new session file created after startup counts from byte 0.
  const transcript2 = join(projectDir, 'session-2.jsonl')
  writeFileSync(transcript2, assistantLine({ id: 'turn4', usage: { input_tokens: 5, output_tokens: 5 } }))
  const third = tracker.collect({})
  assert.ok(third)
  assert.equal(third.inputTokens, 5)
})

test('UsageTracker survives a missing project dir', () => {
  const tracker = new UsageTracker('/nowhere/at/all', join(tmpdir(), 'bgos-usage-none'))
  assert.equal(tracker.collect({}), null)
})
