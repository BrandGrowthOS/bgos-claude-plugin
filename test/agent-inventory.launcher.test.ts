/**
 * lib/agent-inventory.mjs, the supervisor.json pid identity (plugin-supervisor
 * review F1).
 *
 * A supervisor.json is left behind whenever its launcher dies without its
 * finally block (a power cut, a panic, a SIGKILL, a Windows logoff). After a
 * reboot its pid can belong to ANY process, and "alive" alone then kept a dead
 * agent's launcher live for as long as that unrelated process ran: on Windows
 * the sweep never started the agent's task, and hoai itself refused to arm.
 * So a supervisor.json pid is a live hoai launcher only when it is alive AND
 * its command line still runs hoai-core.mjs; a command line that cannot be read
 * keeps the liveness answer. bin/hoai-core.mjs decideSupervisorArming reads the
 * same query (test/hoai-supervise.test.ts pins that side).
 *
 * Every OS effect is a fake: the exec answers from a table.
 *
 * Run: npx tsx --test test/agent-inventory.launcher.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HOAI_LAUNCHER_SCRIPT,
  isLiveHoaiLauncher,
  launcherCommandLineQuery,
  listAgents,
  parseLauncherCommandLines,
  readLauncherCommandLines,
  resolveAgentSupervisor,
  runsHoaiLauncher,
} from '../lib/agent-inventory.mjs'
import { supervisorFileBody } from '../bin/hoai-core.mjs'

const HOME = '/home/kc'
const HOAI_CMD = '/opt/homebrew/bin/node /Users/kc/.claude/plugins/cache/hoai/hoai/0.62.0/bin/hoai-core.mjs'

/** A sync exec that answers the posix batch query (ps -ww -o pid=,command= -p a,b) from a table. */
function psExec(commands: Record<number, string>) {
  const calls: string[][] = []
  const execSync = (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (file !== 'ps' || args[0] !== '-ww' || args[1] !== '-o' || args[2] !== 'pid=,command=' || args[3] !== '-p') return { code: 1, stdout: '' }
    const lines = String(args[4]).split(',').map(Number).filter((pid) => commands[pid] !== undefined).map((pid) => `${String(pid).padStart(6)} ${commands[pid]}`)
    return lines.length ? { code: 0, stdout: `${lines.join('\n')}\n` } : { code: 1, stdout: '' }
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

test('the query: unlimited-width ps on posix (a cut line loses the very file name), one PowerShell CIM query on win32, digits only', () => {
  assert.equal(HOAI_LAUNCHER_SCRIPT, 'hoai-core.mjs')
  assert.deepEqual(launcherCommandLineQuery('darwin', [4242]), { file: 'ps', args: ['-ww', '-o', 'pid=,command=', '-p', '4242'] })
  assert.deepEqual(launcherCommandLineQuery('linux', [12, 34]), { file: 'ps', args: ['-ww', '-o', 'pid=,command=', '-p', '12,34'] })
  const win = launcherCommandLineQuery('win32', [12, 34])
  assert.equal(win?.file, 'powershell.exe')
  assert.deepEqual(win?.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  assert.match(win!.args[3]!, /Get-CimInstance Win32_Process -Filter 'ProcessId=12 OR ProcessId=34'/)
  assert.match(win!.args[3]!, /CommandLine/)
  assert.match(win!.args[3]!, /ConvertTo-Json -Compress/)
  // Nothing that is not a positive integer pid ever reaches the command.
  assert.equal(launcherCommandLineQuery('linux', []), null)
  assert.deepEqual(launcherCommandLineQuery('linux', [0, -1, 1.5, Number.NaN, '7;rm' as never, 9]), { file: 'ps', args: ['-ww', '-o', 'pid=,command=', '-p', '9'] })
})

test('parseLauncherCommandLines: only the pids asked for, an empty or null command line is unreadable (absent)', () => {
  const posix = parseLauncherCommandLines('darwin', `  4242 ${HOAI_CMD}\n   77 /usr/sbin/cupsd -l\n  999 /not/asked/for\n   55 \n`, [4242, 77, 55])
  assert.deepEqual([...posix.entries()], [[4242, HOAI_CMD], [77, '/usr/sbin/cupsd -l']])
  const one = parseLauncherCommandLines('win32', JSON.stringify({ ProcessId: 12, CommandLine: '"C:\\node.exe" C:\\p\\bin\\hoai-core.mjs --keep-alive' }), [12])
  assert.equal(one.get(12), '"C:\\node.exe" C:\\p\\bin\\hoai-core.mjs --keep-alive')
  const many = parseLauncherCommandLines('win32', JSON.stringify([{ ProcessId: 12, CommandLine: 'svchost.exe -k' }, { ProcessId: 34, CommandLine: null }, { ProcessId: 56, CommandLine: 'x' }]), [12, 34])
  assert.deepEqual([...many.entries()], [[12, 'svchost.exe -k']], 'a null CommandLine (another session) is unreadable, an unasked pid is ignored')
  assert.equal(parseLauncherCommandLines('win32', 'not json', [12]).size, 0)
  assert.equal(parseLauncherCommandLines('win32', '', [12]).size, 0)
})

test('readLauncherCommandLines: one exec for the whole fleet, none without pids or without an exec, never throws', () => {
  const ps = psExec({ 4242: HOAI_CMD, 77: '/usr/sbin/cupsd -l' })
  const got = readLauncherCommandLines({ platform: 'linux', pids: [4242, 77, 4242], execSync: ps.execSync })
  assert.equal(ps.calls.length, 1, 'one query, deduplicated')
  assert.deepEqual(ps.calls[0], ['ps', '-ww', '-o', 'pid=,command=', '-p', '4242,77'])
  assert.equal(got.get(4242), HOAI_CMD)
  assert.equal(got.get(77), '/usr/sbin/cupsd -l')
  assert.equal(readLauncherCommandLines({ platform: 'linux', pids: [], execSync: ps.execSync }).size, 0)
  assert.equal(ps.calls.length, 1, 'no pids, no process')
  assert.equal(readLauncherCommandLines({ platform: 'linux', pids: [1] }).size, 0, 'no exec: nothing readable')
  const throwing = () => {
    throw new Error('spawn failed')
  }
  assert.equal(readLauncherCommandLines({ platform: 'linux', pids: [1], execSync: throwing }).size, 0)
})

test('runsHoaiLauncher and isLiveHoaiLauncher: alive AND running hoai-core.mjs; unreadable keeps the liveness answer', () => {
  assert.equal(runsHoaiLauncher(HOAI_CMD), true)
  assert.equal(runsHoaiLauncher('/usr/sbin/cupsd -l'), false)
  assert.equal(runsHoaiLauncher(null), true, 'cannot be read: liveness alone, as before')
  assert.equal(runsHoaiLauncher(undefined), true)
  const supervisor = { pid: 4242, capabilities: ['relaunch'] }
  const lines = (entries: Array<[number, string]>) => new Map(entries)
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => true, commandLines: lines([[4242, HOAI_CMD]]) }), true)
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => true, commandLines: lines([[4242, '/usr/sbin/cupsd -l']]) }), false, 'a reused pid')
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => true, commandLines: lines([]) }), true, 'unreadable')
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => true }), true, 'no command lines at all')
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => false, commandLines: lines([[4242, HOAI_CMD]]) }), false, 'dead')
  assert.equal(isLiveHoaiLauncher({ supervisor: { pid: 4242, capabilities: [] }, pidAlive: () => true }), false, 'no relaunch capability')
  assert.equal(isLiveHoaiLauncher({ supervisor: null, pidAlive: () => true }), false)
})

