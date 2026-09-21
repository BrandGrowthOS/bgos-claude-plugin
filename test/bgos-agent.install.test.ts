/**
 * `hoai-agent install --always-on`, the REAL bin/bgos-agent, run end to end.
 *
 * Desktop one-click's launch step is exactly this command with no --key and no
 * --user, on a workspace that pairing has pinned and that has NO .mcp.json. It
 * used to die there ("no .mcp.json ... and no creds given", measured
 * 2026-09-21), so a first-time owner could never get a background agent. That
 * gate was not removed. It exists because an agent once came back DEAF on the
 * wrong channel spec (2026-08-21), so the install now goes ahead only when the
 * paired topology is PROVEN, and refuses BY NAME otherwise.
 *
 * What these tests pin, by running the script and reading what it left on disk:
 *   1. a proven paired folder gets a supervisor on the channel the shared
 *      resolver proved, and no .mcp.json is invented for it;
 *   2. a clone-style folder that DOES carry a .mcp.json behaves exactly as it
 *      always did: `server:bgos`, the file untouched, and the prover is never
 *      even started;
 *   3. every refusal is named, exits nonzero, and leaves NOTHING behind: no
 *      run.expect, no service file, no launchctl or systemctl call. A refused
 *      install must not be a half install.
 *
 * The machine is stood in for, never the script: HOME is a temp dir, and PATH
 * leads with stand-ins for claude, launchctl, systemctl and loginctl, plus a
 * `bun` that skips `bun install` (no network in a test) and otherwise hands
 * over to the real runtime running this test. The script is run from an
 * npx-shaped copy (.../_npx/<hash>/node_modules/<pkg>/bin), because that is
 * where the desktop's launch line really runs it from, and because the shared
 * resolver treats a clone checkout as a clone (one of the refusals below).
 *
 * Run: npm test, or npx tsx --test test/bgos-agent.install.test.ts
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLONE_CHANNEL_SPEC, MARKETPLACE_CHANNEL_SPEC } from '../bin/bgos-install-method.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0
const hasExpect = spawnSync('bash', ['-c', 'command -v expect']).status === 0
const hasGit = spawnSync('bash', ['-c', 'command -v git']).status === 0
const SLOW = { timeout: 120_000 }

/** An early return reports PASS, so CI sets HOAI_REQUIRE_EXPECT=1 and a missing tool becomes a failure. */
function requireTools(): void {
  assert.notEqual(process.env.HOAI_REQUIRE_EXPECT, '1', 'HOAI_REQUIRE_EXPECT=1 but bash, git or expect is missing')
}
const ready = hasBash && hasExpect && hasGit

interface Machine {
  home: string
  agentBin: string
  pluginRoot: string
  calls: string
  run: (args: string[], extraEnv?: Record<string, string>) => { status: number | null; out: string }
  serviceFiles: () => string[]
}

