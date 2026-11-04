/**
 * What a page writes to its console stays out of the agent's reach. A signed in page
 * can log its own token. The machine holds sealed sign-ins, and the brief's limit is
 * that no value reaches the agent's model, files or chat. Playwright's tab keeps every
 * console line, and writes it to a log file in the agent's own output folder that a
 * snapshot links to. The desktop engine switched this off (engine.js
 * _isolatePageDiagnostics); this host has to as well.
 * No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CAPS, PlaywrightEngine, loadPlaywright, resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'

const chrome = resolveChromeExecutable()
const skip = !chrome.path ? 'no Chrome or Chromium is installed on this machine' : false
const VALUE = 'SYNTHETIC_PAGE_TOKEN_7731'

function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap(name => {
    const file = join(folder, name)
    return statSync(file).isDirectory() ? filesUnder(file) : [file]
  })
}

test('a value a page logs reaches no reply and no file the agent can read', { timeout: 120_000, skip }, async () => {
  if (skip) return
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<title>t</title><button id="b" onclick="console.log('click ${VALUE}');console.error('error ${VALUE}')">Log</button><script>console.log('load ${VALUE}');setTimeout(()=>{throw new Error('thrown ${VALUE}')},0)</script>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bh-con-')))
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch({ executablePath: chrome.path!, headless: true })
  const context = await browser.newContext()
  await context.newPage()
  const engine: any = new PlaywrightEngine({
    endpoint: null, caps: DEFAULT_CAPS, outputDir: home, clientName: 'fixture', clientVersion: '0',
    managedRuntime: { browser, context, assertCurrent() {} },
  })
  try {
    await engine.start()
    const replies: unknown[] = []
    replies.push(await engine.callTool('browser_navigate', { url }))
    await new Promise(resolve => setTimeout(resolve, 200))
    const snapshot = await engine.callTool('browser_snapshot', {})
    replies.push(snapshot)
    const ref = /button \\"Log\\" \[ref=(e\d+)\]/.exec(JSON.stringify(snapshot))?.[1]
    assert.ok(ref, 'the page is on screen for the agent')
    replies.push(await engine.callTool('browser_click', { target: ref }))
    replies.push(await engine.callTool('browser_snapshot', {}))
    for (const reply of replies) assert.equal(JSON.stringify(reply).includes(VALUE), false, JSON.stringify(reply).slice(0, 600))
    for (const file of filesUnder(home)) assert.equal(readFileSync(file).includes(VALUE), false, `${file} holds the value`)
  } finally {
    await browser.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  }
})
