/**
 * The changes_rpc handler (HOAI P7 stage 3, C-31): how a frame from the owner's
 * Changes panel becomes one answer, and only one.
 *
 * The backend (backend/src/changes-panel/changes-rpc.service.ts) emits
 * `{ rpcId, op: 'diff', assistantId, payload }` to the pairing room, re emits it
 * ONCE when no ack lands within 1.5 s, and takes the FIRST result it receives
 * (a result from another pairing is ignored). So the handler acks, always posts
 * one result, never runs a frame twice (it remembers ids with their answers,
 * never forgets them in a finally), and stays silent for a frame that is
 * another agent's: several daemons can share one pairing room, and an error
 * from the wrong one could be the answer that wins.
 *
 * The collector is faked here; test/git-changes.test.ts covers it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

import { ChangesRpcHandler, normalizeChangesRpc, type ChangesRpcFrame } from '../lib/changes-rpc.ts'
import { CHANGES_DEFAULT_CAPS, type ChangesCaps, type ChangesCollectResult, type ChangesPayload } from '../lib/git-changes.ts'

const EM_DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)
const DASHES = new RegExp(`[${EN_DASH}${EM_DASH}]`)

const PAYLOAD: ChangesPayload = {
  v: 1,
  state: 'ok',
  folder: 'billing-export',
  branch: 'fix/export-dupes',
  head: '0123456',
  numstat: '5\t2\tservices/billing/export.py\0',
  numstatTruncated: false,
  patch: 'diff --git a/services/billing/export.py b/services/billing/export.py\n+AWS_SECRET_ACCESS_KEY=abc\n',
  patchTruncated: false,
  untracked: 'notes.md\0',
  untrackedTruncated: false,
  untrackedFiles: [{ path: 'notes.md', bytes: 8, text: '# Notes\n' }],
  takenAt: '2026-09-26T10:00:00.000Z',
}

type Post = { kind: 'ack' | 'result'; rpcId: string; body?: any }
type Collected = { workdir: string; caps: ChangesCaps }

function harness(
  opts: {
    own?: string
    confirmed?: boolean
    workdir?: () => string
    collect?: (input: Collected) => ChangesCollectResult | Promise<ChangesCollectResult>
    postAck?: (rpcId: string) => Promise<unknown>
    postResult?: (rpcId: string, body: any) => Promise<unknown>
  } = {},
) {
  const posts: Post[] = []
  const logs: string[] = []
  const collected: Collected[] = []
  const handler = new ChangesRpcHandler({
    collect: async (input) => {
      collected.push(input)
      return opts.collect ? opts.collect(input) : { ok: true, payload: PAYLOAD }
    },
    workdir: opts.workdir ?? (() => 'E:/agents/billing-export'),
    assistantId: () => opts.own ?? '703',
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
  return { handler, posts, logs, collected }
}

/** The backend's frame (changes-rpc.service.ts), with the numbers of CHANGES_FRAME_PAYLOAD. */
function frame(
  rpcId = 'r1',
  over: { op?: unknown; assistantId?: unknown; payload?: Record<string, unknown> } = {},
): ChangesRpcFrame {
  const f = normalizeChangesRpc({
    rpcId,
    op: 'op' in over ? over.op : 'diff',
    assistantId: 'assistantId' in over ? over.assistantId : '703',
    payload: over.payload ?? {
      scope: 'uncommitted',
      maxPatchBytes: 1_048_576,
      maxNumstatBytes: 262_144,
      maxUntrackedListBytes: 65_536,
      maxUntrackedTextFiles: 20,
      maxUntrackedTextBytes: 65_536,
      budgetMs: 10_000,
    },
  })
  assert.ok(f, 'the frame normalises')
  return f
}

function results(posts: Post[]) {
  return posts.filter((p) => p.kind === 'result').map((p) => p.body)
}

test('acks, then always posts one result', async () => {
  const h = harness()
  await h.handler.handle(frame())
  assert.deepEqual(h.posts, [
    { kind: 'ack', rpcId: 'r1' },
    { kind: 'result', rpcId: 'r1', body: { ok: true, payload: PAYLOAD } },
  ])
  assert.deepEqual(h.collected, [{ workdir: 'E:/agents/billing-export', caps: { ...CHANGES_DEFAULT_CAPS } }])
  // Every state of the collector is an ok result: the backend reads the state.
  for (const state of ['not_git', 'no_commits', 'git_missing'] as const) {
    const s = harness({ collect: () => ({ ok: true, payload: { ...PAYLOAD, state } }) })
    await s.handler.handle(frame(`r-${state}`))
    assert.deepEqual(results(s.posts), [{ ok: true, payload: { ...PAYLOAD, state } }])
  }
})

