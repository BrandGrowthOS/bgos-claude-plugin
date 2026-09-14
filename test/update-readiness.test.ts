import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  ANCESTRY_MAX_DEPTH,
  KEEPALIVE_MARKER_FILE,
  RESTART_MARKER_FILE,
  SUPERVISOR_ENV_HANDLE,
  SUPERVISOR_ENV_KIND,
  SUPERVISOR_ENV_RESTART_CMD,
  SUPERVISOR_FILE,
  agentStateDir,
  buildDeclaredSupervisorBody,
  chooseRestartAuthority,
  decideSupervisorWrite,
  delayedDeclaredCommand,
  detectSupervision,
  isKeepaliveSessionProcess,
  keepaliveMarkerPath,
  keepaliveOwnsProcess,
  parseDeclaredSupervisorEnv,
  parseCommOutput,
  parseKeepaliveMarker,
  parseLaunchctlPrintPid,
  parsePpidOutput,
  parseSupervisorFile,
  parseSystemctlMainPid,
  probeServiceOwnership,
  readProcessAncestry,
  readServiceMainPid,
  resolveSupervision,
  restartMarkerPath,
  serviceFilePath,
  serviceLabel,
  serviceOwnsProcess,
  serviceRestartCommand,
  serviceUnit,
  supervisorFilePath,
  validAssistantId,
  wireSupervisedKind,
  type Supervision,
} from '../lib/update-readiness'
import {
  KEEPALIVE_MARKER_FILE_NAME,
  RESTART_MARKER_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  keepaliveMarkerBody,
  supervisorFileBody,
} from '../bin/hoai-core.mjs'
import { decideKeepaliveMarkerWrite } from '../bin/hoai-keepalive-marker.mjs'

const HOME = '/home/kc'

describe('the launcher file-name mirror', () => {
  test('lib and bin agree on the supervisor and marker file names', () => {
    // The daemon (lib) and the launcher (bin) meet only through these two
    // files; a rename on one side is a silently dead restart authority.
    expect(SUPERVISOR_FILE).toBe(SUPERVISOR_FILE_NAME)
    expect(RESTART_MARKER_FILE).toBe(RESTART_MARKER_FILE_NAME)
  })

  test('the launcher writes exactly what parseSupervisorFile accepts', () => {
    const parsed = parseSupervisorFile(supervisorFileBody(4242, '2026-08-22T00:00:00.000Z'))
    expect(parsed).toEqual({ pid: 4242, capabilities: ['relaunch'] })
  })
})

describe('validAssistantId', () => {
  test('digits only, everything else is null', () => {
    expect(validAssistantId('871')).toBe('871')
    expect(validAssistantId(871)).toBe('871')
    expect(validAssistantId(' 871 ')).toBe('871')
    expect(validAssistantId('871; rm -rf /')).toBeNull()
    expect(validAssistantId('')).toBeNull()
    expect(validAssistantId(null)).toBeNull()
    expect(validAssistantId(undefined)).toBeNull()
  })
})

describe('service and state paths', () => {
  test('mirror bin/bgos-agent naming per platform', () => {
    expect(serviceLabel('871')).toBe('ai.bgos.agent.871')
    expect(serviceUnit('871')).toBe('bgos-agent-871')
    expect(serviceFilePath('darwin', HOME, '871')).toBe(
      join(HOME, 'Library', 'LaunchAgents', 'ai.bgos.agent.871.plist'),
    )
    expect(serviceFilePath('linux', HOME, '871')).toBe(
      join(HOME, '.config', 'systemd', 'user', 'bgos-agent-871.service'),
    )
    expect(agentStateDir(HOME, '871')).toBe(join(HOME, '.bgos-agent', '871'))
    expect(supervisorFilePath(HOME, '871')).toBe(
      join(HOME, '.bgos-agent', '871', 'supervisor.json'),
    )
    expect(restartMarkerPath(HOME, '871')).toBe(
      join(HOME, '.bgos-agent', '871', 'restart-requested.json'),
    )
  })

  test('windows has no service file and invalid ids build no path at all', () => {
    expect(serviceFilePath('win32', HOME, '871')).toBeNull()
    expect(serviceFilePath('linux', HOME, 'evil id')).toBeNull()
    expect(supervisorFilePath(HOME, 'evil id')).toBeNull()
    expect(restartMarkerPath(HOME, null)).toBeNull()
  })
})

describe('parseSupervisorFile', () => {
  test('fail-closed on anything malformed', () => {
    expect(parseSupervisorFile(null)).toBeNull()
    expect(parseSupervisorFile('')).toBeNull()
    expect(parseSupervisorFile('not json')).toBeNull()
    expect(parseSupervisorFile('[]')).toBeNull()
    expect(parseSupervisorFile(JSON.stringify({ capabilities: ['relaunch'] }))).toBeNull()
    expect(parseSupervisorFile(JSON.stringify({ pid: 0, capabilities: ['relaunch'] }))).toBeNull()
    expect(parseSupervisorFile(JSON.stringify({ pid: 1.5, capabilities: ['relaunch'] }))).toBeNull()
  })

  test('keeps only string capabilities', () => {
    const parsed = parseSupervisorFile(
      JSON.stringify({ pid: 7, capabilities: ['relaunch', 42, null] }),
    )
    expect(parsed).toEqual({ pid: 7, capabilities: ['relaunch'] })
  })
})

describe('detectSupervision', () => {
  const base = {
    home: HOME,
    assistantId: '871',
    exists: () => false,
    readFile: () => null,
    pidAlive: () => true,
  }

  test('an installed service file wins per platform', () => {
    const plist = serviceFilePath('darwin', HOME, '871')!
    expect(
      detectSupervision({
        ...base,
        platform: 'darwin',
        exists: (p) => p === plist,
      }),
    ).toBe('launchd')
    const unit = serviceFilePath('linux', HOME, '871')!
    expect(
      detectSupervision({
        ...base,
        platform: 'linux',
        exists: (p) => p === unit,
      }),
    ).toBe('systemd')
  })

  test('a live launcher with the relaunch capability reports launcher', () => {
    const supPath = supervisorFilePath(HOME, '871')!
    expect(
      detectSupervision({
        ...base,
        platform: 'win32',
        readFile: (p) =>
          p === supPath ? JSON.stringify({ pid: 4242, capabilities: ['relaunch'] }) : null,
      }),
    ).toBe('launcher')
  })

  test('a dead pid, a missing capability, or junk is none, never a lie', () => {
    const supPath = supervisorFilePath(HOME, '871')!
    const withFile = (body: string, pidAlive: (pid: number) => boolean) =>
      detectSupervision({
        ...base,
        platform: 'win32',
        readFile: (p) => (p === supPath ? body : null),
        pidAlive,
      })
    expect(withFile(JSON.stringify({ pid: 4242, capabilities: ['relaunch'] }), () => false)).toBe(
      'none',
    )
    expect(withFile(JSON.stringify({ pid: 4242, capabilities: [] }), () => true)).toBe('none')
    expect(withFile('garbage', () => true)).toBe('none')
    expect(detectSupervision({ ...base, platform: 'win32' })).toBe('none')
  })
})

