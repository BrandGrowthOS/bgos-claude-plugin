/**
 * changes_rpc: the owner's Changes panel asks this daemon for the agent's
 * uncommitted changes (HOAI P7 stage 3, C-31). The collector that runs the
 * read only Git is lib/git-changes.ts; this file is the wire contract around
 * it, the stage 2 memory_rpc contract (lib/memory-rpc.ts) with one op.
 *
 * The backend (backend/src/changes-panel/changes-rpc.service.ts) emits
 * `{ rpcId, op: 'diff', assistantId, payload }` to the pairing room, where the
 * payload is `{ scope: 'uncommitted', maxPatchBytes, maxNumstatBytes,
 * maxUntrackedListBytes, maxUntrackedTextFiles, maxUntrackedTextBytes,
 * budgetMs }`. It re emits the frame ONCE when no ack lands within 1.5 s, and
 * takes the FIRST result it receives. The answers go to POST
 * integrations/changes-rpc/:rpcId/ack and /result, the result body
 * `{ ok: true, payload }` or `{ ok: false, error: { code, message } }` with
 * `code` 1 to 40 characters and `message` at most 500 (we send at most 300,
 * dash free). The payload is the collector's raw answer; the backend splits,
 * counts, masks and caps it (changes-view.ts, readDaemonAnswer and
 * buildChangesView), so nothing here does.
 *
 * The rules, in order, and why each one is here (spec 10.1 and 10.3):
 *  1. A frame with no rpcId cannot be answered, so it is dropped. Anything
 *     with one is answered, an unknown op included, so a future backend
 *     change fails loudly instead of timing out.
 *  2. A frame for another agent gets NOTHING, not even an ack. Several
 *     daemons can share one pairing room on a host and the first result
 *     wins: an error from the wrong daemon could be the answer the owner sees.
 *  3. A re sent frame never runs Git twice. The ids of the last 256 frames are
 *     REMEMBERED with their answers: an id still running is ignored, an id
 *     already answered gets the same answer again. Never forgotten in a
 *     finally.
 *  4. The ack is best effort: a failed ack costs one re emit, which rule 3
 *     absorbs, and must not stop the work.
 *  5. Until this agent's home folder is on record (or was pinned), nothing is
 *     read: a stray session holding the lock in its first minute must not
 *     show the owner a folder that is not the agent's.
 *  6. Only op diff with scope uncommitted is read; any other op answers
 *     unsupported and any other scope bad_request.
 *  7. The budget is the collector's: past it the running Git child is killed
 *     and the answer is too_slow.
 *  8. A result is ALWAYS posted. A throw answers read_failed.
 *  9. This daemon never reads the owner's per agent switch for the panel. The
 *     backend sends a frame only while it is on, and is the only gate.
 *
 * The log carries the state and the sizes, never a path, a folder name, a
 * branch or a line of the patch.
 */

import { readCaps, type ChangesCaps, type ChangesCollectResult } from './git-changes.ts'

export type ChangesRpcFrame = {
  rpcId: string
  op: string
  assistantId: string
  payload: Record<string, unknown>
}

export type ChangesRpcResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } }

export type ChangesRpcDeps = {
  /** lib/git-changes.ts collectChanges, with Git and the file system bound. */
  collect: (input: { workdir: string; caps: ChangesCaps }) => Promise<ChangesCollectResult>
  /** The agent's launch folder, read per frame. Never process.cwd(). */
  workdir: () => string
  /** This daemon's own agent, read per frame. Empty means unknown: answer nothing. */
  assistantId: () => string
  /** True once the home folder is recorded, or when the binding needed no record. */
  homeConfirmed: () => boolean
  postAck: (rpcId: string) => Promise<unknown>
  postResult: (rpcId: string, body: ChangesRpcResult) => Promise<unknown>
  log: (msg: string) => void
}

/** How many answered frames are remembered (the memory lane keeps the same). */
export const CHANGES_RPC_SEEN_MAX = 256
export const CHANGES_RPC_MESSAGE_MAX = 300
export const CHANGES_RPC_CODE_MAX = 40

const MSG = {
  otherAgent: 'changes frame for another agent',
  notConfirmed: "this agent's home folder is not confirmed yet",
  unsupported: 'this changes operation is not supported here',
  scope: 'only the uncommitted changes can be read',
  failed: 'changes could not be read on the agent host',
} as const

/** The en and em dash, built from code points so no source file carries either. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, 'g')

/**
 * The frame, or null when it cannot be answered (no string rpcId). The op stays
 * whatever string it was, so an unknown op is still answered.
 */
