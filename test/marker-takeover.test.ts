/**
 * The daemon side of the restart-marker takeover (Windows): the active daemon
 * notices a restart-requested.json that its hoai launcher did not act on, and
 * hands the restart to a detached helper (lib/restart-handoff.mjs).
 *
 * Why it exists. bin/hoai-core.mjs (byte identical at v0.66.1 and main, the
 * same logic at v0.44.0) allows 3 marker relaunches per rolling hour per
 * launcher process. The 4th marker is deleted BEFORE the budget check
 * (:2295 before :2296) and ignored, and `exhausted` (:2228, set at :2299) is
 * never reset, so from then on every marker stays on disk (:2293). Launchers
 * already running in the field cannot be changed, and no daemon read the
 * marker at all (0.67.x only writes it, server.ts writeMarker), so nobody
 * acted: Mark's agent 909 on 2026-10-12, write 1 gone with claude on the same
 * pid, write 2 on disk for more than a minute.
 *
 * Run: npx tsx --test test/marker-takeover.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MARKER_POLL_MS, MAX_RELAUNCHES_PER_WINDOW, RELAUNCH_HEALTHY_MS, RELAUNCH_WINDOW_MS } from '../bin/hoai-core.mjs'
import { WIN32_JSC_THREAD_OPTIONS } from '../bin/bgos-launch.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const MISSING =
  'lib/marker-takeover.mjs is missing: no daemon code reads restart-requested.json (0.67.x only writes it, server.ts writeMarker), ' +
  'so a marker the hoai launcher refuses (bin/hoai-core.mjs:2295-2299) is never acted on'
const mod: any = await import('../lib/marker-takeover.mjs').catch(() => null)
const m = () => {
  assert.ok(mod, MISSING)
  return mod
}

const BOOT = 1_800_000_000_000
const STATE = 'C:\\Users\\kc\\.bgos-agent\\909'
const MARKER = `${STATE}\\restart-requested.json`
const SUPERVISOR = `${STATE}\\supervisor.json`
const LAUNCH = `${STATE}\\launch.json`
const LEDGER = `${STATE}\\restart-takeovers.json`
const LOCK = `${STATE}\\restart-handoff.lock`
const LAUNCHER_PID = 48480
const CLAUDE_PID = 68444
const DAEMON_PID = 70001
const SUP_RAW = JSON.stringify({ pid: LAUNCHER_PID, capabilities: ['relaunch'], startedAt: new Date(BOOT - 3_600_000).toISOString() })

/** A small Windows-shaped disk: path -> { text, mtimeMs }. */
class Disk {
  files = new Map<string, { text: string; mtimeMs: number }>()
  renames: Array<[string, string]> = []
  constructor(public clock: { now: number }) {}
  put(path: string, text: string, mtimeMs = this.clock.now) {
    this.files.set(path, { text, mtimeMs })
  }
  fs() {
    return {
      stat: (p: string) => (this.files.has(p) ? { mtimeMs: this.files.get(p)!.mtimeMs } : null),
      readFile: (p: string) => this.files.get(p)?.text ?? null,
      rename: (from: string, to: string) => {
        const f = this.files.get(from)
        if (!f) return 'gone'
        this.files.delete(from)
        this.files.set(to, f)
        this.renames.push([from, to])
        return 'ok'
      },
    }
  }
}

