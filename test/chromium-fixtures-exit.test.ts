/**
 * A real Chromium test whose browser cannot start must fail and then END (board row 0b78f6a2).
 *
 * remote-browser-controls.chromium's fixture listened on a local http server, then started the
 * browser, and only then registered the hook that closes the server. When the start threw (no
 * browser, a profile folder the vault refuses, Chrome refusing remote debugging), every test failed
 * in under a second and the file's process never exited: seven listening servers kept it alive
 * (process._getActiveHandles() on AlienAres), and --test-timeout does not end a file whose tests
 * have all finished. agent-browser-vault.chromium and remote-credentials.chromium registered the
 * hook in time, but closed the servers only after engine.stop(), which can throw after a failed
 * start (on Windows it hit EPERM removing a runtime folder Chrome had not yet let go of).
 *
 * Each file runs on its own, without the test runner, so a file that hangs is the one process the
 * timeout kills, with a browser that does not exist, so every start fails on every host.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const missingBrowser = join(mkdtempSync(join(tmpdir(), 'no-browser-')), process.platform === 'win32' ? 'chrome.exe' : 'chrome')

function runAlone(file: string): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join('test', file)], {
      cwd: repoRoot,
      env: { ...process.env, HOAI_BROWSER_EXECUTABLE: missingBrowser },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 120_000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, output }) })
  })
}

for (const file of ['remote-browser-controls.chromium.test.ts', 'agent-browser-vault.chromium.test.ts', 'remote-credentials.chromium.test.ts']) {
  test(`${file}: with a browser that cannot start, every test fails and the process exits`, { timeout: 150_000 }, async () => {
    const { code, timedOut, output } = await runAlone(file)
    assert.equal(timedOut, false, `${file} was still running 120 s after it started: something it opened outlived its tests\n${output.slice(-2000)}`)
    assert.equal(code, 1, output.slice(-2000))
    assert.match(output, /\bpass 0\b/, output.slice(-2000))
  })
}
