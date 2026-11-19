#!/usr/bin/env node
/**
 * The idle update rig, Linux: a staged build that dies at import (Data's review of #291, follow up 1; board row
 * 5a455021). The real chain, scratch everything:
 *
 *   tmux (a private socket of its own)
 *     node <cache>/0.81.0/bin/hoai-core.mjs --keep-alive  (the real launcher, from the build that runs)
 *     expect (hoai's own dev channels gate)
 *       claude                                           (stand-in-claude.ts under bun; only the rig PATH has it)
 *         node bin/bgos-launch.mjs server.ts -> bun     (the real daemon, from a marketplace-style install)
 *
 * against stub-backend.mjs on 127.0.0.1 (43000 to 48999), in a scratch HOME under --run-dir. Nothing is installed
 * for real: no service, no watcher, no scheduled job (the crontab and the user's systemd units and timers are listed
 * before and after, and must be identical). Every process of the run is ended by exact pid at the end: those whose
 * environment names the scratch HOME, or whose command line names the run folder.
 *
 * The scenario. 0.81.0 boots and goes live. 0.81.1 is staged (installed_plugins.json names it), and it throws at
 * import: its lib/pairing-lock.ts, which only the daemon loads, starts with a throw. The rig then writes what the
 * 0.81.0 daemon's own idle update writes when it asks (lib/idle-update.mjs act: the lease, canary-1, the record in
 * `requested`), and the restart marker its ladder's own launcher rung writes. On Linux the idle update itself does
 * not ask here: its unattended proof needs a service or the supervised expect gate, which this rig does not install;
 * the Windows rig (rig.mjs) proves the ask. What this one proves is what follows the ask.
 *
 * hoai relaunches claude onto 0.81.1, whose daemon dies at import, so no channel heartbeat comes and the record stays
 * `requested`. Then, within one supervisor cycle (hoai's channel heartbeat check, 3 min after the launch):
 *   before the fix: hoai relaunches onto 0.81.1 again; the install stays on it, nothing is held (RIG FAIL);
 *   after it: the install is back on 0.81.0, 0.81.1 is held bad, and the relaunch comes back on 0.81.0 in the same
 *   session, whose daemon reports the rollback once (RIG PASS).
 *
 * usage (Linux node >= 22, bun on PATH, expect and tmux installed; from the plugin root):
 *   node docs/idle-update/rig/import-death.mjs --run-dir <an empty or new folder outside ~/.claude and ~/.bgos-agent>
 * Prints RIG PASS import-death or RIG FAIL import-death: <why>, and writes <run dir>/result.json.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, mkdtempSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RIG_SRC = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(RIG_SRC, '..', '..', '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : null
}
const FROM = '0.81.0'
const TARGET = '0.81.1'
const ID = '7400001'
const SEC = 1000
const MIN = 60 * SEC
/** hoai's channel heartbeat check (bin/hoai-core.mjs CHANNEL_HEARTBEAT_WAIT_MS): the supervisor cycle. */
const CYCLE_MS = 3 * MIN

let started = false
function die(why) {
  if (started) throw new Error(why)
  console.error(`RIG FAIL import-death: ${why}`)
  process.exit(1)
}
if (process.platform !== 'linux') die('this rig runs on Linux (it finds its processes through /proc)')
const runArg = flag('--run-dir')
if (!runArg) die('--run-dir is required')
const runDir = resolve(runArg)
const realHome = homedir()
for (const real of [join(realHome, '.claude'), join(realHome, '.bgos-agent'), join(realHome, '.bgos-plugin-state')]) {
  if (runDir === real || runDir.startsWith(`${real}/`)) die(`--run-dir is inside ${real}`)
}
if (existsSync(runDir) && readdirSync(runDir).length > 0) die('--run-dir must be empty or new')
for (const tool of ['bun', 'expect', 'tmux']) if (spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0) die(`${tool} is not on PATH`)

