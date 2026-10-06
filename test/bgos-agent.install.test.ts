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
 *      resolver proved (generation 2: run.sh starts hoai from that marketplace
 *      install's record), and no .mcp.json is invented for it;
 *   2. a clone-style folder that DOES carry a .mcp.json keeps its file
 *      untouched, the prover is never even started, and run.sh starts hoai
 *      from this checkout (hoai then reads `server:bgos` from that .mcp.json);
 *   3. every always-on install is stamped (installed-at, fact 3) and carries
 *      supervisor generation 2, and the service carries CLAUDE_CONFIG_DIR and
 *      HOAI_SERVICE_NAMESPACE when the installing shell had them;
 *   4. every refusal is named, exits nonzero, and leaves NOTHING behind: no
 *      run.sh, no service file, no launchctl or systemctl call. A refused
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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { CLONE_CHANNEL_SPEC, MARKETPLACE_CHANNEL_SPEC } from '../bin/bgos-install-method.mjs'
import { resolvePosixBash } from './helpers/posix-bash.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
// bin/bgos-agent is the macOS and Linux installer: it refuses any other OS by name (on Windows it
// says to use WSL), so on Windows there is nothing here to run. Elsewhere the tools are probed
// through the bash that will run the script, and a probe that cannot run reads as "missing", never
// as an exception at import.
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const probe = (script: string) => (BASH ? spawnSync(BASH, ['-c', script], { encoding: 'utf8' }) : null)
const hasExpect = probe('command -v expect')?.status === 0
const hasGit = probe('command -v git')?.status === 0
const SLOW = { timeout: 120_000 }
const realBun = String(probe('command -v bun')?.stdout ?? '').trim()

/**
 * True when this machine can run the installer; otherwise the test SKIPS with the reason. A skip,
 * never an early return, which would report PASS: CI sets HOAI_REQUIRE_EXPECT=1, which turns a
 * missing bash, git or expect into a failure there.
 */
function ready(t: TestContext): boolean {
  if (process.platform === 'win32') {
    t.skip('bin/bgos-agent is the macOS and Linux installer and refuses Windows by name; Windows installs through hoai-bootstrap.ps1')
    return false
  }
  if (BASH && hasExpect && hasGit) return true
  assert.notEqual(process.env.HOAI_REQUIRE_EXPECT, '1', 'HOAI_REQUIRE_EXPECT=1 but bash, git or expect is missing')
  t.skip(`needs bash, git and expect (bash ${BASH ? 'found' : 'missing'}, git ${hasGit ? 'found' : 'missing'}, expect ${hasExpect ? 'found' : 'missing'})`)
  return false
}

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
    const result = spawnSync(BASH!, [agentBin, 'install', ...args], {
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
/** A value baked into run.sh's header (a %q-quoted assignment), read back by bash itself. */
const runShVar = (m: Machine, id: string, name: string) => {
  const runSh = join(m.home, '.bgos-agent', id, 'run.sh')
  const header = readFileSync(runSh, 'utf8').split('\n').filter((l) => /^(sd|id|node_bin|topology|plugin_key|clone_root)=/.test(l)).join('\n')
  return String(spawnSync(BASH!, ['-c', `${header}\nprintf '%s' "$${name}"`], { encoding: 'utf8' }).stdout)
}

test('a PROVEN paired folder with no .mcp.json gets its supervisor, on the channel the resolver proved, and no .mcp.json is invented', SLOW, (t) => {
  if (!ready(t)) return
  const m = machine()
  const workspace = pair(m, '936')
  const result = m.run(['--assistant', '936', '--dir', workspace, '--always-on'])
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /paired folder proven for agent 936 \(folder pin, agent credentials, plugin install record\)/)
  // Generation 2: run.sh resolves the plugin root from THIS channel's install record at every
  // launch, and hoai (started from it) resolves the same marketplace spec the prover proved.
  assert.equal(`plugin:${runShVar(m, '936', 'plugin_key')}`, MARKETPLACE_CHANNEL_SPEC)
  assert.equal(runShVar(m, '936', 'topology'), 'marketplace')
  assert.equal(runShVar(m, '936', 'node_bin'), join(m.home, 'shims', 'node'), 'the node resolved at install is baked')
  assert.equal(existsSync(join(m.home, '.bgos-agent', '936', 'run.expect')), false, 'run.expect is not the launch path any more')
  assert.equal(readFileSync(join(m.home, '.bgos-agent', '936', 'supervisor-generation'), 'utf8').trim(), '2')
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

test('a CLONE-STYLE folder that carries a .mcp.json keeps it byte for byte, the prover is never even started, and hoai starts from this checkout', SLOW, (t) => {
  if (!ready(t)) return
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
  // The clone topology: run.sh starts hoai from this checkout, and hoai reads the channel from
  // the folder's own .mcp.json (server:bgos, bin/hoai-core.mjs resolveChannelSpec).
  assert.equal(runShVar(m, '901', 'topology'), 'clone')
  assert.equal(runShVar(m, '901', 'clone_root'), realpathSync(m.pluginRoot), 'the checkout, physically resolved at install')
  assert.equal(runShVar(m, '901', 'plugin_key'), '')
  assert.equal(CLONE_CHANNEL_SPEC, 'server:bgos')
  assert.equal(readFileSync(join(workspace, '.mcp.json'), 'utf8'), mcp, 'byte for byte')
  assert.doesNotMatch(callsOf(m), /prove-paired-topology/, 'the prover must not run at all for a folder that publishes its own server')
  // Fact 3: EVERY always-on install gets the grace stamp now. Before, only a paired folder did,
  // so a clone-style agent's own daemon could remove the supervisor it ran under within seconds.
  assert.match(readFileSync(join(m.home, '.bgos-agent', '901', 'installed-at'), 'utf8').trim(), /^\d{9,11}$/)
  assert.equal(readFileSync(join(m.home, '.bgos-agent', '901', 'supervisor-generation'), 'utf8').trim(), '2')
})

test('the service carries CLAUDE_CONFIG_DIR and a valid HOAI_SERVICE_NAMESPACE from the installing shell; an invalid namespace is refused by name and left out', SLOW, (t) => {
  if (!ready(t)) return
  const m = machine()
  const workspace = pair(m, '902')
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '902' } } } }))
  const custom = join(m.home, 'custom claude')
  const ok = m.run(['--assistant', '902', '--dir', workspace, '--always-on'], { CLAUDE_CONFIG_DIR: custom, HOAI_SERVICE_NAMESPACE: 'stage1' })
  assert.equal(ok.status, 0, ok.out)
  const service = readFileSync(m.serviceFiles()[0]!, 'utf8')
  if (service.includes('<plist')) {
    assert.ok(service.includes(`<key>CLAUDE_CONFIG_DIR</key><string>${custom}</string>`), service)
    assert.ok(service.includes('<key>HOAI_SERVICE_NAMESPACE</key><string>stage1</string>'), service)
  } else {
    assert.ok(service.includes(`Environment="CLAUDE_CONFIG_DIR=${custom}"`), service)
    assert.ok(service.includes('Environment=HOAI_SERVICE_NAMESPACE=stage1'), service)
  }
  // Without them, the service is exactly what it was.
  const plain = machine()
  const ws2 = pair(plain, '903')
  writeFileSync(join(ws2, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '903' } } } }))
  const bad = plain.run(['--assistant', '903', '--dir', ws2, '--always-on'], { HOAI_SERVICE_NAMESPACE: 'Not-Valid' })
  assert.equal(bad.status, 0, bad.out)
  assert.match(bad.out, /HOAI_SERVICE_NAMESPACE must be 1 to 16 lowercase letters or digits; it is ignored/)
  const plainService = readFileSync(plain.serviceFiles()[0]!, 'utf8')
  assert.doesNotMatch(plainService, /CLAUDE_CONFIG_DIR|HOAI_SERVICE_NAMESPACE/)
})

