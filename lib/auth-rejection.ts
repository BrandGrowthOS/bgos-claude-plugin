/**
 * Sustained credential rejection: notice it, and say so once.
 *
 * THE INCIDENT (2026-08-26). A partner's daemon polled with a credential the
 * backend refused, from 00:00:02 to 15:06:16 UTC, and told nobody. Production
 * nginx counted 14,493 rejected GETs of `peers/inbox` and 14,490 of
 * `assistants/<id>/status`, roughly 29,000 401s in fifteen hours, one pair
 * about every two seconds, which is the default poll interval. The owner saw an
 * agent that was "running" and received nothing. It surfaced only because the
 * rejected traffic tripped a shared rate limit and a DIFFERENT, healthy agent's
 * write came back 429.
 *
 * Two things were absent and only one of them is this file's job.
 *
 *   - The POLL path had no 401 handling at all. `lib/poll-core.ts` contains no
 *     reference to authorization; the peer poll is a plain GET whose rejection
 *     is thrown, logged, and retried on the next tick forever. Meanwhile
 *     `lib/stream-client.ts` does this properly: it separates expiry from
 *     revocation on the wire and re-mints once. One transport learned the
 *     lesson and the other did not.
 *   - `hoai doctor` reported `PASS  Pairing credentials`, because that check
 *     asserts the file EXISTS and its id matches the pin. It never asks the
 *     server whether the credential is ACCEPTED. Fixing that is a separate
 *     change in bin/bgos-doctor.mjs.
 *
 * WHAT THIS MODEL DOES, and deliberately no more: it counts CONSECUTIVE
 * rejections across every authenticated call the daemon makes, and decides when
 * that has gone on long enough to be worth telling the owner. It does not
 * change poll timing. Back-off is a real and separate concern (the noisy
 * neighbour half of the incident) and it belongs in the poll loop rather than
 * bolted onto a counter, so it is left out on purpose.
 *
 * WHY BOTH A COUNT AND A DURATION. A count alone fires on a burst: several
 * calls in flight when a token rotates all fail together and all recover on the
 * next tick. A duration alone fires on one unlucky request at the wrong moment.
 * Requiring both means the daemon has been continuously refused for a real
 * stretch of wall-clock time, which is a condition and not a blip.
 *
 * FAIL QUIET, NOT LOUD. Any successful call resets the state completely,
 * including the notified flag, so a credential that recovers leaves no residue
 * and a LATER failure is free to speak again. The cost of a missed notification
 * is that the owner waits; the cost of a false one is that we accuse a working
 * agent in front of its owner, which is the mistake PR #95 was written to undo.
 */

/** Consecutive rejections before the daemon will consider speaking. */
export const AUTH_REJECTION_MIN_COUNT = 30

/** ...and it must ALSO have been failing for at least this long. */
export const AUTH_REJECTION_MIN_MS = 60_000

export interface AuthRejectionState {
  /** Consecutive rejected calls. Any success returns this to 0. */
  consecutive: number
  /** When the current unbroken run of rejections began, or null. */
  firstAt: number | null
  /** Whether the owner has already been told about THIS run. */
  notified: boolean
}

export function initialAuthRejectionState(): AuthRejectionState {
  return { consecutive: 0, firstAt: null, notified: false }
}

/**
 * Fold one call's outcome into the state.
 *
 * Only 401 counts as a rejection. A 403 is a permission answer about a
 * particular resource rather than a statement about who we are, and a 5xx or a
 * timeout is the server having a bad day; neither means our credential is
 * refused, and treating them as such would fire this on every backend deploy.
 */
export function observeAuthOutcome(
  state: AuthRejectionState,
  status: number,
  now: number,
): AuthRejectionState {
  if (status !== 401) {
    // Anything that is not a rejection ends the run, including a 5xx: we do not
    // KNOW the credential is bad any more, so the evidence is gone.
    return state.consecutive === 0 && !state.notified
      ? state
      : initialAuthRejectionState()
  }
  return {
    consecutive: state.consecutive + 1,
    firstAt: state.firstAt ?? now,
    notified: state.notified,
  }
}

/**
 * Should the owner be told, right now?
 *
 * True at most once per unbroken run of rejections. The caller is expected to
 * mark it notified (see markAuthRejectionNotified) so a 2-second poll does not
 * post the same warning thirty times a minute.
 */
