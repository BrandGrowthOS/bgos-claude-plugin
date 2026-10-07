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
 * still the launcher that wrote the file: it started no later than the file's
 * startedAt and runs hoai-core.mjs as its script (delta review F1 below); what
 * cannot be read keeps the liveness answer. bin/hoai-core.mjs
 * decideSupervisorArming reads the same query (test/hoai-core.identity.test.ts
 * pins that side).
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
  isSupervisorWriter,
  launcherProcessQuery,
  listAgents,
  parseLauncherProcesses,
  parseSupervisorRecord,
  readLauncherProcesses,
  resolveAgentSupervisor,
  runsHoaiLauncher,
} from '../lib/agent-inventory.mjs'
import { decideSupervisorArming, supervisorFileBody } from '../bin/hoai-core.mjs'
import { buildDeclaredSupervisorBody } from '../lib/update-readiness.ts'

const HOME = '/home/kc'
const HOAI_CMD = '/opt/homebrew/bin/node /Users/kc/.claude/plugins/cache/hoai/hoai/0.62.0/bin/hoai-core.mjs'

/** A sync exec that answers the posix batch query (ps -ww -o pid=,etime=,command= -p a,b) from a table; every process is an hour old. */
function psExec(commands: Record<number, string>) {
  const calls: string[][] = []
  const execSync = (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (file !== 'ps' || args[0] !== '-ww' || args[1] !== '-o' || args[2] !== 'pid=,etime=,command=' || args[3] !== '-p') return { code: 1, stdout: '' }
    const lines = String(args[4]).split(',').map(Number).filter((pid) => commands[pid] !== undefined).map((pid) => `${String(pid).padStart(6)}    01:00:00 ${commands[pid]}`)
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

test('the query: unlimited-width ps on posix (a cut line loses the very file name) with the locale-free etime, one PowerShell CIM query on win32, digits only', () => {
  assert.equal(HOAI_LAUNCHER_SCRIPT, 'hoai-core.mjs')
  assert.deepEqual(launcherProcessQuery('darwin', [4242]), { file: 'ps', args: ['-ww', '-o', 'pid=,etime=,command=', '-p', '4242'] })
  assert.deepEqual(launcherProcessQuery('linux', [12, 34]), { file: 'ps', args: ['-ww', '-o', 'pid=,etime=,command=', '-p', '12,34'] })
  const win = launcherProcessQuery('win32', [12, 34])
  assert.equal(win?.file, 'powershell.exe')
  assert.deepEqual(win?.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  assert.match(win!.args[3]!, /Get-CimInstance Win32_Process -Filter 'ProcessId=12 OR ProcessId=34'/)
  assert.match(win!.args[3]!, /CommandLine = \$_\.CommandLine/)
  assert.match(win!.args[3]!, /StartedAtMs = \$\(if \(\$_\.CreationDate\) \{ \(\[DateTimeOffset\]\$_\.CreationDate\)\.ToUnixTimeMilliseconds\(\) \}\)/)
  assert.match(win!.args[3]!, /ConvertTo-Json -Compress/)
  assert.match(win!.args[3]!, /^[\x20-\x7e]+$/, 'pure ASCII')
  // Nothing that is not a positive integer pid ever reaches the command.
  assert.equal(launcherProcessQuery('linux', []), null)
  assert.deepEqual(launcherProcessQuery('linux', [0, -1, 1.5, Number.NaN, '7;rm' as never, 9]), { file: 'ps', args: ['-ww', '-o', 'pid=,etime=,command=', '-p', '9'] })
})

test('parseLauncherProcesses: only the pids asked for, the start time from etime against `now`, a half that cannot be read is null, neither is absent', () => {
  const now = Date.parse('2026-10-07T09:00:00.000Z')
  const posix = parseLauncherProcesses('darwin', `  4242 1-02:03:04 ${HOAI_CMD}\n   77       00:05 /usr/sbin/cupsd -l\n  999 01:00 /not/asked/for\n   55 \n   66 junk /bin/x\n`, [4242, 77, 55, 66], now)
  assert.deepEqual([...posix.entries()], [
    [4242, { command: HOAI_CMD, startedAtMs: now - (((24 + 2) * 60 + 3) * 60 + 4) * 1000 }],
    [77, { command: '/usr/sbin/cupsd -l', startedAtMs: now - 5000 }],
    [66, { command: '/bin/x', startedAtMs: null }],
  ])
  const one = parseLauncherProcesses('win32', JSON.stringify({ ProcessId: 12, CommandLine: '"C:\\node.exe" C:\\p\\bin\\hoai-core.mjs --keep-alive', StartedAtMs: 1_700_000_000_000 }), [12])
  assert.deepEqual(one.get(12), { command: '"C:\\node.exe" C:\\p\\bin\\hoai-core.mjs --keep-alive', startedAtMs: 1_700_000_000_000 })
  const many = parseLauncherProcesses('win32', JSON.stringify([
    { ProcessId: 12, CommandLine: 'svchost.exe -k', StartedAtMs: null },
    { ProcessId: 34, CommandLine: null, StartedAtMs: 1_700_000_000_000 },
    { ProcessId: 35, CommandLine: null, StartedAtMs: null },
    { ProcessId: 56, CommandLine: 'x' },
  ]), [12, 34, 35])
  assert.deepEqual([...many.entries()], [
    [12, { command: 'svchost.exe -k', startedAtMs: null }],
    [34, { command: null, startedAtMs: 1_700_000_000_000 }],
  ], 'another session\'s process is still dated; nothing readable is absent; an unasked pid is ignored')
  assert.equal(parseLauncherProcesses('win32', 'not json', [12]).size, 0)
  assert.equal(parseLauncherProcesses('win32', '', [12]).size, 0)
})

test('readLauncherProcesses: one exec for the whole fleet, none without pids or without an exec, never throws', () => {
  const ps = psExec({ 4242: HOAI_CMD, 77: '/usr/sbin/cupsd -l' })
  const now = Date.parse('2026-10-07T09:00:00.000Z')
  const got = readLauncherProcesses({ platform: 'linux', pids: [4242, 77, 4242], execSync: ps.execSync, now })
  assert.equal(ps.calls.length, 1, 'one query, deduplicated')
  assert.deepEqual(ps.calls[0], ['ps', '-ww', '-o', 'pid=,etime=,command=', '-p', '4242,77'])
  assert.deepEqual(got.get(4242), { command: HOAI_CMD, startedAtMs: now - 3_600_000 })
  assert.deepEqual(got.get(77), { command: '/usr/sbin/cupsd -l', startedAtMs: now - 3_600_000 })
  assert.equal(readLauncherProcesses({ platform: 'linux', pids: [], execSync: ps.execSync }).size, 0)
  assert.equal(ps.calls.length, 1, 'no pids, no process')
  assert.equal(readLauncherProcesses({ platform: 'linux', pids: [1] }).size, 0, 'no exec: nothing readable')
  const throwing = () => {
    throw new Error('spawn failed')
  }
  assert.equal(readLauncherProcesses({ platform: 'linux', pids: [1], execSync: throwing }).size, 0)
})

test('parseSupervisorRecord: the file plus its writer\'s stamp; a missing or junk stamp is null', () => {
  assert.deepEqual(parseSupervisorRecord(supervisorFileBody(42, '2026-10-06T21:00:00.000Z')), {
    pid: 42,
    capabilities: ['relaunch'],
    startedAtMs: Date.parse('2026-10-06T21:00:00.000Z'),
    declaredLauncher: false,
  })
  assert.equal(parseSupervisorRecord(supervisorFileBody(42, 'x'))!.startedAtMs, null)
  assert.equal(parseSupervisorRecord(JSON.stringify({ pid: 42, capabilities: ['relaunch'], startedAt: 1_700_000_000_000 }))!.startedAtMs, null)
  assert.equal(parseSupervisorRecord(JSON.stringify({ pid: 42 }))!.startedAtMs, null)
  assert.equal(parseSupervisorRecord('junk'), null)
  assert.equal(parseSupervisorRecord(null), null)
})

test('runsHoaiLauncher and isLiveHoaiLauncher: alive AND still the writer; unreadable keeps the liveness answer', () => {
  assert.equal(runsHoaiLauncher(HOAI_CMD), true)
  assert.equal(runsHoaiLauncher('/usr/sbin/cupsd -l'), false)
  assert.equal(runsHoaiLauncher(null), true, 'cannot be read: liveness alone, as before')
  assert.equal(runsHoaiLauncher(undefined), true)
  const supervisor = { pid: 4242, capabilities: ['relaunch'] }
  const lines = (entries: Array<[number, string]>) => new Map(entries.map(([pid, command]) => [pid, { command, startedAtMs: null }]))
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => true, processes: lines([[4242, HOAI_CMD]]) }), true)
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => true, processes: lines([[4242, '/usr/sbin/cupsd -l']]) }), false, 'a reused pid')
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => true, processes: lines([]) }), true, 'unreadable')
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => true }), true, 'no command lines at all')
  assert.equal(isLiveHoaiLauncher({ supervisor, pidAlive: () => false, processes: lines([[4242, HOAI_CMD]]) }), false, 'dead')
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

