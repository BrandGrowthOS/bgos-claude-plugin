/**
 * lib/claude-capability-tokens.ts is pinned by hash, not by a sentence.
 *
 * WHAT IS COPIED AND WHY. The BGOS capability canon tells a Claude Code agent
 * the request card sentence only when this daemon declares `permission_card`,
 * and the plan card sentences only when it declares `plan_card`, whatever the
 * daemon's version (BGOS #1624). The canon gates on BGOS's
 * backend/src/integrations/claude-capability-tokens.ts; this daemon declares
 * from lib/claude-capability-tokens.ts, a byte-for-byte copy of it. A token
 * spelled differently on the two sides fails nowhere on its own: the backend's
 * grammar accepts it, the pairing stores it, and the agent is simply never
 * told about a card this daemon posts. So the spelling is held by a hash.
 *
 * THE OTHER HALF. BGOS's
 * backend/src/integrations/claude-capability-tokens.pin.spec.ts pins the SAME
 * digest on its copy, so editing the file there fails BGOS's suite and
 * editing it here fails this one. Neither repo's CI can read the other, which
 * is why each side carries the literal. The last case below compares the two
 * copies directly when both trees are on one machine.
 *
 * WHEN THE DIGEST CASE FAILS, and it is meant to, do not silence it:
 *   1. Make the same edit to BGOS's copy, so the two are byte for byte
 *      identical (LF, no BOM; .gitattributes pins this one to LF).
 *   2. Put the new sha256 in SHA256 below AND in BGOS's pin spec.
 *   3. Ship both in one pair of PRs.
 *
 * WHICH TOKENS THIS RELEASE DECLARES. The file names every token the canon
 * gates a Claude Code sentence on. A token must be declared exactly when this
 * release carries the code that keeps its promise, and never before, because
 * declaring it is what makes the canon tell the agent. This release (#142,
 * the permission relay) carries the relay, so it declares permission_card.
 * It does NOT carry the propose_plan tool: plan_card is named in the file
 * but is declared by #150 (feat/p2-plan-card), which stacks on this branch
 * and carries the tool, and this test asserts plan_card is NOT declared here
 * so the canon cannot tell a daemon on this release about a tool it lacks.
 *
 * MUTATION PROOFS (recorded 2026-09-24 on the Windows build box, through the
 * test lock, file restored byte for byte from a pristine copy after each and
 * re-hashed):
 *  1. one byte flipped in this copy (`plan_card` to `plan_carf` in the
 *     PLAN_CARD literal, byte 1838) -> 2 red: "the token file still has the
 *     bytes BGOS pins for its copy" and "the file names exactly
 *     permission_card and plan_card, in that order".
 *  2. one byte flipped in a COMMENT of this copy (the header's first word
 *     `The` to `Tho`, byte 10) -> 1 red, the digest case alone: behaviour
 *     unchanged, and still caught, because the BGOS copy would then differ.
 *  3. lib/declared-capabilities.ts spelling 'permission_card' itself in
 *     place of the imported PERMISSION_CARD -> 1 red: "this release declares
 *     permission_card, from the file, on every host".
 * BGOS's pin spec records the same two flips on its copy (2 of 5 red, then 1
 * of 5), so a byte changed on either side alone is red on that side.
 *
 * Run: npm test, or npx tsx --test test/claude-capability-tokens.pin.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CLAUDE_CAPABILITY_TOKENS,
  PERMISSION_CARD,
  PLAN_CARD,
} from '../lib/claude-capability-tokens.ts'
import { DECLARED_CAPABILITIES_BASE, declaredCapabilities } from '../lib/declared-capabilities.ts'

/** The digest BGOS's claude-capability-tokens.pin.spec.ts pins too. */
const SHA256 = '128dec02ae34ac6f117805969bd95ba9f0654fac79e72f649286818614bc26e3'

const ROOT = join(import.meta.dirname, '..')
const FILE = join(ROOT, 'lib', 'claude-capability-tokens.ts')

/** The tokens this release carries the code for, and so declares. */
const DECLARED_BY_THIS_RELEASE: readonly string[] = [PERMISSION_CARD]

