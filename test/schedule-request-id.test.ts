/**
 * The schedule tool sends a request id with every create, so asking again after
 * a lost answer makes one routine, not two.
 *
 * The server half (backend contract 4.9): POST scheduled-tasks/agent takes an
 * optional clientRequestId (16 to 100 of A-Z a-z 0-9 _ -). Same person and
 * agent, same id, same body: the first result, 201, nothing new. Same id with
 * another body: 409 with one sentence. No id: as before.
 *
 * Everything here runs against a FAKE server (a local http server that follows
 * that contract), never a real backend or provider. The proof test runs the
 * real `case 'schedule'` source out of server.ts, so the id is minted where the
 * handler mints it, and the fake server counts the routines that exist.
 *
 * Retry paths the add-on has for a create (the full trace is in the PR text):
 *   1. a lost answer (no answer in time, a dropped connection, an unreadable
 *      body, or a gateway 502/503/504): asked once more, with the SAME id;
 *   2. an older server that refuses the field (strict validation, 400 "should
 *      not exist"): sent once more WITHOUT the id (nothing was made);
 *   3. nothing else. An agent calling `schedule` again is a new tool call and
 *      gets a new id (see the "not covered" test).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import { boundedFetch } from '../lib/bounded-fetch.ts'
import { errorBodyText } from '../lib/error-body.ts'
import { buildScheduleCancelPath, buildScheduleCreateBody, buildScheduleListPath } from '../lib/schedule.ts'
import {
  SCHEDULE_REQUEST_ID_PATTERN,
  httpFailure,
  newScheduleRequestId,
  sendScheduleCreate,
} from '../lib/schedule-send.ts'

// ── the fake server ─────────────────────────────────────────────────────────

/** What one request does. 'drop' and 'stall' make the task FIRST, then lose the answer. */
type Step = 'ok' | 'drop' | 'stall' | 'garble' | 504 | 500 | 400 | 403
/**
 * current: knows clientRequestId (contract 4.9).
 * old-lenient: an older server, validation strips unknown fields (whitelist only).
 * old-strict: an older server with strict validation on (forbidNonWhitelisted): 400.
 */
type Mode = 'current' | 'old-lenient' | 'old-strict'

const REUSED =
  'This clientRequestId was already used for a different request. Send a new clientRequestId for a new request, or the same body again to repeat the first one.'
const TASK_DELETED =
  'The task this clientRequestId made was deleted, so nothing was scheduled again. Send a new clientRequestId to schedule it again.'

interface FakeTask {
  id: number
  topic: string
}

interface Fake {
  url: string
  tasks: FakeTask[]
  /** Every request the server saw, in order, as the body it received. */
  requests: Array<Record<string, unknown>>
  /** Pretend this id was used before for this exact body, and its task was then deleted. */
  seedDeleted(id: string, body: Record<string, unknown>): void
  /** Pretend this id was used before for a different body. */
  seedOtherBody(id: string): void
  close(): Promise<void>
}

/** The body with the id left out and the keys sorted: what the server compares. */
function digestOf(body: Record<string, unknown>): string {
  const { clientRequestId: _id, ...rest } = body
  return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))))
}

