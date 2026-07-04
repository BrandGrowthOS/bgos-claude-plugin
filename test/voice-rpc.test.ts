/**
 * Voice control-plane tests (v0.14.0): mint result mapping, consult
 * deadline discipline, frame normalization pass-through.
 *
 * The G2 lesson from the OpenClaw channel: when a new op/lane joins the
 * wire, EVERY validator must pass it through and every outcome must be
 * explicit (result or descriptive error, never silence) — these tests pin
 * both properties.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  VoiceRpcHandler,
  normalizeVoiceRpc,
  normalizeExpiresAtSeconds,
  buildMintInstructions,
  buildConsultNotification,
  CONSULT_TOOL_NAME,
  OFFER_URL,
  type VoiceRpcDeps,
  type VoiceRpcFrame,
  type VoiceRpcResultBody,
} from '../lib/voice-rpc.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────

function frame(over: Partial<VoiceRpcFrame> = {}): VoiceRpcFrame {
  return {
    rpcId: 'rpc-1',
    op: 'mint',
    assistantId: '901',
    agentRoute: '',
    chatId: '12',
    payload: { recentContext: 'KC: hello' },
    ...over,
  }
}

interface Recorded {
  acks: string[]
  results: Array<{ rpcId: string; body: VoiceRpcResultBody }>
  notifications: Array<{ content: string; meta: Record<string, unknown> }>
}

function makeDeps(over: {
  openaiApiKey?: string
  fetchImpl?: typeof fetch
  timing?: VoiceRpcDeps['timing']
  notifyFails?: boolean
  identity?: { name: string; subtitle: string } | null
}): { deps: VoiceRpcDeps; rec: Recorded } {
  const rec: Recorded = { acks: [], results: [], notifications: [] }
  const deps: VoiceRpcDeps = {
    config: {
      openaiApiKey: over.openaiApiKey ?? 'sk-test',
      model: 'gpt-realtime-2',
      voice: 'marin',
      persona: 'Speak like a calm pilot.',
      assistantId: '901',
    },
    postAck: async (rpcId) => {
      rec.acks.push(rpcId)
    },
    postResult: async (rpcId, body) => {
      rec.results.push({ rpcId, body })
    },
    notify: async (content, meta) => {
      if (over.notifyFails) throw new Error('mcp transport closed')
      rec.notifications.push({ content, meta })
    },
    getIdentity: async () =>
      over.identity === undefined
        ? { name: 'Atlas', subtitle: 'Your ops copilot' }
        : over.identity,
    log: () => {},
    fetchImpl: over.fetchImpl,
    timing: over.timing,
  }
  return { deps, rec }
}

function okMintFetch(body: Record<string, unknown> = {}): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(
      JSON.stringify({ value: 'ek_test_123', expires_at: 1_783_200_000, ...body }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  return { fetchImpl, calls }
}

// ── normalizeVoiceRpc (wire-shape validator pass-through) ────────────────────

test('normalizeVoiceRpc passes through every supported op', () => {
  for (const op of ['mint', 'consult', 'dispatch'] as const) {
    const out = normalizeVoiceRpc({
      rpcId: 'r1',
      op,
      assistantId: 901,
      agentRoute: '',
      chatId: 12,
      payload: { a: 1 },
    })
    assert.ok(out, `${op} must pass the normalizer`)
    assert.equal(out.op, op)
    assert.equal(out.rpcId, 'r1')
    assert.deepEqual(out.payload, { a: 1 })
  }
})

test('normalizeVoiceRpc drops malformed frames', () => {
  assert.equal(normalizeVoiceRpc(null), null)
  assert.equal(normalizeVoiceRpc('x'), null)
  assert.equal(normalizeVoiceRpc({ op: 'mint' }), null) // no rpcId
  assert.equal(normalizeVoiceRpc({ rpcId: 'r1' }), null) // no op
  assert.equal(normalizeVoiceRpc({ rpcId: 'r1', op: 'evil_op' }), null)
})

test('normalizeVoiceRpc defaults missing optionals safely', () => {
  const out = normalizeVoiceRpc({ rpcId: 'r1', op: 'mint' })!
  assert.equal(out.agentRoute, '')
  assert.equal(out.chatId, null)
  assert.deepEqual(out.payload, {})
})

// ── expiresAt normalization ──────────────────────────────────────────────────

test('normalizeExpiresAtSeconds handles seconds, milliseconds, strings, junk', () => {
  assert.equal(normalizeExpiresAtSeconds(1_783_200_000), 1_783_200_000)
  assert.equal(normalizeExpiresAtSeconds(1_783_200_000_000), 1_783_200_000)
  assert.equal(normalizeExpiresAtSeconds('1783200000'), 1_783_200_000)
  assert.equal(normalizeExpiresAtSeconds('nope'), null)
  assert.equal(normalizeExpiresAtSeconds(undefined), null)
})

// ── mint ─────────────────────────────────────────────────────────────────────

test('mint maps the OpenAI client_secrets response to the wire contract', async () => {
  const { fetchImpl, calls } = okMintFetch()
  const { deps, rec } = makeDeps({ fetchImpl })
  const handler = new VoiceRpcHandler(deps)
  await handler.handle(frame())

  assert.deepEqual(rec.acks, ['rpc-1'])
  assert.equal(rec.results.length, 1)
  const { body } = rec.results[0]!
  assert.equal(body.ok, true)
  assert.deepEqual(body.payload, {
    provider: 'openai',
    transport: 'webrtc',
    clientSecret: 'ek_test_123',
    offerUrl: OFFER_URL,
    model: 'gpt-realtime-2',
    voice: 'marin',
    expiresAt: 1_783_200_000, // epoch SECONDS (backend multiplies by 1000)
    contextInjected: true, // context rides the instructions
  })

  // The request must bake exactly the consult tool + our instructions.
  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  assert.equal(sent.session.type, 'realtime')
  assert.equal(sent.session.model, 'gpt-realtime-2')
  assert.equal(sent.session.tools.length, 1)
  assert.equal(sent.session.tools[0].name, CONSULT_TOOL_NAME)
  assert.ok(sent.session.audio.input.transcription, 'transcription required')
  assert.equal(sent.session.audio.input.turn_detection.type, 'server_vad')
  assert.match(sent.session.instructions, /Atlas/)
  assert.match(sent.session.instructions, /calm pilot/)
  assert.match(sent.session.instructions, /KC: hello/)
})

test('mint normalizes a milliseconds expires_at to seconds', async () => {
  const { fetchImpl } = okMintFetch({ expires_at: 1_783_200_000_000 })
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(frame())
  assert.equal(rec.results[0]!.body.payload!.expiresAt, 1_783_200_000)
})

test('mint without an OpenAI key posts a descriptive VOICE_NOT_CONFIGURED error', async () => {
  const { deps, rec } = makeDeps({ openaiApiKey: '' })
  await new VoiceRpcHandler(deps).handle(frame())
  const { body } = rec.results[0]!
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'VOICE_NOT_CONFIGURED')
  assert.match(body.error!.message, /BGOS_OPENAI_API_KEY/)
})

test('mint maps an OpenAI HTTP error to MINT_FAILED with status + body excerpt', async () => {
  const fetchImpl = (async () =>
    new Response('{"error":{"message":"invalid_api_key"}}', {
      status: 401,
    })) as typeof fetch
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(frame())
  const { body } = rec.results[0]!
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'MINT_FAILED')
  assert.match(body.error!.message, /401/)
  assert.match(body.error!.message, /invalid_api_key/)
})

test('mint rejects a response with no secret value', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ expires_at: 123 }), {
      status: 200,
    })) as typeof fetch
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(frame())
  assert.equal(rec.results[0]!.body.ok, false)
  assert.match(rec.results[0]!.body.error!.message, /no secret value/)
})

test('mint aborts a hung OpenAI call at its inner deadline (inner < backend 10s)', async () => {
  const fetchImpl = ((url: any, init?: any) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      )
    })) as unknown as typeof fetch
  const { deps, rec } = makeDeps({
    fetchImpl,
    timing: { mintTimeoutMs: 40 },
  })
  const started = Date.now()
  await new VoiceRpcHandler(deps).handle(frame())
  assert.ok(Date.now() - started < 2_000, 'must fail at the inner cap')
  assert.equal(rec.results[0]!.body.ok, false)
  assert.equal(rec.results[0]!.body.error!.code, 'MINT_FAILED')
  assert.match(rec.results[0]!.body.error!.message, /timed out/)
})

test('a failed ack does not abort the op (best-effort ack)', async () => {
  const { fetchImpl } = okMintFetch()
  const { deps, rec } = makeDeps({ fetchImpl })
  deps.postAck = async () => {
    throw new Error('ack route down')
  }
  await new VoiceRpcHandler(deps).handle(frame())
  assert.equal(rec.results.length, 1)
  assert.equal(rec.results[0]!.body.ok, true)
})

// ── consult ──────────────────────────────────────────────────────────────────

const consultFrame = (over: Partial<VoiceRpcFrame> = {}) =>
  frame({
    op: 'consult',
    rpcId: 'rpc-c1',
    payload: {
      callId: 'call_1',
      name: CONSULT_TOOL_NAME,
      args: {
        question: 'What port does the dev server use?',
        context: 'Debugging session',
        responseStyle: 'one sentence',
      },
    },
    ...over,
  })

test('consult notifies the live session and resolves on voice_consult_reply', async () => {
  const { deps, rec } = makeDeps({ timing: { consultTimeoutMs: 2_000 } })
  const handler = new VoiceRpcHandler(deps)
  const done = handler.handle(consultFrame())

  // Wait for the notification to land, then answer like the agent would.
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(rec.notifications.length, 1)
  const note = rec.notifications[0]!
  assert.match(note.content, /\[voice_consult\]/)
  assert.match(note.content, /consult_id="rpc-c1"/)
  assert.match(note.content, /What port does the dev server use\?/)
  assert.match(note.content, /Call context: Debugging session/)
  assert.match(note.content, /Answer style: one sentence/)
  assert.equal(note.meta.event_type, 'voice_consult')
  assert.equal(note.meta.consult_id, 'rpc-c1')

  const status = handler.resolveConsult('rpc-c1', 'It uses port 8081.')
  assert.equal(status, 'resolved')
  await done
  assert.equal(rec.results.length, 1)
  assert.deepEqual(rec.results[0]!.body, {
    ok: true,
    payload: { text: 'It uses port 8081.' },
  })
  assert.equal(handler.pendingConsultCount, 0)
})

test('consult meta is all-string valued (harness drops cards with non-string meta)', async () => {
  // Regression guard mirroring test/ws-inbound-meta.test.ts (plugin PR #19):
  // the Claude Code harness silently drops notifications/claude/channel
  // cards whose meta carries any non-string value (null, undefined, number,
  // boolean). Every consult meta value must be a string — including when the
  // frame's chatId is null / a number.
  for (const chatId of [null, 12, '12'] as const) {
    const { deps, rec } = makeDeps({ timing: { consultTimeoutMs: 2_000 } })
    const handler = new VoiceRpcHandler(deps)
    const done = handler.handle(consultFrame({ chatId }))
    await new Promise((r) => setTimeout(r, 20))
    const meta = rec.notifications[0]!.meta
    for (const [key, value] of Object.entries(meta)) {
      assert.equal(
        typeof value,
        'string',
        `meta.${key} must be a string (got ${typeof value}) for chatId=${String(chatId)}`,
      )
    }
    handler.resolveConsult('rpc-c1', 'ok')
    await done
  }
})

test('consult times out with a descriptive error; a LATE reply is told to use the chat', async () => {
  const { deps, rec } = makeDeps({ timing: { consultTimeoutMs: 30 } })
  const handler = new VoiceRpcHandler(deps)
  await handler.handle(consultFrame())

  assert.equal(rec.results.length, 1)
  const { body } = rec.results[0]!
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'CONSULT_TIMEOUT')
  assert.match(body.error!.message, /still working/)

  // The agent replies after the deadline → steer it to the chat.
  assert.equal(handler.resolveConsult('rpc-c1', 'late answer'), 'late')
  // A consult id we never saw → unknown.
  assert.equal(handler.resolveConsult('rpc-nope', 'x'), 'unknown')
})

test('consult fails fast when the live session is unreachable', async () => {
  const { deps, rec } = makeDeps({
    notifyFails: true,
    timing: { consultTimeoutMs: 5_000 },
  })
  const started = Date.now()
  await new VoiceRpcHandler(deps).handle(consultFrame())
  assert.ok(Date.now() - started < 2_000, 'must not burn the whole budget')
  assert.equal(rec.results[0]!.body.ok, false)
  assert.equal(rec.results[0]!.body.error!.code, 'CONSULT_DELIVERY_FAILED')
})

test('consult with a missing question posts BAD_CONSULT', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(
    consultFrame({ payload: { callId: 'c1', name: CONSULT_TOOL_NAME, args: {} } }),
  )
  assert.equal(rec.results[0]!.body.ok, false)
  assert.equal(rec.results[0]!.body.error!.code, 'BAD_CONSULT')
})

// ── dedupe + unsupported ops ─────────────────────────────────────────────────

test('duplicate frames for the same rpcId are ignored while in flight', async () => {
  const { deps, rec } = makeDeps({ timing: { consultTimeoutMs: 200 } })
  const handler = new VoiceRpcHandler(deps)
  const first = handler.handle(consultFrame())
  await new Promise((r) => setTimeout(r, 10))
  // Backend 1.5s retry-emit delivers the same frame again.
  const second = handler.handle(consultFrame())
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(rec.notifications.length, 1, 'consult must run exactly once')
  handler.resolveConsult('rpc-c1', 'answer')
  await Promise.all([first, second])
  assert.equal(rec.results.length, 1)
})

test('an op the Claude lane does not serve gets a descriptive error, not silence', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(
    frame({ op: 'dispatch', rpcId: 'rpc-d1', payload: { taskId: 't1' } }),
  )
  assert.equal(rec.results.length, 1)
  assert.equal(rec.results[0]!.body.ok, false)
  assert.equal(rec.results[0]!.body.error!.code, 'UNSUPPORTED_OP')
  assert.match(rec.results[0]!.body.error!.message, /voice_task_dispatch/)
})

// ── instruction/notification builders ────────────────────────────────────────

test('buildMintInstructions works without identity/persona/context', () => {
  const text = buildMintInstructions({
    identity: null,
    persona: '',
    recentContext: '',
  })
  assert.match(text, /the agent/)
  assert.match(text, /agent_dispatch/)
  assert.match(text, new RegExp(CONSULT_TOOL_NAME))
  assert.ok(!text.includes('Recent conversation'))
})

test('buildConsultNotification omits empty context/style blocks', () => {
  const text = buildConsultNotification({
    consultId: 'c1',
    question: 'Q?',
    context: '',
    responseStyle: '',
    budgetSeconds: 30,
  })
  assert.ok(!text.includes('Call context:'))
  assert.ok(!text.includes('Answer style:'))
  assert.match(text, /~30 seconds/)
})
