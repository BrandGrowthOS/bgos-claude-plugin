import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserPool } from '../bin/hoai-browser-host.mjs'
import { AgentBrowserVault } from '../lib/agent-browser-vault.mjs'
import { RemoteBrowserViews } from '../lib/remote-view.mjs'

test('two recipients keep distinct engine, encrypted cookie/login profile and view; owner cannot select either', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-private-profiles-')))
  const engines: any[] = []
  const pool = new BrowserPool({ agentRoot: root, createEngine: ({ principal, profileDir, scope }: any) => {
    const vault = new AgentBrowserVault({ profileDir, scope, snapshotMs: 100000 })
    const cdp: any = Object.assign(new EventEmitter(), { send: async () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }), detach: async () => {} })
    let state: any = { cookies: [], origins: [] }
    const page: any = Object.assign(new EventEmitter(), { isClosed: () => false, viewportSize: () => ({ width: 800, height: 600 }), title: async () => principal, url: () => 'https://private.test/', context: () => ({ newCDPSession: async () => cdp }) })
    const browserContext = { storageState: async () => state, setStorageState: async (next: any) => { state = next } }
    vault.bind(browserContext)
    const engine = { vault, profileDir, principal, scope, browserContext, alive: true, cdp, start: async () => {}, pages: () => [page], selectedPage: () => page,
      setCookie: (value: string) => { state = { cookies: [{ name: 'session', value, domain: 'private.test', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }], origins: [] } },
      state: () => state, stop: async () => { await vault.snapshot(); await vault.lock(); engine.alive = false } }
    engines.push(engine)
    return engine
  } })
  const views = new RemoteBrowserViews({ pool })
  t.after(async () => { await views.stop(); await pool.stopAll(); assert.ok(root.includes('hoai-private-profiles-')); rmSync(root, { recursive: true, force: true }) })
  const contexts = ['user-user_alice', 'user-user_bob', 'user-user_owner'].map(principal => ({ assistantId: 901, principal }))
  const recipients = await Promise.all(contexts.slice(0, 2).map(context => pool.acquire(context)))
  assert.notEqual(recipients[0].engine, recipients[1].engine)
  assert.equal(pool.peek(contexts[2]), null)
  const closed: any[] = []
  assert.equal(await views.open({ viewId: 'owner-missing', ...contexts[2], remoteBrowser: true }, { connectionId: 'host', sendFrame: () => assert.fail('owner got recipient pixels'), sendClose: (frame: any) => closed.push(frame) }), false)
  assert.equal(closed[0].reason, 'no_session')
  const owner = await pool.acquire(contexts[2])
  assert.equal(new Set([...recipients, owner].map(slot => slot.paths.profileDir)).size, 3)
  assert.equal(new Set(engines.map(engine => engine.vault.file)).size, 3)
  assert.equal(new Set(engines.map(engine => engine.scope)).size, 3)
  const channels: any[][] = [[], [], []]
  for (let i = 0; i < 3; i++) {
    const engine = pool.peek(contexts[i])!.engine
    await engine.vault.unlock('synthetic shared fixture passphrase')
    await engine.vault.restore()
    engine.setCookie('COOKIE_PRIVATE_' + i)
    await engine.vault.saveLogin({ origin: 'https://private.test', username: 'account' + i, password: 'PASSWORD_PRIVATE_' + i })
    await engine.vault.snapshot()
    assert.equal(await views.open({ viewId: 'view' + i, ...contexts[i], remoteBrowser: true }, { connectionId: 'host', sendFrame: (frame: any) => { channels[i].push(frame); return true }, sendClose: () => {} }), true)
    assert.equal(channels[i][0].frame.params.title, contexts[i].principal)
    assert.equal(views.views.get('view' + i).engine, engine)
    const disk = readFileSync(engine.vault.file, 'utf8')
    for (const secret of ['COOKIE_PRIVATE_', 'PASSWORD_PRIVATE_', 'account', 'synthetic shared fixture passphrase']) assert.equal(disk.includes(secret), false)
  }
  // Even knowing a passphrase does not make copied ciphertext valid under another principal's scope.
  const alice = recipients[0].engine, bob = recipients[1].engine
  await alice.vault.lock(); await bob.vault.lock()
  const originalBob = readFileSync(bob.vault.file)
  writeFileSync(bob.vault.file, readFileSync(alice.vault.file))
  await assert.rejects(bob.vault.unlock('synthetic shared fixture passphrase'), { code: 'vault_unlock_failed' })
  writeFileSync(bob.vault.file, originalBob)
  await bob.vault.unlock('synthetic shared fixture passphrase'); await bob.vault.restore(bob.browserContext)
  assert.equal(bob.state().cookies[0].value, 'COOKIE_PRIVATE_1')
  assert.equal(bob.vault.list('https://private.test')[0].username, 'account1')
})
