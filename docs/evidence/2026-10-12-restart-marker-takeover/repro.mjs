// repro.mjs: the REAL claude.exe under an old hoai launcher in a hidden
// console, the daemon under test, a fake backend, hand-written restart
// markers. Everything inside a scratch HOME; claude's API traffic goes to the
// fake backend (ANTHROPIC_BASE_URL), never out, and claude is never signed in
// (a dummy API key on that local base URL).
// Must be started through scoped.mjs so HOME/USERPROFILE are <runDir>\home.
//
// node repro.mjs --run <name> --launcher <checkout> --daemon <checkout>
//                [--settle 20] [--watch 90] [--writes 6] [--launcher-args "--keep-alive"]
//                [--seed-transcript] [--hold <s>] [--probe] [--kill-claude]
// Environment: RESTARTMK_RUNS (default <this folder>\runs), RESTARTMK_CLAUDE_DIR
// (a folder holding a copy of claude.exe), RESTARTMK_BUN_DIR (bun's folder).
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const RUN = opt('run')
const LAUNCHER = opt('launcher')
const DAEMON = opt('daemon')
const SETTLE = Number(opt('settle', '25'))
const WATCH = Number(opt('watch', '75'))
const WRITES = Number(opt('writes', '2'))
const LAUNCHER_ARGS = (opt('launcher-args', '') || '').split(' ').filter(Boolean)
const EXTRA_ENV = Object.fromEntries((opt('env', '') || '').split(',').filter(Boolean).map((kv) => kv.split('=')))
const ID = '909'
const HARNESS = dirname(fileURLToPath(import.meta.url))
const runDir = join(process.env.RESTARTMK_RUNS || join(HARNESS, 'runs'), RUN)
const home = join(runDir, 'home')
if (!RUN || !LAUNCHER || !DAEMON) throw new Error('need --run --launcher --daemon')
if (process.env.USERPROFILE !== home || process.env.HOME !== home) {
  console.error(`REFUSED: USERPROFILE=${process.env.USERPROFILE} HOME=${process.env.HOME}, expected ${home}`)
  process.exit(97)
}
if (existsSync(join(runDir, 'timeline.log'))) {
  console.error(`REFUSED: ${runDir} already used`)
  process.exit(97)
}
mkdirSync(runDir, { recursive: true })
const T0 = Date.now()
const t = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`
const TL = join(runDir, 'timeline.log')
const say = (line) => {
  const s = `${t()} ${line}`
  appendFileSync(TL, `${s}\n`)
  console.log(s)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── layout ───────────────────────────────────────────────────────────────────
const agentDir = join(runDir, 'agents', 'vera')
const stateDir = join(home, '.bgos-agent', ID)
const marker = join(stateDir, 'restart-requested.json')
mkdirSync(agentDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(join(home, '.claude'), { recursive: true })
writeFileSync(join(agentDir, '.bgos-agent-id'), `${ID}\n`)
const servers = { bgos: { command: 'bun', args: [join(DAEMON, 'server.ts')], env: { BGOS_ASSISTANT_ID: ID, BGOS_AUTO_UPDATE: 'off', ...EXTRA_ENV } } }
if (args.includes('--probe')) servers.probe = { command: 'bun', args: [join(HARNESS, 'probe.mjs')], env: { PROBE_LOG: join(runDir, 'probe.log'), PROBE_BEAT: join(HARNESS, 'beat.mjs') } }
writeFileSync(join(agentDir, '.mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
const API_KEY = 'sk-ant-api03-restartmk-dummy-key-never-valid-0000000000000000000000000000000000000000000000000000000000000000000AA'
const project = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [], disabledMcpjsonServers: [], enabledMcpjsonServers: ['bgos'], mcpContextUris: [] }
writeFileSync(
  join(home, '.claude.json'),
  `${JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true, customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] }, projects: { [agentDir]: project, [agentDir.split('\\').join('/')]: project } }, null, 2)}\n`,
)
if (args.includes('--seed-transcript')) {
  const pin = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5'
  writeFileSync(join(stateDir, 'session-id'), `${pin}\n`)
  const proj = join(home, '.claude', 'projects', agentDir.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(proj, { recursive: true })
  const ts = new Date(Date.now() - 3_600_000).toISOString()
  const u1 = '11111111-2222-4333-8444-555555555555'
  const a1 = '66666666-7777-4888-8999-aaaaaaaaaaaa'
  const base = { isSidechain: false, userType: 'external', cwd: agentDir, sessionId: pin, version: '2.1.296', gitBranch: '' }
  writeFileSync(join(proj, `${pin}.jsonl`), [
    { ...base, parentUuid: null, type: 'user', message: { role: 'user', content: 'restartmk seed: remember the word heron' }, uuid: u1, timestamp: ts },
    { ...base, parentUuid: u1, type: 'assistant', message: { id: 'msg_seed', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Noted: heron.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } }, requestId: 'req_seed', uuid: a1, timestamp: ts },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
}
writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify({ skipDangerousModePermissionPrompt: true, enableAllProjectMcpServers: true }, null, 2)}\n`)

