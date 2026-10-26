/**
 * doctor_rpc: the owner's agent check up (the HOAI Agent health card's "Run
 * checkup") asks this daemon how it is (BGOS board row 01a16795).
 *
 * WHY THIS FILE EXISTS. The lane was built for Hermes (BGOS #747): the backend
 * (backend/src/integrations/doctor-rpc.service.ts) emits
 * `{ rpcId, op: 'run', payload: {} }` to the pairing room, re emits it ONCE when
 * no ack lands within 1.5 s, gives up with "the agent host did not respond"
 * when no ack lands within 10 s, and with a timeout report when no result
 * lands within 75 s. The app offers the check up for every paired agent, and
 * up to 0.74.0 this daemon had no handler, so every Claude Code check up was
 * that silence while the agent was online.
 *
 * The answers go to POST integrations/doctor-rpc/:rpcId/ack and /result. The
 * result body is `{ ok: true, payload: { result: 'ok' | 'fail', checks } }` or
 * `{ ok: false, error: { code, message } }`, validated by the backend's
 * DoctorRpcResultDto: a check's name at most 64, detail and fix at most 400,
 * at most 24 checks, status OK, WARN or FAIL, code at most 64, message at
 * most 300. A body over any of them is a 400, which is the same silence as no
 * answer, so every answer is cut to fit here.
 *
 * The rules, in order:
 *  1. A frame with no rpcId cannot be answered, so it is dropped. Anything
 *     with one is answered, an unknown op included, so a future backend
 *     change fails loudly instead of timing out.
 *  2. A frame that names another agent gets NOTHING, not even an ack: several
 *     daemons can share one pairing room and the first result wins. A frame
 *     that names no agent (the backend today) is answered by the lock holder
 *     (server.ts registers the lane through whenArmed).
 *  3. A re sent frame never runs the checks twice: an id still running is
 *     ignored, an id already answered gets the same answer again while it is
 *     held (the backend's own result deadline), nothing after.
 *  4. The ack is best effort and must not stop the result.
 *  5. A result is ALWAYS posted. A throw answers doctor_failed.
 *  6. The checks run no child process and touch no network: they are read
 *     from what this daemon already tracks for its heartbeat (the Claude login
 *     and usage watchers, the running and staged versions, the home check).
 *     `hoai doctor` on the computer stays the deep check; it starts a second
 *     daemon for its handshake row, which must never happen from in here.
 *
 * Every text is one line and dash free (en and em dashes become hyphens).
 */

import type { ClaudeLoginState } from './claude-login.ts'
import type { RestingEpisode } from './resting.ts'

export type DoctorCheckStatus = 'OK' | 'WARN' | 'FAIL'

export type DoctorCheck = {
  name: string
  status: DoctorCheckStatus
  detail: string
  fix?: string
}

export type DoctorRpcFrame = {
  rpcId: string
  op: string
  /** The agent the frame names, or '' when it names none (the backend today). */
  assistantId: string
}

export type DoctorRpcResult =
  | { ok: true; payload: { result: 'ok' | 'fail'; checks: DoctorCheck[] } }
  | { ok: false; error: { code: string; message: string } }

export type DoctorRpcDeps = {
  /** This daemon's own agent, read per frame. Empty means unknown: answer nothing. */
  assistantId: () => string
  /** The rows, read from the daemon's own state when the frame arrives. */
  runChecks: () => Promise<DoctorCheck[]>
  postAck: (rpcId: string) => Promise<unknown>
  postResult: (rpcId: string, body: DoctorRpcResult) => Promise<unknown>
  log: (msg: string) => void
  /** Runs `run` once, `ms` from now, without keeping the process alive. */
  schedule?: (run: () => void, ms: number) => void
}

/** The backend's RESULT_TIMEOUT_MS: past it an answer is dropped as late. */
export const DOCTOR_RPC_ANSWER_HOLD_MS = 75_000
export const DOCTOR_RPC_SEEN_MAX = 64
export const DOCTOR_RPC_CHECKS_MAX = 24
export const DOCTOR_RPC_NAME_MAX = 64
export const DOCTOR_RPC_DETAIL_MAX = 400
export const DOCTOR_RPC_CODE_MAX = 64
export const DOCTOR_RPC_MESSAGE_MAX = 300

const STATUSES: readonly DoctorCheckStatus[] = ['OK', 'WARN', 'FAIL']

