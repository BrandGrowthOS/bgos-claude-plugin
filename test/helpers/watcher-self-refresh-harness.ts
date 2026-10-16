/**
 * The harness of test/watcher-self-refresh.test.ts: an in-memory home with a real
 * installed_plugins.json, the real loop (runWatcher) run once over it, and the real files run of
 * this checkout's own bundle. A module of its own so test/watcher-real-os.guard.test.ts can drive
 * the very same deps through the self-refresh failure path without running that file's tests.
 */

import { join } from 'node:path'

import { runWatcher } from '../../lib/watcher-core.mjs'
import { WATCHER_BUNDLE_FILES, installWatcherBundle, nodeExec, nodeFs } from '../../lib/watcher-bundle.mjs'
import { observeMarketplaceInstall } from '../../lib/plugin-cli.mjs'
import { memoryFs, type MemoryFs } from './memory-fs.ts'

export const T0 = Date.parse('2026-10-11T08:00:00.000Z')
export const MINUTE = 60_000
export const TOKEN = 'bgp_' + 'S3cretPairingTokenValue0123456789'
export const MACHINE_ID = '0f3b3c1e-7d3a-4d0c-9a4c-1f2e3d4c5b6a'

export type Layout = { name: string; platform: 'linux' | 'win32'; home: string; sep: string; node: string }
export const POSIX: Layout = { name: 'posix', platform: 'linux', home: '/home/kc', sep: '/', node: '/usr/local/bin/node' }
export const WINDOWS: Layout = { name: 'windows', platform: 'win32', home: 'C:\\Users\\kc', sep: '\\', node: 'C:\\Program Files\\nodejs\\node.exe' }

export const at = (L: Layout, ...parts: string[]) => parts.join(L.sep)
export const configDir = (L: Layout) => at(L, L.home, '.claude')
export const cacheRoot = (L: Layout, version: string, config = configDir(L)) => at(L, config, 'plugins', 'cache', 'hoai', 'hoai', version)
export const watcherDir = (L: Layout) => at(L, L.home, '.bgos-agent', 'watcher')
export const liveEntry = (L: Layout) => at(L, watcherDir(L), 'bin', 'hoai-watcher.mjs')
export const stagedEntry = (L: Layout) => at(L, watcherDir(L), 'next', 'bin', 'hoai-watcher.mjs')

/** A plugin root whose every bundle file says which version it is (no imports, so the closure is the list). */
export function writeRoot(fs: MemoryFs, L: Layout, root: string, version: string) {
  for (const rel of WATCHER_BUNDLE_FILES) fs.writeFile(at(L, root, ...rel.split('/')), `// ${rel} ${version}\n`)
  fs.writeFile(at(L, root, 'package.json'), JSON.stringify({ name: 'claude-channel-bgos', version }))
}

/** installed_plugins.json as Claude Code writes it (version 2, an array of installs per id). */
export function writeInstalled(fs: MemoryFs, L: Layout, root: string, version: string, config = configDir(L)) {
  fs.writeFile(
    at(L, config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'hoai@hoai': [{ scope: 'user', installPath: root, version, installedAt: '2026-10-09T10:00:00.000Z', lastUpdated: '2026-10-09T10:00:00.000Z' }] },
    }),
  )
}

/**
 * The AlienAres shape: the live bundle was installed from the 0.61.1 cache folder, that
 * folder is still on disk and unchanged, and installed_plugins.json names 0.63.2.
 */
/** The watcher's own systemd cgroup (cgroup v2), holding `pids`. */
const CGROUP = '/user.slice/user-1000.slice/user@1000.service/app.slice/bgos-watcher.service'
export function writeCgroup(fs: MemoryFs, pids: number[]) {
  fs.writeFile('/proc/self/cgroup', `0::${CGROUP}\n`)
  fs.writeFile(`/sys/fs/cgroup${CGROUP}/cgroup.procs`, pids.map((p) => `${p}\n`).join(''))
}

export async function staleMachine(L: Layout, opts: { installed?: string; vbs?: boolean; claudeConfigDir?: string; cgroup?: number[] | null } = {}) {
  const fs = memoryFs()
  const config = opts.claudeConfigDir ?? configDir(L)
  const oldRoot = cacheRoot(L, '0.61.1', config)
  writeRoot(fs, L, oldRoot, '0.61.1')
  await installWatcherBundle({ pluginRoot: oldRoot, home: L.home, fs, now: () => T0 - 6 * 24 * 60 * MINUTE, claudeConfigDir: opts.claudeConfigDir ?? null })
  fs.writeFile(at(L, watcherDir(L), 'credentials.json'), JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test', machineId: MACHINE_ID }))
  if (opts.vbs !== false) fs.writeFile(at(L, watcherDir(L), 'run-hidden.vbs'), "' launcher\r\n")
  // On Linux the service watcher runs alone in its systemd cgroup unless a test says otherwise.
  if (L.platform === 'linux' && opts.cgroup !== null) writeCgroup(fs, opts.cgroup ?? [process.pid])
  const installed = opts.installed ?? '0.63.2'
  const newRoot = cacheRoot(L, installed, config)
  writeRoot(fs, L, newRoot, installed)
  writeInstalled(fs, L, newRoot, installed, config)
  return { fs, oldRoot, newRoot }
}

export function fakeBackend(opts: { frames?: any[]; jobs?: Record<string, any> } = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = []
  let served = false
  const respond = (status: number, json: any) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) })
  const fetch = async (url: string, init: any) => {
    const u = new URL(url)
    const path = u.pathname + u.search
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : undefined })
    if (path.includes('/machine-rpc/pending')) {
      if (served) return respond(200, { frames: [] })
      served = true
      return respond(200, { frames: opts.frames ?? [] })
    }
    const m = /\/machine-rpc\/([^/]+)$/.exec(u.pathname)
    if (m && init?.method === 'GET') return respond(200, opts.jobs?.[decodeURIComponent(m[1]!)] ?? {})
    return respond(200, {})
  }
  const beats = () => calls.filter((c) => c.path.endsWith('/integrations/heartbeat')).map((c) => c.body)
  return { calls, fetch, beats }
}

