/**
 * A staged build that dies at import (Data's review of #291, follow up 1; board row 5a455021). The idle updater asks
 * for the restart, the relaunch loads the new build, its daemon throws before it ever holds the pairing lock, and the
 * record still says `requested`. No daemon on the build is left to fail validation, so before this fix nothing rolled
 * it back: the install stayed on the build until the 25 min lease ran out, then a 24 h hold, and a reboot landed every
 * agent on the computer on it.
 *
 * The rule (lib/idle-update.mjs decideNeverArrived) and the way back it takes (rollBackNeverArrived, the controller's
 * own rollback steps), on an in-memory disk. hoai's side is test/hoai-core.idle-never-arrived.test.ts; a real disk
 * and the real marketplace rollback are at the end of this file; the rig scenario is docs/idle-update/rig/import-death.mjs.
 *
 * Run: npx tsx --test test/idle-update.never-arrived.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod: any = await import('../lib/idle-update.mjs')
const core: any = await import('../bin/hoai-core.mjs')

function need(name: string): any {
  if (typeof mod[name] !== 'function') {
    assert.fail(
      `lib/idle-update.mjs ${name} is missing: a staged build that dies at import is never rolled back, and the install ` +
        'stays on it until the lease and the 24 h hold run out, while a reboot lands every agent on it',
    )
  }
  return mod[name]
}

const T0 = Date.parse('2026-11-13T09:00:00.000Z')
const SEC = 1000
const MIN = 60 * SEC
const MACHINE = join('/home/a/.bgos-agent', 'idle-update')
const RECORD = join('/home/a/.bgos-agent', '912', 'idle-update.json')
const CACHE = '/home/a/.claude/plugins/cache/hoai/hoai'

function requested(fields: Record<string, unknown> = {}) {
  return {
    schema: 1,
    target: '0.81.0',
    from: '0.80.0',
    fromRoot: `${CACHE}/0.80.0`,
    fromCommit: null,
    installMethod: 'marketplace',
    pin: '0f0e0d0c-1111-4222-8333-444455556666',
    pinBefore: null,
    nonce: '912-n1',
    canaryN: 1,
    state: 'requested',
    attempts: [{ at: new Date(T0).toISOString(), outcome: 'requested' }],
    lockBoots: 0,
    arrivedAt: null,
    validatedAt: null,
    contextLost: false,
    reportedAt: null,
    ...fields,
  }
}

const NONE = { installedVersion: '0.81.0', cameBack: 'none', launchedAtMs: T0 + 5 * SEC, loginExpired: false }

// -- The rule ------------------------------------------------------------------------------------

test('a relaunch after the ask that brought no daemon, with the install still on the build: roll back', () => {
  const decide = need('decideNeverArrived')
  assert.deepEqual(decide({ record: requested(), ...NONE }), { action: 'rollback', reason: 'no_daemon' })
})

test('a relaunch after the ask that came back on the old build, the install still on the new one: roll back', () => {
  const decide = need('decideNeverArrived')
  assert.deepEqual(decide({ record: requested(), ...NONE, cameBack: 'old' }), { action: 'rollback', reason: 'came_back_old' })
})

test('a record that settled is not this rule: arrived, validated, came back old, did not arrive, rolled back, no record', () => {
  const decide = need('decideNeverArrived')
  for (const state of ['arrived', 'validated', 'came_back_old', 'did_not_arrive', 'rolled_back', 'rollback_failed', 'failed', 'no_authority']) {
    assert.deepEqual(decide({ record: requested({ state }), ...NONE }), { action: 'none', reason: 'not_requested' }, state)
  }
  assert.deepEqual(decide({ record: null, ...NONE }), { action: 'none', reason: 'not_requested' })
})

test('a clone is not this rule: its way back is its self updater, inside a daemon', () => {
  const decide = need('decideNeverArrived')
  assert.deepEqual(decide({ record: requested({ installMethod: 'clone' }), ...NONE }), { action: 'none', reason: 'not_marketplace' })
})

test('an install that no longer names the build (moved back, or another version) is not this rule', () => {
  const decide = need('decideNeverArrived')
  for (const installedVersion of ['0.80.0', '0.81.1', null]) {
    assert.deepEqual(decide({ record: requested(), ...NONE, installedVersion }), { action: 'none', reason: 'install_moved' }, String(installedVersion))
  }
})

test('a daemon that came back on the build itself is validation, not this rule; an unknown reading is no rollback', () => {
  const decide = need('decideNeverArrived')
  for (const cameBack of ['target', null, undefined, '']) {
    assert.deepEqual(decide({ record: requested(), ...NONE, cameBack }), { action: 'none', reason: 'came_back_on_target' }, String(cameBack))
  }
})

test('an expired login is not the build: no rollback', () => {
  const decide = need('decideNeverArrived')
  assert.deepEqual(decide({ record: requested(), ...NONE, loginExpired: true }), { action: 'none', reason: 'login_expired' })
})

test('only a launch that started at or after the ask counts: the old daemon itself, or no ask on record, is no rollback', () => {
  const decide = need('decideNeverArrived')
  assert.deepEqual(decide({ record: requested(), ...NONE, launchedAtMs: T0 - SEC }), { action: 'none', reason: 'not_this_launch' })
  assert.deepEqual(decide({ record: requested(), ...NONE, launchedAtMs: T0 }), { action: 'rollback', reason: 'no_daemon' }, 'the same millisecond counts')
  assert.deepEqual(decide({ record: requested(), ...NONE, launchedAtMs: null }), { action: 'none', reason: 'not_this_launch' })
  assert.deepEqual(decide({ record: requested(), ...NONE, launchedAtMs: Number.NaN }), { action: 'none', reason: 'not_this_launch' })
  assert.deepEqual(decide({ record: requested({ attempts: [] }), ...NONE }), { action: 'none', reason: 'not_this_launch' })
  assert.deepEqual(decide({ record: requested({ attempts: [{ at: 'junk', outcome: 'requested' }] }), ...NONE }), { action: 'none', reason: 'not_this_launch' })
})

test('the ask counted is the latest one: an earlier attempt of the same version does not make an older launch count', () => {
  const decide = need('decideNeverArrived')
  const attempts = [
    { at: new Date(T0 - 2 * 24 * 60 * MIN).toISOString(), outcome: 'requested' },
    { at: new Date(T0 - 2 * 24 * 60 * MIN + MIN).toISOString(), outcome: 'came_back_old' },
    { at: new Date(T0).toISOString(), outcome: 'requested' },
  ]
  assert.deepEqual(decide({ record: requested({ attempts }), ...NONE, launchedAtMs: T0 - MIN }), { action: 'none', reason: 'not_this_launch' })
  const ended = [...attempts, { at: new Date(T0 + MIN).toISOString(), outcome: 'came_back_old' }]
  assert.deepEqual(decide({ record: requested({ attempts: ended }), ...NONE, launchedAtMs: T0 + SEC }), { action: 'rollback', reason: 'no_daemon' }, 'read past later outcomes to the last ask')
})

// -- The way back, on an in-memory disk ----------------------------------------------------------

function memDisk() {
  const files = new Map<string, string>()
  return {
    files,
    fs: {
      readFile: (p: string) => files.get(p) ?? null,
      mtimeMs: (p: string) => (files.has(p) ? T0 : null),
      createExclusive: (p: string, text: string) => {
        if (files.has(p)) return 'exists'
        files.set(p, text)
        return 'ok'
      },
      writeAtomic: (p: string, text: string) => {
        files.set(p, text)
        return true
      },
      rename: () => false,
      remove: (p: string) => files.delete(p),
      listDir: () => [],
    },
  }
}

function wayBack(disk: ReturnType<typeof memDisk>, o: { cameBack?: string; installedVersion?: string | null; result?: any; launchedAtMs?: number } = {}) {
  const calls: any[] = []
  const badAtCall: boolean[] = []
  const run = need('rollBackNeverArrived')({
    assistantId: '912',
    recordPath: RECORD,
    machineDir: MACHINE,
    fs: disk.fs,
    installedVersion: o.installedVersion === undefined ? '0.81.0' : o.installedVersion,
    cameBack: o.cameBack ?? 'none',
    launchedAtMs: o.launchedAtMs ?? T0 + 5 * SEC,
    now: T0 + 3 * MIN + 5 * SEC,
    rollbackInstall: async (rec: any) => {
      calls.push(rec)
      badAtCall.push(disk.files.has(join(MACHINE, rec.target, 'bad')))
      if (o.result instanceof Error) throw o.result
      return o.result ?? { ok: true, enrolment: 'set', moved: true, on: rec.from }
    },
  })
  return { run, calls, badAtCall }
}

const readJson = (disk: ReturnType<typeof memDisk>, p: string) => JSON.parse(disk.files.get(p) ?? 'null')

test('the canary: <target>/bad first, then the install back to its own from, the record rolled_back with the attempt', async () => {
  const disk = memDisk()
  disk.files.set(RECORD, JSON.stringify(requested()))
  disk.files.set(join(MACHINE, '0.81.0', 'canary-1'), JSON.stringify({ assistantId: '912', at: new Date(T0).toISOString() }))
  const w = wayBack(disk)
  const back = await w.run
  assert.equal(back.outcome, 'rolled_back')
  assert.equal(back.written, true)
  assert.deepEqual(w.badAtCall, [true], 'the mark is on disk before the install is touched')
  assert.equal(w.calls.length, 1)
  assert.equal(w.calls[0].from, '0.80.0')
  assert.equal(w.calls[0].fromRoot, `${CACHE}/0.80.0`)
  assert.equal(w.calls[0].target, '0.81.0')
  const bad = readJson(disk, join(MACHINE, '0.81.0', 'bad'))
  assert.equal(bad.assistantId, '912')
  assert.equal(bad.reason, 'never_arrived')
  const rec = readJson(disk, RECORD)
  assert.equal(rec.state, 'rolled_back')
  assert.equal(rec.neverArrived, 'no_daemon')
  assert.deepEqual(rec.attempts.map((a: any) => a.outcome), ['requested', 'rolled_back'])
  assert.equal(rec.reportedAt, null, 'the old build reports it when it boots')
  assert.equal(disk.files.has(join(MACHINE, 'went-back-912')), false, 'a canary spends no way back')
  assert.equal(mod.idleUpdateLastError(rec, { runningVersion: '0.80.0' })?.code, 'idle_update_rolled_back')
})

test('the way back is taken once: the record it leaves is no longer requested', async () => {
  const disk = memDisk()
  disk.files.set(RECORD, JSON.stringify(requested()))
  assert.equal((await wayBack(disk).run).outcome, 'rolled_back')
  const again = wayBack(disk)
  assert.equal((await again.run).outcome, 'none')
  assert.deepEqual(again.calls, [])
})

test('nothing to do touches nothing: no mark, no install, no record write', async () => {
  for (const o of [{ installedVersion: '0.80.0' }, { cameBack: 'target' }, { launchedAtMs: T0 - MIN }]) {
    const disk = memDisk()
    const text = JSON.stringify(requested())
    disk.files.set(RECORD, text)
    const w = wayBack(disk, o)
    const back = await w.run
    assert.equal(back.outcome, 'none', JSON.stringify(o))
    assert.equal(back.written, false)
    assert.deepEqual(w.calls, [])
    assert.deepEqual([...disk.files.keys()], [RECORD])
    assert.equal(disk.files.get(RECORD), text)
  }
  const empty = memDisk()
  const w = wayBack(empty)
  assert.equal((await w.run).outcome, 'none')
  assert.equal(empty.files.size, 0)
})

test('a follower: its one way back is spent (went-back), and it goes back to the newer of its own build and the canary\'s', async () => {
  const disk = memDisk()
  disk.files.set(RECORD, JSON.stringify(requested({ canaryN: null, from: '0.79.0', fromRoot: `${CACHE}/0.79.0` })))
  disk.files.set(join(MACHINE, '0.81.0', 'validated'), JSON.stringify({ assistantId: '913', canary: 1, from: '0.80.0', fromRoot: `${CACHE}/0.80.0` }))
  disk.files.set(`${CACHE}/0.80.0/.claude-plugin/plugin.json`, JSON.stringify({ version: '0.80.0' }))
  const w = wayBack(disk)
  assert.equal((await w.run).outcome, 'rolled_back')
  assert.equal(w.calls[0].from, '0.80.0', "the canary's build, newer than its own")
  assert.equal(readJson(disk, join(MACHINE, 'went-back-912')).target, '0.81.0')
  assert.equal(readJson(disk, RECORD).from, '0.80.0', 'the record names the build actually installed')
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'bad')))
})

test('a voided canary is a follower: it spends its way back', async () => {
  const disk = memDisk()
  disk.files.set(RECORD, JSON.stringify(requested()))
  disk.files.set(join(MACHINE, '0.81.0', 'void-1'), '{}')
  await wayBack(disk).run
  assert.ok(disk.files.has(join(MACHINE, 'went-back-912')))
})

test('a follower that used its one way back on another build stays: failed, no mark, the install untouched', async () => {
  const disk = memDisk()
  disk.files.set(RECORD, JSON.stringify(requested({ canaryN: null })))
  disk.files.set(join(MACHINE, '0.81.0', 'validated'), JSON.stringify({ assistantId: '913', canary: 1 }))
  disk.files.set(join(MACHINE, 'went-back-912'), JSON.stringify({ target: '0.79.5' }))
  const w = wayBack(disk)
  const back = await w.run
  assert.equal(back.outcome, 'failed')
  assert.deepEqual(w.calls, [])
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'bad')), false)
  assert.equal(readJson(disk, RECORD).state, 'failed')
})

test('a way back that fails is rollback_failed, with the build still held bad', async () => {
  for (const result of [{ ok: false, reason: 'from_root_missing' }, new Error('disk gone')]) {
    const disk = memDisk()
    disk.files.set(RECORD, JSON.stringify(requested()))
    const back = await wayBack(disk, { result }).run
    assert.equal(back.outcome, 'rollback_failed')
    assert.equal(back.reason, result instanceof Error ? 'disk gone' : 'from_root_missing')
    assert.equal(readJson(disk, RECORD).state, 'rollback_failed')
    assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'bad')))
  }
})

test('a record a daemon of this agent settled meanwhile is left as it wrote it', async () => {
  const disk = memDisk()
  disk.files.set(RECORD, JSON.stringify(requested()))
  const arrived = JSON.stringify(requested({ state: 'arrived', arrivedAt: new Date(T0 + 2 * MIN).toISOString(), lockBoots: 1 }))
  const w = wayBack(disk)
  // Another daemon of this agent settles the record while the install is being moved.
  const read = disk.fs.readFile
  disk.fs.readFile = (p: string) => {
    if (p === RECORD && w.calls.length > 0) disk.files.set(RECORD, arrived)
    return read(p)
  }
  const back = await w.run
  assert.equal(back.written, false)
  assert.equal(disk.files.get(RECORD), arrived)
})

// -- A real disk: hoai's way back through the real marketplace rollback ---------------------------

function realHome() {
  const home = mkdtempSync(join(tmpdir(), 'never-arrived-'))
  const config = join(home, '.claude')
  const cache = join(config, 'plugins', 'cache', 'hoai', 'hoai')
  for (const v of ['0.80.0', '0.81.0']) {
    mkdirSync(join(cache, v, '.claude-plugin'), { recursive: true })
    writeFileSync(join(cache, v, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hoai', version: v }))
  }
  const at = new Date(T0).toISOString()
  writeFileSync(
    join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath: join(cache, '0.81.0'), version: '0.81.0', installedAt: at, lastUpdated: at, gitCommitSha: 'abc' }] } }, null, 2),
  )
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { hoai: { source: { source: 'github', repo: 'BrandGrowthOS/bgos-claude-plugin' }, autoUpdate: true } } }, null, 2))
  const stateDir = join(home, '.bgos-agent', '912')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'idle-update.json'), JSON.stringify(requested({ fromRoot: join(cache, '0.80.0') }), null, 2))
  mkdirSync(join(home, '.bgos-agent', 'idle-update', '0.81.0'), { recursive: true })
  writeFileSync(join(home, '.bgos-agent', 'idle-update', '0.81.0', 'canary-1'), JSON.stringify({ assistantId: '912', at }))
  return { home, config, cache, stateDir }
}

test('hoai on a real disk: the install points back at the old build, the build is held, Claude Code\'s own update is off, the record says rolled_back', async (t) => {
  if (typeof core.idleRollbackNeverArrived !== 'function') assert.fail('bin/hoai-core.mjs idleRollbackNeverArrived is missing: hoai never takes the way back')
  const h = realHome()
  t.after(() => rmSync(h.home, { recursive: true, force: true }))
  const back = await core.idleRollbackNeverArrived({ assistantId: '912', stateDir: h.stateDir, home: h.home, env: {}, cwd: h.home, launchedAtMs: T0 + 5 * SEC, now: T0 + 3 * MIN })
  assert.equal(back.outcome, 'rolled_back', JSON.stringify(back))
  const installed = JSON.parse(readFileSync(join(h.config, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['hoai@hoai'][0]
  assert.equal(installed.version, '0.80.0')
  assert.equal(installed.installPath, join(h.cache, '0.80.0'))
  assert.equal(installed.gitCommitSha, undefined)
  assert.ok(existsSync(join(h.home, '.bgos-agent', 'idle-update', '0.81.0', 'bad')))
  const settings = JSON.parse(readFileSync(join(h.config, 'settings.json'), 'utf8'))
  assert.equal(settings.extraKnownMarketplaces.hoai.autoUpdate, false)
  assert.equal(readdirSync(join(h.home, '.bgos-agent', 'idle-update')).filter((n) => n.startsWith('enrolment-hold-')).length, 1, 'the switch-off is on record as this plugin\'s')
  assert.equal(JSON.parse(readFileSync(join(h.stateDir, 'idle-update.json'), 'utf8')).state, 'rolled_back')
})

test('hoai on a real disk: a record that is not requested is left, and nothing else is touched', async (t) => {
  const h = realHome()
  t.after(() => rmSync(h.home, { recursive: true, force: true }))
  writeFileSync(join(h.stateDir, 'idle-update.json'), JSON.stringify(requested({ state: 'arrived', fromRoot: join(h.cache, '0.80.0') })))
  const before = readFileSync(join(h.config, 'plugins', 'installed_plugins.json'), 'utf8')
  const back = await core.idleRollbackNeverArrived({ assistantId: '912', stateDir: h.stateDir, home: h.home, env: {}, cwd: h.home, launchedAtMs: T0 + 5 * SEC, now: T0 + 3 * MIN })
  assert.equal(back.outcome, 'none')
  assert.equal(readFileSync(join(h.config, 'plugins', 'installed_plugins.json'), 'utf8'), before)
  assert.equal(existsSync(join(h.home, '.bgos-agent', 'idle-update', '0.81.0', 'bad')), false)
})
