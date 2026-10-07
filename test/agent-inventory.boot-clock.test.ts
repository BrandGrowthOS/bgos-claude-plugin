/**
 * Review 3 F1: on Linux a forward step of the wall clock after a stamp made a
 * LIVE writer fail the start-time proof.
 *
 * supervisor.json and keepalive.json carry `startedAt`, the wall clock when
 * they were written, and the proof that a live pid is still their writer was
 * "it started no later than that stamp", with the start computed as
 * `now - etime`. On Linux ps measures etime on the BOOT clock (/proc/uptime
 * minus the process's start in /proc/<pid>/stat), which no wall clock step
 * moves. So when the wall clock was stepped forward after the stamp (a
 * Raspberry Pi with no RTC whose clock NTP corrects after run.sh armed hoai, a
 * WSL2 or other paused VM resynced after host sleep), the computed start moved
 * later than the stamp by the size of the step: the live hoai read as a reused
 * pid (launcherLive false, and a second hoai reclaimed its supervisor.json, two
 * loops on one pin), the daemon's declared-launcher record read as dead, and a
 * live keepalive script stopped being declared (the watcher and the daemon's
 * G11 reading then install beside it).
 *
 * The fix compares on ONE clock on Linux: every stamp also records the boot
 * clock it was written on (`boot: {id, uptimeMs}`, /proc/sys/kernel/random/boot_id
 * and /proc/uptime), and every Linux reading carries the boot id and the
 * process's start on that clock (uptime now minus etime). Another boot means
 * the writer died in a reboot (a reused pid); the same boot compares the start
 * against the stamp's uptime. A stamp or a reading without it (an older writer,
 * darwin, win32, an unreadable /proc) keeps the wall clock rule, which is right
 * on darwin and win32: their ps and CIM report the stored wall start time.
 *
 * Every OS effect is a fake: ps answers from a table, /proc is a map entry.
 *
 * Run: npx tsx --test test/agent-inventory.boot-clock.test.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isLiveHoaiLauncher,
  isSupervisorWriter,
  listAgents,
  parseBootStamp,
  parseLauncherProcesses,
  parseSupervisorRecord,
  readBootClock,
  readDeclaredKeepalive,
  readLauncherProcesses,
  verifyKeepaliveMarker,
} from '../lib/agent-inventory.mjs'
import { decideSupervisorArming, keepaliveMarkerBody, supervisorFileBody } from '../bin/hoai-core.mjs'
import { decideKeepaliveMarkerWrite } from '../bin/hoai-keepalive-marker.mjs'
import { buildDeclaredSupervisorBody, decideSupervisorWrite } from '../lib/update-readiness.ts'
import { readAlwaysOnSupervision } from '../lib/always-on-reconcile.ts'

// -- The scenario: a Raspberry Pi with no RTC, after a power cut ------------------------------------
//
// It boots with its clock an hour behind (fake-hwclock restored the last saved
// time). At uptime 20 s linger starts run.sh, which starts hoai; hoai stamps
// supervisor.json at uptime 25 s with the behind clock. At uptime 100 s NTP
// steps the clock forward by the hour. The watcher looks at uptime 625 s.

const HOME = '/home/pi'
const ROOT = '/home/pi/.claude/plugins/cache/hoai/hoai/0.62.0'
const HOAI = `/usr/bin/node ${ROOT}/bin/hoai-core.mjs`
const DAEMON = `bun ${ROOT}/server.ts`
const BOOT_ID = '4f3c2a10-8b7e-4d21-9a55-0c1e2f3a4b5c'
const R0 = Date.parse('2026-10-07T06:00:00.000Z') // the real time at boot
const BEHIND = 60 * 60_000
const FORK_UPTIME = 20_000
const STAMP_UPTIME = 25_000
const CHECK_UPTIME = 625_000
/** What the wall clock said when hoai stamped the file: an hour behind. */
const STAMP = new Date(R0 + STAMP_UPTIME - BEHIND).toISOString()
/** The wall clock at the check, after the step. */
const NOW = R0 + CHECK_UPTIME
const STAMP_BOOT = { id: BOOT_ID, uptimeMs: STAMP_UPTIME }
const CLOCK_NOW = { id: BOOT_ID, uptimeMs: CHECK_UPTIME }
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000

