/**
 * The permission relay, now on the platform's approval rail.
 *
 * Every pin here stands for a way the relay was invisible before 0.42.1. The
 * card only renders as a card when the message type, the options and the
 * approvalMeta all arrive together, so those three are pinned as a set; the
 * wait only works when the daemon stops running a clock of its own, so the
 * three endings are pinned on a fake clock; and the callback format is pinned
 * against the sentence the plugin's own offline capability text has always
 * told its agent, which was false until this change.
 *
 * Run with: npx tsx --test test/permission-relay.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import {
  APPROVAL_TOOL_MAX_CHARS,
  PENDING_PERMISSION_FAST_WINDOW_MS,
  PERMISSION_CLICK_RE,
  PERMISSION_HOLD_SECONDS,
  PERMISSION_POLL_FAST_MS,
  PERMISSION_POLL_FAST_WINDOW_MS,
  PERMISSION_POLL_SLOW_MS,
  buildPermissionRequestBody,
  cardMessageIdFrom,
  choiceToBehavior,
  isApprovalExpired,
  parsePermissionChoice,
  parsePermissionClick,
  pendingPermissionFastChatIds,
  permissionApprovalOptions,
  permissionBackstopMs,
  permissionCardText,
  permissionPollIntervalMs,
  permissionRowsReader,
  resolvePermissionClick,
  storedWaitSeconds,
  watchPermissionVerdict,
  type PendingPermissionLike,
  type PermissionChoice,
} from '../lib/permission-relay.ts'
import { BGOS_CAPABILITIES_FALLBACK } from '../lib/capabilities.ts'

const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)

const REQ = 'abcde'

// ── The posted card ──────────────────────────────────────────────────────────

test('the posted body is an approval card: type, two ea: options, approvalMeta', () => {
  const body = buildPermissionRequestBody({
    chatId: '42',
    requestId: REQ,
    toolName: 'Bash',
    description: 'Run the migration against the staging database',
    inputPreview: 'psql -f migrate.sql',
  })

  // The three things the app needs together, or it draws grey chips instead.
  assert.equal(body.messageType, 'approval_request')
  assert.deepEqual(body.options, [
    { text: 'Allow once', callbackData: `ea:once:${REQ}`, style: 'success' },
    { text: 'Deny', callbackData: `ea:deny:${REQ}`, style: 'danger' },
  ])
  assert.deepEqual(body.approvalMeta, {
    tool: 'psql -f migrate.sql',
    agent_route: 'claude-code',
    risk: 'medium',
    request_id: REQ,
    wait_seconds: PERMISSION_HOLD_SECONDS,
  })
  assert.equal(body.chatId, 42)
  assert.equal(body.sender, 'assistant')
  assert.equal(body.text, 'Run the migration against the staging database')
  // The route resolves the author from the credential; a stray assistantId is
  // the unknown field the backend's whitelist shadow log caught in July.
  assert.equal('assistantId' in body, false)
})

test('every card carries the same offer: the longest this daemon can hold', () => {
  // The plugin offers, the server decides. There is no owner setting in this
  // number and no read behind it: it is the longest this daemon keeps its own
  // side open, and the server stores the smaller of it and the agent's
  // `approval_wait_seconds`. Sending nothing instead is not "leave it as it
  // was": the server would apply its generic 60 s, which is SHORTER than the
  // 120 s local clock this whole change removed.
  assert.equal(PERMISSION_HOLD_SECONDS, 1800)

  for (const input of [
    { chatId: 1, requestId: REQ, toolName: 'Bash', description: 'ask' },
    { chatId: 2, requestId: REQ, toolName: 'WebFetch', description: '' },
  ]) {
    const body = buildPermissionRequestBody(input) as {
      approvalMeta: Record<string, unknown>
    }
    assert.equal(body.approvalMeta.wait_seconds, PERMISSION_HOLD_SECONDS)
  }
})

test('the card says the ask in the CLI own words, and names the tool when it is blank', () => {
  assert.equal(permissionCardText('Delete the build cache', 'Bash'), 'Delete the build cache')
  assert.equal(permissionCardText('   ', 'Bash'), 'Claude Code wants to use Bash.')
  assert.equal(permissionCardText(undefined, 'WebFetch'), 'Claude Code wants to use WebFetch.')
})

test('approvalMeta.tool is the input preview when there is one, else the tool name', () => {
  const withPreview = buildPermissionRequestBody({
    chatId: 1,
    requestId: REQ,
    toolName: 'Bash',
    description: 'ask',
    inputPreview: 'rm -rf build',
  }) as { approvalMeta: { tool: string } }
  assert.equal(withPreview.approvalMeta.tool, 'rm -rf build')

  const blankPreview = buildPermissionRequestBody({
    chatId: 1,
    requestId: REQ,
    toolName: 'Bash',
    description: 'ask',
    inputPreview: '   ',
  }) as { approvalMeta: { tool: string } }
  assert.equal(blankPreview.approvalMeta.tool, 'Bash')

  // A runaway preview is capped: this value is a JSONB field the morning
  // report selects out, not only a line in one bubble.
  const huge = buildPermissionRequestBody({
    chatId: 1,
    requestId: REQ,
    toolName: 'Bash',
    description: 'ask',
    inputPreview: 'x'.repeat(APPROVAL_TOOL_MAX_CHARS + 500),
  }) as { approvalMeta: { tool: string } }
  assert.equal(huge.approvalMeta.tool.length, APPROVAL_TOOL_MAX_CHARS)
  // AND IT SAYS SO. The command panel is always visible precisely so a person
  // can see what they are allowing, and a silent prefix reads as a complete,
  // shorter command: the owner would approve a tail they never saw.
  assert.ok(huge.approvalMeta.tool.endsWith('...'))
})

// ── The wait the SERVER stored ───────────────────────────────────────────────

test('the stored wait is read off the created message, and only when it is usable', () => {
  // The server stores the smaller of this daemon's offer and the owner's per
  // agent choice, and hands that number back on the row it just created. It is
  // the only place this daemon ever learns the owner's real wait; it never
  // reads the setting.
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: { wait_seconds: 600 } }), 600)
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: { wait_seconds: 1 } }), 1)
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: { wait_seconds: 1800 } }), 1800)

  // Everything a thin or older response can hand back reads as "not stated",
  // and permissionBackstopMs answers that case with this daemon's own hold.
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: { wait_seconds: 0 } }), null)
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: { wait_seconds: 1801 } }), null)
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: { wait_seconds: 600.5 } }), null)
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: { wait_seconds: '600' } }), null)
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: { wait_seconds: null } }), null)
  assert.equal(storedWaitSeconds({ id: 7, approvalMeta: null }), null)
  assert.equal(storedWaitSeconds({ id: 7 }), null)
  assert.equal(storedWaitSeconds(null), null)
  assert.equal(storedWaitSeconds('600'), null)
})

test('the backstop sits behind the STORED wait, never in front of it', () => {
  assert.equal(permissionBackstopMs(600), (600 + 90) * 1000)
  // A response that did not state one falls back to this daemon's own hold,
  // which is the longest the server could possibly have stored.
  assert.equal(permissionBackstopMs(null), (PERMISSION_HOLD_SECONDS + 90) * 1000)
  // The one property that matters: later than the server's own deadline, on
  // both paths. A backstop in FRONT of the server is the 120 s bug again.
  assert.ok(permissionBackstopMs(600) > 600 * 1000)
  assert.ok(permissionBackstopMs(null) > PERMISSION_HOLD_SECONDS * 1000)
})

test('the poll slows down once a request is clearly parked', () => {
  // A 30 minute request at a flat 1.5 s is about 1,200 looks at the chat, per
  // waiting daemon. The first minute is where an answer usually lands, so it
  // keeps the fast cadence; after that the request is parked and a slower look
  // costs the owner nothing, because the server's expiry is what ends the wait.
  assert.equal(permissionPollIntervalMs(0), PERMISSION_POLL_FAST_MS)
  assert.equal(permissionPollIntervalMs(PERMISSION_POLL_FAST_WINDOW_MS - 1), PERMISSION_POLL_FAST_MS)
  assert.equal(permissionPollIntervalMs(PERMISSION_POLL_FAST_WINDOW_MS), PERMISSION_POLL_SLOW_MS)
  assert.equal(permissionPollIntervalMs(30 * 60_000), PERMISSION_POLL_SLOW_MS)
  // A negative age cannot happen now that the watch takes its elapsed time
  // from performance.now(), and neither branch could busy loop anyway: the
  // slowest thing either one returns is a 1.5 s sleep. It is pinned because
  // the boundary spelling should stay deliberate, not because it defends
  // anything.
  assert.equal(permissionPollIntervalMs(-5_000), PERMISSION_POLL_FAST_MS)

  assert.equal(PERMISSION_POLL_FAST_MS, 1500)
  assert.equal(PERMISSION_POLL_SLOW_MS, 5000)
  assert.equal(PERMISSION_POLL_FAST_WINDOW_MS, 60_000)

  // The number this exists for: the reads a full 30 minute request costs.
  const fast = PERMISSION_POLL_FAST_WINDOW_MS / PERMISSION_POLL_FAST_MS
  const slow = (PERMISSION_HOLD_SECONDS * 1000 - PERMISSION_POLL_FAST_WINDOW_MS) / PERMISSION_POLL_SLOW_MS
  assert.ok(fast + slow < 400, `a parked request should cost far under 1,200 reads, got ${fast + slow}`)
})

test('a pending request stops pinning its chat at 2 s once it is clearly parked', () => {
  // THE SECOND LOOP, and the one the first version of this lane forgot to
  // count. fastScopeChatIds reads the pending map, so an unanswered request
  // holds its chat on the scheduler's base 2 s tick: 900 reads of the same
  // endpoint over half an hour, on top of the watch's own. The button prompt
  // beside it has been bounded since 2026-09-05 for exactly this reason.
  const now = 10 * 60_000
  const pending = [
    { chatId: '7', createdAt: now - 1_000 },
    { chatId: '9', createdAt: now - (PENDING_PERMISSION_FAST_WINDOW_MS - 1) },
    { chatId: '11', createdAt: now - PENDING_PERMISSION_FAST_WINDOW_MS },
    { chatId: '13', createdAt: now - 29 * 60_000 },
  ]
  assert.deepEqual(pendingPermissionFastChatIds(pending, now), ['7', '9'])

  // Two requests in one chat are one chat, and a chat whose only request is
  // parked drops out even while another chat's is fresh.
  assert.deepEqual(
    pendingPermissionFastChatIds(
      [
        { chatId: '7', createdAt: now - 1_000 },
        { chatId: '7', createdAt: now - 20 * 60_000 },
      ],
      now,
    ),
    ['7'],
  )
  // A clock that stepped backwards reads as "not fresh", never as forever.
  assert.deepEqual(pendingPermissionFastChatIds([{ chatId: '7', createdAt: now + 5_000 }], now), [])
  assert.deepEqual(pendingPermissionFastChatIds([], now), [])
  assert.equal(PENDING_PERMISSION_FAST_WINDOW_MS, 10 * 60_000)
})

test('the scheduler fast scope reads the bounded list, not the whole pending map', () => {
  // The bound is worth nothing if the call site still spreads the map. This is
  // the line the reviewer found: it fed every pending request, however old,
  // into fastScopeChatIds.
  assert.ok(
    SRC.includes('pendingPermissionChatIds: pendingPermissionFastChatIds('),
    'the fast scope must be fed the bounded list',
  )
  assert.equal(
    /pendingPermissionChatIds:\s*\[\.\.\.pendingPermissions\.values\(\)\]/.test(SRC),
    false,
    'the unbounded spread must not come back',
  )
})

test('the card id is read off the response, or the server expiry arm is off', () => {
  // Without a numeric id, `expiredOn` can never match and `retireCard` is a no
  // op, so the whole server-is-the-judge arm quietly falls back to the
  // backstop. The daemon has to be able to SAY that, so the id parse is pinned
  // here and the caller logs a warning on null.
  assert.equal(cardMessageIdFrom({ id: 91 }), 91)
  assert.equal(cardMessageIdFrom({ id: 0 }), 0)
  assert.equal(cardMessageIdFrom({ id: '91' }), null)
  assert.equal(cardMessageIdFrom({ id: Number.NaN }), null)
  assert.equal(cardMessageIdFrom({ id: Number.POSITIVE_INFINITY }), null)
  assert.equal(cardMessageIdFrom({ message: { id: 91 } }), null)
  assert.equal(cardMessageIdFrom({}), null)
  assert.equal(cardMessageIdFrom(null), null)
  assert.equal(cardMessageIdFrom('91'), null)
})

// ── Clicks, on both transports and both vocabularies ─────────────────────────

function pendingWith(requesterUserId: string): {
  pending: Map<string, PendingPermissionLike>
  answered: PermissionChoice[]
} {
  const answered: PermissionChoice[] = []
  const pending = new Map<string, PendingPermissionLike>([
    [REQ, { requesterUserId, resolve: (c) => answered.push(c) }],
  ])
  return { pending, answered }
}

test('an ea: click resolves the pending request, allow and deny alike', () => {
  for (const [callbackData, choice, behavior] of [
    [`ea:once:${REQ}`, 'once', 'allow'],
    [`ea:deny:${REQ}`, 'deny', 'deny'],
  ] as const) {
    const { pending, answered } = pendingWith('user-1')
    const outcome = resolvePermissionClick({
      callbackData,
      clickerUserId: 'user-1',
      pending,
    })
    assert.equal(outcome.kind, 'resolved')
    assert.deepEqual(answered, [choice])
    assert.equal(choiceToBehavior(choice), behavior)
    // Resolved entries leave the map, so a replay on the OTHER transport reads
    // as stale rather than resolving a second time.
    assert.equal(pending.has(REQ), false)
  }
})

test('a legacy perm: click from a prompt posted before the update still resolves', () => {
  const { pending, answered } = pendingWith('user-1')
  const outcome = resolvePermissionClick({
    callbackData: `perm:session:${REQ}`,
    clickerUserId: 'user-1',
    pending,
  })
  assert.equal(outcome.kind, 'resolved')
  assert.equal(outcome.kind === 'resolved' ? outcome.vocabulary : null, 'perm')
  assert.deepEqual(answered, ['session'])
  // Every yes still collapses to allow at the CLI boundary.
  assert.equal(choiceToBehavior('session'), 'allow')
})

test('a foreign user click is ignored and the request stays open', () => {
  const { pending, answered } = pendingWith('user-1')
  const outcome = resolvePermissionClick({
    callbackData: `ea:once:${REQ}`,
    clickerUserId: 'someone-else',
    pending,
  })
  assert.equal(outcome.kind, 'foreign')
  assert.deepEqual(answered, [])
  assert.equal(pending.has(REQ), true)
})

test('a click for a request this daemon is not holding reads as stale', () => {
  const { pending, answered } = pendingWith('user-1')
  const outcome = resolvePermissionClick({
    callbackData: 'ea:once:zyxwv',
    clickerUserId: 'user-1',
    pending,
  })
  assert.equal(outcome.kind, 'stale')
  assert.deepEqual(answered, [])
  assert.equal(pending.has(REQ), true)
})

test('an ordinary agent button is not a permission click', () => {
  const { pending } = pendingWith('user-1')
  assert.equal(
    resolvePermissionClick({
      callbackData: 'u:ship-it',
      clickerUserId: 'user-1',
      pending,
    }).kind,
    'not_permission',
  )
  // A foreign approval carrying a UUID (a Codex card, say) is left alone: the
  // id shape is this CLI's, and nothing else mints one like it.
  assert.equal(
    parsePermissionClick('ea:once:9f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8'),
    null,
  )
})

test('both vocabularies pass the single gate the stream intake asks', () => {
  assert.equal(PERMISSION_CLICK_RE.test(`ea:once:${REQ}`), true)
  assert.equal(PERMISSION_CLICK_RE.test(`ea:deny:${REQ}`), true)
  assert.equal(PERMISSION_CLICK_RE.test(`perm:permanent:${REQ}`), true)
  assert.equal(PERMISSION_CLICK_RE.test('u:ship-it'), false)
  assert.equal(PERMISSION_CLICK_RE.test('ea:session:abcde'), false)
})

test('the typed yes / no fallback still answers a request', () => {
  assert.equal(parsePermissionChoice(`yes ${REQ}`, REQ), 'once')
  assert.equal(parsePermissionChoice(`no ${REQ}`, REQ), 'deny')
  assert.equal(parsePermissionChoice(`y ${REQ}`, REQ), 'once')
  assert.equal(parsePermissionChoice('yes zyxwv', REQ), null)
  // And a click replayed as text, in either vocabulary.
  assert.equal(parsePermissionChoice(`ea:deny:${REQ}`, REQ), 'deny')
  assert.equal(parsePermissionChoice(`perm:once:${REQ}`, REQ), 'once')
})

test('a client that echoes the BUTTON LABEL is heard, in the words the app uses now', () => {
  // The label list was written against the four retired `perm:` chips, and the
  // app relabels the two `ea:` codes in its own words, so a client that posts
  // the visible label matched nothing at all after the move: the owner said
  // yes and the request denied itself at the end of the wait.
  assert.equal(parsePermissionChoice('Yes, this once', REQ), 'once')
  assert.equal(parsePermissionChoice('yes, this once', REQ), 'once')
  // The retired labels keep working for one release, same as the vocabulary.
  assert.equal(parsePermissionChoice('Allow once', REQ), 'once')
  assert.equal(parsePermissionChoice('Do not allow', REQ), 'deny')
  // A bare "No" is deliberately NOT a verdict: these texts are also SWALLOWED
  // rather than forwarded to the model, and "no" is an ordinary thing to say
  // to an agent. An unheard No costs nothing anyway, the wait fails closed;
  // an unheard Yes loses the owner's permission, which is why that one is
  // listed. The localised twins are not covered for the same reason: the
  // callbackData path is the real one.
  assert.equal(parsePermissionChoice('no', REQ), null)
  assert.equal(parsePermissionChoice('no thanks, not that one', REQ), null)
})

// ── The wait, and its three endings ──────────────────────────────────────────

interface FakeRow {
  id: number
  approvalMeta?: { expired?: unknown } | null
  verdict?: PermissionChoice
}

function fakeWatch(opts: {
  polls: Array<readonly FakeRow[] | null>
  timeoutMs?: number
  /** The owner answers on the other transport during the Nth sleep. */
  answeredDuringSleep?: number
  /** ... or during the Nth look at the chat, the one before the backstop. */
  answeredDuringPoll?: number
}): {
  run: () => Promise<{ choice: PermissionChoice; via: string }>
  retired: () => number
  polled: () => number
  sleeps: number[]
  logs: string[]
} {
  let clock = 0
  let retired = 0
  let polled = 0
  let slept = 0
  let pending = true
  const logs: string[] = []
  const sleeps: number[] = []
  const polls = [...opts.polls]
  const run = () =>
    watchPermissionVerdict<FakeRow>({
      requestId: REQ,
      timeoutMs: opts.timeoutMs ?? 10_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        sleeps.push(ms)
        slept += 1
        if (slept === opts.answeredDuringSleep) pending = false
      },
      stillPending: () => pending,
      rows: async () => {
        polled += 1
        if (polled === opts.answeredDuringPoll) pending = false
        return polls.shift() ?? []
      },
      expiredOn: (row) => isApprovalExpired(row),
      verdictFrom: (row) => row.verdict ?? null,
      retireCard: async () => {
        retired += 1
      },
      log: (line) => logs.push(line),
    })
  return { run, retired: () => retired, polled: () => polled, sleeps, logs }
}