// ── fake backend (BGOS API and the Anthropic API both point here) ───────────
const backend = spawn(process.execPath, [join(HARNESS, 'fake-backend.mjs'), join(runDir, 'backend.log'), ID], { stdio: ['pipe', 'pipe', 'inherit'] })
const port = await new Promise((resolve) => {
  let out = ''
  backend.stdout.setEncoding('utf8')
  backend.stdout.on('data', (c) => {
    out += c
    if (out.includes('\n')) resolve(out.trim())
  })
})
writeFileSync(
  join(home, '.bgos-agent', `credentials-${ID}.json`),
  `${JSON.stringify({ pairingToken: 'pair_FAKE_restartmk', backendUrl: `http://127.0.0.1:${port}`, userId: 'user_fake', assistantId: ID, homeDir: agentDir, homeSource: 'pair' }, null, 2)}\n`,
)
say(`layout ready: home=${home} agent=${agentDir} backend=127.0.0.1:${port} launcher=${LAUNCHER} daemon=${DAEMON} boundary=real claude.exe`)

// ── process listing ──────────────────────────────────────────────────────────
function processes() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true })
  try {
    return JSON.parse(r.stdout).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine ?? '' }))
  } catch {
    return []
  }
}
let launcherPid = -1
const mineCmd = (p) => p.cmd.includes(runDir) || p.cmd.includes(HARNESS) || p.cmd.includes(DAEMON) || p.cmd.includes(LAUNCHER) || (/^claude\.exe$/i.test(p.name) && (p.ppid === launcherPid || (typeof launchersSeen !== 'undefined' && launchersSeen.has(p.ppid))))
function snapshot(label) {
  const all = processes()
  const lines = all.filter((p) => mineCmd(p) && p.pid !== process.pid && p.pid !== backend.pid).map((p) => `   pid=${p.pid} ppid=${p.ppid} ${p.name} ${p.cmd.replace(/\s+/g, ' ').slice(0, 170)}`)
  say(`PROCESSES (${label}):\n${lines.join('\n')}`)
  return all
}
const launchersSeen = new Set()
function currentLauncher() {
  try {
    const pid = JSON.parse(readFileSync(join(stateDir, 'supervisor.json'), 'utf8')).pid
    if (Number.isInteger(pid) && pid > 1) {
      if (!launchersSeen.has(pid)) say(`LAUNCHER PID now ${pid} (supervisor.json)`)
      launchersSeen.add(pid)
      launcherPid = pid
    }
  } catch {}
  return launcherPid
}
const claudes = (all) => {
  currentLauncher()
  return all.filter((p) => /^claude\.exe$/i.test(p.name) && launchersSeen.has(p.ppid) && all.some((l) => l.pid === p.ppid))
}
const daemons = (all) => all.filter((p) => /^bun\.exe$/i.test(p.name) && p.cmd.includes(DAEMON))

