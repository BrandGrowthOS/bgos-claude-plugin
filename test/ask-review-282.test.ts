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