export function shouldReportAuthRejection(
  state: AuthRejectionState,
  now: number,
): boolean {
  if (state.notified) return false
  if (state.consecutive < AUTH_REJECTION_MIN_COUNT) return false
  if (state.firstAt == null) return false
  return now - state.firstAt >= AUTH_REJECTION_MIN_MS
}

export function markAuthRejectionNotified(
  state: AuthRejectionState,
): AuthRejectionState {
  return { ...state, notified: true }
}

/**
 * The same refusal, projected for the FLEET rather than for this machine.
 *
 * 2026-08-29. The backend has accepted a `lastError` on the heartbeat since the
 * columns existed (heartbeat.dto.ts, integration-pairing.repository.ts writes
 * all three), and across 76 live pairings the number that had ever carried one
 * was ZERO. Nothing sent it. So an operator reading the pairing table saw a
 * uniformly blank error column and read it as health, which is worse than an
 * absent column because it answers the question confidently.
 *
 * That gap matters most for exactly this failure. The notification above is
 * local IPC and the log line is on the machine, both correct and both invisible
 * to anyone not sitting at that machine. The 2026-08-26 incident ran ~29,000
 * 401s over fifteen hours and surfaced only when the rejected traffic tripped a
 * shared rate limit and broke a different agent's write.
 *
 * DERIVED, NOT RECORDED. This reads the state the daemon already keeps rather
 * than introducing a second one that could disagree with it. It uses the very
 * thresholds that decide a refusal is real, so it cannot fire on a blip, and
 * because any success returns `consecutive` to 0 it goes back to null on its
 * own. The backend treats an explicit null as "clear the columns", so recovery
 * needs no separate call.
 *
 * Deliberately independent of `notified`: that flag stops the owner being told
 * twice, but the fleet wants the CURRENT state on every heartbeat, and a
 * refusal that is still happening should still be reported.
 */
export function heartbeatLastError(
  state: AuthRejectionState,
  now: number,
): { code: string; message: string; at: string } | null {
  if (state.consecutive < AUTH_REJECTION_MIN_COUNT) return null
  if (state.firstAt == null) return null
  if (now - state.firstAt < AUTH_REJECTION_MIN_MS) return null
  const minutes = Math.floor((now - state.firstAt) / 60_000)
  return {
    code: 'auth_rejected',
    // Under the DTO's 300-char cap with room to spare, and it states the
    // observation only. What the daemon does not know, it does not claim.
    message:
      `The server has refused this agent's credentials on ` +
      `${state.consecutive} consecutive calls over ${minutes} minute(s). ` +
      `Re-pairing is the remedy under every known cause.`,
    at: new Date(state.firstAt).toISOString(),
  }
}

/**
 * The warning, as a LOCAL channel notification to the Claude Code session.
 *
 * IT CANNOT BE A CHAT MESSAGE, and that is the whole point. Posting to the
 * owner's chat is an authenticated HTTP call, so on a daemon whose credential
 * is being refused it is precisely the thing that does not work. Worse,
 * `monitoredChatIds` is itself populated from a poll, so a daemon rejected from
 * boot has no chat id to post to either. A remedy delivered over the broken
 * channel is not a remedy.
 *
 * `mcp.notification` is local IPC to the session that spawned this daemon. It
 * owes nothing to the backend and works exactly when the network path does not,
 * which makes it the only surface that can carry this particular news. The
 * daemon log gets the same line, because that is what `hoai logs` prints and
 * what a person helping over a chat window will ask for.
 *
 * It states the OBSERVATION and not a cause. We know the server is refusing
 * this credential; we do NOT know whether it was revoked, superseded by a later
 * pairing, or something else. PR #95 is the standing record of what happens
 * when a daemon presents a guess to a user as a fact. Re-pairing is the one
 * remedy correct under every one of those causes, which is why it is the only
 * one offered.
 */
export function buildAuthRejectionNotification(input: {
  consecutive: number
  minutes: number
}): { content: string; meta: Record<string, string> } {
  const forHowLong =
    input.minutes >= 2
      ? `for about ${Math.round(input.minutes)} minutes`
      : 'for the last minute or so'
  return {
    content:
      `[hoai] The server is refusing this agent's credentials and has been ${forHowLong} ` +
      `(${input.consecutive} rejected requests in a row). Nothing you send is reaching ` +
      'this agent. Tell the user, and suggest re-pairing from this folder: ' +
      'hoai pair <code from the HOAI app>. If that does not clear it, hoai doctor.',
    meta: { event_type: 'auth_rejected' },
  }
}
