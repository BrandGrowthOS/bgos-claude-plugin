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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

import * as askLib from '../lib/ask-tracker.ts'
import { AskTracker, type PendingAsk } from '../lib/ask-tracker.ts'
import { parseLockRecord } from '../lib/pairing-lock.ts'
import { retiredOwnNotes, tellRetiredOwnOnTick } from '../lib/ask-retired-tell.ts'

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

/** A declaration the recheck of #282 adds: empty until it exists, so its cases fail on an assertion. */
function liftIf(header: string): string {
  return SERVER.includes(`\n${header}`) ? lift(header) : ''
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

function rig(opts: { lockHeld?: boolean; live?: number[]; chatKnown?: boolean; filePath?: string; httpTimeoutMs?: number; channelLoaded?: boolean | null } = {}) {
  const source = [
    lift('async function readAskGroup('),
    lift('function announceCompleteAsks('),
    lift('async function retireOrphanAskRows('),
    lift('function refreshAskTracker('),
    liftIf('function askPassiveRetireHoldMs('),
    liftIf('function orphanRetireMayRun('),
    liftIf('async function retireOrphanedAsks('),
    liftIf('function tellRetiredOwnAsks('),
    liftIf('function askWithdrawnContent('),
    liftIf('function sendAskWithdrawn('),
    liftIf('function withRetiredOwnAskNotes<'),
    lift('function heartbeatAskTracker('),
    liftCase('ask_user_input', 'withdraw_ask', 'askTool'),
    liftCase('withdraw_ask', 'complete_voice_task', 'withdrawTool'),
  ].join('\n')
  const exported = ['askTool', 'withdrawTool', 'announceCompleteAsks', 'heartbeatAskTracker']
  if (source.includes('function retireOrphanedAsks(')) exported.push('retireOrphanedAsks')
  if (source.includes('function withRetiredOwnAskNotes<')) exported.push('withRetiredOwnAskNotes')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText

  let clock = START
  /** Groups another live process posted: their asker says it runs, as its ask tick would. */
  const beatLive = () => {
    for (const ask of tracker.pending()) {
      const owner = ask.owner as (PendingAsk['owner'] & { aliveAt?: number }) | undefined
      if (owner && owner.pid !== SELF.pid && live.has(owner.pid)) owner.aliveAt = clock
    }
  }
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
    filePath: opts.filePath ?? null,
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
  let onGet: ((path: string) => void) | null = null
  const notes: Array<{ params: { content: string; meta: Record<string, string> } }> = []
  let notify: () => Promise<void> = async () => {}
  const logs: string[] = []
  const announced = new Set<number>()
  const askDelivering = new Set<string>()
  // Answers the owner gives at a time on this clock, by the order the questions were posted.
  const scheduled: Array<{ at: number; index: number }> = []
  /** The pairing lock changing hands during a wait: applied on the first read at or after `at`. */
  const lockChanges: Array<{ at: number; held: boolean }> = []
  let lockFileNamesUs = opts.lockHeld ?? true

  const known: Record<string, unknown> = {
    ...askLib,
    Date: FakeDate,
    // The only waits are the blocking wait's ticks: each moves the clock.
    setTimeout: (fn: () => void, ms: number) => {
      clock += ms
      beatLive()
      queueMicrotask(fn)
      return { unref() {} }
    },
    log: (line: string) => logs.push(line),
    askTracker: tracker,
    escapeAgentButtonValue: (v: string) => `u:${v}`,
    resolveAuthorizedChat: (id: string) =>
      opts.chatKnown === false
        ? { ok: false, error: { content: [{ type: 'text', text: `Error: chat ${id} is not a chat you received an inbound event for` }], isError: true } }
        : { ok: true, chatId: id },
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
      onGet?.(path)
      for (const change of lockChanges.splice(0).filter((c) => clock >= c.at || (lockChanges.push(c), false))) {
        known.lockHeld = change.held
      }
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
    HTTP_TIMEOUT_MS: opts.httpTimeoutMs ?? 30_000,
    ASK_READ_PAGE: 20,
    asksWaiting: 0,
    rememberAnnouncedClick: (id: number) => announced.add(id),
    channelArmed: true,
    lockHeld: opts.lockHeld ?? true,
    connectedSince: START - 60 * MIN,
    // What the pairing lock file says, read apart from lockHeld (second fresh review of the recheck, Minor 1).
    pairingLockNamesThisDaemon: () => lockFileNamesUs,
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
    tellRetiredOwnOnTick,
    retiredOwnNotes,
    // This session's channel, as lib/channel-presence.ts reads it off the claude command line.
    channelPresence: () => ({ loaded: opts.channelLoaded ?? null, reason: 'the harness' }),
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
  const lifted = new Function('scope', `with (scope) {\n${js}\nreturn { ${exported.join(', ')} }\n}`)(
    scope,
  ) as {
    askTool(args: Record<string, unknown>): Promise<ToolResult>
    withdrawTool(args: Record<string, unknown>): Promise<ToolResult>
    announceCompleteAsks(via: string): void
    heartbeatAskTracker(): void
    retireOrphanedAsks?: (via: string) => Promise<void>
    withRetiredOwnAskNotes?: <T>(result: T) => T
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
    /** The daemon's own state the lifted code reads (lockHeld, channelArmed), to change mid test. */
    known,
    advance: (ms: number) => {
      clock += ms
      beatLive()
    },
    now: () => clock,
    answer: (id: number, yes = true) => {
      rows.set(id, { id, answer: { optionId: id * 10 + (yes ? 1 : 2), skipped: false } })
    },
    onPatch: (fn: (path: string) => void | Promise<void>) => {
      onPatch = fn
    },
    onGet: (fn: (path: string) => void) => {
      onGet = fn
    },
    /** The pairing lock is held (or not) from `at` on, as a promotion or a stand-down would. */
    lockAt: (at: number, held: boolean) => {
      lockChanges.push({ at, held })
    },
    /** The owner answers the n-th posted question (Yes) once the clock reaches `at`. */
    answerAt: (index: number, at: number) => {
      scheduled.push({ at, index })
    },
    /** The lock file names another daemon, whatever this one's lockHeld says. */
    lockFileTakenBy: () => {
      lockFileNamesUs = false
    },
    /** The next `n` channel sends fail, as a closed transport does. */
    failNotifications: (n: number) => {
      let left = n
      notify = async () => {
        if (left > 0) {
          left--
          throw new Error('the transport is closed')
        }
      }
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
      ;(ask as PendingAsk & { owner?: unknown }).owner = { ...owner }
      clock = at
      beatLive()
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
    // A second card beside the first leaves two open cards and a stale late answer
    // (second review of #282, Minor 7): withdraw the first, then ask again.
    assert.match(text, /call withdraw_ask with this ask_id, then ask again with wait_seconds while your owner is in the chat/)
    assert.match(text, /your owner's next message/)
  }
})

// ── Item 5 (Low), the cheap part: only the daemon holding the pairing announces ──

test('item 5: a daemon that does not hold the pairing lock announces nothing, even with delivery still armed', async () => {
  const r = rig({ lockHeld: false })
  r.foreignGroup('mine', [730], SELF, START)
  r.tracker.record(730, { skipped: true })
  r.announceCompleteAsks('test')
  await r.settle()
  assert.equal(r.notes.length, 0)
})

test('item 1: a passive daemon says why before the chat check, which would otherwise name only the chat', async () => {
  // A passive daemon never discovered its agent's chats, so the membership
  // check would answer first with a reason that hides the real one.
  const r = rig({ lockHeld: false, chatKnown: false })
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /not the one connected to BGOS/)
  assert.equal(r.posts.length, 0)
})

// ── Second review of #282, Important 3: a passive daemon keeps the old blocking contract ──
// It refuses only wait_seconds 0 (a pending card it could never deliver). A
// blocking wait reads the card itself, as before #282, and when it runs out
// the questions not answered are retired, so no card is left that nobody
// would ever hand back, and nothing is reported skipped.

test('second review, Important 3: a passive daemon with no wait field still blocks and returns the answers array, as before #282', async () => {
  const r = rig({ lockHeld: false })
  r.answerAt(0, START + 40_000)
  r.answerAt(1, START + 90_000)
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS })
  assert.deepEqual(rowsOf(res), [
    { question: 'Ship it?', picked_option_value: 'yes', picked_option_label: 'Yes' },
    { question: 'Tonight?', picked_option_value: 'yes', picked_option_label: 'Yes' },
  ], res.content[0].text.slice(0, 160))
  assert.equal(r.posts.length, 2)
  assert.equal(r.patches.length, 0)
  assert.equal(r.notes.length, 0)
})