// -- delta review F1: prove the WRITER, not just "a hoai" -------------------------
//
// Every agent's hoai runs hoai-core.mjs, and on macOS so does every agent's tmux
// server (tmux cannot retitle itself there, so it keeps the client argv that
// names the script). A boot starts the whole fleet inside a few hundred pids, so
// agent 912's stale file can name agent 913's hoai or tmux server. The pid is
// this agent's launcher only when it started no later than the file's startedAt
// (plus the keepalive.json slack) AND runs hoai-core.mjs as its script (argv[1]).

const NOW = Date.parse('2026-10-07T09:00:00.000Z')
const STALE_STAMP = '2026-10-06T21:00:00.000Z'
const ROOT = '/Users/kc/.claude/plugins/cache/hoai/hoai/0.62.0'
const TMUX_913 =
  `tmux -f /dev/null -L hoai-913 new-session -d -s hoai-913 -x 200 -y 50 -c /Users/kc/agents/b /bin/sh -c err=$1; shift; exec "$@" 2>>"$err" ` +
  `hoai-stderr /Users/kc/.bgos-agent/913/hoai.err /usr/bin/env HOAI_SUPERVISED=1 HOAI_SUPERVISED_ASSISTANT_ID=913 BGOS_TMUX_SESSION=hoai-913 ` +
  `BGOS_TMUX_SOCKET=hoai-913 /opt/homebrew/bin/node ${ROOT}/bin/hoai-core.mjs`