describe('serviceRestartCommand', () => {
  test('linux uses a delayed transient unit, darwin a delayed kickstart', () => {
    expect(serviceRestartCommand({ platform: 'linux', assistantId: '871', uid: null })).toEqual({
      file: 'systemd-run',
      args: ['--user', '--on-active=2', 'systemctl', '--user', 'restart', 'bgos-agent-871'],
    })
    expect(serviceRestartCommand({ platform: 'darwin', assistantId: '871', uid: 501 })).toEqual({
      file: '/bin/sh',
      args: ['-c', 'sleep 2 && launchctl kickstart -k gui/501/ai.bgos.agent.871'],
    })
  })

  test('no command without a valid id, a darwin uid, or a serviced platform', () => {
    expect(serviceRestartCommand({ platform: 'linux', assistantId: 'x', uid: null })).toBeNull()
    expect(serviceRestartCommand({ platform: 'darwin', assistantId: '871', uid: null })).toBeNull()
    expect(serviceRestartCommand({ platform: 'win32', assistantId: '871', uid: null })).toBeNull()
  })
})

describe('chooseRestartAuthority', () => {
  const base = {
    home: HOME,
    assistantId: '871',
    exists: () => false,
    readFile: () => null,
    pidAlive: () => true,
    uid: 501,
  }

  test('service beats launcher beats staged', () => {
    const unit = serviceFilePath('linux', HOME, '871')!
    expect(
      chooseRestartAuthority({ ...base, platform: 'linux', exists: (p) => p === unit }),
    ).toEqual({
      kind: 'service',
      service: { kind: 'systemd', handle: 'bgos-agent-871' },
      command: {
        file: 'systemd-run',
        args: ['--user', '--on-active=2', 'systemctl', '--user', 'restart', 'bgos-agent-871'],
      },
    })
    const supPath = supervisorFilePath(HOME, '871')!
    expect(
      chooseRestartAuthority({
        ...base,
        platform: 'win32',
        readFile: (p) =>
          p === supPath ? JSON.stringify({ pid: 4242, capabilities: ['relaunch'] }) : null,
      }),
    ).toEqual({ kind: 'launcher', markerPath: restartMarkerPath(HOME, '871')! })
    expect(chooseRestartAuthority({ ...base, platform: 'win32' })).toEqual({ kind: 'staged' })
  })

  test('a darwin service file with no uid falls through to staged, never a bad restart', () => {
    const plist = serviceFilePath('darwin', HOME, '871')!
    expect(
      chooseRestartAuthority({
        ...base,
        platform: 'darwin',
        exists: (p) => p === plist,
        uid: null,
      }),
    ).toEqual({ kind: 'staged' })
  })
})

describe('the discovery tier: a supervisor that did not install itself under our name', () => {
  const PLIST = `${HOME}/Library/LaunchAgents/ai.bgos.session.871.plist`
  const JOB = JSON.stringify({
    Label: 'ai.bgos.session.871',
    ProgramArguments: ['/bin/bash', `${HOME}/.bgos-session-871/keepalive.sh`],
    WorkingDirectory: `${HOME}/Voxor/Vexa`,
  })

  function host(files: Record<string, string>, loaded: string[]) {
    return {
      exists: (p: string) => p in files,
      readFile: (p: string) => (p in files ? files[p]! : null),
      listDir: (dir: string) =>
        Object.keys(files)
          .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
          .map((p) => p.slice(dir.length + 1)),
      execSync: (file: string, args: string[]) => {
        if (file === 'launchctl' && args[0] === 'list') {
          return { code: 0, stdout: ['PID\tStatus\tLabel', ...loaded.map((l) => `1\t0\t${l}`)].join('\n') }
        }
        if (file === 'plutil') {
          const path = args[args.length - 1]!
          return path in files ? { code: 0, stdout: files[path]! } : { code: 1, stdout: '' }
        }
        return { code: 127, stdout: '' }
      },
    }
  }

  const supervised = {
    platform: 'darwin',
    home: HOME,
    assistantId: '871',
    cwd: `${HOME}/Voxor/Vexa`,
    pidAlive: () => false,
    ...host({ [PLIST]: JOB }, ['ai.bgos.session.871']),
  }

  test('an agent launchd holds under a bespoke label reports launchd, not none', () => {
    // Before discovery this was 'none' and the app refused the one-click
    // update button for a daemon launchd would have restarted on request.
    expect(detectSupervision(supervised)).toBe('launchd')
    const resolved = resolveSupervision(supervised)
    expect(resolved.service?.handle).toBe('ai.bgos.session.871')
    expect(resolved.service?.via).toBe('working-directory')
  })

  test('the restart is addressed to the DISCOVERED label, so it goes through that supervisor', () => {
    // launchctl kickstart -k makes launchd re-run its own launch recipe, in
    // its own WorkingDirectory, reading its own .mcp.json. That is what keeps
    // a restart from starting the agent as somebody else.
    expect(chooseRestartAuthority({ ...supervised, uid: 501 })).toEqual({
      kind: 'service',
      service: { kind: 'launchd', handle: 'ai.bgos.session.871' },
      command: {
        file: '/bin/sh',
        args: ['-c', 'sleep 2 && launchctl kickstart -k gui/501/ai.bgos.session.871'],
      },
    })
  })

  test('unsupervised stays none with every probe wired, and staged stays the fallback', () => {
    const unsupervised = { ...supervised, cwd: `${HOME}/somewhere/else` }
    expect(detectSupervision(unsupervised)).toBe('none')
    expect(chooseRestartAuthority({ ...unsupervised, uid: 501 })).toEqual({ kind: 'staged' })
    // A job that exists on disk but is not loaded cannot restart anything.
    const dormant = { ...supervised, ...host({ [PLIST]: JOB }, ['com.apple.mdworker']) }
    expect(detectSupervision(dormant)).toBe('none')
  })

  test('the canonical service still answers first, with no platform call at all', () => {
    const plist = serviceFilePath('darwin', HOME, '871')!
    let execCalls = 0
    const resolved = resolveSupervision({
      ...supervised,
      exists: (p: string) => p === plist,
      execSync: (file: string, args: string[]) => {
        execCalls += 1
        return { code: 127, stdout: '' }
      },
    })
    expect(resolved.supervised).toBe('launchd')
    expect(resolved.service?.handle).toBe('ai.bgos.agent.871')
    expect(resolved.service?.via).toBe('canonical-file')
    expect(execCalls).toBe(0)
  })

  test('a live launcher is still preferred over nothing when no service is found', () => {
    const supPath = supervisorFilePath(HOME, '871')!
    const files = { [supPath]: JSON.stringify({ pid: 4242, capabilities: ['relaunch'] }) }
    const probe = {
      ...supervised,
      ...host(files, []),
      pidAlive: () => true,
    }
    expect(detectSupervision(probe)).toBe('launcher')
    expect(chooseRestartAuthority({ ...probe, uid: 501 })).toEqual({
      kind: 'launcher',
      markerPath: restartMarkerPath(HOME, '871')!,
    })
  })
})

