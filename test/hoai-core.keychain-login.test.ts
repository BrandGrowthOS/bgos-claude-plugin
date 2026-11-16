import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../bin/hoai-core.mjs'

const recovery = core as unknown as {
  probeClaudeSignedIn: (input: Record<string, unknown>) => boolean
  createClaudeSignInCheck: (input: Record<string, unknown>) => (since: number) => boolean
}
const START = Date.parse('2026-11-01T12:00:00Z')
const INTERVAL = 180_000
const CONFIG = '/fixture/claude-store'
const VERSION = { status: 0, stdout: '2.1.317 (Claude Code)\n' }
const SIGNED_IN = { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }

test('macOS recovery probes a renewed login without a credential file or an agent answer', () => {
  let at = START
  let signedIn = false
  let calls = 0
  const check = recovery.createClaudeSignInCheck({
    platform: 'darwin', configDir: CONFIG, now: () => at,
    mtimeMs: () => { throw new Error('macOS must not stat a credential file') },
    probe: () => { calls++; return signedIn },
  })
  assert.equal(check(START - 1000), false)
  signedIn = true
  assert.equal(check(START - 1000), false, 'a repeated check is rate limited')
  assert.equal(calls, 1)
  at += INTERVAL
  assert.equal(check(START - 1000), true, 'a login clears the hold without model activity')
  assert.equal(calls, 2)
  assert.equal(check(at + 1), false, 'a probe cannot prove a future failure recovered')
  at += INTERVAL
  signedIn = false
  assert.equal(check(at - 1), false, 'success is never reused for a newer failure')
})

test('macOS recovery treats a throwing or inconclusive probe as still held and rate limits retries', () => {
  for (const answer of [null, undefined, 'true', { loggedIn: true }, false, new Error('fixture failure')]) {
    let calls = 0
    const check = recovery.createClaudeSignInCheck({
      platform: 'darwin', configDir: CONFIG, now: () => START,
      probe: () => { calls++; if (answer instanceof Error) throw answer; return answer },
    })
    assert.equal(check(START - 1000), false)
    assert.equal(check(START - 1000), false)
    assert.equal(calls, 1)
  }
})

test('Linux and Windows retain the file timestamp proof and never run the macOS probe', () => {
  for (const platform of ['linux', 'win32']) {
    const paths: string[] = []
    const check = recovery.createClaudeSignInCheck({
      platform, configDir: CONFIG,
      mtimeMs: (path: string) => { paths.push(path); return START },
      probe: () => { throw new Error('not a macOS check') },
    })
    assert.equal(check(START - 1), true)
    assert.equal(check(START), false)
    assert.deepEqual(paths, [`${CONFIG}/.credentials.json`, `${CONFIG}/.credentials.json`])
  }
})

test('the status command is bounded, non interactive, scoped to this store and returns only a boolean', () => {
  const calls: unknown[][] = []
  const run = (...args: unknown[]) => {
    calls.push(args)
    return (args[1] as string[])[0] === '--version' ? VERSION
      : { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'sample@example.invalid' }) }
  }
  assert.equal(recovery.probeClaudeSignedIn({ env: { PATH: '/fixture/bin', CLAUDE_CONFIG_DIR: CONFIG }, run }), true)
  const options = {
    env: { PATH: '/fixture/bin', CLAUDE_CONFIG_DIR: CONFIG },
    encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true,
  }
  assert.deepEqual(calls, [
    ['claude', ['--version'], options],
    ['claude', ['auth', 'status', '--json'], options],
  ])
})

test('a default macOS login keeps CLAUDE_CONFIG_DIR unset, exactly as in the running launcher', () => {
  const env = { PATH: '/fixture/bin' }
  assert.equal(recovery.probeClaudeSignedIn({ env, run: (_file: string, args: string[], options: { env: unknown }) => {
    assert.deepEqual(options.env, env)
    return args[0] === '--version' ? VERSION : SIGNED_IN
  } }), true)
  assert.deepEqual(env, { PATH: '/fixture/bin' }, 'the launcher environment is not mutated')
})