/** ps etime ([[dd-]hh:]mm:ss) for an age in ms. */
function etimeOf(ageMs: number) {
  const s = Math.floor(ageMs / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  return `${d ? `${d}-` : ''}${d || h ? `${pad(h)}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** A posix ps for the batch query that prints whichever columns it was asked for (pid, etime when asked, command). */
function psAged(rows: Record<number, { command: string; startedAtMs: number }>) {
  const calls: string[][] = []
  const execSync = (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (file !== 'ps' || args[0] !== '-ww' || args[1] !== '-o' || args[3] !== '-p') return { code: 1, stdout: '' }
    const withEtime = String(args[2]).includes('etime=')
    const lines = String(args[4])
      .split(',')
      .map(Number)
      .filter((pid) => rows[pid] !== undefined)
      .map((pid) => {
        const row = rows[pid]!
        return `${String(pid).padStart(6)} ${withEtime ? `${etimeOf(NOW - row.startedAtMs).padStart(11)} ` : ''}${row.command}`
      })
    return lines.length ? { code: 0, stdout: `${lines.join('\n')}\n` } : { code: 1, stdout: '' }
  }
  return { calls, execSync }
}

test('F1: runsHoaiLauncher anchors on argv[1]: another agent\'s tmux server, a wrapper or a look-alike name never matches', () => {
  // The supported launch paths: run.sh and the bash dispatcher (node or bun), the Windows task and hoai.ps1 (quoted).
  assert.equal(runsHoaiLauncher(`/opt/homebrew/bin/node ${ROOT}/bin/hoai-core.mjs`), true)
  assert.equal(runsHoaiLauncher(`node ${ROOT}/bin/hoai-core.mjs --keep-alive --new`), true)
  assert.equal(runsHoaiLauncher(`bun ${ROOT}/bin/hoai-core.mjs`), true)
  assert.equal(runsHoaiLauncher('/usr/bin/node /Users/kc/My Projects/bgos-claude-plugin/bin/hoai-core.mjs --keep-alive'), true, 'ps quotes nothing: a checkout path with a space')
  assert.equal(runsHoaiLauncher('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\K C\\p\\bin\\hoai-core.mjs" --keep-alive'), true)
  assert.equal(runsHoaiLauncher('"C:\\Program Files\\nodejs\\node.exe" C:\\p\\bin\\hoai-core.mjs'), true)
  // macOS keeps a tmux server's client argv, which names the script far after argv[1].
  assert.equal(runsHoaiLauncher(TMUX_913), false, 'run.sh\'s tmux server')
  assert.equal(runsHoaiLauncher(`tmux -L hoai-913 new-session -d -s hoai-913 -x 200 -y 50 -c /a /usr/bin/env HOAI_SUPERVISED=1 node ${ROOT}/bin/hoai-core.mjs`), false, 'an older run.sh\'s tmux server')
  assert.equal(runsHoaiLauncher(`tmux new-session /opt/homebrew/bin/node ${ROOT}/bin/hoai-core.mjs`), false)
  assert.equal(runsHoaiLauncher(`/bin/sh -c exec "$@" hoai-stderr /x/hoai.err node ${ROOT}/bin/hoai-core.mjs`), false)
  assert.equal(runsHoaiLauncher(`/usr/bin/env HOAI_SUPERVISED=1 /opt/homebrew/bin/node ${ROOT}/bin/hoai-core.mjs`), false)
  assert.equal(runsHoaiLauncher(`node ${ROOT}/bin/not-hoai-core.mjs`), false, 'the basename, not a substring')
  assert.equal(runsHoaiLauncher(`node ${ROOT}/bin/hoai-core.mjs.bak`), false)
  assert.equal(runsHoaiLauncher(`node --inspect ${ROOT}/bin/hoai-core.mjs`), false, 'argv[1] is a flag')
  assert.equal(runsHoaiLauncher('/usr/libexec/rapportd'), false)
})

// Review 3 F2: posix ps prints argv unquoted, and argv[0] is what run.sh baked
// with `command -v node`, a full path that can hold a space: Laravel Herd's nvm
// lives under `~/Library/Application Support`. The argv[1] parse took the first
// word as argv[0] and stopped argv[1] at the next word starting with '/', so it
// read `Support/.../bin/node` as the script and refused every live hoai there
// (and a checkout path holding ' - '): launcherLive false, and a second
// launcher reclaimed the live one's supervisor.json. argv[0] may now run past a
// space when it is a path (the rest of a directory path follows that space),
// while a tmux client, sh -c, env or another script before hoai-core.mjs still
// never counts.
const HERD_NODE = '/Users/kc/Library/Application Support/Herd/config/nvm/versions/node/v22.11.0/bin/node'

test('review 3 F2: runsHoaiLauncher: a node path with a space (Herd), a checkout path with \' - \', and both at once are hoai; what is not hoai still is not', () => {
  assert.equal(runsHoaiLauncher(`${HERD_NODE} ${ROOT}/bin/hoai-core.mjs`), true, 'the Herd node run.sh bakes')
  assert.equal(runsHoaiLauncher(`${HERD_NODE} ${ROOT}/bin/hoai-core.mjs --keep-alive --new`), true)
  assert.equal(runsHoaiLauncher('/usr/local/bin/node /Users/kc/My Work - Plugins/bgos-claude-plugin/bin/hoai-core.mjs'), true, 'a lone - inside a checkout path is no flag')
  assert.equal(runsHoaiLauncher(`${HERD_NODE} /Users/kc/My Work - Plugins/bgos-claude-plugin/bin/hoai-core.mjs --keep-alive`), true)
  assert.equal(runsHoaiLauncher('/Applications/Node Runtime.app/Contents/MacOS/node /Users/kc/My Projects/p/bin/hoai-core.mjs'), true)
  assert.equal(runsHoaiLauncher('C:\\Program Files\\nodejs\\node.exe C:\\p\\bin\\hoai-core.mjs'), true, 'an unquoted Windows line reads the same way')
  // Still refused: something other than node's script run sits before hoai-core.mjs.
  assert.equal(runsHoaiLauncher(`/usr/bin/tmux new-session node ${ROOT}/bin/hoai-core.mjs`), false, 'an absolute tmux with no flag: new-session is no path')
  assert.equal(runsHoaiLauncher(`/usr/bin/env PATH=/usr/bin /opt/homebrew/bin/node ${ROOT}/bin/hoai-core.mjs`), false, 'env: another path starts before the script')
  assert.equal(runsHoaiLauncher(`/opt/homebrew/bin/node /Users/kc/other/script.mjs ${ROOT}/bin/hoai-core.mjs`), false, 'another script whose argument names hoai-core.mjs')
  assert.equal(runsHoaiLauncher(`${HERD_NODE} --inspect ${ROOT}/bin/hoai-core.mjs`), false, 'argv[1] is a flag')
  assert.equal(runsHoaiLauncher(`tmux -L hoai-913 new-session -d -s hoai-913 ${HERD_NODE} ${ROOT}/bin/hoai-core.mjs`), false, 'a tmux client running the Herd node')
  assert.equal(runsHoaiLauncher(`/bin/sh -c ${HERD_NODE} ${ROOT}/bin/hoai-core.mjs`), false)
  assert.equal(runsHoaiLauncher(`${HERD_NODE} ${ROOT}/bin/not-hoai-core.mjs`), false)
  assert.equal(runsHoaiLauncher(HERD_NODE), false)
})

test('review 3 F2: a live hoai on the Herd node is its file\'s writer: listAgents reads it live and a second hoai refuses to arm beside it', () => {
  const stamp = NOW - 10 * 60_000
  const line = `${HERD_NODE} ${ROOT}/bin/hoai-core.mjs`
  const files = {
    [`${HOME}/.bgos-agent/credentials-912.json`]: '{}',
    [`${HOME}/.bgos-agent/912/supervisor.json`]: supervisorFileBody(4242, new Date(stamp).toISOString()),
  }
  const ps = psAged({ 4242: { command: line, startedAtMs: stamp - 2000 } })
  const [agent] = listAgents({ home: HOME, env: {}, platform: 'darwin', fs: fsWith(files), pidAlive: () => true, execSync: ps.execSync, now: NOW })
  assert.equal(agent!.launcherLive, true)
  assert.equal(agent!.supervisor, 'launcher-live')
  const proc = readLauncherProcesses({ platform: 'darwin', pids: [4242], execSync: ps.execSync, now: NOW }).get(4242)!
  assert.equal(proc.command, line, 'ps prints the argv unquoted, space and all')
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: files[`${HOME}/.bgos-agent/912/supervisor.json`]!, ownPid: 5555, pidAlive: () => true, pidProcess: () => proc }),
    { arm: false, ownerPid: 4242 },
  )
})

