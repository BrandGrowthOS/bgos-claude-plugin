import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'
import { rmSync } from 'node:fs'

import { DEFAULT_CAPS, PlaywrightEngine, loadPlaywright, resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'
import { scratchDir } from './helpers/scratch-dirs.ts'
import { serveSite } from './browser-site-fixture.ts'

const chrome = resolveChromeExecutable()
const skip = chrome.path ? false : 'no Chrome or Chromium is installed on this machine'
const textOf = (reply: any) => (reply.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')

async function within<T>(work: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`privacy read did not finish within ${ms} ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

async function rig(t: TestContext) {
  const home = scratchDir('privacy-settled-')
  const site = await serveSite(() => '<html lang="en"><h1>Public article</h1></html>')
  t.after(() => site.close())
  const browser = await loadPlaywright().chromium.launch({ executablePath: chrome.path!, headless: true })
  t.after(async () => { await browser.close(); rmSync(home, { recursive: true, force: true }) })
  const context = await browser.newContext()
  const page = await context.newPage()
  const client = page._connection.toImpl(page).delegate._mainFrameSession._client
  const send = client.send.bind(client)
  // Delay only the real protocol acknowledgement. Chromium still creates each
  // frame and the production watcher still performs all of its privacy checks.
  const controls = {
    seedDelayMs: 0,
    afterSeed: async (_frameId: string) => {},
    beforeListeners: async () => {},
  }
  client.send = async (method: string, params: any = {}, ...rest: any[]) => {
    if (method === 'DOMDebugger.getEventListeners') await controls.beforeListeners()
    const result = await send(method, params, ...rest)
    if (method === 'Page.createIsolatedWorld' && params.frameId !== page._connection.toImpl(page.mainFrame())._id) {
      if (controls.seedDelayMs) await pause(controls.seedDelayMs)
      await controls.afterSeed(params.frameId)
    }
    return result
  }
  const engine: any = new PlaywrightEngine({
    caps: DEFAULT_CAPS, outputDir: home, clientName: 'fixture', clientVersion: '0',
    managedRuntime: { browser, context, assertCurrent() {} },
  })
  await engine.start()
  await engine.callTool('browser_navigate', { url: site.origin })
  assert.match(textOf(await engine.callTool('browser_snapshot')), /heading "Public article"/)
  return { page, engine, controls, privacy: engine._privacy }
}

test('P1-6 a protected snapshot finishes while a page keeps adding frames every 5 ms', { skip, timeout: 30_000 }, async t => {
  const { page, engine, controls } = await rig(t)
  controls.seedDelayMs = 150
  const seeded = Promise.withResolvers<void>()
  let seeds = 0
  controls.afterSeed = async () => { seeds++; seeded.resolve() }
  await page.evaluate(() => {
    const state = (window as any).churn = { count: 0, timer: undefined as ReturnType<typeof setInterval> | undefined }
    state.timer = setInterval(() => {
      const frame = document.createElement('iframe')
      frame.srcdoc = '<p>Advertisement</p>'
      document.body.appendChild(frame)
      state.count++
      setTimeout(() => frame.remove(), 200)
    }, 5)
  })
  try {
    await within(seeded.promise)
    const start = performance.now()
    const reply = await within(engine.callTool('browser_snapshot'))
    const elapsed = Math.round(performance.now() - start)
    assert.match(textOf(reply), /heading "Public article"/)
    assert.ok(seeds > 1, 'real frame rearming overlapped the read')
    assert.ok(await page.evaluate(() => (window as any).churn.count) > 1)
    t.diagnostic(`protected snapshot completed in ${elapsed} ms with ${seeds} delayed frame seeds`)
  } finally {
    controls.seedDelayMs = 0
    await page.evaluate(() => {
      clearInterval((window as any).churn.timer)
      document.querySelectorAll('iframe').forEach(frame => frame.remove())
    })
    await within(engine._toolWork.catch(() => {}))
  }
})

test('P1-6 a frame arriving during a read is rechecked before any of its text can be returned', { skip, timeout: 30_000 }, async t => {
  const { page, engine, controls, privacy } = await rig(t)
  const seedEntered = Promise.withResolvers<void>(), releaseSeed = Promise.withResolvers<void>()
  const proofEntered = Promise.withResolvers<void>(), recheckEntered = Promise.withResolvers<void>()
  const releaseProof = Promise.withResolvers<void>()
  let firstFrame: string | undefined, proofs = 0, finished = false
  controls.afterSeed = async frameId => {
    firstFrame ??= frameId
    if (frameId === firstFrame) { seedEntered.resolve(); await releaseSeed.promise }
  }
  await page.evaluate(() => document.body.appendChild(document.createElement('iframe')))
  await within(seedEntered.promise)
  const reading: Promise<any> = privacy.read(page).then((facts: any) => { finished = true; return facts })
  // Let this read capture its cutoff and wait on the already tracked seed.
  await new Promise(resolve => setImmediate(resolve))
  controls.beforeListeners = async () => {
    proofs++
    proofEntered.resolve()
    if (proofs >= 2) recheckEntered.resolve()
    await releaseProof.promise
  }
  try {
    await page.evaluate(() => {
      const frame = document.createElement('iframe')
      document.body.appendChild(frame)
      const doc = frame.contentDocument!
      doc.open()
      doc.write('<html lang="en"><h1>SYNTHETIC_LATE_FRAME_TEXT</h1><input><script>window.addEventListener("keydown",()=>{},true)</script></html>')
      doc.close()
    })
    await within(proofEntered.promise)
    releaseSeed.resolve()
    await within(recheckEntered.promise)
    assert.equal(finished, false, 'the late frame proof must finish before the read returns')
    releaseProof.resolve()
    const facts = await within(reading)
    assert.equal(privacy.reloadRequired(page), true, 'a capture listener ahead of the watcher requires a reload')
    assert.deepEqual(facts.values, [])
    assert.deepEqual(facts.fields, [])
    const reply = textOf(await within(engine.callTool('browser_snapshot')))
    assert.doesNotMatch(reply, /SYNTHETIC_LATE_FRAME_TEXT/)
    assert.match(reply, /reload/i)
    t.diagnostic(`late frame checked ${proofs} times; protected read and snapshot withheld its text`)
  } finally {
    releaseSeed.resolve()
    releaseProof.resolve()
    await within(reading.catch(() => {}))
  }
})
