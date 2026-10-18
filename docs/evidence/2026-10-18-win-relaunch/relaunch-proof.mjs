// relaunch-proof.mjs: a REAL hoai relaunch on Windows against a FAKE claude (HOAI board row 978da5db).
//
//   node relaunch-proof.mjs --core <path to bin\hoai-core.mjs> --label <name> [--draw-delay-ms 4000]
//
// What runs, all of it real except claude:
//   - the real superviseClaude from --core (main's or this branch's), unattended (--keep-alive), in a
//     HIDDEN console of its own (Start-Process), as the agent task's wscript gives hoai one;
//   - claude installed the npm way: PATH is cut down to a temporary folder holding cmd-shim's
//     claude.cmd, node and Windows itself, so hoai starts `cmd.exe /c claude.cmd ...`; behind the shim
//     is a FAKE claude (a small node program), never a real one;
//   - the real gate helper (bin\win32-accept-dev-channels.ps1, powershell.exe 5.1) on that console.
//
// The fake claude draws the dev-channels gate in the alternate screen, as Claude Code's TUI does. The
// first one ignores the Enter it gets (the gate that never took, agent 888's shape); the second one
// takes --draw-delay-ms to draw (a cold claude start). Once launch 1's helper has pressed, this script
// writes the restart marker, as the daemon does for an update, and then records:
//   1. KILL: is launch 1's fake claude still running after hoai relaunched?
//   2. STALE GATE: did launch 2's helper press Enter before launch 2's claude drew its gate?
// Everything lives in a fresh folder under %TEMP%; nothing outside it is read or written. Every
// process this script started is ended at the end, by the pids it recorded. Process listings print
// pid, parent pid and name only.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const core = resolve(arg('core', ''))
const label = arg('label', 'run')
const drawDelayMs = Number(arg('draw-delay-ms', '4000'))
if (!existsSync(core)) throw new Error(`--core ${core} does not exist`)
if (process.platform !== 'win32') throw new Error('Windows only')

const dir = mkdtempSync(join(tmpdir(), `hoai-relaunch-proof-${label}-`))
const proofStartedAtMs = Date.now()
const home = join(dir, 'home')
const agent = join(dir, 'agent')
const npmDir = join(dir, 'npm')
const events = join(dir, 'events.jsonl')
const config = join(dir, 'config.json')
const launcherLog = join(dir, 'launcher.log')
const ID = '9901'
const helperLog = join(home, '.bgos-agent', 'logs', 'win32-gate-helper.log')
const markerPath = join(home, '.bgos-agent', ID, 'restart-requested.json')
for (const d of [home, agent, npmDir]) mkdirSync(d, { recursive: true })
const say = (line) => {
  const text = `${new Date().toISOString()} ${line}`
  console.log(text)
  appendFileSync(join(dir, 'proof.log'), `${text}\n`)
}

// -- the npm install of a FAKE claude -------------------------------------------------------------
const SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', '',
].join('\r\n')
const FAKE_CLAUDE = `import { appendFileSync, readFileSync } from 'node:fs'
const events = ${JSON.stringify(events)}
const cfg = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'))
let launch = 1
try { launch = readFileSync(events, 'utf8').split('\\n').filter((l) => l.includes('"ev":"start"')).length + 1 } catch {}
const me = cfg.launches[launch - 1] ?? cfg.launches.at(-1)
let gateOnScreen = false
const ev = (name, extra = {}) => appendFileSync(events, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, launch, ev: name, gateOnScreen, ...extra }) + '\\n')
ev('start', { args: process.argv.slice(2).join(' ') })
// Diagnostics go to the events file, never the console: a write there is part of what is measured.
process.on('uncaughtException', (err) => { ev('crash', { message: String(err && err.message) }); process.exit(70) })
ev('stdin', { stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY) })
let ticks = 0
const ticker = setInterval(() => { ticks += 1; ev('tick', { ticks }); if (ticks >= 12) clearInterval(ticker) }, 1000)
process.stdin.setRawMode(true)
process.stdin.resume()
ev('reading')
process.stdin.on('data', (chunk) => {
  if (!chunk.includes(13)) return
  ev(gateOnScreen ? 'enter' : 'early-enter')
  if (gateOnScreen && me.acceptEnter) {
    gateOnScreen = false
    process.stdout.write('\\x1b[2J\\x1b[Hfake claude ' + process.pid + ' is live\\n')
    ev('live')
  }
})
setTimeout(() => {
  ev('drawing')
  process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H WARNING: Loading development channels\\n\\n  1. I am using this for local development\\n  2. Exit\\n')
  gateOnScreen = true
  ev('gate-drawn')
}, me.drawDelayMs)
setInterval(() => {}, 1000)
setTimeout(() => process.exit(9), 240_000)
`
const pkg = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code')
mkdirSync(pkg, { recursive: true })
writeFileSync(join(pkg, 'cli.js'), FAKE_CLAUDE)
writeFileSync(join(pkg, 'package.json'), '{"type":"module"}\n')
writeFileSync(join(npmDir, 'claude.cmd'), SHIM)
writeFileSync(config, JSON.stringify({ launches: [{ drawDelayMs: 1500, acceptEnter: false }, { drawDelayMs: drawDelayMs, acceptEnter: true }] }))

