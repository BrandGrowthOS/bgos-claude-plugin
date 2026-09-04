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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  VoiceRpcHandler,
  normalizeVoiceRpc,
  normalizeVoiceTaskDispatch,
  normalizeExpiresAtSeconds,
  normalizeVoiceConfig,
  buildMintInstructions,
  AGGREGATE_INSTRUCTIONS_BUDGET,
  VOICE_MEMORY_MAX,
  loadVoiceMemory,
  buildConsultNotification,
  buildVoiceTaskDispatchText,
  buildStopTurnNotification,
  CONSULT_TOOL_NAME,
  OFFER_URL,
  STOP_TURN_CONFIRMATION,
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
    // openaiApiKey is the CALLER's own per-user key, ridden onto the frame by
    // the Home of Agents backend. Default mint frames carry one so the mint
    // proceeds; keyless-refusal tests override payload to drop it.
    payload: { recentContext: 'KC: hello', openaiApiKey: 'sk-caller-own-key' },
    ...over,
  }
}

interface Recorded {
  acks: string[]
  results: Array<{ rpcId: string; body: VoiceRpcResultBody }>
  notifications: Array<{ content: string; meta: Record<string, unknown> }>
  sends: Array<{ chatId: string; text: string }>
}

function makeDeps(over: {
  openaiApiKey?: string
  fetchImpl?: typeof fetch
  timing?: VoiceRpcDeps['timing']
  notifyFails?: boolean
  sendFails?: boolean
  identity?: { name: string; subtitle: string } | null
  config?: Partial<VoiceRpcDeps['config']>
}): { deps: VoiceRpcDeps; rec: Recorded } {
  const rec: Recorded = { acks: [], results: [], notifications: [], sends: [] }
  const deps: VoiceRpcDeps = {
    config: {
      openaiApiKey: over.openaiApiKey ?? 'sk-test',
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      persona: 'Speak like a calm pilot.',
      assistantId: '901',
      ...over.config,
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
    sendChatMessage: async (chatId, text) => {
      if (over.sendFails) throw new Error('send-message route down')
      rec.sends.push({ chatId, text })
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
  for (const op of ['mint', 'consult', 'dispatch', 'stop_turn'] as const) {
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
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    expiresAt: 1_783_200_000, // epoch SECONDS (backend multiplies by 1000)
    contextInjected: true, // context rides the instructions
  })

  // The request must bake exactly the consult tool + our instructions.
  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  assert.equal(sent.session.type, 'realtime')
  assert.equal(sent.session.model, 'gpt-realtime-2.1')
  assert.equal(sent.session.tools.length, 1)
  assert.equal(sent.session.tools[0].name, CONSULT_TOOL_NAME)
  assert.ok(sent.session.audio.input.transcription, 'transcription required')
  assert.equal(sent.session.audio.input.turn_detection.type, 'server_vad')
  assert.match(sent.session.instructions, /Atlas/)
  assert.match(sent.session.instructions, /calm pilot/)
  assert.match(sent.session.instructions, /KC: hello/)
})

test('mint no longer requests a transcription model OpenAI has deprecated', async () => {
  const { fetchImpl, calls } = okMintFetch()
  const { deps } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(frame())

  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  assert.equal(sent.session.audio.input.transcription.model, 'gpt-live-transcribe')
})

test('normalizeVoiceConfig sanitizes the wire (junk voice dropped, speed clamped, instructions capped)', () => {
  assert.deepEqual(normalizeVoiceConfig(undefined), {})
  assert.deepEqual(normalizeVoiceConfig('cedar'), {})
  assert.deepEqual(normalizeVoiceConfig([]), {})
  assert.deepEqual(normalizeVoiceConfig({}), {})
  assert.deepEqual(
    normalizeVoiceConfig({ voice: ' Cedar ', speed: 1.2, instructions: ' hi ' }),
    { voice: 'cedar', speed: 1.2, instructions: 'hi' },
  )
  assert.deepEqual(normalizeVoiceConfig({ voice: 'x; DROP', speed: 99 }), {
    speed: 1.5,
  })
  assert.deepEqual(normalizeVoiceConfig({ speed: '0.01' }), { speed: 0.25 })
  const long = normalizeVoiceConfig({ instructions: 'x'.repeat(5000) })
  assert.equal(long.instructions!.length, 2000)
})

test('mint applies payload.voiceConfig — voice/speed/persona override env, echoed back', async () => {
  const { fetchImpl, calls } = okMintFetch()
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(
    frame({
      payload: {
        recentContext: 'KC: hello',
        openaiApiKey: 'sk-caller-own-key',
        voiceConfig: {
          voice: 'cedar',
          speed: 1.25,
          instructions: 'Dry humor, two sentences max.',
        },
      },
    }),
  )

  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  // Applied to the OpenAI session…
  assert.equal(sent.session.audio.output.voice, 'cedar')
  assert.equal(sent.session.audio.output.speed, 1.25)
  // App persona REPLACES the env persona (env is the fallback only).
  assert.match(sent.session.instructions, /Dry humor/)
  assert.doesNotMatch(sent.session.instructions, /calm pilot/)
  // …and echoed in the result so the in-call gear shows the real voice.
  const payload = rec.results[0]!.body.payload!
  assert.equal(payload.voice, 'cedar')
  assert.equal(payload.speed, 1.25)
})

test('mint without voiceConfig keeps the exact pre-feature request shape (env fallback)', async () => {
  const { fetchImpl, calls } = okMintFetch()
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(frame())

  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  assert.deepEqual(sent.session.audio.output, { voice: 'marin' })
  assert.match(sent.session.instructions, /calm pilot/)
  const payload = rec.results[0]!.body.payload!
  assert.equal(payload.voice, 'marin')
  assert.equal('speed' in payload, false)
})

test('normalizeVoiceConfig keeps an allowlisted model', () => {
  assert.equal(
    normalizeVoiceConfig({ model: 'gpt-realtime-2.1' }).model,
    'gpt-realtime-2.1',
  )
  assert.equal(
    normalizeVoiceConfig({ model: 'gpt-realtime-2.1-mini' }).model,
    'gpt-realtime-2.1-mini',
  )
  assert.equal(
    normalizeVoiceConfig({ model: '  GPT-Realtime-2.1  ' }).model,
    'gpt-realtime-2.1',
  )
})

test('normalizeVoiceConfig drops a model outside the allowlist', () => {
  // The app stores the owner's pick permissively so a newer model id survives
  // a save; the closed allowlist is enforced here, at the only place that
  // spends money.
  assert.ok(!('model' in normalizeVoiceConfig({ model: 'gpt-realtime-4' })))
  assert.ok(!('model' in normalizeVoiceConfig({ model: 'gpt-4o' })))
  assert.ok(!('model' in normalizeVoiceConfig({ model: 7 })))
  assert.ok(!('model' in normalizeVoiceConfig({ voice: 'marin' })))
})

test('mint applies an allowlisted voiceConfig.model over the host default', async () => {
  const { fetchImpl, calls } = okMintFetch()
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(
    frame({
      payload: {
        recentContext: '',
        openaiApiKey: 'sk-caller-own-key',
        voiceConfig: { model: 'gpt-realtime-2.1-mini' },
      },
    }),
  )
  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  assert.equal(sent.session.model, 'gpt-realtime-2.1-mini')
  // Echoed so the app knows which model actually ran the call.
  assert.equal(rec.results[0]!.body.payload!.model, 'gpt-realtime-2.1-mini')
})

test('mint keeps the host default when the pinned model is unknown here', async () => {
  const { fetchImpl, calls } = okMintFetch()
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(
    frame({
      payload: {
        recentContext: '',
        openaiApiKey: 'sk-caller-own-key',
        voiceConfig: { model: 'gpt-realtime-9-unreleased' },
      },
    }),
  )
  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  assert.equal(sent.session.model, 'gpt-realtime-2.1')
  assert.equal(rec.results[0]!.body.ok, true)
})

test('mint with junk voiceConfig degrades to env config, never fails the call', async () => {
  const { fetchImpl, calls } = okMintFetch()
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(
    frame({
      payload: {
        recentContext: '',
        openaiApiKey: 'sk-caller-own-key',
        voiceConfig: { voice: '!!', speed: 'NaNish' },
      },
    }),
  )
  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  assert.deepEqual(sent.session.audio.output, { voice: 'marin' })
  assert.equal(rec.results[0]!.body.ok, true)
})

test('mint normalizes a milliseconds expires_at to seconds', async () => {
  const { fetchImpl } = okMintFetch({ expires_at: 1_783_200_000_000 })
  const { deps, rec } = makeDeps({ fetchImpl })
  await new VoiceRpcHandler(deps).handle(frame())
  assert.equal(rec.results[0]!.body.payload!.expiresAt, 1_783_200_000)
})

test("mint spends the CALLER's OpenAI key from the frame, never the host env owner key", async () => {
  const { fetchImpl, calls } = okMintFetch()
  // The host env carries an owner key; the caller rides THEIR own key on the
  // frame. The mint must spend the caller's key, so no user drains the owner.
  const { deps, rec } = makeDeps({ openaiApiKey: 'sk-host-owner-key', fetchImpl })
  await new VoiceRpcHandler(deps).handle(
    frame({
      payload: { recentContext: 'KC: hello', openaiApiKey: 'sk-caller-own-key' },
    }),
  )
  const auth = String(
    (calls[0]!.init.headers as Record<string, string>).Authorization,
  )
  assert.equal(auth, 'Bearer sk-caller-own-key')
  assert.doesNotMatch(auth, /sk-host-owner-key/)
  assert.equal(rec.results[0]!.body.ok, true)
})

test('mint refuses a keyless frame even when a host env key is set (no owner-key fallback)', async () => {
  // The host env key must NEVER back-fill a caller who sent no key: this is
  // the no-owner-key guarantee (the backend already blocks keyless callers
  // upstream, so this daemon guard is defense in depth). A whitespace-only
  // frame key counts as unset (trimmed) and is refused too.
  for (const payloadKey of [undefined, '   ']) {
    const { deps, rec } = makeDeps({ openaiApiKey: 'sk-host-owner-key' })
    const payload: Record<string, unknown> = { recentContext: 'KC: hello' }
    if (payloadKey !== undefined) payload.openaiApiKey = payloadKey
    await new VoiceRpcHandler(deps).handle(frame({ payload }))
    const { body } = rec.results[0]!
    assert.equal(body.ok, false)
    assert.equal(body.error!.code, 'VOICE_NOT_CONFIGURED')
    assert.match(body.error!.message, /Home of Agents/)
  }
})

test('mint maps an OpenAI HTTP error to MINT_FAILED with status + body excerpt', async () => {
  const fetchImpl = (async () =>
    new Response('{"error":{"message":"invalid_api_key"}}', {
      status: 401,
    })) as unknown as typeof fetch
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
    })) as unknown as typeof fetch
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