test('second review, Important 3: in a passive daemon a wait that runs out retires the questions not answered and returns the answers given, never pending', async () => {
  const r = rig({ lockHeld: false })
  r.answerAt(0, START + 10_000)
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 60 })
  const text = res.content[0].text
  const [first, second] = [...r.rows.keys()]
  assert.doesNotMatch(text, /"status": "pending"/)
  assert.doesNotMatch(text, /"skipped"/)
  assert.match(text, /"status": "withdrawn"/)
  assert.match(text, /"picked_option_value": "yes"/)
  assert.match(text, /withdrawn from the chat/)
  assert.deepEqual(r.patches.map((p) => p.path), [`messages/${second}`], 'only the open question is retired')
  assert.ok(first !== undefined)
  assert.equal(r.tracker.pending().length, 0, 'nothing is left for another daemon to hand out')
  r.answerAt(1, START + 120_000)
  r.advance(120_000)
  r.announceCompleteAsks('test')
  await r.settle()
  assert.equal(r.notes.length, 0)
})

test('second review, Important 3: in a passive daemon a wait the client cancelled retires the card', async () => {
  const r = rig({ lockHeld: false })
  const cancelled = new AbortController()
  cancelled.abort()
  const res = await (r.askTool as (a: Record<string, unknown>, e: { signal: AbortSignal }) => Promise<ToolResult>)(
    { chat_id: '77', questions: QUESTIONS },
    { signal: cancelled.signal },
  )
  assert.doesNotMatch(res.content[0].text, /"status": "pending"/)
  assert.equal(r.patches.length, 2, 'both questions retired')
  assert.equal(r.tracker.pending().length, 0)
})

