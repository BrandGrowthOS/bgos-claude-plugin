/**
 * memory_rpc: the owner's Memory screen asks this daemon to list or change the
 * agent's auto memory (HOAI P7 stage 2, C-39). The store that does the reading
 * and writing is lib/memory.ts; this file is the wire contract around it.
 *
 * The backend (backend/src/memory-panel/memory-rpc.service.ts) emits
 * `{ rpcId, op, assistantId, payload }` to the pairing room, re emits it ONCE
 * when no ack lands within 1.5 s, and takes the FIRST result it receives. The
 * answers go to POST integrations/memory-rpc/:rpcId/ack and /result, the result
 * body `{ ok: true, payload }` or `{ ok: false, error: { code, message } }` with
 * `code` 1 to 40 characters and `message` at most 500 (we send at most 300).
 *
 * The rules, in order, and why each one is here:
 *  1. A frame with no rpcId cannot be answered, so it is dropped. Anything
 *     with one is answered, an unknown op included, so a future backend change
 *     fails loudly instead of timing out.
 *  2. A frame for another agent gets NOTHING, not even an ack. Several daemons
 *     can share one pairing room on a host, a pairing can back more than one
 *     agent, and the first result wins: an error from the wrong daemon could be
 *     the answer the owner sees.
 *  3. A re sent frame never runs twice. The ids of the last 256 frames are
 *     REMEMBERED with their answers (the Hermes bridge keeps 256). An id still
 *     running is ignored; an id already answered gets the same answer again.
 *     voice_rpc forgets its ids in a finally, which here would let the 1.5 s
 *     re emit after a fast write add a fact twice.
 *  4. The ack is best effort: a failed ack costs one re emit, which rule 3
 *     absorbs, and must not stop the work.
 *  5. Until this agent's home folder is on record (or was pinned), nothing is
 *     read or written: a stray session holding the lock in its first minute
 *     must not edit a memory that is not the agent's.
 *  6. list, add, replace and remove go to the store; search and anything else
 *     answer unsupported (the app hides search for Claude Code).
 *  7. A result is ALWAYS posted. A throw answers write_failed.
 */

import type { MemoryAnswer, MemoryTarget } from './memory.ts'

export type MemoryRpcFrame = {
  rpcId: string
  op: string
  assistantId: string
  payload: Record<string, unknown>
}

export type MemoryRpcResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } }

export type MemoryRpcStore = {
  list: () => MemoryAnswer | Promise<MemoryAnswer>
  add: (target: MemoryTarget, content: string) => MemoryAnswer | Promise<MemoryAnswer>
  replace: (target: MemoryTarget, oldText: string, newContent: string) => MemoryAnswer | Promise<MemoryAnswer>
  remove: (target: MemoryTarget, oldText: string) => MemoryAnswer | Promise<MemoryAnswer>
}

export type MemoryRpcDeps = {
  store: MemoryRpcStore
  /** This daemon's own agent, read per frame. Empty means unknown: answer nothing. */
  assistantId: () => string
  /** True once the home folder is recorded, or when the binding needed no record. */
  homeConfirmed: () => boolean
  postAck: (rpcId: string) => Promise<unknown>
  postResult: (rpcId: string, body: MemoryRpcResult) => Promise<unknown>
  log: (msg: string) => void
}

/** How many answered frames are remembered (the Hermes bridge keeps the same). */
export const MEMORY_RPC_SEEN_MAX = 256
/** The backend's own limit on a memory text (MemoryEntryAddDto and friends). */
export const MEMORY_RPC_TEXT_MAX = 4000
export const MEMORY_RPC_MESSAGE_MAX = 300
export const MEMORY_RPC_CODE_MAX = 40

const MSG = {
  otherAgent: 'memory frame for another agent',
  notConfirmed: "this agent's home folder is not confirmed yet",
  search: 'memory search is not available on this agent',
  unsupported: 'this memory operation is not supported here',
  target: 'target must be memory or user',
  text: 'the text is missing, blank or over 4000 characters',
  failed: 'memory operation failed on the agent host',
} as const

/**
 * The frame, or null when it cannot be answered (no string rpcId). The op stays
 * whatever string it was, so an unknown op is still answered.
 */
export function normalizeMemoryRpc(raw: unknown): MemoryRpcFrame | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.rpcId !== 'string' || !r.rpcId) return null
  return {
    rpcId: r.rpcId,
    op: typeof r.op === 'string' ? r.op : '',
    assistantId:
      typeof r.assistantId === 'string' || typeof r.assistantId === 'number' ? String(r.assistantId) : '',
    payload:
      r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : {},
  }
}

