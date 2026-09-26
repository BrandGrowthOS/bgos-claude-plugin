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
 * The seven tokens, and what each one PROMISES the owner:
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
 *   plan_card           this daemon has the propose_plan tool and posts the
 *                       plan card (an `event` row whose payload kind is
 *                       `plan_card`, with Go ahead, Change the plan and Do
 *                       not do this) in the owner's agent chat (0.50.0,
 *                       lib/plan-card.ts). Every host: it is a typed MCP tool
 *                       with no platform limit. Gated exactly like
 *                       permission_card: the backend tells the canon's plan
 *                       card sentences only to a connection that declares
 *                       this token, never by version.
 *   hard_floor          this daemon installs the blocking floor hook
 *                       (bin/hoai-floor-hook.mjs, a PreToolUse entry in
 *                       hooks/hooks.json that asks and never denies) and,
 *                       for an action on the owner's Always ask list, holds
 *                       it for the owner BEFORE any auto approve: the relay
 *                       asks the server's floor-check route first
 *                       (lib/floor-check.ts) and a hold takes the owner's
 *                       request card (0.53.0). Every host: the hook is a
 *                       plain node script and the relay is the permission
 *                       relay above, with no platform limit. The backend
 *                       tells the canon's floor sentence (a hook stops a
 *                       listed action and the relay holds it) only to a
 *                       connection that declares this token WITH
 *                       permission_card, never by version. PAIRING
 *                       CONNECTIONS ONLY: the floor check route is pairing
 *                       scoped, so on a legacy API key connection the relay
 *                       cannot hold anything and this token is not declared
 *                       (DECLARED_CAPABILITIES_PAIRING). AND ONLY WHERE THE
 *                       HOOK IS REGISTERED: a marketplace install always has
 *                       it, a clone only once a launcher or bgos-agent wrote
 *                       it into a settings file the CLI reads, so the daemon
 *                       looks at boot (lib/floor-hook-presence.ts) and does
 *                       not declare a stop its session cannot make.
 *   stop_pauses_mission an owner Stop pauses the chat's open mission with the
 *                       reason "Stopped by you" instead of letting it run on,
 *                       and the owner's next message there resumes it (P6
 *                       stage 3). ONLY where the injector answers, beside
 *                       mission_pause and for the same reason: the pause is
 *                       what clears a Keep working goal whose own Stop hook
 *                       would otherwise re prompt the model after it stood
 *                       down (lib/stop-pause.ts, gated on mission_pause being
 *                       declared on the same beat). BGOS serves the sentence
 *                       that tells the agent so only to a daemon declaring
 *                       it, so the token ships with the code that keeps it.
 *                       Spelled by lib/session-controls-contract.ts, the file
 *                       BGOS and codex-channel-bgos pin too.
 *   sessions_library    the owner can find this agent's sessions from the
 *                       app's Sessions sheet: the list_sessions op answers
 *                       the sessions in the agent's own folder, titles and
 *                       previews that hold a secret withheld on this machine
 *                       (lib/session-library.ts, P6 stage 3). Every host:
 *                       it is a read of the agent folder and needs no tmux.
 *                       It promises the LIST only. Resume and rename are a
 *                       later slice and answer unsupported, and the list's
 *                       own abilities {resume:false, rename:false} say so,
 *                       so the sheet never offers either. Spelled by the
 *                       same contract file.
 *
 * Token grammar is the backend's: /^[a-z][a-z0-9_]{0,63}$/, at most 32
 * entries (backend/src/dto/integrations/pair-exchange.dto.ts). The base is
 * frozen so no call site can push onto it at runtime, and the answer is a
 * fresh array each call, so a caller that mutates what it was given cannot
 * poison the next beat; test/declared-capabilities.test.ts holds all of it in
 * place.
 *
 * The canon gated tokens (permission_card, plan_card and hard_floor) are NOT spelled
 * here. They come from lib/claude-capability-tokens.ts, a byte-for-byte copy
 * of the BGOS file the canon gates on
 * (backend/src/integrations/claude-capability-tokens.ts), whose sha256 both
 * repos pin in a test (here test/claude-capability-tokens.pin.test.ts), so a
 * token renamed on one side only turns that side red instead of leaving the
 * agent silently untold.
 */

import { HARD_FLOOR_TOKEN, PERMISSION_CARD, PLAN_CARD } from './claude-capability-tokens.js'
import { SESSIONS_LIBRARY, STOP_PAUSES_MISSION } from './session-controls-contract.ts'

/** Declared wherever this plugin runs, on every host and every connection. */
export const DECLARED_CAPABILITIES_BASE: readonly string[] = Object.freeze([
  'mission_events',
  'mission_goal_checks',
  'mission_set_goals',
  PERMISSION_CARD,
  PLAN_CARD,
  SESSIONS_LIBRARY,
])

/**
 * Declared only on a PAIRING connection (AUTH.mode === 'pairing').
 *
 * hard_floor promises that a listed action is held for the owner, and the
 * hold is the floor check route, which is pairing scoped: floorCheckPath
 * answers null for an API key connection, consultFloor then reads
 * `unsupported` and the relay auto approves as before the floor
 * (lib/floor-check.ts). The canon fetch carries this list, and the backend
 * counts the fetch's own list for a caller with no pairing, so an API key
 * daemon that declared it would be told "a hook stops a listed action and the
 * relay holds it" while its relay let the same action through. Fail closed:
 * declare it only where the hold is real.
 *
 * permission_card and plan_card do NOT have this flaw and stay in the base:
 * the card is a POST to `messages` and propose_plan is a typed tool, both of
 * which an API key connection can do.
 */
export const DECLARED_CAPABILITIES_PAIRING: readonly string[] = Object.freeze([HARD_FLOOR_TOKEN])

/** Declared only while this daemon can type into its own CLI's composer. */
export const DECLARED_CAPABILITIES_INJECTOR: readonly string[] = Object.freeze([
  'mission_goal_loop',
  'mission_pause',
  STOP_PAUSES_MISSION,
])

/**
 * What to declare on THIS beat.
 *
 * `canInjectGoal` is the live answer to "can this daemon type into the session
 * right now", which server.ts passes as `compactTarget !== null`. Fail closed:
 * an install with no tmux target declares the read half and the owner is
 * offered neither the Keep working switch nor Pause, rather than being offered
 * a control that would quietly do nothing.
 *
 * `authMode` is AUTH.mode, and it is REQUIRED so no call site can forget it:
 * hard_floor is declared only on a pairing connection (see
 * DECLARED_CAPABILITIES_PAIRING), and only where the floor hook is really
 * registered for the session (`floorHook`, found once at boot).
 */
export function declaredCapabilities(input: {
  canInjectGoal: boolean
  /**
   * Is the blocking floor hook registered for this session
   * (lib/floor-hook-presence.ts)? REQUIRED for the same reason as authMode.
   * With no hook the CLI never raises a request for a listed action, so the
   * relay has nothing to hold, and hard_floor would promise a stop that
   * cannot happen: an always on clone updated in place is the case.
   */
  floorHook: boolean
  authMode: 'pairing' | 'apikey'
}): readonly string[] {
  return [
    ...DECLARED_CAPABILITIES_BASE,
    ...(input.authMode === 'pairing' && input.floorHook === true ? DECLARED_CAPABILITIES_PAIRING : []),
    ...(input.canInjectGoal === true ? DECLARED_CAPABILITIES_INJECTOR : []),
  ]
}