// ── Third review of #282: Minors 3 to 6, and the lock changing during a wait (Minor 8) ──

test('third review, Minor 3: a passive daemon that has no event from the chat says why, not only that the chat is unknown', async () => {
  const r = rig({ lockHeld: false, chatKnown: false })
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /not the one connected to BGOS/)
  assert.match(res.content[0].text, /Ask from the connected session/)
  assert.equal(r.posts.length, 0)
})

test('third review, Minor 4: an answer that lands while a passive wait retires the rest is in the result', async () => {
  const r = rig({ lockHeld: false })
  r.answerAt(0, START + 10_000)
  r.onPatch((path) => {
    const id = Number(path.split('/')[1])
    r.rows.set(id, { id, answer: { optionId: id * 10 + 1, skipped: false } })
  })
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 60 })
  assert.deepEqual(rowsOf(res), [
    { question: 'Ship it?', picked_option_value: 'yes', picked_option_label: 'Yes' },
    { question: 'Tonight?', picked_option_value: 'yes', picked_option_label: 'Yes' },
  ], res.content[0].text.slice(0, 200))
})

test('third review, Minor 5: a passive wait whose retire fails says how many were withdrawn, and which may still show', async () => {
  const r = rig({ lockHeld: false })
  r.onPatch(() => {
    throw new Error('backend down')
  })
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 30 })
  assert.match(res.content[0].text, /0 of the 2 question\(s\) not answered were withdrawn from the chat; the other 2 may still show there/)
})

test('third review, Minor 6: the refusals read plainly and name timeout_seconds 0 too', async () => {
  const r = rig({ lockHeld: false })
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, timeout_seconds: 0 })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /timeout_seconds 0/)
  assert.equal(r.posts.length, 0)
})

test('third review, Minor 8: a passive daemon promoted during its wait returns pending, and the card stays live', async () => {
  const r = rig({ lockHeld: false })
  r.lockAt(START + 5_000, true)
  r.answerAt(0, START + 10_000)
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 30 })
  assert.match(res.content[0].text, /"status": "pending"/)
  assert.equal(r.patches.length, 0)
  assert.equal(r.tracker.pending().length, 1)
})

