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
const realBun = spawnSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim()

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

function machine({ fromClone = false, pluginInstalled = true, pluginEnabled = true, withNode = true }: { fromClone?: boolean; pluginInstalled?: boolean; pluginEnabled?: boolean; withNode?: boolean } = {}): Machine {
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
    // what a real `claude plugin install hoai@hoai` leaves: the record, the files, and the plugin ENABLED
    mkdirSync(join(home, '.claude/plugins/cache/hoai/hoai/0.42.3'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'hoai@hoai': pluginEnabled } }))
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
  // No network in a test: skip `bun install`. Otherwise hand over to the REAL bun when this
  // machine has one, because production runs the prover on bun and nothing else in CI loads the
  // doctor under it (found by review); only fall back to the runtime running this test.
  shim('bun', `[ "$1" = "install" ] && exit 0\nexec "${realBun || process.execPath}" "$@"`)
  // The marketplace plugin runs on node, and the installer refuses a paired folder without one.
  if (withNode) shim('node', 'exit 0')

  const agentBin = join(pluginRoot, 'bin', 'bgos-agent')
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const result = spawnSync('bash', [agentBin, 'install', ...args], {
      cwd: home,
      encoding: 'utf8',
      timeout: 100_000,
      env: { HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, ...extraEnv },
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
  // node's directory leads the service PATH, or the plugin's `node` command is not found under launchd
  const service = readFileSync(m.serviceFiles()[0]!, 'utf8')
  assert.ok(service.includes(`${join(m.home, 'shims')}:`), 'the directory node was found in must be on the service PATH')
  // and the install is stamped, so the agent's own daemon does not remove it before the app records always-on
  assert.match(readFileSync(join(m.home, '.bgos-agent', '936', 'installed-at'), 'utf8').trim(), /^\d{9,11}$/)
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
  assert.match(callsOf(m), /--workspace-publishes --workdir .*901-workspace/, 'the file is READ (one line, nothing written), which is how a foreign .mcp.json is told apart')
  assert.equal(existsSync(join(m.home, '.bgos-agent', '901', 'installed-at')), false, 'no stamp either: a clone-style install leaves exactly what it always left')
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
      name: 'the credentials file holds another agent',
      reason: /paired-topology:credentials-belong-to-another-agent/,
      setup: () => {
        const m = machine()
        const ws = pair(m, '17')
        writeFileSync(join(m.home, '.bgos-agent', 'credentials-17.json'), JSON.stringify({ assistantId: 99 }))
        return { m, args: ['--assistant', '17', '--dir', ws, '--always-on'] }
      },
    },
    {
      name: 'the plugin is installed but disabled',
      reason: /paired-topology:plugin-disabled/,
      setup: () => {
        const m = machine({ pluginEnabled: false })
        const ws = pair(m, '18')
        return { m, args: ['--assistant', '18', '--dir', ws, '--always-on'] }
      },
    },
    {
      name: 'no node on PATH, which the marketplace plugin runs on',
      reason: /paired-topology:node-not-found/,
      setup: () => {
        const m = machine({ withNode: false })
        const ws = pair(m, '19')
        return { m, args: ['--assistant', '19', '--dir', ws, '--always-on'] }
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

const FOREIGN_MCP = JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } }, null, 2)

test('a .mcp.json that belongs to ANOTHER tool only no longer gets a deaf server:bgos agent: proven paired, it launches on the marketplace channel', SLOW, () => {
  if (!ready) return requireTools()
  // Reproduced by review with the real installer before this change: exit 0,
  // "using existing .mcp.json", spawn line ending "server:bgos", in a folder where
  // nothing publishes bgos. Connected and deaf, held up by launchd forever.
  const m = machine()
  const workspace = pair(m, '940')
  writeFileSync(join(workspace, '.mcp.json'), FOREIGN_MCP)
  const result = m.run(['--assistant', '940', '--dir', workspace, '--always-on'])
  assert.equal(result.status, 0, result.out)
  assert.doesNotMatch(result.out, /using existing/)
  assert.ok(spawnLine(m, '940').endsWith(`--dangerously-load-development-channels "${MARKETPLACE_CHANNEL_SPEC}"`), spawnLine(m, '940'))
  assert.equal(readFileSync(join(workspace, '.mcp.json'), 'utf8'), FOREIGN_MCP, 'the other tool keeps its file, byte for byte')
})

