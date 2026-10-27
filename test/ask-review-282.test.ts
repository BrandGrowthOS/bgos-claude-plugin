/**
 * Data's review of #282 (askcard), run on the daemon's own code. server.ts
 * cannot be imported (it boots a daemon), so the ask_user_input and
 * withdraw_ask cases, the group read and the announce pass are lifted out of
 * it, as test/peer-403-loop.test.ts does, and run against a real AskTracker,
 * a stub backend and a clock that moves only when the code waits. A name the
 * lifted code reads that this harness does not provide throws, so a stub can
 * never stand in for something silently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import * as askLib from '../lib/ask-tracker.ts'
import { AskTracker, type PendingAsk } from '../lib/ask-tracker.ts'

const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const START = Date.parse('2026-10-27T09:00:00Z')
const MIN = 60_000
const SELF = { pid: 1000, startedAt: START }

/** A top level declaration through its closing brace on a line of its own. */
function lift(header: string): string {
  const start = SERVER.indexOf(`\n${header}`)
  assert.ok(start >= 0, `${header} exists in server.ts`)
  const end = SERVER.indexOf('\n}\n', start)
  return SERVER.slice(start + 1, end + 3)
}

/** One case of the tool switch, wrapped in a function of its own. */
function liftCase(name: string, next: string, fn: string): string {
  const start = SERVER.indexOf(`\n    case '${name}': {`)
  const end = SERVER.indexOf(`\n    case '${next}': {`, start)
  assert.ok(start > 0 && end > start, `the ${name} case exists`)
  return `async function ${fn}(rawArgs, extra = { signal: new AbortController().signal }) {\n  switch ('${name}') {\n${SERVER.slice(start + 1, end)}\n  }\n}\n`
}

interface ToolResult {
  content: Array<{ text: string }>
  isError?: boolean
}

interface Row {
  id: number
  answer?: { optionId?: number; freeText?: string; skipped?: boolean }
}