test('third review, Minor 8: an armed daemon that stands down during its wait retires what is not answered', async () => {
  const r = rig()
  r.lockAt(START + 5_000, false)
  r.answerAt(0, START + 10_000)
  const res = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 30 })
  assert.match(res.content[0].text, /"status": "withdrawn"/)
  assert.equal(r.patches.length, 1)
  assert.equal(r.tracker.pending().length, 0)
})

// ── Data's recheck of #282 at 4d9ee89: a card no daemon may announce is retired, never left live ──

const RETIRE = askLib.askRetireBody()

test('recheck, item 1: a group marked askerEndedBeside has its open questions retired as withdraw_ask does, and this session gets ONE ask_withdrawn event', async () => {
  const r = rig()
  const ask = r.foreignGroup('theirs', [740, 741], { pid: 2003, startedAt: START - 60 * MIN }, START - 30 * MIN)
  ask.askerEndedBeside = START - MIN
  r.answer(740)
  assert.equal(typeof r.retireOrphanedAsks, 'function', 'server.ts retires what no daemon may announce')
  await r.retireOrphanedAsks?.('test')
  await r.settle()
  assert.deepEqual(r.patches, [{ path: 'messages/741', body: RETIRE }], 'the answered question keeps its answer; the open one closes for the owner')
  assert.equal(r.notes.length, 1)
  assert.equal(r.notes[0].params.meta.event_type, 'ask_withdrawn')
  assert.equal(r.notes[0].params.meta.ask_id, 'theirs')
  assert.equal(r.tracker.get('theirs'), null)
  assert.equal(r.tracker.wasDelivered('theirs'), true, 'gone for every daemon')
  await r.retireOrphanedAsks?.('test')
  await r.settle()
  assert.equal(r.notes.length, 1, 'once')
  assert.equal(r.patches.length, 1)
})

test('recheck, item 1: a retire whose PATCH fails keeps the group and says nothing yet; the next pass retires it', async () => {
  const r = rig()
  const ask = r.foreignGroup('theirs', [742], { pid: 2003, startedAt: START - 60 * MIN }, START - 30 * MIN)
  ask.askerEndedBeside = START - MIN
  let fail = true
  r.onPatch(() => {
    if (fail) throw new Error('HTTP 503')
  })
  assert.equal(typeof r.retireOrphanedAsks, 'function')
  await r.retireOrphanedAsks?.('test')
  await r.settle()
  assert.equal(r.notes.length, 0)
  assert.ok(r.tracker.get('theirs'), 'still tracked')
  fail = false
  await r.retireOrphanedAsks?.('test')
  await r.settle()
  assert.equal(r.notes.length, 1)
  assert.equal(r.tracker.get('theirs'), null)
})

test('recheck, item 1: only the armed daemon holding the connection retires; a passive one leaves the card for it', async () => {
  const r = rig({ lockHeld: false })
  const ask = r.foreignGroup('theirs', [743], { pid: 2003, startedAt: START - 60 * MIN }, START - 30 * MIN)
  ask.askerEndedBeside = START - MIN
  assert.equal(typeof r.retireOrphanedAsks, 'function')
  await r.retireOrphanedAsks?.('test')
  await r.settle()
  assert.deepEqual(r.patches, [])
  assert.ok(r.tracker.get('theirs'))
})

test('fresh review of the recheck, Critical 1: whatever took the connection (channel, route, a stale lock after a sleep), every unheld group of a live asker other than this daemon is retired once seen so for ASK_LEASE_MS, one event each, none left', async () => {
  const r = rig({ live: [2004, 2005] })
  r.foreignGroup('first', [750], { pid: 2004, startedAt: START - 60 * MIN }, START - 2 * MIN)
  r.foreignGroup('second', [751, 752], { pid: 2004, startedAt: START - 60 * MIN }, START - MIN)
  r.foreignGroup('older-holder', [753], { pid: 2005, startedAt: START - 90 * MIN }, START - 30 * MIN)
  r.answer(751)
  assert.equal(typeof r.retireOrphanedAsks, 'function')
  for (let i = 0; i < 2; i++) {
    await r.retireOrphanedAsks?.('timer')
    r.advance(15_000)
  }
  await r.retireOrphanedAsks?.('timer')
  await r.settle()
  assert.equal(r.patches.length, 0, 'not within ASK_LEASE_MS of the first look (30 s)')
  r.advance(15_000)
  await r.retireOrphanedAsks?.('timer')
  await r.settle()
  assert.deepEqual(r.patches.map((p) => p.path).sort(), ['messages/750', 'messages/752', 'messages/753'])
  assert.deepEqual(r.notes.map((n) => n.params.meta.ask_id).sort(), ['first', 'older-holder', 'second'])
  assert.ok(r.notes.every((n) => n.params.meta.event_type === 'ask_withdrawn'))
  assert.deepEqual(r.tracker.pending(), [], 'none left')
})

