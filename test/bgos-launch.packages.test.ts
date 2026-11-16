/**
 * bgos-launch start check: a version folder that an update left without its
 * packages still starts.
 *
 * Claude Code installs a new plugin version's packages itself, with a short cap,
 * and a failed install is only a warning: the version still loads, and the MCP
 * server then dies at its first import ("Cannot find package"), on every start.
 * The launcher now checks the server's production dependency closure before bun
 * spawns. When something is missing it copies node_modules from the newest
 * sibling version folder whose bun.lock is byte equal (no network), else runs
 * `bun install --frozen-lockfile --production` with a timeout, else says so in
 * one plain line and exits LAUNCH_EXIT_PACKAGES_MISSING, at most one install
 * attempt per PACKAGES_RETRY_MS.
 *
 * The end to end tests run the real launcher with node and the real bun, offline
 * (the registry is 127.0.0.1:9 and bun's cache is an empty temp folder).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  renameSync,
  writeFileSync,
  lstatSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as launch from '../bin/bgos-launch.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCHER = join(REPO, 'bin', 'bgos-launch.mjs')
const OFFLINE_REGISTRY = 'http://127.0.0.1:9'

// ── fixtures ────────────────────────────────────────────────────────────────

type Pkg = { name: string; version?: string; dependencies?: Record<string, string>; body?: string }

/** A tiny ESM package: dep-a imports dep-b, so a run of the server proves transitive resolution. */
function writePackage(nodeModules: string, pkg: Pkg) {
  const dir = join(nodeModules, ...pkg.name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: pkg.name, version: pkg.version ?? '1.0.0', type: 'module', main: 'index.js', dependencies: pkg.dependencies ?? {} }),
  )
  writeFileSync(join(dir, 'index.js'), pkg.body ?? `export default ${JSON.stringify(pkg.name)}\n`)
}

const FULL_SET: Pkg[] = [
  { name: 'dep-a', dependencies: { 'dep-b': '1.0.0' }, body: "import b from 'dep-b'\nexport default 'a+' + b\n" },
  { name: 'dep-b', body: "export default 'b'\n" },
  { name: '@scope/dep-c', body: "export default 'c'\n" },
]

type FolderOpts = { lock?: string; packages?: Pkg[] | null; deps?: Record<string, string> }

/** A version folder: package.json naming dep-a and @scope/dep-c, bun.lock, a server.ts that imports both. */
function versionFolder(parent: string, name: string, { lock = 'lockfile v1\n', packages = null, deps }: FolderOpts = {}) {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-server', version: name, type: 'module', dependencies: deps ?? { 'dep-a': '1.0.0', '@scope/dep-c': '1.0.0' }, devDependencies: { 'dev-only': '1.0.0' } }),
  )
  writeFileSync(join(dir, 'bun.lock'), lock)
  writeFileSync(
    join(dir, 'server.ts'),
    "import a from 'dep-a'\nimport c from '@scope/dep-c'\nconsole.log(JSON.stringify({ started: a + '+' + c }))\n",
  )
  if (packages) for (const pkg of packages) writePackage(join(dir, 'node_modules'), pkg)
  return dir
}

function scratch(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'bgos-launch-pkgs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'hoai')
}

/** Every path under dir with a hash of its bytes (or its link target), to prove a sibling was left alone. */
function treeDigest(dir: string): string {
  const rows: string[] = []
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const st = lstatSync(path)
      const rel = relative(dir, path).split('\\').join('/')
      if (st.isSymbolicLink()) rows.push(`${rel} -> ${readlinkSync(path)}`)
      else if (st.isDirectory()) {
        rows.push(`${rel}/`)
        walk(path)
      } else rows.push(`${rel} ${createHash('sha256').update(readFileSync(path)).digest('hex')} ${st.mtimeMs}`)
    }
  }
  walk(dir)
  return rows.join('\n')
}

type InstallEffect = { code: number | null; stderr?: string; running?: boolean }
/**
 * An install stand in with the real one's shape: it returns at once with the child's pid and a
 * promise of its end, writes `stderr` into the log file, then does what `effect` says. `running`
 * is a child still going: its promise never settles.
 */
function fakeInstall(effect: (cwd: string) => InstallEffect = () => ({ code: 1, stderr: 'error: ConnectionRefused downloading tarball zod@4.3.6\n' })) {
  const calls: Array<{ file: string; args: string[]; cwd: string; logPath: string }> = []
  const runInstall = (file: string, args: string[], opts: { cwd: string; env: unknown; logPath: string }) => {
    calls.push({ file, args, cwd: opts.cwd, logPath: opts.logPath })
    const out = effect(opts.cwd)
    if (out.stderr) writeFileSync(opts.logPath, out.stderr)
    const done = out.running ? new Promise<never>(() => {}) : Promise.resolve({ code: out.code, signal: null })
    return { pid: 4242, done, unref: () => {} }
  }
  return { calls, runInstall }
}

function bunPath(): string | null {
  return launch.resolveBunPath({ env: process.env, home: homedir() })?.path ?? null
}

/** The real launcher, run by node, offline, with an empty bun cache. */
function runLauncher(serverDir: string, cacheDir: string) {
  const started = performance.now()
  const res = spawnSync(process.execPath, [LAUNCHER, join(serverDir, 'server.ts')], {
    cwd: dirname(serverDir),
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: {
      ...process.env,
      BUN_CONFIG_REGISTRY: OFFLINE_REGISTRY,
      NPM_CONFIG_REGISTRY: OFFLINE_REGISTRY,
      npm_config_registry: OFFLINE_REGISTRY,
      BUN_INSTALL_CACHE_DIR: cacheDir,
    },
  })
  return { ...res, ms: performance.now() - started }
}

