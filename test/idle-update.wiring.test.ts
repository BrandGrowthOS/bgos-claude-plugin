/**
 * The source contract for the idle update's wiring in server.ts
 * (lib/idle-update.mjs has the rules and the controller, lib/idle-update-host.mjs
 * the readings; this pins which facts the daemon hands them). Its mistakes are
 * the expensive kind: a second restart path beside the ladder (the 2026-09-11
 * forced update left 9 agents deaf), a passive daemon acting, a busy fact that
 * is never stamped and so reads as idle, or a version latched bad that the
 * heartbeat still reports as pending.
 *
 * Run: npx tsx --test test/idle-update.wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const NO_WIRING =
  'server.ts never arms the idle update: a staged build loads only when the session restarts, and nothing restarts ' +
  'an idle agent, so Alex\'s 15 agents ran 0.69.12 to 0.74.0 with 0.74.3 staged'

/** The controller's wiring, from its function to idleUpdate.start(). */
function block(): string {
  const at = server.indexOf('function armIdleUpdate(): void {')
  assert.ok(at >= 0, NO_WIRING)
  const end = server.indexOf('idleUpdate.start()', at)
  assert.ok(end > at, NO_WIRING)
  return server.slice(at, end + 'idleUpdate.start()'.length)
}

/** The first arm of delivery, from its latch to the end of the heartbeat step. */
function firstArm(): string {
  const at = server.indexOf('    deliveryLoopsStarted = true\n')
  assert.ok(at >= 0, 'the first arm latch moved')
  const end = server.indexOf('startAuthRecheck()', at)
  assert.ok(end > at, 'the auth recheck step moved')
  return server.slice(at, end)
}

/** The two places this daemon takes the pairing lock: at boot, and on promotion from passive. */
function lockSites(): string[] {
  const boot = server.indexOf('  if (lockAtBoot.acquired) {')
  assert.ok(boot >= 0, 'the boot lock site moved')
  const promotion = server.indexOf('        if (!res.acquired) return\n')
  assert.ok(promotion >= 0, 'the promotion lock site moved')
  return [
    server.slice(boot, server.indexOf('await armDelivery()', boot) + 'await armDelivery()'.length),
    server.slice(promotion, server.indexOf('void armDelivery()', promotion) + 'void armDelivery()'.length),
  ]
}

test('armed the moment this daemon holds the pairing lock, at boot and on promotion, before the arm of delivery that can hang', () => {
  block()
  assert.equal(server.match(/^\s+armIdleUpdate\(\)$/gm)?.length ?? 0, 2, 'one caller per lock acquisition, none after startup complete')
  for (const site of lockSites()) {
    const held = site.indexOf('lockHeld = true')
    const arm = site.indexOf('armIdleUpdate()')
    assert.ok(held >= 0 && arm > held, 'armed after the lock is held')
    assert.ok(site.indexOf('armDelivery()') > arm, 'armed before the arm of delivery, so a startup that hangs still meets its deadline')
  }
  assert.match(block(), /if \(idleUpdate\) return/)
})

