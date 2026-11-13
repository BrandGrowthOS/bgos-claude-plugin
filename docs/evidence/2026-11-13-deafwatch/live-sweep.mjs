#!/usr/bin/env node
/**
 * deafwatch live run (mission 298 goal 21): the REAL keep-alive sweep (lib/watcher-keepalive.mjs
 * runKeepAliveSweep) against the REAL process table and a REAL file system, on a throwaway HOME.
 *
 * What is real: `ps`, `lsof` and `readlink` (the listing and the cwd lookup the sweep judges on), the files (a temporary HOME
 * holding agent 912, its canonical systemd unit file, its launch recipe, its pinned session id, an
 * 11 hour old agent-state.json and channel beacon from its last working session, and a plugin root
 * whose bin/bgos-launch.mjs is GONE, as Ares's antivirus left it), a live process whose command line
 * is the agent's claude on its pinned session (`claude --resume <pin> ...`, set by perl's $0) with
 * NO MCP server under it, the pid probes, the clock.
 *
 * What is not: the backend's consent answer (a stub: keep-alive ON for agent 912), and every command
 * that would ACT (systemctl, launchctl, bash, schtasks): this runs on a shared computer, so those are
 * printed as "would run" and answered as a successful act. The verify then waits for the boot hello
 * the missing file means never comes.
 *
 * The clock: the first sweep runs at the real now (the claude is seconds old: a slow start); the
 * second runs with now() six minutes ahead, which is how the sweep sees a claude that has run past its
 * five minute start grace (its start time is the real one the listing reports).
 *
 * Run from the plugin root: node docs/evidence/2026-11-13-deafwatch/live-sweep.mjs
 * Against main (before the fix), the same script prints sweep 2 `supervised` and exits 1: live-sweep.main.out.txt.
 * Paths are printed relative to the temporary HOME (~); nothing outside it is written.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildLaunchRecipe } from '../../../lib/agent-inventory.mjs'
import { nodeExec, nodeFs } from '../../../lib/watcher-bundle.mjs'
import { keepAliveStatePath, runKeepAliveSweep } from '../../../lib/watcher-keepalive.mjs'

const HOME = mkdtempSync(join(tmpdir(), 'deafwatch-'))
const show = (text) => String(text).split(HOME).join('~')
const PIN = '8c1f0000-0000-4000-8000-0000000d0912'
const ID = '912'
const CONFIG = join(HOME, '.claude')
const ROOT = join(CONFIG, 'plugins', 'cache', 'hoai', 'hoai', '0.87.6')
const AVA = join(HOME, 'hoai-agents', 'ava')
const fs = nodeFs()
const T_OLD = Date.now() - 11 * 60 * 60_000
// keepalive-plan CHANNEL_CORE_FILES, written out so this also runs against a plugin from before it (main).
const CHANNEL_CORE_FILES = ['.claude-plugin/plugin.json', 'server.ts', 'bin/bgos-launch.mjs', 'bin/hoai-core.mjs', 'bin/hoai-browser-launch.mjs', 'bin/hoai-browser-mcp.mjs']

// The agent, as a working install leaves it.
for (const rel of CHANNEL_CORE_FILES) fs.writeFile(join(ROOT, rel), rel.endsWith('.json') ? JSON.stringify({ name: 'hoai', mcpServers: { bgos: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/bgos-launch.mjs', '${CLAUDE_PLUGIN_ROOT}/server.ts'] } } }) : '// stub\n')
fs.writeFile(join(CONFIG, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.87.6', installPath: ROOT, lastUpdated: new Date(T_OLD - 60 * 60_000).toISOString() }] } }))
fs.writeFile(join(HOME, '.bgos-agent', `credentials-${ID}.json`), '{"pairingToken":"x"}')
fs.writeFile(join(HOME, '.bgos-agent', ID, 'launch.json'), JSON.stringify(buildLaunchRecipe({ assistantId: ID, cwd: AVA, argv: [], installMethod: 'marketplace', pluginRoot: ROOT, node: process.execPath, startedAt: new Date(T_OLD).toISOString(), pid: null })))
fs.writeFile(join(HOME, '.bgos-agent', ID, 'session-id'), `${PIN}\n`)
fs.writeFile(join(HOME, '.bgos-agent', ID, 'supervisor-generation'), '2\n')
fs.writeFile(join(AVA, '.bgos-agent-id'), `${ID}\n`)
fs.writeFile(join(HOME, '.config', 'systemd', 'user', `bgos-agent-${ID}.service`), `[Service]\nWorkingDirectory=${AVA}\nExecStart=/bin/bash "${join(HOME, '.bgos-agent', ID, 'run.sh')}"\nEnvironment=HOME=${HOME}\n`)
// The last working session's state and beacon: 11 hours old, its daemon long gone.
const stateDir = join(HOME, '.bgos-plugin-state', ID)
fs.writeFile(join(stateDir, 'agent-state.json'), JSON.stringify({ schemaVersion: 1, assistantId: ID, pid: 999_999, claudePid: 999_998, runningVersion: '0.87.6', pendingRestartVersion: null, turnInFlight: false, pendingMessages: 0, pendingPermissions: 0, activeOperations: 0, lastActivityAt: new Date(T_OLD).toISOString(), sessionId: PIN, updatedAt: new Date(T_OLD).toISOString(), turnSignal: 'hooks' }))
fs.writeFile(join(stateDir, 'channel-beacon.json'), JSON.stringify({ beaconAt: T_OLD, pid: 999_999 }))
const { utimesSync } = await import('node:fs')
utimesSync(join(stateDir, 'channel-beacon.json'), T_OLD / 1000, T_OLD / 1000)
// Ares's antivirus: the MCP launcher is gone.
rmSync(join(ROOT, 'bin', 'bgos-launch.mjs'))

// The agent's claude, relaunched on its pin; its bgos MCP server died at once (no child).
const claude = spawn('perl', ['-e', `$0 = "claude --resume ${PIN} --dangerously-load-development-channels server:bgos"; sleep 900`], { stdio: 'ignore', cwd: AVA })
await new Promise((r) => setTimeout(r, 1500))

const realExec = nodeExec()
const acts = []
const exec = async (file, args, opts) => {
  if (file === 'ps' || file === 'lsof' || file === 'readlink') return realExec(file, args, opts)
  acts.push(`${file} ${args.join(' ')}`)
  console.log(`  would run: ${show(`${file} ${args.join(' ')}`)}`)
  return { code: 0, stdout: file === 'systemctl' && args.some((a) => a.startsWith('--property=LoadState')) ? `Environment=HOME=${HOME}\nFragmentPath=${join(HOME, '.config', 'systemd', 'user', `bgos-agent-${ID}.service`)}\nLoadState=loaded\nActiveState=active\n` : '', stderr: '', error: null, timedOut: false }
}
let skewMs = 0
const logs = []
const ctx = {
  home: HOME,
  env: { PATH: process.env.PATH, HOME },
  platform: 'linux',
  fs,
  exec,
  execSync: (file, args) => ({ code: 1, stdout: '' }),
  spawnDetached: (file, args) => {
    console.log(`  would spawn: ${show(`${file} ${args.join(' ')}`)}`)
    return { pid: null }
  },
  kill: (pid, signal) => console.log(`  would signal ${pid} ${signal}`),
  now: () => Date.now() + skewMs,
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 250))),
  log: (line) => logs.push(line),
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  nodePath: process.execPath,
  uid: process.getuid(),
  manifest: { version: '0.87.6', fingerprint: 'f', installedAt: 'x', pluginRoot: ROOT, files: [], claudeConfigDir: null },
  hasTmux: false,
  hasScript: false,
  hasCommand: () => false,
  verifyTimeoutMs: 3_000,
  fetchKeepAlive: async () => ({ ok: true, status: 200, json: { enabled: true, enabledAt: 'x', assistantIds: [912] }, text: '', error: null }),
}

try {
  const listing = await realExec('ps', ['-o', 'pid=,ppid=,lstart=,args=', '-p', String(claude.pid)], {})
  console.log(`the agent's claude, from the real process table:\n  ${listing.stdout.trim()}`)
  console.log(`plugin root ${show(ROOT)}: bin/bgos-launch.mjs present? ${fs.exists(join(ROOT, 'bin', 'bgos-launch.mjs'))}`)

  console.log('\nsweep 1, at the real now (the claude is seconds old, a slow start):')
  const first = await runKeepAliveSweep(ctx)
  console.log(`  heartbeat entry: ${JSON.stringify(first.agents)}`)

  skewMs = 6 * 60_000
  // Ares, 17:29Z: the session had been active minutes before (its transcript written), and the check up
  // held the restart for that (recent_activity). Written here a minute before sweep 2.
  const transcript = join(CONFIG, 'projects', AVA.replace(/[^a-zA-Z0-9]/g, '-'), `${PIN}.jsonl`)
  fs.writeFile(transcript, '{"type":"assistant"}\n')
  utimesSync(transcript, (Date.now() + skewMs - 60_000) / 1000, (Date.now() + skewMs - 60_000) / 1000)
  console.log('\nsweep 2, six minutes on (past the five minute start grace; its transcript written a minute ago):')
  const second = await runKeepAliveSweep(ctx)
  console.log(`  heartbeat entry: ${JSON.stringify(second.agents)}`)
  const record = JSON.parse(fs.readFile(keepAliveStatePath(HOME)) ?? '{}').agents?.[ID]
  console.log(`  keepalive-state.json record: ${JSON.stringify({ state: record?.state, reason: record?.reason, target: record?.target, attempts: record?.attempts, missingFiles: record?.missingFiles })}`)
  console.log('\nthe watcher log:')
  for (const line of logs) console.log(`  ${show(line)}`)
  const ok = first.agents[0]?.state === 'supervised' && second.agents[0]?.state === 'failed' && String(second.agents[0]?.reason).startsWith('no-channel-heartbeat: missing bin/bgos-launch.mjs') && acts.some((a) => a.startsWith('systemctl --user restart'))
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: slow start left alone, deaf channel flagged past the grace, restarted once through its service, reported not fixed, the missing file named`)
  process.exitCode = ok ? 0 : 1
} finally {
  claude.kill('SIGKILL')
  rmSync(HOME, { recursive: true, force: true })
}
