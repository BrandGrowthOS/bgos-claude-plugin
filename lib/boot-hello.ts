/**
 * Boot hello + persistent channel-live marker (fix 09, found by the Vulcan
 * E2E on 2026-08-22).
 *
 * The preflight gate proves the MCP server can start and `claude mcp list`
 * says Connected, but NEITHER proves the session actually HEARS channel
 * notifications: a wrong launch flag loads the plugin's tools and still
 * wires no inbound (three separate silent-drop vectors are documented in
 * bgos-install-method.mjs launchFlagArgs). The only positive proof is the
 * session ACTING on a channel event.
 *
 * So the daemon manufactures that proof once per pairing lifetime: on the
 * FIRST boot with no live marker on disk, it pushes one channel
 * notification asking the agent to greet its owner via the `reply` tool.
 * The greeting is a real, user-visible hello in the app (the onboarding
 * moment), and the tool call it triggers flips ChannelLiveness, which
 * writes the marker file. The bootstrap's last step waits for that marker
 * to be touched AFTER its launch, which is what finally makes "setup
 * succeeded" mean "a message went all the way through and the agent
 * answered".
 *
 * The marker also updates on the first tool call of every LATER boot, so
 * the doctor can report how recently this install last proved it could
 * hear anything.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { agentStateDir } from './update-readiness.js'

/** File name inside the per-assistant state dir (next to chat-cursors.json). */
export const LIVE_MARKER_FILE = 'channel-live.json'

export interface LiveMarker {
  /** ISO time of the very first proven-live tool call for this pairing. */
  firstLiveAt: string
  /** ISO time of the most recent first-tool-call-of-a-boot. */
  lastLiveAt: string
  /**
   * ISO time the daemon that WROTE lastLiveAt booted. A verify after a
   * restart accepts the marker only when this is later than the restart
   * instant: the OLD session can still answer a probe during its own
   * teardown, and lastLiveAt alone cannot tell the two apart.
   */
  bootedAt?: string
}

/** The marker path for a given state dir (the cursor file's directory). */
export function liveMarkerPath(stateDir: string): string {
  return join(stateDir, LIVE_MARKER_FILE)
}

/** Parse a marker file's content; null for absent or junk. */
export function parseLiveMarker(raw: string | null): LiveMarker | null {
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    const first = typeof parsed.firstLiveAt === 'string' ? parsed.firstLiveAt : ''
    const last = typeof parsed.lastLiveAt === 'string' ? parsed.lastLiveAt : ''
    if (!first && !last) return null
    const bootedAt = typeof parsed.bootedAt === 'string' && parsed.bootedAt ? parsed.bootedAt : undefined
    return { firstLiveAt: first || last, lastLiveAt: last || first, ...(bootedAt ? { bootedAt } : {}) }
  } catch {
    return null
  }
}

/** The next marker content after a proven-live event at `nowIso`. */
export function nextLiveMarker(
  previous: LiveMarker | null,
  nowIso: string,
  bootedAtIso?: string,
): LiveMarker {
  // The writer's own boot time always wins: the marker describes the daemon
  // that is live NOW, not whichever one wrote it last.
  const bootedAt = bootedAtIso || previous?.bootedAt
  return {
    firstLiveAt: previous?.firstLiveAt || nowIso,
    lastLiveAt: nowIso,
    ...(bootedAt ? { bootedAt } : {}),
  }
}

/**
 * Should this boot send the hello notification? Only when the pairing has
 * NEVER proven live (no marker: the onboarding boot, or a re-pair into a
 * fresh state dir) and this boot has not sent one already. Every later boot
 * stays quiet: a returning agent greeting its owner at every restart would
 * be noise, and the runtime deaf-session escalation already covers a later
 * regression.
 *
 * `hasPriorCursorState` suppresses the hello for an EXISTING pairing on the
 * upgrade that introduced the marker. The marker is new, so every already
 * paired agent lacks it, but an agent that has processed channel messages
 * before (it has a chat-cursors file) has ALREADY proven it can hear: the
 * hello is the ONBOARDING proof for a genuinely-new pairing, not something
 * the whole fleet should fire at once when its daemons restart onto the new
 * version. See shouldBackfillLiveMarker for the silent marker write that
 * keeps such an agent consistent afterwards.
 */
export function shouldSendBootHello(input: {
  markerExists: boolean
  sentThisBoot: boolean
  hasPriorCursorState?: boolean
  killSwitch?: string | undefined
}): boolean {
  if (String(input.killSwitch ?? '').trim().toLowerCase() === 'off') return false
  if (input.hasPriorCursorState) return false
  return !input.markerExists && !input.sentThisBoot
}