test('drops a frame with no rpcId; answers an unknown op unsupported and a scope other than uncommitted bad_request', async () => {
  for (const raw of [null, undefined, 'diff', 42, [], { op: 'diff' }, { rpcId: 7, op: 'diff' }, { rpcId: '', op: 'diff' }]) {
    assert.equal(normalizeChangesRpc(raw), null, `${JSON.stringify(raw)} cannot be answered`)
  }
  assert.deepEqual(normalizeChangesRpc({ rpcId: 'r9', op: 'diff', assistantId: 703, payload: [1] }), {
    rpcId: 'r9',
    op: 'diff',
    assistantId: '703',
    payload: {},
  })
  assert.deepEqual(normalizeChangesRpc({ rpcId: 'r9', op: 5 }), { rpcId: 'r9', op: '', assistantId: '', payload: {} })

  const unknown = harness()
  await unknown.handler.handle(frame('r1', { op: 'log' }))
  assert.deepEqual(unknown.posts.map((p) => p.kind), ['ack', 'result'])
  assert.deepEqual(results(unknown.posts), [
    { ok: false, error: { code: 'unsupported', message: 'this changes operation is not supported here' } },
  ])
  assert.deepEqual(unknown.collected, [])

  for (const payload of [{ scope: 'branch' }, { scope: 'last_turn' }, {}, { scope: 'UNCOMMITTED' }]) {
    const h = harness()
    await h.handler.handle(frame('r2', { payload }))
    assert.deepEqual(
      results(h.posts),
      [{ ok: false, error: { code: 'bad_request', message: 'only the uncommitted changes can be read' } }],
      JSON.stringify(payload),
    )
    assert.deepEqual(h.collected, [], 'nothing is read for a scope it does not know')
  }
})

test('gives a frame for another agent nothing, not even an ack, and so does a daemon that does not know its own agent', async () => {
  const other = harness({ own: '703' })
  await other.handler.handle(frame('r1', { assistantId: '999' }))
  await other.handler.handle(frame('r2', { assistantId: 999 }))
  assert.deepEqual(other.posts, [])
  assert.deepEqual(other.collected, [])
  assert.ok(other.logs.some((l) => l.includes('999')), 'the skip is logged')
  // An empty ASSISTANT_ID answers nothing, even to a frame that names none.
  const unknown = harness({ own: '' })
  await unknown.handler.handle(frame('r3', { assistantId: '' }))
  await unknown.handler.handle(frame('r4', { assistantId: 703 }))
  assert.deepEqual(unknown.posts, [])
  assert.deepEqual(unknown.collected, [])
})

test('never runs a re sent frame twice, and answers it again from memory', async () => {
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
  const diff = frame()
  const running = h.handler.handle(diff)
  // The backend re emits while the first is still running: ignored.
  await h.handler.handle(diff)
  releaseAck()
  await running
  // A re emit after it finished gets the same answer again, and Git does not run again.
  await h.handler.handle(diff)
  assert.equal(h.collected.length, 1)
  const answers = results(h.posts)
  assert.equal(answers.length, 2)
  assert.deepEqual(answers[1], answers[0])
  assert.deepEqual(answers[0], { ok: true, payload: PAYLOAD })
})

test('remembers the last 256 ids', async () => {
  const h = harness()
  for (let i = 1; i <= 257; i += 1) await h.handler.handle(frame(`id-${i}`))
  assert.equal(h.collected.length, 257)
  // The newest 256 are remembered: answered again from memory.
  await h.handler.handle(frame('id-257'))
  await h.handler.handle(frame('id-2'))
  assert.equal(h.collected.length, 257, 'id-257 and id-2 are answered from what was remembered')
  // The oldest is forgotten, so it runs as new.
  await h.handler.handle(frame('id-1'))
  assert.equal(h.collected.length, 258)
})

test('a failed ack does not stop the work', async () => {
  const rejects = harness({ postAck: async () => Promise.reject(new Error('502 from the backend')) })
  await rejects.handler.handle(frame())
  assert.deepEqual(results(rejects.posts), [{ ok: true, payload: PAYLOAD }])
  assert.ok(rejects.logs.some((l) => l.includes('ack failed')))
  const throws = harness({
    postAck: () => {
      throw new Error('socket gone')
    },
  })
  await throws.handler.handle(frame())
  assert.equal(results(throws.posts).length, 1)
})