/** Named in the file, NOT declared by this release, and who declares them. */
const DECLARED_LATER: Readonly<Record<string, string>> = {
  [PLAN_CARD]: '#150 (feat/p2-plan-card), which carries the propose_plan tool and /plan',
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Block and line comments removed, so a word in a header is not code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('the token file still has the bytes BGOS pins for its copy', () => {
  assert.equal(
    sha256Of(FILE),
    SHA256,
    'lib/claude-capability-tokens.ts does not match its pin. It must never be edited here alone: make the same edit to BGOS backend/src/integrations/claude-capability-tokens.ts and move both pins (this file header has the steps).',
  )
})

test('the file names exactly permission_card and plan_card, in that order', () => {
  assert.deepEqual([...CLAUDE_CAPABILITY_TOKENS], ['permission_card', 'plan_card'])
  assert.equal(PERMISSION_CARD, 'permission_card')
  assert.equal(PLAN_CARD, 'plan_card')
  assert.ok(Object.isFrozen(CLAUDE_CAPABILITY_TOKENS))
})

test('every token the file names is either declared by this release or named as declared later', () => {
  for (const token of CLAUDE_CAPABILITY_TOKENS) {
    const declared = DECLARED_BY_THIS_RELEASE.includes(token)
    const later = Object.hasOwn(DECLARED_LATER, token)
    assert.ok(declared !== later, `${token} must be exactly one of: declared by this release, or declared later`)
  }
})

test('this release declares permission_card, from the file, on every host', () => {
  for (const token of DECLARED_BY_THIS_RELEASE) {
    assert.ok(DECLARED_CAPABILITIES_BASE.includes(token), `${token} is missing from DECLARED_CAPABILITIES_BASE`)
    for (const canInjectGoal of [true, false]) {
      assert.ok(declaredCapabilities({ canInjectGoal }).includes(token))
    }
  }
  // Taken from the file, not spelled again: a second literal would agree with
  // the file today and drift from it tomorrow without the pin seeing it.
  const code = withoutComments(readFileSync(join(ROOT, 'lib', 'declared-capabilities.ts'), 'utf8'))
  for (const token of CLAUDE_CAPABILITY_TOKENS) {
    assert.ok(!code.includes(`'${token}'`), `lib/declared-capabilities.ts spells '${token}' itself; import it from lib/claude-capability-tokens.ts`)
  }
  assert.match(code, /from '\.\/claude-capability-tokens\.js'/)
})

test('plan_card is NOT declared by this release: #150 declares it, with the tool it promises', () => {
  for (const token of Object.keys(DECLARED_LATER)) {
    for (const canInjectGoal of [true, false]) {
      assert.ok(
        !declaredCapabilities({ canInjectGoal }).includes(token),
        `${token} is declared, but ${DECLARED_LATER[token]} carries the code it promises`,
      )
    }
  }
})

test('the file is LF only with no BOM and no imports, and .gitattributes keeps it so', () => {
  const bytes = readFileSync(FILE)
  assert.equal(bytes.includes(0x0d), false, 'a CR makes the pinned digest unverifiable on a Windows checkout')
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false)
  const code = withoutComments(bytes.toString('utf8'))
  assert.doesNotMatch(code, /\bimport\b/, 'the shared file must import nothing, so both toolchains read it unchanged')
  assert.doesNotMatch(code, /\brequire\s*\(/)
  const attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
  assert.match(attrs, /^lib\/claude-capability-tokens\.ts text eol=lf\r?$/m)
})

test('a changed byte is actually caught, so a passing pin is not vacuous', () => {
  const tampered = Buffer.concat([readFileSync(FILE), Buffer.from('\n')])
  assert.notEqual(createHash('sha256').update(tampered).digest('hex'), SHA256)
})

const bgosCopy = process.env.BGOS_CLAUDE_CAPABILITY_TOKENS_SOURCE
test(
  'cross tree: this copy is byte-identical to the BGOS copy',
  { skip: bgosCopy ? false : 'set BGOS_CLAUDE_CAPABILITY_TOKENS_SOURCE to BGOS backend/src/integrations/claude-capability-tokens.ts' },
  () => {
    assert.ok(existsSync(bgosCopy!), `${bgosCopy} does not exist`)
    assert.equal(sha256Of(FILE), sha256Of(bgosCopy!), 'the two copies have drifted')
  },
)
