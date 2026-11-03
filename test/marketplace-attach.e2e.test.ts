import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, cpSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

import { ATTACH_SCOPE_EVENTS_FILE } from '../lib/attach-scope.mjs'
import { buildRunPlan, main } from '../bin/hoai-core.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0
const SLOW = { timeout: 120_000, skip: hasBun ? false : 'needs bun' }

interface Rig {
  home: string
  folder: string
  stateDir: string
  pluginRoot: string
}

function rig(): Rig {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-scope-e2e-')))
  const folder = join(home, 'agent')
  const stateDir = join(home, '.bgos-plugin-state')
  for (const dir of [folder, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(home, '.bgos-agent', 'credentials-42.json'),
    JSON.stringify({ backendUrl: 'http://127.0.0.1:9/api/v1', pairingToken: 'TESTTOKEN', pairingId: 420, userId: 'u1', assistantId: 42, homeDir: folder, homeSource: 'pairing' }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), '42\n')
  const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai', '9.9.9')
  mkdirSync(pluginRoot, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json']) {
    cpSync(join(repoRoot, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(pluginRoot, 'node_modules'), 'junction')
  const other = join(home, 'other-agent')
  mkdirSync(other)
  writeFileSync(join(other, '.bgos-agent-id'), '41\n')
  writeFileSync(join(home, '.bgos-agent', 'credentials-41.json'), JSON.stringify({
    backendUrl: 'http://127.0.0.1:9/api/v1', pairingToken: 'TESTTOKEN41', pairingId: 410,
    userId: 'u1', assistantId: 41, homeDir: other, homeSource: 'pairing',
  }))
  return { home, folder, stateDir, pluginRoot }
}

interface Answer {
  tools: Array<{ name: string; description?: string }>
  names: string[]
  stderr: string
  capabilities: Record<string, unknown>
  exitCode: number | null
}

/**
 * Boot the daemon with `extraEnv`, speak MCP, list its tools, then stop it (a
 * PID this test started). Driven by the answers, not by timers: initialize is
 * written at once (the pipe holds it until the server reads), tools/list once
 * initialize is answered, and stdin closes once tools/list is answered. A hard
 * deadline only bounds a daemon that never answers.
 */
function boot(r: Rig, extraEnv: Record<string, string> = {}, cwd = r.folder): Promise<Answer> {
  return new Promise((resolve) => {
    const child = spawn('bun', [join(r.pluginRoot, 'server.ts')], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: r.home,
        CLAUDE_CONFIG_DIR: join(r.home, '.claude'),
        BGOS_LAUNCH_CWD: cwd,
        BGOS_PLUGIN_STATE_DIR: r.stateDir,
        HOAI_BROWSER_HOST: 'off',
        ...extraEnv,
      },
    })
    let out = ''
    let err = ''
    let tools: Answer['tools'] = []
    let capabilities: Record<string, unknown> = {}
    let initialized = false
    let done = false
    const send = (m: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(m)}\n`)
      } catch {}
    }
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(deadline)
      resolve({ tools, names: tools.map((t) => t.name), stderr: err, capabilities, exitCode: child.exitCode })
    }
    const stop = () => {
      try {
        child.stdin.end()
      } catch {}
      // A full daemon does not end with stdin at once: stop it (our own PID).
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
        }, 1500).unref()
      }, 500).unref()
    }
    child.stdout.on('data', (d) => {
      out += d
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        let msg: { id?: number; result?: { tools?: Answer['tools']; capabilities?: Record<string, unknown> } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1 && !initialized) {
          capabilities = msg.result?.capabilities ?? {}
          initialized = true
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        } else if (msg.id === 2) {
          tools = msg.result?.tools ?? []
          stop()
        }
      }
    })
    child.on('error', () => finish())
    child.stderr.on('data', (d) => (err += d))
    child.on('exit', finish)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } })
    const deadline = setTimeout(() => {
      stop()
      finish()
    }, 45_000)
  })
}

function events(r: Rig): Array<Record<string, unknown>> {
  const path = join(r.stateDir, ATTACH_SCOPE_EVENTS_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function applyManifestEnv(env: Record<string, string>, userConfig: Record<string, string> = {}): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'))
  return { ...env, ...Object.fromEntries(Object.entries(manifest.mcpServers.bgos.env).map(([key, value]) => [
    key, String(value).replace(/\$\{user_config\.([^}]+)\}/g, (_match, name) => userConfig[name] ?? ''),
  ])) }
}

async function launch(r: Rig, env: Record<string, string>): Promise<Record<string, string>> {
  let daemonEnv: Record<string, string> | undefined
  // Replace only the external Claude CLI. The launcher and daemon are real;
  // the manifest environment is applied between them, just as Claude does.
  const exitCode = await main([], {
    platform: 'linux', env, home: r.home, cwd: r.folder, scriptDir: join(r.pluginRoot, 'bin'),
    listProcesses: () => [], print: () => {}, hasExpect: true,
    spawnImpl: (_file: string, _args: string[], opts: { env: Record<string, string> }) => {
      daemonEnv = { ...opts.env }
      const child = new EventEmitter() as EventEmitter & { kill: () => void }
      child.kill = () => child.emit('exit', null, 'SIGTERM')
      setImmediate(() => child.emit('exit', 0, null))
      return child
    },
  } as never)
  assert.equal(exitCode, 0)
  assert.ok(daemonEnv, 'hoai launched the CLI with the daemon environment')
  return daemonEnv
}


function assertDormant(a: Answer, r: Rig) {
  assert.deepEqual(a.names, [], a.stderr)
  assert.deepEqual(a.capabilities, { tools: {} })
  assert.equal(a.exitCode, 0, a.stderr)
  assert.match(a.stderr, /marketplace dormant/)
  assert.equal(a.stderr.trim().split('\n').length, 1, a.stderr)
  for (const id of ['41', '42']) assert.equal(existsSync(join(r.home, '.bgos-agent', `credentials-${id}.json.lock`)), false)
  const event = events(r).at(-1)!
  assert.ok(event, 'every dormant boot records its scope decision')
  assert.equal(event.verdict, 'refuse')
  assert.equal(event.mode, 'home')
}

test('marketplace real boot: a non agent folder stays dormant with no tools, channel or lock', SLOW, async () => {
  const r = rig()
  try {
    const cwd = join(r.home, 'work')
    mkdirSync(cwd)
    assertDormant(await boot(r, {}, cwd), r)
    assertDormant(await boot(r, { BGOS_ASSISTANT_ID: '42' }, cwd), r)
    assert.equal(events(r).length, 2)
    assert.deepEqual(readdirSync(r.stateDir), [ATTACH_SCOPE_EVENTS_FILE], 'dormant boot writes only telemetry')
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})

test('marketplace real boot: both agents attach in their own home and never as the other agent', SLOW, async () => {
  const r = rig()
  try {
    for (const [id, cwd] of [['42', r.folder], ['41', join(r.home, 'other-agent')]]) {
      const own = await boot(r, {}, cwd)
      assert.ok(own.names.includes('reply'), own.stderr)
      assert.equal(events(r).at(-1)!.assistantId, id)
      assert.equal(events(r).at(-1)!.outcome, 'match')
      const wrong = id === '42' ? '41' : '42'
      assertDormant(await boot(r, { BGOS_ASSISTANT_ID: wrong }, cwd), r)
    }
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})

test('marketplace real boot: explicit scope opts in outside home, inherited scope does not', SLOW, async () => {
  const r = rig()
  try {
    const cwd = join(r.home, 'work')
    mkdirSync(cwd)
    const env = { BGOS_ASSISTANT_ID: '42', HOAI_ATTACH_SCOPE: '42', HOAI_ATTACH_SCOPE_DIR: cwd }
    const opted = await boot(r, env, cwd)
    assert.ok(opted.names.includes('reply'), opted.stderr)
    assert.equal(events(r).at(-1)!.outcome, 'match')
    assertDormant(await boot(r, { ...env, HOAI_ATTACH_SCOPE_DIR: r.folder }, cwd), r)
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})

test('marketplace real boot: unreadable scope fails open', SLOW, async () => {
  const r = rig()
  try {
    const a = await boot(r, { HOAI_ATTACH_SCOPE: 'broken' })
    assert.ok(a.names.includes('reply'), a.stderr)
    assert.equal(events(r).at(-1)!.outcome, 'unreadable')
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})

test('marketplace real boot: a sole agent in its recorded home needs no folder pin', SLOW, async () => {
  const r = rig()
  try {
    rmSync(join(r.home, '.bgos-agent', 'credentials-41.json'))
    rmSync(join(r.folder, '.bgos-agent-id'))
    const a = await boot(r)
    assert.ok(a.names.includes('reply'), a.stderr)
    assert.equal(events(r).at(-1)!.outcome, 'match')
    assert.equal(events(r).at(-1)!.assistantId, '42')
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})

test('marketplace real boot: two unpinned recorded homes select only their own agent', SLOW, async () => {
  const r = rig()
  try {
    for (const folder of [r.folder, join(r.home, 'other-agent')]) rmSync(join(folder, '.bgos-agent-id'))
    for (const [id, folder] of [['42', r.folder], ['41', join(r.home, 'other-agent')]]) {
      const a = await boot(r, {}, folder)
      assert.ok(a.names.includes('reply'), a.stderr)
      assert.equal(events(r).at(-1)!.assistantId, id)
      assert.equal(events(r).at(-1)!.route, 'recorded-home', 'local telemetry records the new home evidence')
    }
    const cwd = join(r.home, 'work')
    mkdirSync(cwd)
    assertDormant(await boot(r, {}, cwd), r)
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})

test('marketplace real boot: unsubstituted manifest identity stays dormant', SLOW, async () => {
  const r = rig()
  try {
    const cwd = join(r.home, 'work')
    mkdirSync(cwd)
    const env = { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' }
    assertDormant(await boot(r, env, cwd), r)
    for (const id of ['41', '42']) rmSync(join(r.home, '.bgos-agent', `credentials-${id}.json`))
    assertDormant(await boot(r, env, cwd), r)
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})

for (const layout of ['legacy plus numbered', 'explicit path plus numbered', 'legacy without home', 'explicit legacy without home'] as const) {
  test(`market2 launcher: ${layout} launches the effective agent 42`, SLOW, async () => {
    const r = rig()
    try {
      const numbered = join(r.home, '.bgos-agent', 'credentials-42.json')
      const credentials = JSON.parse(readFileSync(numbered, 'utf8'))
      const env: Record<string, string> = { CLAUDE_CONFIG_DIR: join(r.home, '.claude') }
      const target = layout === 'explicit path plus numbered'
        ? join(r.home, 'explicit-42.json') : join(r.home, '.bgos-agent', 'credentials.json')
      if (layout.endsWith('without home')) {
        delete credentials.homeDir
        delete credentials.homeSource
        rmSync(join(r.home, '.bgos-agent', 'credentials-41.json'))
      }
      writeFileSync(target, JSON.stringify(credentials))
      rmSync(numbered)
      rmSync(join(r.folder, '.bgos-agent-id'))
      if (layout.startsWith('explicit')) env.BGOS_CREDENTIALS_PATH = target
      if (layout.endsWith('without home')) assertDormant(await boot(r), r)

      const plan = buildRunPlan({ cwd: r.folder, env, home: r.home, scriptDir: join(r.pluginRoot, 'bin') })
      assert.equal(plan.ok, true)
      if (!plan.ok) return
      assert.equal(plan.attachScope, '', 'the daemon resolves identity after applying the manifest environment')
      const launched = await boot(r, applyManifestEnv(await launch(r, env)))
      assert.ok(launched.names.includes('reply'), launched.stderr)
      const event = events(r).at(-1)!
      assert.equal(event.assistantId, '42')
      assert.equal(event.scope, '')
      assert.equal(event.verdict, 'attach')
      assert.equal(event.route, layout.startsWith('explicit') ? 'env-path' : 'legacy')
    } finally { rmSync(r.home, { recursive: true, force: true }) }
  })
}

test('market3 launcher: manifest agent 42 overrides legacy 41 without losing reply', SLOW, async () => {
  const r = rig()
  try {
    const legacy = join(r.home, '.bgos-agent', 'credentials-41.json')
    writeFileSync(join(r.home, '.bgos-agent', 'credentials.json'), readFileSync(legacy, 'utf8'))
    rmSync(legacy)
    rmSync(join(r.folder, '.bgos-agent-id'))
    const env = await launch(r, { CLAUDE_CONFIG_DIR: join(r.home, '.claude') })
    const daemonEnv = applyManifestEnv(env, { assistant_id: '42' })
    const launched = await boot(r, daemonEnv)
    assert.ok(launched.names.includes('reply'), launched.stderr)
    const event = events(r).at(-1)!
    assert.equal(event.assistantId, '42')
    assert.equal(event.verdict, 'attach')
    assert.equal(event.route, 'env-assistant')
    assert.equal(event.launcher, 'hoai')
    // A genuinely conflicting numeric scope is still refused in its own home.
    assertDormant(await boot(r, { ...daemonEnv, HOAI_ATTACH_SCOPE: '41' }), r)
    assert.equal(events(r).at(-1)!.outcome, 'wrong-agent')
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})

test('market2 diagnostics: installed marketplace CLI reports effective home and the legacy setting', SLOW, () => {
  const r = rig()
  try {
    const script = join(r.pluginRoot, 'bin', 'hoai-attach-scope.mjs')
    const env = { PATH: process.env.PATH, HOME: r.home, CLAUDE_CONFIG_DIR: join(r.home, '.claude') }
    const json = spawnSync(process.execPath, [script, '--json'], { env, encoding: 'utf8' })
    assert.equal(json.status, 0, json.stderr)
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.mode.mode, 'home', 'the installed marketplace enforces home by default')
    assert.equal(parsed.setting.mode, 'off', 'the legacy setting remains independently visible')
    assert.equal(parsed.installMethod, 'marketplace')
    const plain = spawnSync(process.execPath, [script], { env, encoding: 'utf8' })
    assert.equal(plain.status, 0, plain.stderr)
    assert.match(plain.stdout, /mode home \(default\)/)
    assert.match(plain.stdout, /setting off \(default\)/)
    assert.doesNotMatch(plain.stdout, /[\u2013\u2014]/)
  } finally { rmSync(r.home, { recursive: true, force: true }) }
})
