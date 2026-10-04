/** Opt-in: node --import tsx test/helpers/packaged-browser-bootstrap-smoke.ts
 * Builds npm pack, installs fresh dependencies, then boots the packaged
 * production supervisor in an isolated Windows home and empty browser cache.
 * No production account, executable override or browser wrapper is used.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const required = ['skills/hoai-browser/SKILL.md', 'lib/browser-bootstrap.mjs', 'lib/agent-browser-vault.mjs',
  'lib/remote-credentials.mjs', 'lib/remote-credentials-crypto.cjs', 'lib/browser-secret-redactor.mjs',
  'lib/browser-host-supervisor.ts', 'bin/hoai-browser-host.mjs']
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile?: string) {
  return new Promise<string>((resolve, reject) => {
    let text = '', stdout = ''
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => { text += data.toString(); stdout += data.toString() })
    child.stderr.on('data', data => { text += data.toString() })
    child.once('error', reject)
    child.once('exit', code => {
      if (logFile) writeFileSync(logFile, text)
      if (code === 0) resolve(stdout)
      else reject(new Error(`Command failed with exit ${code}: ${executable} ${args[0] || ''}\n${text.slice(-6000)}`))
    })
  })
}

function freshEnvironment(root: string) {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|USERNAME|USERDOMAIN|COMPUTERNAME|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)) env[key] = value
  }
  const home = join(root, 'home'), local = join(home, 'AppData', 'Local'), temp = join(root, 'temp')
  for (const path of [home, local, temp, join(root, 'program-files'), join(root, 'program-files-x86'), join(root, 'npm-cache')]) mkdirSync(path, { recursive: true })
  Object.assign(env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: join(home, 'AppData', 'Roaming'),
    TEMP: temp, TMP: temp, PROGRAMFILES: join(root, 'program-files'), 'PROGRAMFILES(X86)': join(root, 'program-files-x86'),
    PROGRAMW6432: join(root, 'program-files'), NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: join(root, 'empty.npmrc'), NPM_CONFIG_UPDATE_NOTIFIER: 'false' })
  writeFileSync(env.NPM_CONFIG_USERCONFIG!, '')
  return env
}

async function outer() {
  assert.equal(process.platform, 'win32', 'This smoke isolates Windows installed-browser roots; other platforms need their own clean image.')
  const report = resolve(repository, 'docs/reports/2026-10-04-remote-credentials')
  mkdirSync(report, { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'hoai-packaged-browser-'))
  const env = freshEnvironment(root), npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  assert.ok(existsSync(npm), 'Node installation must include npm for the fresh package install.')
  const transcript: string[] = []
  const step = (line: string) => { transcript.push(`${new Date().toISOString()} ${line}`); console.log(line) }
  try {
    step('Packing the current plugin into a local npm artifact.')
    const output = await command(process.execPath, [npm, 'pack', '--json', '--pack-destination', root], repository, env)
    const packed = JSON.parse(output)[0]
    for (const path of required) assert.ok(packed.files.some((file: any) => file.path === path), `Package missing ${path}`)
    writeFileSync(join(report, 'packaged-bootstrap-manifest.json'), JSON.stringify({ version: packed.version,
      filename: packed.filename, integrity: packed.integrity, shasum: packed.shasum, requiredFiles: required,
      files: packed.files.map((file: any) => ({ path: file.path, size: file.size })) }, null, 2))
    const archive = join(root, packed.filename)
    await command('tar.exe', ['-xf', archive, '-C', root], root, env)
    const installed = join(root, 'package')
    assert.equal(existsSync(join(installed, 'node_modules')), false)
    step('Installing fresh packaged dependencies with an empty npm user cache.')
    await command(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
      installed, env, join(report, 'packaged-bootstrap-install.txt'))
    step('Starting the packaged supervisor, local relay and first browser task with an empty browser cache.')
    const loader = join(installed, 'node_modules/tsx/dist/loader.mjs')
    const inner = join(installed, 'test/helpers/packaged-browser-bootstrap-smoke.ts')
    const result = await command(process.execPath, ['--import', pathToFileURL(loader).href, inner, '--inner', root, report], installed, env,
      join(report, 'packaged-bootstrap-inner.txt'))
    step(result.trim())
    const evidence = JSON.parse(readFileSync(join(report, 'packaged-bootstrap-evidence.json'), 'utf8'))
    const requiredSourceMatches = Object.fromEntries(Object.entries(evidence.requiredFileSha256).map(([path, digest]) =>
      [path, createHash('sha256').update(readFileSync(join(repository, path))).digest('hex') === digest]))
    assert.ok(Object.values(requiredSourceMatches).every(Boolean), 'Required working source changed during packaging; run again against the final source.')
    const escaped = evidence.browserExecutable.replaceAll("'", "''")
    const remaining = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' }).Count`], repository, process.env)
    assert.equal(Number(remaining.trim()), 0, 'Disposable Chromium processes must exit after the smoke.')
    evidence.requiredSourceMatches = requiredSourceMatches
    evidence.chromiumProcessesAfterCleanup = 0
    writeFileSync(join(report, 'packaged-bootstrap-evidence.json'), JSON.stringify(evidence, null, 2))
    step(`PASS. Disposable install retained for inspection at ${root}`)
    writeFileSync(join(report, 'packaged-bootstrap-run.json'), JSON.stringify({ passed: true, root, installed,
      archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      command: 'node --import tsx test/helpers/packaged-browser-bootstrap-smoke.ts', completedAt: new Date().toISOString() }, null, 2))
    writeFileSync(join(report, 'packaged-bootstrap-summary.md'), `# Packaged browser bootstrap smoke\n\n` +
      `Passed on ${evidence.completedAt} with Node ${evidence.node} on Windows. Package and plugin manifest version: ${packed.version}.\n\n` +
      `Reproduce from the plugin worktree with:\n\n\`\`\`powershell\nnode --import tsx test/helpers/packaged-browser-bootstrap-smoke.ts\n\`\`\`\n\n` +
      `The smoke creates npm pack, extracts it, and installs fresh dependencies with an empty npm user cache. It uses an isolated HOME, USERPROFILE, LOCALAPPDATA and installed-browser search roots. The browser cache starts absent. The packaged production startBrowserHostSupervisor connects the actual host to a synthetic local relay. No executable override, browser wrapper or manual browser install is used.\n\n` +
      `First browser use downloaded pinned Chromium and opened the page in ${evidence.firstUseMs} ms. The actual credential prepare route returned configured=false, unlocked=false, legacy=false. A session cookie was present before closing the locked browser and absent after reopening. A new supervisor process also reopened the same protected profile successfully. Chromium ran with no sandbox-disabling flags, and no fixture Chromium process remained after cleanup.\n\n` +
      `All ${required.length} required skill and runtime files are included and match the final worktree byte for byte. SHA256 values, process command lines and storage results are in [packaged-bootstrap-evidence.json](packaged-bootstrap-evidence.json). The archive hash and retained disposable install are in [packaged-bootstrap-run.json](packaged-bootstrap-run.json).\n\n` +
      `This verifies Windows packaging and the normal supervisor/bootstrap path with a disposable local relay. Native owner-dialog, encrypted restart-state and remote Linux proof are separate checks. No production records were used.\n`)
  } catch (error) {
    step(`FAIL. ${error instanceof Error ? error.message : String(error)}`)
    writeFileSync(join(report, 'packaged-bootstrap-run.json'), JSON.stringify({ passed: false, root, completedAt: new Date().toISOString() }, null, 2))
    throw error
  } finally { writeFileSync(join(report, 'packaged-bootstrap-transcript.txt'), transcript.join('\n') + '\n') }
}

async function inner(root: string, report: string) {
  const { startBrowserHostSupervisor } = await import(pathToFileURL(join(repository, 'lib/browser-host-supervisor.ts')).href)
  const { startFakeRelay } = await import(pathToFileURL(join(repository, 'test/helpers/fake-browser-relay.ts')).href)
  const { resolveChromeExecutable, browserPathsFor } = await import(pathToFileURL(join(repository, 'bin/hoai-browser-host.mjs')).href)
  const { bundledChromium } = await import(pathToFileURL(join(repository, 'lib/browser-bootstrap.mjs')).href)
  assert.equal(process.env.HOAI_BROWSER_EXECUTABLE, undefined)
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, undefined)
  assert.equal(resolveChromeExecutable().path, null, 'The isolated installed-browser roots must hide machine Chrome.')
  const bundled = bundledChromium()
  assert.ok(relative(root, bundled.cache) && !relative(root, bundled.cache).startsWith('..'), 'Browser cache must belong to this disposable home.')
  assert.equal(existsSync(bundled.executable), false, 'No existing Chromium revision can satisfy this proof.')
  assert.equal(existsSync(bundled.cache), false, 'Browser cache must initially be absent.')
  assert.ok(realpathSync(join(repository, 'node_modules/playwright-core')).startsWith(root))
  const version = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version
  const manifestVersion = JSON.parse(readFileSync(join(repository, '.claude-plugin/plugin.json'), 'utf8')).version
  assert.equal(version, manifestVersion)
  for (const path of required) assert.ok(existsSync(join(repository, path)))
  const token = 'synthetic-packaged-smoke-token', assistantId = 991, principal = 'user-packaged-smoke'
  const relay = await startFakeRelay({ token, admissible: [assistantId] })
  relay.autoAnswer('allow_session')
  const site = createServer((req, res) => {
    const present = String(req.headers.cookie || '').includes('packaged_cookie=synthetic_canary')
    if (req.url === '/set') res.setHeader('Set-Cookie', 'packaged_cookie=synthetic_canary; Path=/; HttpOnly; SameSite=Lax')
    res.setHeader('Content-Type', 'text/html')
    res.end(`<html><title>Packaged browser fixture</title><h1>${req.url === '/set' ? 'COOKIE SET' : present ? 'COOKIE PRESENT' : 'COOKIE ABSENT'}</h1></html>`)
  })
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  const agentRoot = join(process.env.USERPROFILE!, '.bgos-agent'), logs: string[] = []
  const start = () => startBrowserHostSupervisor({ env: process.env, auth: { mode: 'pairing', complete: true,
    backendUrl: relay.backendUrl, pairingToken: token, assistantId: String(assistantId) }, agentRoot,
    hostScript: join(repository, 'bin/hoai-browser-host.mjs'), nodePath: process.execPath, log: (line: string) => logs.push(line) })
  let supervisor = start()
  let socket: any, opened = false, id = 0
  const hostPid = supervisor.child?.pid
  const tool = async (name: string, args: any = {}) => {
    const { post } = await relay.rpc(socket, { assistantId, principal, clientId: 'packaged-smoke',
      message: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } } }, 180_000)
    assert.ok(post, `${name} returned no result`)
    assert.equal(post.status, 200)
    assert.equal(post.body.ok, true, JSON.stringify(post.body))
    assert.notEqual(post.body.message?.result?.isError, true, JSON.stringify(post.body.message))
    return post.body.message.result.content.map((item: any) => item.text || '').join('\n')
  }
  const startedAt = Date.now()
  try {
    assert.equal(supervisor.state, 'running')
    socket = await relay.waitForHost(30_000)
    await tool('hoai_browser_open_session', { purpose: 'Packaged first-use bootstrap proof' }); opened = true
    const firstUseMs = Date.now() - startedAt
    assert.ok(existsSync(bundled.executable), 'The ordinary first task must install the pinned browser.')
    const paths = browserPathsFor({ agentRoot, assistantId, principal })
    const viewId = 'packaged_smoke_view'
    const frames: any[] = []
    socket.on('browser_view_frame', (message: any) => { if (message.viewId === viewId) frames.push(message.frame) })
    socket.emit('browser_view_open', { viewId, assistantId, principal })
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 15_000
      while (!predicate()) { assert.ok(Date.now() < deadline, 'Remote-view response timed out'); await sleep(25) }
    }
    await until(() => frames.some(frame => frame.method === 'hoai.ready'))
    const ready = frames.find(frame => frame.method === 'hoai.ready').params
    assert.equal(ready.remoteCredentials, true)
    socket.emit('browser_view_command', { viewId, frame: { id: 200, sessionId: ready.sessionId, tabId: ready.tabId,
      method: 'hoai.credentials.prepare', params: { operation: 'unlock' } } })
    await until(() => frames.some(frame => frame.id === 200))
    const prepared = frames.find(frame => frame.id === 200)
    assert.equal(prepared.error, undefined, JSON.stringify(prepared.error))
    assert.deepEqual(prepared.result.storage, { configured: false, unlocked: false, legacy: false })
    socket.emit('browser_view_command', { viewId, frame: { id: 201, sessionId: ready.sessionId, tabId: ready.tabId,
      method: 'hoai.credentials.cancel', params: { requestId: prepared.result.offer.requestId } } })
    await until(() => frames.some(frame => frame.id === 201))
    assert.deepEqual(frames.find(frame => frame.id === 201).result, {})
    await tool('browser_navigate', { url: `${url}/set` })
    await tool('browser_navigate', { url: `${url}/show` })
    assert.match(await tool('browser_snapshot'), /COOKIE PRESENT/)
    await tool('hoai_browser_close_session'); opened = false
    await tool('hoai_browser_open_session', { purpose: 'Verify locked session is discarded' }); opened = true
    await tool('browser_navigate', { url: `${url}/show` })
    assert.match(await tool('browser_snapshot'), /COOKIE ABSENT/)
    await tool('hoai_browser_close_session'); opened = false
    const firstChild = supervisor.child
    supervisor.stop()
    await until(() => firstChild?.exitCode !== null || firstChild?.signalCode !== null)
    await until(() => !socket.connected)
    supervisor = start()
    socket = await relay.waitForHost(30_000)
    await tool('hoai_browser_open_session', { purpose: 'Verify a new host can reopen the protected profile' }); opened = true
    await tool('browser_navigate', { url: `${url}/show` })
    assert.match(await tool('browser_snapshot'), /COOKIE ABSENT/)
    const escaped = bundled.executable.replaceAll("'", "''")
    const raw = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`], repository, process.env)
    const processes = JSON.parse(raw), list = Array.isArray(processes) ? processes : [processes]
    assert.ok(list.length > 1, 'Actual browser and child processes must be running.')
    assert.ok(list.every((item: any) => !/--no-sandbox|--disable-setuid-sandbox/.test(item.CommandLine || '')))
    assert.ok(list.some((item: any) => /--type=renderer/.test(item.CommandLine || '')))
    writeFileSync(join(report, 'packaged-bootstrap-evidence.json'), JSON.stringify({ completedAt: new Date().toISOString(),
      platform: process.platform, node: process.version, version, manifestVersion, repository, root, hostPid,
      startup: 'startBrowserHostSupervisor from unpacked artifact', restartedHostPid: supervisor.child?.pid,
      hostProcessRestartReopenedProfile: true, installedBrowserFoundInitially: false,
      browserCacheInitiallyAbsent: true, browserExecutable: bundled.executable, firstUseMs,
      freshDependencyPath: realpathSync(join(repository, 'node_modules/playwright-core')),
      packageRequiredFiles: required, requiredFileSha256: Object.fromEntries(required.map(path =>
        [path, createHash('sha256').update(readFileSync(join(repository, path))).digest('hex')])),
      remoteCredentialsAdvertised: true, initialStorage: prepared.result.storage,
      lockedCookiePresentBeforeClose: true, lockedCookieAbsentAfterReopen: true,
      unsafeSandboxFlags: false, chromiumProcessCount: list.length, chromiumProcesses: list,
      profileFilesWhileLocked: readdirSync(paths.profileDir), localRelayOnly: true }, null, 2))
    console.log(`PASS: packaged ${version}, first-use download ${firstUseMs}ms, locked storage, cookie discard and host process restart verified.`)
  } finally {
    if (opened && socket?.connected) {
      try { await tool('hoai_browser_close_session'); opened = false } catch {}
    }
    if (opened && supervisor.child?.pid) { try { await command('taskkill.exe', ['/PID', String(supervisor.child.pid), '/T', '/F'], repository, process.env) } catch {} }
    supervisor.stop()
    for (let attempt = 0; attempt < 30 && supervisor.child?.exitCode === null && supervisor.child?.signalCode === null; attempt++) await sleep(100)
    await relay.close()
    site.closeAllConnections?.()
    await new Promise<void>(resolve => site.close(() => resolve()))
    const hostLogs = readdirSync(agentRoot).filter(name => /^browser-host-.*\.log$/.test(name))
      .map(name => readFileSync(join(agentRoot, name), 'utf8')).join('\n')
    assert.equal(hostLogs.includes(token), false, 'Synthetic pairing token must not be logged.')
    writeFileSync(join(report, 'packaged-bootstrap-host.txt'), logs.join('\n') + '\n' + hostLogs)
  }
}

if (process.argv[2] === '--inner') await inner(resolve(process.argv[3]!), resolve(process.argv[4]!))
else await outer()