test('F1: listAgents after a reboot: agent 912\'s stale file naming agent 913\'s hoai (started after the stamp) or tmux server is not 912\'s launcher', () => {
  const booted = NOW - 30_000
  const files = {
    [`${HOME}/.bgos-agent/credentials-912.json`]: '{}',
    [`${HOME}/.bgos-agent/credentials-911.json`]: '{}',
    [`${HOME}/.bgos-agent/credentials-913.json`]: '{}',
    // 912: the stale file from before the reboot, its pid now agent 913's hoai.
    [`${HOME}/.bgos-agent/912/supervisor.json`]: supervisorFileBody(2041, STALE_STAMP),
    // 911: a stale file without a stamp (start unknown), its pid now agent 913's tmux server.
    [`${HOME}/.bgos-agent/911/supervisor.json`]: JSON.stringify({ pid: 2040, capabilities: ['relaunch'] }),
    // 913: its own launcher, which wrote its file a second after it started.
    [`${HOME}/.bgos-agent/913/supervisor.json`]: supervisorFileBody(2041, new Date(booted + 1000).toISOString()),
  }
  const ps = psAged({ 2040: { command: TMUX_913, startedAtMs: booted }, 2041: { command: `/opt/homebrew/bin/node ${ROOT}/bin/hoai-core.mjs`, startedAtMs: booted } })
  const agents = listAgents({ home: HOME, env: {}, platform: 'darwin', fs: fsWith(files), pidAlive: () => true, execSync: ps.execSync, now: NOW })
  const byId = Object.fromEntries(agents.map((a) => [a.assistantId, a]))
  assert.equal(byId['912']!.launcherLive, false, 'another agent\'s hoai that started after the file was written')
  assert.equal(byId['912']!.supervisor, 'none')
  assert.equal(byId['911']!.launcherLive, false, 'another agent\'s tmux server')
  assert.equal(byId['911']!.supervisor, 'none')
  assert.equal(byId['913']!.launcherLive, true, 'the writer itself')
  assert.equal(byId['913']!.supervisor, 'launcher-live')
})