test('the owner answer ends the wait', async () => {
  const w = fakeWatch({ polls: [null, [{ id: 1 }], [{ id: 2, verdict: 'once' }]] })
  assert.deepEqual(await w.run(), { choice: 'once', via: 'answer' })
  assert.equal(w.retired(), 0)
})

test('an expiry the poll sees denies, because the server is the judge', async () => {
  const w = fakeWatch({
    polls: [[{ id: 1 }], [{ id: 1, approvalMeta: { expired: true } }]],
  })
  assert.deepEqual(await w.run(), { choice: 'deny', via: 'expired' })
  // The server already retired the row; there is nothing left to strip.
  assert.equal(w.retired(), 0)
  assert.ok(w.logs.some((l) => l.includes('the server retired this request')))
})

test('a row whose expiry is anything but true is still open', () => {
  assert.equal(isApprovalExpired({ approvalMeta: { expired: true } }), true)
  assert.equal(isApprovalExpired({ approvalMeta: { expired: false } }), false)
  assert.equal(isApprovalExpired({ approvalMeta: { expired: 'true' } }), false)
  assert.equal(isApprovalExpired({ approvalMeta: null }), false)
  assert.equal(isApprovalExpired({}), false)
  assert.equal(isApprovalExpired(null), false)
})

test('the backstop denies and retires the card nobody is listening to', async () => {
  const w = fakeWatch({ polls: [], timeoutMs: 4500 })
  assert.deepEqual(await w.run(), { choice: 'deny', via: 'backstop' })
  assert.equal(w.retired(), 1)
  assert.ok(w.logs.some((l) => l.includes('local backstop reached')))
})

