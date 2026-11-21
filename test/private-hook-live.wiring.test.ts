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
  // `turn`, then the counting only peer (0.90.21), then the end of the call.
  assert.match(publish, /turn,\n(\s*\/\/.*\n)?\s*peerAssistantId: turn \? null : privateTurns\.peerTurn\(\)\?\.sourceAssistantId \?\? null,\n\s*\}\)/)
  assert.doesNotMatch(publish, /privateTurns\.current\([^)]*\)[\s\S]*privateTurns\.current\(/, 'one read, the same turn for both')
})

// The browser shim counts a refusal only when the daemon's SIGNED context names the peer, so
// the daemon must name it while a peer turn has no verified sender, and never while a turn is open. The function
// itself, sliced from server.ts and run: it fails if the daemon stops naming the peer, names one beside a turn, or
// names anything but the tracker's peer.
test('the daemon names the peer in the signed browser context only while a peer turn has no verified sender', async () => {
  const ts = (await import('typescript')).default
  const start = server.indexOf('function publishBrowserPrivateTurn(): void {')
  const body = server.slice(start, server.indexOf('\n}\n', start) + 2)
  const js = ts.transpileModule(body + '\npublishBrowserPrivateTurn();', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const run = (turn: unknown, peer: { sourceAssistantId: string } | null) => {
    const published: Array<Record<string, unknown>> = []
    const bindings = {
      lockHeld: true, PRIVATE_MARKER_PATHS: [], FLOOR_STATE_ROOT: '/state', ASSISTANT_ID: '1050', USER_ID: 'user_owner',
      AUTH: { mode: 'pairing', pairingToken: 'fixture' }, agentClaudePid: () => 4242,
      privateTurns: { current: () => turn, peerTurn: () => peer }, privateHook: { noteTurn: () => {} },
      privateContextPath: () => '/state/1050/context.json',
      publishPrivateContext: (input: Record<string, unknown>) => { published.push(input) },
    }
    new Function(...Object.keys(bindings), js)(...Object.values(bindings))
    assert.equal(published.length, 1)
    return published[0]
  }
  assert.equal(run(null, { sourceAssistantId: '888' }).peerAssistantId, '888', 'a peer turn with no verified sender names the peer')
  assert.equal(run({ turnId: 't1', actingUserId: 'user_owner' }, { sourceAssistantId: '888' }).peerAssistantId, null, 'never beside an open turn')
  assert.equal(run(null, null).peerAssistantId, null, 'no peer turn, no peer')
})

test('the hold and the refusal wording read PRIVATE_HOOK at the moment of use, never the boot read', () => {
  assert.match(server, /enabled: \(\) => QUIET_TURN_ENABLED && serverQuiet\.on\(\) && lockHeld && PRIVATE_HOOK\.registered,/)
  assert.equal((server.match(/!PRIVATE_HOOK\.registered && lockHeld/g) ?? []).length, 2)
  const uses = [...server.matchAll(/PRIVATE_HOOK_AT_BOOT/g)].length
  assert.equal(uses, 2, 'declared, and handed to the liveness: nothing else reads the boot read')
})