test('F1: the writer stays live: a keep-alive relaunch re-stamps the file long after hoai started, and the stamp has a minute of slack', () => {
  const stamp = NOW - 60 * 60_000
  const files = {
    [`${HOME}/.bgos-agent/credentials-7.json`]: '{}',
    [`${HOME}/.bgos-agent/credentials-8.json`]: '{}',
    [`${HOME}/.bgos-agent/7/supervisor.json`]: supervisorFileBody(4242, new Date(stamp).toISOString()),
    [`${HOME}/.bgos-agent/8/supervisor.json`]: supervisorFileBody(4343, new Date(stamp).toISOString()),
  }
  const ps = psAged({
    // Started three days before its latest stamp (every relaunch rewrites it).
    4242: { command: `node ${ROOT}/bin/hoai-core.mjs --keep-alive`, startedAtMs: stamp - 3 * 86_400_000 },
    // ps etime has 1 s granularity and the stamp is the wall clock: inside the slack.
    4343: { command: `node ${ROOT}/bin/hoai-core.mjs`, startedAtMs: stamp + 30_000 },
  })
  const agents = listAgents({ home: HOME, env: {}, platform: 'linux', fs: fsWith(files), pidAlive: () => true, execSync: ps.execSync, now: NOW })
  assert.deepEqual(agents.map((a) => [a.assistantId, a.launcherLive]), [['7', true], ['8', true]])
})

