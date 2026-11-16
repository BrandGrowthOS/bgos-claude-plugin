/**
 * credentials-restore: a daemon writes back the credentials file it booted from when that file is
 * lost and the pairing token it still holds is still good (stability, 2026-11-14).
 *
 * THE INCIDENT. 2026-11-13: an accident deleted ~/.bgos-agent/credentials-<id>.json for every agent
 * on a Mac. Every daemon kept running on the pairing token in memory (server.ts resolves AUTH once
 * at boot), so nothing looked wrong. But a restart of any of them would have come up unpaired, and
 * the Helper reads a missing file as "agent not on this machine" and refuses its check up. Recovery
 * took a token rotation per agent, by hand.
 *
 * THE FIX. On the auth recheck cadence (lib/auth-recheck.ts, every 10 minutes, plus the file watch
 * on the boot credentials path) the daemon checks that file still exists. When it is gone, it asks
 * the backend whether the token it holds still serves this agent: GET integrations/me must answer
 * 200 AND list this assistant. Only then does it write the file back, with bgos-pair's own
 * writeCredentialsFile (folder 0700, file 0600, the Windows ACL lock), in the shape bgos-pair
 * writes, and log ONE WARN naming the path. It posts nothing to chat.
 *
 * WHAT IT NEVER DOES.
 *   - Overwrite: the write is an exclusive create, so a re-pair that lands while the token check is
 *     in flight wins and the daemon's older copy is dropped.
 *   - Write on a failing token: a 401, a 5xx, no answer, or a 200 that does not list this assistant
 *     (an agent deleted from a pairing that serves others) writes nothing.
 *   - Write another assistant's file: the path must be this agent's own credentials-<id>.json, or
 *     the explicit BGOS_CREDENTIALS_PATH whose name does not name another assistant. The shared
 *     credentials.json is never restored: bgos-pair deletes it ON PURPOSE when it moves an agent to
 *     its own file (dedupeLegacyAfterWrite), and putting it back changes how other agents resolve.
 *   - Log a secret: the lines carry the path and the assistant id, never the token.
 *
 * The body is the boot file as read, with the token the daemon holds. A copy seen on disk after boot
 * replaces it only while it still holds that same token for this same assistant (a home a pinned
 * start confirmed, confirmHomeDir), never a newer pairing's fields.
 */

import { basename } from 'node:path'
import type { CredentialsFile, ResolvedAuth } from './agent-credentials.js'

export type RestoreEligibility = { kind: 'eligible' } | { kind: 'ineligible'; reason: string }

/** Outcome of one check, for the caller and the tests. Only 'restored' wrote anything. */
export type RestoreOutcome =
  | 'ineligible'
  | 'present'
  | 'busy'
  | 'token-refused'
  | 'raced'
  | 'restored'
  | 'write-failed'

export interface CredentialsRestoreDeps {
  /** The credentials file this daemon booted from (server.ts CREDENTIALS_PATH). */
  path: string
  /** How boot selected it (resolveCredentialsSelection's via). */
  via: string
  /** The auth this daemon booted with and still runs on. */
  auth: ResolvedAuth
  /** The file as boot read it. */
  bootCreds: CredentialsFile | null
  exists: (path: string) => boolean
  readCreds: (path: string) => CredentialsFile | null
  /** GET integrations/me with the in-memory pairing token, fresh (never a cached 304). */
  probeMe: () => Promise<{ status: number; body: unknown }>
  /** Exclusive create (bgos-pair writeCredentialsFile with exclusive: true); rejects EEXIST when present. */
  writeExclusive: (path: string, creds: CredentialsFile) => Promise<void>
  log: (line: string) => void
  /** Clock for the back-off; Date.now by default. */
  now?: () => number
}

/**
 * After a refused or unanswered token check, the backend is not asked again for this long. The
 * folder watch stirs on every lock heartbeat beside the file (every 5 s per agent) while the file
 * is missing; without this a revoked token would mean an integrations/me call every few seconds.
 */
export const RESTORE_RETRY_AFTER_REFUSAL_MS = 60_000

function str(value: unknown): string {
  return value == null ? '' : String(value)
}

/**
 * May this daemon ever write its boot credentials path back? Decided once, from what boot knew.
 * Pure: the path's name, the selection route and the boot auth.
 */
export function restoreEligibility(input: {
  path: string
  via: string
  auth: ResolvedAuth
}): RestoreEligibility {
  const { auth } = input
  if (auth.mode !== 'pairing' || auth.source !== 'pairing-file') {
    return { kind: 'ineligible', reason: `booted from ${auth.source}, not a pairing file` }
  }
  if (!auth.pairingToken) return { kind: 'ineligible', reason: 'no pairing token in memory' }
  const id = str(auth.assistantId).trim()
  if (!/^\d+$/.test(id)) return { kind: 'ineligible', reason: 'no assistant id' }
  const named = /^credentials-(\d+)\.json$/.exec(basename(input.path))?.[1]
  if (named && named !== id) {
    return { kind: 'ineligible', reason: `the file names assistant ${named}, this daemon is ${id}` }
  }
  if (named === id) return { kind: 'eligible' }
  if (input.via === 'env-path') return { kind: 'eligible' }
  return { kind: 'ineligible', reason: 'the shared credentials.json is never restored' }
}

