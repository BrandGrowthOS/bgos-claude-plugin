/**
 * bin/bgos-agent names an agent's macOS and Linux service after the HOME it was
 * installed from (board row d6198bb6, mission 154 goal 8), run for real on a faked
 * service layer.
 *
 * The launchd label was ai.bgos.agent.<id>, the systemd unit bgos-agent-<id> and the
 * tmux socket hoai-<id>: one name per user ACCOUNT, because there is one gui/<uid>
 * domain, one systemd --user manager and one tmux socket directory per account. An
 * install, stop or uninstall from a scratch or second HOME holding the same agent's
 * credentials booted out, restarted or stopped the owner's real agent. Now every name
 * carries home-<hid> (#237's watcherHomeId), every command reads the registration back
 * first (bin/hoai-agent-service.mjs probe) and refuses one that records another HOME,
 * and this HOME's OLD job or unit is renamed in place by the next install, in #237's
 * per-OS order; another HOME's is left alone and said.
 *
 * test/helpers/fake-posix-services.mjs is the launchctl, systemctl, loginctl and tmux
 * on PATH: one state file per test, shared by both HOMEs (one account). Nothing real
 * is touched. bin/bgos-agent is the macOS and Linux installer, so on Windows this
 * file skips.
 *
 * Run: npx tsx --test test/bgos-agent.home-scope.test.ts
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { resolvePosixBash } from './helpers/posix-bash.ts'
import { watcherHomeId } from '../lib/watcher-service.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentBin = join(repoRoot, 'bin', 'bgos-agent')
const fakeTool = join(repoRoot, 'test', 'helpers', 'fake-posix-services.mjs')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const ID = '42'
const SLOW = { timeout: 120_000 }

function ready(t: TestContext): boolean {
  if (BASH) return true
  assert.notEqual(process.env.HOAI_REQUIRE_BASH, '1', 'HOAI_REQUIRE_BASH=1 but no bash')
  t.skip(process.platform === 'win32' ? 'bin/bgos-agent is the macOS and Linux installer' : 'no bash')
  return false
}

type Os = 'Darwin' | 'Linux'
type State = {
  uid: number
  managerHome: string
  launchd: Record<string, { plistPath: string; content: string }>
  enabled: string[]
  active: string[]
  tmux: string[]
  fail: Array<{ match: string; exact?: boolean; code?: number; stderr?: string; times?: number }>
  killCallerOn?: string | null
  calls: Array<{ cmd: string; code: number; loaded: string[]; enabled: string[]; active: string[]; tmux: string[] }>
}

/** One user account: two HOMEs on it, one faked service layer, both HOMEs' PATH leading with its tools. */
function account(os: Os) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-homescope-'))
  const owner = join(root, 'home', 'kc')
  const scratch = join(root, 'rig', 'scratch-home')
  const shims = join(root, 'shims')
  const statePath = join(root, 'services.json')
  for (const dir of [owner, scratch, shims]) mkdirSync(dir, { recursive: true })
  const uid = Number(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim())
  // The systemd --user manager is the account's: it reads only the OWNER's unit dir.
  writeFileSync(statePath, JSON.stringify({ uid, managerHome: owner, launchd: {}, enabled: [], active: [], tmux: [], fail: [], calls: [] }))
  const shim = (name: string, body: string) => {
    writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(shims, name), 0o755)
  }
  for (const tool of ['launchctl', 'systemctl', 'loginctl', 'tmux']) shim(tool, `exec '${process.execPath}' '${fakeTool}' '${statePath}' ${tool} "$@"`)
  shim('uname', `echo ${os}`)
  shim('plutil', 'exit 0')
  shim('claude', 'exit 0')
  shim('expect', 'exit 0')
  // bgos-agent's own runtime: `bun install` is skipped (no network), anything else (the
  // HOME id and the read-back helper, the daemon wrapper copy) runs on this test's node.
  shim('bun', `[ "$1" = "install" ] && exit 0\nexec '${process.execPath}' "$@"`)
  shim('node', 'exit 0')
  const workdir = (home: string) => {
    const dir = join(home, 'agents', 'ava')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')] } } }))
    return dir
  }
  const run = (home: string, args: string[]) => {
    const r = spawnSync(BASH!, [agentBin, ...args], {
      cwd: home,
      encoding: 'utf8',
      timeout: 100_000,
      env: { HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', XDG_RUNTIME_DIR: join(root, 'run'), PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin` },
    })
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
  }
  const state = (): State => JSON.parse(readFileSync(statePath, 'utf8'))
  const setState = (mutate: (s: State) => void) => {
    const s = state()
    mutate(s)
    writeFileSync(statePath, JSON.stringify(s))
  }
  const install = (home: string) => run(home, ['install', '--assistant', ID, '--dir', workdir(home), '--always-on', '--no-clone'])
  return { root, owner, scratch, state, setState, run, install, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

type Account = ReturnType<typeof account>
const hid = (home: string) => watcherHomeId(home, 'linux')
const label = (home: string) => `ai.bgos.agent.${ID}.home-${hid(home)}`
const unit = (home: string) => `bgos-agent-${ID}-home-${hid(home)}`
const OLD_LABEL = `ai.bgos.agent.${ID}`
const OLD_UNIT = `bgos-agent-${ID}`
const plistPath = (home: string, name: string) => join(home, 'Library', 'LaunchAgents', `${name}.plist`)
/** This agent's plists in a HOME's LaunchAgents: what the next login loads. */
const agentPlists = (home: string) => {
  const dir = join(home, 'Library', 'LaunchAgents')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`ai.bgos.agent.${ID}`)).sort() : []
}
const unitPath = (home: string, name: string) => join(home, '.config', 'systemd', 'user', `${name}.service`)

