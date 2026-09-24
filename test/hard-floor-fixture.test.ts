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
 * THE CARD KIND. The same file carries HARD_FLOOR_CARD_FIXTURE, the approval
 * card `tool` strings the server's card reader stamps the floor from. For
 * every card the Claude Code relay writes, this test builds it from the
 * stated inputs with the relay's own `permissionCardTool` and asserts the
 * SAME string, byte for byte, and that this plugin's own reading of those
 * inputs (the hook's evidence, or the request's preview) names the rule the
 * server will stamp. The backend's spec runs its card reader over the same
 * strings, so a card shape one side changes alone turns that side red.
 *
 * WHAT THIS SUITE CANNOT SEE: the backend repo. So the data digests are
 * pinned TWICE, in the fixture file and as literals below, the same literals
 * the backend's hard-floor-fixture.spec.ts pins, and the sha256 of the
 * fixture FILE'S BYTES is pinned below too (the plugin's .gitattributes
 * keeps the file at LF on a Windows checkout, so the bytes are the same on
 * every machine). A regenerated fixture, or a comment changed in this copy
 * alone, turns this red until the literals move, a visible diff in both
 * repos, and the reconciliation step byte compares the two files and reads
 * the two sets of literals side by side.
 *
 * Run with: npx tsx --test test/hard-floor-fixture.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  HARD_FLOOR_CARD_FIXTURE,
  HARD_FLOOR_CARD_FIXTURE_DIGEST,
  HARD_FLOOR_FIXTURE,
  HARD_FLOOR_FIXTURE_DIGEST,
  HARD_FLOOR_FIXTURE_RULES,
  HARD_FLOOR_FIXTURE_RULES_VERSION,
  HARD_FLOOR_RULES_DIGEST,
} from '../lib/hard-floor-fixture.ts'
import {
  HARD_FLOOR_RULES,
  HARD_FLOOR_RULES_VERSION,
  classifyCommand,
  classifyFloor,
  classifyPermissionRequest,
  type HardFloorInput,
} from '../lib/hard-floor.ts'
import { permissionCardTool } from '../lib/permission-relay.ts'

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
const PINNED_FIXTURE_DIGEST = '19c12d28cf3cffa382a38927cab05bacc8060dfbdad6e423791c25665f07ddf8'
const PINNED_CARD_FIXTURE_DIGEST = 'dee81aa8df1f5c008b5af7a4b8ab464ca46d7a56d5e3116693007499cb7dd280'
const PINNED_RULES_DIGEST = '5e1a1d280b70eaab889899dd83da5b81603b1362030c0b91b537624506237573'
/**
 * sha256 of lib/hard-floor-fixture.ts's BYTES, equal to the backend spec's
 * PINNED_FIXTURE_FILE_SHA256 (the #1623 / #152 shape). The data digests
 * above let a comment, a type or the header drift in one copy while both
 * suites stay green; this does not.
 */
const PINNED_FIXTURE_FILE_SHA256 = 'fd34a82a22e2ad97e0516f5692c2ac162ff14e3b470a716370217f78081c38ca'

test('pins the fixture data and the rules against the file AND a literal here (regenerate BOTH repos together)', () => {
  const fixture = sha256(JSON.stringify(HARD_FLOOR_FIXTURE))
  const cards = sha256(JSON.stringify(HARD_FLOOR_CARD_FIXTURE))
  const rules = sha256(JSON.stringify(HARD_FLOOR_FIXTURE_RULES))
  assert.equal(fixture, HARD_FLOOR_FIXTURE_DIGEST)
  assert.equal(cards, HARD_FLOOR_CARD_FIXTURE_DIGEST)
  assert.equal(rules, HARD_FLOOR_RULES_DIGEST)
  assert.equal(fixture, PINNED_FIXTURE_DIGEST, 'the data changed: copy the backend file afresh and move the literal')
  assert.equal(cards, PINNED_CARD_FIXTURE_DIGEST, 'the card data changed: copy the backend file afresh and move the literal')
  assert.equal(rules, PINNED_RULES_DIGEST)
})

test('pins the fixture FILE BYTES, so a comment or a type changed in this copy alone is red too', () => {
  const bytes = readFileSync(new URL('../lib/hard-floor-fixture.ts', import.meta.url))
  assert.equal(bytes.includes(0x0d), false, 'LF only: .gitattributes pins lib/hard-floor-fixture.ts to eol=lf')
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    PINNED_FIXTURE_FILE_SHA256,
    'this copy is not byte identical to the one the literal was taken from: copy the backend file afresh',
  )
})

test('.gitattributes keeps the fixture at LF on a Windows checkout', () => {
  const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8')
  assert.match(attributes, /^lib\/hard-floor-fixture\.ts text eol=lf$/m)
})

test('the card strings: the relay builds every relay card byte for byte, and reads the rule the server stamps', () => {
  const wrong: string[] = []
  let relayCards = 0
  for (const card of HARD_FLOOR_CARD_FIXTURE) {
    if (card.writer !== 'claude_relay') {
      assert.equal(card.relay, undefined, `${card.name}: only a relay card carries relay inputs`)
      continue
    }
    assert.ok(card.relay, `${card.name}: a relay card carries its inputs`)
    relayCards += 1
    const built = permissionCardTool(card.relay)
    if (built !== card.tool) {
      wrong.push(`${card.name}: built ${JSON.stringify(built.slice(0, 60))} (${built.length}), fixture ${JSON.stringify(card.tool.slice(0, 60))} (${card.tool.length})`)
    }
    // What the relay itself decided: the hook's evidence when it held one, else the preview.
    const own = card.relay.floorEvidence
      ? classifyCommand(card.relay.floorEvidence)
      : (classifyPermissionRequest(card.relay.toolName, card.relay.inputPreview)?.ruleId ?? null)
    if (own !== card.ruleId) wrong.push(`${card.name}: the relay reads ${own}, the server stamps ${card.ruleId}`)
  }
  assert.deepEqual(wrong, [])
  assert.ok(relayCards >= 10, `every relay shape is walked (${relayCards})`)
})

test('the card corpus is well formed: unique names, a known writer, a must and a must not per writer', () => {
  const all = [...HARD_FLOOR_FIXTURE, ...HARD_FLOOR_CARD_FIXTURE].map((c) => c.name)
  assert.equal(new Set(all).size, all.length, 'names are unique across both lists')
  const ids = new Set(HARD_FLOOR_FIXTURE_RULES.map((r) => r.id))
  for (const card of HARD_FLOOR_CARD_FIXTURE) {
    assert.match(card.name, /^card_[a-z0-9_]+$/, card.name)
    if (card.ruleId !== null) assert.ok(ids.has(card.ruleId), `${card.name} names a rule that exists`)
  }
  for (const writer of ['claude_relay', 'codex_file_change', 'codex_command']) {
    const ofWriter = HARD_FLOOR_CARD_FIXTURE.filter((c) => c.writer === writer)
    assert.ok(ofWriter.some((c) => c.ruleId !== null), `${writer}: a card that must be stamped`)
    assert.ok(ofWriter.some((c) => c.ruleId === null), `${writer}: a card that must not`)
  }
  for (const name of [
    'card_relay_mcp_name_then_preview',
    'card_relay_mcp_bare_name',
    'card_relay_shell_capped_leads_with_evidence',
    'card_relay_shell_elided_leads_with_evidence',
    'card_codex_rename_into_env',
    'card_codex_rename_into_git',
  ]) {
    assert.ok(all.includes(name), name)
  }
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
