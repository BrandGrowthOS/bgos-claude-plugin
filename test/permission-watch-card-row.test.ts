/**
 * The fallback watch reads a card's row id with the one row id reading.
 *
 * The card post, the poll's click and the stream's click read a row id with
 * parseCardRowId: a positive safe integer, or the same number in decimal
 * digits. The watch that reads the card back off the chat history reads it
 * the same way (isPermissionCardRow) for page membership, the anchored read,
 * the expiry and the answer, so a history that carries ids as decimal
 * strings finds the owner's answer on the first read, as a numeric one does.
 *
 * Run with: npx tsx --test test/permission-watch-card-row.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import * as relay from '../lib/permission-relay.ts'

const SRC = readFileSync('server.ts', 'utf8')
const isCardRow = (relay as Record<string, unknown>).isPermissionCardRow as
  | ((rowId: unknown, cardMessageId: number | null) => boolean)
  | undefined

const CARD = 501
const REQUEST = 'abcde'

interface Row {
  message: {
    id: unknown
    sender: string
    answeredAt?: string | null
    answerPayload?: { callbackData?: string } | null
    approvalMeta?: { expired?: unknown } | null
  }
}

const answered = (id: unknown): Row => ({
  message: {
    id,
    sender: 'assistant',
    answeredAt: '2026-11-27T05:00:00.000Z',
    answerPayload: { callbackData: `ea:once:${REQUEST}` },
  },
})
const expired = (id: unknown): Row => ({
  message: { id, sender: 'assistant', approvalMeta: { expired: true } },
})
const other = (id: unknown): Row => ({ message: { id, sender: 'user' } })

/** The watch as waitForVerdict builds it, on a fake clock. */
async function watch(opts: { page: Row[] | null; card?: Row | null }) {
  assert.ok(isCardRow, 'lib/permission-relay.ts exports isPermissionCardRow')
  let clock = 0
  let reads = 0
  let cardReads = 0
  let retired = 0
  const verdict = await relay.watchPermissionVerdict<Row>({
    requestId: REQUEST,
    timeoutMs: 60_000,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
    log: () => {},
    stillPending: () => true,
    rows: relay.permissionRowsReader<Row>({
      cardMessageId: CARD,
      idOf: (row) => row.message.id,
      page: async () => {
        reads += 1
        return opts.page
      },
      card: async () => {
        cardReads += 1
        const row = opts.card ?? null
        return row && isCardRow!(row.message.id, CARD) ? row : null
      },
    }),
    expiredOn: (row: Row) => isCardRow!(row.message.id, CARD) && relay.isApprovalExpired(row.message as never),
    answeredOn: (row: Row) =>
      isCardRow!(row.message.id, CARD) ? relay.answeredPermissionChoice(row.message as never, REQUEST) : null,
    verdictFrom: () => null,
    retireCard: async () => {
      retired += 1
    },
  } as never)
  return { verdict, reads, cardReads, retired }
}

test('one reading of the row: the bound number matches its digits, nothing else', () => {
  assert.ok(isCardRow, 'lib/permission-relay.ts exports isPermissionCardRow')
  assert.equal(isCardRow!(501, CARD), true)
  assert.equal(isCardRow!('501', CARD), true)
  for (const id of ['0501', ' 501', '501 ', 501.5, '5e2', 502, '502', null, undefined, {}]) {
    assert.equal(isCardRow!(id, CARD), false, `row id ${JSON.stringify(id) ?? String(id)}`)
  }
  assert.equal(isCardRow!(501, null), false, 'no bound card matches no row')
  assert.equal(isCardRow!('501', null), false)
})

test("the owner's answered card ends the request on the first read, whether history carries the id as a number or as digits", async () => {
  for (const id of [CARD, String(CARD)]) {
    const r = await watch({ page: [other(id === CARD ? 499 : '499'), answered(id)] })
    assert.deepEqual(r.verdict, { choice: 'once', via: 'answer' }, `history id ${JSON.stringify(id)}`)
    assert.equal(r.reads, 1, 'one read')
    assert.equal(r.cardReads, 0, 'the page holds the card, so no anchored read is spent')
    assert.equal(r.retired, 0, 'an answered card is not retired')
  }
})