const noSleep = async () => {}

// ── (i) the sibling copy, end to end ─────────────────────────────────────────

test('(i) an empty version folder, offline, starts on a copy of its sibling\'s packages; the sibling is untouched', { skip: bunPath() ? false : 'no bun on this machine' }, (t) => {
  const parent = scratch(t)
  const sibling = versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const before = treeDigest(sibling)
  const cache = join(dirname(parent), 'bun-cache')
  mkdirSync(cache)

  const res = runLauncher(fresh, cache)

  assert.equal(res.status, 0, `launcher exit ${res.status}; stderr:\n${res.stderr}`)
  assert.match(res.stdout, /"started":"a\+b\+c"/, 'the server ran and its imports, transitive ones included, resolved')
  assert.ok(existsSync(join(fresh, 'node_modules', 'dep-b', 'package.json')))
  assert.match(res.stderr, /copied .*0\.89\.0/, 'stderr says where the packages came from')
  assert.equal(treeDigest(sibling), before, 'the sibling folder is byte and time equal')
  for (const name of readdirSync(fresh)) assert.ok(!name.startsWith('.bgos-'), `no work file left behind: ${name}`)
})

// ── (ii) a sibling with another lockfile is never used ─────────────────────────

test('(ii) a sibling whose bun.lock differs is not copied from; the install fallback runs instead', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET, lock: 'lockfile v0\n' })
  const fresh = versionFolder(parent, '0.90.0', { lock: 'lockfile v1\n' })
  const install = fakeInstall()

  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep })

  assert.equal(result.status, 'missing')
  assert.equal(existsSync(join(fresh, 'node_modules')), false, 'nothing copied')
  assert.equal(install.calls.length, 1)
  assert.deepEqual(install.calls[0].args, ['install', '--frozen-lockfile', '--production', '--ignore-scripts', '--no-summary'])
  assert.equal(install.calls[0].cwd, fresh)
  assert.equal(install.calls[0].logPath, join(fresh, launch.PACKAGES_INSTALL_LOG), 'its stderr goes to a file in the folder, so it survives the launcher')
  assert.equal(result.detail, 'error: ConnectionRefused downloading tarball zod@4.3.6', "bun's last line is the reason")
})

test('(ii) a sibling with the same bun.lock but incomplete packages is passed over for the next one', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.5', { packages: FULL_SET.slice(0, 1) }) // dep-b missing
  versionFolder(parent, '0.88.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const install = fakeInstall()

  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep })

  assert.equal(result.status, 'copied')
  assert.equal(result.from, join(parent, '0.88.0'))
  assert.equal(install.calls.length, 0)
})

test('siblingsNewestFirst: version folders by version, highest first, never the folder itself', (t) => {
  const parent = scratch(t)
  for (const name of ['0.9.0', '0.10.0', '0.89.10', '0.89.9', 'unknown', '0.90.0']) mkdirSync(join(parent, name), { recursive: true })
  writeFileSync(join(parent, 'not-a-folder'), '')
  assert.deepEqual(
    launch.siblingsNewestFirst(join(parent, '0.90.0')).map((p: string) => relative(parent, p)),
    ['0.89.10', '0.89.9', '0.10.0', '0.9.0', 'unknown'],
  )
})

// ── (iii) no sibling, install fails offline ──────────────────────────────────

test('(iii) no sibling and an offline install: one plain line, a distinct exit code, and the next start does not install again', { skip: bunPath() ? false : 'no bun on this machine' }, (t) => {
  const parent = scratch(t)
  const fresh = join(parent, '0.90.0')
  mkdirSync(fresh, { recursive: true })
  // The real manifest and lockfile, so bun genuinely tries to fetch real packages.
  writeFileSync(join(fresh, 'package.json'), readFileSync(join(REPO, 'package.json')))
  writeFileSync(join(fresh, 'bun.lock'), readFileSync(join(REPO, 'bun.lock')))
  writeFileSync(join(fresh, 'server.ts'), "import { z } from 'zod'\nconsole.log('started', typeof z)\n")
  const cache = join(dirname(parent), 'bun-cache')
  mkdirSync(cache)

  const first = runLauncher(fresh, cache)
  assert.equal(first.status, launch.LAUNCH_EXIT_PACKAGES_MISSING, `stderr:\n${first.stderr}`)
  assert.notEqual(launch.LAUNCH_EXIT_PACKAGES_MISSING, launch.LAUNCH_EXIT_NOT_FOUND)
  assert.equal(first.stdout, '', 'nothing on stdout: it is the MCP channel')
  const lines = first.stderr.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, `exactly one line on stderr, got:\n${first.stderr}`)
  assert.match(lines[0], /^\[bgos-launch\] /)
  assert.match(lines[0], /missing packages \(@modelcontextprotocol\/sdk, /, 'it names the missing packages')
  assert.match(lines[0], /installing them failed \(.*ConnectionRefused/, 'it says why, in bun\'s own words')
  assert.match(lines[0], /bun install --production/, 'it says how to fix it by hand')
  assert.ok(existsSync(join(fresh, launch.PACKAGES_ATTEMPT_FILE)), 'the attempt is recorded in the folder itself')

  const attemptBefore = readFileSync(join(fresh, launch.PACKAGES_ATTEMPT_FILE), 'utf8')
  const cacheBefore = treeDigest(cache)
  const second = runLauncher(fresh, cache)
  assert.equal(second.status, launch.LAUNCH_EXIT_PACKAGES_MISSING)
  assert.equal(second.stderr.split('\n').filter(Boolean).length, 1)
  assert.match(second.stderr, /tries again/)
  assert.equal(readFileSync(join(fresh, launch.PACKAGES_ATTEMPT_FILE), 'utf8'), attemptBefore, 'no second install was run')
  assert.equal(treeDigest(cache), cacheBefore, 'bun was not run again: its cache is unchanged')
})

test('(iii) one install attempt per PACKAGES_RETRY_MS, and a fresh attempt once it has passed', async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const install = fakeInstall()
  let now = 1_000_000_000_000
  const run = () => launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep, now: () => now })

  assert.equal((await run()).status, 'missing')
  assert.equal(install.calls.length, 1)
  now += launch.PACKAGES_RETRY_MS - 1
  const held = await run()
  assert.equal(held.status, 'missing')
  assert.equal(held.reason, 'recent_attempt')
  assert.equal(install.calls.length, 1, 'no install inside the window')
  now += 2
  await run()
  assert.equal(install.calls.length, 2, 'the window passed: one more attempt')
})

