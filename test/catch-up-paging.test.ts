/**
 * The pure half of the catch up walk (lib/poll-core.ts). The daemon half is
 * driven end to end in test/catch-up-after-deploy.e2e.test.ts.
 *
 * The server's rule that shapes all of this: GET chats/:id/messages returns the
 * NEWEST `limit` rows of the range, oldest first (BGOS message.repository.ts,
 * inner ORDER BY m.id DESC LIMIT n). So reading forward with afterId skips the
 * middle, and the only way to reach the cursor is down, with beforeId.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_OLDER_PAGE_LIMIT,
  CHAT_PAGE_DEFAULT_LIMIT,
  advanceCursor,
  buildChatPollRequest,
  buildOlderPagePath,
  firstPollNeedsOlderRows,
  firstReadOwedFrom,
  pageMayHaveOlderRows,
  readNeedsOlderPage,
  selectFirstPollBacklogIds,
  walkOlderPages,
  type FirstPollRow,
} from '../lib/poll-core.js'

const NOW = 1_800_000_000_000
const row = (id: number, sender: string, over: Partial<FirstPollRow> = {}): FirstPollRow => ({
  id,
  sender,
  pendingEmptySystem: false,
  sentDateMs: NOW,
  ...over,
})

// ── The request ──────────────────────────────────────────────────────────────

test('every chat read asks the server whether older rows exist', () => {
  const base = { chatId: '9', userId: 'u', unansweredButtonCount: 0 }
  assert.equal(buildChatPollRequest({ ...base, lastSeen: 0 }).path, 'chats/9/messages?userId=u&withPagination=1')
  assert.equal(buildChatPollRequest({ ...base, lastSeen: 5 }).path, 'chats/9/messages?userId=u&afterId=5&withPagination=1')
  assert.equal(
    buildChatPollRequest({ ...base, lastSeen: 5, forceFull: true }).path,
    'chats/9/messages?userId=u&withPagination=1',
  )
})

test('an older page goes down from the page above and stays above the cursor', () => {
  assert.equal(
    buildOlderPagePath({ chatId: '9', userId: 'u', lastSeen: 100, beforeId: 500 }),
    `chats/9/messages?userId=u&beforeId=500&limit=${CHAT_OLDER_PAGE_LIMIT}&afterId=100&withPagination=1`,
  )
})

test('an older page of a first read has no lower bound: afterId 0 is no bound on the server', () => {
  assert.equal(
    buildOlderPagePath({ chatId: '9', userId: 'u', lastSeen: 0, beforeId: 500 }),
    `chats/9/messages?userId=u&beforeId=500&limit=${CHAT_OLDER_PAGE_LIMIT}&withPagination=1`,
  )
})

test('the walk asks for the most the server will give in one page', () => {
  // The server clamps limit to 1..200 (message.repository.ts); the first page
  // takes the default of 50, which is what keeps an idle read flat.
  assert.equal(CHAT_OLDER_PAGE_LIMIT, 200)
  assert.equal(CHAT_PAGE_DEFAULT_LIMIT, 50)
})

// ── Is there anything older? ─────────────────────────────────────────────────

test('the server\'s hasMore is believed in both directions', () => {
  assert.equal(pageMayHaveOlderRows({ rowCount: 50, hasMore: false, limit: 50 }), false, 'exactly full, nothing older')
  assert.equal(pageMayHaveOlderRows({ rowCount: 3, hasMore: true, limit: 50 }), true)
})

test('with no hasMore (a backend from before #700) a full page may have more and a short one does not', () => {
  assert.equal(pageMayHaveOlderRows({ rowCount: 50, limit: 50 }), true)
  assert.equal(pageMayHaveOlderRows({ rowCount: 49, limit: 50 }), false)
  assert.equal(pageMayHaveOlderRows({ rowCount: 200, hasMore: 'yes', limit: 200 }), true, 'only a boolean is an answer')
})

// ── With a cursor: walk until the cursor is reached ──────────────────────────

test('with a cursor the walk goes on until the rows touch it', () => {
  const need = (oldestId: number, lastSeen: number) =>
    readNeedsOlderPage({ mayHaveOlder: true, oldestId, lastSeen, firstRead: null })
  assert.equal(need(102, 100), true, 'row 101 is still unread')
  assert.equal(need(101, 100), false, 'the next row above the cursor is in hand')
  assert.equal(need(60, 100), false, 'a full read that reaches below the cursor is done')
})

test('hasMore alone never walks past the cursor: a long chat with an idle cursor costs one read', () => {
  // A full read (boot, or open buttons) of a chat with years of history always
  // says hasMore. Only the rows above the cursor are owed.
  assert.equal(readNeedsOlderPage({ mayHaveOlder: true, oldestId: 951, lastSeen: 1000, firstRead: null }), false)
})

test('nothing older means no walk, whatever the cursor', () => {
  assert.equal(readNeedsOlderPage({ mayHaveOlder: false, oldestId: 500, lastSeen: 100, firstRead: null }), false)
})

// ── Without a cursor: walk only as far as the selection could use ────────────

const firstRead = (rows: FirstPollRow[], over: Partial<Parameters<typeof firstPollNeedsOlderRows>[0]> = {}) =>
  firstPollNeedsOlderRows({ rows, recentCutoffMs: null, historyCap: null, ...over })

test('a first read with no reply in hand keeps walking: older rows are owed', () => {
  assert.equal(firstRead([row(1, 'user'), row(2, 'user')]), true)
})

test('a first read stops at a real reply: everything older was handled', () => {
  assert.equal(firstRead([row(1, 'user'), row(2, 'assistant'), row(3, 'user')]), false)
})

test('an agent row with nothing known under it is not a reply yet: the next page says', () => {
  assert.equal(firstRead([row(2, 'assistant'), row(3, 'user')]), true)
})

test('a proactive agent row does not stop the walk', () => {
  assert.equal(firstRead([row(1, 'assistant'), row(2, 'assistant'), row(3, 'user')]), true)
})

test('a first read reaching rows below the first run gate stops: dormant history is not walked', () => {
  const recentCutoffMs = NOW - 1000
  assert.equal(firstRead([row(1, 'user', { sentDateMs: NOW - 5000 }), row(2, 'user')], { recentCutoffMs }), false)
  assert.equal(firstRead([row(1, 'user', { sentDateMs: null }), row(2, 'user')], { recentCutoffMs }), false, 'unknown age is not recent')
  assert.equal(firstRead([row(1, 'user'), row(2, 'user')], { recentCutoffMs }), true, 'all recent, keep going')
})

test('a group\'s first read stops once its history cap is full, and only then', () => {
  const historyCap = { beforeMs: NOW + 1, max: 3 }
  assert.equal(firstRead([row(1, 'user'), row(2, 'user')], { historyCap }), true, 'two of three')
  assert.equal(firstRead([row(1, 'user'), row(2, 'user'), row(3, 'user')], { historyCap }), false, 'three of three')
})

test('rows from the group\'s listing on are not history and never fill its cap', () => {
  const historyCap = { beforeMs: NOW, max: 2 }
  const rows = [row(1, 'user'), row(2, 'user'), row(3, 'user'), row(4, 'user')]
  assert.equal(firstRead(rows, { historyCap }), true, 'all sent from the listing on')
})

test('an empty wake card neither stops the walk nor counts', () => {
  const historyCap = { beforeMs: NOW + 1, max: 1 }
  assert.equal(firstRead([row(1, 'system', { pendingEmptySystem: true })], { historyCap }), true)
})

test('no rows below what is owed means keep walking: the owed rows may start below this page', () => {
  assert.equal(firstRead([]), true)
})

test('the walk\'s stop agrees with the selection: it stops exactly where more rows change nothing', () => {
  // Whatever the walk leaves unread must be something the selection would not
  // have taken anyway, or the stop would be a loss.
  const shapes: Array<{ rows: FirstPollRow[]; older: FirstPollRow[]; opts: { recentCutoffMs: number | null; historyCap: { beforeMs: number; max: number } | null } }> = [
    { rows: [row(5, 'user'), row(6, 'assistant'), row(7, 'user')], older: [row(4, 'user')], opts: { recentCutoffMs: null, historyCap: null } },
    {
      rows: [row(5, 'user', { sentDateMs: NOW - 5000 }), row(6, 'user')],
      older: [row(4, 'user', { sentDateMs: NOW - 6000 })],
      opts: { recentCutoffMs: NOW - 1000, historyCap: null },
    },
    { rows: [row(5, 'user'), row(6, 'user')], older: [row(4, 'user')], opts: { recentCutoffMs: null, historyCap: { beforeMs: NOW + 1, max: 2 } } },
  ]
  for (const { rows, older, opts } of shapes) {
    assert.equal(firstPollNeedsOlderRows({ rows, ...opts }), false)
    assert.deepEqual(
      selectFirstPollBacklogIds({ rows: [...older, ...rows], ...opts }),
      selectFirstPollBacklogIds({ rows, ...opts }),
      'the unread older row changes nothing',
    )
  }
})

test('a first read defers to the rule above through readNeedsOlderPage', () => {
  const opts = { recentCutoffMs: null, historyCap: null }
  assert.equal(
    readNeedsOlderPage({ mayHaveOlder: true, oldestId: 5, lastSeen: 0, firstRead: { rows: [row(5, 'user')], ...opts } }),
    true,
  )
  assert.equal(
    readNeedsOlderPage({ mayHaveOlder: false, oldestId: 5, lastSeen: 0, firstRead: { rows: [row(5, 'user')], ...opts } }),
    false,
  )
})

test('what a first read owes starts at the live floor, or just above a cursor another read moved', () => {
  assert.equal(firstReadOwedFrom({ liveFloor: undefined, cursorNow: 0 }), Number.POSITIVE_INFINITY)
  assert.equal(firstReadOwedFrom({ liveFloor: 40, cursorNow: 0 }), 40)
  assert.equal(firstReadOwedFrom({ liveFloor: undefined, cursorNow: 40 }), 41)
  assert.equal(firstReadOwedFrom({ liveFloor: 90, cursorNow: 40 }), 41)
  assert.equal(firstReadOwedFrom({ liveFloor: 20, cursorNow: 40 }), 20)
})

// ── The walk ─────────────────────────────────────────────────────────────────

type Row = { id: number }

/** The real rule: newest `limit` of the rows below beforeId, oldest first. */
function serverWalk(allIds: number[], limit: number) {
  const calls: number[] = []
  return {
    calls,
    fetchOlder: async (beforeId: number) => {
      calls.push(beforeId)
      const below = allIds.filter((id) => id < beforeId)
      const rows = below.slice(-limit).map((id) => ({ id }))
      return { rows, mayHaveOlder: below.length > limit }
    },
  }
}

