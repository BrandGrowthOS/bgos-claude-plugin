/**
 * lib/idle-update.mjs, the pure rules: an idle agent loads its staged plugin
 * update by itself (lane idleupd, board row 5a455021, Data's shape).
 *
 * Alex's Mac: 15 agents had 0.74.3 staged (pendingRestartVersion, auto update
 * on, supervised launchd) and still ran 0.69.12 to 0.74.0, because a staged
 * build loads only when the session restarts and nothing restarts an idle one.
 * Every rule of docs/idle-update/DESIGN.md is pinned here, one test per rule,
 * each one turned red by its own mutant (docs/idle-update/mutants.json).
 *
 * Run: npx tsx --test test/idle-update.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Only a missing module reads as missing; a module that does not load is a failure of its own.
const mod: any = await import('../lib/idle-update.mjs').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
  throw err
})

const MISSING =
  'lib/idle-update.mjs is missing: a staged build loads only when the session restarts, and nothing restarts an idle ' +
  'agent (the per-machine watcher is opt-in, a marketplace install never asks, a clone asks once), so the agent runs ' +
  'the old version until someone quits it'
function need(): any {
  if (!mod) assert.fail(MISSING)
  return mod
}

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Every fact idle, every guard clear: the one case that restarts. */
function idle(over: Record<string, unknown> = {}): any {
  return {
    now: NOW,
    autoUpdateEnabled: true,
    runningVersion: '0.80.0',
    stagedVersion: '0.81.0',
    active: true,
    watcherSweepActive: false,
    heldBad: false,
    authority: { kind: 'launcher', unattended: true },
    attempt: { failed: 0, lastAtMs: null, rolledBack: false, inFlight: false },
    draining: false,
    updateLockHeld: false,
    markerAgeMs: null,
    bootAtMs: NOW - 2 * HOUR,
    startupComplete: true,
    safe: { turnInFlight: false, turnSignal: 'hooks', pendingMessages: 0, pendingPermissions: 0, activeOperations: 0 },
    openAsks: 0,
    goalRunning: false,
    call: { pendingConsults: 0, openContinuations: 0, lastVoiceAtMs: null, openMeetings: 0 },
    lastBrowserToolAtMs: null,
    personAttached: false,
    activityMs: [NOW - 40 * MIN],
    jitterMs: 5 * MIN,
    machine: { lease: 'free', spacingUntilMs: null, canary: 'none' },
    claudeKnown: true,
    descendants: [],
    serviceStrays: { ok: true, strays: [] },
    wake: { known: true, nextDueAtMs: null },
    ...over,
  }
}

function decide(over: Record<string, unknown> = {}): { action: string; reason: string } {
  return need().decideIdleUpdate(idle(over))
}

function waits(over: Record<string, unknown>, reason: string): void {
  assert.deepEqual(decide(over), { action: 'wait', reason })
}

// -- Version order -------------------------------------------------------------------------------

