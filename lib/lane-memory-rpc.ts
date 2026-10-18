/**
 * PERSON LANES, a person's Memory screen answered from their own lane
 * (shared agents Phase 3, P5; design section 6 row Memory and its "As built
 * in P4" list; BGOS CORE-CONTRACTS 7.8 "a person's own lane controls").
 *
 * BGOS P4 sends a person's memory frame stamped for her lane:
 * `{ rpcId, op, assistantId, payload, actorUserId, lane: 'person:<id>' }`,
 * on the socket event `memory_rpc`, to:
 *   - her RUNNING lane: only to her lane's sockets whose own handshake
 *     declared `lane_memory_rpc`, and only her lane's session may settle it;
 *   - her STOPPED lane: only to the agent's own SIGNED daemon socket that
 *     declared it, and only the owner's pairing may settle it.
 * Every answer, an error answer included, must echo the stamp (`lane`), or
 * it is refused and the panel waits until its timeout.
 *
 * This file is both answers: the lane daemon (lane-server.ts) for its own
 * person only, and the owner's daemon (server.ts) for a stopped lane, from
 * that person's folder on disk. Either way:
 *   - the frame must be for this agent, and stamped exactly for the person
 *     it names; anything else gets nothing, not even an ack;
 *   - the memory is `<lane>/work/memory/` (lib/lane-memory.mjs), through a
 *     file view that refuses a symlink and anything outside that folder and
 *     the lane's memory trash, so a planted link cannot turn a panel read or
 *     write into one of the owner's files;
 *   - a write (add, replace, remove) is applied AT MOST ONCE per rpcId across
 *     processes (the marker in the lane folder); a duplicate re-sends the
 *     first answer, or nothing while the first one runs;
 *   - the answer echoes `lane` at the top and `actorUserId` and `lane` inside
 *     `payload` (the result body's only free form object, so a strict
 *     validation pipe never refuses it).
 * The owner's own, unstamped frame never comes here (lib/memory-rpc.ts).
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'

import { isSafeLaneUserId, lanePaths, OWNER_LANE_STAMP, personLaneStamp, readLaneStamp } from './lane-core.mjs'
import { claimLaneMemoryWrite, finishLaneMemoryWrite } from './lane-memory.mjs'
import { createClaudeMemoryStore, nodeMemoryFs, type ClaudeMemoryStore, type MemoryFolderAnswer, type MemoryFs } from './memory.ts'
import { memoryRpcFailure, normalizeMemoryRpc, runMemoryRpcOp, type MemoryRpcFrame, type MemoryRpcResult } from './memory-rpc.ts'

export { LANE_MEMORY_RPC_TOKEN } from './lane-core.mjs'

export type LaneMemoryFrame = MemoryRpcFrame & { actorUserId: string; lane: string }

const WRITE_OPS = new Set(['add', 'replace', 'remove'])

/**
 * Whose frame is this? `owner` for the owner's own (no stamp, or `owner`,
 * and no person named); `person` when it is stamped exactly for the safe id
 * it names; `drop` for anything else (unreadable, a stamp and a person that
 * disagree, no rpcId).
 */
export function classifyMemoryFrame(
  raw: unknown,
): { kind: 'owner'; frame: MemoryRpcFrame } | { kind: 'person'; frame: LaneMemoryFrame } | { kind: 'drop'; why: string } {
  const frame = normalizeMemoryRpc(raw)
  if (!frame) return { kind: 'drop', why: 'no_rpc_id' }
  const r = raw as Record<string, unknown>
  const stamp = readLaneStamp(r)
  const actor = r.actorUserId
  if (stamp === null || stamp === OWNER_LANE_STAMP) {
    if (actor !== undefined && actor !== null) return { kind: 'drop', why: 'person_without_stamp' }
    return { kind: 'owner', frame }
  }
  if (typeof actor !== 'string' || !isSafeLaneUserId(actor) || stamp !== personLaneStamp(actor)) {
    return { kind: 'drop', why: `stamp ${stamp}` }
  }
  return { kind: 'person', frame: { ...frame, actorUserId: actor, lane: stamp } }
}