/** One watcher process over `fs`: the real loop, once, with the lifecycle modules a job would use stubbed. */
export function watcherRun(L: Layout, fs: MemoryFs, opts: { now?: number; probeCode?: number; backend?: ReturnType<typeof fakeBackend>; modules?: Record<string, unknown>; spawnPid?: number | null } = {}) {
  let nowMs = opts.now ?? T0
  const execs: Array<{ file: string; args: string[] }> = []
  const spawns: Array<{ file: string; args: string[] }> = []
  const logs: string[] = []
  const backend = opts.backend ?? fakeBackend()
  const deps = {
    home: L.home,
    env: { USER: 'kc' } as Record<string, string | undefined>,
    platform: L.platform,
    fetch: backend.fetch,
    fs,
    exec: async (file: string, args: readonly string[]) => {
      execs.push({ file, args: [...args] })
      const probe = args[args.length - 1] === 'help'
      return { code: probe ? opts.probeCode ?? 0 : 0, stdout: '', stderr: '', error: null, timedOut: false }
    },
    spawnDetached: (file: string, args: readonly string[]) => {
      spawns.push({ file, args: [...args] })
      return { pid: opts.spawnPid === undefined ? 4343 : opts.spawnPid }
    },
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms
    },
    once: true,
    nodePath: L.node,
    uid: 501,
    username: 'kc',
    pidAlive: () => false,
    execSync: () => ({ code: 1, stdout: '' }),
    hasTmux: false,
    hasScript: false,
    echo: (line: string) => logs.push(line),
    keepAliveSweep: async () => ({ enabled: false, agents: [] }),
    modules: {
      planMachine: () => ({ verdict: 'nothing_to_do', targetVersion: null, steps: [] }),
      executePlan: async () => {
        throw new Error('no job in this test')
      },
      observeMarketplaceInstall,
      runClaudeCli: async () => ({ code: 1, stdout: '', stderr: 'no cli in this test', timedOut: false }),
      buildFailureDiagnostics: () => ({}),
      postFailureDiagnostics: async () => true,
      ...opts.modules,
    },
  }
  return {
    run: () => runWatcher(deps as any),
    execs,
    spawns,
    logs,
    backend,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

export const probesOf = (execs: Array<{ file: string; args: string[] }>) => execs.filter((e) => e.args[e.args.length - 1] === 'help')
export const stateOf = (L: Layout, fs: MemoryFs) => JSON.parse(fs.readFile(at(L, watcherDir(L), 'state.json')) ?? '{}')

/**
 * The real files run: an old bundle installed from the checkout at `repo` as a clone (its manifest
 * names the checkout) under `base`/home, and the real loop run once over the real filesystem, the
 * staged copy probed by the real exec under this node.
 */
export async function realFilesRun(repo: string, base: string) {
  const home = join(base, 'home')
  const live = join(home, '.bgos-agent', 'watcher')
  const fs = nodeFs()
  // An old bundle installed from this checkout as a clone: its manifest names the checkout.
  fs.writeFile(join(live, 'bin', 'hoai-watcher.mjs'), '// an old entry\n')
  fs.writeFile(join(live, 'manifest.json'), JSON.stringify({ version: '0.61.1', fingerprint: 'old', installedAt: 'x', pluginRoot: repo, files: ['bin/hoai-watcher.mjs'] }))
  fs.writeFile(join(live, 'credentials.json'), JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test', machineId: MACHINE_ID }))
  fs.writeFile(join(live, 'run-hidden.vbs'), "' launcher\r\n")
  const spawns: string[] = []
  const execs: string[][] = []
  const realExec = nodeExec()
  // Linux is told it is darwin here: the cgroup guard would read this test runner's own cgroup.
  const platform = process.platform === 'win32' ? 'win32' : 'darwin'
  const code = await runWatcher({
    home,
    env: { USER: 'kc' },
    platform,
    fetch: fakeBackend().fetch as any,
    fs,
    exec: (file: string, args: readonly string[], opts?: any) => {
      execs.push([file, ...args])
      return realExec(file, args, opts)
    },
    spawnDetached: (file: string) => {
      spawns.push(file)
      return { pid: 4343 }
    },
    now: () => T0,
    sleep: async () => {},
    once: true,
    nodePath: process.execPath,
    uid: 501,
    username: 'kc',
    pidAlive: () => false,
    execSync: () => ({ code: 1, stdout: '' }),
    hasTmux: false,
    hasScript: false,
    keepAliveSweep: async () => ({ enabled: false, agents: [] }),
    modules: { planMachine: () => ({ verdict: 'nothing_to_do', steps: [] }), executePlan: async () => ({}), observeMarketplaceInstall, runClaudeCli: async () => ({ code: 1 }) },
  } as any)
  return { code, platform, live, execs, spawns }
}