test('(iii) the plain line: what is wrong, why, when it tries again, and the fix by hand', () => {
  const line = launch.packagesMissingMessage({
    status: 'missing',
    serverDir: '/Users/example/.claude/plugins/cache/market/hoai/0.90.0',
    missing: ['zod', '@modelcontextprotocol/sdk', 'socket.io-client', 'playwright-core'],
    reason: 'install_failed',
    detail: 'error: ConnectionRefused downloading tarball zod@4.3.6',
    retryAt: Date.UTC(2026, 10, 16, 12, 30),
  })
  assert.equal(line.includes('\n'), false, 'one line')
  assert.match(line, /^\[bgos-launch\] /)
  assert.match(line, /zod, @modelcontextprotocol\/sdk, socket\.io-client and 1 more/)
  assert.match(line, /ConnectionRefused/)
  assert.match(line, /run bun install --production in "\/Users\/example\/\.claude\/plugins\/cache\/market\/hoai\/0\.90\.0"/)
  assert.equal(line.includes('&&'), false, 'no shell syntax: cmd needs cd \/d across drives and PowerShell 5 has no &&')
  const installing = launch.packagesMissingMessage({ status: 'missing', serverDir: '/x', missing: ['zod'], reason: 'installing', retryAt: 0 })
  assert.equal(installing.includes('\n'), false)
  assert.match(installing, /being installed now/)
  assert.match(installing, /\/mcp/, 'it says how to start again once they are in: Claude Code does not retry by itself')
})

test('(iii) only a bunx was found: no install is tried, and the reason is one main starts bun anyway for', async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const install = fakeInstall()
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: install.runInstall, sleep: noSleep })
  assert.equal(result.status, 'missing')
  assert.equal(result.reason, 'no_bun')
  assert.equal(install.calls.length, 0)
  assert.ok(launch.START_ANYWAY_REASONS.has('no_bun'), 'the check could not help, so it must not stand in the way either')
})

test('an install that brings the packages: installed, and the attempt record is cleared', async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  writeFileSync(join(fresh, launch.PACKAGES_ATTEMPT_FILE), JSON.stringify({ at: 0, outcome: 'failed' }))
  const install = fakeInstall((cwd) => {
    for (const pkg of FULL_SET) writePackage(join(cwd, 'node_modules'), pkg)
    return { code: 0 }
  })
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep })
  assert.equal(result.status, 'installed')
  assert.equal(existsSync(join(fresh, launch.PACKAGES_ATTEMPT_FILE)), false)
})

test('an install that exits 0 is believed over the check: bun starts, and what the check could not find is named', async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const install = fakeInstall((cwd) => {
    writePackage(join(cwd, 'node_modules'), FULL_SET[0])
    return { code: 0 }
  })
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep })
  assert.equal(result.status, 'installed')
  assert.ok(result.unresolved.includes('dep-b'))
  // Remembered: while the check finds nothing beyond what bun was believed over, a start does no work.
  assert.equal(launch.packagesNeedWork(fresh), false)
  const again = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep })
  assert.equal(again.status, 'present')
  assert.equal(install.calls.length, 1, 'no install on every start')
  rmSync(join(fresh, 'node_modules', 'dep-a'), { recursive: true })
  assert.equal(launch.packagesNeedWork(fresh), true, 'something more goes missing: the check works again')
})

test('an install still running when the wait ends keeps going: the lock passes to it and the line says so', async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const install = fakeInstall(() => ({ code: null, running: true }))
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep, waitMs: 50 })
  assert.equal(result.status, 'missing')
  assert.equal(result.reason, 'installing')
  const owner = JSON.parse(readFileSync(join(fresh, launch.PACKAGES_LOCK_DIR, 'owner.json'), 'utf8'))
  assert.equal(owner.pid, 4242, 'the install holds the folder now, so no second install starts beside it')

  // The next start finds it still running, waits for it, and starts once its packages are in.
  let waits = 0
  const next = await launch.ensureServerPackages({
    serverDir: fresh,
    bunPath: '/opt/bun/bin/bun',
    env: {},
    runInstall: install.runInstall,
    isAlive: (pid: number) => pid === 4242,
    sleep: async () => {
      if (++waits === 2) for (const pkg of FULL_SET) writePackage(join(fresh, 'node_modules'), pkg)
    },
  })
  assert.equal(next.status, 'present')
  assert.equal(install.calls.length, 1, 'no second install')
})