// ── launcher, in a hidden console of its own ─────────────────────────────────
const PATH = [process.env.RESTARTMK_CLAUDE_DIR || join(HARNESS, 'realclaude'), dirname(process.execPath), process.env.RESTARTMK_BUN_DIR || join(process.env.LOCALAPPDATA || '', 'bun'), 'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';')
const launcherEnv = {}
for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') launcherEnv[k] = v
Object.assign(launcherEnv, {
  PATH,
  ANTHROPIC_API_KEY: API_KEY,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  RESTARTMK_TEE_LOG: join(runDir, 'launcher.log'),
  NODE_OPTIONS: `--import=file:///${join(HARNESS, 'tee.mjs').split('\\').join('/')}`,
})
const psArgs = [join(LAUNCHER, 'bin', 'hoai-core.mjs'), ...LAUNCHER_ARGS].map((a) => `'${a.replace(/'/g, "''")}'`).join(',')
const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$p = Start-Process -FilePath '${process.execPath}' -ArgumentList ${psArgs} -WorkingDirectory '${agentDir}' -WindowStyle Hidden -PassThru; $p.Id`], { encoding: 'utf8', env: launcherEnv, windowsHide: true })
launcherPid = Number(String(ps.stdout).trim())
launchersSeen.add(launcherPid)
say(`launcher started pid=${launcherPid} in a hidden console: node ${join(LAUNCHER, 'bin', 'hoai-core.mjs')} ${LAUNCHER_ARGS.join(' ')} (${ps.stderr.trim().slice(0, 200)})`)
const alive = (all, pid) => all.some((p) => p.pid === pid)

// ── followers ────────────────────────────────────────────────────────────────
const followers = { launcher: [join(runDir, 'launcher.log'), 0], daemon: [join(home, '.bgos-agent', 'logs', `bgos-plugin-${ID}.log`), 0], gate: [join(home, '.bgos-agent', 'logs', 'win32-gate-helper.log'), 0] }
function pump() {
  for (const [name, f] of Object.entries(followers)) {
    if (!existsSync(f[0])) continue
    const lines = readFileSync(f[0], 'utf8').split('\n').filter(Boolean)
    for (const line of lines.slice(f[1])) {
      if (name === 'launcher' && !/\[hoai\]|\[tee\]|restart|relaunch|marker/i.test(line)) continue
      if (name === 'daemon' && !/Starting BGOS|restart takeover|passive|pairing lock acquired/i.test(line)) continue
      say(`${name.toUpperCase()} ${line.slice(0, 300)}`)
    }
    f[1] = lines.length
  }
}
let dumpN = 0
function screen(label) {
  const out = join(runDir, `screen-${String(++dumpN).padStart(2, '0')}.txt`)
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HARNESS, 'screendump.ps1'), '-ConsolePid', String(currentLauncher()), '-OutFile', out], { windowsHide: true, timeout: 30_000 })
  const text = existsSync(out) ? readFileSync(out, 'utf8').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-14).join('\n      ') : '(no dump)'
  say(`SCREEN (${label}) ${out}:\n      ${text}`)
}
async function watchFor(ms, onTick) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    pump()
    if (onTick && (await onTick())) return true
    await sleep(1000)
  }
  return false
}

let all = processes()
await watchFor(90_000, async () => {
  all = processes()
  return claudes(all).length > 0 && daemons(all).length > 0
})
say(`claude.exe ${claudes(all).map((p) => p.pid).join(',') || 'NOT running'}; daemon ${daemons(all).map((p) => p.pid).join(',') || 'NOT running'}`)
await watchFor(SETTLE * 1000)
all = snapshot('before marker 1')
screen('before marker 1')

for (let w = 1; w <= WRITES; w++) {
  const before = new Set(claudes(all).map((p) => p.pid))
  writeFileSync(marker, Buffer.from(JSON.stringify({ reason: `restartmk write ${w}`, requestedBy: 'restartmk' }), 'ascii'))
  say(`MARKER ${w} WRITTEN ${marker} (claude.exe before: ${[...before].join(',') || 'none'})`)
  let goneAt = null
  let restartedAt = null
  let nextSnap = Date.now() + 15_000
  await watchFor(WATCH * 1000, async () => {
    if (goneAt === null && !existsSync(marker)) {
      goneAt = t()
      say(`MARKER ${w} GONE`)
    }
    if (Date.now() > nextSnap || restartedAt === null) {
      all = processes()
      const now = claudes(all).map((p) => p.pid)
      const fresh = now.filter((pid) => !before.has(pid))
      if (restartedAt === null && fresh.length) {
        restartedAt = t()
        say(`NEW claude.exe ${fresh.join(',')} (old still alive: ${[...before].filter((pid) => now.includes(pid)).join(',') || 'none'})`)
      }
      if (Date.now() > nextSnap) {
        snapshot(`marker ${w}, ${t()}`)
        screen(`marker ${w}, ${t()}`)
        nextSnap = Date.now() + 20_000
      }
    }
    return false
  })
  all = processes()
  const now = claudes(all).map((p) => p.pid)
  say(`RESULT write ${w}: marker ${goneAt ? `gone at ${goneAt}` : 'STILL PRESENT'}; claude.exe now ${now.join(',') || 'none'} (before ${[...before].join(',') || 'none'}); ${restartedAt ? `new claude at ${restartedAt}` : 'NO new claude'}; launcher ${alive(all, launcherPid) ? 'alive' : 'GONE'}`)
}

if (args.includes('--kill-claude')) {
  all = processes()
  const victims = claudes(all).map((p) => p.pid)
  say(`KILL CLAUDE (as a daemon ending its own session would): taskkill /F ${victims.join(',') || '(none)'}`)
  for (const pid of victims) spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
  let nextSnap = 0
  await watchFor(Number(opt('after-kill', '45')) * 1000, async () => {
    if (Date.now() > nextSnap) {
      all = processes()
      say(`after kill: launcher ${alive(all, launcherPid) ? 'alive' : 'GONE'}; claude.exe ${claudes(all).map((p) => p.pid).join(',') || 'none'}; supervisor.json ${existsSync(join(stateDir, 'supervisor.json')) ? 'present' : 'absent'}`)
      nextSnap = Date.now() + 10_000
    }
    return false
  })
}
if (Number(opt('hold', '0')) > 0) {
  say(`HOLD ${opt('hold')}s for outside checks`)
  await watchFor(Number(opt('hold')) * 1000, async () => {
    all = processes()
    claudes(all)
    return false
  })
}
all = snapshot('end')
screen('end')
pump()
const readOr = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim() : '(absent)')
say(`FINAL session-id: ${readOr(join(stateDir, 'session-id'))}`)
say(`FINAL supervisor.json: ${readOr(join(stateDir, 'supervisor.json'))}`)
say(`FINAL restart-takeovers.json: ${readOr(join(stateDir, 'restart-takeovers.json')).replace(/\s+/g, ' ')}`)
say(`FINAL claimed/refused: ${readOr(join(stateDir, 'restart-requested.claimed.json'))} / ${readOr(join(stateDir, 'restart-requested.refused.json'))}`)
const dlog = join(home, '.bgos-agent', 'logs', `bgos-plugin-${ID}.log`)
if (existsSync(dlog)) say(`FINAL takeover lines:\n${readFileSync(dlog, 'utf8').split('\n').filter((l) => /restart takeover/.test(l)).map((l) => '   ' + l.slice(0, 400)).join('\n')}`)
say(`FINAL claude.exe: ${claudes(processes()).map((p) => `${p.pid} ppid=${p.ppid} ${p.cmd.replace(/\s+/g, ' ').slice(0, 220)}`).join(' | ') || 'none'}`)

// ── teardown: only processes of this run ─────────────────────────────────────
all = processes()
const kill = new Set()
const addTree = (pid) => {
  kill.add(pid)
  for (const c of all.filter((p) => p.ppid === pid)) addTree(c.pid)
}
for (const pid of launchersSeen) addTree(pid)
for (const p of all) if (mineCmd(p) && p.pid !== process.pid && p.pid !== backend.pid && !/scoped\.mjs|repro2?\.mjs/.test(p.cmd)) addTree(p.pid)
for (const pid of kill) if (all.some((p) => p.pid === pid)) spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
backend.stdin.end()
backend.kill()
await sleep(2000)
const left = processes().filter((p) => mineCmd(p) && p.pid !== process.pid && !/scoped\.mjs|repro2?\.mjs/.test(p.cmd))
say(`teardown: killed ${[...kill].join(',')}; left over: ${left.map((p) => `${p.pid} ${p.name}`).join(', ') || 'none'}`)
const api = existsSync(join(runDir, 'backend.log')) ? readFileSync(join(runDir, 'backend.log'), 'utf8').split('\n').filter((l) => l.includes('"/v1/')).length : 0
say(`claude API calls answered by the fake backend: ${api}`)
process.exit(0)