const dir = runDir
const home = join(dir, 'home')
const tmp = join(dir, 'tmp')
const binDir = join(dir, 'bin')
const configDir = join(home, '.claude')
const cacheRoot = join(configDir, 'plugins', 'cache', 'hoai', 'hoai')
const machineDir = join(home, '.bgos-agent')
const stateDir = join(machineDir, ID)
const idleDir = join(machineDir, 'idle-update')
const cwd = join(home, 'agents', ID)
for (const d of [tmp, binDir, cacheRoot, stateDir, cwd]) mkdirSync(d, { recursive: true })
const progressPath = join(dir, 'progress.log')
const say = (line) => {
  const text = `[rig ${new Date().toISOString().slice(11, 19)}] ${line}`
  console.log(text)
  appendFileSync(progressPath, `${text}\n`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// -- Files ---------------------------------------------------------------------------------------

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
function jsonLines(path) {
  return readText(path)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

/** A marketplace-style copy of this plugin at <cache>/<version>, its dependencies linked, never installed. */
function build(version, { diesAtImport = false } = {}) {
  const dest = join(cacheRoot, version)
  if (existsSync(dest)) die(`build ${version} already exists`)
  const skip = new Set(['.git', 'test', 'docs', 'node_modules'].map((n) => join(PLUGIN, n)))
  cpSync(PLUGIN, dest, { recursive: true, filter: (src) => !skip.has(src) && !/\/(REPORT|BRIEF)[^/]*\.md$/.test(src) })
  symlinkSync(join(PLUGIN, 'node_modules'), join(dest, 'node_modules'))
  for (const rel of ['package.json', join('.claude-plugin', 'plugin.json')]) {
    const path = join(dest, rel)
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version }, null, 2)}\n`)
  }
  if (diesAtImport) {
    // Only the daemon loads it (TypeScript, which hoai's node never imports), so the launcher of this build is fine.
    const path = join(dest, 'lib', 'pairing-lock.ts')
    writeFileSync(path, `throw new Error('RIG: this build dies at import')\n${readFileSync(path, 'utf8')}`)
  }
  return dest
}
const pluginsPath = join(configDir, 'plugins', 'installed_plugins.json')
function install(version) {
  const at = new Date().toISOString()
  writeJsonAtomic(pluginsPath, { version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath: join(cacheRoot, version), version, installedAt: at, lastUpdated: at, gitCommitSha: 'rig' }] } })
}
const installedVersion = () => readJson(pluginsPath)?.plugins?.['hoai@hoai']?.[0]?.version ?? null
const record = () => readJson(join(stateDir, 'idle-update.json'))

// -- The stand-in claude, and a PATH that finds only it ------------------------------------------

function rigPath() {
  const standIn = join(binDir, 'stand-in-claude.ts')
  cpSync(join(RIG_SRC, 'stand-in-claude.ts'), standIn)
  const bun = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(join(binDir, 'claude'), `#!/bin/sh\nexec "${bun}" "${standIn}" "$@"\n`)
  chmodSync(join(binDir, 'claude'), 0o755)
  symlinkSync(process.execPath, join(binDir, 'node'))
  symlinkSync(bun, join(binDir, 'bun'))
  const dirs = [binDir, '/usr/bin', '/bin']
  for (const d of dirs.slice(1)) if (existsSync(join(d, 'claude'))) die(`${join(d, 'claude')} is on the rig PATH: only the stand-in may be`)
  return dirs.join(':')
}

let PATH_RIG = ''
/**
 * The rig's own tmux socket: never a session of the person's. In a short folder of its own under the system temp
 * folder, since a socket path is capped at 108 bytes and a run folder can be longer; removed at the end.
 */
const tmuxDir = mkdtempSync(join(tmpdir(), 'hoai-rig-'))
const TMUX_SOCKET = join(tmuxDir, 's')
function agentEnv() {
  return {
    PATH: PATH_RIG,
    HOME: home,
    USER: process.env.USER ?? 'rig',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: tmp,
    HOAI_RIG_DIR: dir,
    HOAI_BROWSER_HOST: 'off',
  }
}

// -- Processes: ours by the scratch HOME or the run folder, ended by exact pid ------------------

function ours() {
  const found = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    let env = ''
    let cmd = ''
    try {
      env = readFileSync(`/proc/${name}/environ`, 'latin1')
      cmd = readFileSync(`/proc/${name}/cmdline`, 'latin1').replace(/\0/g, ' ')
    } catch {
      continue
    }
    if (env.split('\0').includes(`HOME=${home}`) || cmd.includes(dir)) found.push({ pid: Number(name), cmd: cmd.trim().slice(0, 160) })
  }
  return found
}
async function teardown() {
  say('teardown: ending the rig tmux server, then every process of this run, each by exact pid')
  spawnSync('tmux', ['-S', TMUX_SOCKET, 'kill-server'], { env: agentEnv() })
  await sleep(2 * SEC)
  for (let round = 0; round < 6; round++) {
    const left = ours()
    if (left.length === 0) {
      say('teardown: nothing of ours is alive')
      return []
    }
    for (const p of left) {
      try {
        process.kill(p.pid, round < 3 ? 'SIGTERM' : 'SIGKILL')
      } catch {}
    }
    await sleep(2 * SEC)
  }
  return ours().map((p) => `${p.pid} ${p.cmd}`)
}