/** The en and em dash, built from code points so no source file carries either. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, 'g')

/** One line, dash free, cut to `max` with an ellipsis. */
export function oneDoctorLine(text: unknown, max: number): string {
  const line = String(text ?? '')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? line.slice(0, max - 3).trimEnd() + '...' : line
}

/** The frame, or null when it cannot be answered (no string rpcId). */
export function normalizeDoctorRpc(raw: unknown): DoctorRpcFrame | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.rpcId !== 'string' || !r.rpcId) return null
  return {
    rpcId: r.rpcId,
    op: typeof r.op === 'string' ? r.op : '',
    assistantId:
      typeof r.assistantId === 'string' || typeof r.assistantId === 'number' ? String(r.assistantId).trim() : '',
  }
}

function failure(code: string, message: string): DoctorRpcResult {
  return {
    ok: false,
    error: {
      code: oneDoctorLine(code, DOCTOR_RPC_CODE_MAX) || 'doctor_failed',
      message: oneDoctorLine(message, DOCTOR_RPC_MESSAGE_MAX) || 'The check up could not run on the agent host.',
    },
  }
}

/** Cut every row to the backend DTO; an unknown status reads as WARN. */
export function fitDoctorChecks(checks: readonly DoctorCheck[]): DoctorCheck[] {
  return checks.slice(0, DOCTOR_RPC_CHECKS_MAX).map((c) => {
    const status = STATUSES.includes(c?.status) ? c.status : 'WARN'
    const fix = oneDoctorLine(c?.fix, DOCTOR_RPC_DETAIL_MAX)
    return {
      name: oneDoctorLine(c?.name, DOCTOR_RPC_NAME_MAX) || 'Check',
      status,
      detail: oneDoctorLine(c?.detail, DOCTOR_RPC_DETAIL_MAX),
      ...(fix ? { fix } : {}),
    }
  })
}

type Answered = { state: 'done'; result: DoctorRpcResult | null }
type Seen = { state: 'running' } | Answered

function scheduleUnref(run: () => void, ms: number): void {
  const timer = setTimeout(run, ms) as { unref?: () => unknown }
  timer.unref?.()
}

export class DoctorRpcHandler {
  private readonly deps: DoctorRpcDeps
  private readonly seen = new Map<string, Seen>()

  constructor(deps: DoctorRpcDeps) {
    this.deps = deps
  }

  async handle(frame: DoctorRpcFrame): Promise<void> {
    if (!frame?.rpcId) return
    const own = String(this.deps.assistantId() ?? '').trim()
    if (!own) {
      this.deps.log(`doctor_rpc ${frame.rpcId} skipped: this daemon does not know its agent`)
      return
    }
    if (frame.assistantId && frame.assistantId !== own) {
      this.deps.log(`doctor_rpc ${frame.rpcId} skipped: frame for agent ${frame.assistantId}, this daemon ${own}`)
      return
    }

    const earlier = this.seen.get(frame.rpcId)
    if (earlier?.state === 'running') {
      this.deps.log(`doctor_rpc duplicate frame ignored while it runs (rpc=${frame.rpcId})`)
      return
    }
    if (earlier?.state === 'done') {
      if (earlier.result) await this.post(frame.rpcId, earlier.result)
      return
    }
    this.remember(frame.rpcId, { state: 'running' })

    try {
      await this.deps.postAck(frame.rpcId)
    } catch (err) {
      this.deps.log(`doctor_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${errorText(err)}`)
    }

    let result: DoctorRpcResult
    try {
      result = await this.run(frame)
    } catch (err) {
      this.deps.log(`doctor_rpc failed (rpc=${frame.rpcId}): ${errorText(err)}`)
      result = failure('doctor_failed', 'The check up could not run on the agent host.')
    }
    const entry: Answered = { state: 'done', result }
    this.seen.set(frame.rpcId, entry)
    const schedule = this.deps.schedule ?? scheduleUnref
    schedule(() => {
      entry.result = null
    }, DOCTOR_RPC_ANSWER_HOLD_MS)
    await this.post(frame.rpcId, result)
  }

  private async run(frame: DoctorRpcFrame): Promise<DoctorRpcResult> {
    if (frame.op !== 'run') return failure('unsupported', 'This check up operation is not supported by this connector.')
    const checks = fitDoctorChecks(await this.deps.runChecks())
    const result = checks.some((c) => c.status === 'FAIL') ? 'fail' : 'ok'
    this.deps.log(
      `doctor_rpc answered (rpc=${frame.rpcId}, result=${result}, rows=${checks.length}, ` +
        `warn=${checks.filter((c) => c.status === 'WARN').length}, fail=${checks.filter((c) => c.status === 'FAIL').length})`,
    )
    return { ok: true, payload: { result, checks } }
  }