const run = (rows: Row[], mayHaveOlder: boolean, over: Partial<Parameters<typeof walkOlderPages<Row>>[0]> = {}) => {
  const during: string[] = []
  const noProgress: number[] = []
  const done = walkOlderPages<Row>({
    rows,
    mayHaveOlder,
    idOf: (r) => r.id,
    needsOlder: (_held, more) => more,
    fetchOlder: async () => ({ rows: [], mayHaveOlder: false }),
    during: async (work) => {
      during.push('start')
      try {
        return await work()
      } finally {
        during.push('end')
      }
    },
    onNoProgress: (beforeId) => noProgress.push(beforeId),
    ...over,
  })
  return { done, during, noProgress }
}

test('a read the first page finishes costs nothing more and never starts the keepalive', async () => {
  const fetchOlder = async () => assert.fail('no older page is due')
  const { done, during } = run([{ id: 1 }, { id: 2 }], false, { fetchOlder })
  assert.deepEqual(await done, [{ id: 1 }, { id: 2 }])
  assert.deepEqual(during, [])
})

test('the walk returns every row once, oldest first, however many pages', async () => {
  const all = Array.from({ length: 1234 }, (_, i) => i + 1)
  const server = serverWalk(all, 200)
  const first = all.slice(-50).map((id) => ({ id }))
  const { done, during } = run(first, true, { fetchOlder: server.fetchOlder })
  assert.deepEqual((await done).map((r) => r.id), all)
  assert.equal(server.calls[0], all[all.length - 50], 'the first older page starts under the first page')
  assert.deepEqual(during, ['start', 'end'], 'the keepalive wraps the whole walk, once')
})