describe('the env contract: a launcher declares what supervises this session', () => {
  test('launchd/systemd need a safe handle; launcher does not', () => {
    expect(
      parseDeclaredSupervisorEnv({
        [SUPERVISOR_ENV_KIND]: 'launchd',
        [SUPERVISOR_ENV_HANDLE]: 'ai.bgos.claude.session',
      }),
    ).toEqual({ kind: 'launchd', handle: 'ai.bgos.claude.session', restartCommand: null })
    expect(
      parseDeclaredSupervisorEnv({
        [SUPERVISOR_ENV_KIND]: 'systemd',
        [SUPERVISOR_ENV_HANDLE]: 'bgos-agent-871',
      }),
    ).toEqual({ kind: 'systemd', handle: 'bgos-agent-871', restartCommand: null })
    expect(parseDeclaredSupervisorEnv({ [SUPERVISOR_ENV_KIND]: 'launcher' })).toEqual({
      kind: 'launcher',
      handle: null,
      restartCommand: null,
    })
  })

  test('an optional explicit relaunch command is parsed from JSON', () => {
    expect(
      parseDeclaredSupervisorEnv({
        [SUPERVISOR_ENV_KIND]: 'launchd',
        [SUPERVISOR_ENV_HANDLE]: 'ai.bgos.session.871',
        [SUPERVISOR_ENV_RESTART_CMD]: JSON.stringify({ file: '/opt/keepalive.sh', args: ['--kick', '871'] }),
      }),
    ).toEqual({
      kind: 'launchd',
      handle: 'ai.bgos.session.871',
      restartCommand: { file: '/opt/keepalive.sh', args: ['--kick', '871'] },
    })
  })

  test('absent, unknown, unsafe, or malformed declarations are null (never a wrong authority)', () => {
    expect(parseDeclaredSupervisorEnv({})).toBeNull()
    expect(parseDeclaredSupervisorEnv({ [SUPERVISOR_ENV_KIND]: '  ' })).toBeNull()
    expect(parseDeclaredSupervisorEnv({ [SUPERVISOR_ENV_KIND]: 'pm2' })).toBeNull()
    // launchd/systemd with no handle, or an unsafe one, declares nothing.
    expect(parseDeclaredSupervisorEnv({ [SUPERVISOR_ENV_KIND]: 'launchd' })).toBeNull()
    expect(
      parseDeclaredSupervisorEnv({
        [SUPERVISOR_ENV_KIND]: 'launchd',
        [SUPERVISOR_ENV_HANDLE]: 'ai.bgos; rm -rf /',
      }),
    ).toBeNull()
    // A present-but-broken restart command fails the WHOLE declaration closed.
    expect(
      parseDeclaredSupervisorEnv({
        [SUPERVISOR_ENV_KIND]: 'launchd',
        [SUPERVISOR_ENV_HANDLE]: 'ai.bgos.session.871',
        [SUPERVISOR_ENV_RESTART_CMD]: 'not json',
      }),
    ).toBeNull()
    expect(
      parseDeclaredSupervisorEnv({
        [SUPERVISOR_ENV_KIND]: 'systemd',
        [SUPERVISOR_ENV_HANDLE]: 'bgos-agent-871',
        [SUPERVISOR_ENV_RESTART_CMD]: JSON.stringify({ args: ['no file'] }),
      }),
    ).toBeNull()
  })
})

describe('buildDeclaredSupervisorBody: a declared service is not a marker launcher', () => {
  test('a service declaration carries the handle and NO relaunch capability', () => {
    const body = buildDeclaredSupervisorBody({
      declared: { kind: 'launchd', handle: 'ai.bgos.session.871', restartCommand: null },
      pid: 4242,
      startedAt: '2026-08-30T00:00:00.000Z',
    })
    expect(JSON.parse(body)).toEqual({
      pid: 4242,
      capabilities: [],
      startedAt: '2026-08-30T00:00:00.000Z',
      supervisor: { kind: 'launchd', handle: 'ai.bgos.session.871' },
    })
    // And it round-trips through the parser into the declared block.
    expect(parseSupervisorFile(body)).toEqual({
      pid: 4242,
      capabilities: [],
      declared: { kind: 'launchd', handle: 'ai.bgos.session.871', restartCommand: null },
    })
  })

  test('a launcher declaration DOES carry the relaunch capability (it watches the marker)', () => {
    const body = buildDeclaredSupervisorBody({
      declared: { kind: 'launcher', handle: null, restartCommand: null },
      pid: 7,
      startedAt: '2026-08-30T00:00:00.000Z',
    })
    expect(JSON.parse(body).capabilities).toEqual(['relaunch'])
  })
})