/** The plist 0.69.2's bin/bgos-agent wrote for this agent in that HOME (what matters to a read-back). */
function oldPlist(home: string) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${OLD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/bash</string>',
    `    <string>${home}/.bgos-agent/${ID}/run.sh</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key><string>${home}/agents/ava</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>HOME</key><string>${home}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** The unit 0.69.2's bin/bgos-agent wrote for this agent in that HOME. */
function oldUnit(home: string) {
  return ['[Unit]', `Description=BGOS Claude Code agent ${ID}`, '', '[Service]', 'Type=simple', `WorkingDirectory=${home}/agents/ava`, `ExecStart=/bin/bash "${home}/.bgos-agent/${ID}/run.sh"`, `Environment=HOME=${home}`, '', '[Install]', 'WantedBy=default.target', ''].join('\n')
}

/** The owner's 0.69.2 agent: its old job loaded (macOS) or its old unit enabled and running (Linux), its tmux server up. */
function seedOldAgent(a: Account, os: Os) {
  if (os === 'Darwin') {
    const path = plistPath(a.owner, OLD_LABEL)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, oldPlist(a.owner))
    a.setState((s) => {
      s.launchd[OLD_LABEL] = { plistPath: path, content: oldPlist(a.owner) }
      s.tmux.push(`hoai-${ID}`)
    })
  } else {
    const path = unitPath(a.owner, OLD_UNIT)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, oldUnit(a.owner))
    a.setState((s) => {
      s.enabled.push(OLD_UNIT)
      s.active.push(OLD_UNIT)
      s.tmux.push(`hoai-${ID}`)
    })
  }
}

/** Calls that ACT on a name (not the read-only print / show / is-active / status / list). */
const acting = (cmd: string) => !/^(launchctl (print|list)|systemctl --user (show|show-environment|is-active|status|list-units|daemon-reload)|loginctl|tmux .*(has-session|list-sessions))\b/.test(cmd)
const namesExactly = (cmd: string, name: string) => new RegExp(`(^|[\\s/=])${name.replace(/\./g, '\\.')}(\\.service|\\.plist)?($|\\s)`).test(cmd)

// -- two HOMEs side by side -------------------------------------------------------------------------

test('macOS: two HOMEs with the same agent id side by side: each loads its own job under its own HOME\'s label, neither replaces the other', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  const owner = a.install(a.owner)
  assert.equal(owner.status, 0, owner.out)
  const ownerJob = JSON.stringify(a.state().launchd[label(a.owner)])
  assert.ok(ownerJob, 'the owner job is loaded under its own label')
  const scratch = a.install(a.scratch)
  assert.equal(scratch.status, 0, scratch.out)
  assert.deepEqual(Object.keys(a.state().launchd).sort(), [label(a.owner), label(a.scratch)].sort())
  assert.equal(JSON.stringify(a.state().launchd[label(a.owner)]), ownerJob, 'the owner job, byte for byte')
  // The run.sh of each HOME bakes its own tmux socket: one HOME's run.sh never ends the other's server.
  for (const home of [a.owner, a.scratch]) {
    const runSh = readFileSync(join(home, '.bgos-agent', ID, 'run.sh'), 'utf8')
    assert.match(runSh, new RegExp(`^sock=hoai-${ID}-home-${hid(home)}$`, 'm'))
  }
})

test('Linux: two HOMEs side by side: the owner\'s unit is the owner\'s; a scratch HOME\'s install fails by its own name and never reaches the owner\'s unit', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Linux')
  t.after(a.cleanup)
  const owner = a.install(a.owner)
  assert.equal(owner.status, 0, owner.out)
  assert.deepEqual(a.state().active, [unit(a.owner)])
  const from = a.state().calls.length
  const scratch = a.install(a.scratch)
  // The user manager reads only the account's own unit dir, so the scratch unit is not found by name.
  assert.notEqual(scratch.status, 0, scratch.out)
  assert.deepEqual(a.state().active, [unit(a.owner)])
  assert.deepEqual(a.state().enabled, [unit(a.owner)])
  const touched = a.state().calls.slice(from).filter((c) => acting(c.cmd) && namesExactly(c.cmd, unit(a.owner)))
  assert.deepEqual(touched, [], 'the scratch HOME never acted on the owner\'s unit')
})

// -- a scratch HOME cannot touch the owner's agent -------------------------------------------------------

for (const os of ['Darwin', 'Linux'] as const) {
  test(`${os}: a scratch HOME cannot touch the default HOME's 0.69.2 agent: install, stop, restart, status and uninstall leave its job and its tmux server exactly as they were, and say so`, SLOW, (t) => {
    if (!ready(t)) return
    const a = account(os)
    t.after(a.cleanup)
    seedOldAgent(a, os)
    const before = JSON.stringify({ launchd: a.state().launchd[OLD_LABEL] ?? null, enabled: a.state().enabled.includes(OLD_UNIT), active: a.state().active.includes(OLD_UNIT) })
    const from = a.state().calls.length
    const results = [
      a.install(a.scratch),
      a.run(a.scratch, ['stop', '--assistant', ID]),
      a.run(a.scratch, ['restart', '--assistant', ID]),
      a.run(a.scratch, ['status', '--assistant', ID]),
      a.run(a.scratch, ['uninstall', '--assistant', ID]),
    ]
    const after = JSON.stringify({ launchd: a.state().launchd[OLD_LABEL] ?? null, enabled: a.state().enabled.includes(OLD_UNIT), active: a.state().active.includes(OLD_UNIT) })
    assert.equal(after, before, 'the owner\'s old job or unit, exactly as it was')
    assert.ok(a.state().tmux.includes(`hoai-${ID}`), 'the owner agent\'s tmux server still runs')
    const oldName = os === 'Darwin' ? OLD_LABEL : OLD_UNIT
    const touched = a.state().calls.slice(from).filter((c) => acting(c.cmd) && (namesExactly(c.cmd, oldName) || c.cmd.includes(`-L hoai-${ID} `) || c.cmd.endsWith(`-L hoai-${ID}`)))
    assert.deepEqual(touched.map((c) => c.cmd), [], 'the old name and the old socket were only ever READ from the scratch HOME')
    assert.ok(existsSync(os === 'Darwin' ? plistPath(a.owner, OLD_LABEL) : unitPath(a.owner, OLD_UNIT)), 'the owner\'s service file is not the scratch HOME\'s to remove')
    const said = results.map((r) => r.out).join('\n')
    assert.match(said, new RegExp(`service note: left the ${os === 'Darwin' ? 'launchd job' : 'systemd unit'} "${oldName}" alone: it was installed from another HOME \\(${a.owner.replace(/\//g, '\\/')}\\)`))
  })
}