test('a click on the other transport stops the watch dead', async () => {
  // Found in review, and it is the common case now that a wait can be half an
  // hour: the button click wins the race in server.ts, but this loop knew
  // nothing about it and could not learn. The owner's answer is stamped on the
  // CARD row and writes no user message, so `verdictFrom` never sees it. It
  // would poll on for the whole backstop, then strip the buttons off a card
  // the owner had already answered and log that nobody answered.
  const w = fakeWatch({ polls: [], timeoutMs: 600_000, answeredDuringSleep: 2 })
  assert.deepEqual(await w.run(), { choice: 'deny', via: 'cancelled' })
  assert.equal(w.polled(), 1, 'it stops looking at the chat')
  assert.equal(w.retired(), 0, 'an answered card keeps its buttons')
  assert.deepEqual(w.logs, [], 'and nothing claims the backstop was reached')
})

test('a click during the very last look still keeps the buttons on the card', async () => {
  // The same defect one tick later: the answer lands while the final read is
  // in flight, so the loop falls out of the bottom and would PATCH the options
  // off a card the owner has just answered.
  // The timeout lands exactly on the end of that read, so the loop falls out
  // of the bottom with the answer already in.
  const w = fakeWatch({ polls: [], timeoutMs: 3000, answeredDuringPoll: 2 })
  assert.deepEqual(await w.run(), { choice: 'deny', via: 'cancelled' })
  assert.equal(w.retired(), 0)
  assert.deepEqual(w.logs, [])
})

