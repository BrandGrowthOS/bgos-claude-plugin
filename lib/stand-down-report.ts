/**
 * Stand-down reports (identity race plan step 3, board row fc75c7c3, 0.65.3).
 *
 * A daemon that refuses, exits, goes passive or switches a duty off used to
 * tell only its own log. The backend can now hear it (BGOS #2189): POST
 * /api/v1/integrations/stand-downs under the pairing token, a body of exactly
 * six fields, 204. That is what lets the owner see a stray standing down, and
 * what counts the agents still answering by elimination before anyone retires
 * that route.
 *
 * PRIVACY BY CONSTRUCTION, the backend's rule. A report is tokens and nothing
 * else: one of eight reasons, one of six routes, boot or run, the machine id the
 * heartbeat already sends, the plugin version and the time. No field can carry
 * a folder, file name, command, pid, session id, error text or token, and the
 * log lines here are tokens too. A value off the contract is never sent: the
 * backend would 400 it, and a 400 is the plugin's bug, not a reason to retry.
 *
 * NEVER IN THE WAY. A report is fire and forget: one attempt, bounded at 2 s
 * (headers and body), never retried (not a 400, not a 401, not anything), never
 * redirected (a 3xx would carry the token elsewhere), and it never throws. At
 * most one report per (reason, phase) per process: the dedupe is the rate
 * limit, so a lock that flaps all day sends one lock_lost per phase. After a
 * 401 the token is refused, so nothing more is sent at all. A site with no
 * pairing credentials (unpaired, or an API key install, which has no pairing to
 * report under) sends nothing.
 *
 * AN EXIT SITE BLOCKS (reportSync). The uncaught exception handler and main()
 * failing used to exit at once. Waiting for a fetch would leave the event loop
 * running for up to 2 s past an unknown fault: an in-flight poll could forward
 * and advance cursors, an arm could finish and re-arm. So an exit site sends
 * from a child process and blocks on it (spawnSync, 2 s at most, token on
 * stdin, never on the command line), and nothing else in the daemon runs
 * between the fault and the exit.
 *
 * The token lists are the backend's, copied from BGOS
 * backend/src/integrations/stand-down-contract.ts (#2189, 56e1156) and pinned
 * by test/stand-down-report.test.ts, so a drift on either side goes red there.
 */
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process'

import { boundedFetch, isFetchTimeoutError, type BoundedFetchFn } from './bounded-fetch.ts'
import { MACHINE_ID_RE } from './machine-id.mjs'

/** The eight reasons, one per class of site in server.ts. */
export const STAND_DOWN_REASONS = [
  'refuse_home_mismatch',
  'passive_at_boot',
  'lock_lost',
  'arm_failed',
  'exit_uncaught',
  'exit_boot_fatal',
  'always_on_unsupported',
  'always_on_supervisor_missing',
] as const
export type StandDownReason = (typeof STAND_DOWN_REASONS)[number]

/**
 * How a daemon found the identity it runs as: the resolver's `via`
 * (lib/agent-credentials.ts CredentialsVia), plus `unknown`. The FINE route,
 * never the pairing lock's three words (pin, env, elimination): the backend
 * counts `sole-per-assistant` and `legacy` apart.
 */
export const IDENTITY_ROUTES = [
  'env-path',
  'env-assistant',
  'folder-pin',
  'sole-per-assistant',
  'legacy',
  'unknown',
] as const
export type ReportedIdentityRoute = (typeof IDENTITY_ROUTES)[number]

/** Before the daemon first armed delivery, or after. */
export const STAND_DOWN_PHASES = ['boot', 'run'] as const
export type StandDownPhase = (typeof STAND_DOWN_PHASES)[number]

/** The only keys a report body carries, in this order. */
export const STAND_DOWN_BODY_KEYS = ['reason', 'route', 'phase', 'machineId', 'pluginVersion', 'at'] as const

/** The backend's STAND_DOWN_VERSION_REGEX (bounded, unlike the heartbeat's). */
export const STAND_DOWN_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}[-\w.]{0,20}$/

/** The backend's report timestamp shape (stand-down.dto.ts). */
const STAND_DOWN_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

/** The route, under the API base. */
export const STAND_DOWN_PATH = 'integrations/stand-downs'

/** One attempt, at most this long, headers and body. */
export const STAND_DOWN_REPORT_TIMEOUT_MS = 2000

const listed = (list: readonly string[], value: unknown): value is string =>
  typeof value === 'string' && list.includes(value)

/** The resolver's `via` as the backend's route; anything else is `unknown`. */
export function reportedIdentityRoute(via: unknown): ReportedIdentityRoute {
  return listed(IDENTITY_ROUTES, via) ? (via as ReportedIdentityRoute) : 'unknown'
}