describe('resolveSupervision consumes a declared service authority', () => {
  const supPath = supervisorFilePath(HOME, '871')!
  const base = {
    platform: 'darwin',
    home: HOME,
    assistantId: '871',
    exists: () => false,
    listDir: () => [],
    execSync: () => ({ code: 127, stdout: '' }),
    pidAlive: () => true,
  }
  const declaredBody = buildDeclaredSupervisorBody({
    declared: { kind: 'launchd', handle: 'ai.bgos.claude.session', restartCommand: null },
    pid: 4242,
    startedAt: '2026-08-30T00:00:00.000Z',
  })

  test('a declared launchd label resolves to launchd via:declared, even with the platform blind', () => {
    // The platform guess (exists/listDir/execSync) finds NOTHING here, exactly
    // like the legacy bespoke-label case. The declaration alone resolves it.
    const probe = { ...base, readFile: (p: string) => (p === supPath ? declaredBody : null) }
    expect(detectSupervision(probe)).toBe('launchd')
    const resolved = resolveSupervision(probe)
    expect(resolved.service?.handle).toBe('ai.bgos.claude.session')
    expect(resolved.service?.via).toBe('declared')
    // The restart is addressed to the DECLARED label, through its supervisor.
    expect(chooseRestartAuthority({ ...probe, uid: 501 })).toEqual({
      kind: 'service',
      service: { kind: 'launchd', handle: 'ai.bgos.claude.session' },
      command: { file: '/bin/sh', args: ['-c', 'sleep 2 && launchctl kickstart -k gui/501/ai.bgos.claude.session'] },
    })
  })

  test('a stale declaration (dead pid) is none, never a lie', () => {
    const probe = {
      ...base,
      readFile: (p: string) => (p === supPath ? declaredBody : null),
      pidAlive: () => false,
    }
    expect(detectSupervision(probe)).toBe('none')
    expect(chooseRestartAuthority({ ...probe, uid: 501 })).toEqual({ kind: 'staged' })
  })

  test('an explicit declared relaunch command overrides the handle-built one, injection-safe', () => {
    const body = buildDeclaredSupervisorBody({
      declared: {
        kind: 'launchd',
        handle: 'ai.bgos.session.871',
        restartCommand: { file: '/opt/keepalive.sh', args: ['--kick', '871'] },
      },
      pid: 4242,
      startedAt: '2026-08-30T00:00:00.000Z',
    })
    const probe = { ...base, readFile: (p: string) => (p === supPath ? body : null) }
    expect(chooseRestartAuthority({ ...probe, uid: 501 })).toEqual({
      kind: 'service',
      service: { kind: 'launchd', handle: 'ai.bgos.session.871' },
      command: { file: '/bin/sh', args: ['-c', 'sleep 2 && exec "$0" "$@"', '/opt/keepalive.sh', '--kick', '871'] },
    })
  })

  test('the canonical installed service still wins over a declaration', () => {
    const plist = serviceFilePath('darwin', HOME, '871')!
    const probe = {
      ...base,
      exists: (p: string) => p === plist,
      readFile: (p: string) => (p === supPath ? declaredBody : null),
    }
    const resolved = resolveSupervision(probe)
    expect(resolved.service?.handle).toBe('ai.bgos.agent.871')
    expect(resolved.service?.via).toBe('canonical-file')
  })
})