test('fresh review of the recheck, Critical 1: a passive session\'s blocking wait keeps its card from the retire while it holds it', async () => {
  const r = rig({ live: [2007] })
  const ask = r.foreignGroup('waiting', [770], { pid: 2007, startedAt: START - 60 * MIN }, START)
  ask.heldUntil = START + 2 * MIN
  for (let i = 0; i < 5; i++) {
    await r.retireOrphanedAsks?.('timer')
    r.advance(20_000)
  }
  await r.settle()
  assert.deepEqual(r.patches, [])
  assert.ok(r.tracker.get('waiting'))
})

test('fresh review of the recheck, Minor 2: a group another daemon delivers or retires while this one retires its rows is never told here', async () => {
  const r = rig()
  const ask = r.foreignGroup('theirs', [780], { pid: 2008, startedAt: START - 60 * MIN }, START - 30 * MIN)
  ask.askerEndedBeside = START - MIN
  // The passive asker's own wait retired it (or its restart delivered it) during the PATCH.
  r.onPatch(() => r.tracker.delivered('theirs'))
  assert.equal(typeof r.retireOrphanedAsks, 'function')
  await r.retireOrphanedAsks?.('test')
  await r.settle()
  assert.equal(r.patches.length, 1)
  assert.equal(r.notes.length, 0, 'its session already has the answers, or was told')
})

test('second fresh review of the recheck, Minor 1: a daemon whose lockHeld is stale (its poll tick stalled while a rival took the lock) retires nothing: it asks the lock file first', async () => {
  const r = rig({ live: [2009] })
  r.foreignGroup('real-holders', [790], { pid: 2009, startedAt: START - 60 * MIN }, START)
  const marked = r.foreignGroup('marked', [791], { pid: 2010, startedAt: START - 60 * MIN }, START - 30 * MIN)
  marked.askerEndedBeside = START - MIN
  r.lockFileTakenBy()
  for (let i = 0; i < 5; i++) {
    await r.retireOrphanedAsks?.('timer')
    r.advance(15_000)
  }
  await r.settle()
  assert.deepEqual(r.patches, [], 'pid 2009 holds the connection: its card is its own to deliver')
  assert.equal(r.notes.length, 0)
})

test('second fresh review of the recheck, Minor 3: a passive wait retires its card under a hold on disk, so the connected daemon never retires it too', async () => {
  const r = rig({ lockHeld: false })
  const heldDuringPatch: boolean[] = []
  r.onPatch(() => {
    const ask = r.tracker.pending()[0]
    heldDuringPatch.push(ask?.heldUntil !== undefined && ask.heldUntil > r.now())
  })
  await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 5 })
  assert.equal(heldDuringPatch.length, 2)
  assert.ok(heldDuringPatch.every(Boolean), `held through its own retire: ${JSON.stringify(heldDuringPatch)}`)
  assert.equal(r.tracker.pending().length, 0)
})