test('the status probe fails closed for logged out, API key, malformed, failed, timed out and missing CLI results', () => {
  for (const result of [
    { status: 0, stdout: '{"loggedIn":false,"authMethod":"none"}' },
    { status: 0, stdout: '{"loggedIn":true,"authMethod":"api_key"}' },
    { status: 0, stdout: '{"loggedIn":"true","authMethod":"claude.ai"}' },
    { status: 0, stdout: '{"loggedIn":true}' },
    { status: 0, stdout: 'not JSON' },
    { status: 1, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' },
    { status: null, error: new Error('ETIMEDOUT'), stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' },
    { status: 0, error: new Error('ENOENT'), stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' },
    null,
  ]) {
    assert.equal(recovery.probeClaudeSignedIn({ env: {}, run: (_file: string, args: string[]) => args[0] === '--version' ? VERSION : result }), false)
  }
  assert.equal(recovery.probeClaudeSignedIn({ env: {}, run: () => { throw new Error('fixture') } }), false)
})

test('affected older and unknown CLI versions never receive automatic auth status, even if it would report a login', () => {
  for (const version of [
    '2.1.277 (Claude Code)', '2.1.301 (Claude Code)', '2.1.316 (Claude Code)',
    '2.0.999 (Claude Code)', '1.9.999 (Claude Code)', '', 'unknown',
    '2.1.317-rc.1 (Claude Code)', '2.1.999-beta (Claude Code)',
    'wrapper 2.1.317', '2.1.317 (Claude Code)\nunexpected output',
  ]) {
    const commands: string[][] = []
    const notices: unknown[][] = []
    assert.equal(recovery.probeClaudeSignedIn({
      env: {},
      run: (_file: string, args: string[]) => {
        commands.push(args)
        return args[0] === '--version' ? { status: 0, stdout: version } : SIGNED_IN
      },
      onUnsupportedVersion: (...args: unknown[]) => notices.push(args),
    }), false, version)
    assert.deepEqual(commands, [['--version']], version)
    assert.deepEqual(notices, [[]], 'no raw CLI output escapes the version gate')
  }
})

test('failed, timed out, missing and throwing version checks never reach auth status', () => {
  for (const result of [
    { ...VERSION, status: 1 }, { ...VERSION, status: null },
    { ...VERSION, error: new Error('ETIMEDOUT') }, null, new Error('ENOENT'),
  ]) {
    const commands: string[][] = []
    assert.equal(recovery.probeClaudeSignedIn({ env: {}, run: (_file: string, args: string[]) => {
      commands.push(args)
      if (result instanceof Error) throw result
      return result
    } }), false)
    assert.deepEqual(commands, [['--version']])
  }
})

test('the fixed release and newer stable versions probe status only after a successful numeric version check', () => {
  for (const version of ['2.1.317 (Claude Code)', '2.1.318', '2.1.1000', '2.2.0 (Claude Code)', '3.0.0 (Claude Code)']) {
    const commands: string[][] = []
    assert.equal(recovery.probeClaudeSignedIn({ env: {}, run: (_file: string, args: string[]) => {
      commands.push(args)
      return args[0] === '--version' ? { status: 0, stdout: version } : SIGNED_IN
    } }), true, version)
    assert.deepEqual(commands, [['--version'], ['auth', 'status', '--json']])
  }
})

test('recovery retries the version gate after an update and does not reuse success after a downgrade', () => {
  let at = START
  let version = '2.1.277 (Claude Code)'
  const commands: string[][] = []
  let notices = 0
  const check = recovery.createClaudeSignInCheck({
    platform: 'darwin', configDir: CONFIG, env: {}, now: () => at,
    run: (_file: string, args: string[]) => {
      commands.push(args)
      return args[0] === '--version' ? { status: 0, stdout: version } : SIGNED_IN
    },
    onUnsupportedVersion: () => { notices++ },
  })
  assert.equal(check(START - 1), false)
  assert.equal(check(START - 1), false)
  assert.deepEqual(commands, [['--version']], 'version checks share the recovery throttle')
  at += INTERVAL
  assert.equal(check(START - 1), false)
  assert.equal(notices, 1, 'update guidance is printed once per checker')
  version = '2.1.317 (Claude Code)'
  at += INTERVAL
  assert.equal(check(START - 1), true, 'an in-place update enables recovery')
  version = '2.1.277 (Claude Code)'
  at += INTERVAL
  assert.equal(check(at - 1), false, 'a later failure cannot reuse the safe version')
  assert.equal(commands.filter((args) => args[0] === 'auth').length, 1)
})

class FakeClaude extends EventEmitter {
  pid = 45000
  exitCode: number | null = null
  signalCode: string | null = null
  kill() {
    setImmediate(() => { this.exitCode = 1; this.emit('exit', 1, null) })
    return true
  }
}

for (const mode of ['injected', 'fixed', 'old', 'unknown']) {
  test(`the macOS supervisor recovers safely with the ${mode} CLI probe`, async (t) => {
    const store = mkdtempSync(join(tmpdir(), 'hoai-keychain-login-'))
    t.after(() => rmSync(store, { recursive: true, force: true }))
    const files = new Map<string, string>()
    const children: FakeClaude[] = []
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean; fired: boolean }> = []
    const prints: string[] = []
    const stop = new AbortController()
    let at = START
    let signedIn = false
    let probes = 0
    const commands: string[][] = []
    const blocked = mode === 'old' || mode === 'unknown'
    const done = core.superviseClaude(['--dangerously-load-development-channels', 'plugin:hoai@hoai'], {
      platform: 'darwin', home: '/fixture/home', cwd: '/fixture/agent',
      scriptDir: '/fixture/.claude/plugins/cache/hoai/hoai/0.0.0/bin',
      env: { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '123', CLAUDE_CONFIG_DIR: store },
      readFile: (path: string) => files.get(path) ?? null,
      listDir: (path: string) => { try { return path.startsWith(store) ? readdirSync(path) : [] } catch { return [] } },
      exists: (path: string) => files.has(path),
      writeFile: (path: string, body: string) => { files.set(path, body); return true },
      removeFile: (path: string) => files.delete(path),
      spawnImpl: (() => { const child = new FakeClaude(); children.push(child); return child }) as never,
      hasExpect: true, listProcesses: () => [], pidAlive: () => false, pidProcess: () => null,
      probeIdentityFlag: () => null, generateId: () => '12345678-1234-4234-8234-123456789abc',
      now: () => at, writeErr: () => {}, print: (line: string) => prints.push(line),
      setTimer: (fn: () => void, ms: number) => { const timer = { fn, ms, cleared: false, fired: false }; timers.push(timer); return timer },
      clearTimer: (timer: { cleared: boolean }) => { timer.cleared = true },
      claudeLoginFailure: () => ({ at: START - 1000, text: 'Login expired' }),
      ...(mode === 'injected' ? { probeClaudeSignedIn: () => { probes++; return signedIn } } : {}),
      spawnSyncImpl: (_file: string, args: string[]) => {
        commands.push(args)
        if (args[0] === '--version') return { status: 0, stdout: mode === 'old' ? '2.1.277 (Claude Code)' : mode === 'unknown' ? 'unknown' : VERSION.stdout }
        probes++
        return blocked || signedIn ? SIGNED_IN : { status: 0, stdout: '{"loggedIn":false}' }
      },
      pollMs: 5, signal: stop.signal,
    } as never)
    t.after(async () => { stop.abort(); await done })
    const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)) }
    const fire = async () => {
      const timer = timers.find((timer) => timer.ms === INTERVAL && !timer.cleared && !timer.fired)
      assert.ok(timer, 'heartbeat check armed')
      timer.fired = true
      at += INTERVAL
      timer.fn()
      await settle()
    }
    await settle()
    assert.equal(children.length, 1)
    await fire()
    assert.equal(children.length, 1)
    assert.equal(probes, 0, 'only a held failure needs a recovery probe')
    await fire()
    assert.equal(children.length, 1)
    assert.equal(probes, blocked ? 0 : 1)
    assert.match(prints.join('\n'), /ALERT \(claude-login-expired\)/)
    if (blocked) {
      assert.deepEqual(commands, [['--version']])
      assert.match(prints.join('\n'), /[Uu]pdate Claude Code to 2\.1\.317 or newer/)
      assert.match(prints.join('\n'), /agent.*answer/)
      await fire()
      assert.equal(children.length, 1, 'unsafe status cannot lift the login hold')
      assert.equal(probes, 0)
      assert.equal(prints.filter((line) => /[Uu]pdate Claude Code to/.test(line)).length, 1)
      const project = join(store, 'projects', 'fixture-agent')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'answer.jsonl'), JSON.stringify({
        type: 'assistant', timestamp: new Date(at).toISOString(),
        message: { role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'fixture answer' }] },
      }) + '\n')
    }
    signedIn = true
    await fire()
    assert.equal(probes, blocked ? 0 : 2)
    for (let i = 0; i < 200 && children.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(children.length, 2, `recovery releases the hold and permits the one heartbeat relaunch: ${prints.join('\n')}`)
    assert.match(prints.join('\n'), /Relaunching claude/)
  })
}
