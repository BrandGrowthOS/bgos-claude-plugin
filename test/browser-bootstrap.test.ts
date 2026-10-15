import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { bundledChromium, createBrowserBootstrap } from '../lib/browser-bootstrap.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture(t: any) {
  const cache = mkdtempSync(join(tmpdir(), 'browser-bootstrap-'))
  t.after(() => rmSync(cache, { recursive: true, force: true }))
  const revision = join(cache, 'chromium-1'); mkdirSync(revision)
  const paths = { cache, executable: join(revision, 'chrome'), cli: join(cache, 'bundled-cli.js'), marker: join(revision, 'INSTALLATION_COMPLETE') }
  const controller = createBrowserBootstrap()
  const finishFiles = () => { writeFileSync(paths.executable, 'fixture'); writeFileSync(paths.marker, '') }
  const child: any = Object.assign(new EventEmitter(), { pid: 900001, stdout: Object.assign(new EventEmitter(), { resume() {} }), stderr: Object.assign(new EventEmitter(), { resume() {} }) })
  let calls = 0, killed = 0
  child.kill = () => { killed++ }
  const request: any = { bundle: () => paths, env: {}, platform: 'win32', spawnImpl: () => { calls++; setImmediate(() => child.emit('spawn')); return child } }
  const close = (code = 0) => { child.emit('exit', code); child.stdout.emit('end'); child.stderr.emit('end'); child.emit('close', code) }
  return { paths, controller, child, request, finishFiles, close, calls: () => calls, killed: () => killed, lock: join(cache, '.hoai-chromium-install.lock') }
}

test('unrelated installed browser needs no installer; invalid explicit override cannot fallback', async t => {
  const f = fixture(t)
  assert.equal(await f.controller.ensureBrowser({ ...f.request, findInstalled: () => ({ path: '/installed/chrome' }) }), '/installed/chrome')
  assert.equal(f.calls(), 0)
  await assert.rejects(f.controller.ensureBrowser({ env: { HOAI_BROWSER_EXECUTABLE: '/missing' }, bundle: () => { throw new Error('must not download') } }), { code: 'browser_install_failed' })
})

test('first use deduplicates pinned installer and waits close/EOF with a secretless environment', async t => {
  const f = fixture(t), calls: any[] = []
  f.request.env = { PATH: 'fixturepath', HOME: f.paths.cache, HOAI_BROWSER_HOST_PAIRING_TOKEN: 'NO_TOKEN', SSH_AUTH_SOCK: '/NO_SOCKET', HOAI_BROWSER_CHROME_ENV: 'SSH_AUTH_SOCK', ANTHROPIC_API_KEY: 'NO_KEY' }
  const original = f.request.spawnImpl
  f.request.spawnImpl = (...args: any[]) => { calls.push(args); return original() }
  const first = f.controller.ensureBrowser(f.request), second = f.controller.ensureBrowser(f.request)
  await turn(); f.finishFiles(); f.child.emit('exit', 0); await turn()
  assert.equal(f.calls(), 1); assert.equal(existsSync(f.lock), true)
  assert.deepEqual(f.controller.activity(), { pendingPhysicalOperations: 1, cleanupUnknown: false })
  f.close()
  assert.deepEqual(await Promise.all([first, second]), [f.paths.executable, f.paths.executable])
  await f.controller.whenDrained(); assert.equal(existsSync(f.lock), false)
  assert.deepEqual(calls[0][1], [f.paths.cli, 'install', 'chromium', '--no-shell'])
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(calls[0][2].env.PLAYWRIGHT_BROWSERS_PATH, f.paths.cache)
  for (const secret of ['NO_TOKEN', 'NO_SOCKET', 'NO_KEY']) assert.equal(JSON.stringify(calls).includes(secret), false)
})

test('newly appearing executable cannot bypass pending close through findInstalled or bundle cache', async t => {
  const f = fixture(t); const first = f.controller.ensureBrowser(f.request); await turn(); f.finishFiles()
  let admitted = 0
  const second = f.controller.ensureBrowser({ ...f.request, findInstalled: () => ({ path: f.paths.executable }) }).then(value => { admitted++; return value })
  const third = f.controller.ensureBrowser(f.request).then(value => { admitted++; return value })
  f.child.emit('exit', 0); await turn()
  assert.equal(admitted, 0); assert.equal(f.calls(), 1); assert.equal(existsSync(f.lock), true)
  f.close(); await Promise.all([first, second, third]); assert.equal(admitted, 2)
})