test('a start waits at most its wait for another start, then gives up with a plain reason', { timeout: 30_000 }, async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  mkdirSync(join(fresh, launch.PACKAGES_LOCK_DIR))
  writeFileSync(join(fresh, launch.PACKAGES_LOCK_DIR, 'owner.json'), JSON.stringify({ pid: 4242, at: Date.now(), token: 'theirs' }))
  let now = Date.now()
  const result = await launch.ensureServerPackages({
    serverDir: fresh,
    bunPath: '/opt/bun/bin/bun',
    env: {},
    runInstall: fakeInstall().runInstall,
    isAlive: () => true,
    now: () => now,
    sleep: async (ms: number) => void (now += ms),
    waitMs: 5_000,
  })
  assert.equal(result.status, 'missing')
  assert.equal(result.reason, 'installing')
  assert.ok(existsSync(join(fresh, launch.PACKAGES_LOCK_DIR)), 'the other start keeps its lock')
})

test('startWaitMs: under Claude Code\'s wait for the MCP server, from MCP_TIMEOUT when it is set', () => {
  assert.equal(launch.startWaitMs({}), 25_000)
  assert.equal(launch.startWaitMs({ MCP_TIMEOUT: '60000' }), 55_000)
  assert.equal(launch.startWaitMs({ MCP_TIMEOUT: 'soon' }), 25_000)
  assert.equal(launch.startWaitMs({ MCP_TIMEOUT: '8000' }), 4_000, 'a short wait: half of it, still under it')
  assert.equal(launch.startWaitMs({ MCP_TIMEOUT: '9999999' }), launch.PACKAGES_START_WAIT_MAX_MS, 'never more than the cap')
})

test('startInstall: the child runs on its own with stderr in the log file, and its end is reported', async (t) => {
  const parent = scratch(t)
  mkdirSync(parent, { recursive: true })
  const logPath = join(parent, 'install.log')
  const child = launch.startInstall(process.execPath, ['-e', 'console.log("to stdout"); console.error("error: nope"); process.exit(3)'], { cwd: parent, env: process.env, logPath })
  assert.ok(Number.isInteger(child.pid))
  const end = await child.done
  assert.equal(end.code, 3)
  assert.equal(readFileSync(logPath, 'utf8').trim(), 'error: nope', 'stderr in the file')

  // The launcher's stdout is the MCP channel: a launcher that runs an install must print nothing there.
  const script = [
    `import { startInstall } from ${JSON.stringify(pathToFileURL(LAUNCHER).href)}`,
    `const child = startInstall(process.execPath, ['-e', 'console.log("to stdout")'], { cwd: ${JSON.stringify(parent)}, env: process.env, logPath: ${JSON.stringify(logPath)} })`,
    'await child.done',
  ].join('\n')
  const host = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(host.status, 0, host.stderr)
  assert.equal(host.stdout, '', "the install's stdout reaches nothing")
})

test('startInstall: when bun ends, the install itself records how it went and lets go of the folder, even with no start left to do it', { timeout: 60_000 }, async (t) => {
  const parent = scratch(t)
  const dir = versionFolder(parent, '0.90.0')
  const lockDir = join(dir, launch.PACKAGES_LOCK_DIR)
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 1, at: Date.now(), token: 'mine' }))
  const opts = {
    cwd: dir,
    env: process.env,
    logPath: join(dir, launch.PACKAGES_INSTALL_LOG),
    attemptPath: join(dir, launch.PACKAGES_ATTEMPT_FILE),
    lockDir,
    token: 'mine',
    at: 1234,
    timeoutMs: 60_000,
  }
  const failed = launch.startInstall(process.execPath, ['-e', 'console.error("error: ConnectionRefused"); process.exit(1)'], opts)
  assert.equal((await failed.done).code, 1)
  assert.deepEqual(JSON.parse(readFileSync(opts.attemptPath, 'utf8')), { at: 1234, reason: 'install_failed', detail: 'error: ConnectionRefused' })
  assert.equal(existsSync(lockDir), false, 'released')

  // Somebody else's lock is never released by it.
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 1, at: Date.now(), token: 'theirs' }))
  const ok = launch.startInstall(process.execPath, ['-e', 'process.exit(0)'], opts)
  assert.equal((await ok.done).code, 0)
  assert.ok(existsSync(lockDir))
  assert.equal(existsSync(opts.attemptPath), false, 'a good install leaves no retry window')

  // A hung install is stopped at its cap by the install's own keeper.
  const started = performance.now()
  const hung = launch.startInstall(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { ...opts, timeoutMs: 1_000 })
  const end = await hung.done
  assert.notEqual(end.code, 0)
  assert.ok(performance.now() - started < 30_000)
  assert.match(JSON.parse(readFileSync(opts.attemptPath, 'utf8')).detail, /took longer than 1 s/)
})

// ── (iv) packages present: nothing happens, fast ─────────────────────────────

test('(iv) packages present: no copy, no install, and the check adds under 50 ms on the real tree', async () => {
  const install = fakeInstall()
  let copies = 0
  const copyDir = () => {
    copies++
  }
  const opts = { serverDir: REPO, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, copyDir, sleep: noSleep }
  assert.equal((await launch.ensureServerPackages(opts)).status, 'present')
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    const result = await launch.ensureServerPackages(opts)
    times.push(performance.now() - started)
    assert.equal(result.status, 'present')
  }
  times.sort((a, b) => a - b)
  assert.ok(times[2] < 50, `median check ${times[2].toFixed(1)} ms`)
  assert.equal(install.calls.length, 0)
  assert.equal(copies, 0)
})

test('(iv) a folder with no package.json is none of the check\'s business', async (t) => {
  const parent = scratch(t)
  mkdirSync(join(parent, 'bare'), { recursive: true })
  const install = fakeInstall()
  const result = await launch.ensureServerPackages({ serverDir: join(parent, 'bare'), bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep })
  assert.equal(result.status, 'skipped')
  assert.equal(install.calls.length, 0)
})