test('the same foreign .mcp.json in a folder that is NOT a proven paired folder is refused by name, and the message does not claim the file is missing', SLOW, () => {
  if (!ready) return requireTools()
  const m = machine()
  const workspace = pair(m, '941', { pin: '', creds: false })
  writeFileSync(join(workspace, '.mcp.json'), FOREIGN_MCP)
  const result = m.run(['--assistant', '941', '--dir', workspace, '--always-on'])
  assert.equal(result.status, 1, result.out)
  assert.match(result.out, /the \.mcp\.json in .*941-workspace publishes no HOAI server \(it belongs to another tool\) and no creds given/)
  assert.match(result.out, /paired-topology:no-folder-pin/)
  // the NEGATIVE the title promises: with the file right there, nothing may say it is missing
  assert.doesNotMatch(result.out, /no \.mcp\.json in/i)
  assert.equal(existsSync(join(m.home, '.bgos-agent', '941', 'run.expect')), false)
  assert.deepEqual(m.serviceFiles(), [])
  assert.doesNotMatch(callsOf(m), /^(launchctl|systemctl) /m)
})

test('every folder that DOES publish something server:bgos can launch keeps the old arm: a hand written bgos entry, and a reader that could not run', SLOW, () => {
  if (!ready) return requireTools()
  // (a) an entry CALLED bgos with no env block: not "ours" by the BGOS_ rule, still what server:bgos launches
  const handWritten = machine()
  const wsA = pair(handWritten, '942')
  writeFileSync(join(wsA, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['wrapper.mjs'] } } }))
  const a = handWritten.run(['--assistant', '942', '--dir', wsA, '--always-on'])
  assert.equal(a.status, 0, a.out)
  assert.match(a.out, /using existing/)
  assert.ok(spawnLine(handWritten, '942').endsWith(`"${CLONE_CHANNEL_SPEC}"`))
  // (b) the reader itself broken: FAIL OPEN to the arm the folder always had, never to a refusal
  const broken = machine()
  const wsB = pair(broken, '943')
  writeFileSync(join(wsB, '.mcp.json'), FOREIGN_MCP)
  writeFileSync(join(broken.pluginRoot, 'bin', 'bgos-doctor.mjs'), 'throw new Error("the doctor could not even load")\n')
  const b = broken.run(['--assistant', '943', '--dir', wsB, '--always-on'])
  assert.equal(b.status, 0, b.out)
  assert.match(b.out, /using existing/)
  assert.ok(spawnLine(broken, '943').endsWith(`"${CLONE_CHANNEL_SPEC}"`))
})

test('only a POSITIVE "publishes nothing of ours" widens the arm: a file that is not JSON, a renamed server of ours, and one with an unusable name all keep the old arm', SLOW, () => {
  if (!ready) return requireTools()
  // The bash side of the fail-open promise, which the mutation pass showed was pinned by text only.
  const cases: Array<[string, string]> = [
    ['950', '{ this is not json'],
    ['951', JSON.stringify({ mcpServers: { atlas: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '951' } } } })],
    ['952', JSON.stringify({ mcpServers: { 'my server': { command: 'bun', env: { BGOS_BACKEND_URL: 'x' } } } })],
  ]
  for (const [id, body] of cases) {
    const m = machine()
    const ws = pair(m, id)
    writeFileSync(join(ws, '.mcp.json'), body)
    const result = m.run(['--assistant', id, '--dir', ws, '--always-on'])
    assert.equal(result.status, 0, `${id}: ${result.out}`)
    assert.match(result.out, /using existing/, id)
    assert.doesNotMatch(result.out, /paired folder proven|paired-topology/, id)
    assert.ok(spawnLine(m, id).endsWith(`"${CLONE_CHANNEL_SPEC}"`), `${id}: ${spawnLine(m, id)}`)
    assert.equal(readFileSync(join(ws, '.mcp.json'), 'utf8'), body, `${id}: untouched`)
  }
})

test('a foreign .mcp.json that starts with a BOM is still recognised as foreign', SLOW, () => {
  if (!ready) return requireTools()
  const m = machine()
  const ws = pair(m, '953')
  writeFileSync(join(ws, '.mcp.json'), String.fromCharCode(0xfeff) + FOREIGN_MCP)
  const result = m.run(['--assistant', '953', '--dir', ws, '--always-on'])
  assert.equal(result.status, 0, result.out)
  assert.ok(spawnLine(m, '953').endsWith(`"${MARKETPLACE_CHANNEL_SPEC}"`), spawnLine(m, '953'))
})