function controller(over: Record<string, any> = {}) {
  const clock = { now: BOOT + 120_000 }
  const disk = new Disk(clock)
  disk.put(SUPERVISOR, SUP_RAW, BOOT - 3_600_000)
  disk.put(LAUNCH, '{"cwd":"C:\\\\agents\\\\vera"}', BOOT - 2_000)
  const logs: string[] = []
  const spawns: Array<{ argv: string[]; env: Record<string, string> }> = []
  let active = true
  const alive = new Set([LAUNCHER_PID, CLAUDE_PID, DAEMON_PID])
  const intervals: Array<() => void> = []
  const c = m().createMarkerTakeover({
    platform: 'win32',
    assistantId: '909',
    stateDir: STATE,
    bootAtMs: BOOT,
    now: () => clock.now,
    ownPid: DAEMON_PID,
    active: () => active,
    claudePid: () => CLAUDE_PID,
    fs: disk.fs(),
    pidAlive: (pid: number) => alive.has(pid),
    setInterval: (fn: () => void) => {
      intervals.push(fn)
      return intervals.length
    },
    clearInterval: () => {},
    setTimeout: () => 0,
    watch: () => ({ close() {}, on() {} }),
    spawnHelper: (argv: string[], env: Record<string, string>) => {
      spawns.push({ argv, env })
      return { pid: 90001 }
    },
    helperParams: () => ({
      home: 'C:\\Users\\kc',
      launchCwd: 'C:\\agents\\vera',
      logPath: 'C:\\Users\\kc\\.bgos-agent\\logs\\bgos-plugin-909.log',
      pluginStateDir: 'C:\\Users\\kc\\.bgos-plugin-state\\909',
      credentialsPath: 'C:\\Users\\kc\\.bgos-agent\\credentials-909.json',
      pluginRoot: 'C:\\agents\\plugin',
    }),
    helperEnv: () => ({ PATH: 'C:\\Windows' }),
    log: (line: string) => logs.push(line),
    ...over,
  })
  return {
    c,
    clock,
    disk,
    logs,
    spawns,
    alive,
    setActive: (v: boolean) => (active = v),
    at: (ms: number) => (clock.now = ms),
    write: (text = '{"reason":"proof","requestedBy":"mark"}') => disk.put(MARKER, text, clock.now),
    run: (ms: number, step = 500) => {
      let last: any = null
      const end = clock.now + ms
      while (clock.now < end) {
        clock.now += step
        last = c.tick('poll') ?? last
      }
      return last
    },
  }
}

// -- the module exists, and its timings sit where the launcher's do ------------

test('the timings are tied to the launcher: stranded after 5 polls, swallow bound 2 polls + 1 s, session up longer than the health window', () => {
  const t = m()
  assert.equal(t.STRANDED_AFTER_MS, 5 * MARKER_POLL_MS)
  assert.equal(t.SWALLOW_MAX_LIFETIME_MS, 2 * MARKER_POLL_MS + 1_000)
  assert.ok(t.MIN_SESSION_UP_MS > RELAUNCH_HEALTHY_MS, 'a takeover must never land in the launcher health window (retry-fresh mints a NEW session)')
  assert.equal(t.TAKEOVER_LEDGER_FILE_NAME, 'restart-takeovers.json')
})

// -- observeMarker --------------------------------------------------------------

test('observeMarker: a marker written before the daemon started is stale and never a candidate, even 2 hours later', () => {
  const { observeMarker } = m()
  let state = null
  const reading = { present: true, mtimeMs: BOOT - 1, source: 'poll', supervisorRaw: SUP_RAW, launchMtimeMs: 1 }
  let out = observeMarker(state, reading, { now: BOOT + 1000, bootAtMs: BOOT })
  assert.deepEqual(out.events, ['stale'])
  assert.equal(out.candidate, null)
  out = observeMarker(out.state, reading, { now: BOOT + 7_200_000, bootAtMs: BOOT })
  assert.deepEqual(out.events, [], 'logged once')
  assert.equal(out.candidate, null)
  // A marker written AT the boot instant is stale too: the session it would restart started with it.
  out = observeMarker(null, { ...reading, mtimeMs: BOOT }, { now: BOOT + 999_999, bootAtMs: BOOT })
  assert.equal(out.candidate, null)
})

test('observeMarker: a fresh marker still on disk 15 s after it was seen is stranded; at 14.999 s it is not', () => {
  const { observeMarker, STRANDED_AFTER_MS } = m()
  const reading = { present: true, mtimeMs: BOOT + 60_000, source: 'poll', supervisorRaw: SUP_RAW, launchMtimeMs: 5 }
  const seen = observeMarker(null, reading, { now: BOOT + 60_100, bootAtMs: BOOT })
  assert.deepEqual(seen.events, ['seen'])
  const early = observeMarker(seen.state, reading, { now: BOOT + 60_100 + STRANDED_AFTER_MS - 1, bootAtMs: BOOT })
  assert.equal(early.candidate, null)
  const due = observeMarker(early.state, reading, { now: BOOT + 60_100 + STRANDED_AFTER_MS, bootAtMs: BOOT })
  assert.equal(due.candidate?.kind, 'stranded')
  assert.equal(due.candidate?.markerMtimeMs, BOOT + 60_000)
  assert.equal(due.candidate?.supervisorRawAtSight, SUP_RAW)
})