test('the watch itself slows down, so a parked request is not 1,200 reads', async () => {
  // The cadence has to be IN the loop, not only in the pure function beside
  // it: the whole cost this saves is the loop's own looks at the chat.
  const w = fakeWatch({ polls: [], timeoutMs: 70_000 })
  assert.deepEqual(await w.run(), { choice: 'deny', via: 'backstop' })

  const fastWindow = PERMISSION_POLL_FAST_WINDOW_MS / PERMISSION_POLL_FAST_MS
  assert.deepEqual(
    w.sleeps.slice(0, fastWindow),
    new Array(fastWindow).fill(PERMISSION_POLL_FAST_MS),
    'the first minute keeps the fast cadence, where an answer usually lands',
  )
  assert.deepEqual(
    w.sleeps.slice(fastWindow),
    new Array(w.sleeps.length - fastWindow).fill(PERMISSION_POLL_SLOW_MS),
    'and everything after it is the slow one',
  )
  // A flat fast cadence over the same 70 s would have been 47 looks.
  assert.equal(w.sleeps.length, 42)
  assert.equal(w.polled(), 42)
})

// ── The card the page stopped carrying ───────────────────────────────────────

type CardRow = { message: { id: number } }

function reader(opts: {
  cardMessageId: number | null
  pages: Array<readonly CardRow[] | null>
  card?: CardRow | null
}) {
  const asked: number[] = []
  const pages = [...opts.pages]
  let look = 0
  const read = permissionRowsReader<CardRow>({
    cardMessageId: opts.cardMessageId,
    idOf: (row) => row.message.id,
    page: async () => {
      look += 1
      return pages.shift() ?? null
    },
    card: async () => {
      asked.push(look)
      return opts.card ?? null
    },
  })
  return { read, asked }
}

