/**
 * A nightly update asks to be restarted (KC, 2026-09-26).
 *
 * His words: "our auto update of the plugin is working but the restart is
 * still manual ... the watchers will receive a command to restart and it
 * restarts every single agent automatically".
 *
 * MEASURED BEFORE THE FIX: 20 of 59 live claude-code daemons were running
 * older code than they already held on disk. 29 of them sit under the hoai
 * launcher, which ALREADY restarts an agent when it sees the marker. The
 * launcher was never the problem; nothing ever wrote the marker for a
 * scheduled update, because the restart ladder was reachable only from a
 * TRIGGERED (clicked) update.
 *
 * WHAT MUST NOT REGRESS. On 2026-08-06 a daemon exited after updating on the
 * ASSUMPTION a supervisor existed, and five of seven agents on one machine
 * went silent overnight. So 'exit' stays behind the operator's explicit opt
 * in, and the new 'ladder' answer never exits: it asks an authority that has
 * to prove it owns this process, and that ladder stages when it cannot.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { decideScheduledRestart, shouldExitAfterUpdate } from '../lib/self-update.js'

describe('a nightly update asks to be restarted', () => {
test('a nightly update asks the ladder when one is wired in', () => {
  expect(decideScheduledRestart({ exitOptIn: false, canAskLadder: true })).toBe('ladder')
})

test('THE DEFECT: it does not just sit there when a ladder exists', () => {
  // Before this fix the answer was always 'stay' with the opt in unset, which
  // is what left 20 of 59 agents running code they had already replaced.
  expect(decideScheduledRestart({ exitOptIn: false, canAskLadder: true })).not.toBe('stay')
})

test('with no ladder wired in it stays exactly as before', () => {
  expect(decideScheduledRestart({ exitOptIn: false, canAskLadder: false })).toBe('stay')
})

test('the operator opt in still wins, and still means exit', () => {
  // The 2026-08-06 behaviour, unchanged for a host that chose it.
  expect(decideScheduledRestart({ exitOptIn: true, canAskLadder: true })).toBe('exit')
  expect(decideScheduledRestart({ exitOptIn: true, canAskLadder: false })).toBe('exit')
})

test('the opt in still fails closed on anything not explicitly truthy', () => {
  // The control: this is the gate that decides 'exit', so a typo must not
  // become an exit on a host with nothing to restart it.
  for (const value of ['', 'maybe', '0', 'false', 'off', undefined]) {
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: value })).toBe(false)
  }
  for (const value of ['1', 'true', 'on', 'yes', 'TRUE']) {
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: value })).toBe(true)
  }
})

test('the nightly update is actually WIRED to the ladder, not just able to be', () => {
  // The decision above is pure, so it cannot see a server that never passes
  // requestRestart. That is the whole defect being fixed: the ladder existed
  // and nothing scheduled ever called it. So read the wiring and assert on it.
  const server = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')
  expect(server).toContain('requestRestart:')
  expect(server).toContain('restartAfterScheduledUpdate')
})

test('the scheduled restart reuses the ladder rather than reimplementing it', () => {
  // A second implementation would be a second place to forget the ownership
  // pre-flight (9 daemons muted, 2026-09-11) and the never-exit rule (5 agents
  // dead, 2026-08-06). One ladder, one set of safeties.
  const rpc = readFileSync(join(import.meta.dir, '..', 'lib', 'update-rpc.ts'), 'utf8')
  const entry = rpc.slice(rpc.indexOf('async restartAfterScheduledUpdate'))
  const body = entry.slice(0, entry.indexOf('\n  }'))
  expect(body).toContain('this.restartLadder(')
  // It must not grow its own authority handling.
  expect(body).not.toContain('signalProcess')
  expect(body).not.toContain('writeMarker')
})
})