describe('service ownership: a job is a restart authority only when it holds this process', () => {
  // Pids are the live control taken on the dev Mac on 2026-09-12: argus's
  // daemon (240) chains to 99136, the main pid of ai.bgos.agent.1050, so that
  // job owns it; the BGOS daemon (52214) chains through a detached tmux (798)
  // to launchd, and the keepalive job it declared (97998) is nowhere in it.
  test('serviceOwnsProcess: the job pid must be in the ancestry; nothing else counts', () => {
    const cases: Array<[number[], number | null, boolean]> = [
      [[240, 99845, 99827, 99136, 1], 99136, true],
      [[4242], 4242, true],
      [[52214, 52034, 52030, 798, 1], 97998, false],
      [[4242, 1], null, false],
      [[], 4242, false],
      [[4242, 1], 1, false],
      [[4242, 1], 0, false],
      [[4242, 1], -5, false],
      [[4242, 1], 4242.5, false],
    ]
    for (const [ancestry, servicePid, expected] of cases) {
      expect(serviceOwnsProcess(ancestry, servicePid)).toBe(expected)
    }
  })

  test('parsePpidOutput: the one integer ps prints, whitespace tolerated, anything else null', () => {
    expect(parsePpidOutput(' 52034\n')).toBe(52034)
    expect(parsePpidOutput('1')).toBe(1)
    expect(parsePpidOutput('0\n')).toBe(0)
    expect(parsePpidOutput('')).toBeNull()
    expect(parsePpidOutput('ps: illegal option')).toBeNull()
    expect(parsePpidOutput('12 34')).toBeNull()
  })

  test('readProcessAncestry: walks ppid to 1, self first, stopping at the first unreadable link', () => {
    const tree: Record<number, number> = { 240: 99845, 99845: 99827, 99827: 99136, 99136: 1 }
    const calls: string[][] = []
    const execSync = (file: string, args: string[]) => {
      calls.push([file, ...args])
      const pid = Number(args[args.length - 1])
      return pid in tree ? { code: 0, stdout: ` ${tree[pid]}\n` } : { code: 1, stdout: '' }
    }
    expect(readProcessAncestry(240, execSync)).toEqual([240, 99845, 99827, 99136, 1])
    expect(calls[0]).toEqual(['ps', '-o', 'ppid=', '-p', '240'])
    // pid 1 is the end of every chain and is never queried.
    expect(calls.some((c) => c[c.length - 1] === '1')).toBe(false)
    // A link ps cannot read ends the walk with what was read so far.
    expect(readProcessAncestry(7, execSync)).toEqual([7])
    // A ppid of 0 (a kernel-owned parent) ends the walk too.
    expect(readProcessAncestry(9, () => ({ code: 0, stdout: '0\n' }))).toEqual([9])
  })

  test('readProcessAncestry: bounded and cycle-safe', () => {
    // A ps that claims every pid's parent is 2 would loop forever unbounded.
    expect(readProcessAncestry(5, () => ({ code: 0, stdout: '2\n' }))).toEqual([5, 2])
    let n = 1000
    const deep = readProcessAncestry(n, () => ({ code: 0, stdout: `${++n}\n` }))
    expect(deep.length).toBe(ANCESTRY_MAX_DEPTH)
  })

  test('parseLaunchctlPrintPid: the top-level pid line of a running job; not running or unknown is null', () => {
    // Shape of a real `launchctl print gui/501/ai.bgos.agent.1050` on 2026-09-12.
    const running = [
      'gui/501/ai.bgos.agent.1050 = {',
      '\tactive count = 1',
      '\tpath = /Users/kc/Library/LaunchAgents/ai.bgos.agent.1050.plist',
      '\tstate = running',
      '',
      '\tprogram = /bin/bash',
      '\tpid = 99136',
      '\tendpoints = {',
      '\t\t"ai.bgos.agent.1050" = {',
      '\t\t\tstate = active',
      '\t\t}',
      '\t}',
      '}',
    ].join('\n')
    expect(parseLaunchctlPrintPid(running)).toBe(99136)
    const notRunning = running
      .split('\n')
      .filter((l) => !l.includes('pid = '))
      .join('\n')
      .replace('state = running', 'state = not running')
    expect(parseLaunchctlPrintPid(notRunning)).toBeNull()
    expect(
      parseLaunchctlPrintPid('Bad request.\nCould not find service "x" in domain for user gui: 501\n'),
    ).toBeNull()
    expect(parseLaunchctlPrintPid('')).toBeNull()
    // Neither a pid inside another word nor an exit-code line matches.
    expect(parseLaunchctlPrintPid('\tlast exit code = 0\n\tspid = 3\n')).toBeNull()
  })

  test('parseSystemctlMainPid: MainPID=N; 0 (inactive) and junk are null', () => {
    expect(parseSystemctlMainPid('MainPID=12345\n')).toBe(12345)
    expect(parseSystemctlMainPid('MainPID=0\n')).toBeNull()
    expect(parseSystemctlMainPid('')).toBeNull()
    expect(parseSystemctlMainPid('Unit x.service could not be found.\n')).toBeNull()
  })

  test('readServiceMainPid: the exact platform query, fail-closed without a uid or with an unsafe handle', () => {
    const calls: string[][] = []
    const execSync = (file: string, args: string[]) => {
      calls.push([file, ...args])
      if (file === 'launchctl') return { code: 0, stdout: '\tstate = running\n\tpid = 99136\n' }
      if (file === 'systemctl') return { code: 0, stdout: 'MainPID=4242\n' }
      return { code: 127, stdout: '' }
    }
    expect(readServiceMainPid({ kind: 'launchd', handle: 'ai.bgos.agent.1050', uid: 501, execSync })).toBe(99136)
    expect(calls[0]).toEqual(['launchctl', 'print', 'gui/501/ai.bgos.agent.1050'])
    expect(readServiceMainPid({ kind: 'systemd', handle: 'bgos-agent-871', uid: null, execSync })).toBe(4242)
    expect(calls[1]).toEqual(['systemctl', '--user', 'show', '-p', 'MainPID', 'bgos-agent-871'])
    calls.length = 0
    expect(readServiceMainPid({ kind: 'launchd', handle: 'ai.bgos.agent.1050', uid: null, execSync })).toBeNull()
    expect(readServiceMainPid({ kind: 'launchd', handle: 'ai.bgos; rm -rf /', uid: 501, execSync })).toBeNull()
    expect(calls).toEqual([])
    // A failing command is null, never a guess.
    expect(
      readServiceMainPid({
        kind: 'launchd',
        handle: 'ai.bgos.agent.1050',
        uid: 501,
        execSync: () => ({ code: 113, stdout: '' }),
      }),
    ).toBeNull()
  })

  test('probeServiceOwnership: both readings, raw, for the handler to decide with serviceOwnsProcess', () => {
    const tree: Record<number, number> = { 240: 99845, 99845: 99827, 99827: 99136, 99136: 1 }
    const execSync = (file: string, args: string[]) => {
      if (file === 'ps') {
        const pid = Number(args[args.length - 1])
        return pid in tree ? { code: 0, stdout: `${tree[pid]}\n` } : { code: 1, stdout: '' }
      }
      if (file === 'launchctl') return { code: 0, stdout: '\tpid = 99136\n' }
      return { code: 127, stdout: '' }
    }
    const reading = probeServiceOwnership({
      ownPid: 240,
      service: { kind: 'launchd', handle: 'ai.bgos.agent.1050' },
      uid: 501,
      execSync,
    })
    expect(reading).toEqual({ ownPid: 240, ancestorPids: [240, 99845, 99827, 99136, 1], servicePid: 99136 })
    expect(serviceOwnsProcess(reading.ancestorPids, reading.servicePid)).toBe(true)
  })

  test('chooseRestartAuthority carries the job it resolved, so the handler can verify ownership', () => {
    const unit = serviceFilePath('linux', HOME, '871')!
    const authority = chooseRestartAuthority({
      platform: 'linux',
      home: HOME,
      assistantId: '871',
      exists: (p) => p === unit,
      readFile: () => null,
      pidAlive: () => true,
      uid: null,
    })
    expect(authority.kind).toBe('service')
    if (authority.kind !== 'service') throw new Error('unreachable')
    expect(authority.service).toEqual({ kind: 'systemd', handle: 'bgos-agent-871' })
  })
})

describe('delayedDeclaredCommand', () => {
  test('wraps with a delayed sh that passes argv positionally, never spliced', () => {
    expect(delayedDeclaredCommand({ file: '/x/y', args: ['a', 'b c'] }, 2)).toEqual({
      file: '/bin/sh',
      args: ['-c', 'sleep 2 && exec "$0" "$@"', '/x/y', 'a', 'b c'],
    })
  })
  test('no delay runs verbatim; a bad command is null', () => {
    expect(delayedDeclaredCommand({ file: '/x', args: ['a'] }, 0)).toEqual({ file: '/x', args: ['a'] })
    expect(delayedDeclaredCommand(null, 2)).toBeNull()
    expect(delayedDeclaredCommand({ file: '   ', args: [] }, 2)).toBeNull()
  })
})