test('the expiry still arrives after the card falls off the newest 50', async () => {
  // THE READ IS A PAGE, and nothing said so. `chats/<id>/messages` with no
  // cursor is the newest 50 rows, so a card posted into a busy chat (a meeting
  // with several people, or this daemon's own traffic) slides off the page
  // during a wait that now lasts minutes. `expiredOn` can only fire on a row
  // it is handed, so the server could declare the request dead and the watch
  // would sit there until the backstop: the CLI blocked and the update drain
  // held open long after the row was gone.
  const card: CardRow = { message: { id: 100 } }
  const onPage = reader({ cardMessageId: 100, pages: [[card]], card })
  assert.deepEqual(await onPage.read(), [card])
  assert.deepEqual(onPage.asked, [], 'while the card is on the page, nothing extra is read')

  // A 304 before the card has ever left the page is exactly what it says:
  // nothing new in the newest 50, the card among them. Reading the card again
  // on every quiet look would double the cost of the common case.
  const quiet = reader({ cardMessageId: 100, pages: [null, [card]], card })
  assert.deepEqual(await quiet.read(), null)
  assert.deepEqual(await quiet.read(), [card])
  assert.deepEqual(quiet.asked, [])

  const fellOff = reader({
    cardMessageId: 100,
    // The page, then the same chat 60 messages later, then a 304.
    pages: [[card], [{ message: { id: 180 } }], null],
    card,
  })
  assert.deepEqual(await fellOff.read(), [card])
  assert.deepEqual(
    await fellOff.read(),
    [{ message: { id: 180 } }, card],
    'once the card is off the page it is read on its own and handed to the watch',
  )
  // AND IT KEEPS BEING READ. The page's own ETag says "nothing new in the
  // newest 50", which is true and useless: the card is not in them any more,
  // so a 304 there must not end the expiry arm.
  assert.deepEqual(await fellOff.read(), [card])
  assert.deepEqual(fellOff.asked, [2, 3])
})

test('the anchored read is skipped when there is no card to anchor to, and never fabricates rows', async () => {
  // No card id means the whole server-is-the-judge arm is already off
  // (cardMessageIdFrom, above), so there is nothing to read and no reason to
  // spend a request per look finding that out.
  const noId = reader({ cardMessageId: null, pages: [[{ message: { id: 5 } }], null] })
  assert.deepEqual(await noId.read(), [{ message: { id: 5 } }])
  assert.deepEqual(await noId.read(), null)
  assert.deepEqual(noId.asked, [])

  // And a card read that gives nothing back (a 304 on its own validator, or a
  // failed look) leaves the page exactly as it was rather than inventing a row.
  const thin = reader({ cardMessageId: 100, pages: [[{ message: { id: 180 } }], null], card: null })
  assert.deepEqual(await thin.read(), [{ message: { id: 180 } }])
  assert.deepEqual(await thin.read(), null)
  assert.deepEqual(thin.asked, [1, 2])
})

