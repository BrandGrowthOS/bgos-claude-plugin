/**
 * doctor_rpc: the owner's agent check up (the BGOS Agent health card's "Run
 * checkup") asks this daemon how it is. Until 0.75.0 the Claude Code daemon had
 * no handler at all, so every check up of a Claude Code agent waited out the
 * backend's ack deadline and read "the agent host did not respond" while the
 * agent was online and chatting (BGOS board row 01a16795, measured on Cho,
 * pairing 144, 2026-10-23 07:04:30Z: POST .../doctor answered 200, no ack and
 * no result ever arrived).
 *
 * These tests pin the wire contract the backend holds us to
 * (backend/src/integrations/doctor-rpc.service.ts and
 * backend/src/dto/integrations/doctor-rpc.dto.ts in BGOS): the ack and the
 * result go out for every frame with an rpcId, the result always fits the
 * backend's validation limits (a 400 there is the same silence as no answer),
 * and the checks are built from what this daemon already knows, with no child
 * process.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  DOCTOR_RPC_ANSWER_HOLD_MS,
  DOCTOR_RPC_CHECKS_MAX,
  DOCTOR_RPC_DETAIL_MAX,
  DOCTOR_RPC_NAME_MAX,
  DoctorRpcHandler,
  buildDoctorChecks,
  normalizeDoctorRpc,
  type DoctorCheck,
  type DoctorFacts,
  type DoctorRpcResult,
} from '../lib/doctor-rpc.ts'

const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`)

type Posted = { kind: 'ack' | 'result'; rpcId: string; body?: DoctorRpcResult }

function harness(over: Partial<{
  assistantId: string
  checks: () => Promise<DoctorCheck[]>
  ackFails: boolean
}> = {}) {
  const posted: Posted[] = []
  const logs: string[] = []
  const scheduled: Array<{ run: () => void; ms: number }> = []
  const handler = new DoctorRpcHandler({
    assistantId: () => over.assistantId ?? '42',
    runChecks: over.checks ?? (async () => [{ name: 'Connection', status: 'OK', detail: 'fine' }]),
    postAck: async (rpcId) => {
      posted.push({ kind: 'ack', rpcId })
      if (over.ackFails) throw new Error('ack refused')
    },
    postResult: async (rpcId, body) => {
      posted.push({ kind: 'result', rpcId, body })
    },
    log: (m) => logs.push(m),
    schedule: (run, ms) => scheduled.push({ run, ms }),
  })
  return { handler, posted, logs, scheduled }
}

function frame(raw: Record<string, unknown>) {
  const f = normalizeDoctorRpc(raw)
  assert.ok(f, 'the frame normalises')
  return f
}

// ── normalizeDoctorRpc ───────────────────────────────────────────────────────

test('the backend frame today, { rpcId, op: run, payload: {} }, normalises with no agent named', () => {
  assert.deepEqual(normalizeDoctorRpc({ rpcId: 'r1', op: 'run', payload: {} }), {
    rpcId: 'r1',
    op: 'run',
    assistantId: '',
  })
})

test('a frame with no rpcId cannot be answered and normalises to null', () => {
  for (const raw of [null, undefined, 'x', [], {}, { op: 'run' }, { rpcId: '' }, { rpcId: 7 }]) {
    assert.equal(normalizeDoctorRpc(raw), null)
  }
})

test('an agent named as a number or a string is kept as a string', () => {
  assert.equal(normalizeDoctorRpc({ rpcId: 'r', op: 'run', assistantId: 42 })?.assistantId, '42')
  assert.equal(normalizeDoctorRpc({ rpcId: 'r', op: 'run', assistantId: '42' })?.assistantId, '42')
})

// ── DoctorRpcHandler ─────────────────────────────────────────────────────────

test('a run frame is acked, then answered with the checks (the production silence, fixed)', async () => {
  const h = harness()
  await h.handler.handle(frame({ rpcId: 'r1', op: 'run', payload: {} }))
  assert.deepEqual(
    h.posted.map((p) => `${p.kind}:${p.rpcId}`),
    ['ack:r1', 'result:r1'],
    'ack first, then the result',
  )
  assert.deepEqual(h.posted[1].body, {
    ok: true,
    payload: { result: 'ok', checks: [{ name: 'Connection', status: 'OK', detail: 'fine' }] },
  })
})

test('one FAIL row makes the result fail; WARN alone does not', async () => {
  const warn = harness({ checks: async () => [{ name: 'A', status: 'WARN', detail: 'w' }] })
  await warn.handler.handle(frame({ rpcId: 'w', op: 'run' }))
  assert.equal((warn.posted[1].body as { payload: { result: string } }).payload.result, 'ok')

  const fail = harness({
    checks: async () => [
      { name: 'A', status: 'OK', detail: 'a' },
      { name: 'B', status: 'FAIL', detail: 'b', fix: 'do b' },
    ],
  })
  await fail.handler.handle(frame({ rpcId: 'f', op: 'run' }))
  assert.equal((fail.posted[1].body as { payload: { result: string } }).payload.result, 'fail')
})

test('a frame naming another agent gets nothing, not even an ack', async () => {
  const h = harness({ assistantId: '42' })
  await h.handler.handle(frame({ rpcId: 'r', op: 'run', assistantId: '7' }))
  assert.deepEqual(h.posted, [])
})

test('a frame naming this agent is answered', async () => {
  const h = harness({ assistantId: '42' })
  await h.handler.handle(frame({ rpcId: 'r', op: 'run', assistantId: 42 }))
  assert.equal(h.posted.length, 2)
})

test('a daemon that does not know its own agent answers nothing', async () => {
  const h = harness({ assistantId: '' })
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  assert.deepEqual(h.posted, [])
})

test('an unknown op is answered unsupported, so a future backend fails loudly instead of timing out', async () => {
  const h = harness()
  await h.handler.handle(frame({ rpcId: 'r', op: 'repair' }))
  assert.deepEqual(h.posted.map((p) => p.kind), ['ack', 'result'])
  const body = h.posted[1].body as { ok: false; error: { code: string } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'unsupported')
})

test('checks that throw still post a result, doctor_failed', async () => {
  const h = harness({
    checks: async () => {
      throw new Error('disk on fire')
    },
  })
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  const body = h.posted[1].body as { ok: false; error: { code: string; message: string } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'doctor_failed')
  assert.ok(body.error.message.length > 0 && body.error.message.length <= 300)
})

test('a failed ack does not stop the result', async () => {
  const h = harness({ ackFails: true })
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  assert.deepEqual(h.posted.map((p) => p.kind), ['ack', 'result'])
})

test('the backend re emit (no ack within 1.5 s) never runs the checks twice and gets the same answer', async () => {
  let runs = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const h = harness({
    checks: async () => {
      runs += 1
      await gate
      return [{ name: 'Connection', status: 'OK', detail: 'fine' }]
    },
  })
  const first = h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  release()
  await first
  assert.equal(runs, 1, 'a frame still running is not run again')
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  assert.equal(runs, 1, 'an answered frame is not run again')
  const results = h.posted.filter((p) => p.kind === 'result')
  assert.equal(results.length, 2, 'the answered duplicate gets the answer again')
  assert.deepEqual(results[0].body, results[1].body)
})

test('the answer is let go after the backend hold, and a later duplicate gets nothing', async () => {
  const h = harness()
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  assert.equal(h.scheduled.length, 1)
  assert.equal(h.scheduled[0].ms, DOCTOR_RPC_ANSWER_HOLD_MS)
  h.scheduled[0].run()
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  assert.equal(h.posted.filter((p) => p.kind === 'result').length, 1)
})

test('every answer fits the backend DTO: name 64, detail and fix 400, 24 checks, no dashes', async () => {
  const long = 'x'.repeat(2000) + String.fromCharCode(0x2014)
  const h = harness({
    checks: async () =>
      Array.from({ length: 40 }, (_, i) => ({
        name: `${long}${i}`,
        status: (['OK', 'WARN', 'FAIL', 'bogus'] as const)[i % 4] as DoctorCheck['status'],
        detail: `a ${String.fromCharCode(0x2013)} b\n${long}`,
        fix: long,
      })),
  })
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  const body = h.posted[1].body as { ok: true; payload: { checks: DoctorCheck[] } }
  assert.equal(body.payload.checks.length, DOCTOR_RPC_CHECKS_MAX)
  assert.equal(DOCTOR_RPC_CHECKS_MAX, 24)
  for (const c of body.payload.checks) {
    assert.ok(c.name.length <= DOCTOR_RPC_NAME_MAX && DOCTOR_RPC_NAME_MAX === 64)
    assert.ok(c.detail.length <= DOCTOR_RPC_DETAIL_MAX && DOCTOR_RPC_DETAIL_MAX === 400)
    assert.ok((c.fix ?? '').length <= 400)
    assert.ok(['OK', 'WARN', 'FAIL'].includes(c.status), `status ${c.status} is one the backend accepts`)
    assert.doesNotMatch(`${c.name}${c.detail}${c.fix ?? ''}`, DASH)
    assert.doesNotMatch(c.detail, /\n/)
  }
})

test('an empty fix is left out, never sent as an empty string', async () => {
  const h = harness({ checks: async () => [{ name: 'A', status: 'OK', detail: 'a', fix: '' }] })
  await h.handler.handle(frame({ rpcId: 'r', op: 'run' }))
  const body = h.posted[1].body as { ok: true; payload: { checks: DoctorCheck[] } }
  assert.equal('fix' in body.payload.checks[0], false)
})

// ── buildDoctorChecks ────────────────────────────────────────────────────────

const NOW = Date.parse('2026-10-23T07:04:30Z')

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    now: NOW,
    runningVersion: '0.75.0',
    pendingRestartVersion: null,
    updateDraining: false,
    assistantId: '42',
    homeConfirmed: true,
    login: { failing: false, since: null, text: null },
    resting: null,
    ...over,
  }
}

function byName(checks: DoctorCheck[], name: string): DoctorCheck {
  const c = checks.find((x) => x.name === name)
  assert.ok(c, `a ${name} row is present (rows: ${checks.map((x) => x.name).join(', ')})`)
  return c
}

test('a healthy daemon reports every row OK', () => {
  const checks = buildDoctorChecks(facts())
  assert.ok(checks.length >= 4)
  for (const c of checks) assert.equal(c.status, 'OK', `${c.name}: ${c.detail}`)
  assert.match(byName(checks, 'Connector').detail, /0\.75\.0/)
})

test('an expired Claude login is a FAIL row with the fix, in plain words', () => {
  const checks = buildDoctorChecks(
    facts({ login: { failing: true, since: NOW - 3_600_000, text: 'Login expired · Please run /login' } }),
  )
  const row = byName(checks, 'Claude login')
  assert.equal(row.status, 'FAIL')
  assert.match(row.detail, /Login expired/)
  assert.match(row.fix ?? '', /\/login/)
})

test('a usage limit is a WARN row that says when it resets', () => {
  const checks = buildDoctorChecks(facts({ resting: { resetAt: '2026-10-23T09:00:00.000Z', synthetic: false } }))
  const row = byName(checks, 'Claude usage')
  assert.equal(row.status, 'WARN')
  assert.match(row.detail, /2026-10-23T09:00/)
})

test('an update waiting for a restart, or draining, is a WARN on the connector row', () => {
  assert.equal(byName(buildDoctorChecks(facts({ pendingRestartVersion: '0.76.0' })), 'Connector').status, 'WARN')
  assert.equal(byName(buildDoctorChecks(facts({ updateDraining: true })), 'Connector').status, 'WARN')
})

test('a home folder not yet confirmed is a WARN on the agent row', () => {
  const row = byName(buildDoctorChecks(facts({ homeConfirmed: false })), 'Agent folder')
  assert.equal(row.status, 'WARN')
})