test('macOS: a scratch HOME\'s own leftover 0.69.2 plist never steers its start, restart or stop onto the owner\'s loaded old job', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  // A 0.69.2 install in the scratch HOME left its old plist there (same label, the scratch HOME's run.sh).
  const leftover = plistPath(a.scratch, OLD_LABEL)
  mkdirSync(dirname(leftover), { recursive: true })
  writeFileSync(leftover, oldPlist(a.scratch))
  const before = JSON.stringify(a.state().launchd[OLD_LABEL])
  const from = a.state().calls.length
  for (const cmd of ['start', 'restart', 'stop']) a.run(a.scratch, [cmd, '--assistant', ID])
  assert.equal(JSON.stringify(a.state().launchd[OLD_LABEL]), before, 'the owner\'s old job, exactly as it was')
  const touched = a.state().calls.slice(from).filter((c) => acting(c.cmd) && (namesExactly(c.cmd, OLD_LABEL) || c.cmd.includes(leftover)))
  assert.deepEqual(touched.map((c) => c.cmd), [])
})

test('macOS: this HOME\'s own label recording another HOME is refused by install and uninstall: exit nonzero, named, nothing written or removed', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  // A job under the OWNER's scoped label that was loaded from the scratch HOME's plist (copied, or a hash collision).
  const foreign = oldPlist(a.scratch).replace(`<string>${OLD_LABEL}</string>`, `<string>${label(a.owner)}</string>`)
  const path = plistPath(a.scratch, label(a.owner))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, foreign)
  a.setState((s) => {
    s.launchd[label(a.owner)] = { plistPath: path, content: foreign }
  })
  const before = JSON.stringify(a.state().launchd)
  const installed = a.install(a.owner)
  assert.notEqual(installed.status, 0)
  assert.match(installed.out, new RegExp(`refused: the launchd job "${label(a.owner).replace(/\./g, '\\.')}" records another HOME`))
  assert.equal(existsSync(join(a.owner, '.bgos-agent', ID, 'run.sh')), false, 'a refused install writes no run.sh')
  assert.equal(existsSync(plistPath(a.owner, label(a.owner))), false, 'nor a plist')
  mkdirSync(join(a.owner, '.bgos-agent', ID), { recursive: true })
  writeFileSync(join(a.owner, '.bgos-agent', ID, 'run.sh'), 'x')
  const removed = a.run(a.owner, ['uninstall', '--assistant', ID])
  assert.notEqual(removed.status, 0)
  assert.match(removed.out, /nothing was removed/)
  assert.ok(existsSync(join(a.owner, '.bgos-agent', ID, 'run.sh')), 'no purge')
  assert.equal(JSON.stringify(a.state().launchd), before)
})

