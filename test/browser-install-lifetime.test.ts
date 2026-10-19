import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { trackBrowserInstaller, captureInstallerGroup, installerGroupEmpty, createInstallerGroupProof } from '../lib/browser-install-lifetime.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture(options: any = {}) {
  const child: any = new EventEmitter()
  child.pid = 900001
  child.stdout = Object.assign(new EventEmitter(), { resume() {} })
  child.stderr = Object.assign(new EventEmitter(), { resume() {} })
  let releases = 0, marked = 0, verified = 0
  const tracker = trackBrowserInstaller({ child, timeoutMs: 1000, verifyInstalled: () => { verified++; return true }, release: () => { releases++; return true }, markUnknown: () => { marked++ }, captureGroup: () => ({ original: true }), groupEmpty: () => false, ...options } as any)
  const start = () => child.emit('spawn')
  const eof = () => { child.stdout.emit('end'); child.stderr.emit('end') }
  return { child, tracker, start, eof, counts: () => ({ releases, marked, verified }) }
}

test('normal success waits original close and both pipe EOF, not exit', async () => {
  const f = fixture(); f.start()
  let done = false; f.tracker.result.then(() => { done = true })
  f.eof(); await turn(); assert.equal(done, false)
  f.child.emit('exit', 0); await turn()
  assert.equal(done, false); assert.equal(f.counts().releases, 0)
  f.child.emit('close', 0); await f.tracker.result; await f.tracker.physical
  assert.deepEqual(f.counts(), { releases: 1, marked: 0, verified: 1 })
  assert.deepEqual(f.tracker.activity(), { pendingPhysicalOperations: 0, cleanupUnknown: false })
})

test('deadline rejects logically but retains physical ownership; late CLI0 is never success', async () => {
  const f = fixture({ timeoutMs: 5 }); f.start()
  const refusal = assert.rejects(f.tracker.result, { code: 'browser_install_recovery_required' })
  await new Promise(resolve => setTimeout(resolve, 15)); await refusal
  assert.deepEqual(f.tracker.activity(), { pendingPhysicalOperations: 1, cleanupUnknown: true })
  assert.equal(f.counts().releases, 0)
  f.child.emit('exit', 0); f.eof(); f.child.emit('close', 0)
  await assert.rejects(f.tracker.physical, { code: 'browser_install_recovery_required' })
  assert.equal(f.counts().releases, 0); assert.equal(f.counts().verified, 0)
})

test('abnormal completion frees only an original positively empty group and never turns failure into success', async () => {
  let observed: any
  const f = fixture({ groupEmpty: (identity: any) => { observed = identity; return identity?.original === true } }); f.start()
  f.child.emit('exit', 1)
  await assert.rejects(f.tracker.result, { code: 'browser_install_recovery_required' })
  assert.equal(f.counts().releases, 0)
  f.eof(); f.child.emit('close', 1); await f.tracker.physical
  assert.deepEqual(observed, { original: true }); assert.equal(f.counts().releases, 1)
  assert.equal(f.tracker.activity().cleanupUnknown, false)
})

test('missing EOF, pipe error, invalid marker and failed release are unknown despite close0', async () => {
  for (const kind of ['missing-eof', 'pipe-error', 'marker', 'release']) {
    const f = fixture(kind === 'marker' ? { verifyInstalled: () => false } : kind === 'release' ? { release: () => false } : {})
    f.start()
    if (kind !== 'missing-eof') f.eof()
    if (kind === 'pipe-error') f.child.stdout.emit('error', new Error('PRIVATE INSTALLER OUTPUT'))
    f.child.emit('exit', 0); f.child.emit('close', 0)
    await assert.rejects(f.tracker.result, (error: any) => error.code === 'browser_install_recovery_required' && !error.message.includes('PRIVATE'))
    await assert.rejects(f.tracker.physical, { code: 'browser_install_recovery_required' })
    assert.equal(f.tracker.activity().cleanupUnknown, true)
  }
})

