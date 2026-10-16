/**
 * A faked window and process layer for the watcher loop (board row afa70b0c): the process table a
 * windows pass (lib/agent-windows.mjs) lists, and the signals it sends, driven ONLY through the exec
 * and kill a test hands runWatcher. No real process is ever listed, signalled, started or closed.
 *
 * It answers the listing commands lib/process-tree.mjs emits from its own table (PowerShell's CIM
 * query on win32, ps on a Mac or Linux), answers tmux queries with no server, and models a signal:
 * one to a pid in the table ends that process (signal 0 only asks), one to any other pid is ESRCH.
 * Every listing and every signal is recorded, so a test can prove what the code looked at and what
 * it closed. Anything else it is asked to run fails with 127 and is recorded in `refused`.
 */

import { WIN32_PROCESS_SCRIPT, psCommand } from '../../lib/process-tree.mjs'
import { VIEWER_SCRIPT_FILE_NAME } from '../../lib/agent-windows.mjs'

export type FakeProcess = { pid: number; ppid: number; command: string; startedAtMs: number }
export type ExecResult = { code: number | null; stdout: string; stderr: string; error: string | null; timedOut: boolean }

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', error: null, timedOut: false })

/** A HOAI viewer window as the win32 windows pass finds it: powershell running the viewer script in view mode. */
export function viewerProcess(opts: { pid: number; assistantId: string; consolePid: number; startedAtMs?: number }): FakeProcess {
  return {
    pid: opts.pid,
    ppid: 4,
    startedAtMs: opts.startedAtMs ?? Date.parse('2026-10-11T07:00:00.000Z'),
    command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\kc\\.bgos-agent\\watcher\\bin\\${VIEWER_SCRIPT_FILE_NAME}" -ConsolePid ${opts.consolePid} -AssistantId ${opts.assistantId}`,
  }
}

/** lstart as ps prints it under LC_ALL=C ("Sun Oct 11 07:00:00 2026"), local time. */
function lstart(ms: number) {
  const d = new Date(ms)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  const two = (n: number) => String(n).padStart(2, '0')
  return `${day} ${mon} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`
}

export function fakeWindowHost(opts: { processes?: FakeProcess[] } = {}) {
  // A real table is never empty (the parsers read an empty one as unreadable): the system process.
  const seed: FakeProcess[] = [{ pid: 4, ppid: 0, command: 'System', startedAtMs: Date.parse('2026-10-01T00:00:00.000Z') }, ...(opts.processes ?? [])]
  const processes = new Map(seed.map((p) => [p.pid, { ...p }]))
  /** One entry per process listing answered: 'win32' (the CIM query) or 'ps'. */
  const listings: string[] = []
  const kills: Array<{ pid: number; signal: string | number }> = []
  const refused: Array<{ file: string; args: string[] }> = []
  const table = () => [...processes.values()]

  const exec = async (file: string, args: readonly string[], _opts?: unknown): Promise<ExecResult> => {
    const name = String(file).split(/[\\/]/).pop()!.toLowerCase()
    if (name === 'powershell.exe' && args.includes('-Command') && args.includes(WIN32_PROCESS_SCRIPT)) {
      listings.push('win32')
      return ok(JSON.stringify(table().map((p) => ({ ProcessId: p.pid, ParentProcessId: p.ppid, CreationDate: p.startedAtMs, CommandLine: p.command }))))
    }
    const ps = psCommand('linux')
    const psMac = psCommand('darwin')
    if (name === 'ps' && (args.join(' ') === ps.args.join(' ') || args.join(' ') === psMac.args.join(' '))) {
      listings.push('ps')
      return ok(table().map((p) => `${p.pid} ${p.ppid} 501 ${lstart(p.startedAtMs)} ${p.command}`).join('\n'))
    }
    // No tmux server: nothing to list and no client to detach.
    if (name === 'tmux') return { code: 1, stdout: '', stderr: 'no server running', error: null, timedOut: false }
    refused.push({ file: String(file), args: [...args] })
    return { code: 127, stdout: '', stderr: `not faked: ${file}`, error: null, timedOut: false }
  }

  const kill = (pid: number, signal: string | number = 'SIGTERM') => {
    kills.push({ pid, signal })
    if (!processes.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' })
    if (signal !== 0 && signal !== '0') processes.delete(pid)
    return true
  }

  return { processes, listings, kills, refused, exec, kill, pidAlive: (pid: number) => processes.has(pid) }
}

export type FakeWindowHost = ReturnType<typeof fakeWindowHost>
