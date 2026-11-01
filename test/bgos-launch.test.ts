/**
 * bgos-launch tests (pure resolver + hint text + main wiring).
 *
 * bgos-launch is the node launch shim the plugin manifest runs instead of a
 * bare `bun` command: it probes BUN_INSTALL, ~/.bun/bin, and every PATH entry
 * for bun (then bunx as a last resort), spawns the hit with the argv it was
 * given, and turns "bun is not installed" into a plain install hint + exit 127
 * instead of a silent ENOENT. This suite pins the probe order, the win32/posix
 * name differences, the hint text, the cwd rule, the exit-code mapping, and
 * main()'s failure/success/signal wiring via injected IO.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveBunPath,
  bunInstallHint,
  missingBunMessage,
  executableNames,
  resolveLaunchCwd,
  exitCodeForChild,
  main,
  bunRuntimeEnv,
  bunRefusesOptions,
  threadOptionsWarning,
  WIN32_JSC_THREAD_OPTIONS,
  LAUNCH_EXIT_NOT_FOUND,
  SIGNAL_EXIT_CODES,
} from '../bin/bgos-launch.mjs'

/** exists stub: true only for the given absolute candidates. */
const existsIn = (paths: string[]) => (p: string) => paths.includes(p)

test('resolveBunPath: BUN_INSTALL beats home beats PATH', () => {
  const env = { BUN_INSTALL: '/opt/bun', PATH: '/usr/local/bin:/usr/bin' }
  const home = '/home/kc'
  const everywhere = [
    '/opt/bun/bin/bun',
    '/home/kc/.bun/bin/bun',
    '/usr/local/bin/bun',
    '/usr/bin/bun',
  ]

  const viaInstall = resolveBunPath({ env, home, platform: 'linux', exists: existsIn(everywhere) })
  assert.deepEqual(viaInstall, { path: '/opt/bun/bin/bun', via: 'bun-install' })

  const viaHome = resolveBunPath({
    env,
    home,
    platform: 'linux',
    exists: existsIn(everywhere.slice(1)),
  })
  assert.deepEqual(viaHome, { path: '/home/kc/.bun/bin/bun', via: 'home' })

  const viaPath = resolveBunPath({
    env,
    home,
    platform: 'linux',
    exists: existsIn(everywhere.slice(2)),
  })
  assert.deepEqual(viaPath, { path: '/usr/local/bin/bun', via: 'path' })
})

test('resolveBunPath: PATH entries are probed in order', () => {
  const env = { PATH: '/first/bin:/second/bin' }
  const exists = existsIn(['/first/bin/bun', '/second/bin/bun'])
  const hit = resolveBunPath({ env, home: '', platform: 'linux', exists })
  assert.deepEqual(hit, { path: '/first/bin/bun', via: 'path' })
})

test('resolveBunPath: bunx is a fallback only, and any bun beats every bunx', () => {
  const env = { BUN_INSTALL: '/opt/bun', PATH: '/usr/bin' }
  const home = '/home/kc'

  // No bun anywhere: the bunx probes run, in the same install/home/path order.
  const bunxHome = resolveBunPath({
    env,
    home,
    platform: 'linux',
    exists: existsIn(['/home/kc/.bun/bin/bunx']),
  })
  assert.deepEqual(bunxHome, { path: '/home/kc/.bun/bin/bunx', via: 'bunx-home' })

  const bunxInstall = resolveBunPath({
    env,
    home,
    platform: 'linux',
    exists: existsIn(['/opt/bun/bin/bunx', '/usr/bin/bunx']),
  })
  assert.deepEqual(bunxInstall, { path: '/opt/bun/bin/bunx', via: 'bunx-install' })

  const bunxPath = resolveBunPath({
    env,
    home,
    platform: 'linux',
    exists: existsIn(['/usr/bin/bunx']),
  })
  assert.deepEqual(bunxPath, { path: '/usr/bin/bunx', via: 'bunx-path' })

  // bun's LAST probe (PATH) still beats bunx's FIRST probe (BUN_INSTALL).
  const bunWins = resolveBunPath({
    env,
    home,
    platform: 'linux',
    exists: existsIn(['/usr/bin/bun', '/opt/bun/bin/bunx']),
  })
  assert.deepEqual(bunWins, { path: '/usr/bin/bun', via: 'path' })
})

