/**
 * PERSON LANES, a person's Memory screen answered from her own lane (shared
 * agents Phase 3, P5; design section 6 and its "As built in P4" list;
 * lib/lane-memory-rpc.ts, lib/lane-memory.mjs).
 *
 *   - A frame is the owner's only with no stamp (or `owner`) and no person;
 *     a person's only when stamped EXACTLY for the safe id it names;
 *     anything else is dropped.
 *   - The lane daemon answers only its own person, the owner's daemon (a
 *     stopped lane) any person, and either answers from THAT person's
 *     `<lane>/work/memory/`, never the owner's memory or another lane's.
 *   - EVERY answer, an error included, echoes `lane` at the top and
 *     `actorUserId` and `lane` in its payload.
 *   - A write is applied AT MOST ONCE per rpcId ACROSS PROCESSES: two
 *     handlers (two processes) over one disk apply it once, the second
 *     re-sends the first answer, and a write another process holds gets no
 *     answer at all from this one.
 *   - A planted symlink (the memory folder, a note) never turns a panel read
 *     or write into one of the owner's files.
 *
 * Run with: npx tsx --test test/lane-memory-rpc.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and these
// tests use POSIX symlinks and 0600 modes, so the file is skipped there.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lanePaths } from '../lib/lane-core.mjs'
import { claimLaneMemoryWrite, finishLaneMemoryWrite } from '../lib/lane-memory.mjs'
import { classifyMemoryFrame, confinedMemoryFs, laneMemoryAnswer, LaneMemoryRpcHandler, LANE_MEMORY_RPC_TOKEN } from '../lib/lane-memory-rpc.ts'
import { nodeMemoryFs } from '../lib/memory.ts'
import * as realFs from 'node:fs'

const AGENT = '1076'

function home(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'lane-mem-')))
}

function frame(userId: string, op: string, payload: Record<string, unknown> = {}, rpcId = `rpc-${op}-${userId}`) {
  return { rpcId, op, assistantId: AGENT, payload, actorUserId: userId, lane: `person:${userId}` }
}

function handler(h: string, opts: { accepts?: (u: string) => boolean; acks?: string[]; results?: Array<{ rpcId: string; body: Record<string, unknown> }> } = {}) {
  const results = opts.results ?? []
  const acks = opts.acks ?? []
  const logs: string[] = []
  const handle = new LaneMemoryRpcHandler({
    assistantId: AGENT,
    home: h,
    accepts: opts.accepts ?? (() => true),
    postAck: async (rpcId) => { acks.push(rpcId) },
    postResult: async (rpcId, body) => { results.push({ rpcId, body }) },
    log: (l) => logs.push(l),
  })
  return { handle, results, acks, logs }
}

function seedNote(h: string, userId: string, text: string) {
  const paths = lanePaths({ home: h, assistantId: AGENT, userId })
  mkdirSync(paths.memoryDir, { recursive: true })
  writeFileSync(join(paths.memoryDir, 'MEMORY.md'), `- [Fact](fact.md) - ${text}\n`)
  writeFileSync(join(paths.memoryDir, 'fact.md'), `---\nname: Fact\ndescription: "${text}"\nmetadata:\n  type: user\n---\n\n${text}\n`)
  return paths
}

test('the token is the backend\'s spelling', () => {
  assert.equal(LANE_MEMORY_RPC_TOKEN, 'lane_memory_rpc')
})

test('whose frame: the owner\'s only unstamped with no person; a person\'s only exactly stamped', () => {
  assert.equal(classifyMemoryFrame({ rpcId: 'r', op: 'list', assistantId: 1, payload: {} }).kind, 'owner')
  assert.equal(classifyMemoryFrame({ rpcId: 'r', op: 'list', assistantId: 1, payload: {}, lane: 'owner' }).kind, 'owner')
  const person = classifyMemoryFrame({ rpcId: 'r', op: 'list', assistantId: '1', payload: {}, actorUserId: 'user_ana', lane: 'person:user_ana' })
  assert.equal(person.kind, 'person')
  const drops: unknown[] = [
    { op: 'list', assistantId: 1, actorUserId: 'user_ana', lane: 'person:user_ana' },
    { rpcId: 'r', op: 'list', assistantId: 1, actorUserId: 'user_ana' },
    { rpcId: 'r', op: 'list', assistantId: 1, actorUserId: 'user_ana', lane: 'person:user_ben' },
    { rpcId: 'r', op: 'list', assistantId: 1, actorUserId: '../x', lane: 'person:../x' },
    { rpcId: 'r', op: 'list', assistantId: 1, lane: 'person:user_ana' },
    { rpcId: 'r', op: 'list', assistantId: 1, actorUserId: 'user_ana', lane: 'PERSON:user_ana' },
    { rpcId: 'r', op: 'list', assistantId: 1, actorUserId: 'user_ana', lane: 7 },
  ]
  for (const raw of drops) assert.equal(classifyMemoryFrame(raw).kind, 'drop', JSON.stringify(raw))
})

test('every answer echoes the stamp, an error answer included', () => {
  const ok = laneMemoryAnswer({ ok: true, payload: { stores: {} } }, 'user_ana')
  assert.deepEqual(ok, { ok: true, payload: { stores: {}, actorUserId: 'user_ana', lane: 'person:user_ana' }, lane: 'person:user_ana' })
  const err = laneMemoryAnswer({ ok: false, error: { code: 'unsupported', message: 'x' } }, 'user_ana')
  assert.deepEqual(err, { ok: false, error: { code: 'unsupported', message: 'x' }, payload: { actorUserId: 'user_ana', lane: 'person:user_ana' }, lane: 'person:user_ana' })
})

test('a list reads THAT person\'s own lane memory, and a write lands in her work/memory, with the echo', async () => {
  const h = home()
  try {
    seedNote(h, 'user_ana', 'Ana likes durian')
    seedNote(h, 'user_ben', 'Ben likes kiwi')
    const { handle, results, acks } = handler(h)
    await handle.handle(frame('user_ana', 'list'))
    assert.equal(results.length, 1)
    const listed = results[0]!.body as { ok: boolean; lane: string; payload: { stores: { user: { entries: Array<{ text: string }> } }; actorUserId: string } }
    assert.equal(listed.ok, true)
    assert.equal(listed.lane, 'person:user_ana')
    assert.equal(listed.payload.actorUserId, 'user_ana')
    assert.deepEqual(listed.payload.stores.user.entries.map((e) => e.text), ['Ana likes durian'])
    assert.ok(!JSON.stringify(listed).includes('kiwi'), 'never another lane\'s memory')
    await handle.handle(frame('user_ana', 'add', { target: 'memory', content: 'Ana works nights' }))
    const added = results[1]!.body as { ok: boolean; lane: string }
    assert.equal(added.ok, true)
    assert.equal(added.lane, 'person:user_ana')
    const ana = lanePaths({ home: h, assistantId: AGENT, userId: 'user_ana' })
    assert.match(readFileSync(join(ana.memoryDir, 'MEMORY.md'), 'utf8'), /Ana works nights/)
    assert.doesNotMatch(readFileSync(join(lanePaths({ home: h, assistantId: AGENT, userId: 'user_ben' }).memoryDir, 'MEMORY.md'), 'utf8'), /nights/)
    assert.deepEqual(acks, ['rpc-list-user_ana', 'rpc-add-user_ana'])
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('a lane daemon answers only its own person; a frame for another agent gets nothing, not even an ack', async () => {
  const h = home()
  try {
    seedNote(h, 'user_ben', 'Ben likes kiwi')
    const { handle, results, acks } = handler(h, { accepts: (u) => u === 'user_ana' })
    await handle.handle(frame('user_ben', 'list'))
    await handle.handle({ ...frame('user_ana', 'list'), assistantId: '9' })
    await handle.handle({ ...frame('user_ana', 'list'), lane: 'person:user_ben' })
    assert.deepEqual(results, [])
    assert.deepEqual(acks, [])
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('search and unknown ops are answered as unsupported, with the echo', async () => {
  const h = home()
  try {
    const { handle, results } = handler(h)
    await handle.handle(frame('user_ana', 'search', { query: 'x', limit: 10 }))
    await handle.handle(frame('user_ana', 'teleport'))
    for (const r of results) {
      assert.equal(r.body.ok, false)
      assert.equal(r.body.lane, 'person:user_ana')
      assert.equal((r.body.error as { code: string }).code, 'unsupported')
    }
    assert.equal(results.length, 2)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('ONCE PER rpcId ACROSS PROCESSES: two daemons over one disk apply a write once and both answer the same', async () => {
  const h = home()
  try {
    const shared: Array<{ rpcId: string; body: Record<string, unknown> }> = []
    const lane = handler(h, { results: shared })
    const owner = handler(h, { results: shared })
    const add = frame('user_ana', 'add', { target: 'memory', content: 'Ana works nights' }, 'rpc-shared-1')
    await lane.handle.handle(add)
    await owner.handle.handle(add)
    await lane.handle.handle(add)
    const index = readFileSync(join(lanePaths({ home: h, assistantId: AGENT, userId: 'user_ana' }).memoryDir, 'MEMORY.md'), 'utf8')
    assert.equal(index.split('\n').filter((l) => l.includes('Ana works nights')).length, 1, 'applied exactly once: one index line')
    assert.equal(shared.length, 3)
    assert.deepEqual(shared[1]!.body, shared[0]!.body, 'the second process re-sends the first answer')
    assert.deepEqual(shared[2]!.body, shared[0]!.body)
    assert.deepEqual(owner.acks, [], 'the duplicate is not acked as new work')
    const markers = readdirSync(lanePaths({ home: h, assistantId: AGENT, userId: 'user_ana' }).memoryRpcDir)
    assert.equal(markers.length, 1)
    assert.ok(!markers[0]!.includes('rpc-shared-1'), 'the marker name is a hash, never the raw id')
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('a write another process is still applying gets no answer from this one, and is not applied twice', async () => {
  const h = home()
  try {
    const paths = lanePaths({ home: h, assistantId: AGENT, userId: 'user_ana' })
    assert.deepEqual(claimLaneMemoryWrite(paths.memoryRpcDir, 'rpc-held'), { kind: 'first' })
    const { handle, results, acks } = handler(h)
    await handle.handle(frame('user_ana', 'add', { target: 'memory', content: 'should not land' }, 'rpc-held'))
    assert.deepEqual(results, [])
    assert.deepEqual(acks, [])
    assert.equal(existsSync(join(paths.memoryDir, 'MEMORY.md')), false)
    finishLaneMemoryWrite(paths.memoryRpcDir, 'rpc-held', { ok: true, lane: 'person:user_ana' })
    assert.deepEqual(claimLaneMemoryWrite(paths.memoryRpcDir, 'rpc-held'), { kind: 'done', result: { ok: true, lane: 'person:user_ana' } })
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('reads are not held by the marker: a list re-runs and answers again', async () => {
  const h = home()
  try {
    const { handle, results } = handler(h)
    await handle.handle(frame('user_ana', 'list', {}, 'rpc-list-twice'))
    await handle.handle(frame('user_ana', 'list', {}, 'rpc-list-twice'))
    assert.equal(results.length, 2)
    assert.equal(existsSync(lanePaths({ home: h, assistantId: AGENT, userId: 'user_ana' }).memoryRpcDir), false, 'no marker for a read')
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('a symlinked memory folder is refused: the owner\'s files are never read or written through it', async () => {
  const h = home()
  try {
    const owner = join(h, 'owner-memory')
    mkdirSync(owner, { recursive: true })
    writeFileSync(join(owner, 'MEMORY.md'), '- [Secret](secret.md) - the owner\'s secret\n')
    writeFileSync(join(owner, 'secret.md'), '---\nname: Secret\n---\n\nthe owner\'s secret\n')
    const paths = lanePaths({ home: h, assistantId: AGENT, userId: 'user_ana' })
    mkdirSync(paths.workDir, { recursive: true })
    symlinkSync(owner, paths.memoryDir)
    const { handle, results } = handler(h)
    await handle.handle(frame('user_ana', 'list'))
    await handle.handle(frame('user_ana', 'add', { target: 'memory', content: 'planted' }))
    for (const r of results) {
      assert.equal(r.body.ok, false)
      assert.equal(r.body.lane, 'person:user_ana')
    }
    assert.ok(!JSON.stringify(results).includes('secret'))
    assert.doesNotMatch(readFileSync(join(owner, 'MEMORY.md'), 'utf8'), /planted/)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('a symlinked note is never read through', async () => {
  const h = home()
  try {
    const paths = lanePaths({ home: h, assistantId: AGENT, userId: 'user_ana' })
    mkdirSync(paths.memoryDir, { recursive: true })
    const outside = join(h, 'outside.md')
    writeFileSync(outside, '---\nname: Leak\nmetadata:\n  type: user\n---\n\nTOP-SECRET-CONTENT\n')
    symlinkSync(outside, join(paths.memoryDir, 'leak.md'))
    writeFileSync(join(paths.memoryDir, 'MEMORY.md'), '- [Leak](leak.md) - a hook\n')
    const { handle, results } = handler(h)
    await handle.handle(frame('user_ana', 'list'))
    assert.ok(!JSON.stringify(results).includes('TOP-SECRET-CONTENT'))
    // Observable: the outside file says `type: user`; read through the link,
    // the entry would land in the user store.
    const listed = results[0]!.body as { payload: { stores: { memory: { entries: unknown[] }; user: { entries: unknown[] } } } }
    assert.equal(listed.payload.stores.user.entries.length, 0, 'the link was not read')
    assert.equal(listed.payload.stores.memory.entries.length, 1)
    // And the Undo path cannot carry the outside file's words into the lane:
    // a remove then the same add restores only what was read, which is nothing.
    await handle.handle(frame('user_ana', 'remove', { target: 'memory', oldText: 'a hook' }, 'rpc-rm-link'))
    await handle.handle(frame('user_ana', 'add', { target: 'memory', content: 'a hook' }, 'rpc-add-back'))
    for (const name of readdirSync(paths.memoryDir)) {
      const full = join(paths.memoryDir, name)
      if (lstatSync(full).isSymbolicLink()) continue // the planted link itself, left untouched
      try {
        assert.doesNotMatch(readFileSync(full, 'utf8'), /TOP-SECRET-CONTENT/, `${name} carries the outside file`)
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err
      }
    }
    const trash = lanePaths({ home: h, assistantId: AGENT, userId: 'user_ana' }).memoryTrashDir
    for (const name of existsSync(trash) ? readdirSync(trash) : []) {
      assert.doesNotMatch(readFileSync(join(trash, name), 'utf8'), /TOP-SECRET-CONTENT/, 'nor its trash')
    }
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('a symlink planted between the check and the read is still refused (the read never follows it, review L1)', () => {
  const h = home()
  try {
    const root = join(h, 'memory')
    mkdirSync(root, { recursive: true })
    const outside = join(h, 'outside.md')
    writeFileSync(outside, 'OWNER-SECRET-9090')
    const note = join(root, 'note.md')
    symlinkSync(outside, note)
    // The race: the check's lstat saw a plain file, the path is a link by the time it is read.
    const racing = { ...realFs, lstatSync: ((p: string) => (p === note ? { isSymbolicLink: () => false } : realFs.lstatSync(p))) } as unknown as typeof realFs
    const view = confinedMemoryFs(nodeMemoryFs, () => [root], racing)
    assert.equal(view.readFile(note), null)
    writeFileSync(join(root, 'plain.md'), 'mine')
    assert.equal(view.readFile(join(root, 'plain.md')), 'mine', 'a plain note is read')
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})