export interface StandDownBody {
  reason: StandDownReason
  route: ReportedIdentityRoute
  phase: StandDownPhase
  machineId: string
  pluginVersion: string
  at: string
}

/**
 * The body, or the name of the first field the backend would refuse. Every
 * value is checked against the contract, so nothing the backend would 400 is
 * ever put on the wire.
 */
export function buildStandDownBody(input: {
  reason: unknown
  route: unknown
  phase: unknown
  machineId: unknown
  pluginVersion: unknown
  at: unknown
}): { body: StandDownBody } | { invalid: (typeof STAND_DOWN_BODY_KEYS)[number] } {
  if (!listed(STAND_DOWN_REASONS, input.reason)) return { invalid: 'reason' }
  if (!listed(IDENTITY_ROUTES, input.route)) return { invalid: 'route' }
  if (!listed(STAND_DOWN_PHASES, input.phase)) return { invalid: 'phase' }
  if (typeof input.machineId !== 'string' || !MACHINE_ID_RE.test(input.machineId)) return { invalid: 'machineId' }
  if (
    typeof input.pluginVersion !== 'string' ||
    input.pluginVersion.length > 32 ||
    !STAND_DOWN_VERSION_RE.test(input.pluginVersion)
  ) {
    return { invalid: 'pluginVersion' }
  }
  if (typeof input.at !== 'string' || input.at.length > 40 || !STAND_DOWN_AT_RE.test(input.at)) return { invalid: 'at' }
  return {
    body: {
      reason: input.reason as StandDownReason,
      route: input.route as ReportedIdentityRoute,
      phase: input.phase as StandDownPhase,
      machineId: input.machineId,
      pluginVersion: input.pluginVersion,
      at: input.at,
    },
  }
}

/** `<backendUrl>/api/v1/integrations/stand-downs`, the API base built as server.ts builds it. */
export function standDownUrl(backendUrl: string): string | null {
  const base = backendUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return null
  return `${base.endsWith('/api/v1') ? base : `${base}/api/v1`}/${STAND_DOWN_PATH}`
}

/** The pairing credential a report goes under, or null for anything else. */
export function pairingCredential(auth: {
  mode: string
  backendUrl: string
  pairingToken: string
}): { backendUrl: string; pairingToken: string } | null {
  if (auth.mode !== 'pairing' || !auth.pairingToken || !auth.backendUrl) return null
  return { backendUrl: auth.backendUrl, pairingToken: auth.pairingToken }
}