// -- the same HOME's old job is renamed in place --------------------------------------------------------

test('macOS same-HOME migration: install renames the 0.69.2 job in #237\'s order (old booted out and gone, then the new one bootstrapped), never two at once; its old plist and old tmux server go', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  const r = a.install(a.owner)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(Object.keys(a.state().launchd), [label(a.owner)])
  assert.match(r.out, new RegExp(`service note: renamed the launchd job "${OLD_LABEL}" \\(installed from this HOME by an older version\\) to launchd job "${label(a.owner)}"`))
  assert.equal(existsSync(plistPath(a.owner, OLD_LABEL)), false, 'the old plist would load again at the next login')
  for (const c of a.state().calls) assert.ok(c.loaded.filter((l) => l.startsWith(`ai.bgos.agent.${ID}`)).length <= 1, `two jobs at: ${c.cmd}`)
  const cmds = a.state().calls.map((c) => c.cmd)
  const outAt = cmds.findIndex((c) => c === `launchctl bootout gui/${a.state().uid}/${OLD_LABEL}`)
  const inAt = cmds.findIndex((c) => c.startsWith('launchctl bootstrap') && c.endsWith(`${label(a.owner)}.plist`))
  assert.ok(outAt >= 0 && inAt > outAt, cmds.join('\n'))
  assert.equal(a.state().tmux.includes(`hoai-${ID}`), false, 'the old job\'s tmux server ended with it')
})

