/**
 * The source contract for the hook restart's wiring in server.ts
 * (lib/hook-restart.mjs has the rules; this pins which facts the daemon hands
 * them). Its mistakes are the expensive kind: outcomes collected on a plain
 * fresh start (the 2026-10-12 restart loop), a passive daemon asking, a clock
 * that is not the daemon's own, or a second ladder beside the one every other
 * restart walks.
 *
 * Run: npx tsx --test test/hook-restart.wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const NO_WIRING =
  'server.ts never asks for a restart after it registered the private turn hook at boot: ' +
  'it only logs "restart this agent to load them" (server.ts:14783 at main), so every private call refuses until a person restarts the agent'

/** The boot registration, from its call to the outcomes it hands the restart. */
function registration(): string {
  const at = server.indexOf('const bootHooks = registerCloneHooksAtBoot({')
  assert.ok(at >= 0, 'the boot registration call moved')
  const end = server.indexOf('const hookOutcomes: string[] = bootHooks.restartOutcomes', at)
  assert.ok(end > at, 'the restart outcomes no longer come from the boot registration')
  return server.slice(at, end + 'const hookOutcomes: string[] = bootHooks.restartOutcomes'.length)
}

/** The hook restart block in main(), from its state folder to hookRestart.start(). */
function block(): string {
  const at = server.indexOf('createHookRestart({')
  assert.ok(at >= 0, NO_WIRING)
  const from = server.lastIndexOf('const hookRestartDir = agentStateDir(homedir(), ASSISTANT_ID)', at)
  const to = server.indexOf('hookRestart.start()', at)
  assert.ok(from >= 0 && to > at, NO_WIRING)
  return server.slice(from, to + 'hookRestart.start()'.length)
}

test('the boot registration hands on its outcomes only when the hook was NOT registered, never on a marketplace install', () => {
  assert.ok(server.includes('createHookRestart({'), NO_WIRING)
  const r = registration()
  // The decision itself is lib/clone-hooks.mjs registerCloneHooksAtBoot (test/clone-hooks.boot.test.ts runs it):
  // restartOutcomes is empty when the private turn hook was found, and there is nothing at all on a marketplace install.
  assert.match(r, /installMethod: INSTALL_METHOD,/)
  assert.match(r, /privateHookRegistered: PRIVATE_HOOK\.registered,/)
  assert.equal(server.split('const hookOutcomes').length - 1, 1, 'nothing else declares the outcomes')
  assert.equal(server.split('hookOutcomes.push(').length - 1, 0, 'nothing else adds an outcome')
})

test('ONE restart through the daemon\'s own ladder, asked by the pairing lock holder only, on the daemon\'s own clock', () => {
  const b = block()
  assert.match(b, /outcomes: hookOutcomes,/)
  assert.match(b, /recordPath: pathJoin\(hookRestartDir, HOOK_RESTART_FILE_NAME\)/)
  assert.match(b, /active: \(\) => lockHeld && !shuttingDown/)
  assert.match(b, /bootAtMs: DAEMON_START_MS/)
  assert.match(b, /draining: \(\) => updateDrainMode/)
  assert.match(b, /drain: setUpdateDrainMode/)
  assert.match(b, /requestRestart: \(\) => updateRpc\.restartAfterHookRegistration\(\)/)
  assert.match(b, /fs: nodeHookRestartFs\(\)/)
})

test('it waits for the safe moment the watcher waits for: the facts agent-state.json publishes, claude\'s process tree, and no update in flight', () => {
  const b = block()
  assert.match(b, /turnInFlight: hookTurnLive \|\| hookTurn\.carried\.size > 0/)
  assert.match(b, /turnSignal: hookTurnSignal\(\{ lastEventAtMs: lastHookEventAtMs, endedSessionId: hookEndedSessionId \}\)/)
  assert.match(b, /\.\.\.updateDrainSnapshot\(\)/)
  assert.match(b, /activityMs: \(\) => \[DAEMON_START_MS, lastInboundAtMs, lastHookEventAtMs, agentTranscript\(\)\.activityMs\]/)
  assert.match(b, /claudePid: \(\) => agentClaudePid\(\)/)
  assert.match(b, /listProcesses\(\{ platform: process\.platform, exec: nodeExec\(\), env: process\.env \}\)/)
  assert.match(b, /updateLockHeld: \(\) =>\s*INSTALL_METHOD !== 'marketplace' && isUpdateLockHeld\(joinPath\(import\.meta\.dir, '\.git', AUTO_UPDATE_LOCK_FILE\)\)/)
})

test('it runs on every platform: the block sits at the top level of main(), outside the Windows takeover gate', () => {
  block()
  assert.match(server, /\n  const hookRestartDir = agentStateDir\(homedir\(\), ASSISTANT_ID\)\n  if \(hookRestartDir\) \{\n    const hookRestart = createHookRestart\(\{/)
})

test('the shutdown path never names the hook restart: it is inert once shutdown begins (active)', () => {
  const at = server.indexOf('const shutdown = (cause')
  assert.ok(at >= 0)
  const end = server.indexOf('process.exit(code)', at)
  assert.doesNotMatch(server.slice(at, end), /hookRestart/, 'test/stand-down-sites.test.ts runs this site in a sandbox that names only the daemon state it needs')
})
