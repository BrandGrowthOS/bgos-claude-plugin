/**
 * The session status this daemon reports on its heartbeat (HOAI board row
 * 9c3d6b2c, session liveness, option C approved by Kc on 2026-10-09).
 *
 * WHY. The server only ever heard from this daemon, and this daemon kept
 * checking in while the Claude Code session behind it was frozen, so a frozen
 * agent read `online` in green. The daemon already knows what its session is
 * doing (lib/agent-state.ts publishes it every 30 s for the watcher); this
 * sends those facts to the server, which turns them into a word.
 *
 * What these tests pin:
 *   - the PAYLOAD SHAPE: exactly the shared contract's fields, and every report
 *     this daemon builds passes the server's own parser (the contract test on
 *     this side; the parser is the byte identical copy in
 *     lib/session-status-contract.ts);
 *   - PRIVACY: facts only. Built from a real recorded hook stream full of
 *     commands, paths and the agents' own words, the report carries none of
 *     them;
 *   - what counts as RUNNING and as the SESSION's activity (not this
 *     daemon's own polls, deliveries and heartbeats);
 *   - the CADENCE: a change goes out within a minute, a busy report is renewed
 *     every 2 minutes, an idle unchanged one is not re-sent.
 *
 * Run: npx tsx --test test/session-status.test.ts
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import {
  applyHookEventToTurn,
  emptyTurn,
  parseHookEvent,
  type TurnState,
} from '../lib/hook-events.ts'
import {
  parseSessionStatus,
  SESSION_STATUS_BUSY_MS,
  SESSION_STATUS_CHANGE_MS,
  SESSION_STATUS_FIELDS,
  SESSION_STATUS_MAX_COUNT,
} from '../lib/session-status-contract.ts'
import {
  buildSessionStatus,
  countRunningWork,
  SESSION_STATUS_MIN_GAP_MS,
  SESSION_STATUS_TICK_MS,
  sessionStatusDue,
  sessionStatusSignature,
  type SessionFacts,
} from '../lib/session-status.ts'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

const idleFacts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  turnInFlight: false,
  turnSignal: 'hooks',
  questionsWaiting: 0,
  messagesWaiting: 0,
  oldestMessageAtMs: null,
  running: 0,
  sessionActivityAtMs: [NOW - 5 * MIN],
  ...over,
})

// ── The payload shape, against the shared contract ─────────────────────────

test('a full report carries exactly the contract fields and passes the server parser', () => {
  const report = buildSessionStatus(
    idleFacts({
      turnInFlight: true,
      questionsWaiting: 1,
      messagesWaiting: 2,
      oldestMessageAtMs: NOW - 3 * MIN,
      running: 1,
      sessionActivityAtMs: [NOW - MIN, null, undefined, NOW - 9 * MIN],
    }),
    NOW,
  )
  assert.deepEqual(report, {
    v: 1,
    at: iso(NOW),
    busy: true,
    lastActivityAt: iso(NOW - MIN),
    taskOpen: true,
    questionsWaiting: 1,
    messagesWaiting: 2,
    oldestMessageAt: iso(NOW - 3 * MIN),
    running: 1,
  })
  assert.deepEqual(Object.keys(report), [...SESSION_STATUS_FIELDS])
  assert.deepEqual(parseSessionStatus(JSON.parse(JSON.stringify(report))), { ok: true, report })
})

test('every report this daemon can build is one the server reads (no drop)', () => {
  const shapes: Array<Partial<SessionFacts>> = [
    {},
    { turnSignal: 'none', turnInFlight: true },
    { sessionActivityAtMs: [] },
    { sessionActivityAtMs: [Number.NaN, null] },
    { messagesWaiting: 3, oldestMessageAtMs: null },
    { messagesWaiting: 5000, running: -2, questionsWaiting: 1.7 },
  ]
  for (const over of shapes) {
    const report = buildSessionStatus(idleFacts(over), NOW)
    const parsed = parseSessionStatus(JSON.parse(JSON.stringify(report)))
    assert.equal(parsed.ok, true, `dropped: ${JSON.stringify(over)} -> ${JSON.stringify(parsed)}`)
  }
})

test('counts are whole, never negative and clipped to the contract bound', () => {
  const report = buildSessionStatus(
    idleFacts({ messagesWaiting: 5000, running: -2, questionsWaiting: 1.7 }),
    NOW,
  )
  assert.equal(report.messagesWaiting, SESSION_STATUS_MAX_COUNT)
  assert.equal(report.running, 0)
  assert.equal(report.questionsWaiting, 1)
})

test('without hooks the task is unknown (null), never a false "no task"', () => {
  const report = buildSessionStatus(idleFacts({ turnSignal: 'none', turnInFlight: false }), NOW)
  assert.equal(report.taskOpen, null)
  const busyNoHooks = buildSessionStatus(idleFacts({ turnSignal: 'none', turnInFlight: true }), NOW)
  assert.equal(busyNoHooks.taskOpen, null)
})

test('busy is work owed: a task, a question, a message or something running', () => {
  assert.equal(buildSessionStatus(idleFacts(), NOW).busy, false)
  assert.equal(buildSessionStatus(idleFacts({ turnInFlight: true }), NOW).busy, true)
  assert.equal(buildSessionStatus(idleFacts({ questionsWaiting: 1 }), NOW).busy, true)
  assert.equal(
    buildSessionStatus(idleFacts({ messagesWaiting: 1, oldestMessageAtMs: NOW }), NOW).busy,
    true,
  )
  assert.equal(buildSessionStatus(idleFacts({ running: 1 }), NOW).busy, true)
})

test('last activity is the newest SESSION time, and null when the session never did anything', () => {
  assert.equal(
    buildSessionStatus(idleFacts({ sessionActivityAtMs: [NOW - 9 * MIN, NOW - 2 * MIN] }), NOW)
      .lastActivityAt,
    iso(NOW - 2 * MIN),
  )
  assert.equal(buildSessionStatus(idleFacts({ sessionActivityAtMs: [null, undefined] }), NOW).lastActivityAt, null)
})

test('the oldest waiting message is only reported while a message waits', () => {
  assert.equal(buildSessionStatus(idleFacts({ oldestMessageAtMs: NOW - MIN }), NOW).oldestMessageAt, null)
  assert.equal(
    buildSessionStatus(idleFacts({ messagesWaiting: 1, oldestMessageAtMs: NOW - MIN }), NOW)
      .oldestMessageAt,
    iso(NOW - MIN),
  )
})

// ── Running work and privacy, from a real recorded hook stream ──────────────

type ProbeRecord = { hook: string; payload: Record<string, unknown> }
const PROBE_TEXT = readFileSync(new URL('./fixtures/stage8-hooks.jsonl', import.meta.url), 'utf8')
const PROBE: ProbeRecord[] = PROBE_TEXT.split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as ProbeRecord)

function replay(records: ProbeRecord[]): TurnState[] {
  let state = emptyTurn()
  const states: TurnState[] = []
  let now = 1_000
  for (const record of records) {
    const event = parseHookEvent(record.payload)
    if (event === null) continue
    now += 1_000
    state = applyHookEventToTurn(state, event, now).next
    states.push(state)
  }
  return states
}

const pick = (match: (r: ProbeRecord) => boolean, what: string): Record<string, unknown> => {
  const record = PROBE.find(match)
  assert.ok(record, `the probe has no ${what}`)
  return record.payload
}

/** The same picks test/hook-subagent-rows.test.ts drives its cases with. */
const CHILD = 'ae89978c2d1dd91df'
const OWNER_PROMPT = pick(
  (r) => r.hook === 'UserPromptSubmit' && !String(r.payload.prompt ?? '').includes('<task-notification>'),
  'the owner prompt',
)
const LAUNCH = pick(
  (r) =>
    r.hook === 'PostToolUse' &&
    r.payload.tool_name === 'Agent' &&
    ((r.payload.tool_response as Record<string, unknown>)?.agentId ?? '') === CHILD,
  'the Agent launch response',
)
const OPENED = pick(
  (r) => r.hook === 'PreToolUse' && r.payload.tool_name === 'Agent' && r.payload.tool_use_id === LAUNCH.tool_use_id,
  'the Agent PreToolUse',
)
const PARENT_STOP = pick(
  (r) => r.hook === 'Stop' && r.payload.last_assistant_message === 'Waiting for the agents to complete...',
  'the parent Stop that waited for its child',
)
const CHILD_STOP = pick((r) => r.hook === 'SubagentStop' && r.payload.agent_id === CHILD, 'the child stop')
const PARENT_BASH = pick(
  (r) => r.hook === 'PreToolUse' && r.payload.tool_name === 'Bash' && r.payload.agent_id === undefined,
  "the parent's own Bash",
)
const PARENT_BASH_DONE = pick(
  (r) => r.hook === 'PostToolUse' && r.payload.tool_use_id === PARENT_BASH.tool_use_id,
  "the parent's own Bash result",
)
const SESSION_END = pick((r) => r.hook === 'SessionEnd', 'a SessionEnd')