describe('decideSupervisorWrite: the boot writer decision', () => {
  const NONE: Supervision = { supervised: 'none', service: null }
  const startedAt = '2026-08-30T00:00:00.000Z'

  test('env-declared writes the declared body', () => {
    const decision = decideSupervisorWrite({
      env: { [SUPERVISOR_ENV_KIND]: 'launchd', [SUPERVISOR_ENV_HANDLE]: 'ai.bgos.claude.session' },
      existingRaw: null,
      ownPid: 4242,
      startedAt,
      detection: NONE,
    })
    expect(decision.action).toBe('write')
    if (decision.action !== 'write') throw new Error('unreachable')
    expect(decision.reason).toBe('env-declared')
    // And what it writes resolves right back to a launchd service.
    const resolved = resolveSupervision({
      platform: 'darwin',
      home: HOME,
      assistantId: '871',
      exists: () => false,
      listDir: () => [],
      execSync: () => ({ code: 127, stdout: '' }),
      pidAlive: () => true,
      readFile: (p) => (p === supervisorFilePath(HOME, '871') ? decision.body : null),
    })
    expect(resolved.supervised).toBe('launchd')
    expect(resolved.service?.handle).toBe('ai.bgos.claude.session')
  })

  test('a present-but-invalid env writes NOTHING (a wrong file is worse than none)', () => {
    const decision = decideSupervisorWrite({
      env: { [SUPERVISOR_ENV_KIND]: 'launchd' }, // no handle
      existingRaw: null,
      ownPid: 4242,
      startedAt,
      detection: NONE,
    })
    expect(decision).toEqual({ action: 'skip', reason: 'invalid-env' })
  })

  test('no env falls back to a CONFIDENT detection, and writes nothing otherwise', () => {
    const detected: Supervision = {
      supervised: 'launchd',
      service: { kind: 'launchd', handle: 'ai.bgos.session.871', via: 'working-directory', file: null },
    }
    const write = decideSupervisorWrite({ env: {}, existingRaw: null, ownPid: 4242, startedAt, detection: detected })
    expect(write.action).toBe('write')
    if (write.action !== 'write') throw new Error('unreachable')
    expect(write.reason).toBe('detected-launchd')
    expect(JSON.parse(write.body).supervisor).toEqual({ kind: 'launchd', handle: 'ai.bgos.session.871' })
    // No env and no confident authority: write nothing rather than a guess.
    expect(decideSupervisorWrite({ env: {}, existingRaw: null, ownPid: 4242, startedAt, detection: NONE })).toEqual({
      action: 'skip',
      reason: 'no-confident-authority',
    })
  })

  test('never clobbers a supervisor.json a DIFFERENT live supervisor owns', () => {
    // A running hoai supervise loop wrote its own launcher pid; the daemon must
    // not overwrite it with its own, which would break the marker/singleton.
    const foreign = JSON.stringify({ pid: 9999, capabilities: ['relaunch'] })
    const decision = decideSupervisorWrite({
      env: { [SUPERVISOR_ENV_KIND]: 'launchd', [SUPERVISOR_ENV_HANDLE]: 'ai.bgos.claude.session' },
      existingRaw: foreign,
      ownPid: 4242,
      startedAt,
      detection: NONE,
      pidAlive: (pid) => pid === 9999,
    })
    expect(decision).toEqual({ action: 'skip', reason: 'live-supervisor-owns' })
  })

  test('a stale file (dead owner) or our own pid does not block a refresh', () => {
    const stale = JSON.stringify({ pid: 9999, capabilities: ['relaunch'] })
    const decision = decideSupervisorWrite({
      env: { [SUPERVISOR_ENV_KIND]: 'launcher' },
      existingRaw: stale,
      ownPid: 4242,
      startedAt,
      detection: NONE,
      pidAlive: () => false, // the prior owner is gone
    })
    expect(decision.action).toBe('write')
  })
})

// ---------------------------------------------------------------------------
// The keepalive tier (2026-09-13). A keepalive SCRIPT launches claude inside a
// DETACHED tmux session, so the script's pid is never in the daemon's
// ancestry: measured live on KC's Mac on 2026-09-13, a session's chain is
// claude > expect > tmux server > launchd, and the keepalive pids (33108,
// 33150, 33154) appear in none of them. The binding that DOES hold is the
// claude pid the keepalive launched, which is the daemon's own ancestor and
// the process a restart has to signal.
// ---------------------------------------------------------------------------

