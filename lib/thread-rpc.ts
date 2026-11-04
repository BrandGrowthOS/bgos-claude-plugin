/**
 * The Threads phase 1 ops on the voice_rpc rail (plan "Wire contract", Daemon
 * ops), guarded here, locally, like lib/model-effort-rpc.ts guards the picker
 * ops: lib/session-controls-contract.ts is pinned across repos and does not
 * change.
 *
 *   thread_turn  {chatId, rootId, replyId, mode, text, title, rootText}
 *                -> {accepted:true, state:"working"|"waiting"} at once
 *   thread_close {chatId, rootId, removeWorktree} -> {stopped:true}
 *   aside        {chatId, asideId, questionId, question, quote, history}
 *                -> progress frames {seq, delta}, then {text}
 *
 * This file turns a frame's payload into the lanes' and the aside's input, and
 * a refusal into the code BGOS passes on (bad_request, unsupported,
 * no_session, timed_out, failed, ...).
 */

import { AsideError, type AsideInput } from './aside-fork.ts'
import { ThreadLaneError, type ThreadTurnInput } from './thread-lanes.ts'
import type { AsideExchange, ThreadTurnMode } from './thread-lane-args.ts'

export const THREAD_TURN = 'thread_turn'
export const THREAD_CLOSE = 'thread_close'
export const ASIDE = 'aside'
export const THREAD_OPS = Object.freeze([THREAD_TURN, THREAD_CLOSE, ASIDE] as const)
export type ThreadOp = (typeof THREAD_OPS)[number]

export function isThreadOp(op: unknown): op is ThreadOp {
  return op === THREAD_TURN || op === THREAD_CLOSE || op === ASIDE
}

/** What the voice_rpc handler needs from the lanes and the aside runner. */
export interface ThreadRpcDeps {
  turn(input: ThreadTurnInput): { accepted: true; state: 'working' | 'waiting' } | Promise<{ accepted: true; state: 'working' | 'waiting' }>
  close(input: { rootId: string; removeWorktree: boolean }): Promise<{ stopped: true }>
  aside(input: AsideInput, onDelta: (seq: number, text: string) => void): Promise<{ text: string }>
}

export class ThreadRpcError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

export function threadTurnPayload(payload: Record<string, unknown>, frameChatId: string | number | null): ThreadTurnInput {
  const chatId = str(payload.chatId) || str(frameChatId)
  const rootId = str(payload.rootId)
  const mode = str(payload.mode)
  if (!chatId || !rootId) throw new ThreadRpcError('bad_request', 'A thread turn needs its chat and its root message.')
  if (mode !== 'start' && mode !== 'reply' && mode !== 'summary') {
    throw new ThreadRpcError('bad_request', 'A thread turn mode is start, reply or summary.')
  }
  return {
    chatId,
    rootId,
    replyId: str(payload.replyId),
    mode: mode as ThreadTurnMode,
    text: str(payload.text),
    title: str(payload.title),
    rootText: str(payload.rootText),
  }
}

export function threadClosePayload(payload: Record<string, unknown>): { rootId: string; removeWorktree: boolean } {
  const rootId = str(payload.rootId)
  if (!rootId) throw new ThreadRpcError('bad_request', 'Closing a thread needs its root message.')
  return { rootId, removeWorktree: payload.removeWorktree === true }
}

export function asidePayload(payload: Record<string, unknown>): AsideInput {
  const question = str(payload.question)
  if (question.trim() === '') throw new ThreadRpcError('bad_request', 'A side question needs its question.')
  const history: AsideExchange[] = []
  if (Array.isArray(payload.history)) {
    for (const item of payload.history) {
      if (!item || typeof item !== 'object') continue
      const x = item as Record<string, unknown>
      if (typeof x.q === 'string' && typeof x.a === 'string') history.push({ q: x.q, a: x.a })
    }
  }
  return { question, quote: str(payload.quote), history }
}

/** A refusal that carries a code BGOS can pass on, or null for anything else (answered failed). */
export function threadRefusal(err: unknown): { code: string; message: string } | null {
  if (err instanceof ThreadRpcError || err instanceof ThreadLaneError || err instanceof AsideError) {
    return { code: err.code, message: err.message }
  }
  return null
}
