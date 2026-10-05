/**
 * How long THIS daemon waits before it comes back after the server drops it.
 *
 * THE DEFECT THIS EXISTS FOR, measured in production on 2026-10-05. A blue/
 * green backend deploy ends with an nginx reload, and 30 s later nginx
 * force-kills the old workers and drops every socket in ONE second: 123 of
 * them, 51 of which were distinct agent pairings. Every one of those daemons
 * then came back on the same schedule and met a brand new container whose auth
 * cache is a process singleton, so it was empty by construction. Each first
 * authenticated request from a pairing costs a `bcrypt.compare` at cost 12,
 * which the backend's own docblock prices at 100 to 250 ms of CPU, on a box
 * with two vCPUs. The backend started ZERO request handlers for about six
 * seconds, the per-address in-flight cap tripped 107 times in that minute, and
 * the owner, who pressed Enter inside the window, waited about 16 seconds for
 * his message to appear in a group chat.
 *
 * WHAT WAS ALREADY TRUE, so this is not oversold: socket.io-client defaults
 * `randomizationFactor` to 0.5 and backo2 applies it to the base, so a base of
 * 1000 ms already drew from about 500 to 1500 ms. The window was never a single
 * instant. It was about one second wide, which for 51 daemons is still roughly
 * 50 first-requests per second against a cold cache. Widening the base to 500
 * to 5000 ms makes the window about 7 s, thinning that to roughly 7 per second.
 *
 * AND THE SOCKET IS NOT THE EXPENSIVE PART. On reconnect this daemon also runs
 * a catch-up, and on the legacy path that is `pollAllChats`, one request per
 * monitored chat, fired with no delay at all. The stream path has waited a
 * random 0 to 5000 ms before its catch-up since the Agent Update Stream
 * shipped; the legacy path, which is what most of the fleet runs, did not. So
 * the first authenticated request after a reconnect, the one that pays the
 * bcrypt, arrived as fast as the socket could hand over. Both numbers here are
 * drawn ONCE per draw and are independent, so the handshake and the catch-up do
 * not land together either.
 *
 * Pure on purpose: `random` is passed in, so a test pins the ends and the
 * middle instead of sampling a generator and hoping.
 */

/** The narrowest base a daemon will wait before its first reconnect attempt. */
export const RECONNECT_BASE_DELAY_MIN_MS = 500

/** The widest. Above this, a deploy starts to feel like an outage. */
export const RECONNECT_BASE_DELAY_MAX_MS = 5_000

/**
 * The widest delay before the post-reconnect catch-up. Deliberately the same
 * 5 s the stream path has always used, so the two catch-up paths spread the
 * same amount and one cannot be the slow one.
 */
export const CATCHUP_DELAY_MAX_MS = 5_000

/**
 * Anything that is not a usable 0..1 reading collapses to the midpoint rather
 * than to an end. A broken generator then produces the OLD behaviour, every
 * daemon on one value, which is a visible regression; collapsing to 0 would
 * produce a thundering herd that is faster than the one this replaces, and
 * collapsing to 1 would look like a hang.
 */
function clamp01(random: number): number {
  return Number.isFinite(random) && random >= 0 && random <= 1 ? random : 0.5
}

/**
 * The reconnect base for THIS process, in ms. socket.io still applies its own
 * +/-50% jitter and its exponential backoff on top, so the first attempt lands
 * somewhere inside roughly 250 to 7500 ms.
 */
export function drawReconnectBaseDelayMs(random: number): number {
  const span = RECONNECT_BASE_DELAY_MAX_MS - RECONNECT_BASE_DELAY_MIN_MS
  return Math.round(RECONNECT_BASE_DELAY_MIN_MS + clamp01(random) * span)
}

/**
 * How long to wait after a reconnect before the catch-up sweep. Starts at 0:
 * someone has to go first, and a floor here would delay every daemon's
 * recovery to buy nothing, since the point is the SPREAD and not the delay.
 */
export function drawCatchupDelayMs(random: number): number {
  return Math.floor(clamp01(random) * CATCHUP_DELAY_MAX_MS)
}