describe('the keepalive tier: a launcher that starts the session in a detached tmux', () => {
  const KEEPALIVE_PID = 33108
  const CLAUDE_PID = 35759
  const OWN_PID = 63948
  /** Measured on KC's Mac: the daemon sits under claude > expect > tmux > launchd. */
  const TREE: Record<number, number> = {
    [OWN_PID]: CLAUDE_PID,
    [CLAUDE_PID]: 35755,
    35755: 798,
    798: 1,
  }
  /** comm for each pid in the chain, as `ps -o comm=` prints it on this Mac
   *  (an absolute path for a path-launched binary). */
  const COMM: Record<number, string> = {
    [OWN_PID]: '/opt/homebrew/bin/bun',
    [CLAUDE_PID]: '/Users/fitecho/.local/bin/claude',
    35755: '/usr/bin/expect',
    798: '/opt/homebrew/bin/tmux',
  }
  const psExec = (_file: string, args: string[]) => {
    const pid = Number(args[args.length - 1])
    if (args.includes('comm=')) {
      return pid in COMM ? { code: 0, stdout: `${COMM[pid]}\n` } : { code: 1, stdout: '' }
    }
    return pid in TREE ? { code: 0, stdout: ` ${TREE[pid]}\n` } : { code: 1, stdout: '' }
  }
  const markerPath = keepaliveMarkerPath(HOME, '910')!
  const body = keepaliveMarkerBody({
    pid: KEEPALIVE_PID,
    claudePid: CLAUDE_PID,
    tmuxSession: 'agent-910',
    startedAt: '2026-09-13T00:00:00.000Z',
  })
  const base = {
    platform: 'darwin',
    home: HOME,
    assistantId: '910',
    ownPid: OWN_PID,
    exists: () => false,
    readFile: (p: string) => (p === markerPath ? body : null),
    pidAlive: (pid: number) => pid === KEEPALIVE_PID,
    execSync: psExec,
  }

  test('the writer writes exactly what the daemon accepts, in the file the daemon reads', () => {
    // bin (the keepalive-side writer) and lib (the daemon-side parser) meet
    // only through this file; a rename or a field drop on one side is a
    // silently dead restart authority.
    expect(KEEPALIVE_MARKER_FILE).toBe(KEEPALIVE_MARKER_FILE_NAME)
    expect(markerPath).toBe(join(HOME, '.bgos-agent', '910', 'keepalive.json'))
    expect(parseKeepaliveMarker(body)).toEqual({
      pid: KEEPALIVE_PID,
      claudePid: CLAUDE_PID,
      tmuxSession: 'agent-910',
    })
  })

  test('parseKeepaliveMarker is fail-closed: every malformed body is null', () => {
    const full = {
      kind: 'keepalive',
      pid: KEEPALIVE_PID,
      claudePid: CLAUDE_PID,
      capabilities: ['relaunch'],
    }
    expect(parseKeepaliveMarker(JSON.stringify(full))?.tmuxSession).toBeNull()
    const rejected: Array<Record<string, unknown>> = [
      { ...full, kind: 'launcher' }, // not this contract
      { ...full, kind: undefined },
      { ...full, capabilities: [] }, // no relaunch promise
      { ...full, capabilities: 'relaunch' },
      { ...full, pid: 1 }, // init restarts no one
      { ...full, pid: 0 },
      { ...full, pid: -3 },
      { ...full, pid: 4.5 },
      { ...full, pid: '33108' },
      { ...full, claudePid: 1 },
      { ...full, claudePid: undefined },
      { ...full, claudePid: null },
    ]
    for (const value of rejected) {
      expect(parseKeepaliveMarker(JSON.stringify(value))).toBeNull()
    }
    expect(parseKeepaliveMarker('garbage')).toBeNull()
    expect(parseKeepaliveMarker('[]')).toBeNull()
    expect(parseKeepaliveMarker('')).toBeNull()
    expect(parseKeepaliveMarker(null)).toBeNull()
  })

  test('tmuxSession is collapsed and capped: it reaches a log line', () => {
    // The only free-text field in the marker. Nothing acts on it, but it is
    // printed in the restart log line, where a newline would split one record
    // into two.
    const withNewline = JSON.stringify({
      kind: 'keepalive',
      pid: KEEPALIVE_PID,
      claudePid: CLAUDE_PID,
      capabilities: ['relaunch'],
      tmuxSession: ' agent-910\nFAKE LOG LINE ',
    })
    expect(parseKeepaliveMarker(withNewline)?.tmuxSession).toBe('agent-910 FAKE LOG LINE')
    const long = JSON.stringify({
      kind: 'keepalive',
      pid: KEEPALIVE_PID,
      claudePid: CLAUDE_PID,
      capabilities: ['relaunch'],
      tmuxSession: 'x'.repeat(500),
    })
    expect(parseKeepaliveMarker(long)?.tmuxSession?.length).toBe(64)
  })

  test('keepaliveOwnsProcess: the session it launched must be one of our ancestors', () => {
    const marker = parseKeepaliveMarker(body)!
    const ancestry = [OWN_PID, CLAUDE_PID, 35755, 798, 1]
    expect(keepaliveOwnsProcess(ancestry, marker)).toBe(true)
    // Another agent's marker: the session it names is not in our chain.
    expect(keepaliveOwnsProcess([OWN_PID, 52034, 798, 1], marker)).toBe(false)
    expect(keepaliveOwnsProcess([], marker)).toBe(false)
    expect(keepaliveOwnsProcess(ancestry, null)).toBe(false)
  })

  test('our OWN pid is not a session we can restart by signalling', () => {
    // readProcessAncestry puts self first, and the invariant this rule needs is
    // "killing this pid takes this process with it". That holds for a strict
    // ancestor and not for us: signalling ourselves kills the daemon while
    // claude lives on, so the keepalive never relaunches and the agent is gone.
    const selfMarker = parseKeepaliveMarker(
      keepaliveMarkerBody({
        pid: KEEPALIVE_PID,
        claudePid: OWN_PID,
        tmuxSession: null,
        startedAt: '2026-09-13T00:00:00.000Z',
      }),
    )!
    expect(keepaliveOwnsProcess([OWN_PID, CLAUDE_PID, 35755, 798, 1], selfMarker)).toBe(false)
  })

  test('a live keepalive pid in our chain does NOT vouch for a session pid that is not', () => {
    // The pid we SIGNAL has to be the pid we PROVED. A marker whose own pid is
    // one of our ancestors (so the cheap half of the check passes) but whose
    // claudePid is some unrelated process would otherwise have us kill that
    // unrelated process and restart nothing. Same-user, so this is a
    // correctness rule before it is a security one: a writer that races and
    // records the wrong session pid must be refused, not obeyed.
    const mismatched = parseKeepaliveMarker(
      keepaliveMarkerBody({
        pid: KEEPALIVE_PID,
        claudePid: 424242,
        tmuxSession: null,
        startedAt: '2026-09-13T00:00:00.000Z',
      }),
    )!
    expect(keepaliveOwnsProcess([OWN_PID, KEEPALIVE_PID, 1], mismatched)).toBe(false)
  })

  test('an alive keepalive whose session is our ancestor reports keepalive', () => {
    expect(detectSupervision(base)).toBe('keepalive')
    expect(resolveSupervision(base).keepalive).toEqual({
      pid: KEEPALIVE_PID,
      claudePid: CLAUDE_PID,
      tmuxSession: 'agent-910',
    })
  })

  test('a DEAD keepalive pid is ignored and the older tiers answer instead', () => {
    // The positive control is the same probe with the pid alive (above): this
    // asserts the liveness check is what changed the answer, not the fixture.
    const plist = serviceFilePath('darwin', HOME, '910')!
    const probe = { ...base, exists: (p: string) => p === plist, pidAlive: () => false }
    expect(detectSupervision(probe)).toBe('launchd')
    expect(detectSupervision({ ...probe, pidAlive: (pid: number) => pid === KEEPALIVE_PID })).toBe(
      'keepalive',
    )
  })

  test('a marker for a session that is NOT our ancestor is ignored', () => {
    const plist = serviceFilePath('darwin', HOME, '910')!
    const foreign = keepaliveMarkerBody({
      pid: KEEPALIVE_PID,
      claudePid: 99999, // another agent's session
      tmuxSession: 'agent-918',
      startedAt: '2026-09-13T00:00:00.000Z',
    })
    const probe = {
      ...base,
      exists: (p: string) => p === plist,
      readFile: (p: string) => (p === markerPath ? foreign : null),
    }
    expect(detectSupervision(probe)).toBe('launchd')
  })

  // Defence in depth rather than the only guard: readProcessAncestry is
  // itself fail-closed on a non-integer pid, so this pins the CONTRACT (a
  // caller that forgets the anchor gets no keepalive tier) and not one line.
  // The ancestry check itself is pinned by the foreign-marker test above.
  test('a shared ancestor is not our session: the tmux server is refused', () => {
    // Measured on KC's Mac 2026-09-13: ONE tmux server (798) is a strict
    // ancestor of EVERY session on the host, so an ancestry test alone lets a
    // marker naming 798 bind to all nine daemons at once, and the restart would
    // SIGTERM the tmux server and take the whole fleet down mid-turn. Being an
    // ancestor is necessary and not sufficient: the pid has to BE a claude
    // session, which is what the marker claims it is.
    const plist = serviceFilePath('darwin', HOME, '910')!
    const sharedAncestor = keepaliveMarkerBody({
      pid: KEEPALIVE_PID,
      claudePid: 798,
      tmuxSession: 'agent-910',
      startedAt: '2026-09-13T00:00:00.000Z',
    })
    expect(
      detectSupervision({
        ...base,
        exists: (p: string) => p === plist,
        readFile: (p: string) => (p === markerPath ? sharedAncestor : null),
      }),
    ).toBe('launchd')
  })

  test('isKeepaliveSessionProcess: only a claude binary, by basename', () => {
    expect(isKeepaliveSessionProcess('/Users/fitecho/.local/bin/claude')).toBe(true)
    expect(isKeepaliveSessionProcess('claude')).toBe(true)
    expect(isKeepaliveSessionProcess('/opt/homebrew/bin/tmux')).toBe(false)
    expect(isKeepaliveSessionProcess('/usr/bin/expect')).toBe(false)
    expect(isKeepaliveSessionProcess('launchd')).toBe(false)
    expect(isKeepaliveSessionProcess('claude-code')).toBe(false)
    expect(isKeepaliveSessionProcess('')).toBe(false)
    expect(isKeepaliveSessionProcess(null)).toBe(false)
  })

  test('parseCommOutput: the one line ps prints, trimmed, anything else null', () => {
    expect(parseCommOutput('/usr/bin/expect\n')).toBe('/usr/bin/expect')
    expect(parseCommOutput('  claude  ')).toBe('claude')
    expect(parseCommOutput('')).toBeNull()
    expect(parseCommOutput('a\nb\n')).toBeNull()
  })

  test('a ps that cannot name the session refuses it, never assumes', () => {
    // Fail-closed: an unreadable comm is not evidence that the pid is claude.
    expect(detectSupervision({ ...base, execSync: (f, a) => (a.includes('comm=') ? { code: 1, stdout: '' } : psExec(f, a)) })).toBe('none')
  })

  test('without ownPid or execSync the tier cannot prove ownership and does not fire', () => {
    const { ownPid: _ownPid, ...noPid } = base
    expect(detectSupervision(noPid)).toBe('none')
    const { execSync: _exec, ...noExec } = base
    expect(detectSupervision(noExec)).toBe('none')
  })

  test('chooseRestartAuthority hands back the session pid to signal, never a command', () => {
    expect(chooseRestartAuthority({ ...base, uid: 501 })).toEqual({
      kind: 'keepalive',
      sessionPid: CLAUDE_PID,
      keepalivePid: KEEPALIVE_PID,
      tmuxSession: 'agent-910',
    })
  })

  test('a proven keepalive beats an installed service file that never held us', () => {
    // This is the whole point: the canonical plist tier answered 'launchd' for
    // these sessions and the app offered a one-click that kickstarted a job
    // holding nothing (the 2026-09-11 mute).
    const plist = serviceFilePath('darwin', HOME, '910')!
    const probe = { ...base, exists: (p: string) => p === plist, uid: 501 }
    expect(detectSupervision(probe)).toBe('keepalive')
    expect(chooseRestartAuthority(probe).kind).toBe('keepalive')
    // No service record is published for it: a job that cannot restart this
    // agent must not be left on disk for the watcher to kickstart.
    expect(resolveSupervision(probe).service).toBeNull()
  })

  test('the wire keeps saying launcher until the backend enum learns keepalive', () => {
    // Measured 2026-09-13: backend/src/integrations/pairing-update-state.ts
    // UPDATE_SUPERVISED_MODES has no 'keepalive', sanitizeUpdateReadiness maps
    // anything outside it to 'none', and the app gates one-click on
    // supervised !== 'none' (frontend updateStateModel.ts isOneClickEligible).
    // Sending the honest new token today would REMOVE the update button from
    // exactly the sessions this tier fixes.
    expect(wireSupervisedKind('keepalive')).toBe('launcher')
    for (const kind of ['systemd', 'launchd', 'launcher', 'pm2', 'none'] as const) {
      expect(wireSupervisedKind(kind)).toBe(kind)
    }
  })
})

