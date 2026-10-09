/**
 * Send the not responding verdict AT ONCE when it is reached, and its clearing
 * the moment the session speaks again (HOAI board row 9c3d6b2c, rollout step
 * 3). Before this the verdict (lastError code `session_unresponsive`) rode the
 * next 6 hourly heartbeat, unless an update related beat happened to go
 * first, so it could reach the server hours after this daemon had already
 * posted its warning into the chat.
 *
 * The returned sweep is called from the escalation itself and on a short
 * tick; it sends only on a CHANGE of the reading, and only from the pairing
 * lock holder (a daemon that stood down must not flip the shared pairing's
 * health). Never throws: a status nicety must never break the daemon.
 */
export function createVerdictSender(deps: {
  /** The verdict now: true while the session is judged not responding. */
  read: () => boolean
  /** True while this daemon holds the pairing lock. */
  isHolder: () => boolean
  /** Send a heartbeat now (it carries the verdict on lastError). */
  send: () => void
  log: (line: string) => void
}): () => void {
  let reported = false
  return () => {
    try {
      if (!deps.isHolder()) return
      const verdict = deps.read() === true
      if (verdict === reported) return
      reported = verdict
      deps.log(`session ${verdict ? 'not responding' : 'answering again'}; heartbeat sent now`)
      deps.send()
    } catch {
      /* never break the daemon over a status send */
    }
  }
}
