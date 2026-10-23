/**
 * lib/agent-checkup.mjs: the PURE classifier and planner of the check up pass
 * (PLAN-doctor.md section 4.2, packet P2). One table per cause C3 to C9, then
 * the two invariants that must never break:
 *
 *   never a restart or a start for C8 (signed out) or C9 (usage limit)
 *   never a restart or a start when the safe table says unsafe, or a gate says no
 *
 * Every observation is a fixture; nothing here reads a disk, a process or the
 * network. A one-line mutant of a guard in the module turns a named row red.
 *
 * Run: npx tsx --test test/agent-checkup.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  BEACON_STALE_MS,
  DRAIN_MAX_MS,
  PASS_DEADLINE_MS,
  VALIDATION_WINDOW_MS,
  WEDGE_WINDOW_MS,
  checkupPass,
  diagnoseAgent,
  planRepairs,
} from '../lib/agent-checkup.mjs'
import { MAX_ATTEMPTS_PER_TARGET, RESTART_MIN_INTERVAL_MS } from '../lib/keepalive-plan.mjs'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const MIN = 60_000

/** A healthy agent: claude and daemon up, versions equal, nothing owed, no gate spent. */
function healthy(): Record<string, any> {
  return {
    now: NOW,
    assistantId: '42',
    claudeAlive: true,
    daemonAlive: true,
    descendants: [],
    agentState: null,
    stateFresh: false,
    activityMs: [NOW - 60 * MIN],
    beaconHeartbeatAtMs: NOW - 10_000,
    launchStatus: null,
    hasSupervisor: true,
    hasLaunchRecipe: false,
    messagesDeliveredAtMs: null,
    lastTranscriptActivityAtMs: NOW - 60 * MIN,
    stuckScreen: null,
    runningVersion: '0.74.0',
    installedVersion: '0.74.0',
    publishedVersion: '0.74.0',
    belowFloor: false,
    update: { jobDeadlineAtMs: null, validationPendingSinceMs: null, drainSinceMs: null, stagedNeverApplied: false },
    transcriptError: null,
    lastRestartAtMs: null,
    attempts: 0,
  }
}

function obs(over: Record<string, any> = {}): any {
  return { ...healthy(), ...over }
}

/** A fresh agent-state.json as the daemon publishes it (turnSignal hooks). */
function freshState(over: Record<string, any> = {}): Record<string, any> {
  return {
    assistantId: '42',
    pid: 4242,
    claudePid: 4243,
    runningVersion: '0.74.0',
    pendingRestartVersion: null,
    turnInFlight: false,
    pendingMessages: 0,
    pendingPermissions: 0,
    activeOperations: 0,
    lastActivityAtMs: NOW - 60 * MIN,
    sessionId: null,
    updatedAtMs: NOW - 5_000,
    turnSignal: 'hooks',
    ...over,
  }
}

function causes(findings: Array<{ cause: string }>): string[] {
  return findings.map((f) => f.cause)
}

function steps(actions: Array<{ action: string; outcome: string }>): string[] {
  return actions.map((a) => `${a.action}:${a.outcome}`)
}

const MUTATING = new Set(['restart', 'start'])

function plannedRestart(actions: Array<{ action: string; outcome: string }>): boolean {
  return actions.some((a) => MUTATING.has(a.action) && a.outcome === 'planned')
}

// -- Healthy and unreadable ------------------------------------------------------------------

test('healthy agent: no findings, no actions', () => {
  const pass = checkupPass(obs())
  assert.deepEqual(pass.findings, [])
  assert.deepEqual(pass.actions, [])
})

test('an unreadable process table names no process cause (unknown is not a diagnosis)', () => {
  for (const over of [{ claudeAlive: null }, { daemonAlive: null }, { claudeAlive: null, daemonAlive: null }]) {
    const findings = diagnoseAgent(obs(over))
    assert.deepEqual(causes(findings).filter((c) => ['C3', 'C4', 'C5'].includes(c)), [], JSON.stringify(over))
  }
})

// -- C3: daemon down, session alive ----------------------------------------------------------