test('timeout retains durable ownership, blocks retries and late CLI0 is recovery required', async t => {
  const f = fixture(t); const first = f.controller.ensureBrowser({ ...f.request, timeoutMs: 5 })
  const rejected = assert.rejects(first, { code: 'browser_install_recovery_required' })
  await new Promise(resolve => setTimeout(resolve, 15)); await rejected
  assert.equal(existsSync(f.lock), true); assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).state, 'recovery-required')
  f.finishFiles()
  await assert.rejects(f.controller.ensureBrowser({ ...f.request, findInstalled: () => ({ path: f.paths.executable }) }), { code: 'browser_install_recovery_required' })
  assert.equal(f.calls(), 1); assert.equal(f.killed(), 0)
  f.close(); await assert.rejects(f.controller.whenDrained(), { code: 'browser_install_recovery_required' })
  assert.equal(existsSync(f.lock), true); assert.equal(f.controller.activity().cleanupUnknown, true)
  const nextHost = createBrowserBootstrap()
  await assert.rejects(nextHost.ensureBrowser({ ...f.request, findInstalled: () => ({ path: f.paths.executable }) }), { code: 'browser_install_recovery_required' })
  assert.equal(f.calls(), 1)
})

test('stale/dead owner and malformed lock data never authorizes automatic reclaim', async t => {
  for (const value of ['{"pid":2147483647}', 'not-json', '{"version":1,"state":"recovery-required"}']) {
    const f = fixture(t); f.finishFiles(); writeFileSync(f.lock, value)
    await assert.rejects(f.controller.ensureBrowser({ ...f.request, findInstalled: () => ({ path: f.paths.executable }) }), { code: 'browser_install_recovery_required' })
    assert.equal(readFileSync(f.lock, 'utf8'), value); assert.equal(f.calls(), 0)
    await assert.rejects(f.controller.whenDrained(), { code: 'browser_install_recovery_required' })
  }
})

test('cache requires complete marker and original lock replacement is not unlinked', async t => {
  const f = fixture(t); writeFileSync(f.paths.executable, 'partial')
  const first = f.controller.ensureBrowser(f.request); await turn()
  f.finishFiles(); writeFileSync(f.lock, JSON.stringify({ nonce: 'replacement' })); f.close()
  await assert.rejects(first, { code: 'browser_install_recovery_required' })
  await assert.rejects(f.controller.whenDrained(), { code: 'browser_install_recovery_required' })
  assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).nonce, 'replacement')
})

test('normal Windows and Darwin success retain the pinned completion contract', async t => {
  for (const platform of ['win32', 'darwin']) {
    const f = fixture(t), first = f.controller.ensureBrowser({ ...f.request, platform }); await turn(); f.finishFiles(); f.close()
    assert.equal(await first, f.paths.executable); await f.controller.whenDrained()
  }
})

test('installer source/resolution is freshly checked before successful cache admission', async t => {
  const f = fixture(t)
  let changed = false
  const first = f.controller.ensureBrowser({ ...f.request, bundle: () => changed ? { ...f.paths, cli: join(f.paths.cache, 'changed-cli.js') } : f.paths })
  await turn(); f.finishFiles(); changed = true; f.close()
  await assert.rejects(first, { code: 'browser_install_recovery_required' })
  await assert.rejects(f.controller.whenDrained(), { code: 'browser_install_recovery_required' })
  assert.equal(existsSync(f.lock), true)
})

test('host cancellation refuses new admission and retains physical work until known original completion', async t => {
  const f = fixture(t); const first = f.controller.ensureBrowser(f.request); await turn(); f.controller.cancel()
  await assert.rejects(first, { code: 'browser_install_recovery_required' })
  await assert.rejects(f.controller.ensureBrowser(f.request), { code: 'browser_install_recovery_required' })
  let drained = false; const drain = f.controller.whenDrained().catch(() => { drained = true })
  await turn(); assert.equal(drained, false); assert.equal(f.controller.activity().pendingPhysicalOperations, 1)
  f.close(1); await drain; assert.equal(drained, true)
})

