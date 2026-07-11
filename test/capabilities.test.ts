/**
 * Capability bootstrap: pickCapabilities selects the served canon when the
 * backend response is well-formed, and falls back to the bundled copy otherwise.
 *
 * Run with: npm test  (node --test, no extra deps)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  pickCapabilities,
  BGOS_CAPABILITIES_FALLBACK,
} from '../lib/capabilities.ts'

const SERVED_TEXT =
  '# BGOS Channel Agent Capabilities\n(channel: claude, canon v2026.07.11)\n\nGuide body.'

test('uses the served canon when the response carries both markers', () => {
  const r = pickCapabilities({ text: SERVED_TEXT, version: '2026.07.11' })
  assert.equal(r.source, 'backend')
  assert.equal(r.version, '2026.07.11')
  assert.equal(r.text, SERVED_TEXT)
})

test('defaults version to "unknown" when the backend omits it', () => {
  const r = pickCapabilities({ text: SERVED_TEXT })
  assert.equal(r.source, 'backend')
  assert.equal(r.version, 'unknown')
})

test('falls back to the bundled copy on null (fetch failed)', () => {
  const r = pickCapabilities(null)
  assert.equal(r.source, 'fallback')
  assert.equal(r.version, 'bundled')
  assert.equal(r.text, BGOS_CAPABILITIES_FALLBACK)
})

test('falls back when the response is missing the markers', () => {
  const r = pickCapabilities({ text: 'some unrelated body', version: '9' })
  assert.equal(r.source, 'fallback')
  assert.equal(r.text, BGOS_CAPABILITIES_FALLBACK)
})

test('falls back when text is not a string', () => {
  const r = pickCapabilities({ text: 123 })
  assert.equal(r.source, 'fallback')
})

test('the bundled fallback itself carries the markers (so injection guards match)', () => {
  assert.ok(BGOS_CAPABILITIES_FALLBACK.includes('BGOS Channel'))
  assert.ok(BGOS_CAPABILITIES_FALLBACK.includes('Agent Capabilities'))
})
