/**
 * lib/idle-update-host.mjs: the readings server.ts hands the idle update
 * controller, and the marketplace half of its rollback
 * (docs/idle-update/DESIGN.md, "Rollback" and "Platforms"). Each one reads a
 * file or runs one command through an injected fs or exec, so every answer,
 * the fail-closed ones above all, is pinned here.
 *
 * Run: npx tsx --test test/idle-update.host.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Only a missing module reads as missing; a module that does not load is a failure of its own.
const mod: any = await import('../lib/idle-update-host.mjs').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
  throw err
})

const MISSING =
  'lib/idle-update-host.mjs is missing: server.ts has no reading of the launcher claim, a person at the tmux session, ' +
  'the watcher sweep or the wake schedule to hand the idle update, and no way to put a marketplace install back'
function need(): any {
  if (!mod) assert.fail(MISSING)
  return mod
}

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const MIN = 60_000
const HOME = '/Users/a'
const STATE = '/Users/a/.bgos-agent/912'
const MACHINE = '/Users/a/.bgos-agent/idle-update'

function memFs(files: Record<string, { text: string; mtimeMs?: number } | string> = {}) {
  const map = new Map<string, { text: string; mtimeMs: number }>()
  for (const [p, v] of Object.entries(files)) map.set(p, typeof v === 'string' ? { text: v, mtimeMs: NOW - 60 * MIN } : { text: v.text, mtimeMs: v.mtimeMs ?? NOW - 60 * MIN })
  const writes: Array<{ path: string; text: string }> = []
  return {
    map,
    writes,
    readFile: (p: string) => map.get(p)?.text ?? null,
    mtimeMs: (p: string) => map.get(p)?.mtimeMs ?? null,
    listDir: (p: string) => {
      const prefix = `${p}/`
      const names = new Set<string>()
      for (const key of map.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0])
      return names.size ? [...names] : null
    },
    writeAtomic: (p: string, text: string) => {
      writes.push({ path: p, text })
      map.set(p, { text, mtimeMs: NOW })
      return true
    },
    remove: (p: string) => map.delete(p),
  }
}

// -- The launcher claim (supervisor.json) -------------------------------------------------------

const SUPERVISOR = `${STATE}/supervisor.json`

test('a live relaunch launcher: its pid, its claimed start, the marker path, and when the claim was written', () => {
  const fs = memFs({ [SUPERVISOR]: { text: JSON.stringify({ pid: 620, capabilities: ['relaunch'], startedAt: '2026-10-28T09:00:00.000Z' }), mtimeMs: NOW - 3 * 60 * MIN } })
  const claim = need().readLauncherClaim({ stateDir: STATE, fs, alive: (pid: number) => pid === 620 })
  assert.deepEqual(claim, {
    pid: 620,
    startedAtMs: Date.parse('2026-10-28T09:00:00.000Z'),
    markerPath: `${STATE}/restart-requested.json`,
    supervisorMtimeMs: NOW - 3 * 60 * MIN,
  })
})

test('no relaunch promise, a dead pid, or a claim that does not parse: no launcher', () => {
  const m = need()
  const alive = () => true
  assert.equal(m.readLauncherClaim({ stateDir: STATE, fs: memFs({ [SUPERVISOR]: JSON.stringify({ pid: 620, capabilities: [] }) }), alive }), null)
  assert.equal(m.readLauncherClaim({ stateDir: STATE, fs: memFs({ [SUPERVISOR]: JSON.stringify({ pid: 620, capabilities: ['relaunch'] }) }), alive: () => false }), null)
  assert.equal(m.readLauncherClaim({ stateDir: STATE, fs: memFs({ [SUPERVISOR]: '{ junk' }), alive }), null)
  assert.equal(m.readLauncherClaim({ stateDir: STATE, fs: memFs(), alive }), null)
  assert.equal(m.readLauncherClaim({ stateDir: STATE, fs: memFs({ [SUPERVISOR]: JSON.stringify({ pid: -4, capabilities: ['relaunch'] }) }), alive }), null)
})

test('a claim with no start time still names the launcher; the start is then unknown', () => {
  const fs = memFs({ [SUPERVISOR]: JSON.stringify({ pid: 620, capabilities: ['relaunch'] }) })
  assert.equal(need().readLauncherClaim({ stateDir: STATE, fs, alive: () => true }).startedAtMs, null)
})

test('the restart marker: its age when one waits, null when none does', () => {
  const m = need()
  assert.equal(m.readMarkerMtimeMs({ stateDir: STATE, fs: memFs({ [`${STATE}/restart-requested.json`]: { text: '{}', mtimeMs: NOW - 2 * MIN } }) }), NOW - 2 * MIN)
  assert.equal(m.readMarkerMtimeMs({ stateDir: STATE, fs: memFs() }), null)
})

// -- The unattended proof's inputs --------------------------------------------------------------

test('the restart marker taken back: that one file, and a removal that fails says so', () => {
  const m = need()
  const removed: string[] = []
  assert.equal(m.removeRestartMarker({ stateDir: STATE, fs: { remove: (p: string) => { removed.push(p); return true } } }), true)
  assert.deepEqual(removed, [`${STATE}/restart-requested.json`])
  assert.equal(m.removeRestartMarker({ stateDir: STATE, fs: { remove: () => false } }), false)
  assert.equal(m.removeRestartMarker({ stateDir: STATE, fs: { remove: () => { throw new Error('EBUSY') } } }), false)
})

test('the unattended inputs: this HOME\'s tmux sockets, run.sh, launch-status and run-agent.vbs as read now', () => {
  const fs = memFs({
    [`${STATE}/launch-status`]: { text: 'outcome=live at=2026-10-28T09:00:05Z\n', mtimeMs: NOW - 170 * MIN },
    [`${STATE}/run-agent.vbs`]: { text: 'WScript.Quit shell.Run("x", 0, True)\n', mtimeMs: NOW - 5 * 60 * MIN },
  })
  const got = need().readUnattendedInputs({ platform: 'darwin', home: HOME, assistantId: '912', stateDir: STATE, fs })
  assert.equal(got.runShPath, `${STATE}/run.sh`)
  assert.ok(Array.isArray(got.ownSockets) && got.ownSockets.length === 2, JSON.stringify(got.ownSockets))
  assert.match(got.ownSockets[0], /^hoai-912-home-[0-9a-f]{8}$/)
  assert.equal(got.ownSockets[1], 'hoai-912')
  assert.deepEqual(got.launchStatus, { outcome: 'live', mtimeMs: NOW - 170 * MIN })
  assert.deepEqual(got.runAgentVbs, { text: 'WScript.Quit shell.Run("x", 0, True)\n', mtimeMs: NOW - 5 * 60 * MIN })
  assert.equal(got.runAgentVbsPath, `${STATE}/run-agent.vbs`)
})

test('nothing on disk: every input is empty, never a guess', () => {
  const got = need().readUnattendedInputs({ platform: 'linux', home: HOME, assistantId: '912', stateDir: STATE, fs: memFs() })
  assert.deepEqual(got.launchStatus, { outcome: null, mtimeMs: null })
  assert.deepEqual(got.runAgentVbs, { text: null, mtimeMs: null })
})

// -- A person at the agent's tmux session -------------------------------------------------------

function tmuxExec(answers: Record<string, { code: number; stdout?: string; stderr?: string } | Error>) {
  const calls: Array<{ file: string; args: string[]; env: Record<string, string | undefined> }> = []
  const exec = async (file: string, args: string[], opts: any) => {
    calls.push({ file, args, env: opts?.env ?? {} })
    const key = args.join(' ')
    const answer = answers[key]
    if (answer instanceof Error) throw answer
    if (!answer) return { code: 1, stdout: '', stderr: 'no server running on /private/tmp/tmux-501/default' }
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { exec, calls }
}

const SOCKETS = ['hoai-912-home-abcd1234', 'hoai-912']
const RW_LIST = (s: string) => `-L ${s} list-clients -F #{client_readonly}`

test('a read-write client on the agent\'s own socket is a person attached', async () => {
  const t = tmuxExec({ [RW_LIST(SOCKETS[0])]: { code: 0, stdout: '1\n0\n' } })
  const got = await need().readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepaliveSession: null, tmuxPath: '/opt/homebrew/bin/tmux', exec: t.exec, env: { TMUX: '/tmp/x,1,0', PATH: '/usr/bin' } })
  assert.equal(got, true)
  assert.equal(t.calls[0].file, '/opt/homebrew/bin/tmux')
  assert.equal(t.calls[0].env.TMUX, undefined, 'the query never goes to the server the daemon itself may sit in')
})

test('only read-only viewers (Show agent windows) is nobody typing', async () => {
  const t = tmuxExec({ [RW_LIST(SOCKETS[0])]: { code: 0, stdout: '1\n' }, [RW_LIST(SOCKETS[1])]: { code: 0, stdout: '' } })
  assert.equal(await need().readPersonAttached({ platform: 'linux', sockets: SOCKETS, keepaliveSession: null, tmuxPath: '/usr/bin/tmux', exec: t.exec, env: {} }), false)
})

test('no server on either socket is nobody attached', async () => {
  const t = tmuxExec({
    [RW_LIST(SOCKETS[0])]: { code: 1, stderr: 'no server running on /private/tmp/tmux-501/hoai-912-home-abcd1234' },
    [RW_LIST(SOCKETS[1])]: { code: 1, stderr: 'error connecting to /private/tmp/tmux-501/hoai-912 (No such file or directory)' },
  })
  assert.equal(await need().readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepaliveSession: null, tmuxPath: '/usr/bin/tmux', exec: t.exec, env: {} }), false)
})

test('a tmux that fails any other way, times out or throws is unknown, which waits', async () => {
  const m = need()
  const odd = tmuxExec({ [RW_LIST(SOCKETS[0])]: { code: 1, stderr: 'server exited unexpectedly' } })
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepaliveSession: null, tmuxPath: '/usr/bin/tmux', exec: odd.exec, env: {} }), null)
  const thrown = tmuxExec({ [RW_LIST(SOCKETS[0])]: new Error('spawn EACCES') })
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepaliveSession: null, tmuxPath: '/usr/bin/tmux', exec: thrown.exec, env: {} }), null)
  const timedOut = { exec: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) }
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepaliveSession: null, tmuxPath: '/usr/bin/tmux', exec: timedOut.exec, env: {} }), null)
})

test('no tmux found at all is unknown on macOS and Linux, and Windows never asks tmux', async () => {
  const m = need()
  const t = tmuxExec({})
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepaliveSession: null, tmuxPath: null, exec: t.exec, env: {} }), null)
  assert.equal(await m.readPersonAttached({ platform: 'win32', sockets: SOCKETS, keepaliveSession: null, tmuxPath: null, exec: t.exec, env: {} }), false)
  assert.equal(t.calls.length, 0)
})

test('the keepalive\'s own session on the default server counts too', async () => {
  const m = need()
  const session = 'agent-912'
  const attached = tmuxExec({ [`list-clients -t =${session} -F #{client_readonly}`]: { code: 0, stdout: '0\n' } })
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepaliveSession: session, tmuxPath: '/usr/bin/tmux', exec: attached.exec, env: {} }), true)
  const gone = tmuxExec({ [`list-clients -t =${session} -F #{client_readonly}`]: { code: 1, stderr: "can't find session: agent-912" } })
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepalive: true, keepaliveSession: session, tmuxPath: '/usr/bin/tmux', exec: gone.exec, env: {} }), null, 'a label tmux cannot find proves nobody absent')
  const noServer = tmuxExec({})
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepalive: true, keepaliveSession: session, tmuxPath: '/usr/bin/tmux', exec: noServer.exec, env: {} }), null, 'a keepalive on another server is not on the default one')
})

test('a keepalive with no session declared and no tmux of its own to ask is unknown, which waits', async () => {
  const t = tmuxExec({})
  assert.equal(await need().readPersonAttached({ platform: 'linux', sockets: SOCKETS, keepalive: true, keepaliveSession: null, tmuxPath: '/usr/bin/tmux', exec: t.exec, env: {} }), null)
})

test('a keepalive is asked on the tmux server and session the daemon itself runs in (TMUX, TMUX_PANE), first', async () => {
  const m = need()
  const env = { TMUX: '/private/tmp/tmux-501/default,4242,0', TMUX_PANE: '%3' }
  const display = '-S /private/tmp/tmux-501/default display -p -t %3 #{session_name}'
  const list = '-S /private/tmp/tmux-501/default list-clients -t =kc-agent -F #{client_readonly}'
  const typing = tmuxExec({ [display]: { code: 0, stdout: 'kc-agent\n' }, [list]: { code: 0, stdout: '0\n' } })
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepalive: true, keepaliveSession: 'a stale label', tmuxPath: '/usr/bin/tmux', exec: typing.exec, env }), true)
  const viewing = tmuxExec({ [display]: { code: 0, stdout: 'kc-agent\n' }, [list]: { code: 0, stdout: '1\n' } })
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepalive: true, keepaliveSession: null, tmuxPath: '/usr/bin/tmux', exec: viewing.exec, env }), false)
  const unnamed = tmuxExec({ [display]: { code: 1, stderr: 'no current target' } })
  assert.equal(await m.readPersonAttached({ platform: 'darwin', sockets: SOCKETS, keepalive: true, keepaliveSession: null, tmuxPath: '/usr/bin/tmux', exec: unnamed.exec, env }), null)
})

// -- The watcher's sweep ------------------------------------------------------------------------

const WATCHER_STATE = '/Users/a/.bgos-agent/watcher/keepalive-state.json'

test('the watcher sweep is active only when enabled and written in the last few minutes', () => {
  const m = need()
  const at = (ms: number, enabled = true) => memFs({ [WATCHER_STATE]: JSON.stringify({ schemaVersion: 1, updatedAt: new Date(ms).toISOString(), enabled }) })
  assert.equal(m.readWatcherSweepActive({ home: HOME, fs: at(NOW - 2 * MIN), now: NOW, freshMs: 5 * MIN }), true)
  assert.equal(m.readWatcherSweepActive({ home: HOME, fs: at(NOW - 6 * MIN), now: NOW, freshMs: 5 * MIN }), false)
  assert.equal(m.readWatcherSweepActive({ home: HOME, fs: at(NOW - 1 * MIN, false), now: NOW, freshMs: 5 * MIN }), false)
  assert.equal(m.readWatcherSweepActive({ home: HOME, fs: memFs({ [WATCHER_STATE]: 'null' }), now: NOW, freshMs: 5 * MIN }), false)
  assert.equal(m.readWatcherSweepActive({ home: HOME, fs: memFs(), now: NOW, freshMs: 5 * MIN }), false)
})

test('a watcher state stamped a little in the future (a clock that jumped back) is active; one stamped further ahead than it stays fresh is stale', () => {
  const m = need()
  const ahead = (ms: number) => memFs({ [WATCHER_STATE]: JSON.stringify({ schemaVersion: 1, updatedAt: new Date(NOW + ms).toISOString(), enabled: true }) })
  assert.equal(m.readWatcherSweepActive({ home: HOME, fs: ahead(4 * MIN), now: NOW, freshMs: 5 * MIN }), true)
  assert.equal(m.readWatcherSweepActive({ home: HOME, fs: ahead(6 * MIN), now: NOW, freshMs: 5 * MIN }), false, 'a watcher that still sweeps rewrites it on the new clock')
  assert.equal(m.readWatcherSweepActive({ home: HOME, fs: ahead(3 * 60 * MIN), now: NOW, freshMs: 5 * MIN }), false)
})

// -- The wake schedule --------------------------------------------------------------------------

test('the schedule read: the backend answers a list (AgentScheduledTaskViewDto[]); anything else is unknown', async () => {
  const m = need()
  const tasks = [{ id: 't1', kind: 'wake', nextFireAt: '2026-10-28T12:05:00.000Z', status: 'active' }]
  const paths: string[] = []
  const ok = await m.readWakeSchedule(async (path: string) => {
    paths.push(path)
    return tasks
  })
  assert.deepEqual(ok, { ok: true, tasks })
  assert.deepEqual(paths, ['scheduled-tasks/agent?status=active'])
  assert.deepEqual(await m.readWakeSchedule(async () => ({ items: tasks })), { ok: false, tasks: null })
  assert.deepEqual(await m.readWakeSchedule(async () => {
    throw new Error('GET 503')
  }), { ok: false, tasks: null })
})

// -- Versions held on this computer, and the enrolment ------------------------------------------

test('the versions latched bad on this computer are the X.Y.Z folders with a bad file', () => {
  const fs = memFs({
    [`${MACHINE}/0.81.0/bad`]: '{}',
    [`${MACHINE}/0.81.0/canary-1`]: '{}',
    [`${MACHINE}/0.82.0/canary-1`]: '{}',
    [`${MACHINE}/lease.json`]: '{}',
    [`${MACHINE}/../evil/bad`]: '{}',
  })
  assert.deepEqual(need().listHeldBadVersions({ machineDir: MACHINE, fs }), ['0.81.0'])
  assert.deepEqual(need().listHeldBadVersions({ machineDir: MACHINE, fs: memFs() }), [])
})

test('the boot enrolment: held while the latest is bad here, taken back only from a hold this rollback wrote', () => {
  const m = need()
  const hold = JSON.stringify({ marketplace: 'hoai', configDir: '/Users/a/.claude', version: '0.81.0', at: '2026-10-28T10:00:00.000Z' })
  const configDir = '/Users/a/.claude'
  assert.equal(m.decideEnrolment({ holdRaw: null, marketplace: 'hoai', latestKnownVersion: '0.81.0', badVersions: ['0.81.0'], configDir }), 'hold')
  assert.equal(m.decideEnrolment({ holdRaw: hold, marketplace: 'hoai', latestKnownVersion: '0.81.0', badVersions: ['0.81.0'], configDir }), 'hold')
  assert.equal(m.decideEnrolment({ holdRaw: hold, marketplace: 'hoai', latestKnownVersion: null, badVersions: ['0.81.0'], configDir }), 'hold')
  assert.equal(m.decideEnrolment({ holdRaw: hold, marketplace: 'hoai', latestKnownVersion: '0.81.1', badVersions: ['0.81.0'], configDir }), 'reclaim')
  assert.equal(m.decideEnrolment({ holdRaw: null, marketplace: 'hoai', latestKnownVersion: '0.81.1', badVersions: ['0.81.0'], configDir }), 'normal')
  assert.equal(m.decideEnrolment({ holdRaw: hold, marketplace: 'other', latestKnownVersion: '0.81.1', badVersions: [], configDir }), 'normal')
  assert.equal(m.decideEnrolment({ holdRaw: '{ junk', marketplace: 'hoai', latestKnownVersion: '0.81.1', badVersions: [], configDir }), 'normal')
})

test('the boot enrolment takes a hold back only in the Claude config folder that rollback switched off', () => {
  const m = need()
  const hold = JSON.stringify({ marketplace: 'hoai', configDir: '/Users/a/.claude', version: '0.81.0', at: '2026-10-28T10:00:00.000Z' })
  const at = { holdRaw: hold, marketplace: 'hoai', latestKnownVersion: '0.81.1', badVersions: ['0.81.0'] }
  assert.equal(m.decideEnrolment({ ...at, configDir: '/Users/a/.claude' }), 'reclaim')
  assert.equal(m.decideEnrolment({ ...at, configDir: '/Users/a/.claude-b' }), 'normal', 'another config folder\'s false is a person\'s')
  assert.equal(m.decideEnrolment({ ...at, holdRaw: JSON.stringify({ marketplace: 'hoai', version: '0.81.0' }), configDir: '/Users/a/.claude' }), 'normal', 'a hold that names no folder reclaims nothing')
})

// -- The marketplace rollback -------------------------------------------------------------------

const CONFIG = '/Users/a/.claude'
const INSTALLED = `${CONFIG}/plugins/installed_plugins.json`
const FROM_ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.80.0`
const TO_ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.81.0`
const RECORD = { target: '0.81.0', from: '0.80.0', fromRoot: FROM_ROOT, fromCommit: null, installMethod: 'marketplace' }

function installedDoc(version = '0.81.0', installPath = TO_ROOT) {
  return JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', version, installPath, lastUpdated: '2026-10-28T08:00:00.000Z' }], 'other@x': [{ scope: 'user', version: '1.0.0', installPath: '/x' }] } })
}

function rollbackWorld(over: Record<string, any> = {}) {
  const fs = memFs({
    [INSTALLED]: over.installed ?? installedDoc(),
    ...(over.noFromRoot ? {} : { [`${FROM_ROOT}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'hoai', version: over.fromRootVersion ?? '0.80.0' }) }),
  })
  const autoUpdate: boolean[] = []
  const setAutoUpdate = (enabled: boolean) => {
    autoUpdate.push(enabled)
    if (over.setThrows) throw new Error('settings.json locked')
    return over.setResult ?? { changed: true, reason: 'set' }
  }
  return { fs, autoUpdate, setAutoUpdate }
}

test('the marketplace rollback points installed_plugins.json back at the old folder and holds Claude Code\'s own update', async () => {
  const w = rollbackWorld()
  const result = await need().rollbackMarketplaceInstall({
    record: RECORD,
    installedPluginsPath: INSTALLED,
    holdPath: `${MACHINE}/enrolment-hold.json`,
    marketplace: 'hoai',
    fs: w.fs,
    setAutoUpdate: w.setAutoUpdate,
    now: NOW,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const doc = JSON.parse(w.fs.readFile(INSTALLED)!)
  assert.equal(doc.plugins['hoai@hoai'][0].version, '0.80.0')
  assert.equal(doc.plugins['hoai@hoai'][0].installPath, FROM_ROOT)
  assert.deepEqual(doc.plugins['other@x'], [{ scope: 'user', version: '1.0.0', installPath: '/x' }])
  assert.deepEqual(w.autoUpdate, [false], 'the relaunch must not reinstall the build it is leaving')
  const hold = JSON.parse(w.fs.readFile(`${MACHINE}/enrolment-hold.json`)!)
  assert.deepEqual({ marketplace: hold.marketplace, version: hold.version }, { marketplace: 'hoai', version: '0.81.0' })
})

test('the rollback\'s hold names the Claude config folder it switched off', async () => {
  const w = rollbackWorld()
  const result = await need().rollbackMarketplaceInstall({ record: RECORD, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(w.fs.readFile(`${MACHINE}/enrolment-hold.json`)!).configDir, CONFIG)
})

test('installed_plugins.json is read back after the write: one a concurrent claude overwrote is written again, one that never holds fails', async () => {
  const m = need()
  const flaky = rollbackWorld()
  let clobbers = 1
  const write = flaky.fs.writeAtomic
  flaky.fs.writeAtomic = (p: string, text: string) => {
    const ok = write(p, text)
    if (p === INSTALLED && clobbers > 0) {
      clobbers -= 1
      write(p, installedDoc())
    }
    return ok
  }
  const healed = await m.rollbackMarketplaceInstall({ record: RECORD, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs: flaky.fs, setAutoUpdate: flaky.setAutoUpdate, now: NOW })
  assert.equal(healed.ok, true, JSON.stringify(healed))
  assert.equal(JSON.parse(flaky.fs.readFile(INSTALLED)!).plugins['hoai@hoai'][0].version, '0.80.0')
  const stuck = rollbackWorld()
  const put = stuck.fs.writeAtomic
  stuck.fs.writeAtomic = (p: string, text: string) => (p === INSTALLED ? put(p, installedDoc()) : put(p, text))
  const lost = await m.rollbackMarketplaceInstall({ record: RECORD, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs: stuck.fs, setAutoUpdate: stuck.setAutoUpdate, now: NOW })
  assert.deepEqual(lost, { ok: false, reason: 'not_persisted' })
  assert.deepEqual(stuck.autoUpdate, [], 'nothing more is changed once the install could not be pointed back')
})

test('a switch-off of Claude Code\'s own update that did not persist fails the rollback: no restart into a reinstall', async () => {
  const w = rollbackWorld({ setResult: { changed: false, reason: 'not_persisted' } })
  const result = await need().rollbackMarketplaceInstall({ record: RECORD, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.deepEqual(result, { ok: false, reason: 'auto_update_still_on' })
})

test('the old folder gone, or holding another version: refused, nothing written', async () => {
  const m = need()
  for (const over of [{ noFromRoot: true }, { fromRootVersion: '0.79.0' }]) {
    const w = rollbackWorld(over)
    const result = await m.rollbackMarketplaceInstall({ record: RECORD, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
    assert.deepEqual(result, { ok: false, reason: 'from_root_missing' })
    assert.deepEqual(w.fs.writes, [])
    assert.deepEqual(w.autoUpdate, [])
  }
})

test('an installed_plugins.json with no hoai entry, or not parsing, is refused untouched', async () => {
  const m = need()
  for (const installed of ['{ junk', JSON.stringify({ version: 2, plugins: {} })]) {
    const w = rollbackWorld({ installed })
    const result = await m.rollbackMarketplaceInstall({ record: RECORD, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
    assert.equal(result.ok, false)
    assert.deepEqual(w.fs.writes, [])
    assert.deepEqual(w.autoUpdate, [])
  }
})

test('auto-update the person had already switched off is theirs: no hold is recorded, so nothing ever turns it back on', async () => {
  const w = rollbackWorld({ setResult: { changed: false, reason: 'already' } })
  const result = await need().rollbackMarketplaceInstall({ record: RECORD, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.equal(result.ok, true)
  assert.equal(w.fs.readFile(`${MACHINE}/enrolment-hold.json`), null)
})

test('a settings write that fails still leaves the install pointed back, and fails the rollback so nothing restarts into a reinstall', async () => {
  const w = rollbackWorld({ setThrows: true })
  const result = await need().rollbackMarketplaceInstall({ record: RECORD, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.deepEqual(result, { ok: false, reason: 'auto_update_still_on' })
  assert.equal(JSON.parse(w.fs.readFile(INSTALLED)!).plugins['hoai@hoai'][0].version, '0.80.0')
})

// An agent that is not failing steps in only while the install still names the marked build (DESIGN.md, Round 4).
const STILL_ON = { ...RECORD, ifStillOn: '0.81.0' }
const OTHER_ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.80.5`

test('stepping in: the install still on the marked build goes back, and the write is said to be this call\'s', async () => {
  const w = rollbackWorld()
  const result = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.moved, true)
  assert.equal(JSON.parse(w.fs.readFile(INSTALLED)!).plugins['hoai@hoai'][0].version, '0.80.0')
  assert.deepEqual(w.autoUpdate, [false])
})

test('stepping in: another agent\'s good build stands: nothing written, not even for an agent whose own folder went, and the switch-off is still asked', async () => {
  for (const noFromRoot of [false, true]) {
    const before = installedDoc('0.80.5', OTHER_ROOT)
    const w = rollbackWorld({ installed: before, noFromRoot })
    const writes: string[] = []
    const fs = { ...w.fs, writeAtomic: (p: string, text: string) => (writes.push(p), w.fs.writeAtomic(p, text)) }
    const result = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.moved, false)
    assert.equal(w.fs.readFile(INSTALLED), before)
    assert.equal(writes.includes(INSTALLED), false)
    assert.deepEqual(w.autoUpdate, [false], 'an agent that crashed before its switch-off leaves one owing')
  }
})

test('stepping in: two agents at once: the read back finds the other\'s good build, and neither fights it', async () => {
  const w = rollbackWorld()
  let writes = 0
  const fs = {
    ...w.fs,
    writeAtomic: (p: string, text: string) => {
      if (p !== INSTALLED) return w.fs.writeAtomic(p, text)
      writes += 1
      // The other agent's write lands right after this one.
      w.fs.writeAtomic(p, text)
      return w.fs.writeAtomic(p, installedDoc('0.80.5', OTHER_ROOT))
    },
  }
  const result = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(writes, 1)
  assert.equal(JSON.parse(w.fs.readFile(INSTALLED)!).plugins['hoai@hoai'][0].version, '0.80.5')
})

test('stepping in: a claude that writes the marked build back over this write is written again, and one that never stops fails', async () => {
  const healed = rollbackWorld()
  let writes = 0
  const fs = {
    ...healed.fs,
    writeAtomic: (p: string, text: string) => {
      if (p !== INSTALLED) return healed.fs.writeAtomic(p, text)
      writes += 1
      return healed.fs.writeAtomic(p, writes === 1 ? installedDoc() : text)
    },
  }
  const result = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs, setAutoUpdate: healed.setAutoUpdate, now: NOW })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(writes, 2)
  const stuck = rollbackWorld()
  const never = { ...stuck.fs, writeAtomic: (p: string, text: string) => stuck.fs.writeAtomic(p, p === INSTALLED ? installedDoc() : text) }
  const lost = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs: never, setAutoUpdate: stuck.setAutoUpdate, now: NOW })
  assert.deepEqual(lost, { ok: false, reason: 'not_persisted' })
})

test('stepping in: the old folder gone with the install still on the marked build is refused, nothing written', async () => {
  const before = installedDoc()
  const w = rollbackWorld({ noFromRoot: true })
  const result = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.deepEqual(result, { ok: false, reason: 'from_root_missing' })
  assert.equal(w.fs.readFile(INSTALLED), before)
  assert.deepEqual(w.autoUpdate, [])
})

test('stepping in: an install it cannot read is no sign that it moved', async () => {
  for (const installed of ['{ not json', JSON.stringify({ version: 2, plugins: {} })]) {
    const w = rollbackWorld({ installed })
    const result = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
    assert.equal(result.ok, false, installed)
    assert.deepEqual(w.autoUpdate, [], installed)
  }
})

test('the clone rollback: the self updater\'s, for the commit on the record', async () => {
  const calls: string[] = []
  const updater = { rollbackCheckoutTo: async (commit: string) => (calls.push(commit), { ok: true as const }) }
  const result = await need().rollbackCloneInstall({ record: { from: '0.80.0', target: '0.81.0', fromCommit: 'abc' }, updater, checkoutVersion: () => '0.81.0' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, ['abc'])
})

test('the clone rollback: no updater, or no commit, is refused', async () => {
  const updater = { rollbackCheckoutTo: async () => assert.fail('never asked') }
  assert.deepEqual(await need().rollbackCloneInstall({ record: { fromCommit: 'abc' }, updater: null, checkoutVersion: () => null }), { ok: false, reason: 'no_updater' })
  assert.deepEqual(await need().rollbackCloneInstall({ record: { fromCommit: null }, updater, checkoutVersion: () => null }), { ok: false, reason: 'no_commit' })
})

test('the clone rollback, stepping in: a checkout that left the marked build owes nothing, even to a daemon with no updater or no commit', async () => {
  const record = { from: '0.80.0', target: '0.81.0', fromCommit: null, ifStillOn: '0.81.0' }
  assert.deepEqual(await need().rollbackCloneInstall({ record, updater: null, checkoutVersion: () => '0.80.0' }), { ok: true, moved: false })
  assert.deepEqual(await need().rollbackCloneInstall({ record, updater: { rollbackCheckoutTo: async () => assert.fail('never asked') }, checkoutVersion: () => '0.80.0' }), { ok: true, moved: false })
  assert.deepEqual(await need().rollbackCloneInstall({ record, updater: null, checkoutVersion: () => '0.81.0' }), { ok: false, reason: 'no_updater' })
  assert.deepEqual(await need().rollbackCloneInstall({ record, updater: null, checkoutVersion: () => null }), { ok: false, reason: 'no_updater' })
})

test('the clone rollback, stepping in: the checkout is read again under the update lock, where agents queued behind another\'s rollback find it moved', async () => {
  let on = '0.81.0'
  let wanted: boolean | null = null
  const updater = {
    rollbackCheckoutTo: async (_commit: string, stillWanted?: () => boolean) => {
      on = '0.80.5'
      wanted = stillWanted ? stillWanted() : null
      return { ok: true as const }
    },
  }
  await need().rollbackCloneInstall({ record: { fromCommit: 'abc', ifStillOn: '0.81.0' }, updater, checkoutVersion: () => on })
  assert.equal(wanted, false)
  on = '0.81.0'
  await need().rollbackCloneInstall({ record: { fromCommit: 'abc', target: '0.81.0' }, updater, checkoutVersion: () => on })
  assert.equal(wanted, null, 'a failing agent goes back whatever the checkout reads')
})

test('the clone rollback, stepping in: only while the checkout still holds the marked build, or a pending state a daemon cannot lose would check it out every poll', async () => {
  const calls: string[] = []
  const updater = { rollbackCheckoutTo: async (commit: string) => (calls.push(commit), { ok: true as const }) }
  const record = { from: '0.80.0', target: '0.81.0', fromCommit: 'abc', ifStillOn: '0.81.0' }
  assert.deepEqual(await need().rollbackCloneInstall({ record, updater, checkoutVersion: () => '0.80.0' }), { ok: true, moved: false })
  assert.deepEqual(calls, [])
  assert.deepEqual(await need().rollbackCloneInstall({ record, updater, checkoutVersion: () => '0.81.0' }), { ok: true })
  assert.deepEqual(calls, ['abc'])
  assert.deepEqual(await need().rollbackCloneInstall({ record, updater, checkoutVersion: () => null }), { ok: true }, 'a package.json it cannot read is no sign that it moved')
})

test('stepping in: a good build that arrives between the first look and the write stands too', async () => {
  const w = rollbackWorld()
  const writes: string[] = []
  let reads = 0
  const fs = {
    ...w.fs,
    readFile: (p: string) => {
      if (p !== INSTALLED) return w.fs.readFile(p)
      reads += 1
      return reads === 1 ? installedDoc() : installedDoc('0.80.5', OTHER_ROOT)
    },
    writeAtomic: (p: string, text: string) => (writes.push(p), w.fs.writeAtomic(p, text)),
  }
  const result = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.moved, false)
  assert.equal(writes.includes(INSTALLED), false)
})

test('stepping in: the result names the version the install reads after the write', async () => {
  const w = rollbackWorld()
  const mine = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.equal(mine.on, '0.80.0')
  const other = rollbackWorld()
  let writes = 0
  const fs = {
    ...other.fs,
    writeAtomic: (p: string, text: string) => {
      if (p !== INSTALLED) return other.fs.writeAtomic(p, text)
      writes += 1
      return other.fs.writeAtomic(p, installedDoc('0.80.5', OTHER_ROOT))
    },
  }
  const lost = await need().rollbackMarketplaceInstall({ record: STILL_ON, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', configDir: CONFIG, fs, setAutoUpdate: other.setAutoUpdate, now: NOW })
  assert.equal(lost.on, '0.80.5')
  assert.equal(lost.moved, true, 'this call did write, and the read back took what it found as done')
  assert.equal(writes, 1)
})

test('two config folders on one HOME each keep their own hold: a second switch-off leaves the first folder\'s to be taken back', async () => {
  const m = need()
  const folders = ['/Users/a/.claude-a', '/Users/a/.claude-b']
  const paths = folders.map((f) => `${MACHINE}/${m.enrolmentHoldFileName(f)}`)
  assert.notEqual(paths[0], paths[1])
  assert.equal(m.enrolmentHoldFileName(folders[0]), m.enrolmentHoldFileName(folders[0]), 'a boot finds what the rollback wrote')
  assert.match(m.enrolmentHoldFileName(folders[0]), /^enrolment-hold-[0-9a-f]{16}\.json$/, 'a file name, whatever the folder\'s path holds')
  const w = rollbackWorld()
  for (const [i, configDir] of folders.entries()) {
    const result = await m.rollbackMarketplaceInstall({ record: i === 0 ? RECORD : STILL_ON, installedPluginsPath: INSTALLED, holdPath: paths[i], marketplace: 'hoai', configDir, fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  for (const [i, configDir] of folders.entries()) {
    const decided = m.decideEnrolment({ holdRaw: w.fs.readFile(paths[i]), marketplace: 'hoai', latestKnownVersion: '0.81.1', badVersions: ['0.81.0'], configDir })
    assert.equal(decided, 'reclaim', configDir)
  }
})

test('a clone record is not the marketplace rollback\'s', async () => {
  const w = rollbackWorld()
  const result = await need().rollbackMarketplaceInstall({ record: { ...RECORD, installMethod: 'clone' }, installedPluginsPath: INSTALLED, holdPath: `${MACHINE}/enrolment-hold.json`, marketplace: 'hoai', fs: w.fs, setAutoUpdate: w.setAutoUpdate, now: NOW })
  assert.deepEqual(result, { ok: false, reason: 'not_marketplace' })
  assert.deepEqual(w.fs.writes, [])
})

// -- The cgroup of an owning systemd unit -------------------------------------------------------

const UNIT = { kind: 'systemd', handle: 'bgos-agent-912.service' }
const SHOW = `--user show -p MainPID -p ControlGroup ${UNIT.handle}`
const CG = '/user.slice/user-1000.slice/user@1000.service/app.slice/bgos-agent-912.service'
const RUN_SH = '/home/a/.bgos-agent/912/run.sh'
/** A gen-2 Linux agent: systemd --user > run.sh; the tmux server (own socket, reparented) > hoai > claude > this daemon. */
const LINUX = [
  { pid: 1, ppid: 0, command: '/sbin/init' },
  { pid: 500, ppid: 1, command: '/lib/systemd/systemd --user' },
  { pid: 600, ppid: 500, command: `/bin/bash ${RUN_SH}` },
  { pid: 610, ppid: 500, command: `tmux -L ${SOCKETS[0]} new-session -d -s hoai-912` },
  { pid: 620, ppid: 610, command: 'node /home/a/plugin/bin/hoai-core.mjs' },
  { pid: 630, ppid: 620, command: 'claude --resume pin' },
  { pid: 640, ppid: 630, command: 'bun /home/a/plugin/server.ts' },
  { pid: 700, ppid: 500, command: 'python3 long_job.py' },
]
const showOk = { code: 0, stdout: `MainPID=600\nControlGroup=${CG}\n` }
const strays = (o: { exec?: any; files?: Record<string, string>; processes?: any; service?: any } = {}) =>
  need().readServiceStrays({
    service: o.service === undefined ? UNIT : o.service,
    processes: o.processes === undefined ? LINUX : o.processes,
    claudePid: 630,
    sockets: SOCKETS,
    runShPath: RUN_SH,
    exec: o.exec ?? tmuxExec({ [SHOW]: showOk }).exec,
    fs: memFs(o.files ?? { [`/sys/fs/cgroup${CG}/cgroup.procs`]: '600\n610\n620\n630\n640\n700\n' }),
    env: {},
  })

