import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { PlaywrightEngine, loadPlaywright, resolveConfig } from '../bin/hoai-browser-host.mjs'
import { profileLaunchArguments } from '../lib/browser-profile-launch.mjs'
import { ensureBrowser } from '../lib/browser-bootstrap.mjs'
import { RTC_BROWSER_VERSION } from '../lib/browser-profile-rtc-activity.mjs'

assert.equal(process.platform, 'linux')
assert.equal(process.getuid(), 1000)
const require = createRequire(import.meta.url), { chromium, tools } = loadPlaywright()
const directory = await mkdtemp('/tmp/hoai-webmcp-')
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  response.end('<!doctype html><title>Disposable WebMCP fixture</title><h1>Fixture</h1>')
})
const report = {
  kind: 'actual sandboxed WebMCP exclusion',
  scope: 'A synthetic page-defined tool in a private loopback website. Actual pinned Playwright backend and shipped host configuration. The explicit positive control enables WebMCP only in its own backend. No HOAI server, model or agent permission claim.',
  nodeVersion: process.versions.node,
  playwrightVersion: require('playwright-core/package.json').version,
  browserVersion: null, checks: [], cleanup: null,
}
async function processState(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
    return { pid, group: Number(fields[2]), started: fields[19] }
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error }
}
async function groupMembers(group) {
  const values = await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(name => processState(Number(name))))
  return values.filter(value => value?.group === group)
}
const contexts = [], backends = [], engines = []
let browser, owned, originalMembers = [], failed
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: await ensureBrowser({ findInstalled: () => ({ path: null }) }), ...profileLaunchArguments(), args: [...profileLaunchArguments().args, '--enable-features=WebMCP'] })
  report.browserVersion = browser.version(); assert.equal(report.browserVersion, RTC_BROWSER_VERSION)
  const root = await browser.newBrowserCDPSession(), pid = (await root.send('SystemInfo.getProcessInfo')).processInfo.find(row => row.type === 'browser').id
  owned = await processState(pid); assert.equal(owned.group, owned.pid); originalMembers = await groupMembers(owned.group)
  const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
  assert.equal(args.includes('--no-sandbox'), false); assert.equal(args.includes('--remote-debugging-pipe'), true); assert.equal(args.some(value => value.startsWith('--remote-debugging-port=')), false)
  const create = async () => {
    const context = await browser.newContext(); contexts.push(context)
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.evaluate(() => {
      window.fixtureCanaryCalls = 0
      const model = document.modelContext ?? navigator.modelContext
      if (typeof model?.registerTool !== 'function') throw Error('fixture_native_webmcp_unavailable')
      model.registerTool({ name: 'fixture_page_tool', description: 'Synthetic fixture', inputSchema: { type: 'object', properties: {} }, execute: async () => { window.fixtureCanaryCalls++; return 'SYNTHETIC_CANARY' } })
    })
    return { context, page }
  }
  const config = await resolveConfig({ caps: ['pdf'], outputDir: directory })
  const positive = await create(), enabled = { ...config, webmcp: true }
  const backend = new tools.BrowserBackend(enabled, positive.context, tools.filteredTools(enabled)); backends.push(backend)
  await backend.initialize({ cwd: directory, name: 'fixture', version: '1' }); await backend._context.ensureBrowserContext(); await backend._context.currentTab().updateWebMCPTools()
  const dynamic = backend.dynamicTools(); assert.equal(dynamic.length, 1); assert.match(dynamic[0].name, /fixture_page_tool/)
  const called = await backend.callTool(dynamic[0].name, {}); assert.equal(called.isError, undefined); assert.equal(await positive.page.evaluate(() => window.fixtureCanaryCalls), 1)
  report.checks.push('a real native page-defined tool is collected and invoked by the explicit positive control')
  const negative = await create(), engine = new PlaywrightEngine({ caps: ['pdf'], outputDir: directory, managedRuntime: { browser, context: negative.context, assertCurrent() {} } }); engines.push(engine)
  await engine.start(); await engine.selectPage(negative.page); await engine.callTool('browser_snapshot', {}); await engine._backend._context.currentTab().updateWebMCPTools()
  assert.deepEqual(engine._backend.dynamicTools(), []); assert.equal(engine.roster().some(tool => tool.name === dynamic[0].name), false)
  const refused = await engine.callTool(dynamic[0].name, {}); assert.equal(refused.isError, true); assert.equal(await negative.page.evaluate(() => window.fixtureCanaryCalls), 0); assert.equal(negative.context.pages().length, 1)
  report.checks.push('shipped host configuration refuses collection, served roster exposure and invocation without opening another page')
} catch (error) { failed = error }
finally {
  const cleanup = await Promise.allSettled([...engines.map(engine => engine.stop()), ...backends.map(backend => backend.dispose()), ...contexts.map(context => context.close())])
  await browser?.close()
  if (owned) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await groupMembers(owned.group)).length === 0) break
      await delay(10)
    }
    for (const member of originalMembers) assert.notEqual((await processState(member.pid))?.started, member.started)
    assert.deepEqual(await groupMembers(owned.group), [])
  }
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
  assert.ok(cleanup.every(value => value.status === 'fulfilled'))
  report.cleanup = { originalProcessCount: originalMembers.length, ownedBrowserGroupGone: Boolean(owned), serverClosed: !server.listening, privateDirectoryRemoved: true, forcedStop: false }
  report.ok = !failed; console.log(JSON.stringify(report))
}
if (failed) throw failed
