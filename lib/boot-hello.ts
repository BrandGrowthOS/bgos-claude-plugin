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

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** File name inside the per-assistant state dir (next to chat-cursors.json). */
export const LIVE_MARKER_FILE = 'channel-live.json'

export interface LiveMarker {
  /** ISO time of the very first proven-live tool call for this pairing. */
  firstLiveAt: string
  /** ISO time of the most recent first-tool-call-of-a-boot. */
  lastLiveAt: string
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
    return { firstLiveAt: first || last, lastLiveAt: last || first }
  } catch {
    return null
  }
}

/** The next marker content after a proven-live event at `nowIso`. */
export function nextLiveMarker(
  previous: LiveMarker | null,
  nowIso: string,
): LiveMarker {
  return {
    firstLiveAt: previous?.firstLiveAt || nowIso,
    lastLiveAt: nowIso,
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
export function recordLiveMarker(path: string, nowIso: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const next = nextLiveMarker(readLiveMarker(path), nowIso)
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
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