test('version order: numeric X.Y.Z, so 0.80.10 is newer than 0.80.9 (a text compare says the opposite)', () => {
  const m = need()
  assert.equal(m.compareVersions('0.80.10', '0.80.9'), 1)
  assert.equal(m.compareVersions('0.80.0', '0.81.0'), -1)
  assert.equal(m.compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(m.compareVersions('v1.0.0', '1.0.0'), null)
  assert.equal(m.compareVersions('0.81', '0.80.0'), null)
  assert.equal(m.compareVersions(null, '0.80.0'), null)
  assert.equal(m.isNewerVersion('0.81.0', '0.80.0'), true)
  assert.equal(m.isNewerVersion('0.80.0', '0.80.0'), false)
  assert.equal(m.isNewerVersion('0.79.9', '0.80.0'), false)
  assert.equal(m.isNewerVersion('junk', '0.80.0'), false)
})

// -- Durations, scale and jitter -----------------------------------------------------------------

const RIG_BACKEND = { backendUrl: 'http://127.0.0.1:43561/api/v1' }

test('scale: unset, junk, zero and negative read as 1; the rig scale is clamped to 600', () => {
  const m = need()
  for (const raw of [undefined, '', 'fast', '0', '-5', 'NaN']) assert.equal(m.scaleFromEnv(raw, RIG_BACKEND), 1, String(raw))
  assert.equal(m.scaleFromEnv('60', RIG_BACKEND), 60)
  assert.equal(m.scaleFromEnv('100000', RIG_BACKEND), 600)
})

test('scale: honoured only against a loopback backend, so a real agent can never shrink its safety windows', () => {
  const m = need()
  assert.equal(m.scaleFromEnv('60', { backendUrl: 'https://api.bgos.ai/api/v1' }), 1)
  assert.equal(m.scaleFromEnv('60', { backendUrl: 'http://127.0.0.1.example.com/api/v1' }), 1)
  assert.equal(m.scaleFromEnv('60', { backendUrl: 'not a url' }), 1)
  assert.equal(m.scaleFromEnv('60'), 1)
  assert.equal(m.scaleFromEnv('60', { backendUrl: 'http://localhost:4000/api/v1' }), 60)
  assert.equal(m.scaleFromEnv('60', { backendUrl: 'http://[::1]:4000/api/v1' }), 60)
})

test('scaled durations divide every duration by the scale and carry the scale itself', () => {
  const m = need()
  const d = m.scaledDurations(60)
  assert.equal(d.scale, 60)
  assert.equal(d.leaseTtlMs, m.DEFAULT_DURATIONS.leaseTtlMs / 60)
  assert.equal(d.minUpMs, SEC)
  assert.equal(m.scaledDurations(1).leaseTtlMs, 10 * MIN)
})

test('scaled durations keep two floors: a relaunch gets its real 3.5 min to arrive, and a beacon 30 s to be fresh', () => {
  const m = need()
  assert.equal(m.scaledDurations(60).didNotArriveMs, 3.5 * MIN)
  assert.equal(m.scaledDurations(60).beaconFreshMs, 30 * SEC)
  assert.equal(m.scaledDurations(2).beaconFreshMs, MIN)
})

test('jitter is a uniform 0 to 10 min draw, a broken random reads as the midpoint, and it varies with the draw', () => {
  const m = need()
  assert.equal(m.drawJitterMs(0), 0)
  assert.equal(m.drawJitterMs(1), 10 * MIN)
  assert.equal(m.drawJitterMs(0.5), 5 * MIN)
  assert.equal(m.drawJitterMs(Number.NaN), 5 * MIN)
  assert.notEqual(m.drawJitterMs(0.1), m.drawJitterMs(0.9))
  assert.equal(m.drawJitterMs(1, m.scaledDurations(60)), 10 * SEC)
})

test('back-off: none before a failure, 24 h after the first, doubling, capped at 7 days', () => {
  const m = need()
  assert.equal(m.attemptBackoffMs(0), 0)
  assert.equal(m.attemptBackoffMs(1), DAY)
  assert.equal(m.attemptBackoffMs(2), 2 * DAY)
  assert.equal(m.attemptBackoffMs(3), 4 * DAY)
  assert.equal(m.attemptBackoffMs(10), 7 * DAY)
})

// -- The gates, one test per rule ----------------------------------------------------------------

test('idle with a newer build staged, an unattended authority and every guard clear: restart', () => {
  assert.deepEqual(decide(), { action: 'restart', reason: 'idle' })
})

test('gate 1: BGOS_AUTO_UPDATE off never restarts, whatever else holds', () => {
  assert.deepEqual(decide({ autoUpdateEnabled: false }), { action: 'off', reason: 'updates_disabled' })
  assert.deepEqual(decide({ autoUpdateEnabled: false, active: false }), { action: 'off', reason: 'updates_disabled' })
})

test('gate 2: nothing staged, the same version, an older one or an unreadable one is not an update', () => {
  for (const stagedVersion of [null, '0.80.0', '0.79.9', '0.81', 'garbage']) {
    assert.deepEqual(decide({ stagedVersion }), { action: 'off', reason: 'nothing_staged' }, String(stagedVersion))
  }
  assert.deepEqual(decide({ runningVersion: null }), { action: 'off', reason: 'nothing_staged' })
})

test('gate 3: only the pairing lock holder acts, never a passive or shutting daemon', () => {
  waits({ active: false }, 'passive')
})

test('gate 4: where the watcher sweep is active on this HOME, it owns updates and this controller stands down', () => {
  waits({ watcherSweepActive: true }, 'watcher_owns_updates')
})

test('gate 5: a version latched bad on this computer is never restarted onto', () => {
  waits({ heldBad: true }, 'version_held_bad')
})

test('gate 6: staged or unproven authority, or a launch not proven unattended, never restarts', () => {
  waits({ authority: { kind: 'staged', unattended: false } }, 'no_unattended_authority')
  waits({ authority: { kind: 'launcher', unattended: false } }, 'no_unattended_authority')
  waits({ authority: { kind: 'service', unattended: false } }, 'no_unattended_authority')
  assert.equal(decide({ authority: { kind: 'keepalive', unattended: true } }).action, 'restart')
  assert.equal(decide({ authority: { kind: 'service', unattended: true } }).action, 'restart')
})

test('gate 7: one attempt per version, then a back-off of 24 h that doubles; a rolled back version never again', () => {
  waits({ attempt: { failed: 1, lastAtMs: NOW - 23 * HOUR, rolledBack: false, inFlight: false } }, 'attempted')
  assert.equal(decide({ attempt: { failed: 1, lastAtMs: NOW - 25 * HOUR, rolledBack: false, inFlight: false } }).action, 'restart')
  waits({ attempt: { failed: 2, lastAtMs: NOW - 25 * HOUR, rolledBack: false, inFlight: false } }, 'attempted')
  waits({ attempt: { failed: 1, lastAtMs: NOW - 90 * DAY, rolledBack: true, inFlight: false } }, 'attempted')
  waits({ attempt: { failed: 0, lastAtMs: NOW - 90 * DAY, rolledBack: false, inFlight: true } }, 'attempted')
})

test('gate 8: never while draining, while the update lock is held, or while a restart marker waits', () => {
  waits({ draining: true }, 'update_in_flight')
  waits({ updateLockHeld: true }, 'update_in_flight')
  waits({ markerAgeMs: 1 * MIN }, 'update_in_flight')
})

test('gate 8: a marker hoai has not taken in 5 min is a launcher that stopped taking markers, said as such', () => {
  waits({ markerAgeMs: 6 * MIN }, 'launcher_latched')
})

test('gate 9: never in the first minute of a daemon', () => {
  waits({ bootAtMs: NOW - 30 * SEC, activityMs: [] }, 'young')
})

test('gate 20: a restart through a systemd unit ends its whole cgroup, so a stray job in it waits, and an unreadable group waits', () => {
  waits({ serviceStrays: { ok: true, strays: [4242] } }, 'background_job')
  waits({ serviceStrays: { ok: false, strays: [] } }, 'process_tree_unreadable')
  assert.equal(decide({ serviceStrays: { ok: true, strays: [] } }).action, 'restart')
})

test('gates in their order: a turn is named before an open ask and a person (gate 10 comes first)', () => {
  waits({ safe: { ...idle().safe, turnInFlight: true }, activityMs: [NOW - 5 * MIN], openAsks: 1, personAttached: true }, 'turn_in_flight')
})

test('gate 9: never before this daemon\'s own startup completed (a startup that hangs is no moment to restart)', () => {
  waits({ startupComplete: false }, 'young')
  waits({ startupComplete: undefined }, 'young')
})

test('gate 10: a turn in flight waits (the watcher safe moment)', () => {
  waits({ safe: { ...idle().safe, turnInFlight: true } }, 'turn_in_flight')
})

test('gate 10: an owed reply, a permission card or an operation in flight waits', () => {
  waits({ safe: { ...idle().safe, pendingMessages: 1 } }, 'pending_messages')
  waits({ safe: { ...idle().safe, pendingPermissions: 1 } }, 'pending_permission')
  waits({ safe: { ...idle().safe, activeOperations: 1 } }, 'pending_messages')
})

test('gate 10: a turn flag nothing backed for 2 h is stale, exactly as the watcher reads it', () => {
  assert.deepEqual(decide({ safe: { ...idle().safe, turnInFlight: true }, activityMs: [NOW - 3 * HOUR], bootAtMs: NOW - 4 * HOUR }), {
    action: 'restart',
    reason: 'stale_turn',
  })
})

test('gate 11: an open ask or plan card waits', () => {
  waits({ openAsks: 1 }, 'open_ask')
})

test('gate 12: a running goal waits', () => {
  waits({ goalRunning: true }, 'goal_running')
})

test('gate 13: a call waits: a consult owed, a provisional answer open, a voice frame in the last 30 min, a meeting', () => {
  const call = idle().call
  waits({ call: { ...call, pendingConsults: 1 } }, 'call_active')
  waits({ call: { ...call, openContinuations: 1 } }, 'call_active')
  waits({ call: { ...call, lastVoiceAtMs: NOW - 29 * MIN } }, 'call_active')
  waits({ call: { ...call, openMeetings: 1 } }, 'call_active')
  assert.equal(decide({ call: { ...call, lastVoiceAtMs: NOW - 31 * MIN } }).action, 'restart')
})

test('gate 14: a browser tool used in the last 30 min waits (the browser host dies with the daemon)', () => {
  waits({ lastBrowserToolAtMs: NOW - 29 * MIN }, 'browser_in_use')
  assert.equal(decide({ lastBrowserToolAtMs: NOW - 31 * MIN }).action, 'restart')
})

test('gate 15: a person attached to the agent session waits, and an unreadable reading counts as attached', () => {
  waits({ personAttached: true }, 'person_attached')
  waits({ personAttached: null }, 'person_attached')
})

test('gate 16: activity inside the quiet window waits: 10 min with the hook signal, 30 without', () => {
  waits({ activityMs: [NOW - 9 * MIN] }, 'recent_activity')
  waits({ activityMs: [NOW - 29 * MIN], safe: { ...idle().safe, turnSignal: 'none' } }, 'recent_activity')
})

test('gate 16: no hook signal never restarts: the daemon cannot see a turn, so no amount of quiet proves one is not running', () => {
  const blind = { safe: { ...idle().safe, turnSignal: 'none' } }
  // A long tool call writes no transcript line and fires no hook this daemon sees: it reads as quiet.
  waits({ ...blind, activityMs: [NOW - 50 * MIN] }, 'no_turn_signal')
  waits({ ...blind, activityMs: [NOW - 7 * DAY], bootAtMs: NOW - 8 * DAY }, 'no_turn_signal')
  // A state that does not say is no signal.
  waits({ safe: { ...idle().safe, turnSignal: undefined }, activityMs: [NOW - 50 * MIN] }, 'no_turn_signal')
  assert.equal(decide({ activityMs: [NOW - 50 * MIN] }).action, 'restart')
})

test('gate 16: no_turn_signal says so only at the moment the old 30 min rule would have restarted: a fresh boot is no alarm', () => {
  const blind = { safe: { ...idle().safe, turnSignal: 'none' } }
  waits({ ...blind, activityMs: [NOW - 29 * MIN], bootAtMs: NOW - 2 * HOUR }, 'recent_activity')
  waits({ ...blind, activityMs: [], bootAtMs: NOW - 12 * MIN }, 'recent_activity')
  waits({ ...blind, activityMs: [NOW - 31 * MIN], bootAtMs: NOW - 2 * HOUR }, 'no_turn_signal')
})

test('gate 17: quiet, but this agent\'s jitter has not run out, so fifteen agents never leave together', () => {
  waits({ activityMs: [NOW - 12 * MIN], jitterMs: 5 * MIN }, 'jitter')
  assert.equal(decide({ activityMs: [NOW - 16 * MIN], jitterMs: 5 * MIN }).action, 'restart')
  // Boot is activity too, so a daemon with no other stamp still waits out window plus jitter.
  waits({ activityMs: [], bootAtMs: NOW - 12 * MIN, jitterMs: 5 * MIN }, 'jitter')
})

test('gate 18: another agent on this computer holds the restart lease, or released it under 2 min ago', () => {
  waits({ machine: { lease: 'held', spacingUntilMs: null, canary: 'none' } }, 'machine_busy')
  waits({ machine: { lease: 'free', spacingUntilMs: NOW + 1 * MIN, canary: 'none' } }, 'spacing')
  assert.equal(decide({ machine: { lease: 'free', spacingUntilMs: NOW - 1, canary: 'none' } }).action, 'restart')
})

test('gate 19: the first agent onto a version is its canary, and the rest wait until it confirms', () => {
  waits({ machine: { lease: 'free', spacingUntilMs: null, canary: 'pending' } }, 'canary_unconfirmed')
  waits({ machine: { lease: 'free', spacingUntilMs: null, canary: 'hold' } }, 'canary_unconfirmed')
  waits({ machine: { lease: 'free', spacingUntilMs: null, canary: 'latch_bad' } }, 'version_held_bad')
  for (const canary of ['none', 'validated', 'next', 'mine']) {
    assert.equal(decide({ machine: { lease: 'free', spacingUntilMs: null, canary } }).action, 'restart', canary)
  }
})

test('gate 20: a background job under claude, or a tree that cannot be read, waits', () => {
  waits({ descendants: ['/bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1.sh && npm run dev'] }, 'background_job')
  waits({ descendants: null }, 'process_tree_unreadable')
  waits({ claudeKnown: false }, 'process_tree_unreadable')
})

test('gate 21: a wake or call due within 10 min waits, and an unreadable schedule fails closed', () => {
  waits({ wake: { known: true, nextDueAtMs: NOW + 9 * MIN } }, 'wake_due')
  waits({ wake: { known: true, nextDueAtMs: NOW - 1 * MIN } }, 'wake_due')
  waits({ wake: { known: false, nextDueAtMs: null } }, 'wake_schedule_unknown')
  assert.equal(decide({ wake: { known: true, nextDueAtMs: NOW + 11 * MIN } }).action, 'restart')
})

test('the scale shrinks every window for the rig, the safe moment included, and nothing else', () => {
  const m = need()
  const d = m.scaledDurations(60)
  const f = idle({ activityMs: [NOW - 20 * SEC], jitterMs: 2 * SEC, bootAtMs: NOW - 5 * MIN })
  assert.deepEqual(m.decideIdleUpdate(f, d), { action: 'restart', reason: 'idle' })
  assert.deepEqual(m.decideIdleUpdate({ ...f, activityMs: [NOW - 5 * SEC] }, d), { action: 'wait', reason: 'recent_activity' })
  assert.deepEqual(m.decideIdleUpdate(f), { action: 'wait', reason: 'recent_activity' })
})

// -- Lease and canary ----------------------------------------------------------------------------

const ME = { assistantId: '912', nonce: 'n-912' }

test('lease: none is free, my own nonce is mine, a fresh other is held, an old one is expired', () => {
  const m = need()
  const lease = (assistantId: string, nonce: string, at: number) => JSON.stringify({ assistantId, target: '0.81.0', nonce, at: new Date(at).toISOString() })
  assert.equal(m.decideLease({ raw: null, mtimeMs: null, now: NOW, me: ME }).state, 'free')
  assert.equal(m.decideLease({ raw: lease('912', 'n-912', NOW - MIN), mtimeMs: NOW - MIN, now: NOW, me: ME }).state, 'mine')
  assert.equal(m.decideLease({ raw: lease('912', 'other', NOW - MIN), mtimeMs: NOW - MIN, now: NOW, me: ME }).state, 'held')
  assert.equal(m.decideLease({ raw: lease('913', 'n-913', NOW - 9 * MIN), mtimeMs: NOW - 9 * MIN, now: NOW, me: ME }).state, 'held')
  assert.equal(m.decideLease({ raw: lease('913', 'n-913', NOW - 11 * MIN), mtimeMs: NOW - 11 * MIN, now: NOW, me: ME }).state, 'expired')
})

test('lease and canary: a stamp more than the lease life in the future is a broken clock, so it expires', () => {
  const m = need()
  const future = JSON.stringify({ assistantId: '913', target: '0.81.0', nonce: 'n-913', at: new Date(NOW + DAY).toISOString() })
  assert.equal(m.decideLease({ raw: future, mtimeMs: NOW + DAY, now: NOW, me: ME }).state, 'expired')
  const near = JSON.stringify({ assistantId: '913', target: '0.81.0', nonce: 'n-913', at: new Date(NOW + 30 * SEC).toISOString() })
  assert.equal(m.decideLease({ raw: near, mtimeMs: NOW, now: NOW, me: ME }).state, 'held')
  const ahead = [{ n: 1, assistantId: '913', at: NOW + DAY }]
  assert.deepEqual(m.decideCanary({ files: { canaries: ahead, voids: [], validated: false, bad: false }, now: NOW, me: ME }), { state: 'next', next: 2 })
})

test('lease: a half written file is held while young and expired once old, never free', () => {
  const m = need()
  assert.equal(m.decideLease({ raw: '', mtimeMs: NOW - 5 * SEC, now: NOW, me: ME }).state, 'held')
  assert.equal(m.decideLease({ raw: '{"assist', mtimeMs: NOW - 11 * MIN, now: NOW, me: ME }).state, 'expired')
  assert.equal(m.decideLease({ raw: '', mtimeMs: null, now: NOW, me: ME }).state, 'held')
})

function canaryFiles(over: Record<string, unknown> = {}): any {
  return { canaries: [], voids: [], validated: false, bad: false, ...over }
}

test('canary: no canary yet means I would be canary 1', () => {
  assert.deepEqual(need().decideCanary({ files: canaryFiles(), now: NOW, me: ME }), { state: 'none', next: 1 })
})

test('canary: a validated version lets everyone go; a bad one holds everyone', () => {
  const m = need()
  assert.equal(m.decideCanary({ files: canaryFiles({ validated: true, canaries: [{ n: 1, assistantId: '913', at: NOW - MIN }] }), now: NOW, me: ME }).state, 'validated')
  assert.equal(m.decideCanary({ files: canaryFiles({ bad: true, validated: true }), now: NOW, me: ME }).state, 'bad')
})

test('canary: another agent restarting onto it now is pending; my own is mine', () => {
  const m = need()
  assert.equal(m.decideCanary({ files: canaryFiles({ canaries: [{ n: 1, assistantId: '913', at: NOW - 3 * MIN }] }), now: NOW, me: ME }).state, 'pending')
  assert.deepEqual(m.decideCanary({ files: canaryFiles({ canaries: [{ n: 1, assistantId: '912', at: NOW - 3 * MIN }] }), now: NOW, me: ME }), { state: 'mine', n: 1 })
})

test('canary: an attempt that ended with no verdict (not the build\'s fault) hands the canary to the next agent', () => {
  const m = need()
  assert.deepEqual(m.decideCanary({ files: canaryFiles({ canaries: [{ n: 1, assistantId: '913', at: NOW - 3 * MIN }], voids: [1] }), now: NOW, me: ME }), { state: 'next', next: 2 })
})

test('canary: one that never came back holds the version 24 h, then one more agent may try', () => {
  const m = need()
  const silent = [{ n: 1, assistantId: '913', at: NOW - 11 * MIN }]
  assert.equal(m.decideCanary({ files: canaryFiles({ canaries: silent }), now: NOW, me: ME }).state, 'hold')
  assert.deepEqual(
    m.decideCanary({ files: canaryFiles({ canaries: [{ n: 1, assistantId: '913', at: NOW - 25 * HOUR }] }), now: NOW, me: ME }),
    { state: 'next', next: 2 },
  )
})

test('canary: two that never came back latch the version bad, so a silent killer costs at most two agents', () => {
  const m = need()
  const two = [{ n: 1, assistantId: '913', at: NOW - 3 * DAY }, { n: 2, assistantId: '914', at: NOW - 91 * MIN }]
  assert.equal(m.decideCanary({ files: canaryFiles({ canaries: two }), now: NOW, me: ME }).state, 'latch_bad')
})

test('canary: a second canary past its lease may still be validating (a slow start, an outage forgiven): it holds, it is not latched', () => {
  const m = need()
  const two = [{ n: 1, assistantId: '913', at: NOW - 3 * DAY }, { n: 2, assistantId: '914', at: NOW - 30 * MIN }]
  assert.equal(m.decideCanary({ files: canaryFiles({ canaries: two }), now: NOW, me: ME }).state, 'hold')
  assert.equal(m.DEFAULT_DURATIONS.canarySilentMs, 90 * MIN, 'past the startup bound, an hour of outage and the deadline')
})

// -- The record ----------------------------------------------------------------------------------

function record(over: Record<string, unknown> = {}): any {
  return {
    schema: 1,
    target: '0.81.0',
    from: '0.80.0',
    fromRoot: '/c/plugins/cache/hoai/hoai/0.80.0',
    fromCommit: null,
    installMethod: 'marketplace',
    pin: 'pin-1',
    nonce: 'n-912',
    canaryN: 1,
    state: 'requested',
    attempts: [{ at: new Date(NOW - 10 * MIN).toISOString(), outcome: 'requested' }],
    lockBoots: 0,
    arrivedAt: null,
    validatedAt: null,
    contextLost: false,
    reportedAt: null,
    ...over,
  }
}

test('record: it round trips, and junk or another schema reads as none', () => {
  const m = need()
  assert.deepEqual(m.parseIdleUpdateRecord(JSON.stringify(record())), record())
  assert.equal(m.parseIdleUpdateRecord('{"schema":2}'), null)
  assert.equal(m.parseIdleUpdateRecord('nope'), null)
  assert.equal(m.parseIdleUpdateRecord(null), null)
})

test('record: a target or from that is not a plain X.Y.Z is junk, so it can never name a folder', () => {
  const m = need()
  assert.equal(m.parseIdleUpdateRecord(JSON.stringify(record({ target: '../../x' }))), null)
  assert.equal(m.parseIdleUpdateRecord(JSON.stringify(record({ from: '0.80.0/..' }))), null)
  assert.equal(m.parseIdleUpdateRecord(JSON.stringify(record({ from: null }))), null)
})

test('record: the attempt facts for the staged version, and nothing for another version', () => {
  const m = need()
  const failed = record({ state: 'did_not_arrive', attempts: [{ at: new Date(NOW - HOUR).toISOString(), outcome: 'did_not_arrive' }] })
  assert.deepEqual(m.attemptFactsFor(failed, '0.81.0'), { failed: 1, lastAtMs: NOW - HOUR, rolledBack: false, inFlight: false })
  assert.deepEqual(m.attemptFactsFor(failed, '0.82.0'), { failed: 0, lastAtMs: null, rolledBack: false, inFlight: false })
  assert.equal(m.attemptFactsFor(record(), '0.81.0').inFlight, true)
  assert.equal(m.attemptFactsFor(record({ state: 'rolled_back' }), '0.81.0').rolledBack, true)
  assert.deepEqual(m.attemptFactsFor(null, '0.81.0'), { failed: 0, lastAtMs: null, rolledBack: false, inFlight: false })
})

test('boot settle: the session came back on the target with the same pin: arrived, first lock holding boot', () => {
  const { record: next, event } = need().settleRecordAtBoot(record(), { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(event, 'arrived')
  assert.equal(next.state, 'arrived')
  assert.equal(next.lockBoots, 1)
  assert.equal(next.arrivedAt, new Date(NOW).toISOString())
  assert.equal(next.contextLost, false)
})

test('boot settle: on the target with a NEW pin, the conversation was lost: said, and counted as failed', () => {
  const m = need()
  const { record: next, event } = m.settleRecordAtBoot(record(), { runningVersion: '0.81.0', pin: 'pin-2', now: NOW })
  assert.equal(event, 'context_lost')
  assert.equal(next.state, 'arrived')
  assert.equal(next.contextLost, true)
  assert.equal(m.attemptFactsFor(next, '0.81.0').failed, 1)
})

test('boot settle: the session came back on the old version: came_back_old, a failed attempt', () => {
  const m = need()
  const { record: next, event } = m.settleRecordAtBoot(record(), { runningVersion: '0.80.0', pin: 'pin-1', now: NOW })
  assert.equal(event, 'came_back_old')
  assert.equal(next.state, 'came_back_old')
  assert.equal(m.attemptFactsFor(next, '0.81.0').failed, 1)
})

test('boot settle: a second lock holding boot of the target before it validated is a failed new build', () => {
  const arrived = record({ state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString() })
  const { record: next, event } = need().settleRecordAtBoot(arrived, { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(event, 'second_boot')
  assert.equal(next.lockBoots, 2)
})

test('boot settle: a second boot resets the arrival, so a held deadline counts from the boot that is running', () => {
  const arrived = record({ state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString() })
  const { record: next } = need().settleRecordAtBoot(arrived, { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(next.arrivedAt, new Date(NOW).toISOString())
})

test('boot settle: a build that already proved live may boot once more (a person\'s restart, a reconnect) before it is called failing', () => {
  const m = need()
  const live = record({ state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString(), liveAt: new Date(NOW - 3 * MIN).toISOString() })
  const again = m.settleRecordAtBoot(live, { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(again.event, 'arrived_again')
  assert.equal(again.record.lockBoots, 2)
  assert.equal(again.record.arrivedAt, new Date(NOW).toISOString())
  assert.equal(again.record.liveAt, null)
  assert.equal(again.record.rearrived, true)
  const third = m.settleRecordAtBoot({ ...again.record, liveAt: new Date(NOW + MIN).toISOString() }, { runningVersion: '0.81.0', pin: 'pin-1', now: NOW + 2 * MIN })
  assert.equal(third.event, 'second_boot', 'one re-arrival, never a loop')
  const never = m.settleRecordAtBoot(record({ state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString() }), { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(never.event, 'second_boot', 'a build that never proved live gets no second chance')
})

test('boot settle: a boot whose predecessor ended cleanly (its claude went away: hoai relaunching a slow start, a person, a computer shut down overnight) is a re-arrival, once', () => {
  const m = need()
  const base = { state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString() }
  const ended = m.settleRecordAtBoot(record({ ...base, endedAt: new Date(NOW - 40 * SEC).toISOString() }), { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(ended.event, 'arrived_again')
  assert.equal(ended.record.rearrived, true)
  assert.equal(ended.record.endedAt, null)
  assert.equal(ended.record.lockBoots, 2)
  assert.equal(ended.record.arrivedAt, new Date(NOW).toISOString())
  // A clean stop is a clean stop whenever the next boot comes: the computer shut down, the agent started next morning.
  const long = m.settleRecordAtBoot(record({ ...base, endedAt: new Date(NOW - 9 * HOUR).toISOString() }), { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(long.event, 'arrived_again', 'a clean end hours before this boot')
  const twice = m.settleRecordAtBoot({ ...ended.record, endedAt: new Date(NOW + 30 * SEC).toISOString() }, { runningVersion: '0.81.0', pin: 'pin-1', now: NOW + MIN })
  assert.equal(twice.event, 'second_boot', 'one re-arrival per record, never a loop')
})

test('boot settle: a new session drops the clean end and the live proof of the boot before it, so a crash on that session is a failed build', () => {
  const m = need()
  const proofs = { endedAt: new Date(NOW - MIN).toISOString(), liveAt: new Date(NOW - 2 * MIN).toISOString() }
  for (const proof of ['endedAt', 'liveAt'] as const) {
    const base = { state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString(), [proof]: proofs[proof] }
    for (const contextLost of [false, true]) {
      const lost = m.settleRecordAtBoot(record({ ...base, contextLost }), { runningVersion: '0.81.0', pin: 'pin-2', now: NOW })
      assert.equal(lost.event, 'context_lost')
      assert.equal(lost.record[proof], null, `${proof}, contextLost=${contextLost}: it was the boot before's`)
      // The context_lost boot crashed (no proof of its own); hoai relaunched it on the same new session.
      const next = m.settleRecordAtBoot(lost.record, { runningVersion: '0.81.0', pin: 'pin-2', now: NOW + 3 * MIN })
      assert.equal(next.event, 'second_boot', `${proof}, contextLost=${contextLost}`)
    }
  }
})

test('a record is superseded by another attempt, a later boot\'s settle or a verdict given since, never by an older state of its own attempt', () => {
  const m = need()
  const mine = { nonce: 'n1', target: '0.81.0', state: 'arrived', arrivedAt: new Date(NOW).toISOString(), attempts: [{ at: new Date(NOW - 5 * MIN).toISOString(), outcome: 'requested' }] }
  assert.equal(m.isRecordSuperseded(mine, { ...mine }), false, 'the same record')
  assert.equal(m.isRecordSuperseded(mine, { ...mine, liveAt: new Date(NOW + MIN).toISOString() }), false, 'its own later write')
  assert.equal(m.isRecordSuperseded(mine, { ...mine, nonce: 'n2', target: '0.82.0', state: 'requested', arrivedAt: undefined }), true, 'another attempt')
  assert.equal(m.isRecordSuperseded(mine, { ...mine, arrivedAt: new Date(NOW + 2 * MIN).toISOString(), contextLost: true }), true, 'a later boot settled it')
  assert.equal(m.isRecordSuperseded(mine, { ...mine, state: 'requested', arrivedAt: undefined }), false, 'a disk that refused the settle holds the older state')
  assert.equal(m.isRecordSuperseded(mine, { ...mine, arrivedAt: new Date(NOW - MIN).toISOString() }), false, 'an older settle of its own attempt')
  // The same boot's attempt given its verdict, or a failed attempt appended, by another daemon that held the lock since.
  for (const state of ['validated', 'failed', 'came_back_old', 'rolled_back', 'rollback_failed']) {
    assert.equal(m.isRecordSuperseded(mine, { ...mine, state }), true, `a verdict on disk: ${state}`)
  }
  assert.equal(m.isRecordSuperseded(mine, { ...mine, attempts: [...mine.attempts, { at: new Date(NOW + MIN).toISOString(), outcome: 'deadline' }] }), true, 'a failed attempt appended')
  assert.equal(m.isRecordSuperseded({ ...mine, state: 'validated' }, { ...mine, state: 'validated' }), false, 'its own verdict')
  assert.equal(m.isRecordSuperseded(mine, { ...mine, attempts: [] }), false, 'a disk that refused an attempt holds fewer')
  assert.equal(m.isRecordSuperseded(mine, null), false, 'nothing readable: keep acting')
  assert.equal(m.isRecordSuperseded(null, mine), false)
})

test('boot settle: an end time that does not read as a time is no clean end', () => {
  const m = need()
  const base = { state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString() }
  for (const endedAt of ['', 'yesterday', 'not a time']) {
    const next = m.settleRecordAtBoot(record({ ...base, endedAt }), { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
    assert.equal(next.event, 'second_boot', JSON.stringify(endedAt))
  }
})

test('boot settle: a predecessor that only polled recently (no clean end on record: it crashed or hung) is a failed build', () => {
  const m = need()
  const base = { state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString() }
  const polled = m.settleRecordAtBoot(record({ ...base, aliveAt: new Date(NOW - 40 * SEC).toISOString() }), { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(polled.event, 'second_boot')
})

test('boot settle: the target booting again on a NEW session is a lost conversation, never a reason to roll back', () => {
  // hoai retries a resume that died inside 25 s as a fresh session: claude's
  // fault or the transcript's, not the build's. The new pin is kept, so the
  // next boot on it (hoai's no-channel-heartbeat relaunch) still counts.
  const m = need()
  const arrived = record({ state: 'arrived', lockBoots: 1, arrivedAt: new Date(NOW - 4 * MIN).toISOString() })
  const { record: next, event } = m.settleRecordAtBoot(arrived, { runningVersion: '0.81.0', pin: 'pin-2', now: NOW })
  assert.equal(event, 'context_lost')
  assert.equal(next.state, 'arrived')
  assert.equal(next.pin, 'pin-2')
  assert.equal(next.pinBefore, 'pin-1')
  assert.equal(next.lockBoots, 1)
  assert.equal(next.arrivedAt, new Date(NOW).toISOString())
  assert.equal(m.settleRecordAtBoot(next, { runningVersion: '0.81.0', pin: 'pin-2', now: NOW + MIN }).event, 'second_boot')
})

test('boot settle: an unknown pin at boot is never read as a lost conversation', () => {
  const m = need()
  assert.equal(m.settleRecordAtBoot(record(), { runningVersion: '0.81.0', pin: null, now: NOW }).event, 'arrived')
})

test('boot settle: the target booting AGAIN after a rollback is rollback_failed, said once, never a second rollback', () => {
  const m = need()
  const rolled = record({ state: 'rolled_back' })
  const { record: next, event } = m.settleRecordAtBoot(rolled, { runningVersion: '0.81.0', pin: 'pin-1', now: NOW })
  assert.equal(event, 'rollback_failed')
  assert.equal(next.state, 'rollback_failed')
  assert.equal(m.settleRecordAtBoot(next, { runningVersion: '0.81.0', pin: 'pin-1', now: NOW }).event, 'none')
})

test('boot settle: back on the old version after a rollback: reported once', () => {
  const m = need()
  const { record: next, event } = m.settleRecordAtBoot(record({ state: 'rolled_back' }), { runningVersion: '0.80.0', pin: 'pin-1', now: NOW })
  assert.equal(event, 'rolled_back')
  assert.equal(next.reportedAt, new Date(NOW).toISOString())
  assert.equal(m.settleRecordAtBoot(next, { runningVersion: '0.80.0', pin: 'pin-1', now: NOW }).event, 'none')
})

test('boot settle: a validated record, or none, does nothing', () => {
  const m = need()
  assert.equal(m.settleRecordAtBoot(null, { runningVersion: '0.81.0', pin: 'p', now: NOW }).event, 'none')
  assert.equal(m.settleRecordAtBoot(record({ state: 'validated' }), { runningVersion: '0.81.0', pin: 'p', now: NOW }).event, 'none')
})

// -- Validation and rollback ---------------------------------------------------------------------

function proof(over: Record<string, unknown> = {}): any {
  const p: any = {
    arrivedAtMs: NOW - 2 * MIN,
    now: NOW,
    startupComplete: true,
    heartbeatOkAtMs: NOW - 30 * SEC,
    beaconAtMs: NOW - 10 * SEC,
    deaf: false,
    loginExpired: false,
    liveSinceMs: NOW - 60 * SEC,
    ...over,
  }
  // Unless a case says otherwise, this boot's startup completed the moment it arrived.
  if (!('startupCompleteAtMs' in over)) p.startupCompleteAtMs = p.arrivedAtMs
  return p
}

test('validation: startup complete, a heartbeat at the new version, a live beacon, no deaf verdict, 60 s held', () => {
  assert.equal(need().decideValidation(proof()), 'validated')
})

test('validation: each missing proof keeps it pending (a deaf build never validates)', () => {
  const m = need()
  for (const over of [
    { startupComplete: false },
    { heartbeatOkAtMs: null },
    { beaconAtMs: null },
    { beaconAtMs: NOW - 3 * MIN },
    // Touched during the hold, but not since: the build went deaf after it.
    { arrivedAtMs: NOW - 4 * MIN, liveSinceMs: NOW - 3 * MIN, beaconAtMs: NOW - 150 * SEC },
    { deaf: true },
    { arrivedAtMs: NOW - 30 * SEC },
    { liveSinceMs: null },
    { liveSinceMs: NOW - 59 * SEC },
  ]) {
    assert.equal(m.decideValidation(proof(over)), 'pending', JSON.stringify(over))
  }
})

test('validation: no proof 5 min after a live boot is the deadline, unless the shared login has expired', () => {
  const m = need()
  assert.equal(m.decideValidation(proof({ arrivedAtMs: NOW - 6 * MIN, beaconAtMs: null })), 'deadline')
  assert.equal(m.decideValidation(proof({ arrivedAtMs: NOW - 6 * MIN, beaconAtMs: null, loginExpired: true })), 'pending')
})

test('validation: an unreachable backend holds the deadline, and the time it was unreachable or asleep is not counted', () => {
  const m = need()
  const late = { arrivedAtMs: NOW - 6 * MIN, beaconAtMs: null }
  assert.equal(m.decideValidation(proof({ ...late, backendUnreachable: true })), 'pending')
  assert.equal(m.decideValidation(proof({ ...late, suspendedMs: 2 * MIN })), 'pending')
  assert.equal(m.decideValidation(proof({ ...late, suspendedMs: 30 * SEC })), 'deadline')
})

test('outage: an answer below 500 is a backend that answered; a 5xx, or no answer at all (null), is one this computer cannot reach', () => {
  const m = need()
  for (const status of [200, 204, 304, 401, 404, 429]) assert.equal(m.isBackendAnswer(status), true, String(status))
  for (const status of [500, 502, 503, null, undefined]) assert.equal(m.isBackendAnswer(status), false, String(status))
})

test('validation: the 60 s hold counts from the first live reading, never from the arrival (a slow start validates on a minute live)', () => {
  const m = need()
  const slow = { arrivedAtMs: NOW - 10 * MIN, startupCompleteAtMs: NOW - 2 * MIN, heartbeatOkAtMs: NOW - 20 * SEC }
  assert.equal(m.decideValidation(proof({ ...slow, liveSinceMs: NOW })), 'pending')
  assert.equal(m.decideValidation(proof({ ...slow, liveSinceMs: NOW - 59 * SEC })), 'pending')
  assert.equal(m.decideValidation(proof({ ...slow, liveSinceMs: NOW - 60 * SEC })), 'validated')
  assert.equal(m.decideValidation(proof({ ...slow, liveSinceMs: null })), 'pending')
})

test('validation: the deadline counts from this boot\'s startup complete; a startup that never completes has its own 15 min bound', () => {
  const m = need()
  const dead = { beaconAtMs: null, arrivedAtMs: NOW - 12 * MIN }
  assert.equal(m.decideValidation(proof({ ...dead, startupCompleteAtMs: NOW - 4 * MIN })), 'pending', 'a slow startup is not the build failing')
  assert.equal(m.decideValidation(proof({ ...dead, startupCompleteAtMs: NOW - 5 * MIN })), 'deadline')
  const never = { beaconAtMs: null, startupComplete: false, startupCompleteAtMs: null }
  assert.equal(m.decideValidation(proof({ ...never, arrivedAtMs: NOW - 14 * MIN })), 'pending')
  assert.equal(m.decideValidation(proof({ ...never, arrivedAtMs: NOW - 15 * MIN })), 'deadline')
  assert.equal(m.decideValidation(proof({ ...never, arrivedAtMs: NOW - 16 * MIN, suspendedMs: 2 * MIN })), 'pending')
  assert.equal(m.decideValidation(proof({ ...never, arrivedAtMs: NOW - 16 * MIN, backendUnreachable: true })), 'pending')
})

test('durations: a startup bound, no age bound on a clean end, a bound on the rollback restart\'s waits, a cap on an outage', () => {
  const m = need()
  assert.equal(m.DEFAULT_DURATIONS.startupDeadlineMs, 15 * MIN)
  assert.equal('endedGraceMs' in m.DEFAULT_DURATIONS, false)
  assert.equal('aliveGraceMs' in m.DEFAULT_DURATIONS, false)
  assert.equal(m.DEFAULT_DURATIONS.rollbackProofGraceMs, 10 * MIN)
  assert.equal(m.DEFAULT_DURATIONS.unreachableCapMs, 60 * MIN)
  assert.equal(m.DEFAULT_DURATIONS.unattendedRecheckMs, 60 * MIN, 'a refused launch proof is read again an hour on')
})

test('a clean end is its claude going away: stdin ended or closed, a signal (a hangup too), or a broken pipe on its own output', () => {
  const m = need()
  for (const cause of ['stdin-end', 'stdin-close', 'SIGTERM', 'SIGINT', 'SIGHUP', 'stdout-epipe']) assert.equal(m.isCleanEnd(cause), true, cause)
  // The fault handlers' broken pipe is a write after end on ANY stream: as likely a fault in the build.
  for (const cause of ['broken-pipe', 'uncaught', '', undefined, null]) assert.equal(m.isCleanEnd(cause), false, String(cause))
})

test('validation: an outage holds the deadline for at most an hour; past that its minutes count (a build that breaks its own calls is rolled back)', () => {
  const m = need()
  const down = { beaconAtMs: null, backendUnreachable: true, arrivedAtMs: NOW - 70 * MIN, startupCompleteAtMs: NOW - 70 * MIN }
  assert.equal(m.decideValidation(proof({ ...down, unreachableMs: 59 * MIN })), 'pending')
  assert.equal(m.decideValidation(proof({ ...down, unreachableMs: 61 * MIN })), 'deadline', 'seventy minutes, an hour of it forgiven')
  assert.equal(m.decideValidation(proof({ ...down, unreachableMs: 61 * MIN, arrivedAtMs: NOW - 64 * MIN, startupCompleteAtMs: NOW - 64 * MIN })), 'pending')
  assert.equal(m.decideValidation(proof({ ...down, backendUnreachable: false, unreachableMs: 30 * MIN, arrivedAtMs: NOW - 34 * MIN, startupCompleteAtMs: NOW - 34 * MIN })), 'pending', 'minutes down under the cap are never counted')
  assert.equal(m.decideValidation(proof({ beaconAtMs: null, loginExpired: true, arrivedAtMs: NOW - 5 * HOUR, startupCompleteAtMs: NOW - 5 * HOUR })), 'pending', 'an expired login is never the build\'s fault')
})

test('validation: the hold needs a beacon touched and a heartbeat landed during it, not one reading still fresh from before', () => {
  const m = need()
  assert.equal(m.decideValidation(proof({ beaconAtMs: NOW - 61 * SEC })), 'pending', 'one beacon at the first live reading, none since')
  assert.equal(m.decideValidation(proof({ heartbeatOkAtMs: NOW - 61 * SEC })), 'pending', 'no heartbeat landed during the hold')
  assert.equal(m.decideValidation(proof({ arrivedAtMs: NOW - 50 * SEC, liveSinceMs: NOW - 70 * SEC })), 'pending', 'a hold that began before this boot arrived')
  assert.equal(m.decideValidation(proof()), 'validated')
})

test('validation: live is every proof but the 60 s hold', () => {
  const m = need()
  const early = { arrivedAtMs: NOW - 30 * SEC, heartbeatOkAtMs: NOW - 20 * SEC, liveSinceMs: NOW - 20 * SEC }
  assert.equal(m.decideValidation(proof(early)), 'pending')
  assert.equal(m.isLiveBuild(proof(early)), true)
  assert.equal(m.isLiveBuild(proof({ ...early, deaf: true })), false)
  assert.equal(m.isLiveBuild(proof({ ...early, beaconAtMs: null })), false)
  assert.equal(m.isLiveBuild(proof({ ...early, heartbeatOkAtMs: NOW - 40 * SEC })), false)
})

test('rollback moment: a restart through a systemd unit waits for a stray job in its cgroup, or a group it cannot read', () => {
  const m = need()
  assert.deepEqual(m.decideRollbackMoment(quietRollback({ serviceStrays: { ok: true, strays: [4242] } })), { go: false, reason: 'background_job' })
  assert.deepEqual(m.decideRollbackMoment(quietRollback({ serviceStrays: { ok: false, strays: [] } })), { go: false, reason: 'process_tree_unreadable' })
  assert.deepEqual(m.decideRollbackMoment(quietRollback({ serviceStrays: { ok: true, strays: [] } })), { go: true, reason: 'quiet' })
})

test('rollback: only the canary rolls back the shared install; another agent reports; an expired login does neither', () => {
  const m = need()
  assert.equal(m.decideRollback({ canary: true, loginExpired: false }), 'rollback')
  assert.equal(m.decideRollback({ canary: false, loginExpired: false }), 'report_only')
  assert.equal(m.decideRollback({ canary: true, loginExpired: true }), 'none')
})

/** The rollback restart's facts, everything quiet: the one case that goes. */
function quietRollback(over: Record<string, unknown> = {}): any {
  const f = idle()
  return {
    now: NOW,
    bootAtMs: NOW - 10 * MIN,
    active: true,
    draining: false,
    authority: f.authority,
    safe: f.safe,
    activityMs: [NOW - 5 * MIN],
    openAsks: 0,
    goalRunning: false,
    call: f.call,
    lastBrowserToolAtMs: null,
    personAttached: false,
    claudeKnown: true,
    descendants: [],
    serviceStrays: { ok: true, strays: [] },
    wake: { known: true, nextDueAtMs: null },
    ...over,
  }
}

test('rollback moment: quiet, unattended and nothing open: go', () => {
  assert.deepEqual(need().decideRollbackMoment(quietRollback()), { go: true, reason: 'quiet' })
})

test('rollback moment: never through an authority not proven unattended, never passive, never while draining', () => {
  const m = need()
  const no = (over: Record<string, unknown>, reason: string) => assert.deepEqual(m.decideRollbackMoment(quietRollback(over)), { go: false, reason })
  no({ authority: { kind: 'launcher', unattended: false } }, 'no_unattended_authority')
  no({ authority: { kind: 'staged', unattended: true } }, 'no_unattended_authority')
  no({ authority: null }, 'no_unattended_authority')
  no({ active: false }, 'passive')
  no({ draining: true }, 'update_in_flight')
})

test('rollback moment: an open ask, a running goal, a call, a browser in use or a wake due waits', () => {
  const m = need()
  const no = (over: Record<string, unknown>, reason: string) => assert.deepEqual(m.decideRollbackMoment(quietRollback(over)), { go: false, reason })
  no({ openAsks: 1 }, 'open_ask')
  no({ goalRunning: true }, 'goal_running')
  no({ call: { pendingConsults: 0, openContinuations: 0, lastVoiceAtMs: NOW - MIN, openMeetings: 0 } }, 'call_active')
  no({ call: { pendingConsults: 0, openContinuations: 0, lastVoiceAtMs: null, openMeetings: 1 } }, 'call_active')
  no({ lastBrowserToolAtMs: NOW - MIN }, 'browser_in_use')
  no({ wake: { known: true, nextDueAtMs: NOW + 2 * MIN } }, 'wake_due')
  // A schedule a failing build cannot read never keeps it on that build.
  assert.equal(m.decideRollbackMoment(quietRollback({ wake: { known: false, nextDueAtMs: null } })).go, true)
})

test('rollback moment: no hook signal goes back all the same, but on the 30 min quiet: 2 min of quiet proves nothing without one', () => {
  const m = need()
  const blind = (activity: number) => quietRollback({ safe: { ...quietRollback().safe, turnSignal: 'none' }, activityMs: [NOW - activity], bootAtMs: NOW - DAY })
  assert.deepEqual(m.decideRollbackMoment(blind(29 * MIN)), { go: false, reason: 'recent_activity' })
  // Never held for a signal that may never come: a deaf build gets no turns, and it must still go back.
  assert.deepEqual(m.decideRollbackMoment(blind(31 * MIN)), { go: true, reason: 'quiet' })
  assert.deepEqual(m.decideRollbackMoment(quietRollback({ activityMs: [NOW - 3 * MIN], bootAtMs: NOW - DAY })), { go: true, reason: 'quiet' })
})

// -- Unattended and own launcher proofs ----------------------------------------------------------

const POSIX_TABLE = [
  { pid: 1, ppid: 0, command: '/sbin/launchd' },
  { pid: 500, ppid: 1, command: '/bin/bash /Users/a/.bgos-agent/912/run.sh' },
  { pid: 600, ppid: 1, command: 'tmux -f /dev/null -L hoai-912-home-abc new-session -d -s hoai-912-home-abc' },
  { pid: 610, ppid: 600, command: '/bin/sh -c err=$1; shift; exec "$@" 2>>"$err" hoai-stderr' },
  { pid: 620, ppid: 610, command: '/usr/local/bin/node /Users/a/plugin/bin/hoai-core.mjs' },
  { pid: 630, ppid: 620, command: 'expect -c spawn claude' },
  { pid: 640, ppid: 630, command: '/Users/a/.local/bin/claude --dangerously-skip-permissions --resume pin-1' },
  { pid: 650, ppid: 640, command: 'bun /Users/a/plugin/server.ts' },
]

function unattended(over: Record<string, unknown> = {}): any {
  return need().proveUnattended({
    platform: 'darwin',
    authorityKind: 'launcher',
    launcherPid: 620,
    processes: POSIX_TABLE,
    ownSockets: ['hoai-912-home-abc', 'hoai-912'],
    runShPath: '/Users/a/.bgos-agent/912/run.sh',
    launchStatus: { outcome: null, mtimeMs: null },
    supervisorMtimeMs: NOW - HOUR,
    runAgentVbs: { text: null, mtimeMs: null },
    runAgentVbsPath: 'C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs',
    launcherStartedAtMs: NOW - HOUR,
    ...over,
  })
}

test('unattended: a gen-2 launcher descending from the agent\'s own tmux server is unattended', () => {
  assert.equal(unattended().unattended, true)
})

test('unattended: a supervised launch-status written at or after supervisor.json is unattended', () => {
  const r = unattended({ processes: null, launchStatus: { outcome: 'live', mtimeMs: NOW - HOUR + 5 * SEC } })
  assert.equal(r.unattended, true)
  assert.equal(unattended({ processes: null, launchStatus: { outcome: 'live', mtimeMs: NOW - 2 * HOUR } }).unattended, false)
})

test('unattended: a person\'s own hoai in a terminal is never unattended', () => {
  const table = [
    { pid: 1, ppid: 0, command: '/sbin/launchd' },
    { pid: 300, ppid: 1, command: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
    { pid: 310, ppid: 300, command: '-zsh' },
    { pid: 620, ppid: 310, command: 'node /Users/a/plugin/bin/hoai-core.mjs' },
    { pid: 640, ppid: 620, command: 'claude --resume pin-1' },
    { pid: 650, ppid: 640, command: 'bun /Users/a/plugin/server.ts' },
  ]
  assert.equal(unattended({ processes: table }).unattended, false)
  assert.equal(unattended({ processes: null }).unattended, false)
})

test('unattended: a keepalive script, and a service that owns the daemon, are unattended by construction', () => {
  assert.equal(unattended({ authorityKind: 'keepalive', processes: null }).unattended, true)
  assert.equal(unattended({ authorityKind: 'service', processes: null }).unattended, true)
  assert.equal(unattended({ authorityKind: 'staged' }).unattended, false)
})

const WIN_TABLE = [
  { pid: 4, ppid: 0, command: 'System' },
  { pid: 900, ppid: 4, command: 'C:\\WINDOWS\\system32\\svchost.exe -k netsvcs -p -s Schedule' },
  { pid: 910, ppid: 900, command: '"C:\\WINDOWS\\System32\\WScript.exe" //B "C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs"' },
  { pid: 920, ppid: 910, command: '"C:\\Program Files\\nodejs\\node.exe" C:\\plugin\\bin\\hoai-core.mjs --keep-alive' },
  { pid: 940, ppid: 920, command: '"C:\\Users\\kc\\.local\\bin\\claude.exe" --resume pin-1' },
  { pid: 950, ppid: 940, command: 'C:\\Users\\kc\\.bun\\bin\\bun.exe C:\\plugin\\server.ts' },
]
// The body lib/agent-task-win32.mjs writes: the launcher runs hidden (style 0) and the script waits for it.
const HIDDEN_VBS = [
  'Set shell = CreateObject("WScript.Shell")',
  'WScript.Quit shell.Run("""C:\\node.exe"" ""C:\\plugin\\bin\\hoai-core.mjs"" --keep-alive", 0, True)',
  '',
].join('\r\n')

test('unattended on Windows: the logon task\'s hidden run-agent.vbs started the launcher', () => {
  const r = unattended({ platform: 'win32', launcherPid: 920, processes: WIN_TABLE, runAgentVbs: { text: HIDDEN_VBS, mtimeMs: NOW - 2 * HOUR } })
  assert.equal(r.unattended, true)
})

test('unattended on Windows: --keep-alive typed in a console, a visible vbs, a vbs rewritten later, or no table is not proof', () => {
  const typed = WIN_TABLE.map((p) => (p.pid === 920 ? { ...p, ppid: 930 } : p)).concat([{ pid: 930, ppid: 4, command: 'C:\\WINDOWS\\system32\\cmd.exe' }])
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: typed, runAgentVbs: { text: HIDDEN_VBS, mtimeMs: NOW - 2 * HOUR } }).unattended, false)
  const visible = HIDDEN_VBS.replace(', 0, True', ', 7, True')
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: WIN_TABLE, runAgentVbs: { text: visible, mtimeMs: NOW - 2 * HOUR } }).unattended, false)
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: WIN_TABLE, runAgentVbs: { text: HIDDEN_VBS, mtimeMs: NOW - 10 * MIN } }).unattended, false)
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: null, runAgentVbs: { text: HIDDEN_VBS, mtimeMs: NOW - 2 * HOUR } }).unattended, false)
  assert.equal(
    unattended({ platform: 'win32', launcherPid: 920, processes: null, launchStatus: { outcome: 'live', mtimeMs: NOW }, runAgentVbs: { text: HIDDEN_VBS, mtimeMs: NOW - 2 * HOUR } }).unattended,
    false,
  )
})

test('unattended on Windows: only THIS agent\'s run-agent.vbs proves it, never another agent\'s or one elsewhere', () => {
  const vbs = { text: HIDDEN_VBS, mtimeMs: NOW - 2 * HOUR }
  const other = WIN_TABLE.map((p) => (p.pid === 910 ? { ...p, command: '"C:\\WINDOWS\\System32\\WScript.exe" //B "C:\\Users\\kc\\.bgos-agent\\913\\run-agent.vbs"' } : p))
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: other, runAgentVbs: vbs }).unattended, false)
  const elsewhere = WIN_TABLE.map((p) => (p.pid === 910 ? { ...p, command: '"C:\\WINDOWS\\System32\\WScript.exe" //B C:\\Temp\\run-agent.vbs' } : p))
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: elsewhere, runAgentVbs: vbs }).unattended, false)
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: WIN_TABLE, runAgentVbs: vbs, runAgentVbsPath: null }).unattended, false)
  const slashes = WIN_TABLE.map((p) => (p.pid === 910 ? { ...p, command: 'wscript.exe //B c:/users/kc/.bgos-agent/912/run-agent.vbs' } : p))
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: slashes, runAgentVbs: vbs }).unattended, true)
  // This agent's own script, but run by cscript (a console a person sees and types in), is no proof either.
  const byCscript = WIN_TABLE.map((p) => (p.pid === 910 ? { ...p, command: '"C:\\WINDOWS\\System32\\cscript.exe" //B "C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs"' } : p))
  assert.equal(unattended({ platform: 'win32', launcherPid: 920, processes: byCscript, runAgentVbs: vbs }).unattended, false)
})