/**
 * On the upgrade that introduced the marker, an existing pairing (one with
 * prior cursor state) has no marker yet but has already proven it can hear.
 * Backfill the marker silently so the doctor reports it live and no later
 * boot re-evaluates it as an onboarding boot. Only when there is prior cursor
 * state AND no marker; a genuinely-new pairing writes its marker the normal
 * way (the first proven-live tool call).
 */
export function shouldBackfillLiveMarker(input: {
  markerExists: boolean
  hasPriorCursorState: boolean
}): boolean {
  return !input.markerExists && input.hasPriorCursorState
}

/**
 * The hello channel notification. The instruction names the reply tool and
 * the chat explicitly so even a bare session with no CLAUDE.md acts on it,
 * and the greeting doubles as the user-visible "your agent is alive" moment.
 */
export function buildBootHelloNotification(input: {
  assistantName?: string | null
  chatId: string
}): { content: string; meta: Record<string, string> } {
  const who = String(input.assistantName ?? '').trim()
  const name = who ? ` as ${who}` : ''
  return {
    content:
      `[hoai] This session just came online${name} for the first time. ` +
      `To confirm the channel works end to end, call the \`reply\` tool NOW ` +
      `with chat_id=${input.chatId} and a one-line friendly hello introducing ` +
      `yourself to your user. This first reply is what proves the connection, ` +
      `so do it before anything else.`,
    meta: {
      event_type: 'boot_hello',
      chat_id: String(input.chatId),
    },
  }
}

/** Effectful: read the marker at `path` (null when absent/junk). */
export function readLiveMarker(path: string): LiveMarker | null {
  try {
    return parseLiveMarker(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Effectful, best effort: persist the proven-live event. Never throws. */
export function recordLiveMarker(path: string, nowIso: string, bootedAtIso?: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const next = nextLiveMarker(readLiveMarker(path), nowIso, bootedAtIso)
    // Write-then-rename: a verify poll must never read a torn marker with a
    // fresh mtime and call that proof.
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(tmp, path)
  } catch {
    // Telemetry only; the daemon must never crash over a marker write.
  }
}

/** Effectful: the marker file's mtime in ms, or null when absent. */
export function liveMarkerMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

// ── Liveness probe after a restart (zero-terminal lifecycle, design 7.2) ─────
//
// The marker above refreshes only on the FIRST tool call of a boot, and the
// hello fires only on a pairing's first boot ever, so after a routine
// restart nothing proves the session hears the channel until the user
// speaks. The watcher manufactures that proof without touching the
// conversation: it writes ~/.bgos-agent/<id>/probe-requested.json (existence
// only, contents ignored) and the daemon, polling that file every 3s,
// unlinks it and pushes ONE silent channel notification asking the session
// to call the `channel_ack` tool. That call goes through the CallTool
// chokepoint, flips liveness, and touches channel-live.json, which is what
// the watcher reads (mtime > restartedAt) to call the restart proven.

/** File name inside ~/.bgos-agent/<id>/ (the launcher's state dir, NOT the
 *  plugin state dir that holds the live marker; design 7.1). */
export const PROBE_REQUEST_FILE = 'probe-requested.json'
/** How often the daemon stats the probe file (cheap, unref'd). */
export const LIVENESS_PROBE_POLL_MS = 3_000
/** At most one probe notification per this window, however often the file
 *  reappears (the watcher rewrites it every 30s while it waits). */
export const LIVENESS_PROBE_MIN_INTERVAL_MS = 30_000

/** ~/.bgos-agent/<id>/probe-requested.json, or null for an invalid id. */
export function probeRequestPath(
  home: string,
  assistantId: string | number | null | undefined,
): string | null {
  const dir = agentStateDir(home, assistantId)
  return dir ? join(dir, PROBE_REQUEST_FILE) : null
}

/** Pure rate-limited decision: send when the marker is present and the last
 *  probe (if any) is at least the minimum interval old. */
export function shouldSendLivenessProbe(input: {
  markerExists: boolean
  lastSentAt: number | null
  now: number
}): boolean {
  if (!input.markerExists) return false
  if (input.lastSentAt === null) return true
  return input.now - input.lastSentAt >= LIVENESS_PROBE_MIN_INTERVAL_MS
}

/**
 * The silent probe notification. It names the tool, forbids any user-facing
 * message, and tells the session to resume what it was doing; the meta
 * event_type lets a CLAUDE.md or a future filter recognise it.
 */
export function buildLivenessProbeNotification(
  input: { chatId?: string | null } = {},
): { content: string; meta: Record<string, string> } {
  const meta: Record<string, string> = { event_type: 'liveness_probe' }
  const chatId = String(input.chatId ?? '').trim()
  if (chatId) meta.chat_id = chatId
  return {
    content:
      '[hoai] Liveness check after a restart. Call the channel_ack tool now, ' +
      'then continue whatever you were doing. Do NOT send any message to the ' +
      'user for this.',
    meta,
  }
}
