/** Checkup diagnosis and the report-only policy. All observations are synthetic. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  BEACON_STALE_MS,
  DRAIN_MAX_MS,
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
    processState: 'alive',
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
  const processState = over.claudeAlive === false && over.daemonAlive === false ? 'stopped' : 'alive'
  return { ...healthy(), processState, ...over }
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

test('healthy agent: no findings, no actions', () => {
  const pass = checkupPass(obs())
  assert.deepEqual(pass.findings, [])
  assert.deepEqual(pass.actions, [])
})

test('C3: a live claude with no live daemon is daemon_down, report only', () => {
  const findings = diagnoseAgent(obs({ daemonAlive: false }))
  assert.deepEqual(causes(findings), ['C3'])
  assert.equal(findings[0].code, 'daemon_down')
  assert.equal(findings[0].fixable, false)
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

test('C4: no claude and no daemon is not_running, reported with a supervisor', () => {
  const findings = diagnoseAgent(obs({ claudeAlive: false, daemonAlive: false }))
  assert.deepEqual(causes(findings), ['C4'])
  assert.equal(findings[0].code, 'not_running')
  assert.equal(findings[0].fixable, false)
})

test('C4: a launch recipe still requires owner action', () => {
  const findings = diagnoseAgent(obs({ claudeAlive: false, daemonAlive: false, hasSupervisor: false, hasLaunchRecipe: true }))
  assert.equal(findings[0].fixable, false)
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

test('C5: owner messages delivered and no transcript activity for the wedge window', () => {
  const findings = diagnoseAgent(
    obs({ messagesDeliveredAtMs: NOW - WEDGE_WINDOW_MS - MIN, lastTranscriptActivityAtMs: NOW - WEDGE_WINDOW_MS - 2 * MIN }),
  )
  assert.deepEqual(causes(findings), ['C5'])
  assert.equal(findings[0].code, 'no_reply')
  assert.equal(findings[0].fixable, false)
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

test('C5: a silence that the login or the usage limit explains is not also called a wedge', () => {
  const wedged = { messagesDeliveredAtMs: NOW - 30 * MIN, lastTranscriptActivityAtMs: NOW - 40 * MIN }
  assert.deepEqual(causes(diagnoseAgent(obs({ ...wedged, transcriptError: { kind: 'authentication_failed', resetAt: null } }))), ['C8'])
  assert.deepEqual(causes(diagnoseAgent(obs({ ...wedged, transcriptError: { kind: 'rate_limit', resetAt: '2026-10-23T15:00:00Z' } }))), ['C9'])
})

test('C6: a daemon running below the installed version is stale_plugin', () => {
  const findings = diagnoseAgent(obs({ runningVersion: '0.73.0', installedVersion: '0.74.0', publishedVersion: '0.74.0' }))
  assert.deepEqual(causes(findings), ['C6'])
  assert.equal(findings[0].code, 'stale_plugin')
  assert.equal(findings[0].fixable, false)
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

test('C7: an update inside its windows is in progress, not stuck', () => {
  const update = {
    jobDeadlineAtMs: NOW + MIN,
    validationPendingSinceMs: NOW - VALIDATION_WINDOW_MS + MIN,
    drainSinceMs: NOW - DRAIN_MAX_MS + MIN,
    stagedNeverApplied: false,
  }
  assert.deepEqual(diagnoseAgent(obs({ update })), [])
})

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

test('purity: the input is not mutated, and the same input gives the same answer', () => {
  const input = obs({ daemonAlive: false, runningVersion: '0.73.0', installedVersion: '0.74.0', agentState: freshState(), stateFresh: true })
  const frozen = JSON.stringify(input)
  const first = checkupPass(input)
  const second = checkupPass(input)
  assert.equal(JSON.stringify(input), frozen)
  assert.deepEqual(first, second)
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

// The policy is independent of busy-state guesses, versions and error combinations.
const PROBLEMS: Array<[string, Record<string, any>]> = [
  ['daemon down', { daemonAlive: false }],
  ['stale beacon', { beaconHeartbeatAtMs: NOW - BEACON_STALE_MS - 1 }],
  ['wedged', { messagesDeliveredAtMs: NOW - 30 * MIN, lastTranscriptActivityAtMs: NOW - 40 * MIN }],
  ['stale plugin', { runningVersion: '0.73.0' }],
  ['stuck update', { update: { stagedNeverApplied: true } }],
]

for (const [name, problem] of PROBLEMS) {
  test(`alive ${name}: report with Restart now for both idle and busy targets`, () => {
    for (const turnInFlight of [false, true]) {
      const pass = checkupPass(obs({ ...problem, agentState: freshState({ turnInFlight }), stateFresh: true }))
      assert.ok(pass.findings.length > 0)
      assert.ok(pass.findings.every((f) => !f.fixable))
      assert.ok(pass.actions.every((a) => a.action === 'report'))
      assert.ok(pass.actions.every((a) => a.ownerAction?.kind === 'restart' && /Restart now/.test(a.ownerAction.text)))
    }
  })
}

test('unclear process absence is reported with an owner action and never started', () => {
  for (const processState of ['unknown', null, undefined, 'unrecognized']) {
    const pass = checkupPass(obs({ processState, claudeAlive: null, daemonAlive: null }))
    assert.deepEqual(causes(pass.findings), ['C11'])
    assert.deepEqual(steps(pass.actions), ['report:planned'])
    assert.equal(pass.actions[0].code, 'process_unknown')
    assert.match(pass.actions[0].ownerAction!.text, /Restart now/)
  }
})

test('a launcher, daemon or background process without visible Claude is alive and reported', () => {
  const pass = checkupPass(obs({ processState: 'alive', claudeAlive: false, daemonAlive: false }))
  assert.deepEqual(causes(pass.findings), ['C3'])
  assert.equal(pass.findings[0].code, 'process_alive')
  assert.deepEqual(steps(pass.actions), ['report:planned'])
})

test('contradictory process observations never authorize recovery', () => {
  for (const claudeAlive of [false, true, null]) {
    for (const daemonAlive of [false, true, null]) {
      const input = obs({ processState: 'stopped', claudeAlive, daemonAlive })
      assert.equal(plannedRestart(checkupPass(input).actions), false)
    }
  }
})

test('a completely stopped target is reported with Restart now', () => {
  const pass = checkupPass(obs({ claudeAlive: false, daemonAlive: false }))
  assert.deepEqual(steps(pass.actions), ['report:planned'])
  assert.deepEqual(pass.actions[0].causes, ['C4'])
  assert.match(pass.actions[0].ownerAction!.text, /Restart now/)
})

for (const [reason, over] of [
  ['restart_rate_limited', { lastRestartAtMs: NOW - MIN }],
  ['attempts_exhausted', { attempts: MAX_ATTEMPTS_PER_TARGET }],
  ['blocked_by_login', { transcriptError: { kind: 'authentication_failed', resetAt: null } }],
  ['blocked_by_usage_limit', { transcriptError: { kind: 'rate_limit', resetAt: null } }],
  ['blocked_by_pairing', { pairingRevoked: true }],
] as const) {
  test(`stopped target: ${reason} still only reports an owner action`, () => {
    const pass = checkupPass(obs({ claudeAlive: false, daemonAlive: false, ...over }))
    assert.equal(plannedRestart(pass.actions), false)
    assert.ok(pass.actions.every((a) => a.action === 'report'))
    assert.ok(pass.actions.some((a) => a.action === 'report' && a.causes.includes('C4') && /Restart now/.test(a.ownerAction!.text)))
  })
}

test('a stopped target at the shared rate limit edge still only reports', () => {
  const pass = checkupPass(obs({ claudeAlive: false, daemonAlive: false, lastRestartAtMs: NOW - RESTART_MIN_INTERVAL_MS }))
  assert.equal(plannedRestart(pass.actions), false)
})

for (const [code, update] of [
  ['job_past_deadline', { jobDeadlineAtMs: NOW - 1 }],
  ['validation_stalled', { validationPendingSinceMs: NOW - VALIDATION_WINDOW_MS - 1 }],
  ['drain_too_long', { drainSinceMs: NOW - DRAIN_MAX_MS - 1 }],
  ['staged_not_applied', { stagedNeverApplied: true }],
] as const) {
  test(`stuck update ${code} is reported without automatic file work`, () => {
    const pass = checkupPass(obs({ update }))
    assert.equal(pass.findings[0].code, code)
    assert.deepEqual(steps(pass.actions), ['report:planned'])
  })
}

test('pairing confirmation never authorizes checkup mutations in any process state', () => {
  for (const processState of ['alive', 'unknown', 'stopped']) {
    for (const confirmed of [false, true]) {
      const pass = checkupPass(obs({ processState, claudeAlive: processState === 'alive', daemonAlive: false, pairingRevoked: true, pairingRepairConfirmed: confirmed }))
      assert.ok(pass.actions.every((a) => a.action === 'report'))
      assert.equal(plannedRestart(pass.actions), false)
      assert.equal(pass.findings.find((f) => f.cause === 'C10')!.fixable, false)
    }
  }
})

test('invariant: every process state only receives reports across all problem combinations', () => {
  let cases = 0
  for (const processState of ['alive', 'unknown', 'stopped']) {
    for (let mask = 0; mask < 1 << PROBLEMS.length; mask++) {
      for (const kind of [null, 'rate_limit', 'authentication_failed']) {
        for (const turnInFlight of [false, true]) {
          const over: Record<string, any> = { processState, claudeAlive: processState === 'alive', daemonAlive: false,
            agentState: freshState({ turnInFlight }), stateFresh: true,
            transcriptError: kind ? { kind, resetAt: null } : null }
          PROBLEMS.forEach(([, problem], i) => { if (mask & (1 << i)) Object.assign(over, problem) })
          const pass = checkupPass(obs(over))
          const label = JSON.stringify(over)
          assert.ok(steps(pass.actions).every((step) => !/restart|free_limit|update|repair/.test(step)), label)
          assert.ok(pass.actions.every((a) => a.action === 'report'), label)
          if (kind) assert.equal(plannedRestart(pass.actions), false, label)
          cases++
        }
      }
    }
  }
  assert.equal(cases, 576)
})

test('the planner reports even a legacy fixable finding', () => {
  const findings = diagnoseAgent(obs({ claudeAlive: false, daemonAlive: false }))
  const actions = planRepairs(findings.map((f) => ({ ...f, fixable: true })))
  assert.deepEqual(steps(actions), ['report:planned'])
})