/** /proc as a Linux box shows it at the check. */
const PROC = {
  '/proc/sys/kernel/random/boot_id': `${BOOT_ID}\n`,
  '/proc/uptime': `${CHECK_UPTIME / 1000}.00 1180.42\n`,
}

/** ps etime ([[dd-]hh:]mm:ss) for a duration in ms. */
function etimeOf(ms: number) {
  const s = Math.floor(ms / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return `${h ? `${pad(h)}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/**
 * A Linux ps for both queries: the launcher batch (`-ww -o pid=,etime=,command= -p`)
 * and the keepalive table (`-A -o pid=,ppid=,uid=,etime=`). Each row is a
 * process forked at `forkUptimeMs` on the boot clock; etime is what ps prints
 * for it at CHECK_UPTIME, which no wall clock step changes.
 */
function linuxPs(rows: Record<number, { command: string; forkUptimeMs: number; ppid?: number; uid?: number }>) {
  const calls: string[][] = []
  const execSync = (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (file !== 'ps') return { code: 1, stdout: '' }
    const etime = (pid: number) => etimeOf(CHECK_UPTIME - rows[pid]!.forkUptimeMs)
    if (args[0] === '-ww' && args[2] === 'pid=,etime=,command=' && args[3] === '-p') {
      const lines = String(args[4]).split(',').map(Number).filter((pid) => rows[pid]).map((pid) => `${String(pid).padStart(6)} ${etime(pid).padStart(11)} ${rows[pid]!.command}`)
      return lines.length ? { code: 0, stdout: `${lines.join('\n')}\n` } : { code: 1, stdout: '' }
    }
    if (args[0] === '-A' && args[2] === 'pid=,ppid=,uid=,etime=') {
      const lines = Object.keys(rows).map(Number).map((pid) => `${pid} ${rows[pid]!.ppid ?? 1} ${rows[pid]!.uid ?? UID} ${etime(pid)}`)
      return { code: 0, stdout: `${lines.join('\n')}\n` }
    }
    if (args[0] === '-o' && args[1] === 'comm=') return { code: 0, stdout: 'claude\n' }
    return { code: 1, stdout: '' }
  }
  return { calls, execSync }
}

function fsWith(files: Record<string, string>) {
  return {
    exists: (p: string) => p in files,
    readFile: (p: string) => files[p] ?? null,
    listDir: (p: string) => {
      const prefix = p.replace(/[\\/]+$/, '') + '/'
      return [...new Set(Object.keys(files).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]!))]
    },
  }
}

test('F1: the live hoai stamped before the clock step is still its file\'s writer: same boot, started before the stamp on the boot clock', () => {
  const ps = linuxPs({ 4242: { command: HOAI, forkUptimeMs: FORK_UPTIME } })
  const raw = supervisorFileBody(4242, STAMP, STAMP_BOOT)
  const record = parseSupervisorRecord(raw)!
  assert.deepEqual(record.boot, STAMP_BOOT)
  const proc = readLauncherProcesses({ platform: 'linux', pids: [4242], execSync: ps.execSync, now: NOW, bootClock: () => CLOCK_NOW }).get(4242)!
  // The wall clock reading moved by the step: on its own it calls the live writer a reused pid.
  assert.ok(proc.startedAtMs! > Date.parse(STAMP) + 60_000, 'the wall clock start lies after the stamp')
  assert.equal(isSupervisorWriter({ startedAtMs: record.startedAtMs }, proc), false, 'the wall clock rule alone: the bug')
  assert.deepEqual(proc.boot, { id: BOOT_ID, startedUptimeMs: FORK_UPTIME })
  assert.equal(isSupervisorWriter(record, proc), true)
  assert.equal(isLiveHoaiLauncher({ supervisor: record, pidAlive: () => true, processes: new Map([[4242, proc]]) }), true)
  // hoai's own singleton guard: a second hoai (run.sh in the incumbent's relaunch gap) refuses.
  assert.deepEqual(decideSupervisorArming({ existingRaw: raw, ownPid: 5555, pidAlive: () => true, pidProcess: () => proc }), { arm: false, ownerPid: 4242 })
})

