#!/usr/bin/env node
/**
 * The idle update rig (Windows). Real chain, scratch everything:
 *
 *   wscript //B <scratch HOME>\.bgos-agent\<id>\run-agent.vbs   (text from lib/agent-task-win32.mjs agentTaskSpec)
 *     node <cache>\<version>\bin\hoai-core.mjs --keep-alive       (the real launcher)
 *       claude.exe                                                (stand-in-claude.ts, compiled; only on the rig PATH)
 *         node bin\bgos-launch.mjs server.ts -> bun server.ts       (the real daemon, from a marketplace-style install)
 *
 * against stub-backend.mjs on 127.0.0.1 (43000 to 48999). No scheduled task is
 * created (the vbs is started by this script, never registered), the watcher
 * is never installed, and every process is ended by its exact pid, checked
 * against its creation time; never by image name. Scheduled tasks are listed
 * before and after each scenario and must be identical.
 *
 * usage (Windows node, from the plugin root):
 *   node docs/idle-update/rig/rig.mjs --run-dir E:\...\rig-run --scenario idle|busy|broken|stagger [--scale 5] [--agents 15]
 *   busy takes [--cases turn,owed,...] (the idle control always runs): about 0.9 GB per agent, so a run stays under the cap.
 * Prints RIG PASS <scenario> or RIG FAIL <scenario>: <why>, and writes <scenario dir>\result.json.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RIG_SRC = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(RIG_SRC, '..', '..', '..')
const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}
const scenario = flag('--scenario')
const runDir = flag('--run-dir')
const scale = Number(flag('--scale', '5'))
const agentCount = Number(flag('--agents', '15'))
const MEMORY_CAP = 3.8 * 1024 ** 3
const FROM = '0.81.0'
const TARGET = '0.81.1'

/** Once the run has started anything, a failure throws, so the teardown in its finally still ends every process. */
let started = false
function die(why) {
  if (started) throw new Error(why)
  console.error(`RIG FAIL ${scenario ?? '?'}: ${why}`)
  process.exit(1)
}
if (process.platform !== 'win32') die('the rig runs on Windows node')
if (!['idle', 'busy', 'broken', 'stagger', 'wake'].includes(scenario ?? '')) die('--scenario idle|busy|broken|stagger|wake')
if (!runDir || !/^[D-Zd-z]:\\/.test(runDir)) die('--run-dir must be an absolute path on a drive other than C:')
if (!Number.isFinite(scale) || scale < 1 || scale > 10) die('--scale must be 1..10 (the beacon lands about every 10 s; 2 min / scale must stay above it)')
const realProfile = (process.env.USERPROFILE ?? '').toLowerCase()
if (realProfile && resolve(runDir).toLowerCase().startsWith(realProfile)) die('--run-dir is inside the real profile')

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
const dir = join(runDir, `${scenario}-${stamp}`)
const home = join(dir, 'home')
const tmp = join(dir, 'tmp')
const configDir = join(home, '.claude')
const cacheRoot = join(configDir, 'plugins', 'cache', 'hoai', 'hoai')
const machineDir = join(home, '.bgos-agent')
mkdirSync(tmp, { recursive: true })
mkdirSync(machineDir, { recursive: true })
const progressPath = join(dir, 'progress.log')
const say = (line) => {
  const text = `[rig ${new Date().toISOString().slice(11, 19)}] ${line}`
  console.log(text)
  appendFileSync(progressPath, `${text}\n`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SEC = 1000
const MIN = 60 * SEC

// -- Processes: listed, owned, ended by exact pid ------------------------------------------------

const LIST_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; ' +
  'c = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }); ' +
  'n = $_.Name; ws = $_.WorkingSetSize; pb = $_.PrivatePageCount; cmd = $_.CommandLine } } | ConvertTo-Json -Compress'
function listProcesses() {
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60 * SEC }, (err, stdout) => {
      if (err) return done(null)
      try {
        const rows = JSON.parse(stdout)
        done(Array.isArray(rows) ? rows : [rows])
      } catch {
        done(null)
      }
    })
  })
}

/** Every process this run started, directly or below one it started: pid -> {c, n, cmd}. */
const owned = new Map()
const roots = new Map()
/**
 * A root is a process this run just started. Its creation time must not be older than the moment before the start
 * (with a second of slack for the clock's grain): a root that died at once can have its pid handed to a process
 * this run never started, and that one is never adopted.
 */
