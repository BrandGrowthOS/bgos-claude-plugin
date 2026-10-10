/**
 * The exit path's guarantee, proven on the runtime the daemon actually runs on
 * (bun server.ts). An exit site sends its stand-down report from a child and
 * BLOCKS on it (lib/stand-down-report.ts reportSync), so nothing else in the
 * daemon runs between the fault and the exit: no timer, no socket frame, no
 * poll or arm continuation. test/stand-down-report.test.ts proves it under
 * node; this file is in the bun family (scripts/run-tests.mjs), so the parent
 * here is bun and the child is `bun -e`.
 *
 * Run with: bun test test/stand-down-bun.test.ts
 */
import { afterAll, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createStandDownReporter } from '../lib/stand-down-report'

const children: Array<() => void> = []
afterAll(() => children.forEach((close) => close()))

async function backend(mode: string): Promise<{ url: string; captured: () => Promise<Array<{ body: Record<string, unknown> }>> }> {
  const fixture = fileURLToPath(new URL('./fixtures/stand-down-backend.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixture, mode], { stdio: ['pipe', 'pipe', 'inherit'] })
  children.push(() => {
    try {
      child.stdin!.end()
      child.kill()
    } catch {}
  })
  const port = await new Promise<string>((resolve) => {
    let out = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (c: string) => {
      out += c
      if (out.includes('\n')) resolve(out.trim())
    })
  })
  const url = `http://127.0.0.1:${port}`
  return { url, captured: async () => (await (await fetch(`${url}/captured`)).json()) as Array<{ body: Record<string, unknown> }> }
}

function reporter(url: string, logs: string[]) {
  return createStandDownReporter({
    credentials: () => ({ backendUrl: url, pairingToken: 'pair_BUN_SECRET' }),
    route: 'folder-pin',
    machineId: () => 'aaaabbbb-cccc-4ddd-8eee-ffff00001111',
    pluginVersion: () => '0.65.3',
    log: (line) => void logs.push(line),
  })
}

test('under bun, an exit report is in before the call returns and the event loop never turns meanwhile', async () => {
  expect(typeof process.versions.bun).toBe('string')
  const b = await backend('validate')
  const logs: string[] = []
  let ticked = false
  setTimeout(() => (ticked = true), 0)
  reporter(b.url, logs).reportSync('exit_uncaught', 'run')
  const turned = ticked
  const logsAtReturn = [...logs]
  expect(turned).toBe(false)
  expect(logsAtReturn).toEqual(['stand-down exit_uncaught (run) reported (HTTP 204)'])
  const got = await b.captured()
  expect(got.length).toBe(1)
  expect(got[0].body.reason).toBe('exit_uncaught')
})

test('under bun, a backend that never answers holds the exit 2 s at most, and the loop still never turns', async () => {
  const b = await backend('hang')
  const logs: string[] = []
  let ticked = false
  setTimeout(() => (ticked = true), 0)
  const started = Date.now()
  reporter(b.url, logs).reportSync('exit_boot_fatal', 'boot')
  const took = Date.now() - started
  expect(ticked).toBe(false)
  expect(took).toBeGreaterThanOrEqual(1500)
  expect(took).toBeLessThan(2800)
  expect(logs).toEqual(['stand-down exit_boot_fatal (boot) got no answer within 2000 ms, not retried'])
})