test('missingPackages: the production closure, transitive ones included, never devDependencies', (t) => {
  const parent = scratch(t)
  const dir = versionFolder(parent, '0.90.0', { packages: FULL_SET })
  assert.deepEqual(launch.missingPackages(dir), [], 'dev-only is a devDependency and is not needed')
  rmSync(join(dir, 'node_modules', 'dep-b'), { recursive: true })
  assert.deepEqual(launch.missingPackages(dir), ['dep-b'], 'a package that only a dependency needs')
  rmSync(join(dir, 'node_modules'), { recursive: true })
  assert.deepEqual(launch.missingPackages(dir).sort(), ['@scope/dep-c', 'dep-a'])
})

test('missingPackages: a nested copy and a parent folder\'s node_modules both count, as node resolves them', (t) => {
  const parent = scratch(t)
  const dir = versionFolder(parent, '0.90.0', { packages: [FULL_SET[0]] })
  writePackage(join(dir, 'node_modules', 'dep-a', 'node_modules'), FULL_SET[1])
  writePackage(join(parent, 'node_modules'), FULL_SET[2])
  assert.deepEqual(launch.missingPackages(dir), [])
})

test('missingPackages: optional and peer dependencies are not required', (t) => {
  const parent = scratch(t)
  const dir = versionFolder(parent, '0.90.0', { packages: FULL_SET })
  const pj = join(dir, 'node_modules', 'dep-b', 'package.json')
  writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, 'utf8')), optionalDependencies: { 'fsevents-like': '1' }, peerDependencies: { 'peer-x': '1' } }))
  assert.deepEqual(launch.missingPackages(dir), [])
})

// ── (v) a copy that fails half way leaves nothing broken ──────────────────────

test('(v) a copy that fails half way leaves no node_modules and no work folder, then falls back to install', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const install = fakeInstall()
  const copyDir = (_from: string, to: string) => {
    mkdirSync(join(to, 'dep-a'), { recursive: true })
    writeFileSync(join(to, 'dep-a', 'package.json'), '{"name":"dep-a"}')
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  }

  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, copyDir, sleep: noSleep })

  assert.equal(result.status, 'missing')
  assert.equal(existsSync(join(fresh, 'node_modules')), false, 'no half copy under the real name')
  assert.deepEqual(readdirSync(fresh).filter((n) => n.startsWith('.bgos-') && n !== launch.PACKAGES_ATTEMPT_FILE && n !== launch.PACKAGES_INSTALL_LOG), [], 'no work folder or lock left')
  assert.equal(install.calls.length, 1, 'the install fallback still ran')
})

test('(v) a half installed node_modules is replaced whole, and a failed copy leaves it exactly as it was', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0', { packages: [FULL_SET[0]] }) // dep-b and dep-c missing
  writeFileSync(join(fresh, 'node_modules', 'leftover.txt'), 'from the failed install')
  const before = treeDigest(join(fresh, 'node_modules'))

  const failing = await launch.ensureServerPackages({
    serverDir: fresh,
    bunPath: null,
    env: {},
    runInstall: fakeInstall().runInstall,
    sleep: noSleep,
    copyDir: () => {
      throw new Error('EIO')
    },
  })
  assert.equal(failing.status, 'missing')
  assert.equal(treeDigest(join(fresh, 'node_modules')), before, 'the old folder is untouched')

  const ok = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep })
  assert.equal(ok.status, 'copied')
  assert.deepEqual(launch.missingPackages(fresh), [])
  assert.equal(existsSync(join(fresh, 'node_modules', 'leftover.txt')), false, 'the half folder was replaced, not merged')
  assert.deepEqual(readdirSync(fresh).filter((n) => n.startsWith('.bgos-')), [], 'the old copy was removed')
})

test('(v) relative links inside node_modules stay relative, so the copy never points into the sibling', async (t) => {
  const parent = scratch(t)
  const sibling = versionFolder(parent, '0.89.0', { packages: FULL_SET })
  mkdirSync(join(sibling, 'node_modules', '.bin'))
  const target = join('..', 'dep-a', 'index.js')
  try {
    symlinkSync(target, join(sibling, 'node_modules', '.bin', 'dep-a'), 'file')
  } catch (err) {
    t.skip(`this machine cannot make symlinks (${(err as Error).message})`)
    return
  }
  const fresh = versionFolder(parent, '0.90.0')
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep })
  assert.equal(result.status, 'copied')
  assert.equal(readlinkSync(join(fresh, 'node_modules', '.bin', 'dep-a')), target)
})

// ── several agents starting the same new version at once ─────────────────────

test('a start that finds another start fixing the folder waits for it instead of copying again', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const lock = join(fresh, launch.PACKAGES_LOCK_DIR)
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid + 1, at: Date.now(), token: 'theirs' }))
  let copies = 0
  let waits = 0
  const sleep = async () => {
    waits++
    // The other start finishes: its packages are in, its lock is gone.
    for (const pkg of FULL_SET) writePackage(join(fresh, 'node_modules'), pkg)
    rmSync(lock, { recursive: true })
  }
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, copyDir: () => void copies++, sleep, isAlive: () => true })
  assert.equal(result.status, 'present')
  assert.equal(copies, 0)
  assert.ok(waits >= 1)
})