/** The answer body for a person's frame: the result plus the echo. */
export function laneMemoryAnswer(result: MemoryRpcResult, userId: string): Record<string, unknown> {
  const lane = personLaneStamp(userId)
  const echo = { actorUserId: userId, lane }
  return result.ok
    ? { ok: true, payload: { ...result.payload, ...echo }, lane }
    : { ok: false, error: result.error, payload: echo, lane }
}

/**
 * The lane's memory folder: `<work>/memory`, created when missing, refused
 * when `work` or `memory` is a symlink.
 */
export function resolveLaneMemoryFolder(paths: { workDir: string; memoryDir: string }, fs: typeof nodeFs = nodeFs): MemoryFolderAnswer {
  try {
    // A person whose lane never started has no folder yet; the supervisor
    // makes the same one (0700) at its first start.
    if (!fs.existsSync(paths.workDir)) fs.mkdirSync(paths.workDir, { recursive: true, mode: 0o700 })
    const work = fs.lstatSync(paths.workDir)
    if (work.isSymbolicLink() || !work.isDirectory()) {
      return { ok: false, code: 'unavailable', message: 'this lane\'s working folder is not a plain folder' }
    }
    try {
      const mem = fs.lstatSync(paths.memoryDir)
      if (mem.isSymbolicLink() || !mem.isDirectory()) {
        return { ok: false, code: 'unavailable', message: 'this lane\'s memory folder is not a plain folder' }
      }
    } catch {
      fs.mkdirSync(paths.memoryDir, { mode: 0o700 })
    }
    return { ok: true, memDir: join(fs.realpathSync(paths.workDir), 'memory') }
  } catch {
    return { ok: false, code: 'unavailable', message: 'this lane has no memory folder yet' }
  }
}

/**
 * A view of the disk that only reaches files directly inside the given
 * folders, and never through a symlink.
 */
export function confinedMemoryFs(base: MemoryFs, roots: () => string[], fs: typeof nodeFs = nodeFs): MemoryFs {
  const inside = (path: string): boolean => {
    const list = roots()
    if (!list.some((root) => path === root || dirname(path) === root)) return false
    try {
      if (fs.lstatSync(path).isSymbolicLink()) return false
    } catch { /* not there yet: fine */ }
    return true
  }
  const refuse = (path: string): never => {
    throw new Error(`lane memory: ${path} is outside this lane's memory`)
  }
  // A read opens the file WITHOUT following a final symlink, so one planted
  // between the check above and the read is refused too (security review L1).
  const readNoFollow = (path: string): string | null => {
    let fd: number
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    } catch {
      return null
    }
    try {
      return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, 'utf8') : null
    } finally {
      fs.closeSync(fd)
    }
  }
  return {
    exists: (p) => inside(p) && base.exists(p),
    readFile: (p) => (!inside(p) ? null : base === nodeMemoryFs ? readNoFollow(p) : base.readFile(p)),
    writeFile: (p, text) => (inside(p) ? base.writeFile(p, text) : refuse(p)),
    rename: (from, to) => (inside(from) && inside(to) ? base.rename(from, to) : refuse(`${from} -> ${to}`)),
    rm: (p) => (inside(p) ? base.rm(p) : refuse(p)),
    listDir: (p) => (inside(p) ? base.listDir(p) : []),
    stat: (p) => (inside(p) ? base.stat(p) : null),
    mkdir: (p) => (inside(p) ? base.mkdir(p) : refuse(p)),
    realpath: (p) => (inside(p) && base.realpath ? base.realpath(p) : null),
  }
}

export interface LaneMemoryRpcDeps {
  /** This daemon's agent. */
  assistantId: string
  home: string
  stateRoot?: string
  /** The lane daemon: only its own person. The owner's daemon: any person. */
  accepts: (userId: string) => boolean
  postAck: (rpcId: string) => Promise<unknown>
  postResult: (rpcId: string, body: Record<string, unknown>) => Promise<unknown>
  log: (msg: string) => void
  fs?: typeof nodeFs
  memoryFs?: MemoryFs
  now?: () => number
}

