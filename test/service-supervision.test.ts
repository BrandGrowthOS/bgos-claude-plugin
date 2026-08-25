/**
 * lib/service-supervision.mjs: WHICH loaded service-manager job supervises a
 * given agent, discovered by asking the platform instead of guessing a label.
 *
 * Pins, in the order they matter:
 *   - an agent supervised under a NON-CANONICAL label (the dev fleet's
 *     ai.bgos.session.<id>, or anything else a bespoke launcher installs) is
 *     detected, because that is the bug this module exists to fix: before it,
 *     only ai.bgos.agent.<id> / bgos-agent-<id> counted and 7 of 8 live agents
 *     reported 'none';
 *   - an unsupervised agent is still 'none'. Every miss fails CLOSED: no
 *     loaded-job list, no readable job detail, no match, an ambiguous match, a
 *     job on disk that is not loaded, or a working directory pinned to another
 *     agent all resolve to null;
 *   - the restart is addressed to the handle that was RESOLVED, so it goes
 *     back through the supervisor holding the agent (launchctl kickstart -k /
 *     systemctl --user restart) and that supervisor re-runs its own launch
 *     recipe in its own working directory. Nothing here relaunches by hand,
 *     changes a working directory, or passes a session flag, which is the
 *     fleet-restart identity bleed in docs/learnings;
 *   - the two entry points that used to restate this tier separately
 *     (lib/update-readiness.ts for the daemon, lib/agent-inventory.mjs for the
 *     watcher) agree on a shared scenario table, so the mirror cannot drift
 *     back apart silently.
 *
 * Run: npx tsx --test test/service-supervision.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FOLDER_PIN_FILE_NAME,
  MCP_CONFIG_FILE_NAME,
  SERVICE_HANDLE_RE,
  SERVICE_RECORD_FILE_NAME,
  SERVICE_RECORD_SCHEMA_VERSION,
  agentStateDirFor,
  buildServiceRecord,
  isSafeServiceHandle,
  launchAgentsDir,
  matchJobToAgent,
  parseLaunchctlList,
  parseLaunchdJobJson,
  MCP_SERVER_NAME_RE,
  parseMcpAssistantId,
  parseMcpChannelServerName,
  parseServiceRecord,
  parseSystemctlUnitList,
  parseSystemdUnitFile,
  pathIsInside,
  pickSoleMatch,
  readFolderIdentity,
  resolveSupervisingService,
  serviceRestartCommandForHandle,
  systemdUserDir,
  verifyServiceRecord,
} from '../lib/service-supervision.mjs'
import { detectSupervision, resolveSupervision } from '../lib/update-readiness'
import { detectSupervisor, resolveAgentSupervisor } from '../lib/agent-inventory.mjs'

const HOME = '/home/kc'
const AGENTS_DIR = launchAgentsDir(HOME)
const UNITS_DIR = systemdUserDir(HOME)

// -- fixtures -------------------------------------------------------------------------

/** A launchd plist as plutil -convert json prints it. */
function plistJson(job: {
  label: string
  workingDirectory?: string
  programArguments?: string[]
  stdout?: string
  stderr?: string
}) {
  return JSON.stringify({
    Label: job.label,
    ...(job.programArguments ? { ProgramArguments: job.programArguments } : {}),
    ...(job.workingDirectory ? { WorkingDirectory: job.workingDirectory } : {}),
    ...(job.stdout ? { StandardOutPath: job.stdout } : {}),
    ...(job.stderr ? { StandardErrorPath: job.stderr } : {}),
    RunAtLoad: true,
    KeepAlive: true,
  })
}

function launchctlList(labels: string[]) {
  return ['PID\tStatus\tLabel', ...labels.map((l, i) => `${1000 + i}\t0\t${l}`)].join('\n')
}

function systemctlList(units: string[]) {
  return units.map((u) => `${u} loaded active running some description`).join('\n')
}

/**
 * A fake machine: plist / unit files on disk (keyed by full path, value is the
 * raw file text) plus the set of labels the service manager reports LOADED.
 */
function fakeHost(opts: {
  files?: Record<string, string>
  loadedLaunchd?: string[]
  loadedSystemd?: string[]
  plutilFails?: boolean
}) {
  const files = opts.files ?? {}
  const calls: string[] = []
  const listDir = (dir: string) =>
    Object.keys(files)
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => p.slice(dir.length + 1))
  const readFile = (p: string) => (p in files ? files[p]! : null)
  const execSync = (file: string, args: string[]) => {
    calls.push([file, ...args].join(' '))
    if (file === 'launchctl' && args[0] === 'list') {
      return { code: 0, stdout: launchctlList(opts.loadedLaunchd ?? []) }
    }
    if (file === 'systemctl') return { code: 0, stdout: systemctlList(opts.loadedSystemd ?? []) }
    if (file === 'plutil') {
      if (opts.plutilFails) return { code: 1, stdout: '' }
      const path = args[args.length - 1]!
      return path in files ? { code: 0, stdout: files[path]! } : { code: 1, stdout: '' }
    }
    return { code: 127, stdout: '' }
  }
  return { files, listDir, readFile, execSync, calls }
}

// -- handle safety ---------------------------------------------------------------------

test('a service handle must be inert on a command line before it is used', () => {
  assert.equal(isSafeServiceHandle('ai.bgos.session.910'), true)
  assert.equal(isSafeServiceHandle('ai.bgos.agent.901'), true)
  assert.equal(isSafeServiceHandle('bgos-agent-912.service'), true)
  assert.equal(isSafeServiceHandle('app@user.service'), true)
  // A discovered handle comes off disk, so every shell metacharacter is refused.
  for (const bad of [
    '',
    'a b',
    'a;rm -rf /',
    'a$(id)',
    'a`id`',
    'a"b',
    "a'b",
    'a\nb',
    '/absolute',
    '.leading-dot',
    `${'x'.repeat(129)}`,
  ]) {
    assert.equal(isSafeServiceHandle(bad), false, `expected ${JSON.stringify(bad)} to be refused`)
  }
  assert.equal(SERVICE_HANDLE_RE.test('ai.bgos.session.910'), true)
})

