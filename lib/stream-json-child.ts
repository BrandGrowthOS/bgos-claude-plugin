/**
 * The stream json plumbing that thread lanes (lib/thread-lanes.ts) and By the
 * way (lib/aside-fork.ts) share: a child `claude -p` written to on stdin and
 * read as NDJSON on stdout.
 *
 * The child handle is an interface so both managers are unit tested with
 * fakes; spawnStreamJson is the real one server.ts passes in.
 */

import { spawn } from 'node:child_process'

export interface StreamJsonChild {
  /** Write to stdin. A no op once the child is gone. */
  write(chunk: string): void
  /** Close stdin. */
  end(): void
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
  onStdout(cb: (chunk: string) => void): void
  /** Called once: the exit, or a start that failed (code null). */
  onExit(cb: (code: number | null, signal: string | null) => void): void
}

export type SpawnStreamJson = (command: string, args: string[], opts: { cwd: string }) => StreamJsonChild

/** NDJSON: whole lines only, JSON objects only; anything else is skipped. */
export function lineSplitter(onFrame: (frame: Record<string, unknown>) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onFrame(parsed as Record<string, unknown>)
    }
  }
}

/** One user message in the CLI's `--input-format stream-json` shape. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`
}

/**
 * The variables that tie a process to the session that launched this daemon.
 * A lane or a By the way fork is a session of its own: inheriting these would
 * let its hooks or its bridge speak as the main session.
 */
const PARENT_SESSION_VARS = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
]

export function laneChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || PARENT_SESSION_VARS.includes(key)) continue
    out[key] = value
  }
  return out
}

/** The real child: node's spawn with three pipes; stderr is drained and dropped. */
export function spawnStreamJson(command: string, args: string[], opts: { cwd: string }): StreamJsonChild {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: laneChildEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let gone = false
  const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = []
  const finish = (code: number | null, signal: string | null): void => {
    if (gone) return
    gone = true
    for (const cb of exitCallbacks) cb(code, signal)
  }
  child.on('error', () => finish(null, null))
  child.on('exit', (code, signal) => finish(code, signal))
  child.stdin?.on('error', () => {})
  child.stdout?.setEncoding('utf8')
  child.stderr?.resume()
  return {
    write(chunk) {
      if (gone || !child.stdin || child.stdin.destroyed) return
      child.stdin.write(chunk)
    },
    end() {
      if (gone || !child.stdin || child.stdin.destroyed) return
      child.stdin.end()
    },
    kill(signal) {
      if (gone) return
      try {
        child.kill(signal)
      } catch {}
    },
    onStdout(cb) {
      child.stdout?.on('data', (d: string) => cb(d))
    },
    onExit(cb) {
      exitCallbacks.push(cb)
    },
  }
}