test('off the page, the anchored read finds the card by its digits too', async () => {
  for (const id of [CARD, String(CARD)]) {
    const r = await watch({ page: [other('900')], card: answered(id) })
    assert.deepEqual(r.verdict, { choice: 'once', via: 'answer' }, `anchored id ${JSON.stringify(id)}`)
  }
})

test("the server's expiry on the card is read by its digits too", async () => {
  for (const id of [CARD, String(CARD)]) {
    const r = await watch({ page: [expired(id)] })
    assert.deepEqual(r.verdict, { choice: 'deny', via: 'expired' }, `history id ${JSON.stringify(id)}`)
    assert.equal(r.retired, 0)
  }
})

test("control: another row's answer and expiry are none of this request's business", async () => {
  const r = await watch({ page: [answered('502'), expired(502), answered('0501')] })
  assert.deepEqual(r.verdict, { choice: 'deny', via: 'backstop' })
  assert.equal(r.retired, 1)
})

/**
 * waitForVerdict as server.ts has it, compiled with its collaborators: the
 * real row reader and readers, the history read stubbed. It hands back the
 * watch it built, run on a fake clock.
 */
function serverWatch(history: Row[], anchored: Row | null = null) {
  const waitSource = SRC.slice(SRC.indexOf('async function waitForVerdict('), SRC.indexOf('\n}\n', SRC.indexOf('async function waitForVerdict(')) + 3)
  let captured: any = null
  const js = ts.transpileModule(`${waitSource}\nvoid waitForVerdict('${REQUEST}', '10', ${CARD}, 60000, 'owner', false, undefined, () => true); return null;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const bindings: Record<string, unknown> = {
    chatLastSeen: new Map(), oncePerRow: () => () => true, log: () => {}, USER_ID: 'owner',
    watchPermissionVerdict: (opts: any) => { captured = opts; return new Promise(() => {}) },
    permissionRowsReader: relay.permissionRowsReader, isPermissionCardRow: isCardRow,
    isApprovalExpired: relay.isApprovalExpired, answeredPermissionChoice: relay.answeredPermissionChoice,
    senderUserIdCandidate: relay.senderUserIdCandidate, readTapperUserId: () => null,
    isNotModified: () => false,
    bgosGet: async (path: string) => (path.includes('beforeId=') ? { messages: anchored ? [anchored] : [] } : { messages: history }),
  }
  new Function(...Object.keys(bindings), js)(...Object.values(bindings))
  assert.ok(captured, 'waitForVerdict hands its watch to watchPermissionVerdict')
  let clock = 0
  let retired = 0
  return relay
    .watchPermissionVerdict({
      ...captured,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms },
      retireCard: async () => { retired += 1 },
    })
    .then((verdict) => ({ verdict, retired }))
}

test("server.ts, run: the watch's own arms take the owner's answer and the expiry off a card whose history id is digits", async () => {
  assert.ok(isCardRow, 'lib/permission-relay.ts exports isPermissionCardRow')
  for (const id of [CARD, String(CARD)]) {
    assert.deepEqual((await serverWatch([answered(id)])).verdict, { choice: 'once', via: 'answer' }, `page id ${JSON.stringify(id)}`)
    // Another agent row on the page, so the typed answer lane has nothing to read.
    assert.deepEqual((await serverWatch([{ message: { id: '900', sender: 'assistant' } }], answered(id))).verdict, { choice: 'once', via: 'answer' }, `anchored id ${JSON.stringify(id)}`)
    assert.deepEqual((await serverWatch([expired(id)])).verdict, { choice: 'deny', via: 'expired' }, `expired id ${JSON.stringify(id)}`)
  }
  const control = await serverWatch([answered('502'), expired('502')])
  assert.deepEqual(control.verdict, { choice: 'deny', via: 'backstop' }, "another row's answer is not this card's")
  assert.equal(control.retired, 1)
})

test('server.ts: the watch reads its card with the one row reading on every arm', () => {
  const body = SRC.slice(SRC.indexOf('async function waitForVerdict('), SRC.indexOf('verdictFrom: (msg) =>', SRC.indexOf('async function waitForVerdict(')))
  assert.ok(body.length > 0)
  assert.ok((body.match(/isPermissionCardRow\(/g) ?? []).length >= 3, 'the anchored read, the expiry and the answer')
  assert.doesNotMatch(body, /\.id === cardMessageId/, 'no raw comparison of a history id with the bound number')
})