// -- parsers ----------------------------------------------------------------------------

test('parseLaunchctlList: the header is not a job, a job with no pid still is', () => {
  const text = ['PID\tStatus\tLabel', '900\t0\tai.bgos.session.910', '-\t0\tcom.apple.mdworker', 'junk'].join('\n')
  const loaded = parseLaunchctlList(text)
  assert.equal(loaded.has('ai.bgos.session.910'), true)
  // Loaded but not currently running is still kickstartable, so it counts.
  assert.equal(loaded.has('com.apple.mdworker'), true)
  assert.equal(loaded.has('Label'), false)
  assert.equal(loaded.size, 2)
  assert.equal(parseLaunchctlList('').size, 0)
  assert.equal(parseLaunchctlList(null).size, 0)
  // An unsafe label is dropped at the door rather than later.
  assert.equal(parseLaunchctlList('1\t0\tbad label').size, 0)
})

test('parseSystemctlUnitList: names only, bullets stripped, non-services ignored', () => {
  const text = [
    '● bgos-agent-912.service loaded failed failed BGOS agent',
    'hoai-vexa.service loaded active running HOAI',
    'dbus.socket loaded active listening D-Bus',
    '',
  ].join('\n')
  const loaded = parseSystemctlUnitList(text)
  assert.deepEqual([...loaded].sort(), ['bgos-agent-912.service', 'hoai-vexa.service'])
})

test('parseLaunchdJobJson: identity-bearing fields only; junk and a label-less job are null', () => {
  const job = parseLaunchdJobJson(
    plistJson({
      label: 'ai.bgos.session.910',
      programArguments: ['/bin/bash', '/home/kc/.bgos-session-910/keepalive.sh'],
      workingDirectory: '/home/kc/Voxor/Vexa',
      stdout: '/home/kc/.bgos-session-910/agent.out.log',
      stderr: '/home/kc/.bgos-session-910/agent.err.log',
    }),
  )
  assert.equal(job?.handle, 'ai.bgos.session.910')
  assert.equal(job?.workingDirectory, '/home/kc/Voxor/Vexa')
  assert.deepEqual(job?.paths, [
    '/bin/bash',
    '/home/kc/.bgos-session-910/keepalive.sh',
    '/home/kc/.bgos-session-910/agent.out.log',
    '/home/kc/.bgos-session-910/agent.err.log',
    '/home/kc/Voxor/Vexa',
  ])
  assert.equal(parseLaunchdJobJson('not json'), null)
  assert.equal(parseLaunchdJobJson('[]'), null)
  assert.equal(parseLaunchdJobJson(JSON.stringify({ WorkingDirectory: '/x' })), null)
  assert.equal(parseLaunchdJobJson(''), null)
})

test('parseSystemdUnitFile: directive values, comments skipped, name comes from the file', () => {
  const job = parseSystemdUnitFile(
    'hoai-vexa.service',
    [
      '# a comment=not a directive',
      '[Service]',
      'ExecStart=-/usr/bin/bash /home/kc/.bgos-session-910/keepalive.sh',
      'WorkingDirectory=/home/kc/Voxor/Vexa',
      'Restart=always',
      '',
    ].join('\n'),
  )
  assert.equal(job?.handle, 'hoai-vexa.service')
  assert.equal(job?.workingDirectory, '/home/kc/Voxor/Vexa')
  // An Exec* value is a command line: its tokens are the paths, and systemd's
  // leading prefix character is not part of the executable path.
  assert.equal(job?.paths.includes('/usr/bin/bash'), true)
  assert.equal(job?.paths.includes('/home/kc/.bgos-session-910/keepalive.sh'), true)
  assert.equal(job?.paths.includes('always'), false)
  assert.equal(parseSystemdUnitFile('', 'ExecStart=/x'), null)
  assert.equal(parseSystemdUnitFile('x.service', ''), null)
})

// -- matching ---------------------------------------------------------------------------

test('pathIsInside: the dir itself and its children, never a sibling with a shared prefix', () => {
  assert.equal(pathIsInside('/home/kc/.bgos-agent/912', '/home/kc/.bgos-agent/912'), true)
  assert.equal(pathIsInside('/home/kc/.bgos-agent/912/run.sh', '/home/kc/.bgos-agent/912'), true)
  assert.equal(pathIsInside('/home/kc/.bgos-agent/9120/run.sh', '/home/kc/.bgos-agent/912'), false)
  assert.equal(pathIsInside('', '/x'), false)
  assert.equal(pathIsInside('/x', ''), false)
})

test('matchJobToAgent: the state dir is the stronger anchor; a working directory must match EXACTLY', () => {
  const stateDir = '/home/kc/.bgos-agent/912'
  const byState = {
    handle: 'anything.at.all',
    workingDirectory: '/home/kc/elsewhere',
    paths: ['/bin/bash', `${stateDir}/run.sh`],
  }
  assert.equal(matchJobToAgent({ job: byState, stateDir, cwd: '/home/kc/agents/ava' }), 'state-dir')
  const byCwd = {
    handle: 'ai.bgos.session.912',
    workingDirectory: '/home/kc/agents/ava',
    paths: ['/bin/bash', '/home/kc/.bgos-session-912/keepalive.sh'],
  }
  assert.equal(matchJobToAgent({ job: byCwd, stateDir, cwd: '/home/kc/agents/ava' }), 'working-directory')
  // A PARENT of the agent's folder is not the agent's folder: a prefix match
  // would hand every agent under ~/agents to one job.
  assert.equal(matchJobToAgent({ job: byCwd, stateDir, cwd: '/home/kc/agents' }), null)
  assert.equal(matchJobToAgent({ job: byCwd, stateDir, cwd: '' }), null)
  assert.equal(matchJobToAgent({ job: null, stateDir, cwd: '/home/kc/agents/ava' }), null)
})

