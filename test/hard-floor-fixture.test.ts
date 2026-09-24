/**
 * Cross-repo anti-drift test for the hard floor (rules_version 1).
 *
 * The platform backend runs its own spec over the SAME file
 * (backend/src/services/hard-floor-fixture.ts, byte identical to
 * lib/hard-floor-fixture.ts) against ITS classifier. If either side changes a
 * rule id, a word, the version, or how any named case classifies, without the
 * other following, one of the two suites goes red. That matters in both
 * directions: a case the plugin misses is an action the hook never asks about
 * and the relay never holds, whatever the owner's switch says; a case only the
 * plugin catches is a round trip the server then waves on.
 *
 * Run with: npx tsx --test test/hard-floor-fixture.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  HARD_FLOOR_FIXTURE,
  HARD_FLOOR_FIXTURE_DIGEST,
  HARD_FLOOR_FIXTURE_RULES,
  HARD_FLOOR_FIXTURE_RULES_VERSION,
  HARD_FLOOR_RULES_DIGEST,
} from '../lib/hard-floor-fixture.ts'
import {
  HARD_FLOOR_RULES,
  HARD_FLOOR_RULES_VERSION,
  classifyFloor,
  type HardFloorInput,
} from '../lib/hard-floor.ts'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

test('the rules version is the cross repo key, and both sides say 1', () => {
  assert.equal(HARD_FLOOR_FIXTURE_RULES_VERSION, 1)
  assert.equal(HARD_FLOOR_RULES_VERSION, HARD_FLOOR_FIXTURE_RULES_VERSION)
})

test('this plugin carries exactly the fixture rule ids and words, in order', () => {
  assert.deepEqual(
    HARD_FLOOR_RULES.map((r) => ({ id: r.id, words: r.words })),
    HARD_FLOOR_FIXTURE_RULES,
  )
})

test('pins the fixture data and the rules (regenerate BOTH repos when this changes)', () => {
  assert.equal(sha256(JSON.stringify(HARD_FLOOR_FIXTURE)), HARD_FLOOR_FIXTURE_DIGEST)
  assert.equal(sha256(JSON.stringify(HARD_FLOOR_FIXTURE_RULES)), HARD_FLOOR_RULES_DIGEST)
})

test('every named case classifies exactly as the fixture says', () => {
  const wrong: string[] = []
  for (const testCase of HARD_FLOOR_FIXTURE) {
    const got = classifyFloor(testCase.input as HardFloorInput)?.ruleId ?? null
    if (got !== testCase.ruleId) {
      wrong.push(`${testCase.name}: expected ${testCase.ruleId}, got ${got}`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('a match always carries the version and the rule words the card prints', () => {
  for (const testCase of HARD_FLOOR_FIXTURE) {
    const match = classifyFloor(testCase.input as HardFloorInput)
    if (!match) continue
    assert.equal(match.rulesVersion, HARD_FLOOR_FIXTURE_RULES_VERSION, testCase.name)
    assert.equal(
      match.words,
      HARD_FLOOR_FIXTURE_RULES.find((r) => r.id === match.ruleId)?.words,
      testCase.name,
    )
  }
})

test('the corpus is well formed: unique names, every rule caught, every kind has a must not', () => {
  const names = HARD_FLOOR_FIXTURE.map((c) => c.name)
  assert.equal(new Set(names).size, names.length, 'case names are unique')
  for (const name of names) assert.match(name, /^[a-z0-9_]+$/, name)
  const ids = new Set(HARD_FLOOR_FIXTURE_RULES.map((r) => r.id))
  for (const c of HARD_FLOOR_FIXTURE) {
    if (c.ruleId !== null) assert.ok(ids.has(c.ruleId), `${c.name} names a rule that exists`)
  }
  for (const rule of HARD_FLOOR_FIXTURE_RULES) {
    assert.ok(
      HARD_FLOOR_FIXTURE.some((c) => c.ruleId === rule.id),
      `${rule.id} has at least one case that must match`,
    )
  }
  for (const kind of ['command', 'path', 'tool', 'request']) {
    const ofKind = HARD_FLOOR_FIXTURE.filter((c) => c.input.kind === kind)
    assert.ok(ofKind.some((c) => c.ruleId !== null), `${kind}: a case that must match`)
    assert.ok(ofKind.some((c) => c.ruleId === null), `${kind}: a case that must not`)
  }
  // The live probe's own frames are in it verbatim (map part 24, D1 and C2).
  assert.ok(names.includes('request_bash_rm_rf_verbatim'))
  assert.ok(names.includes('request_bash_force_push_verbatim'))
  // And the one harmless call the probe's subagents made on their own.
  assert.ok(names.includes('git_status'))
})

test('the fixture file is data only: no import, no em or en dash', () => {
  const src = readFileSync(new URL('../lib/hard-floor-fixture.ts', import.meta.url), 'utf8')
  assert.equal(/^\s*import\s/m.test(src), false, 'a byte identical file cannot import a repo path')
  const emDash = String.fromCharCode(0x2014)
  const enDash = String.fromCharCode(0x2013)
  assert.ok(!src.includes(emDash) && !src.includes(enDash))
})