test('F1: isSupervisorWriter: a start after the stamp plus the slack is a reused pid; a half that cannot be read proves nothing', () => {
  const stamp = Date.parse(STALE_STAMP)
  const record = { startedAtMs: stamp }
  const hoai = `node ${ROOT}/bin/hoai-core.mjs`
  assert.equal(isSupervisorWriter(record, null), true, 'nothing readable: liveness decides')
  assert.equal(isSupervisorWriter(record, { command: hoai, startedAtMs: stamp + 60_000 }), true, 'inside the slack')
  assert.equal(isSupervisorWriter(record, { command: hoai, startedAtMs: stamp + 60_001 }), false)
  assert.equal(isSupervisorWriter(record, { command: null, startedAtMs: stamp + 3_600_000 }), false, 'Windows hides the command line; the start still proves reuse')
  assert.equal(isSupervisorWriter(record, { command: null, startedAtMs: stamp - 1000 }), true)
  assert.equal(isSupervisorWriter({ startedAtMs: null }, { command: hoai, startedAtMs: stamp + 3_600_000 }), true, 'no stamp: the command line decides')
  assert.equal(isSupervisorWriter({ startedAtMs: null }, { command: TMUX_913, startedAtMs: null }), false)
})

// -- delta review F3: the daemon's own declared-launcher record -------------------
//
// A bespoke launcher that watches restart markers declares itself with
// BGOS_SUPERVISOR_KIND=launcher, and the agent's DAEMON then writes
// supervisor.json naming its own pid (lib/update-readiness.ts
// buildDeclaredSupervisorBody). That pid runs `bun server.ts`, never
// hoai-core.mjs, so the script test alone read the declared launcher as dead:
// no 'marker' restart tier, and the canonical service beside it waited on a
// "manual session" for ever. That exact record is judged by liveness and the
// start-time proof alone.

const DAEMON = `bun ${ROOT}/server.ts`

