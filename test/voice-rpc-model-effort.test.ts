/**
 * The picker ops ride BGOS's voice_rpc rail (assistant-sessions.service.ts
 * send(): the same broker the Sessions ops use), so lib/voice-rpc.ts must
 * pass them through, hand them to the picker, post exactly one result in the
 * shape BGOS settles (voice-rpc.service.ts settle(): payload on ok, else
 * error.code), never run one twice, and stay silent for another agent's frame.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VoiceRpcHandler, normalizeVoiceRpc, type VoiceRpcDeps, type VoiceRpcResultBody } from '../lib/voice-rpc.ts'
import { APPLY_MODEL_EFFORT, LIST_MODEL_EFFORT, type PickerAnswer, type PickerFrame } from '../lib/model-effort-rpc.ts'

type Frame = PickerFrame

function rig(answer: (frame: Frame) => Promise<PickerAnswer>, mine = true) {
  const acks: string[] = []
  const results: Array<{ rpcId: string; body: VoiceRpcResultBody }> = []
  const asked: Frame[] = []
  const logs: string[] = []
  const deps: VoiceRpcDeps = {
    config: { openaiApiKey: '', model: 'm', voice: 'v', persona: '', assistantId: '42' },
    postAck: async (rpcId) => { acks.push(rpcId) },
    postResult: async (rpcId, body) => { results.push({ rpcId, body }) },
    notify: async () => {},
    getIdentity: async () => null,
    modelEffort: {
      mine: () => mine,
      answer: async (frame) => {
        asked.push(frame)
        return answer(frame)
      },
    },
    log: (m) => logs.push(m),
  }
  return { handler: new VoiceRpcHandler(deps), acks, results, asked, logs }
}

const frame = (op: string, over: Record<string, unknown> = {}) =>
  normalizeVoiceRpc({ rpcId: 'rpc-1', op, assistantId: '42', agentRoute: '', chatId: '9', payload: {}, ...over })!

test('both picker ops pass the normalizer; nothing else new does', () => {
  for (const op of [LIST_MODEL_EFFORT, APPLY_MODEL_EFFORT]) assert.equal(normalizeVoiceRpc({ rpcId: 'r', op })?.op, op)
  for (const op of ['set_model', 'set_effort', 'describe', 'model_effort_rpc']) assert.equal(normalizeVoiceRpc({ rpcId: 'r', op }), null, op)
})

test('a list is acked, answered by the picker, and its catalog posted as the payload', async () => {
  const catalog = { runtime: 'claude-code', sessionId: 's', current: null, models: [] }
  const r = rig(async () => ({ ok: true, payload: catalog }))
  await r.handler.handle(frame(LIST_MODEL_EFFORT))
  assert.deepEqual(r.acks, ['rpc-1'])
  assert.equal(r.asked.length, 1)
  assert.deepEqual(r.results, [{ rpcId: 'rpc-1', body: { ok: true, payload: catalog } }])
})

test('a refusal is posted with the picker\'s code, which BGOS passes to the app', async () => {
  const r = rig(async () => ({ ok: false, code: 'busy', message: 'The agent is working on a turn. Try again when it is idle.' }))
  await r.handler.handle(frame(APPLY_MODEL_EFFORT, { payload: { sessionId: 's', model: 'opus', effort: 'high' } }))
  assert.deepEqual(r.results, [{ rpcId: 'rpc-1', body: { ok: false, error: { code: 'busy', message: 'The agent is working on a turn. Try again when it is idle.' } } }])
})

test('a picker that throws is answered failed, never left to time out', async () => {
  const r = rig(async () => { throw new Error('boom') })
  await r.handler.handle(frame(APPLY_MODEL_EFFORT))
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0]!.body.ok, false)
  assert.equal(r.results[0]!.body.error?.code, 'failed')
})

test('a re sent apply never types twice: the same rpcId runs once, even after it answered', async () => {
  let release: () => void = () => {}
  let calls = 0
  // Only the first answer is held: a second run, if one ever happened, answers at once.
  const r = rig(() => calls++ === 0 ? new Promise<PickerAnswer>((resolve) => { release = () => resolve({ ok: true, payload: {} }) }) : Promise.resolve({ ok: true, payload: {} }))
  const first = r.handler.handle(frame(APPLY_MODEL_EFFORT))
  await r.handler.handle(frame(APPLY_MODEL_EFFORT))
  release()
  await first
  await r.handler.handle(frame(APPLY_MODEL_EFFORT))
  assert.equal(r.asked.length, 1)
  assert.equal(r.results.length, 1)
})

test('another agent\'s frame gets no ack and no result: the right daemon answers it', async () => {
  const r = rig(async () => ({ ok: true, payload: {} }), false)
  await r.handler.handle(frame(APPLY_MODEL_EFFORT, { assistantId: '43' }))
  assert.deepEqual(r.acks, [])
  assert.deepEqual(r.results, [])
  assert.equal(r.asked.length, 0)
})

test('with no picker wired the ops are refused not_allowed, never run', async () => {
  const results: Array<{ rpcId: string; body: VoiceRpcResultBody }> = []
  const handler = new VoiceRpcHandler({
    config: { openaiApiKey: '', model: 'm', voice: 'v', persona: '', assistantId: '42' },
    postAck: async () => {},
    postResult: async (rpcId, body) => { results.push({ rpcId, body }) },
    notify: async () => {},
    getIdentity: async () => null,
    log: () => {},
  })
  await handler.handle(frame(APPLY_MODEL_EFFORT))
  assert.equal(results[0]!.body.error?.code, 'not_allowed')
})

test('the handler logs a picker rpcId as its short hash, never raw', async () => {
  const rpcId = 'rpc-7\n[2026-10-26T00:00:00Z] forged'
  const r = rig(async () => ({ ok: true, payload: {} }))
  const deps = r.handler as unknown as { deps: VoiceRpcDeps }
  deps.deps.postResult = async () => { throw new Error('backend down') }
  deps.deps.postAck = async () => { throw new Error('backend down') }
  await r.handler.handle(frame(APPLY_MODEL_EFFORT, { rpcId }))
  await r.handler.handle(frame(APPLY_MODEL_EFFORT, { rpcId }))
  assert.ok(r.logs.length >= 3, JSON.stringify(r.logs))
  for (const line of r.logs) {
    assert.ok(!line.includes('rpc-7'), `raw rpcId in the log: ${JSON.stringify(line)}`)
    assert.ok(!line.includes('\n'), `a forged line: ${JSON.stringify(line)}`)
  }
})

// Round 3 review M1: a picker answer races BGOS's 20 s timer from its emit, so
// it never waits for the ack POST, and its deadline counts from arrival.
test('a picker result is not held behind a slow ack, and the frame carries its arrival time', async () => {
  const r = rig(async () => ({ ok: true, payload: { done: true } }))
  const d = (r.handler as unknown as { deps: VoiceRpcDeps }).deps
  d.postAck = () => new Promise(() => {})
  const before = Date.now()
  const done = await Promise.race([r.handler.handle(frame(APPLY_MODEL_EFFORT)).then(() => 'done'), new Promise((res) => setTimeout(() => res('held'), 500))])
  assert.equal(done, 'done', 'the result waited for the ack')
  assert.deepEqual(r.results, [{ rpcId: 'rpc-1', body: { ok: true, payload: { done: true } } }])
  const at = r.asked[0]!.receivedAtMs!
  assert.ok(typeof at === 'number' && at >= before && at <= Date.now())
})
