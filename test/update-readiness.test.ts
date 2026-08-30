import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
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
  parseDeclaredSupervisorEnv,
  parseSupervisorFile,
  resolveSupervision,
  restartMarkerPath,
  serviceFilePath,
  serviceLabel,
  serviceRestartCommand,
  serviceUnit,
  supervisorFilePath,
  validAssistantId,
  type Supervision,
} from '../lib/update-readiness'
import {
  RESTART_MARKER_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  supervisorFileBody,
} from '../bin/hoai-core.mjs'

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
