/**
 * What the owner reads on a permission card this host posts (mission 150 goal
 * 12, the wording step 8 of BGOS #2432 failed on). The backend writes the card
 * as "<agentName> wants to <summary>", so:
 *   - the card names the agent the relay frame names, never "Your agent" when
 *     the backend sent a name (bin/hoai-browser-host.mjs dropped it);
 *   - every verb the host can ask about reads after "wants to": the host
 *     passed the trail's past tense ("wants to opened", "wants to clicked").
 * The real GateKeeper against a fake backend, the host core over a fake engine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, BrowserPool, RelaySessions, hostInstructions } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'

type Card = Record<string, any>

const SITE = 'https://files.example.com'
const WHERE = 'files.example.com'

/** Every tool name below is served; the fake backend allows each card at once. */
const TOOL_NAMES = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_drop',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_resize',
  'browser_close',
  'browser_tabs',
]

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'card-words-'))
  const cards: Card[] = []
  const gates = new GateKeeper({
    postCard: async (card: Card) => {
      cards.push(card)
      return true
    },
    readGate: async () => ({ state: 'answered', choice: 'allow_once' }),
    randomBytes: (k: number) => Buffer.from(`${cards.length + 1}`.padStart(k, 'w')),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    // This in-process backend has no socket to keep its pending poll alive.
    backgroundSleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 5,
  })
  const pool = new BrowserPool({
    agentRoot: join(home, '.bgos-agent'),
    createEngine: () => ({
      alive: false,
      async start() {
        this.alive = true
      },
      pages: () => [{ url: () => `${SITE}/`, title: async () => 'Files' }],
      async callTool(name: string) {
        return { content: [{ type: 'text', text: `${name} ran` }] }
      },
      async stop() {
        this.alive = false
      },
    }),
  })
  const tools = TOOL_NAMES.map((name) => ({ name, description: '', inputSchema: { type: 'object', properties: {} } }))
  const core: any = new BrowserHostCore({ pool, browserTools: tools, deviceLabel: 'box-1', gates: gates as never })
  return { home, cards, core, done: () => rmSync(home, { recursive: true, force: true }) }
}

function callFrame(n: number, extra: Record<string, unknown>, name = 'browser_navigate', args: Record<string, unknown> = { url: `${SITE}/report` }) {
  return {
    rpcId: `r${n}`,
    clientId: 'client-1',
    assistantId: 900,
    message: { jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } },
    ...extra,
  }
}

function relayOver(core: any) {
  return new RelaySessions({ core, serverInfo: { name: 'hoai-agent-browser', version: '0.0.0' }, instructions: hostInstructions('box-1') })
}

test('a relayed call asks with the agent the frame names: the card carries the name, not "Your agent"', async () => {
  const s = setup()
  try {
    const out: any = await relayOver(s.core).relay(callFrame(1, { assistantName: 'Sage' }) as never)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.ok(s.cards.length >= 1, 'a card was posted')
    for (const card of s.cards) assert.equal(card.agentName, 'Sage')
  } finally {
    s.done()
  }
})

test('a frame with no name posts no made up one: the backend then names the agent from its own record', async () => {
  const s = setup()
  try {
    const out: any = await relayOver(s.core).relay(callFrame(1, {}) as never)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.ok(s.cards.length >= 1)
    for (const card of s.cards) assert.equal(card.agentName ?? null, null)
  } finally {
    s.done()
  }
})

/** Each verb the host can ask about, and the words the card puts after "wants to". */
const VERBS: Array<[string, Record<string, unknown>, string]> = [
  ['browser_navigate', { url: `${SITE}/report?q=1` }, `open ${SITE}`],
  ['browser_navigate_back', {}, `go back on ${WHERE}`],
  ['browser_click', { element: 'Get report link' }, `click Get report link on ${WHERE}`],
  ['browser_type', { element: 'Search box', text: 'quarterly' }, `type in Search box on ${WHERE}`],
  ['browser_fill_form', { fields: [{ name: 'City', type: 'textbox', value: 'Dubai' }] }, `fill 1 form field on ${WHERE}`],
  ['browser_fill_form', { fields: [{ name: 'City', type: 'textbox', value: 'Dubai' }, { name: 'Street', type: 'textbox', value: 'Main' }] }, `fill 2 form fields on ${WHERE}`],
  ['browser_select_option', { element: 'Size', values: ['L'] }, `select L in Size on ${WHERE}`],
  ['browser_press_key', { key: 'Enter' }, `press Enter on ${WHERE}`],
  ['browser_hover', { element: 'Menu' }, `hover Menu on ${WHERE}`],
  ['browser_drag', { startElement: 'Card A', endElement: 'Done column' }, `drag Card A to Done column on ${WHERE}`],
  ['browser_drop', { element: 'Drop zone', paths: ['E:/x/a.csv'] }, `drop a file onto Drop zone on ${WHERE}`],
  ['browser_drop', { element: 'Drop zone', paths: ['E:/x/a.csv', 'E:/x/b.csv'] }, `drop 2 files onto Drop zone on ${WHERE}`],
  ['browser_file_upload', { paths: ['E:/x/a.csv'] }, `upload a file on ${WHERE}`],
  ['browser_handle_dialog', { accept: true }, `accept a dialog on ${WHERE}`],
  ['browser_handle_dialog', { accept: false }, `dismiss a dialog on ${WHERE}`],
  ['browser_resize', { width: 800, height: 600 }, `resize to 800x600 on ${WHERE}`],
  ['browser_close', {}, `close the page on ${WHERE}`],
  ['browser_tabs', { action: 'new' }, `open a new tab on ${WHERE}`],
  ['browser_tabs', { action: 'close' }, `close a tab on ${WHERE}`],
  ['browser_tabs', { action: 'select', index: 1 }, `switch tabs on ${WHERE}`],
]

test('every verb the host asks about reads after "wants to": the imperative, never the trail\'s past tense', async () => {
  const s = setup()
  const ctx = { assistantId: 900, principal: 'owner', assistantName: 'Sage' }
  try {
    for (const [name, args, words] of VERBS) {
      const before = s.cards.length
      await s.core.callTool(ctx, name, args)
      assert.equal(s.cards.length, before + 1, `${name} ${JSON.stringify(args)} asked once`)
      const card = s.cards[s.cards.length - 1]
      assert.equal(card.summary, words, `${name} ${JSON.stringify(args)}`)
      // The sentence the backend writes (browser-gate-card.ts: `${agentName} wants to ${lowerFirst(summary)}`).
      const sentence = `${card.agentName} wants to ${card.summary.charAt(0).toLowerCase()}${card.summary.slice(1)}`
      assert.match(sentence, /^Sage wants to (open|go|click|type|fill|select|press|hover|drag|drop|upload|accept|dismiss|resize|close|switch) /, sentence)
      assert.doesNotMatch(sentence, /wants to \S+ed\b/, sentence)
    }
  } finally {
    s.done()
  }
})
