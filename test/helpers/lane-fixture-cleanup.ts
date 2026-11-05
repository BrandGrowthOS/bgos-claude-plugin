import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { processStamp } from '../../lib/lane-process.ts'

/** End the fixture's descendants, including detached children, before removing its home. */
export async function cleanupLaneFixture(dir: string, rootPid?: number): Promise<void> {
  if (rootPid) {
    const rows = await new Promise<number[][]>((done, reject) => execFile('ps', ['-A', '-o', 'pid=,ppid='],
      { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
        if (error) { reject(error); return }
        done(stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number)))
      }))
    const owned = [rootPid]
    for (let i = 0; i < owned.length; i++) {
      for (const [pid, parent] of rows) {
        if (parent === owned[i] && pid > 1 && !owned.includes(pid)) owned.push(pid)
      }
    }
    const stamps = await Promise.all(owned.map(async (pid) => ({ pid, stamp: await processStamp(pid) })))
    const signal = async (kind: 'SIGTERM' | 'SIGKILL') => {
      for (const { pid, stamp } of stamps.slice().reverse()) {
        if (!stamp || await processStamp(pid) !== stamp) continue
        try { process.kill(pid, kind) } catch { /* already exited */ }
      }
    }
    await signal('SIGTERM')
    const deadline = Date.now() + 1_000
    let alive = stamps
    while (alive.length && Date.now() < deadline) {
      alive = (await Promise.all(alive.map(async (entry) =>
        entry.stamp && await processStamp(entry.pid) === entry.stamp ? entry : null))).filter((entry) => entry !== null)
      if (alive.length) await new Promise((done) => setTimeout(done, 25))
    }
    await signal('SIGKILL')
  }
  // CLI logs can finish a write after their parent exits. Bounded native
  // retries handle ENOTEMPTY without masking a test assertion in finally.
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
