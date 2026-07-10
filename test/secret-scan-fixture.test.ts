/**
 * Cross-repo anti-drift test for the secret-scan gate (rules_version 1).
 *
 * The platform backend runs src/agent-handoffs/secret-scan-fixture.spec.ts
 * over the SAME corpus with the SAME expected findings and the SAME two
 * digests. If either scanner changes a rule name, a rule order, a regex, or
 * the corpus without the other following, one of the two suites goes red.
 * That is the point: the claude-code packaging path scans with lib/secret-scan.ts
 * and the n8n path scans with the backend twin, so a silent divergence is how
 * a secret ships in a pack.
 *
 * Run: npm test  (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  SECRET_SCAN_FIXTURE,
  SECRET_SCAN_FIXTURE_DIGEST,
  SECRET_SCAN_RULE_NAMES_DIGEST,
} from '../lib/secret-scan-fixture.ts'
import {
  SECRET_SCAN_RULE_NAMES,
  SECRET_SCAN_RULES_VERSION,
  scanText,
} from '../lib/secret-scan.ts'

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

test('pins rules_version 1', () => {
  assert.equal(SECRET_SCAN_RULES_VERSION, 1)
})

test('pins the fixture data (regenerate BOTH repos when this changes)', () => {
  assert.equal(
    sha256(JSON.stringify(SECRET_SCAN_FIXTURE)),
    SECRET_SCAN_FIXTURE_DIGEST,
  )
})

test('pins the rule names and their order against the backend twin', () => {
  assert.equal(
    sha256(JSON.stringify(SECRET_SCAN_RULE_NAMES)),
    SECRET_SCAN_RULE_NAMES_DIGEST,
  )
})

test('scans every fixture case exactly as the backend does', () => {
  for (const testCase of SECRET_SCAN_FIXTURE) {
    const findings = scanText('f.txt', testCase.line)
    assert.deepEqual(
      findings.map((f) => ({ rule: f.rule, excerpt: f.excerpt })),
      testCase.findings,
      `case ${testCase.name}`,
    )
    for (const finding of findings) {
      assert.equal(finding.file, 'f.txt')
      assert.equal(finding.line, 1)
    }
  }
})

test('blocks every case that carries a secret and passes every clean case', () => {
  const blocked = SECRET_SCAN_FIXTURE.filter((c) => c.findings.length > 0)
  const clean = SECRET_SCAN_FIXTURE.filter((c) => c.findings.length === 0)
  assert.ok(blocked.length > 0)
  assert.ok(clean.length > 0)
  for (const c of blocked) {
    assert.ok(scanText('f.txt', c.line).length > 0, `expected block: ${c.name}`)
  }
  for (const c of clean) {
    assert.deepEqual(scanText('f.txt', c.line), [], `expected clean: ${c.name}`)
  }
})

test('never echoes a full secret in an excerpt', () => {
  for (const c of SECRET_SCAN_FIXTURE) {
    for (const finding of scanText('f.txt', c.line)) {
      assert.match(finding.excerpt, /\.\.\.$/)
      assert.ok(finding.excerpt.length <= 7)
    }
  }
})