test('F1: listAgents after the step: hoai\'s record and the daemon\'s declared-launcher record are live (each read through /proc)', () => {
  const declared = buildDeclaredSupervisorBody({ declared: { kind: 'launcher', handle: null, restartCommand: null }, pid: 4913, startedAt: STAMP, boot: STAMP_BOOT })
  const files = {
    ...PROC,
    [`${HOME}/.bgos-agent/credentials-912.json`]: '{}',
    [`${HOME}/.bgos-agent/credentials-913.json`]: '{}',
    [`${HOME}/.bgos-agent/912/supervisor.json`]: supervisorFileBody(4912, STAMP, STAMP_BOOT),
    [`${HOME}/.bgos-agent/913/supervisor.json`]: declared,
  }
  const ps = linuxPs({ 4912: { command: HOAI, forkUptimeMs: FORK_UPTIME }, 4913: { command: DAEMON, forkUptimeMs: FORK_UPTIME + 2000 } })
  const agents = listAgents({ home: HOME, env: {}, platform: 'linux', fs: fsWith(files), pidAlive: () => true, execSync: ps.execSync, now: NOW, uid: UID })
  assert.deepEqual(agents.map((a) => [a.assistantId, a.launcherLive, a.supervisor]), [['912', true, 'launcher-live'], ['913', true, 'launcher-live']])
})

test('F1: a live keepalive script stays declared after the step: the watcher\'s reading and the daemon\'s G11 reading both see it', () => {
  const marker = keepaliveMarkerBody({ pid: 3100, claudePid: 3200, tmuxSession: 'agent-912', startedAt: STAMP, boot: STAMP_BOOT })
  const files = { ...PROC, [`${HOME}/.bgos-agent/912/keepalive.json`]: marker }
  const ps = linuxPs({ 3100: { command: 'bash keepalive.sh', forkUptimeMs: FORK_UPTIME }, 3200: { command: 'claude', forkUptimeMs: FORK_UPTIME + 1000, ppid: 3100 } })
  const probe = { platform: 'linux', home: HOME, assistantId: '912', readFile: (p: string) => (files as Record<string, string>)[p] ?? null, pidAlive: () => true, execSync: ps.execSync, now: NOW, uid: UID }
  assert.deepEqual(readDeclaredKeepalive(probe), { pid: 3100, claudePid: 3200, tmuxSession: 'agent-912' })
  assert.deepEqual(verifyKeepaliveMarker(probe), { pid: 3100, claudePid: 3200, tmuxSession: 'agent-912' }, 'its claude is proven too (it descends from the script)')
  // The daemon's G11 reading (lib/always-on-reconcile.ts) runs the same rule with its own clock.
  const realNow = Date.now
  Date.now = () => NOW
  try {
    assert.deepEqual(readAlwaysOnSupervision({ platform: 'linux', home: HOME, assistantId: '912', readFile: probe.readFile, pidAlive: () => true, execSync: ps.execSync } as never), {
      state: 'other',
      other: { kind: 'keepalive', handle: 'agent-912', via: 'keepalive-declared' },
    })
  } finally {
    Date.now = realNow
  }
})

