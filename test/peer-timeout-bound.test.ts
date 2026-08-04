/**
 * send_to_peer's advertised timeout bound must match what the server accepts.
 *
 * 2026-08-04 (Ava, 871): the tool description advertised waits up to 600s
 * while the backend rejects anything over 50 with a 400 (its edge closes idle
 * connections at 60s; backend/src/dto/peer.dto.ts pins the cap). An agent
 * following the description got its whole send rejected. The fix is twofold
 * and this suite pins both halves:
 *   1. the description tells the truth (50s cap, poll for longer), and
 *   2. the handler CLAMPS an over-cap value instead of forwarding it, so a
 *      caller passing yesterday's 600 gets a 50s wait, not a 400.
 *
 * Source-contract style (reads server.ts) because the handler is not
 * exported; if the clamp or the description drifts, this goes red naming it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')

describe('send_to_peer timeout bound', () => {
  test('the description no longer advertises 600s anywhere near wait_for_reply', () => {
    const waitRegion = source.slice(
      source.indexOf("wait_for_reply: { type: 'boolean'"),
      source.indexOf("turn_state: {"),
    )
    expect(waitRegion.length).toBeGreaterThan(0)
    expect(waitRegion).not.toContain('600')
    expect(waitRegion).toContain('50')
  })

  test('the handler clamps timeout_seconds to the 50s server cap', () => {
    expect(source).toContain('PEER_WAIT_CAP_SECONDS = 50')
    expect(source).toMatch(/Math\.min\(rawTimeout, PEER_WAIT_CAP_SECONDS\)/)
  })

  test('an omitted timeout stays omitted (the server default 45 applies)', () => {
    expect(source).toMatch(/rawTimeout === undefined \? undefined :/)
  })
})
