/**
 * The REAL server.ts, booted as the marketplace plugin's copy under a stand-in
 * `claude`, answers a duplicate with a notice and nothing else (kc-server,
 * 2026-10-13).
 *
 * What is real: `bun server.ts` from a copy of this checkout placed where
 * Claude Code puts a marketplace plugin (<config>/plugins/cache/hoai/hoai/9.9.9),
 * the pairing credentials file, the folder pin and the folder's .mcp.json, the
 * `ps` walk up to a process whose command line is `claude ... --dangerously-load-
 * development-channels <spec>`, and the MCP stdio protocol. What is stood in: the
 * `claude` itself (a node process started with argv0 "claude", so `ps` shows the
 * command line a session shows), and the backend (nothing listens on port 9).
 *
 * Three runs of the same copy:
 *   - the session loads server:bgos and the folder registers a checkout: the
 *     copy serves ONE notice tool, declares no claude/channel capability, takes
 *     no pairing lock and writes no plugin state. The checkout stays the only
 *     channel the session can push into.
 *   - the session names THIS copy (plugin:hoai@hoai): the full daemon, a
 *     channel, a lock.
 *   - the folder registers no checkout: the full daemon, whatever the flags.
 *
 * Skipped where it cannot run: Windows (the probe reads `ps`) and a host
 * without bun.
 *
 * Run: npx tsx --test test/duplicate-copy.e2e.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0
const SKIP = process.platform === 'win32' ? 'the probe reads ps' : hasBun ? false : 'needs bun'
const SLOW = { timeout: 120_000, skip: SKIP }

const CLAUDE_STUB = `
import { spawn } from 'node:child_process'
const root = process.argv[2]
const child = spawn('bun', [root + '/server.ts'], { stdio: 'inherit', cwd: process.cwd(), env: process.env })
child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGTERM', () => child.kill('SIGTERM'))
`

interface Rig {
  home: string
  folder: string
  pluginRoot: string
}

/** A machine: the plugin copy in Claude Code's cache, one paired agent, its folder. */
function rig({ checkout }: { checkout: boolean }): Rig {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-dup-e2e-')))
  const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai', '9.9.9')
  const folder = join(home, 'agent')
  const checkoutDir = join(home, 'checkout')
  for (const dir of [pluginRoot, folder, checkoutDir, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json']) {
    cpSync(join(repoRoot, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(pluginRoot, 'node_modules'))
  writeFileSync(join(pluginRoot, 'package.json'), readPackageAs(join(repoRoot, 'package.json'), '9.9.9'))
  writeFileSync(join(checkoutDir, 'server.ts'), '// the checkout copy\n')
  writeFileSync(
    join(home, '.bgos-agent', 'credentials-42.json'),
    JSON.stringify({ backendUrl: 'http://127.0.0.1:9/api/v1', pairingToken: 'TESTTOKEN', pairingId: 420, userId: 'u1', assistantId: 42, homeDir: folder, homeSource: 'pairing' }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), '42\n')
  if (checkout) {
    writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(checkoutDir, 'server.ts')] } } }))
  }
  writeFileSync(join(home, 'claude-stub.mjs'), CLAUDE_STUB)
  return { home, folder, pluginRoot }
}

function readPackageAs(path: string, version: string): string {
  const pkg = JSON.parse(readFileSyncUtf8(path)) as Record<string, unknown>
  return JSON.stringify({ ...pkg, version })
}
function readFileSyncUtf8(path: string): string {
  return spawnSync('cat', [path], { encoding: 'utf8' }).stdout
}

interface Answer {
  initialize: { capabilities: Record<string, unknown>; instructions?: string } | null
  tools: string[]
  exitCode: number | null
  stderr: string
}

/** Boot the copy under a stand-in claude naming `spec`, speak MCP, then close its stdin. */
function boot(r: Rig, spec: string): Promise<Answer> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(r.home, 'claude-stub.mjs'), r.pluginRoot, '--dangerously-load-development-channels', spec], {
      argv0: 'claude',
      cwd: r.folder,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: r.home, CLAUDE_CONFIG_DIR: join(r.home, '.claude'), BGOS_LAUNCH_CWD: r.folder, HOAI_BROWSER_HOST: 'off' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`)
    const finish = (code: number | null) => {
      const lines = out.split('\n').filter(Boolean).map((l) => {
        try {
          return JSON.parse(l) as { id?: number; result?: Record<string, unknown> }
        } catch {
          return {}
        }
      })
      const init = lines.find((l) => l.id === 1)?.result as Answer['initialize']
      const listed = lines.find((l) => l.id === 2)?.result as { tools?: Array<{ name: string }> } | undefined
      resolve({ initialize: init ?? null, tools: (listed?.tools ?? []).map((t) => t.name), exitCode: code, stderr: err })
    }
    let done = false
    child.on('exit', (code) => {
      if (done) return
      done = true
      finish(code)
    })
    setTimeout(() => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }), 3500)
    setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 4000)
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), 4500)
    setTimeout(() => child.stdin.end(), 6500)
    // A full daemon does not end with stdin at once: stop it so the test can read what it did.
    setTimeout(() => {
      if (!done) {
        done = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 1500)
        finish(null)
      }
    }, 9000)
  })
}

const lockFiles = (r: Rig) => readdirSync(join(r.home, '.bgos-agent')).filter((f) => f.endsWith('.lock'))

test('the plugin copy of a session that loads server:bgos serves ONE notice tool, declares no channel and takes no lock', SLOW, async () => {
  const r = rig({ checkout: true })
  try {
    const a = await boot(r, 'server:bgos')
    assert.ok(a.initialize, a.stderr)
    assert.equal(a.initialize.capabilities.experimental, undefined, 'a second channel must not be declared')
    assert.equal(a.initialize.instructions, undefined)
    assert.deepEqual(a.tools, ['hoai_duplicate_copy'])
    assert.equal(a.exitCode, 0, 'it ends with its host, as a served notice does')
    assert.match(a.stderr, /duplicate plugin copy, standing aside: the session loads server:bgos from .*checkout/)
    assert.deepEqual(lockFiles(r), [], 'no pairing lock: the checkout copy keeps the only one')
    assert.equal(existsSync(join(r.home, '.bgos-plugin-state')), false, 'no plugin state written')
  } finally {
    rmSync(r.home, { recursive: true, force: true })
  }
})

test('control: a session that names THIS copy as its channel gets the full daemon, a channel capability and the lock', SLOW, async () => {
  const r = rig({ checkout: true })
  try {
    const a = await boot(r, 'plugin:hoai@hoai')
    assert.ok(a.initialize, a.stderr)
    assert.ok(a.initialize.capabilities.experimental, 'this copy IS the channel here')
    assert.ok(a.tools.length > 1 && !a.tools.includes('hoai_duplicate_copy'))
    assert.doesNotMatch(a.stderr, /duplicate plugin copy/)
    // The lock is released when the daemon ends, so it is read off the boot line, not the disk.
    assert.match(a.stderr, /pairing lock acquired \(unlocked\).*this daemon owns the channel/)
  } finally {
    rmSync(r.home, { recursive: true, force: true })
  }
})

test('control: with no checkout registered in the folder the copy keeps running whatever the session loads', SLOW, async () => {
  const r = rig({ checkout: false })
  try {
    const a = await boot(r, 'server:bgos')
    assert.ok(a.initialize, a.stderr)
    assert.ok(a.tools.length > 1 && !a.tools.includes('hoai_duplicate_copy'))
    assert.doesNotMatch(a.stderr, /duplicate plugin copy/)
  } finally {
    rmSync(r.home, { recursive: true, force: true })
  }
})
