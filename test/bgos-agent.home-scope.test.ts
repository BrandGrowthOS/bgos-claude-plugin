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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  panes?: Record<string, string[]>
  fail: Array<{ match: string; exact?: boolean; code?: number; stderr?: string; times?: number; skip?: number }>
  killCallerOn?: string | null
  watch?: string
  unloadWith?: { line: string; label: string; skip?: number } | Array<{ line: string; label: string; skip?: number }>
  bootoutKeeps?: string[]
  calls: Array<{ cmd: string; code: number; loaded: string[]; enabled: string[]; active: string[]; tmux: string[]; watched?: string | null }>
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
  // HOAI_TEST_NO_HELPER: no runtime answers bin/hoai-agent-service.mjs (no bun and no node on the box).
  shim('bun', `[ "$1" = "install" ] && exit 0\ncase "$1" in */hoai-agent-service.mjs) [ -n "$HOAI_TEST_NO_HELPER" ] && exit 1 ;; esac\nexec '${process.execPath}' "$@"`)
  shim('node', 'exit 0')
  const workdir = (home: string) => {
    const dir = join(home, 'agents', 'ava')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')] } } }))
    return dir
  }
  const run = (home: string, args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(BASH!, [agentBin, ...args], {
      cwd: home,
      encoding: 'utf8',
      timeout: 100_000,
      env: { HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', XDG_RUNTIME_DIR: join(root, 'run'), PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, ...extraEnv },
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
// The HOME id of a HOME, by its real path (round 2 H2: one HOME spelled through a symlink is one HOME).
const hid = (home: string) => watcherHomeId(existsSync(home) ? realpathSync(home) : home, 'linux')
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

test('macOS same-HOME migration: install renames the 0.69.2 job, the new one bootstrapped and read back BEFORE the old one is booted out (round 2 M1), two loaded only between the two; its old plist and old tmux server go', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  const r = a.install(a.owner)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(Object.keys(a.state().launchd), [label(a.owner)])
  assert.match(r.out, new RegExp(`service note: renamed the launchd job "${OLD_LABEL}" \\(installed from this HOME by an older version\\) to launchd job "${label(a.owner)}"`))
  assert.equal(existsSync(plistPath(a.owner, OLD_LABEL)), false, 'the old plist would load again at the next login')
  const calls = a.state().calls
  const cmds = calls.map((c) => c.cmd)
  const outAt = cmds.findIndex((c) => c === `launchctl bootout gui/${a.state().uid}/${OLD_LABEL}`)
  const inAt = cmds.findIndex((c) => c.startsWith('launchctl bootstrap') && c.endsWith(`${label(a.owner)}.plist`))
  assert.ok(inAt >= 0 && outAt > inAt, cmds.join('\n'))
  calls.forEach((c, i) => {
    const jobs = c.loaded.filter((l) => l.startsWith(`ai.bgos.agent.${ID}`)).length
    assert.ok(jobs <= (i >= inAt && i < outAt ? 2 : 1), `${jobs} jobs at: ${c.cmd}`)
  })
  assert.equal(a.state().tmux.includes(`hoai-${ID}`), false, 'the old job\'s tmux server ended with it')
})

test('macOS same-HOME migration rollback: when the new job does not come up the old one stays loaded, as it was, and the new plist is removed', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    s.fail.push({ match: `${label(a.owner)}.plist`, code: 5, stderr: 'Bootstrap failed: 5: Input/output error', times: 99 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0)
  assert.match(r.out, new RegExp(`migration rolled back \\(the old job "${OLD_LABEL}" stays loaded, the new one is removed\\)`))
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
  assert.match(r.out, new RegExp(`migration rolled back \\(the old job "${OLD_LABEL}" stays loaded, the new one is removed\\)`))
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
  // Round 2 M1: the new job was loaded and read back BEFORE the old one was booted out, so the
  // agent is supervised under its new name right away, not only from the next login.
  assert.deepEqual(Object.keys(a.state().launchd), [label(a.owner)], 'the new job is loaded')
  assert.deepEqual(agentPlists(a.owner), [`${label(a.owner)}.plist`], 'one plist: the next login starts the agent once, under the new name')
  const cmds = a.state().calls.map((c) => c.cmd)
  const inAt = cmds.findIndex((c) => c.startsWith('launchctl bootstrap') && c.endsWith(`${label(a.owner)}.plist`))
  const outAt = cmds.findIndex((c) => c === `launchctl bootout gui/${a.state().uid}/${OLD_LABEL}`)
  assert.ok(inAt >= 0 && outAt > inAt, cmds.join('\n'))
})

// -- round 2 -----------------------------------------------------------------------------------

for (const os of ['Darwin', 'Linux'] as const) {
  test(`round 2 H2 (${os}): a HOME spelled through a symlink is ONE HOME: its id is the real path's, and the owner's 0.69.2 job recorded under the real spelling is renamed, never joined by a second job`, SLOW, (t) => {
    if (!ready(t)) return
    const a = account(os)
    t.after(a.cleanup)
    seedOldAgent(a, os)
    const alias = join(a.root, 'alias-kc')
    symlinkSync(a.owner, alias)
    const r = a.install(alias)
    assert.equal(r.status, 0, r.out)
    if (os === 'Darwin') {
      assert.deepEqual(Object.keys(a.state().launchd), [label(a.owner)], 'one job, under the id of the real path')
      assert.deepEqual(agentPlists(a.owner), [`${label(a.owner)}.plist`])
      assert.match(r.out, new RegExp(`service note: renamed the launchd job "${OLD_LABEL}"`))
    } else {
      assert.deepEqual(a.state().active, [unit(a.owner)], 'one running unit, under the id of the real path')
      assert.deepEqual(a.state().enabled, [unit(a.owner)])
      assert.match(r.out, new RegExp(`service note: renamed the systemd unit "${OLD_UNIT}"`))
    }
    assert.doesNotMatch(r.out, /alone: it was installed from another HOME/)
    // Either spelling names the same service.
    const viaAlias = a.run(alias, ['status', '--assistant', ID]).out
    const viaReal = a.run(a.owner, ['status', '--assistant', ID]).out
    // macOS names the loaded job; on both, status names the agent's HOME-scoped tmux session.
    const named = (out: string) => (os === 'Darwin' ? /ai\.bgos\.agent\.42\.home-[0-9a-f]{8}(?= is loaded)/ : /hoai-42-home-[0-9a-f]{8}/).exec(out)?.[0]
    assert.equal(named(viaAlias), os === 'Darwin' ? label(a.owner) : `hoai-${ID}-home-${hid(a.owner)}`, viaAlias)
    assert.equal(named(viaReal), named(viaAlias), `${viaAlias}\n----\n${viaReal}`)
  })
}

test('round 2 L8: an uninstall whose own read-back cannot be read removes NOTHING and says so (exit 1); so does one with no runtime for the read-back', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  assert.equal(a.install(a.owner).status, 0)
  const runSh = join(a.owner, '.bgos-agent', ID, 'run.sh')
  a.setState((s) => {
    s.fail.push({ match: `launchctl print gui/${s.uid}/${label(a.owner)}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 99 })
  })
  const unreadable = a.run(a.owner, ['uninstall', '--assistant', ID])
  assert.notEqual(unreadable.status, 0)
  assert.match(unreadable.out, /refused: .* could not be read .* nothing was removed/)
  assert.ok(existsSync(runSh) && existsSync(plistPath(a.owner, label(a.owner))), 'nothing removed')
  assert.deepEqual(Object.keys(a.state().launchd), [label(a.owner)], 'and nothing stopped')
  a.setState((s) => {
    s.fail = []
  })
  const noHelper = a.run(a.owner, ['uninstall', '--assistant', ID], { HOAI_TEST_NO_HELPER: '1' })
  assert.notEqual(noHelper.status, 0)
  assert.match(noHelper.out, /nothing was removed/)
  assert.ok(existsSync(runSh) && existsSync(plistPath(a.owner, label(a.owner))))
})

test('round 2 L9: this HOME\'s old plist rewritten by plutil (key and value on their own lines) is still recognized as this HOME\'s and removed', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  const ownerOld = plistPath(a.owner, OLD_LABEL)
  mkdirSync(dirname(ownerOld), { recursive: true })
  writeFileSync(ownerOld, oldPlist(a.owner).replace(`    <key>HOME</key><string>${a.owner}</string>`, `\t\t<key>HOME</key>\n\t\t<string>${a.owner}</string>`))
  // The loaded ai.bgos.agent.42 is another HOME's: the owner's old plist is not part of any job.
  const rigOld = plistPath(a.scratch, OLD_LABEL)
  mkdirSync(dirname(rigOld), { recursive: true })
  writeFileSync(rigOld, oldPlist(a.scratch))
  a.setState((s) => {
    s.launchd[OLD_LABEL] = { plistPath: rigOld, content: oldPlist(a.scratch) }
  })
  const r = a.install(a.owner)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(agentPlists(a.owner), [`${label(a.owner)}.plist`], 'one plist of the agent at the next login')
})

test('round 2 L5: a rolled back rename puts the previous run.sh back (atomically replaced, never rewritten in place)', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Linux')
  t.after(a.cleanup)
  seedOldAgent(a, 'Linux')
  const runSh = join(a.owner, '.bgos-agent', ID, 'run.sh')
  mkdirSync(dirname(runSh), { recursive: true })
  const previous = '#!/usr/bin/env bash\n# 0.69.2 run.sh\nsock="hoai-$id"\n'
  writeFileSync(runSh, previous)
  a.setState((s) => {
    s.fail.push({ match: `systemctl --user start ${unit(a.owner)}`, code: 1, stderr: 'Job failed.', times: 1 })
  })
  a.setState((s) => {
    s.watch = runSh
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0)
  assert.equal(readFileSync(runSh, 'utf8'), previous, 'the old unit runs the run.sh it ran before')
  assert.equal(existsSync(`${runSh}.prev`), false)
  // Put back BEFORE the old unit is started again, so it never starts on the new one (review of round 2).
  const again = a.state().calls.find((c) => c.cmd === `systemctl --user enable --now ${OLD_UNIT}`)
  assert.ok(again, a.state().calls.map((c) => c.cmd).join('\n'))
  assert.equal(again!.watched, previous)
})

test('round 2 L6: a 0.69.2 tmux server orphaned on the old socket with its pane in this agent\'s folder is ended by the install (it would hold the new job\'s singleton wait for good); one elsewhere is left', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  const folder = join(a.owner, 'agents', 'ava')
  mkdirSync(folder, { recursive: true })
  a.setState((s) => {
    s.tmux.push(`hoai-${ID}`)
    s.panes = { [`hoai-${ID}`]: [folder] }
  })
  const r = a.install(a.owner)
  assert.equal(r.status, 0, r.out)
  assert.equal(a.state().tmux.includes(`hoai-${ID}`), false, 'the orphan in this agent\'s folder is ended')
  assert.match(r.out, /service note: ended an old tmux server/)
  // Only once the new job is loaded: an install typed into that orphan's session ends with it.
  const cmds = a.state().calls.map((c) => c.cmd)
  const killAt = cmds.indexOf(`tmux -L hoai-${ID} kill-server`)
  const inAt = cmds.findIndex((c) => c.startsWith('launchctl bootstrap') && c.endsWith(`${label(a.owner)}.plist`))
  assert.ok(inAt >= 0 && killAt > inAt, cmds.join('\n'))
  // A server on the old socket whose pane is another folder (another HOME's agent of this id) is left.
  const b = account('Darwin')
  t.after(b.cleanup)
  b.setState((s) => {
    s.tmux.push(`hoai-${ID}`)
    s.panes = { [`hoai-${ID}`]: [join(b.scratch, 'agents', 'ava')] }
  })
  assert.equal(b.install(b.owner).status, 0)
  assert.ok(b.state().tmux.includes(`hoai-${ID}`))
})

test('round 2 (review): an old job whose bootout is only slow, gone during the rollback, is loaded again on its own run.sh: never left with nothing loaded', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  const runSh = join(a.owner, '.bgos-agent', ID, 'run.sh')
  mkdirSync(dirname(runSh), { recursive: true })
  const previous = '#!/usr/bin/env bash\n# 0.69.2 run.sh\nsock="hoai-$id"\n'
  writeFileSync(runSh, previous)
  a.setState((s) => {
    // The bootout reports a failure and the job outlasts the rename's 40 checks; it goes only while the
    // rollback boots the new job out again (that label's second bootout; the first is before its bootstrap).
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.unloadWith = { line: `launchctl bootout gui/${s.uid}/${label(a.owner)}`, label: OLD_LABEL, skip: 1 }
    s.watch = runSh
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0)
  assert.match(r.out, new RegExp(`migration rolled back \\(the old job "${OLD_LABEL}" stays loaded, the new one is removed\\)`))
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL], 'the old job is loaded again')
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`])
  const again = a.state().calls.filter((c) => c.cmd.startsWith('launchctl bootstrap') && c.cmd.endsWith(`${OLD_LABEL}.plist`))
  assert.equal(again.length, 1, a.state().calls.map((c) => c.cmd).join('\n'))
  assert.equal(again[0].watched, previous, 'on the run.sh it ran before')
})

test('round 2 (verify): a launchctl print that FAILS after the old job\'s bootout (not rc 113, no such job) is unknown, never gone: the rename rolls back and the old job, its plist and its tmux server stay as they were', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    // The bootout does not unload it, and every later read of it fails (after the install's own read-back).
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.fail.push({ match: `launchctl print gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 99, skip: 1 })
  })
  const oldJob = JSON.stringify(a.state().launchd[OLD_LABEL])
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back \(the new one is removed\), but the old job "ai\.bgos\.agent\.42" could not be read back, so it may not be loaded: .*could not be read back after its bootout.*\(the old plist is back, so the next login starts the old job\)/)
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL], 'the new job booted out again; the old one as it was')
  assert.equal(JSON.stringify(a.state().launchd[OLD_LABEL]), oldJob)
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`], 'its plist back in its place, no new one')
  assert.ok(a.state().tmux.includes(`hoai-${ID}`), 'its session was not ended for a job that may still run')
})

test('round 2 (verify 3): an old job whose bootout launchd ACCEPTED, though it can no longer be read back, counts as gone: the rename completes, the new job loaded', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    // The bootout works (the fake unloads it), but every later read of the old label fails.
    s.fail.push({ match: `launchctl print gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 299, skip: 1 })
  })
  const r = a.install(a.owner)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(Object.keys(a.state().launchd), [label(a.owner)])
  assert.deepEqual(agentPlists(a.owner), [`${label(a.owner)}.plist`])
  assert.match(r.out, new RegExp(`service note: renamed the launchd job "${OLD_LABEL}"`))
})

test('round 2 (verify 3): an old job that went during the rollback but can no longer be read back is bootstrapped again from its own plist, on its own run.sh; launchd taking it counts as loaded', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  const runSh = join(a.owner, '.bgos-agent', ID, 'run.sh')
  mkdirSync(dirname(runSh), { recursive: true })
  const previous = '#!/usr/bin/env bash\n# 0.69.2 run.sh\nsock="hoai-$id"\n'
  writeFileSync(runSh, previous)
  a.setState((s) => {
    // Its bootout reports a failure; it goes only while the rollback boots the new job out again; no read of it answers.
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.fail.push({ match: `launchctl print gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 299, skip: 1 })
    s.unloadWith = { line: `launchctl bootout gui/${s.uid}/${label(a.owner)}`, label: OLD_LABEL, skip: 1 }
    s.watch = runSh
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back \(the old job "ai\.bgos\.agent\.42" stays loaded, the new one is removed\).*launchd took its plist again/)
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL], 'the old job is loaded again, the new one booted out')
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`])
  const again = a.state().calls.filter((c) => c.cmd.startsWith('launchctl bootstrap') && c.cmd.endsWith(`${OLD_LABEL}.plist`))
  assert.equal(again.length, 1, a.state().calls.map((c) => c.cmd).join('\n'))
  assert.equal(again[0].watched, previous, 'on the run.sh it ran before')
})

test('round 2 (verify 3): an unknown read of the old job does not end the rollback\'s watch of it', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  const printOld = `launchctl print gui/${a.state().uid}/${OLD_LABEL}`
  a.setState((s) => {
    // The old job will not go. One read of it fails: the first of the watch after the rollback
    // (after the install's read-back and the rename's 40 checks of it).
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.fail.push({ match: printOld, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 1, skip: 41 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back \(the old job "ai\.bgos\.agent\.42" stays loaded, the new one is removed\)/)
  const cmds = a.state().calls.map((c) => c.cmd)
  const failedAt = a.state().calls.findIndex((c) => c.cmd === printOld && c.code === 1)
  assert.ok(failedAt > 0, cmds.join('\n'))
  const readsAfter = cmds.slice(failedAt + 1).filter((c) => c === printOld).length
  assert.ok(readsAfter >= 30, `the watch went on after the unknown read: ${readsAfter} more reads`)
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL])
})

test('round 2 (verify 3): a rollback whose new job will not boot out (still listed) leaves both loaded, said with the bootout that ends it; the old job is never loaded again beside it', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${label(a.owner)}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back, but the new job .* could not be booted out again/)
  assert.match(r.out, new RegExp(`launchctl bootout gui/${a.state().uid}/${label(a.owner).replace(/\./g, '\\.')}`))
  assert.deepEqual(Object.keys(a.state().launchd).sort(), [OLD_LABEL, label(a.owner)].sort())
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`], 'only the old plist loads at the next login')
  assert.equal(a.state().calls.some((c) => c.cmd.startsWith('launchctl bootstrap') && c.cmd.endsWith(`${OLD_LABEL}.plist`)), false)
})