test('a retire that fails still denies, it is best effort', async () => {
  const logs: string[] = []
  let clock = 0
  const verdict = await watchPermissionVerdict<FakeRow>({
    requestId: REQ,
    timeoutMs: 3000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    stillPending: () => true,
    rows: async () => [],
    expiredOn: () => false,
    verdictFrom: () => null,
    retireCard: async () => {
      throw new Error('backend down')
    },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(verdict, { choice: 'deny', via: 'backstop' })
  assert.ok(logs.some((l) => l.includes('could not retire the card')))
})

// ── The relay against the daemon it lives in ─────────────────────────────────

test('the callback format matches the sentence this plugin tells its own agent', () => {
  // lib/capabilities.ts has said this since the canon bootstrap shipped, and
  // it was FALSE here until 0.42.1: the relay spoke perm:. Nothing pinned the
  // two together, so the plugin's own ground truth could lie for months.
  const sentence = 'Approvals use the ea:{choice}:{id} callback format.'
  assert.ok(
    BGOS_CAPABILITIES_FALLBACK.includes(sentence),
    'the bundled capability fallback must still carry the approvals sentence',
  )
  for (const option of permissionApprovalOptions(REQ)) {
    const shape = sentence
      .replace(/^.*?(ea:\{choice\}:\{id\}).*$/, '$1')
      .replace('{choice}', '(once|deny)')
      .replace('{id}', REQ)
    assert.match(option.callbackData, new RegExp(`^${shape}$`))
  }
})

test('auto approve still short circuits before anything is posted', () => {
  const handler = SRC.slice(
    SRC.indexOf('mcp.setNotificationHandler(PermissionRequestSchema'),
    SRC.indexOf('async function waitForVerdict('),
  )
  assert.ok(handler.length > 0)
  const autoBranch = handler.slice(
    handler.indexOf('if (AUTO_APPROVE) {'),
    handler.indexOf('const chatId = monitoredChatIds[0]'),
  )
  assert.ok(autoBranch.includes("behavior: 'allow'"))
  assert.equal(autoBranch.includes('bgosPost'), false)
  assert.ok(/\n\s+return\n/.test(autoBranch), 'auto approve must return, not fall through')
  // The drain check stays in front of everything, auto approve included.
  assert.ok(handler.includes('if (updateDrainMode) {'))
})

test('a request raised during an update drain is DENIED, never left hanging', () => {
  // Found in review. This branch used to `return Promise.resolve()` with no
  // verdict of any kind, so the CLI sat blocked on a request nothing would
  // ever answer and no log said why. Harmless while the local clock was 120 s
  // and the drain could not outlast it by much; not harmless now that a
  // request can hold the drain open for half an hour.
  const handler = SRC.slice(
    SRC.indexOf('mcp.setNotificationHandler(PermissionRequestSchema'),
    SRC.indexOf('async function waitForVerdict('),
  )
  const drainBranch = handler.slice(
    handler.indexOf('if (updateDrainMode) {'),
    handler.indexOf('return trackMessageOperation('),
  )
  assert.ok(drainBranch.length > 0, 'the drain branch must still come first')
  assert.ok(drainBranch.includes("behavior: 'deny'"), 'it must answer the CLI')
  assert.equal(
    handler.includes('if (updateDrainMode) return Promise.resolve()'),
    false,
    'a silent return leaves the CLI blocked for ever',
  )
})

test('the watch owns its own ETag validator, and says when the expiry arm is off', () => {
  const wait = SRC.slice(
    SRC.indexOf('async function waitForVerdict('),
    SRC.indexOf('// ── Tools ──'),
  )
  assert.ok(wait.length > 0)
  // The default cache key is the path, and the ask_user_input wait loop reads
  // the SAME path in the same chat: whichever loop got the 200 recorded the
  // validator and the other one got a 304 and lost that tick. Per request, so
  // two open requests in one chat cannot do it to each other either.
  assert.match(wait, /cacheKey: `perm:\$\{requestId\}`/)
  // And a response with no numeric id disables `expiredOn` and `retireCard`
  // together, which is the whole server-is-the-judge arm going quiet.
  const handler = SRC.slice(
    SRC.indexOf('mcp.setNotificationHandler(PermissionRequestSchema'),
    SRC.indexOf('async function waitForVerdict('),
  )
  assert.ok(handler.includes('cardMessageIdFrom(posted)'))
  assert.ok(
    handler.includes('the server expiry arm is off for this request'),
    'a null card id must be logged as what it costs, not as "message unknown"',
  )
})

test('both click intakes resolve through the one shared helper', () => {
  // They carried a hand copied version of this each, which is how they drifted
  // far enough apart that the stream path needed a log line for "the other
  // one's regex did not re-parse".
  const calls = SRC.match(/resolvePermissionClick\(/g) ?? []
  assert.equal(calls.length, 2)
  assert.ok(SRC.includes('Permission inline-button click'))
  assert.ok(SRC.includes('Permission inline-button click via stream'))
})

/**
 * A `/` at `start` is a regex literal: where does it end, or null if it does
 * not end on this line, which means it was never a regex at all.
 *
 * A character class is tracked because a `/` inside `[...]` does not close the
 * literal, and a `\` escape is skipped because `\/` does not either.
 */
function regexLiteralEnd(source: string, start: number): number | null {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    // A regex literal cannot span a line. If we reach one, this `/` was
    // division after all and the caller must treat it as an ordinary character.
    if (ch === '\n') return null
    if (inClass) {
      if (ch === ']') inClass = false
      i += 1
      continue
    }
    if (ch === '[') {
      inClass = true
      i += 1
      continue
    }
    if (ch === '/') {
      i += 1
      while (i < source.length && /[a-z]/.test(source[i]!)) i += 1
      return i
    }
    i += 1
  }
  return null
}

/** The words after which a `/` begins a regex rather than dividing something. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'void',
  'delete',
  'new',
  'throw',
])

/**
 * Drop comments, keep code, so the guard below can tell a mention from a read.
 * It reports the quote state it finished in, so a file it could not parse
 * fails loudly instead of being half scanned (see the guard).
 *
 * It has to exist because the relay's own comment NAMES the column it must not
 * read (`assistants.approval_wait_seconds`, the thing the server clamps
 * against), and that sentence is the whole explanation of why this daemon only
 * offers.
 *
 * REGEX LITERALS ARE PARSED, and that is not optional, found in review. The
 * first version treated `/` as an ordinary character, so the `['"]` inside
 * lib/secret-scan.ts's own pattern opened a quote that never closed, and five
 * of the 73 lib files finished the scan desynced. After a desync the file is
 * nonsense in both directions: a `//` inside what the parser thinks is code
 * eats a real line, and a comment inside what it thinks is a string is
 * reported as a read. Whether a `/` starts a literal is decided the way every
 * hand written JS lexer decides it: by the token before it.
 */
function stripComments(source: string): { code: string; quote: string | null } {
  let out = ''
  let i = 0
  let quote: string | null = null
  // The last non whitespace character of code emitted, which is the only
  // signal a lexer has for division versus a regex literal.
  let lastSignificant = ''
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      lastSignificant = ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === '/') {
      const word = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(out)
      const divides =
        (/[A-Za-z0-9_$]/.test(lastSignificant) ||
          lastSignificant === ')' ||
          lastSignificant === ']') &&
        !(word && REGEX_PRECEDING_KEYWORDS.has(word[1]!))
      const end = divides ? null : regexLiteralEnd(source, i)
      if (end !== null) {
        // Kept whole rather than dropped: a pattern that names the column
        // would still be a read, and this guard should see it.
        out += source.slice(i, end)
        lastSignificant = '/'
        i = end
        continue
      }
    }
    out += ch
    if (!/\s/.test(ch)) lastSignificant = ch
    i += 1
  }
  return { code: out, quote }
}