test('every refusal is NAMED, exits nonzero, and leaves nothing behind: no wrapper, no service file, no service call', SLOW, (t) => {
  if (!ready(t)) return
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
      // Checked in the preflight now: the supervisor runs hoai on node whatever the topology.
      name: 'no node on PATH, which the always-on supervisor runs hoai on',
      reason: /supervisor:node-not-found/,
      setup: () => {
        const m = machine({ withNode: false })
        const ws = pair(m, '19')
        return { m, args: ['--assistant', '19', '--dir', ws, '--always-on'] }
      },
    },
    {
      // Without --always-on the paired arm's own check still names the plugin's need for node.
      name: 'no node on PATH, which the marketplace plugin runs on (no supervisor asked for)',
      reason: /paired-topology:node-not-found/,
      setup: () => {
        const m = machine({ withNode: false })
        const ws = pair(m, '20')
        return { m, args: ['--assistant', '20', '--dir', ws] }
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
    assert.equal(existsSync(join(m.home, '.bgos-agent', id, 'run.sh')), false, `${c.name}: no supervisor may be written`)
    assert.equal(existsSync(join(m.home, '.bgos-agent', id, 'run.expect')), false, `${c.name}: no wrapper may be written`)
    assert.deepEqual(m.serviceFiles(), [], `${c.name}: no service file may be written`)
    assert.doesNotMatch(callsOf(m), /^(launchctl|systemctl) /m, `${c.name}: the service manager must never be called`)
  }
})