test('C3: a live claude with no live daemon is daemon_down, fixable', () => {
  const findings = diagnoseAgent(obs({ daemonAlive: false }))
  assert.deepEqual(causes(findings), ['C3'])
  assert.equal(findings[0].code, 'daemon_down')
  assert.equal(findings[0].fixable, true)
})

test('C3: a stale beacon heartbeat while claude runs is beacon_stale', () => {
  const findings = diagnoseAgent(obs({ beaconHeartbeatAtMs: NOW - BEACON_STALE_MS - 1 }))
  assert.deepEqual(causes(findings), ['C3'])
  assert.equal(findings[0].code, 'beacon_stale')
})

test('C3: a fresh beacon and an unknown beacon are not stale', () => {
  assert.deepEqual(diagnoseAgent(obs({ beaconHeartbeatAtMs: NOW - BEACON_STALE_MS + 1 })), [])
  assert.deepEqual(diagnoseAgent(obs({ beaconHeartbeatAtMs: null })), [])
})

test('C3 plan: restart then verify, when the safe table says safe', () => {
  const pass = checkupPass(obs({ daemonAlive: false }))
  assert.deepEqual(steps(pass.actions), ['restart:planned', 'verify:planned'])
  assert.deepEqual(pass.actions[0].causes, ['C3'])
  assert.equal(pass.actions[1].via, 'boot_hello')
  assert.equal(pass.actions[1].deadlineMs, PASS_DEADLINE_MS)
})

test('C3 plan: a turn in flight holds the restart as waiting_idle with the reason', () => {
  const pass = checkupPass(obs({ daemonAlive: false, stateFresh: true, agentState: freshState({ turnInFlight: true }) }))
  assert.deepEqual(steps(pass.actions), ['restart:skipped'])
  assert.equal(pass.actions[0].reason, 'turn_in_flight')
  assert.equal(pass.actions[0].state, 'waiting_idle')
})

// -- C4: dead session --------------------------------------------------------------------------

test('C4: no claude and no daemon is not_running, fixable with a supervisor', () => {
  const findings = diagnoseAgent(obs({ claudeAlive: false, daemonAlive: false }))
  assert.deepEqual(causes(findings), ['C4'])
  assert.equal(findings[0].code, 'not_running')
  assert.equal(findings[0].fixable, true)
})

test('C4: a launch recipe is as good as a supervisor', () => {
  const findings = diagnoseAgent(obs({ claudeAlive: false, daemonAlive: false, hasSupervisor: false, hasLaunchRecipe: true }))
  assert.equal(findings[0].fixable, true)
})

test('C4 plan: a dead session is started, then verified', () => {
  const pass = checkupPass(obs({ claudeAlive: false, daemonAlive: false }))
  assert.deepEqual(steps(pass.actions), ['start:planned', 'verify:planned'])
  assert.deepEqual(pass.actions[0].causes, ['C4'])
})

test('C4: a named launch failure is reported, never retried in a loop', () => {
  for (const outcome of ['exited-during-startup', 'plugin-root-missing', 'node-missing', 'gate-trust', 'hoai-exited-without-status']) {
    const over = { claudeAlive: false, daemonAlive: false, launchStatus: { outcome } }
    const findings = diagnoseAgent(obs(over))
    assert.deepEqual(causes(findings), ['C4'], outcome)
    assert.equal(findings[0].code, 'launch_failed', outcome)
    assert.equal(findings[0].fixable, false, outcome)
    assert.match(findings[0].evidence, new RegExp(outcome), outcome)
    const pass = checkupPass(obs(over))
    assert.deepEqual(steps(pass.actions), ['report:planned'], outcome)
    assert.equal(pass.actions[0].ownerAction?.kind, 'fix_launch', outcome)
  }
})

test('C4: a launch that is merely starting or waiting is not a failure', () => {
  for (const outcome of ['starting', 'waiting-for-incumbent']) {
    const findings = diagnoseAgent(obs({ claudeAlive: false, daemonAlive: false, launchStatus: { outcome } }))
    assert.equal(findings[0].code, 'not_running', outcome)
  }
})