test('actual bundled installer provenance is exact and exposes its complete marker', () => {
  const resolved = bundledChromium()
  assert.match(resolved.executable, /chromium-1248/)
  assert.match(resolved.marker, /chromium-1248[\\/]INSTALLATION_COMPLETE$/)
  assert.match(resolved.cli, /playwright-core[\\/]cli\.js$/)
})

test('copied actual resolver refuses changed bundled CLI bytes before loading or spawning it', async t => {
  const f = fixture(t), lib = join(f.paths.cache, 'lib'), pkg = join(f.paths.cache, 'node_modules', 'playwright-core')
  mkdirSync(lib); mkdirSync(pkg, { recursive: true })
  for (const name of ['browser-bootstrap.mjs', 'browser-install-lifetime.mjs', 'browser-env.mjs', 'browser-bootstrap.pin.json']) copyFileSync(new URL(`../lib/${name}`, import.meta.url), join(lib, name))
  const require = createRequire(import.meta.url)
  copyFileSync(require.resolve('playwright-core/package.json'), join(pkg, 'package.json'))
  const original = dirname(require.resolve('playwright-core/package.json'))
  for (const name of ['lib/bootstrap.js', 'lib/coreBundle.js', 'lib/utilsBundle.js', 'lib/entry/oopBrowserDownload.js']) {
    mkdirSync(dirname(join(pkg, name)), { recursive: true }); copyFileSync(join(original, name), join(pkg, name))
  }
  writeFileSync(join(pkg, 'index.js'), `module.exports = { chromium: { executablePath: () => ${JSON.stringify(join(f.paths.cache, 'chromium-1248', 'chrome'))} } }`)
  writeFileSync(join(pkg, 'cli.js'), 'throw new Error("DO NOT EXECUTE THIS CLI")')
  const actual = await import(pathToFileURL(join(lib, 'browser-bootstrap.mjs')).href)
  assert.throws(() => actual.bundledChromium(), { code: 'browser_install_failed' })
  assert.equal(f.calls(), 0)
})

test('logger same-executable reentry joins the already published original reservation', async t => {
  const f = fixture(t)
  let reentry: Promise<any> | undefined
  const first = f.controller.ensureBrowser({ ...f.request, log: () => { if (!reentry) reentry = f.controller.ensureBrowser(f.request) } })
  await turn(); assert.equal(f.calls(), 1)
  f.finishFiles(); f.close()
  const completed = await Promise.allSettled([first, reentry])
  assert.deepEqual(completed.map(row => row.status), ['fulfilled', 'fulfilled'])
  assert.deepEqual(completed.map(row => row.status === 'fulfilled' ? row.value : null), [f.paths.executable, f.paths.executable])
  await f.controller.whenDrained(); assert.equal(f.controller.activity().cleanupUnknown, false)
})

test('logger cancellation sees the deferred physical reservation and prevents spawn', async t => {
  const f = fixture(t)
  let drain: Promise<void> | undefined, drained = false, observedPending = -1, observedDrained = true
  const first = f.controller.ensureBrowser({ ...f.request, log: () => {
    observedPending = f.controller.activity().pendingPhysicalOperations
    f.controller.cancel(); drain = f.controller.whenDrained().then(() => { drained = true })
    observedDrained = drained
  } })
  await assert.rejects(first, { code: 'browser_install_recovery_required' }); await drain
  assert.equal(observedPending, 1); assert.equal(observedDrained, false)
  assert.equal(f.calls(), 0); assert.equal(drained, true); assert.equal(existsSync(f.lock), false)
  assert.deepEqual(f.controller.activity(), { pendingPhysicalOperations: 0, cleanupUnknown: false })
})