async function startFake(mode: Mode, script: Step[] = []): Promise<Fake> {
  const tasks: FakeTask[] = []
  const requests: Array<Record<string, unknown>> = []
  const remembered = new Map<string, { digest: string; taskId: number | null }>()
  let nth = 0
  const stalled: ServerResponse[] = []

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const step = script[nth++] ?? 'ok'
      const sent = JSON.parse(raw) as Record<string, unknown>
      requests.push(sent)
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (step === 400 || step === 403 || step === 500 || step === 504) {
        return json(step, { statusCode: step, message: `refused with ${step}` })
      }
      if (mode === 'old-strict' && 'clientRequestId' in sent) {
        return json(400, { statusCode: 400, message: ['property clientRequestId should not exist'], error: 'Bad Request' })
      }
      const body = { ...sent }
      if (mode === 'old-lenient') delete body.clientRequestId
      const id = typeof body.clientRequestId === 'string' ? body.clientRequestId : null
      let task: FakeTask | undefined
      if (id !== null) {
        const key = `person-1|agent-1|${id}`
        const before = remembered.get(key)
        if (before) {
          if (before.digest !== digestOf(body)) return json(409, { statusCode: 409, code: 'schedule_request_id_reused', message: REUSED })
          if (before.taskId === null) return json(409, { statusCode: 409, code: 'schedule_request_task_deleted', message: TASK_DELETED })
          task = tasks.find((t) => t.id === before.taskId)
        } else {
          task = { id: tasks.length + 1, topic: String(body.topic) }
          tasks.push(task)
          remembered.set(key, { digest: digestOf(body), taskId: task.id })
        }
      } else {
        task = { id: tasks.length + 1, topic: String(body.topic) }
        tasks.push(task)
      }
      // The task exists now. The answer may still be lost on its way back.
      if (step === 'drop') return void res.socket?.destroy()
      if (step === 'stall') return void stalled.push(res)
      if (step === 'garble') {
        res.writeHead(201, { 'Content-Type': 'application/json' })
        return void res.end('{"id": 1, "top')
      }
      json(201, task)
    })
  }

  const server: Server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    tasks,
    requests,
    seedDeleted: (id, body) => void remembered.set(`person-1|agent-1|${id}`, { digest: digestOf(body), taskId: null }),
    seedOtherBody: (id) => void remembered.set(`person-1|agent-1|${id}`, { digest: '{"topic":"something else"}', taskId: 1 }),
    close: async () => {
      for (const res of stalled) res.socket?.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** The add-on's POST, shaped like bgosPeerPost: one deadline, a typed failure for an answered refusal. */
function postTo(fake: Fake, timeoutMs = 400) {
  return (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<unknown> =>
    boundedFetch(
      {
        url: `${fake.url}/${path}`,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
        timeoutMs,
        label: `POST ${path}`,
      },
      async (response) => {
        if (!response.ok) throw httpFailure('POST', response.status, errorBodyText(await response.text().catch(() => '')))
        return response.json()
      },
      { log: () => {} },
    )
}

const noSleep = async () => {}

async function withFake<T>(mode: Mode, script: Step[], run: (fake: Fake) => Promise<T>): Promise<T> {
  const fake = await startFake(mode, script)
  try {
    return await run(fake)
  } finally {
    await fake.close()
  }
}

function buildBody(extra: Record<string, unknown> = {}) {
  const built = buildScheduleCreateBody({
    kind: 'wake',
    topic: 'Check the deploy',
    when: '2026-11-09T09:00:00+04:00',
    chatId: 200,
    clientRequestId: newScheduleRequestId(),
    ...extra,
  })
  assert.equal(built.ok, true, JSON.stringify(built))
  return (built as Extract<typeof built, { ok: true }>).body
}

// ── the real handler, run against the fake ──────────────────────────────────

const serverSource = readFileSync('server.ts', 'utf8')
const scheduleCase = serverSource.slice(serverSource.indexOf("    case 'schedule': {"), serverSource.indexOf("    case 'list_schedules': {"))

function runScheduleCase(
  fake: Fake,
  rawArgs: Record<string, unknown>,
  overrides: { newScheduleRequestId?: () => string } = {},
) {
  const post = postTo(fake)
  const bindings = {
    name: 'schedule',
    rawArgs,
    privateCall: { actingUserId: 'user_owner', chatId: '200', headers: { 'X-Caller-Assistant-Id': 'agent-1' } },
    buildScheduleCancelPath,
    buildScheduleCreateBody,
    buildScheduleListPath,
    newScheduleRequestId: overrides.newScheduleRequestId ?? newScheduleRequestId,
    // The real send, with no real waiting between the first ask and the second.
    sendScheduleCreate: (opts: Parameters<typeof sendScheduleCreate>[0]) => sendScheduleCreate({ ...opts, sleep: noSleep }),
    log: () => {},
    resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
    bgosPeerPost: post,
    bgosPeerGet: async () => [],
    bgosPeerDelete: async () => ({ ok: true }),
  }
  const js = ts.transpileModule(`return (async () => { switch(name) { ${scheduleCase} } })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as Promise<{
    content: Array<{ text: string }>
    isError?: boolean
  }>
}

const SCHEDULE_ARGS = { kind: 'wake', topic: 'Check the deploy', when: '2026-11-09T09:00:00+04:00' }

test('PROOF: the handler asks again after a lost answer and only one routine is made', async () => {
  await withFake('current', ['drop', 'ok'], async (fake) => {
    const result = await runScheduleCase(fake, SCHEDULE_ARGS)
    assert.notEqual(result.isError, true, result.content[0].text)
    assert.equal(fake.requests.length, 2, 'the add-on asked twice')
    assert.equal(typeof fake.requests[0].clientRequestId, 'string', 'the first ask carried an id')
    assert.equal(fake.requests[1].clientRequestId, fake.requests[0].clientRequestId, 'the second ask carried the SAME id')
    assert.equal(fake.tasks.length, 1, 'exactly one routine exists')
    assert.match(result.content[0].text, /^Scheduled\./)
  })
})

test('PROOF: two separate calls with identical words are two routines (the body is never the key)', async () => {
  await withFake('current', [], async (fake) => {
    await runScheduleCase(fake, SCHEDULE_ARGS)
    await runScheduleCase(fake, SCHEDULE_ARGS)
    assert.equal(fake.requests.length, 2)
    assert.notEqual(fake.requests[0].clientRequestId, fake.requests[1].clientRequestId, 'a new tool call gets a new id')
    assert.equal(fake.tasks.length, 2, 'both wanted routines were made')
  })
})

test('NOT COVERED, on purpose: the agent calling schedule again after a failure is a new request and makes a second routine', async () => {
  // Both asks of the first call are lost; the agent then calls the tool again.
  await withFake('current', ['drop', 'drop', 'ok'], async (fake) => {
    const first = await runScheduleCase(fake, SCHEDULE_ARGS)
    assert.equal(first.isError, true)
    assert.equal(fake.tasks.length, 1, 'the first call did make its routine, the answers were lost')
    const second = await runScheduleCase(fake, SCHEDULE_ARGS)
    assert.notEqual(second.isError, true)
    assert.equal(fake.tasks.length, 2, 'the agent asking again is not recognised as the same request')
  })
})

// ── the sender, one rule at a time ──────────────────────────────────────────

test('a lost answer from a dropped connection is asked again with the same id', async () => {
  await withFake('current', ['drop', 'ok'], async (fake) => {
    const body = buildBody()
    const sent = await sendScheduleCreate({ body, post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, true)
    assert.equal(fake.requests.length, 2)
    assert.equal(fake.requests[1].clientRequestId, body.clientRequestId)
    assert.equal(fake.tasks.length, 1)
  })
})

test('a lost answer from no answer in time is asked again with the same id', async () => {
  await withFake('current', ['stall', 'ok'], async (fake) => {
    const body = buildBody()
    const sent = await sendScheduleCreate({ body, post: (b) => postTo(fake, 150)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, true)
    assert.equal(fake.requests.length, 2)
    assert.equal(fake.requests[1].clientRequestId, body.clientRequestId)
    assert.equal(fake.tasks.length, 1)
  })
})

test('an answer that arrives cut off is a lost answer: asked again, still one routine', async () => {
  await withFake('current', ['garble', 'ok'], async (fake) => {
    const sent = await sendScheduleCreate({ body: buildBody(), post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, true)
    assert.equal(fake.requests.length, 2)
    assert.equal(fake.tasks.length, 1)
  })
})

test('a gateway timeout (504) is a lost answer: asked again with the same id', async () => {
  await withFake('current', [504, 'ok'], async (fake) => {
    const body = buildBody()
    const sent = await sendScheduleCreate({ body, post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, true)
    assert.equal(fake.requests.length, 2)
    assert.equal(fake.requests[1].clientRequestId, body.clientRequestId)
  })
})

test('it asks again only once: two lost answers in a row stop, with one routine made', async () => {
  await withFake('current', ['drop', 'drop', 'ok'], async (fake) => {
    const sent = await sendScheduleCreate({ body: buildBody(), post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, false)
    assert.equal(fake.requests.length, 2, 'no third ask')
    assert.equal(fake.tasks.length, 1)
  })
})

test('an answered refusal (400, 403, 500) is never asked again', async () => {
  for (const status of [400, 403, 500] as const) {
    await withFake('current', [status, 'ok'], async (fake) => {
      const sent = await sendScheduleCreate({ body: buildBody(), post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
      assert.equal(sent.ok, false, `status ${status}`)
      assert.equal(fake.requests.length, 1, `status ${status} was asked again`)
      assert.match((sent as { error: string }).error, new RegExp(String(status)))
    })
  }
})

test('with no id there is no second ask after a lost answer (it could not be made safe)', async () => {
  await withFake('current', ['drop', 'ok'], async (fake) => {
    const { clientRequestId: _gone, ...noId } = buildBody()
    const sent = await sendScheduleCreate({ body: noId, post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, false)
    assert.equal(fake.requests.length, 1)
  })
})

test('an older server that refuses the field still gets the routine: sent once more without the id', async () => {
  await withFake('old-strict', [], async (fake) => {
    const sent = await sendScheduleCreate({ body: buildBody(), post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, true)
    assert.equal(fake.requests.length, 2)
    assert.equal('clientRequestId' in fake.requests[0], true)
    assert.equal('clientRequestId' in fake.requests[1], false, 'the second send has no id')
    assert.equal(fake.tasks.length, 1)
  })
})

test('after the resend without the id there is no further ask, even if that answer is lost', async () => {
  // Request 1 is refused by the strict older server; request 2 (no id) makes the routine and loses its answer.
  await withFake('old-strict', ['ok', 'drop', 'ok'], async (fake) => {
    const sent = await sendScheduleCreate({ body: buildBody(), post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, false)
    assert.equal(fake.requests.length, 2, 'a third ask without an id could make a second routine')
    assert.equal(fake.tasks.length, 1)
  })
})

test('an older server that quietly ignores the field behaves as before: one send, one routine', async () => {
  await withFake('old-lenient', [], async (fake) => {
    const sent = await sendScheduleCreate({ body: buildBody(), post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, true)
    assert.equal(fake.requests.length, 1)
    assert.equal(fake.tasks.length, 1)
  })
})

// ── what the agent reads on a 409 ───────────────────────────────────────────

const JARGON = /409|\bPOST\b|HTTP|clientRequestId|request id|\bid\b|schedule_request/i

test('a 409 for a request that clashed reads plainly and is not asked again', async () => {
  await withFake('current', [], async (fake) => {
    const body = buildBody()
    fake.seedOtherBody(body.clientRequestId!)
    const sent = await sendScheduleCreate({ body, post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, false)
    const error = (sent as { error: string }).error
    assert.equal(error, 'This request clashed with an earlier one, so nothing was scheduled. Call schedule again to make the routine.')
    assert.doesNotMatch(error, JARGON)
    assert.equal(fake.requests.length, 1)
    assert.equal(fake.tasks.length, 0)
  })
})

test('a 409 for a routine the owner deleted reads plainly and is not asked again', async () => {
  await withFake('current', [], async (fake) => {
    const body = buildBody()
    fake.seedDeleted(body.clientRequestId!, body as unknown as Record<string, unknown>)
    const sent = await sendScheduleCreate({ body, post: (b) => postTo(fake)('scheduled-tasks/agent', b as never), sleep: noSleep })
    assert.equal(sent.ok, false)
    const error = (sent as { error: string }).error
    assert.equal(error, 'This routine was made and then deleted by the owner, so it was not made again. Call schedule again if it is still wanted.')
    assert.doesNotMatch(error, JARGON)
    assert.equal(fake.requests.length, 1)
  })
})

test('the handler hands the agent the plain 409 sentence as the tool result', async () => {
  await withFake('current', [], async (fake) => {
    // The id this call mints is already remembered as a routine the owner deleted.
    const mint = () => {
      const id = newScheduleRequestId()
      const body = buildBody({ clientRequestId: id, chatId: 200 }) as unknown as Record<string, unknown>
      fake.seedDeleted(id, body)
      return id
    }
    const result = await runScheduleCase(fake, SCHEDULE_ARGS, { newScheduleRequestId: mint })
    assert.equal(result.isError, true)
    assert.equal(
      result.content[0].text,
      'Failed to create the schedule: This routine was made and then deleted by the owner, so it was not made again. Call schedule again if it is still wanted.',
    )
    assert.doesNotMatch(result.content[0].text, JARGON)
    assert.equal(fake.requests.length, 1)
  })
})

test('any other 409 keeps the server sentence without the technical prefix', async () => {
  const sent = await sendScheduleCreate({
    body: buildBody(),
    post: async () => {
      throw httpFailure('POST', 409, errorBodyText(JSON.stringify({ statusCode: 409, message: 'You already have 20 routines on this agent.' })))
    },
    sleep: noSleep,
  })
  assert.deepEqual(sent, { ok: false, error: 'You already have 20 routines on this agent.' })
})

// ── the id itself, and the body builder ─────────────────────────────────────

test('newScheduleRequestId: in the server shape, and different every time', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const id = newScheduleRequestId()
    assert.match(id, SCHEDULE_REQUEST_ID_PATTERN)
    seen.add(id)
  }
  assert.equal(seen.size, 200)
})

test('the builder puts a good id in the body and leaves it out when none is given', () => {
  const id = 'Q2v8xT0bLk3mN5pR7sU9wA'
  const withId = buildScheduleCreateBody({ kind: 'wake', topic: 't', when: '2026-11-09T09:00:00Z', clientRequestId: id })
  assert.deepEqual(withId, { ok: true, body: { kind: 'wake', topic: 't', fireAt: '2026-11-09T09:00:00Z', clientRequestId: id } })
  const without = buildScheduleCreateBody({ kind: 'wake', topic: 't', when: '2026-11-09T09:00:00Z' })
  assert.deepEqual(without, { ok: true, body: { kind: 'wake', topic: 't', fireAt: '2026-11-09T09:00:00Z' } })
  assert.equal('clientRequestId' in (without as { body: object }).body, false)
})

test('the builder refuses an id the server would refuse, in plain words', () => {
  for (const bad of ['short', 'a'.repeat(101), 'has a space 0123456789', 'slash/in/the/id0123', 42, '']) {
    const built = buildScheduleCreateBody({ kind: 'wake', topic: 't', when: '2026-11-09T09:00:00Z', clientRequestId: bad })
    assert.equal(built.ok, false, JSON.stringify(bad))
  }
})

// ── the transport hands over the typed failure ──────────────────────────────

test('bgosPeerPost raises an answered refusal through httpFailure, so the status survives', () => {
  const start = serverSource.indexOf('async function bgosPeerPost(')
  const block = serverSource.slice(start, serverSource.indexOf('async function bgosPeerDelete(', start))
  assert.match(block, /throw httpFailure\('POST', response\.status, errorBodyText\(text\)\)/)
})

test('httpFailure keeps the message the other peer calls always had, and adds the status', () => {
  const err = httpFailure('POST', 400, errorBodyText(JSON.stringify({ message: ['property x should not exist'] }))) as Error & { status: number }
  assert.equal(err.message, 'POST 400: property x should not exist')
  assert.equal(err.status, 400)
  assert.equal(err.name, 'Error')
})
