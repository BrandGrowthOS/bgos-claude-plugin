/**
 * lib/machine-id.mjs: the per-machine identity the heartbeat carries so the
 * backend can group every agent (and the watcher) on one host under one
 * machine. Zero-terminal lifecycle design 1.4 / 2.1 / 7.5.
 *
 * Rules pinned here: the file lives at ~/.bgos-agent/machine-id, a uuid v4
 * is minted on first read and persisted (0600 where the platform honours
 * modes), later reads return the same id, a malformed file is re-minted,
 * and an unwritable home yields '' (never a throw, never a fresh id per
 * call that would make the fleet look like N machines).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MACHINE_ID_FILE,
  MACHINE_ID_RE,
  ensureMachineId,
  machineIdPath,
  normalizeMachineId,
} from '../lib/machine-id.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'machine-id-'))
}

test('machineIdPath sits at <home>/.bgos-agent/machine-id', () => {
  assert.equal(machineIdPath('/home/x'), join('/home/x', '.bgos-agent', MACHINE_ID_FILE))
  assert.equal(MACHINE_ID_FILE, 'machine-id')
})

test('normalizeMachineId accepts the backend shape and rejects junk', () => {
  assert.equal(normalizeMachineId('  0f8a7b6c-1234-4abc-8def-0123456789ab\n'), '0f8a7b6c-1234-4abc-8def-0123456789ab')
  assert.equal(normalizeMachineId('short'), null)
  assert.equal(normalizeMachineId('has spaces in it here'), null)
  assert.equal(normalizeMachineId('x'.repeat(65)), null)
  assert.equal(normalizeMachineId(null), null)
  assert.equal(normalizeMachineId(undefined), null)
  assert.ok(MACHINE_ID_RE.test('a'.repeat(8)))
})

test('first read mints a uuid v4, persists it, and later reads return the same id', () => {
  const home = freshHome()
  const first = ensureMachineId({ home })
  assert.match(first, UUID_RE)
  const onDisk = readFileSync(machineIdPath(home), 'utf8')
  assert.equal(onDisk.trim(), first)
  const second = ensureMachineId({ home })
  assert.equal(second, first)
})

test('the minted id uses the injected generator when given', () => {
  const home = freshHome()
  const id = ensureMachineId({ home, generateId: () => 'fixed-machine-id-0001' })
  assert.equal(id, 'fixed-machine-id-0001')
  assert.equal(ensureMachineId({ home, generateId: () => 'other' }), 'fixed-machine-id-0001')
})

test('a malformed file is re-minted, not returned', () => {
  const home = freshHome()
  const path = machineIdPath(home)
  nodeFs.mkdirSync(join(home, '.bgos-agent'), { recursive: true })
  nodeFs.writeFileSync(path, 'not a machine id at all, with spaces\n')
  const id = ensureMachineId({ home })
  assert.match(id, UUID_RE)
  assert.equal(readFileSync(path, 'utf8').trim(), id)
})

test('an empty file is re-minted too', () => {
  const home = freshHome()
  nodeFs.mkdirSync(join(home, '.bgos-agent'), { recursive: true })
  nodeFs.writeFileSync(machineIdPath(home), '')
  assert.match(ensureMachineId({ home }), UUID_RE)
})

test('the file is created 0600 where the platform honours modes', () => {
  if (process.platform === 'win32') return
  const home = freshHome()
  ensureMachineId({ home })
  const mode = statSync(machineIdPath(home)).mode & 0o777
  assert.equal(mode, 0o600)
})

test('an unwritable home yields an empty string, never a throw', () => {
  const home = freshHome()
  const fs = {
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    mkdirSync: () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    },
    writeFileSync: () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    },
    chmodSync: () => {},
  }
  assert.equal(ensureMachineId({ home, fs }), '')
  assert.equal(existsSync(machineIdPath(home)), false)
})

test('a generator that produces junk yields an empty string rather than a bad id', () => {
  const home = freshHome()
  assert.equal(ensureMachineId({ home, generateId: () => 'bad id!' }), '')
  assert.equal(existsSync(machineIdPath(home)), false)
})

test('a write that fails after the read leaves no half-written file behind', () => {
  const home = freshHome()
  let writes = 0
  const real = nodeFs
  const fs = {
    readFileSync: real.readFileSync,
    mkdirSync: real.mkdirSync,
    writeFileSync: () => {
      writes += 1
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    },
    chmodSync: real.chmodSync,
  }
  assert.equal(ensureMachineId({ home, fs }), '')
  assert.equal(writes, 1)
  assert.equal(existsSync(machineIdPath(home)), false)
})