test('a systemd unit\'s cgroup: a job orphaned out of claude\'s tree is a stray its restart would kill; run.sh, the tmux server and claude\'s line are not', async () => {
  assert.deepEqual(await strays(), { ok: true, strays: [700] })
  assert.deepEqual(await strays({ files: { [`/sys/fs/cgroup${CG}/cgroup.procs`]: '600\n610\n620\n630\n640\n' } }), { ok: true, strays: [] })
  assert.deepEqual(await strays({ files: { [`/sys/fs/cgroup/systemd${CG}/cgroup.procs`]: '600\n630\n640\n700\n' } }), { ok: true, strays: [700] }, 'cgroup v1 too')
})

test('the unit\'s cgroup fails closed: systemctl refusing or throwing, no cgroup.procs, or no process table is unreadable', async () => {
  const fail = { ok: false, strays: [] }
  assert.deepEqual(await strays({ exec: tmuxExec({ [SHOW]: { code: 1, stderr: 'Failed to connect to bus' } }).exec }), fail)
  assert.deepEqual(await strays({ exec: tmuxExec({ [SHOW]: new Error('spawn systemctl ENOENT') }).exec }), fail)
  assert.deepEqual(await strays({ files: {} }), fail)
  assert.deepEqual(await strays({ files: { [`/sys/fs/cgroup${CG}/cgroup.procs`]: 'not pids' } }), fail)
  assert.deepEqual(await strays({ processes: null }), fail)
})