function machine({ fromClone = false, pluginInstalled = true }: { fromClone?: boolean; pluginInstalled?: boolean } = {}): Machine {
  const home = mkdtempSync(join(tmpdir(), 'hoai-install-'))
  // Where the code runs from. npx-shaped by default; a plain checkout-shaped dir for the clone case.
  const pluginRoot = fromClone
    ? join(home, 'bgos-claude-plugin')
    : join(home, '.npm', '_npx', 'abc123', 'node_modules', 'claude-channel-bgos')
  mkdirSync(pluginRoot, { recursive: true })
  cpSync(join(repoRoot, 'bin'), join(pluginRoot, 'bin'), { recursive: true })
  cpSync(join(repoRoot, 'lib'), join(pluginRoot, 'lib'), { recursive: true })
  cpSync(join(repoRoot, 'package.json'), join(pluginRoot, 'package.json'))
  // cmd_install clones the plugin when server.ts is missing beside it. It is only checked for existence.
  writeFileSync(join(pluginRoot, 'server.ts'), '// stand-in: the installer only checks that this file exists\n')

  if (pluginInstalled) {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath: join(home, '.claude/plugins/cache/hoai/hoai/0.42.3'), version: '0.42.3' }] } }),
    )
  }

  const shims = join(home, 'shims')
  const calls = join(home, 'calls.log')
  mkdirSync(shims)
  const shim = (name: string, body: string) => {
    writeFileSync(join(shims, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`)
    chmodSync(join(shims, name), 0o755)
  }
  shim('claude', 'exit 0')
  // "print" answers "not loaded", so the reload loop does not wait for a job that was never there
  shim('launchctl', '[ "$1" = "print" ] && exit 1\nexit 0')
  shim('systemctl', 'exit 0')
  shim('loginctl', 'exit 0')
  // no network in a test: skip `bun install`, and otherwise BE a JS runtime
  shim('bun', `[ "$1" = "install" ] && exit 0\nexec "${process.execPath}" "$@"`)

  const agentBin = join(pluginRoot, 'bin', 'bgos-agent')
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const result = spawnSync('bash', [agentBin, 'install', ...args], {
      cwd: home,
      encoding: 'utf8',
      timeout: 100_000,
      env: { HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`, ...extraEnv },
    })
    return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
  }
  const serviceFiles = () => {
    const found: string[] = []
    for (const dir of [join(home, 'Library', 'LaunchAgents'), join(home, '.config', 'systemd', 'user')]) {
      if (existsSync(dir)) found.push(...readdirSync(dir).map((f) => join(dir, f)))
    }
    return found
  }
  return { home, agentBin, pluginRoot, calls, run, serviceFiles }
}

/** What pairing leaves behind: a pinned workspace and that agent's credentials file. */
function pair(m: Machine, id: string, { pin = id, creds = true }: { pin?: string; creds?: boolean } = {}): string {
  const workspace = join(m.home, '.bgos-agent', `${id}-workspace`)
  mkdirSync(workspace, { recursive: true })
  if (pin) writeFileSync(join(workspace, '.bgos-agent-id'), `${pin}\n`)
  if (creds) writeFileSync(join(m.home, '.bgos-agent', `credentials-${id}.json`), JSON.stringify({ assistantId: Number(id) }))
  return workspace
}

const callsOf = (m: Machine) => (existsSync(m.calls) ? readFileSync(m.calls, 'utf8') : '')
const spawnLine = (m: Machine, id: string) =>
  readFileSync(join(m.home, '.bgos-agent', id, 'run.expect'), 'utf8').split('\n').find((l) => l.startsWith('spawn ')) ?? ''

test('a PROVEN paired folder with no .mcp.json gets its supervisor, on the channel the resolver proved, and no .mcp.json is invented', SLOW, () => {
  if (!ready) return requireTools()
  const m = machine()
  const workspace = pair(m, '936')
  const result = m.run(['--assistant', '936', '--dir', workspace, '--always-on'])
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /paired folder proven for agent 936 \(folder pin, agent credentials, plugin install record\)/)
  assert.ok(spawnLine(m, '936').endsWith(`--dangerously-load-development-channels "${MARKETPLACE_CHANNEL_SPEC}"`), spawnLine(m, '936'))
  assert.equal(existsSync(join(workspace, '.mcp.json')), false, 'a marketplace folder has no .mcp.json, and the installer must not fabricate one')
  assert.equal(m.serviceFiles().length, 1, 'exactly one service file')
  assert.match(callsOf(m), /--prove-paired-topology --workdir .*936-workspace --assistant-id 936/)
  // the spec never came from this script: bin/bgos-agent does not contain it outside comments
  const code = readFileSync(m.agentBin, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.equal(code.includes(MARKETPLACE_CHANNEL_SPEC), false)
})