function rig(opts: { lockHeld?: boolean; live?: number[] } = {}) {
  const source = [
    lift('async function readAskGroup('),
    lift('function announceCompleteAsks('),
    lift('async function retireOrphanAskRows('),
    liftCase('ask_user_input', 'withdraw_ask', 'askTool'),
    liftCase('withdraw_ask', 'complete_voice_task', 'withdrawTool'),
  ].join('\n')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText

  let clock = START
  class FakeDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock)
      else super(args[0] as string)
    }
    static now(): number {
      return clock
    }
  }
  const live = new Set(opts.live ?? [])
  const tracker = new AskTracker({
    filePath: null,
    now: () => clock,
    // Read by the fix (who posted a group, and is that process still running).
    ...({ self: SELF, isAlive: (pid: number) => pid === SELF.pid || live.has(pid) } as object),
  })

  // The backend: question rows by id, answered or not, and what was sent.
  const rows = new Map<number, Row>()
  const posts: Array<Record<string, unknown>> = []
  const patches: Array<{ path: string; body: unknown }> = []
  let nextId = 500
  let onPatch: ((path: string) => void | Promise<void>) | null = null
  const notes: Array<{ params: { content: string; meta: Record<string, string> } }> = []
  let notify: () => Promise<void> = async () => {}
  const logs: string[] = []
  const announced = new Set<number>()
  const askDelivering = new Set<string>()
  // Answers the owner gives at a time on this clock, by the order the questions were posted.
  const scheduled: Array<{ at: number; index: number }> = []

  const known: Record<string, unknown> = {
    ...askLib,
    Date: FakeDate,
    // The only waits are the blocking wait's ticks: each moves the clock.
    setTimeout: (fn: () => void, ms: number) => {
      clock += ms
      queueMicrotask(fn)
      return { unref() {} }
    },
    log: (line: string) => logs.push(line),
    askTracker: tracker,
    escapeAgentButtonValue: (v: string) => `u:${v}`,
    resolveAuthorizedChat: (id: string) => ({ ok: true, chatId: id }),
    a2aRouteRefusedChats: new Set<string>(),
    refuseA2aToolPost: () => false,
    a2aRouteRequiredResult: () => ({ content: [{ type: 'text', text: 'a2a' }], isError: true }),
    bgosPost: async (path: string, body: Record<string, unknown>) => {
      posts.push({ path, ...body })
      const id = nextId++
      rows.set(id, { id })
      return { id, askId: (body.askId as string | undefined) ?? 'grp-1' }
    },
    bgosGet: async (path: string) => {
      const ids = [...rows.keys()]
      for (const s of scheduled) {
        const id = ids[s.index]
        if (id !== undefined && clock >= s.at && !rows.get(id)!.answer) {
          rows.set(id, { id, answer: { optionId: id * 10 + 1, skipped: false } })
        }
      }
      const before = Number(/beforeId=(\d+)/.exec(path)?.[1] ?? Infinity)
      return {
        messages: [...rows.values()]
          .filter((r) => r.id < before)
          .map((r) => ({
            message: { id: r.id, answeredAt: r.answer ? new Date().toISOString() : null, answerPayload: r.answer ?? null },
            messageOptions: [
              { id: r.id * 10 + 1, text: 'Yes', callbackData: 'u:yes' },
              { id: r.id * 10 + 2, text: 'No', callbackData: 'u:no' },
            ],
          })),
      }
    },
    bgosPatch: async (path: string, body: unknown) => {
      patches.push({ path, body })
      await onPatch?.(path)
      return {}
    },
    isNotModified: () => false,
    USER_ID: 'user_1',
    ASSISTANT_ID: '947',
    ASK_HOLD_MARGIN_MS: 30_000,
    ASK_READ_PAGE: 20,
    asksWaiting: 0,
    rememberAnnouncedClick: (id: number) => announced.add(id),
    channelArmed: true,
    lockHeld: opts.lockHeld ?? true,
    updateDrainMode: false,
    ownerAnnounceRefused: () => false,
    lanesOnForThisAgent: false,
    chatOwnership: { isOthers: () => false },
    noteLaneMisroute: () => {},
    askDelivering,
    trackMessageOperation: (op: () => Promise<unknown>) => op(),
    mcp: {
      notification: async (n: { params: { content: string; meta: Record<string, string> } }) => {
        notes.push(n)
        await notify()
      },
    },
    privateTapCard: (o: { content: string }) => o.content,
    privateTurns: {},
  }
  const scope = new Proxy(known, {
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => {
      if (typeof key === 'symbol') return undefined
      if (key in target) return target[key]
      throw new ReferenceError(`the harness has no ${String(key)}`)
    },
    set: (target, key, value) => {
      target[key as string] = value
      return true
    },
  })
  // eslint-disable-next-line no-new-func
  const lifted = new Function('scope', `with (scope) {\n${js}\nreturn { askTool, withdrawTool, announceCompleteAsks }\n}`)(
    scope,
  ) as {
    askTool(args: Record<string, unknown>): Promise<ToolResult>
    withdrawTool(args: Record<string, unknown>): Promise<ToolResult>
    announceCompleteAsks(via: string): void
  }

  return {
    tracker,
    rows,
    posts,
    patches,
    notes,
    logs,
    askDelivering,
    ...lifted,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
    answer: (id: number, yes = true) => {
      rows.set(id, { id, answer: { optionId: id * 10 + (yes ? 1 : 2), skipped: false } })
    },
    onPatch: (fn: (path: string) => void | Promise<void>) => {
      onPatch = fn
    },
    /** The owner answers the n-th posted question (Yes) once the clock reaches `at`. */
    answerAt: (index: number, at: number) => {
      scheduled.push({ at, index })
    },
    holdNotifications: () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      notify = () => gate
      return release
    },
    /** A group as if another process posted it, `postedAgo` before now. */
    foreignGroup: (askId: string, ids: number[], owner: { pid: number; startedAt: number }, postedAt: number): PendingAsk => {
      const at = clock
      clock = postedAt
      for (const id of ids) rows.set(id, { id })
      const ask = tracker.register({
        askId,
        chatId: '77',
        questions: ids.map((messageId) => ({
          messageId,
          text: `Q${messageId}?`,
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
        })),
      })
      ;(ask as PendingAsk & { owner?: unknown }).owner = owner
      clock = at
      return ask
    },
    settle: () => new Promise((r) => setImmediate(r)),
  }
}

