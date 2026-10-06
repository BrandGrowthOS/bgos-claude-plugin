/**
 * lib/keepalive-plan.mjs: the PURE decisions of the watcher's keep-alive sweep
 * (design sections 5 and 6, findings 7 to 9, gaps G1, G5, G10). Every rule is a
 * table here, so a reviewer reads the policy in one place and a mutant of any
 * guard turns a named row red:
 *
 *   parseAgentState / isAgentStateFresh   the daemon's published state (design 7), fail closed
 *   isBackgroundJobCommand                Claude Code's Bash and Monitor tool marker (finding 9)
 *   decideSafeMoment                      the design 6 table, exact reasons
 *   decidePendingRestart                  upgrade_pending / update_pending / the legacy time rule
 *   decideSupervise / decideTaskStart     who gets a supervisor, and when a Windows task is started
 *   decideRestartGate / decideInstallGate the rate limits (30 min, 3 attempts, 1 per sweep, 1 h retry)
 *   parseKeepAliveResponse / decideKeepAliveConsent   the backend list and its 24 h cache
 *   parseInstalledPluginRecord            the installed version and when it landed
 *   advanceAgentRecord / reportEntry      since, waitingSince after 24 h, the 120 char bound
 *
 * Run: npx tsx --test test/keepalive-plan.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_STATE_FRESH_MS,
  INSTALL_RETRY_MS,
  KEEPALIVE_CACHE_MAX_AGE_MS,
  LAUNCHER_STABLE_MS,
  LEGACY_QUIET_WINDOW_MS,
  MAX_ATTEMPTS_PER_TARGET,
  MAX_TASK_STARTS_PER_EPISODE,
  QUIET_WINDOW_MS,
  RESTART_MIN_INTERVAL_MS,
  STALE_TURN_MS,
  TASK_START_MIN_INTERVAL_MS,
  WAITING_ASK_AFTER_MS,
  advanceAgentRecord,
  advanceLauncherEpisode,
  buildKeepAliveCache,
  decideInstallGate,
  decideKeepAliveConsent,
  decidePendingRestart,
  decideRestartBudget,
  decideRestartGate,
  decideSafeMoment,
  decideSupervise,
  decideTaskStart,
  decideTaskStartGate,
  isAgentStateFresh,
  isBackgroundJobCommand,
  parseAgentState,
  parseInstalledPluginRecord,
  parseKeepAliveCache,
  parseKeepAliveResponse,
  reportEntry,
} from '../lib/keepalive-plan.mjs'

const NOW = Date.parse('2026-10-06T19:00:00.000Z')
const MIN = 60_000

function stateBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    assistantId: '123',
    pid: 4242,
    claudePid: 4200,
    runningVersion: '0.62.0',
    pendingRestartVersion: null,
    turnInFlight: false,
    pendingMessages: 0,
    pendingPermissions: 0,
    activeOperations: 0,
    lastActivityAt: '2026-10-06T18:00:00.000Z',
    sessionId: '8c1f0000-0000-4000-8000-000000000001',
    updatedAt: '2026-10-06T18:59:30.000Z',
    ...overrides,
  })
}

// -- constants ---------------------------------------------------------------------------

test('the windows and limits are the design numbers', () => {
  assert.equal(AGENT_STATE_FRESH_MS, 120_000)
  assert.equal(QUIET_WINDOW_MS, 10 * MIN)
  assert.equal(LEGACY_QUIET_WINDOW_MS, 30 * MIN)
  assert.equal(RESTART_MIN_INTERVAL_MS, 30 * MIN)
  assert.equal(MAX_ATTEMPTS_PER_TARGET, 3)
  assert.equal(INSTALL_RETRY_MS, 60 * MIN)
  assert.equal(WAITING_ASK_AFTER_MS, 24 * 60 * MIN)
  assert.equal(KEEPALIVE_CACHE_MAX_AGE_MS, 24 * 60 * MIN)
})

// -- agent-state.json ----------------------------------------------------------------------

test('parseAgentState: the design 7 body parses; times become ms', () => {
  const s = parseAgentState(stateBody(), '123')!
  assert.equal(s.assistantId, '123')
  assert.equal(s.pid, 4242)
  assert.equal(s.claudePid, 4200)
  assert.equal(s.runningVersion, '0.62.0')
  assert.equal(s.pendingRestartVersion, null)
  assert.equal(s.turnInFlight, false)
  assert.equal(s.updatedAtMs, Date.parse('2026-10-06T18:59:30.000Z'))
  assert.equal(s.lastActivityAtMs, Date.parse('2026-10-06T18:00:00.000Z'))
  assert.equal(s.sessionId, '8c1f0000-0000-4000-8000-000000000001')
  // claudePid may be null (the daemon found no claude ancestor); a numeric id is accepted.
  assert.equal(parseAgentState(stateBody({ claudePid: null, assistantId: 123 }), '123')!.claudePid, null)
})

test('parseAgentState: fail closed on every malformed shape (null reads as "no fresh state")', () => {
  const rows: Array<[string, unknown]> = [
    ['not json', '{'],
    ['array', '[]'],
    ['schema 2', stateBody({ schemaVersion: 2 })],
    ['other agent', stateBody({ assistantId: '124' })],
    ['junk id', stateBody({ assistantId: '12a' })],
    ['pid 1', stateBody({ pid: 1 })],
    ['pid string', stateBody({ pid: '4242' })],
    ['claudePid junk', stateBody({ claudePid: 'x' })],
    ['turnInFlight missing', stateBody({ turnInFlight: undefined })],
    ['turnInFlight string', stateBody({ turnInFlight: 'false' })],
    ['negative pendingMessages', stateBody({ pendingMessages: -1 })],
    ['fractional pendingPermissions', stateBody({ pendingPermissions: 0.5 })],
    ['activeOperations missing', stateBody({ activeOperations: undefined })],
    ['updatedAt junk', stateBody({ updatedAt: 'yesterday' })],
    ['lastActivityAt junk', stateBody({ lastActivityAt: 'soon' })],
  ]
  for (const [name, raw] of rows) {
    assert.equal(parseAgentState(raw as string, '123'), null, name)
  }
  assert.equal(parseAgentState(null, '123'), null)
  assert.equal(parseAgentState('', '123'), null)
})

test('isAgentStateFresh: written in the last 120 s AND the writing pid alive', () => {
  const s = parseAgentState(stateBody(), '123')!
  const alive = (pid: number) => pid === 4242
  assert.equal(isAgentStateFresh(s, { now: NOW, pidAlive: alive }), true)
  assert.equal(isAgentStateFresh(s, { now: NOW + 91_000, pidAlive: alive }), false, '121 s old')
  assert.equal(isAgentStateFresh(s, { now: NOW, pidAlive: () => false }), false, 'pid dead')
  assert.equal(isAgentStateFresh(s, { now: NOW - 300_000, pidAlive: alive }), false, 'written in the future')
  assert.equal(isAgentStateFresh(null, { now: NOW, pidAlive: alive }), false)
})

// -- the background job marker (finding 9) -----------------------------------------------------

test('isBackgroundJobCommand: shell-snapshots/snapshot- in either slash style; MCP servers and claude itself are not jobs', () => {
  const yes = [
    "/bin/zsh -c source /Users/kc/.claude/shell-snapshots/snapshot-zsh-1759777000-abc.sh && eval 'tail -f log'",
    '/bin/bash -c source /home/kc/.claude/shell-snapshots/snapshot-bash-1.sh && python monitor.py',
    'C:\\Program Files\\Git\\bin\\bash.exe -c source C:\\Users\\kc\\.claude\\shell-snapshots\\snapshot-bash-1.sh',
  ]
  const no = [
    'node /home/kc/.claude/plugins/cache/hoai/hoai/0.62.0/server.ts',
    'claude --dangerously-skip-permissions',
    'bun run server.ts',
    '/bin/zsh -c ls shell-snapshots',
    '',
  ]
  for (const cmd of yes) assert.equal(isBackgroundJobCommand(cmd), true, cmd)
  for (const cmd of no) assert.equal(isBackgroundJobCommand(cmd), false, cmd)
  assert.equal(isBackgroundJobCommand(null as any), false)
})

// -- the safe moment (design 6 table) -------------------------------------------------------------

test('decideSafeMoment: the design 6 table, exact reasons', () => {
  const fresh = parseAgentState(stateBody(), '123')!
  const base = { running: true, stateFresh: true, state: fresh, descendants: [] as string[] | null, activityMs: [NOW - 60 * MIN], now: NOW }
  const job = '/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh && tail -f x'
  const rows: Array<[string, Record<string, unknown>, boolean, string]> = [
    ['not running is always safe, even mid nothing', { running: false, state: null, stateFresh: false, descendants: null }, true, 'not_running'],
    ['idle, fresh state, quiet 60 min', {}, true, 'idle'],
    ['turn in flight', { state: { ...fresh, turnInFlight: true } }, false, 'turn_in_flight'],
    ['a reply is owed', { state: { ...fresh, pendingMessages: 2 } }, false, 'pending_messages'],
    ['a permission is pending', { state: { ...fresh, pendingPermissions: 1 } }, false, 'pending_permission'],
    ['a delivery is running', { state: { ...fresh, activeOperations: 1 } }, false, 'pending_messages'],
    ['a background job descendant', { descendants: ['node /x/server.ts', job] }, false, 'background_job'],
    ['the process tree could not be read', { descendants: null }, false, 'process_tree_unreadable'],
    ['running unknown', { running: null, state: null, stateFresh: false }, false, 'process_tree_unreadable'],
    ['activity 9 min ago with fresh state', { activityMs: [NOW - 9 * MIN] }, false, 'recent_activity'],
    ['activity 11 min ago with fresh state', { activityMs: [null, NOW - 11 * MIN] }, true, 'idle'],
    ['legacy daemon: 11 min is NOT quiet enough', { state: null, stateFresh: false, activityMs: [NOW - 11 * MIN] }, false, 'recent_activity'],
    ['legacy daemon: 29 min still not', { state: null, stateFresh: false, activityMs: [NOW - 29 * MIN] }, false, 'recent_activity'],
    ['legacy daemon: 31 min quiet is safe', { state: null, stateFresh: false, activityMs: [NOW - 31 * MIN] }, true, 'idle'],
    ['the newest source wins', { activityMs: [NOW - 60 * MIN, NOW - 2 * MIN, undefined] }, false, 'recent_activity'],
    ['no activity evidence at all', { activityMs: [] }, true, 'idle'],
    ['a stale state is not consulted for turn flags', { stateFresh: false, state: { ...fresh, turnInFlight: true }, activityMs: [NOW - 31 * MIN] }, true, 'idle'],
  ]
  for (const [name, patch, safe, reason] of rows) {
    const out = decideSafeMoment({ ...base, ...patch } as any)
    assert.deepEqual(out, { safe, reason }, name)
  }
})

test('decideSafeMoment: a turn flag with NO activity for 2 h and no background job is stale (an interrupted turn never gets its Stop); anything less is still a turn', () => {
  assert.equal(STALE_TURN_MS, 2 * 60 * MIN)
  const turn = parseAgentState(stateBody({ turnInFlight: true }), '123')!
  const base = { running: true, stateFresh: true, state: turn, descendants: [] as string[] | null, activityMs: [NOW - 121 * MIN], now: NOW }
  const job = '/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh && tail -f x'
  const rows: Array<[string, Record<string, unknown>, boolean, string]> = [
    ['quiet 121 min, no job: stale, the normal restart path', {}, true, 'stale_turn'],
    ['quiet exactly 2 h: stale', { activityMs: [NOW - 120 * MIN] }, true, 'stale_turn'],
    ['every source quiet 3 h: stale', { activityMs: [NOW - 180 * MIN, null, NOW - 200 * MIN] }, true, 'stale_turn'],
    ['activity 119 min ago: a live turn', { activityMs: [NOW - 119 * MIN] }, false, 'turn_in_flight'],
    ['one newer source vetoes it', { activityMs: [NOW - 180 * MIN, NOW - 30 * MIN] }, false, 'turn_in_flight'],
    ['a background job under claude: still the turn', { descendants: ['node /x/server.ts', job] }, false, 'turn_in_flight'],
    ['a process tree that could not be read cannot prove no job', { descendants: null }, false, 'turn_in_flight'],
    ['no activity evidence at all cannot prove quiet', { activityMs: [] }, false, 'turn_in_flight'],
    ['a stamp in the future (clock skew) is not quiet', { activityMs: [NOW + 5 * MIN] }, false, 'turn_in_flight'],
    ['a stale turn hides no owed reply', { state: { ...turn, pendingMessages: 1 } }, false, 'pending_messages'],
    ['a stale turn hides no pending permission', { state: { ...turn, pendingPermissions: 1 } }, false, 'pending_permission'],
    ['a stale turn hides no running delivery', { state: { ...turn, activeOperations: 1 } }, false, 'pending_messages'],
  ]
  for (const [name, patch, safe, reason] of rows) {
    assert.deepEqual(decideSafeMoment({ ...base, ...patch } as any), { safe, reason }, name)
  }
})

test('decideSafeMoment: the turn flags outrank the process tree (the more specific reason is reported)', () => {
  const fresh = parseAgentState(stateBody({ turnInFlight: true }), '123')!
  const out = decideSafeMoment({ running: true, stateFresh: true, state: fresh, descendants: null, activityMs: [], now: NOW } as any)
  assert.deepEqual(out, { safe: false, reason: 'turn_in_flight' })
})

// -- pending restart ---------------------------------------------------------------------------------

test('decidePendingRestart: upgrade, update, the legacy time rule, and nothing', () => {
  const base = {
    canonical: true,
    generation: 2,
    stateFresh: true,
    runningVersion: '0.62.0',
    pendingRestartVersion: null,
    installedVersion: '0.62.0',
    claudeStartedAtMs: null,
    installLandedAtMs: null,
  }
  const rows: Array<[string, Record<string, unknown>, unknown]> = [
    ['current supervisor, current version', {}, null],
    ['canonical generation 1 supervisor', { generation: 1 }, { kind: 'upgrade_pending', target: 'supervisor-generation-2', reason: 'supervisor_generation_1' }],
    ['generation 1 but NOT canonical (bespoke) is never upgraded', { canonical: false, generation: 1 }, null],
    ['the upgrade outranks a version gap', { generation: 1, runningVersion: '0.61.0' }, { kind: 'upgrade_pending', target: 'supervisor-generation-2', reason: 'supervisor_generation_1' }],
    ['running differs from installed', { runningVersion: '0.61.4' }, { kind: 'update_pending', target: '0.62.0', reason: 'running_differs_from_installed' }],
    ['a rollback (installed older) also differs', { runningVersion: '0.62.1' }, { kind: 'update_pending', target: '0.62.0', reason: 'running_differs_from_installed' }],
    ['installed unknown: the daemon-reported staged version stands in', { installedVersion: null, pendingRestartVersion: '0.62.1' }, { kind: 'update_pending', target: '0.62.1', reason: 'running_differs_from_installed' }],
    ['running unknown', { runningVersion: null }, null],
    ['legacy: claude started before the install landed', { stateFresh: false, runningVersion: null, claudeStartedAtMs: NOW - 60 * MIN, installLandedAtMs: NOW - 30 * MIN }, { kind: 'update_pending', target: '0.62.0', reason: 'started_before_install' }],
    ['legacy: claude started after the install landed', { stateFresh: false, runningVersion: null, claudeStartedAtMs: NOW - 10 * MIN, installLandedAtMs: NOW - 30 * MIN }, null],
    ['legacy: no claude found', { stateFresh: false, claudeStartedAtMs: null, installLandedAtMs: NOW - 30 * MIN }, null],
    ['legacy: landing time unknown', { stateFresh: false, claudeStartedAtMs: NOW - 60 * MIN, installLandedAtMs: null }, null],
    ['legacy with no installed version names the landing instant', { stateFresh: false, installedVersion: null, claudeStartedAtMs: NOW - 60 * MIN, installLandedAtMs: NOW - 30 * MIN }, { kind: 'update_pending', target: `landed:${NOW - 30 * MIN}`, reason: 'started_before_install' }],
    ['a fresh state is never judged by time', { claudeStartedAtMs: NOW - 60 * MIN, installLandedAtMs: NOW - 30 * MIN }, null],
  ]
  for (const [name, patch, expected] of rows) {
    assert.deepEqual(decidePendingRestart({ ...base, ...patch } as any), expected, name)
  }
})

// -- supervise ---------------------------------------------------------------------------------------

test('decideSupervise: none + known cwd + cleared installs; no cwd needs a first launch; never over a bespoke service or a keepalive', () => {
  const base = { cleared: true, supervisor: 'none', serviceVia: null, keepaliveVerified: false, cwd: '/h/hoai-agents/ava' }
  const rows: Array<[string, Record<string, unknown>, unknown]> = [
    ['none + cwd + cleared', {}, { action: 'install', state: 'installing', reason: null }],
    ['none + no cwd', { cwd: null }, { action: 'none', state: 'needs_first_launch', reason: 'no_known_folder' }],
    ['not cleared by the backend (G3)', { cleared: false }, { action: 'none', state: null, reason: 'not_cleared' }],
    ['canonical service', { supervisor: 'service', serviceVia: 'canonical-file' }, { action: 'none', state: 'supervised', reason: 'canonical' }],
    ['bespoke discovered service (G11)', { supervisor: 'service', serviceVia: 'working-directory' }, { action: 'none', state: 'supervised', reason: 'bespoke' }],
    ['a verified keepalive.json with no visible job', { keepaliveVerified: true }, { action: 'none', state: 'supervised', reason: 'keepalive' }],
    ['a live hoai launcher', { supervisor: 'launcher-live' }, { action: 'none', state: 'supervised', reason: 'launcher' }],
  ]
  for (const [name, patch, expected] of rows) {
    assert.deepEqual(decideSupervise({ ...base, ...patch } as any), expected, name)
  }
})

test('decideTaskStart: a Windows agent task is started only when its launcher is dead and the agent is surely not running', () => {
  const base = { platform: 'win32', canonicalTask: true, launcherLive: false, running: false, recentActivity: false }
  assert.equal(decideTaskStart(base), true)
  assert.equal(decideTaskStart({ ...base, platform: 'linux' }), false, 'posix supervisors restart by themselves')
  assert.equal(decideTaskStart({ ...base, canonicalTask: false }), false)
  assert.equal(decideTaskStart({ ...base, launcherLive: true }), false, 'the launcher is alive')
  assert.equal(decideTaskStart({ ...base, running: true }), false, 'running by hand: never a second session')
  assert.equal(decideTaskStart({ ...base, running: null }), false, 'unknown is not "not running"')
  assert.equal(decideTaskStart({ ...base, recentActivity: true }), false, 'recent activity may be a session we cannot see')
})

test('decideTaskStartGate: the restart limits for a dead launcher (1 start per 30 min, 3 per death episode, then failed task_start_failed)', () => {
  assert.equal(TASK_START_MIN_INTERVAL_MS, 30 * MIN)
  assert.equal(MAX_TASK_STARTS_PER_EPISODE, 3)
  const base = { now: NOW, lastTaskStartAtMs: null, taskStarts: 0 }
  const rows: Array<[string, Record<string, unknown>, unknown]> = [
    ['first start of an episode', {}, { allowed: true, state: 'supervised', reason: null }],
    ['third start still allowed', { taskStarts: 2, lastTaskStartAtMs: NOW - 31 * MIN }, { allowed: true, state: 'supervised', reason: null }],
    ['three starts spent: visible, never a fourth', { taskStarts: 3, lastTaskStartAtMs: NOW - 120 * MIN }, { allowed: false, state: 'failed', reason: 'task_start_failed' }],
    ['spent outranks the interval', { taskStarts: 3, lastTaskStartAtMs: NOW - 1 * MIN }, { allowed: false, state: 'failed', reason: 'task_start_failed' }],
    ['started 29 min ago', { taskStarts: 1, lastTaskStartAtMs: NOW - 29 * MIN }, { allowed: false, state: 'supervised', reason: 'task_start_rate_limited' }],
    ['started 31 min ago', { taskStarts: 1, lastTaskStartAtMs: NOW - 31 * MIN }, { allowed: true, state: 'supervised', reason: null }],
    ['the interval holds across an episode reset', { taskStarts: 0, lastTaskStartAtMs: NOW - 11 * MIN }, { allowed: false, state: 'supervised', reason: 'task_start_rate_limited' }],
  ]
  for (const [name, patch, expected] of rows) {
    assert.deepEqual(decideTaskStartGate({ ...base, ...patch } as any), expected, name)
  }
})

test('advanceLauncherEpisode: a death episode ends only once the launcher has stayed alive 10 minutes', () => {
  assert.equal(LAUNCHER_STABLE_MS, 10 * MIN)
  const at = (ms: number) => new Date(ms).toISOString()
  const rows: Array<[string, Record<string, unknown> | null, boolean, unknown]> = [
    ['no history, launcher dead', null, false, { taskStarts: 0, launcherAliveSince: null }],
    ['dead: the count holds, the alive clock stops', { taskStarts: 2, launcherAliveSince: at(NOW - 30 * MIN) }, false, { taskStarts: 2, launcherAliveSince: null }],
    ['first seen alive: the clock starts, the count holds', { taskStarts: 2, launcherAliveSince: null }, true, { taskStarts: 2, launcherAliveSince: at(NOW) }],
    ['alive 9 min: still the same episode', { taskStarts: 3, launcherAliveSince: at(NOW - 9 * MIN) }, true, { taskStarts: 3, launcherAliveSince: at(NOW - 9 * MIN) }],
    ['alive 10 min: the episode is over', { taskStarts: 3, launcherAliveSince: at(NOW - 10 * MIN) }, true, { taskStarts: 0, launcherAliveSince: at(NOW - 10 * MIN) }],
    ['junk bookkeeping reads as none', { taskStarts: -1, launcherAliveSince: 'soon' }, true, { taskStarts: 0, launcherAliveSince: at(NOW) }],
  ]
  for (const [name, prev, launcherLive, expected] of rows) {
    assert.deepEqual(advanceLauncherEpisode(prev, { launcherLive, now: NOW }), expected, name)
  }
})

// -- rate limits ---------------------------------------------------------------------------------------

test('decideRestartGate: 3 attempts per target then failed, 1 restart per sweep, 1 per agent per 30 min', () => {
  const base = { now: NOW, lastRestartAtMs: null, attempts: 0, restartsThisSweep: 0, pendingKind: 'update_pending' }
  const rows: Array<[string, Record<string, unknown>, unknown]> = [
    ['first attempt', {}, { allowed: true, state: 'update_pending', reason: null }],
    ['third attempt still allowed', { attempts: 2 }, { allowed: true, state: 'update_pending', reason: null }],
    ['three attempts spent', { attempts: 3 }, { allowed: false, state: 'failed', reason: 'attempts_exhausted' }],
    ['another agent restarted this sweep', { restartsThisSweep: 1 }, { allowed: false, state: 'update_pending', reason: 'one_restart_per_sweep' }],
    ['restarted 29 min ago', { lastRestartAtMs: NOW - 29 * MIN }, { allowed: false, state: 'update_pending', reason: 'restart_rate_limited' }],
    ['restarted 31 min ago', { lastRestartAtMs: NOW - 31 * MIN }, { allowed: true, state: 'update_pending', reason: null }],
    ['an upgrade keeps its own state name', { pendingKind: 'upgrade_pending', restartsThisSweep: 1 }, { allowed: false, state: 'upgrade_pending', reason: 'one_restart_per_sweep' }],
  ]
  for (const [name, patch, expected] of rows) {
    assert.deepEqual(decideRestartGate({ ...base, ...patch } as any), expected, name)
  }
})

test("decideRestartBudget: the agent's OWN limits (3 attempts per target, 1 per 30 min), judged whatever the agent is doing", () => {
  const base = { now: NOW, lastRestartAtMs: null, attempts: 0, pendingKind: 'update_pending' }
  const rows: Array<[string, Record<string, unknown>, unknown]> = [
    ['first attempt', {}, { allowed: true, state: 'update_pending', reason: null }],
    ['third attempt still allowed', { attempts: 2, lastRestartAtMs: NOW - 31 * MIN }, { allowed: true, state: 'update_pending', reason: null }],
    ['three attempts spent', { attempts: 3, lastRestartAtMs: NOW - 31 * MIN }, { allowed: false, state: 'failed', reason: 'attempts_exhausted' }],
    ['spent outranks the interval', { attempts: 3, lastRestartAtMs: NOW - 1 * MIN }, { allowed: false, state: 'failed', reason: 'attempts_exhausted' }],
    ['restarted 29 min ago', { attempts: 1, lastRestartAtMs: NOW - 29 * MIN }, { allowed: false, state: 'update_pending', reason: 'restart_rate_limited' }],
    ['an upgrade keeps its own state name', { pendingKind: 'upgrade_pending', attempts: 1, lastRestartAtMs: NOW - 29 * MIN }, { allowed: false, state: 'upgrade_pending', reason: 'restart_rate_limited' }],
  ]
  for (const [name, patch, expected] of rows) {
    assert.deepEqual(decideRestartBudget({ ...base, ...patch } as any), expected, name)
  }
})

test('decideInstallGate: a failed install is retried at most once an hour, one install per sweep', () => {
  const base = { now: NOW, lastInstallAtMs: null, lastInstallError: null, installsThisSweep: 0 }
  const rows: Array<[string, Record<string, unknown>, unknown]> = [
    ['never tried', {}, { allowed: true, state: 'installing', reason: null }],
    ['failed 59 min ago', { lastInstallAtMs: NOW - 59 * MIN, lastInstallError: 'install_failed:rc 1' }, { allowed: false, state: 'failed', reason: 'install_failed:rc 1' }],
    ['failed 61 min ago', { lastInstallAtMs: NOW - 61 * MIN, lastInstallError: 'install_failed:rc 1' }, { allowed: true, state: 'installing', reason: null }],
    ['installed 5 min ago, not visible yet', { lastInstallAtMs: NOW - 5 * MIN }, { allowed: false, state: 'installing', reason: 'install_retry_wait' }],
    ['another agent installed this sweep', { installsThisSweep: 1 }, { allowed: false, state: 'installing', reason: 'one_install_per_sweep' }],
  ]
  for (const [name, patch, expected] of rows) {
    assert.deepEqual(decideInstallGate({ ...base, ...patch } as any), expected, name)
  }
})

// -- consent (design 3.4) ---------------------------------------------------------------------------------

test('parseKeepAliveResponse: {enabled, enabledAt, assistantIds:number[]}; ids become digit strings; junk is null', () => {
  assert.deepEqual(parseKeepAliveResponse({ enabled: true, enabledAt: '2026-10-06T18:00:00.000Z', assistantIds: [912, 7, '42', -1, 'x', 1.5] }), {
    enabled: true,
    enabledAt: '2026-10-06T18:00:00.000Z',
    assistantIds: ['7', '42', '912'],
  })
  assert.deepEqual(parseKeepAliveResponse({ enabled: false, enabledAt: null, assistantIds: [] }), { enabled: false, enabledAt: null, assistantIds: [] })
  for (const junk of [null, [], {}, { enabled: 'yes', assistantIds: [] }, { enabled: true }, { enabled: true, assistantIds: 'all' }]) {
    assert.equal(parseKeepAliveResponse(junk), null, JSON.stringify(junk))
  }
})

test('decideKeepAliveConsent: live answer wins; a failure falls back to a cache younger than 24 h; otherwise OFF', () => {
  const live = { enabled: true, enabledAt: 'x', assistantIds: ['912'] }
  const cache = parseKeepAliveCache(buildKeepAliveCache(live, NOW - 23 * 60 * MIN))
  assert.deepEqual(decideKeepAliveConsent({ live, cache: null, now: NOW }), { ...live, source: 'live' })
  assert.deepEqual(decideKeepAliveConsent({ live: null, cache, now: NOW }), { ...live, source: 'cache' })
  const old = parseKeepAliveCache(buildKeepAliveCache(live, NOW - 25 * 60 * MIN))
  assert.deepEqual(decideKeepAliveConsent({ live: null, cache: old, now: NOW }), { enabled: false, enabledAt: null, assistantIds: [], source: 'none' })
  const future = parseKeepAliveCache(buildKeepAliveCache(live, NOW + 10 * MIN))
  assert.equal(decideKeepAliveConsent({ live: null, cache: future, now: NOW }).enabled, false, 'a cache from the future is not consent')
  assert.deepEqual(decideKeepAliveConsent({ live: null, cache: null, now: NOW }).source, 'none')
})

test('buildKeepAliveCache / parseKeepAliveCache: the design 3.4 file shape round trips; junk is null', () => {
  const body = buildKeepAliveCache({ enabled: true, enabledAt: 'e', assistantIds: ['7'] }, NOW)
  assert.deepEqual(JSON.parse(body), { schemaVersion: 1, enabled: true, enabledAt: 'e', assistantIds: ['7'], fetchedAt: new Date(NOW).toISOString() })
  assert.deepEqual(parseKeepAliveCache(body), { enabled: true, enabledAt: 'e', assistantIds: ['7'], fetchedAtMs: NOW })
  for (const junk of ['', '{', '[]', JSON.stringify({ schemaVersion: 2, enabled: true, assistantIds: [], fetchedAt: 'x' }), JSON.stringify({ schemaVersion: 1, enabled: true, assistantIds: [], fetchedAt: 'never' })]) {
    assert.equal(parseKeepAliveCache(junk), null, junk)
  }
})

// -- installed version (design 5 step 2) ----------------------------------------------------------------------

test('parseInstalledPluginRecord: the hoai entry (scope user first), its version, path and lastUpdated', () => {
  const raw = JSON.stringify({
    version: 2,
    plugins: {
      'other@hoai': [{ scope: 'user', version: '9.9.9', installPath: '/x', lastUpdated: '2026-10-06T00:00:00.000Z' }],
      'hoai@hoai': [
        { scope: 'project', version: '0.1.0', installPath: '/p', lastUpdated: '2026-01-01T00:00:00.000Z' },
        { scope: 'user', version: '0.62.0', installPath: '/c/plugins/cache/hoai/hoai/0.62.0', installedAt: '2026-10-01T00:00:00.000Z', lastUpdated: '2026-10-06T18:30:00.000Z' },
      ],
    },
  })
  assert.deepEqual(parseInstalledPluginRecord(raw), {
    version: '0.62.0',
    installPath: '/c/plugins/cache/hoai/hoai/0.62.0',
    lastUpdatedMs: Date.parse('2026-10-06T18:30:00.000Z'),
  })
  // installedAt stands in when lastUpdated is absent.
  const noUpdated = JSON.stringify({ plugins: { 'hoai@hoai': { scope: 'user', version: '0.62.0', installPath: '/c', installedAt: '2026-10-01T00:00:00.000Z' } } })
  assert.equal(parseInstalledPluginRecord(noUpdated)!.lastUpdatedMs, Date.parse('2026-10-01T00:00:00.000Z'))
  for (const junk of [null, '', '{', JSON.stringify({ plugins: {} }), JSON.stringify({ plugins: { 'hoai@hoai': [] } })]) {
    assert.equal(parseInstalledPluginRecord(junk as any), null, String(junk))
  }
})

// -- bookkeeping and the heartbeat entry ------------------------------------------------------------------------

test('advanceAgentRecord: since is kept while the state holds and reset when it changes', () => {
  const first = advanceAgentRecord(null, { state: 'waiting_idle', reason: 'background_job' }, NOW)
  assert.deepEqual(first, { state: 'waiting_idle', reason: 'background_job', since: new Date(NOW).toISOString() })
  const later = advanceAgentRecord(first, { state: 'waiting_idle', reason: 'recent_activity' }, NOW + 60 * MIN)
  assert.equal(later.since, first.since, 'same state: since holds, the reason may change')
  assert.equal(later.reason, 'recent_activity')
  const moved = advanceAgentRecord({ ...later, attempts: 2 }, { state: 'restarted', reason: null }, NOW + 61 * MIN)
  assert.equal(moved.since, new Date(NOW + 61 * MIN).toISOString())
  assert.equal(moved.attempts, 2, 'other bookkeeping rides along')
})

test('reportEntry: waitingSince appears only after 24 h of waiting_idle; strings are bounded to 120 characters', () => {
  const since = new Date(NOW - 25 * 60 * MIN).toISOString()
  assert.deepEqual(reportEntry('912', { state: 'waiting_idle', reason: 'background_job', since }, NOW), {
    id: '912',
    state: 'waiting_idle',
    reason: 'background_job',
    since,
    waitingSince: since,
  })
  const recent = new Date(NOW - 23 * 60 * MIN).toISOString()
  assert.deepEqual(reportEntry('912', { state: 'waiting_idle', reason: 'background_job', since: recent }, NOW), {
    id: '912',
    state: 'waiting_idle',
    reason: 'background_job',
    since: recent,
  })
  const long = reportEntry('7', { state: 'failed', reason: `install_failed:${'x'.repeat(300)}`, since: recent }, NOW)
  assert.equal(long.reason!.length, 120)
  assert.deepEqual(reportEntry('7', { state: 'supervised', reason: null, since: recent }, NOW), { id: '7', state: 'supervised', since: recent })
})
