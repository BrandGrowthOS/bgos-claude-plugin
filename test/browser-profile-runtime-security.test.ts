import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { listTools, resolveConfig } from '../bin/hoai-browser-host.mjs'
import { MINIMUM_BROWSER_NODE_VERSION } from '../lib/browser-profile-node-runtime.mjs'

const require = createRequire(import.meta.url)
const read = (name: string) => readFileSync(new URL('../' + name, import.meta.url), 'utf8')

test('the shipped dependency and both lockfiles bind the qualified browser package and supported Node minimum', () => {
  const pkg = JSON.parse(read('package.json')), lock = JSON.parse(read('package-lock.json'))
  const installed = require('playwright-core/package.json'), pin = JSON.parse(read('lib/browser-profile-launch.pin.json'))
  assert.equal(pkg.dependencies['playwright-core'], '1.64.1'); assert.equal(installed.version, '1.64.1')
  assert.equal(pkg.engines.node, '>=' + MINIMUM_BROWSER_NODE_VERSION)
  assert.equal(lock.packages[''].engines.node, pkg.engines.node)
  assert.equal(lock.packages[''].dependencies['playwright-core'], pkg.dependencies['playwright-core'])
  const entry = lock.packages['node_modules/playwright-core']
  assert.equal(entry.version, installed.version)
  assert.equal(entry.resolved, 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.1.tgz')
  const bun = read('bun.lock')
  assert.ok(bun.includes('"playwright-core": "1.64.1"'))
  assert.ok(bun.includes('"playwright-core@1.64.1"')); assert.ok(bun.includes(entry.integrity))
  assert.equal(pin.playwrightVersion, installed.version)
  assert.equal(createHash('sha256').update(readFileSync(require.resolve(pin.bundleExport))).digest('hex'), pin.bundleSha256)
})

test('shipped host configuration explicitly disables page-defined WebMCP for each supported capability set', async () => {
  for (const caps of [[], ['pdf'], ['pdf', 'vision']]) {
    const config = await resolveConfig({ caps, outputDir: process.cwd() })
    assert.equal(config.webmcp, false)
  }
})

test('the upgraded actual roster exposes media and named isolated contexts as writes requiring separate policy admission', async () => {
  const tools = await listTools({ caps: ['pdf'], outputDir: process.cwd() })
  const media = tools.find((tool: { name: string }) => tool.name === 'browser_emulate_media')
  const tabs = tools.find((tool: { name: string }) => tool.name === 'browser_tabs')
  assert.equal(media?.annotations.readOnlyHint, false); assert.equal(tabs?.annotations.readOnlyHint, false)
  assert.equal((tabs?.inputSchema as { properties?: { isolatedContext?: { type: string } } }).properties?.isolatedContext?.type, 'string')
})