test('a throw answers read_failed, short and dash free', async () => {
  const long = `git exploded ${EM_DASH} twice ${EN_DASH} at E:/Users/kc/secret-project ${'x'.repeat(900)}`
  const h = harness({
    collect: () => {
      throw new Error(long)
    },
  })
  await h.handler.handle(frame())
  assert.deepEqual(results(h.posts), [
    { ok: false, error: { code: 'read_failed', message: 'changes could not be read on the agent host' } },
  ])
  // What the log keeps is short and dash free too.
  for (const line of h.logs) {
    assert.doesNotMatch(line, DASHES)
    assert.ok(line.length <= 400, `${line.length} characters`)
  }
  // A failure the collector answers is passed on, short and dash free, with a code the backend accepts.
  const slow = harness({ collect: () => ({ ok: false, code: 'too_slow', message: long }) })
  await slow.handler.handle(frame())
  const [result] = results(slow.posts)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'too_slow')
  assert.ok(result.error.message.length <= 300, `${result.error.message.length} characters`)
  assert.doesNotMatch(result.error.message, DASHES)
  assert.ok(result.error.message.startsWith('git exploded - twice - '))
  // A result that cannot be posted is logged, never thrown at the socket handler.
  const lost = harness({ postResult: async () => Promise.reject(new Error('offline')) })
  await lost.handler.handle(frame())
  assert.ok(lost.logs.some((l) => l.includes('result failed')))
})

test('past the budget the answer is too_slow', async () => {
  const h = harness({
    collect: () => ({ ok: false, code: 'too_slow', message: 'reading the changes took longer than the time allowed' }),
  })
  await h.handler.handle(frame())
  assert.deepEqual(results(h.posts), [
    { ok: false, error: { code: 'too_slow', message: 'reading the changes took longer than the time allowed' } },
  ])
})

test('before the home folder is on record, nothing is read', async () => {
  for (const f of [frame('r1'), frame('r2', { op: 'log' })]) {
    const h = harness({ confirmed: false })
    await h.handler.handle(f)
    assert.deepEqual(h.posts.map((p) => p.kind), ['ack', 'result'])
    assert.deepEqual(results(h.posts), [
      { ok: false, error: { code: 'unavailable', message: "this agent's home folder is not confirmed yet" } },
    ])
    assert.deepEqual(h.collected, [])
  }
})

test("reads with the frame's caps, never above the defaults, in the launch folder asked for on each frame", async () => {
  let folder = 'E:/agents/one'
  const h = harness({ workdir: () => folder })
  await h.handler.handle(
    frame('r1', { payload: { scope: 'uncommitted', maxPatchBytes: 5000, maxUntrackedTextFiles: 3, budgetMs: 999_999 } }),
  )
  folder = 'E:/agents/two'
  await h.handler.handle(frame('r2'))
  assert.deepEqual(h.collected, [
    { workdir: 'E:/agents/one', caps: { ...CHANGES_DEFAULT_CAPS, maxPatchBytes: 5000, maxUntrackedTextFiles: 3 } },
    { workdir: 'E:/agents/two', caps: { ...CHANGES_DEFAULT_CAPS } },
  ])
})

test('logs sizes and counts, never a path, a folder or a line of a patch', async () => {
  const h = harness()
  await h.handler.handle(frame())
  assert.ok(h.logs.length > 0, 'the answer is logged')
  for (const line of h.logs) {
    for (const secret of ['billing-export', 'fix/export-dupes', 'export.py', 'AWS_SECRET', 'notes.md', 'E:/agents']) {
      assert.ok(!line.includes(secret), `the log names ${secret}: ${line}`)
    }
  }
  assert.ok(h.logs.some((l) => /state=ok/.test(l) && /patch=\d+/.test(l)), h.logs.join('\n'))
})

test("reads the owner's Changes switch nowhere in lib/ or server.ts", () => {
  // The switch lives on the server and nowhere else: the backend sends a frame
  // only while it is on (changes-panel.service.ts). A daemon that read it would
  // have started keeping a copy of the owner's setting.
  const files: Array<[string, string]> = [['server.ts', readFileSync(new URL('../server.ts', import.meta.url), 'utf8')]]
  for (const name of readdirSync(new URL('../lib/', import.meta.url))) {
    if (!/\.(ts|mjs)$/.test(name)) continue
    files.push([`lib/${name}`, readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8')])
  }
  assert.ok(files.length > 60, `the whole tree was scanned (${files.length})`)
  assert.ok(files.some(([n]) => n === 'lib/changes-rpc.ts'), 'the handler itself is scanned')
  const offenders = files.filter(([, src]) => /showChanges|show_changes/i.test(src)).map(([n]) => n)
  assert.deepEqual(offenders, [])
})