test('the comment stripper keeps the reads it is meant to catch', () => {
  // The guard below is only worth anything if this does not swallow code, so
  // it is pinned on its own before it is trusted.
  const code = (source: string) => stripComments(source).code
  assert.equal(code('const x = 1 // reads approvalWaitSeconds\n').includes('approvalWaitSeconds'), false)
  assert.equal(code('/* assistants.approval_wait_seconds */\nconst x = 1').includes('approval_wait_seconds'), false)
  assert.equal(code('const w = data.approvalWaitSeconds').includes('approvalWaitSeconds'), true)
  assert.equal(code("const k = 'approval_wait_seconds' // not a comment").includes('approval_wait_seconds'), true)
  assert.equal(code("const u = 'https://x/y' + a.approvalWaitSeconds").includes('approvalWaitSeconds'), true)

  // The five real files this was getting wrong, in miniature. A regex literal
  // that carries a quote character must not open a string, and a regex that
  // carries a `//` must not start a comment.
  const secretish = `const RE = /(?:key|secret)['"]?\\s*[:=]/i\nconst w = data.approvalWaitSeconds\n`
  assert.equal(stripComments(secretish).quote, null)
  assert.equal(code(secretish).includes('approvalWaitSeconds'), true)
  const urlish = 'const RE = /https:\\/\\/x/ // approvalWaitSeconds\nconst y = a.approval_wait_seconds\n'
  assert.equal(stripComments(urlish).quote, null)
  assert.equal(code(urlish).includes('approvalWaitSeconds'), false)
  assert.equal(code(urlish).includes('approval_wait_seconds'), true)

  // And division still divides. If a `/` after a value were read as the start
  // of a literal, the comment on this line would be swallowed into it and kept
  // as code, which is the false POSITIVE half of the same bug.
  const division = 'const n = total / count // mentions approvalWaitSeconds\nconst w = a.approvalWaitSeconds\n'
  assert.equal(stripComments(division).quote, null)
  assert.equal(code(division).includes('mentions'), false)
  assert.equal(code(division).includes('total / count'), true)
  assert.equal(code(division).includes('a.approvalWaitSeconds'), true)
  // `return /x/` is a regex even though a word sits in front of it.
  assert.equal(stripComments('function f() { return /a["b]/.test(s) }').quote, null)
  // A slash inside a character class does not close the literal. Read as if it
  // did, the quote right after it would open a string that never closes, which
  // is the desync in one line.
  assert.equal(stripComments('const RE = /[/"]/\n').quote, null)
  // And a `/` that is neither a comment nor a regex must not swallow the rest
  // of the file looking for a partner: a literal cannot span a line.
  const afterTemplate = 'const n = `${a}` / 2\nconst w = a.approval_wait_seconds // mentions\n'
  assert.equal(stripComments(afterTemplate).quote, null)
  assert.equal(code(afterTemplate).includes('mentions'), false)
  assert.equal(code(afterTemplate).includes('a.approval_wait_seconds'), true)
})