test('own launcher: the hoai that supervises this session\'s claude, a strict ancestor, is proven', () => {
  assert.equal(need().proveOwnLauncher({ ownPid: 650, launcherPid: 620, processes: POSIX_TABLE }).proven, true)
})

test('own launcher: a nested claude between this daemon and hoai is refused (the pid proven is the pid replaced)', () => {
  const nested = POSIX_TABLE.concat([
    { pid: 700, ppid: 640, command: '/bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1.sh && claude -p hi' },
    { pid: 710, ppid: 700, command: '/Users/a/.local/bin/claude -p hi' },
    { pid: 720, ppid: 710, command: 'bun /Users/a/plugin/server.ts' },
  ])
  assert.equal(need().proveOwnLauncher({ ownPid: 720, launcherPid: 620, processes: nested }).proven, false)
})

test('own launcher: not an ancestor, not hoai, no claude above, or no table is refused', () => {
  const m = need()
  assert.equal(m.proveOwnLauncher({ ownPid: 650, launcherPid: 500, processes: POSIX_TABLE }).proven, false)
  const notHoai = POSIX_TABLE.map((p) => (p.pid === 620 ? { ...p, command: 'node /Users/a/other.mjs' } : p))
  assert.equal(m.proveOwnLauncher({ ownPid: 650, launcherPid: 620, processes: notHoai }).proven, false)
  const noClaude = POSIX_TABLE.map((p) => (p.pid === 640 ? { ...p, command: 'node fake-session.mjs' } : p))
  assert.equal(m.proveOwnLauncher({ ownPid: 650, launcherPid: 620, processes: noClaude }).proven, false)
  assert.equal(m.proveOwnLauncher({ ownPid: 650, launcherPid: 620, processes: null }).proven, false)
  assert.equal(m.proveOwnLauncher({ ownPid: 650, launcherPid: 650, processes: POSIX_TABLE }).proven, false)
})

