/**
 * lib/process-tree.mjs: the process table the keep-alive sweep reads to find an
 * agent's claude and its background jobs (design 6, finding 9). Every OS call
 * goes through an injected exec; the parsers are pinned on fixtures captured in
 * the formats the real tools print:
 *
 *   posix   ps pid=,ppid=,lstart=,command= (darwin -a -x -ww, linux -e -ww, LC_ALL=C)
 *   win32   PowerShell Get-CimInstance Win32_Process as compressed JSON
 *   cwd     lsof -a -d cwd -p <pids> -Fn (darwin), readlink /proc/<pid>/cwd (linux),
 *           none on win32
 *
 * A listing that cannot be fully parsed is UNREADABLE (null), never partial: a
 * skipped line could be the background job the safe moment must see.
 *
 * Run: npx tsx --test test/process-tree.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  claudeCandidates,
  descendantsOf,
  findClaudePidsByCwd,
  isClaudeCommand,
  listProcesses,
  parseLsofCwd,
  parsePsOutput,
  parseWin32ProcessJson,
  psCommand,
  readProcessCwds,
  win32ProcessCommand,
} from '../lib/process-tree.mjs'

const PS_FIXTURE = [
  '    1     0 Mon Oct  5 08:00:00 2026 /sbin/launchd',
  ' 4100     1 Tue Oct  6 17:59:58 2026 tmux new-session -d -s hoai-912',
  ' 4200  4100 Tue Oct  6 18:00:00 2026 claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:hoai@hoai',
  ' 4242  4200 Tue Oct  6 18:00:05 2026 node /Users/kc/.claude/plugins/cache/hoai/hoai/0.62.0/server.ts',
  " 4300  4200 Tue Oct  6 18:30:00 2026 /bin/zsh -c source /Users/kc/.claude/shell-snapshots/snapshot-zsh-1759777000-abc.sh && eval 'tail -f /tmp/x.log' < /dev/null",
  ' 4301  4300 Tue Oct  6 18:30:01 2026 tail -f /tmp/x.log',
  ' 5000     1 Tue Oct  6 17:00:00 2026 /Users/kc/.local/bin/claude',
  ' 5001  5000 Tue Oct  6 17:00:01 2026 ',
  '',
].join('\n')

function recordingExec(answers: Record<string, { code: number; stdout: string }>) {
  const calls: Array<{ file: string; args: string[]; opts: any }> = []
  const exec = async (file: string, args: readonly string[], opts: any = {}) => {
    calls.push({ file, args: [...args], opts })
    const key = `${file} ${args.join(' ')}`
    const hit = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))
    const answer = hit ? hit[1] : { code: 1, stdout: '' }
    return { code: answer.code, stdout: answer.stdout, stderr: '', error: null, timedOut: false }
  }
  return { calls, exec }
}

test('psCommand: one ps listing per platform, start time included, wide so commands are never cut', () => {
  assert.deepEqual(psCommand('darwin'), { file: 'ps', args: ['-a', '-x', '-ww', '-o', 'pid=,ppid=,lstart=,command='] })
  // On linux -e is "every process"; on darwin -e means "show the environment", hence -a -x there.
  assert.deepEqual(psCommand('linux'), { file: 'ps', args: ['-e', '-ww', '-o', 'pid=,ppid=,lstart=,args='] })
})

test('parsePsOutput: pid, ppid, local start time and the full command line', () => {
  const rows = parsePsOutput(PS_FIXTURE)!
  assert.equal(rows.length, 8)
  assert.deepEqual(rows[2], {
    pid: 4200,
    ppid: 4100,
    startedAtMs: new Date(2026, 9, 6, 18, 0, 0).getTime(),
    command: 'claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:hoai@hoai',
  })
  assert.equal(rows[4]!.command.includes('shell-snapshots/snapshot-zsh'), true)
  assert.equal(rows[0]!.startedAtMs, new Date(2026, 9, 5, 8, 0, 0).getTime())
  assert.equal(rows[7]!.command, '', 'a process with an empty command line is still a row')
})

test('parsePsOutput: any line that does not parse makes the whole listing unreadable (fail closed); empty is unreadable', () => {
  assert.equal(parsePsOutput(`${PS_FIXTURE}\nthis is not a ps line\n`), null)
  assert.equal(parsePsOutput(''), null)
  assert.equal(parsePsOutput('   \n'), null)
  // An unparseable start time is tolerated (the row stays, its time is unknown).
  const odd = parsePsOutput(' 7 1 Xyz Abc 99 99:99:99 2026 claude')!
  assert.deepEqual(odd, [{ pid: 7, ppid: 1, startedAtMs: null, command: 'claude' }])
})

test('win32: Get-CimInstance Win32_Process as JSON with ProcessId, ParentProcessId, CreationDate, CommandLine', () => {
  const cmd = win32ProcessCommand()
  assert.equal(cmd.file, 'powershell.exe')
  assert.deepEqual(cmd.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  const script = cmd.args[3]!
  for (const part of ['Get-CimInstance Win32_Process', 'ProcessId', 'ParentProcessId', 'CreationDate', 'CommandLine', 'ToUnixTimeMilliseconds', 'ConvertTo-Json -Compress']) {
    assert.ok(script.includes(part), `the script names ${part}`)
  }
  const rows = parseWin32ProcessJson(
    JSON.stringify([
      { ProcessId: 4, ParentProcessId: 0, CreationDate: null, CommandLine: null },
      { ProcessId: 900, ParentProcessId: 4, CreationDate: 1759773600000, CommandLine: '"C:\\Users\\kc\\.local\\bin\\claude.exe" --x' },
      { ProcessId: 901, ParentProcessId: 900, CreationDate: '/Date(1759773605000)/', CommandLine: 'bash.exe -c source C:\\Users\\kc\\.claude\\shell-snapshots\\snapshot-bash-1.sh' },
      { ProcessId: 902, ParentProcessId: 900, CreationDate: '2026-10-06T18:00:10.000Z', CommandLine: 'node server.ts' },
    ]),
  )!
  assert.deepEqual(rows, [
    { pid: 4, ppid: 0, startedAtMs: null, command: '' },
    { pid: 900, ppid: 4, startedAtMs: 1759773600000, command: '"C:\\Users\\kc\\.local\\bin\\claude.exe" --x' },
    { pid: 901, ppid: 900, startedAtMs: 1759773605000, command: 'bash.exe -c source C:\\Users\\kc\\.claude\\shell-snapshots\\snapshot-bash-1.sh' },
    { pid: 902, ppid: 900, startedAtMs: Date.parse('2026-10-06T18:00:10.000Z'), command: 'node server.ts' },
  ])
  // ConvertTo-Json prints a lone object (not an array) when there is one process.
  assert.equal(parseWin32ProcessJson(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, CreationDate: null, CommandLine: 'x' }))!.length, 1)
  for (const junk of ['', '{', '[]', JSON.stringify([{ ParentProcessId: 1 }]), JSON.stringify([{ ProcessId: 'x', ParentProcessId: 1 }])]) {
    assert.equal(parseWin32ProcessJson(junk), null, junk)
  }
})

test('listProcesses: posix runs ps under LC_ALL=C (English month names); a failed or unparseable ps is ok:false', async () => {
  const good = recordingExec({ 'ps -a -x -ww': { code: 0, stdout: PS_FIXTURE } })
  const res = await listProcesses({ platform: 'darwin', exec: good.exec, env: { PATH: '/usr/bin', LANG: 'de_DE.UTF-8' } })
  assert.equal(res.ok, true)
  assert.equal(res.processes!.length, 8)
  assert.equal(good.calls.length, 1)
  assert.equal(good.calls[0]!.opts.env.LC_ALL, 'C')
  assert.equal(good.calls[0]!.opts.env.PATH, '/usr/bin')
  const failed = recordingExec({ 'ps ': { code: 1, stdout: '' } })
  assert.deepEqual(await listProcesses({ platform: 'linux', exec: failed.exec, env: {} }), { ok: false, error: 'ps_failed:1' })
  const junk = recordingExec({ 'ps ': { code: 0, stdout: 'garbage' } })
  assert.deepEqual(await listProcesses({ platform: 'linux', exec: junk.exec, env: {} }), { ok: false, error: 'ps_unparseable' })
  const win = recordingExec({ 'powershell.exe': { code: 0, stdout: JSON.stringify({ ProcessId: 5, ParentProcessId: 1, CreationDate: null, CommandLine: 'x' }) } })
  const winRes = await listProcesses({ platform: 'win32', exec: win.exec, env: {} })
  assert.equal(winRes.ok, true)
  assert.equal(win.calls[0]!.file, 'powershell.exe')
})

test('descendantsOf: every process below the root (children of children), never the root, cycle safe', () => {
  const rows = parsePsOutput(PS_FIXTURE)!
  assert.deepEqual(
    descendantsOf(rows, 4200).map((p) => p.pid).sort(),
    [4242, 4300, 4301],
  )
  assert.deepEqual(descendantsOf(rows, 4301), [])
  const loop = [
    { pid: 10, ppid: 11, startedAtMs: null, command: 'a' },
    { pid: 11, ppid: 10, startedAtMs: null, command: 'b' },
  ]
  assert.deepEqual(descendantsOf(loop, 10).map((p) => p.pid), [11])
})

test('isClaudeCommand: the native binary by basename (posix or win32), the node-hosted cli.js; nothing that merely mentions claude', () => {
  const yes = [
    'claude',
    'claude --dangerously-skip-permissions',
    '/Users/kc/.local/bin/claude --resume 8c1f',
    '"C:\\Users\\kc\\.local\\bin\\claude.exe" --x',
    'C:\\Users\\kc\\.local\\bin\\claude.exe',
    'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --x',
  ]
  const no = [
    'node /Users/kc/.claude/plugins/cache/hoai/hoai/0.62.0/server.ts',
    'tail -f /Users/kc/.claude/claude.log',
    'claude-helper --x',
    'vim claude',
    '',
  ]
  for (const c of yes) assert.equal(isClaudeCommand(c), true, c)
  for (const c of no) assert.equal(isClaudeCommand(c), false, c)
  assert.deepEqual(claudeCandidates(parsePsOutput(PS_FIXTURE)!).map((p) => p.pid), [4200, 5000])
})

test('parseLsofCwd: -Fn blocks (p<pid>, fcwd, n<path>) into pid -> cwd', () => {
  const out = 'p4200\nfcwd\nn/Users/kc/hoai-agents/ava\np5000\nfcwd\nn/Users/kc/projects/other dir\n'
  const map = parseLsofCwd(out)
  assert.equal(map.get(4200), '/Users/kc/hoai-agents/ava')
  assert.equal(map.get(5000), '/Users/kc/projects/other dir')
  assert.equal(parseLsofCwd('').size, 0)
})

test('readProcessCwds: darwin asks lsof once for every pid; linux reads /proc/<pid>/cwd; win32 asks nothing (best effort: none)', async () => {
  const mac = recordingExec({ lsof: { code: 1, stdout: 'p4200\nfcwd\nn/Users/kc/hoai-agents/ava\n' } })
  const macMap = await readProcessCwds({ platform: 'darwin', exec: mac.exec, pids: [4200, 5000] })
  assert.deepEqual(mac.calls.map((c) => [c.file, ...c.args]), [['lsof', '-a', '-d', 'cwd', '-p', '4200,5000', '-Fn']])
  assert.equal(macMap.get(4200), '/Users/kc/hoai-agents/ava', 'lsof exits 1 when one pid is gone and still prints the rest')
  const linux = recordingExec({ 'readlink /proc/4200/cwd': { code: 0, stdout: '/home/kc/hoai-agents/ava\n' } })
  const linuxMap = await readProcessCwds({ platform: 'linux', exec: linux.exec, pids: [4200, 5000] })
  assert.deepEqual(linux.calls.map((c) => [c.file, ...c.args]), [['readlink', '/proc/4200/cwd'], ['readlink', '/proc/5000/cwd']])
  assert.equal(linuxMap.get(4200), '/home/kc/hoai-agents/ava')
  assert.equal(linuxMap.has(5000), false)
  const win = recordingExec({})
  assert.equal((await readProcessCwds({ platform: 'win32', exec: win.exec, pids: [900] })).size, 0)
  assert.equal(win.calls.length, 0)
  assert.equal((await readProcessCwds({ platform: 'darwin', exec: win.exec, pids: [] })).size, 0)
  assert.equal(win.calls.length, 0, 'no pids, no lsof')
})

test('findClaudePidsByCwd: every claude whose cwd is the agent folder (trailing slash tolerant), nothing else', () => {
  const rows = parsePsOutput(PS_FIXTURE)!
  const cwds = new Map([
    [4200, '/Users/kc/hoai-agents/ava'],
    [5000, '/Users/kc/projects/other'],
    [4242, '/Users/kc/hoai-agents/ava'],
  ])
  assert.deepEqual(findClaudePidsByCwd({ processes: rows, cwds, cwd: '/Users/kc/hoai-agents/ava/' }), [4200])
  assert.deepEqual(findClaudePidsByCwd({ processes: rows, cwds, cwd: '/Users/kc/hoai-agents/nobody' }), [])
  assert.deepEqual(findClaudePidsByCwd({ processes: rows, cwds, cwd: '' }), [])
})