test('error and cancellation do not settle drain before close or send numeric PID signals', async () => {
  for (const kind of ['error', 'cancel']) {
    const f = fixture(); f.start(); let killed = 0, physical = false
    f.child.kill = () => { killed++ }
    f.tracker.physical.then(() => { physical = true }, () => { physical = true })
    if (kind === 'error') f.child.emit('error', new Error('PRIVATE'))
    else f.tracker.cancel()
    await assert.rejects(f.tracker.result, { code: 'browser_install_recovery_required' }); await turn()
    assert.equal(physical, false); assert.equal(killed, 0)
    f.eof(); f.child.emit('close', 1); await assert.rejects(f.tracker.physical)
  }
})

test('a spawn error with no original child releases only after actual close', async () => {
  const f = fixture(); f.child.pid = undefined
  f.child.emit('error', new Error('ENOENT')); await assert.rejects(f.tracker.result)
  assert.equal(f.counts().releases, 0)
  f.eof(); f.child.emit('close', -1); await f.tracker.physical
  assert.equal(f.counts().releases, 1)
})

test('process group proof refuses unknown identity and non-Linux platforms without signalling', () => {
  assert.equal(captureInstallerGroup({ pid: process.pid }, 'win32'), null)
  assert.equal(captureInstallerGroup({ pid: -1 }, 'linux'), null)
  assert.equal(installerGroupEmpty(null, 'linux'), false)
  assert.equal(installerGroupEmpty({ pid: 1, group: 2, session: 1 }, 'linux'), false)
  assert.equal(installerGroupEmpty({ pid: 1, group: 1, session: 1 }, 'darwin'), false)
})

test('close0 without an original exit0 receipt does not qualify normal success', async () => {
  const f = fixture(); f.start(); f.eof(); f.child.emit('close', 0)
  await assert.rejects(f.tracker.result, { code: 'browser_install_recovery_required' })
  await assert.rejects(f.tracker.physical, { code: 'browser_install_recovery_required' })
  assert.equal(f.counts().releases, 0)
})

const missing = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
const identity = { pid: 41, group: 41, session: 41, start: '12345' }
test('group inventory race never substitutes for kernel group absence', () => {
  let probes = 0
  // Listed parent forks an unlisted child and exits before stat. The group still exists.
  const proof = createInstallerGroupProof({ list: () => ['41', '42'], readStat: missing, probe: (group: number) => { assert.equal(group, 41); probes++ } } as any)
  assert.equal(proof.empty(identity, 'linux'), false)
  assert.equal(probes, 1)
})

test('only ESRCH plus absent original identity qualifies group cleanup', () => {
  for (const code of ['EPERM', 'EACCES', 'EINVAL', undefined, 'ESRCH']) {
    const proof = createInstallerGroupProof({ list: () => [], readStat: missing, probe: () => { throw Object.assign(new Error('probe'), { code }) } } as any)
    assert.equal(proof.empty(identity, 'linux'), code === 'ESRCH')
  }
})

test('reused leader, surviving group member and malformed native identities remain unknown', () => {
  for (const current of [{ ...identity, start: 'different' }, { ...identity, pid: 42 }, { ...identity, group: NaN }]) {
    let probed = false
    const proof = createInstallerGroupProof({ list: () => [String(current.pid)], readStat: () => current, probe: () => { probed = true; throw Object.assign(new Error('absent'), { code: 'ESRCH' }) } } as any)
    assert.equal(proof.empty(identity, 'linux'), false); assert.equal(probed, false)
  }
  const reusedAfterProbe = createInstallerGroupProof({ list: () => [], readStat: () => ({ ...identity, start: '67890' }), probe: () => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }) } } as any)
  assert.equal(reusedAfterProbe.empty(identity, 'linux'), false)
})

test('capturing a group requires exact detached original PID, start and session', () => {
  const proof = createInstallerGroupProof({ readStat: () => ({ ...identity }) } as any)
  assert.deepEqual(proof.capture({ pid: 41 }, 'linux'), identity)
  for (const changed of [{ ...identity, pid: 42 }, { ...identity, session: 42 }, { ...identity, group: 42 }, { ...identity, start: null }]) {
    const invalid = createInstallerGroupProof({ readStat: () => changed } as any)
    assert.equal(invalid.capture({ pid: 41 }, 'linux'), null)
  }
})