/** Feed payloads in order; every intermediate state, oldest first. */
function feedAll(payloads: Array<Record<string, unknown>>): TurnState[] {
  let state = emptyTurn()
  const states: TurnState[] = []
  let now = 1_000
  for (const payload of payloads) {
    const event = parseHookEvent(payload)
    assert.ok(event, 'a probe payload parses')
    now += 1_000
    state = applyHookEventToTurn(state, event, now).next
    states.push(state)
  }
  return states
}

test('running counts an open command, a working helper, and a helper that outlived its parent turn', () => {
  const [prompted, opened, launched, stopped, childDone] = feedAll([
    OWNER_PROMPT,
    OPENED,
    LAUNCH,
    PARENT_STOP,
    CHILD_STOP,
  ])
  assert.equal(countRunningWork(prompted!), 0, 'a prompt alone runs nothing')
  assert.equal(countRunningWork(opened!), 1, 'the helper row is open')
  assert.equal(countRunningWork(launched!), 1, 'launched and still working')
  // The parent stopped while its helper worked: the live turn is reset, the
  // work is not over, and it still reads as running (the carried card).
  assert.equal(stopped!.tools.size, 0, 'the live turn was reset at the Stop')
  assert.equal(stopped!.carried.size, 1, 'a card was carried')
  assert.equal(countRunningWork(stopped!), 1, 'the helper still counts after the Stop')
  assert.equal(countRunningWork(childDone!), 0, 'the helper settled')

  const [, bash, bashDone] = feedAll([OWNER_PROMPT, PARENT_BASH, PARENT_BASH_DONE])
  assert.equal(countRunningWork(bash!), 1, 'a command between its PreToolUse and its result')
  assert.equal(countRunningWork(bashDone!), 0)

  const ended = feedAll([OWNER_PROMPT, OPENED, LAUNCH, PARENT_STOP, SESSION_END])
  assert.equal(countRunningWork(ended[ended.length - 1]!), 0, 'a session that ended runs nothing')
  assert.equal(countRunningWork(emptyTurn()), 0)
})

