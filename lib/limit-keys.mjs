/**
 * limit-keys: how the watcher READS an agent's screen and sends it ONE Enter, per platform. The only
 * effects of the limit watch live here; the rules are lib/limit-screen.mjs, the pass is
 * lib/watcher-limit.mjs.
 *
 *   macOS, Linux   the agent's hoai runs in tmux (bin/bgos-agent, socket hoai-<id>-home-<hid>, or the
 *                  old hoai-<id>). Read: `tmux -L <s> capture-pane -p -t =<s>:`. Press: the pane is
 *                  read AGAIN and must equal the approved text, then `tmux -L <s> send-keys -t =<s>:
 *                  Enter`: a key NAME, never literal text. Without tmux, expect holds the agent's PTY
 *                  and nothing outside it can type there: no key path, the owner gets the one tap fix.
 *   Windows        the agent runs in the hidden console of its `hoai-core --keep-alive` launcher (pid
 *                  in supervisor.json). bin/win32-limit-screen.ps1 attaches to that console: `read`
 *                  prints the visible rows and their sha256; `press` reads again and writes ONE Enter
 *                  key event only when the hash still matches the approved one (exit 7 otherwise).
 *
 * There is exactly one key in this file, Enter, and no way to pass another or any text.
 */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { SUPERVISOR_FILE_NAME, agentServiceNamesFor, joinDir, parseSupervisorRecord } from './agent-inventory.mjs'
import { findTool } from './agent-windows.mjs'

export const WIN32_LIMIT_HELPER_FILE_NAME = 'win32-limit-screen.ps1'
/** No read or press may hang the watcher's loop. */
export const SCREEN_EXEC_TIMEOUT_MS = 20_000

/** Helper exit codes (bin/win32-limit-screen.ps1). */
export const HELPER_EXIT = Object.freeze({ ok: 0, attachFailed: 2, injectFailed: 3, addTypeFailed: 5, screenChanged: 7 })

const SHA256_RE = /^[0-9a-f]{64}$/

export function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex')
}

/** Where the Windows helper ships: the bin dir beside this module (the watcher bundle carries it). */
export function defaultLimitHelperDir() {
  return fileURLToPath(new URL('../bin/', import.meta.url)).replace(/[\\/]+$/, '')
}

/**
 * The tmux the agent's supervisor runs (bin/bgos-agent finds it on PATH or in Homebrew), by full path
 * so a watcher started by launchd or systemd with a short PATH still finds it; null on Windows, or
 * when this computer has no tmux.
 * @param {{ platform: string, env?: Record<string, string | undefined>, home?: string, fs?: { exists?: (p: string) => boolean }, hasTmux?: boolean }} ctx
 */
export function limitTmuxPath(ctx) {
  if (ctx.platform === 'win32' || ctx.hasTmux === false) return null
  const exists = typeof ctx.fs?.exists === 'function' ? (p) => ctx.fs.exists(p) : undefined
  const found = findTool('tmux', { env: ctx.env ?? {}, home: ctx.home ?? '', ...(exists ? { exists } : {}) })
  if (found) return found
  return ctx.hasTmux === true ? 'tmux' : null
}

/** The two tmux argv shapes the limit watch ever runs. */
export function tmuxCaptureArgs(socket) {
  return ['-L', socket, 'capture-pane', '-p', '-t', `=${socket}:`]
}
export function tmuxEnterArgs(socket) {
  return ['-L', socket, 'send-keys', '-t', `=${socket}:`, 'Enter']
}

/**
 * powershell.exe arguments for the Windows helper, or null for anything but a positive pid, the
 * mode read, or the mode press with a sha256.
 * @param {{ helper: string, consolePid: number, mode: 'read' | 'press', expectHash?: string }} opts
 */
export function win32LimitHelperArgs({ helper, consolePid, mode, expectHash }) {
  if (!Number.isInteger(consolePid) || consolePid <= 0 || !helper) return null
  const head = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', String(helper), '-ConsolePid', String(consolePid), '-Mode']
  if (mode === 'read') return [...head, 'read']
  if (mode === 'press' && typeof expectHash === 'string' && SHA256_RE.test(expectHash)) return [...head, 'press', '-ExpectHash', expectHash]
  return null
}

/** The helper's `read` answer, `HOAI-SCREEN <sha256> <base64 utf8>`, or null unless the hash is of that very text. */
export function parseHelperScreen(stdout) {
  const m = /^HOAI-SCREEN ([0-9a-f]{64}) ([A-Za-z0-9+/=]*)\r?$/m.exec(String(stdout ?? ''))
  if (!m) return null
  const text = Buffer.from(m[2], 'base64').toString('utf8')
  return sha256Hex(text) === m[1] ? { hash: m[1], text } : null
}

