/**
 * skills_rpc: the owner's Abilities screen asks this daemon for the skills its
 * agent loads, and to remove one (skills view design, section 7 row 3). The
 * reading and the removing are lib/skills-inventory.ts; this file is the wire
 * contract around it, the same lane shape as lib/memory-rpc.ts.
 *
 * The backend (backend/src/skills/skills-rpc.service.ts) emits
 * `{ rpcId, op, assistantId, payload }` to the pairing room, re emits it ONCE
 * when no ack lands within 1.5 s, and takes the FIRST result it receives. The
 * answers go to POST integrations/skills-rpc/:rpcId/ack and /result, the result
 * body `{ ok: true, payload }` or `{ ok: false, error: { code, message } }`.
 *
 * The rules, in order:
 *  1. A frame with no rpcId cannot be answered, so it is dropped. Anything
 *     with one is answered, an unknown op included.
 *  2. A frame for another agent gets NOTHING, not even an ack: several daemons
 *     can share one pairing room, and the first result wins.
 *  3. A re sent frame never runs twice: the last 256 answers are remembered.
 *  4. The ack is best effort.
 *  5. Until this agent's home folder is on record, nothing is read or removed.
 *  6. list_installed answers `{ skills, omitted? }`; remove answers
 *     `{ removed }`. The Store ops (install, catalog) are not Claude Code's
 *     and answer unsupported, as do the share ops until row 6 ships them.
 *  7. A result is ALWAYS posted. A throw answers read_failed or write_failed.
 */

import type { SkillRemoveAnswer, SkillsList } from './skills-inventory.ts'

export type SkillsRpcFrame = {
  rpcId: string
  op: string
  assistantId: string
  payload: Record<string, unknown>
}

export type SkillsRpcResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } }

export type SkillsRpcInventory = {
  list: () => SkillsList | Promise<SkillsList>
  remove: (payload: Record<string, unknown>) => SkillRemoveAnswer | Promise<SkillRemoveAnswer>
}

export type SkillsRpcDeps = {
  inventory: SkillsRpcInventory
  /** This daemon's own agent, read per frame. Empty means unknown: answer nothing. */
  assistantId: () => string
  homeConfirmed: () => boolean
  postAck: (rpcId: string) => Promise<unknown>
  postResult: (rpcId: string, body: SkillsRpcResult) => Promise<unknown>
  log: (msg: string) => void
}

export const SKILLS_RPC_SEEN_MAX = 256
export const SKILLS_RPC_MESSAGE_MAX = 300
export const SKILLS_RPC_CODE_MAX = 40

const MSG = {
  otherAgent: 'skills frame for another agent',
  notConfirmed: "this agent's home folder is not confirmed yet",
  unsupported: 'this skills operation is not supported on a Claude Code agent',
  readFailed: 'the skills could not be read on the agent host',
  writeFailed: 'the skill could not be removed on the agent host',
} as const

export function normalizeSkillsRpc(raw: unknown): SkillsRpcFrame | null {
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
export function shortSkillsMessage(message: unknown, fallback: string): string {
  const text = String(message ?? '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return fallback
  return text.length > SKILLS_RPC_MESSAGE_MAX ? text.slice(0, SKILLS_RPC_MESSAGE_MAX - 3).trimEnd() + '...' : text
}

function failure(code: string, message: string, fallback: string): SkillsRpcResult {
  const safeCode = String(code ?? '').trim().slice(0, SKILLS_RPC_CODE_MAX) || 'write_failed'
  return { ok: false, error: { code: safeCode, message: shortSkillsMessage(message, fallback) } }
}

/** A copy with every null or undefined key left out, so the wire never carries one. */
function present<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = v
  return out as T
}

type Seen = { state: 'running' } | { state: 'done'; result: SkillsRpcResult }

export class SkillsRpcHandler {
  private readonly deps: SkillsRpcDeps
  private readonly seen = new Map<string, Seen>()

  constructor(deps: SkillsRpcDeps) {
    this.deps = deps
  }

  async handle(frame: SkillsRpcFrame): Promise<void> {
    if (!frame?.rpcId) return
    const own = String(this.deps.assistantId() ?? '').trim()
    if (!own || String(frame.assistantId) !== own) {
      this.deps.log(
        `skills_rpc ${frame.rpcId} skipped: ${MSG.otherAgent} (frame ${frame.assistantId || 'none'}, this daemon ${own || 'unknown'})`,
      )
      return
    }

    const earlier = this.seen.get(frame.rpcId)
    if (earlier?.state === 'running') {
      this.deps.log(`skills_rpc duplicate frame ignored while it runs (rpc=${frame.rpcId})`)
      return
    }
    if (earlier?.state === 'done') {
      this.deps.log(`skills_rpc duplicate frame answered again from memory (rpc=${frame.rpcId})`)
      await this.post(frame.rpcId, earlier.result)
      return
    }
    this.remember(frame.rpcId, { state: 'running' })

    try {
      await this.deps.postAck(frame.rpcId)
    } catch (err) {
      this.deps.log(`skills_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${errorText(err)}`)
    }

    let result: SkillsRpcResult
    try {
      result = await this.run(frame)
    } catch (err) {
      this.deps.log(`skills_rpc ${frame.op} failed (rpc=${frame.rpcId}): ${errorText(err)}`)
      result =
        frame.op === 'remove'
          ? failure('write_failed', MSG.writeFailed, MSG.writeFailed)
          : failure('read_failed', MSG.readFailed, MSG.readFailed)
    }
    this.remember(frame.rpcId, { state: 'done', result })
    await this.post(frame.rpcId, result)
  }

  private async run(frame: SkillsRpcFrame): Promise<SkillsRpcResult> {
    const { inventory } = this.deps
    if (frame.op !== 'list_installed' && frame.op !== 'remove') {
      return failure('unsupported', MSG.unsupported, MSG.unsupported)
    }
    if (!this.deps.homeConfirmed()) return failure('unavailable', MSG.notConfirmed, MSG.notConfirmed)
    if (frame.op === 'list_installed') {
      const listed = await inventory.list()
      const skills = (listed?.skills ?? []).map((s) => present(s))
      return {
        ok: true,
        payload: { skills, ...(listed?.omitted?.length ? { omitted: listed.omitted } : {}) },
      }
    }
    const answer = await inventory.remove(frame.payload)
    if (answer && answer.ok === true) return { ok: true, payload: { removed: answer.removed } }
    if (answer && answer.ok === false) return failure(answer.code, answer.message, MSG.writeFailed)
    return failure('write_failed', MSG.writeFailed, MSG.writeFailed)
  }

  private remember(rpcId: string, state: Seen): void {
    this.seen.delete(rpcId)
    this.seen.set(rpcId, state)
    // Answered frames go first: evicting one still running would let its re emit run it twice.
    while (this.seen.size > SKILLS_RPC_SEEN_MAX) {
      let victim: string | undefined
      for (const [id, seen] of this.seen) {
        if (seen.state === 'done') {
          victim = id
          break
        }
      }
      victim ??= this.seen.keys().next().value
      if (victim === undefined) break
      this.seen.delete(victim)
    }
  }

  private async post(rpcId: string, result: SkillsRpcResult): Promise<void> {
    try {
      await this.deps.postResult(rpcId, result)
    } catch (err) {
      this.deps.log(`skills_rpc result failed (rpc=${rpcId}): ${errorText(err)}`)
    }
  }
}

function errorText(err: unknown): string {
  return shortSkillsMessage(err instanceof Error ? err.message : String(err), 'unknown error')
}