test('second fresh review of the recheck, Minor 5: the retire reads the file again after its PATCH, so a tombstone another daemon wrote meanwhile stops the event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'askcard-retire-'))
  try {
    const filePath = join(dir, 'pending-asks.json')
    const r = rig({ filePath })
    const ask = r.foreignGroup('theirs', [795], { pid: 2011, startedAt: START - 60 * MIN }, START - 30 * MIN)
    ask.askerEndedBeside = START - MIN
    r.tracker.hold('theirs', START - 1)
    r.tracker.release('theirs')
    // Another daemon, on the same file, delivers it while this one PATCHes.
    const other = new AskTracker({ filePath, now: () => r.now(), ...({ self: { pid: 2012, startedAt: START - MIN }, isAlive: () => true } as object) })
    r.onPatch(() => {
      other.refresh()
      other.delivered('theirs')
    })
    await r.retireOrphanedAsks?.('test')
    await r.settle()
    assert.equal(r.patches.length, 1)
    assert.equal(r.notes.length, 0, 'the other daemon handed it out: nothing to tell here')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('third fresh review of the recheck, Minor 1: a rival that takes the lock while the retire reads the card (a slow backend) stops the PATCH', async () => {
  const r = rig()
  const ask = r.foreignGroup('theirs', [796], { pid: 2014, startedAt: START - 60 * MIN }, START - 30 * MIN)
  ask.askerEndedBeside = START - MIN
  r.onGet(() => r.lockFileTakenBy())
  await r.retireOrphanedAsks?.('timer')
  await r.settle()
  assert.deepEqual(r.patches, [], 'the lock changed hands during the read')
  assert.equal(r.notes.length, 0)
  assert.deepEqual(r.tracker.pending().map((g) => g.askId), ['theirs'], 'kept for the daemon that holds the lock now')
  // Fourth fresh review, Minor 2: and let go, so a later pass here may retire it once the lock is back.
  assert.deepEqual(r.tracker.retirable(START - 60 * MIN).map((g) => g.askId), ['theirs'], 'not left withdrawing')
})

test('third fresh review of the recheck, Minor 4: a passive wait holds its card through a retire as long as the HTTP timeout allows (a read and a PATCH per question)', async () => {
  const r = rig({ lockHeld: false, httpTimeoutMs: 120_000 })
  const heldFor: number[] = []
  r.onPatch(() => {
    const ask = r.tracker.pending()[0]
    heldFor.push((ask?.heldUntil ?? 0) - r.now())
  })
  await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 5 })
  assert.equal(heldFor.length, 2)
  assert.ok(heldFor.every((ms) => ms >= (2 + 1) * 120_000), `held for ${JSON.stringify(heldFor)} ms`)
})

test('third fresh review of the recheck, Minor 5: the lock file names this daemon only when it parses and carries this pid; anything else is no', () => {
  const src = lift('function pairingLockNamesThisDaemon(')
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const dir = mkdtempSync(join(tmpdir(), 'askcard-lock-'))
  try {
    const lockPath = join(dir, 'pairing.lock')
    const names = new Function('scope', `with (scope) {\n${js}\nreturn pairingLockNamesThisDaemon\n}`)({
      PAIRING_LOCK_PATH: lockPath,
      readFileSync,
      parseLockRecord,
      process: { pid: 4321 },
    }) as () => boolean
    assert.equal(names(), false, 'no lock file')
    writeFileSync(lockPath, '{"pid": 43')
    assert.equal(names(), false, 'half written')
    writeFileSync(lockPath, JSON.stringify({ pid: 1234, heartbeatAt: START }))
    assert.equal(names(), false, 'another daemon')
    writeFileSync(lockPath, JSON.stringify({ pid: 4321, heartbeatAt: START }))
    assert.equal(names(), true, 'this daemon')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fourth fresh review of the recheck, Minor 1: a blocking wait holds its card through a last read as long as the HTTP timeout allows', async () => {
  const r = rig({ lockHeld: false, httpTimeoutMs: 120_000 })
  const deadline = r.now() + 5_000
  const heldThroughLastRead: boolean[] = []
  r.onGet(() => {
    if (r.now() < deadline || heldThroughLastRead.length > 0) return
    // The last read takes 100 s of a 120 s timeout (a slow backend).
    r.advance(100_000)
    const ask = r.tracker.pending()[0]
    heldThroughLastRead.push(ask?.heldUntil !== undefined && ask.heldUntil > r.now())
  })
  await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 5 })
  assert.deepEqual(heldThroughLastRead, [true], 'held on disk until the last read ends')
})

/** The lease follow-up of #282: the retire's record for a live asker, read through the instance. */
type RetiredOwn = { takeRetiredOwn?: () => Array<{ ask: PendingAsk; withdrawn: number }>; retire?: (askId: string, opts: { withdrawn: number; tellAsker?: boolean }) => PendingAsk | null }

