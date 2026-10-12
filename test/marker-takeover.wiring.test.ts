/**
 * The source contract for the restart-marker takeover's wiring in server.ts
 * (lib/marker-takeover.mjs has the rules; this pins how the daemon hands them
 * its facts). The wiring is a handful of lines in main(), so its mistakes are
 * the expensive kind: a takeover started off Windows, by a passive daemon, on
 * the wrong clock, or a helper that dies with claude or flashes a console.
 *
 * Run: npx tsx --test test/marker-takeover.wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const NO_WIRING = 'server.ts never starts the restart-marker takeover: a marker the hoai launcher refuses (bin/hoai-core.mjs:2295-2299) is never acted on'

/** The takeover block in main(), from its declaration to markerTakeover.start(). */
function block(): string {
  const at = server.indexOf('createMarkerTakeover({')
  assert.ok(at >= 0, NO_WIRING)
  const from = server.lastIndexOf('let markerTakeover', at)
  const to = server.indexOf('markerTakeover.start()', at)
  assert.ok(from >= 0 && to > at, NO_WIRING)
  return server.slice(from, to + 'markerTakeover.start()'.length)
}

test('the takeover starts only on Windows, and HOAI_MARKER_TAKEOVER=off turns it off', () => {
  const b = block()
  assert.match(b, /if \(process\.platform === 'win32' && String\(process\.env\.HOAI_MARKER_TAKEOVER \?\? ''\)\.trim\(\)\.toLowerCase\(\) !== 'off'\)/)
})

test('only the active daemon (the pairing lock holder, not shutting down) may act, on the daemon\'s own start clock', () => {
  const b = block()
  assert.match(b, /active: \(\) => lockHeld && !shuttingDown/)
  assert.match(b, /bootAtMs: DAEMON_START_MS/)
  assert.match(b, /claudePid: \(\) => agentClaudePid\(\)/)
  assert.match(b, /ownPid: process\.pid/)
})

test('the helper is spawned detached, hidden, with stdio ignored, a scrubbed env, and from this running version', () => {
  const b = block()
  assert.match(b, /detached: true/)
  assert.match(b, /stdio: 'ignore'/)
  assert.match(b, /windowsHide: true/)
  assert.match(b, /helperEnv: \(\) =>\s*handoffEnv\(process\.env,/)
  assert.match(b, /pathJoin\(RUNNING_ROOT, 'bin', 'hoai-restart-handoff\.mjs'\)/)
  assert.match(b, /\.unref\(\)/)
})

test('the relaunch uses the installed root (currentPluginRootFor), the daemon\'s own state and lock paths', () => {
  const b = block()
  assert.match(b, /pluginRoot: currentPluginRootFor\(/)
  assert.match(b, /credentialsPath: CREDENTIALS_PATH/)
  assert.match(b, /pluginStateDir: pathDirname\(CURSOR_FILE_PATH\)/)
})

test('shutdown stops the takeover', () => {
  const at = server.indexOf('const shutdown = (cause')
  assert.ok(at >= 0)
  const end = server.indexOf('process.exit(code)', at)
  assert.match(server.slice(at, end), /markerTakeover\?\.stop\(\)/, NO_WIRING)
})

test('bin/hoai-restart-handoff.mjs exists and runs runRestartHandoff', () => {
  const url = new URL('../bin/hoai-restart-handoff.mjs', import.meta.url)
  assert.ok(existsSync(url), 'the helper the daemon spawns is missing')
  assert.match(readFileSync(url, 'utf8'), /runRestartHandoff\(params,/)
})