test('F1: the boot clock still catches a reused pid, where the wall clock could not: a start after the stamp on that clock, or another boot', () => {
  const record = parseSupervisorRecord(supervisorFileBody(4242, STAMP, STAMP_BOOT))!
  // Same boot, forked five minutes after the stamp while the clock went BACK an
  // hour (a VM resync the other way): the wall clock start reads before the stamp.
  const later = { command: HOAI, startedAtMs: Date.parse(STAMP) - 55 * 60_000, boot: { id: BOOT_ID, startedUptimeMs: STAMP_UPTIME + 5 * 60_000 } }
  assert.equal(isSupervisorWriter(record, later), false)
  assert.equal(isSupervisorWriter(record, { ...later, boot: { id: BOOT_ID, startedUptimeMs: STAMP_UPTIME + 60_000 } }), true, 'inside the slack')
  assert.equal(isSupervisorWriter(record, { ...later, boot: { id: BOOT_ID, startedUptimeMs: STAMP_UPTIME + 60_001 } }), false)
  // Another boot: the Pi lost power again and came back with its clock restored
  // BEHIND the stamp; the stale file's pid now belongs to a process run at boot.
  // Its wall clock start is before the stamp, so the old rule called it the
  // writer and the agent stayed down behind it.
  const reused = { command: HOAI, startedAtMs: Date.parse(STAMP) - 10 * 60_000, boot: { id: '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4', startedUptimeMs: 12_000 } }
  assert.equal(isSupervisorWriter({ startedAtMs: record.startedAtMs }, reused), true, 'the wall clock rule alone')
  assert.equal(isSupervisorWriter(record, reused), false)
  assert.deepEqual(decideSupervisorArming({ existingRaw: supervisorFileBody(4242, STAMP, STAMP_BOOT), ownPid: 5555, pidAlive: () => true, pidProcess: () => reused }), { arm: true, reclaimedStale: true })
  // The same for keepalive.json: a marker from the boot before declares nothing.
  const files: Record<string, string> = {
    '/proc/sys/kernel/random/boot_id': '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4\n',
    '/proc/uptime': `${CHECK_UPTIME / 1000}.00 1180.42\n`,
    [`${HOME}/.bgos-agent/912/keepalive.json`]: keepaliveMarkerBody({ pid: 3100, claudePid: 3200, tmuxSession: null, startedAt: STAMP, boot: STAMP_BOOT }),
  }
  const ps = linuxPs({ 3100: { command: 'bash keepalive.sh', forkUptimeMs: 1000 } })
  assert.equal(readDeclaredKeepalive({ platform: 'linux', home: HOME, assistantId: '912', readFile: (p: string) => files[p] ?? null, pidAlive: () => true, execSync: ps.execSync, now: Date.parse(STAMP) + 60_000, uid: UID }), null)
})

test('F1: without the boot clock on BOTH sides the wall clock rule stands (an older writer, darwin, win32, an unreadable /proc)', () => {
  const stamp = Date.parse(STAMP)
  const onBoot = { command: HOAI, startedAtMs: stamp + 3_600_000, boot: { id: BOOT_ID, startedUptimeMs: FORK_UPTIME } }
  // An older writer's record: no boot stamp, so the wall clock decides.
  assert.equal(isSupervisorWriter(parseSupervisorRecord(supervisorFileBody(4242, STAMP))!, onBoot), false)
  // A reading without the boot clock (darwin, or /proc unreadable).
  const record = parseSupervisorRecord(supervisorFileBody(4242, STAMP, STAMP_BOOT))!
  assert.equal(isSupervisorWriter(record, { command: HOAI, startedAtMs: stamp + 3_600_000 }), false)
  assert.equal(isSupervisorWriter(record, { command: HOAI, startedAtMs: stamp - 1000 }), true)
  // darwin's etime is the wall clock already: no boot clock is attached there, even when one is offered.
  const darwin = parseLauncherProcesses('darwin', `  4242       10:05 ${HOAI}\n`, [4242], NOW, CLOCK_NOW)
  assert.deepEqual(darwin.get(4242), { command: HOAI, startedAtMs: NOW - 605_000 })
  const linux = parseLauncherProcesses('linux', `  4242       10:05 ${HOAI}\n`, [4242], NOW, CLOCK_NOW)
  assert.deepEqual(linux.get(4242), { command: HOAI, startedAtMs: NOW - 605_000, boot: { id: BOOT_ID, startedUptimeMs: FORK_UPTIME } })
  assert.deepEqual(parseLauncherProcesses('linux', `  4242       10:05 ${HOAI}\n`, [4242], NOW).get(4242), { command: HOAI, startedAtMs: NOW - 605_000 }, 'no clock, no boot reading')
  // The command line still has its say on the boot clock path.
  assert.equal(isSupervisorWriter(record, { command: '/usr/sbin/cupsd -l', startedAtMs: null, boot: { id: BOOT_ID, startedUptimeMs: 1000 } }), false)
})