function withAskFile(fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'askcard-lease-'))
  return fn(join(dir, 'pending-asks.json')).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('lease follow-up, item 2: the retire of a live asker\'s card leaves it on file for that asker, with what was answered', () =>
  withAskFile(async (filePath) => {
    const r = rig({ live: [2015], filePath })
    const asker = { pid: 2015, startedAt: START - 60 * MIN }
    r.foreignGroup('theirs', [797, 798], asker, START - MIN)
    r.answer(797)
    for (let i = 0; i < 3; i++) {
      await r.retireOrphanedAsks?.('timer')
      r.advance(15_000)
    }
    await r.retireOrphanedAsks?.('timer')
    await r.settle()
    assert.deepEqual(r.patches.map((p) => p.path), ['messages/798'])
    assert.equal(r.notes.length, 1, 'this session is told, as before')
    const theAsker = new AskTracker({ filePath, now: () => r.now(), ...({ self: asker, isAlive: () => true } as object) })
    theAsker.refresh()
    const told = (theAsker as unknown as RetiredOwn).takeRetiredOwn?.() ?? 'missing'
    assert.notEqual(told, 'missing')
    assert.deepEqual(
      (told as Array<{ ask: PendingAsk; withdrawn: number }>).map((t) => [t.ask.askId, t.withdrawn, Object.keys(t.ask.answers)]),
      [['theirs', 1, ['797']]],
    )
  }))

test('lease follow-up review, Important 2: a card in a share recipient\'s chat is retired, but kept for nobody: the asker\'s stale lane state never decides', () =>
  withAskFile(async (filePath) => {
    const r = rig({ live: [2018], filePath })
    const asker = { pid: 2018, startedAt: START - 60 * MIN }
    r.foreignGroup('recipients', [795, 796], asker, START - MIN)
    r.answer(795)
    // Lanes are on and the chat is a share recipient's: the connected daemon tells no owner session.
    r.known.ownerAnnounceRefused = () => true
    for (let i = 0; i < 3; i++) {
      await r.retireOrphanedAsks?.('timer')
      r.advance(15_000)
    }
    await r.retireOrphanedAsks?.('timer')
    await r.settle()
    assert.deepEqual(r.patches.map((p) => p.path), ['messages/796'], 'retired as before')
    assert.equal(r.notes.length, 0, 'this session is not told')
    const theAsker = new AskTracker({ filePath, now: () => r.now(), ...({ self: asker, isAlive: () => true } as object) })
    theAsker.refresh()
    assert.deepEqual((theAsker as unknown as RetiredOwn).takeRetiredOwn?.() ?? 'missing', [], 'nor is the asker, whatever lanes it last saw')
  }))

test('lease follow-up, item 2: the asker\'s own daemon, passive, tells its session once on its tick that its card was retired', () =>
  withAskFile(async (filePath) => {
    const r = rig({ filePath })
    const pending = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
    assert.ok(!pending.isError)
    const askId = r.tracker.pending()[0].askId
    r.answer(r.tracker.pending()[0].questions[0].messageId)
    r.known.lockHeld = false
    r.known.channelArmed = false
    // The daemon that took the connection reads one answer and retires the rest.
    const holder = new AskTracker({ filePath, now: () => r.now(), ...({ self: { pid: 2016, startedAt: START - MIN }, isAlive: () => true } as object) })
    holder.refresh()
    holder.record(r.tracker.pending()[0].questions[0].messageId, { skipped: true })
    holder.beginWithdraw(askId)
    assert.notEqual((holder as unknown as RetiredOwn).retire?.(askId, { withdrawn: 1, tellAsker: true }) ?? 'missing', 'missing')
    for (let i = 0; i < 3; i++) {
      r.advance(5_000)
      r.heartbeatAskTracker()
      await r.settle()
    }
    const told = r.notes.filter((n) => n.params.meta.event_type === 'ask_withdrawn')
    assert.equal(told.length, 1, 'once')
    assert.equal(told[0].params.meta.ask_id, askId)
    assert.equal(told[0].params.meta.withdrawn, '1')
    assert.ok(Object.values(told[0].params.meta).every((v) => typeof v === 'string'))
    assert.match(told[0].params.content, /this session posted/)
    assert.equal(r.tracker.get(askId), null)
  }))