test('a CLONE-STYLE folder that carries a .mcp.json behaves exactly as it always did, and the prover is never even started', SLOW, () => {
  if (!ready) return requireTools()
  // On the very machine where the paired topology WOULD be provable: pinned
  // folder, credentials, marketplace plugin installed. The .mcp.json still wins,
  // because that is what the folder publishes (2026-08-21: the other answer is
  // an agent that says Connected and hears nothing).
  const m = machine()
  const workspace = pair(m, '901')
  const mcp = JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['wrapper.mjs'], env: { BGOS_ASSISTANT_ID: '901' } } } }, null, 2)
  writeFileSync(join(workspace, '.mcp.json'), mcp)
  const result = m.run(['--assistant', '901', '--dir', workspace, '--always-on'])
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /using existing .*\.mcp\.json \(pass --key\/--user to regenerate\)/)
  assert.doesNotMatch(result.out, /paired folder proven|paired-topology/)
  assert.ok(spawnLine(m, '901').endsWith(`--dangerously-load-development-channels "${CLONE_CHANNEL_SPEC}"`), spawnLine(m, '901'))
  assert.equal(readFileSync(join(workspace, '.mcp.json'), 'utf8'), mcp, 'byte for byte')
  assert.doesNotMatch(callsOf(m), /prove-paired-topology/, 'the prover must not run at all for a folder that publishes its own server')
})

test('every refusal is NAMED, exits nonzero, and leaves nothing behind: no wrapper, no service file, no service call', SLOW, () => {
  if (!ready) return requireTools()
  const cases: Array<{ name: string; reason: RegExp; setup: () => { m: Machine; args: string[]; env?: Record<string, string> } }> = [
    {
      name: 'never paired',
      reason: /paired-topology:no-folder-pin/,
      setup: () => {
        const m = machine()
        const ws = pair(m, '10', { pin: '', creds: true })
        return { m, args: ['--assistant', '10', '--dir', ws, '--always-on'] }
      },
    },
    {
      name: 'pinned to another agent',
      reason: /paired-topology:pin-mismatch .*pinned to agent 77, not 11/,
      setup: () => {
        const m = machine()
        const ws = pair(m, '11', { pin: '77' })
        return { m, args: ['--assistant', '11', '--dir', ws, '--always-on'] }
      },
    },
    {
      name: 'no credentials for that agent',
      reason: /paired-topology:no-agent-credentials/,
      setup: () => {
        const m = machine()
        const ws = pair(m, '12', { creds: false })
        return { m, args: ['--assistant', '12', '--dir', ws, '--always-on'] }
      },
    },
    {
      name: 'marketplace plugin not installed',
      reason: /paired-topology:plugin-not-installed/,
      setup: () => {
        const m = machine({ pluginInstalled: false })
        const ws = pair(m, '13')
        return { m, args: ['--assistant', '13', '--dir', ws, '--always-on'] }
      },
    },
    {
      name: 'installed only under a CLAUDE_CONFIG_DIR the background service will not inherit',
      reason: /paired-topology:plugin-not-installed .*does not inherit/,
      setup: () => {
        const m = machine({ pluginInstalled: false })
        const ws = pair(m, '14')
        const custom = join(m.home, 'custom-claude')
        mkdirSync(join(custom, 'plugins'), { recursive: true })
        writeFileSync(join(custom, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath: '/x', version: '0.42.3' }] } }))
        return { m, args: ['--assistant', '14', '--dir', ws, '--always-on'], env: { CLAUDE_CONFIG_DIR: custom } }
      },
    },
    {
      name: 'the installer is a clone checkout',
      reason: /paired-topology:installer-is-a-clone/,
      setup: () => {
        const m = machine({ fromClone: true })
        const ws = pair(m, '15')
        return { m, args: ['--assistant', '15', '--dir', ws, '--always-on'] }
      },
    },
    {
      name: 'an explicit --channel that disagrees with the proof',
      reason: /paired-topology:channel-mismatch --channel server:bgos/,
      setup: () => {
        const m = machine()
        const ws = pair(m, '16')
        return { m, args: ['--assistant', '16', '--dir', ws, '--always-on', '--channel', 'server:bgos'] }
      },
    },
  ]
  for (const c of cases) {
    const { m, args, env } = c.setup()
    const id = args[1]!
    const result = m.run(args, env)
    assert.equal(result.status, 1, `${c.name}: ${result.out}`)
    assert.match(result.out, c.reason, c.name)
    assert.equal(existsSync(join(m.home, '.bgos-agent', id, 'run.expect')), false, `${c.name}: no wrapper may be written`)
    assert.deepEqual(m.serviceFiles(), [], `${c.name}: no service file may be written`)
    assert.doesNotMatch(callsOf(m), /^(launchctl|systemctl) /m, `${c.name}: the service manager must never be called`)
  }
})
