#!/usr/bin/env node
/**
 * Fifteen agents on one computer, each its own process (Windows node), each
 * running the REAL controller (lib/idle-update.mjs createIdleUpdate) on the
 * REAL disk of a scratch HOME, on the real clock (scaled). They share the
 * lease, spacing and canary files exactly as fifteen daemons of one computer
 * do. This script is their supervisor: when a controller's restart is taken,
 * that process ends and is started again on the new version, as hoai does.
 *
 * Why not the real chain (rig.mjs stagger): each real agent commits about
 * 0.9 GB (bun server.ts and the compiled stand-in claude), so fifteen need
 * about 13 GB, past the 4 GB a probe may use on this box. rig.mjs proves the
 * chain (hoai, claude, the daemon, the session kept) with a few agents; this
 * proves the stagger with fifteen, at about 50 MB each.
 *
 * What is a fake: the process table each controller reads (the gen-2 Mac shape
 * of the report), the turn and backend facts (idle, live), and the restart
 * itself (the controller's ask is taken; the supervisor relaunches). No
 * scheduled task is created; they are listed before and after and must be
 * identical. Every process is ended by its exact pid.
 *
 * usage (Windows node, from the plugin root):
 *   node docs/idle-update/rig/stagger-many.mjs --run-dir E:\...\rig-run [--agents 15] [--scale 5]
 * Prints RIG PASS many or RIG FAIL many: <why>, and writes <scenario dir>\result.json.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const PLUGIN = resolve(dirname(SELF), '..', '..', '..')
const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}
const FROM = '0.81.0'
const TARGET = '0.81.1'
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const MEMORY_CAP = 3.8 * 1024 ** 3

const pinFor = (id) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`

/** The gen-2 Mac chain of one agent, as its controller reads it: launchd, tmux, sh, hoai, expect, claude, the daemon. */
function table(id) {
  const b = id * 100
  return [
    { pid: 1, ppid: 0, command: '/sbin/launchd' },
    { pid: b, ppid: 1, command: `tmux -f /dev/null -L hoai-${id}-home-abc new-session -d -s hoai-${id}-home-abc` },
    { pid: b + 10, ppid: b, command: '/bin/sh -c exec "$@" hoai-stderr' },
    { pid: b + 20, ppid: b + 10, command: '/usr/local/bin/node /Users/a/plugin/bin/hoai-core.mjs' },
    { pid: b + 30, ppid: b + 20, command: 'expect -c spawn claude' },
    { pid: b + 40, ppid: b + 30, command: `/Users/a/.local/bin/claude --dangerously-skip-permissions --resume ${pinFor(id)}` },
    { pid: b + 50, ppid: b + 40, command: 'bun /Users/a/plugin/server.ts' },
  ]
}

// -- One agent's daemon (a child process) ----------------------------------------------------------