test('macOS same-HOME migration rollback: when the new job does not come up the old one is loaded again and the new plist removed', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    s.fail.push({ match: `${label(a.owner)}.plist`, code: 5, stderr: 'Bootstrap failed: 5: Input/output error', times: 99 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0)
  assert.match(r.out, new RegExp(`migration rolled back \\(the old job "${OLD_LABEL}" is loaded again\\)`))
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL])
  assert.equal(existsSync(plistPath(a.owner, label(a.owner))), false)
  assert.ok(existsSync(plistPath(a.owner, OLD_LABEL)))
})

test('macOS: the owner\'s old label held by ANOTHER HOME (a 0.69.2 rig took it): the owner\'s install leaves that job alone but removes the owner\'s own old plist, so the next login loads ONE plist of the agent', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  // The owner's 0.69.2 plist is in place, but the loaded ai.bgos.agent.42 is the rig's (its plist, its HOME).
  const ownerOld = plistPath(a.owner, OLD_LABEL)
  mkdirSync(dirname(ownerOld), { recursive: true })
  writeFileSync(ownerOld, oldPlist(a.owner))
  const rigOld = plistPath(a.scratch, OLD_LABEL)
  mkdirSync(dirname(rigOld), { recursive: true })
  writeFileSync(rigOld, oldPlist(a.scratch))
  a.setState((s) => {
    s.launchd[OLD_LABEL] = { plistPath: rigOld, content: oldPlist(a.scratch) }
  })
  const rigJob = JSON.stringify(a.state().launchd[OLD_LABEL])
  const r = a.install(a.owner)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(agentPlists(a.owner), [`${label(a.owner)}.plist`], 'only the new plist loads at the next login')
  assert.equal(JSON.stringify(a.state().launchd[OLD_LABEL]), rigJob, 'the rig\'s job is left exactly as it is')
  assert.ok(existsSync(rigOld), 'and so is its plist')
  assert.match(r.out, /service note: removed .*ai\.bgos\.agent\.42\.plist, an old service file of this HOME/)
})

test('macOS: an old job that cannot be read back, with this HOME\'s old plist there, is refused by install (the job may be this HOME\'s: a second one beside it could run the agent twice)', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    s.fail.push({ match: `launchctl print gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 99 })
  })
  const before = JSON.stringify(a.state().launchd)
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0)
  assert.match(r.out, /refused: the old service of agent 42 could not be read back .* nothing was changed/)
  assert.equal(JSON.stringify(a.state().launchd), before)
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`])
  assert.equal(existsSync(join(a.owner, '.bgos-agent', ID, 'run.sh')), false, 'nothing of the supervisor is written')
})

