import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { chromeEnv } from '../lib/browser-env.mjs'
import { profileLaunchArguments } from '../lib/browser-profile-launch.mjs'
import { createChromiumRtcActivity, RTC_BROWSER_VERSION } from '../lib/browser-profile-rtc-activity.mjs'
const require = createRequire(import.meta.url), { chromium } = require('playwright-core')
const report = { kind: 'Actual disposable sandboxed Chrome155 private native RTC qualification', checks: [] }, active = []
let server
const authority = { profileId: randomUUID(), actingUserId: 'synthetic-recipient', assistantId: 7, endpointId: randomUUID(), bootId: 'synthetic-boot', runtimeId: 'synthetic-runtime', sessionId: 'synthetic-session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1, keyFingerprint: 'a'.repeat(64) }
const expression = '(()=>{const peer=new RTCPeerConnection({iceServers:[]});peer.close();return true})()'
const check = (name, value = {}) => { report.checks.push({ name, ok: true, ...value }); if (process.env.HOAI_PROBE_REPORT) writeFileSync(process.env.HOAI_PROBE_REPORT, JSON.stringify(report, null, 2)) }
async function create() {
  const environment = chromeEnv(process.env, { platform: 'linux', headed: false })
  for (const name of Object.keys(environment)) if (['DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(name.toUpperCase())) delete environment[name]
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, chromiumSandbox: true, ...profileLaunchArguments(), env: environment }); active.push(browser)
  const root = await browser.newBrowserCDPSession(), processes = await root.send('SystemInfo.getProcessInfo'), pid = processes.processInfo.find(value => value.type === 'browser').id
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  const observer = await createChromiumRtcActivity({ browser, root, authority, browserVersion: await browser.version(), processIdentity: { pid, started } })
  const context = await browser.newContext(), ids = (await root.send('Target.getBrowserContexts')).browserContextIds.filter(value => value !== observer.privateContextId)
  assert.equal(ids.length, 1); await observer.bindContext({ context, contextId: ids[0] })
  return { browser, root, observer, context, contextId: ids[0], scope: { authority, context, browserVersion: RTC_BROWSER_VERSION } }
}
const zero = f => async () => f.context.pages().length === 0 && !(await f.root.send('Target.getTargets')).targetInfos.some(value => value.browserContextId === f.contextId)
try {
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store'); res.end('<!doctype html><h1>Disposable RTC fixture</h1>' + (req.url === '/rtc' ? '<script>' + expression + '</script>' : '')) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port, other = 'http://localhost:' + server.address().port
  const clean = await create(), cleanPage = await clean.context.newPage(); await cleanPage.goto(origin + '/'); assert.equal(clean.observer.assertQualified(clean.scope), true); await cleanPage.close()
  assert.equal(await clean.observer.confirmStopped({ ...clean.scope, assertPhysicalZero: zero(clean) }), true); await clean.observer.dispose(); assert.equal(clean.browser.contexts().length, 1); await clean.browser.close()
  check('real-exclusive-startup-marker-bound-context-and-clean-target-zero-qualify')
  for (const mode of ['main-first', 'same-frame', 'cross-frame', 'navigation', 'popup', 'last-pause']) {
    const f = await create(), page = await f.context.newPage(); await page.goto(origin + '/')
    if (mode === 'main-first') await page.goto(origin + '/rtc')
    if (mode === 'same-frame' || mode === 'cross-frame') await page.evaluate(url => new Promise(resolve => { const frame = document.createElement('iframe'); frame.onload = () => { frame.remove(); resolve(true) }; frame.src = url; document.body.append(frame) }), (mode === 'same-frame' ? origin : other) + '/rtc')
    if (mode === 'navigation') { await page.goto(other + '/rtc'); await page.goto(origin + '/') }
    if (mode === 'popup') { const wait = f.context.waitForEvent('page'); await page.evaluate(source => { window.open('about:blank').document.write('<script>globalThis.rtcExecuted=' + source + ';</script>') }, expression); const popup = await wait; assert.equal(await popup.evaluate(() => globalThis.rtcExecuted), true); await popup.close() }
    if (mode === 'last-pause') { const cdp = await f.context.newCDPSession(page); await cdp.send('Debugger.enable'); await page.evaluate(expression); const paused = new Promise(resolve => cdp.on('Debugger.paused', resolve)); await cdp.send('Debugger.pause'); void cdp.send('Runtime.evaluate', { expression: 'void 0' }).catch(() => {}); await paused }
    if (mode !== 'last-pause') { const next = await f.context.newPage(); await next.goto(origin + '/new-tab'); assert.equal(await next.evaluate(() => 1 + 1), 2); await next.close() }; await page.close()
    await assert.rejects(f.observer.confirmStopped({ ...f.scope, assertPhysicalZero: zero(f) }), { code: 'profile_rtc_history_unqualified' })
    assert.equal(await f.observer.privatePage.evaluate(async () => Object.keys((await import('./dump_creator.js')).peerConnectionDataStore).length), 0)
    await f.observer.dispose(); await f.browser.close(); check('actual-' + mode + '-closed-RTC-refuses-capture-with-normal-local-new-tab-intact')
  }
  const extra = await create(), unknown = await extra.browser.newContext(); await assert.rejects(extra.observer.confirmStopped({ ...extra.scope, assertPhysicalZero: zero(extra) }), { code: 'profile_rtc_inventory_unqualified' }); await unknown.close(); await extra.observer.dispose(); await extra.browser.close(); check('a-concurrent-unknown-browser-context-never-becomes-owned-authority')
  report.ok = true
} catch (error) { report.ok = false; report.failure = error.stack || String(error) }
finally { for (const browser of active) await browser.close().catch(() => {}); if (server) { server.closeAllConnections(); server.close() }; if (process.env.HOAI_PROBE_REPORT) writeFileSync(process.env.HOAI_PROBE_REPORT, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1 }
