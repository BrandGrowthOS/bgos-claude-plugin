/**
 * Cross-repo anti-drift test for the hard floor (rules_version 1).
 *
 * lib/hard-floor-fixture.ts is COPIED BYTE FOR BYTE from the platform
 * backend's backend/src/services/hard-floor-fixture.ts, whose own spec runs
 * the same cases through the server's classifier. If either side changes a
 * rule id, a word, the version, or how any named case classifies, without the
 * other following, one of the two suites goes red. That matters in both
 * directions: a case the plugin misses is an action the hook never asks about
 * and the relay never holds, whatever the owner's switch says; a case only the
 * plugin catches is a round trip, a terminal prompt and, when the check
 * errors, a refused call for an action the server does not list.
 *
 * WHAT THIS SUITE CANNOT SEE: the backend repo. So the digests are pinned
 * TWICE, in the fixture file and as literals below, the same two literals the
 * backend's hard-floor-fixture.spec.ts pins: regenerating the data and its
 * digest together turns this red until the literals move too, a visible diff
 * in both repos, and the reconciliation step byte compares the two files and
 * reads the two pairs of literals side by side.
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

/**
 * The digests, as literals, equal to the backend spec's PINNED_FIXTURE_DIGEST
 * and PINNED_RULES_DIGEST. Change these only together with a fixture copied
 * afresh from the backend.
 */
const PINNED_FIXTURE_DIGEST = '9524af5c3f2b10e89775e484f24c7470c6c1719257219cc26bebb933308deb46'
const PINNED_RULES_DIGEST = '5e1a1d280b70eaab889899dd83da5b81603b1362030c0b91b537624506237573'

test('pins the fixture data and the rules against the file AND a literal here (regenerate BOTH repos together)', () => {
  const fixture = sha256(JSON.stringify(HARD_FLOOR_FIXTURE))
  const rules = sha256(JSON.stringify(HARD_FLOOR_FIXTURE_RULES))
  assert.equal(fixture, HARD_FLOOR_FIXTURE_DIGEST)
  assert.equal(rules, HARD_FLOOR_RULES_DIGEST)
  assert.equal(fixture, PINNED_FIXTURE_DIGEST, 'the data changed: copy the backend file afresh and move the literal')
  assert.equal(rules, PINNED_RULES_DIGEST)
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
