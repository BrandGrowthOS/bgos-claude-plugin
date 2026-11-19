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
import { AGENT_STATE_FILE_NAME, isAgentStateFresh, parseAgentState } from './keepalive-plan.mjs'

export const VERIFY_TIMEOUT_MS = 120_000
export const VERIFY_POLL_MS = 3_000
export const PROBE_REWRITE_MS = 30_000
/** How long an agent gets to answer the question asked BEFORE an update. */
export const LIVE_BEFORE_TIMEOUT_MS = 20_000
/**
 * An agent that did not answer in that window but acted on the channel this
 * recently may be in the middle of a long turn (a probe is answered by a tool
 * call, which a busy session makes only when its turn ends). Older than this,
 * or never, it is deaf.
 */
export const LIVE_BEFORE_STALE_MS = 6 * 60 * 60_000

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
  // A second bound on the laps themselves. Every lap awaits only the injected
  // sleep, so a clock that never reaches the deadline (a wall clock stepped
  // back, or a test's sleep that does not advance its fake clock) kept this
  // loop on microtasks for ever: it never yielded to a timer, so nothing could
  // stop it (a watcher test run sat at 100% CPU for 50 minutes, its
  // --test-timeout never fired). A real sleep(pollMs) lasts at least pollMs,
  // so on a real clock the deadline always ends the wait first.
  const maxPolls = Math.ceil(timeoutMs / Math.max(1, pollMs)) + 1
  let polls = 0
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
    if (at >= deadline || polls >= maxPolls) return { ok: false, message: 'agent_deaf_after_restart', evidence }
    if (restartMarkerPending && fs.stat(restartMarkerPath) == null) {
      restartMarkerPending = false
      lastProbeAt = at
      writeProbe()
    }
    if (requestProbe && at - lastProbeAt >= probeRewriteMs) {
      lastProbeAt = at
      writeProbe()
    }
    polls += 1
    await sleep(pollMs)
  }
}

/**
 * What the daemon's published state says it is doing, when that state can be
 * trusted (fresh, its writer alive, this agent's): the first sign of work in
 * hand, or null. Read only after the probe went unanswered.
 */
