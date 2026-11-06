/** Every command runner is fake. No checkup may launch or signal anything. */
import './helpers/real-os-sentinel.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCheckupJob } from '../lib/watcher-core.mjs'
import * as restart from '../lib/agent-restart.mjs'
import { buildLaunchRecipe, joinDir, listAgents, serviceFilePath } from '../lib/agent-inventory.mjs'
import { agentTaskSpec } from '../lib/agent-task-win32.mjs'
import { agentTaskDescription } from '../lib/agent-service.mjs'
import { memoryFs } from './helpers/memory-fs.ts'
import { fakeAgentTasks } from './helpers/fake-agent-tasks.ts'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const ID = '42'
type State = 'stopped' | 'idle' | 'busy' | 'unresponsive' | 'unclear'
const mechanisms = [
  ['systemd', 'linux', true], ['launchd', 'darwin', true], ['task', 'win32', true],
  ['tmux', 'linux', false], ['script', 'linux', false], ['script', 'darwin', false],
  ['hidden recipe', 'win32', false],
] as const

function fixture(platform: string, service: boolean, mechanism: string, state: State) {
  const home = platform === 'win32' ? 'C:\\Users\\example' : '/home/example'
  const path = (...parts: string[]) => parts.reduce((a, b) => joinDir(a, b), home)
  const cwd = path('agents', 'example')
  const root = path('plugin')
  const stateDir = path('.bgos-agent', ID)
  const pluginState = path('.bgos-plugin-state', ID)
  const credentialsPath = path('.bgos-agent', `credentials-${ID}.json`)
  const fs = memoryFs({
    [joinDir(root, 'bin/bgos-pair.mjs')]: '// example pairing CLI',
    [credentialsPath]: JSON.stringify({ assistantId: ID, pairingId: 7, pairingToken: 'example-secret', backendUrl: 'https://api.example.test' }),
    [joinDir(cwd, '.bgos-agent-id')]: ID,
    [joinDir(stateDir, 'launch.json')]: JSON.stringify(buildLaunchRecipe({ assistantId: ID, cwd, argv: [], installMethod: 'marketplace', pluginRoot: root, node: 'node', startedAt: '2026-10-23T00:00:00Z', pid: 400 })),
  }, [cwd])
  const unit = serviceFilePath(platform, home, ID)
  if (service && platform === 'linux') fs.writeFile(unit!, `[Service]\nWorkingDirectory=${cwd}\nExecStart=/bin/bash "${stateDir}/run.sh"\nEnvironment=HOME=${home}\n`)
  if (service && platform === 'darwin') fs.writeFile(unit!, `<plist><dict><key>Label</key><string>ai.bgos.agent.${ID}</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>${stateDir}/run.sh</string></array><key>WorkingDirectory</key><string>${cwd}</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>${home}</string></dict></dict></plist>`)
  const taskHost = fakeAgentTasks({ fs })
  if (service && platform === 'win32') {
    const spec = agentTaskSpec({ assistantId: ID, home, nodePath: 'node', pluginRoot: root, cwd })
    for (const file of spec.files) fs.writeFile(file.path, file.content)
    taskHost.seed.task(spec.taskName, spec.launcherPath, { description: agentTaskDescription(ID, home) })
  }
  const alive = new Set<number>()
  if (['idle', 'busy', 'unresponsive'].includes(state)) {
    alive.add(401)
    alive.add(402)
    fs.writeFile(joinDir(pluginState, 'agent-state.json'), JSON.stringify({
      schemaVersion: 1, assistantId: ID, pid: 402, claudePid: 401,
      runningVersion: '1.0.0', pendingRestartVersion: null, turnInFlight: state === 'busy',
      pendingMessages: 0, pendingPermissions: 0, activeOperations: 0,
      lastActivityAt: new Date(NOW - 60 * 60_000).toISOString(),
      updatedAt: new Date(NOW - (state === 'unresponsive' ? 60 * 60_000 : 1_000)).toISOString(), turnSignal: 'hooks',
    }))
    fs.writeFile(joinDir(pluginState, 'channel-beacon.json'), '{}')
    fs.touch(joinDir(pluginState, 'channel-beacon.json'), NOW - 60 * 60_000)
  }
  const calls: Array<{ runner: string; file: string; args: readonly string[] }> = []
  const progress: any[] = []
  const kills: any[] = []
  const spawns: any[] = []
  let now = NOW
  let race: 'cwd' | 'report' | null = null
  let born = false
  let cwdQueries = 0
  const result = (stdout = '', code = 0) => ({ code, stdout, stderr: '', timedOut: false, error: null })
  const ps = () => {
    if (state === 'unclear') return ''
    const rows = [{ pid: 1, ppid: 0, command: '/sbin/init' }]
    if (alive.has(401)) rows.push({ pid: 401, ppid: 1, command: `claude ${cwd}` }, { pid: 402, ppid: 401, command: 'node server.ts' })
    if (born) rows.push({ pid: 600, ppid: 1, command: 'python monitor.py' })
    return platform === 'win32'
      ? JSON.stringify(rows.map((p) => ({ ProcessId: p.pid, ParentProcessId: p.ppid, CommandLine: p.command, CreationDate: NOW - 60_000 })))
      : rows.map((p) => `${p.pid} ${p.ppid} 501 Fri Oct 23 10:00:00 2026 ${p.command}`).join('\n')
  }
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ runner: 'exec', file, args })
    if (file === 'ps' || (file === 'powershell.exe' && args.includes('-Command'))) return result(ps())
    if (file === 'readlink' || file === 'lsof') {
      cwdQueries++
      if (race === 'cwd') { born = true; alive.add(600) }
      const processCwd = args.some((arg) => arg.includes('/600/')) ? cwd : '/'
      return result(file === 'lsof' ? 'p1\nn/\n' : processCwd)
    }
    if (file === 'systemctl') return result(`LoadState=loaded\nActiveState=inactive\nFragmentPath=${unit}\nWorkingDirectory=${cwd}\nEnvironment=HOME=${home}\n`)
    if (file === 'launchctl') return result(`gui/501/ai.bgos.agent.${ID} = {\n path = ${unit}\n state = not running\n working directory = ${cwd}\n environment = {\n HOME => ${home}\n }\n}`)
    if (file === 'powershell.exe' || file === 'schtasks.exe') return taskHost.exec(file, args)
    return result()
  }
  const ctx: any = {
    home, env: {}, platform, fs, exec, uid: 501, nodePath: 'node',
    credentials: { backendUrl: 'https://api.example.test' }, secrets: [], username: 'example',
    now: () => now, sleep: async (ms: number) => { now += ms }, log: () => {},
    pidAlive: (pid: number) => alive.has(pid), realpath: (p: string) => p,
    execSync: (file: string, args: string[]) => { calls.push({ runner: 'execSync', file, args }); return result('', 1) },
    spawnDetached: (file: string, args: string[]) => { calls.push({ runner: 'spawnDetached', file, args }); spawns.push({ file, args }); return { pid: 700 } },
    kill: (...args: any[]) => kills.push(args), hasTmux: mechanism === 'tmux', hasScript: true, hasCommand: () => false,
    verifyTimeoutMs: 1_000, manifest: { pluginRoot: root },
    modules: { observeMarketplaceInstall: async () => ({ installed: { present: true, version: '1.0.0', installPath: root }, marketplaceLatest: { version: '1.0.0' } }) },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    client: { progress: async (_id: string, body: any) => {
      progress.push(body)
      if (race === 'report' && body.state === 'running') { born = true; alive.add(600) }
      return { ok: true }
    } },
  }
  const job: any = { intent: 'checkup', targets: [{ assistantId: ID, pairingId: 7 }] }
  return { ctx, fs, job, calls, kills, spawns, progress, credentialsPath, stateDir, alive,
    race: (when: 'cwd' | 'report') => { race = when },
    get born() { return born }, get cwdQueries() { return cwdQueries },
  }
}

