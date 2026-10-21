import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createAgentProfileFileArea } from '../lib/browser-profile-file-area.mjs'
type Row = Record<string, any>
function fixture() {
  const directory = path.join(os.tmpdir(), 'synthetic-agent-private', 'runtime'), rows = new Map<string, Row>(), calls: Row[] = []; let changed = false, nextInode = 1
  const stat = (overrides: Row = {}) => ({ dev: 1, ino: nextInode++, uid: 1000, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false, ...overrides })
  const parts = directory.slice(path.parse(directory).root.length).split(path.sep).filter(Boolean); let item = path.parse(directory).root; for (const part of parts) { item = path.join(item, part); rows.set(item, stat()) }
  const fs: Row = { async lstat(target: string) { calls.push({ kind: 'stat', target }); const row = rows.get(target); if (!row) throw Object.assign(Error('missing fixture'), { code: 'ENOENT' }); return row }, async mkdir(target: string, options: Row) { calls.push({ kind: 'mkdir', target, options }); assert.equal(rows.has(target), false); rows.set(target, stat()) }, async realpath(target: string) { return target } }
  const check = () => { if (changed) throw Error('fixture context changed') }, options = { directory, assertCurrent: check, filesystem: fs as any, platform: 'linux' as const, uid: 1000 }
  return { directory, rows, calls, fs, stat, options, change: () => { changed = true } }
}

test('private agent area requires positive exact owner and mode proof and never chmods existing directories', async () => {
  const f = fixture(), area = await createAgentProfileFileArea(f.options); assert.equal(await area.assertPrivateDirectory(f.directory), true); assert.equal(f.calls.some(row => row.kind === 'mkdir'), false)
  f.change(); assert.equal(await area.assertPrivateDirectory(f.directory), true) // Ownership-only receipt still permits independent cleanup; it grants no runtime authority.
})

test('private agent area creates only a missing generated directory with mode0700', async () => {
  const f = fixture(); f.rows.delete(f.directory); await createAgentProfileFileArea(f.options); assert.deepEqual(f.calls.filter(row => row.kind === 'mkdir'), [{ kind: 'mkdir', target: f.directory, options: { mode: 0o700 } }])
})

test('permissive owner or linked directory cannot become private by assertion or adoption', async () => {
  for (const override of [{ mode: 0o40755 }, { uid: 2000 }, { isSymbolicLink: () => true }, { isDirectory: () => false }]) { const f = fixture(); f.rows.set(f.directory, f.stat(override)); await assert.rejects(createAgentProfileFileArea(f.options)); assert.equal(f.calls.some(row => row.kind === 'mkdir'), false) }
})

test('a linked ancestor and a different realpath refuse before returned private capability', async () => {
  const f = fixture(); f.rows.set(path.dirname(f.directory), f.stat({ isSymbolicLink: () => true })); await assert.rejects(createAgentProfileFileArea(f.options)); const g = fixture(); g.fs.realpath = async () => path.dirname(g.directory); await assert.rejects(createAgentProfileFileArea(g.options))
})

test('a replaced original directory cannot pass later inode verification', async () => {
  const f = fixture(), area = await createAgentProfileFileArea(f.options); f.rows.set(f.directory, f.stat()); await assert.rejects(area.assertPrivateDirectory(f.directory))
})

test('context loss after a filesystem await prevents private directory creation', async () => {
  const f = fixture(); f.rows.delete(f.directory); const original = f.fs.lstat; f.fs.lstat = async (target: string) => { if (target === f.directory) f.change(); return original(target) }; await assert.rejects(createAgentProfileFileArea(f.options)); assert.equal(f.calls.some(row => row.kind === 'mkdir'), false)
})

test('a non-Linux host or arbitrary relative and non-normalized directory has no private proof', async () => {
  const f = fixture(); for (const options of [{ ...f.options, platform: 'win32' as const }, { ...f.options, uid: -1 }, { ...f.options, directory: '../private' }, { ...f.options, directory: f.directory + path.sep + '..' + path.sep + 'other' }]) await assert.rejects(createAgentProfileFileArea(options)); assert.equal(f.calls.length, 0)
})