const QUESTIONS = [
  { text: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] },
  { text: 'Tonight?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] },
]

/** The answers array a blocking call returns, or null when the result is anything else. */
function rowsOf(r: ToolResult): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(r.content[0].text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ── Item 1 (High): answers go only to the session that asked ─────────────────

test('item 1: a passive daemon refuses ask_user_input before posting anything, since it could never deliver the answers', async () => {
  const r = rig({ lockHeld: false })
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
  assert.equal(r.posts.length, 0, 'nothing posted')
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /connected/i)
  assert.equal(r.tracker.pending().length, 0)
})

test('item 1: an armed daemon never announces a group another live session posted', async () => {
  const r = rig({ live: [2000] })
  r.foreignGroup('theirs', [700, 701], { pid: 2000, startedAt: START - 10 * MIN }, START - 5 * MIN)
  r.answer(700)
  r.answer(701)
  r.tracker.record(700, { optionValue: 'yes', optionLabel: 'Yes' })
  r.tracker.record(701, { optionValue: 'yes', optionLabel: 'Yes' })
  r.announceCompleteAsks('test')
  await r.settle()
  assert.equal(r.notes.length, 0, 'their answers never start a turn here')
  assert.ok(r.tracker.get('theirs'), 'kept for the session that asked')
})

test('item 1: a group posted after this daemon started, by a session that has since ended, is not announced here', async () => {
  // This daemon ran beside the asker (it started first), so it is another
  // session that took over the pairing, not the asker restarted.
  const r = rig()
  r.advance(20 * MIN)
  r.foreignGroup('theirs', [710], { pid: 2001, startedAt: START - 60 * MIN }, START + 5 * MIN)
  r.tracker.record(710, { skipped: true })
  r.announceCompleteAsks('test')
  await r.settle()
  assert.equal(r.notes.length, 0)
})

test('item 1: a group whose asker ended before this daemon started is announced once (the asker restarted)', async () => {
  const r = rig()
  r.foreignGroup('before-restart', [720], { pid: 2002, startedAt: START - 60 * MIN }, START - 30 * MIN)
  r.tracker.record(720, { skipped: true })
  r.announceCompleteAsks('test')
  r.announceCompleteAsks('test again')
  await r.settle()
  assert.equal(r.notes.length, 1)
  assert.equal(r.notes[0].params.meta.ask_id, 'before-restart')
})

test('item 1: this session\'s own card is announced once when its last answer comes in', async () => {
  const r = rig()
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
  assert.match(res.content[0].text, /"status": "pending"/)
  const [a, b] = [...r.rows.keys()]
  r.tracker.record(a, { optionValue: 'yes', optionLabel: 'Yes' })
  r.tracker.record(b, { optionValue: 'no', optionLabel: 'No' })
  r.announceCompleteAsks('test')
  await r.settle()
  assert.equal(r.notes.length, 1)
})

// ── Item 2 (Medium): a withdrawn card never delivers ─────────────────────────

test('item 2: an answer that lands while withdraw_ask is retiring the rows is never announced', async () => {
  const r = rig()
  await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
  const askId = r.tracker.pending()[0].askId
  const [first, last] = [...r.rows.keys()]
  r.answer(first)
  // The owner answers the last open question while its row is being retired,
  // and the stream's door runs the announce pass at once.
  r.onPatch(() => {
    r.answer(last)
    r.tracker.record(last, { optionValue: 'yes', optionLabel: 'Yes' })
    r.announceCompleteAsks('stream')
  })
  const res = await r.withdrawTool({ ask_id: askId })
  await r.settle()
  assert.equal(r.notes.length, 0, 'no ask_answered after the tool said none would come')
  assert.match(res.content[0].text, /withdrawn/)
  assert.equal(r.tracker.get(askId), null)
  r.announceCompleteAsks('later pass')
  await r.settle()
  assert.equal(r.notes.length, 0)
})