test('pickSoleMatch: a stronger anchor wins, a tie at the same strength fails closed', () => {
  const a = { kind: 'launchd' as const, handle: 'a', via: 'state-dir' as const, file: null }
  const b = { kind: 'launchd' as const, handle: 'b', via: 'working-directory' as const, file: null }
  const b2 = { kind: 'launchd' as const, handle: 'b2', via: 'working-directory' as const, file: null }
  assert.equal(pickSoleMatch([]), null)
  assert.equal(pickSoleMatch([b])?.handle, 'b')
  assert.equal(pickSoleMatch([a, b])?.handle, 'a')
  // Two jobs equally entitled to the agent: guessing which one is the failure
  // this module exists to prevent.
  assert.equal(pickSoleMatch([b, b2]), null)
  assert.equal(pickSoleMatch([a, { ...a, handle: 'a2' }]), null)
})

// -- the resolver, darwin -----------------------------------------------------------------

const SESSION_PLIST = `${AGENTS_DIR}/ai.bgos.session.910.plist`
const SESSION_JOB = plistJson({
  label: 'ai.bgos.session.910',
  programArguments: ['/bin/bash', '/home/kc/.bgos-session-910/keepalive.sh'],
  workingDirectory: '/home/kc/Voxor/Vexa',
  stdout: '/home/kc/.bgos-session-910/agent.out.log',
})

test('darwin: an agent supervised under a BESPOKE label is found by its working directory', () => {
  const host = fakeHost({
    files: { [SESSION_PLIST]: SESSION_JOB },
    loadedLaunchd: ['ai.bgos.session.910', 'com.apple.mdworker'],
  })
  assert.deepEqual(
    resolveSupervisingService({
      platform: 'darwin',
      home: HOME,
      assistantId: '910',
      cwd: '/home/kc/Voxor/Vexa',
      listDir: host.listDir,
      readFile: host.readFile,
      execSync: host.execSync,
    }),
    {
      kind: 'launchd',
      handle: 'ai.bgos.session.910',
      via: 'working-directory',
      file: SESSION_PLIST,
    },
  )
})

test('darwin: an agent whose job writes into its state dir is found without any cwd at all', () => {
  const stateDir = agentStateDirFor(HOME, '901')!
  const plist = `${AGENTS_DIR}/whatever-they-called-it.plist`
  const host = fakeHost({
    files: {
      [plist]: plistJson({
        label: 'com.someone.else.901',
        programArguments: ['/bin/bash', `${stateDir}/run.sh`],
        workingDirectory: '/home/kc/Voxor',
      }),
    },
    loadedLaunchd: ['com.someone.else.901'],
  })
  const resolved = resolveSupervisingService({
    platform: 'darwin',
    home: HOME,
    assistantId: '901',
    cwd: null,
    listDir: host.listDir,
    readFile: host.readFile,
    execSync: host.execSync,
  })
  assert.equal(resolved?.handle, 'com.someone.else.901')
  assert.equal(resolved?.via, 'state-dir')
})

test('darwin: a plist on disk that launchd has NOT loaded is not a restart authority', () => {
  const host = fakeHost({ files: { [SESSION_PLIST]: SESSION_JOB }, loadedLaunchd: ['com.apple.mdworker'] })
  assert.equal(
    resolveSupervisingService({
      platform: 'darwin',
      home: HOME,
      assistantId: '910',
      cwd: '/home/kc/Voxor/Vexa',
      listDir: host.listDir,
      readFile: host.readFile,
      execSync: host.execSync,
    }),
    null,
  )
})

test('darwin: two loaded jobs claiming the same working directory resolve to nothing', () => {
  const second = `${AGENTS_DIR}/ai.bgos.session.911.plist`
  const host = fakeHost({
    files: {
      [SESSION_PLIST]: SESSION_JOB,
      [second]: plistJson({ label: 'ai.bgos.session.911', workingDirectory: '/home/kc/Voxor/Vexa' }),
    },
    loadedLaunchd: ['ai.bgos.session.910', 'ai.bgos.session.911'],
  })
  assert.equal(
    resolveSupervisingService({
      platform: 'darwin',
      home: HOME,
      assistantId: '910',
      cwd: '/home/kc/Voxor/Vexa',
      listDir: host.listDir,
      readFile: host.readFile,
      execSync: host.execSync,
    }),
    null,
  )
})

test('darwin: a working directory that identifies nothing is refused as an anchor', () => {
  const homeJob = `${AGENTS_DIR}/ai.bgos.session.910.plist`
  const host = fakeHost({
    files: { [homeJob]: plistJson({ label: 'ai.bgos.session.910', workingDirectory: HOME }) },
    loadedLaunchd: ['ai.bgos.session.910'],
  })
  for (const cwd of [HOME, `${HOME}/`, '/', '', null]) {
    assert.equal(
      resolveSupervisingService({
        platform: 'darwin',
        home: HOME,
        assistantId: '910',
        cwd,
        listDir: host.listDir,
        readFile: host.readFile,
        execSync: host.execSync,
      }),
      null,
      `expected cwd ${JSON.stringify(cwd)} to identify nothing`,
    )
  }
})