// -- Marketplace rollback ------------------------------------------------------------------------

const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'other@hoai': [{ scope: 'user', version: '9.9.9', installPath: '/x' }],
    'hoai@hoai': [
      { scope: 'project', version: '0.81.0', installPath: '/c/plugins/cache/hoai/hoai/0.81.0', projectPath: '/p' },
      { scope: 'user', version: '0.81.0', installPath: '/c/plugins/cache/hoai/hoai/0.81.0', installedAt: '2026-10-01T00:00:00.000Z', lastUpdated: '2026-10-28T11:00:00.000Z', gitCommitSha: 'abc' },
    ],
  },
})

test('repoint: the user-scope hoai entry goes back to the old version and folder; every other entry and field is kept', () => {
  const r = need().repointInstalledPlugins(INSTALLED, { version: '0.80.0', installPath: '/c/plugins/cache/hoai/hoai/0.80.0', now: NOW })
  assert.equal(r.ok, true)
  const doc = JSON.parse(r.text)
  const user = doc.plugins['hoai@hoai'][1]
  assert.equal(user.version, '0.80.0')
  assert.equal(user.installPath, '/c/plugins/cache/hoai/hoai/0.80.0')
  assert.equal(user.lastUpdated, new Date(NOW).toISOString())
  assert.equal(user.installedAt, '2026-10-01T00:00:00.000Z')
  assert.equal(doc.plugins['hoai@hoai'][0].version, '0.81.0')
  assert.deepEqual(doc.plugins['other@hoai'], [{ scope: 'user', version: '9.9.9', installPath: '/x' }])
  assert.equal(doc.version, 2)
})

