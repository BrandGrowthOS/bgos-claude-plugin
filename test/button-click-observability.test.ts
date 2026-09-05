import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * A tap of the owner's reached his agent ~5.5 minutes after the backend
 * stamped it (2026-09-05), and nobody could tell whether the click was
 * delivered late or delivered on time and queued behind a busy turn.
 * `applyStreamButtonsAnswered` had THREE unlogged early returns and
 * ws-delivered inbound was never logged at all, so "late" and "lost"
 * produced identical evidence: none.
 *
 * These pins keep every exit from that function observable. NOTE the source
 * is read with line endings normalised: this repo's checkout is CRLF on
 * Windows and a source scan matching a literal "\n" silently finds nothing,
 * which is how a guard becomes unable to see the thing it guards.
 */
const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function applyStreamButtonsAnsweredBody(): string {
  const start = SRC.indexOf('function applyStreamButtonsAnswered(')
  expect(start).toBeGreaterThan(0)
  const next = SRC.indexOf('\nasync function applyStreamMessage(', start)
  expect(next).toBeGreaterThan(start)
  return SRC.slice(start, next)
}

describe('button_clicked observability', () => {
  test('applyStreamButtonsAnswered has NO bare early return: every exit says why', () => {
    const body = applyStreamButtonsAnsweredBody()
    // A bare `return` on its own line with nothing logged above it in the same
    // block is the shape that made this bug undiagnosable.
    const bare = body.match(/^\s*if \([^)]*\) return$/gm) ?? []
    expect(bare).toEqual([])
  })

  test('each of the three drop paths logs a distinct reason', () => {
    const body = applyStreamButtonsAnsweredBody()
    expect(body).toContain('button_clicked DROPPED at view')
    expect(body).toContain('button_clicked DROPPED at payload')
    expect(body).toContain('button_clicked SKIPPED')
  })

  test('receipt is stamped and stream authority is recorded, not assumed', () => {
    const body = applyStreamButtonsAnsweredBody()
    expect(body).toContain('const receivedAtMs = Date.now()')
    expect(body).toContain('const authorityAtReceipt = streamAuthority !== null')
    // Authority must appear on EVERY outcome line, not merely often enough:
    // a click lost while the stream was NOT authoritative is a different bug
    // from one lost while it was. Counting to a threshold let a removed stamp
    // pass (watched green under mutation 2026-09-05), so tie the two counts.
    const outcomes = body.match(/button_clicked (DROPPED|SKIPPED|RECEIVED)/g) ?? []
    const stamps = body.match(/streamAuthority=\$\{authorityAtReceipt\}/g) ?? []
    expect(outcomes.length).toBeGreaterThan(0)
    expect(stamps.length).toBe(outcomes.length)
  })

  test('a delivered click reports how long it spent inside the daemon', () => {
    const body = applyStreamButtonsAnsweredBody()
    expect(body).toContain('button_clicked RECEIVED on the stream')
    expect(body).toContain('handed to transport')
    expect(body).toContain('Date.now() - receivedAtMs')
  })
})