test('observeMarker: an overwrite (a new mtime) is a new marker and restarts the clock', () => {
  const { observeMarker, STRANDED_AFTER_MS } = m()
  const r1 = { present: true, mtimeMs: BOOT + 60_000, source: 'poll', supervisorRaw: SUP_RAW, launchMtimeMs: 5 }
  const s1 = observeMarker(null, r1, { now: BOOT + 60_000, bootAtMs: BOOT })
  const r2 = { ...r1, mtimeMs: BOOT + 70_000 }
  const s2 = observeMarker(s1.state, r2, { now: BOOT + 70_000, bootAtMs: BOOT })
  assert.deepEqual(s2.events, ['seen'])
  const s3 = observeMarker(s2.state, r2, { now: BOOT + 60_000 + STRANDED_AFTER_MS + 1, bootAtMs: BOOT })
  assert.equal(s3.candidate, null, 'the clock restarted at the overwrite')
})

test('observeMarker: a fresh marker removed within 7 s while this session lives is swallowed 10 s later, not at 9.999 s', () => {
  const { observeMarker, SWALLOW_CONFIRM_MS, SWALLOW_MAX_LIFETIME_MS } = m()
  const present = { present: true, mtimeMs: BOOT + 60_000, source: 'watch-named', supervisorRaw: SUP_RAW, launchMtimeMs: 5 }
  const absent = { present: false, mtimeMs: null, source: 'poll' }
  const seen = observeMarker(null, present, { now: BOOT + 60_000, bootAtMs: BOOT })
  const gone = observeMarker(seen.state, absent, { now: BOOT + 60_000 + SWALLOW_MAX_LIFETIME_MS, bootAtMs: BOOT })
  assert.deepEqual(gone.events, ['vanished'])
  const vanishedAt = BOOT + 60_000 + SWALLOW_MAX_LIFETIME_MS
  const early = observeMarker(gone.state, absent, { now: vanishedAt + SWALLOW_CONFIRM_MS - 1, bootAtMs: BOOT })
  assert.equal(early.candidate, null)
  const due = observeMarker(early.state, absent, { now: vanishedAt + SWALLOW_CONFIRM_MS, bootAtMs: BOOT })
  assert.equal(due.candidate?.kind, 'swallowed')
  assert.equal(due.candidate?.launchMtimeAtSight, 5)
})

test('observeMarker: a marker removed later than two launcher polls was removed by someone else, never a swallow', () => {
  const { observeMarker, SWALLOW_MAX_LIFETIME_MS } = m()
  const present = { present: true, mtimeMs: BOOT + 60_000, source: 'poll', supervisorRaw: SUP_RAW, launchMtimeMs: 5 }
  const absent = { present: false, mtimeMs: null, source: 'poll' }
  const seen = observeMarker(null, present, { now: BOOT + 60_000, bootAtMs: BOOT })
  const gone = observeMarker(seen.state, absent, { now: BOOT + 60_000 + SWALLOW_MAX_LIFETIME_MS + 1, bootAtMs: BOOT })
  assert.deepEqual(gone.events, ['removed_by_other'])
  const later = observeMarker(gone.state, absent, { now: BOOT + 600_000, bootAtMs: BOOT })
  assert.equal(later.candidate, null)
  // And the same marker coming back (same mtime) is not tracked again.
  const back = observeMarker(later.state, present, { now: BOOT + 600_500, bootAtMs: BOOT })
  assert.deepEqual(back.events, [])
})

test('observeMarker: an event with no marker on disk never makes a sighting by itself (a stale marker being deleted fires one too)', () => {
  const { observeMarker } = m()
  for (const source of ['watch-named', 'watch-other', 'poll']) {
    const out = observeMarker(null, { present: false, mtimeMs: null, source }, { now: BOOT + 60_000, bootAtMs: BOOT })
    assert.equal(out.state, null, source)
    assert.deepEqual(out.events, [], source)
  }
})