function addRoot(pid, label, startedAtMs) {
  roots.set(pid, { label, floor: startedAtMs - SEC })
}
/** Walk down from the roots; a child must be younger than its parent (pid reuse). */
function adopt(rows) {
  const byParent = new Map()
  for (const r of rows) {
    if (!byParent.has(r.pp)) byParent.set(r.pp, [])
    byParent.get(r.pp).push(r)
  }
  const byPid = new Map(rows.map((r) => [r.p, r]))
  const queue = []
  for (const [pid, root] of roots) {
    const row = byPid.get(pid)
    if (row && (owned.has(pid) ? owned.get(pid).c === row.c : row.c >= root.floor)) {
      owned.set(pid, { c: row.c, n: row.n, cmd: row.cmd })
      queue.push(row)
    }
  }
  for (const [pid, info] of owned) {
    const row = byPid.get(pid)
    if (row && row.c === info.c) queue.push(row)
  }
  const seen = new Set()
  while (queue.length) {
    const parent = queue.shift()
    if (seen.has(parent.p)) continue
    seen.add(parent.p)
    for (const child of byParent.get(parent.p) ?? []) {
      if (child.c < parent.c) continue
      if (!owned.has(child.p) || owned.get(child.p).c !== child.c) owned.set(child.p, { c: child.c, n: child.n, cmd: child.cmd })
      queue.push(child)
    }
  }
  // Two sums: the working set counts the pages bun and node share once per process, so it overstates; private
  // bytes are what the rig really commits, and the cap applies to them. Both are reported.
  let ws = 0
  let pb = 0
  const byName = {}
  for (const [pid, info] of owned) {
    const row = byPid.get(pid)
    if (row && row.c === info.c) {
      ws += Number(row.ws ?? 0)
      pb += Number(row.pb ?? 0)
      const name = String(row.n ?? '?').toLowerCase()
      byName[name] ??= { count: 0, privateMB: 0 }
      byName[name].count += 1
      byName[name].privateMB += Math.round(Number(row.pb ?? 0) / 1024 ** 2)
    }
  }
  return { ws, pb, byName }
}
function aliveOwned(rows) {
  const byPid = new Map(rows.map((r) => [r.p, r]))
  return [...owned].filter(([pid, info]) => byPid.get(pid)?.c === info.c).map(([pid, info]) => ({ pid, ...info }))
}
/**
 * End each process by its pid only if it is still the process this run adopted: the creation time is read and the
 * kill is made through one handle, so a pid freed and handed to another process in between is never ended.
 * @param {Array<{ pid: number, c: number }>} list
 */
function killExact(list) {
  const pairs = list.filter((p) => Number.isInteger(p.pid) && Number.isFinite(p.c)).map((p) => `${p.pid}:${Math.round(p.c)}`)
  if (pairs.length === 0) return
  const script =
    `foreach ($pair in '${pairs.join(',')}'.Split(',')) { $id, $c = $pair.Split(':'); ` +
    'try { $p = Get-Process -Id ([int]$id) -ErrorAction Stop; ' +
    '$ms = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds(); ' +
    'if ([math]::Abs($ms - [int64]$c) -le 100) { $p.Kill() } } catch {} }'
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60 * SEC })
}

// -- Scheduled tasks, before and after -----------------------------------------------------------

const TASKS_SCRIPT =
  "Get-ScheduledTask | Sort-Object TaskPath,TaskName | ForEach-Object { $a = ($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -join ' ; '; \"$($_.TaskPath)$($_.TaskName)`t$a\" }"
function scheduledTasks(label) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TASKS_SCRIPT], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  if (res.status !== 0) die(`could not list scheduled tasks (${label})`)
  const text = res.stdout.replace(/\r/g, '')
  writeFileSync(join(dir, `scheduled-tasks-${label}.txt`), text)
  return { count: text.split('\n').filter(Boolean).length, sha: createHash('sha256').update(text).digest('hex') }
}

// -- The install: builds in a marketplace-style cache --------------------------------------------

