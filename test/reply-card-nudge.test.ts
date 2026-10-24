/**
 * THE REPLY TOOL NAMES A CARD WHEN THE REPLY WAS CARD SHAPED (server.ts, the
 * reply case, and lib/reply-card-shape.ts).
 *
 * After a reply is sent, and only on a daemon that declares ui_card, a card
 * shaped reply (an email draft, a table, a status list, a comparison) gets ONE
 * line appended to the tool result, never to the message: at most once per
 * chat per 30 minutes. The send itself is never blocked, delayed or changed.
 *
 * WHY THIS RUNS THE REAL CODE OUT OF server.ts. server.ts cannot be imported
 * without booting a daemon, so, as test/peer-403-loop.test.ts does, the
 * harness lifts the reply case of the tool switch, transpiles it, and runs it
 * against stubs, with bgosPost capturing the exact bytes of every send. On
 * code without the nudge the same harness lifts the same case and the line
 * never comes.
 *
 * Run with: npx tsx --test test/reply-card-nudge.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Absent on code without the nudge, which is exactly what the red run needs.
const shapes: Record<string, unknown> = await import('../lib/reply-card-shape.ts').catch(() => ({}))

const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const START = Date.UTC(2026, 9, 25, 9, 0, 0)
const MINUTE = 60_000
const LINE_START = 'This reply would read better as a card'

const EMAIL_DRAFT = [
  'Here is the draft for Sarah, ready to paste:',
  '',
  '```',
  'To: sarah.lee@pjprestaurants.com',
  'Cc: ahmad@pjprestaurants.com',
  'Subject: October LTO results and the November plan',
  '',
  'Hi Sarah,',
  '',
  'The October LTO closed at 4.2 percent over plan across the 38 stores, with the',
  'strongest lift in the Dubai cluster. I have attached the store level sheet.',
  '',
  'For November I suggest we keep the same price point and move the spend to',
  'delivery apps. Can we review on Tuesday?',
  '',
  'Best,',
  'Kc',
  '```',
].join('\n')

const TABLE = [
  'Here is how the four regions did last week against plan:',
  '',
  '| Region | Sales | Plan | Variance |',
  '| --- | ---: | ---: | ---: |',
  '| Dubai | 412,300 | 398,000 | +3.6% |',
  '| Abu Dhabi | 221,950 | 230,000 | -3.5% |',
  '| Sharjah | 133,400 | 128,000 | +4.2% |',
  '| Northern Emirates | 87,120 | 90,500 | -3.7% |',
  '',
  'Dubai and Sharjah carried the week; Abu Dhabi is down on delivery.',
].join('\n')

const PROSE = 'Done. The sheet is updated and I sent the link to Ahmad. Anything else?'

/** The reply case of the tool switch, wrapped in a function of its own. */
function liftReplyCase(): string {
  const start = SERVER.indexOf("\n    case 'reply': {")
  const end = SERVER.indexOf("\n    case 'propose_plan': {", start)
  assert.ok(start > 0 && end > start, 'the reply case exists')
  return `async function replyTool(rawArgs) {\n  switch ('reply') {\n${SERVER.slice(start + 1, end)}\n  }\n}\n`
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

interface Harness {
  reply(chatId: string, text: string): Promise<ToolResult>
  advance(ms: number): void
  /** Exact bytes of every send-message body, in order. */
  sent: string[]
  logs: string[]
}

function harness(opts: {
  declared: () => readonly string[]
  failSend?: boolean
  peerChats?: string[]
}): Harness {
  const js = ts.transpileModule(liftReplyCase(), {
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

  const sent: string[] = []
  const logs: string[] = []
  const recorder: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : recorder),
    apply: () => undefined,
  })
  const Nudges = shapes.ReplyCardNudges as (new (o: { now: () => number }) => unknown) | undefined
  const known: Record<string, unknown> = {
    ...shapes,
    Date: FakeDate,
    log: (line: string) => logs.push(line),
    ASSISTANT_ID: '947',
    resolveAuthorizedChat: (id: string) => ({ ok: true, chatId: id, sessionHandle: undefined }),
    peerReplyRefusedChats: new Set<string>(),
    pendingInbounds: new Map<string, unknown>(),
    meetingIdByChatId: new Map<string, number>(),
    peerConvByChat: new Map((opts.peerChats ?? []).map((c) => [c, 'conv-77'])),
    protectBackslashesForMarkdown: (text: string) => text,
    recentButtonPrompts: new Map<string, unknown>(),
    usageTracker: { collect: () => null },
    peerRefusalOf: () => null,
    bgosPost: async (path: string, body: unknown) => {
      assert.equal(path, 'send-message')
      sent.push(JSON.stringify(body))
      if (opts.failSend) throw new Error('HTTP 500: Internal server error')
      return { message: { id: 9002 } }
    },
    // The gate's own inputs, as a Linux pairing with no tmux target reads them.
    compactTarget: null,
    FLOOR_HOOK: { registered: false },
    laneSupport: () => ({ ok: false, missing: [] }),
    AUTH: { mode: 'pairing' },
    declaredCapabilities: () => opts.declared(),
    ...(Nudges ? { replyCardNudges: new Nudges({ now: () => clock }) } : {}),
  }
  const scope = new Proxy(known, {
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => (typeof key === 'symbol' ? undefined : key in target ? target[key] : recorder),
    set: (target, key, value) => {
      target[key as string] = value
      return true
    },
  })
  // eslint-disable-next-line no-new-func
  const factory = new Function('scope', `with (scope) {\n${js}\nreturn { replyTool }\n}`)
  const lifted = factory(scope) as { replyTool(args: Record<string, unknown>): Promise<ToolResult> }

  return {
    reply: (chatId, text) => lifted.replyTool({ chat_id: chatId, text }),
    advance: (ms) => {
      clock += ms
    },
    sent,
    logs,
  }
}