test('C4: no supervisor and no recipe is needs_first_launch, reported not started', () => {
  const over = { claudeAlive: false, daemonAlive: false, hasSupervisor: false, hasLaunchRecipe: false }
  const findings = diagnoseAgent(obs(over))
  assert.equal(findings[0].code, 'needs_first_launch')
  assert.equal(findings[0].fixable, false)
  assert.deepEqual(steps(checkupPass(obs(over)).actions), ['report:planned'])
})

test('C4: live-but-not-signed-in is the login cause C8, not a dead session', () => {
  const findings = diagnoseAgent(obs({ claudeAlive: false, daemonAlive: false, launchStatus: { outcome: 'live-but-not-signed-in' } }))
  assert.deepEqual(causes(findings), ['C8'])
})

// -- C5: wedged session ------------------------------------------------------------------------

test('C5: owner messages delivered and no transcript activity for the wedge window', () => {
  const findings = diagnoseAgent(
    obs({ messagesDeliveredAtMs: NOW - WEDGE_WINDOW_MS - MIN, lastTranscriptActivityAtMs: NOW - WEDGE_WINDOW_MS - 2 * MIN }),
  )
  assert.deepEqual(causes(findings), ['C5'])
  assert.equal(findings[0].code, 'no_reply')
  assert.equal(findings[0].fixable, true)
})

test('C5: delivered less than the wedge window ago is a think, not a wedge', () => {
  const findings = diagnoseAgent(obs({ messagesDeliveredAtMs: NOW - WEDGE_WINDOW_MS + MIN, lastTranscriptActivityAtMs: NOW - 30 * MIN }))
  assert.deepEqual(findings, [])
})

test('C5: transcript activity after the delivery is an agent that answered', () => {
  const findings = diagnoseAgent(obs({ messagesDeliveredAtMs: NOW - 30 * MIN, lastTranscriptActivityAtMs: NOW - 2 * MIN }))
  assert.deepEqual(findings, [])
})

test('C5: nothing delivered means nothing is owed', () => {
  assert.deepEqual(diagnoseAgent(obs({ messagesDeliveredAtMs: null, lastTranscriptActivityAtMs: null })), [])
})

test('C5: an unanswerable screen is stuck_screen, with the screen named', () => {
  const findings = diagnoseAgent(obs({ stuckScreen: 'trust this folder' }))
  assert.deepEqual(causes(findings), ['C5'])
  assert.equal(findings[0].code, 'stuck_screen')
  assert.match(findings[0].evidence, /trust this folder/)
})

test('C5 plan: a wedged idle session is restarted and verified', () => {
  const pass = checkupPass(
    obs({
      messagesDeliveredAtMs: NOW - 30 * MIN,
      lastTranscriptActivityAtMs: NOW - 40 * MIN,
      stateFresh: true,
      agentState: freshState({ turnSignal: 'hooks' }),
      activityMs: [NOW - 25 * MIN],
    }),
  )
  assert.deepEqual(steps(pass.actions), ['restart:planned', 'verify:planned'])
})

test('C5 plan: it looks busy, so it is not interrupted (waiting_idle, reason named)', () => {
  const pass = checkupPass(
    obs({
      messagesDeliveredAtMs: NOW - 30 * MIN,
      lastTranscriptActivityAtMs: NOW - 40 * MIN,
      stateFresh: true,
      agentState: freshState({ turnInFlight: true, lastActivityAtMs: NOW - 3 * MIN }),
      activityMs: [NOW - 3 * MIN],
    }),
  )
  assert.deepEqual(steps(pass.actions), ['restart:skipped'])
  assert.equal(pass.actions[0].state, 'waiting_idle')
  assert.equal(pass.actions[0].reason, 'turn_in_flight')
})