test('a lock left by a start that died is taken over', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const lock = join(fresh, launch.PACKAGES_LOCK_DIR)
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, at: Date.now(), token: 'dead' }))
  mkdirSync(join(fresh, `${launch.PACKAGES_PARTIAL_DIR}-999999999`))
  writeFileSync(join(fresh, `${launch.PACKAGES_PARTIAL_DIR}-999999999`, 'half.txt'), 'the dead start\'s half copy')
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep, isAlive: () => false })
  assert.equal(result.status, 'copied')
  assert.equal(existsSync(lock), false, 'released')
  assert.deepEqual(readdirSync(fresh).filter((n) => n.startsWith('.bgos-')), [], "the dead start's half copy went with its lock")
})

test('two starts that both judge the same lock dead: the second gives back the lock the first just took', { timeout: 30_000 }, async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const lock = join(fresh, launch.PACKAGES_LOCK_DIR)
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_998, at: Date.now(), token: 'dead' }))
  let installs = 0
  const result = await launch.ensureServerPackages({
    serverDir: fresh,
    bunPath: '/opt/bun/bin/bun',
    env: {},
    runInstall: fakeInstall(() => (installs++, { code: 1 })).runInstall,
    // While this start decides the holder is gone, another start takes the lock over first.
    isAlive: (pid: number) => {
      if (pid === 999_999_998) {
        writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 4243, at: Date.now(), token: 'the-first-taker' }))
        return false
      }
      return pid === 4243
    },
    sleep: async () => {
      for (const pkg of FULL_SET) writePackage(join(fresh, 'node_modules'), pkg)
    },
  })
  assert.equal(result.status, 'present', 'it waited for the first taker instead of working beside it')
  assert.equal(installs, 0)
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, 'the-first-taker')
})

test('a dead lock that cannot be moved never spins: the start gives up within its wait', { timeout: 30_000 }, async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const lock = join(fresh, launch.PACKAGES_LOCK_DIR)
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_997, at: Date.now(), token: 'dead' }))
  let now = Date.now()
  let tries = 0
  const result = await launch.ensureServerPackages({
    serverDir: fresh,
    bunPath: '/opt/bun/bin/bun',
    env: {},
    runInstall: fakeInstall().runInstall,
    isAlive: () => false,
    now: () => now,
    sleep: async (ms: number) => void (now += ms),
    rename: (from: string, to: string) => {
      if (from === lock) {
        tries++
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      renameSync(from, to)
    },
    waitMs: 5_000,
  })
  assert.equal(result.status, 'missing')
  assert.equal(result.reason, 'not_writable')
  assert.ok(launch.START_ANYWAY_REASONS.has('not_writable'))
  assert.ok(tries < 100, `it paced its tries (${tries})`)
})

test('one wait per start: a slow copy leaves the install only what is left, and the install still starts in the background', { timeout: 30_000 }, async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  let now = 1_000_000
  const install = fakeInstall(() => ({ code: null, running: true }))
  const started = performance.now()
  const result = await launch.ensureServerPackages({
    serverDir: fresh,
    bunPath: '/opt/bun/bin/bun',
    env: {},
    runInstall: install.runInstall,
    now: () => now,
    sleep: noSleep,
    waitMs: 20_000,
    copyDir: () => {
      now += 20_000 // the whole wait went on a copy that then failed
      throw new Error('EIO')
    },
  })
  assert.equal(result.reason, 'installing')
  assert.equal(install.calls.length, 1, 'the install was started all the same')
  assert.ok(performance.now() - started < 5_000, 'and the start did not wait a second time')
})

test('a lock that cannot be put back is left aside, never deleted', async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const lock = join(fresh, launch.PACKAGES_LOCK_DIR)
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_996, at: Date.now(), token: 'dead' }))
  let now = Date.now()
  await launch.ensureServerPackages({
    serverDir: fresh,
    bunPath: null,
    env: {},
    runInstall: fakeInstall().runInstall,
    now: () => now,
    sleep: async (ms: number) => void (now += ms),
    waitMs: 3_000,
    isAlive: (pid: number) => {
      if (pid === 999_999_996) writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 4244, at: Date.now(), token: 'live' }))
      return pid === 4244
    },
    rename: (from: string, to: string) => {
      if (to === lock) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) // the put back never works
      renameSync(from, to)
    },
  })
  const kept = readdirSync(fresh).filter((n) => n.startsWith(`${launch.PACKAGES_LOCK_DIR}.stale-`))
  assert.equal(kept.length, 1, 'the live lock was left aside')
  assert.equal(JSON.parse(readFileSync(join(fresh, kept[0], 'owner.json'), 'utf8')).token, 'live')
})

test('a start holding the folder clears the half copies of starts that are gone, and only those', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  for (const name of [`${launch.PACKAGES_OLD_DIR}-999999995`, `${launch.PACKAGES_PARTIAL_DIR}-999999994`, `${launch.PACKAGES_PARTIAL_DIR}-4245`]) {
    mkdirSync(join(fresh, name))
    writeFileSync(join(fresh, name, 'x'), 'x')
  }
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep, isAlive: (pid: number) => pid === 4245 })
  assert.equal(result.status, 'copied')
  assert.deepEqual(readdirSync(fresh).filter((n) => n.startsWith('.bgos-')), [`${launch.PACKAGES_PARTIAL_DIR}-4245`], "a live start's work is left alone")
})

test('a copy cut off by a stop (the start killed mid copy) is not tried again at once: the next start installs instead', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const marker = join(fresh, launch.PACKAGES_COPY_FILE)
  // What a start leaves when it is killed inside the copy: its record that a copy began.
  writeFileSync(marker, JSON.stringify({ pid: 999999993, at: Date.now() }))
  let copies = 0
  const copyDir = (from: string, to: string) => {
    copies++
    cpSync(from, to, { recursive: true })
  }
  const install = fakeInstall((cwd) => {
    for (const pkg of FULL_SET) writePackage(join(cwd, 'node_modules'), pkg)
    return { code: 0 }
  })
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep, copyDir, isAlive: () => false })
  assert.equal(result.status, 'installed')
  assert.equal(copies, 0, 'no second copy right after one that never finished')
  assert.equal(install.calls.length, 1)
  assert.ok(!existsSync(marker), 'with the packages in, the record goes')
})

