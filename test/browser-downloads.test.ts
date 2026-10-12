/**
 * DOWNLOADS IN THE AGENT'S OWN BROWSER, the rules (HOAI board row 67562770).
 *
 * The desktop app's rules (BGOS #2198), on the plugin's browser host: a
 * download is asked for like any gated action; Deny deletes it; Allow puts it
 * where the ask said; one nobody answers is KEPT for the owner, in an owner
 * only folder that is never synced, the agent reads it as kept and never gets
 * its path, the owner is told the moment it is kept and one tap deletes it,
 * and every kept file is gone after 7 days.
 *
 * The fakes: a Playwright Download is a file in the held folder that grows as
 * <guid>.crdownload and is renamed to <guid> when it finishes, exactly what
 * Chrome was measured doing on this host. The gate is the real GateKeeper
 * against a fake backend the test answers, as in browser-gate.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as fsMod from 'node:fs'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { GateKeeper } from '../lib/browser-gate.mjs'
import {
  CARD_SUMMARY_MAX,
  DOWNLOAD_KEEP_LIMITS,
  DOWNLOAD_KEEP_MS,
  DownloadStore,
  KeptFolderGuard,
  SlotDownloads,
  askSummary,
  cleanFileName,
  downloadLines,
  downloadPaths,
  keptSummary,
  saveName,
  syncedFolderOf,
} from '../lib/browser-downloads.mjs'

const DOWNLOAD_CHOICES = ['allow_once', 'allow_session', 'trust_site', 'deny']

type Card = Record<string, any>

/** A fake HOAI that keeps each card and answers what the test says (browser-gate.test.ts). */
function server() {
  const cards: Card[] = []
  const state = new Map<string, { state: string; choice: string | null }>()
  let accept = true
  return {
    cards,
    refuse(v = true) {
      accept = !v
    },
    answer(gateId: string, choice: string | null, as = 'answered') {
      state.set(gateId, { state: as, choice })
    },
    postCard: async (card: Card) => {
      if (!accept) return false
      cards.push(card)
      state.set(String(card.gateId), { state: 'open', choice: null })
      return true
    },
    readGate: async (gateId: string) => state.get(gateId) ?? { state: 'unknown', choice: null },
  }
}

let ids = 0
function keeper(srv: ReturnType<typeof server>) {
  return new GateKeeper({
    postCard: srv.postCard,
    readGate: srv.readGate,
    randomBytes: (n: number) => Buffer.from(`${++ids}`.padStart(n, 'x')),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 5,
  })
}

const readyGuard = { ready: true, reason: null, prepare: async () => true, verify: () => true }

/** A Playwright Download as this host sees it: a guid file Chrome writes into held/. */
function fakeDownload(held: string, { name = 'AuthKey_7KQ2X9.p8', url = 'https://appstoreconnect.apple.com/keys/1?token=SECRET', pageUrl = 'https://appstoreconnect.apple.com/keys', bytes = 257, finished = true } = {}) {
  mkdirSync(held, { recursive: true })
  const guid = randomUUID()
  const final = join(held, guid)
  const partial = `${final}.crdownload`
  writeFileSync(partial, Buffer.alloc(bytes, 65))
  let settle!: (v: string | null) => void
  const done = new Promise<string | null>((r) => (settle = r))
  let ended = false
  const d = {
    guid,
    final,
    partial,
    cancelled: 0,
    suggestedFilename: () => name,
    url: () => url,
    page: () => ({ url: () => pageUrl }),
    failure: () => done,
    path: () => done.then((f) => (f ? Promise.reject(new Error(f)) : final)),
    cancel: async () => {
      d.cancelled++
      if (ended) return
      ended = true
      rmSync(partial, { force: true })
      settle('canceled')
    },
    _artifact: { _initializer: { absolutePath: final } },
    finish() {
      if (ended) return
      ended = true
      renameSync(partial, final)
      settle(null)
    },
    grow(n: number) {
      appendFileSync(partial, Buffer.alloc(n, 66))
    },
  }
  if (finished) d.finish()
  return d
}