test('C5: a silence that the login or the usage limit explains is not also called a wedge', () => {
  const wedged = { messagesDeliveredAtMs: NOW - 30 * MIN, lastTranscriptActivityAtMs: NOW - 40 * MIN }
  assert.deepEqual(causes(diagnoseAgent(obs({ ...wedged, transcriptError: { kind: 'authentication_failed', resetAt: null } }))), ['C8'])
  assert.deepEqual(causes(diagnoseAgent(obs({ ...wedged, transcriptError: { kind: 'rate_limit', resetAt: '2026-10-23T15:00:00Z' } }))), ['C9'])
})

// -- C6: stale plugin --------------------------------------------------------------------------

test('C6: a daemon running below the installed version is stale_plugin', () => {
  const findings = diagnoseAgent(obs({ runningVersion: '0.73.0', installedVersion: '0.74.0', publishedVersion: '0.74.0' }))
  assert.deepEqual(causes(findings), ['C6'])
  assert.equal(findings[0].code, 'stale_plugin')
  assert.equal(findings[0].fixable, true)
  assert.equal(findings[0].from, '0.73.0')
  assert.equal(findings[0].to, '0.74.0')
})

test('C6: the published version counts when it is newer than the installed one', () => {
  const findings = diagnoseAgent(obs({ runningVersion: '0.74.0', installedVersion: '0.74.0', publishedVersion: '0.75.0' }))
  assert.equal(findings[0].to, '0.75.0')
})

test('C6: versions compare as numbers, not text (0.9.0 is below 0.10.0)', () => {
  const findings = diagnoseAgent(obs({ runningVersion: '0.9.0', installedVersion: '0.10.0', publishedVersion: '0.10.0' }))
  assert.deepEqual(causes(findings), ['C6'])
})

test('C6: a running version at or above everything known is current', () => {
  assert.deepEqual(diagnoseAgent(obs({ runningVersion: '0.75.0', installedVersion: '0.74.0', publishedVersion: '0.74.0' })), [])
})

test('C6: a restart the daemon says is pending, and the backend floor, also name it', () => {
  assert.deepEqual(
    causes(diagnoseAgent(obs({ stateFresh: true, agentState: freshState({ pendingRestartVersion: '0.75.0' }) }))),
    ['C6'],
  )
  assert.deepEqual(causes(diagnoseAgent(obs({ belowFloor: true }))), ['C6'])
})

test('C6: an unparseable version is unknown, not stale', () => {
  assert.deepEqual(diagnoseAgent(obs({ runningVersion: 'banana', installedVersion: '0.74.0' })), [])
  assert.deepEqual(diagnoseAgent(obs({ runningVersion: null })), [])
})

test('C6 plan: update, then restart to apply it, then verify', () => {
  const pass = checkupPass(obs({ runningVersion: '0.73.0', installedVersion: '0.74.0' }))
  assert.deepEqual(steps(pass.actions), ['update:planned', 'restart:planned', 'verify:planned'])
  assert.deepEqual(pass.actions[0].causes, ['C6'])
})

test('C6 plan: an unsafe moment still stages the update but holds the restart', () => {
  const pass = checkupPass(
    obs({ runningVersion: '0.73.0', installedVersion: '0.74.0', stateFresh: true, agentState: freshState({ pendingMessages: 2 }) }),
  )
  assert.deepEqual(steps(pass.actions), ['update:planned', 'restart:skipped'])
  assert.equal(pass.actions[1].reason, 'pending_messages')
})

// -- C7: stuck update --------------------------------------------------------------------------

const STUCK: Array<[string, Record<string, any>]> = [
  ['job_past_deadline', { jobDeadlineAtMs: NOW - 1 }],
  ['validation_stalled', { validationPendingSinceMs: NOW - VALIDATION_WINDOW_MS - 1 }],
  ['drain_too_long', { drainSinceMs: NOW - DRAIN_MAX_MS - 1 }],
  ['staged_not_applied', { stagedNeverApplied: true }],
]

for (const [code, update] of STUCK) {
  test(`C7: ${code} is a stuck update, repaired`, () => {
    const findings = diagnoseAgent(obs({ update: { ...healthy().update, ...update } }))
    assert.deepEqual(causes(findings), ['C7'])
    assert.equal(findings[0].code, code)
    assert.equal(findings[0].fixable, true)
    const pass = checkupPass(obs({ update: { ...healthy().update, ...update } }))
    assert.deepEqual(steps(pass.actions), ['repair:planned', 'restart:planned', 'verify:planned'])
  })
}