test('item 2: a card whose ask_answered is already on its way is not reported withdrawn', async () => {
  const r = rig()
  await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
  const askId = r.tracker.pending()[0].askId
  for (const id of r.rows.keys()) r.tracker.record(id, { skipped: true })
  const release = r.holdNotifications()
  r.announceCompleteAsks('stream')
  assert.equal(r.notes.length, 1, 'the delivery started')
  const res = await r.withdrawTool({ ask_id: askId })
  assert.doesNotMatch(res.content[0].text, /no ask_answered event will come/)
  assert.match(res.content[0].text, /on its way/)
  assert.equal(r.patches.length, 0, 'nothing retired under an answer already delivered')
  release()
  await r.settle()
  assert.equal(r.tracker.get(askId), null, 'delivered')
})

test('item 2: a withdraw that could not retire a row lets a later answer through again', async () => {
  const r = rig()
  await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
  const askId = r.tracker.pending()[0].askId
  r.onPatch(() => {
    throw new Error('503')
  })
  const res = await r.withdrawTool({ ask_id: askId })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /stays tracked/)
  for (const id of r.rows.keys()) r.tracker.record(id, { skipped: true })
  r.announceCompleteAsks('stream')
  await r.settle()
  assert.equal(r.notes.length, 1, 'the card is live again, as the result said')
})

// ── Item 3 (Medium): existing callers keep the old contract ──────────────────

test('item 3: with neither wait_seconds nor timeout_seconds the call blocks, as before, and returns the answers array', async () => {
  const r = rig()
  r.answerAt(0, START + 40_000)
  r.answerAt(1, START + 90_000)
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS })
  const rows = rowsOf(res)
  assert.ok(rows, `the answers array, not: ${res.content[0].text.slice(0, 80)}`)
  assert.deepEqual(rows, [
    { question: 'Ship it?', picked_option_value: 'yes', picked_option_label: 'Yes' },
    { question: 'Tonight?', picked_option_value: 'yes', picked_option_label: 'Yes' },
  ])
  assert.ok(r.now() - START >= 90_000, 'it waited for the last answer')
  assert.equal(r.notes.length, 0, 'and no event follows the result')
})

test('item 3: that default wait is the old 600 s; when it runs out the result is pending, never invented skips', async () => {
  const r = rig()
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS })
  assert.ok(r.now() - START >= 600_000, 'it waited 600 s')
  assert.ok(r.now() - START < 610_000)
  assert.match(res.content[0].text, /"status": "pending"/)
  assert.match(res.content[0].text, /600 s wait/)
  assert.doesNotMatch(res.content[0].text, /"skipped"/)
})

test('item 3: wait_seconds given as a string is read as that many seconds, never as 0', async () => {
  const r = rig()
  r.answerAt(0, START + 10_000)
  r.answerAt(1, START + 30_000)
  const rows = rowsOf(await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: '60' }))
  assert.ok(rows, 'it waited and returned the answers')
  assert.equal(rows.length, 2)
})

test('item 3: timeout_seconds given as a string is read the same way', async () => {
  const r = rig()
  r.answerAt(0, START + 5_000)
  r.answerAt(1, START + 6_000)
  assert.ok(rowsOf(await r.askTool({ chat_id: '77', questions: QUESTIONS, timeout_seconds: ' 90 ' })))
})

for (const bad of ['soon', '', -5, Number.NaN, '1e999', true]) {
  test(`item 3: wait_seconds ${typeof bad === 'number' ? String(bad) : JSON.stringify(bad)} is refused with a clear error before anything is posted`, async () => {
    const r = rig()
    const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: bad })
    assert.equal(res.isError, true)
    assert.match(res.content[0].text, /wait_seconds/)
    assert.match(res.content[0].text, /0 to 600/)
    assert.equal(r.posts.length, 0)
  })
}

test('item 3: wait_seconds 0 still returns pending at once', async () => {
  const r = rig()
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
  assert.equal(r.now(), START)
  assert.match(res.content[0].text, /"status": "pending"/)
})

test('item 3: a pending result says in plain words that the answers come later, in a turn where owner-only tools refuse, and what to do', async () => {
  const r = rig()
  const now = (await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })).content[0].text
  const late = (await rig().askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 5 })).content[0].text
  for (const text of [now, late]) {
    assert.match(text, /arrive later/)
    assert.match(text, /refuse/)
    assert.match(text, /schedule, boards, the browser, email_send and call_owner/)
    assert.match(text, /ask again with wait_seconds while your owner is in the chat/)
    assert.match(text, /your owner's next message/)
  }
})
