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
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
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
  start: (args: string[], extraEnv?: Record<string, string>) => { child: ChildProcess; done: Promise<{ status: number | null; out: string }> }
  serviceFiles: () => string[]
}

function machine({ fromClone = false, fromCache = false, pluginInstalled = true, pluginEnabled = true, withNode = true, os, holdInstall = false }: { fromClone?: boolean; fromCache?: boolean; pluginInstalled?: boolean; pluginEnabled?: boolean; withNode?: boolean; os?: 'Linux'; holdInstall?: boolean } = {}): Machine {
  const home = mkdtempSync(join(tmpdir(), 'hoai-install-'))
  // Where the code runs from. npx-shaped by default; a plain checkout-shaped dir for the clone
  // case; a marketplace plugin's versioned cache dir (where the watcher's sweep runs it from).
  const pluginRoot = fromClone
    ? join(home, 'bgos-claude-plugin')
    : fromCache
      ? join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai', '0.62.0')
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
  // `is-active` answers from a file, so a test can stand in for a unit that is already running.
  shim('systemctl', `[ "$2" = "is-active" ] && { [ -f "${home}/unit-active" ] && exit 0; exit 3; }\nexit 0`)
  shim('loginctl', 'exit 0')
  // The systemd --user path, on any host: the script reads the OS from `uname -s` once, at the top.
  if (os) shim('uname', `echo ${os}`)
  // No network in a test: skip `bun install`. Otherwise hand over to the REAL bun when this
  // machine has one, because production runs the prover on bun and nothing else in CI loads the
  // doctor under it (found by review); only fall back to the runtime running this test.
  // holdInstall parks an install inside `bun install` (it says so with <home>/holding) until
  // <home>/release exists, so a second install can be started while the first is mid-way.
  const onInstall = holdInstall
    ? `{ : > "${home}/holding"; while [ ! -f "${home}/release" ]; do /bin/sleep 0.05; done; exit 0; }`
    : 'exit 0'
  shim('bun', `[ "$1" = "install" ] && ${onInstall}\nexec "${realBun || process.execPath}" "$@"`)
  // The marketplace plugin runs on node, and the installer refuses a paired folder without one.
  if (withNode) shim('node', 'exit 0')

  const agentBin = join(pluginRoot, 'bin', 'bgos-agent')
  const envFor = (extraEnv: Record<string, string>) => ({ HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, ...extraEnv })
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const result = spawnSync(BASH!, [agentBin, 'install', ...args], {
      cwd: home,
      encoding: 'utf8',
      timeout: 100_000,
      env: envFor(extraEnv),
    })
    return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
  }
  /** The same install, in the background: resolves with its exit code and output when it ends. */
  const start = (args: string[], extraEnv: Record<string, string> = {}) => {
    const child = spawn(BASH!, [agentBin, 'install', ...args], { cwd: home, env: envFor(extraEnv) })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    const done = new Promise<{ status: number | null; out: string }>((resolve) => child.on('close', (status) => resolve({ status, out })))
    return { child, done }
  }
  const serviceFiles = () => {
    const found: string[] = []
    for (const dir of [join(home, 'Library', 'LaunchAgents'), join(home, '.config', 'systemd', 'user')]) {
      if (existsSync(dir)) found.push(...readdirSync(dir).map((f) => join(dir, f)))
    }
    return found
  }
  return { home, agentBin, pluginRoot, calls, run, start, serviceFiles }
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
  assert.doesNotMatch(result.out, /package-runner cache/, 'a marketplace agent starts hoai from its install record, never from where the installer ran')
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
  // This run comes from an npx-shaped cache, which npm may delete: said at install, not discovered later.
  assert.match(result.out, /starts hoai from .*_npx.*, a package-runner cache that npm may delete/)
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
      // The service carries CLAUDE_CONFIG_DIR, so the background session would look in the
      // custom dir and find no plugin there: refused at install, not discovered at launch.
      name: 'installed only under ~/.claude while CLAUDE_CONFIG_DIR (which the service carries) points elsewhere',
      reason: /paired-topology:plugin-not-installed .*where the background agent will look \(.*custom-claude\); that is this shell's CLAUDE_CONFIG_DIR/,
      setup: () => {
        const m = machine()
        const ws = pair(m, '14')
        const custom = join(m.home, 'custom-claude')
        mkdirSync(join(custom, 'plugins'), { recursive: true })
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

test('Linux: a reinstall over a RUNNING unit restarts it (enable --now leaves an active unit on its old run.sh), and a stopped unit is just started', SLOW, (t) => {
  if (!ready(t)) return
  // The upgrade case (design section 5): a generation 1 agent is running, the sweep reinstalls,
  // and `systemctl --user enable --now` does nothing to a unit that is already active. Without a
  // restart the agent kept running run.expect with no tmux after its "upgrade".
  const upgrade = machine({ os: 'Linux' })
  const ws = pair(upgrade, '904')
  writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '904' } } } }))
  writeFileSync(join(upgrade.home, 'unit-active'), '')
  const r = upgrade.run(['--assistant', '904', '--dir', ws, '--always-on'])
  assert.equal(r.status, 0, r.out)
  assert.ok(existsSync(join(upgrade.home, '.config', 'systemd', 'user', 'bgos-agent-904.service')), 'the systemd path ran')
  const calls = callsOf(upgrade).split('\n').filter((l) => l.startsWith('systemctl '))
  const enabled = calls.indexOf('systemctl --user enable --now bgos-agent-904')
  const restarted = calls.indexOf('systemctl --user restart bgos-agent-904')
  assert.ok(enabled >= 0, calls.join('\n'))
  assert.ok(restarted > enabled, `the running unit is restarted onto the new run.sh, after it is enabled:\n${calls.join('\n')}`)
  assert.ok(calls.indexOf('systemctl --user daemon-reload') < enabled, 'the new unit file is loaded first')

  // A unit that is not running: enable --now starts it, and nothing restarts it a second time.
  const fresh = machine({ os: 'Linux' })
  const ws2 = pair(fresh, '905')
  writeFileSync(join(ws2, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '905' } } } }))
  const r2 = fresh.run(['--assistant', '905', '--dir', ws2, '--always-on'])
  assert.equal(r2.status, 0, r2.out)
  const calls2 = callsOf(fresh).split('\n').filter((l) => l.startsWith('systemctl '))
  assert.ok(calls2.includes('systemctl --user enable --now bgos-agent-905'), calls2.join('\n'))
  assert.equal(calls2.filter((l) => / restart /.test(` ${l} `)).length, 0, calls2.join('\n'))
})