test('a copy record older than PACKAGES_RETRY_MS, or of a start still alive, does not stop the copy; the record is there only while copying', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  for (const [name, record, alive] of [
    ['0.90.0', { pid: 999999993, at: Date.now() - launch.PACKAGES_RETRY_MS - 1_000 }, false],
    ['0.90.1', null, false],
    // A start still copying elsewhere (its lock taken over as hung) is no reason to stop.
    ['0.90.2', { pid: 999999993, at: Date.now() }, true],
  ] as const) {
    const fresh = versionFolder(parent, name)
    const marker = join(fresh, launch.PACKAGES_COPY_FILE)
    if (record) writeFileSync(marker, JSON.stringify(record))
    let seenWhileCopying: unknown = null
    const copyDir = (from: string, to: string) => {
      seenWhileCopying = JSON.parse(readFileSync(marker, 'utf8'))
      cpSync(from, to, { recursive: true })
    }
    const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep, copyDir, isAlive: () => alive, pid: 4250 })
    assert.equal(result.status, 'copied', name)
    assert.equal((seenWhileCopying as { pid?: number } | null)?.pid, 4250, 'the record names this start while it copies')
    assert.ok(!existsSync(marker), 'and goes when the copy is done')
  }
})

test('the owner record is replaced whole (written aside, renamed over), so a start never reads it half written', async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const lock = join(fresh, launch.PACKAGES_LOCK_DIR)
  const ownerRenames: string[] = []
  const rename = (from: string, to: string) => {
    if (to === join(lock, 'owner.json')) ownerRenames.push(from)
    renameSync(from, to)
  }
  const install = fakeInstall(() => ({ code: null, running: true }))
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: '/opt/bun/bin/bun', env: {}, runInstall: install.runInstall, sleep: noSleep, waitMs: 50, rename })
  assert.equal(result.reason, 'installing')
  assert.equal(ownerRenames.length, 2, 'both changes of holder (start and install, then the install alone) are renames')
  for (const from of ownerRenames) assert.equal(dirname(from), lock, 'written aside inside the lock itself')
  assert.deepEqual(readdirSync(lock), ['owner.json'], 'nothing left beside it')
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid, 4242)
})

test('a release moves the lock to a name of its own before removing it, so a start that takes the folder meanwhile keeps its lock', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const lock = join(fresh, launch.PACKAGES_LOCK_DIR)
  const lockMoves: string[] = []
  const rename = (from: string, to: string) => {
    if (from === lock) lockMoves.push(basename(to))
    renameSync(from, to)
  }
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep, rename })
  assert.equal(result.status, 'copied')
  assert.equal(lockMoves.length, 1)
  assert.match(lockMoves[0], /^\.bgos-packages\.lock\.done-/)
  assert.deepEqual(readdirSync(fresh).filter((n) => n.startsWith('.bgos-')), [], 'released, and nothing left')
})

test('a start holding the folder also clears lock leftovers of starts that are gone, and a moved aside lock only once its holders are gone', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const L = launch.PACKAGES_LOCK_DIR
  const leftovers: Array<[string, object | null]> = [
    [`${L}.new-999999992-0b1c`, { pid: 999999992, at: 1, token: '999999992-0b1c' }],
    [`${L}.done-999999991-77aa`, null],
    [`${L}.stale-999999990-1234abcd`, { pid: 999999988, at: 1, token: 'gone' }],
    [`${L}.stale-999999989-5678abcd`, { pid: 4245, at: 1, token: 'live' }],
    [`${L}.new-4246-3c3c`, { pid: 4246, at: 1, token: '4246-3c3c' }],
  ]
  for (const [name, owner] of leftovers) {
    mkdirSync(join(fresh, name))
    if (owner) writeFileSync(join(fresh, name, 'owner.json'), JSON.stringify(owner))
  }
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep, isAlive: (pid: number) => pid === 4245 || pid === 4246 })
  assert.equal(result.status, 'copied')
  assert.deepEqual(
    readdirSync(fresh).filter((n) => n.startsWith('.bgos-')).sort(),
    [`${L}.new-4246-3c3c`, `${L}.stale-999999989-5678abcd`].sort(),
    'a live start and a lock whose holder lives are left alone',
  )
})

test('a start whose lock was taken over never removes the new holder\'s lock', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  const lock = join(fresh, launch.PACKAGES_LOCK_DIR)
  const copyDir = (from: string, to: string) => {
    // While this start copies, another one decides it is gone and takes the folder.
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 4243, at: Date.now(), token: 'the-new-holder' }))
    for (const pkg of FULL_SET) writePackage(to, pkg)
  }
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep, copyDir })
  assert.equal(result.status, 'copied')
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, 'the-new-holder', 'their lock stands')
})

test('on Windows a rename that the virus scanner briefly blocks is tried again', async (t) => {
  const parent = scratch(t)
  versionFolder(parent, '0.89.0', { packages: FULL_SET })
  const fresh = versionFolder(parent, '0.90.0')
  let blocked = 0
  // Only the copy's own rename into place is blocked: the lock's rename is not what this is about.
  const rename = (from: string, to: string) => {
    if (basename(from).startsWith('.bgos-node_modules.partial') && blocked < 2) {
      blocked++
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
    }
    renameSync(from, to)
  }
  const result = await launch.ensureServerPackages({ serverDir: fresh, bunPath: null, env: {}, runInstall: fakeInstall().runInstall, sleep: noSleep, rename })
  assert.equal(result.status, 'copied')
  assert.equal(blocked, 2)
  assert.deepEqual(launch.missingPackages(fresh), [])
})