test('darwin: a working directory PINNED to another agent never matches (wrong identity)', () => {
  const host = fakeHost({
    files: {
      [SESSION_PLIST]: SESSION_JOB,
      '/home/kc/Voxor/Vexa/.bgos-agent-id': '777\n',
    },
    loadedLaunchd: ['ai.bgos.session.910'],
  })
  assert.equal(
    resolveSupervisingService({
      platform: 'darwin',
      home: HOME,
      assistantId: '910',
      cwd: '/home/kc/Voxor/Vexa',
      listDir: host.listDir,
      readFile: host.readFile,
      execSync: host.execSync,
    }),
    null,
  )
  // The SAME folder, pinned to this agent, is exactly what we want to match.
  const own = fakeHost({
    files: { [SESSION_PLIST]: SESSION_JOB, '/home/kc/Voxor/Vexa/.bgos-agent-id': '910\n' },
    loadedLaunchd: ['ai.bgos.session.910'],
  })
  assert.equal(
    resolveSupervisingService({
      platform: 'darwin',
      home: HOME,
      assistantId: '910',
      cwd: '/home/kc/Voxor/Vexa',
      listDir: own.listDir,
      readFile: own.readFile,
      execSync: own.execSync,
    })?.handle,
    'ai.bgos.session.910',
  )
})

test('darwin: unreadable job detail, an unsafe label, a bad id and missing probes all fail closed', () => {
  const base = {
    platform: 'darwin',
    home: HOME,
    assistantId: '910',
    cwd: '/home/kc/Voxor/Vexa',
  }
  const unreadable = fakeHost({
    files: { [SESSION_PLIST]: SESSION_JOB },
    loadedLaunchd: ['ai.bgos.session.910'],
    plutilFails: true,
  })
  assert.equal(
    resolveSupervisingService({ ...base, listDir: unreadable.listDir, readFile: unreadable.readFile, execSync: unreadable.execSync }),
    null,
  )
  const unsafe = fakeHost({
    files: { [SESSION_PLIST]: plistJson({ label: 'evil label', workingDirectory: '/home/kc/Voxor/Vexa' }) },
    loadedLaunchd: ['ai.bgos.session.910'],
  })
  assert.equal(
    resolveSupervisingService({ ...base, listDir: unsafe.listDir, readFile: unsafe.readFile, execSync: unsafe.execSync }),
    null,
  )
  const ok = fakeHost({ files: { [SESSION_PLIST]: SESSION_JOB }, loadedLaunchd: ['ai.bgos.session.910'] })
  assert.equal(
    resolveSupervisingService({ ...base, assistantId: 'nine-ten', listDir: ok.listDir, readFile: ok.readFile, execSync: ok.execSync }),
    null,
  )
  // No probes at all: the discovery tier simply does not run.
  assert.equal(resolveSupervisingService({ ...base, execSync: ok.execSync } as never), null)
  // launchctl itself unavailable: no loaded-job list means no authority.
  assert.equal(
    resolveSupervisingService({
      ...base,
      listDir: ok.listDir,
      readFile: ok.readFile,
      execSync: () => ({ code: 127, stdout: '' }),
    }),
    null,
  )
})

test('win32 resolves nothing: no per-user service namespace exists to ask', () => {
  const host = fakeHost({ files: { [SESSION_PLIST]: SESSION_JOB }, loadedLaunchd: ['ai.bgos.session.910'] })
  assert.equal(
    resolveSupervisingService({
      platform: 'win32',
      home: HOME,
      assistantId: '910',
      cwd: '/home/kc/Voxor/Vexa',
      listDir: host.listDir,
      readFile: host.readFile,
      execSync: host.execSync,
    }),
    null,
  )
})

// -- the resolver, linux ------------------------------------------------------------------

const UNIT_PATH = `${UNITS_DIR}/vexa-agent.service`
const UNIT_BODY = [
  '[Service]',
  'ExecStart=/usr/bin/hoai',
  'WorkingDirectory=/home/kc/Voxor/Vexa',
  'Restart=always',
].join('\n')

test('linux: a systemd --user unit under a bespoke NAME is found and only when loaded', () => {
  const host = fakeHost({ files: { [UNIT_PATH]: UNIT_BODY }, loadedSystemd: ['vexa-agent.service'] })
  assert.deepEqual(
    resolveSupervisingService({
      platform: 'linux',
      home: HOME,
      assistantId: '910',
      cwd: '/home/kc/Voxor/Vexa',
      listDir: host.listDir,
      readFile: host.readFile,
      execSync: host.execSync,
    }),
    { kind: 'systemd', handle: 'vexa-agent.service', via: 'working-directory', file: UNIT_PATH },
  )
  const notLoaded = fakeHost({ files: { [UNIT_PATH]: UNIT_BODY }, loadedSystemd: ['other.service'] })
  assert.equal(
    resolveSupervisingService({
      platform: 'linux',
      home: HOME,
      assistantId: '910',
      cwd: '/home/kc/Voxor/Vexa',
      listDir: notLoaded.listDir,
      readFile: notLoaded.readFile,
      execSync: notLoaded.execSync,
    }),
    null,
  )
})

test('linux: a unit whose ExecStart points into the agent state dir matches by state dir', () => {
  const stateDir = agentStateDirFor(HOME, '912')!
  const path = `${UNITS_DIR}/somebodys-agent.service`
  const host = fakeHost({
    files: { [path]: `[Service]\nExecStart=/bin/bash ${stateDir}/run.sh\n` },
    loadedSystemd: ['somebodys-agent.service'],
  })
  const resolved = resolveSupervisingService({
    platform: 'linux',
    home: HOME,
    assistantId: '912',
    cwd: null,
    listDir: host.listDir,
    readFile: host.readFile,
    execSync: host.execSync,
  })
  assert.equal(resolved?.handle, 'somebodys-agent.service')
  assert.equal(resolved?.via, 'state-dir')
})

