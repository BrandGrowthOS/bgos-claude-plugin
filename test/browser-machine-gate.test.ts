/**
 * On a machine nobody watches, a gate reads what the host itself saw of the page, not only
 * what the agent wrote about it, and a browsing card speaks only for the owner's own turn.
 * The real BrowserHostCore and the real GateKeeper over a fake engine and a fake backend.
 * Made up pages only. No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { BrowserHostCore, defaultPurposeFor, readPairings } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'

const OWNER = { assistantId: 42, assistantName: 'Atlas', principal: 'user-owner_1' }
const RECIPIENT = { assistantId: 42, assistantName: 'Atlas', principal: 'user-recipient_2' }
const PAGE = '### Snapshot\n```yaml\n- button "Make /finance public" [ref=e2] [cursor=pointer]\n- textbox "Search" [ref=e1]\n- textbox "Password" [ref=e5]\n- button "Show the report" [ref=e7]\n- button "Delete account" [ref=e9]\n- listitem "Report" [ref=e3]\n```'
const reply = (text: string) => ({ content: [{ type: 'text', text }] })
const tool = (name: string) => ({ name, description: '', inputSchema: { type: 'object', properties: {} } })
const TOOLS = ['browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_drag', 'browser_navigate'].map(tool)

function rig({ intentCheck = null, owner = true }: any = {}) {
  const cards: any[] = [], sessionCards: any[] = [], engineCalls: string[] = []
  const slot: any = { key: 'k', engine: { alive: true, vault: { status: () => ({ unlocked: false }) }, pages: () => [{ url: () => 'https://crm.example/settings', title: async () => 't' }], callTool: async (name: string) => { engineCalls.push(name); return reply(name === 'browser_snapshot' ? PAGE : 'done') }, selectedPage: () => ({ url: () => 'https://crm.example/settings' }) }, paths: { key: 'k' } }
  const pool: any = { acquire: async () => slot, peek: () => slot, slotKey: () => 'k', pathsFor: () => slot.paths, release: async () => true }
  const gates = new GateKeeper({
    postCard: async (card: any) => { cards.push(card); return true },
    readGate: async (gateId: string) => ({ gateId, state: 'answered', status: 'answered', answer: 'allow_once', answered: true, choice: 'allow_once', reason: 'answered' }),
    randomBytes: (n: number) => Buffer.alloc(n, 7), sleep: async () => {}, log: () => {},
  } as any)
  const core: any = new BrowserHostCore({ pool, browserTools: TOOLS, deviceLabel: 'Build box', gates, postSessionCard: async (_a: number, _id: string, payload: any) => { sessionCards.push(payload); return true }, isOwnerPrincipal: (ctx: any) => owner && ctx.principal === OWNER.principal, intentCheck } as any)
  // A site the agent may already write on, so only the sensitive path asks.
  core._settingsFor = () => ({})
  core._grantsFor = () => ({ 'https://crm.example': { navigate: 'allow', write: 'allow' } })
  core._currentOrigin = async () => 'https://crm.example'
  return { core, slot, cards, sessionCards, engineCalls }
}

test('an agent\'s harmless words on a sensitive target: the gate asks, and the card names what the page calls it', async () => {
  const r = rig()
  await r.core.callTool(OWNER, 'browser_snapshot', {})
  const call = r.core.callTool(OWNER, 'browser_click', { target: 'e2', element: 'Show the report', wait_seconds: 5 })
  for (let i = 0; i < 50 && !r.cards.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(r.cards.length, 1, 'it asked, though the agent\'s own words are harmless')
  assert.equal(r.cards[0].kind, 'sensitive')
  assert.match(r.cards[0].summary, /Make \/finance public/)
  assert.equal(r.cards[0].summary.includes('Show the report'), false, 'the agent\'s description is not what the owner reads')
  void call.catch(() => {})
})

test('a harmless host name proceeds, while a missing host name asks', async () => {
  const r = rig()
  await r.core.callTool(OWNER, 'browser_snapshot', {})
  await r.core.callTool(OWNER, 'browser_click', { target: 'e7', element: 'Show the report' })
  assert.equal(r.cards.length, 0, 'a harmless page name on a trusted write asks nothing')
  assert.deepEqual(r.engineCalls, ['browser_snapshot', 'browser_click'])
  const blind = rig()
  await blind.core.callTool(OWNER, 'browser_click', { target: 'e2', element: 'Show the report' })
  assert.equal(blind.cards.length, 1); assert.equal(blind.cards[0].kind, 'sensitive')
})

test('typing into a field the page calls Password is a credential gate, whatever the agent called it', async () => {
  const r = rig()
  await r.core.callTool(OWNER, 'browser_snapshot', {})
  const call = r.core.callTool(OWNER, 'browser_type', { target: 'e5', element: 'the note', text: 'x', wait_seconds: 5 })
  for (let i = 0; i < 50 && !r.cards.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(r.cards[0]?.kind, 'credential')
  void call.catch(() => {})
})

test('a multi target action is judged and named by all its targets', async () => {
  const r = rig()
  await r.core.callTool(OWNER, 'browser_snapshot', {})
  const drag = r.core.callTool(OWNER, 'browser_drag', { startTarget: 'e3', endTarget: 'e9', startElement: 'Report', endElement: 'Archive', wait_seconds: 5 })
  for (let i = 0; i < 50 && !r.cards.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.match(r.cards[0]?.summary ?? '', /Delete account/)
  void drag.catch(() => {})
})

test('another person\'s turn sends no page fact to the intent check, even on a slot that has a session card', async () => {
  const asked: any[] = []
  const r = rig({ owner: false, intentCheck: async (_a: number, _s: string, body: any) => { asked.push(body); return { verdict: 'does_not_match', quote: 'q', reason: 'x' } } })
  await r.core.callTool(OWNER, 'browser_snapshot', {})
  r.slot.cardId = 'card_1'
  const call = r.core.callTool(OWNER, 'browser_click', { target: 'e2', element: 'Send the invoice', wait_seconds: 5 })
  for (let i = 0; i < 50 && !r.cards.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(r.cards.length, 1)
  assert.equal(asked.length, 0, JSON.stringify(asked))
  assert.equal(/does not match/i.test(r.cards[0].summary), false)
  await call
})

test('a sensitive gate goes through the intent check with the host\'s own facts, and a mismatch is on the owner\'s card', async () => {
  const asked: any[] = []
  const r = rig({ intentCheck: async (_assistantId: number, sessionId: string, body: any) => { asked.push({ sessionId, body }); return { verdict: 'does_not_match', quote: 'send the invoice to finance', reason: 'x' } } })
  await r.core.callTool(OWNER, 'hoai_browser_open_session', { purpose: 'Send the invoice' })
  await r.core.callTool(OWNER, 'browser_snapshot', {})
  const call = r.core.callTool(OWNER, 'browser_click', { target: 'e2', element: 'Send the invoice', wait_seconds: 5 })
  for (let i = 0; i < 50 && !r.cards.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(asked.length, 1)
  assert.equal(asked[0].sessionId, r.slot.cardId)
  const { body } = asked[0]
  assert.deepEqual({ kind: body.kind, tool: body.tool, targetRole: body.targetRole, targetName: body.targetName, assistantId: body.assistantId, origin: body.origin }, { kind: 'sensitive', tool: 'browser_click', targetRole: 'button', targetName: 'Make /finance public', assistantId: 42, origin: 'https://crm.example' })
  assert.equal(body.gateId, r.cards[0].gateId, 'for this gate')
  assert.ok(body.action.length <= 200)
  assert.match(r.cards[0].summary, /does not match/i)
  assert.match(r.cards[0].summary, /send the invoice to finance/)
  assert.ok(r.cards[0].summary.length <= 200)
  void call.catch(() => {})
})

test('a check that is off, unknown, slow or broken changes nothing on the card, and a match adds nothing', async () => {
  for (const intentCheck of [
    async () => ({ verdict: 'unknown', quote: null, reason: 'disabled' }),
    async () => ({ verdict: 'matches', quote: 'x', reason: 'x' }),
    async () => { throw new Error('offline') },
    () => new Promise(() => {}),
  ]) {
    const r = rig({ intentCheck })
    r.core.intentCheckWaitMs = 20
    await r.core.callTool(OWNER, 'hoai_browser_open_session', { purpose: 'p' })
    await r.core.callTool(OWNER, 'browser_snapshot', {})
    const call = r.core.callTool(OWNER, 'browser_click', { target: 'e2', element: 'x', wait_seconds: 5 })
    for (let i = 0; i < 100 && !r.cards.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(r.cards.length, 1)
    assert.equal(/match/i.test(r.cards[0].summary), false)
    void call.catch(() => {})
  }
})

test('a page tree read before a navigation names nothing after it', async () => {
  const r = rig()
  await r.core.callTool(OWNER, 'browser_snapshot', {})
  assert.ok(r.slot.lastSnapshotText)
  const call = r.core.callTool(OWNER, 'browser_navigate', { url: 'https://other.example/', wait_seconds: 1 })
  for (let i = 0; i < 100 && r.slot.lastSnapshotText; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(r.slot.lastSnapshotText, null)
  void call.catch(() => {})
})

test('what the agent is told about sign-ins is true: refused, opened, and neither', async () => {
  const r = rig()
  r.slot.signInsRefused = true
  const refused = JSON.stringify(await r.core.callTool(OWNER, 'hoai_browser_open_session', { purpose: 'p' }))
  assert.match(refused, /sign-ins stay on their computer/)
  assert.match(refused, /same OS user/)
  r.slot.signInsRefused = false; r.slot.signInsApplied = true
  const opened = JSON.stringify(await r.core.callTool(OWNER, 'hoai_browser_open_session', { purpose: 'p' }))
  assert.equal(/not readable by any tool/.test(opened), false, 'the old promise is gone')
  assert.match(opened, /what a signed in page displays does reach your snapshots/)
  r.slot.signInsApplied = false
  assert.equal(/sign-ins/.test(JSON.stringify(await r.core.callTool(OWNER, 'hoai_browser_open_session', { purpose: 'p' }))), false, 'a machine with nothing to refuse says nothing')
})

// P2-6.
test('a share recipient\'s browsing posts no card to the owner\'s chat: not the open, not the end', async () => {
  const r = rig()
  await r.core.callTool(RECIPIENT, 'hoai_browser_open_session', { purpose: 'A private errand of the recipient' })
  await r.core.callTool(RECIPIENT, 'hoai_browser_close_session', {})
  assert.deepEqual(r.sessionCards, [])
})

test('a room posts none, an unknown owner posts none, and the owner\'s own turn posts both', async () => {
  const r = rig()
  await r.core.callTool({ ...OWNER, principal: 'group-7' }, 'hoai_browser_open_session', { purpose: 'room' })
  assert.deepEqual(r.sessionCards, [])
  const unknown = rig({ owner: false })
  await unknown.core.callTool(OWNER, 'hoai_browser_open_session', { purpose: 'mine' })
  assert.deepEqual(unknown.sessionCards, [], 'a host that cannot tell whose turn this is stays quiet')
  await r.core.callTool(OWNER, 'hoai_browser_open_session', { purpose: 'mine' })
  await r.core.callTool(OWNER, 'hoai_browser_close_session', {})
  assert.deepEqual(r.sessionCards.map((card: any) => card.state), ['browsing', 'ended'])
})

test('the end of a browsing card names a reason the server takes (found by the real run: it answered 400 and the card stayed open)', async () => {
  const { sessionCardPayload } = await import('../bin/hoai-browser-host.mjs')
  const ended = sessionCardPayload({ sessionId: 'bs_x', seq: 2, state: 'ended', agentName: 'Atlas', purpose: 'p', startedAt: '2026-11-04T00:00:00.000Z' })
  assert.equal(ended.end_reason, 'closed_by_agent')
})

test('the default purpose names the site and nothing after it: a path can hold a token as well as a query can', () => {
  assert.equal(defaultPurposeFor('https://crm.example/a/b?token=SYNTHETIC&x=1#frag'), 'Browsing https://crm.example')
  assert.equal(defaultPurposeFor('https://site.example/reset/SYNTH_RESET_TOKEN'), 'Browsing https://site.example')
  assert.equal(defaultPurposeFor('https://user:pw@crm.example/'), 'Browsing https://crm.example')
  assert.equal(defaultPurposeFor('not a url?token=SYNTHETIC'), 'Browsing on request')
  assert.equal(defaultPurposeFor(undefined), 'Browsing on request')
})

test('a gate on another person\'s turn still reaches the owner, who answers it, and tells them no page, no site and no purpose', async () => {
  const r = rig()
  r.slot.purpose = 'A private errand of the recipient'
  r.slot.lastSnapshotText = PAGE
  const call = r.core.callTool(RECIPIENT, 'browser_click', { target: 'e2', element: 'Pay invoice 8841 to Dr Lee', wait_seconds: 5 })
  for (let i = 0; i < 50 && !r.cards.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(r.cards.length, 1)
  const card = r.cards[0], words = JSON.stringify(card)
  for (const leak of ['Make /finance public', 'Pay invoice', 'private errand', 'crm.example']) assert.equal(words.includes(leak), false, `${leak}: ${words}`)
  assert.match(card.summary, /someone you share this agent with/i)
  assert.deepEqual(card.choices, ['allow_once', 'deny'], 'nothing an owner could remember blind')
  assert.equal(card.kind, 'sensitive')
  void call.catch(() => {})
  // CONTROL: the owner's own turn keeps its words.
  const own = rig()
  own.slot.lastSnapshotText = PAGE
  const mine = own.core.callTool(OWNER, 'browser_click', { target: 'e2', element: 'x', wait_seconds: 5 })
  for (let i = 0; i < 50 && !own.cards.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.match(own.cards[0].summary, /Make \/finance public/)
  void mine.catch(() => {})
})

test('a snapshot of one element or to a depth is not the whole page, and leaves the tree the gate reads alone', async () => {
  const r = rig()
  await r.core.callTool(OWNER, 'browser_snapshot', {})
  const whole = r.slot.lastSnapshotText
  r.slot.engine.callTool = async () => reply('### Snapshot\n```yaml\n- button "Part" [ref=e1]\n```')
  await r.core.callTool(OWNER, 'browser_snapshot', { target: 'e1' })
  assert.equal(r.slot.lastSnapshotText, whole)
  await r.core.callTool(OWNER, 'browser_snapshot', { depth: 1 })
  assert.equal(r.slot.lastSnapshotText, whole)
})

test('the owner comes from the credentials the pairing was made with', () => {
  const read = readPairings({ agentRoot: '/x', allow: null, listDir: () => ['credentials-42.json'], readText: () => JSON.stringify({ assistantId: 42, backendUrl: 'https://api.test', pairingId: 7, pairingToken: 'made-up', userId: 'owner_1', pairedAt: '2026-11-04T00:00:00Z' }) })
  assert.equal(read.pairings[0].ownerUserId, 'owner_1')
})