// ── stop_turn (session controls, cooperative) ────────────────────────────────

const stopFrame = (over: Partial<VoiceRpcFrame> = {}) =>
  frame({
    op: 'stop_turn',
    rpcId: 'rpc-s1',
    chatId: '42',
    payload: { requestedBy: 'user' },
    ...over,
  })

test('stop_turn notifies the live session, confirms in-chat, and results cooperative', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(stopFrame())

  assert.deepEqual(rec.acks, ['rpc-s1'])
  // The channel notification tells the agent to stand down on THAT chat.
  assert.equal(rec.notifications.length, 1)
  const note = rec.notifications[0]!
  assert.match(note.content, /\[stop_turn\]/)
  assert.match(note.content, /chat 42/)
  assert.match(note.content, /do not start any new tool calls/)
  assert.match(note.content, /Keep any partial results/)
  assert.equal(note.meta.event_type, 'stop_turn')
  assert.equal(note.meta.chat_id, '42')
  // The plain confirmation rides the normal outbound send path.
  assert.deepEqual(rec.sends, [{ chatId: '42', text: STOP_TURN_CONFIRMATION }])
  // Wire contract: {stopped:true} on success, cooperative mode declared.
  assert.deepEqual(rec.results, [
    {
      rpcId: 'rpc-s1',
      body: { ok: true, payload: { stopped: true, mode: 'cooperative' } },
    },
  ])
})