test('C7: an update inside its windows is in progress, not stuck', () => {
  const update = {
    jobDeadlineAtMs: NOW + MIN,
    validationPendingSinceMs: NOW - VALIDATION_WINDOW_MS + MIN,
    drainSinceMs: NOW - DRAIN_MAX_MS + MIN,
    stagedNeverApplied: false,
  }
  assert.deepEqual(diagnoseAgent(obs({ update })), [])
})

test('C6 and C7 together get ONE repair, not an update and a repair', () => {
  const pass = checkupPass(
    obs({ runningVersion: '0.73.0', installedVersion: '0.74.0', update: { ...healthy().update, stagedNeverApplied: true } }),
  )
  assert.deepEqual(causes(pass.findings), ['C6', 'C7'])
  assert.deepEqual(steps(pass.actions), ['repair:planned', 'restart:planned', 'verify:planned'])
  assert.deepEqual(pass.actions[0].causes, ['C6', 'C7'])
})

// -- C8 and C9: reported, never restarted -----------------------------------------------------

test('C8: authentication_failed in the transcript is login_expired, not fixable', () => {
  const findings = diagnoseAgent(obs({ transcriptError: { kind: 'authentication_failed', resetAt: null } }))
  assert.deepEqual(causes(findings), ['C8'])
  assert.equal(findings[0].code, 'login_expired')
  assert.equal(findings[0].fixable, false)
})

test('C8 plan: report only, the owner types /login', () => {
  const pass = checkupPass(obs({ transcriptError: { kind: 'authentication_failed', resetAt: null } }))
  assert.deepEqual(steps(pass.actions), ['report:planned'])
  assert.equal(pass.actions[0].ownerAction?.kind, 'login')
  assert.match(pass.actions[0].ownerAction?.text, /\/login/)
})

test('C9: rate_limit in the transcript is usage_limit, with the reset time', () => {
  const findings = diagnoseAgent(obs({ transcriptError: { kind: 'rate_limit', resetAt: '2026-10-23T15:00:00Z' } }))
  assert.deepEqual(causes(findings), ['C9'])
  assert.equal(findings[0].code, 'usage_limit')
  assert.equal(findings[0].fixable, false)
  assert.equal(findings[0].resetAt, '2026-10-23T15:00:00Z')
})

test('C9 plan: report only, the reset time is in the words', () => {
  const pass = checkupPass(obs({ transcriptError: { kind: 'rate_limit', resetAt: '2026-10-23T15:00:00Z' } }))
  assert.deepEqual(steps(pass.actions), ['report:planned'])
  assert.equal(pass.actions[0].ownerAction?.kind, 'wait')
  assert.match(pass.actions[0].ownerAction?.text, /2026-10-23T15:00:00Z/)
})

test('C9: a limit with no known reset time still reports', () => {
  const pass = checkupPass(obs({ transcriptError: { kind: 'rate_limit', resetAt: null } }))
  assert.deepEqual(steps(pass.actions), ['report:planned'])
  assert.equal(pass.actions[0].ownerAction?.kind, 'wait')
})

test('C8 and C9 are reported FIRST, before any other action, in the same pass', () => {
  const pass = checkupPass(
    obs({ daemonAlive: false, runningVersion: '0.73.0', installedVersion: '0.74.0', transcriptError: { kind: 'authentication_failed', resetAt: null } }),
  )
  assert.equal(pass.actions[0].action, 'report')
  assert.deepEqual(pass.actions[0].causes, ['C8'])
})

// -- Never a restart for C8 or C9 --------------------------------------------------------------