function build(version, { broken = false } = {}) {
  const dest = join(cacheRoot, version)
  if (existsSync(dest)) die(`build ${version} already exists`)
  mkdirSync(dest, { recursive: true })
  const res = spawnSync('robocopy.exe', [PLUGIN, dest, '/E', '/XD', join(PLUGIN, '.git'), join(PLUGIN, 'test'), join(PLUGIN, 'docs'), '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true })
  if (res.status === null || res.status >= 8) die(`robocopy of ${version} failed (${res.status})`)
  for (const rel of ['package.json', join('.claude-plugin', 'plugin.json')]) {
    const path = join(dest, rel)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    doc.version = version
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
  }
  if (broken) {
    // A build whose delivery never goes live: the channel beacon is never written.
    const path = join(dest, 'lib', 'pairing-lock.ts')
    const text = readFileSync(path, 'utf8')
    const anchor = '  const io = input.io ?? defaultLockIo\n  try {\n    io.writeFile(\n      input.path,\n      serializeBeaconHeartbeat('
    if (text.split(anchor).length !== 2) die('the broken build anchor is not unique in lib/pairing-lock.ts')
    writeFileSync(path, text.replace(anchor, `  if (input.path) return false // RIG: broken build, the beacon is never written\n${anchor}`))
  }
  return dest
}
function installedPlugins(version) {
  const path = join(configDir, 'plugins', 'installed_plugins.json')
  const at = new Date().toISOString()
  const doc = { version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath: join(cacheRoot, version), version, installedAt: at, lastUpdated: at, gitCommitSha: 'rig' }] } }
  writeFileSync(`${path}.tmp`, `${JSON.stringify(doc, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}
/** settings.json as an enrolled install has it: Claude Code's own update on for the hoai marketplace, so the rollback has one to switch off. */
function enrolMarketplace() {
  const doc = { extraKnownMarketplaces: { hoai: { source: { source: 'github', repo: 'BrandGrowthOS/bgos-claude-plugin' }, autoUpdate: true } } }
  writeFileSync(join(configDir, 'settings.json'), `${JSON.stringify(doc, null, 2)}\n`)
}
function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['hoai@hoai'][0].version
  } catch {
    return null
  }
}

// -- The stand-in claude and the PATH that finds only it -----------------------------------------

const binDir = join(runDir, 'bin')
function standIn() {
  const exe = join(binDir, 'claude.exe')
  const src = join(RIG_SRC, 'stand-in-claude.ts')
  if (existsSync(exe) && statSync(exe).mtimeMs > statSync(src).mtimeMs) return exe
  mkdirSync(binDir, { recursive: true })
  const res = spawnSync('bun', ['build', '--compile', src, '--outfile', exe], { encoding: 'utf8', windowsHide: true, shell: true, env: { ...process.env, TEMP: tmp, TMP: tmp } })
  if (res.status !== 0) die(`bun build --compile failed: ${res.stderr}`)
  return exe
}
function which(name) {
  const res = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
  return res.status === 0 ? res.stdout.split(/\r?\n/).filter(Boolean)[0] : null
}
function rigPath() {
  const bun = which('bun')
  if (!bun) die('bun is not on PATH')
  const sys = process.env.SystemRoot ?? 'C:\\Windows'
  const dirs = [binDir, dirname(bun), dirname(process.execPath), join(sys, 'System32'), sys, join(sys, 'System32', 'Wbem'), join(sys, 'System32', 'WindowsPowerShell', 'v1.0')]
  for (const d of dirs.slice(1)) {
    for (const n of ['claude.exe', 'claude.cmd', 'claude.bat', 'claude.com', 'claude']) {
      if (existsSync(join(d, n))) die(`${join(d, n)} is on the rig PATH: only the stand-in may be`)
    }
  }
  return dirs.join(';')
}

// -- Agents --------------------------------------------------------------------------------------

let port = 0
let stubPid = 0
let PATH_RIG = ''
const agents = []
const { agentTaskSpec } = await import(pathToFileURL(join(PLUGIN, 'lib', 'agent-task-win32.mjs')).href)

function agentEnv(extra = {}) {
  const pick = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USERNAME', 'COMPUTERNAME', 'PSModulePath']
  const env = {}
  for (const key of pick) if (process.env[key] !== undefined) env[key] = process.env[key]
  return {
    ...env,
    PATH: PATH_RIG,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: tmp,
    TMP: tmp,
    HOAI_RIG_DIR: dir,
    BGOS_IDLE_UPDATE_SCALE: String(scale),
    HOAI_BROWSER_HOST: 'off',
    ...extra,
  }
}

function prepareAgent(id, version) {
  const cwd = join(home, 'agents', id)
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, '.bgos-agent-id'), `${id}\n`)
  writeFileSync(
    join(machineDir, `credentials-${id}.json`),
    `${JSON.stringify({ backendUrl: `http://127.0.0.1:${port}`, pairingToken: `rig-token-${id}`, pairingId: `rig-${id}`, userId: '1', assistantId: id, pairedAt: new Date().toISOString(), homeDir: cwd, homeSource: 'pin' }, null, 2)}\n`,
  )
  const spec = agentTaskSpec({ assistantId: id, home, nodePath: process.execPath, pluginRoot: join(cacheRoot, version), cwd })
  const vbs = spec.files[0]
  mkdirSync(dirname(vbs.path), { recursive: true })
  writeFileSync(vbs.path, vbs.content)
  return { id, cwd, vbs: vbs.path, stateDir: dirname(vbs.path) }
}

async function launch(agent, { how = 'task', env = {} } = {}) {
  if (how === 'task') {
    const at = Date.now()
    const child = spawn('wscript.exe', ['//B', agent.vbs], { cwd: agent.cwd, env: agentEnv(env), stdio: 'ignore', windowsHide: true })
    agent.root = child.pid
    addRoot(child.pid, `wscript ${agent.id}`, at)
  } else {
    // A person's own `hoai --keep-alive`: not the agent task's hidden wscript.
    const core = join(cacheRoot, FROM, 'bin', 'hoai-core.mjs')
    const ps = `$p = Start-Process -FilePath '${process.execPath}' -ArgumentList '"${core}" --keep-alive' -WorkingDirectory '${agent.cwd}' -WindowStyle Hidden -PassThru; $p.Id`
    const at = Date.now()
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', env: agentEnv(env), windowsHide: true })
    const pid = Number(String(res.stdout).trim())
    if (!Number.isInteger(pid) || pid <= 0) die(`could not start the interactive launcher for ${agent.id}`)
    agent.root = pid
    addRoot(pid, `hoai by hand ${agent.id}`, at)
  }
  agent.how = how
  agents.push(agent)
  say(`launched ${agent.id} (${how}) root pid ${agent.root}`)
}

const logOf = (id) => join(machineDir, 'logs', `bgos-plugin-${id}.log`)
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
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
const idleLines = (id) => readText(logOf(id)).split('\n').filter((l) => l.includes('idle update: '))
const sessionLaunches = (agent) => jsonLines(join(agent.cwd, '.rig', 'launches.jsonl')).filter((l) => l.mode)
const heartbeats = (id) => jsonLines(join(dir, 'stub-requests.jsonl')).filter((r) => r.path === 'integrations/heartbeat' && r.assistantId === id)
const record = (id) => {
  try {
    return JSON.parse(readFileSync(join(machineDir, id, 'idle-update.json'), 'utf8'))
  } catch {
    return null
  }
}
function step(agent, value) {
  const d = join(agent.cwd, '.rig', 'cmd')
  mkdirSync(d, { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`
  writeFileSync(join(d, `${name}.tmp`), JSON.stringify(value))
  renameSync(join(d, `${name}.tmp`), join(d, name))
}
async function stub(op, body) {
  const res = await fetch(`http://127.0.0.1:${port}/__rig/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.json()
}

async function startStub() {
  for (let i = 0; i < 10; i++) {
    const candidate = 43000 + Math.floor(Math.random() * 6000)
    const at = Date.now()
    const child = spawn(process.execPath, [join(RIG_SRC, 'stub-backend.mjs'), '--port', String(candidate), '--dir', dir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const exited = new Promise((r) => child.on('exit', (code) => r(code)))
    let ended = false
    for (let t = 0; t < 50; t++) {
      // Only this candidate's own ready line counts: a slower one before it may still write the file.
      let ready = null
      try {
        ready = JSON.parse(readFileSync(join(dir, 'stub-ready.json'), 'utf8'))
      } catch {}
      if (ready?.pid === child.pid && ready?.port === candidate) {
        port = candidate
        stubPid = child.pid
        addRoot(child.pid, 'stub', at)
        say(`stub on 127.0.0.1:${port} pid ${stubPid}`)
        return
      }
      const code = await Promise.race([exited, sleep(100).then(() => 'running')])
      if (code !== 'running') {
        ended = true
        break
      }
    }
    // Still starting after 5 s: ended through its own handle before the next candidate, never left listening.
    if (!ended) {
      child.kill()
      await Promise.race([exited, sleep(5 * SEC)])
    }
  }
  die('the stub backend did not start')
}

// -- Watching ------------------------------------------------------------------------------------

let peakWs = 0
let peakPb = 0
let peakByName = {}
async function watch(label, done, { timeoutMs, everyMs = 10 * SEC }) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const rows = await listProcesses()
    if (rows) {
      const { ws, pb, byName } = adopt(rows)
      peakWs = Math.max(peakWs, ws)
      if (pb > peakPb) {
        peakPb = pb
        peakByName = byName
      }
      if (pb > MEMORY_CAP) throw new Error(`memory cap: the rig's processes commit ${(pb / 1024 ** 3).toFixed(2)} GB private (working set ${(ws / 1024 ** 3).toFixed(2)} GB): ${JSON.stringify(byName)}`)
    }
    const verdict = await done()
    if (verdict) return verdict
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await sleep(everyMs)
  }
}
const armed = (id) => idleLines(id).some((l) => l.includes('idle update: armed on'))
// A status-only beat carries no daemonVersion and no lastError: the report is on the last beat that names a version.
const versionBeats = (id) => heartbeats(id).filter((h) => typeof h.body?.daemonVersion === 'string')
const latestVersion = (id) => versionBeats(id).at(-1)?.body?.daemonVersion ?? null

