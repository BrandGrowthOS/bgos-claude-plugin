/**
 * Guards the always-on reconcile against the unbounded-retry defect found on
 * a Windows host 2026-08-09: bin/bgos-agent was absent (install never shipped
 * it), so every reconcile cycle retried an install that can never succeed.
 * One daemon logged 9,852 identical failures in 2.5 days, burying the single
 * actionable line (repair the plugin install) in noise.
 *
 * The contract: a missing supervisor binary is a host-layout fact, not a
 * transient. The reconcile must check the binary exists BEFORE any spawn,
 * log the repair instruction ONCE, latch itself off for the session, and
 * never attempt again until restart.
 *
 * Source-scan style (the reconcile is server.ts-inline, matching
 * agent-credentials.test.ts precedent).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

const reconcileBody = (() => {
  const start = serverSource.indexOf('async function reconcileAlwaysOn(')
  expect(start).toBeGreaterThan(-1)
  const end = serverSource.indexOf('\n// ── Startup', start)
  return serverSource.slice(start, end === -1 ? undefined : end)
})()

describe('always-on reconcile with a missing supervisor binary', () => {
  it('checks the binary exists before any spawn attempt', () => {
    const existsAt = reconcileBody.indexOf('existsSync(BGOS_AGENT_BIN)')
    const firstSpawnAt = reconcileBody.indexOf('execFileAsync(')
    expect(existsAt).toBeGreaterThan(-1)
    expect(firstSpawnAt).toBeGreaterThan(-1)
    expect(existsAt).toBeLessThan(firstSpawnAt)
  })

  it('latches off for the session instead of retrying forever', () => {
    // The latch variable exists, is consulted on entry, and is set when the
    // binary is missing. Removing any leg reopens the 9,852-retry loop.
    expect(serverSource).toContain('let reconcileDisabledReason')
    expect(reconcileBody).toMatch(/if \(reconcileDisabledReason\) return/)
    expect(reconcileBody).toMatch(/reconcileDisabledReason = /)
  })

  it('on win32 stands down before any spawn and names the truth', () => {
    // Windows cannot exec a shebang script and the supervisor script has no
    // Windows implementation behind it (launchd + systemd only). The branch
    // must come BEFORE the existence check: the file EXISTS on Windows
    // checkouts, so an existence latch alone never fires there and the
    // retry storm continues (Mark's correction, 2026-08-09).
    const winAt = reconcileBody.indexOf("process.platform === 'win32'")
    const existsAt = reconcileBody.indexOf('existsSync(BGOS_AGENT_BIN)')
    expect(winAt).toBeGreaterThan(-1)
    expect(winAt).toBeLessThan(existsAt)
    expect(reconcileBody).toContain('restart-survival is NOT active')
    expect(reconcileBody).toContain('unfulfilled')
  })

  it('tells the operator how to repair, in the one log line it emits', () => {
    expect(reconcileBody).toContain('re-run the installer or restore bin/bgos-agent')
    expect(reconcileBody).toContain('logged once')
  })
})