test('macOS rename: a bootout that fails while the old job stays loaded rolls back cleanly: the old job and its plist as they were, no new plist', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0)
  assert.match(r.out, new RegExp(`migration rolled back \\(the old job "${OLD_LABEL}" is loaded again\\)`))
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL])
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`], 'exactly the old plist, back in its place')
  assert.ok(a.state().tmux.includes(`hoai-${ID}`), 'the old job\'s session was not ended for a rename that did not happen')
})

test('macOS rename from inside the old job\'s own session: the installer is killed at the bootout, and the next login still finds exactly ONE plist of the agent', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    s.killCallerOn = `launchctl bootout gui/${s.uid}/${OLD_LABEL}`
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, 'the installer died at the bootout')
  assert.deepEqual(Object.keys(a.state().launchd), [], 'the old job is gone (the installer never reached the bootstrap)')
  assert.deepEqual(agentPlists(a.owner), [`${label(a.owner)}.plist`], 'one plist: the next login starts the agent once, under the new name')
})

test('Linux same-HOME migration: install renames the 0.69.2 unit with ONE manager job (drop-in Conflicts=, new enabled first, old disabled, one start): never without an enabled unit, never two running', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Linux')
  t.after(a.cleanup)
  seedOldAgent(a, 'Linux')
  const r = a.install(a.owner)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(a.state().enabled, [unit(a.owner)])
  assert.deepEqual(a.state().active, [unit(a.owner)])
  assert.match(r.out, new RegExp(`service note: renamed the systemd unit "${OLD_UNIT}" \\(installed from this HOME by an older version\\) to systemd unit "${unit(a.owner)}"`))
  const ours = (list: string[]) => list.filter((u) => u.startsWith(`bgos-agent-${ID}`))
  for (const c of a.state().calls) {
    assert.ok(ours(c.enabled).length >= 1, `no enabled unit at: ${c.cmd}`)
    assert.ok(ours(c.active).length <= 1, `two running at: ${c.cmd}`)
  }
  const cmds = a.state().calls.map((c) => c.cmd)
  assert.ok(cmds.indexOf(`systemctl --user enable ${unit(a.owner)}`) < cmds.indexOf(`systemctl --user disable ${OLD_UNIT}`), cmds.join('\n'))
  assert.equal(cmds.filter((c) => c === `systemctl --user stop ${OLD_UNIT}`).length, 0, 'the old unit is stopped by the manager\'s swap job, never by the installer')
  assert.equal(existsSync(unitPath(a.owner, OLD_UNIT)), false, 'the old unit file goes once it is done')
  assert.equal(existsSync(join(dirname(unitPath(a.owner, unit(a.owner))), `${unit(a.owner)}.service.d`, 'hoai-rename.conf')), false, 'the drop-in goes once it is done')
})

test('Linux same-HOME migration rollback: a swap that fails enables and starts the old unit again', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Linux')
  t.after(a.cleanup)
  seedOldAgent(a, 'Linux')
  a.setState((s) => {
    s.fail.push({ match: `systemctl --user start ${unit(a.owner)}`, code: 1, stderr: 'Job failed.', times: 1 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0)
  assert.match(r.out, new RegExp(`migration rolled back \\(the old unit "${OLD_UNIT}" is enabled and started again\\)`))
  assert.deepEqual(a.state().enabled, [OLD_UNIT])
  assert.deepEqual(a.state().active, [OLD_UNIT])
  assert.equal(existsSync(unitPath(a.owner, unit(a.owner))), false, 'the new unit file goes: nothing later acts on a new unit that does not run')
  // So stop, restart and status act on the old unit that runs, never on a stray new one.
  const from = a.state().calls.length
  assert.equal(a.run(a.owner, ['restart', '--assistant', ID]).status, 0)
  assert.ok(a.state().calls.slice(from).some((c) => c.cmd === `systemctl --user restart ${OLD_UNIT}`))
  assert.deepEqual(a.state().active, [OLD_UNIT])
})

test('an agent not renamed yet is still found and supervised under its old name (status, restart); the next install renames it', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  const status = a.run(a.owner, ['status', '--assistant', ID])
  assert.equal(status.status, 0, status.out)
  assert.match(status.out, new RegExp(`${OLD_LABEL.replace(/\./g, '\\.')} is loaded`))
  assert.match(status.out, /was installed from this HOME by an older version; the next install renames it/)
  const from = a.state().calls.length
  const restarted = a.run(a.owner, ['restart', '--assistant', ID])
  assert.equal(restarted.status, 0, restarted.out)
  assert.ok(a.state().calls.slice(from).some((c) => c.cmd.startsWith('launchctl bootstrap') && c.cmd.endsWith(`${OLD_LABEL}.plist`)), 'restarted under the old name')
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL])
  // is-installed sees the old service file of this HOME.
  assert.equal(a.run(a.owner, ['is-installed', '--assistant', ID]).status, 0)
})

// -- uninstall removes only its own ----------------------------------------------------------------------

test('macOS: an old name is never LOADED anew: start or restart with only this HOME\'s old plist and nothing loaded says to run install (which renames it), and bootstraps nothing', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  const old = plistPath(a.owner, OLD_LABEL)
  mkdirSync(dirname(old), { recursive: true })
  writeFileSync(old, oldPlist(a.owner))
  for (const cmd of ['start', 'restart']) {
    const r = a.run(a.owner, [cmd, '--assistant', ID])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /installed under its old name and not loaded; run: hoai-agent install --assistant 42 --always-on/)
  }
  assert.equal(a.state().calls.some((c) => c.cmd.startsWith('launchctl bootstrap')), false)
  assert.deepEqual(Object.keys(a.state().launchd), [])
})

test('macOS: uninstall removes only its own: the scratch HOME\'s job goes, the owner\'s stays; the owner\'s uninstall takes its old job too', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  assert.equal(a.install(a.owner).status, 0)
  assert.equal(a.install(a.scratch).status, 0)
  a.setState((s) => {
    s.tmux.push(`hoai-${ID}-home-${hid(a.owner)}`, `hoai-${ID}-home-${hid(a.scratch)}`)
  })
  const ownerJob = JSON.stringify(a.state().launchd[label(a.owner)])
  const removed = a.run(a.scratch, ['uninstall', '--assistant', ID])
  assert.equal(removed.status, 0, removed.out)
  assert.deepEqual(Object.keys(a.state().launchd), [label(a.owner)])
  assert.equal(JSON.stringify(a.state().launchd[label(a.owner)]), ownerJob)
  assert.deepEqual(a.state().tmux, [`hoai-${ID}-home-${hid(a.owner)}`], 'only the scratch HOME\'s tmux server ended')
  assert.ok(existsSync(plistPath(a.owner, label(a.owner))))
  // The owner's uninstall, with a leftover old job of its own HOME: both go, and it says so.
  const old = plistPath(a.owner, OLD_LABEL)
  writeFileSync(old, oldPlist(a.owner))
  a.setState((s) => {
    s.launchd[OLD_LABEL] = { plistPath: old, content: oldPlist(a.owner) }
  })
  const mine = a.run(a.owner, ['uninstall', '--assistant', ID])
  assert.equal(mine.status, 0, mine.out)
  assert.deepEqual(Object.keys(a.state().launchd), [])
  assert.match(mine.out, new RegExp(`service note: removed the launchd job "${OLD_LABEL}" \\(installed from this HOME by an older version\\)`))
})

test('the id-less listing marks each agent job by the HOME its name carries', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  assert.equal(a.install(a.owner).status, 0)
  assert.equal(a.install(a.scratch).status, 0)
  seedOldAgent(a, 'Darwin')
  const listing = a.run(a.owner, ['status']).out
  assert.match(listing, new RegExp(`${label(a.owner).replace(/\./g, '\\.')}\\s+\\(this HOME\\)`))
  assert.match(listing, new RegExp(`${label(a.scratch).replace(/\./g, '\\.')}\\s+\\(another HOME\\)`))
  assert.match(listing, new RegExp(`${OLD_LABEL.replace(/\./g, '\\.')}\\s+\\(old name, 0\\.69\\.2 or earlier`))
})
