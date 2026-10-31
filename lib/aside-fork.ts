/**
 * By the way on Claude Code (Threads phase 1, spec 8.4 and 19).
 *
 * A side question is answered by a one shot fork of the agent's MAIN session:
 * `claude -p --resume <main> --fork-session` with no tools at all
 * (lib/thread-lane-args.ts asideArgs), run in the main session's own folder so
 * the CLI finds the transcript. The fork reads the session file as far as it
 * is written, which is "everything in the conversation so far". The question
 * goes on stdin with the side question instruction inside the message.
 *
 * Its text streams as ordered deltas (onDelta, numbered from 0), its answer is
 * the result frame (or the streamed text when the result is missing), and the
 * fork's own session file is ALWAYS deleted once the child has exited: an
 * aside never becomes a session anybody resumes. The main session's file is
 * never touched. Hard timeout 55 s, under BGOS's 60 s.
 */

import { asideArgs, asidePrompt, isSessionId, type AsideExchange } from './thread-lane-args.ts'
import { lineSplitter, type SpawnStreamJson } from './stream-json-child.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

export const ASIDE_TIMEOUT_MS = 55_000

export class AsideError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface AsideDeps {
  spawn: SpawnStreamJson
  claudeBin(): string | null
  /** The main session this daemon has proven it serves, or null. */
  mainSessionId(): string | null
  /** The folder the main session runs in (its transcripts' project dir derives from it). */
  mainFolder: string
  home: string
  /** CLAUDE_CONFIG_DIR, '' for ~/.claude. */
  configDir: string
  /** Writes (once) and returns the empty MCP config's path. */
  emptyMcpConfigPath(): string
  unlink(path: string): void
  onDelta(seq: number, text: string): void
  timeoutMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  log?(msg: string): void
}

export interface AsideInput {
  question: string
  quote: string
  history: readonly AsideExchange[]
}

export function runAside(input: AsideInput, deps: AsideDeps): Promise<{ text: string }> {
  const mainId = deps.mainSessionId()
  if (!isSessionId(mainId)) {
    return Promise.reject(new AsideError('no_session', 'This agent has no running session to answer from yet.'))
  }
  const claude = deps.claudeBin()
  if (!claude) {
    return Promise.reject(new AsideError('unavailable', 'This computer cannot run Claude Code for a side question.'))
  }
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const args = asideArgs({ mainSessionId: mainId, emptyMcpConfigPath: deps.emptyMcpConfigPath() })

  return new Promise<{ text: string }>((resolve, reject) => {
    let settled = false
    let forkId: string | null = null
    let seq = 0
    let streamed = ''
    let resultText: string | null = null
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    const child = deps.spawn(claude, args, { cwd: deps.mainFolder })
    const timer = setTimer(() => {
      child.kill('SIGKILL')
      settle(() => reject(new AsideError('timed_out', 'The side question took too long to answer.')))
    }, deps.timeoutMs ?? ASIDE_TIMEOUT_MS)

    child.onStdout(lineSplitter((frame) => {
      if (frame.type === 'system' && frame.subtype === 'init') {
        const id = frame.session_id
        // Never the main session: that file is the chat itself.
        if (forkId === null && isSessionId(id) && id !== mainId) forkId = id
        return
      }
      if (frame.type === 'stream_event') {
        const event = frame.event as Record<string, unknown> | undefined
        const delta = event?.delta as Record<string, unknown> | undefined
        if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
          streamed += delta.text
          deps.onDelta(seq++, delta.text)
        }
        return
      }
      if (frame.type === 'result') {
        if (typeof frame.result === 'string' && frame.result.trim() !== '') resultText = frame.result
        const text = resultText ?? streamed
        if (text.trim() !== '') settle(() => resolve({ text }))
      }
    }))

    child.onExit(() => {
      clearTimer(timer)
      if (forkId) {
        const path = sessionTranscriptPath(deps.home, deps.mainFolder, forkId, deps.configDir)
        try {
          deps.unlink(path)
        } catch (err) {
          deps.log?.(`aside: could not delete the fork session file: ${err instanceof Error ? err.name : 'error'}`)
        }
      }
      const text = resultText ?? streamed
      settle(() =>
        text.trim() !== ''
          ? resolve({ text })
          : reject(new AsideError('failed', 'The side question could not be answered from what the agent knows.')),
      )
    })

    child.write(asidePrompt(input.question, input.quote, input.history))
    child.end()
  })
}
