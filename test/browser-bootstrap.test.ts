import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureBrowser } from '../lib/browser-bootstrap.mjs'

function fixture(t: any) {
  const cache = mkdtempSync(join(tmpdir(), 'browser-bootstrap-'))
  t.after(() => rmSync(cache, { recursive: true, force: true }))
  const executable = join(cache, 'chromium-fixture'), cli = join(cache, 'bundled-cli.js')
  return { cache, executable, cli }
}

test('installed browser wins without loading a downloader or touching cache', async () => {
  assert.equal(await ensureBrowser({ findInstalled: () => ({ path: '/installed/chrome' }), bundle: () => { throw new Error('not needed') } }), '/installed/chrome')
})

test('first use provisions pinned bundled Chromium once using a secretless installer environment', async t => {
  const paths = fixture(t), calls: any[] = []
  const spawnImpl: any = (command: any, args: any, options: any) => {
    calls.push({ command, args, options }); const child = new EventEmitter()
    setImmediate(() => { writeFileSync(paths.executable, 'fixture'); child.emit('exit', 0) }); return child
  }
  const request = { findInstalled: () => ({ path: null }), bundle: () => paths, spawnImpl,
    env: { PATH: 'fixturepath', HOME: paths.cache, HOAI_BROWSER_HOST_PAIRING_TOKEN: 'NO_TOKEN', SSH_AUTH_SOCK: '/NO_SOCKET',
      HOAI_BROWSER_CHROME_ENV: 'SSH_AUTH_SOCK', ANTHROPIC_API_KEY: 'NO_KEY' } }
  const values = await Promise.all([ensureBrowser(request), ensureBrowser(request)])
  assert.deepEqual(values, [paths.executable, paths.executable]); assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, [paths.cli, 'install', 'chromium', '--no-shell'])
  assert.equal(calls[0].options.env.PLAYWRIGHT_BROWSERS_PATH, paths.cache)
  for (const secret of ['NO_TOKEN', 'NO_SOCKET', 'NO_KEY']) assert.equal(JSON.stringify(calls).includes(secret), false)
  assert.equal(existsSync(join(paths.cache, '.hoai-chromium-install.lock')), false)
})

test('failed installation cleans its lock and a later request can retry', async t => {
  const paths = fixture(t)
  const spawnImpl: any = () => { const child = new EventEmitter(); setImmediate(() => child.emit('exit', 1)); return child }
  await assert.rejects(ensureBrowser({ bundle: () => paths, spawnImpl, env: {} }), { code: 'browser_install_failed' })
  assert.equal(existsSync(join(paths.cache, '.hoai-chromium-install.lock')), false)
  assert.equal(existsSync(paths.executable), false)
  writeFileSync(paths.executable, 'fixture')
  assert.equal(await ensureBrowser({ bundle: () => paths, env: {} }), paths.executable)
})

test('an explicit invalid browser override cannot silently choose a different browser', async () => {
  await assert.rejects(ensureBrowser({ findInstalled: () => ({ path: null }), env: { HOAI_BROWSER_EXECUTABLE: '/missing' }, bundle: () => { throw new Error('must not download') } }), { code: 'browser_install_failed' })
})
