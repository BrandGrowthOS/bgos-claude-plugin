import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createDarwinProcessProof } from '../lib/browser-profile-process-darwin.mjs'

const unavailable = { code: 'profile_process_exit_proof_unavailable' }
const first = 'Sat Nov  7 12:34:56 2026'
const replacement = 'Sat Nov  7 12:34:57 2026'
const result = (stdout: string, status = 0) => ({ stdout, stderr: '', status, signal: null })

// Changing the pinned start time, accepting an unavailable ps, or comparing
// only the pid would violate these exit-proof assertions.
test('Darwin proof distinguishes a live identity, a reused pid and an exited process', () => {
  let current: any = result(` 123 123 ${first}\n`)
  const proof = createDarwinProcessProof({ read: () => current })
  const identity = proof.identity(123)
  assert.deepEqual(identity, { pid: 123, started: String(Date.UTC(2026, 10, 7, 12, 34, 56)) })
  assert.equal(proof.exited(identity), false)
  current = result(`123 123 ${replacement}\n`)
  assert.notDeepEqual(proof.identity(123), identity)
  assert.equal(proof.exited(identity), true)
  current = result('', 1)
  assert.equal(proof.exited(identity), true)
  assert.throws(() => proof.identity(123), unavailable)
})

test('Darwin proof fails closed when the helper is missing or its output is unproved', () => {
  for (const response of [
    { ...result('', 1), error: Object.assign(new Error('synthetic missing helper'), { code: 'ENOENT' }) },
    { ...result('', 1), stderr: 'synthetic permission denied' },
    { ...result('', 0), signal: 'SIGTERM' },
    result('', 0), result('garbage\n'), result(`124 124 ${first}\n`),
    result(`123 123 ${first}\n123 123 ${first}\n`),
    result(`123 123 ${first}\n`, 2),
  ]) {
    const proof = createDarwinProcessProof({ read: () => response })
    assert.throws(() => proof.identity(123), unavailable)
    assert.throws(() => proof.exited({ pid: 123, started: '1234' }), unavailable)
  }
  const thrown = createDarwinProcessProof({ read: () => { throw new Error('synthetic read failure') } })
  assert.throws(() => thrown.exited({ pid: 123, started: '1234' }), unavailable)
})

test('Darwin proof validates calendar dates and does not normalize malformed timestamps', () => {
  for (const timestamp of [
    'Fri Nov  7 12:34:56 2026', 'Sat Foo  7 12:34:56 2026',
    'Sat Nov 31 12:34:56 2026', 'Sat Nov  7 24:34:56 2026',
    'Sat Nov  7 12:60:56 2026', 'Sat Nov  7 12:34:60 2026',
    'Sam Nov  7 12:34:56 2026', `${first} trailing`,
  ]) {
    const proof = createDarwinProcessProof({ read: () => result(`123 123 ${timestamp}\n`) })
    assert.throws(() => proof.identity(123), unavailable)
  }
})

test('Darwin proof rejects untrusted pids before invoking the reader', () => {
  let reads = 0
  const proof = createDarwinProcessProof({ read: () => { reads++; return result(`123 123 ${first}\n`) } })
  for (const pid of [undefined, null, 0, -1, 1.5, NaN, Infinity, '123;exit', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => proof.identity(pid as number), unavailable)
  }
  assert.equal(reads, 0)
})

test('Darwin proof uses an absolute helper, fixed locale and timezone, bounded argv execution', () => {
  const proof = createDarwinProcessProof({ read: (file: string, args: string[], options: any) => {
    assert.equal(file, '/bin/ps')
    assert.deepEqual(args, ['-o', 'pid=,pgid=,lstart=', '-p', '123'])
    assert.equal(options.env.LC_ALL, 'C')
    assert.equal(options.env.TZ, 'UTC')
    assert.equal(options.shell, false)
    assert.equal(options.encoding, 'utf8')
    assert.ok(options.timeout > 0 && options.timeout <= 5000)
    assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 16 * 1024 * 1024)
    return result(`123 123 ${first}\n`)
  } })
  assert.equal(proof.identity(123).pid, 123)
})

test('Darwin group inventory carries start identities and refuses partial or empty tables', () => {
  let current = result(`123 123 ${first}    \n124 123 ${replacement}    \n125 125 ${first}    \n`)
  const proof = createDarwinProcessProof({ read: (_file: string, args: string[]) => {
    assert.deepEqual(args, ['-A', '-o', 'pid=,pgid=,lstart='])
    return current
  } })
  assert.deepEqual(proof.groupMembers(123), [
    { pid: 123, started: String(Date.UTC(2026, 10, 7, 12, 34, 56)) },
    { pid: 124, started: String(Date.UTC(2026, 10, 7, 12, 34, 57)) },
  ])
  for (const invalid of [result(''), result('', 1), result(`123 123 ${first}\nbad row\n`)]) {
    current = invalid
    assert.throws(() => proof.groupMembers(123), unavailable)
  }
})

test('real Darwin reader proves a child is alive and then proves its exit', { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await once(child, 'spawn')
  const proof = createDarwinProcessProof(), identity = proof.identity(child.pid!)
  assert.equal(proof.exited(identity), false)
  assert.ok(proof.groupMembers(child.pid!).some((member: any) => member.pid === identity.pid && member.started === identity.started))
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  assert.equal(proof.exited(identity), true)
})
