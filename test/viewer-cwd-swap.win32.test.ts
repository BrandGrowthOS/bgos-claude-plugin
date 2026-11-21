/**
 * viewercwd on a REAL Windows file system and process table (runs in the Windows CI job only).
 *
 * The cause, proven on a Windows agent PC: Windows refuses to rename a folder that is any process's
 * working folder. Viewers opened by 0.90.21 and older ran in <watcher>\bin, so the bundle swap's
 * first move (bin to prev\bin) failed with EBUSY at every hourly self refresh while one was open.
 *
 * Here a real child process stands in for such a viewer: a node that idles with its working folder
 * in bin and the viewer's command line shape (this bundle's hoai-agent-viewer.ps1, -ConsolePid,
 * -AssistantId). A second child, which the "watcher" did not start, works elsewhere. The test shows
 *   1. the real swap fails while the stand-in holds bin (the cause, on this machine),
 *   2. closeViewersForSwap closes the stand-in by its pid, after a real process listing, and leaves
 *      the other child running,
 *   3. the real swap then goes through.
 * Only the two children this test starts are ever signalled.
 *
 * Run (Windows): npx tsx --test test/viewer-cwd-swap.win32.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VIEWER_SCRIPT_FILE_NAME, closeViewersForSwap } from '../lib/agent-windows.mjs'
import { emptyViewerMemory } from '../lib/agent-windows-plan.mjs'
import { listProcesses } from '../lib/process-tree.mjs'
import { nodeExec, nodeFs, swapStagedBundle } from '../lib/watcher-bundle.mjs'

const IDLE = 'setInterval(() => {}, 1000)'

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** End a child this test started and wait for its exit event (or `ms`), so Windows has let go of its working folder. */
async function endChild(child: ChildProcess, ms: number) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    child.kill()
  } catch {
    // already gone
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, ms).unref())])
}

async function until(check: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

test(
  'REAL Windows: a viewer working in bin blocks the swap; closed by pid before it, the swap goes through, and the process the watcher did not start runs on',
  { skip: process.platform !== 'win32' ? 'Windows only' : false, timeout: 120_000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), 'hoai-viewercwd-'))
    const home = join(base, 'home')
    const live = join(home, '.bgos-agent', 'watcher')
    const bin = join(live, 'bin')
    const fs = nodeFs()
    for (const dir of ['', 'next']) {
      const root = dir ? join(live, dir) : live
      const tag = dir ? 'v2' : 'v1'
      fs.writeFile(join(root, 'bin', 'hoai-watcher.mjs'), `// ${tag}\n`)
      fs.writeFile(join(root, 'lib', 'watcher-core.mjs'), `// ${tag}\n`)
      fs.writeFile(join(root, 'manifest.json'), JSON.stringify({ version: tag === 'v1' ? '0.90.16' : '0.90.22', fingerprint: tag }))
    }
    const children: ChildProcess[] = []
    try {
      const viewer = spawn(process.execPath, ['-e', IDLE, '--', '-File', join(bin, VIEWER_SCRIPT_FILE_NAME), '-ConsolePid', '1', '-AssistantId', '912'], { cwd: bin, stdio: 'ignore', windowsHide: true })
      const person = spawn(process.execPath, ['-e', IDLE], { cwd: base, stdio: 'ignore', windowsHide: true })
      children.push(viewer, person)
      assert.ok(viewer.pid && person.pid)

      // The real process table names the stand-in with its start time (as the windows pass records it).
      let row: { pid: number; startedAtMs: number | null; command: string } | undefined
      assert.ok(
        await until(async () => {
          const table = await listProcesses({ platform: 'win32', exec: nodeExec(), env: process.env })
          row = table.ok ? table.processes.find((p: { pid: number }) => p.pid === viewer.pid) : undefined
          return Boolean(row && row.command.includes(VIEWER_SCRIPT_FILE_NAME))
        }, 30_000),
        'the stand-in viewer is listed',
      )
      assert.equal(typeof row!.startedAtMs, 'number')

      // 1. The cause: while it works in bin, the move of bin is refused (no wait between the retries here).
      const blocked = await swapStagedBundle({ home, fs, sleep: async () => {} })
      assert.equal(blocked.ok, false, 'Windows refused to move bin while a process works in it')
      assert.match(blocked.message, /EBUSY|EPERM/)
      assert.equal(fs.readFile(join(bin, 'hoai-watcher.mjs')), '// v1\n', 'the live bundle is intact')

      // 2. Closed by pid, after a real listing; only the known viewer of this bundle.
      const memory = { ...emptyViewerMemory(), viewerPids: [{ pid: viewer.pid!, startedAtMs: row!.startedAtMs!, id: '912' }, { pid: person.pid!, startedAtMs: row!.startedAtMs!, id: '7' }] }
      const out = await closeViewersForSwap({ platform: 'win32', env: process.env, exec: nodeExec(), kill: (pid: number, signal: string) => process.kill(pid, signal as NodeJS.Signals), log: () => {}, viewerDir: bin, memory } as any)
      assert.deepEqual(out.closed, [{ pid: viewer.pid, id: '912' }])
      assert.ok(await until(() => !alive(viewer.pid!), 10_000), 'the stand-in viewer ended')

      // 3. The real swap, with its real retry wait, goes through.
      const swapped = await swapStagedBundle({ home, fs })
      assert.deepEqual(swapped, { ok: true, swapped: ['bin', 'lib', 'manifest.json'], message: 'swapped' })
      assert.equal(fs.readFile(join(bin, 'hoai-watcher.mjs')), '// v2\n')
      assert.equal(alive(person.pid!), true, 'the process the watcher did not start runs on')
    } finally {
      // Cleanup only: it never decides the test. A sync remove right after the kill hit EPERM on a
      // real Windows PC, before Windows had let go of the children's working folders, and that
      // error replaced the assertions' own result. So each child's exit event is awaited, then the
      // folder is removed with retries, and a folder Windows still holds is left in the temp dir.
      await Promise.all(children.map((child) => endChild(child, 10_000)))
      try {
        await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
      } catch (err) {
        console.error(`viewercwd test: temp folder ${base} not removed (${(err as Error).message}); left for the OS to clear`)
      }
    }
  },
)