test('repoint: no hoai entry, or a document that does not parse, is refused and never rewritten', () => {
  const m = need()
  assert.equal(m.repointInstalledPlugins('{"plugins":{}}', { version: '0.80.0', installPath: '/p', now: NOW }).ok, false)
  assert.equal(m.repointInstalledPlugins('not json', { version: '0.80.0', installPath: '/p', now: NOW }).ok, false)
})

test('enrolment hold: Claude Code\'s startup update stays off while the marketplace\'s latest is latched bad', () => {
  const m = need()
  assert.equal(m.holdMarketplaceEnrolment({ latestKnownVersion: '0.81.0', badVersions: ['0.81.0'] }), true)
  assert.equal(m.holdMarketplaceEnrolment({ latestKnownVersion: null, badVersions: ['0.81.0'] }), true)
  assert.equal(m.holdMarketplaceEnrolment({ latestKnownVersion: '0.81.1', badVersions: ['0.81.0'] }), false)
  assert.equal(m.holdMarketplaceEnrolment({ latestKnownVersion: '0.81.0', badVersions: [] }), false)
})

// -- Reporting -----------------------------------------------------------------------------------

test('report: a restart that did not arrive or came back old says so with the app\'s standing code and the next try', () => {
  const m = need()
  const r = record({ state: 'came_back_old', attempts: [{ at: new Date(NOW - HOUR).toISOString(), outcome: 'came_back_old' }] })
  const e = m.idleUpdateLastError(r, { runningVersion: '0.80.0' })
  assert.equal(e.code, 'scheduled_update_failed')
  assert.match(e.message, /0\.81\.0/)
  assert.match(e.message, /0\.80\.0/)
  assert.match(e.message, /2026-10-29T11:00:00\.000Z/)
  assert.ok(e.message.length <= 300)
  assert.equal(e.at, new Date(NOW - HOUR).toISOString())
})