test('stop_turn accepts a numeric chatId (backend sends the string form; be liberal)', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(stopFrame({ chatId: 42 }))
  assert.equal(rec.notifications[0]!.meta.chat_id, '42')
  assert.deepEqual(rec.results[0]!.body.payload, {
    stopped: true,
    mode: 'cooperative',
  })
})

test('stop_turn meta is all-string valued (harness drops cards with non-string meta)', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(stopFrame({ chatId: 42 }))
  for (const [key, value] of Object.entries(rec.notifications[0]!.meta)) {
    assert.equal(typeof value, 'string', `meta.${key} must be a string`)
  }
})

test('stop_turn without a chatId cannot be scoped: honest {stopped:false, supported:false}', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(stopFrame({ chatId: null }))
  assert.equal(rec.notifications.length, 0, 'nothing to notify without a scope')
  assert.equal(rec.sends.length, 0)
  assert.deepEqual(rec.results[0]!.body, {
    ok: true,
    payload: { stopped: false, supported: false },
  })
})

test('stop_turn reports unsupported when the live session is unreachable', async () => {
  const { deps, rec } = makeDeps({ notifyFails: true })
  await new VoiceRpcHandler(deps).handle(stopFrame())
  assert.equal(rec.sends.length, 0, 'no confirmation when the stop never landed')
  assert.deepEqual(rec.results[0]!.body, {
    ok: true,
    payload: { stopped: false, supported: false },
  })
})