test('round 2 (verify 4): a bootout launchd ACCEPTED of an old job it still lists after the wait does not count as gone: the rename rolls back, the old job, its plist and its session kept', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    s.bootoutKeeps = [OLD_LABEL]
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back \(the old job "ai\.bgos\.agent\.42" stays loaded, the new one is removed\): the old job "ai\.bgos\.agent\.42" was still loaded after 40 checks/)
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL])
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`])
  assert.ok(a.state().tmux.includes(`hoai-${ID}`), 'its session was not ended')
})

test('round 2 (verify 4): a new job unreadable once after its bootstrap that then boots out and reads as gone is removed, the old job never touched', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    // Prints of the new label: the install's read-back and the wait before its bootstrap answer; the read-back after it fails once.
    s.fail.push({ match: `launchctl print gui/${s.uid}/${label(a.owner)}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 1, skip: 2 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back \(the old job "ai\.bgos\.agent\.42" stays loaded, the new one is removed\): the new job .* could not be read back after its bootstrap/)
  assert.deepEqual(Object.keys(a.state().launchd), [OLD_LABEL])
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`])
  assert.equal(a.state().calls.some((c) => c.cmd === `launchctl bootout gui/${a.state().uid}/${OLD_LABEL}`), false)
})

test('round 2 (verify 4): a new job unreadable once after its bootstrap that will not boot out and reads as listed is possibly loaded: both may be loaded, said', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    s.fail.push({ match: `launchctl print gui/${s.uid}/${label(a.owner)}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 1, skip: 2 })
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${label(a.owner)}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99, skip: 1 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back, but the new job .* could not be booted out again \(or read back\)/)
  assert.match(r.out, /the old plist is back, so the next login starts the old job/)
  assert.deepEqual(Object.keys(a.state().launchd).sort(), [OLD_LABEL, label(a.owner)].sort())
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`])
  assert.equal(a.state().calls.some((c) => c.cmd === `launchctl bootout gui/${a.state().uid}/${OLD_LABEL}`), false)
})

test('round 2 (verify 4): an old job that went during the rollback and whose plist launchd refuses is NOT loaded, said with what the next login finds', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    // Its bootout fails; it goes while the rollback boots the new job out; every bootstrap of its plist is refused.
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.unloadWith = { line: `launchctl bootout gui/${s.uid}/${label(a.owner)}`, label: OLD_LABEL, skip: 1 }
    s.fail.push({ match: `${OLD_LABEL}.plist`, code: 5, stderr: 'Bootstrap failed: 5: Input/output error', times: 99 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back, but the old job "ai\.bgos\.agent\.42" is not loaded: .*could not be loaded again after 5 tries \(the old plist is back, so the next login starts the old job\)/)
  assert.deepEqual(Object.keys(a.state().launchd), [], 'nothing loaded, as said')
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`])
})