test('F1: readBootClock reads /proc on Linux only, and anything junk is null; parseBootStamp is strict', () => {
  const read = (files: Record<string, string>) => (p: string) => files[p] ?? null
  assert.deepEqual(readBootClock({ platform: 'linux', readFile: read(PROC) }), CLOCK_NOW)
  assert.deepEqual(readBootClock({ platform: 'linux', readFile: read({ ...PROC, '/proc/uptime': '7.5 1.0\n' }) }), { id: BOOT_ID, uptimeMs: 7500 })
  let asked = 0
  assert.equal(readBootClock({ platform: 'darwin', readFile: () => (asked++, 'x') }), null)
  assert.equal(readBootClock({ platform: 'win32', readFile: () => (asked++, 'x') }), null)
  assert.equal(asked, 0, 'nothing is read off Linux')
  assert.equal(readBootClock({ platform: 'linux', readFile: read({ '/proc/uptime': PROC['/proc/uptime'] }) }), null, 'no boot id')
  assert.equal(readBootClock({ platform: 'linux', readFile: read({ ...PROC, '/proc/uptime': 'junk' }) }), null)
  assert.equal(readBootClock({ platform: 'linux', readFile: read({ ...PROC, '/proc/sys/kernel/random/boot_id': '\n' }) }), null)
  assert.equal(readBootClock({ platform: 'linux', readFile: () => { throw new Error('EACCES') } }), null)
  assert.deepEqual(parseBootStamp({ id: BOOT_ID, uptimeMs: 25_000 }), STAMP_BOOT)
  for (const junk of [null, 'x', [], { id: BOOT_ID }, { uptimeMs: 1 }, { id: '', uptimeMs: 1 }, { id: BOOT_ID, uptimeMs: -1 }, { id: BOOT_ID, uptimeMs: '1' }, { id: 'x'.repeat(65), uptimeMs: 1 }]) {
    assert.equal(parseBootStamp(junk), null, JSON.stringify(junk))
  }
})

test('F1: every writer stamps the boot clock with startedAt (and only when it has one): hoai, the keepalive marker, the daemon', () => {
  assert.deepEqual(JSON.parse(supervisorFileBody(42, STAMP, STAMP_BOOT)), { pid: 42, capabilities: ['relaunch'], startedAt: STAMP, boot: STAMP_BOOT })
  assert.deepEqual(JSON.parse(supervisorFileBody(42, STAMP)), { pid: 42, capabilities: ['relaunch'], startedAt: STAMP })
  assert.deepEqual(JSON.parse(keepaliveMarkerBody({ pid: 3100, claudePid: 3200, startedAt: STAMP, boot: STAMP_BOOT })).boot, STAMP_BOOT)
  assert.equal('boot' in JSON.parse(keepaliveMarkerBody({ pid: 3100, claudePid: 3200, startedAt: STAMP })), false)
  const write = decideKeepaliveMarkerWrite({ argv: ['--assistant', '912', '--keepalive-pid', '3100', '--claude-pid', '3200'], home: HOME, startedAt: STAMP, boot: STAMP_BOOT })
  assert.equal(write.action, 'write')
  assert.deepEqual(JSON.parse((write as { body: string }).body).boot, STAMP_BOOT)
  const declared = JSON.parse(buildDeclaredSupervisorBody({ declared: { kind: 'launcher', handle: null, restartCommand: null }, pid: 9, startedAt: STAMP, boot: STAMP_BOOT }))
  assert.deepEqual(declared.boot, STAMP_BOOT)
  assert.equal(parseSupervisorRecord(JSON.stringify(declared))!.declaredLauncher, true)
  const decision = decideSupervisorWrite({
    env: { BGOS_SUPERVISOR_KIND: 'launcher' },
    existingRaw: null,
    ownPid: 9,
    startedAt: STAMP,
    boot: STAMP_BOOT,
    detection: { supervised: 'none', service: null } as never,
  })
  assert.equal(decision.action, 'write')
  assert.deepEqual(JSON.parse((decision as { body: string }).body).boot, STAMP_BOOT)
})

test('F1: the two production writers that touch the real disk read the boot clock with their stamp (source contracts)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const start = server.indexOf('function writeSupervisorRecordAtBoot(): void {')
  assert.ok(start > 0)
  const boot = server.slice(start, server.indexOf('\n}\n', start))
  assert.match(boot, /startedAt: new Date\(\)\.toISOString\(\),\n[^\n]*\n      boot: readBootClock\(\{ platform: process\.platform \}\),\n/)
  const marker = readFileSync(join(root, 'bin', 'hoai-keepalive-marker.mjs'), 'utf8')
  const main = marker.slice(marker.indexOf('export function main('))
  assert.match(main, /startedAt: new Date\(\)\.toISOString\(\),\n    boot: readBootClock\(\{ platform: process\.platform \}\),\n/)
})
