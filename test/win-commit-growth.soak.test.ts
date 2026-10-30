/**
 * The Windows commit growth soak (board rows a8646712 and dc37e2ac).
 *
 * On Windows, bun 1.3 leaks every thread that exits: its handle stays open and
 * about 0.3 MB of committed memory stays with it. JavaScriptCore starts garbage
 * collector helpers and JIT compiler threads when there is work and lets them
 * exit a few seconds later, so a daemon that collects every so often made and
 * lost threads all day. Each agent's daemon grew 100 to 330 MB of committed
 * memory an hour while its working set stayed flat, until a PC with seven
 * agents reached 98% commit and jobs were killed. bin/bgos-launch.mjs now
 * starts bun with both pools switched off (WIN32_JSC_THREAD_OPTIONS).
 *
 * This file starts the daemon exactly as Claude Code does, `node
 * bin/bgos-launch.mjs server.ts`, against a stand in backend (http and
 * socket.io on 127.0.0.1) with a scratch HOME and no credential file, and paces
 * a full collection every 12 s (test/fixtures/gc-pacer.mjs, preloaded through
 * BUN_OPTIONS): sparse enough for the helper threads to go idle and exit in
 * between, which is what an idle daemon does on its own, only faster. After a
 * warm-up it samples the daemon's committed memory (PagedMemorySize64) and
 * handle count every 15 s and fits a line through each. Each lost thread
 * leaves its handle behind, so the handle count is the slope that tells the
 * two apart inside 12 minutes: on main 233 to 301 (357 an hour), with the
 * launcher change 202 to 202. The memory those threads keep, a few dozen MB in
 * 12 minutes, hides in the noise of so short a run, which is why the leak took
 * hours to show; the committed memory limit is a guard, not the separator.
 *
 * Windows only, and opt in (HOAI_SOAK=1): it runs about 16 minutes, never more
 * than 20. It only ever stops the bun it started: by that pid, and only while
 * the pid still names the process it found (the same creation time).
 *
 * Run: HOAI_SOAK=1 npx tsx --test test/win-commit-growth.soak.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

const ROOT = join(import.meta.dirname, '..')
const SKIP = process.platform !== 'win32' ? 'Windows only' : process.env.HOAI_SOAK === '1' ? false : 'opt in: HOAI_SOAK=1'

const ASSISTANT_ID = 4242
const WARM_UP_MS = 3 * 60_000
const MEASURE_MS = 12 * 60_000
const SAMPLE_MS = 15_000
/** A guard: with the fix this slope is flat, and no daemon may grow like before. */
const MAX_COMMIT_MB_PER_HOUR = 150
/**
 * On main this daemon lost about 350 thread handles an hour with the 12 s pacer (177 to 360
 * across all runs); with the fix, none. 150 leaves room on both sides: over 12 minutes a
 * lasting step of about 20 handles would read as 150 an hour.
 */
const MAX_HANDLES_PER_HOUR = 150

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function powershell(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (_err, stdout) =>
      resolve(String(stdout ?? '').trim()),
    )
  })
}

type Proc = { pid: number; created: string }

/** The one bun.exe whose parent is `parentPid`, with its creation time; null when there is none. */
async function bunChild(parentPid: number): Promise<Proc | null> {
  const out = await powershell(
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid} AND Name='bun.exe'") | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToString('o') }`,
  )
  const match = /^(\d+) (\S+)$/.exec(out)
  return match ? { pid: Number(match[1]), created: match[2] } : null
}

/**
 * The bun.exe the launcher started: found by its parent, never by name alone. A bun that
 * is a shim (scoop's starts the real one) has the daemon as its own bun child.
 */
async function bunChildOf(launcherPid: number, waitMs: number): Promise<Proc> {
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    const child = await bunChild(launcherPid)
    if (child) return (await bunChild(child.pid)) ?? child
    await sleep(500)
  }
  throw new Error(`the launcher (pid ${launcherPid}) started no bun.exe`)
}

/** Stops `proc` only while its pid still names that process: a pid Windows gave to another is left alone. */
async function stopIfStillOurs(proc: Proc): Promise<void> {
  const created = await powershell(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${proc.pid}"; if ($p) { $p.CreationDate.ToString('o') }`,
  )
  if (created !== proc.created) return
  try {
    process.kill(proc.pid)
  } catch {
    // Gone in between.
  }
}