describe('bin/hoai-keepalive-marker: the writer a keepalive script calls', () => {
  const HOME_2 = '/home/kc'
  const at = '2026-09-13T04:05:06.000Z'

  test('a complete invocation writes the file the daemon reads, parseable', () => {
    const decision = decideKeepaliveMarkerWrite({
      argv: ['--assistant', '910', '--keepalive-pid', '33108', '--claude-pid', '35759', '--tmux', 'agent-910'],
      home: HOME_2,
      startedAt: at,
    })
    expect(decision.action).toBe('write')
    if (decision.action !== 'write') throw new Error('unreachable')
    expect(decision.path).toBe(keepaliveMarkerPath(HOME_2, '910')!)
    // The end-to-end mirror: what bin writes is exactly what lib accepts.
    expect(parseKeepaliveMarker(decision.body)).toEqual({
      pid: 33108,
      claudePid: 35759,
      tmuxSession: 'agent-910',
    })
  })

  test('--flag=value is the same as --flag value, and tmux is optional', () => {
    const decision = decideKeepaliveMarkerWrite({
      argv: ['--assistant=910', '--keepalive-pid=33108', '--claude-pid=35759'],
      home: HOME_2,
      startedAt: at,
    })
    if (decision.action !== 'write') throw new Error('expected a write')
    expect(parseKeepaliveMarker(decision.body)?.tmuxSession).toBeNull()
  })

  test('a missing or unusable argument writes nothing at all', () => {
    const bad: string[][] = [
      [],
      ['--assistant', '910', '--keepalive-pid', '33108'], // no session pid
      ['--assistant', '910', '--claude-pid', '35759'], // no keepalive pid
      ['--keepalive-pid', '33108', '--claude-pid', '35759'], // no assistant
      ['--assistant', '910; rm -rf /', '--keepalive-pid', '33108', '--claude-pid', '35759'],
      ['--assistant', '910', '--keepalive-pid', '1', '--claude-pid', '35759'], // init
      ['--assistant', '910', '--keepalive-pid', '33108', '--claude-pid', 'nope'],
    ]
    for (const argv of bad) {
      expect(decideKeepaliveMarkerWrite({ argv, home: HOME_2, startedAt: at }).action).toBe('usage')
    }
  })
})