test('PRIVACY: a report built mid stream carries no command, path, prompt or reply text', () => {
  const states = [
    ...replay(PROBE),
    ...feedAll([OWNER_PROMPT, OPENED, LAUNCH, PARENT_BASH, PARENT_STOP, CHILD_STOP]),
  ]
  // Every string value of every payload in the probe that is CONTENT: a
  // command, a path, a sentence or an id has a space, a slash, a dot, a dash
  // or a digit in it, where an enum word like `running` does not.
  const secrets = new Set<string>()
  const collect = (v: unknown): void => {
    if (typeof v === 'string' && v.trim().length >= 8 && /[\s/.\-0-9]/.test(v)) secrets.add(v.trim())
    else if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  PROBE.forEach((r) => collect(r.payload))
  assert.ok(secrets.size > 20, 'the probe really is full of content')

  for (const state of states) {
    const report = buildSessionStatus(
      idleFacts({
        turnInFlight: state.turnId !== null,
        running: countRunningWork(state),
        sessionActivityAtMs: [state.lastActivityAt],
      }),
      NOW,
    )
    const wire = JSON.stringify(report)
    for (const key of Object.keys(report)) assert.ok(SESSION_STATUS_FIELDS.includes(key), key)
    for (const value of Object.values(report)) {
      if (typeof value === 'string') assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    for (const secret of secrets) {
      assert.equal(wire.includes(secret), false, `the report leaked ${secret.slice(0, 40)}`)
    }
  }
})

// ── Cadence ──────────────────────────────────────────────────────────────────

test('the tick and the gap keep a change within a minute of going out', () => {
  assert.equal(SESSION_STATUS_TICK_MS, 5_000)
  assert.equal(SESSION_STATUS_MIN_GAP_MS + SESSION_STATUS_TICK_MS, SESSION_STATUS_CHANGE_MS)
})

test('sessionStatusDue: first, changed, busy renewal, and quiet otherwise', () => {
  const idle = buildSessionStatus(idleFacts(), NOW)
  const busy = buildSessionStatus(idleFacts({ turnInFlight: true }), NOW)
  const sigIdle = sessionStatusSignature(idle)
  const sigBusy = sessionStatusSignature(busy)

  assert.equal(sessionStatusDue({ nowMs: NOW, lastAttemptAtMs: null, lastSentSignature: null, report: idle }), 'first')
  // Idle and unchanged: never again, however long.
  assert.equal(
    sessionStatusDue({ nowMs: NOW + 6 * 60 * MIN, lastAttemptAtMs: NOW, lastSentSignature: sigIdle, report: idle }),
    null,
  )
  // Changed, but the last send was too recent: wait for the gap.
  assert.equal(
    sessionStatusDue({
      nowMs: NOW + SESSION_STATUS_MIN_GAP_MS - 1,
      lastAttemptAtMs: NOW,
      lastSentSignature: sigIdle,
      report: busy,
    }),
    null,
  )
  assert.equal(
    sessionStatusDue({
      nowMs: NOW + SESSION_STATUS_MIN_GAP_MS,
      lastAttemptAtMs: NOW,
      lastSentSignature: sigIdle,
      report: busy,
    }),
    'changed',
  )
  // Busy and unchanged: renewed every busy beat, not sooner.
  assert.equal(
    sessionStatusDue({
      nowMs: NOW + SESSION_STATUS_BUSY_MS - 1,
      lastAttemptAtMs: NOW,
      lastSentSignature: sigBusy,
      report: busy,
    }),
    null,
  )
  assert.equal(
    sessionStatusDue({
      nowMs: NOW + SESSION_STATUS_BUSY_MS,
      lastAttemptAtMs: NOW,
      lastSentSignature: sigBusy,
      report: busy,
    }),
    'busy',
  )
})

test('the signature ignores only the build time, so a new instant alone is no news', () => {
  const a = buildSessionStatus(idleFacts(), NOW)
  const b = buildSessionStatus(idleFacts(), NOW + 30_000)
  assert.equal(sessionStatusSignature(a), sessionStatusSignature(b))
  const c = buildSessionStatus(idleFacts({ sessionActivityAtMs: [NOW] }), NOW)
  assert.notEqual(sessionStatusSignature(a), sessionStatusSignature(c))
})

test('simulated on the real tick: every change goes out within a minute, and no faster than the gap', () => {
  const sent: number[] = []
  let lastAttempt: number | null = null
  let lastSig: string | null = null
  // The session changes state every 7 seconds for ten minutes (a busy turn).
  for (let t = 0; t <= 10 * MIN; t += SESSION_STATUS_TICK_MS) {
    const report = buildSessionStatus(
      idleFacts({ turnInFlight: true, sessionActivityAtMs: [NOW + Math.floor(t / 7_000) * 7_000] }),
      NOW + t,
    )
    if (sessionStatusDue({ nowMs: NOW + t, lastAttemptAtMs: lastAttempt, lastSentSignature: lastSig, report })) {
      sent.push(t)
      lastAttempt = NOW + t
      lastSig = sessionStatusSignature(report)
    }
  }
  for (let i = 1; i < sent.length; i += 1) {
    const gap = sent[i]! - sent[i - 1]!
    assert.ok(gap >= SESSION_STATUS_MIN_GAP_MS, `two sends ${gap} ms apart`)
    assert.ok(gap <= SESSION_STATUS_CHANGE_MS, `a change waited ${gap} ms`)
  }
  assert.ok(sent.length >= 10, `${sent.length} sends in ten busy minutes`)
})