test('round 2 (verify 5): the reload decides on its latest reads: a plist launchd took that is gone again, then refused, then unreadable, is "may not be loaded" after 5 tries, never "stays loaded"', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  const uid = a.state().uid
  const oldPlist = plistPath(a.owner, OLD_LABEL)
  a.setState((s) => {
    // The old job will not go at its bootout (still listed for the 40 checks), then goes while the
    // rollback boots the new job out. The reload's first bootstrap is taken and undone at once; every
    // later one is refused. Reads of it: the install's read-back, the 40 checks, the watch's one, the
    // reload's first two answer; every later one fails.
    s.fail.push({ match: `launchctl bootout gui/${uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.unloadWith = [
      { line: `launchctl bootout gui/${uid}/${label(a.owner)}`, label: OLD_LABEL, skip: 1 },
      { line: `launchctl bootstrap gui/${uid} ${oldPlist}`, label: OLD_LABEL, skip: 0 },
    ]
    s.fail.push({ match: `launchctl bootstrap gui/${uid} ${oldPlist}`, exact: true, code: 5, stderr: 'Bootstrap failed: 5: Input/output error', times: 99, skip: 1 })
    s.fail.push({ match: `launchctl print gui/${uid}/${OLD_LABEL}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 299, skip: 44 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /could not be read back, so it may not be loaded: .*a bootstrap of its plist was tried 5 times/)
  assert.doesNotMatch(r.out, /stays loaded/)
  assert.equal(a.state().calls.filter((c) => c.cmd === `launchctl bootstrap gui/${uid} ${oldPlist}`).length, 5)
})

test('round 2 (verify 4): a rollback with no old plist on disk says so: no plist of the old job is left, run install again', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  // The old job is loaded, but its plist was removed from disk (the loaded job keeps its record).
  rmSync(plistPath(a.owner, OLD_LABEL))
  a.setState((s) => {
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.fail.push({ match: `launchctl print gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 299, skip: 1 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /no plist of the old job is left, so run hoai-agent install again/)
  assert.deepEqual(agentPlists(a.owner), [])
})

test('round 2 (verify 3): a new job that cannot be read back after its bootstrap and will not boot out counts as possibly loaded: both may be loaded, said, and the old job is never booted out', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    // Prints of the new label: the install's read-back and the wait before its bootstrap answer; every later one fails.
    s.fail.push({ match: `launchctl print gui/${s.uid}/${label(a.owner)}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 299, skip: 2 })
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${label(a.owner)}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99, skip: 1 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back, but the new job .* could not be booted out again \(or read back\)/)
  assert.deepEqual(Object.keys(a.state().launchd).sort(), [OLD_LABEL, label(a.owner)].sort())
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`])
  assert.equal(a.state().calls.some((c) => c.cmd === `launchctl bootout gui/${a.state().uid}/${OLD_LABEL}`), false, 'the old job was never booted out')
})

test('round 2 (verify 2): a rollback whose new job cannot be booted out nor read back counts it as possibly loaded: both may be loaded, said, and the old job is never loaded again beside it', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    // The old job will not go; the new one will not go either, and after the rollback's bootout it cannot be
    // read (prints of the new label: the install's read-back, the wait before its bootstrap, its read-back).
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${label(a.owner)}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.fail.push({ match: `launchctl print gui/${s.uid}/${label(a.owner)}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 299, skip: 3 })
  })
  const r = a.install(a.owner)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /migration rolled back, but the new job .* could not be booted out again/)
  // It says how to end it: until then both jobs share one run.sh and end each other's session in turn.
  assert.match(r.out, new RegExp(`launchctl bootout gui/${a.state().uid}/${label(a.owner).replace(/\./g, '\\.')}`))
  assert.deepEqual(Object.keys(a.state().launchd).sort(), [OLD_LABEL, label(a.owner)].sort(), 'both, as said')
  assert.deepEqual(agentPlists(a.owner), [`${OLD_LABEL}.plist`], 'only the old plist loads at the next login')
  assert.equal(a.state().calls.some((c) => c.cmd.startsWith('launchctl bootstrap') && c.cmd.endsWith(`${OLD_LABEL}.plist`)), false, 'the old job never loaded again beside it')
})