test('listAgents: a supervisor.json left by a launcher that died uncleanly, whose pid is now an UNRELATED process, is not a live launcher', () => {
  const files = {
    [`${HOME}/.bgos-agent/credentials-912.json`]: '{}',
    [`${HOME}/.bgos-agent/credentials-7.json`]: '{}',
    [`${HOME}/.bgos-agent/credentials-5.json`]: '{}',
    // 912: the stale file, its pid reused after a reboot by an unrelated process.
    [`${HOME}/.bgos-agent/912/supervisor.json`]: supervisorFileBody(626, 'x'),
    // 7: a real, live hoai launcher.
    [`${HOME}/.bgos-agent/7/supervisor.json`]: supervisorFileBody(4242, 'x'),
    // 5: a live pid whose command line cannot be read (another user's, hidden).
    [`${HOME}/.bgos-agent/5/supervisor.json`]: supervisorFileBody(888, 'x'),
  }
  const ps = psExec({ 626: '/usr/libexec/rapportd', 4242: HOAI_CMD })
  const agents = listAgents({ home: HOME, env: {}, platform: 'linux', fs: fsWith(files), pidAlive: () => true, execSync: ps.execSync })
  const byId = Object.fromEntries(agents.map((a) => [a.assistantId, a]))
  assert.equal(byId['912']!.launcherLive, false, 'the reused pid is not this agent\'s launcher')
  assert.equal(byId['912']!.supervisor, 'none', 'and not a restart authority either')
  assert.equal(byId['912']!.running, false)
  assert.equal(byId['7']!.launcherLive, true)
  assert.equal(byId['7']!.supervisor, 'launcher-live')
  assert.equal(byId['5']!.launcherLive, true, 'unreadable: the liveness answer stands')
  assert.equal(byId['5']!.supervisor, 'launcher-live')
  const queries = ps.calls.filter((c) => c[0] === 'ps' && c[1] === '-ww')
  assert.equal(queries.length, 1, 'one command line query for the whole inventory')
  assert.deepEqual(queries[0]!.slice(-1)[0]!.split(',').map(Number).sort((a, b) => a - b), [626, 888, 4242])
})