test('no-child cancellation and synchronous spawn failure retain unknown when lock release fails', async t => {
  for (const kind of ['cancel', 'spawn-throw']) {
    const f = fixture(t)
    const options = kind === 'cancel' ? { ...f.request, log: () => { writeFileSync(f.lock, 'malformed-replacement'); f.controller.cancel() } }
      : { ...f.request, spawnImpl: () => { writeFileSync(f.lock, 'malformed-replacement'); throw new Error('PRIVATE SPAWN ERROR') } }
    const outcome: any = await f.controller.ensureBrowser(options).then(() => null, error => error)
    assert.equal(outcome?.code, 'browser_install_recovery_required')
    const drained = await Promise.race([f.controller.whenDrained().then(() => 'clean', () => 'unknown'), turn().then(() => 'pending')])
    assert.equal(drained, 'unknown'); assert.equal(f.controller.activity().cleanupUnknown, true)
    assert.equal(readFileSync(f.lock, 'utf8'), 'malformed-replacement')
    assert.equal(f.calls(), 0)
  }
})

test('unclaimed cached admission cannot race another owner creating a complete executable', async t => {
  const f = fixture(t), lib = join(f.paths.cache, 'lib'); mkdirSync(lib)
  for (const name of ['browser-bootstrap.mjs', 'browser-install-lifetime.mjs', 'browser-env.mjs', 'browser-bootstrap.pin.json']) copyFileSync(new URL(`../lib/${name}`, import.meta.url), join(lib, name))
  const source = join(lib, 'browser-bootstrap.mjs')
  writeFileSync(source, readFileSync(source, 'utf8').replace("from 'node:fs'", "from './fixture-fs.mjs'"))
  const literals = JSON.stringify({ lock: f.lock, executable: f.paths.executable, marker: f.paths.marker })
  writeFileSync(join(lib, 'fixture-fs.mjs'), `import fs from 'node:fs'; export { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, lstatSync, fstatSync, writeSync, ftruncateSync, fsyncSync } from 'node:fs'; const paths=${literals}; let injected=false; export function existsSync(path){ const observed=fs.existsSync(path); if(path===paths.lock&&!observed&&!injected){injected=true;fs.writeFileSync(paths.lock,JSON.stringify({owner:'other-still-running'}),{flag:'wx'});fs.writeFileSync(paths.executable,'partial-owner-install');fs.writeFileSync(paths.marker,'')}return observed }`)
  const actual = await import(pathToFileURL(source).href), controller = actual.createBrowserBootstrap()
  await assert.rejects(controller.ensureBrowser(f.request), { code: 'browser_install_recovery_required' })
  assert.equal(f.calls(), 0); assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).owner, 'other-still-running')
  await assert.rejects(controller.whenDrained(), { code: 'browser_install_recovery_required' })
})

test('read-only readiness reports complete, partial and recovery cache without modifying it', async t => {
  const f = fixture(t), options = { bundle: () => f.paths }
  assert.equal(f.controller.readiness(options).state, 'needs-install')
  writeFileSync(f.paths.executable, 'partial')
  assert.equal(f.controller.readiness(options).state, 'needs-install')
  f.finishFiles(); assert.equal(f.controller.readiness(options).state, 'installed')
  writeFileSync(f.lock, 'malformed-or-old-owner')
  assert.equal(f.controller.readiness(options).state, 'recovery-required')
  assert.equal(readFileSync(f.lock, 'utf8'), 'malformed-or-old-owner'); assert.equal(f.calls(), 0)
})

test('read-only readiness distinguishes original installing work and logical unknown work', async t => {
  const f = fixture(t), first = f.controller.ensureBrowser(f.request); await turn()
  assert.equal(f.controller.readiness({ bundle: () => f.paths }).state, 'installing')
  f.controller.cancel(); await assert.rejects(first)
  assert.equal(f.controller.readiness({ bundle: () => f.paths }).state, 'recovery-required')
  f.close(1); await assert.rejects(f.controller.whenDrained())
})

test('unrelated installed browser remains usable ordinarily but does not bypass discovered recovery', async t => {
  const f = fixture(t), options = { ...f.request, findInstalled: () => ({ path: '/unrelated/installed/chrome' }) }
  assert.equal(await f.controller.ensureBrowser(options), '/unrelated/installed/chrome')
  writeFileSync(f.lock, 'older-unknown-install')
  await assert.rejects(f.controller.ensureBrowser(options), { code: 'browser_install_recovery_required' })
  assert.equal(f.controller.activity().cleanupUnknown, true)
  await assert.rejects(f.controller.whenDrained(), { code: 'browser_install_recovery_required' })
  assert.equal(f.calls(), 0)
})