test('resolveBunPath: win32 probes .exe names and also the bare ones', () => {
  const env = { BUN_INSTALL: 'C:\\bun', PATH: 'C:\\Windows\\system32;C:\\tools' }
  const home = 'C:\\Users\\kc'

  const exe = resolveBunPath({
    env,
    home,
    platform: 'win32',
    exists: existsIn(['C:\\bun\\bin\\bun.exe']),
  })
  assert.deepEqual(exe, { path: 'C:\\bun\\bin\\bun.exe', via: 'bun-install' })

  // A shim without .exe still resolves (bare name probed after the .exe name).
  const bare = resolveBunPath({
    env,
    home,
    platform: 'win32',
    exists: existsIn(['C:\\tools\\bun']),
  })
  assert.deepEqual(bare, { path: 'C:\\tools\\bun', via: 'path' })

  // Within one directory the .exe name wins over the bare name.
  const both = resolveBunPath({
    env,
    home,
    platform: 'win32',
    exists: existsIn(['C:\\tools\\bun.exe', 'C:\\tools\\bun']),
  })
  assert.deepEqual(both, { path: 'C:\\tools\\bun.exe', via: 'path' })
})

test('resolveBunPath: posix never probes .exe names', () => {
  const probed: string[] = []
  const spy = (p: string) => {
    probed.push(p)
    return false
  }
  resolveBunPath({
    env: { BUN_INSTALL: '/opt/bun', PATH: '/usr/local/bin:/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: spy,
  })
  assert.ok(probed.length > 0, 'the probe set must not be empty')
  assert.equal(
    probed.filter((p) => p.endsWith('.exe')).length,
    0,
    `posix probed an .exe name: ${probed.join(', ')}`,
  )

  // And an exists that only knows .exe files can never satisfy a posix probe.
  const exeOnly = resolveBunPath({
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: (p: string) => p.endsWith('.exe'),
  })
  assert.equal(exeOnly, null)
})

test('resolveBunPath: null when nothing exists, and empty inputs do not throw', () => {
  assert.equal(
    resolveBunPath({
      env: { BUN_INSTALL: '/opt/bun', PATH: '/usr/bin' },
      home: '/home/kc',
      platform: 'linux',
      exists: () => false,
    }),
    null,
  )
  assert.equal(resolveBunPath({ env: {}, home: '', platform: 'linux', exists: () => false }), null)
  assert.equal(resolveBunPath({ env: {}, home: '', platform: 'win32', exists: () => false }), null)
})

test('executableNames: .exe variants only on win32', () => {
  assert.deepEqual(executableNames('bun', 'win32'), ['bun.exe', 'bun'])
  assert.deepEqual(executableNames('bun', 'linux'), ['bun'])
  assert.deepEqual(executableNames('bunx', 'darwin'), ['bunx'])
})

test('bunInstallHint: the right one-liner per platform', () => {
  assert.equal(bunInstallHint('win32'), 'powershell -c "irm bun.sh/install.ps1 | iex"')
  assert.equal(bunInstallHint('linux'), 'curl -fsSL https://bun.sh/install | bash')
  assert.equal(bunInstallHint('darwin'), 'curl -fsSL https://bun.sh/install | bash')
})

test('missingBunMessage: names bun, carries the install command, mentions PATH and bunx', () => {
  for (const platform of ['win32', 'linux']) {
    const message = missingBunMessage(platform)
    assert.ok(message.includes('bun'), 'must name bun')
    assert.ok(message.includes('bunx'), 'must mention bunx')
    assert.ok(message.includes('PATH'), 'must mention PATH')
    assert.ok(message.includes(bunInstallHint(platform)), 'must carry the install command')
    assert.ok(/plugin/i.test(message), 'must say the plugin needs it')
  }
})

test('resolveLaunchCwd: server.ts gets its containing directory, wrappers keep the inherited cwd', () => {
  assert.equal(resolveLaunchCwd(['E:\\plugin\\server.ts'], 'win32'), 'E:\\plugin')
  assert.equal(resolveLaunchCwd(['/opt/plugin/server.ts'], 'linux'), '/opt/plugin')
  assert.equal(resolveLaunchCwd(['/opt/plugin/wrapper.mjs', '--plugin-dir', '/opt/plugin'], 'linux'), undefined)
  assert.equal(resolveLaunchCwd([], 'linux'), undefined)
})

test('exitCodeForChild: forwards codes, maps signals, never returns null', () => {
  assert.equal(exitCodeForChild(0, null), 0)
  assert.equal(exitCodeForChild(7, null), 7)
  assert.equal(exitCodeForChild(null, 'SIGTERM'), SIGNAL_EXIT_CODES.SIGTERM)
  assert.equal(exitCodeForChild(null, 'SIGINT'), SIGNAL_EXIT_CODES.SIGINT)
  assert.equal(exitCodeForChild(null, 'SIGHUP'), 1)
  assert.equal(exitCodeForChild(null, null), 1)
})

// ── main wiring (injected IO; no real bun involved) ──────────────────────────

class FakeChild extends EventEmitter {
  killed: string[] = []
  kill(signal?: string) {
    this.killed.push(String(signal ?? 'SIGTERM'))
    return true
  }
}

test('main: exits 127 with the hint (and no spawn) when bun is unresolvable', async () => {
  // Real existsSync against a scratch HOME + PATH that cannot hold bun, so the
  // default probe genuinely comes up empty even on a machine that has bun.
  const scratch = await mkdtemp(join(tmpdir(), 'bgos-launch-'))
  try {
    let spawned = 0
    let err = ''
    const code = await main(['server.ts'], {
      env: { BUN_INSTALL: join(scratch, 'nowhere'), PATH: scratch },
      home: scratch,
      spawnImpl: (() => {
        spawned++
        return new FakeChild()
      }) as never,
      writeErr: (text: string) => {
        err += text
      },
    })
    assert.equal(code, LAUNCH_EXIT_NOT_FOUND)
    assert.equal(spawned, 0, 'nothing may be spawned when bun is missing')
    assert.ok(err.includes('bun'), 'stderr must name bun')
    assert.ok(err.includes('PATH'), 'stderr must mention PATH')
    assert.ok(err.includes(bunInstallHint(process.platform)), 'stderr must carry the install command')
    assert.ok(!err.includes('ENOENT'), 'no raw ENOENT reaches the user')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('main: spawns the resolved bun with the given argv, inherit stdio, and the server.ts cwd', async () => {
  const child = new FakeChild()
  const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
  const done = main(['/opt/plugin/server.ts'], {
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsIn(['/usr/bin/bun']),
    spawnImpl: ((file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts })
      return child
    }) as never,
    writeErr: () => {},
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, '/usr/bin/bun')
  assert.deepEqual(calls[0].args, ['/opt/plugin/server.ts'])
  assert.equal(calls[0].opts.stdio, 'inherit')
  assert.equal(calls[0].opts.cwd, '/opt/plugin')
})

test('main: forwards SIGTERM/SIGINT to the child and maps a signal death to 128+n', async () => {
  const child = new FakeChild()
  const handlers: Record<string, () => void> = {}
  const done = main(['/opt/plugin/wrapper.mjs'], {
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsIn(['/usr/bin/bun']),
    spawnImpl: (() => child) as never,
    writeErr: () => {},
    onSignal: (signal: string, handler: () => void) => {
      handlers[signal] = handler
    },
  })
  handlers.SIGTERM()
  assert.deepEqual(child.killed, ['SIGTERM'])
  handlers.SIGINT()
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGINT'])
  child.emit('exit', null, 'SIGTERM')
  assert.equal(await done, SIGNAL_EXIT_CODES.SIGTERM)
})

test('main: a spawn error surfaces the hint, not a bare stack, and exits 127', async () => {
  const child = new FakeChild()
  let err = ''
  const done = main(['/opt/plugin/server.ts'], {
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsIn(['/usr/bin/bun']),
    spawnImpl: (() => child) as never,
    writeErr: (text: string) => {
      err += text
    },
    onSignal: () => {},
  })
  child.emit('error', new Error('spawn EACCES'))
  assert.equal(await done, LAUNCH_EXIT_NOT_FOUND)
  assert.ok(err.includes('could not start /usr/bin/bun'), 'must say what failed to start')
  assert.ok(err.includes(bunInstallHint('linux')), 'must still carry the install guidance')
  assert.ok(!err.includes('\n    at '), 'no stack frames in the user-visible error')
})

// 2026-08-27. Relocating cwd so bun can resolve the server's dependencies
// silently broke the folder pin for every marketplace install: the server's
// process.cwd() became the plugin cache directory, so the identity lookup read
// <plugin>/.bgos-agent-id instead of the operator's own folder. The pin could
// never be found, and the refusal then told the user to create the very file it
// had just made unreadable. The original directory now travels in the
// environment, which survives the relocation.
test('main: carries the ORIGINAL cwd through as BGOS_LAUNCH_CWD when it relocates', async () => {
  const child = new FakeChild()
  const calls: Array<{ opts: Record<string, unknown> }> = []
  const done = main(['/opt/plugin/server.ts'], {
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsIn(['/usr/bin/bun']),
    spawnImpl: ((_f: string, _a: string[], opts: Record<string, unknown>) => {
      calls.push({ opts })
      return child
    }) as never,
    writeErr: () => {},
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  // It still relocates, because that is what makes bun resolve dependencies...
  assert.equal(calls[0].opts.cwd, '/opt/plugin')
  // ...and the directory the operator was actually in travels alongside it.
  const env = calls[0].opts.env as Record<string, string>
  assert.equal(env.BGOS_LAUNCH_CWD, process.cwd())
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment must survive')
})

test('main: an explicit BGOS_LAUNCH_CWD is respected, not overwritten', async () => {
  // A supervisor or a wrapper may already know the operator's directory.
  const child = new FakeChild()
  const calls: Array<{ opts: Record<string, unknown> }> = []
  const done = main(['/opt/plugin/server.ts'], {
    env: { PATH: '/usr/bin', BGOS_LAUNCH_CWD: '/home/kc/agents/vexa' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsIn(['/usr/bin/bun']),
    spawnImpl: ((_f: string, _a: string[], opts: Record<string, unknown>) => {
      calls.push({ opts })
      return child
    }) as never,
    writeErr: () => {},
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  const env = calls[0].opts.env as Record<string, string>
  assert.equal(env.BGOS_LAUNCH_CWD, '/home/kc/agents/vexa')
})

test('main: a wrapper argv keeps the inherited cwd and needs no override', async () => {
  // No relocation means process.cwd() is already the operator's directory, so
  // injecting the variable would be noise.
  const child = new FakeChild()
  const calls: Array<{ opts: Record<string, unknown> }> = []
  const done = main(['/opt/plugin/wrapper.mjs', '--plugin-dir', '/opt/plugin'], {
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsIn(['/usr/bin/bun']),
    spawnImpl: ((_f: string, _a: string[], opts: Record<string, unknown>) => {
      calls.push({ opts })
      return child
    }) as never,
    writeErr: () => {},
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  assert.equal(calls[0].opts.cwd, undefined)
  assert.equal(calls[0].opts.env, undefined)
})

// The Agent Browser's Node floor (0.72.0): an older Node gets one plain line naming the floor, and bun still starts.
test('main: on a Node older than 22.12.0 it says so in one plain line and still starts bun; a current Node says nothing', async () => {
  for (const [nodeVersion, expectLine] of [['20.11.1', true], ['22.11.9', true], ['22.12.0', false], ['24.16.0', false]] as const) {
    const child = new FakeChild()
    const errs: string[] = []
    let spawned = 0
    const done = main(['/opt/plugin/server.ts'], {
      env: { PATH: '/usr/bin' },
      home: '/home/kc',
      platform: 'linux',
      exists: existsIn(['/usr/bin/bun']),
      spawnImpl: (() => { spawned++; return child }) as never,
      writeErr: (text: string) => errs.push(text),
      onSignal: () => {},
      nodeVersion,
    })
    child.emit('exit', 0, null)
    assert.equal(await done, 0)
    assert.equal(spawned, 1, `${nodeVersion}: bun starts either way`)
    if (expectLine) {
      assert.equal(errs.length, 1, nodeVersion)
      assert.equal(errs[0], `[bgos-launch] This machine runs Node.js ${nodeVersion}, and the HOAI Agent Browser needs Node.js 22.12.0 or newer: install a current Node.js 22 or 24 LTS release from https://nodejs.org, then restart this agent.\n`)
    } else assert.deepEqual(errs, [], nodeVersion)
  }
})

// Board rows a8646712 and dc37e2ac. On Windows, bun 1.3 leaks every thread that
// exits: its handle stays open and about 0.3 MB of committed memory with it.
// JavaScriptCore starts garbage collector helpers and JIT compiler threads when
// there is work and lets them exit a few seconds later, so an idle daemon made
// and lost threads all day: committed memory grew 100 to 330 MB an hour while
// the working set stayed flat, until a PC ran out. One marker, no concurrent
// collector and no concurrent compiler leave both pools empty. Windows only:
// the Mac fleet stays flat on the same bun.
test('WIN32_JSC_THREAD_OPTIONS: one GC marker, no concurrent collector, no concurrent compiler', () => {
  assert.deepEqual({ ...WIN32_JSC_THREAD_OPTIONS }, {
    BUN_JSC_numberOfGCMarkers: '1',
    BUN_JSC_useConcurrentGC: '0',
    BUN_JSC_useConcurrentJIT: '0',
  })
  assert.ok(Object.isFrozen(WIN32_JSC_THREAD_OPTIONS))
})

test('bunRuntimeEnv: win32 gets the thread options; macOS and Linux get nothing', () => {
  assert.deepEqual(bunRuntimeEnv({ env: { PATH: 'C:\\bin' }, platform: 'win32' }), {
    BUN_JSC_numberOfGCMarkers: '1',
    BUN_JSC_useConcurrentGC: '0',
    BUN_JSC_useConcurrentJIT: '0',
  })
  assert.deepEqual(bunRuntimeEnv({ env: { PATH: '/usr/bin' }, platform: 'darwin' }), {})
  assert.deepEqual(bunRuntimeEnv({ env: { PATH: '/usr/bin' }, platform: 'linux' }), {})
})

test('bunRuntimeEnv: a value the operator set is theirs, even an empty one', () => {
  assert.deepEqual(
    bunRuntimeEnv({ env: { BUN_JSC_numberOfGCMarkers: '4' }, platform: 'win32' }),
    { BUN_JSC_useConcurrentGC: '0', BUN_JSC_useConcurrentJIT: '0' },
  )
  assert.deepEqual(
    bunRuntimeEnv({ env: { BUN_JSC_numberOfGCMarkers: '2', BUN_JSC_useConcurrentGC: '', BUN_JSC_useConcurrentJIT: '1' }, platform: 'win32' }),
    {},
  )
})

/** A stand in for spawnSync that records each `bun -e 0` probe and answers with `result`. */
function probeSpy(result: { status: number | null; stderr: string }) {
  const probes: Array<{ file: string; args: string[]; env: Record<string, string> }> = []
  const impl = ((file: string, args: string[], opts: { env: Record<string, string> }) => {
    probes.push({ file, args, env: opts.env })
    return result
  }) as never
  return { probes, impl }
}

const REFUSED = { status: 1, stderr: 'error: invalid JSC environment variable\n\n    BUN_JSC_useConcurrentJIT=0\n' }

test('main: on win32 bun starts with the thread options beside the relocation and the rest of the environment', async () => {
  const child = new FakeChild()
  const calls: Array<{ file: string; opts: Record<string, unknown> }> = []
  const probe = probeSpy({ status: 0, stderr: '' })
  const done = main(['C:\\plugin\\server.ts'], {
    env: { PATH: 'C:\\bun', USERPROFILE: 'C:\\Users\\kc' },
    home: 'C:\\Users\\kc',
    platform: 'win32',
    exists: existsIn(['C:\\bun\\bun.exe']),
    spawnImpl: ((file: string, _a: string[], opts: Record<string, unknown>) => {
      calls.push({ file, opts })
      return child
    }) as never,
    spawnSyncImpl: probe.impl,
    writeErr: () => {},
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  assert.equal(calls[0].file, 'C:\\bun\\bun.exe')
  assert.equal(calls[0].opts.cwd, 'C:\\plugin')
  const env = calls[0].opts.env as Record<string, string>
  assert.equal(env.BUN_JSC_numberOfGCMarkers, '1')
  assert.equal(env.BUN_JSC_useConcurrentGC, '0')
  assert.equal(env.BUN_JSC_useConcurrentJIT, '0')
  assert.equal(env.BGOS_LAUNCH_CWD, process.cwd())
  assert.equal(env.PATH, 'C:\\bun')
  assert.equal(env.USERPROFILE, 'C:\\Users\\kc')
  // The same bun ran `-e 0` with the options first, once.
  assert.equal(probe.probes.length, 1)
  assert.equal(probe.probes[0].file, 'C:\\bun\\bun.exe')
  assert.deepEqual(probe.probes[0].args, ['-e', '0'])
  assert.equal(probe.probes[0].env.BUN_JSC_useConcurrentJIT, '0')
})

// bun exits on a JSC option it does not know, and those options change between
// bun releases: a bun that refuses them must still start the daemon, as before.
test('main: on win32 a bun that refuses the options starts without them and says so', async () => {
  const child = new FakeChild()
  const calls: Array<{ opts: Record<string, unknown> }> = []
  let err = ''
  const done = main(['C:\\plugin\\server.ts'], {
    env: { PATH: 'C:\\bun' },
    home: 'C:\\Users\\kc',
    platform: 'win32',
    exists: existsIn(['C:\\bun\\bun.exe']),
    spawnImpl: ((_f: string, _a: string[], opts: Record<string, unknown>) => {
      calls.push({ opts })
      return child
    }) as never,
    spawnSyncImpl: probeSpy(REFUSED).impl,
    writeErr: (text: string) => {
      err += text
    },
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  const env = calls[0].opts.env as Record<string, string>
  assert.deepEqual(Object.keys(env).sort(), ['BGOS_LAUNCH_CWD', 'PATH'])
  assert.match(err, /^\[bgos-launch\] this bun refuses BUN_JSC_numberOfGCMarkers, BUN_JSC_useConcurrentGC, BUN_JSC_useConcurrentJIT; starting it without them\n$/)
})

// The bunx last resort is bun in `bun x` mode: `bunx -e 0` would fetch a package
// named 0, not check the options, so a bunx launch stays exactly as before.
test('main: on win32 a bunx launch gets no thread options and runs no check', async () => {
  const child = new FakeChild()
  const calls: Array<{ file: string; opts: Record<string, unknown> }> = []
  const done = main(['C:\\plugin\\server.ts'], {
    env: { PATH: 'C:\\bun' },
    home: 'C:\\Users\\kc',
    platform: 'win32',
    exists: existsIn(['C:\\bun\\bunx.exe']),
    spawnImpl: ((file: string, _a: string[], opts: Record<string, unknown>) => {
      calls.push({ file, opts })
      return child
    }) as never,
    spawnSyncImpl: (() => assert.fail('no check through bunx')) as never,
    writeErr: () => {},
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  assert.equal(calls[0].file, 'C:\\bun\\bunx.exe')
  assert.deepEqual(Object.keys(calls[0].opts.env as Record<string, string>).sort(), ['BGOS_LAUNCH_CWD', 'PATH'])
})

test('bunRefusesOptions: only bun\'s own refusal counts, never a probe that failed some other way', () => {
  assert.equal(bunRefusesOptions('bun', {}, probeSpy(REFUSED).impl), true)
  assert.equal(bunRefusesOptions('bun', {}, probeSpy({ status: 0, stderr: '' }).impl), false)
  assert.equal(bunRefusesOptions('bun', {}, probeSpy({ status: null, stderr: '' }).impl), false, 'a timeout')
  assert.equal(bunRefusesOptions('bun', {}, probeSpy({ status: 1, stderr: 'error: Module not found' }).impl), false)
})

test('main: on win32 a wrapper argv still gets the thread options, and no relocation variable', async () => {
  const child = new FakeChild()
  const calls: Array<{ opts: Record<string, unknown> }> = []
  const done = main(['C:\\plugin\\wrapper.mjs'], {
    env: { PATH: 'C:\\bun' },
    home: 'C:\\Users\\kc',
    platform: 'win32',
    exists: existsIn(['C:\\bun\\bun.exe']),
    spawnImpl: ((_f: string, _a: string[], opts: Record<string, unknown>) => {
      calls.push({ opts })
      return child
    }) as never,
    spawnSyncImpl: probeSpy({ status: 0, stderr: '' }).impl,
    writeErr: () => {},
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  assert.equal(calls[0].opts.cwd, undefined)
  const env = calls[0].opts.env as Record<string, string>
  assert.equal(env.BUN_JSC_numberOfGCMarkers, '1')
  assert.equal(env.BUN_JSC_useConcurrentGC, '0')
  assert.equal(env.BUN_JSC_useConcurrentJIT, '0')
  assert.equal(env.BGOS_LAUNCH_CWD, undefined)
})

test('main: on macOS bun starts exactly as before, with no runtime options added', async () => {
  const child = new FakeChild()
  const calls: Array<{ opts: Record<string, unknown> }> = []
  const done = main(['/opt/plugin/server.ts'], {
    env: { PATH: '/usr/bin' },
    home: '/Users/kc',
    platform: 'darwin',
    exists: existsIn(['/usr/bin/bun']),
    spawnImpl: ((_f: string, _a: string[], opts: Record<string, unknown>) => {
      calls.push({ opts })
      return child
    }) as never,
    spawnSyncImpl: (() => assert.fail('nothing is probed off Windows')) as never,
    writeErr: () => {},
    onSignal: () => {},
  })
  child.emit('exit', 0, null)
  assert.equal(await done, 0)
  const env = calls[0].opts.env as Record<string, string>
  assert.deepEqual(Object.keys(env).sort(), ['BGOS_LAUNCH_CWD', 'PATH'])
})

// A daemon started on Windows some other way than through this launcher (a
// hand written .mcp.json running bun server.ts) still loses memory with every
// thread, so it says so once at boot, naming what is missing and the way out.
test('threadOptionsWarning: a Windows daemon without the options says which and how to fix it; otherwise nothing', () => {
  const warning = threadOptionsWarning({ env: { BUN_JSC_numberOfGCMarkers: '1' }, platform: 'win32' })
  assert.ok(warning)
  assert.ok(warning.includes('BUN_JSC_useConcurrentGC'), warning)
  assert.ok(warning.includes('BUN_JSC_useConcurrentJIT'), warning)
  assert.ok(!warning.includes('BUN_JSC_numberOfGCMarkers'), 'a key already set is not missing')
  assert.ok(warning.includes('bin/bgos-launch.mjs'), 'it names the way out')
  assert.ok(!/[\u2013\u2014]/.test(warning), 'no en or em dashes')
  assert.equal(threadOptionsWarning({ env: { ...WIN32_JSC_THREAD_OPTIONS }, platform: 'win32' }), null)
  assert.equal(threadOptionsWarning({ env: {}, platform: 'darwin' }), null)
  assert.equal(threadOptionsWarning({ env: {}, platform: 'linux' }), null)
})

test('server.ts logs the thread options warning once at boot', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8')
  assert.match(source, /import \{ threadOptionsWarning \} from '\.\/bin\/bgos-launch\.mjs'/)
  assert.match(source, /threadOptionsWarning\(\{ env: process\.env, platform: process\.platform \}\)/)
})