test('listAgents: no live launcher pid, no command line query at all (the heartbeat lists agents every minute)', () => {
  const files = {
    [`${HOME}/.bgos-agent/credentials-912.json`]: '{}',
    [`${HOME}/.bgos-agent/912/supervisor.json`]: supervisorFileBody(626, 'x'),
  }
  const ps = psExec({ 626: HOAI_CMD })
  const [row] = listAgents({ home: HOME, env: {}, platform: 'linux', fs: fsWith(files), pidAlive: () => false, execSync: ps.execSync })
  assert.equal(row!.launcherLive, false)
  assert.equal(ps.calls.filter((c) => c[0] === 'ps' && c[1] === '-ww').length, 0)
})

test('resolveAgentSupervisor on its own (no inventory batch) reads the one pid itself, and without an exec keeps the liveness answer', () => {
  const sup = `${HOME}/.bgos-agent/912/supervisor.json`
  const probe = {
    platform: 'linux',
    home: HOME,
    assistantId: '912',
    exists: () => false,
    readFile: (p: string) => (p === sup ? supervisorFileBody(626, 'x') : null),
    pidAlive: (pid: number) => pid === 626,
  }
  assert.equal(resolveAgentSupervisor({ ...probe, execSync: psExec({ 626: '/usr/libexec/rapportd' }).execSync }).supervisor, 'none')
  assert.equal(resolveAgentSupervisor({ ...probe, execSync: psExec({ 626: HOAI_CMD }).execSync }).supervisor, 'launcher-live')
  assert.equal(resolveAgentSupervisor(probe).supervisor, 'launcher-live', 'no exec: liveness only, as before')
})

test('win32: the Windows agent task\'s launcher (`node ...\\bin\\hoai-core.mjs --keep-alive`) is recognised, a reused pid is not', () => {
  const W = 'C:\\Users\\kc'
  const files = {
    [`${W}\\.bgos-agent\\credentials-912.json`]: '{}',
    [`${W}\\.bgos-agent\\912\\run-agent.vbs`]: "' vbs",
    [`${W}\\.bgos-agent\\912\\supervisor.json`]: supervisorFileBody(777, 'x'),
  }
  const winExec = (answer: unknown) => (file: string) =>
    file === 'powershell.exe' ? { code: 0, stdout: JSON.stringify(answer) } : { code: 1, stdout: '' }
  const fs = {
    exists: (p: string) => p in files,
    readFile: (p: string) => (files as Record<string, string>)[p] ?? null,
    listDir: (p: string) => (p === `${W}\\.bgos-agent` ? ['credentials-912.json', '912'] : []),
  }
  const live = listAgents({ home: W, env: {}, platform: 'win32', fs, pidAlive: () => true, execSync: winExec({ ProcessId: 777, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\p\\bin\\hoai-core.mjs" --keep-alive' }) })
  assert.equal(live[0]!.launcherLive, true)
  const reused = listAgents({ home: W, env: {}, platform: 'win32', fs, pidAlive: () => true, execSync: winExec({ ProcessId: 777, CommandLine: 'C:\\Windows\\System32\\svchost.exe -k netsvcs' }) })
  assert.equal(reused[0]!.launcherLive, false, 'so the sweep starts the agent\'s task again')
})