/**
 * Can this computer press a key in this agent's screen, and how?
 * @param {{ platform: string, row: { assistantId: string, stateDir: string }, home: string, fs: { readFile: (p: string) => string | null },
 *   pidAlive: (pid: number) => boolean, tmuxPath: string | null, helperDir: string | null }} params
 * @returns {{ ok: true, kind: 'tmux', tmux: string, sockets: string[] } | { ok: true, kind: 'console', consolePid: number, helper: string } | { ok: false, reason: string }}
 */
export function limitKeyPath({ platform, row, home, fs, pidAlive, tmuxPath, helperDir }) {
  if (platform === 'win32') {
    if (!helperDir) return { ok: false, reason: 'unsupported' }
    const supervisor = parseSupervisorRecord(fs.readFile(joinDir(row.stateDir, SUPERVISOR_FILE_NAME)))
    // The launcher's console is the agent's: the pid must be alive, or there is nothing to attach to.
    if (!supervisor || !Number.isInteger(supervisor.pid) || !pidAlive(supervisor.pid)) return { ok: false, reason: 'no_console' }
    return { ok: true, kind: 'console', consolePid: supervisor.pid, helper: joinDir(helperDir, WIN32_LIMIT_HELPER_FILE_NAME) }
  }
  if (platform === 'darwin' || platform === 'linux') {
    if (!tmuxPath) return { ok: false, reason: 'no_tmux' }
    const names = agentServiceNamesFor(row.assistantId, home, platform)
    if (!names) return { ok: false, reason: 'unsupported' }
    const sockets = [...new Set([names.current.tmuxSocket, names.legacy.tmuxSocket])]
    return { ok: true, kind: 'tmux', tmux: tmuxPath, sockets }
  }
  return { ok: false, reason: 'unsupported' }
}

/**
 * Read the agent's screen through its key path.
 * @returns {Promise<{ ok: true, text: string, hash: string, socket: string | null } | { ok: false, why: 'no_tmux' | 'no_console' | 'screen_unreadable' }>}
 */
export async function readAgentScreen(keyPath, { exec }) {
  if (keyPath.kind === 'tmux') {
    for (const socket of keyPath.sockets) {
      const out = await exec(keyPath.tmux, tmuxCaptureArgs(socket), { timeoutMs: SCREEN_EXEC_TIMEOUT_MS })
      if (out.code === 0) return { ok: true, text: out.stdout, hash: sha256Hex(out.stdout), socket }
    }
    // No server on any of the agent's sockets: it does not run in tmux (expect holds its PTY).
    return { ok: false, why: 'no_tmux' }
  }
  const args = win32LimitHelperArgs({ helper: keyPath.helper, consolePid: keyPath.consolePid, mode: 'read' })
  if (!args) return { ok: false, why: 'screen_unreadable' }
  const out = await exec('powershell.exe', args, { timeoutMs: SCREEN_EXEC_TIMEOUT_MS })
  if (out.code === HELPER_EXIT.attachFailed) return { ok: false, why: 'no_console' }
  const screen = out.code === 0 ? parseHelperScreen(out.stdout) : null
  if (!screen) return { ok: false, why: 'screen_unreadable' }
  return { ok: true, text: screen.text, hash: screen.hash, socket: null }
}

/**
 * ONE Enter, only on the screen that was approved: the screen is read again right before the key
 * (tmux here, the helper on Windows) and nothing is sent when it changed.
 * @param {*} keyPath
 * @param {{ text: string, hash: string, socket: string | null }} approved
 * @returns {Promise<{ sent: boolean, why: string }>}
 */
export async function pressEnterOnce(keyPath, approved, { exec }) {
  if (keyPath.kind === 'tmux') {
    const socket = approved.socket
    if (!socket || !keyPath.sockets.includes(socket)) return { sent: false, why: 'no_tmux' }
    const again = await exec(keyPath.tmux, tmuxCaptureArgs(socket), { timeoutMs: SCREEN_EXEC_TIMEOUT_MS })
    if (again.code !== 0 || again.stdout !== approved.text) return { sent: false, why: 'screen_changed' }
    const out = await exec(keyPath.tmux, tmuxEnterArgs(socket), { timeoutMs: SCREEN_EXEC_TIMEOUT_MS })
    return out.code === 0 ? { sent: true, why: 'sent' } : { sent: false, why: 'inject_failed' }
  }
  const args = win32LimitHelperArgs({ helper: keyPath.helper, consolePid: keyPath.consolePid, mode: 'press', expectHash: approved.hash })
  if (!args) return { sent: false, why: 'screen_unreadable' }
  const out = await exec('powershell.exe', args, { timeoutMs: SCREEN_EXEC_TIMEOUT_MS })
  if (out.code === 0) return { sent: true, why: 'sent' }
  if (out.code === HELPER_EXIT.screenChanged) return { sent: false, why: 'screen_changed' }
  if (out.code === HELPER_EXIT.attachFailed) return { sent: false, why: 'no_console' }
  return { sent: false, why: out.timedOut ? 'helper_timed_out' : 'inject_failed' }
}
