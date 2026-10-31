/**
 * The three Threads phase 1 ops on the voice_rpc rail (plan "Wire contract",
 * Daemon ops): thread_turn answers {accepted, state} at once, thread_close
 * answers {stopped:true}, aside streams ordered progress frames and answers
 * {text}. Local op guards in lib/thread-rpc.ts; the shared Sessions contract
 * file is untouched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VoiceRpcHandler, normalizeVoiceRpc, type VoiceRpcDeps, type VoiceRpcResultBody } from '../lib/voice-rpc.ts'
import { ASIDE, THREAD_CLOSE, THREAD_TURN, isThreadOp, type ThreadRpcDeps } from '../lib/thread-rpc.ts'
import { AsideError } from '../lib/aside-fork.ts'
import type { ThreadTurnInput } from '../lib/thread-lanes.ts'

function rig(threads: Partial<ThreadRpcDeps> | null = {}) {
  const timeline: string[] = []
  const results: Array<{ rpcId: string; body: VoiceRpcResultBody }> = []
  const progress: Array<{ seq: number; delta: string }> = []
  const turns: ThreadTurnInput[] = []
  const closes: Array<{ rootId: string; removeWorktree: boolean }> = []
  const asides: unknown[] = []
  const deps: VoiceRpcDeps = {
    config: { openaiApiKey: '', model: 'm', voice: 'v', persona: '', assistantId: '42' },
    postAck: async (rpcId) => { timeline.push(`ack ${rpcId}`) },
    postResult: async (rpcId, body) => { timeline.push(`result ${rpcId}`); results.push({ rpcId, body }) },
    postProgress: async (_rpcId, body) => {
      // A slower first progress post must still land before the second.
      if (body.seq === 0) await new Promise((r) => setTimeout(r, 5))
      timeline.push(`progress ${body.seq}`)
      progress.push(body)
    },
    notify: async () => {},
    getIdentity: async () => null,
    threads: threads === null ? undefined : {
      turn: (input) => { turns.push(input); return { accepted: true, state: 'waiting' } },
      close: async (input) => { closes.push(input); return { stopped: true } },
      aside: async (input, onDelta) => { asides.push(input); onDelta(0, 'PELIC'); onDelta(1, 'AN-42'); return { text: 'PELICAN-42' } },
      ...threads,
    },
    log: () => {},
  }
  return { handler: new VoiceRpcHandler(deps), timeline, results, progress, turns, closes, asides }
}

const frame = (op: string, payload: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  normalizeVoiceRpc({ rpcId: 'rpc-1', op, assistantId: '42', agentRoute: '', chatId: '55', payload, ...over })!

const turnPayload = { chatId: '55', rootId: '101', replyId: '1010', mode: 'start', text: 'look', title: 'T', rootText: 'root' }

test('the three thread ops pass the normalizer and are guarded locally', () => {
  for (const op of [THREAD_TURN, THREAD_CLOSE, ASIDE]) {
    assert.equal(normalizeVoiceRpc({ rpcId: 'r', op })?.op, op)
    assert.equal(isThreadOp(op), true)
  }
  for (const op of ['thread', 'threads', 'btw', 'side']) assert.equal(normalizeVoiceRpc({ rpcId: 'r', op }), null, op)
})

test('thread_turn is acked, handed to the lanes, and answered with accepted and the state at once', async () => {
  const r = rig()
  await r.handler.handle(frame(THREAD_TURN, turnPayload))
  assert.deepEqual(r.turns, [{ chatId: '55', rootId: '101', replyId: '1010', mode: 'start', text: 'look', title: 'T', rootText: 'root' }])
  assert.deepEqual(r.timeline, ['ack rpc-1', 'result rpc-1'])
  assert.deepEqual(r.results[0]!.body, { ok: true, payload: { accepted: true, state: 'waiting' } })
})

test('thread_turn takes the chat from the frame when the payload has none', async () => {
  const r = rig()
  const { chatId: _omit, ...rest } = turnPayload
  await r.handler.handle(frame(THREAD_TURN, rest))
  assert.equal(r.turns[0]!.chatId, '55')
})

test('a thread_turn without a root is refused bad_request and never reaches the lanes', async () => {
  const r = rig()
  await r.handler.handle(frame(THREAD_TURN, { ...turnPayload, rootId: '' }))
  assert.equal(r.turns.length, 0)
  assert.equal(r.results[0]!.body.ok, false)
  assert.equal(r.results[0]!.body.error?.code, 'bad_request')
})

test('thread_close stops the lane and answers stopped; only a literal true removes the worktree', async () => {
  const r = rig()
  await r.handler.handle(frame(THREAD_CLOSE, { chatId: '55', rootId: '101', removeWorktree: true }))
  await r.handler.handle(frame(THREAD_CLOSE, { chatId: '55', rootId: '102', removeWorktree: 'true' }, { rpcId: 'rpc-2' }))
  assert.deepEqual(r.closes, [{ rootId: '101', removeWorktree: true }, { rootId: '102', removeWorktree: false }])
  assert.deepEqual(r.results.map((x) => x.body), [{ ok: true, payload: { stopped: true } }, { ok: true, payload: { stopped: true } }])
})

test('aside: ack, then the deltas as ordered progress frames, then the text as the result', async () => {
  const r = rig()
  await r.handler.handle(frame(ASIDE, {
    chatId: '55', asideId: 'a1', questionId: 'q1', question: 'code word?', quote: 'PELICAN', history: [{ q: 'hi', a: 'hello' }, { q: 3 }, 'junk'],
  }))
  assert.deepEqual(r.timeline, ['ack rpc-1', 'progress 0', 'progress 1', 'result rpc-1'])
  assert.deepEqual(r.progress, [{ seq: 0, delta: 'PELIC' }, { seq: 1, delta: 'AN-42' }])
  assert.deepEqual(r.results[0]!.body, { ok: true, payload: { text: 'PELICAN-42' } })
  assert.deepEqual(r.asides, [{ question: 'code word?', quote: 'PELICAN', history: [{ q: 'hi', a: 'hello' }] }])
})

test('an aside without a question is refused bad_request', async () => {
  const r = rig()
  await r.handler.handle(frame(ASIDE, { question: '  ' }))
  assert.equal(r.asides.length, 0)
  assert.equal(r.results[0]!.body.error?.code, 'bad_request')
})

test('an aside refusal keeps its code (no_session) so BGOS can tell the person', async () => {
  const r = rig({ aside: async () => { throw new AsideError('no_session', 'This agent has no running session to answer from yet.') } })
  await r.handler.handle(frame(ASIDE, { question: 'q' }))
  assert.deepEqual(r.results[0]!.body, { ok: false, error: { code: 'no_session', message: 'This agent has no running session to answer from yet.' } })
})

test('anything else that throws in a thread op is answered failed, never left to time out', async () => {
  const r = rig({ turn: () => { throw new Error('boom') } })
  await r.handler.handle(frame(THREAD_TURN, turnPayload))
  assert.equal(r.results[0]!.body.error?.code, 'failed')
})

test('a daemon without thread lanes answers unsupported', async () => {
  const r = rig(null)
  await r.handler.handle(frame(THREAD_TURN, turnPayload))
  assert.equal(r.results[0]!.body.error?.code, 'unsupported')
})

test('another agent\'s thread frame gets no ack and no result', async () => {
  const r = rig()
  await r.handler.handle(frame(THREAD_TURN, turnPayload, { assistantId: '43' }))
  assert.deepEqual(r.timeline, [])
  assert.equal(r.turns.length, 0)
})

test('a re sent thread_turn runs once, even after it answered (the 1.5 s re emit)', async () => {
  const r = rig()
  await r.handler.handle(frame(THREAD_TURN, turnPayload))
  await r.handler.handle(frame(THREAD_TURN, turnPayload))
  assert.equal(r.turns.length, 1)
  assert.equal(r.results.length, 1)
})