async function child() {
  const m = await import(pathToFileURL(join(PLUGIN, 'lib', 'idle-update.mjs')).href)
  const id = Number(flag('--id'))
  const version = flag('--version')
  const dir = flag('--dir')
  const scale = Number(flag('--scale', '5'))
  const firstBoot = version === FROM
  const home = join(dir, 'home')
  const stateDir = join(home, '.bgos-agent', String(id))
  mkdirSync(stateDir, { recursive: true })
  const emit = (ev) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), id, version, ...ev })}\n`)
  const b = id * 100
  const bootAtMs = firstBoot ? Date.now() - 3 * HOUR : Date.now()
  // A relaunched daemon completes its startup a moment after it boots, as server.ts does.
  const startupAtMs = Date.now() + 2 * SEC
  const launcherStartedAtMs = Date.now() - 3 * HOUR
  const c = m.createIdleUpdate({
    assistantId: String(id),
    ownPid: b + 50,
    platform: 'darwin',
    bootAtMs,
    runningVersion: version,
    installMethod: 'marketplace',
    fromRoot: join(dir, 'cache', version),
    fromCommit: null,
    durations: m.scaledDurations(scale),
    paths: { record: join(stateDir, m.IDLE_UPDATE_FILE_NAME), machineDir: join(home, '.bgos-agent', m.IDLE_UPDATE_DIR_NAME) },
    fs: m.nodeIdleUpdateFs(),
    now: Date.now,
    random: Math.random,
    nonce: () => `${id}-${process.pid}-${Date.now()}`,
    autoUpdateEnabled: () => true,
    stagedVersion: () => (version === FROM && existsSync(join(dir, 'staged.txt')) ? TARGET : null),
    active: () => true,
    holdsLock: () => true,
    watcherSweepActive: () => false,
    authorityKind: () => 'service',
    serviceOwnsUs: () => false,
    draining: () => false,
    updateLockHeld: () => false,
    markerMtimeMs: () => null,
    safeState: () => ({ turnInFlight: false, turnSignal: 'hooks', pendingMessages: 0, pendingPermissions: 0, activeOperations: 0 }),
    activityMs: () => [bootAtMs],
    openAsks: () => 0,
    goalRunning: () => false,
    call: () => ({ pendingConsults: 0, openContinuations: 0, lastVoiceAtMs: null, openMeetings: 0 }),
    lastBrowserToolAtMs: () => null,
    claudePid: () => b + 40,
    sessionId: async () => pinFor(id),
    listProcesses: async () => ({ ok: true, processes: table(id) }),
    launcher: () => ({ pid: b + 20, startedAtMs: launcherStartedAtMs, markerPath: join(stateDir, 'restart-requested.json'), supervisorMtimeMs: launcherStartedAtMs }),
    unattendedInputs: () => ({
      ownSockets: [`hoai-${id}-home-abc`, `hoai-${id}`],
      runShPath: `/Users/a/.bgos-agent/${id}/run.sh`,
      launchStatus: { outcome: null, mtimeMs: null },
      runAgentVbs: { text: null, mtimeMs: null },
    }),
    personAttached: async () => false,
    wakeSchedule: async () => ({ ok: true, tasks: [] }),
    serviceStrays: async () => ({ ok: true, strays: [] }),
    startupComplete: () => Date.now() >= startupAtMs,
    // Live delivery: the heartbeat answers and the channel beacon is touched, as on a healthy build.
    heartbeatOkAtMs: () => (Date.now() >= startupAtMs ? Date.now() - SEC : null),
    beaconAtMs: () => (Date.now() >= startupAtMs ? Date.now() - SEC : null),
    deaf: () => false,
    loginExpired: () => false,
    backendUnreachable: () => false,
    monotonicNow: () => performance.now(),
    requestHeartbeat: () => {},
    drain: (on) => emit({ ev: 'drain', on }),
    restart: async (target) => {
      emit({ ev: 'restart', target })
      // The ladder took it: the supervisor ends this daemon and starts the new build.
      setTimeout(() => process.exit(0), 500)
      return true
    },
    restartRollback: async (target) => {
      emit({ ev: 'rollback_restart', target })
      return false
    },
    rollbackInstall: async () => {
      emit({ ev: 'rollback_install' })
      return { ok: false, reason: 'not_in_this_rig' }
    },
    report: (err) => emit({ ev: 'report', err }),
    log: (line) => emit({ ev: 'log', line }),
    setInterval,
    clearInterval,
  })
  emit({ ev: 'boot' })
  c.start()
  // Kept alive by the supervisor until it ends this process by its pid.
  setInterval(() => {}, HOUR)
}

if (args.includes('--child')) {
  await child()
} else {
  await supervisor()
}

// -- The supervisor (this computer's fifteen hoai) -------------------------------------------------

async function supervisor() {
  const runDir = flag('--run-dir')
  const count = Number(flag('--agents', '15'))
  const scale = Number(flag('--scale', '5'))
  if (!runDir) {
    console.error('usage: stagger-many.mjs --run-dir <dir> [--agents 15] [--scale 5]')
    process.exit(2)
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const dir = join(runDir, `many-${stamp}`)
  const home = join(dir, 'home')
  const machineDir = join(home, '.bgos-agent', 'idle-update')
  mkdirSync(join(dir, 'agents'), { recursive: true })
  const say = (line) => {
    const text = `[many ${new Date().toISOString().slice(11, 19)}] ${line}`
    console.log(text)
    appendFileSync(join(dir, 'progress.log'), `${text}\n`)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const results = { scenario: 'many', scale, agents: count, from: FROM, target: TARGET, dir, checks: [], launches: {} }
  const check = (name, ok, detail) => {
    results.checks.push({ name, ok: Boolean(ok), detail })
    say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }

  const TASKS_SCRIPT =
    "Get-ScheduledTask | Sort-Object TaskPath,TaskName | ForEach-Object { $a = ($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -join ' ; '; \"$($_.TaskPath)$($_.TaskName)`t$a\" }"
  const scheduledTasks = (label) => {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TASKS_SCRIPT], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    if (res.status !== 0) throw new Error(`could not list scheduled tasks (${label})`)
    const text = res.stdout.replace(/\r/g, '')
    writeFileSync(join(dir, `scheduled-tasks-${label}.txt`), text)
    return { count: text.split('\n').filter(Boolean).length, sha: createHash('sha256').update(text).digest('hex') }
  }
  /** Private bytes of the processes this script started (and itself), by exact pid. */
  const privateBytes = (pids) =>
    new Promise((done) => {
      const list = [...pids].join(',')
      const ps = `Get-CimInstance Win32_Process -Filter "ProcessId=${[...pids].join(' OR ProcessId=')}" | Measure-Object -Property PrivatePageCount -Sum | ForEach-Object { $_.Sum }`
      if (!list) return done(0)
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 60 * SEC }, (err, stdout) => done(err ? null : Number(String(stdout).trim()) || 0))
    })

  const live = new Map() // id -> ChildProcess
  const launches = new Map() // id -> [{ version, at, pid }]
  const events = []
  let unexpected = null
  let stopping = false
  const launch = (id, version) => {
    const proc = spawn(process.execPath, [SELF, '--child', '--id', String(id), '--version', version, '--dir', dir, '--scale', String(scale)], {
      cwd: PLUGIN,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    live.set(id, proc)
    if (!launches.has(id)) launches.set(id, [])
    launches.get(id).push({ version, at: Date.now(), pid: proc.pid })
    let restarted = false
    let buf = ''
    proc.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        appendFileSync(join(dir, 'agents', `${id}.log`), `${line}\n`)
        try {
          const ev = JSON.parse(line)
          events.push(ev)
          if (ev.ev === 'restart') restarted = true
          if (ev.ev === 'rollback_restart' || ev.ev === 'rollback_install') unexpected ??= `${id}: ${ev.ev}`
        } catch {}
      }
    })
    proc.stderr.on('data', (chunk) => appendFileSync(join(dir, 'agents', `${id}.err`), chunk))
    proc.on('exit', (code) => {
      if (live.get(id) !== proc) return
      live.delete(id)
      if (stopping) return
      if (!restarted) {
        unexpected ??= `${id} on ${version} ended by itself (code ${code})`
        return
      }
      // hoai takes the marker on its next poll and starts claude, which starts the daemon of the new build.
      setTimeout(() => {
        if (!stopping) launch(id, TARGET)
      }, 2 * SEC)
    })
  }

  const record = (id) => {
    try {
      return JSON.parse(readFileSync(join(home, '.bgos-agent', String(id), 'idle-update.json'), 'utf8'))
    } catch {
      return null
    }
  }

  const ids = Array.from({ length: count }, (_, i) => 7500001 + i)
  let failure = null
  let peak = 0
  const tasksBefore = scheduledTasks('before')
  say(`scenario many, ${count} agents, scale ${scale}, dir ${dir}`)
  say(`scheduled tasks before: ${tasksBefore.count} (${tasksBefore.sha.slice(0, 12)})`)
  try {
    for (const id of ids) launch(id, FROM)
    const armedBy = Date.now() + 2 * MIN
    while (ids.some((id) => !events.some((e) => e.id === id && e.ev === 'log' && /armed on/.test(e.line)))) {
      if (Date.now() > armedBy) throw new Error('not every controller armed in 2 min')
      await sleep(SEC)
    }
    say(`all ${count} controllers armed on ${FROM}`)
    writeFileSync(join(dir, 'staged.txt'), TARGET)
    results.stagedAt = new Date().toISOString()
    say(`staged ${TARGET}`)
    const until = Date.now() + 90 * MIN
    let lastOn = -1
    for (;;) {
      if (unexpected) throw new Error(unexpected)
      const pb = await privateBytes([process.pid, ...[...live.values()].map((p) => p.pid)])
      if (pb !== null) {
        peak = Math.max(peak, pb)
        if (pb > MEMORY_CAP) throw new Error(`memory cap: ${(pb / 1024 ** 3).toFixed(2)} GB private`)
      }
      const on = ids.filter((id) => launches.get(id).at(-1).version === TARGET && record(id)?.state === 'validated').length
      if (on !== lastOn) say(`${on}/${count} on ${TARGET}`)
      lastOn = on
      if (on === count) break
      if (Date.now() > until) throw new Error(`timed out: ${on}/${count} validated`)
      await sleep(10 * SEC)
    }
    // Every agent on the target: watch a little longer for a second restart.
    await sleep((3 * MIN) / scale + 10 * SEC)
    if (unexpected) throw new Error(unexpected)
  } catch (err) {
    failure = String(err?.message ?? err)
    say(`error: ${failure}`)
  } finally {
    stopping = true
    for (const [, proc] of live) {
      // Through the child's own handle, held since the spawn: never a pid another process may have been handed.
      proc.kill()
    }
    await sleep(2 * SEC)
  }

  for (const id of ids) results.launches[id] = launches.get(id)?.map((l) => ({ version: l.version, at: new Date(l.at).toISOString() })) ?? []
  const windows = ids
    .map((id) => {
      const rec = record(id)
      const requested = (rec?.attempts ?? []).map((x) => Date.parse(x.at)).filter(Number.isFinite)[0] ?? null
      const relaunch = launches.get(id)?.[1]?.at ?? null
      const validated = Date.parse(rec?.validatedAt ?? '') || null
      return { id, requested, relaunch, validated, canaryN: rec?.canaryN ?? null, state: rec?.state ?? null }
    })
    .sort((x, y) => (x.relaunch ?? Infinity) - (y.relaunch ?? Infinity))
  const iso = (t) => (t ? new Date(t).toISOString() : null)
  results.windows = windows.map((w) => ({ ...w, requested: iso(w.requested), relaunch: iso(w.relaunch), validated: iso(w.validated) }))
  results.peakPrivateGB = Number((peak / 1024 ** 3).toFixed(2))

  check(`all ${count} validated on ${TARGET}`, windows.every((w) => w.state === 'validated'), windows.filter((w) => w.state !== 'validated').map((w) => ({ id: w.id, state: w.state })))
  check(`all ${count} restarted exactly once`, ids.every((id) => launches.get(id)?.length === 2), ids.map((id) => launches.get(id)?.length ?? 0))
  const relaunches = windows.map((w) => w.relaunch).filter(Boolean)
  const gaps = relaunches.slice(1).map((t, i) => t - relaunches[i])
  const spacingMs = (2 * MIN) / scale
  check('no two relaunches together: each gap at least the spacing', gaps.length > 0 && gaps.every((g) => g >= spacingMs), { spacingMs, minGapMs: gaps.length ? Math.min(...gaps) : null })
  let overlap = false
  for (let i = 1; i < windows.length; i++) if (windows[i].relaunch && windows[i - 1].validated && windows[i].relaunch < windows[i - 1].validated) overlap = true
  check("no relaunch before the previous agent's validation", !overlap)
  check('the first agent onto the version was its canary', windows[0]?.canaryN === 1, windows[0])
  check('one attempt per agent', ids.every((id) => (record(id)?.attempts ?? []).filter((a) => a.outcome === 'requested').length === 1))
  check('no rollback anywhere', !events.some((e) => e.ev === 'rollback_restart' || e.ev === 'rollback_install'))
  check('memory under the cap', peak > 0 && peak <= MEMORY_CAP, `${results.peakPrivateGB} GB private at peak`)
  const aliveAfter = [...live.values()].map((p) => p.pid)
  check('no process of ours left alive', aliveAfter.length === 0, aliveAfter)
  const tasksAfter = scheduledTasks('after')
  say(`scheduled tasks after: ${tasksAfter.count} (${tasksAfter.sha.slice(0, 12)})`)
  check('scheduled tasks identical before and after', tasksBefore.sha === tasksAfter.sha, { before: tasksBefore, after: tasksAfter })
  results.failure = failure
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(results, null, 2)}\n`)
  const failed = results.checks.filter((c) => !c.ok)
  if (failure || failed.length) {
    console.log(`RIG FAIL many: ${failure ?? failed.map((c) => c.name).join('; ')}`)
    process.exit(1)
  }
  console.log(`RIG PASS many (${results.checks.length} checks, peak ${results.peakPrivateGB} GB private)`)
}