/** Short, one line and dash free: every en and em dash becomes a hyphen. */
export function shortMemoryMessage(message: unknown, fallback: string = MSG.failed): string {
  const text = String(message ?? '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return fallback
  return text.length > MEMORY_RPC_MESSAGE_MAX ? text.slice(0, MEMORY_RPC_MESSAGE_MAX - 3).trimEnd() + '...' : text
}

function failure(code: string, message: string): MemoryRpcResult {
  const safeCode = String(code ?? '').trim().slice(0, MEMORY_RPC_CODE_MAX) || 'write_failed'
  return { ok: false, error: { code: safeCode, message: shortMemoryMessage(message) } }
}

function fromAnswer(answer: MemoryAnswer): MemoryRpcResult {
  if (answer && answer.ok === true) return { ok: true, payload: { stores: answer.stores } }
  if (answer && answer.ok === false) return failure(answer.code, answer.message)
  return failure('write_failed', MSG.failed)
}

function targetOf(payload: Record<string, unknown>): MemoryTarget | null {
  return payload.target === 'memory' || payload.target === 'user' ? payload.target : null
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.trim() || value.length > MEMORY_RPC_TEXT_MAX) return null
  return value
}

type Seen = { state: 'running' } | { state: 'done'; result: MemoryRpcResult }

export class MemoryRpcHandler {
  private readonly deps: MemoryRpcDeps
  /** rpcId to its state, oldest first; bounded at MEMORY_RPC_SEEN_MAX. */
  private readonly seen = new Map<string, Seen>()

  constructor(deps: MemoryRpcDeps) {
    this.deps = deps
  }

  async handle(frame: MemoryRpcFrame): Promise<void> {
    if (!frame?.rpcId) return
    const own = String(this.deps.assistantId() ?? '').trim()
    if (!own || String(frame.assistantId) !== own) {
      this.deps.log(
        `memory_rpc ${frame.rpcId} skipped: ${MSG.otherAgent} (frame ${frame.assistantId || 'none'}, this daemon ${own || 'unknown'})`,
      )
      return
    }

    const earlier = this.seen.get(frame.rpcId)
    if (earlier?.state === 'running') {
      this.deps.log(`memory_rpc duplicate frame ignored while it runs (rpc=${frame.rpcId})`)
      return
    }
    if (earlier?.state === 'done') {
      this.deps.log(`memory_rpc duplicate frame answered again from memory (rpc=${frame.rpcId})`)
      await this.post(frame.rpcId, earlier.result)
      return
    }
    this.remember(frame.rpcId, { state: 'running' })

    try {
      await this.deps.postAck(frame.rpcId)
    } catch (err) {
      this.deps.log(`memory_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${errorText(err)}`)
    }

    let result: MemoryRpcResult
    try {
      result = await this.run(frame)
    } catch (err) {
      this.deps.log(`memory_rpc ${frame.op} failed (rpc=${frame.rpcId}): ${errorText(err)}`)
      result = failure('write_failed', MSG.failed)
    }
    // Remembered for good (bounded), never forgotten in a finally: see rule 3.
    this.seen.set(frame.rpcId, { state: 'done', result })
    await this.post(frame.rpcId, result)
  }

  private async run(frame: MemoryRpcFrame): Promise<MemoryRpcResult> {
    if (!this.deps.homeConfirmed()) return failure('unavailable', MSG.notConfirmed)
    const { store } = this.deps
    const p = frame.payload
    switch (frame.op) {
      case 'list':
        return fromAnswer(await store.list())
      case 'add': {
        const target = targetOf(p)
        if (!target) return failure('bad_request', MSG.target)
        const content = textOf(p.content)
        if (content == null) return failure('bad_request', MSG.text)
        return fromAnswer(await store.add(target, content))
      }
      case 'replace': {
        const target = targetOf(p)
        if (!target) return failure('bad_request', MSG.target)
        const oldText = textOf(p.oldText)
        const newContent = textOf(p.newContent)
        if (oldText == null || newContent == null) return failure('bad_request', MSG.text)
        return fromAnswer(await store.replace(target, oldText, newContent))
      }
      case 'remove': {
        const target = targetOf(p)
        if (!target) return failure('bad_request', MSG.target)
        const oldText = textOf(p.oldText)
        if (oldText == null) return failure('bad_request', MSG.text)
        return fromAnswer(await store.remove(target, oldText))
      }
      case 'search':
        return failure('unsupported', MSG.search)
      default:
        return failure('unsupported', MSG.unsupported)
    }
  }

  private remember(rpcId: string, state: Seen): void {
    this.seen.delete(rpcId)
    this.seen.set(rpcId, state)
    while (this.seen.size > MEMORY_RPC_SEEN_MAX) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }

  private async post(rpcId: string, result: MemoryRpcResult): Promise<void> {
    try {
      await this.deps.postResult(rpcId, result)
    } catch (err) {
      this.deps.log(`memory_rpc result failed (rpc=${rpcId}): ${errorText(err)}`)
    }
  }
}

function errorText(err: unknown): string {
  return shortMemoryMessage(err instanceof Error ? err.message : String(err), 'unknown error')
}