test('lease follow-up, item 2: a group handed over to the asker\'s restart is announced there once, and no ask_withdrawn goes anywhere', async () => {
  const r = rig()
  r.foreignGroup('handed', [799], { pid: 2017, startedAt: START - 60 * MIN }, START - 30 * MIN)
  r.tracker.record(799, { skipped: true })
  r.announceCompleteAsks('test')
  for (let i = 0; i < 4; i++) {
    await r.retireOrphanedAsks?.('timer')
    r.heartbeatAskTracker()
    r.advance(15_000)
    await r.settle()
  }
  assert.deepEqual(r.notes.map((n) => n.params.meta.event_type), ['ask_answered'])
})

/** The asker posts and stands down; the daemon that took the connection reads one answer and retires the rest, keeping the card for the asker. */
async function retiredForThePassiveAsker(r: ReturnType<typeof rig>, filePath: string): Promise<string> {
  const pending = await r.askTool({ chat_id: '77', questions: QUESTIONS, wait_seconds: 0 })
  assert.ok(!pending.isError)
  const askId = r.tracker.pending()[0].askId
  r.answer(r.tracker.pending()[0].questions[0].messageId)
  r.known.lockHeld = false
  r.known.channelArmed = false
  const holder = new AskTracker({ filePath, now: () => r.now(), ...({ self: { pid: 2016, startedAt: START - MIN }, isAlive: () => true } as object) })
  holder.refresh()
  holder.record(r.tracker.pending()[0].questions[0].messageId, { skipped: true })
  holder.beginWithdraw(askId)
  assert.notEqual((holder as unknown as RetiredOwn).retire?.(askId, { withdrawn: 1, tellAsker: true }) ?? 'missing', 'missing')
  return askId
}

test('gaps after #284, gap 1, on the daemon\'s own code: a tell whose send failed on the tick is sent again on the next, then never again', () =>
  withAskFile(async (filePath) => {
    const r = rig({ filePath })
    const askId = await retiredForThePassiveAsker(r, filePath)
    r.failNotifications(1)
    for (let i = 0; i < 4; i++) {
      r.advance(5_000)
      r.heartbeatAskTracker()
      await r.settle()
    }
    const tries = r.notes.filter((n) => n.params.meta.event_type === 'ask_withdrawn')
    assert.equal(tries.length, 2, 'the failed send, then the one that landed')
    assert.ok(tries.every((n) => n.params.meta.ask_id === askId))
    assert.match(r.logs.join('\n'), /telling this session failed/)
  }))

test('gaps after #284, gap 1, on the daemon\'s own code: the passive asker whose channel is not loaded sends nothing on its tick, and its next tool result carries its one ask_withdrawn', () =>
  withAskFile(async (filePath) => {
    const r = rig({ filePath, channelLoaded: false })
    const askId = await retiredForThePassiveAsker(r, filePath)
    for (let i = 0; i < 3; i++) {
      r.advance(5_000)
      r.heartbeatAskTracker()
      await r.settle()
    }
    assert.deepEqual(r.notes.filter((n) => n.params.meta.event_type === 'ask_withdrawn'), [], 'no channel event: it would be dropped unseen')
    assert.ok(r.withRetiredOwnAskNotes, 'withRetiredOwnAskNotes exists')
    const result = r.withRetiredOwnAskNotes({ content: [{ type: 'text', text: 'sent' }] })
    assert.equal(result.content.length, 2)
    assert.equal(result.content[0].text, 'sent', 'the tool\'s own result first, as it was')
    assert.match(result.content[1].text, new RegExp(`^\\[ask_withdrawn\\] A question card this session posted was retired \\(ask_id=${askId}\\)`))
    r.advance(5_000)
    r.heartbeatAskTracker()
    await r.settle()
    assert.deepEqual(r.withRetiredOwnAskNotes({ content: [{ type: 'text', text: 'again' }] }).content.length, 1, 'once')
    assert.deepEqual(r.notes.filter((n) => n.params.meta.event_type === 'ask_withdrawn'), [])
  }))
