// ── Session mode: what the app draws above the composer ──────────────────────
//
// The chip over the composer ("Plan mode ...") is drawn from a field of the
// CHAT row, not from anything local, so the daemon has to REPORT the mode for
// the app to show it. The route is pairing scoped and per chat, the same shape
// as the Steps route this daemon already PUTs to.
//
// WHAT THIS CHANNEL REPORTS, and the one word that makes it honest:
// `enforced: false`. Codex has a real read only plan mode and reports `true`;
// this plugin has no mode at all. Every HOAI agent runs with
// `--dangerously-skip-permissions`, so a plan directive is a request the model
// honours and nothing else (lib/plan-card.ts's header has the whole story).
// The app reads this flag to choose the chip's words, so `false` is what puts
// "<Agent> will propose before it changes anything" on screen instead of
// "read only until approved". Reporting `true` here would be a lie rendered in
// the owner's own chat.
//
// NOTHING IN THIS PLUGIN BEHAVES DIFFERENTLY BECAUSE OF THE MODE. It is a
// report, one way, about what was asked for. The daemon never reads it back to
// decide anything, which keeps stage 1's rule intact: the daemon offers, the
// server decides.
//
// Pure: paths and bodies only. The daemon owns the PATCH, and a failure of it
// is logged and dropped, never fatal, because a missing chip is a cosmetic loss
// and a dead daemon is not.

export type SessionMode = 'plan' | 'default'

export const SESSION_MODES: readonly SessionMode[] = ['plan', 'default']

/** See the header. Not a default, a statement about this channel. */
export const CLAUDE_SESSION_MODE_ENFORCED = false

/**
 * The route, or NULL when this connection has no route to report on.
 *
 * THERE IS ONE SPELLING AND IT IS PAIRING SCOPED. This function used to mint
 * an API key twin, `assistants/:id/chats/:chatId/session-mode`, on the
 * precedent of slashCommandSyncPath and the Steps route, both of which really
 * do carry a user scoped @Put beside the pairing one. Session mode does not:
 * backend/src/session-mode/session-mode.controller.ts declares the
 * `integrations/` path ALONE, and its header says why in as many words, which
 * is the part that makes this a decision rather than a gap. Only the HOST can
 * know whether the host is in plan mode, so a route the app (or any API key
 * holder) could call would let something other than the daemon put a mode on
 * screen that the host is not in, which is the exact dishonesty C-13 exists to
 * avoid. Design spec section 4 says pairing scoped too.
 *
 * So the API key branch pointed at nothing. It was not an error anyone would
 * see: the PATCH 404s, the caller swallows it, and the chip simply never
 * appears for an API key daemon while the log line blames the backend. Null is
 * returned instead, so the one caller skips the request rather than firing a
 * doomed one per plan event, and a future user scoped route is a change here
 * and nowhere else.
 */
export function sessionModePath(
  authMode: 'pairing' | 'apikey',
  assistantId: string | number,
  chatId: string | number,
): string | null {
  if (authMode !== 'pairing') return null
  const encodedAssistant = encodeURIComponent(String(assistantId))
  const encodedChat = encodeURIComponent(String(chatId))
  return `integrations/assistants/${encodedAssistant}/chats/${encodedChat}/session-mode`
}

export function buildSessionModeBody(
  mode: SessionMode,
  enforced: boolean = CLAUDE_SESSION_MODE_ENFORCED,
): { mode: SessionMode; enforced: boolean } {
  return { mode, enforced }
}

/**
 * Whether this report is worth a request.
 *
 * The daemon reports a mode on three occasions (a /plan directive, a plan
 * answered, a /code) and all three can repeat: two /plans in a row, an owner
 * closing a chip that was already closed. Re-sending the same value would put
 * a PATCH on the wire per tap for no change on screen, so the last reported
 * value per chat is remembered and an unchanged one is dropped.
 *
 * An UNKNOWN last value (a fresh daemon, a chat it has not reported on) always
 * reports, including `default`: the app may be showing a chip this process
 * knows nothing about, left by the daemon that died.
 */
export function shouldReportSessionMode(
  lastReported: SessionMode | undefined,
  next: SessionMode,
): boolean {
  return lastReported !== next
}
