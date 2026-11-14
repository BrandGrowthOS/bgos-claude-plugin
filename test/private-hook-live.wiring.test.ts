import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// QUIETTURN4: in a running daemon, PRIVATE_HOOK.registered is the private turn hook's LIVENESS (the boot read, or
// the hook's own marker read for a turn since), not the boot read alone. Everything that decides on it reads it at
// the moment of use: the quiet turn hold's switch and the refusal wording. The boot read keeps its own name for the
// boot. The behaviour is in test/quiet-turn-threats.test.ts (QUIETTURN4) and test/private-hook-live.test.ts.

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('PRIVATE_HOOK is the liveness view over the boot read, not the boot read itself', () => {
  assert.match(server, /const PRIVATE_HOOK_AT_BOOT: PrivateHookPresence = \(\(\) => \{\n\s*try \{\n\s*return privateHookPresence\(\{/)
  assert.match(server, /const privateHook = createPrivateHookLiveness\(\{ atBoot: PRIVATE_HOOK_AT_BOOT, log \}\)\nconst PRIVATE_HOOK: PrivateHookPresence = privateHook\.presence\n/)
  assert.equal((server.match(/const PRIVATE_HOOK\b/g) ?? []).length, 1)
})

test('every marker read the daemon makes feeds the liveness, with the same turn it publishes', () => {
  const publish = server.slice(server.indexOf('function publishBrowserPrivateTurn(): void {'), server.indexOf('let hookTurn: TurnState = emptyTurn()'))
  assert.match(publish, /const turn = privateTurns\.current\(\{ markerPaths: PRIVATE_MARKER_PATHS \}\)\n(\s*\/\/.*\n)?\s*privateHook\.noteTurn\(turn\)/)
  assert.match(publish, /turn,\n\s*\}\)/)
  assert.doesNotMatch(publish, /privateTurns\.current\([^)]*\)[\s\S]*privateTurns\.current\(/, 'one read, the same turn for both')
})

test('the hold and the refusal wording read PRIVATE_HOOK at the moment of use, never the boot read', () => {
  assert.match(server, /enabled: \(\) => QUIET_TURN_ENABLED && serverQuiet\.on\(\) && lockHeld && PRIVATE_HOOK\.registered,/)
  assert.equal((server.match(/!PRIVATE_HOOK\.registered && lockHeld/g) ?? []).length, 2)
  const uses = [...server.matchAll(/PRIVATE_HOOK_AT_BOOT/g)].length
  assert.equal(uses, 2, 'declared, and handed to the liveness: nothing else reads the boot read')
})