function untilExists(path: string, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(path)) return resolve()
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(tick, 25)
    }
    tick()
  })
}

test('two installs of the same agent at once: the second says "install already in progress", exits 0 and writes nothing; the lock goes with the first', SLOW, async (t) => {
  if (!ready(t)) return
  // The daemon's reconcileAlwaysOn and the watcher's sweep can both decide, within the same
  // minute, that agent 906 needs `bgos-agent install`. Two installs writing one run.sh and one
  // service file (and reloading it twice) is a race nobody can read afterwards.
  const m = machine({ holdInstall: true })
  const ws = pair(m, '906')
  writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '906' } } } }))
  const args = ['--assistant', '906', '--dir', ws, '--always-on']
  const first = m.start(args)
  // Whatever happens below, nothing stays parked in the fake `bun install` after the test.
  t.after(() => writeFileSync(join(m.home, 'release'), ''))
  await untilExists(join(m.home, 'holding'), 'the first install to be mid-way')

  const second = m.run(args)
  assert.equal(second.status, 0, second.out)
  assert.match(second.out, /install already in progress for agent 906/)
  assert.equal(existsSync(join(m.home, '.bgos-agent', '906', 'run.sh')), false, 'the second install wrote no supervisor')
  assert.deepEqual(m.serviceFiles(), [], 'and no service file')
  assert.equal(callsOf(m).split('\n').filter((l) => l === 'bun install --no-summary').length, 1, 'only the first one got as far as bun install')

  writeFileSync(join(m.home, 'release'), '')
  const done = await first.done
  assert.equal(done.status, 0, done.out)
  assert.doesNotMatch(done.out, /already in progress/)
  assert.ok(existsSync(join(m.home, '.bgos-agent', '906', 'run.sh')), 'the first install finished')
  assert.equal(existsSync(join(m.home, '.bgos-agent', '906.install.lock')), false, 'and released its lock on the way out')
})