// -- decideMarkerTakeover -------------------------------------------------------

function facts(over: Record<string, any> = {}) {
  return {
    platform: 'win32',
    now: BOOT + 120_000,
    bootAtMs: BOOT,
    active: true,
    ownPid: DAEMON_PID,
    claudePid: CLAUDE_PID,
    supervisorRaw: SUP_RAW,
    launcherAlive: true,
    launchMtimeMs: 5,
    ledger: { entries: [], unreadable: false, junkBlocksUntilMs: null },
    handoffLockLive: false,
    candidate: { kind: 'stranded', key: 'm1', markerMtimeMs: BOOT + 60_000, firstSeenAtMs: BOOT + 60_000, vanishedAtMs: null, supervisorRawAtSight: SUP_RAW, launchMtimeAtSight: 5 },
    ...over,
  }
}

test('decideMarkerTakeover: everything in order acts', () => {
  assert.deepEqual(m().decideMarkerTakeover(facts()), { action: 'act', reason: 'unanswered', kind: 'stranded' })
})

test('decideMarkerTakeover: off Windows nothing, and no candidate nothing', () => {
  const { decideMarkerTakeover } = m()
  assert.equal(decideMarkerTakeover(facts({ platform: 'linux' })).action, 'none')
  assert.equal(decideMarkerTakeover(facts({ candidate: null })).action, 'none')
})

test('decideMarkerTakeover: a passive daemon (a second copy of the agent) never acts', () => {
  assert.deepEqual(m().decideMarkerTakeover(facts({ active: false })), { action: 'refuse', reason: 'passive', kind: 'stranded' })
  // A daemon still young may only be on its way to the lock: it waits instead of refusing for good.
  assert.equal(m().decideMarkerTakeover(facts({ active: false, now: BOOT + 30_000 })).action, 'wait')
})

test('decideMarkerTakeover: a session up less than MIN_SESSION_UP_MS waits (and keeps the candidate), then acts', () => {
  const { decideMarkerTakeover, MIN_SESSION_UP_MS } = m()
  assert.equal(decideMarkerTakeover(facts({ now: BOOT + MIN_SESSION_UP_MS - 1 })).action, 'wait')
  assert.equal(decideMarkerTakeover(facts({ now: BOOT + MIN_SESSION_UP_MS })).action, 'act')
})

test('decideMarkerTakeover: no live hoai launcher (missing, junk, no relaunch, the daemon\'s own record, own or claude pid, dead) is left alone', () => {
  const { decideMarkerTakeover } = m()
  const declared = JSON.stringify({ pid: DAEMON_PID, capabilities: ['relaunch'], startedAt: new Date(BOOT).toISOString(), supervisor: { kind: 'launcher' } })
  for (const [why, over] of [
    ['missing', { supervisorRaw: null }],
    ['junk', { supervisorRaw: '{' }],
    ['no relaunch', { supervisorRaw: JSON.stringify({ pid: LAUNCHER_PID, capabilities: [] }) }],
    ['declared by the daemon', { supervisorRaw: declared }],
    ['own pid', { supervisorRaw: JSON.stringify({ pid: DAEMON_PID, capabilities: ['relaunch'] }) }],
    ['claude pid', { supervisorRaw: JSON.stringify({ pid: CLAUDE_PID, capabilities: ['relaunch'] }) }],
    ['dead', { launcherAlive: false }],
  ] as const) {
    const out = decideMarkerTakeover(facts({ ...over, candidate: { ...facts().candidate, supervisorRawAtSight: (over as any).supervisorRaw ?? SUP_RAW } }))
    assert.equal(out.action, 'refuse', why)
    assert.equal(out.reason, 'no_live_hoai_launcher', why)
  }
})

test('decideMarkerTakeover: supervisor.json rewritten since the marker was seen (a launcher re-armed or relaunched) is launcher_changed', () => {
  const raw2 = JSON.stringify({ pid: LAUNCHER_PID, capabilities: ['relaunch'], startedAt: new Date(BOOT + 61_000).toISOString() })
  assert.deepEqual(m().decideMarkerTakeover(facts({ supervisorRaw: raw2 })), { action: 'refuse', reason: 'launcher_changed', kind: 'stranded' })
})