/** Scheduled work for this user: crontab, and the user's systemd unit files and timers. */
function scheduled(label) {
  const run = (cmd) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }).stdout ?? ''
  const text = [
    '# crontab -l',
    run('crontab -l 2>&1'),
    '# systemctl --user list-unit-files (not transient)',
    run("systemctl --user list-unit-files --no-pager --no-legend 2>&1 | awk '$2 != \"transient\"'"),
    '# systemctl --user list-timers --all (names)',
    run("systemctl --user list-timers --all --no-pager --no-legend 2>&1 | grep -o '[^ ]*\\.timer' | sort"),
  ].join('\n')
  writeFileSync(join(dir, `scheduled-${label}.txt`), text)
  return text
}

// -- The stub backend ----------------------------------------------------------------------------

let port = 0
async function startStub() {
  for (let i = 0; i < 10; i++) {
    const candidate = 43000 + Math.floor(Math.random() * 6000)
    const child = spawn(process.execPath, [join(RIG_SRC, 'stub-backend.mjs'), '--port', String(candidate), '--dir', dir], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...agentEnv(), PATH: process.env.PATH ?? '' } })
    const exited = new Promise((r) => child.on('exit', (code) => r(code)))
    for (let t = 0; t < 50; t++) {
      const ready = readJson(join(dir, 'stub-ready.json'))
      if (ready?.pid === child.pid && ready?.port === candidate) {
        port = candidate
        say(`stub on 127.0.0.1:${port} pid ${child.pid}`)
        return
      }
      if ((await Promise.race([exited, sleep(100).then(() => 'running')])) !== 'running') break
    }
    child.kill()
  }
  die('the stub backend did not start')
}

// -- What happened -------------------------------------------------------------------------------

const launches = () => jsonLines(join(cwd, '.rig', 'launches.jsonl'))
const sessionLaunches = () => launches().filter((l) => l.mode)
const heartbeats = () => jsonLines(join(dir, 'stub-requests.jsonl')).filter((r) => r.path === 'integrations/heartbeat' && r.assistantId === ID)
const versionBeats = () => heartbeats().filter((h) => typeof h.body?.daemonVersion === 'string')
const daemonLog = () => readText(join(machineDir, 'logs', `bgos-plugin-${ID}.log`))
const hoaiLog = () => readText(join(dir, 'hoai.log'))

async function watch(label, done, { timeoutMs, everyMs = 3 * SEC }) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const verdict = await done()
    if (verdict) return verdict
    if (Date.now() > until) return null
    await sleep(everyMs)
  }
}

const results = { scenario: 'import-death', from: FROM, target: TARGET, dir, checks: [], timeline: {} }
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: Boolean(ok), detail })
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