test('never a restart or a start for C8: even when every other gate is open', () => {
  for (const over of [
    {},
    { daemonAlive: false },
    { claudeAlive: false, daemonAlive: false },
    { messagesDeliveredAtMs: NOW - 30 * MIN, lastTranscriptActivityAtMs: NOW - 40 * MIN },
    { runningVersion: '0.73.0', installedVersion: '0.74.0' },
    { update: { ...healthy().update, stagedNeverApplied: true } },
  ]) {
    const pass = checkupPass(obs({ ...over, transcriptError: { kind: 'authentication_failed', resetAt: null } }))
    assert.equal(plannedRestart(pass.actions), false, JSON.stringify(over))
    for (const a of pass.actions) {
      if (MUTATING.has(a.action)) assert.equal(a.reason, 'blocked_by_login', JSON.stringify(over))
    }
  }
})

test('never a restart or a start for C9: even when every other gate is open', () => {
  for (const over of [
    {},
    { daemonAlive: false },
    { claudeAlive: false, daemonAlive: false },
    { messagesDeliveredAtMs: NOW - 30 * MIN, lastTranscriptActivityAtMs: NOW - 40 * MIN },
    { runningVersion: '0.73.0', installedVersion: '0.74.0' },
    { update: { ...healthy().update, stagedNeverApplied: true } },
  ]) {
    const pass = checkupPass(obs({ ...over, transcriptError: { kind: 'rate_limit', resetAt: null } }))
    assert.equal(plannedRestart(pass.actions), false, JSON.stringify(over))
    for (const a of pass.actions) {
      if (MUTATING.has(a.action)) assert.equal(a.reason, 'blocked_by_usage_limit', JSON.stringify(over))
    }
  }
})

test('C8 with a stale plugin: the update is still staged, nothing is restarted', () => {
  const pass = checkupPass(
    obs({ runningVersion: '0.73.0', installedVersion: '0.74.0', transcriptError: { kind: 'authentication_failed', resetAt: null } }),
  )
  assert.deepEqual(steps(pass.actions), ['report:planned', 'update:planned', 'restart:skipped'])
})

test('a named launch failure with a stale plugin: the update is staged, the agent is not restarted into the same failure', () => {
  for (const [outcome, code] of [['exited-during-startup', 'launch_failed']]) {
    const pass = checkupPass(
      obs({ claudeAlive: false, daemonAlive: false, launchStatus: { outcome }, runningVersion: '0.73.0', installedVersion: '0.74.0' }),
    )
    assert.deepEqual(steps(pass.actions), ['report:planned', 'update:planned', 'restart:skipped'])
    assert.equal(pass.actions[2].reason, code)
  }
  const first = checkupPass(
    obs({ claudeAlive: false, daemonAlive: false, hasSupervisor: false, runningVersion: '0.73.0', installedVersion: '0.74.0' }),
  )
  assert.equal(plannedRestart(first.actions), false)
  assert.equal(first.actions.find((a) => MUTATING.has(a.action))?.reason, 'needs_first_launch')
})

test('a signed out launch is C8 and starts nothing, even with a supervisor', () => {
  const pass = checkupPass(obs({ claudeAlive: false, daemonAlive: false, launchStatus: { outcome: 'live-but-not-signed-in' } }))
  assert.deepEqual(causes(pass.findings), ['C8'])
  assert.equal(plannedRestart(pass.actions), false)
})

// -- Never a kill when unsafe, and the gates ---------------------------------------------------

const UNSAFE: Array<[string, Record<string, any>]> = [
  ['turn_in_flight', { stateFresh: true, agentState: freshState({ turnInFlight: true }) }],
  ['pending_messages', { stateFresh: true, agentState: freshState({ pendingMessages: 1 }) }],
  ['pending_permission', { stateFresh: true, agentState: freshState({ pendingPermissions: 1 }) }],
  ['background_job', { descendants: ['/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && sleep 900'] }],
  ['process_tree_unreadable', { descendants: null }],
  ['recent_activity', { activityMs: [NOW - 2 * MIN] }],
]

for (const [reason, unsafe] of UNSAFE) {
  test(`never a kill when unsafe: ${reason} holds a C3 restart, waiting_idle`, () => {
    const pass = checkupPass(obs({ daemonAlive: false, ...unsafe }))
    assert.equal(plannedRestart(pass.actions), false)
    assert.deepEqual(steps(pass.actions), ['restart:skipped'])
    assert.equal(pass.actions[0].reason, reason)
    assert.equal(pass.actions[0].state, 'waiting_idle')
  })
}