test('the daemon never reads the owner per agent wait, anywhere', () => {
  // The rule both plugin repos carry: the plugin always sends and the app
  // decides. Wave A broke it for one commit by reading `approvalWaitSeconds`
  // off GET /assistants/:id before every card, which cost a BLOCKED agent a
  // round trip to learn a number the server was about to decide for itself.
  // The scan is case insensitive so `fetchApprovalWaitSeconds` and any
  // SCREAMING_CASE twin of the column name are caught with the plain spelling.
  const libDir = new URL('../lib/', import.meta.url)
  const scanned: Array<{ name: string; code: string; quote: string | null }> = []
  for (const name of readdirSync(libDir)) {
    if (!name.endsWith('.ts') && !name.endsWith('.mjs')) continue
    scanned.push({
      name: `lib/${name}`,
      ...stripComments(readFileSync(new URL(name, libDir), 'utf8')),
    })
  }
  scanned.push({ name: 'server.ts', ...stripComments(SRC) })

  // Non vacuous: a scan that read nothing, or that stripped the code away
  // along with the comments, would pass this test for ever.
  assert.ok(scanned.length > 20, `expected the whole lib tree, scanned ${scanned.length}`)
  // AND EVERY ONE OF THEM PARSED. Found in review: the first stripper ended
  // five of these 73 files still inside a quote, because it walked into a
  // regex literal containing a quote character (lib/secret-scan.ts has
  // `['"]` inside its own pattern). From that point on the file is garbage in
  // both directions, so it could fail on a comment or pass on a real read,
  // and nothing said which files were scanned as nonsense.
  const unparsed = scanned.filter((f) => f.quote !== null).map((f) => `${f.name} (${f.quote})`)
  assert.deepEqual(unparsed, [], `the stripper could not parse these, so this guard did not cover them: ${unparsed}`)
  const relay = scanned.find((f) => f.name === 'lib/permission-relay.ts')
  assert.ok(relay, 'the relay itself must be among the files this read')
  assert.ok(relay.code.includes('export const PERMISSION_HOLD_SECONDS = 1800'))
  assert.ok(relay.code.includes('export function storedWaitSeconds('))
  const daemon = scanned.find((f) => f.name === 'server.ts')
  assert.ok(daemon?.code.includes('buildPermissionRequestBody({'))
  assert.ok(
    scanned.every((f) => f.code.trim().length > 0),
    'an unreadable or fully stripped file must not pass as a clean one',
  )

  const offenders = scanned
    .filter((f) => /approvalwaitseconds|approval_wait_seconds/i.test(f.code))
    .map((f) => f.name)
  assert.deepEqual(offenders, [], `these read an owner setting they must not read: ${offenders}`)
})

test('nothing is awaited between minting the request and posting the card', () => {
  // The read wave A removed sat exactly here, so a blocked agent waited on a
  // settings round trip before its owner could even see the card. Whatever
  // else changes in this handler, the post must be the first thing awaited
  // after the pending entry exists.
  const handler = SRC.slice(
    SRC.indexOf('mcp.setNotificationHandler(PermissionRequestSchema'),
    SRC.indexOf('async function waitForVerdict('),
  )
  // Through the stripper, like the guard above it: this window is mostly
  // comment, and the word "await" is an ordinary thing for a comment about an
  // await to contain. A raw grep here fails on a prose edit that awaits
  // nothing, and the obvious fix for that is to delete the guard.
  const between = stripComments(
    handler.slice(
      handler.indexOf('pendingPermissions.set(request_id,'),
      handler.indexOf('const posted = await bgosPost('),
    ),
  ).code
  assert.ok(
    between.includes('pendingPermissions.set(request_id,') &&
      between.includes('resolve: resolveButtonChoice'),
    'the handler must still mint the request before it posts, and this must be reading its CODE',
  )
  assert.equal(between.includes('await '), false, `nothing may be awaited here: ${between}`)
})

test('the watch anchors on the card itself, and measures the wait on a monotonic clock', () => {
  const watch = SRC.slice(
    SRC.indexOf('async function waitForVerdict('),
    SRC.indexOf('// ── Tools ─'),
  )
  assert.ok(watch.length > 0, 'the watch must still be in server.ts')
  // The page read stays (the typed fallback is read from it) and the expiry
  // stops depending on it.
  assert.ok(watch.includes('rows: permissionRowsReader<ChatMessage>({'))
  assert.ok(
    watch.includes('&beforeId=${cardMessageId + 1}&limit=1'),
    'the card is read on its own, anchored one id above it, one row',
  )
  assert.ok(
    watch.includes("cacheKey: `perm-card:${requestId}`"),
    'and on its own validator, or it shares the page read ETag and loses ticks',
  )
  // A wall clock that steps forward denies a live request. Everything the
  // watch asks this for is a duration, so a monotonic source costs nothing.
  assert.ok(watch.includes('now: () => performance.now()'))
  assert.equal(watch.includes('now: () => Date.now()'), false)
})

test('the daemon no longer runs a clock of its own', () => {
  const handler = SRC.slice(
    SRC.indexOf('mcp.setNotificationHandler(PermissionRequestSchema'),
    SRC.indexOf('async function waitForVerdict('),
  )
  // The hard coded 120 s wait was the whole bug: it declared a decline while
  // the owner's card was still answerable.
  assert.equal(handler.includes('120_000'), false)
  // And the backstop is built from what the SERVER stored on the row it just
  // created, not from anything this daemon decided on its own.
  assert.ok(handler.includes('const storedWait = storedWaitSeconds(posted)'))
  assert.ok(handler.includes('permissionBackstopMs(storedWait)'))
  // And the card goes to the messages route, which is the one that carries a
  // message type and an approvalMeta at all.
  assert.match(handler, /bgosPost\(\s*'messages',/)
  assert.equal(/bgosPost\(\s*'send-message'/.test(handler), false)
  assert.ok(handler.includes('buildPermissionRequestBody({'))
})