/** Does an integrations/me answer vouch that the token still serves this assistant? */
export function meVouchesFor(status: number, body: unknown, assistantId: string): boolean {
  if (status !== 200) return false
  const list = body && typeof body === 'object' ? (body as { assistants?: unknown }).assistants : undefined
  if (!Array.isArray(list)) return false
  const id = str(assistantId).trim()
  return Boolean(id) && list.some((row) => row && str((row as { assistant_id?: unknown }).assistant_id) === id)
}

/** Same token, same assistant: the only on-disk copy whose fields may be written back. */
function samePairing(creds: CredentialsFile | null | undefined, auth: ResolvedAuth): creds is CredentialsFile {
  return Boolean(
    creds &&
      creds.pairingToken === auth.pairingToken &&
      str(creds.assistantId).trim() === str(auth.assistantId).trim(),
  )
}

/**
 * The body to write: the newest copy of THIS pairing the daemon has seen (boot, or on disk after
 * boot with the same token and assistant), with the token the daemon holds and this assistant's id.
 */
export function restoredCredentials(input: {
  bootCreds: CredentialsFile | null
  lastSeen: CredentialsFile | null
  auth: ResolvedAuth
}): CredentialsFile {
  const { auth } = input
  const base: CredentialsFile = samePairing(input.lastSeen, auth) ? input.lastSeen : (input.bootCreds ?? {})
  const id = str(auth.assistantId).trim()
  return {
    ...base,
    backendUrl: base.backendUrl || auth.backendUrl,
    pairingToken: auth.pairingToken,
    userId: base.userId || auth.userId,
    assistantId: str(base.assistantId).trim() === id ? base.assistantId : Number(id),
  }
}

/**
 * One per daemon. check() is safe to call from the interval and the file watch at once: a second
 * call while one is in flight returns 'busy' and does nothing.
 */
export class CredentialsFileRestorer {
  private readonly eligibility: RestoreEligibility
  private lastSeen: CredentialsFile | null = null
  private running = false
  /** The refusal already logged for the current absence; cleared when the file is present. */
  private reported: string | null = null
  /** When the last refused or failed token check happened; null after a success or a present file. */
  private refusedAtMs: number | null = null

  constructor(private readonly deps: CredentialsRestoreDeps) {
    this.eligibility = restoreEligibility({ path: deps.path, via: deps.via, auth: deps.auth })
  }

  async check(): Promise<RestoreOutcome> {
    if (this.eligibility.kind !== 'eligible') return 'ineligible'
    if (this.running) return 'busy'
    this.running = true
    try {
      return await this.run()
    } finally {
      this.running = false
    }
  }

  private async run(): Promise<RestoreOutcome> {
    const { deps } = this
    const id = str(deps.auth.assistantId).trim()
    if (deps.exists(deps.path)) {
      const seen = deps.readCreds(deps.path)
      if (samePairing(seen, deps.auth)) this.lastSeen = seen
      this.reported = null
      this.refusedAtMs = null
      return 'present'
    }

    const now = (deps.now ?? Date.now)()
    if (this.refusedAtMs !== null && now - this.refusedAtMs < RESTORE_RETRY_AFTER_REFUSAL_MS) {
      return 'token-refused'
    }

    let status = 0
    let body: unknown = null
    let failure = ''
    try {
      ;({ status, body } = await deps.probeMe())
    } catch (err) {
      failure = err instanceof Error ? err.message : str(err)
    }
    if (failure || !meVouchesFor(status, body, id)) {
      const why = failure
        ? `the backend could not be asked (${failure})`
        : status === 200
          ? `integrations/me does not list assistant ${id} for this token`
          : `integrations/me answered ${status}`
      this.refusedAtMs = now
      this.reportOnce(
        `credentials file ${deps.path} is missing and was not restored: ${why}; ` +
          'nothing was written, it is checked again on the next recheck',
      )
      return 'token-refused'
    }

    // The token check took a round trip; a re-pair may have landed meanwhile.
    if (deps.exists(deps.path)) return 'raced'
    const creds = restoredCredentials({ bootCreds: deps.bootCreds, lastSeen: this.lastSeen, auth: deps.auth })
    try {
      await deps.writeExclusive(deps.path, creds)
    } catch (err) {
      if ((err as { code?: unknown })?.code === 'EEXIST') return 'raced'
      this.reportOnce(
        `credentials file ${deps.path} is missing and could not be written back: ` +
          `${err instanceof Error ? err.message : str(err)}`,
      )
      return 'write-failed'
    }
    this.lastSeen = creds
    this.reported = null
    this.refusedAtMs = null
    deps.log(
      `WARN credentials file restored: ${deps.path} was missing; wrote it back (mode 0600) for ` +
        `assistant ${id} from this daemon's pairing token, which integrations/me still accepts, ` +
        'so a restart finds its pairing',
    )
    return 'restored'
  }

  private reportOnce(line: string): void {
    // Keyed on the reason's first words, so a changing error text is not a new report every recheck.
    const key = line.replace(/\(.*$/, '')
    if (this.reported === key) return
    this.reported = key
    this.deps.log(line)
  }
}