function stage(version) {
  installedPlugins(version)
  say(`staged ${version}: installed_plugins.json now points at it`)
}

// -- Teardown ------------------------------------------------------------------------------------

async function teardown() {
  say('teardown: ending the launchers, then anything of ours still alive, each by exact pid')
  const rows = (await listProcesses()) ?? []
  adopt(rows)
  for (const agent of agents) {
    const hoai = aliveOwned(rows).find((p) => /hoai-core\.mjs/i.test(p.cmd ?? '') && (p.pid === agent.root || owned.has(p.pid)) && descendsFrom(rows, p.pid, agent.root))
    if (hoai) killExact([{ pid: hoai.pid, c: owned.get(hoai.pid)?.c }])
  }
  await sleep(3 * SEC)
  for (let round = 0; round < 5; round++) {
    const now = (await listProcesses()) ?? []
    adopt(now)
    const left = aliveOwned(now)
    if (left.length === 0) {
      say('teardown: nothing of ours is alive')
      return []
    }
    killExact(left.map((p) => ({ pid: p.pid, c: p.c })))
    await sleep(2 * SEC)
  }
  const last = aliveOwned((await listProcesses()) ?? [])
  return last.map((p) => `${p.pid} ${p.n}`)
}
function descendsFrom(rows, pid, root) {
  const byPid = new Map(rows.map((r) => [r.p, r]))
  let cur = byPid.get(pid)
  for (let i = 0; cur && i < 64; i++) {
    if (cur.p === root) return true
    cur = byPid.get(cur.pp)
  }
  return pid === root
}

// -- Scenarios -----------------------------------------------------------------------------------

const results = { scenario, scale, from: FROM, target: TARGET, dir, checks: [], agents: {} }
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: Boolean(ok), detail })
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const ids = (n, base) => Array.from({ length: n }, (_, i) => String(base + i))

/** One at a time: each daemon armed (or off) before the next launches, so no two boots' memory peaks stack. */
async function bootAll(list, { how = {}, env = {} } = {}) {
  const ready = (a) => armed(a.id) || idleLines(a.id).some((l) => l.includes('idle update: off'))
  for (const a of list) {
    await launch(a, { how: how[a.id] ?? 'task', env: env[a.id] ?? {} })
    await watch(`${a.id} armed or off`, () => ready(a), { timeoutMs: 6 * MIN, everyMs: 3 * SEC })
  }
  say(`all ${list.length} daemons armed (or off)`)
}