const DECLARED = () => ['mission_events', 'plan_card', 'ui_card'] as const
const UNDECLARED = () => ['mission_events', 'plan_card'] as const

function textOf(result: ToolResult): string {
  assert.equal(result.content.length, 1, 'one text block')
  return result.content[0].text
}

test('a card shaped reply returns the line once, a second within 30 minutes does not', async () => {
  const h = harness({ declared: DECLARED })

  const first = textOf(await h.reply('33001', EMAIL_DRAFT))
  const [sentLine, nudge, ...rest] = first.split('\n')
  assert.equal(sentLine, 'Sent (message_id: 9002)')
  assert.equal(rest.length, 0, 'exactly ONE line appended')
  assert.ok(nudge.startsWith(LINE_START), nudge)
  assert.ok(nudge.includes('an email draft: a keyvalue block for To, Cc and Subject, then the body'), nudge)
  assert.ok(nudge.includes('show_component with kind ui_card (see Cards you compose in bgos_capabilities)'), nudge)

  h.advance(10 * MINUTE)
  assert.equal(textOf(await h.reply('33001', TABLE)), 'Sent (message_id: 9002)', 'inside the window')
  h.advance(19 * MINUTE)
  assert.equal(textOf(await h.reply('33001', EMAIL_DRAFT)), 'Sent (message_id: 9002)', 'still inside the window')

  h.advance(1 * MINUTE)
  const later = textOf(await h.reply('33001', TABLE))
  assert.ok(later.startsWith('Sent (message_id: 9002)\n'), later)
  assert.ok(later.includes('a table block'), 'past the window the table is named')
  assert.equal(h.sent.length, 4, 'every reply was sent')
})

test('a prose reply returns the plain result', async () => {
  const h = harness({ declared: DECLARED })
  assert.equal(textOf(await h.reply('33001', PROSE)), 'Sent (message_id: 9002)')
})

test('an undeclared daemon never gets the line', async () => {
  const h = harness({ declared: UNDECLARED })
  for (const text of [EMAIL_DRAFT, TABLE, EMAIL_DRAFT]) {
    assert.equal(textOf(await h.reply('33001', text)), 'Sent (message_id: 9002)')
    h.advance(31 * MINUTE)
  }
  assert.equal(h.sent.length, 3)
})

test('the sent message body is byte identical with or without the nudge', async () => {
  const nudged = harness({ declared: DECLARED })
  const plain = harness({ declared: UNDECLARED })

  const withLine = textOf(await nudged.reply('33001', EMAIL_DRAFT))
  const withoutLine = textOf(await plain.reply('33001', EMAIL_DRAFT))
  assert.ok(withLine.includes(LINE_START), 'the declared daemon was nudged')
  assert.ok(!withoutLine.includes(LINE_START), 'the undeclared daemon was not')

  assert.equal(nudged.sent.length, 1)
  assert.equal(plain.sent.length, 1)
  assert.equal(nudged.sent[0], plain.sent[0], 'the same bytes went to send-message')
  assert.equal(JSON.parse(nudged.sent[0]).text, EMAIL_DRAFT, 'the message is the agent text, untouched')
  assert.ok(!nudged.sent[0].includes(LINE_START), 'the line never reaches the message')

  // The throttled second send is the same bytes as the nudged first one too.
  await nudged.reply('33001', EMAIL_DRAFT)
  assert.equal(nudged.sent[1], nudged.sent[0])
})

test('a failed send is not nudged and reads as before', async () => {
  const h = harness({ declared: DECLARED, failSend: true })
  const result = await h.reply('33001', TABLE)
  assert.equal(result.isError, true)
  assert.equal(textOf(result), 'Failed to send: HTTP 500: Internal server error')
})

test('a reply into a peer side thread is never nudged (the reader is an agent)', async () => {
  const h = harness({ declared: DECLARED, peerChats: ['33017'] })
  assert.equal(textOf(await h.reply('33017', TABLE)), 'Sent (message_id: 9002)')
  // And the side thread spent nothing: the owner's chat is still nudged.
  assert.ok(textOf(await h.reply('33001', TABLE)).includes(LINE_START))
})

test('an error deciding the nudge is swallowed and logged, the send result stands', async () => {
  const h = harness({
    declared: () => {
      throw new Error('declared list unreadable')
    },
  })
  assert.equal(textOf(await h.reply('33001', TABLE)), 'Sent (message_id: 9002)')
  assert.equal(h.sent.length, 1)
  assert.ok(h.logs.some((line) => /declared list unreadable/.test(line)), h.logs.join('\n'))
})