test('round 2 (verify 2): a launchctl print that says "Could not find service" is not listed whatever its rc, as #237\'s reader reads it: the rename goes through', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  a.setState((s) => {
    // The bootout reports a failure but the job goes (only the answer's text can say so: launchd did not
    // accept the bootout), and every later read of it answers rc 3 with "Could not find service".
    s.fail.push({ match: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 5, stderr: 'Boot-out failed: 5: Input/output error', times: 99 })
    s.unloadWith = { line: `launchctl bootout gui/${s.uid}/${OLD_LABEL}`, label: OLD_LABEL, skip: 0 }
    s.fail.push({ match: `launchctl print gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 3, stderr: `Bad request.\nCould not find service "${OLD_LABEL}" in domain for user gui: ${s.uid}`, times: 299, skip: 1 })
  })
  const r = a.install(a.owner)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(Object.keys(a.state().launchd), [label(a.owner)])
  assert.deepEqual(agentPlists(a.owner), [`${label(a.owner)}.plist`])
})

test('round 2 (review): an uninstall whose OLD job cannot be read back, with this HOME\'s old plist there, removes nothing (that job may be running)', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Darwin')
  t.after(a.cleanup)
  seedOldAgent(a, 'Darwin')
  const runSh = join(a.owner, '.bgos-agent', ID, 'run.sh')
  mkdirSync(dirname(runSh), { recursive: true })
  writeFileSync(runSh, 'x')
  a.setState((s) => {
    s.fail.push({ match: `launchctl print gui/${s.uid}/${OLD_LABEL}`, exact: true, code: 1, stderr: 'launchctl: XPC error', times: 99 })
  })
  const before = JSON.stringify(a.state().launchd)
  const r = a.run(a.owner, ['uninstall', '--assistant', ID])
  assert.notEqual(r.status, 0)
  assert.match(r.out, /refused: agent 42's old service could not be read back .* nothing was removed/)
  assert.ok(existsSync(runSh) && existsSync(plistPath(a.owner, OLD_LABEL)), 'nothing removed')
  assert.equal(JSON.stringify(a.state().launchd), before, 'and nothing stopped')
})

test('round 2 L11: a rename drop-in an interrupted swap left behind is removed by the next install', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Linux')
  t.after(a.cleanup)
  assert.equal(a.install(a.owner).status, 0)
  const dropIn = join(dirname(unitPath(a.owner, unit(a.owner))), `${unit(a.owner)}.service.d`, 'hoai-rename.conf')
  mkdirSync(dirname(dropIn), { recursive: true })
  writeFileSync(dropIn, `[Unit]\nConflicts=${OLD_UNIT}.service\nAfter=${OLD_UNIT}.service\n`)
  assert.equal(a.install(a.owner).status, 0)
  assert.equal(existsSync(dropIn), false)
})

test('round 2: on Linux an install from a HOME that is not the user manager\'s is refused by name before its service file or run.sh is written (the manager never reads that HOME\'s unit folder)', SLOW, (t) => {
  if (!ready(t)) return
  const a = account('Linux')
  t.after(a.cleanup)
  const r = a.install(a.scratch)
  assert.notEqual(r.status, 0)
  assert.match(r.out, /refused: this account's systemd --user manager reads its units from .*home\/kc.*, not from this HOME/)
  assert.equal(existsSync(join(a.scratch, '.bgos-agent', ID, 'run.sh')), false)
  assert.equal(existsSync(unitPath(a.scratch, unit(a.scratch))), false)
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
  assert.match(listing, new RegExp(`${OLD_LABEL.replace(/\./g, '\\.')}\\s+\\(old name, before 0\\.69\\.5`))
})