export function normalizeChangesRpc(raw: unknown): ChangesRpcFrame | null {
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
export function shortChangesMessage(message: unknown, fallback: string = MSG.failed): string {
  const text = String(message ?? '')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return fallback
  return text.length > CHANGES_RPC_MESSAGE_MAX ? text.slice(0, CHANGES_RPC_MESSAGE_MAX - 3).trimEnd() + '...' : text
}

function failure(code: string, message: string): ChangesRpcResult {
  const safeCode = String(code ?? '').trim().slice(0, CHANGES_RPC_CODE_MAX) || 'read_failed'
  return { ok: false, error: { code: safeCode, message: shortChangesMessage(message) } }
}

type Seen = { state: 'running' } | { state: 'done'; result: ChangesRpcResult }

export class ChangesRpcHandler {
  private readonly deps: ChangesRpcDeps
  /** rpcId to its state, oldest first; bounded at CHANGES_RPC_SEEN_MAX. */
  private readonly seen = new Map<string, Seen>()

  constructor(deps: ChangesRpcDeps) {
    this.deps = deps
  }

  async handle(frame: ChangesRpcFrame): Promise<void> {
    if (!frame?.rpcId) return
    const own = String(this.deps.assistantId() ?? '').trim()
    if (!own || String(frame.assistantId) !== own) {
      this.deps.log(
        `changes_rpc ${frame.rpcId} skipped: ${MSG.otherAgent} (frame ${frame.assistantId || 'none'}, this daemon ${own || 'unknown'})`,
      )
      return
    }

    const earlier = this.seen.get(frame.rpcId)
    if (earlier?.state === 'running') {
      this.deps.log(`changes_rpc duplicate frame ignored while it runs (rpc=${frame.rpcId})`)
      return
    }
    if (earlier?.state === 'done') {
      this.deps.log(`changes_rpc duplicate frame answered again from memory (rpc=${frame.rpcId})`)
      await this.post(frame.rpcId, earlier.result)
      return
    }
    this.remember(frame.rpcId, { state: 'running' })

    try {
      await this.deps.postAck(frame.rpcId)
    } catch (err) {
      this.deps.log(`changes_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${errorText(err)}`)
    }

    let result: ChangesRpcResult
    try {
      result = await this.run(frame)
    } catch (err) {
      this.deps.log(`changes_rpc ${frame.op || 'frame'} failed (rpc=${frame.rpcId}): ${errorText(err)}`)
      result = failure('read_failed', MSG.failed)
    }
    // Remembered for good (bounded), never forgotten in a finally: see rule 3.
    this.seen.set(frame.rpcId, { state: 'done', result })
    await this.post(frame.rpcId, result)
  }

  private async run(frame: ChangesRpcFrame): Promise<ChangesRpcResult> {
    if (!this.deps.homeConfirmed()) return failure('unavailable', MSG.notConfirmed)
    if (frame.op !== 'diff') return failure('unsupported', MSG.unsupported)
    if (frame.payload.scope !== 'uncommitted') return failure('bad_request', MSG.scope)
    const answer = await this.deps.collect({ workdir: this.deps.workdir(), caps: readCaps(frame.payload) })
    if (answer && answer.ok === true) {
      const p = answer.payload
      this.deps.log(
        `changes_rpc diff answered (rpc=${frame.rpcId}, state=${p.state}, numstat=${p.numstat.length}, ` +
          `patch=${p.patch.length}, untracked=${p.untracked.length}, read=${p.untrackedFiles.length}, ` +
          `cut=${p.numstatTruncated || p.patchTruncated || p.untrackedTruncated})`,
      )
      return { ok: true, payload: p as unknown as Record<string, unknown> }
    }
    if (answer && answer.ok === false) {
      this.deps.log(`changes_rpc diff not answered (rpc=${frame.rpcId}, code=${answer.code})`)
      return failure(answer.code, answer.message)
    }
    return failure('read_failed', MSG.failed)
  }

  private remember(rpcId: string, state: Seen): void {
    this.seen.delete(rpcId)
    this.seen.set(rpcId, state)
    while (this.seen.size > CHANGES_RPC_SEEN_MAX) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }

  private async post(rpcId: string, result: ChangesRpcResult): Promise<void> {
    try {
      await this.deps.postResult(rpcId, result)
    } catch (err) {
      this.deps.log(`changes_rpc result failed (rpc=${rpcId}): ${errorText(err)}`)
    }
  }
}

function errorText(err: unknown): string {
  return shortChangesMessage(err instanceof Error ? err.message : String(err), 'unknown error')
}
