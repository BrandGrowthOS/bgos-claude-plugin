/**
 * agent-verify: prove a restarted agent HEARS the channel (design 7.2,
 * landmine 4). "Connected" is never proof; a wrong launch flag loads the
 * plugin, connects, and still drops every message. The only positive proof
 * is the session ACTING on a channel event, which the daemon records as the
 * channel-live marker (~/.bgos-plugin-state/<id>/channel-live.json,
 * lib/boot-hello.ts: {firstLiveAt, lastLiveAt}) on the first tool call after
 * a boot.
 *
 * After a routine restart nothing triggers that first tool call until the
 * user speaks, so the watcher asks for it silently: it writes
 * ~/.bgos-agent/<id>/probe-requested.json (existence only; the daemon polls
 * it, unlinks it, and pushes ONE liveness_probe notification whose
 * channel_ack tool call flips the marker), re-writing the probe every 30s
 * while it waits. Verification then polls the marker every 3s for up to
 * 120s: Date.parse(lastLiveAt) > restartedAtMs is the proof; the file's
 * mtime is accepted only as secondary evidence when lastLiveAt is
 * unparseable. Timeout -> agent_deaf_after_restart (the executor's rollback
 * path).
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; fs, clock and
 * sleep injected so tests never wait.
 */

import { PROBE_MARKER_FILE_NAME, RESTART_MARKER_FILE_NAME, joinDir } from './agent-inventory.mjs'
import { nodeFs } from './watcher-bundle.mjs'

export const VERIFY_TIMEOUT_MS = 120_000
export const VERIFY_POLL_MS = 3_000
export const PROBE_REWRITE_MS = 30_000

/** Mirror of lib/boot-hello.ts parseLiveMarker: null for absent or junk. */
export function parseLiveMarker(raw) {
  if (raw == null) return null
  try {
    const parsed = JSON.parse(String(raw))
    if (!parsed || typeof parsed !== 'object') return null
    const first = typeof parsed.firstLiveAt === 'string' ? parsed.firstLiveAt : ''
    const last = typeof parsed.lastLiveAt === 'string' ? parsed.lastLiveAt : ''
    const bootedAt = typeof parsed.bootedAt === 'string' && parsed.bootedAt ? parsed.bootedAt : null
    if (!first && !last) return null
    return { firstLiveAt: first || last, lastLiveAt: last || first, ...(bootedAt ? { bootedAt } : {}) }
  } catch {
    return null
  }
}

/**
 * Pure verdict over one observation of the marker.
 * @param {{ raw: string | null, mtimeMs: number | null, restartedAtMs: number }} obs
 * @returns {{ proven: boolean, via: 'lastLiveAt' | 'mtime' | null, lastLiveAt: string | null }}
 */
export function liveMarkerProves({ raw, mtimeMs, restartedAtMs }) {
  const marker = parseLiveMarker(raw)
  const lastLiveAt = marker?.lastLiveAt ?? null
  // A marker stamped with the writer's boot time proves nothing when that
  // daemon booted BEFORE the restart: the old session can still answer a
  // probe during its own teardown (the marker is refreshed on every
  // channel_ack), and a fresh lastLiveAt alone cannot tell the two apart.
  const bootedAtMs = marker?.bootedAt ? Date.parse(marker.bootedAt) : NaN
  if (Number.isFinite(bootedAtMs) && bootedAtMs <= restartedAtMs) {
    return { proven: false, via: null, lastLiveAt }
  }
  const parsedAt = lastLiveAt == null ? NaN : Date.parse(lastLiveAt)
  if (Number.isFinite(parsedAt)) {
    return { proven: parsedAt > restartedAtMs, via: parsedAt > restartedAtMs ? 'lastLiveAt' : null, lastLiveAt }
  }
  // lastLiveAt unparseable (or the file is junk): the mtime is the only evidence.
  if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) && mtimeMs > restartedAtMs) {
    return { proven: true, via: 'mtime', lastLiveAt }
  }
  return { proven: false, via: null, lastLiveAt }
}

/**
 * Wait for the agent to prove it hears the channel after `restartedAtMs`.
 * @param {import('./agent-inventory.mjs').AgentRow | Record<string, any>} agent
 * @param {{ restartedAtMs: number, fs?: import('./watcher-bundle.mjs').WatcherFs,
 *   now?: () => number, sleep?: (ms: number) => Promise<unknown>, timeoutMs?: number,
 *   pollMs?: number, requestProbe?: boolean, probeRewriteMs?: number, log?: (line: string) => void }} deps
 * @returns {Promise<{ ok: boolean, message: string, evidence: { lastLiveAt: string | null,
 *   markerPath: string, probePath: string, mtimeMs: number | null, via: 'lastLiveAt' | 'mtime' | null } }>}
 */
export async function verifyAgent(agent, deps) {
  const restartedAtMs = deps.restartedAtMs
  const fs = deps.fs ?? nodeFs()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = deps.timeoutMs ?? VERIFY_TIMEOUT_MS
  const pollMs = deps.pollMs ?? VERIFY_POLL_MS
  const requestProbe = deps.requestProbe ?? true
  const probeRewriteMs = deps.probeRewriteMs ?? PROBE_REWRITE_MS
  const log = deps.log ?? (() => {})
  const markerPath = agent.liveMarkerPath
  const probePath = joinDir(agent.stateDir, PROBE_MARKER_FILE_NAME)

  const writeProbe = () => {
    if (!requestProbe) return
    try {
      fs.writeFile(probePath, `${JSON.stringify({ requestedAt: new Date(now()).toISOString(), by: 'hoai-watcher' })}\n`)
    } catch (err) {
      log(`[verify ${agent.assistantId}] probe write failed at ${probePath}: ${String(err?.message ?? err)}`)
    }
  }

  const startedAt = now()
  const deadline = startedAt + timeoutMs
  // While the restart marker is still on disk the launcher has not acted,
  // so the OLD daemon may eat this first probe during its teardown (its
  // own ack is rejected by the bootedAt rule, but the probe file is gone).
  // Ask once more the moment the marker disappears, at no extra wait.
  const restartMarkerPath = joinDir(agent.stateDir, RESTART_MARKER_FILE_NAME)
  let restartMarkerPending = requestProbe && fs.stat(restartMarkerPath) != null
  let lastProbeAt = startedAt
  writeProbe()
  for (;;) {
    const raw = fs.readFile(markerPath)
    const mtimeMs = fs.stat(markerPath)?.mtimeMs ?? null
    const verdict = liveMarkerProves({ raw, mtimeMs, restartedAtMs })
    const evidence = { lastLiveAt: verdict.lastLiveAt, markerPath, probePath, mtimeMs, via: verdict.via }
    if (verdict.proven) return { ok: true, message: 'channel proven live after the restart', evidence }
    const at = now()
    if (at >= deadline) return { ok: false, message: 'agent_deaf_after_restart', evidence }
    if (restartMarkerPending && fs.stat(restartMarkerPath) == null) {
      restartMarkerPending = false
      lastProbeAt = at
      writeProbe()
    }
    if (requestProbe && at - lastProbeAt >= probeRewriteMs) {
      lastProbeAt = at
      writeProbe()
    }
    await sleep(pollMs)
  }
}