test('decideMarkerTakeover: a swallowed marker with launch.json rewritten was honoured (or a claude.cmd wrapper was killed): launcher_relaunched', () => {
  const swallowed = { ...facts().candidate, kind: 'swallowed', vanishedAtMs: BOOT + 61_000 }
  const { decideMarkerTakeover } = m()
  assert.deepEqual(decideMarkerTakeover(facts({ candidate: swallowed, launchMtimeMs: 6 })), { action: 'refuse', reason: 'launcher_relaunched', kind: 'swallowed' })
  assert.equal(decideMarkerTakeover(facts({ candidate: swallowed })).action, 'act')
})

test('decideMarkerTakeover: the loop guard is the launcher\'s own budget, 3 per rolling hour, and a future-dated entry counts', () => {
  const { decideMarkerTakeover } = m()
  const now = BOOT + 120_000
  const entry = (atMs: number, markerMtimeMs = atMs) => ({ atMs, kind: 'stranded', markerMtimeMs })
  const two = [entry(now - 1000), entry(now - 2000)]
  assert.equal(decideMarkerTakeover(facts({ ledger: { entries: two, unreadable: false, junkBlocksUntilMs: null } })).action, 'act')
  const three = [...two, entry(now + 60_000)]
  const capped = decideMarkerTakeover(facts({ ledger: { entries: three, unreadable: false, junkBlocksUntilMs: null } }))
  assert.equal(capped.action, 'refuse')
  assert.equal(capped.reason, 'cap')
  assert.equal(MAX_RELAUNCHES_PER_WINDOW, 3)
  const old = [...two, entry(now - RELAUNCH_WINDOW_MS)]
  assert.equal(decideMarkerTakeover(facts({ ledger: { entries: old, unreadable: false, junkBlocksUntilMs: null } })).action, 'act', 'an entry exactly an hour old no longer counts')
})

test('decideMarkerTakeover: a marker already in the ledger (by its mtime) is never taken over twice', () => {
  const ledger = { entries: [{ atMs: BOOT + 100_000, kind: 'stranded', markerMtimeMs: BOOT + 60_000 }], unreadable: false, junkBlocksUntilMs: null }
  assert.deepEqual(m().decideMarkerTakeover(facts({ ledger })), { action: 'refuse', reason: 'already_taken_over', kind: 'stranded' })
})

test('decideMarkerTakeover: a junk ledger blocks for an hour from its mtime, then reads as empty', () => {
  const { decideMarkerTakeover, parseTakeoverLedger } = m()
  const now = BOOT + 120_000
  const fresh = parseTakeoverLedger('not json', { now, fileMtimeMs: now - 1000 })
  assert.equal(fresh.unreadable, true)
  assert.equal(decideMarkerTakeover(facts({ ledger: fresh })).reason, 'ledger_unreadable')
  const old = parseTakeoverLedger('not json', { now, fileMtimeMs: now - RELAUNCH_WINDOW_MS - 1 })
  assert.equal(decideMarkerTakeover(facts({ ledger: old })).action, 'act')
  assert.deepEqual(parseTakeoverLedger(null, { now, fileMtimeMs: null }), { entries: [], unreadable: false, junkBlocksUntilMs: null })
})

test('decideMarkerTakeover: a live handoff lock means a helper is already at work', () => {
  assert.deepEqual(m().decideMarkerTakeover(facts({ handoffLockLive: true })), { action: 'refuse', reason: 'handoff_in_progress', kind: 'stranded' })
})

test('handoffLockLive: a live pid under 15 minutes old holds it; a dead pid or an old lock does not', () => {
  const { parseHandoffLock, handoffLockLive, HANDOFF_LOCK_STALE_MS } = m()
  const lock = parseHandoffLock(JSON.stringify({ pid: 90001, at: new Date(BOOT).toISOString() }))
  assert.deepEqual(lock, { pid: 90001, atMs: BOOT })
  assert.equal(handoffLockLive(lock, { now: BOOT + 1000, pidAlive: () => true }), true)
  assert.equal(handoffLockLive(lock, { now: BOOT + 1000, pidAlive: () => false }), false)
  assert.equal(handoffLockLive(lock, { now: BOOT + HANDOFF_LOCK_STALE_MS, pidAlive: () => true }), false)
  assert.equal(parseHandoffLock('junk'), null)
})