  private remember(rpcId: string, state: Seen): void {
    this.seen.delete(rpcId)
    this.seen.set(rpcId, state)
    while (this.seen.size > DOCTOR_RPC_SEEN_MAX) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }

  private async post(rpcId: string, result: DoctorRpcResult): Promise<void> {
    try {
      await this.deps.postResult(rpcId, result)
    } catch (err) {
      this.deps.log(`doctor_rpc result failed (rpc=${rpcId}): ${errorText(err)}`)
    }
  }
}

function errorText(err: unknown): string {
  return oneDoctorLine(err instanceof Error ? err.message : String(err), 200) || 'unknown error'
}

// ── The rows ─────────────────────────────────────────────────────────────────

/** What this daemon already knows, read when the frame arrives. */
export type DoctorFacts = {
  now: number
  /** The version this process runs, or null when it could not be read. */
  runningVersion: string | null
  /** A newer version installed and waiting for a restart, else null. */
  pendingRestartVersion: string | null
  /** True while this daemon is draining to hand over to an update. */
  updateDraining: boolean
  assistantId: string
  /** The home check passed (a pin, a match, an override). */
  homeConfirmed: boolean
  /** lib/claude-login.ts, the state the heartbeat reports. */
  login: ClaudeLoginState
  /** lib/resting.ts, the usage cap episode the heartbeat reports. */
  resting: RestingEpisode | null
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 2) return 'just now'
  if (minutes < 120) return `${minutes} minutes ago`
  return `${Math.round(minutes / 60)} hours ago`
}

/**
 * The rows, in the order the owner reads them. Pure: the same facts give the
 * same rows. A FAIL is something that keeps the agent from answering and has
 * a fix the owner can do; a WARN is worth knowing and fixes itself or needs
 * nothing.
 */
export function buildDoctorChecks(f: DoctorFacts): DoctorCheck[] {
  const rows: DoctorCheck[] = []
  const version = f.runningVersion ?? 'an unknown version'

  rows.push({
    name: 'Connection',
    status: 'OK',
    detail: `Agent ${f.assistantId} is connected to HOAI and answered this check up.`,
  })

  if (f.updateDraining) {
    rows.push({
      name: 'Connector',
      status: 'WARN',
      detail: `Version ${version} is handing over to an update right now.`,
      fix: 'Wait a minute and run the check up again.',
    })
  } else if (f.pendingRestartVersion && f.pendingRestartVersion !== f.runningVersion) {
    rows.push({
      name: 'Connector',
      status: 'WARN',
      detail: `Running ${version}; version ${f.pendingRestartVersion} is installed and starts on the next restart.`,
      fix: 'Restart the agent, or wait for its next restart.',
    })
  } else {
    rows.push({ name: 'Connector', status: 'OK', detail: `Running version ${version}.` })
  }

  rows.push(
    f.homeConfirmed
      ? { name: 'Agent folder', status: 'OK', detail: "This session runs in the agent's own folder." }
      : {
          name: 'Agent folder',
          status: 'WARN',
          detail: "This session's folder is not confirmed as the agent's home yet, so its memory, skills and changes are not shown.",
          fix: "Start the agent from its own folder (the one HOAI set it up in), or run hoai doctor there.",
        },
  )

  if (f.login.failing) {
    const since = f.login.since !== null ? ` (first seen ${ago(f.now - f.login.since)})` : ''
    rows.push({
      name: 'Claude login',
      status: 'FAIL',
      detail: `Claude Code says: ${f.login.text ?? 'the login failed'}${since}. The agent cannot answer until it signs in again.`,
      fix: 'On this computer, open the agent in a terminal and type /login, or run claude auth login. Every agent sharing this login comes back.',
    })
  } else {
    rows.push({
      name: 'Claude login',
      status: 'OK',
      detail: "No login failure in this agent's recent work.",
    })
  }

  if (f.resting) {
    const when = f.resting.synthetic ? `about ${f.resting.resetAt}` : f.resting.resetAt
    rows.push({
      name: 'Claude usage',
      status: 'WARN',
      detail: `The Claude usage limit was reached; the agent rests until ${when} (UTC).`,
      fix: 'Wait for the reset, or raise the plan limit on claude.ai.',
    })
  } else {
    rows.push({ name: 'Claude usage', status: 'OK', detail: 'No usage limit reached.' })
  }

  return rows
}