test('a restart gate that says no is a skipped step with its reason and state', () => {
  const rateLimited = checkupPass(obs({ daemonAlive: false, lastRestartAtMs: NOW - RESTART_MIN_INTERVAL_MS + MIN }))
  assert.deepEqual(steps(rateLimited.actions), ['restart:skipped'])
  assert.equal(rateLimited.actions[0].reason, 'restart_rate_limited')

  const exhausted = checkupPass(obs({ daemonAlive: false, attempts: MAX_ATTEMPTS_PER_TARGET }))
  assert.deepEqual(steps(exhausted.actions), ['restart:skipped'])
  assert.equal(exhausted.actions[0].reason, 'attempts_exhausted')
  assert.equal(exhausted.actions[0].state, 'failed')
})

test('a restart exactly at the rate limit edge is allowed', () => {
  const pass = checkupPass(obs({ daemonAlive: false, lastRestartAtMs: NOW - RESTART_MIN_INTERVAL_MS }))
  assert.equal(plannedRestart(pass.actions), true)
})

test('one restart per pass, however many causes want one', () => {
  const pass = checkupPass(
    obs({
      daemonAlive: false,
      messagesDeliveredAtMs: NOW - 30 * MIN,
      lastTranscriptActivityAtMs: NOW - 40 * MIN,
      runningVersion: '0.73.0',
      installedVersion: '0.74.0',
      update: { ...healthy().update, stagedNeverApplied: true },
    }),
  )
  assert.equal(pass.actions.filter((a: any) => MUTATING.has(a.action)).length, 1)
  assert.equal(pass.actions.filter((a: any) => a.action === 'verify').length, 1)
  const restart = pass.actions.find((a) => a.action === 'restart')
  assert.deepEqual(restart?.causes, ['C3', 'C5', 'C6', 'C7'])
})

test('the order is: reports, then update or repair, then restart or start, then verify', () => {
  const pass = checkupPass(
    obs({
      daemonAlive: false,
      runningVersion: '0.73.0',
      installedVersion: '0.74.0',
      transcriptError: { kind: 'rate_limit', resetAt: null },
    }),
  )
  assert.deepEqual(pass.actions.map((a: any) => a.action), ['report', 'update', 'restart'])
  const clean = checkupPass(obs({ daemonAlive: false, runningVersion: '0.73.0', installedVersion: '0.74.0' }))
  assert.deepEqual(clean.actions.map((a: any) => a.action), ['update', 'restart', 'verify'])
})

test('verify is planned only when something was actually changed', () => {
  assert.equal(checkupPass(obs({ transcriptError: { kind: 'rate_limit', resetAt: null } })).actions.some((a: any) => a.action === 'verify'), false)
  assert.equal(checkupPass(obs({ daemonAlive: false, stateFresh: true, agentState: freshState({ turnInFlight: true }) })).actions.some((a: any) => a.action === 'verify'), false)
})

// -- The invariants, over the whole cross product ----------------------------------------------