test('an API key session never arms it: the heartbeat that validates a new build is a pairing one', () => {
  const b = block()
  const guard = b.indexOf("if (AUTH.mode !== 'pairing') {")
  assert.ok(guard >= 0 && guard < b.indexOf('idleUpdate = createIdleUpdate('), 'the auth mode is checked before the controller exists')
  assert.match(b.slice(guard, b.indexOf('idleUpdate = createIdleUpdate(')), /log\('idle update: off: /)
})

test('it acts only as the pairing lock holder, never once shutdown has begun, on the daemon\'s own clock and boot', () => {
  const b = block()
  assert.match(b, /active: \(\) => lockHeld && !shuttingDown,/)
  assert.match(b, /bootAtMs: DAEMON_START_MS,/)
  assert.match(b, /now: Date\.now,/)
  assert.match(b, /ownPid: process\.pid,/)
  assert.match(b, /runningVersion: RUNNING_VERSION,/)
  assert.match(b, /installMethod: INSTALL_METHOD,/)
  assert.match(b, /fromRoot: RUNNING_ROOT,/)
  assert.match(b, /fromCommit: selfUpdater\?\.runningCommitId \?\? null,/)
  assert.match(b, /autoUpdateEnabled: \(\) => isAutoUpdateEnabled\(process\.env\.BGOS_AUTO_UPDATE\),/)
  assert.match(b, /durations: IDLE_UPDATE_DURATIONS,/)
  assert.match(server, /const IDLE_UPDATE_DURATIONS = scaledDurations\(scaleFromEnv\(process\.env\.BGOS_IDLE_UPDATE_SCALE, \{ backendUrl: BACKEND_URL \}\)\)/)
  assert.ok(server.indexOf('const BACKEND_URL = ') < server.indexOf('const IDLE_UPDATE_DURATIONS = '), 'the backend is known before the scale is read')
})

test('the restart is the daemon\'s own ladder, through its two idle entry points, and nothing else', () => {
  const b = block()
  assert.match(b, /restart: \(target: string, proof: OwnLauncherProof \| null\) => updateRpc\.restartForStagedUpdate\(target, proof\),/)
  assert.match(b, /restartRollback: \(from: string, proof: OwnLauncherProof \| null\) => updateRpc\.restartForRollback\(from, proof\),/)
  assert.match(b, /drain: setUpdateDrainMode,/)
  assert.match(b, /draining: \(\) => updateDrainMode,/)
  for (const forbidden of [/process\.exit/, /kickstart/, /restartAgent/, /--continue/, /spawnProcess/, /process\.kill/]) {
    assert.doesNotMatch(b, forbidden, `the idle update block must not ${forbidden}`)
  }
})

test('the safe moment is the one the watcher and the hook restart wait for, plus the asks, the goal, a call and the browser', () => {
  const b = block()
  assert.match(b, /turnInFlight: hookTurnLive \|\| hookTurn\.carried\.size > 0,/)
  assert.match(b, /turnSignal: hookTurnSignal\(\{ lastEventAtMs: lastHookEventAtMs, endedSessionId: hookEndedSessionId \}\),/)
  assert.match(b, /\.\.\.updateDrainSnapshot\(\),/)
  assert.match(b, /activityMs: \(\) => \[DAEMON_START_MS, lastInboundAtMs, lastHookEventAtMs, agentTranscript\(\)\.activityMs\],/)
  assert.match(b, /openAsks: \(\) => idleOpenAsks\(Date\.now\(\)\),/)
  assert.match(server, /return asksWaiting \+ openPlansByChat\.size \+ askTracker\.pending\(\)\.filter\(\(ask\) => now - ask\.postedAt < IDLE_ASK_FRESH_MS\)\.length/)
  assert.match(b, /goalLane\.condition !== null && !goalLane\.closed/)
  assert.match(b, /goalPendingArm !== null/)
  assert.match(b, /goalInjectionsInFlight > 0/)
  assert.match(b, /goalSelfClears > 0/)
  assert.match(b, /pendingConsults: voiceRpc\.pendingConsultCount,/)
  assert.match(b, /openContinuations: voiceRpc\.openContinuationCount,/)
  assert.match(b, /openMeetings: meetingContexts\.size,/)
  assert.match(b, /lastVoiceAtMs: lastVoiceFrameAtMs,/)
  assert.match(b, /lastBrowserToolAtMs: \(\) => lastBrowserToolAtMs,/)
  assert.match(b, /claudePid: \(\) => agentClaudePid\(\),/)
  assert.match(b, /listProcesses\(\{ platform: process\.platform, exec: nodeExec\(\), env: process\.env \}\)/)
  assert.match(b, /updateLockHeld: \(\) =>\s*INSTALL_METHOD !== 'marketplace' && isUpdateLockHeld\(joinPath\(import\.meta\.dir, '\.git', AUTO_UPDATE_LOCK_FILE\)\),/)
})

test('every busy fact is stamped where it happens, or it reads as idle', () => {
  const voice = server.indexOf('voiceRpc.handle(frame)')
  assert.ok(voice >= 0)
  assert.ok(server.lastIndexOf('lastVoiceFrameAtMs = Date.now()', voice) > voice - 400, 'a voice frame stamps lastVoiceFrameAtMs as it arrives')
  const hook = server.indexOf('function onHookPayload(')
  const hookEnd = server.indexOf('\n}\n', hook)
  const hookBody = server.slice(hook, hookEnd)
  assert.match(hookBody, /\(event\.name === 'PreToolUse' \|\| event\.name === 'PostToolUse'\) && \/hoai-browser__\/\.test\(String\(payload\.tool_name \?\? ''\)\)/)
  assert.match(hookBody, /lastBrowserToolAtMs = Date\.now\(\)/)
  // Only a beacon written where the supervisor watches proves delivery live: a write that failed stamps nothing.
  assert.match(server, /const beaconWritten = touchBeaconHeartbeat\(\{\n\s+path: BEACON_HEARTBEAT_PATH,\n\s+now: hbNow,\n\s+pid: process\.pid,\n\s+\}\)\n(?:\s+\/\/.*\n)*\s+if \(beaconWritten\) beaconTouchedAtMs = hbNow\n/)
  assert.doesNotMatch(server, /\}\)\n\s+beaconTouchedAtMs = hbNow/)
  assert.match(server, /startupCompleteAtMs = Date\.now\(\)\n\s+log\('startup complete: polling armed, message delivery is live'\)/)
})

