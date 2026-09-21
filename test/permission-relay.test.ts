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
import { readFileSync } from 'node:fs'

import {
  APPROVAL_TOOL_MAX_CHARS,
  APPROVAL_WAIT_MAX_SECONDS,
  DEFAULT_APPROVAL_WAIT_SECONDS,
  PERMISSION_CLICK_RE,
  buildPermissionRequestBody,
  cardMessageIdFrom,
  choiceToBehavior,
  isApprovalExpired,
  parseApprovalWaitSeconds,
  parsePermissionChoice,
  parsePermissionClick,
  permissionApprovalOptions,
  permissionBackstopMs,
  permissionCardText,
  permissionWaitSeconds,
  resolvePermissionClick,
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
    waitSeconds: 600,
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
    wait_seconds: 600,
  })
  assert.equal(body.chatId, 42)
  assert.equal(body.sender, 'assistant')
  assert.equal(body.text, 'Run the migration against the staging database')
  // The route resolves the author from the credential; a stray assistantId is
  // the unknown field the backend's whitelist shadow log caught in July.
  assert.equal('assistantId' in body, false)
})

test('the card ALWAYS carries a wait, because sending none is the shortest wait of all', () => {
  // The trap this pins, found in review. Sending no `wait_seconds` is not
  // "leave it as it was": the server then applies its generic
  // APPROVAL_TIMEOUT_SECONDS of 60 s and refuses the owner's tap by the flag,
  // so a thin read would have made the window SHORTER than the 120 s local
  // clock this whole change replaced. So a read that gives nothing sends the
  // longest this daemon can hold its own side open instead, which is also
  // exactly what a plugin is told to send when the server does the deciding.
  assert.equal(permissionWaitSeconds(600), 600)
  assert.equal(permissionWaitSeconds(null), APPROVAL_WAIT_MAX_SECONDS)
  assert.equal(permissionWaitSeconds(undefined), APPROVAL_WAIT_MAX_SECONDS)
  assert.ok(APPROVAL_WAIT_MAX_SECONDS > DEFAULT_APPROVAL_WAIT_SECONDS)

  const withWait = buildPermissionRequestBody({
    chatId: 1,
    requestId: REQ,
    toolName: 'Bash',
    description: 'ask',
    waitSeconds: permissionWaitSeconds(600),
  }) as { approvalMeta: Record<string, unknown> }
  assert.equal(withWait.approvalMeta.wait_seconds, 600)

  const thinRead = buildPermissionRequestBody({
    chatId: 1,
    requestId: REQ,
    toolName: 'Bash',
    description: 'ask',
    waitSeconds: permissionWaitSeconds(null),
  }) as { approvalMeta: Record<string, unknown> }
  assert.equal(thinRead.approvalMeta.wait_seconds, APPROVAL_WAIT_MAX_SECONDS)

  // And the daemon itself resolves the read through that helper rather than
  // handing the raw answer to the card, which is the one way the "send
  // nothing" behaviour could come back.
  assert.match(SRC, /permissionWaitSeconds\(await fetchApprovalWaitSeconds\(\)\)/)
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
    waitSeconds: 600,
  }) as { approvalMeta: { tool: string } }
  assert.equal(withPreview.approvalMeta.tool, 'rm -rf build')

  const blankPreview = buildPermissionRequestBody({
    chatId: 1,
    requestId: REQ,
    toolName: 'Bash',
    description: 'ask',
    inputPreview: '   ',
    waitSeconds: 600,
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
    waitSeconds: 600,
  }) as { approvalMeta: { tool: string } }
  assert.equal(huge.approvalMeta.tool.length, APPROVAL_TOOL_MAX_CHARS)
  // AND IT SAYS SO. The command panel is always visible precisely so a person
  // can see what they are allowing, and a silent prefix reads as a complete,
  // shorter command: the owner would approve a tail they never saw.
  assert.ok(huge.approvalMeta.tool.endsWith('...'))
})

// ── The owner's wait ─────────────────────────────────────────────────────────

test('the per agent wait is read only when it is a whole number in the server range', () => {
  assert.equal(parseApprovalWaitSeconds({ approvalWaitSeconds: 600 }), 600)
  assert.equal(parseApprovalWaitSeconds({ approvalWaitSeconds: 60 }), 60)
  assert.equal(parseApprovalWaitSeconds({ approvalWaitSeconds: 1800 }), 1800)

  // Everything a thin read can hand back reads as "no preference", and what a
  // request with no preference waits is permissionWaitSeconds' job, pinned in
  // its own test above.
  assert.equal(parseApprovalWaitSeconds({ approvalWaitSeconds: 59 }), null)
  assert.equal(parseApprovalWaitSeconds({ approvalWaitSeconds: 1801 }), null)
  assert.equal(parseApprovalWaitSeconds({ approvalWaitSeconds: 600.5 }), null)
  assert.equal(parseApprovalWaitSeconds({ approvalWaitSeconds: '600' }), null)
  assert.equal(parseApprovalWaitSeconds({ approvalWaitSeconds: null }), null)
  assert.equal(parseApprovalWaitSeconds({}), null)
  assert.equal(parseApprovalWaitSeconds(null), null)
  assert.equal(parseApprovalWaitSeconds('nonsense'), null)
})

test('the backstop sits behind the owner wait, never in front of it', () => {
  assert.equal(permissionBackstopMs(600), (600 + 90) * 1000)
  // Read off the SAME number the card carries, so the two can never disagree
  // about how long this request lives.
  assert.equal(
    permissionBackstopMs(permissionWaitSeconds(null)),
    (APPROVAL_WAIT_MAX_SECONDS + 90) * 1000,
  )
  // The one property that matters: later than the server's own deadline.
  assert.ok(permissionBackstopMs(1800) > 1800 * 1000)
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
  logs: string[]
} {
  let clock = 0
  let retired = 0
  let polled = 0
  let slept = 0
  let pending = true
  const logs: string[] = []
  const polls = [...opts.polls]
  const run = () =>
    watchPermissionVerdict<FakeRow>({
      requestId: REQ,
      timeoutMs: opts.timeoutMs ?? 10_000,
      pollIntervalMs: 1500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
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
  return { run, retired: () => retired, polled: () => polled, logs }
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

test('a retire that fails still denies, it is best effort', async () => {
  const logs: string[] = []
  let clock = 0
  const verdict = await watchPermissionVerdict<FakeRow>({
    requestId: REQ,
    timeoutMs: 3000,
    pollIntervalMs: 1500,
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

test('the daemon no longer runs a clock of its own', () => {
  const handler = SRC.slice(
    SRC.indexOf('mcp.setNotificationHandler(PermissionRequestSchema'),
    SRC.indexOf('async function waitForVerdict('),
  )
  // The hard coded 120 s wait was the whole bug: it declared a decline while
  // the owner's card was still answerable.
  assert.equal(handler.includes('120_000'), false)
  assert.ok(handler.includes('permissionBackstopMs('))
  // And the card goes to the messages route, which is the one that carries a
  // message type and an approvalMeta at all.
  assert.match(handler, /bgosPost\(\s*'messages',/)
  assert.equal(/bgosPost\(\s*'send-message'/.test(handler), false)
  assert.ok(handler.includes('buildPermissionRequestBody({'))
})