test('a failed confirmation send does not flip a delivered stop', async () => {
  const { deps, rec } = makeDeps({ sendFails: true })
  await new VoiceRpcHandler(deps).handle(stopFrame())
  assert.equal(rec.notifications.length, 1, 'the stop itself was delivered')
  assert.deepEqual(rec.results[0]!.body.payload, {
    stopped: true,
    mode: 'cooperative',
  })
})

test('stop_turn works without a sendChatMessage dep (confirmation is optional)', async () => {
  const { deps, rec } = makeDeps({})
  delete deps.sendChatMessage
  await new VoiceRpcHandler(deps).handle(stopFrame())
  assert.deepEqual(rec.results[0]!.body.payload, {
    stopped: true,
    mode: 'cooperative',
  })
})

test('buildStopTurnNotification names the chat and the stand-down rules', () => {
  const text = buildStopTurnNotification({ chatId: '7' })
  assert.match(text, /^\[stop_turn\]/)
  assert.match(text, /chat 7/)
  assert.match(text, /ONE short reply line/)
  assert.match(text, /other chats is unaffected/)
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

test('a paired dispatch is ACCEPTED and the task card reaches the live session', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(
    frame({ op: 'dispatch', rpcId: 'rpc-d1', chatId: '4465', payload: { taskId: 't1', question: 'book the table', context: 'for 8pm' } }),
  )
  assert.equal(rec.results.length, 1)
  assert.equal(rec.results[0]!.body.ok, true)
  assert.deepEqual(rec.results[0]!.body.payload, { accepted: true, taskId: 't1' })
  assert.equal(rec.notifications.length, 1)
  assert.match(rec.notifications[0]!.content, /\[voice_dispatch\] .*task #t1/)
  assert.match(rec.notifications[0]!.content, /complete_voice_task tool with task_id="t1"/)
  assert.equal(rec.notifications[0]!.meta.event_type, 'voice_task_dispatch')
  assert.equal(rec.notifications[0]!.meta.task_id, 't1')
  for (const v of Object.values(rec.notifications[0]!.meta)) assert.equal(typeof v, 'string')
})

test('every voice card carries the canonical envelope, all strings', async () => {
  const { deps, rec } = makeDeps({ config: { chatIdFallback: '4465', userId: 'user_x' } })
  const h = new VoiceRpcHandler(deps)
  const consult = h.handle(frame({ op: 'consult', rpcId: 'rpc-e1', chatId: null, payload: { callId: 'c', name: 'claude_agent_consult', args: {} } }))
  await new Promise((r) => setTimeout(r, 10))
  h.resolveConsult('rpc-e1', 'ok')
  await consult
  await h.handle(frame({ op: 'dispatch', rpcId: 'rpc-e2', chatId: null, payload: { taskId: 't' } }))
  for (const n of rec.notifications) {
    for (const k of ['event_type', 'chat_id', 'assistant_id', 'user_id', 'transport', 'ts']) {
      assert.equal(typeof n.meta[k], 'string', `${n.meta.event_type} missing ${k}`)
      assert.notEqual(n.meta[k], '', `${n.meta.event_type} has empty ${k}`)
    }
  }
  // chatId null on the frame, so the fallback must have filled it.
  assert.equal(rec.notifications[0]!.meta.chat_id, '4465')
})

// ── dispatch() must apply the same requireConfirmed gate as the WS lane ─────

test('dispatch() rejects an unconfirmed task when requireConfirmedDispatch is on', async () => {
  const { deps, rec } = makeDeps({ config: { requireConfirmedDispatch: true } })
  await new VoiceRpcHandler(deps).handle(
    frame({ op: 'dispatch', rpcId: 'rpc-g1', chatId: '4465', payload: { taskId: 't1', question: 'book the table' } }),
  )
  assert.equal(rec.results.length, 1)
  const { body } = rec.results[0]!
  assert.equal(body.ok, false)
  assert.equal(body.error?.code, 'BAD_DISPATCH')
  assert.match(body.error?.message ?? '', /unconfirmed/)
  assert.equal(rec.notifications.length, 0, 'an unconfirmed dispatch must never reach the live session')
})

test('dispatch() accepts a confirmed task when requireConfirmedDispatch is on', async () => {
  const { deps, rec } = makeDeps({ config: { requireConfirmedDispatch: true } })
  await new VoiceRpcHandler(deps).handle(
    frame({ op: 'dispatch', rpcId: 'rpc-g2', chatId: '4465', payload: { taskId: 't1', question: 'book the table', confirmed: true } }),
  )
  assert.equal(rec.results.length, 1)
  assert.equal(rec.results[0]!.body.ok, true)
  assert.equal(rec.notifications.length, 1)
})

test('dispatch() accepts an unconfirmed task when requireConfirmedDispatch is off (default)', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(
    frame({ op: 'dispatch', rpcId: 'rpc-g3', chatId: '4465', payload: { taskId: 't1', question: 'book the table' } }),
  )
  assert.equal(rec.results.length, 1)
  assert.equal(rec.results[0]!.body.ok, true)
  assert.equal(rec.notifications.length, 1)
})

// ── server.ts config wiring: chatIdFallback must stay lazy ─────────────────

test('server.ts VoiceRpcHandler config declares chatIdFallback as a getter, not a snapshot', () => {
  // A plain `chatIdFallback: monitoredChatIds[0] ?? null` field would freeze
  // on the empty startup array (monitoredChatIds is populated after this
  // config object is built at module load). This source-scan makes a revert
  // to a plain field fail a test instead of silently shipping an
  // always-empty chat_id fallback.
  const here = dirname(fileURLToPath(import.meta.url))
  const serverSrc = readFileSync(join(here, '..', 'server.ts'), 'utf8')
  assert.match(serverSrc, /get\s+chatIdFallback\s*\(/, 'chatIdFallback must stay a getter on the voiceRpc config literal')
})

test('a dispatch with no taskId is refused loudly, never silently', async () => {
  const { deps, rec } = makeDeps({})
  await new VoiceRpcHandler(deps).handle(frame({ op: 'dispatch', rpcId: 'rpc-d2', payload: {} }))
  assert.equal(rec.results[0]!.body.ok, false)
  assert.equal(rec.results[0]!.body.error!.code, 'BAD_DISPATCH')
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

// ── quick-wins prompt pack (Iris 514) ────────────────────────────────────────

test('mint instructions carry the truthfulness contract', () => {
  const text = buildMintInstructions({
    identity: null,
    persona: '',
    recentContext: '',
  })
  assert.ok(text.includes('Truthfulness contract: NEVER invent'))
  assert.ok(text.includes('still in progress'))
})

test('mint instructions carry the intent-only brief rule', () => {
  const text = buildMintInstructions({
    identity: null,
    persona: '',
    recentContext: '',
  })
  assert.ok(text.includes('intent and desired outcome'))
  assert.ok(text.includes('stale mechanics mislead it'))
})

test('consult notification carries the continuation brief', () => {
  const text = buildConsultNotification({
    consultId: 'c1',
    question: 'q',
    context: '',
    responseStyle: '',
    budgetSeconds: 30,
  })
  assert.ok(text.includes('Reuse those results'))
  assert.ok(text.includes('re-check only what changed'))
})

test('voice task dispatch text keeps the contract and adds the continuation brief', () => {
  const text = buildVoiceTaskDispatchText({
    taskId: 't1',
    question: 'q',
    context: 'ctx',
  })
  assert.ok(text.includes('[voice_dispatch]'))
  assert.ok(text.includes('task #t1'))
  assert.ok(text.includes('complete_voice_task'))
  assert.ok(text.includes('Extra context: ctx'))
  assert.ok(text.includes('Reuse those results'))
  assert.ok(text.includes('re-check only what changed'))
})

test('voice task dispatch text omits the context block when empty', () => {
  const text = buildVoiceTaskDispatchText({ taskId: 't2', question: 'q', context: '' })
  assert.ok(!text.includes('Extra context:'))
})

// ── confirm-before-dispatch gate (Iris G5, wave 1) ───────────────────────────

test('normalizeVoiceConfig picks up requireDispatchConfirm (boolean and string)', () => {
  assert.equal(
    normalizeVoiceConfig({ requireDispatchConfirm: true }).requireDispatchConfirm,
    true,
  )
  assert.equal(
    normalizeVoiceConfig({ requireDispatchConfirm: 'true' })
      .requireDispatchConfirm,
    true,
  )
  assert.ok(!('requireDispatchConfirm' in normalizeVoiceConfig({ voice: 'marin' })))
  assert.ok(!('requireDispatchConfirm' in normalizeVoiceConfig({ requireDispatchConfirm: false })))
})

test('mint instructions carry the propose-first contract only when the gate is on', () => {
  const on = buildMintInstructions({
    identity: null,
    persona: '',
    recentContext: '',
    requireDispatchConfirm: true,
  })
  assert.ok(on.includes('Dispatch confirmation is ON'))
  assert.ok(on.includes('STAGES a proposal'))
  assert.ok(on.includes('confirm_dispatch'))
  const off = buildMintInstructions({
    identity: null,
    persona: '',
    recentContext: '',
  })
  assert.ok(!off.includes('Dispatch confirmation is ON'))
})

test('mint bakes the propose-first contract when voiceConfig requires confirmation', async () => {
  const { fetchImpl, calls } = okMintFetch()
  const { deps } = makeDeps({ fetchImpl })
  const handler = new VoiceRpcHandler(deps)
  await handler.handle(
    frame({
      payload: {
        recentContext: '',
        openaiApiKey: 'sk-caller-own-key',
        voiceConfig: { requireDispatchConfirm: true },
      },
    }),
  )
  const sent = JSON.parse(String(calls[0]!.init.body)) as any
  assert.ok(String(sent.session.instructions).includes('Dispatch confirmation is ON'))
})

test('normalizeVoiceTaskDispatch: gate off passes unconfirmed through (back-compat)', () => {
  const out = normalizeVoiceTaskDispatch(
    { task_id: 't1', question: 'q', context: 'ctx', chat_id: 12 },
    { requireConfirmed: false },
  )
  assert.deepEqual(out, {
    ok: true,
    task: { taskId: 't1', question: 'q', context: 'ctx', chatId: '12' },
  })
})

test('normalizeVoiceTaskDispatch: gate on rejects an unconfirmed dispatch with a reason', () => {
  const out = normalizeVoiceTaskDispatch(
    { task_id: 't1', question: 'q' },
    { requireConfirmed: true },
  )
  assert.equal(out.ok, false)
  assert.match(String((out as { ok: false; reason: string }).reason), /unconfirmed/i)
})

test('normalizeVoiceTaskDispatch: gate on accepts confirmed true and "true"', () => {
  for (const confirmed of [true, 'true']) {
    const out = normalizeVoiceTaskDispatch(
      { task_id: 't1', question: 'q', confirmed },
      { requireConfirmed: true },
    )
    assert.equal(out.ok, true, `confirmed=${String(confirmed)}`)
  }
})

test('normalizeVoiceTaskDispatch: missing task_id is rejected regardless of gate', () => {
  for (const requireConfirmed of [false, true]) {
    const out = normalizeVoiceTaskDispatch({ question: 'q' }, { requireConfirmed })
    assert.equal(out.ok, false)
  }
})

// ── welcome-back ceremony (Iris G2, wave 1) ─────────────────────────────────

test('mint instructions carry the welcome-back ceremony', () => {
  const text = buildMintInstructions({
    identity: { name: 'Jeff', subtitle: '' },
    persona: '',
    recentContext: '',
  })
  assert.ok(text.includes('Welcome-back ceremony'))
  assert.ok(text.includes('skip the greeting ceremony'))
  assert.ok(text.includes('by name'))
  assert.ok(text.includes('never a robotic'))
})

// ── owner memory head + aggregate budget (Iris G4, wave 1) ──────────────────

test('mint instructions include the owner memory head when memory is present', () => {
  const text = buildMintInstructions({
    identity: { name: 'Jeff', subtitle: '' },
    persona: '',
    recentContext: '',
    memory: 'Owner is in Asia/Dubai. Active project: the launch. "the usual" = Thursday 9am.',
  })
  assert.ok(text.includes('Owner memory'))
  assert.ok(text.includes('Asia/Dubai'))
})

test('no memory head when memory is empty (safe default, byte-identical)', () => {
  const withEmpty = buildMintInstructions({
    identity: { name: 'Jeff', subtitle: '' },
    persona: '',
    recentContext: '',
    memory: '',
  })
  const without = buildMintInstructions({
    identity: { name: 'Jeff', subtitle: '' },
    persona: '',
    recentContext: '',
  })
  assert.ok(!withEmpty.includes('Owner memory'))
  assert.equal(withEmpty, without)
})

test('aggregate instructions budget caps the total and trims memory FIRST', () => {
  const bigMemory = 'M'.repeat(8000)
  const bigContext = 'C'.repeat(13000)
  const text = buildMintInstructions({
    identity: { name: 'Jeff', subtitle: '' },
    persona: '',
    recentContext: bigContext,
    memory: bigMemory,
  })
  // Total instructions stay within the aggregate budget.
  assert.ok(
    text.length <= AGGREGATE_INSTRUCTIONS_BUDGET,
    `instructions ${text.length} exceed budget ${AGGREGATE_INSTRUCTIONS_BUDGET}`,
  )
  // Memory is sacrificed before the recent conversation: the context survives
  // heavily, the memory is trimmed to little/none.
  const memoryChars = (text.match(/M/g) || []).length
  const contextChars = (text.match(/C/g) || []).length
  assert.ok(contextChars > memoryChars, 'context must outlast memory under pressure')
})

test('a context that alone exceeds the budget drops memory entirely and trims context', () => {
  const hugeContext = 'C'.repeat(20000)
  const text = buildMintInstructions({
    identity: { name: 'Jeff', subtitle: '' },
    persona: '',
    recentContext: hugeContext,
    memory: 'M'.repeat(4000),
  })
  assert.ok(text.length <= AGGREGATE_INSTRUCTIONS_BUDGET)
  assert.ok(!text.includes('Owner memory'), 'memory must be dropped when context alone fills the budget')
})

test('loadVoiceMemory concatenates the agent home memory files, capped', () => {
  const files: Record<string, string> = {
    '/agent/USER.md': 'Owner is Kc, tz Asia/Dubai.',
    '/agent/MEMORY.md': 'Active project: the launch.',
  }
  const mem = loadVoiceMemory({
    cwd: '/agent',
    env: {},
    readFile: (p) => files[p] ?? null,
  })
  assert.ok(mem.includes('Asia/Dubai'))
  assert.ok(mem.includes('the launch'))
})

test('loadVoiceMemory returns empty when no memory files exist (safe default)', () => {
  const mem = loadVoiceMemory({ cwd: '/empty', env: {}, readFile: () => null })
  assert.equal(mem, '')
})

test('loadVoiceMemory honors BGOS_VOICE_MEMORY=off', () => {
  const mem = loadVoiceMemory({
    cwd: '/agent',
    env: { BGOS_VOICE_MEMORY: 'off' },
    readFile: () => 'secret',
  })
  assert.equal(mem, '')
})

test('loadVoiceMemory honors an explicit BGOS_VOICE_MEMORY_FILE and caps at VOICE_MEMORY_MAX', () => {
  const mem = loadVoiceMemory({
    cwd: '/agent',
    env: { BGOS_VOICE_MEMORY_FILE: '/custom/brief.md' },
    readFile: (p) => (p === '/custom/brief.md' ? 'X'.repeat(20000) : null),
  })
  assert.equal(mem.length, VOICE_MEMORY_MAX)
})

test('G4 safe default: a memory-less agent keeps its full pre-feature context (no aggregate trim)', () => {
  const bigContext = 'C'.repeat(18000)
  const text = buildMintInstructions({
    identity: { name: 'Jeff', subtitle: '' },
    persona: '',
    recentContext: bigContext,
    memory: '',
  })
  // No memory => no aggregate trim => the full 18k context survives (well past
  // the 14k budget), byte-identical to the pre-feature 20k-slice behavior.
  assert.ok((text.match(/C/g) || []).length >= 18000)
})

test('G4 context trim keeps the MOST RECENT turns (tail), not the oldest', () => {
  // OLDEST...NEWEST: a marker at the very end must survive a budget trim.
  const context = 'OLDEST' + 'x'.repeat(14000) + 'NEWEST'
  const text = buildMintInstructions({
    identity: { name: 'Jeff', subtitle: '' },
    persona: '',
    recentContext: context,
    memory: 'M'.repeat(2000),
  })
  assert.ok(text.includes('NEWEST'), 'the most recent turn must survive the trim')
  assert.ok(!text.includes('OLDEST'), 'the oldest turn is dropped first')
})