test('the new build validates on live evidence: startup, a heartbeat that landed, the beacon, no deaf verdict, the login', () => {
  const b = block()
  assert.match(b, /startupComplete: \(\) => startupCompleteAtMs !== null,/)
  assert.match(b, /heartbeatOkAtMs: \(\) => heartbeatOkAtMs,/)
  assert.match(b, /beaconAtMs: \(\) => beaconTouchedAtMs,/)
  assert.match(b, /deaf: \(\) => currentUnresponsiveError\(Date\.now\(\)\) !== null,/)
  assert.match(b, /loginExpired: \(\) => currentAccountError\(Date\.now\(\)\) !== null,/)
  assert.match(b, /requestHeartbeat: \(\) => versionHeartbeat\?\.sendNow\(\),/)
  // Only a POST that resolved stamps it (bgosCall throws on a refusal), and only a beat that carried this build's
  // version: a status-only beat says nothing about which build reached the backend.
  const post = server.indexOf('post: async (path: string, body: Record<string, unknown>) => {')
  assert.ok(post >= 0, 'the heartbeat post moved')
  const wrapper = server.slice(post, server.indexOf('\n      },\n', post))
  assert.match(wrapper, /const result = await bgosPost\(path, body\)/)
  assert.match(wrapper, /if \(body\.daemonVersion === RUNNING_VERSION\) heartbeatOkAtMs = Date\.now\(\)/)
  assert.doesNotMatch(wrapper, /if \(path === 'integrations\/heartbeat'\) heartbeatOkAtMs = Date\.now\(\)/)
  assert.match(b, /monotonicNow: \(\) => performance\.now\(\),/)
})

test('backend reach is read off every backend call, not the heartbeat alone, so an outage during a slow startup holds the deadline too', () => {
  const at = server.indexOf('function bgosCall<T>(')
  assert.ok(at >= 0, 'bgosCall moved')
  const call = server.slice(at, server.indexOf('\n}\n', at))
  assert.match(call, /const backend = isBackendUrl\(call\.url\)/)
  assert.match(call, /if \(backend\) noteBackendReach\(response\.status\)/)
  assert.match(call, /if \(backend && !answered\) noteBackendReach\(null\)/)
  // An S3 presigned upload is not the backend: it neither proves the backend reached nor down.
  const isBackend = server.indexOf('function isBackendUrl(url: string): boolean {')
  assert.ok(isBackend >= 0, 'isBackendUrl is missing')
  assert.match(server.slice(isBackend, server.indexOf('\n}\n', isBackend)), /return url === API_BASE \|\| url\.startsWith\(`\$\{API_BASE\}\/`\)/)
  const note = server.indexOf('function noteBackendReach(status: number | null): void {')
  assert.ok(note >= 0, 'noteBackendReach is missing')
  const body = server.slice(note, server.indexOf('\n}\n', note))
  assert.match(body, /if \(isBackendAnswer\(status\)\) backendUnreachableSinceMs = null/)
  assert.match(body, /else backendUnreachableSinceMs \?\?= Date\.now\(\)/)
  assert.match(block(), /backendUnreachable: \(\) => backendUnreachableSinceMs !== null,/)
  assert.doesNotMatch(server, /heartbeatUnreachableSinceMs|isBackendUnreachableError/)
})