export interface StandDownReporterDeps {
  /** The pairing token and backend, as the heartbeat sends them; null sends nothing. */
  credentials: () => { backendUrl: string; pairingToken: string } | null
  /** How this daemon found its identity (normalized: anything unlisted is `unknown`). */
  route: unknown
  /** The machine id the heartbeat sends (~/.bgos-agent/machine-id), read, not minted. */
  machineId: () => string
  /** The running version (lib/version-heartbeat.ts readOwnVersion), read ONCE, here. */
  pluginVersion: () => string | null
  /** One line per report, tokens only. */
  log?: (line: string) => void
  fetchImpl?: BoundedFetchFn<Response>
  now?: () => number
  timeoutMs?: number
  /** The exit path's sender: the runtime this daemon runs on, and spawnSync. */
  execPath?: string
  spawnSyncImpl?: (command: string, args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<string>
}

export interface StandDownReporter {
  /** Fire and forget: resolves within the deadline, never rejects. */
  report(reason: StandDownReason, phase: StandDownPhase): Promise<void>
  /** For an exit site: blocks until the report is in, 2 s at most, never throws. */
  reportSync(reason: StandDownReason, phase: StandDownPhase): void
}

/**
 * The exit path's child: reads {url, token, body, timeoutMs} as JSON on stdin,
 * POSTs once with no redirect, prints the HTTP status and nothing else (to a
 * pipe the parent reads, never the daemon's own stdout), and exits.
 */
const SYNC_SENDER = [
  "let raw = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (c) => (raw += c))",
  "process.stdin.on('end', () => {",
  '  let job',
  '  try { job = JSON.parse(raw) } catch { process.exit(3) }',
  '  const ac = new AbortController()',
  '  setTimeout(() => { try { ac.abort() } catch {} process.exit(2) }, job.timeoutMs)',
  '  fetch(job.url, {',
  "    method: 'POST',",
  "    headers: { 'Content-Type': 'application/json', 'X-BGOS-Pairing': job.token },",
  '    body: JSON.stringify(job.body),',
  "    redirect: 'error',",
  '    signal: ac.signal,',
  '  }).then(',
  '    (r) => process.stdout.write(String(r.status), () => process.exit(0)),',
  '    () => process.exit(1),',
  '  )',
  '})',
].join('\n')

export function createStandDownReporter(deps: StandDownReporterDeps): StandDownReporter {
  const route = reportedIdentityRoute(deps.route)
  const timeoutMs = deps.timeoutMs ?? STAND_DOWN_REPORT_TIMEOUT_MS
  const read = <T>(provider: () => T): T | null => {
    try {
      return provider()
    } catch {
      return null
    }
  }
  // Once, at boot: a clone updated in place must still report the version
  // that is RUNNING, as the heartbeat does.
  const pluginVersion = read(deps.pluginVersion)
  // (reason, phase) pairs already attempted, whatever came of them.
  const attempted = new Set<string>()
  // A 401 means the backend refused this token: nothing more is worth sending.
  let refused = false
  const say = (line: string): void => {
    try {
      deps.log?.(line)
    } catch {}
  }
  /** The request, or null (and one line saying why) when nothing may be sent. */
  const prepare = (
    reason: StandDownReason,
    phase: StandDownPhase,
  ): { what: string; url: string; token: string; body: StandDownBody } | null => {
    const what = `stand-down ${reason} (${phase})`
    if (!listed(STAND_DOWN_REASONS, reason) || !listed(STAND_DOWN_PHASES, phase)) return null
    const key = `${reason}:${phase}`
    if (refused || attempted.has(key)) return null
    attempted.add(key)
    const credential = read(deps.credentials)
    const url = credential ? standDownUrl(credential.backendUrl) : null
    if (!credential || !credential.pairingToken || !url) {
      say(`${what} not sent: no pairing credentials`)
      return null
    }
    const built = buildStandDownBody({
      reason,
      route,
      phase,
      machineId: read(deps.machineId),
      pluginVersion,
      at: new Date((deps.now ?? Date.now)()).toISOString(),
    })
    if ('invalid' in built) {
      say(`${what} not sent: no valid ${built.invalid}`)
      return null
    }
    return { what, url, token: credential.pairingToken, body: built.body }
  }
  const outcome = (what: string, status: number): void => {
    if (status === 401) refused = true
    say(
      status >= 200 && status < 300 ? `${what} reported (HTTP ${status})` : `${what} not taken (HTTP ${status}), not retried`,
    )
  }
  const timedOut = (what: string) => `${what} got no answer within ${timeoutMs} ms, not retried`
  const failed = (what: string) => `${what} could not be sent, not retried`

  const send = async (job: NonNullable<ReturnType<typeof prepare>>): Promise<void> => {
    try {
      const status = await boundedFetch(
        {
          url: job.url,
          init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-BGOS-Pairing': job.token },
            body: JSON.stringify(job.body),
            redirect: 'error',
          },
          timeoutMs,
          label: `POST ${STAND_DOWN_PATH}`,
        },
        async (response) => {
          // Drain inside the deadline so the socket is freed; the text is never read.
          try {
            await response.arrayBuffer()
          } catch {}
          return response.status
        },
        { fetchImpl: deps.fetchImpl },
      )
      outcome(job.what, status)
    } catch (err) {
      say(isFetchTimeoutError(err) ? timedOut(job.what) : failed(job.what))
    }
  }

  const sendSync = (job: NonNullable<ReturnType<typeof prepare>>): void => {
    try {
      const run = deps.spawnSyncImpl ?? (spawnSync as NonNullable<StandDownReporterDeps['spawnSyncImpl']>)
      const result = run(deps.execPath ?? process.execPath, ['-e', SYNC_SENDER], {
        input: JSON.stringify({ url: job.url, token: job.token, body: job.body, timeoutMs }),
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1024,
      })
      const printed = String(result?.stdout ?? '').trim()
      if (/^\d{3}$/.test(printed)) return outcome(job.what, Number(printed))
      const tooLong = (result?.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || result?.status === 2
      say(tooLong ? timedOut(job.what) : failed(job.what))
    } catch {
      say(failed(job.what))
    }
  }

  return {
    report(reason, phase) {
      try {
        const job = prepare(reason, phase)
        return job ? send(job).catch(() => {}) : Promise.resolve()
      } catch {
        return Promise.resolve()
      }
    },
    reportSync(reason, phase) {
      try {
        const job = prepare(reason, phase)
        if (job) sendSync(job)
      } catch {}
    },
  }
}

/**
 * Wait for `pending`, but never longer than `timeoutMs`, and never throw: what
 * an exit site awaits before it exits. The timer is deliberately NOT unref'd,
 * so the process lives until the report settles or the deadline passes, and
 * then the caller exits.
 */
export function settleWithin(pending: Promise<unknown>, timeoutMs = STAND_DOWN_REPORT_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    Promise.resolve(pending).then(done, done)
  })
}