// -- the agent folder and the launcher --------------------------------------------------------------
writeFileSync(join(agent, '.bgos-agent-id'), `${ID}\n`)
writeFileSync(join(agent, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['server.ts'], env: { BGOS_ASSISTANT_ID: ID } } } }))
const root = process.env.SystemRoot ?? 'C:\\Windows'
const PATH = [npmDir, dirname(process.execPath), join(root, 'System32'), root, join(root, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
const LAUNCHER = `import { appendFileSync } from 'node:fs'
const { superviseClaude } = await import(${JSON.stringify(pathToFileURL(core).href)})
const log = (line) => appendFileSync(${JSON.stringify(launcherLog)}, new Date().toISOString() + ' ' + line + '\\n')
log('launcher pid ' + process.pid)
const env = { ...process.env, PATH: ${JSON.stringify(PATH)} }
for (const k of Object.keys(env)) if (/^(BGOS_|HOAI_|CLAUDE_CONFIG_DIR$)/i.test(k)) delete env[k]
const code = await superviseClaude(['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:bgos'], {
  env, home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(agent)}, scriptDir: ${JSON.stringify(dirname(core))},
  keepAlive: true, print: (line) => { log(line); console.log(line) },
})
log('superviseClaude returned ' + code)
`
writeFileSync(join(dir, 'launcher.mjs'), LAUNCHER)

const ps = (command) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
const q = (v) => `'${String(v).replace(/'/g, "''")}'`
const start = ps(`$p = Start-Process -FilePath ${q(process.execPath)} -ArgumentList ${q(`"${join(dir, 'launcher.mjs')}"`)} -WorkingDirectory ${q(agent)} -WindowStyle Hidden -PassThru; $p.Id`)
const launcherPid = Number(String(start.stdout).trim())
if (!Number.isInteger(launcherPid) || launcherPid <= 0) throw new Error(`the launcher did not start: ${start.stderr}`)
say(`[${label}] proof folder ${dir}`)
say(`[${label}] hoai launcher pid ${launcherPid} (hidden console), core ${core}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const evs = () => read(events).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const helperLines = () => read(helperLog).split(/\r?\n/).filter(Boolean)
async function until(check, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(200)
  }
  say(`[${label}] timed out waiting for ${what}`)
  return false
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Still the process this proof started: a node.exe created after the proof began (Windows reuses pids). */
function ours(pid) {
  const r = ps(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p.Name + '|' + ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`)
  const [name, created] = String(r.stdout).trim().split('|')
  return /^node\.exe$/i.test(name ?? '') && Number(created) >= proofStartedAtMs - 5_000
}
/** pid, parent pid and name of every process under the launcher (and the fake claudes): nothing else. */
function tree() {
  const r = ps('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress')
  const all = JSON.parse(r.stdout || '[]')
  const mine = new Set([launcherPid, ...evs().map((e) => e.pid)])
  let grew = true
  while (grew) {
    grew = false
    for (const p of all) if (mine.has(p.ParentProcessId) && !mine.has(p.ProcessId)) { mine.add(p.ProcessId); grew = true }
  }
  return all.filter((p) => mine.has(p.ProcessId)).map((p) => `pid ${p.ProcessId} ppid ${p.ParentProcessId} ${p.Name}`)
}

let verdict = {}
try {
  // Launch 1: the gate is drawn, launch 1's helper presses, the fake claude ignores it.
  await until(() => evs().some((e) => e.launch === 1 && e.ev === 'gate-drawn'), 60_000, 'launch 1 to draw its gate')
  await until(() => helperLines().some((l) => / accepted$| unproven/.test(l)), 60_000, 'launch 1 helper to press')
  await sleep(1500)
  say(`[${label}] launch 1 processes before the relaunch:\n    ${tree().join('\n    ')}`)
  const first = evs().find((e) => e.launch === 1 && e.ev === 'start')
  // The update restart, as the daemon asks for one.
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(markerPath, JSON.stringify({ requestedAt: new Date().toISOString(), reason: 'relaunch-proof' }))
  say(`[${label}] restart marker written`)
  await until(() => evs().some((e) => e.launch === 2 && e.ev === 'start'), 60_000, 'launch 2 to start')
  await until(() => helperLines().filter((l) => l.includes(' start console=')).length >= 2, 30_000, 'launch 2 helper to start')
  await until(() => evs().some((e) => e.launch === 2 && e.ev === 'gate-drawn'), 60_000, 'launch 2 to draw its gate')
  await until(() => helperLines().filter((l) => / accepted$| unproven| timeout /.test(l)).length >= 2, 30_000, 'launch 2 helper to finish')
  await sleep(3000)
  say(`[${label}] processes after the relaunch:\n    ${tree().join('\n    ')}`)
  const second = evs().find((e) => e.launch === 2 && e.ev === 'start')
  const helperRuns = []
  for (const line of helperLines()) {
    const m = /^(\S+) pid=(\d+) (\S+)/.exec(line)
    if (!m) continue
    if (m[3] === 'start') helperRuns.push({ pid: Number(m[2]), lines: [] })
    helperRuns.at(-1)?.lines.push({ t: m[1], word: m[3] })
  }
  const accepted2 = helperRuns[1]?.lines.find((l) => l.word === 'accepted')
  const gate2 = evs().find((e) => e.launch === 2 && e.ev === 'gate-drawn')
  verdict = {
    launch1FakeClaudePid: first?.pid,
    launch1FakeClaudeAliveAfterRelaunch: first ? alive(first.pid) : null,
    launch2FakeClaudePid: second?.pid,
    launch2HelperAcceptedAt: accepted2 ? new Date(accepted2.t).toISOString() : null,
    launch2GateDrawnAt: gate2?.t ?? null,
    launch2HelperPressedBeforeItsGate: accepted2 && gate2 ? new Date(accepted2.t) < new Date(gate2.t) : null,
    launch2GateAnswered: evs().some((e) => e.launch === 2 && e.ev === 'live'),
    launch2EarlyEnter: evs().some((e) => e.launch === 2 && e.ev === 'early-enter'),
    enterTakenByLaunch1AfterRelaunch: evs().some((e) => e.launch === 1 && (e.ev === 'enter' || e.ev === 'early-enter') && second && e.t > second.t),
  }
  say(`[${label}] helper log:\n    ${helperLines().join('\n    ')}`)
  say(`[${label}] fake claude events:\n    ${evs().map((e) => `${e.t} launch ${e.launch} pid ${e.pid} ${e.ev}${e.gateOnScreen ? ' (gate on screen)' : ''}`).join('\n    ')}`)
  say(`[${label}] launcher log:\n    ${read(launcherLog).split(/\r?\n/).filter(Boolean).join('\n    ')}`)
  say(`[${label}] VERDICT ${JSON.stringify(verdict, null, 1)}`)
} finally {
  // Ours only: the launcher's tree, then any fake claude it left behind, by the pids recorded above.
  if (ours(launcherPid)) spawnSync(join(root, 'System32', 'taskkill.exe'), ['/PID', String(launcherPid), '/T', '/F'], { windowsHide: true })
  for (const e of evs().filter((x) => x.ev === 'start')) {
    if (alive(e.pid) && ours(e.pid)) {
      say(`[${label}] ending leftover fake claude ${e.pid} (started by this proof)`)
      try {
        process.kill(e.pid)
      } catch {}
    }
  }
  await sleep(1000)
  say(`[${label}] left running afterwards (should be none):\n    ${tree().join('\n    ') || '(none)'}`)
}
writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 1))
