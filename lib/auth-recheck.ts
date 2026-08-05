/**
 * auth-recheck: slow re-resolution of the boot-time credential decision,
 * visibility only (peer-871-4).
 *
 * The daemon resolves auth exactly ONCE at startup (server.ts freezes AUTH),
 * and the boot log line then masquerades as current truth for the whole
 * process lifetime. On kc-server an agent kept printing a pairing-file
 * resolution from a boot that preceded TWO rewrites of the file underneath
 * it. This module re-runs the same pure resolveCredentialsPath + resolveAuth
 * logic on a slow cadence, compares the OUTCOME (mode, source, assistantId,
 * token identity via a non-secret fingerprint) against what boot resolved,
 * and formats ONE structured WARN per distinct divergence - including the
 * AGE of the divergence (how long ago the underlying file mtime changed) -
 * plus a recovery line if the resolution reverts.
 *
 * NO behavior change: the running process keeps whatever boot resolved.
 * Never logs or carries a token; identity comparison uses the first 8 hex
 * chars of a sha256 only.
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { ResolvedAuth } from './agent-credentials.js'

/** Re-check cadence: every 10 minutes by default, env-tunable. */
export const AUTH_RECHECK_DEFAULT_INTERVAL_MS = 600_000
/** Floor so a mis-set env value can never hot-loop stat+parse. */
export const AUTH_RECHECK_MIN_INTERVAL_MS = 5_000

/** The compared OUTCOME of a credential resolution. Secret-free by design. */
export interface AuthSnapshot {
  mode: string
  source: string
  assistantId: string
  /** The credentials path resolveCredentialsPath selected at snapshot time. */
  credentialsPath: string
  /** Non-secret token identity: sha256 first 8 hex chars, or 'none'. */
  tokenFingerprint: string
}

/** Non-secret identity for a secret: first 8 hex chars of its sha256. */
export function tokenFingerprint(secret: string): string {
  if (!secret) return 'none'
  return createHash('sha256').update(secret).digest('hex').slice(0, 8)
}

/** Snapshot the compared outcome of a ResolvedAuth. Never stores the secret. */
export function authSnapshot(auth: ResolvedAuth, credentialsPath: string): AuthSnapshot {
  return {
    mode: auth.mode,
    source: auth.source,
    assistantId: auth.assistantId,
    credentialsPath,
    tokenFingerprint: tokenFingerprint(auth.pairingToken || auth.apiKey),
  }
}

/**
 * Human age of a divergence from the underlying file's mtime delta, or the
 * explicit unknown wording when no mtime could be read.
 */
export function formatAge(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs)) return 'at an unknown time'
  const ms = Math.max(0, ageMs)
  const s = ms / 1000
  if (s < 90) return `${Math.round(s)}s ago`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m ago`
  const h = m / 60
  if (h < 48) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * Interval resolution: BGOS_AUTH_RECHECK_INTERVAL_MS in ms; '0' or 'off'
 * disables; garbage falls back to the default; positive values clamp to the
 * floor. Pure so the policy is testable.
 */
export function resolveAuthRecheckIntervalMs(
  env: Record<string, string | undefined>,
): number {
  const raw = (env.BGOS_AUTH_RECHECK_INTERVAL_MS ?? '').trim()
  if (!raw) return AUTH_RECHECK_DEFAULT_INTERVAL_MS
  if (raw.toLowerCase() === 'off') return 0
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return AUTH_RECHECK_DEFAULT_INTERVAL_MS
  if (parsed <= 0) return 0
  return Math.max(AUTH_RECHECK_MIN_INTERVAL_MS, Math.floor(parsed))
}

/** 'pairing-file credentials-871.json for assistant 871', 'apikey-env for assistant 871', ... */
function describeResolution(s: AuthSnapshot): string {
  const where =
    s.source === 'pairing-file'
      ? `pairing-file ${basename(s.credentialsPath)}`
      : s.source
  return `${where} for assistant ${s.assistantId || '<missing>'}`
}

/** Identity key of an outcome: any field change is a distinct state. */
function snapshotKey(s: AuthSnapshot): string {
  return [s.mode, s.source, s.assistantId, s.credentialsPath, s.tokenFingerprint].join('\u0000')
}

/**
 * Once-per-distinct-state divergence monitor. evaluate() returns the log
 * line to emit (a WARN on a newly seen divergent state, a recovery line when
 * the resolution reverts to the boot outcome) or null for silence. The
 * caller owns actual logging and NEVER changes running auth.
 */
export class AuthRecheckMonitor {
  private readonly bootKey: string
  /** Key of the divergent state already warned about; null = in sync. */
  private reportedKey: string | null = null

  constructor(private readonly boot: AuthSnapshot) {
    this.bootKey = snapshotKey(boot)
  }

  evaluate(
    current: AuthSnapshot,
    fileMtimeMs: number | null,
    nowMs: number,
  ): string | null {
    const key = snapshotKey(current)
    if (key === this.bootKey) {
      if (this.reportedKey === null) return null
      this.reportedKey = null
      return (
        'credentials resolution recovered: current resolution again matches ' +
        `boot (${describeResolution(this.boot)})`
      )
    }
    if (key === this.reportedKey) return null
    this.reportedKey = key
    const age =
      fileMtimeMs == null ? formatAge(null) : formatAge(nowMs - fileMtimeMs)
    const fpPart =
      current.tokenFingerprint !== this.boot.tokenFingerprint
        ? `; token fp ${this.boot.tokenFingerprint} -> ${current.tokenFingerprint}`
        : ''
    return (
      `WARN credentials resolution changed underneath this process ${age}: ` +
      `boot resolved ${describeResolution(this.boot)}, now resolves ` +
      `${describeResolution(current)}${fpPart}; the running session keeps ` +
      'its boot auth; restart to adopt the new resolution'
    )
  }
}