test('report: a restart the ladder could only stage says so with the standing code too', () => {
  const m = need()
  const r = record({ state: 'no_authority', attempts: [{ at: new Date(NOW - HOUR).toISOString(), outcome: 'no_authority' }] })
  assert.equal(m.idleUpdateLastError(r, { runningVersion: '0.80.0' }).code, 'scheduled_update_failed')
  assert.equal(m.attemptFactsFor(r, '0.81.0').failed, 1)
})

test('report: a rollback, a failed rollback, a lost conversation and a non-canary failure each have their own code', () => {
  const m = need()
  assert.equal(m.idleUpdateLastError(record({ state: 'rolled_back' }), { runningVersion: '0.80.0' }).code, 'idle_update_rolled_back')
  assert.equal(m.idleUpdateLastError(record({ state: 'rollback_failed' }), { runningVersion: '0.81.0' }).code, 'idle_update_rollback_failed')
  assert.equal(m.idleUpdateLastError(record({ state: 'arrived', contextLost: true }), { runningVersion: '0.81.0' }).code, 'idle_update_context_lost')
  assert.equal(m.idleUpdateLastError(record({ state: 'failed' }), { runningVersion: '0.81.0' }).code, 'idle_update_failed')
})

test('report: a validated restart, a pending one, or no record says nothing (and so clears a standing error)', () => {
  const m = need()
  assert.equal(m.idleUpdateLastError(record({ state: 'validated' }), { runningVersion: '0.81.0' }), null)
  assert.equal(m.idleUpdateLastError(record(), { runningVersion: '0.80.0' }), null)
  assert.equal(m.idleUpdateLastError(null, { runningVersion: '0.80.0' }), null)
})

test('report: a version held on this computer, and a launcher that stopped taking markers, say so while they stand', () => {
  const m = need()
  assert.equal(m.idleUpdateWaitError('version_held_bad', { target: '0.81.0', runningVersion: '0.80.0', now: NOW }).code, 'idle_update_held')
  assert.equal(m.idleUpdateWaitError('launcher_latched', { target: '0.81.0', runningVersion: '0.80.0', now: NOW }).code, 'idle_update_launcher_latched')
  const blind = m.idleUpdateWaitError('no_turn_signal', { target: '0.81.0', runningVersion: '0.80.0', now: NOW })
  assert.equal(blind.code, 'idle_update_no_turn_signal')
  assert.match(blind.message, /0\.81\.0/)
  assert.ok(blind.message.length <= 300)
  assert.equal(m.idleUpdateWaitError('recent_activity', { target: '0.81.0', runningVersion: '0.80.0', now: NOW }), null)
})