test('only a systemd unit ends a whole group: a launchd job reads nothing; a unit running nothing kills nothing', async () => {
  const t = tmuxExec({ [SHOW]: showOk })
  assert.deepEqual(await strays({ service: { kind: 'launchd', handle: 'ai.bgos.agent.912' }, exec: t.exec }), { ok: true, strays: [] })
  assert.equal(t.calls.length, 0)
  assert.deepEqual(await strays({ exec: tmuxExec({ [SHOW]: { code: 0, stdout: 'MainPID=0\nControlGroup=\n' } }).exec }), { ok: true, strays: [] })
})

test('the unit\'s cgroup fails closed where it cannot tell: no service named, a running unit with no group, a member the listing does not have', async () => {
  const fail = { ok: false, strays: [] }
  const t = tmuxExec({ [SHOW]: showOk })
  assert.deepEqual(await strays({ service: null, exec: t.exec }), fail, 'asked only for a service; none named now is unknown')
  assert.equal(t.calls.length, 0)
  assert.deepEqual(await strays({ exec: tmuxExec({ [SHOW]: { code: 0, stdout: 'MainPID=600\nControlGroup=\n' } }).exec }), fail)
  assert.deepEqual(await strays({ files: { [`/sys/fs/cgroup${CG}/cgroup.procs`]: '600\n610\n620\n630\n640\n4242\n' } }), { ok: true, strays: [4242] }, 'started after the listing: not known to be ours')
})