// -- the restart command ------------------------------------------------------------------

test('serviceRestartCommandForHandle: the restart goes THROUGH the supervisor, addressed to the resolved handle', () => {
  assert.deepEqual(
    serviceRestartCommandForHandle({ kind: 'launchd', handle: 'ai.bgos.session.910', uid: 501 }),
    { file: 'launchctl', args: ['kickstart', '-k', 'gui/501/ai.bgos.session.910'] },
  )
  assert.deepEqual(
    serviceRestartCommandForHandle({ kind: 'launchd', handle: 'ai.bgos.session.910', uid: 501, delaySeconds: 2 }),
    { file: '/bin/sh', args: ['-c', 'sleep 2 && launchctl kickstart -k gui/501/ai.bgos.session.910'] },
  )
  assert.deepEqual(serviceRestartCommandForHandle({ kind: 'systemd', handle: 'vexa-agent.service' }), {
    file: 'systemctl',
    args: ['--user', 'restart', 'vexa-agent.service'],
  })
  assert.deepEqual(
    serviceRestartCommandForHandle({ kind: 'systemd', handle: 'vexa-agent.service', delaySeconds: 2 }),
    { file: 'systemd-run', args: ['--user', '--on-active=2', 'systemctl', '--user', 'restart', 'vexa-agent.service'] },
  )
})

test('serviceRestartCommandForHandle: no uid, an unsafe handle or an unknown kind builds NO command', () => {
  assert.equal(serviceRestartCommandForHandle({ kind: 'launchd', handle: 'ai.bgos.session.910', uid: null }), null)
  assert.equal(serviceRestartCommandForHandle({ kind: 'launchd', handle: 'ai.bgos.session.910', uid: -1 }), null)
  assert.equal(serviceRestartCommandForHandle({ kind: 'launchd', handle: 'a; rm -rf /', uid: 501 }), null)
  assert.equal(serviceRestartCommandForHandle({ kind: 'systemd', handle: 'a$(id).service' }), null)
  assert.equal(serviceRestartCommandForHandle({ kind: 'upstart', handle: 'x' }), null)
})

// -- the two mirrors agree ------------------------------------------------------------------

/**
 * The daemon (lib/update-readiness.ts) and the watcher (lib/agent-inventory.mjs)
 * answer the same question in two vocabularies. They shared a hardcoded label
 * and drifted apart in silence once; this table is what stops that recurring.
 */
const PARITY_CASES: Array<{
  name: string
  platform: string
  cwd: string | null
  files: Record<string, string>
  loadedLaunchd?: string[]
  loadedSystemd?: string[]
  supervisorBody?: string | null
  expectDaemon: string
  expectWatcher: string
  expectHandle: string | null
}> = [
  {
    name: 'bespoke launchd label, matched by working directory',
    platform: 'darwin',
    cwd: '/home/kc/Voxor/Vexa',
    files: { [SESSION_PLIST]: SESSION_JOB },
    loadedLaunchd: ['ai.bgos.session.910'],
    expectDaemon: 'launchd',
    expectWatcher: 'service',
    expectHandle: 'ai.bgos.session.910',
  },
  {
    name: 'canonical launchd plist still wins with no probes consulted',
    platform: 'darwin',
    cwd: null,
    files: { [`${AGENTS_DIR}/ai.bgos.agent.910.plist`]: 'canonical' },
    loadedLaunchd: [],
    expectDaemon: 'launchd',
    expectWatcher: 'service',
    expectHandle: 'ai.bgos.agent.910',
  },
  {
    name: 'bespoke systemd unit, matched by working directory',
    platform: 'linux',
    cwd: '/home/kc/Voxor/Vexa',
    files: { [UNIT_PATH]: UNIT_BODY },
    loadedSystemd: ['vexa-agent.service'],
    expectDaemon: 'systemd',
    expectWatcher: 'service',
    expectHandle: 'vexa-agent.service',
  },
  {
    name: 'a live hoai launcher, no service anywhere',
    platform: 'darwin',
    cwd: '/home/kc/Voxor/Vexa',
    files: {},
    supervisorBody: JSON.stringify({ pid: 4242, capabilities: ['relaunch'] }),
    expectDaemon: 'launcher',
    expectWatcher: 'launcher-live',
    expectHandle: null,
  },
  {
    name: 'nothing supervises this agent',
    platform: 'darwin',
    cwd: '/home/kc/Voxor/Vexa',
    files: {},
    expectDaemon: 'none',
    expectWatcher: 'none',
    expectHandle: null,
  },
  {
    name: 'a job on disk that is not loaded supervises nothing',
    platform: 'darwin',
    cwd: '/home/kc/Voxor/Vexa',
    files: { [SESSION_PLIST]: SESSION_JOB },
    loadedLaunchd: ['com.apple.mdworker'],
    expectDaemon: 'none',
    expectWatcher: 'none',
    expectHandle: null,
  },
]