test('an owning systemd unit\'s cgroup is read through the host module, for the authority the restart goes through', () => {
  const b = block()
  assert.match(b, /serviceStrays: \(processes: any\[\] \| null, claudePid: number \| null\) => \{/)
  assert.match(b, /readServiceStrays\(\{\n?\s*service: authority\.kind === 'service' \? authority\.service : null,/)
  assert.match(b, /runShPath: inputs\.runShPath,/)
  assert.match(b, /sockets: inputs\.ownSockets,/)
})

test('the report is a fourth lastError producer, after the credential, the login and the deaf verdict', () => {
  assert.match(server, /currentUnresponsiveError\(now\),\n\s+\) \?\? idleUpdateError/)
  const b = block()
  assert.match(b, /report: \(err: \{ code: string; message: string; at: string \} \| null\) => \{\n\s+idleUpdateError = err\n\s+versionHeartbeat\?\.sendNow\(\)/)
})

test('a version latched bad here is no pending restart for the heartbeat, a click or the watcher; the controller still sees it staged', () => {
  const at = server.indexOf('function daemonPendingRestartVersion(')
  assert.ok(at >= 0)
  const end = server.indexOf('\n}\n', at)
  assert.match(server.slice(at, end), /heldBad: latched \? idleUpdateHeldBad : undefined,/)
  assert.match(server, /function idleUpdateHeldBad\(version: string\): boolean \{\n\s+return isVersionHeldBad\(version, \{ machineDir: IDLE_UPDATE_MACHINE_DIR, fs: nodeIdleUpdateFs\(\) \}\)/)
  assert.match(block(), /stagedVersion: \(\) => daemonStagedVersion\(\),/)
  const staged = server.indexOf('function daemonStagedVersion(')
  assert.ok(staged >= 0)
  assert.match(server.slice(staged, server.indexOf('\n}\n', staged)), /return daemonPendingRestartVersion\(undefined, \{ latched: false \}\)/)
})

test('the readings come from the host module: the launcher claim, the unattended inputs, a person, the watcher, the schedule', () => {
  const b = block()
  assert.match(b, /launcher: \(\) => readLauncherClaim\(\{ stateDir, fs, alive: defaultPidAlive \}\),/)
  assert.match(b, /markerMtimeMs: \(\) => readMarkerMtimeMs\(\{ stateDir, fs \}\),/)
  assert.match(b, /unattendedInputs: \(\) => readUnattendedInputs\(\{ platform: process\.platform, home: homedir\(\), assistantId: ASSISTANT_ID, stateDir, fs \}\),/)
  assert.match(b, /readPersonAttached\(\{\n?\s*platform: process\.platform,/)
  assert.match(b, /keepalive: authority\.kind === 'keepalive',/)
  assert.match(b, /watcherSweepActive: \(\) => readWatcherSweepActive\(\{ home: homedir\(\), fs, now: Date\.now\(\), freshMs: IDLE_UPDATE_DURATIONS\.watcherFreshMs \}\),/)
  assert.match(b, /wakeSchedule: \(\) => readWakeSchedule\(\(path\) => bgosPeerGet\(path\)\),/)
  assert.match(b, /sessionId: async \(\) => readTextOrNull\(pathJoin\(stateDir, SESSION_ID_FILE_NAME\)\)\?\.trim\(\) \|\| null,/)
  assert.match(b, /authorityKind: \(\) => idleRestartAuthority\(\)\.kind,/)
  assert.match(b, /serviceOwnsUs: \(\) => idleServiceOwnsUs\(\),/)
})

test('the rollback: the marketplace through the host module and the clone through the self updater, never an exit', () => {
  const at = server.indexOf('async function idleRollbackInstall(')
  assert.ok(at >= 0, 'idleRollbackInstall is missing')
  const body = server.slice(at, server.indexOf('\n}\n', at))
  assert.match(body, /rollbackMarketplaceInstall\(\{/)
  assert.match(body, /installedPluginsPath: installedPluginsPath\(CLAUDE_CONFIG_DIR\),/)
  assert.match(body, /setAutoUpdate: \(\) => ensureMarketplaceAutoUpdate\(\{ configDir: CLAUDE_CONFIG_DIR, marketplace, enabled: false \}\)/)
  // Its own line: the setAutoUpdate line above names the config folder too, for another call.
  assert.match(body, /^\s+configDir: CLAUDE_CONFIG_DIR,$/m, 'the hold records the config folder it switched off')
  assert.match(body, /selfUpdater\.rollbackCheckoutTo\(record\.fromCommit\)/)
  assert.doesNotMatch(body, /process\.exit|attemptRollback/)
  assert.match(block(), /rollbackInstall: \(record: any\) => idleRollbackInstall\(record\),/)
})

test('the boot enrolment holds Claude Code\'s own update while the latest is latched bad here, and takes back only its own hold', () => {
  const at = server.indexOf("if (INSTALL_METHOD === 'marketplace') {\n      // Make sure this machine is enrolled")
  assert.ok(at >= 0, 'the boot enrolment moved')
  const end = server.indexOf('marketplaceLatest.start()', at)
  const step = server.slice(at, end)
  const observe = step.indexOf('await marketplaceLatest.observeNow()')
  const decide = step.indexOf('decideEnrolment({')
  const ensure = step.indexOf('ensureMarketplaceAutoUpdate({')
  assert.ok(observe >= 0 && decide > observe && ensure > decide, 'the latest is observed, then the hold decided, then the enrolment')
  assert.match(step, /latestKnownVersion: marketplaceLatest\.current\(\),/)
  assert.match(step, /badVersions: listHeldBadVersions\(\{ machineDir: IDLE_UPDATE_MACHINE_DIR, fs: nodeIdleUpdateFs\(\) \}\),/)
  assert.match(step, /marketplaceName && updatesAllowed && enrolment !== 'hold'/)
  assert.match(step, /reclaim: enrolment === 'reclaim',/)
  assert.match(step.slice(decide, ensure), /^\s+configDir: CLAUDE_CONFIG_DIR,$/m)
})

test('a clean end (its claude went away: stdin closed, a signal) is on the idle update record; a fatal error never is', () => {
  const at = server.indexOf('  const shutdown = (cause: ShutdownCause | string, code: number): void => {')
  assert.ok(at >= 0, 'shutdown moved')
  const body = server.slice(at, server.indexOf('\n  }\n', at))
  assert.match(body, /idleUpdate\?\.noteEnded\(\)/)
  assert.ok(body.indexOf('idleUpdate?.noteEnded()') < body.indexOf('process.exit(code)'))
  const fault = server.indexOf("process.on('uncaughtException', (err) => {")
  assert.ok(fault >= 0)
  assert.doesNotMatch(server.slice(fault, server.indexOf('\n  })\n', fault)), /noteEnded/)
  const main = server.indexOf('main().catch((err) => {')
  assert.ok(main >= 0)
  assert.doesNotMatch(server.slice(main, server.indexOf('\n})\n', main)), /noteEnded/)
  const exit = server.indexOf("process.on('exit', () => {")
  assert.doesNotMatch(server.slice(exit, server.indexOf('\n  })\n', exit)), /noteEnded/, 'the exit backstop also runs after a crash')
})