function assertReadOnly(f: ReturnType<typeof fixture>) {
  const allowed = (c: typeof f.calls[number]) => c.runner !== 'spawnDetached' && (
    c.file === 'ps' || c.file === 'readlink' || c.file === 'lsof' ||
    (c.file === 'powershell.exe' && c.args.includes('-Command') && c.args.some((a) => a.startsWith('Get-CimInstance '))) ||
    (c.file === 'systemctl' && ['show', 'status', 'list-units'].includes(c.args[1]!)) ||
    (c.file === 'launchctl' && ['print', 'list'].includes(c.args[0]!)))
  assert.deepEqual(f.calls.filter((c) => !allowed(c)), [], 'zero starts, restarts, kickstarts, task runs, pairing commands or takeovers')
  assert.deepEqual(f.kills, [])
  assert.deepEqual(f.spawns, [])
  assert.equal(f.fs.readFile(joinDir(f.stateDir, 'restart-requested.json')), null)
  assert.equal(f.fs.readFile(joinDir(f.stateDir, 'probe-requested.json')), null)
  const terminal = f.progress.at(-1)
  assert.equal(terminal.state, 'done')
  assert.ok(terminal.findings.length > 0)
  assert.ok(terminal.findings.some((finding: any) => /Restart now/.test(finding.fix)))
  assert.ok(terminal.actions.every((action: any) => action.did === 'report'))
  assert.ok(terminal.actions.some((action: any) => /Restart now/.test(action.detail)))
}

for (const [mechanism, platform, service] of mechanisms) {
  for (const state of ['stopped', 'idle', 'busy', 'unresponsive', 'unclear'] as const) {
    test(`checkup read only: ${platform} ${mechanism} ${state}`, async () => {
      const f = fixture(platform, service, mechanism, state)
      const inventory = listAgents({ ...f.ctx, now: NOW })
      assert.equal(inventory.length, 1)
      assert.equal(inventory[0]!.supervisor === 'service', service, 'fixture reaches the intended restart tier')
      const before = [...f.fs.files]
      await runCheckupJob(f.ctx, 'example-job', f.job)
      assertReadOnly(f)
      assert.deepEqual([...f.fs.files], before, 'observing and reporting never changes agent files or recovery budgets')
    })
  }
}

for (const when of ['cwd', 'report'] as const) {
  test(`checkup read only: unrecorded process born during ${when}`, async () => {
    const f = fixture('linux', false, 'tmux', 'stopped')
    f.race(when)
    await runCheckupJob(f.ctx, 'example-job', f.job)
    assert.equal(f.born, true, 'the race actually occurred')
    if (when === 'cwd') assert.ok(f.cwdQueries > 0)
    assertReadOnly(f)
  })
}

test('checkup no longer exports a start-only wrapper', () => {
  assert.equal('startStoppedAgent' in restart, false)
})

test('checkup pairing checks stay read only even with a legacy repair confirmation', async () => {
  const f = fixture('linux', false, 'tmux', 'stopped')
  const before = [...f.fs.files]
  f.ctx.fetch = async () => ({ ok: false, status: 401, text: async () => '{"code":"pairing_revoked"}' })
  f.job.pairingRepair = { confirmed: true, assistantId: ID, pairingId: 7, pairCode: 'EXAMPLE-CODE' }
  await runCheckupJob(f.ctx, 'example-job', f.job)
  assertReadOnly(f)
  assert.ok(f.progress.at(-1).findings.some((finding: any) => finding.cause === 'pairing_revoked'))
  assert.deepEqual([...f.fs.files], before)
})