test('the daemon and the watcher resolve the same authority and the same handle', () => {
  for (const scenario of PARITY_CASES) {
    const host = fakeHost({
      files: scenario.files,
      loadedLaunchd: scenario.loadedLaunchd,
      loadedSystemd: scenario.loadedSystemd,
    })
    const supervisorPath = `${HOME}/.bgos-agent/910/supervisor.json`
    const readFile = (p: string) =>
      p === supervisorPath ? (scenario.supervisorBody ?? null) : host.readFile(p)
    const probe = {
      platform: scenario.platform,
      home: HOME,
      assistantId: '910',
      cwd: scenario.cwd,
      exists: (p: string) => p in scenario.files,
      readFile,
      listDir: host.listDir,
      execSync: host.execSync,
      pidAlive: () => true,
    }
    const daemon = resolveSupervision(probe)
    const watcher = resolveAgentSupervisor(probe)
    assert.equal(daemon.supervised, scenario.expectDaemon, `daemon: ${scenario.name}`)
    assert.equal(watcher.supervisor, scenario.expectWatcher, `watcher: ${scenario.name}`)
    assert.equal(detectSupervision(probe), scenario.expectDaemon, `daemon enum: ${scenario.name}`)
    assert.equal(detectSupervisor(probe), scenario.expectWatcher, `watcher enum: ${scenario.name}`)
    assert.equal(daemon.service?.handle ?? null, scenario.expectHandle, `daemon handle: ${scenario.name}`)
    assert.equal(watcher.service?.handle ?? null, scenario.expectHandle, `watcher handle: ${scenario.name}`)
  }
})

// -- folder identity: the veto must read what the fleet actually has ---------------------

/**
 * A folder laid out the way EVERY agent folder on the BGOS dev Mac actually
 * is: no `.bgos-agent-id` at all (those eight agents predate bakeLaunchPin),
 * and `.mcp.json` carrying the real BGOS_ASSISTANT_ID next to the API key.
 * A veto that reads only the pin file is inert against this layout, which is
 * the whole point of these cases.
 */
function realAgentFolder(dir: string, assistantId: string) {
  return {
    [`${dir}/${MCP_CONFIG_FILE_NAME}`]: JSON.stringify({
      mcpServers: {
        bgos: {
          command: 'bun',
          args: ['/Users/fitecho/bgos-claude-plugin/server.ts'],
          env: {
            BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1',
            BGOS_API_KEY: 'sk-live-do-not-leak-me',
            BGOS_ASSISTANT_ID: assistantId,
          },
        },
      },
    }),
  }
}

test('parseMcpAssistantId: the id from any server env, nothing else, and a conflict is not an id', () => {
  const files = realAgentFolder('/x', '910')
  const mcpWith = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers })
  assert.equal(parseMcpAssistantId(files[`/x/${MCP_CONFIG_FILE_NAME}`]!), '910')
  // The marketplace topology names the server something else.
  assert.equal(parseMcpAssistantId(mcpWith({ hoai: { env: { BGOS_ASSISTANT_ID: '77' } } })), '77')
  // Two entries agreeing is still one identity.
  assert.equal(
    parseMcpAssistantId(mcpWith({ a: { env: { BGOS_ASSISTANT_ID: '5' } }, b: { env: { BGOS_ASSISTANT_ID: '5' } } })),
    '5',
  )
  // Two entries disagreeing is a folder whose identity cannot be established.
  assert.equal(
    parseMcpAssistantId(mcpWith({ a: { env: { BGOS_ASSISTANT_ID: '5' } }, b: { env: { BGOS_ASSISTANT_ID: '6' } } })),
    'conflict',
  )
  assert.equal(parseMcpAssistantId(mcpWith({ bgos: { command: 'bun' } })), null)
  assert.equal(parseMcpAssistantId('not json'), null)
  assert.equal(parseMcpAssistantId('[]'), null)
  assert.equal(parseMcpAssistantId(null), null)
  assert.equal(parseMcpAssistantId(mcpWith({ bgos: { env: { BGOS_ASSISTANT_ID: 'nine' } } })), null)
})

test('readFolderIdentity: either source is authoritative, disagreement is a conflict, silence is usable', () => {
  const mcp = realAgentFolder('/x', '910')
  const read = (files: Record<string, string>) => (p: string) => (p in files ? files[p]! : null)
  const PIN = `/x/${FOLDER_PIN_FILE_NAME}`
  // .mcp.json alone: the ONLY source the real fleet folders have.
  assert.deepEqual(readFolderIdentity('/x', read(mcp)), { id: '910', conflict: false })
  // The pin file alone: what bakeLaunchPin writes for a freshly paired folder.
  assert.deepEqual(readFolderIdentity('/x', read({ [PIN]: '910\n' })), { id: '910', conflict: false })
  // Both, agreeing.
  assert.deepEqual(readFolderIdentity('/x', read({ ...mcp, [PIN]: '910\n' })), { id: '910', conflict: false })
  // Both, disagreeing: no identity, and the caller must refuse the folder.
  assert.deepEqual(readFolderIdentity('/x', read({ ...mcp, [PIN]: '777\n' })), { id: null, conflict: true })
  // Neither: a folder that declares nothing stays usable.
  assert.deepEqual(readFolderIdentity('/x', read({})), { id: null, conflict: false })
})

test('a REAL agent folder (no pin file, .mcp.json only) vetoes a job belonging to another agent', () => {
  // The coordinator's negative control, run against the layout the fleet has:
  // assistant 999 pointed at agent 910's folder must resolve NOTHING, because
  // restarting ai.bgos.session.910 restarts 910, not 999.
  const cwd = '/home/kc/Voxor/Vexa'
  const host = fakeHost({
    files: { [SESSION_PLIST]: SESSION_JOB, ...realAgentFolder(cwd, '910') },
    loadedLaunchd: ['ai.bgos.session.910'],
  })
  const probe = {
    platform: 'darwin',
    home: HOME,
    cwd,
    listDir: host.listDir,
    readFile: host.readFile,
    execSync: host.execSync,
  }
  assert.equal(resolveSupervisingService({ ...probe, assistantId: '999' }), null)
  // The agent the folder DOES belong to still resolves its own job.
  assert.equal(
    resolveSupervisingService({ ...probe, assistantId: '910' })?.handle,
    'ai.bgos.session.910',
  )
  // A folder claiming two identities at once resolves for neither.
  const conflicted = fakeHost({
    files: {
      [SESSION_PLIST]: SESSION_JOB,
      ...realAgentFolder(cwd, '910'),
      [`${cwd}/${FOLDER_PIN_FILE_NAME}`]: '777\n',
    },
    loadedLaunchd: ['ai.bgos.session.910'],
  })
  assert.equal(
    resolveSupervisingService({
      ...probe,
      assistantId: '910',
      listDir: conflicted.listDir,
      readFile: conflicted.readFile,
      execSync: conflicted.execSync,
    }),
    null,
  )
})

