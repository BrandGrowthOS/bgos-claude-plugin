/**
 * Positive self-session transcript binding: the contextPct gauge must track
 * THIS daemon's session, not whichever transcript in the shared project dir
 * was touched last (the frozen/wrong-gauge bug).
 *
 * Pure-function tests for the resolution chain plus fs-backed tests for the
 * binder, using fixture transcripts whose entry shapes mirror real ones
 * (tool_result marker entries, assistant usage entries).
 *
 * Run with:  npm test      (node --test, no extra deps)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  tailContainsMarker,
  findMarkerFile,
  resolveBinding,
  AMBIGUITY_WINDOW_MS,
  SessionTranscriptBinder,
} from '../lib/session-binding.ts'
import { mungeCwd } from '../lib/usage-report.ts'

// Real-shape fixture lines.
const markerLine = (messageId: number): string =>
  JSON.stringify({
    parentUuid: '92043e68-88c6-4bd7-8860-6bc2079a944c',
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: 'toolu_01Kd23Mgcx8mkHKzoUBaqWrB',
          type: 'tool_result',
          content: [{ type: 'text', text: `Sent (message_id: ${messageId})` }],
        },
      ],
    },
  })

// Model pinned to a 200k family: these tests assert WHICH transcript the
// binder reads, so the percentages below are just a legible way to tell the
// fixtures apart. A 1M-context model id here would make every expected value
// a function of the window table instead.
const assistantLine = (usedTokens: number): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-haiku-4-5',
      id: 'msg_fixture',
      role: 'assistant',
      usage: {
        input_tokens: usedTokens,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })

// ── tailContainsMarker ───────────────────────────────────────────────────────

test('marker matches a real tool_result user entry', () => {
  const chunk = `${assistantLine(1000)}\n${markerLine(20287)}\n`
  assert.ok(tailContainsMarker(chunk, 'Sent (message_id: 20287'))
  assert.ok(!tailContainsMarker(chunk, 'Sent (message_id: 99999'))
})

test('marker inside a non-user line does not match', () => {
  const prose = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: 'discussing Sent (message_id: 777) in prose' },
  })
  assert.ok(!tailContainsMarker(`${prose}\n`, 'Sent (message_id: 777'))
})

// ── findMarkerFile ───────────────────────────────────────────────────────────

test('newest marker wins across files', () => {
  const tails = [
    { name: 'old.jsonl', chunk: `${markerLine(100)}\n` },
    { name: 'ours.jsonl', chunk: `${markerLine(200)}\n` },
  ]
  // markers are newest-first
  assert.equal(
    findMarkerFile(tails, ['Sent (message_id: 200', 'Sent (message_id: 100']),
    'ours.jsonl',
  )
  // fall back to an older marker when the newest is not on disk yet
  assert.equal(
    findMarkerFile(tails, ['Sent (message_id: 999', 'Sent (message_id: 100']),
    'old.jsonl',
  )
  assert.equal(findMarkerFile(tails, []), null)
})

// ── resolveBinding priority chain ────────────────────────────────────────────

// Every resolveBinding call passes an explicit `now`; the ambiguity rule
// (rule 5) measures candidate mtimes against it. RECENT_* sit inside the
// AMBIGUITY_WINDOW_MS window, STALE sits just outside it.
const NOW = 100 * 60_000
const RECENT_A = NOW - 2000
const RECENT_B = NOW - 1000
const STALE = NOW - AMBIGUITY_WINDOW_MS - 1

// Two recent candidates plus a stale env-id file: rule 5 alone would refuse
// this set as ambiguous, so every positive-signal test below also proves its
// signal (marker / sticky marker / env / sticky previous) beats ambiguity.
const cands = [
  { name: 'a.jsonl', mtimeMs: RECENT_A },
  { name: 'b.jsonl', mtimeMs: RECENT_B },
  { name: 'env-id.jsonl', mtimeMs: STALE },
]

test('marker evidence beats everything, two-recent ambiguity included', () => {
  const b = resolveBinding({
    candidates: cands,
    envSessionId: 'env-id',
    markerFile: 'a.jsonl',
    previous: { name: 'b.jsonl', source: 'newest-mtime' },
    now: NOW,
  })
  assert.deepEqual(b, { name: 'a.jsonl', source: 'marker' })
})

test('a marker-proven binding is sticky across scan misses', () => {
  const b = resolveBinding({
    candidates: cands,
    envSessionId: 'env-id',
    markerFile: null,
    previous: { name: 'a.jsonl', source: 'marker' },
    now: NOW,
  })
  assert.deepEqual(b, { name: 'a.jsonl', source: 'marker' })
})

test('env session id binds when its file exists, ambiguity and staleness aside', () => {
  const b = resolveBinding({
    candidates: cands,
    envSessionId: 'env-id',
    markerFile: null,
    previous: null,
    now: NOW,
  })
  // env-id.jsonl is stale and a/b are both recent; the env id still wins
  // because it is a positive signal, not an mtime guess.
  assert.deepEqual(b, { name: 'env-id.jsonl', source: 'env' })
})

test('env session id is ignored when its file is absent (--continue launch)', () => {
  // Rewritten for the ambiguity rule: the old expectation bound b.jsonl by
  // newest mtime among several live candidates, which is exactly the guess
  // rule 5 now refuses. One recent + one stale keeps the fallthrough
  // unambiguous, so the test still pins the env-file-absent behavior.
  const b = resolveBinding({
    candidates: [
      { name: 'a.jsonl', mtimeMs: STALE },
      { name: 'b.jsonl', mtimeMs: RECENT_B },
    ],
    envSessionId: 'env-id',
    markerFile: null,
    previous: null,
    now: NOW,
  })
  assert.deepEqual(b, { name: 'b.jsonl', source: 'newest-mtime' })
})

test('sticky previous binding: a foreign session cannot steal it via mtime', () => {
  const b = resolveBinding({
    candidates: cands,
    envSessionId: null,
    markerFile: null,
    previous: { name: 'a.jsonl', source: 'newest-mtime' },
    now: NOW,
  })
  // b.jsonl is newer and both are recent (ambiguous for rule 5), but the
  // held binding survives without falling through to a guess.
  assert.deepEqual(b, { name: 'a.jsonl', source: 'newest-mtime' })
})

test('newest-mtime fires only when unambiguous; empty dir yields null', () => {
  // Rewritten for the ambiguity rule: the old test bound the newest of
  // three live candidates with no signal at all, the always-guess behavior
  // rule 5 no longer has. A sole recent candidate among stale ones is the
  // unambiguous case that still binds.
  assert.deepEqual(
    resolveBinding({
      candidates: [
        { name: 'a.jsonl', mtimeMs: STALE },
        { name: 'b.jsonl', mtimeMs: RECENT_B },
        { name: 'c.jsonl', mtimeMs: STALE - 5000 },
      ],
      envSessionId: null,
      markerFile: null,
      previous: null,
      now: NOW,
    }),
    { name: 'b.jsonl', source: 'newest-mtime' },
  )
  assert.equal(
    resolveBinding({
      candidates: [],
      envSessionId: 'env-id',
      markerFile: 'x.jsonl',
      previous: { name: 'y.jsonl', source: 'marker' },
      now: NOW,
    }),
    null,
  )
})

// ── resolveBinding ambiguity refusal (rule 5) ────────────────────────────────

test('two recent candidates and no positive signal refuse to bind', () => {
  const b = resolveBinding({
    candidates: [
      { name: 'a.jsonl', mtimeMs: RECENT_A },
      { name: 'b.jsonl', mtimeMs: RECENT_B },
    ],
    envSessionId: null,
    markerFile: null,
    previous: null,
    now: NOW,
  })
  assert.equal(b, null)
})

test('one recent + one stale binds the recent one', () => {
  const b = resolveBinding({
    candidates: [
      { name: 'stale.jsonl', mtimeMs: STALE },
      { name: 'live.jsonl', mtimeMs: RECENT_B },
    ],
    envSessionId: null,
    markerFile: null,
    previous: null,
    now: NOW,
  })
  assert.deepEqual(b, { name: 'live.jsonl', source: 'newest-mtime' })
})

test('a sole candidate binds even when stale', () => {
  // Nothing else exists to confuse it with, so staleness is no objection.
  const b = resolveBinding({
    candidates: [{ name: 'only.jsonl', mtimeMs: STALE }],
    envSessionId: null,
    markerFile: null,
    previous: null,
    now: NOW,
  })
  assert.deepEqual(b, { name: 'only.jsonl', source: 'newest-mtime' })
})

// ── SessionTranscriptBinder (fs-backed) ──────────────────────────────────────

function makeProjectDir(cwd: string): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), 'binder-test-'))
  const dir = join(home, 'projects', mungeCwd(cwd))
  mkdirSync(dir, { recursive: true })
  return { home, dir }
}

test('binder: marker scan rebinds away from a newer foreign transcript', () => {
  const cwd = '/work/space'
  const { home, dir } = makeProjectDir(cwd)
  const now = Date.now()
  // Ours: contains our reply marker, older mtime.
  writeFileSync(join(dir, 'ours.jsonl'), `${assistantLine(40_000)}\n${markerLine(20287)}\n`)
  utimesSync(join(dir, 'ours.jsonl'), new Date(now - 60_000), new Date(now - 60_000))
  // Foreign: newer mtime, would win under the old newest-mtime heuristic.
  writeFileSync(join(dir, 'foreign.jsonl'), `${assistantLine(190_000)}\n`)

  const binder = new SessionTranscriptBinder(cwd, { claudeHome: home })
  binder.recordReplyMessageId(20287)
  const resolved = binder.resolve(now)
  assert.ok(resolved)
  assert.equal(resolved.binding.name, 'ours.jsonl')
  assert.equal(resolved.binding.source, 'marker')
  // And the pct comes from OUR transcript (40k/200k = 20), not the foreign 95.
  assert.equal(binder.readContextPct(), 20)
})

test('binder: falls back to newest-mtime with a log line when no signal exists', () => {
  const cwd = '/work/other'
  const { home, dir } = makeProjectDir(cwd)
  const now = Date.now()
  writeFileSync(join(dir, 'only.jsonl'), `${assistantLine(100_000)}\n`)
  const logs: string[] = []
  const binder = new SessionTranscriptBinder(cwd, {
    claudeHome: home,
    log: (m) => logs.push(m),
  })
  const resolved = binder.resolve(now)
  assert.ok(resolved)
  assert.equal(resolved.binding.source, 'newest-mtime')
  assert.ok(
    logs.some((l) => l.includes('newest-mtime') && l.includes('unambiguous')),
  )
  assert.equal(binder.readContextPct(), 50)
})

test('binder: refuses to guess between two recent transcripts, logs once', () => {
  const cwd = '/work/ambiguous'
  const { home, dir } = makeProjectDir(cwd)
  const now = Date.now()
  writeFileSync(join(dir, 'one.jsonl'), `${assistantLine(50_000)}\n`)
  writeFileSync(join(dir, 'two.jsonl'), `${assistantLine(60_000)}\n`)
  const logs: string[] = []
  const binder = new SessionTranscriptBinder(cwd, {
    claudeHome: home,
    log: (m) => logs.push(m),
  })
  // Both transcripts are recent and nothing positive distinguishes them:
  // stay unbound rather than track a possible neighbour, and say so once.
  assert.equal(binder.resolve(now), null)
  assert.equal(binder.readContextPct(), null)
  assert.equal(binder.resolve(now), null)
  assert.equal(
    logs.filter((l) => l.includes('refusing to guess')).length,
    1,
  )
  // The first reply marker resolves the ambiguity with positive proof.
  writeFileSync(
    join(dir, 'one.jsonl'),
    `${assistantLine(50_000)}\n${markerLine(31337)}\n`,
  )
  binder.recordReplyMessageId(31337)
  const resolved = binder.resolve(now)
  assert.ok(resolved)
  assert.equal(resolved.binding.name, 'one.jsonl')
  assert.equal(resolved.binding.source, 'marker')
  assert.equal(binder.readContextPct(), 25)
})

test('binder: env session id binds a fresh launch', () => {
  const cwd = '/work/fresh'
  const { home, dir } = makeProjectDir(cwd)
  writeFileSync(join(dir, 'sess-123.jsonl'), `${assistantLine(20_000)}\n`)
  writeFileSync(join(dir, 'other.jsonl'), `${assistantLine(180_000)}\n`)
  const binder = new SessionTranscriptBinder(cwd, {
    claudeHome: home,
    envSessionId: 'sess-123',
  })
  const resolved = binder.resolve()
  assert.ok(resolved)
  assert.deepEqual(resolved.binding, { name: 'sess-123.jsonl', source: 'env' })
  assert.equal(binder.readContextPct(), 10)
})

test('binder: missing project dir degrades to null, never throws', () => {
  const binder = new SessionTranscriptBinder('/nope', {
    claudeHome: join(tmpdir(), 'binder-test-does-not-exist'),
  })
  assert.equal(binder.resolve(), null)
  assert.equal(binder.readContextPct(), null)
  assert.equal(binder.readBoundTail(), null)
})