function busySignal(agent, { fs, now, staleMs, pidAlive }) {
  const dir = agent?.pluginStateDir
  if (typeof dir !== 'string' || dir === '') return null
  let raw = null
  try {
    raw = fs.readFile(joinDir(dir, AGENT_STATE_FILE_NAME))
  } catch {
    return null
  }
  const state = parseAgentState(raw, agent.assistantId)
  if (!isAgentStateFresh(state, { now, pidAlive })) return null
  if (state.turnInFlight) return 'turn_in_flight'
  if (state.pendingMessages > 0) return 'messages_waiting'
  if (state.pendingPermissions > 0) return 'permission_waiting'
  if (state.activeOperations > 0) return 'operation_running'
  if (state.lastActivityAtMs !== null && now - state.lastActivityAtMs <= staleMs) return 'recent_activity'
  return null
}

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * Before an update: does this agent hear the channel NOW?
 *
 * The verify after an update rolls the whole computer back when an agent is
 * deaf. That is right only when the update made it deaf. An agent that was
 * already deaf (launched with a flag that drops channel events, hand started
 * on an old version) fails that verify on every version, so it rolled a good
 * install back and then failed again on the old one (Bug board rows 66450e01
 * and 367b861a, 17 Nov 2026). The planner's own guard reads `running`, which
 * only says the agent has a supervisor.
 *
 * So the same question is asked once before anything is installed, with the
 * same probe, and answered from the marker alone:
 *   live true   lastLiveAt moved after the question: it answered;
 *   live false  no answer, and the marker shows no sign of life (absent, junk
 *               or last moved more than LIVE_BEFORE_STALE_MS ago);
 *   live null   no answer, but it acted on the channel recently: it may be
 *               busy, so nothing is concluded and the update can be blamed;
 *               or (review of #396, C1) the daemon's own published state
 *               (agent-state.json, fresh, its writer alive) shows a turn in
 *               flight, work waiting, or activity inside the window. The
 *               marker moves only on a boot's first tool call and on
 *               channel_ack, so a healthy session up for hours in a long turn
 *               has an old marker; its state is what says it is busy.
 *
 * The verify's bootedAt rule does not apply: nothing was restarted, so the
 * daemon that answers is the one that has been running all along.
 *
 * @param {import('./agent-inventory.mjs').AgentRow | Record<string, any>} agent
 * @param {{ fs?: import('./watcher-bundle.mjs').WatcherFs, now?: () => number,
 *   sleep?: (ms: number) => Promise<unknown>, timeoutMs?: number, pollMs?: number,
 *   staleMs?: number, log?: (line: string) => void, pidAlive?: (pid: number) => boolean }} [deps]
 * @returns {Promise<{ live: boolean | null, detail: string, lastLiveAt: string | null }>}
 */
export async function proveLiveBefore(agent, deps = {}) {
  const fs = deps.fs ?? nodeFs()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  // A zero, negative or junk window would read every agent as deaf at once.
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : LIVE_BEFORE_TIMEOUT_MS
  const pollMs = deps.pollMs ?? VERIFY_POLL_MS
  const staleMs = deps.staleMs ?? LIVE_BEFORE_STALE_MS
  const log = deps.log ?? (() => {})
  const pidAlive = deps.pidAlive ?? defaultPidAlive
  const markerPath = agent?.liveMarkerPath
  if (typeof markerPath !== 'string' || markerPath === '' || typeof agent?.stateDir !== 'string' || agent.stateDir === '') {
    return { live: null, detail: 'no_marker_path', lastLiveAt: null }
  }
  // A read that cannot be parsed (a write in progress, a torn file) keeps the
  // last good read: one bad read is no evidence that the agent never lived.
  let lastGood = { ms: null, iso: null }
  const lastLiveMs = () => {
    const marker = parseLiveMarker(fs.readFile(markerPath))
    const at = marker ? Date.parse(marker.lastLiveAt) : NaN
    if (Number.isFinite(at)) lastGood = { ms: at, iso: marker.lastLiveAt }
    return lastGood
  }
  const askedAt = now()
  const probePath = joinDir(agent.stateDir, PROBE_MARKER_FILE_NAME)
  try {
    fs.writeFile(probePath, `${JSON.stringify({ requestedAt: new Date(askedAt).toISOString(), by: 'hoai-watcher', purpose: 'before_update' })}\n`)
  } catch (err) {
    log(`[live-before ${agent.assistantId}] probe write failed at ${probePath}: ${String(err?.message ?? err)}`)
  }
  // The same two bounds as verifyAgent: the deadline, and a count of laps for
  // a clock that never reaches it.
  const maxPolls = Math.ceil(timeoutMs / Math.max(1, pollMs)) + 1
  let seen = lastLiveMs()
  for (let polls = 0; ; polls += 1) {
    if (seen.ms !== null && seen.ms > askedAt) return { live: true, detail: 'answered', lastLiveAt: seen.iso }
    if (now() - askedAt >= timeoutMs || polls >= maxPolls) break
    await sleep(pollMs)
    seen = lastLiveMs()
  }
  const waited = `no_answer_in_${timeoutMs}ms`
  const busy = busySignal(agent, { fs, now: now(), staleMs, pidAlive })
  if (busy !== null) return { live: null, detail: `${waited};busy_${busy}`, lastLiveAt: seen.iso }
  if (seen.ms === null) return { live: false, detail: `${waited};never_live`, lastLiveAt: seen.iso }
  if (askedAt - seen.ms > staleMs) return { live: false, detail: `${waited};last_live_${seen.iso}`, lastLiveAt: seen.iso }
  return { live: null, detail: `${waited};recently_live_${seen.iso}`, lastLiveAt: seen.iso }
}