test('the API key sitting next to the id in .mcp.json never leaves the resolver', () => {
  const cwd = '/home/kc/Voxor/Vexa'
  const host = fakeHost({
    files: { [SESSION_PLIST]: SESSION_JOB, ...realAgentFolder(cwd, '910') },
    loadedLaunchd: ['ai.bgos.session.910'],
  })
  const resolved = resolveSupervisingService({
    platform: 'darwin',
    home: HOME,
    assistantId: '910',
    cwd,
    listDir: host.listDir,
    readFile: host.readFile,
    execSync: host.execSync,
  })
  assert.equal(JSON.stringify(resolved).includes('sk-live-do-not-leak-me'), false)
  assert.equal(JSON.stringify(resolved).includes('BGOS_API_KEY'), false)
})

// -- the published record, and its live re-verification -----------------------------------

const RECORD_CWD = '/home/kc/Voxor/Vexa'
const GOOD_SERVICE = {
  kind: 'launchd' as const,
  handle: 'ai.bgos.session.910',
  via: 'working-directory' as const,
  file: SESSION_PLIST,
}

function recordHost(extra: Record<string, string> = {}, loaded = ['ai.bgos.session.910']) {
  return fakeHost({
    files: { [SESSION_PLIST]: SESSION_JOB, ...realAgentFolder(RECORD_CWD, '910'), ...extra },
    loadedLaunchd: loaded,
  })
}

test('buildServiceRecord / parseServiceRecord: a round trip, and every malformed record is nothing', () => {
  const record = buildServiceRecord({
    assistantId: '910',
    service: GOOD_SERVICE,
    cwd: RECORD_CWD,
    resolvedAt: '2026-08-25T09:00:00.000Z',
  })!
  assert.deepEqual(record, {
    schemaVersion: SERVICE_RECORD_SCHEMA_VERSION,
    assistantId: '910',
    kind: 'launchd',
    handle: 'ai.bgos.session.910',
    via: 'working-directory',
    cwd: RECORD_CWD,
    resolvedAt: '2026-08-25T09:00:00.000Z',
  })
  assert.deepEqual(parseServiceRecord(JSON.stringify(record)), record)
  // The record names a job, never a token, and never the config it came from.
  assert.equal(JSON.stringify(record).includes('BGOS_API_KEY'), false)
  assert.equal(buildServiceRecord({ assistantId: 'x', service: GOOD_SERVICE, cwd: RECORD_CWD }), null)
  assert.equal(buildServiceRecord({ assistantId: '910', service: GOOD_SERVICE, cwd: '' }), null)
  assert.equal(
    buildServiceRecord({ assistantId: '910', service: { ...GOOD_SERVICE, handle: 'a; rm -rf /' }, cwd: RECORD_CWD }),
    null,
  )
  for (const bad of [
    'not json',
    '[]',
    JSON.stringify({ ...record, schemaVersion: 99 }),
    JSON.stringify({ ...record, assistantId: 'x' }),
    JSON.stringify({ ...record, kind: 'upstart' }),
    JSON.stringify({ ...record, handle: 'evil label' }),
    JSON.stringify({ ...record, cwd: '' }),
  ]) {
    assert.equal(parseServiceRecord(bad), null, `expected ${bad.slice(0, 40)} to parse as nothing`)
  }
})

test('verifyServiceRecord: the platform must independently agree before a record counts', () => {
  const host = recordHost()
  const base = {
    platform: 'darwin',
    home: HOME,
    assistantId: '910',
    listDir: host.listDir,
    readFile: host.readFile,
    execSync: host.execSync,
  }
  const record = buildServiceRecord({ assistantId: '910', service: GOOD_SERVICE, cwd: RECORD_CWD })!
  assert.deepEqual(verifyServiceRecord({ ...base, record }), GOOD_SERVICE)

  // Stale: launchd no longer has that job loaded.
  const unloaded = recordHost({}, ['com.apple.mdworker'])
  assert.equal(
    verifyServiceRecord({ ...base, record, listDir: unloaded.listDir, readFile: unloaded.readFile, execSync: unloaded.execSync }),
    null,
  )
  // Tampered handle: the live resolution names a different job, so no.
  assert.equal(verifyServiceRecord({ ...base, record: { ...record, handle: 'com.apple.mdworker' } }), null)
  // Tampered kind.
  assert.equal(verifyServiceRecord({ ...base, record: { ...record, kind: 'systemd' } }), null)
  // Filed under another agent.
  assert.equal(verifyServiceRecord({ ...base, record: { ...record, assistantId: '777' } }), null)
  // Tampered cwd, pointing at a folder that belongs to somebody else: the
  // folder-identity veto refuses it, so the record buys nothing.
  const foreign = recordHost({ ...realAgentFolder('/home/kc/other', '777') })
  assert.equal(
    verifyServiceRecord({
      ...base,
      record: { ...record, cwd: '/home/kc/other' },
      listDir: foreign.listDir,
      readFile: foreign.readFile,
      execSync: foreign.execSync,
    }),
    null,
  )
  assert.equal(verifyServiceRecord({ ...base, record: null }), null)
  assert.equal(verifyServiceRecord({ ...base, record, assistantId: 'x' }), null)
})