test('F3: listAgents: the daemon\'s declared-launcher record is live while its pid is that daemon, and only that exact record shape is', () => {
  const stamp = NOW - 10 * 60_000
  const startedAt = new Date(stamp).toISOString()
  const declared = (pid: number, restartCommand: unknown = null) =>
    buildDeclaredSupervisorBody({ declared: { kind: 'launcher', handle: null, restartCommand } as never, pid, startedAt })
  const ids = ['912', '913', '914', '915', '916', '917']
  const files: Record<string, string> = Object.fromEntries(ids.map((id) => [`${HOME}/.bgos-agent/credentials-${id}.json`, '{}']))
  Object.assign(files, {
    // The daemon's own record, plain and with a declared restart command.
    [`${HOME}/.bgos-agent/912/supervisor.json`]: declared(4912),
    [`${HOME}/.bgos-agent/913/supervisor.json`]: declared(4913, { file: '/usr/local/bin/my-launcher', args: ['--restart'] }),
    // The same record after an unclean stop, its pid since reused by a later daemon.
    [`${HOME}/.bgos-agent/914/supervisor.json`]: declared(4914),
    // Shapes the daemon never writes: a junk restart command (parseDeclaredSupervisor refuses it), no stamp.
    [`${HOME}/.bgos-agent/915/supervisor.json`]: JSON.stringify({ pid: 4915, capabilities: ['relaunch'], startedAt, supervisor: { kind: 'launcher', restartCommand: { file: '' } } }),
    [`${HOME}/.bgos-agent/916/supervisor.json`]: JSON.stringify({ pid: 4916, capabilities: ['relaunch'], supervisor: { kind: 'launcher' } }),
    // A declared service manager is no marker launcher at all (no relaunch capability).
    [`${HOME}/.bgos-agent/917/supervisor.json`]: buildDeclaredSupervisorBody({ declared: { kind: 'launchd', handle: 'ai.bgos.session.917', restartCommand: null }, pid: 4917, startedAt }),
  })
  const before = { command: DAEMON, startedAtMs: stamp - 2000 }
  const ps = psAged({ 4912: before, 4913: before, 4914: { command: DAEMON, startedAtMs: stamp + 5 * 60_000 }, 4915: before, 4916: before, 4917: before })
  const agents = listAgents({ home: HOME, env: {}, platform: 'darwin', fs: fsWith(files), pidAlive: () => true, execSync: ps.execSync, now: NOW })
  assert.deepEqual(
    agents.map((a) => [a.assistantId, a.launcherLive]),
    [['912', true], ['913', true], ['914', false], ['915', false], ['916', false], ['917', false]],
  )
  assert.equal(agents[0]!.supervisor, 'launcher-live')
  // Nothing readable about the pid: liveness alone, as for every record.
  const blind = listAgents({ home: HOME, env: {}, platform: 'darwin', fs: fsWith(files), pidAlive: () => true, execSync: () => ({ code: 1, stdout: '' }), now: NOW })
  assert.equal(blind[0]!.launcherLive, true)
})

test('F3: parseSupervisorRecord marks exactly the declared-launcher record the daemon writes', () => {
  const startedAt = '2026-10-07T08:50:00.000Z'
  const of = (body: string) => parseSupervisorRecord(body)!.declaredLauncher
  assert.equal(of(buildDeclaredSupervisorBody({ declared: { kind: 'launcher', handle: null, restartCommand: null }, pid: 9, startedAt })), true)
  assert.equal(of(buildDeclaredSupervisorBody({ declared: { kind: 'launcher', handle: null, restartCommand: { file: '/x', args: [] } }, pid: 9, startedAt })), true)
  assert.equal(of(JSON.stringify({ pid: 9, capabilities: ['relaunch'], startedAt, supervisor: { kind: 'launcher', restartCommand: { file: '/x' } } })), true, 'args may be absent')
  assert.equal(of(supervisorFileBody(9, startedAt)), false, 'hoai\'s own record')
  assert.equal(of(JSON.stringify({ pid: 9, capabilities: ['relaunch'], startedAt, supervisor: { kind: 'launcher', restartCommand: { file: '/x', args: [1] } } })), false)
  assert.equal(of(JSON.stringify({ pid: 9, capabilities: ['relaunch'], startedAt, supervisor: { kind: 'launcher', restartCommand: 'x' } })), false)
  assert.equal(of(JSON.stringify({ pid: 9, capabilities: ['relaunch'], startedAt, supervisor: [] })), false)
  assert.equal(of(JSON.stringify({ pid: 9, capabilities: ['relaunch'], startedAt, supervisor: { kind: 'systemd', handle: 'x' } })), false)
  assert.equal(of(JSON.stringify({ pid: 9, capabilities: ['relaunch'], startedAt: 'x', supervisor: { kind: 'launcher' } })), false, 'no stamp, no start-time proof')
})
