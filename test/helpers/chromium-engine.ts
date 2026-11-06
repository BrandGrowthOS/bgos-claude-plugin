import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { ChromiumEngine, launchChromium } from '../../bin/hoai-browser-host.mjs'

/** Wait for the OS exit event, never a sleep that assumes Chrome has closed. */
export function waitForTestBrowserExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const exited = () => { clearTimeout(timer); child.removeListener('exit', exited); resolve(true) }
    const timer = setTimeout(() => { child.removeListener('exit', exited); resolve(false) }, ms)
    child.once('exit', exited)
  })
}

export function killTestBrowserTree(pid: number, exec: typeof execFile = execFile): Promise<void> {
  return new Promise(resolve => {
    // No shell, and only the pid returned by this fixture's own launch. Killing
    // one Windows process leaves Chrome helpers holding runtime files open.
    exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 10_000 }, () => resolve())
  })
}

export async function stopWindowsTestBrowser(child: ChildProcess, killTree = killTestBrowserTree): Promise<void> {
  // Browser.close has already been sent. Give slow hosted runners time to close
  // before forcing the owned tree, then require a real exit before removing files.
  if (await waitForTestBrowserExit(child, 20_000)) return
  if (child.pid === undefined) throw new Error('The test browser has no owned pid')
  await killTree(child.pid)
  if (!await waitForTestBrowserExit(child, 10_000)) throw new Error('The test browser process tree did not finish closing')
}

/** Test budgets only. The host's production launch and stop limits stay intact. */
export class TestChromiumEngine extends ChromiumEngine {
  constructor(options: { executable: string | null; profileDir: string; outputDir: string; heldDir?: string; scope?: string }) {
    super({ ...options, launch: args => launchChromium({ ...args,
      timeoutMs: process.platform === 'win32' ? 60_000 : 30_000,
      killWaitMs: process.platform === 'win32' ? 10_000 : 3_000,
    }) })
  }

  async _killChild() {
    if (process.platform !== 'win32') return super._killChild()
    const child = this._child
    if (!child) return
    await stopWindowsTestBrowser(child)
    this._child = null
  }
}
