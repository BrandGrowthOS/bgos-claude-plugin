/**
 * The skills_rpc handler (skills view design, section 7 row 3): how a frame
 * from the owner's Abilities screen becomes one answer, and only one.
 *
 * Same lane rules as memory_rpc (lib/memory-rpc.ts): a frame for another agent
 * gets nothing, a re sent frame never runs twice, the ack is best effort, a
 * result is always posted, and nothing is read before the home folder is
 * confirmed. The two ops are list_installed and remove; the Store ops are not
 * Claude Code's and answer unsupported.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SkillsRpcHandler, normalizeSkillsRpc, type SkillsRpcFrame } from '../lib/skills-rpc.ts'

type Post = { kind: 'ack' | 'result'; rpcId: string; body?: any }

const ROW = {
  name: 'agent-skill',
  description: 'Does it.',
  provenance: 'local',
  removable: true,
  scope: 'agent',
  path: '~/a/.claude/skills/agent-skill',
  shareable: true,
}

function harness(opts: {
  own?: string
  confirmed?: boolean
  list?: () => any
  remove?: (payload: Record<string, unknown>) => any
  postAck?: () => Promise<unknown>
} = {}) {
  const posts: Post[] = []
  const logs: string[] = []
  const calls: Array<[string, unknown?]> = []
  const handler = new SkillsRpcHandler({
    inventory: {
      list: () => {
        calls.push(['list'])
        return opts.list ? opts.list() : { skills: [ROW] }
      },
      remove: (payload) => {
        calls.push(['remove', payload])
        return opts.remove
          ? opts.remove(payload)
          : { ok: true, removed: { name: 'agent-skill', scope: 'agent', path: ROW.path } }
      },
    },
    assistantId: () => opts.own ?? '701',
    homeConfirmed: () => opts.confirmed ?? true,
    postAck: async (rpcId) => {
      posts.push({ kind: 'ack', rpcId })
      if (opts.postAck) await opts.postAck()
    },
    postResult: async (rpcId, body) => {
      posts.push({ kind: 'result', rpcId, body })
    },
    log: (m) => logs.push(m),
  })
  return { handler, posts, logs, calls }
}

function frame(op: string, payload: Record<string, unknown> = {}, extra: Partial<SkillsRpcFrame> = {}): SkillsRpcFrame {
  return { rpcId: 'r1', op, assistantId: '701', payload, ...extra }
}

test('normalize drops a frame with no rpcId and keeps an unknown op', () => {
  assert.equal(normalizeSkillsRpc(null), null)
  assert.equal(normalizeSkillsRpc({ op: 'list_installed' }), null)
  assert.equal(normalizeSkillsRpc({ rpcId: '' }), null)
  assert.deepEqual(normalizeSkillsRpc({ rpcId: 'x', op: 'weird', assistantId: 701, payload: [1] }), {
    rpcId: 'x',
    op: 'weird',
    assistantId: '701',
    payload: {},
  })
})

test('a frame for another assistant is skipped: no ack, no result, nothing read', async () => {
  const h = harness()
  await h.handler.handle(frame('list_installed', {}, { assistantId: '999' }))
  await h.handler.handle(frame('remove', { name: 'agent-skill', scope: 'agent', path: ROW.path }, { rpcId: 'r2', assistantId: '999' }))
  assert.deepEqual(h.posts, [])
  assert.deepEqual(h.calls, [])
  const unknown = harness({ own: '' })
  await unknown.handler.handle(frame('list_installed'))
  assert.deepEqual(unknown.posts, [])
})

test('list_installed acks, then answers { skills } from the inventory', async () => {
  const h = harness()
  await h.handler.handle(frame('list_installed'))
  assert.deepEqual(h.posts, [
    { kind: 'ack', rpcId: 'r1' },
    { kind: 'result', rpcId: 'r1', body: { ok: true, payload: { skills: [ROW] } } },
  ])
})

test('list_installed passes the omitted reasons through, and omits the key when there are none', async () => {
  const omitted = [{ scope: 'agent', reason: 'no_launch_cwd' }]
  const h = harness({ list: () => ({ skills: [], omitted }) })
  await h.handler.handle(frame('list_installed'))
  assert.deepEqual(h.posts[1]!.body, { ok: true, payload: { skills: [], omitted } })
})

test('remove hands the whole payload to the inventory and answers what it did', async () => {
  const h = harness()
  const payload = { name: 'agent-skill', scope: 'agent', path: ROW.path }
  await h.handler.handle(frame('remove', payload))
  assert.deepEqual(h.calls, [['remove', payload]])
  assert.deepEqual(h.posts[1]!.body, {
    ok: true,
    payload: { removed: { name: 'agent-skill', scope: 'agent', path: ROW.path } },
  })
})

test('a refused remove answers its code', async () => {
  const h = harness({ remove: () => ({ ok: false, code: 'scope_refused', message: 'only agent skills can be removed here' }) })
  await h.handler.handle(frame('remove', { name: 'x', scope: 'computer', path: '~/.claude/skills/x' }))
  assert.deepEqual(h.posts[1]!.body, {
    ok: false,
    error: { code: 'scope_refused', message: 'only agent skills can be removed here' },
  })
})

test('nothing is read or removed before the home folder is confirmed', async () => {
  const h = harness({ confirmed: false })
  await h.handler.handle(frame('list_installed'))
  await h.handler.handle(frame('remove', { name: 'agent-skill', scope: 'agent', path: ROW.path }, { rpcId: 'r2' }))
  assert.deepEqual(h.calls, [])
  assert.equal(h.posts[1]!.body.error.code, 'unavailable')
  assert.equal(h.posts[3]!.body.error.code, 'unavailable')
})

test('the Store ops and anything unknown answer unsupported, never a timeout', async () => {
  for (const op of ['install', 'catalog', 'export_skill', 'install_bundle', '']) {
    const h = harness()
    await h.handler.handle(frame(op))
    assert.equal(h.posts[1]!.body.error.code, 'unsupported', op)
    assert.deepEqual(h.calls, [])
  }
})

test('a re sent frame runs once and is answered again from memory', async () => {
  const h = harness()
  const f = frame('remove', { name: 'agent-skill', scope: 'agent', path: ROW.path })
  await h.handler.handle(f)
  await h.handler.handle(f)
  assert.equal(h.calls.length, 1)
  assert.equal(h.posts.filter((p) => p.kind === 'result').length, 2)
  assert.deepEqual(h.posts[1]!.body, h.posts[2]!.body)
})

test('a failed ack does not stop the work; a throw answers read_failed', async () => {
  const h = harness({ postAck: async () => { throw new Error('net down') } })
  await h.handler.handle(frame('list_installed'))
  assert.equal(h.posts[1]!.body.ok, true)
  const t = harness({ list: () => { throw new Error('EACCES — nope') } })
  await t.handler.handle(frame('list_installed'))
  assert.equal(t.posts[1]!.body.error.code, 'read_failed')
  assert.ok(!/[–—]/.test(t.posts[1]!.body.error.message))
})

test('the answer carries no null or undefined anywhere', async () => {
  const h = harness({ list: () => ({ skills: [{ ...ROW, hiddenBy: undefined }] }) })
  await h.handler.handle(frame('list_installed'))
  const json = JSON.stringify(h.posts[1]!.body)
  assert.ok(!json.includes('null'))
  assert.deepEqual(Object.keys(h.posts[1]!.body.payload.skills[0]).includes('hiddenBy'), false)
})

test('a flood of answered frames never evicts a frame still running', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let calls = 0
  const h = harness({ list: async () => { calls += 1; if (calls === 1) await gate; return { skills: [] } } })
  const slow = h.handler.handle(frame('list_installed', {}, { rpcId: 'slow' }))
  for (let i = 0; i < 300; i++) await h.handler.handle(frame('list_installed', {}, { rpcId: `f${i}` }))
  // the re emit of the running frame is ignored, not run a second time
  await h.handler.handle(frame('list_installed', {}, { rpcId: 'slow' }))
  assert.equal(calls, 301)
  release()
  await slow
})
