/**
 * A browser on the agent's machine keeps what it holds to itself, on the real engine
 * and a real Chromium. No other local process gets a way in through a debugging port,
 * and no page text lands in a file: not in the agent's folder and not in temp.
 * Made up values on loopback. No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChromiumEngine, DEFAULT_CAPS, PlaywrightEngine, keepPageOutOfFiles, loadPlaywright, resolveChromeExecutable, sweepPageFiles } from '../bin/hoai-browser-host.mjs'

const chrome = resolveChromeExecutable()
const posix = process.platform !== 'win32'
const lsofPath = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(existsSync)
const skip = !chrome.path ? 'no Chrome or Chromium is installed on this machine' : false

const made = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The process and every descendant, by the system's own process table. */
function treeOf(root: number): number[] {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=']).toString().trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
  const tree = new Set([root])
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true } }
  return [...tree]
}

/** Every TCP port the process tree listens on, as lsof reports them. */
function listeningPorts(root: number): number[] {
  let out = ''
  try { out = execFileSync(lsofPath!, ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', treeOf(root).join(','), '-Fn'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch (error: any) { if (error.status !== 1) throw error }
  return out.split('\n').filter(line => line.startsWith('n')).map(line => Number(line.split(':').pop()))
}

/** What a separate process with an empty environment gets when it asks a port who it is. */
function outsideClient(port: number): string {
  try {
    return execFileSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/json/version').then(r=>r.json()).then(j=>console.log(j.webSocketDebuggerUrl?'ANSWERED':'NOTHING'),()=>console.log('NOTHING'))`], { env: {}, timeout: 15_000 }).toString().trim()
  } catch { return 'NOTHING' }
}

test('no other local process finds a debugging port on this browser, and the same probe finds one that has it', { timeout: 120_000, skip: skip || !posix || !lsofPath ? (skip || 'needs lsof') : false }, async () => {
  const home = made('bh-port-')
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  const control = spawn(chrome.path!, ['--remote-debugging-port=0', `--user-data-dir=${join(home, 'control')}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true })
  try {
    await engine.start()
    await engine.vault.context.setStorageState({ cookies: [{ name: 'sid', value: 'MADE_UP_VALUE', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] })
    const pid = engine._child.pid
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'the host knows its Chrome')
    assert.deepEqual(listeningPorts(pid), [], 'this browser listens on no port')
    assert.equal(existsSync(join(engine._runtimeDir, 'DevToolsActivePort')), false, 'and leaves no endpoint file')
    assert.ok(!execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)]).toString().includes('--remote-debugging-port'), 'and was not started with the flag')
    assert.equal((await engine.vault.context.cookies()).length, 1, 'while the host itself still drives it')

    // CONTROL, same probe: a Chrome with the flag is found, and answers a stranger.
    let ports: number[] = []
    for (let i = 0; i < 100 && !ports.length; i++) { await sleep(100); ports = listeningPorts(control.pid!) }
    assert.ok(ports.length > 0, 'the probe finds a port on a browser that has one')
    assert.equal(outsideClient(ports[0]), 'ANSWERED', 'and the outside client reaches it')
  } finally {
    if (Number.isInteger(control.pid) && control.pid! > 1) { try { process.kill(-control.pid!, 'SIGKILL') } catch {} }
    await engine.stop().catch(() => {})
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }
})

test('the host hears when its Chrome has gone, pid and all', { timeout: 60_000, skip: skip || !posix ? (skip || 'posix') : false }, async () => {
  const home = made('bh-gone-')
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  try {
    await engine.start()
    const child = engine._child
    let exited = false
    child.once('exit', () => { exited = true })
    assert.equal(child.exitCode, null)
    child.kill('SIGKILL')
    for (let i = 0; i < 100 && !exited; i++) await sleep(50)
    assert.equal(exited, true, 'the host hears that its Chrome is gone')
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/)
  } finally {
    await engine.stop().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

/** Every readable file under a folder. Links are not followed. */
function filesUnder(folder: string, out: string[] = []): string[] {
  let names: string[] = []
  try { names = readdirSync(folder) } catch { return out }
  for (const name of names) {
    const file = join(folder, name)
    try {
      const stat = lstatSync(file)
      if (stat.isDirectory()) filesUnder(file, out)
      else if (stat.isFile() && stat.size < 64 * 1024 * 1024) out.push(file)
    } catch {}
  }
  return out
}
const holding = (files: string[], value: string) => files.filter(file => { try { return readFileSync(file).includes(value) } catch { return false } })

/** Everything this test could have written: the agent's folder, and whatever appeared in temp since it began. */
function scanned(home: string, tempBefore: Set<string>): string[] {
  const temp = tmpdir()
  const fresh = readdirSync(temp).filter(name => !tempBefore.has(name)).map(name => join(temp, name))
  return [...filesUnder(home), ...fresh.flatMap(path => { try { return statSync(path).isDirectory() ? filesUnder(path) : [path] } catch { return [] } })]
}

test('a signed in page: no file under the agent\'s folder or temp holds its text, while the agent still reads it', { timeout: 180_000, skip }, async () => {
  const MARKER = `MADE_UP_CODE_${randomBytes(9).toString('hex')}`
  const MASKED = `MADE_UP_MASKED_${randomBytes(9).toString('hex')}`
  const LINKED = `MADE_UP_LINK_${randomBytes(9).toString('hex')}`
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<title>Security settings</title><h1>Recovery code ${MARKER}</h1><label>Password <input type="password" aria-label="Password" value="${MASKED}"></label><label>Note <input aria-label="Note" value="an ordinary value"></label><a href="/next?token=${LINKED}">Next</a><button>Show</button>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const home = made('bh-page-')
  const tempBefore = new Set(readdirSync(tmpdir()))
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'browser-output', 'k'), scope: 'fixture' })
  try {
    await engine.start()
    const cleanShot = await engine.callTool('browser_take_screenshot', {})
    assert.ok(cleanShot.content.some((part: any) => part.type === 'image'), 'a fresh page without protected content still has image output')
    const replies: any[] = []
    const call = async (name: string, args: any = {}) => { const reply = await engine.callTool(name, args); replies.push({ name, reply }); return reply }
    await call('browser_navigate', { url })
    const snapshot = await call('browser_snapshot', {})
    const text = JSON.stringify(snapshot)
    assert.ok(text.includes(MARKER), 'the agent reads what the page displays, so the check below is not about an empty page')
    assert.ok(text.includes('an ordinary value'), 'and an ordinary field keeps its value')
    assert.equal(text.includes(MASKED), false, 'a masked input keeps its value out of the reply')
    const ref = /button \\"Show\\" \[ref=(e\d+)\]/.exec(text)?.[1]
    assert.ok(ref)
    await call('browser_click', { target: ref })
    await call('browser_snapshot', { filename: 'named.yml' })
    await call('browser_take_screenshot', {})
    await call('browser_take_screenshot', { filename: 'named.png' })
    const found = await call('browser_find', { text: 'Recovery', filename: 'found.md' })
    assert.ok(JSON.stringify(found).includes(MARKER), 'a named find answers in the reply instead')
    await sleep(300)

    // While the browser is open: the agent's folder and temp, the runtime folder included.
    assert.ok(filesUnder(engine._runtimeDir).length > 0, 'the scan reaches the live runtime folder')
    assert.deepEqual(holding(scanned(home, tempBefore), MARKER), [], 'no file holds the page text while it is open')
    assert.deepEqual(holding(scanned(home, tempBefore), MASKED), [], 'nor the masked value')
    assert.deepEqual(holding(scanned(home, tempBefore), LINKED), [], 'nor the token in a link')
    assert.deepEqual(readdirSync(join(home, 'browser-output', 'k')), [], 'no page file of any kind: a picture of a page is that page')
    for (const { name, reply } of replies) {
      const body = JSON.stringify(reply)
      assert.notEqual(reply.isError, true, `${name} answered: ${body.slice(0, 300)}`)
      assert.equal(/\.yml|page-\d|\.png\)/.test(body), false, `${name} links no file: ${body.slice(0, 400)}`)
    }
    const shot = replies.find(row => row.name === 'browser_take_screenshot').reply
    assert.equal(shot.content.some((part: any) => part.type === 'image'), false, 'protected form pixels are withheld')
    assert.ok(shot.content.some((part: any) => /withheld/.test(part.text || '')), 'the refusal explains why')

    // CONTROL, same scanner: a file that holds it is found.
    writeFileSync(join(home, 'control.txt'), MARKER)
    assert.deepEqual(holding(scanned(home, tempBefore), MARKER), [join(home, 'control.txt')], 'the scanner finds the marker when a file holds it')
    rmSync(join(home, 'control.txt'))

    await engine.stop()
    assert.deepEqual(holding(scanned(home, tempBefore), MARKER), [], 'and none after it closes')
  } finally {
    await engine.stop().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  }
})

test('a page file an earlier run left goes: at the next start of that browser and at its close', { timeout: 120_000, skip }, async () => {
  const home = made('bh-left-')
  const outputDir = join(home, 'browser-output', 'k')
  mkdirSync(join(outputDir, 'older'), { recursive: true })
  writeFileSync(join(outputDir, 'page-2026-11-01.yml'), 'MADE_UP_LEFT_BEHIND')
  writeFileSync(join(outputDir, 'older', 'console-1.log'), 'MADE_UP_LEFT_BEHIND')
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir, scope: 'fixture' })
  try {
    await engine.start()
    assert.deepEqual(readdirSync(outputDir), [], 'gone at the start')
    writeFileSync(join(outputDir, 'written-during.pdf'), 'x')
    await engine.stop()
    assert.deepEqual(readdirSync(outputDir), [], 'and at the close')
  } finally {
    await engine.stop().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

test('a page file left for a principal that never opens again goes when the host first serves the agent, and only that agent', () => {
  const home = made('bh-sweep-')
  try {
    for (const id of ['900', '901']) {
      mkdirSync(join(home, id, 'browser-output', 'user-a'), { recursive: true })
      writeFileSync(join(home, id, 'browser-output', 'user-a', 'page-1.yml'), 'MADE_UP_LEFT_BEHIND')
      mkdirSync(join(home, id, 'downloads'), { recursive: true })
      writeFileSync(join(home, id, 'downloads', 'kept.bin'), 'the owner kept this')
    }
    sweepPageFiles({ agentRoot: home, assistantId: 900 })
    assert.deepEqual(readdirSync(join(home, '900', 'browser-output')), [])
    assert.equal(readFileSync(join(home, '900', 'downloads', 'kept.bin'), 'utf8'), 'the owner kept this', 'a kept download is not a page file')
    assert.deepEqual(readdirSync(join(home, '901', 'browser-output')), ['user-a'], 'another agent is its own host\'s to sweep')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a PDF of a page is never written on this machine: a live cookie changes nothing the host can see, so nothing opens it', { timeout: 120_000, skip }, async () => {
  const home = made('bh-pdf-')
  const outputDir = join(home, 'browser-output', 'k')
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir, scope: 'fixture' })
  try {
    await engine.start()
    await engine.callTool('browser_navigate', { url: 'data:text/html,<h1>made up</h1>' })
    for (const state of [{ holdsSignIns: false }, { holdsSignIns: true }]) {
      Object.assign(engine, state)
      const refused = await engine.callTool('browser_pdf_save', {})
      assert.equal(refused.isError, true, JSON.stringify(refused).slice(0, 200))
      assert.match(JSON.stringify(refused), /not saved as a file/)
      assert.deepEqual(readdirSync(outputDir), [])
    }
  } finally {
    await engine.stop().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

test('a masked field keeps its value out of every reply on the real engine: a plain line, a quoted line, a placeholder, a frame, and browser_find', { timeout: 180_000, skip }, async () => {
  const VALUES = { plain: `MADE_UP_PLAIN_${randomBytes(6).toString('hex')}`, quoted: `MADE_UP_QUOTED_${randomBytes(6).toString('hex')}`, holder: `MADE_UP_HOLDER_${randomBytes(6).toString('hex')}`, framed: `MADE_UP_FRAMED_${randomBytes(6).toString('hex')}`, styled: `MADE_UP_STYLED_${randomBytes(6).toString('hex')}`, area: `MADE_UP_AREA_${randomBytes(6).toString('hex')}`, editable: `MADE_UP_EDITABLE_${randomBytes(6).toString('hex')}` }
  const NOTE = 'an ordinary value', frame = `<input type=password aria-label='In frame' value='${VALUES.framed}'>`
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<title>Keys</title><label>Plain <input type="password" aria-label="Plain" value="${VALUES.plain}"></label><input type="password" aria-label="Key: required" value="${VALUES.quoted}"><input type="password" aria-label="Holder" placeholder="Enter key" value="${VALUES.holder}"><input aria-label="Styled" style="-webkit-text-security:disc" value="${VALUES.styled}"><textarea aria-label="Area" style="-webkit-text-security:disc">${VALUES.area}</textarea><div contenteditable role="textbox" aria-label="Editable" style="-webkit-text-security:disc">${VALUES.editable}</div><input aria-label="Note" value="${NOTE}"><iframe srcdoc="${frame}"></iframe>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const home = made('bh-mask-')
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'browser-output', 'k'), scope: 'fixture' })
  try {
    await engine.start()
    await engine.callTool('browser_navigate', { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })
    await sleep(300)
    const page = engine.pages()[0], held = await page.locator('input[aria-label="Plain"]').inputValue()
    assert.equal(held, VALUES.plain, 'CONTROL: the page really holds the value')
    const replies: Record<string, any> = {
      snapshot: await engine.callTool('browser_snapshot', {}),
      findPlain: await engine.callTool('browser_find', { text: 'Plain' }),
      findQuoted: await engine.callTool('browser_find', { text: 'Key' }),
      findHolder: await engine.callTool('browser_find', { text: 'Holder' }),
      findFrame: await engine.callTool('browser_find', { regex: 'textbox' }),
    }
    const tree = JSON.stringify(replies.snapshot)
    assert.ok(tree.includes(NOTE), 'an ordinary field keeps its value')
    for (const name of ['Plain', 'Key: required', 'Holder', 'Styled', 'Area', 'Editable', 'In frame']) assert.ok(tree.includes(name), `the field ${name} is still there: ${tree.slice(0, 600)}`)
    assert.match(JSON.stringify(replies.findFrame), /textbox/, 'find answered')
    for (const [name, reply] of Object.entries(replies)) for (const [form, value] of Object.entries(VALUES)) assert.equal(JSON.stringify(reply).includes(value), false, `${name} carried the ${form} value`)
    // The same value elsewhere on the page is that value too, by a route a line of the tree cannot show.
    await page.evaluate((value: string) => { const p = document.createElement('p'); p.textContent = `Copied ${value}`; document.body.append(p) }, VALUES.plain)
    assert.equal(JSON.stringify(await engine.callTool('browser_snapshot', {})).includes(VALUES.plain), false, 'text repeating a masked value')
    // With the last net off the fields still hold: their values were never read into a tree. Only the copy
    // in plain text, which is the net's whole job, comes back.
    const inner = engine._engine, net = inner._privacy.text
    inner._privacy.text = (text: string) => text
    for (const args of [['browser_snapshot', {}], ['browser_find', { regex: 'textbox' }]] as const) {
      const text = JSON.stringify(await engine.callTool(args[0], args[1]))
      for (const [form, value] of Object.entries(VALUES)) if (form !== 'plain') assert.equal(text.includes(value), false, `${args[0]} carried the ${form} value with the net off`)
    }
    inner._privacy.text = net
    // An error that quotes a value a call just typed into a masked box is redacted as well.
    const TYPED = `MADE_UP_TYPED_${randomBytes(6).toString('hex')}`
    await page.locator('input[aria-label="Plain"]').fill(TYPED)
    const backend = inner._backend, real = backend.callTool
    backend.callTool = async () => { throw new Error(`failed near ${TYPED}`) }
    await assert.rejects(engine.callTool('browser_snapshot', {}), (error: Error) => error.message === 'Browser command failed. No page details were released.' && !error.message.includes(TYPED))
    backend.callTool = real
  } finally {
    await engine.stop().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  }
})

test('a page that was already open when a managed browser started is masked on both doors', { timeout: 120_000, skip }, async () => {
  const VALUE = `MADE_UP_OPEN_${randomBytes(6).toString('hex')}`
  const home = made('bh-open-')
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch({ executablePath: chrome.path!, headless: true })
  const context = await browser.newContext(), page = await context.newPage()
  await page.setContent(`<title>Keys</title><input type="password" aria-label="Open" value="${VALUE}">`)
  const engine: any = new PlaywrightEngine({ caps: DEFAULT_CAPS, outputDir: home, clientName: 'fixture', clientVersion: '0', managedRuntime: { browser, context, assertCurrent() {} } })
  try {
    await engine.start()
    engine._privacy.text = (text: string) => text // the tree alone, with no net behind it
    const found = JSON.stringify(await engine.callTool('browser_find', { regex: 'textbox' }))
    assert.match(found, /Open/, found.slice(0, 300))
    assert.equal(found.includes(VALUE), false, found.slice(0, 300))
  } finally {
    await browser.close().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

test('a Playwright that moved the methods the guard replaces stops the call, not the guard', () => {
  assert.throws(() => keepPageOutOfFiles('browser_snapshot', {}, {}), { code: 'browser_unavailable' })
  assert.throws(() => keepPageOutOfFiles('browser_snapshot', {}, { _writeFile() {}, addCode() {} }), { code: 'browser_unavailable' })
  const response: any = { _writeFile() {}, addFileResult() {}, addCode() {} }
  assert.deepEqual(keepPageOutOfFiles('browser_snapshot', { filename: 'x.yml', depth: 2 }, response), { depth: 2 }, 'a named file is not written anywhere')
  return assert.rejects(response._writeFile({}, 'page text'), { code: 'not_available' })
})
