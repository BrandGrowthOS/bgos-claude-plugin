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
 * Why this is a FUNCTION and no longer a frozen constant (0.42.0). Two of the
 * four tokens depend on the HOST rather than on the release: this daemon is an
 * MCP stdio child of the CLI, so it can only type into its parent's composer
 * where tmux control of that pane exists, which is Mac and Linux and not
 * Windows, and which lib/compact-capability.ts can discover up to thirty
 * minutes AFTER boot. The heartbeat already sends a thunk evaluated per beat
 * (lib/version-heartbeat.ts:141), so a late upgrade starts declaring on the
 * next beat and a Windows host declares the read half for the life of the
 * process. A channel-level constant would have been wrong on half the fleet
 * the day it shipped.
 *
 * The six tokens, and what each one PROMISES the owner:
 *
 *   mission_events      this daemon listens for the owner's own mission
 *                       decisions (Set aside, Mark done, Pause, Resume,
 *                       Start) and relays each one to its model in band, in
 *                       the chat the mission belongs to. Every host.
 *   mission_goal_checks a separate judge reads this agent's work and this
 *                       daemon reports its verdict. Every host: Claude Code's
 *                       own /goal runs the checker as a session scoped Stop
 *                       hook and writes the verdict into the session
 *                       transcript, and reading a file has no platform limit.
 *                       So a Windows agent shows a real Last check for a goal
 *                       a person typed in its own terminal.
 *   mission_goal_loop   the owner's Keep working can really arm this daemon's
 *                       loop. ONLY where the injector answers, because arming
 *                       a native goal means typing `/goal <condition>` into
 *                       the composer and there is no other way in: a channel
 *                       push cannot do it (the enqueue sets
 *                       skipSlashCommands, see
 *                       docs/learnings/a-channel-push-cannot-arm-a-native-goal.md)
 *                       and the model has no tool for it.
 *   mission_set_goals   the model has set_mission_goals, which writes the
 *                       mini goals of an open mission that has none yet
 *                       (every /goal mission starts that way). The backend
 *                       arms a Keep working wake on a goal-less mission only
 *                       for a daemon declaring this, because that wake asks
 *                       the agent to write its goals. Every host: it is a
 *                       plain HTTP write the model makes itself.
 *   mission_pause       a pause truly stops the work. ONLY where the injector
 *                       answers, because the pause this daemon can enforce IS
 *                       clearing the native goal. It is honest about its
 *                       limit, which the canon states: the loop stops after
 *                       the current turn, and a turn already running is not
 *                       killed. Before 0.42.0 this file said mission_pause was
 *                       deliberately absent because nothing here could enforce
 *                       a pause and promised the goal lane would decide it.
 *                       This is that decision.
 *   permission_card     this daemon relays Claude Code's permission prompt
 *                       as a BGOS request card (an `approval_request` with
 *                       an `approvalMeta`, Allow once and Deny) and honours
 *                       the owner's `ea:` answers to it (0.49.0,
 *                       lib/permission-relay.ts). Every host: the prompt
 *                       arrives over the channel's own permission
 *                       notification and the answer goes back the same way,
 *                       with no platform limit. The backend tells the canon's
 *                       permission request card sentence only to a
 *                       connection that declares this token, on its
 *                       heartbeat or on the capabilities fetch itself
 *                       (lib/capabilities.ts, capabilitiesFetchPath), and NOT
 *                       by version: a release number cannot be reserved in
 *                       this repo, so a floor naming one would promise the
 *                       card to whichever release happened to take it.
 *
 * Token grammar is the backend's: /^[a-z][a-z0-9_]{0,63}$/, at most 32
 * entries (backend/src/dto/integrations/pair-exchange.dto.ts). The base is
 * frozen so no call site can push onto it at runtime, and the answer is a
 * fresh array each call, so a caller that mutates what it was given cannot
 * poison the next beat; test/declared-capabilities.test.ts holds all of it in
 * place.
 *
 * The canon gated tokens (permission_card, and plan_card once the plan card
 * ships) are NOT spelled here. They come from lib/claude-capability-tokens.ts,
 * a byte-for-byte copy of the BGOS file the canon gates on
 * (backend/src/integrations/claude-capability-tokens.ts), whose sha256 both
 * repos pin in a test (here test/claude-capability-tokens.pin.test.ts), so a
 * token renamed on one side only turns that side red instead of leaving the
 * agent silently untold.
 */

import { PERMISSION_CARD } from './claude-capability-tokens.js'

/** Declared wherever this plugin runs, on every host. */
export const DECLARED_CAPABILITIES_BASE: readonly string[] = Object.freeze([
  'mission_events',
  'mission_goal_checks',
  'mission_set_goals',
  PERMISSION_CARD,
])

/** Declared only while this daemon can type into its own CLI's composer. */
export const DECLARED_CAPABILITIES_INJECTOR: readonly string[] = Object.freeze([
  'mission_goal_loop',
  'mission_pause',
])

/**
 * What to declare on THIS beat.
 *
 * `canInjectGoal` is the live answer to "can this daemon type into the session
 * right now", which server.ts passes as `compactTarget !== null`. Fail closed:
 * an install with no tmux target declares the read half and the owner is
 * offered neither the Keep working switch nor Pause, rather than being offered
 * a control that would quietly do nothing.
 */
export function declaredCapabilities(input: { canInjectGoal: boolean }): readonly string[] {
  return input.canInjectGoal === true
    ? [...DECLARED_CAPABILITIES_BASE, ...DECLARED_CAPABILITIES_INJECTOR]
    : [...DECLARED_CAPABILITIES_BASE]
}