async function sample(pid: number): Promise<{ commit: number; handles: number } | null> {
  const out = await powershell(
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { "{0},{1}" -f $p.PagedMemorySize64, $p.HandleCount }`,
  )
  const [commit, handles] = out.split(',').map(Number)
  return Number.isFinite(commit) && Number.isFinite(handles) ? { commit, handles } : null
}

/** Least squares slope of y over x. */
function slope(points: Array<[number, number]>): number {
  const n = points.length
  const mx = points.reduce((a, [x]) => a + x, 0) / n
  const my = points.reduce((a, [, y]) => a + y, 0) / n
  let num = 0
  let den = 0
  for (const [x, y] of points) {
    num += (x - mx) * (y - my)
    den += (x - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

/** The stand in backend: the smallest answers the daemon accepts, on a port in 43000 to 48999. */
async function startBackend(): Promise<{ url: string; close: () => Promise<void> }> {
  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/api\/v1\//, '')
    req.resume()
    if (req.method !== 'GET') return json(res, { ok: true })
    if (path === 'peers/inbox') return json(res, { chats: [{ id: 9001, assistantId: ASSISTANT_ID, kind: 'main', userId: 'soak-user' }] })
    if (/^chats\/\d+\/messages$/.test(path)) return json(res, { messages: [] })
    if (path === 'meetings' || path === 'renderables') return json(res, [])
    if (path === `assistants/${ASSISTANT_ID}`) return json(res, { id: ASSISTANT_ID, code: 'claude-code', alwaysOn: false })
    return json(res, {})
  })
  const io = new SocketServer(http)
  for (let attempt = 0; ; attempt++) {
    const port = 43000 + Math.floor(Math.random() * 6000)
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject)
        http.listen(port, '127.0.0.1', () => {
          http.off('error', reject)
          resolve()
        })
      })
      return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => io.close(() => r())) }
    } catch (err) {
      if (attempt >= 20) throw err
    }
  }
}

test('the Windows daemon started by the launcher keeps its committed memory and handles flat', { skip: SKIP, timeout: 20 * 60_000 }, async () => {
  const backend = await startBackend()
  const scratch = mkdtempSync(join(tmpdir(), 'hoai-soak-'))
  const home = join(scratch, 'home')
  const folder = join(home, 'agent')
  for (const dir of [folder, join(home, '.bgos-agent', String(ASSISTANT_ID)), join(home, '.claude'), join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) {
    mkdirSync(dir, { recursive: true })
  }
  const stderr: string[] = []
  // Only what the daemon needs (the SDK adds its usual few, like USERNAME), and
  // nothing that names a runtime option: the launcher decides those, which is
  // what this file measures.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
    ...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    BGOS_BACKEND_URL: backend.url,
    BGOS_PAIRING_TOKEN: 'soak-token-not-real',
    BGOS_USER_ID: 'soak-user',
    BGOS_ASSISTANT_ID: String(ASSISTANT_ID),
    BGOS_LAUNCH_CWD: folder,
    BGOS_BOOT_HELLO: 'off',
    BGOS_AUTO_UPDATE: 'off',
    HOAI_BROWSER_HOST: 'off',
    HOAI_SERVICE_NAMESPACE: 'hoaisoak',
    BUN_OPTIONS: `--preload ${join(ROOT, 'test', 'fixtures', 'gc-pacer.mjs').replace(/\\/g, '/')}`,
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'bin', 'bgos-launch.mjs'), join(ROOT, 'server.ts')],
    cwd: folder,
    env,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) stderr.push(line)
  })
  const client = new Client({ name: 'soak', version: '0.0.0' }, { capabilities: {} })
  let daemon: Proc | null = null
  try {
    await client.connect(transport)
    await client.listTools()
    daemon = await bunChildOf(transport.pid!, 30_000)
    const armedBy = Date.now() + 60_000
    while (!stderr.some((l) => l.includes('startup complete: polling armed'))) {
      if (Date.now() > armedBy) throw new Error(`the daemon never armed; stderr tail:\n${stderr.slice(-20).join('\n')}`)
      await sleep(250)
    }
    await sleep(WARM_UP_MS)
    const commit: Array<[number, number]> = []
    const handles: Array<[number, number]> = []
    const t0 = Date.now()
    while (Date.now() - t0 <= MEASURE_MS) {
      const s = await sample(daemon.pid)
      assert.ok(s, 'the daemon must stay up for the whole soak')
      const hours = (Date.now() - t0) / 3_600_000
      commit.push([hours, s.commit / 1024 / 1024])
      handles.push([hours, s.handles])
      await sleep(SAMPLE_MS)
    }
    const commitMbPerHour = Math.round(slope(commit))
    const handlesPerHour = Math.round(slope(handles))
    const first = commit[0][1]
    const last = commit[commit.length - 1][1]
    console.log(
      `[soak] ${commit.length} samples: commit ${Math.round(first)} to ${Math.round(last)} MB, ` +
        `${commitMbPerHour} MB an hour; handles ${handles[0][1]} to ${handles[handles.length - 1][1]}, ${handlesPerHour} an hour`,
    )
    assert.ok(commitMbPerHour < MAX_COMMIT_MB_PER_HOUR, `committed memory grows ${commitMbPerHour} MB an hour (limit ${MAX_COMMIT_MB_PER_HOUR})`)
    assert.ok(handlesPerHour < MAX_HANDLES_PER_HOUR, `handles grow ${handlesPerHour} an hour (limit ${MAX_HANDLES_PER_HOUR})`)
  } finally {
    // A start that failed before the daemon was found still leaves its bun to stop: look while
    // the launcher is up, since closing the transport ends the launcher but not always its child.
    if (!daemon && transport.pid) daemon = await bunChildOf(transport.pid, 2_000).catch(() => null)
    await client.close().catch(() => {})
    if (daemon) {
      // It usually ends with its stdin; only one still running is stopped.
      await sleep(3_000)
      await stopIfStillOurs(daemon)
    }
    await backend.close()
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    } catch (err) {
      // Never in place of the soak's own result.
      console.log(`[soak] scratch ${scratch} left behind: ${String(err)}`)
    }
  }
})