function setup(over: Record<string, any> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dl-unit-'))
  const agentRoot = join(home, '.bgos-agent')
  const srv = server()
  const gates = keeper(srv)
  let t = Date.parse('2026-10-12T08:00:00Z')
  const logs: string[] = []
  const store = new DownloadStore({
    agentRoot,
    assistantId: 900,
    gates,
    deviceLabel: 'box-1',
    home,
    guard: over.guard ?? readyGuard,
    limits: over.limits ?? DOWNLOAD_KEEP_LIMITS,
    now: () => t,
    noticePollMs: 5,
    log: (l: string) => logs.push(l),
    ...(over.fsImpl ? { fsImpl: over.fsImpl } : {}),
  })
  const remembered: Array<{ origin: string | null; choice: string }> = []
  let verdict: any = over.verdict ?? { verdict: 'ask', gate: 'download' }
  let owner = false
  const slot = new SlotDownloads({
    store,
    key: 'owner',
    gates,
    gateKey: join(agentRoot, '900', 'browser', 'owner'),
    context: () => ({ agentName: 'Data', purpose: 'Create an App Store Connect key' }),
    decide: () => verdict,
    remember: (origin: string | null, choice: string) => remembered.push({ origin, choice }),
    ownerControl: () => owner,
    choices: DOWNLOAD_CHOICES,
    graceMs: 60,
    heldPollMs: 10,
    unclaimedAfterMs: over.unclaimedAfterMs ?? 40,
    log: (l: string) => logs.push(l),
    ...(over.fsImpl ? { fsImpl: over.fsImpl } : {}),
  })
  const paths = downloadPaths({ agentRoot, assistantId: 900, key: 'owner' })
  const outputDir = join(agentRoot, '900', 'browser-output', 'owner')
  return {
    home,
    agentRoot,
    srv,
    gates,
    store,
    slot,
    paths,
    outputDir,
    logs,
    remembered,
    setVerdict: (v: any) => (verdict = v),
    setOwner: (v: boolean) => (owner = v),
    advance: (ms: number) => (t += ms),
    now: () => t,
    downloadCards: () => srv.cards.filter((c) => c.kind === 'download'),
    done: () => {
      slot.stop()
      store.stop()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

async function until(ok: () => boolean, what: () => string, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out: ${what()}`)
}

const filesUnder = (dir: string): string[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]))
}

const status = (s: ReturnType<typeof setup>) => downloadLines(s.slot.rows()).join('\n')

// ── The ask ───────────────────────────────────────────────────────────────────

test('a download the page starts is ASKED for, with the desktop download choices, the file name and the site, never the URL', async () => {
  const s = setup()
  try {
    s.slot.onDownload(fakeDownload(s.paths.held))
    await until(() => s.downloadCards().length === 1, () => 'one download card')
    const card = s.downloadCards()[0]!
    assert.deepEqual(card.choices, DOWNLOAD_CHOICES)
    assert.equal(card.origin, 'https://appstoreconnect.apple.com')
    assert.equal(card.waitSeconds, 60, 'a download ask is 60 seconds, whatever wait the click carried')
    assert.match(card.summary, /^download AuthKey_7KQ2X9\.p8 /)
    assert.doesNotMatch(JSON.stringify(card), /token|SECRET|keys\/1/, 'the card names the site, never the URL or its query')
    assert.match(status(s), /AuthKey_7KQ2X9\.p8, 257 B, waiting for your owner's answer/)
  } finally {
    s.done()
  }
})

test('DENY deletes every byte of it and the agent reads "your owner said no"; a Deny is not remembered', async () => {
  const s = setup()
  try {
    const d = fakeDownload(s.paths.held)
    s.slot.onDownload(d)
    await until(() => s.downloadCards().length === 1, () => 'asked')
    s.srv.answer(String(s.downloadCards()[0]!.gateId), 'deny')
    await until(() => /your owner said no/.test(status(s)), () => status(s))
    assert.deepEqual(filesUnder(join(s.agentRoot, '900')).filter((p) => !p.endsWith('downloads.json')), [], 'no file left anywhere in the agent folder')
    assert.deepEqual(s.remembered, [], 'a Deny covers this download only, as the host does for every gate')
  } finally {
    s.done()
  }
})

test('ALLOW lands in the output folder the ask named, under its own name, never over another file, and the agent gets the path', async () => {
  const s = setup()
  try {
    mkdirSync(s.outputDir, { recursive: true })
    writeFileSync(join(s.outputDir, 'billing_q3.csv'), 'an older file')
    s.slot.onDownload(fakeDownload(s.paths.held, { name: 'billing_q3.csv', url: 'https://billing.example.com/q3.csv' }))
    await until(() => s.downloadCards().length === 1, () => 'asked')
    const card = s.downloadCards()[0]!
    assert.ok(card.summary.includes('~/.bgos-agent/900/browser-output/owner'), card.summary)
    s.srv.answer(String(card.gateId), 'allow_session')
    const landed = join(s.outputDir, 'billing_q3 (1).csv')
    await until(() => existsSync(landed), () => `landed: ${filesUnder(s.outputDir)}`)
    assert.equal(readFileSync(join(s.outputDir, 'billing_q3.csv'), 'utf8'), 'an older file', 'never overwrites')
    await until(() => status(s).includes(landed), () => status(s))
    assert.match(status(s), /billing_q3\.csv, 257 B, saved in your browser folder/)
    assert.deepEqual(s.remembered, [{ origin: 'https://billing.example.com', choice: 'allow_session' }], 'Allow for this session is remembered like any gate')
    assert.deepEqual(filesUnder(s.paths.held), [], 'nothing left in the held folder')
  } finally {
    s.done()
  }
})

test('NO ANSWER keeps it for the owner: opaque name in kept/, index, 7 days, never a path to the agent, and the owner is told by a second card', async () => {
  const s = setup()
  try {
    s.slot.onDownload(fakeDownload(s.paths.held))
    await until(() => s.downloadCards().length === 1, () => 'asked')
    const ask = s.downloadCards()[0]!
    assert.match(ask.summary, /If you don't answer, the file is kept for you on box-1/)
    s.srv.answer(String(ask.gateId), null, 'expired')
    await until(() => s.downloadCards().length === 2, () => 'the notice card')
    const notice = s.downloadCards()[1]!
    assert.deepEqual(notice.choices, ['allow_once', 'deny'], 'the notice offers this one file or Delete, and remembers nothing')
    assert.match(notice.summary, /AuthKey_7KQ2X9\.p8.*nobody answered.*kept for you on box-1/)
    assert.match(notice.summary, /Deny deletes it/)
    assert.equal(notice.waitSeconds, 1800)
    const kept = filesUnder(s.paths.kept)
    assert.equal(kept.length, 1)
    assert.match(kept[0]!, /[\\/]kept[\\/][0-9a-f-]{36}$/, 'an opaque name, not the site file name')
    const index = JSON.parse(readFileSync(s.paths.index, 'utf8'))
    const rec = index.records.find((r: any) => r.state === 'kept')
    assert.equal(rec.fileName, 'AuthKey_7KQ2X9.p8')
    assert.equal(rec.keptUntil, s.now() + DOWNLOAD_KEEP_MS)
    assert.equal(rec.keptReason, 'no_answer')
    assert.doesNotMatch(readFileSync(s.paths.index, 'utf8'), /token|SECRET|keys\/1/, 'the index keeps the origin only')
    const text = status(s)
    assert.match(text, /AuthKey_7KQ2X9\.p8, 257 B, kept for your owner \(no answer\)/)
    assert.match(text, /Do not download it again/)
    assert.ok(!text.includes(s.paths.kept) && !text.includes(kept[0]!), 'never a kept path to the agent')
    if (process.platform !== 'win32') assert.equal(statSync(kept[0]!).mode & 0o077, 0, 'owner only file')
    assert.deepEqual(s.remembered, [])
  } finally {
    s.done()
  }
})

test('the notice: Deny deletes the kept file (one tap), Allow gives that one file to the agent, no answer leaves it kept', async () => {
  for (const choice of ['deny', 'allow_once', null] as const) {
    const s = setup()
    try {
      s.slot.onDownload(fakeDownload(s.paths.held))
      await until(() => s.downloadCards().length === 1, () => 'asked')
      s.srv.answer(String(s.downloadCards()[0]!.gateId), null, 'expired')
      await until(() => s.downloadCards().length === 2 && filesUnder(s.paths.kept).length === 1, () => 'kept and told')
      const notice = s.downloadCards()[1]!
      if (choice) s.srv.answer(String(notice.gateId), choice)
      else s.srv.answer(String(notice.gateId), null, 'expired')
      if (choice === 'deny') {
        await until(() => filesUnder(s.paths.kept).length === 0, () => 'deleted')
        await until(() => /deleted by your owner/.test(status(s)), () => status(s))
      } else if (choice === 'allow_once') {
        const landed = join(s.outputDir, 'AuthKey_7KQ2X9.p8')
        await until(() => existsSync(landed), () => 'given')
        assert.deepEqual(filesUnder(s.paths.kept), [])
        await until(() => status(s).includes(landed), () => status(s))
        assert.deepEqual(s.remembered, [], 'the notice never remembers a grant')
      } else {
        await new Promise((r) => setTimeout(r, 60))
        assert.equal(filesUnder(s.paths.kept).length, 1, 'an unanswered notice leaves it kept')
      }
    } finally {
      s.done()
    }
  }
})

test('only an explicit Deny deletes: an answer the host cannot read, a closed host and a lost card all KEEP the file', async () => {
  for (const end of ['unreadable', 'closeAll', 'lost', 'unreachable'] as const) {
    const s = setup()
    try {
      if (end === 'unreachable') s.srv.refuse()
      s.slot.onDownload(fakeDownload(s.paths.held))
      if (end !== 'unreachable') {
        await until(() => s.downloadCards().length === 1, () => 'asked')
        const gateId = String(s.downloadCards()[0]!.gateId)
        if (end === 'unreadable') s.srv.answer(gateId, 'download_later')
        if (end === 'lost') s.srv.answer(gateId, null, 'unknown')
        if (end === 'closeAll') s.gates.closeAll()
      }
      await until(() => filesUnder(s.paths.kept).length === 1, () => `${end}: kept, ${status(s)}`)
      assert.match(status(s), /kept for your owner/, end)
    } finally {
      s.done()
    }
  }
})

test("the owner's rules decide without asking: a session grant or a trusted site saves, a Deny on the site deletes", async () => {
  const s = setup({ verdict: { verdict: 'allow', reason: 'download_granted' } })
  try {
    s.slot.onDownload(fakeDownload(s.paths.held, { name: 'report.pdf', url: 'https://x.example/r.pdf' }))
    await until(() => existsSync(join(s.outputDir, 'report.pdf')), () => status(s))
    s.setVerdict({ verdict: 'deny', reason: 'download_denied' })
    const d = fakeDownload(s.paths.held, { name: 'evil.exe', finished: false })
    s.slot.onDownload(d)
    await until(() => /evil\.exe.*not saved: your owner's rules refuse it/.test(status(s)), () => status(s))
    assert.equal(d.cancelled, 1)
    assert.ok(!existsSync(d.partial) && !existsSync(d.final))
    assert.equal(s.downloadCards().length, 0, 'nobody was asked')
  } finally {
    s.done()
  }
})

test('a blob: or data: download is judged by the page it came from', async () => {
  const s = setup()
  try {
    s.slot.onDownload(fakeDownload(s.paths.held, { name: 'export.csv', url: 'blob:https://app.example.com/1234', pageUrl: 'https://app.example.com/report' }))
    await until(() => s.downloadCards().length === 1, () => 'asked')
    assert.equal(s.downloadCards()[0]!.origin, 'https://app.example.com')
  } finally {
    s.done()
  }
})

// ── Limits ────────────────────────────────────────────────────────────────────

test('LIMITS: a file over the per file limit, the sixth of a session and the 26th of the agent are not kept; no answer deletes them', async () => {
  const limits = { fileBytes: 1000, sessionBytes: 10_000, sessionFiles: 2, totalBytes: 100_000, totalFiles: 3 }
  const s = setup({ limits })
  try {
    const keepOne = async (name: string, bytes = 100) => {
      s.slot.onDownload(fakeDownload(s.paths.held, { name, bytes }))
      const isAsk = (c: Card) => c.summary.startsWith(`download ${name} into`)
      await until(() => s.downloadCards().some(isAsk), () => `asked ${name}`)
      const ask = s.downloadCards().find(isAsk)!
      s.srv.answer(String(ask.gateId), null, 'expired')
      return ask
    }
    const big = await keepOne('big.bin', 5000)
    assert.match(big.summary, /If you don't answer, the file is deleted/, 'a file over the limit is not promised to be kept')
    await until(() => /big\.bin.*not kept: over the 50 MB a kept file may have|big\.bin.*not kept/.test(status(s)), () => status(s))
    await keepOne('one.bin')
    await keepOne('two.bin')
    await until(() => filesUnder(s.paths.kept).length === 2, () => status(s))
    const third = await keepOne('three.bin')
    assert.match(third.summary, /the file is deleted/, 'the session already keeps as many as it may')
    await until(() => /three\.bin.*not kept/.test(status(s)), () => status(s))
    assert.equal(filesUnder(s.paths.kept).length, 2)
    assert.deepEqual(filesUnder(s.paths.held), [])
  } finally {
    s.done()
  }
})

test('bytes while waiting are bounded: past the agent ceiling the newest unanswered download is cancelled and its ask ended', async () => {
  const limits = { fileBytes: 1000, sessionBytes: 10_000, sessionFiles: 5, totalBytes: 3000, totalFiles: 25 }
  const s = setup({ limits })
  try {
    const a = fakeDownload(s.paths.held, { name: 'a.bin', bytes: 100, finished: false })
    s.slot.onDownload(a)
    await until(() => s.downloadCards().length === 1, () => 'asked a')
    const b = fakeDownload(s.paths.held, { name: 'b.bin', bytes: 100, finished: false })
    s.slot.onDownload(b)
    b.grow(4000)
    await until(() => b.cancelled === 1, () => `b cancelled: ${status(s)}`)
    assert.equal(a.cancelled, 0, 'the older one keeps arriving')
    await until(() => /b\.bin.*not kept/.test(status(s)), () => status(s))
  } finally {
    s.done()
  }
})

// ── Close, sweep, crash ───────────────────────────────────────────────────────

test('SESSION CLOSE keeps an undecided download that finishes within the grace, ends its ask, and deletes one still arriving', async () => {
  const s = setup()
  try {
    const done = fakeDownload(s.paths.held, { name: 'done.p8', finished: false })
    const slow = fakeDownload(s.paths.held, { name: 'slow.iso', finished: false })
    s.slot.onDownload(done)
    s.slot.onDownload(slow)
    await until(() => s.downloadCards().length === 1, () => 'asked')
    setTimeout(() => done.finish(), 20)
    await s.slot.drain('session_closed')
    assert.equal(s.gates.pending(join(s.agentRoot, '900', 'browser', 'owner')), null, 'the ask is over')
    assert.equal(filesUnder(s.paths.kept).length, 1)
    assert.equal(slow.cancelled, 1)
    assert.match(status(s), /done\.p8.*kept for your owner \(session closed\)/)
    assert.deepEqual(filesUnder(s.paths.held), [])
    // The owner answering the old card later changes nothing.
    s.srv.answer(String(s.downloadCards()[0]!.gateId), 'deny')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(filesUnder(s.paths.kept).length, 1)
  } finally {
    s.done()
  }
})

test('THE DELETION TEST: every kept file is there at 7 days less 1 ms and gone at 7 days, swept on an injected clock; an orphan goes by age', async () => {
  const s = setup()
  try {
    s.slot.onDownload(fakeDownload(s.paths.held))
    await until(() => s.downloadCards().length === 1, () => 'asked')
    s.srv.answer(String(s.downloadCards()[0]!.gateId), null, 'expired')
    await until(() => filesUnder(s.paths.kept).length === 1, () => 'kept')
    const orphan = join(s.paths.kept, randomUUID())
    writeFileSync(orphan, 'left by a crash')
    s.advance(DOWNLOAD_KEEP_MS - 1)
    const old = new Date(s.now() - DOWNLOAD_KEEP_MS + 1000)
    utimesSync(orphan, old, old)
    await s.store.sweep()
    assert.equal(filesUnder(s.paths.kept).length, 2, 'not yet')
    s.advance(1)
    utimesSync(orphan, new Date(s.now() - DOWNLOAD_KEEP_MS), new Date(s.now() - DOWNLOAD_KEEP_MS))
    await s.store.sweep()
    assert.deepEqual(filesUnder(s.paths.kept), [], 'every kept file is gone at 7 days')
    assert.match(status(s), /deleted after 7 days/)
    assert.equal(JSON.parse(readFileSync(s.paths.index, 'utf8')).records.length, 0)
  } finally {
    s.done()
  }
})

test('after a crash: a held download that had finished comes back kept and its owner is told; a partial is deleted', async () => {
  const s = setup()
  try {
    s.srv.refuse() // the crash happened mid ask: nothing could be posted
    const finished = fakeDownload(s.paths.held, { name: 'finished.p8' })
    const partial = fakeDownload(s.paths.held, { name: 'partial.iso', finished: false })
    s.slot.onDownload(finished)
    s.slot.onDownload(partial)
    await until(() => JSON.parse(readFileSync(s.paths.index, 'utf8')).records.length === 2, () => 'held records written')
    s.slot.stop() // the host is killed: no drain
    s.srv.refuse(false)
    const fresh = new DownloadStore({ agentRoot: s.agentRoot, assistantId: 900, gates: s.gates, deviceLabel: 'box-1', home: s.home, guard: readyGuard, now: s.now, noticePollMs: 5 })
    try {
      await fresh.sweep({ atStart: true })
      assert.equal(filesUnder(s.paths.kept).length, 1)
      assert.ok(!existsSync(partial.partial))
      assert.deepEqual(filesUnder(s.paths.held), [])
      await fresh.tellOwners()
      await until(() => s.downloadCards().some((c) => /finished\.p8.*kept for you/.test(c.summary)), () => JSON.stringify(s.downloadCards().map((c) => c.summary)))
    } finally {
      fresh.stop()
    }
  } finally {
    s.done()
  }
})

test('a file Chrome wrote that no download event claimed is never left silent: it is kept and its owner told', async () => {
  // Adopted by the close itself: the watcher would wait a minute for its event.
  const s = setup({ unclaimedAfterMs: 60_000 })
  try {
    s.slot.onDownload(fakeDownload(s.paths.held, { name: 'claimed.p8', finished: false }))
    writeFileSync(join(s.paths.held, randomUUID()), 'a download Playwright could not name')
    await s.slot.drain('session_closed')
    await until(() => s.downloadCards().some((c) => /kept for you/.test(c.summary) && /download/.test(c.summary)), () => JSON.stringify(s.downloadCards().map((c) => c.summary)))
    assert.deepEqual(filesUnder(s.paths.held), [])
    assert.equal(filesUnder(s.paths.kept).length, 1)
  } finally {
    s.done()
  }
})

test('a notice that could not be posted is posted later, exactly once; one posted before a restart is still read after it', async () => {
  const s = setup()
  try {
    s.slot.onDownload(fakeDownload(s.paths.held))
    await until(() => s.downloadCards().length === 1, () => 'asked')
    s.srv.refuse()
    s.srv.answer(String(s.downloadCards()[0]!.gateId), null, 'expired')
    await until(() => filesUnder(s.paths.kept).length === 1, () => 'kept')
    assert.equal(s.downloadCards().length, 1, 'the notice could not be posted')
    s.srv.refuse(false)
    await s.store.tellOwners()
    await s.store.tellOwners()
    await until(() => s.downloadCards().length === 2, () => 'told once')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(s.downloadCards().length, 2, 'exactly once')
    // A restart: a new store, new gates, the same backend. The owner taps Deny afterwards.
    s.store.stop()
    const gates2 = keeper(s.srv)
    const fresh = new DownloadStore({ agentRoot: s.agentRoot, assistantId: 900, gates: gates2, deviceLabel: 'box-1', home: s.home, guard: readyGuard, now: s.now, noticePollMs: 5 })
    try {
      await fresh.sweep({ atStart: true })
      await fresh.tellOwners()
      assert.equal(s.downloadCards().length, 2, 'no second notice after a restart')
      s.srv.answer(String(s.downloadCards()[1]!.gateId), 'deny')
      await until(() => filesUnder(s.paths.kept).length === 0, () => 'Deny after a restart still deletes')
    } finally {
      fresh.stop()
    }
  } finally {
    s.done()
  }
})

// ── Owner control, guard ──────────────────────────────────────────────────────

test("a download the OWNER starts while holding the browser is kept for them, with no ask, and never given to the agent", async () => {
  const s = setup()
  try {
    s.setOwner(true)
    s.slot.onDownload(fakeDownload(s.paths.held, { name: 'mine.p8' }))
    await until(() => filesUnder(s.paths.kept).length === 1, () => status(s))
    assert.ok(s.downloadCards().every((c) => !/^download mine\.p8 into/.test(c.summary)), 'no ask')
    await until(() => s.downloadCards().some((c) => /mine\.p8.*kept for you/.test(c.summary)), () => 'told')
    assert.deepEqual(filesUnder(s.outputDir), [])
  } finally {
    s.done()
  }
})

test('with the folder guard not ready, a download is refused and nothing is kept', async () => {
  const s = setup({ guard: { ready: false, reason: 'synced_folder', prepare: async () => false, verify: () => false } })
  try {
    const d = fakeDownload(s.paths.held, { finished: false })
    s.slot.onDownload(d)
    await until(() => d.cancelled === 1, () => status(s))
    assert.match(status(s), /not saved: downloads are off on this machine/)
    assert.equal(s.downloadCards().length, 0)
    assert.deepEqual(filesUnder(s.paths.kept), [])
  } finally {
    s.done()
  }
})

test('the folder guard refuses a synced or roaming folder, on its path and on what it really points at', async () => {
  const home = 'C:\\Users\\kc'
  assert.equal(syncedFolderOf('C:\\Users\\kc\\OneDrive\\.bgos-agent\\900\\browser-downloads', { platform: 'win32', env: {}, home }), 'OneDrive')
  assert.equal(syncedFolderOf('D:\\Org\\OneDrive - Org\\x', { platform: 'win32', env: { OneDriveCommercial: 'D:\\Org\\OneDrive - Org' }, home }), 'OneDrive')
  assert.equal(syncedFolderOf('C:\\Users\\kc\\.bgos-agent\\900\\browser-downloads', { platform: 'win32', env: { APPDATA: 'C:\\Users\\kc\\AppData\\Roaming' }, home }), null)
  assert.equal(syncedFolderOf('/Users/kc/Library/Mobile Documents/x', { platform: 'darwin', env: {}, home: '/Users/kc' }), 'iCloud Drive')
  assert.equal(syncedFolderOf('/home/kc/Dropbox/.bgos-agent/9', { platform: 'linux', env: {}, home: '/home/kc' }), 'Dropbox')
  // A roaming profile copies the whole profile root, ~/.bgos-agent included.
  const runs: string[][] = []
  const guard = new KeptFolderGuard({
    dir: 'C:\\Users\\kc\\.bgos-agent\\900\\browser-downloads',
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    home,
    run: async (file: string, args: string[]) => {
      runs.push([file, ...args])
      if (/whoami/i.test(file)) return { stdout: '"kc\\\\kc","S-1-5-21-1-2-3-1001"\r\n' }
      if (/reg/i.test(file)) return { stdout: '    CentralProfile    REG_SZ    \\\\server\\profiles\\kc\r\n' }
      throw new Error('not expected')
    },
    fsImpl: { mkdirSync: () => {}, lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 2 }), realpathSync: { native: (p: string) => p } },
  })
  assert.equal(await guard.prepare(), false)
  assert.equal(guard.reason, 'roaming_profile')
})

test('the folder guard on the REAL file system: owner only, read back, nothing above it trusted', { skip: process.platform === 'win32' && !spawnSync('icacls.exe', ['/?']).stdout ? 'no icacls' : false }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-guard-'))
  try {
    const dir = join(home, '.bgos-agent', '900', 'browser-downloads')
    const guard = new KeptFolderGuard({ dir, home, env: { ...process.env, OneDrive: undefined, OneDriveConsumer: undefined, OneDriveCommercial: undefined } })
    assert.equal(await guard.prepare(), true, `guard: ${guard.reason}; ACL read back: ${guard.readBack}`)
    assert.equal(guard.verify(), true)
    if (process.platform === 'win32') {
      const sid = /"(S-1-[0-9-]+)"\s*$/.exec(spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.trim())![1]
      const saved = join(home, 'acl.txt')
      spawnSync('icacls.exe', [dir, '/save', saved])
      const sddl = readFileSync(saved).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim())[1]!.trim()
      assert.match(sddl, new RegExp(`^D:P(?:AI)?\\(A;OICI;FA;;;${sid}\\)$`), sddl)
    } else {
      assert.equal(statSync(dir).mode & 0o777, 0o700)
    }
    // Swapped for another folder: no longer trusted. Renamed away rather than
    // deleted, so the new folder cannot reuse the old inode (Linux does).
    renameSync(dir, `${dir}.old`)
    mkdirSync(dir)
    assert.equal(guard.verify(), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── Words ─────────────────────────────────────────────────────────────────────

test('card text stays under the 500 characters the card route takes, with the name cleaned and its extension kept', () => {
  const evil = `${'\u202e'}inv\u0007oice${'x'.repeat(300)}\r\n.p8`
  const name = cleanFileName(evil)
  assert.ok(name.length <= 120, `${name.length}`)
  assert.ok(name.endsWith('.p8'), name)
  assert.doesNotMatch(name, /[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/)
  const ask = askSummary({ fileName: name, device: 'd'.repeat(60), agentName: 'a'.repeat(60), displayDir: `~/.bgos-agent/900/browser-output/${'k'.repeat(60)}.${'f'.repeat(32)}`, keepable: true })
  const kept = keptSummary({ fileName: name, device: 'd'.repeat(60), agentName: 'a'.repeat(60), displayDir: `~/.bgos-agent/900/browser-output/${'k'.repeat(60)}`, reason: 'no_answer' })
  assert.ok(ask.length <= CARD_SUMMARY_MAX && kept.length <= CARD_SUMMARY_MAX, `${ask.length} ${kept.length}`)
  assert.match(ask, /If you don't answer, the file is kept for you/)
  assert.match(kept, /Deny deletes it/)
  assert.equal(cleanFileName(''), 'download')
})

test('the name saved into the output folder is a plain file name on every system', () => {
  assert.equal(saveName('../../etc/passwd'), 'passwd')
  assert.equal(saveName('..\\..\\Windows\\win.ini'), 'win.ini')
  assert.equal(saveName('CON.txt'), '_CON.txt')
  assert.equal(saveName('report.pdf. . '), 'report.pdf')
  assert.equal(saveName('a:b*c?.csv'), 'a_b_c_.csv')
  assert.equal(saveName('..'), 'download')
})

test('the Downloads block: one line per download, kept rows with no path, saved rows with theirs, and the do not fetch again line', () => {
  const lines = downloadLines([
    { handle: 'dl_ab12', fileName: 'AuthKey.p8', bytes: 257, state: 'kept', keptReason: 'no_answer' },
    { handle: 'dl_cd34', fileName: 'billing.csv', bytes: 12 * 1024, state: 'saved', savedPath: '/home/a/.bgos-agent/900/browser-output/owner/billing.csv' },
    { handle: 'dl_ef56', fileName: 'x.bin', bytes: 3, state: 'deleted', reason: 'expired' },
  ])
  assert.equal(lines[0], 'Downloads: dl_ab12 AuthKey.p8, 257 B, kept for your owner (no answer). It stays on this machine for them; you are not given it.')
  assert.equal(lines[1], '  dl_cd34 billing.csv, 12 KB, saved in your browser folder: /home/a/.bgos-agent/900/browser-output/owner/billing.csv')
  assert.equal(lines[2], '  dl_ef56 x.bin, 3 B, deleted after 7 days.')
  assert.equal(lines[3], '  Do not download it again: the site may serve it once. Ask your owner what to do with it.')
  assert.deepEqual(downloadLines([]), [])
})

test('every file the rules write stays inside the agent folder', async () => {
  const s = setup()
  try {
    s.slot.onDownload(fakeDownload(s.paths.held, { name: 'one.p8' }))
    await until(() => s.downloadCards().length === 1, () => 'asked')
    s.srv.answer(String(s.downloadCards()[0]!.gateId), null, 'expired')
    await until(() => filesUnder(s.paths.kept).length === 1, () => 'kept')
    const agentDir = join(s.agentRoot, '900') + sep
    for (const p of filesUnder(s.home)) assert.ok(p.startsWith(agentDir), `outside the agent folder: ${p}`)
  } finally {
    s.done()
  }
})

// ── Review fixes (the one delegated review of this change) ────────────────────

test('after a crash, recovery with the REAL folder guard keeps a finished held download (the guard is prepared first)', async () => {
  const s = setup()
  try {
    s.srv.refuse()
    s.slot.onDownload(fakeDownload(s.paths.held, { name: 'once.p8', finished: false }))
    await until(() => JSON.parse(readFileSync(s.paths.index, 'utf8')).records.length === 1, () => 'held record written')
    s.slot.stop() // killed mid ask: the file finishes, nothing settles it
    const d = s.slot.records[0]!.download as ReturnType<typeof fakeDownload>
    d.finish()
    s.store.stop()
    const env = { ...process.env, OneDrive: undefined, OneDriveConsumer: undefined, OneDriveCommercial: undefined }
    const fresh = new DownloadStore({ agentRoot: s.agentRoot, assistantId: 900, gates: s.gates, deviceLabel: 'box-1', home: s.home, env, now: s.now, noticePollMs: 5 })
    try {
      await fresh.sweep({ atStart: true })
      assert.equal(filesUnder(s.paths.kept).length, 1, `kept, not deleted: guard ${fresh.guard.reason}`)
      assert.deepEqual(filesUnder(s.paths.held), [])
    } finally {
      fresh.stop()
    }
  } finally {
    s.done()
  }
})

test('a session closing while a no answer keep is still waiting on the lock keeps the file ONCE and reads it as kept', async () => {
  const s = setup()
  try {
    const d = fakeDownload(s.paths.held, { name: 'race.p8', finished: false })
    s.slot.onDownload(d)
    await until(() => s.downloadCards().length === 1, () => 'asked')
    s.srv.answer(String(s.downloadCards()[0]!.gateId), null, 'expired')
    await until(() => /race\.p8.*kept for your owner \(no answer\), still arriving/.test(status(s)), () => status(s))
    let release!: () => void
    void s.store.withLock(() => new Promise<void>((r) => (release = r)))
    const draining = s.slot.drain('session_closed')
    d.finish()
    await new Promise((r) => setTimeout(r, 30))
    release()
    await draining
    await until(() => filesUnder(s.paths.kept).length === 1, () => 'kept once')
    await new Promise((r) => setTimeout(r, 40))
    assert.match(status(s), /race\.p8, 257 B, kept for your owner/, status(s))
    assert.doesNotMatch(status(s), /not kept|deleted/)
  } finally {
    s.done()
  }
})

test('a Deny whose delete Windows refuses for a moment is retried, and a file that cannot be deleted is never picked up as kept', async () => {
  for (const mode of ['brief', 'stuck'] as const) {
    let target = ''
    let refusals = 0
    const fsWrap: any = { ...fsMod, rmSync: (p: string, o: any) => {
      if (target && p === target && (mode === 'stuck' || refusals < 2)) {
        refusals++
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      return fsMod.rmSync(p, o)
    } }
    const s = setup({ fsImpl: fsWrap })
    try {
      const d = fakeDownload(s.paths.held, { name: `${mode}.p8` })
      target = d.final
      s.slot.onDownload(d)
      await until(() => s.downloadCards().length === 1, () => 'asked')
      s.srv.answer(String(s.downloadCards()[0]!.gateId), 'deny')
      await until(() => /your owner said no/.test(status(s)), () => status(s))
      if (mode === 'brief') {
        await until(() => !existsSync(d.final), () => 'deleted after the retry')
      } else {
        await s.slot.drain('session_closed')
        assert.equal(filesUnder(s.paths.kept).length, 0, 'a file the owner denied is never kept')
        assert.equal(s.downloadCards().length, 1, `nor announced as kept: only the ask was posted, ${JSON.stringify(s.downloadCards().map((c) => c.summary))}`)
        target = ''
        const fresh = new DownloadStore({ agentRoot: s.agentRoot, assistantId: 900, gates: s.gates, deviceLabel: 'box-1', home: s.home, guard: readyGuard, now: s.now, noticePollMs: 5 })
        try {
          await fresh.sweep({ atStart: true })
          assert.equal(filesUnder(s.paths.kept).length, 0, 'nor at the next start')
          assert.ok(!existsSync(d.final), 'the next start deletes it')
        } finally {
          fresh.stop()
        }
      }
    } finally {
      s.done()
    }
  }
})

test('while the session runs, the held folder watcher adopts a file no download event claimed (kept, owner told)', async () => {
  const s = setup()
  try {
    mkdirSync(s.paths.held, { recursive: true })
    s.slot.watch()
    writeFileSync(join(s.paths.held, randomUUID()), 'a download Playwright could not name')
    await until(() => filesUnder(s.paths.kept).length === 1, () => 'adopted by the watcher')
    await until(() => s.downloadCards().some((c) => /without naming it, so it is kept for you/.test(c.summary)), () => JSON.stringify(s.downloadCards().map((c) => c.summary)))
    assert.deepEqual(filesUnder(s.paths.held), [])
  } finally {
    s.done()
  }
})
