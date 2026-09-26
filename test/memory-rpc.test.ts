/**
 * The memory_rpc handler (HOAI P7 stage 2, C-39): how a frame from the owner's
 * Memory screen becomes one answer, and only one.
 *
 * The backend emits a frame to the pairing room, re emits it ONCE when no ack
 * lands within 1.5 s, and takes the first result it receives. So the handler
 * must ack, always post a result, never run a frame twice (it REMEMBERS ids
 * rather than forgetting them in a finally, the voice_rpc shape, which would let
 * a re emit after a fast write add a fact twice), and stay silent for a frame
 * that is another agent's (several daemons can share a pairing room, and an
 * error from the wrong one could be the answer that wins).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryRpcHandler, normalizeMemoryRpc, type MemoryRpcFrame } from '../lib/memory-rpc.ts'

const STORES = {
  memory: { entries: [{ text: 'likes tea', flagged: false, patterns: [] }], chars: 26, limit: 25000 },
  user: { entries: [], chars: 0, limit: 25000 },
}

type Post = { kind: 'ack' | 'result'; rpcId: string; body?: any }

function fakeStore(answer?: (op: string, args: unknown[]) => any) {
  const calls: Array<[string, ...unknown[]]> = []
  const reply = (op: string, ...args: unknown[]) => {
    calls.push([op, ...args])
    return answer ? answer(op, args) : { ok: true, stores: STORES }
  }
  return {
    calls,
    store: {
      list: () => reply('list'),
      add: (t: string, c: string) => reply('add', t, c),
      replace: (t: string, o: string, n: string) => reply('replace', t, o, n),
      remove: (t: string, o: string) => reply('remove', t, o),
    },
  }
}

function harness(opts: {
  own?: string
  confirmed?: boolean
  answer?: (op: string, args: unknown[]) => any
  postAck?: (rpcId: string) => Promise<unknown>
  postResult?: (rpcId: string, body: any) => Promise<unknown>
} = {}) {
  const posts: Post[] = []
  const logs: string[] = []
  const fake = fakeStore(opts.answer)
  const handler = new MemoryRpcHandler({
    store: fake.store as any,
    assistantId: () => opts.own ?? '701',
    homeConfirmed: () => opts.confirmed ?? true,
    postAck: async (rpcId) => {
      posts.push({ kind: 'ack', rpcId })
      if (opts.postAck) await opts.postAck(rpcId)
    },
    postResult: async (rpcId, body) => {
      posts.push({ kind: 'result', rpcId, body })
      if (opts.postResult) await opts.postResult(rpcId, body)
    },
    log: (msg) => logs.push(msg),
  })
  return { handler, posts, logs, calls: fake.calls }
}

function frame(op: string, payload: Record<string, unknown> = {}, rpcId = 'r1', assistantId: unknown = 701): MemoryRpcFrame {
  const f = normalizeMemoryRpc({ rpcId, op, assistantId, payload })
  assert.ok(f, 'the frame normalises')
  return f
}

function results(posts: Post[]) {
  return posts.filter((p) => p.kind === 'result').map((p) => p.body)
}

test('acks, then always posts one result', async () => {
  const h = harness()
  await h.handler.handle(frame('list'))
  assert.deepEqual(h.posts, [
    { kind: 'ack', rpcId: 'r1' },
    { kind: 'result', rpcId: 'r1', body: { ok: true, payload: { stores: STORES } } },
  ])
  assert.deepEqual(h.calls, [['list']])

  await h.handler.handle(frame('add', { target: 'user', content: 'My name is Kc' }, 'r2'))
  await h.handler.handle(frame('replace', { target: 'memory', oldText: 'likes tea', newContent: 'likes green tea' }, 'r3'))
  await h.handler.handle(frame('remove', { target: 'memory', oldText: 'likes tea' }, 'r4'))
  assert.deepEqual(h.calls.slice(1), [
    ['add', 'user', 'My name is Kc'],
    ['replace', 'memory', 'likes tea', 'likes green tea'],
    ['remove', 'memory', 'likes tea'],
  ])
  assert.deepEqual(
    h.posts.slice(2).map((p) => `${p.kind} ${p.rpcId}`),
    ['ack r2', 'result r2', 'ack r3', 'result r3', 'ack r4', 'result r4'],
  )

  // A refusal from the store is a result too, with its own code.
  const refused = harness({ answer: () => ({ ok: false, code: 'no_match', message: 'no memory entry matches that text exactly' }) })
  await refused.handler.handle(frame('remove', { target: 'memory', oldText: 'nothing' }))
  assert.deepEqual(results(refused.posts), [
    { ok: false, error: { code: 'no_match', message: 'no memory entry matches that text exactly' } },
  ])
})

test('a frame with no rpcId is dropped; anything with one is answered', async () => {
  for (const raw of [null, undefined, 'list', 42, [], { op: 'list' }, { rpcId: 7, op: 'list' }, { rpcId: '', op: 'list' }]) {
    assert.equal(normalizeMemoryRpc(raw), null, `${JSON.stringify(raw)} cannot be answered`)
  }
  assert.deepEqual(normalizeMemoryRpc({ rpcId: 'r9', op: 'list', assistantId: 701, payload: [1] }), {
    rpcId: 'r9',
    op: 'list',
    assistantId: '701',
    payload: {},
  })
  assert.deepEqual(normalizeMemoryRpc({ rpcId: 'r9', op: 5 }), { rpcId: 'r9', op: '', assistantId: '', payload: {} })

  const h = harness()
  await h.handler.handle(frame('dance'))
  assert.deepEqual(h.posts.map((p) => p.kind), ['ack', 'result'])
  assert.equal(results(h.posts)[0].ok, false)
  assert.equal(results(h.posts)[0].error.code, 'unsupported')
  assert.deepEqual(h.calls, [])
})

test('search is answered unsupported, never silence', async () => {
  const h = harness()
  await h.handler.handle(frame('search', { query: 'address', limit: 10 }))
  assert.deepEqual(results(h.posts), [
    { ok: false, error: { code: 'unsupported', message: 'memory search is not available on this agent' } },
  ])
  assert.deepEqual(h.calls, [])
})

test('a bad payload is a bad_request', async () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['add', { content: 'no target' }],
    ['add', { target: 'notes', content: 'wrong target' }],
    ['add', { target: 'memory' }],
    ['add', { target: 'memory', content: '   ' }],
    ['add', { target: 'memory', content: 42 }],
    ['add', { target: 'memory', content: 'x'.repeat(4001) }],
    ['replace', { target: 'memory', oldText: 'likes tea' }],
    ['replace', { target: 'memory', newContent: 'likes green tea' }],
    ['replace', { target: 'user', oldText: 'x'.repeat(4001), newContent: 'y' }],
    ['remove', { target: 'memory' }],
    ['remove', { target: 'memory', oldText: '' }],
    ['remove', { oldText: 'likes tea' }],
  ]
  for (const [op, payload] of bad) {
    const h = harness()
    await h.handler.handle(frame(op, payload))
    const [result] = results(h.posts)
    assert.equal(result.ok, false, `${op} ${JSON.stringify(payload).slice(0, 60)}`)
    assert.equal(result.error.code, 'bad_request', `${op} ${JSON.stringify(payload).slice(0, 60)}`)
    assert.deepEqual(h.calls, [], 'the store is never asked')
  }
  // Exactly 4000 characters is allowed.
  const edge = harness()
  await edge.handler.handle(frame('add', { target: 'memory', content: 'x'.repeat(4000) }))
  assert.equal(results(edge.posts)[0].ok, true)
})

test('a frame for another agent gets no ack and no result', async () => {
  const other = harness({ own: '701' })
  await other.handler.handle(frame('list', {}, 'r1', '999'))
  await other.handler.handle(frame('add', { target: 'memory', content: 'x' }, 'r2', 999))
  assert.deepEqual(other.posts, [])
  assert.deepEqual(other.calls, [])
  assert.ok(other.logs.some((l) => l.includes('999')), 'the skip is logged')
  // A daemon that does not know its own agent answers nothing, even to a frame that names none.
  const unknown = harness({ own: '' })
  await unknown.handler.handle(frame('list', {}, 'r3', ''))
  await unknown.handler.handle(frame('list', {}, 'r4', 701))
  assert.deepEqual(unknown.posts, [])
  assert.deepEqual(unknown.calls, [])
})

test('a re sent frame never runs twice', async () => {
  let releaseAck: () => void = () => {}
  const ackGate = new Promise<void>((resolve) => {
    releaseAck = resolve
  })
  let first = true
  const h = harness({
    postAck: async () => {
      if (first) {
        first = false
        await ackGate
      }
    },
  })
  const add = frame('add', { target: 'memory', content: 'likes tea' })
  const running = h.handler.handle(add)
  // The backend re emits while the first is still running: ignored.
  await h.handler.handle(add)
  releaseAck()
  await running
  // A re emit after it finished gets the same answer again, and nothing runs again.
  await h.handler.handle(add)
  assert.deepEqual(h.calls, [['add', 'memory', 'likes tea']])
  const answers = results(h.posts)
  assert.equal(answers.length, 2)
  assert.deepEqual(answers[1], answers[0])
  assert.deepEqual(answers[0], { ok: true, payload: { stores: STORES } })
})

test('remembers the last 256 ids', async () => {
  const h = harness()
  for (let i = 1; i <= 257; i += 1) await h.handler.handle(frame('list', {}, `id-${i}`))
  assert.equal(h.calls.length, 257)
  // The newest 256 are remembered: answered again from memory.
  await h.handler.handle(frame('list', {}, 'id-257'))
  await h.handler.handle(frame('list', {}, 'id-2'))
  assert.equal(h.calls.length, 257, 'id-257 and id-2 are answered from what was remembered')
  // The oldest is forgotten, so it runs as new.
  await h.handler.handle(frame('list', {}, 'id-1'))
  assert.equal(h.calls.length, 258)
})

test('before the home folder is on record, nothing is read or written', async () => {
  for (const f of [frame('list'), frame('add', { target: 'memory', content: 'x' }, 'r2')]) {
    const h = harness({ confirmed: false })
    await h.handler.handle(f)
    assert.deepEqual(h.posts.map((p) => p.kind), ['ack', 'result'])
    assert.deepEqual(results(h.posts), [
      { ok: false, error: { code: 'unavailable', message: "this agent's home folder is not confirmed yet" } },
    ])
    assert.deepEqual(h.calls, [])
  }
})

test('a failed ack does not stop the work', async () => {
  const rejects = harness({ postAck: async () => Promise.reject(new Error('502 from the backend')) })
  await rejects.handler.handle(frame('list'))
  assert.deepEqual(results(rejects.posts), [{ ok: true, payload: { stores: STORES } }])
  assert.ok(rejects.logs.some((l) => l.includes('ack failed')))
  const throws = harness({
    postAck: () => {
      throw new Error('socket gone')
    },
  })
  await throws.handler.handle(frame('list'))
  assert.equal(results(throws.posts).length, 1)
})

test('an unexpected throw answers write_failed', async () => {
  const h = harness({
    answer: () => {
      throw new Error('EACCES: permission denied, open /cfg/projects/-a/memory/MEMORY.md')
    },
  })
  await h.handler.handle(frame('add', { target: 'memory', content: 'x' }))
  assert.deepEqual(results(h.posts), [
    { ok: false, error: { code: 'write_failed', message: 'memory operation failed on the agent host' } },
  ])
  // A result that cannot be posted is logged, never thrown at the socket handler.
  const lost = harness({ postResult: async () => Promise.reject(new Error('offline')) })
  await lost.handler.handle(frame('list'))
  assert.ok(lost.logs.some((l) => l.includes('result failed')))
})

test('error messages are short and dash free', async () => {
  const long = `the index moved \u2014 twice \u2013 ${'x'.repeat(900)}`
  const h = harness({ answer: () => ({ ok: false, code: 'store_busy', message: long }) })
  await h.handler.handle(frame('remove', { target: 'memory', oldText: 'likes tea' }))
  const [result] = results(h.posts)
  assert.equal(result.error.code, 'store_busy')
  assert.ok(result.error.message.length <= 300, `${result.error.message.length} characters`)
  assert.doesNotMatch(result.error.message, /[\u2013\u2014]/)
  assert.ok(result.error.message.startsWith('the index moved - twice - '))
  // A code the backend would refuse (over 40 characters, or empty) is never sent as is.
  const odd = harness({ answer: () => ({ ok: false, code: 'c'.repeat(60), message: '' }) })
  await odd.handler.handle(frame('list'))
  const [oddResult] = results(odd.posts)
  assert.ok(oddResult.error.code.length >= 1 && oddResult.error.code.length <= 40)
  assert.ok(oddResult.error.message.length >= 1)
})
