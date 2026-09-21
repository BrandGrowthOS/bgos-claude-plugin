/**
 * What this daemon reports it can do, sent on every version heartbeat.
 *
 * The carrier already existed: `integration_pairings.declared_capabilities` is
 * a text[] seeded at pair exchange and REPLACED WHOLESALE on every heartbeat,
 * with `supports_turn_refresh` as the shipped precedent for reading one as a
 * feature gate. So an already-paired daemon that updates starts declaring on
 * its next beat with no re-pair, and a daemon that never declares reads as
 * "enforces nothing", which is both fail-closed and exactly what a pre-0.41.0
 * install looks like.
 *
 * Why this is a list and not a channel constant: the backend decides what the
 * OWNER is offered from what the DAEMON reported, per daemon, at runtime. Two
 * installs of this same plugin on two hosts can differ (tmux control of the
 * CLI pane exists on Mac and Linux and not on Windows), so a channel-level
 * constant would be wrong on half the fleet the day it shipped.
 *
 * What is deliberately ABSENT is the point of the file:
 *
 *   mission_pause  NOT declared. This daemon has no process-level handle on an
 *                  in-flight Claude Code turn, so its stop is cooperative: it
 *                  can ASK the session to stand down and it cannot enforce
 *                  anything. A Pause button that does nothing is worse than no
 *                  Pause button, so the owner is not offered one here. If a
 *                  pause this daemon can genuinely enforce ever lands, it
 *                  arrives with the goal lane in stage 6 of the Mission
 *                  program, and that is when this token gets declared.
 *
 * Token grammar is the backend's: /^[a-z][a-z0-9_]{0,63}$/, at most 32
 * entries (backend/src/dto/integrations/pair-exchange.dto.ts). Frozen so no
 * call site can push onto it at runtime; test/declared-capabilities.test.ts
 * holds all of it in place.
 */

export const DECLARED_CAPABILITIES: readonly string[] = Object.freeze([
  // This daemon listens for the owner's own mission decisions (Set aside,
  // Mark done, Pause, Resume, Start) and relays each one to its model in
  // band, in the chat the mission belongs to.
  'mission_events',
])
