import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChromiumEngine, BrowserHostCore, browserPathsFor, resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'
import { RemoteCredentials } from '../lib/remote-credentials.mjs'
import { RemoteOwnerInput } from '../lib/remote-input.mjs'
import crypto from '../lib/remote-credentials-crypto.cjs'

const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : [p] })

test('actual owner fill remains redacted from MCP snapshots, evaluate, console and text artifacts after Not now', { timeout: 45000 }, async t => {
  // macOS: os.tmpdir() is /var/folders/..., and /var is a symlink to /private/var,
  // so a path built from it is an ALIAS. agent-browser-vault's secureProfileDir
  // deliberately refuses an alias (`realpathSync(absolute) !== absolute` throws
  // unsafe_profile), which is the anti-aliasing property the vault exists to
  // have. So every temp root under tmpdir() must be canonicalised here, or these
  // specs can never pass on a Mac. CI runs ubuntu-latest and windows-latest
  // only, where /tmp is real, so this was green in CI and red on every developer
  // and agent machine in the fleet. Canonicalising the TEST root keeps the
  // production check exactly as strict: ~/.bgos-agent, the real profile root,
  // has no symlink in its chain.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'credential-browser-')))
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><form id="signin"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button><span>Sign in</span></button></form><script>window.submitted=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submitted++});document.querySelectorAll("input").forEach(x=>x.addEventListener("input",()=>console.log(x.value)))</script>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const paths = browserPathsFor({ agentRoot: root, assistantId: 901, principal: 'user-fixture' })
  const engine: any = new ChromiumEngine({ ...paths, executable: process.env.HOAI_BROWSER_EXECUTABLE || resolveChromeExecutable({ env: process.env }).path })
  t.after(async () => { await engine.stop(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
  await engine.start()
  const page = engine.pages()[0]
  await page.goto(origin)
  await engine.vault.unlock('fixture owner passphrase 123'); await engine.vault.restore(page.context())
  await engine.callTool('browser_snapshot', {})
  const slot: any = { engine, runningTools: new Set() }
  const view: any = { viewId: 'view_fixture', sessionId: 'session_fixture', tabId: 'tab_fixture', engine, page,
    context: { assistantId: 901, principal: 'user-fixture' } }
  const credentials = new RemoteCredentials({ current: () => slot, storageFor: () => engine.vault })
  t.after(() => credentials.close(view))
  const secret = 'CANARY_pw_"quotes"_\\slash'
  const prepared = await credentials.prepare(view, { operation: 'login' })
  const result = await credentials.commit(view, crypto.sealOffer(prepared.offer, { username: 'fixture-user', password: secret }))
  assert.equal(await page.locator('input[type=password]').inputValue(), secret)
  await credentials.save(view, { pendingId: result.pending.pendingId, save: false })
  assert.equal(slot.ownerInputLease, null)
  const snapshot = await engine.callTool('browser_snapshot', {})
  const evaluated = await engine.callTool('browser_evaluate', { function: '() => document.querySelector("input[type=password]").value' })
  const consoleMessages = await engine.callTool('browser_console_messages', {})
  await engine.callTool('browser_snapshot', { filename: 'snapshot.txt' })
  await engine.callTool('browser_console_messages', { filename: 'console.txt' })
  await page.evaluate((value: string) => console.log(encodeURIComponent(value)), secret)
  await engine.callTool('browser_console_messages', { filename: 'console-encoded.txt' })
  const outputs = JSON.stringify([snapshot, evaluated, consoleMessages]) + files(paths.outputDir).filter(file => /\.(txt|log|md)$/.test(file)).map(file => readFileSync(file, 'utf8')).join('\n')
  for (const marker of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) assert.equal(outputs.includes(marker), false, marker)
  assert.ok(outputs.includes('[REDACTED]'))
  assert.deepEqual(engine.vault.list(origin), [])
  await page.evaluate((value: string) => { document.title = value; history.replaceState(null, '', '?' + encodeURIComponent(value)) }, secret)
  const core = new BrowserHostCore({ pool: { peek: () => slot } as any, browserTools: [], deviceLabel: 'fixture' })
  const status = JSON.stringify(await core.callTool(view.context, 'hoai_browser_status', {}))
  for (const marker of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) assert.equal(status.includes(marker), false)
  assert.ok(status.includes('[REDACTED]'))

  // Only a single explicit pointer gesture may submit the exact trusted form.
  view.cdp = await page.context().newCDPSession(page)
  const input = new RemoteOwnerInput({ current: () => slot,
    credentialPointer: (view: any, input: any) => credentials.pointer(view, input),
    revoked: (view: any) => credentials.clearSubmit(view) })
  const owner = await input.acquire(view)
  const button = await page.locator('button span').boundingBox()
  const point = { leaseId: owner.leaseId, x: button.x + button.width / 2, y: button.y + button.height / 2, button: 'left' }
  await input.pointer(view, { ...point, type: 'down' })
  await input.pointer(view, { ...point, type: 'up' })
  assert.equal(await page.evaluate(() => (window as any).submitted), 1)
  await assert.rejects(input.pointer(view, { ...point, type: 'down' }), { code: 'credential_field' })
  assert.equal(await page.evaluate(() => (window as any).submitted), 1)
  input.release(view)

  // Associated submitters outside the form can override its destination.
  for (const markup of [
    '<button form="signin" formaction="https://outside.invalid">Submit</button>',
    '<input type="image" form="signin" formaction="https://outside.invalid">',
    '<button form="signin" formtarget="other">Submit</button>',
  ]) {
    await page.goto(origin); await page.evaluate((html: string) => document.body.insertAdjacentHTML('beforeend', html), markup)
    await assert.rejects(credentials.prepare(view, { operation: 'login' }), { code: 'credential_changed' })
  }

  // Expiring a held submit gesture releases away from the control without submitting.
  await page.goto(origin)
  const again = await credentials.prepare(view, { operation: 'login' })
  const pending = await credentials.commit(view, crypto.sealOffer(again.offer, { username: 'fixture-user', password: secret }))
  await credentials.save(view, { pendingId: pending.pending.pendingId, save: false })
  const secondOwner = await input.acquire(view)
  await input.pointer(view, { ...point, leaseId: secondOwner.leaseId, type: 'down' })
  input.release(view)
  await input.drain(view)
  assert.equal(await page.evaluate(() => (window as any).submitted), 0)
})