test('an install lock older than ten minutes is stale (its install died without its trap) and is taken over, by name', SLOW, (t) => {
  if (!ready(t)) return
  const m = machine()
  const ws = pair(m, '907')
  writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '907' } } } }))
  const lock = join(m.home, '.bgos-agent', '907.install.lock')
  mkdirSync(lock, { recursive: true })
  const old = new Date(Date.now() - 11 * 60_000)
  utimesSync(lock, old, old)
  const r = m.run(['--assistant', '907', '--dir', ws, '--always-on'])
  assert.equal(r.status, 0, r.out)
  assert.doesNotMatch(r.out, /already in progress/)
  assert.match(r.out, /stale install lock for agent 907/)
  assert.ok(existsSync(join(m.home, '.bgos-agent', '907', 'run.sh')))
  assert.equal(existsSync(lock), false)

  // A fresh lock is NOT stale: that install is still running, so this one stands down.
  const fresh = machine()
  const ws2 = pair(fresh, '908')
  writeFileSync(join(ws2, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '908' } } } }))
  mkdirSync(join(fresh.home, '.bgos-agent', '908.install.lock'), { recursive: true })
  const r2 = fresh.run(['--assistant', '908', '--dir', ws2, '--always-on'])
  assert.equal(r2.status, 0, r2.out)
  assert.match(r2.out, /install already in progress for agent 908/)
  assert.equal(existsSync(join(fresh.home, '.bgos-agent', '908', 'run.sh')), false)
  assert.ok(existsSync(join(fresh.home, '.bgos-agent', '908.install.lock')), 'and leaves the other install\'s lock alone')
})

test('run from a marketplace plugin\'s VERSIONED cache dir, a clone-style folder\'s supervisor looks its root up in the install record at every launch instead of baking that dir', SLOW, (t) => {
  if (!ready(t)) return
  // <config>/plugins/cache/hoai/hoai/0.62.0 is replaced by the next plugin update and pruned
  // after it. Baked as the clone checkout, the agent would stop with plugin-root-missing then.
  const m = machine({ fromCache: true })
  const ws = pair(m, '909')
  writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '909' } } } }))
  const r = m.run(['--assistant', '909', '--dir', ws, '--always-on'])
  assert.equal(r.status, 0, r.out)
  assert.equal(runShVar(m, '909', 'topology'), 'marketplace', 'the root is an install record lookup')
  assert.equal(runShVar(m, '909', 'plugin_key'), 'hoai@hoai', 'named by the cache path: <plugin>@<marketplace>')
  assert.match(r.out, /versioned plugin cache dir.*looks the plugin root up in the install record \(hoai@hoai\)/)
  assert.doesNotMatch(r.out, /package-runner cache/)
  // and the folder's own channel is untouched: it still publishes server:bgos from its .mcp.json
  assert.doesNotMatch(callsOf(m), /prove-paired-topology/)

  // A plain checkout is still a fixed checkout.
  const clone = machine({ fromClone: true })
  const ws2 = pair(clone, '910')
  writeFileSync(join(ws2, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '910' } } } }))
  const r2 = clone.run(['--assistant', '910', '--dir', ws2, '--always-on'])
  assert.equal(r2.status, 0, r2.out)
  assert.equal(runShVar(clone, '910', 'topology'), 'clone')
  assert.equal(runShVar(clone, '910', 'plugin_key'), '')
})

test('a paired folder whose plugin is installed ONLY under the custom CLAUDE_CONFIG_DIR is proven, and the service carries that config dir', SLOW, (t) => {
  if (!ready(t)) return
  // The proof is asked under the environment the service will really have. Generation 2 writes
  // CLAUDE_CONFIG_DIR into the service, so this install is exactly where the background session
  // looks; the proof used to strip the variable and refuse it.
  const m = machine({ pluginInstalled: false })
  const ws = pair(m, '911')
  const custom = join(m.home, 'custom-claude')
  const installPath = join(custom, 'plugins', 'cache', 'hoai', 'hoai', '0.42.3')
  mkdirSync(installPath, { recursive: true })
  writeFileSync(join(custom, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath, version: '0.42.3' }] } }))
  writeFileSync(join(custom, 'settings.json'), JSON.stringify({ enabledPlugins: { 'hoai@hoai': true } }))
  const r = m.run(['--assistant', '911', '--dir', ws, '--always-on'], { CLAUDE_CONFIG_DIR: custom })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /paired folder proven for agent 911/)
  assert.equal(`plugin:${runShVar(m, '911', 'plugin_key')}`, MARKETPLACE_CHANNEL_SPEC)
  const service = readFileSync(m.serviceFiles()[0]!, 'utf8')
  assert.ok(service.includes(custom), 'the service looks in the config dir the proof looked in')
})