test('ledgerBodyWith: appends, prunes past a day and past 20 entries, keeps the schema', () => {
  const { ledgerBodyWith, parseTakeoverLedger, LEDGER_KEEP_MS, LEDGER_KEEP_MAX } = m()
  const now = BOOT + 10 * LEDGER_KEEP_MS
  const many = Array.from({ length: 30 }, (_, i) => ({ atMs: now - i * 1000, kind: 'stranded', markerMtimeMs: i }))
  const body = ledgerBodyWith([{ atMs: now - LEDGER_KEEP_MS - 1, kind: 'swallowed', markerMtimeMs: null }, ...many], { atMs: now, kind: 'swallowed', markerMtimeMs: 7, claudePid: 1, launcherPid: 2, daemonPid: 3, pin: 'p', route: 'task' }, now)
  const parsed = JSON.parse(body)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.takeovers.length, LEDGER_KEEP_MAX)
  assert.equal(parsed.takeovers.at(-1).route, 'task')
  const back = parseTakeoverLedger(body, { now, fileMtimeMs: now })
  assert.equal(back.entries.length, LEDGER_KEEP_MAX)
  assert.equal(back.entries.at(-1).atMs, now)
})

// -- the environment the helper (and a hidden relaunch) gets ---------------------

test('handoffEnv: drops Claude Code session markers and every key the plugin and the folder inject, keeps user settings', () => {
  const { handoffEnv, mcpEnvKeys, SESSION_ENV_KEYS } = m()
  const plugin = readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')
  const folder = JSON.stringify({ mcpServers: { bgos: { command: 'bun', env: { BGOS_ASSISTANT_ID: '909', BGOS_AUTO_UPDATE: 'off' } } } })
  const extraKeys = mcpEnvKeys(plugin, folder, 'junk', null)
  for (const key of ['BGOS_API_KEY', 'BGOS_ASSISTANT_ID', 'BGOS_AUTO_UPDATE']) assert.ok(extraKeys.has(key), key)
  const env = {
    ClaudeCode: '1', // case-insensitive on Windows
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '1234',
    CLAUDE_PROJECT_DIR: 'C:\\agents\\vera',
    CLAUDE_PLUGIN_ROOT: 'C:\\x',
    BGOS_API_KEY: 'secret',
    BGOS_ASSISTANT_ID: '909',
    BGOS_AUTO_UPDATE: 'off',
    BGOS_LAUNCH_CWD: 'C:\\agents\\vera',
    HOAI_SUPERVISED: '1',
    PATH: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\kc',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
    CLAUDE_CONFIG_DIR: 'C:\\cfg',
    CLAUDE_CODE_USE_BEDROCK: '1',
    MCP_TIMEOUT: '9000',
    BGOS_PLUGIN_STATE_DIR: 'D:\\state',
  }
  const out = handoffEnv(env, { platform: 'win32', extraKeys })
  for (const gone of ['ClaudeCode', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'BGOS_API_KEY', 'BGOS_ASSISTANT_ID', 'BGOS_AUTO_UPDATE', 'BGOS_LAUNCH_CWD', 'HOAI_SUPERVISED']) {
    assert.equal(gone in out, false, gone)
  }
  for (const kept of ['PATH', 'USERPROFILE', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'MCP_TIMEOUT', 'BGOS_PLUGIN_STATE_DIR']) {
    assert.equal(out[kept], (env as any)[kept], kept)
  }
  assert.ok(SESSION_ENV_KEYS.includes('CLAUDECODE'))
  assert.equal(env.BGOS_API_KEY, 'secret', 'the input is not mutated')
})