test('the watcher resolves an agent it has NO recipe for, via the published record only', () => {
  // The six hand-started agents on the dev Mac: no launch.json, so the watcher
  // has no cwd of its own and used to resolve none while the daemon resolved
  // them fine. Now the daemon leaves the record and the watcher verifies it.
  const host = recordHost()
  const record = buildServiceRecord({ assistantId: '910', service: GOOD_SERVICE, cwd: RECORD_CWD })!
  const recordPath = `${HOME}/.bgos-agent/910/${SERVICE_RECORD_FILE_NAME}`
  const withRecord = (body: string | null) => ({
    platform: 'darwin',
    home: HOME,
    assistantId: '910',
    // No recipe, so the watcher brings no working directory of its own.
    cwd: null,
    exists: () => false,
    readFile: (p: string) => (p === recordPath ? body : host.readFile(p)),
    listDir: host.listDir,
    execSync: host.execSync,
    pidAlive: () => false,
  })
  const resolved = resolveAgentSupervisor(withRecord(JSON.stringify(record)))
  assert.equal(resolved.supervisor, 'service')
  assert.equal(resolved.service?.handle, 'ai.bgos.session.910')
  // Without the record the watcher is blind to this agent, which is the state
  // this tier exists to fix.
  assert.equal(resolveAgentSupervisor(withRecord(null)).supervisor, 'none')
  // A record the live job list does not corroborate buys nothing.
  const bogus = JSON.stringify({ ...record, handle: 'com.apple.mdworker' })
  assert.equal(resolveAgentSupervisor(withRecord(bogus)).supervisor, 'none')
})

// -- parseMcpChannelServerName ------------------------------------------------
//
// The sibling of parseMcpAssistantId, over the same parse: a folder's .mcp.json
// declares not only WHICH agent it is, but which CHANNEL that agent listens on.
// Claude Code loads an MCP server entry's channel as `server:<entry name>`, so
// the name is the second half of the spec. bin/hoai-core.mjs prefers it over
// install-method detection, because detection answers where the plugin FILES
// live, and that proxy breaks for exactly these folders.

test('parseMcpChannelServerName: the NAME of our entry, whatever it is called', () => {
  const mcpWith = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers })
  const ours = { command: 'bun', env: { BGOS_BACKEND_URL: 'https://api', BGOS_ASSISTANT_ID: '900' } }

  assert.equal(parseMcpChannelServerName(mcpWith({ bgos: ours })), 'bgos')
  // Keying on the env, not the name: the name is exactly what a user may have
  // renamed, and a rename must not silently send the agent back to detection.
  assert.equal(parseMcpChannelServerName(mcpWith({ atlas: ours })), 'atlas')
  // A single BGOS_ key is enough; not every writer sets an assistant id (the
  // clone bootstrap writes only BGOS_BACKEND_URL and BGOS_AUTO_APPROVE).
  assert.equal(
    parseMcpChannelServerName(mcpWith({ bgos: { env: { BGOS_BACKEND_URL: 'https://api' } } })),
    'bgos',
  )
})

test('parseMcpChannelServerName: other peoples servers are not ours', () => {
  const mcpWith = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers })
  const ours = { env: { BGOS_BACKEND_URL: 'https://api' } }
  assert.equal(
    parseMcpChannelServerName(mcpWith({ linear: { env: { LINEAR_API_KEY: 'x' } } })),
    null,
  )
  // Ours found even when it shares the file with strangers.
  assert.equal(
    parseMcpChannelServerName(mcpWith({ linear: { env: { LINEAR_API_KEY: 'x' } }, bgos: ours })),
    'bgos',
  )
  // An entry with no env at all declares nothing.
  assert.equal(parseMcpChannelServerName(mcpWith({ bgos: { command: 'bun' } })), null)
})

test('parseMcpChannelServerName: two of ours is a conflict, never a guess', () => {
  const mcpWith = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers })
  const ours = { env: { BGOS_BACKEND_URL: 'https://api' } }
  // Two HOAI channels in one workspace has no single right answer, and picking
  // one is how an agent ends up loading a channel nobody delivers to.
  assert.equal(parseMcpChannelServerName(mcpWith({ bgos: ours, bgos2: ours })), 'conflict')
})

test('parseMcpChannelServerName: a name that could not be spelled on a command line is refused', () => {
  const mcpWith = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers })
  const ours = { env: { BGOS_BACKEND_URL: 'https://api' } }
  for (const name of ['a name with spaces', 'has:colon', '-leading-dash', '', 'x'.repeat(65)]) {
    assert.equal(parseMcpChannelServerName(mcpWith({ [name]: ours })), null, `refused: ${name}`)
  }
  assert.ok(MCP_SERVER_NAME_RE.test('bgos'))
})

test('parseMcpChannelServerName: junk input never throws, it declares nothing', () => {
  for (const raw of ['', 'not json', '{}', '[]', 'null', '{"mcpServers":"nope"}', null, undefined]) {
    assert.equal(parseMcpChannelServerName(raw as never), null, `junk: ${String(raw)}`)
  }
})

test('parseMcpChannelServerName: nothing but the name leaves the function', () => {
  // Same secrecy rule as parseMcpAssistantId, and it matters as much here: this
  // file holds BGOS_API_KEY. The return type is a string, so the only way a
  // secret escapes is if someone returns the entry; pin that it is the name.
  const raw = JSON.stringify({
    mcpServers: {
      bgos: { env: { BGOS_BACKEND_URL: 'https://api', BGOS_API_KEY: 'sk-super-secret-value' } },
    },
  })
  const result = parseMcpChannelServerName(raw)
  assert.equal(result, 'bgos')
  assert.equal(typeof result, 'string')
  assert.ok(!String(result).includes('sk-super-secret-value'))
})