// ── main wiring ──────────────────────────────────────────────────────────────

class FakeChild {
  handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  on(event: string, fn: (...a: unknown[]) => void) {
    ;(this.handlers[event] ??= []).push(fn)
    return this
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers[event] ?? []) fn(...args)
  }
  kill() {
    return true
  }
}

test('main: packages that cannot be fixed end the launch with the plain line and the distinct code, and bun never spawns', { timeout: 30_000 }, async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  let spawned = 0
  let err = ''
  const code = await launch.main([join(fresh, 'server.ts')], {
    env: { PATH: '/usr/bin' },
    home: '/home/example',
    platform: process.platform,
    exists: () => true,
    spawnSyncImpl: (() => ({ stderr: '' })) as never,
    spawnImpl: (() => {
      spawned++
      const child = new FakeChild()
      setImmediate(() => child.emit('exit', 0, null))
      return child
    }) as never,
    writeErr: (text: string) => void (err += text),
    onSignal: () => {},
    packages: { runInstall: fakeInstall().runInstall, sleep: noSleep },
  })
  assert.equal(code, launch.LAUNCH_EXIT_PACKAGES_MISSING)
  assert.equal(spawned, 0)
  assert.equal(err.split('\n').filter(Boolean).length, 1, err)
})

test('main: a check that throws never stops a start that might have worked', { timeout: 30_000 }, async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const child = new FakeChild()
  let err = ''
  const done = launch.main([join(fresh, 'server.ts')], {
    env: { PATH: '/usr/bin' },
    home: '/home/example',
    platform: process.platform,
    exists: () => true,
    spawnSyncImpl: (() => ({ stderr: '' })) as never,
    spawnImpl: (() => {
      setImmediate(() => child.emit('exit', 0, null))
      return child
    }) as never,
    writeErr: (text: string) => void (err += text),
    onSignal: () => {},
    packages: {
      runInstall: fakeInstall().runInstall,
      sleep: noSleep,
      copyDir: () => {},
      siblings: () => {
        throw new Error('boom')
      },
    },
  })
  assert.equal(await done, 0)
  assert.match(err, /start check failed: boom; starting anyway/)
})

test('main: a check that could not help (no bun to install with) starts bun anyway, with one line', { timeout: 30_000 }, async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const child = new FakeChild()
  let spawned = 0
  let err = ''
  const code = await launch.main([join(fresh, 'server.ts')], {
    env: { PATH: '/usr/bin' },
    home: '/home/example',
    platform: process.platform,
    exists: (p: string) => p.includes('bunx'),
    spawnSyncImpl: (() => ({ stderr: '' })) as never,
    spawnImpl: (() => {
      spawned++
      setImmediate(() => child.emit('exit', 0, null))
      return child
    }) as never,
    writeErr: (text: string) => void (err += text),
    onSignal: () => {},
    packages: { runInstall: fakeInstall().runInstall, sleep: noSleep },
  })
  assert.equal(code, 0)
  assert.equal(spawned, 1)
  assert.match(err, /only bunx was found.*starting anyway/)
})

test('main: a spawn that throws after the check reaches the caller, never an unhandled rejection', { timeout: 30_000 }, async (t) => {
  const parent = scratch(t)
  const fresh = versionFolder(parent, '0.90.0')
  const install = fakeInstall((cwd) => {
    for (const pkg of FULL_SET) writePackage(join(cwd, 'node_modules'), pkg)
    return { code: 0 }
  })
  await assert.rejects(
    launch.main([join(fresh, 'server.ts')], {
      env: { PATH: '/usr/bin' },
      home: '/home/example',
      platform: process.platform,
      exists: () => true,
      spawnSyncImpl: (() => ({ stderr: '' })) as never,
      spawnImpl: (() => {
        throw new Error('spawn EINVAL')
      }) as never,
      writeErr: () => {},
      onSignal: () => {},
      packages: { runInstall: install.runInstall, sleep: noSleep },
    }),
    /spawn EINVAL/,
  )
})

test('main: a wrapper argv (no server.ts) runs no check at all', { timeout: 30_000 }, async () => {
  const child = new FakeChild()
  let checks = 0
  const done = launch.main(['/opt/plugin/wrapper.mjs'], {
    env: { PATH: '/usr/bin' },
    home: '/home/example',
    platform: process.platform,
    exists: () => true,
    spawnSyncImpl: (() => ({ stderr: '' })) as never,
    spawnImpl: (() => {
      setImmediate(() => child.emit('exit', 0, null))
      return child
    }) as never,
    writeErr: () => {},
    onSignal: () => {},
    packages: {
      runInstall: () => {
        checks++
        return { pid: 1, done: Promise.resolve({ code: 1, signal: null }), unref: () => {} }
      },
      sleep: noSleep,
    },
  })
  assert.equal(await done, 0)
  assert.equal(checks, 0)
})

test('the launcher stays builtins only: its static imports are node: modules and the one plain lib it already had', () => {
  const source = readFileSync(LAUNCHER, 'utf8')
  const specs = [...source.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  for (const spec of specs) assert.ok(spec.startsWith('node:') || spec === '../lib/browser-profile-node-runtime.mjs', spec)
  assert.ok(statSync(LAUNCHER).size > 0)
})