test('handoffEnv: the JSC thread options the launcher gives this daemon on Windows never reach the helper or a relaunched claude', () => {
  const { handoffEnv, SESSION_ENV_KEYS } = m()
  for (const key of Object.keys(WIN32_JSC_THREAD_OPTIONS)) assert.ok(SESSION_ENV_KEYS.includes(key), key)
  const out = handoffEnv({ ...WIN32_JSC_THREAD_OPTIONS, PATH: 'C:\\Windows' }, { platform: 'win32' })
  assert.deepEqual(out, { PATH: 'C:\\Windows' })
})

test('handoffArgv and parseHandoffArgv round trip; junk ids, pids, kinds and relative paths give null', () => {
  const { handoffArgv, parseHandoffArgv } = m()
  const params = {
    assistantId: '909', kind: 'swallowed', markerMtimeMs: BOOT + 60_000, bootAtMs: BOOT, daemonPid: DAEMON_PID, claudePid: CLAUDE_PID,
    launcherPid: LAUNCHER_PID, stateDir: STATE, home: 'C:\\Users\\kc', launchCwd: 'C:\\agents\\vera', logPath: 'C:\\Users\\kc\\.bgos-agent\\logs\\bgos-plugin-909.log',
    pluginStateDir: 'C:\\Users\\kc\\.bgos-plugin-state\\909', credentialsPath: 'C:\\Users\\kc\\.bgos-agent\\credentials-909.json', pluginRoot: 'C:\\agents\\plugin',
  }
  const argv = handoffArgv(params)
  assert.ok(argv.every((a: unknown) => typeof a === 'string'))
  assert.deepEqual(parseHandoffArgv(argv), params)
  const broken = (key: string, value: string) => {
    const i = argv.indexOf(`--${key}`)
    const copy = [...argv]
    copy[i + 1] = value
    return parseHandoffArgv(copy)
  }
  assert.equal(broken('assistant', '9 09'), null)
  assert.equal(broken('assistant', '..\\x'), null)
  assert.equal(broken('daemon-pid', '1'), null)
  assert.equal(broken('launcher-pid', 'x'), null)
  assert.equal(broken('kind', 'restart'), null)
  assert.equal(broken('state-dir', 'relative\\dir'), null)
  assert.equal(broken('plugin-root', '..\\plugin'), null)
  assert.equal(parseHandoffArgv([]), null)
})