test('a row the server repeats on an older page is taken once', async () => {
  const pages = [{ rows: [{ id: 9 }, { id: 10 }], mayHaveOlder: false }]
  const { done } = run([{ id: 10 }, { id: 11 }], true, { fetchOlder: async () => pages.shift()! })
  assert.deepEqual((await done).map((r) => r.id), [9, 10, 11])
})

test('rows out of order on the first page do not fool the walk', async () => {
  const seen: number[] = []
  const { done } = run([{ id: 11 }, { id: 10 }], true, {
    fetchOlder: async (beforeId) => {
      seen.push(beforeId)
      return { rows: [], mayHaveOlder: false }
    },
  })
  assert.deepEqual((await done).map((r) => r.id), [10, 11])
  assert.deepEqual(seen, [10])
})

test('the stop rule decides over every row held so far', async () => {
  const held: number[][] = []
  const server = serverWalk([1, 2, 3, 4, 5, 6], 2)
  const { done } = run([{ id: 5 }, { id: 6 }], true, {
    fetchOlder: server.fetchOlder,
    needsOlder: (rows) => {
      held.push(rows.map((r) => r.id))
      return rows[0]!.id > 3
    },
  })
  assert.deepEqual((await done).map((r) => r.id), [3, 4, 5, 6])
  assert.deepEqual(held, [[5, 6], [3, 4, 5, 6]])
})