function summarise(agent) {
  return {
    launches: sessionLaunches(agent).map((l) => ({ at: l.at, mode: l.mode, sessionId: l.sessionId, version: l.pluginVersion, resumedLines: l.resumedLines })),
    versions: [...new Set(versionBeats(agent.id).map((h) => h.body.daemonVersion))],
    lastError: versionBeats(agent.id).at(-1)?.body?.lastError ?? null,
    record: record(agent.id),
    idle: idleLines(agent.id).map((l) => l.replace(/^.*idle update: /, '')).slice(-12),
  }
}

async function scenarioIdle() {
  const [a] = ids(1, 7100001).map((id) => prepareAgent(id, FROM))
  await bootAll([a])
  stage(TARGET)
  await watch('the restart onto the target', () => latestVersion(a.id) === TARGET && record(a.id)?.state === 'validated', { timeoutMs: 15 * MIN })
  say('restarted and validated; watching two more minutes for a second restart')
  await sleep(2 * MIN)
  const s = summarise(a)
  results.agents[a.id] = s
  check('one restart, onto the target', s.launches.length === 2 && s.launches[1].version === TARGET, s.launches)
  check('context kept: the second launch resumed the same session', s.launches[1]?.mode === 'resume' && s.launches[1]?.sessionId === s.launches[0]?.sessionId && s.launches[1]?.resumedLines > 0)
  check('reported: heartbeats carry the new version with no error', latestVersion(a.id) === TARGET && s.lastError === null, { versions: s.versions, lastError: s.lastError })
  check('record validated', s.record?.state === 'validated', s.record?.state)
}