test('currentPluginRootFor: a marketplace install relaunches from the INSTALLED root (the running cache dir may be the old version)', () => {
  const { currentPluginRootFor } = m()
  const installed = JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ installPath: 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.68.2', version: '0.68.2' }] } })
  const exists = (p: string) => p === 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.68.2\\bin\\hoai-core.mjs'
  assert.equal(currentPluginRootFor({ installMethod: 'marketplace', pluginRoot: 'C:\\old', installedPluginsRaw: installed, exists }), 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.68.2')
  assert.equal(currentPluginRootFor({ installMethod: 'marketplace', pluginRoot: 'C:\\old', installedPluginsRaw: installed, exists: () => false }), 'C:\\old')
  assert.equal(currentPluginRootFor({ installMethod: 'marketplace', pluginRoot: 'C:\\old', installedPluginsRaw: null, exists }), 'C:\\old')
  assert.equal(currentPluginRootFor({ installMethod: 'clone', pluginRoot: 'C:\\agents\\plugin', installedPluginsRaw: installed, exists }), 'C:\\agents\\plugin')
})

// -- the controller -------------------------------------------------------------

test('controller: off Windows start() arms nothing and a tick does nothing', () => {
  const h = controller({ platform: 'linux' })
  h.c.start()
  h.write()
  assert.equal(h.run(120_000), null)
  assert.equal(h.spawns.length, 0)
})

test('controller: a stranded marker under a live launcher spawns exactly ONE helper with the handoff argv and env, logs ACT, then stops', () => {
  const h = controller()
  h.c.start()
  assert.ok(h.logs.some((l) => l.startsWith('restart takeover: armed for ')), h.logs.join('\n'))
  h.write()
  h.c.tick('watch-named')
  assert.ok(h.logs.some((l) => l.startsWith('restart takeover: marker seen')), h.logs.join('\n'))
  h.run(14_000)
  assert.equal(h.spawns.length, 0, 'the launcher gets its 15 s')
  h.run(2_000)
  assert.equal(h.spawns.length, 1)
  const params = m().parseHandoffArgv(h.spawns[0].argv)
  assert.equal(params.kind, 'stranded')
  assert.equal(params.launcherPid, LAUNCHER_PID)
  assert.equal(params.claudePid, CLAUDE_PID)
  assert.equal(params.daemonPid, DAEMON_PID)
  assert.deepEqual(h.spawns[0].env, { PATH: 'C:\\Windows' })
  assert.ok(h.logs.some((l) => /^restart takeover: ACT \(stranded\): hoai launcher pid 48480 left the marker written .* unanswered; takeover 1 of 3 this hour; helper pid 90001/.test(l)), h.logs.join('\n'))
  // The daemon claims nothing and writes nothing: the helper does, after proving the session.
  assert.deepEqual(h.disk.renames, [])
  assert.ok(h.disk.files.has(MARKER))
  assert.equal(h.disk.files.has(LEDGER), false)
  h.write('{"again":1}')
  h.run(60_000)
  assert.equal(h.spawns.length, 1, 'one helper per daemon process')
})

test('controller: a swallowed marker (the launcher\'s deny branch deleted it, this session lives on) spawns the helper with kind swallowed', () => {
  const h = controller()
  h.c.start()
  h.write()
  h.c.tick('watch-named')
  h.clock.now += 2_000
  h.disk.files.delete(MARKER)
  h.c.tick('watch-named')
  h.run(9_000)
  assert.equal(h.spawns.length, 0)
  h.run(1_500)
  assert.equal(h.spawns.length, 1)
  assert.equal(m().parseHandoffArgv(h.spawns[0].argv).kind, 'swallowed')
})

test('controller: a passive daemon never spawns and never touches the disk', () => {
  const h = controller()
  h.setActive(false)
  h.c.start()
  h.write()
  h.run(120_000)
  assert.equal(h.spawns.length, 0)
  assert.deepEqual(h.disk.renames, [])
  assert.ok(h.logs.some((l) => /NOT acting on the marker written .*: passive/.test(l)), h.logs.join('\n'))
})

test('controller: the cap refuses, and a stranded marker is set aside as restart-requested.refused.json, never restarted later', () => {
  const h = controller()
  const now = h.clock.now
  h.disk.put(LEDGER, JSON.stringify({ schemaVersion: 1, takeovers: [1, 2, 3].map((i) => ({ at: new Date(now - i * 60_000).toISOString(), kind: 'stranded', markerMtimeMs: i })) }), now - 60_000)
  h.c.start()
  h.write()
  h.run(20_000)
  assert.equal(h.spawns.length, 0)
  assert.equal(h.disk.files.has(MARKER), false)
  assert.ok(h.disk.files.has(`${STATE}\\restart-requested.refused.json`))
  assert.ok(h.logs.some((l) => l.startsWith('restart takeover: REFUSED (loop guard): 3 takeovers in the last hour')), h.logs.join('\n'))
})

test('controller: the spawn throwing is logged, nothing is claimed, and it never spawns again', () => {
  let calls = 0
  const h = controller({
    spawnHelper: () => {
      calls += 1
      throw new Error('EACCES')
    },
  })
  h.c.start()
  h.write()
  h.run(20_000)
  h.write('{"again":1}')
  h.run(60_000)
  assert.equal(calls, 1)
  assert.ok(h.logs.some((l) => l.startsWith('restart takeover: HANDOFF DID NOT START (EACCES)')), h.logs.join('\n'))
  assert.deepEqual(h.disk.renames, [])
})

test('controller: a daemon that boots after a takeover never acts on what is left on disk', () => {
  const h = controller()
  h.write()
  // The marker predates this daemon: the session it asked to restart is the one before it.
  const late = controller({ bootAtMs: h.clock.now + 1, fs: h.disk.fs() })
  late.clock.now = h.clock.now + 600_000
  late.c.start()
  late.run(120_000)
  assert.equal(late.spawns.length, 0)
  assert.ok(late.logs.some((l) => l.startsWith('restart takeover: stale marker on disk')), late.logs.join('\n'))
})