test('a server that ignores beforeId cannot spin the walk: it stops, says so, and keeps what it has', async () => {
  let calls = 0
  const { done, noProgress } = run([{ id: 10 }, { id: 11 }], true, {
    fetchOlder: async () => {
      // Fail, not hang, if the guard is ever gone.
      if (++calls > 3) throw new Error('the walk is spinning')
      return { rows: [{ id: 10 }, { id: 11 }], mayHaveOlder: true }
    },
  })
  assert.deepEqual((await done).map((r) => r.id), [10, 11])
  assert.equal(calls, 1)
  assert.deepEqual(noProgress, [10])
})

test('an empty page that still claims more cannot spin the walk either', async () => {
  let calls = 0
  const { done, noProgress } = run([{ id: 10 }], true, {
    fetchOlder: async () => {
      if (++calls > 3) throw new Error('the walk is spinning')
      return { rows: [], mayHaveOlder: true }
    },
  })
  assert.deepEqual((await done).map((r) => r.id), [10])
  assert.equal(calls, 1)
  assert.deepEqual(noProgress, [10])
})

test('an empty last page is the normal end, not a failure to progress', async () => {
  const { done, noProgress } = run([{ id: 10 }], true, { fetchOlder: async () => ({ rows: [], mayHaveOlder: false }) })
  await done
  assert.deepEqual(noProgress, [])
})

test('a failed older page fails the walk: nothing is handed on and the keepalive ends', async () => {
  const { done, during } = run([{ id: 10 }], true, {
    fetchOlder: async () => {
      throw new Error('GET 503')
    },
  })
  await assert.rejects(done, /GET 503/)
  assert.deepEqual(during, ['start', 'end'])
})

// ── One read can now be very long ────────────────────────────────────────────

test('the cursor advance survives a read larger than a spread can carry', () => {
  // Math.min(...ids) throws RangeError past the engine's argument limit: about
  // 125 thousand under node, and a million under bun (measured on 1.3.14).
  const pendingEmptyIds = Array.from({ length: 1_500_000 }, (_, i) => 2_000_000 - i)
  assert.equal(advanceCursor({ lastSeen: 1, maxId: 3_000_000, pendingEmptyIds }), 500_000)
})