test('invariant: no planned restart or start under C8, C9, an unsafe moment or a closed gate (every combination)', () => {
  const flags: Array<[string, Record<string, any>]> = [
    ['login', { transcriptError: { kind: 'authentication_failed', resetAt: null } }],
    ['limit', { transcriptError: { kind: 'rate_limit', resetAt: null } }],
    ['daemon', { daemonAlive: false }],
    ['dead', { claudeAlive: false, daemonAlive: false }],
    ['wedged', { messagesDeliveredAtMs: NOW - 30 * MIN, lastTranscriptActivityAtMs: NOW - 40 * MIN }],
    ['stale', { runningVersion: '0.73.0', installedVersion: '0.74.0' }],
    ['stuck', { update: { ...healthy().update, stagedNeverApplied: true } }],
  ]
  const safety: Array<[string, boolean, Record<string, any>]> = [
    ['idle', true, {}],
    ...UNSAFE.map(([name, over]): [string, boolean, Record<string, any>] => [name, false, over]),
  ]
  const budgets: Array<[string, boolean, Record<string, any>]> = [
    ['open', true, {}],
    ['rate', false, { lastRestartAtMs: NOW - MIN }],
    ['exhausted', false, { attempts: MAX_ATTEMPTS_PER_TARGET }],
  ]
  let cases = 0
  for (let mask = 0; mask < 1 << flags.length; mask++) {
    let base: Record<string, any> = {}
    const on = new Set<string>()
    flags.forEach(([name, over], i) => {
      if (mask & (1 << i)) {
        base = { ...base, ...over }
        on.add(name)
      }
    })
    for (const [safeName, safe, safeOver] of safety) {
      for (const [budgetName, open, budgetOver] of budgets) {
        const input = obs({ ...base, ...safeOver, ...budgetOver })
        const label = `${[...on].join('+') || 'none'} / ${safeName} / ${budgetName}`
        const pass = checkupPass(structuredClone(input))
        cases++
        for (const a of pass.actions) {
          if (!MUTATING.has(a.action) || a.outcome !== 'planned') continue
          assert.equal(on.has('login'), false, `restart under C8: ${label}`)
          assert.equal(on.has('limit'), false, `restart under C9: ${label}`)
          assert.equal(open, true, `restart through a closed gate: ${label}`)
          // A start of a session that is not running is no kill; every other restart needs the safe table.
          if (a.action === 'restart') assert.equal(safe, true, `kill when unsafe: ${label}`)
        }
      }
    }
  }
  assert.ok(cases > 800, `expected the full cross product, got ${cases}`)
})

// -- Purity ------------------------------------------------------------------------------------

test('purity: the input is not mutated, and the same input gives the same answer', () => {
  const input = obs({ daemonAlive: false, runningVersion: '0.73.0', installedVersion: '0.74.0', agentState: freshState(), stateFresh: true })
  const frozen = JSON.stringify(input)
  const first = checkupPass(input)
  const second = checkupPass(input)
  assert.equal(JSON.stringify(input), frozen)
  assert.deepEqual(first, second)
})

test('planRepairs takes findings and gates alone (the planner is separable from the classifier)', () => {
  const findings = diagnoseAgent(obs({ daemonAlive: false }))
  const actions = planRepairs(findings, { now: NOW, lastRestartAtMs: null, attempts: 0, safeMoment: { safe: true, reason: 'idle' } })
  assert.deepEqual(steps(actions), ['restart:planned', 'verify:planned'])
  const held = planRepairs(findings, { now: NOW, lastRestartAtMs: null, attempts: 0, safeMoment: { safe: false, reason: 'turn_in_flight' } })
  assert.deepEqual(steps(held), ['restart:skipped'])
})

test('purity: the module imports nothing but the pure keepalive plan, and uses no I/O', () => {
  const source = readFileSync(fileURLToPath(new URL('../lib/agent-checkup.mjs', import.meta.url)), 'utf8')
  const imports = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['./keepalive-plan.mjs'])
  assert.doesNotMatch(source, /child_process|node:fs|node:net|node:http|fetch\(|process\.env|Date\.now\(|setTimeout/)
})

test('house style: no em or en dashes anywhere in the module or this test', () => {
  for (const path of ['../lib/agent-checkup.mjs', './agent-checkup.test.ts']) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, new RegExp('[\\u2013\\u2014]'), path)
  }
})

test('every report string is bounded for the backend', () => {
  const pass = checkupPass(
    obs({ daemonAlive: false, runningVersion: '0.73.0', installedVersion: '0.74.0', transcriptError: { kind: 'rate_limit', resetAt: '2026-10-23T15:00:00Z' } }),
  )
  for (const f of pass.findings) assert.ok(f.evidence.length <= 120, f.evidence)
  for (const a of pass.actions) {
    if (a.ownerAction) assert.ok(a.ownerAction.text.length <= 240, a.ownerAction.text)
  }
})
