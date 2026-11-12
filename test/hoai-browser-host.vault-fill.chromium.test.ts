/**
 * A person's saved login filled end to end on this machine's host, in a real
 * Chromium: a real signed state and a real host key (test/helpers/
 * vault-state-fixture.mjs), the redeem answered by a fake server, the real
 * checks, the real open, the real page fill, and what the agent reads after.
 * Loopback, made up values. The https rule of hoai_vault_fill is the core's
 * (test/hoai-browser-host.vault-fill.test.ts); here the login's website is the
 * loopback origin.
 *
 * No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChromiumEngine, resolveChromeExecutable, runPersonVaultFill } from '../bin/hoai-browser-host.mjs'
import { vaultHostDir } from '../lib/vault-host.mjs'
import { confirmHostPin, loadOrCreateHostKey, provisionSigningIdentity, registerHostKey, testSecurity } from './helpers/vault-host.mjs'
import { account, signedState } from './helpers/vault-state-fixture.mjs'

const chrome = resolveChromeExecutable()
const skip = chrome.path ? false : 'no Chrome or Chromium is installed on this machine'
const AGENT = 901
const OWNER = 'user_Owner1'
const LEO = 'user_Leo1'
const ITEM = '2f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const SECRET = 'made-up-Secret-77'
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`

async function rig(t: any, loginOk: boolean) {
  const posted: string[] = []
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/session' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { posted.push(body); res.end(page(`<h1>Welcome</h1><p>You typed ${body}</p>`)) })
      return
    }
    res.end(page(`<form method="post" action="/session"${loginOk ? '' : ' onsubmit="event.preventDefault()"'}><input name="email" type="email"><input name="pw" type="password"><button>Sign in</button></form>`))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hvc-')))
  const agentRoot = join(home, '.bgos-agent')
  const dir = vaultHostDir(join(agentRoot, String(AGENT)))
  const record = await loadOrCreateHostKey(dir, AGENT)
  await provisionSigningIdentity(dir, AGENT, generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'))
  await registerHostKey({ stateDir: dir, assistantId: AGENT, ownerId: OWNER, apiBase: 'https://api.example.com/api/v1', pairingToken: 'pt',
    fetch: (async () => new Response(JSON.stringify({ registered: true, publicKey: record.publicKey }), { status: 201 })) as never })
  await confirmHostPin(dir)
  const acct = account()
  const state = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed: record.hostSeed, acct, people: [{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }] }],
    items: [{ id: ITEM, website: origin, username: 'owner@example.com', password: SECRET }] })
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  await engine.start()
  t.after(async () => { await engine.stop().catch(() => {}); server.close(); rmSync(home, { recursive: true, force: true }) })
  await engine.callTool('browser_navigate', { url: `${origin}/login` })
  const run = () => runPersonVaultFill({
    pairing: { backendUrl: 'https://api.example.com', token: 'pt', ownerUserId: OWNER, assistantIds: [AGENT] }, agentRoot, assistantId: AGENT, actingUserId: LEO,
    ticket: 'K'.repeat(43), sessionId: 'vs_1', tabId: 'tab_1', origin, page: engine.selectedPage(), engine, security: testSecurity,
    fetchImpl: (async () => new Response(JSON.stringify({ state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }), { status: 200 })) as never,
  } as never)
  return { engine, run, posted }
}

const textOf = (r: any) => (r?.content || []).map((c: any) => c.text ?? '').join('\n')

test('a working sign in: the owner\'s login reaches the site, never the agent', { skip, timeout: 120_000 }, async (t) => {
  const r = await rig(t, true)
  assert.deepEqual(await r.run(), { filled: true })
  assert.equal(r.posted.length, 1)
  assert.match(r.posted[0]!, new RegExp(`pw=${SECRET}`))
  // The site echoes what was typed: the agent's snapshot shows it hidden.
  const snapshot = textOf(await r.engine.callTool('browser_snapshot', {}))
  assert.match(snapshot, /Welcome/)
  assert.doesNotMatch(snapshot, new RegExp(SECRET))
})

test('a refused sign in: the fields are emptied, and what the agent reads after has no value', { skip, timeout: 120_000 }, async (t) => {
  const r = await rig(t, false)
  const receipt = await r.run()
  assert.deepEqual(receipt, { filled: false, reason: 'sign_in_failed' })
  assert.deepEqual(await r.engine.selectedPage().evaluate(() => [...document.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value)), ['', ''])
  const snapshot = textOf(await r.engine.callTool('browser_snapshot', {}))
  assert.match(snapshot, /Sign in/, 'the page is released to the agent once the fields are empty')
  assert.doesNotMatch(snapshot, new RegExp(SECRET))
  assert.doesNotMatch(snapshot, /owner@example\.com/)
})