async function scenario() {
  writeFileSync(join(cwd, '.bgos-agent-id'), `${ID}\n`)
  writeJsonAtomic(join(machineDir, `credentials-${ID}.json`), {
    backendUrl: `http://127.0.0.1:${port}`,
    pairingToken: `rig-token-${ID}`,
    pairingId: `rig-${ID}`,
    userId: '1',
    assistantId: ID,
    pairedAt: new Date().toISOString(),
    homeDir: cwd,
    homeSource: 'pin',
  })
  // In its own tmux session on a private socket, as the gen-2 service runs it: hoai's expect gate hands claude a
  // terminal (interact), which reads EOF at once on /dev/null.
  const hoaiOut = join(dir, 'hoai.log')
  const command = `exec "${process.execPath}" "${join(cacheRoot, FROM, 'bin', 'hoai-core.mjs')}" --keep-alive 2>&1 | tee -a "${hoaiOut}"`
  const tmux = spawnSync('tmux', ['-S', TMUX_SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'rig', '-x', '200', '-y', '50', '-c', cwd, command], { env: agentEnv(), encoding: 'utf8' })
  if (tmux.status !== 0) throw new Error(`tmux new-session failed: ${tmux.stderr}`)
  const hoai = { pid: Number(spawnSync('tmux', ['-S', TMUX_SOCKET, 'list-panes', '-t', 'rig', '-F', '#{pane_pid}'], { env: agentEnv(), encoding: 'utf8' }).stdout.trim()) }
  say(`hoai ${FROM} started, pid ${hoai.pid}`)

  const live = await watch(`${FROM} live`, () => versionBeats().some((h) => h.body.daemonVersion === FROM) && daemonLog().includes('idle update: '), { timeoutMs: 6 * MIN })
  if (!live) throw new Error(`${FROM} never went live: ${launches().slice(-3).map((l) => JSON.stringify(l)).join(' ')}`)
  const first = sessionLaunches()[0]
  say(`${FROM} is live: session ${first?.sessionId}`)
  await sleep(10 * SEC)

  build(TARGET, { diesAtImport: true })
  install(TARGET)
  say(`staged ${TARGET}, which dies at import: installed_plugins.json now names it`)

  // What the old daemon's idle update writes when it asks (lib/idle-update.mjs act), then its ladder's own launcher
  // rung (lib/update-rpc.ts restartForStagedUpdate): the lease, the canary, the record, the marker.
  const nonce = randomUUID()
  const askedAt = new Date().toISOString()
  mkdirSync(join(idleDir, TARGET), { recursive: true })
  writeFileSync(join(idleDir, 'lease.json'), `${JSON.stringify({ assistantId: ID, target: TARGET, nonce, at: askedAt })}\n`, { flag: 'wx' })
  writeFileSync(join(idleDir, TARGET, 'canary-1'), `${JSON.stringify({ assistantId: ID, at: askedAt })}\n`, { flag: 'wx' })
  writeJsonAtomic(join(stateDir, 'idle-update.json'), {
    schema: 1,
    target: TARGET,
    from: FROM,
    fromRoot: join(cacheRoot, FROM),
    fromCommit: null,
    installMethod: 'marketplace',
    pin: first?.sessionId ?? null,
    pinBefore: null,
    nonce,
    canaryN: 1,
    state: 'requested',
    attempts: [{ at: askedAt, outcome: 'requested' }],
    lockBoots: 0,
    arrivedAt: null,
    validatedAt: null,
    contextLost: false,
    reportedAt: null,
  })
  writeFileSync(join(stateDir, 'restart-requested.json'), `${JSON.stringify({ at: askedAt, by: 'rig', target: TARGET })}\n`)
  results.timeline.askedAt = askedAt
  say(`asked: record requested, lease and canary-1 for ${ID}, restart marker for hoai`)

  const onTarget = await watch(`a launch onto ${TARGET}`, () => sessionLaunches().find((l) => l.pluginVersion === TARGET), { timeoutMs: 2 * MIN, everyMs: SEC })
  if (!onTarget) throw new Error(`hoai never relaunched onto ${TARGET}`)
  results.timeline.targetLaunchAt = onTarget.at
  say(`hoai relaunched claude onto ${TARGET} at ${onTarget.at}; waiting one supervisor cycle (${CYCLE_MS / MIN} min) and a minute`)
  const cycleEnd = Date.parse(onTarget.at) + CYCLE_MS + MIN
  await watch('one supervisor cycle', () => Date.now() >= cycleEnd, { timeoutMs: CYCLE_MS + 2 * MIN, everyMs: 5 * SEC })

  const atCycle = { installed: installedVersion(), record: record()?.state ?? null, bad: existsSync(join(idleDir, TARGET, 'bad')) }
  results.timeline.atCycle = atCycle
  say(`after one supervisor cycle: install ${atCycle.installed}, record ${atCycle.record}, ${TARGET} held ${atCycle.bad}`)
  if (atCycle.installed === FROM) {
    await watch(`${FROM} back and reporting`, () => versionBeats().some((h) => h.body.daemonVersion === FROM && Date.parse(h.at ?? '') > Date.parse(onTarget.at) && h.body.lastError?.code === 'idle_update_rolled_back'), { timeoutMs: 4 * MIN })
    await sleep(20 * SEC)
  }

  const after = sessionLaunches().filter((l) => Date.parse(l.at) > Date.parse(onTarget.at))
  const deaths = launches().filter((l) => l.mcpExit !== undefined && l.mcpExit !== null && l.mcpExit !== 0)
  const stderr = readText(join(cwd, '.rig', 'mcp-stderr.log'))
  const beatsAfter = versionBeats().filter((h) => Date.parse(h.at ?? '') > Date.parse(onTarget.at))
  const said = daemonLog().split('\n').filter((l) => l.includes(`after rolling ${TARGET} back`))
  const hoaiSaid = hoaiLog().split('\n').filter((l) => l.includes('never reported in'))
  results.observed = {
    launches: sessionLaunches().map((l) => ({ at: l.at, mode: l.mode, sessionId: l.sessionId, version: l.pluginVersion })),
    deaths: deaths.length,
    beatsAfter: beatsAfter.map((h) => ({ at: h.at, version: h.body.daemonVersion, lastError: h.body.lastError?.code ?? null })).slice(-5),
    daemonSaid: said,
    hoaiSaid,
    record: record(),
    bad: readJson(join(idleDir, TARGET, 'bad')),
    settings: readJson(join(configDir, 'settings.json'))?.extraKnownMarketplaces ?? null,
  }

  check(`the restart launched ${TARGET}, and its daemon died at import`, onTarget && deaths.length >= 1 && stderr.includes('RIG: this build dies at import'), { deaths: deaths.length })
  check(`within one supervisor cycle the install is back on ${FROM}`, atCycle.installed === FROM, atCycle.installed)
  check(`within one supervisor cycle ${TARGET} is held bad on this computer`, atCycle.bad, readJson(join(idleDir, TARGET, 'bad')))
  check('the record says rolled_back', record()?.state === 'rolled_back', record()?.state ?? null)
  check(`the relaunch came back on ${FROM}, in the same session`, after.length >= 1 && after[0].pluginVersion === FROM && after[0].sessionId === first?.sessionId, after.map((l) => [l.pluginVersion, l.sessionId]))
  check(`${TARGET} was launched once, never again: no loop`, sessionLaunches().filter((l) => l.pluginVersion === TARGET).length === 1, sessionLaunches().map((l) => l.pluginVersion))
  check('one report line: the old build reports the rollback once', said.length === 1 && beatsAfter.at(-1)?.body?.lastError?.code === 'idle_update_rolled_back', { said, lastError: beatsAfter.at(-1)?.body?.lastError ?? null })
  check("Claude Code's own update for the marketplace is off, so nothing reinstalls the build", readJson(join(configDir, 'settings.json'))?.extraKnownMarketplaces?.hoai?.autoUpdate === false, results.observed.settings)
}

// -- Run -----------------------------------------------------------------------------------------

say(`import-death, dir ${dir}`)
const before = scheduled('before')
let failure = null
let leftAlive = []
started = true
try {
  PATH_RIG = rigPath()
  build(FROM)
  install(FROM)
  writeJsonAtomic(join(configDir, 'settings.json'), { extraKnownMarketplaces: { hoai: { source: { source: 'github', repo: 'BrandGrowthOS/bgos-claude-plugin' }, autoUpdate: true } } })
  await startStub()
  await scenario()
} catch (err) {
  failure = String(err?.message ?? err)
  say(`error: ${failure}`)
} finally {
  leftAlive = await teardown()
}
const after = scheduled('after')
check('scheduled work identical before and after', before === after)
check('no process of ours left alive', leftAlive.length === 0, leftAlive)
results.failure = failure
writeFileSync(join(dir, 'result.json'), `${JSON.stringify(results, null, 2)}\n`)
const failed = results.checks.filter((c) => !c.ok).map((c) => c.name)
if (failure || failed.length) {
  console.log(`RIG FAIL import-death: ${failure ?? failed.join('; ')}`)
  process.exit(1)
}
console.log(`RIG PASS import-death (${results.checks.length} checks)`)
