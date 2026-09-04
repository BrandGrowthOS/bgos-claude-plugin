import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The repo idiom for a source scan: an import.meta.url URL resolves identically
// under bun and under the tsx runner the canonical `npm test` orchestrator uses,
// where import.meta.dir does not exist.
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('losing the pairing lock stands the daemon down, it does not merely warn', () => {
  // The detailed form must be what the poll tick calls: the boolean form
  // cannot name the rival holder.
  assert.match(server, /refreshPairingLockDetailed\(/)
  // There must be a real consequence, not only a log line.
  assert.match(server, /channelArmed\s*=\s*false/)
  // And the daemon must be able to come back if the rival dies.
  assert.match(server, /lockRecheck|resumeLockRecheck/)
})

test('the poll tick refuses to forward while not armed', () => {
  assert.match(server, /if\s*\(\s*!channelArmed\s*\)/)
})