// The busy cases, in id order after the idle control (7200001). `--cases` runs the control and a subset, so a
// run stays under the memory cap: each agent of the real chain commits about 0.9 GB (two bun processes).
const BUSY_CASES = ['turn', 'owed', 'browser', 'wake', 'hand', 'off', 'ask', 'call', 'goal']
async function scenarioBusy() {
  const picked = flag('--cases', BUSY_CASES.join(',')).split(',').filter(Boolean)
  for (const k of picked) if (!BUSY_CASES.includes(k)) die(`unknown busy case ${k}; known: ${BUSY_CASES.join(',')}`)
  const control = prepareAgent(String(7200001), FROM)
  const by = Object.fromEntries(BUSY_CASES.map((k, i) => [k, picked.includes(k) ? prepareAgent(String(7200002 + i), FROM) : null]))
  const { turn, owed, browser, wake, hand: byHand, off, ask, call, goal } = by
  const list = [control, ...BUSY_CASES.map((k) => by[k]).filter(Boolean)]
  const names = { turn: 'turn in flight', owed: 'reply owed', browser: 'browser in use', wake: 'wake due', hand: 'launched by hand', off: 'auto update off', ask: 'open ask card', call: 'call live', goal: 'goal running' }
  const reasons = {
    turn: /waiting: turn_in_flight/,
    owed: /waiting: pending_messages/,
    browser: /waiting: browser_in_use/,
    wake: /waiting: wake_due/,
    hand: /waiting: no_unattended_authority/,
    off: /off: updates_disabled/,
    ask: /waiting: open_ask/,
    call: /waiting: call_active/,
    goal: /waiting: goal_running/,
  }
  const roles = { [control.id]: 'idle control' }
  const expect = {}
  for (const k of BUSY_CASES) {
    if (!by[k]) continue
    roles[by[k].id] = names[k]
    expect[by[k].id] = reasons[k]
  }
  results.roles = roles
  results.cases = picked
  await bootAll(list, { how: byHand ? { [byHand.id]: 'interactive' } : {}, env: off ? { [off.id]: { BGOS_AUTO_UPDATE: 'off' } } : {} })
  // The busy facts, set before anything is staged.
  if (turn) step(turn, { op: 'prompt', text: 'rig: a long turn that has not ended' })
  // A browser tool inside a turn that then ends: only the browser window holds it, not an open turn. The window
  // (30 min, scaled) is shorter than the hold below, so the browser is used again every 2 min, as a person still at it.
  let browserUsedAt = 0
  const keepBrowserInUse = () => {
    if (!browser || Date.now() - browserUsedAt < 2 * MIN) return
    browserUsedAt = Date.now()
    step(browser, { op: 'prompt', text: 'rig: look something up in the browser' })
    step(browser, { op: 'tool', name: 'mcp__plugin_hoai_hoai-browser__browser_navigate', phase: 'pre' })
    step(browser, { op: 'tool', name: 'mcp__plugin_hoai_hoai-browser__browser_navigate', phase: 'post' })
    step(browser, { op: 'stop' })
  }
  keepBrowserInUse()
  const keepWakeDue = async () => {
    if (wake) await stub('schedule', { assistantId: wake.id, tasks: [{ id: 1, name: 'rig wake', status: 'active', nextFireAt: new Date(Date.now() + 60 * SEC).toISOString() }] })
  }
  await keepWakeDue()
  // A voice frame in the last 30 min (scaled) is a live call; one every poll keeps it live.
  const keepCallLive = async () => {
    if (call) await stub('voice', { assistantId: call.id })
  }
  await keepCallLive()
  if (goal) step(goal, { op: 'goal', condition: 'rig: keep going until the rig says stop' })
  if (owed) {
    // A fresh pairing's chat is empty, and the first message ever in a chat is read as backlog (the first-poll path,
    // server.ts), which owes no tracked reply by design. A field agent always has history: one message first, then
    // the one the reply is owed to.
    await stub('inbound', { assistantId: owed.id, text: 'rig: hello' })
    // A chat message (it has a message id), not the boot hello the session also gets.
    await watch('the owed agent saw its first message', () => jsonLines(join(owed.cwd, '.rig', 'inbound.jsonl')).some((l) => l.meta?.message_id), { timeoutMs: 3 * MIN })
    await stub('inbound', { assistantId: owed.id, text: 'rig: please answer me' })
  }
  if (ask) {
    await stub('inbound', { assistantId: ask.id, text: 'rig: ask me something' })
    await watch('the ask agent saw its inbound', () => jsonLines(join(ask.cwd, '.rig', 'inbound.jsonl')).some((l) => l.meta?.chat_id), { timeoutMs: 3 * MIN })
    const chatId = String(jsonLines(join(ask.cwd, '.rig', 'inbound.jsonl')).find((l) => l.meta?.chat_id).meta.chat_id)
    step(ask, { op: 'call', tool: 'reply', arguments: { chat_id: chatId, text: 'rig: one question first' } })
    step(ask, { op: 'call', tool: 'ask_user_input', arguments: { chat_id: chatId, wait_seconds: 0, questions: [{ text: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] } })
  }
  if (owed) await watch('the owed message was delivered', () => jsonLines(join(owed.cwd, '.rig', 'inbound.jsonl')).filter((l) => l.meta?.message_id).length > 1, { timeoutMs: 3 * MIN })
  stage(TARGET)
  // Quiet window (10 min with hooks) + jitter (10 min) + margin, all scaled; the wake stays due all along.
  const holdMs = (20 * MIN) / scale + 3 * MIN
  const until = Date.now() + holdMs
  await watch('the idle control restarted and every busy agent held for the quiet window and jitter', async () => {
    await keepWakeDue()
    await keepCallLive()
    keepBrowserInUse()
    return Date.now() > until && record(control.id)?.state === 'validated'
  }, { timeoutMs: holdMs + 15 * MIN })
  for (const a of list) results.agents[a.id] = { role: roles[a.id], ...summarise(a) }
  check('idle control restarted onto the target and validated', results.agents[control.id].launches.length === 2 && record(control.id)?.state === 'validated', results.agents[control.id].launches)
  for (const a of list.slice(1)) {
    const s = results.agents[a.id]
    check(`${roles[a.id]} (${a.id}) waited: never restarted`, s.launches.length === 1 && !s.versions.includes(TARGET), { launches: s.launches.length, versions: s.versions })
    check(`${roles[a.id]} (${a.id}) waited for the right reason`, s.idle.some((l) => expect[a.id].test(l)), s.idle)
  }
  // Released: the turn ends, the wake is gone, the reply is sent, the card withdrawn; the browser window runs out by itself.
  if (turn) step(turn, { op: 'stop' })
  if (wake) await stub('schedule', { assistantId: wake.id, tasks: [] })
  const owedChat = owed ? String(jsonLines(join(owed.cwd, '.rig', 'inbound.jsonl')).find((l) => l.meta?.chat_id)?.meta?.chat_id ?? '') : ''
  if (owedChat) step(owed, { op: 'call', tool: 'reply', arguments: { chat_id: owedChat, text: 'rig: answered' } })
  const askId = (() => {
    if (!ask) return null
    const r = jsonLines(join(ask.cwd, '.rig', 'results.jsonl')).find((l) => l.step?.tool === 'ask_user_input')
    const m = /ask_id["':\s]+([A-Za-z0-9_-]+)/.exec(r?.outcome?.result ?? '')
    return m ? m[1] : null
  })()
  if (askId) step(ask, { op: 'call', tool: 'withdraw_ask', arguments: { ask_id: askId } })
  if (goal) step(goal, { op: 'goal', condition: 'rig: keep going until the rig says stop', met: true })
  say('released turn, wake, reply, ask and goal; the browser and call windows run out by themselves')
  const released = [turn, owed, browser, wake, ask, call, goal].filter(Boolean)
  try {
    await watch('the released agents restarted onto the target', () => released.every((a) => latestVersion(a.id) === TARGET), { timeoutMs: (60 * MIN) / scale + 20 * MIN })
    check('every released busy agent then restarted onto the target', true)
  } catch (err) {
    check('every released busy agent then restarted onto the target', false, released.map((a) => ({ id: a.id, role: roles[a.id], version: latestVersion(a.id), idle: idleLines(a.id).slice(-3) })))
  }
  for (const a of [byHand, off].filter(Boolean)) {
    const s = summarise(a)
    check(`${roles[a.id]} (${a.id}) still never restarted`, s.launches.length === 1 && !s.versions.includes(TARGET), { launches: s.launches.length, versions: s.versions })
  }
  for (const a of list) results.agents[a.id] = { role: roles[a.id], ...summarise(a) }
}

async function scenarioBroken() {
  const list = ids(2, 7300001).map((id) => prepareAgent(id, FROM))
  await bootAll(list)
  build(TARGET, { broken: true })
  stage(TARGET)
  await watch('a rollback back onto the old build', () => list.some((a) => record(a.id)?.state === 'rolled_back') && installedVersion() === FROM && list.every((a) => latestVersion(a.id) === FROM), { timeoutMs: 20 * MIN })
  say('rolled back; watching three more minutes for any further restart')
  await sleep(3 * MIN)
  for (const a of list) results.agents[a.id] = summarise(a)
  const canary = list.find((a) => record(a.id)?.state === 'rolled_back')
  const other = list.find((a) => a !== canary)
  const c = results.agents[canary.id]
  check('the canary restarted onto the broken build once', c.launches.filter((l) => l.version === TARGET).length >= 1 && c.versions.includes(TARGET), c.launches)
  check('the canary came back on the old build, same session', c.launches.at(-1)?.version === FROM && c.launches.at(-1)?.sessionId === c.launches[0]?.sessionId)
  check('the rollback is reported', c.lastError?.code === 'idle_update_rolled_back', c.lastError)
  check('the install points back at the old build', installedVersion() === FROM)
  check('the broken version is latched bad on this computer', existsSync(join(machineDir, 'idle-update', TARGET, 'bad')))
  check('the other agent never restarted', results.agents[other.id].launches.length === 1, results.agents[other.id].launches)
  check('no loop: the canary restarted at most twice (onto the build, back off it), plus one health relaunch at most', c.launches.length <= 4, c.launches.length)
  let settings = null
  try {
    settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
  } catch {}
  check("Claude Code's own update for the marketplace is off after the rollback", JSON.stringify(settings ?? {}).includes('"autoUpdate":false'), settings?.extraKnownMarketplaces ?? null)
}

// What a restart does to a schedule (DESIGN.md, "What a restart does to /loop and scheduled wakes"). A backend wake is
// the backend's, and its fire reaches the resumed session on the new build. A one-shot entry at a Stop (a self-paced
// /loop) holds the restart; a Stop that shows only an interval /loop, which --resume restores, lets it through. The
// stand-in proves the daemon's handling, never Claude Code's own restore.
async function scenarioWake() {
  const [a] = ids(1, 7500001).map((id) => prepareAgent(id, FROM))
  await bootAll([a])
  const seen = () => jsonLines(join(a.cwd, '.rig', 'inbound.jsonl'))
  // A chat's first message reads as backlog (the owed case above), so the fire needs one before it.
  await stub('fire', { assistantId: a.id, text: 'rig: hello' })
  await watch('the first card was delivered', () => seen().some((l) => l.meta?.message_id), { timeoutMs: 3 * MIN })
  await stub('schedule', { assistantId: a.id, tasks: [{ id: 1, name: 'rig wake', status: 'active', nextFireAt: new Date(Date.now() + 360 * MIN).toISOString() }] })
  step(a, { op: 'prompt', text: 'rig: a turn that ends on a self-paced /loop' })
  await sleep(SEC)
  step(a, { op: 'stop', sessionCrons: [{ id: 'rig-wakeup', schedule: '30 12 * * *', recurring: false, prompt: '/loop rig' }] })
  stage(TARGET)
  await watch('the restart held for the pending wakeup', () => idleLines(a.id).some((l) => /waiting: session_wake/.test(l)), { timeoutMs: 5 * MIN })
  say('held; watching past the quiet window and the largest jitter')
  await sleep((20 * MIN) / scale + MIN)
  const whileHeld = sessionLaunches(a).length
  step(a, { op: 'prompt', text: 'rig: a turn that ends on an interval /loop only' })
  await sleep(SEC)
  step(a, { op: 'stop', sessionCrons: [{ id: 'rig-interval', schedule: '*/10 * * * *', recurring: true, prompt: '/loop 10m rig' }] })
  await watch('the restart onto the target', () => latestVersion(a.id) === TARGET && record(a.id)?.state === 'validated', { timeoutMs: 15 * MIN })
  const before = seen().length
  await stub('fire', { assistantId: a.id, text: 'rig: the wake fires' })
  await watch('the fire reached the session', () => seen().slice(before).some((l) => l.content?.includes('rig: the wake fires')), { timeoutMs: 3 * MIN })
  say('watching two more minutes for a second restart')
  await sleep(2 * MIN)
  const s = summarise(a)
  results.agents[a.id] = s
  const fired = seen().find((l) => l.content?.includes('rig: the wake fires'))
  check('held: no restart while the Stop showed a pending wakeup, through the quiet window and the largest jitter', whileHeld === 1, whileHeld)
  const scheduleReads = jsonLines(join(dir, 'stub-requests.jsonl')).filter((r) => r.path === 'scheduled-tasks/agent' && r.assistantId === a.id).length
  check('the old daemon read the wake, 6 h out, before it restarted', scheduleReads > 0, scheduleReads)
  check('one restart, onto the target, once only an interval /loop was left', s.launches.length === 2 && s.launches[1].version === TARGET, s.launches)
  check('context kept: the second launch resumed the same session', s.launches[1]?.mode === 'resume' && s.launches[1]?.sessionId === s.launches[0]?.sessionId, s.launches)
  check("the wake's fire reached the resumed session, after the restart", Date.parse(fired?.at ?? '') > Date.parse(s.launches[1]?.at ?? ''), fired)
  check('reported: heartbeats carry the new version with no error', latestVersion(a.id) === TARGET && s.lastError === null, { versions: s.versions, lastError: s.lastError })
}

async function scenarioStagger() {
  const list = ids(agentCount, 7400001).map((id) => prepareAgent(id, FROM))
  await bootAll(list)
  stage(TARGET)
  await watch(`all ${list.length} on the target`, () => {
    const on = list.filter((a) => latestVersion(a.id) === TARGET && record(a.id)?.state === 'validated').length
    say(`${on}/${list.length} on ${TARGET}`)
    return on === list.length
  }, { timeoutMs: 90 * MIN, everyMs: 15 * SEC })
  for (const a of list) results.agents[a.id] = summarise(a)
  // Each agent's window: from the old daemon's restart request to the new one's validation.
  const windows = list.map((a) => {
    const rec = record(a.id)
    const requested = (rec?.attempts ?? []).map((x) => Date.parse(x.at)).filter(Number.isFinite)[0] ?? null
    const validated = Date.parse(rec?.validatedAt ?? '') || null
    const relaunch = Date.parse(sessionLaunches(a)[1]?.at ?? '') || null
    return { id: a.id, requested, relaunch, validated }
  }).sort((x, y) => (x.relaunch ?? 0) - (y.relaunch ?? 0))
  results.windows = windows.map((w) => ({ ...w, requested: w.requested && new Date(w.requested).toISOString(), relaunch: w.relaunch && new Date(w.relaunch).toISOString(), validated: w.validated && new Date(w.validated).toISOString() }))
  check(`all ${list.length} restarted exactly once`, list.every((a) => sessionLaunches(a).length === 2), list.map((a) => sessionLaunches(a).length))
  const relaunches = windows.map((w) => w.relaunch).filter(Boolean)
  const gaps = relaunches.slice(1).map((t, i) => t - relaunches[i])
  const spacingMs = (2 * MIN) / scale
  check('no two relaunches together: each gap at least the spacing', gaps.every((g) => g >= spacingMs), { spacingMs, minGapMs: Math.min(...gaps), gaps })
  let overlap = false
  for (let i = 1; i < windows.length; i++) if (windows[i].relaunch && windows[i - 1].validated && windows[i].relaunch < windows[i - 1].validated) overlap = true
  check("no relaunch before the previous agent's validation", !overlap)
  check('every agent kept its session', list.every((a) => {
    const l = sessionLaunches(a)
    return l[1]?.mode === 'resume' && l[1]?.sessionId === l[0]?.sessionId
  }))
}

// -- Run -----------------------------------------------------------------------------------------

say(`scenario ${scenario}, scale ${scale}, dir ${dir}`)
const tasksBefore = scheduledTasks('before')
say(`scheduled tasks before: ${tasksBefore.count} (${tasksBefore.sha.slice(0, 12)})`)
let failure = null
let leftAlive = []
started = true
try {
  standIn()
  PATH_RIG = rigPath()
  say('building the installed version')
  build(FROM)
  if (scenario !== 'broken') build(TARGET)
  installedPlugins(FROM)
  enrolMarketplace()
  await startStub()
  if (scenario === 'idle') await scenarioIdle()
  if (scenario === 'busy') await scenarioBusy()
  if (scenario === 'broken') await scenarioBroken()
  if (scenario === 'stagger') await scenarioStagger()
  if (scenario === 'wake') await scenarioWake()
} catch (err) {
  failure = String(err?.message ?? err)
  say(`error: ${failure}`)
  for (const a of agents) results.agents[a.id] ??= summarise(a)
} finally {
  leftAlive = await teardown()
  const stub = stubPid ? aliveOwned((await listProcesses()) ?? []).find((p) => p.pid === stubPid) : null
  if (stub) killExact([{ pid: stub.pid, c: stub.c }])
}
const tasksAfter = scheduledTasks('after')
say(`scheduled tasks after: ${tasksAfter.count} (${tasksAfter.sha.slice(0, 12)})`)
check('scheduled tasks identical before and after', tasksBefore.sha === tasksAfter.sha, { before: tasksBefore, after: tasksAfter })
check('no process of ours left alive', leftAlive.length === 0, leftAlive)
results.peakWorkingSetGB = Number((peakWs / 1024 ** 3).toFixed(2))
results.peakPrivateGB = Number((peakPb / 1024 ** 3).toFixed(2))
results.peakPrivateByName = peakByName
results.failure = failure
writeFileSync(join(dir, 'result.json'), `${JSON.stringify(results, null, 2)}\n`)
const failed = results.checks.filter((c) => !c.ok).map((c) => c.name)
if (failure || failed.length) {
  console.log(`RIG FAIL ${scenario}: ${failure ?? failed.join('; ')}`)
  process.exit(1)
}
console.log(`RIG PASS ${scenario} (${results.checks.length} checks, peak ${results.peakPrivateGB} GB private, ${results.peakWorkingSetGB} GB working set)`)