export class LaneMemoryRpcHandler {
  private readonly deps: LaneMemoryRpcDeps
  private readonly stores = new Map<string, ClaudeMemoryStore>()

  constructor(deps: LaneMemoryRpcDeps) {
    this.deps = deps
  }

  private storeFor(userId: string): ClaudeMemoryStore {
    const existing = this.stores.get(userId)
    if (existing) return existing
    const fs = this.deps.fs ?? nodeFs
    const paths = lanePaths({ home: this.deps.home, assistantId: this.deps.assistantId, userId, stateRoot: this.deps.stateRoot })
    let memDir: string | null = null
    const store = createClaudeMemoryStore({
      fs: confinedMemoryFs(this.deps.memoryFs ?? nodeMemoryFs, () => [memDir ?? paths.memoryDir, paths.memoryTrashDir], fs),
      resolve: () => {
        const answer = resolveLaneMemoryFolder(paths, fs)
        memDir = answer.ok ? answer.memDir : null
        return answer
      },
      trashDir: paths.memoryTrashDir,
      now: this.deps.now ?? Date.now,
    })
    this.stores.set(userId, store)
    return store
  }

  async handle(frame: LaneMemoryFrame): Promise<void> {
    const { log } = this.deps
    if (String(frame.assistantId) !== String(this.deps.assistantId)) {
      log(`lane memory_rpc ${frame.rpcId} skipped: frame for agent ${frame.assistantId || 'none'}`)
      return
    }
    const userId = frame.actorUserId
    if (!isSafeLaneUserId(userId) || frame.lane !== personLaneStamp(userId) || !this.deps.accepts(userId)) {
      log(`lane memory_rpc ${frame.rpcId} refused: not a person this daemon answers for`)
      return
    }
    const fs = this.deps.fs ?? nodeFs
    const paths = lanePaths({ home: this.deps.home, assistantId: this.deps.assistantId, userId, stateRoot: this.deps.stateRoot })
    const isWrite = WRITE_OPS.has(frame.op)
    if (isWrite) {
      let claim: ReturnType<typeof claimLaneMemoryWrite>
      try {
        claim = claimLaneMemoryWrite(paths.memoryRpcDir, frame.rpcId, { fs, now: this.deps.now })
      } catch (err) {
        // Without the marker the write cannot be held to once: refuse it.
        log(`lane memory_rpc ${frame.rpcId}: no marker (${String(err)}); not applied`)
        await this.post(frame.rpcId, laneMemoryAnswer(memoryRpcFailure('unavailable', 'this lane cannot record the change right now'), userId))
        return
      }
      if (claim.kind === 'running') {
        log(`lane memory_rpc ${frame.rpcId}: another process holds this write; it answers`)
        return
      }
      if (claim.kind === 'done') {
        log(`lane memory_rpc ${frame.rpcId}: already applied; the first answer is sent again`)
        await this.post(frame.rpcId, claim.result as Record<string, unknown>)
        return
      }
    }
    try {
      await this.deps.postAck(frame.rpcId)
    } catch (err) {
      log(`lane memory_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${String(err)}`)
    }
    let result: MemoryRpcResult
    try {
      result = await runMemoryRpcOp(this.storeFor(userId), frame)
    } catch (err) {
      log(`lane memory_rpc ${frame.op} failed (rpc=${frame.rpcId}): ${String(err)}`)
      result = memoryRpcFailure('write_failed', 'memory operation failed on the agent host')
    }
    const body = laneMemoryAnswer(result, userId)
    if (isWrite) {
      try {
        finishLaneMemoryWrite(paths.memoryRpcDir, frame.rpcId, body, { fs, now: this.deps.now })
      } catch (err) {
        log(`lane memory_rpc ${frame.rpcId}: answer not recorded (${String(err)})`)
      }
    }
    await this.post(frame.rpcId, body)
  }

  private async post(rpcId: string, body: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.postResult(rpcId, body)
    } catch (err) {
      this.deps.log(`lane memory_rpc result failed (rpc=${rpcId}): ${String(err)}`)
    }
  }
}
