import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { win32 } from 'node:path'
import * as vault from '../lib/agent-browser-vault.mjs'
import { hostEnv } from '../lib/browser-env.mjs'
import { ChromiumEngine } from '../bin/hoai-browser-host.mjs'

const run = (...args: any[]) => (vault as any).runWindowsAclScript(...args)

// Model the startup dependency: without a system module path this child never
// answers. The injected daemon environment deliberately has no PSModulePath.
function powershell(answer = '{"set":true}', stall = false) {
  const calls: any[] = []
  let killed = 0
  const spawn = (file: string, args: string[], options: any) => {
    calls.push({ file, args, options })
    const child: any = new EventEmitter()
    child.stdout = new PassThrough()
    child.kill = (signal: string) => { assert.equal(signal, 'SIGKILL'); killed++; return true }
    if (!stall && options.env.SystemRoot && options.env.PSModulePath) setImmediate(() => {
      child.stdout.end(answer)
      child.emit('close', 0, null)
    })
    return child
  }
  return { spawn, calls, killed: () => killed }
}

test('Windows ACL process repairs the missing module path in the daemon environment and yields to the event loop', async () => {
  const env = hostEnv({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PSModulePath: 'C:\\untrusted-modules', SSH_AUTH_SOCK: 'fixture-socket', GH_PAT: 'fixture-secret' }, { platform: 'win32' })
  assert.equal(env.PSModulePath, undefined, 'the real daemon allow list strips the module path')
  const baseline = powershell()
  const blocked = baseline.spawn('powershell.exe', [], { env })
  let answered = false
  blocked.once('close', () => { answered = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(answered, false, 'the injected child stalls with the unrepaired environment')
  blocked.kill('SIGKILL')
  const ps = powershell()
  let ticked = false
  setImmediate(() => { ticked = true })
  const answer = await run('$answer = 1', { env, spawnImpl: ps.spawn, timeoutMs: 1000 })
  assert.deepEqual(answer, { set: true })
  assert.equal(ticked, true, 'permission startup must not block other host requests')
  const { file, args, options } = ps.calls[0]
  assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(args.slice(0, 3), ['-NoLogo', '-NoProfile', '-NonInteractive'])
  assert.equal(args[3], '-EncodedCommand')
  assert.equal(Buffer.from(args[4], 'base64').toString('utf16le'), '$answer = 1')
  assert.equal(options.env.PSModulePath, win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'))
  assert.equal(options.env.TEMP, env.TEMP)
  for (const name of ['SSH_AUTH_SOCK', 'GH_PAT', 'ComSpec']) assert.equal(options.env[name], undefined)
  assert.equal(env.PSModulePath, undefined, 'the caller environment is unchanged')
})

test('Windows ACL process recovers a missing SystemRoot from case-insensitive windir', async () => {
  const ps = powershell()
  assert.deepEqual(await run('fixture', { env: { windir: 'D:\\Windows', tmp: 'D:\\Temp' }, spawnImpl: ps.spawn }), { set: true })
  assert.equal(ps.calls[0].options.env.SystemRoot, 'D:\\Windows')
  assert.equal(ps.calls[0].options.env.TMP, 'D:\\Temp')
  assert.equal(ps.calls[0].file.startsWith('D:\\Windows\\'), true)
})

test('Windows ACL process kills a stalled child within its deadline and reports a readable failure', async () => {
  const ps = powershell('', true)
  const answer = await run('fixture', { env: {}, spawnImpl: ps.spawn, timeoutMs: 20 })
  assert.match(answer.failed, /PowerShell did not finish within 20 ms/)
  assert.equal(ps.killed(), 1)
})

test('Windows ACL process refuses spawn errors, nonzero exits, invalid JSON and excessive output', async () => {
  const broken = () => { throw Object.assign(new Error('fixture'), { code: 'ENOENT' }) }
  assert.match((await run('fixture', { spawnImpl: broken })).failed, /ENOENT/)
  for (const answer of ['not json', 'null', '[]', '{}', '{"set":true}\n' + 'x'.repeat(1024 * 1024)]) {
    assert.equal(typeof (await run('fixture', { env: {}, spawnImpl: powershell(answer).spawn })).failed, 'string')
  }
  const spawn = () => {
    const child: any = new EventEmitter()
    child.stdout = new PassThrough()
    child.kill = () => true
    setImmediate(() => child.emit('error', Object.assign(new Error('fixture'), { code: 'EACCES' })))
    return child
  }
  assert.match((await run('fixture', { spawnImpl: spawn })).failed, /EACCES/)
  const exit = () => {
    const child: any = new EventEmitter()
    child.stdout = new PassThrough()
    setImmediate(() => { child.stdout.end('{"set":true}'); child.emit('close', 1, null) })
    return child
  }
  assert.match((await run('fixture', { spawnImpl: exit })).failed, /exit 1/)
})

test('Windows permission protection awaits both ACL steps before caching success and retries a failure', async () => {
  const folder = 'C:\\fixture-async-profile'
  let calls = 0
  const protect = async (script: string) => {
    calls++
    assert.match(script, /\$PSModuleAutoLoadingPreference = 'None'/)
    assert.match(script, /Import-Module -Name \(\$PSHOME \+ '\\Modules\\Microsoft\.PowerShell\.Utility\\Microsoft\.PowerShell\.Utility\.psd1'\)/)
    await new Promise(resolve => setImmediate(resolve))
    return { set: true }
  }
  await vault.protectWindowsDirectory(folder, { ino: 100 }, protect)
  await vault.protectWindowsDirectory(folder, { ino: 100 }, protect)
  assert.equal(calls, 1)
  await assert.rejects(vault.protectWindowsDirectory(folder, { ino: 101 }, async () => ({ failed: 'PowerShell did not finish within 20 ms' })),
    (error: any) => error.code === 'unsafe_profile' && error.reason === 'acl_step_failed' && /permission step/.test(error.message))
  await vault.protectWindowsDirectory(folder, { ino: 101 }, protect)
  assert.equal(calls, 2, 'a failed check must not cache the replacement folder')
})

// A copy of the module no other test has run PowerShell through, so its first start is still its first.
let freshCopies = 0
const freshVault = async () => import(new URL(`../lib/agent-browser-vault.mjs?first-start=${++freshCopies}`, import.meta.url).href)

// A PowerShell that answers `afterMs` after it is started (on the mocked clock), or never.
function slowPowershell(afterMs: number | null) {
  let killed = 0
  const spawn = () => {
    const child: any = new EventEmitter()
    child.stdout = new PassThrough()
    child.kill = () => { killed++; return true }
    if (afterMs !== null) setTimeout(() => { child.stdout.end('{"set":true}'); child.emit('close', 0, null) }, afterMs)
    return child
  }
  return { spawn, killed: () => killed }
}

test('a first PowerShell start slower than 10 s still protects the profile, and a later start keeps the 10 s limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mod = await freshVault()
  const protect = (ino: number, ps: ReturnType<typeof slowPowershell>) =>
    mod.protectWindowsDirectory('C:\\fixture-first-start', { ino }, (script: string) => mod.runWindowsAclScript(script, { env: { SystemRoot: 'C:\\Windows' }, spawnImpl: ps.spawn }))
  // A cold runner: the first PowerShell of the process takes 15 s to answer.
  const cold = slowPowershell(15_000)
  const first = protect(1, cold)
  t.mock.timers.tick(15_000)
  await first
  assert.equal(cold.killed(), 0)
  // PowerShell has answered once, so a start that takes as long now is a hang: 10 s, as before.
  const later = slowPowershell(15_000)
  const second = protect(2, later)
  t.mock.timers.tick(15_000)
  await assert.rejects(second, (error: any) => error.code === 'unsafe_profile' && error.reason === 'acl_step_failed' && /within 10000 ms/.test(error.detail ?? error.message))
  assert.equal(later.killed(), 1)
})

test('a first PowerShell start that never answers is still cut off, and the next start is still treated as a first', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mod = await freshVault()
  const env = { SystemRoot: 'C:\\Windows' }
  const stalled = slowPowershell(null)
  const answer = mod.runWindowsAclScript('fixture', { env, spawnImpl: stalled.spawn })
  t.mock.timers.tick(30_000)
  assert.match((await answer).failed, /PowerShell did not finish within 30000 ms/)
  assert.equal(stalled.killed(), 1)
  // No PowerShell has answered yet in this process, so the next one gets the first start's time too.
  const cold = slowPowershell(15_000)
  const next = mod.runWindowsAclScript('fixture', { env, spawnImpl: cold.spawn })
  t.mock.timers.tick(15_000)
  assert.deepEqual(await next, { set: true })
})

test('Chrome startup waits for profile protection and stays closed on an asynchronous refusal', async t => {
  let refuse: (error: Error) => void = () => {}
  const pending = new Promise<never>((_, reject) => { refuse = reject })
  t.mock.method(vault.AgentBrowserVault, 'create', () => pending)
  let launches = 0
  const engine = new ChromiumEngine({ profileDir: 'fixture', outputDir: 'fixture', executable: 'unused',
    launch: (() => { launches++; throw new Error('must not launch') }) as any })
  const starting = engine.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(launches, 0)
  assert.equal(engine._runtimeDir, null)
  const error = Object.assign(new Error('unsafe_profile: permission step timed out'), { code: 'unsafe_profile' })
  refuse(error)
  await assert.rejects(starting, error)
  assert.equal(launches, 0)
  assert.equal(engine.alive, false)
})
