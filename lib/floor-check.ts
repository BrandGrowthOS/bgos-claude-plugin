/**
 * The permission relay's half of the hard floor (0.49.0): what it asks the
 * server about a request that matched the list, and what it does with the
 * answer.
 *
 * WHY THE RELAY HAS TO CHANGE AT ALL. The floor hook (bin/hoai-floor-hook.mjs)
 * makes the CLI raise a permission request for a listed action even under
 * --dangerously-skip-permissions, and that request lands here. On a default
 * install (`BGOS_AUTO_APPROVE: "true"`, hardcoded in the shipped manifest) the
 * relay used to answer `allow` to it in 8 ms without looking (map part 24,
 * run D3), so the hook alone was a floor that was off on every default
 * install. So, BEFORE the auto approve branch, a request that matches the list
 * asks the server one question: does this agent's owner want it held?
 *
 * THE ANSWER IS A DECISION PER EVENT, NOT A COPY OF THE SETTING. The owner's
 * switch lives on the server and nowhere else; this daemon never reads it,
 * stores it or caches it (test/floor-check.test.ts fails a file that does).
 * `POST /api/v1/integrations/assistants/:id/floor-check` with
 * `{ toolName, inputPreview }` answers `{ hold, ruleId?, rulesVersion }`,
 * where `hold` is true only when the switch is on AND the server's own list
 * matches.
 *
 *   hold      the interactive path: the two option card, the owner's wait, the
 *             owner's answer, even though auto approve is on. The drain and
 *             no chat exits of that path refuse a held request, as they
 *             refuse any request there.
 *   proceed   today's auto approve, unchanged.
 *   error     REFUSED (deny). A listed action whose check could not reach the
 *             server is never allowed silently: a network failure, a timeout,
 *             a refusal (401, 403, 5xx) or an answer that is not the shape
 *             above.
 *
 * TWO READINGS THAT ARE NOT ERRORS, and why each proceeds, logged:
 *   - an API key connection. The route is pairing scoped, like the session
 *     mode route (lib/session-mode.ts), and has no user scoped twin, so a
 *     legacy API key daemon has nowhere to ask. Refusing would deny every
 *     listed action of every legacy full access agent whose owner never saw
 *     the switch, which is the change the spec forbids for the switch off.
 *   - a 404 from the route. The switch, the list and this route ship together
 *     in one backend release, so a backend without the route cannot have the
 *     switch on for anyone. The house refusal for an agent the pairing does
 *     not own is a 403, which is refused like any other error.
 *
 * WHAT THE RELAY DECIDES FROM (planFloorRequest). The hook's FLOOR RECORD
 * first (lib/floor-state.mjs): the hook saw the whole tool input, while the
 * request's `input_preview` is a copy the CLI cuts in the middle when a value
 * is over 3500 code points, so a listed action in the middle of a long
 * command is not in the preview at all. Then, only when there is no record,
 * the preview itself. And a shell preview carrying the CLI's cut mark with no
 * record and no match is sent to the owner rather than auto approved: what
 * was cut cannot be checked, and the only answer that is not a guess is the
 * owner's.
 *
 * A BODY THE LIST NO LONGER READS. The body is fitted to the route's 4000
 * characters by dropping arguments, never the operator
 * (lib/floor-evidence.mjs). When even that cannot fit the listed part (an
 * essential word thousands of characters long), what is sent is a head the
 * list does not read as any action, and a `hold: false` about it is an answer
 * about a different, harmless command. consultFloor re-reads its own body and
 * floorRouteFor sends such a proceed to the owner instead of auto approving.
 *
 * WITH AUTO APPROVE OFF (floorRouteFor's second argument). Every request is
 * interactive there already, so the question is asked only for a request the
 * hook's record vouches for, and it changes one thing: when the owner has not
 * asked to hold it and the session runs with full access
 * (`permission_mode: bypassPermissions`, which the record carries), the
 * request exists ONLY because the floor hook asked, so it is allowed, exactly
 * as it ran before 0.49.0, instead of posting a card to an owner whose switch
 * is off. In any other mode the CLI would have asked anyway, so it goes to
 * the owner as before. An error there also goes to the owner: the card is not
 * a silent allow, and it is what that install did before.
 *
 * Pure except `consultFloor`, which takes the network call as an argument.
 */

import type { HardFloorMatch } from './hard-floor.js'
import {
  FLOOR_SHELL_TOOLS,
  classifyCommand,
  classifyPath,
  classifyPermissionRequest,
  hardFloorWords,
  previewIsElided,
  readToolInput,
} from './hard-floor.js'
import { compactFloorEvidence } from './floor-evidence.mjs'

/** The route's own limits (spec 4.4); a body over either is a 400. */
export const FLOOR_CHECK_TOOL_NAME_MAX = 200
export const FLOOR_CHECK_INPUT_PREVIEW_MAX = 4000

/**
 * How long a blocked tool call waits for the server's answer before the
 * relay gives up and refuses it. The CLI is holding the call (and the
 * terminal dialog) while this runs, so it is far shorter than an ordinary
 * REST deadline; a backend that is up answers in well under a second.
 */
export const FLOOR_CHECK_TIMEOUT_MS = 10_000

export interface FloorCheckBody {
  toolName: string
  inputPreview: string
  /**
   * True only for a shell request the CLI cut in the middle with no floor
   * record naming it (consultElidedFloor): the relay cannot read what was
   * cut, so it asks whether the owner's switch would hold what it cannot see.
   * The server holds such a request exactly when the switch is on.
   */
  elided?: boolean
}

export type FloorAnswer =
  | { kind: 'hold'; ruleId: string | null; rulesVersion: number | null }
  | { kind: 'proceed'; rulesVersion: number | null }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'error'; reason: string }

/**
 * What the relay does next. `owner` is the interactive path for a request the
 * owner's floor does not hold (auto approve off, see the header).
 */
export type FloorRoute = 'hold' | 'auto_approve' | 'refuse' | 'owner'

/** The hook's floor record, as the relay reads it (lib/floor-state.mjs). */
export interface FloorRecord {
  v: 1
  at: number
  toolName: string
  ruleId: string
  rulesVersion: number
  evidence: string
  permissionMode: string | null
  sessionId: string | null
  toolUseId: string | null
}

/** How the relay treats one permission request, before any network. */
export type FloorPlan =
  | { action: 'consult'; match: HardFloorMatch; source: 'record' | 'preview'; record: FloorRecord | null }
  | { action: 'ask_elided'; reason: string }
  | { action: 'none' }

/**
 * Decide, from the hook's record and the request itself, whether the relay
 * asks the server, goes straight to the owner, or carries on as before.
 */
export function planFloorRequest(input: {
  autoApprove: boolean
  toolName: string
  inputPreview: string | undefined
  record: FloorRecord | null
  previewMatch: HardFloorMatch | null
}): FloorPlan {
  const { record } = input
  if (record) {
    return {
      action: 'consult',
      source: 'record',
      record,
      match: {
        ruleId: record.ruleId as HardFloorMatch['ruleId'],
        rulesVersion: record.rulesVersion,
        words: hardFloorWords(record.ruleId) ?? '',
        evidence: record.evidence,
      },
    }
  }
  if (!input.autoApprove) return { action: 'none' }
  if (input.previewMatch) {
    return { action: 'consult', source: 'preview', record: null, match: input.previewMatch }
  }
  if (FLOOR_SHELL_TOOLS.includes(input.toolName) && previewIsElided(input.inputPreview)) {
    // NOT straight to the owner (the stage 6 backend review): that posted a
    // card for every long unlisted command on an install whose owner never
    // turned the switch on. The server is asked whether the owner's floor
    // holds a request it cannot read (consultElidedFloor).
    return {
      action: 'ask_elided',
      reason:
        'the command was cut in the middle by the CLI and no floor record names it, so what was cut cannot be checked',
    }
  }
  return { action: 'none' }
}

/**
 * The route, or NULL when this connection has nowhere to ask (an API key
 * daemon; see the header). One spelling, pairing scoped.
 */
export function floorCheckPath(
  authMode: 'pairing' | 'apikey',
  assistantId: string | number,
): string | null {
  if (authMode !== 'pairing') return null
  const id = String(assistantId ?? '').trim()
  if (!id) return null
  return `integrations/assistants/${encodeURIComponent(id)}/floor-check`
}

/**
 * The body, inside the route's limits, carrying what the server's list reads.
 *
 * NOT the raw preview. The CLI's preview is the WHOLE tool input and has no
 * ceiling (a Write carries the file), so the raw text can be over the route's
 * 4000 characters, and a preview cut to fit is no longer JSON. The body is
 * therefore the input reduced to the fields the list reads, re-rendered as
 * JSON: `{"command":"..."}` for a shell tool, `{"file_path":"..."}` (or
 * `notebook_path`) for an edit tool, `{}` for an MCP tool, whose NAME is what
 * matched. A command too long for the limit, or one in which the match's rule
 * is no longer visible (the CLI cut the listed action out of the preview's
 * middle, and the match came from the hook's record), is replaced by the
 * simple command that matched (the match's evidence), so the server reads the
 * part that matters and not a head and a tail that stop around it.
 */
export function buildFloorCheckBody(
  toolName: string,
  inputPreview: string | undefined,
  match: Pick<HardFloorMatch, 'evidence'> & { ruleId?: string },
): FloorCheckBody {
  const name = String(toolName ?? '').slice(0, FLOOR_CHECK_TOOL_NAME_MAX)
  const input = readToolInput(toolName, inputPreview ?? '')
  const reduced: Record<string, string> = {}
  for (const key of ['command', 'file_path', 'notebook_path'] as const) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) reduced[key] = value
  }
  const evidence = String(match.evidence ?? '')
  const ruleId = match.ruleId
  if (ruleId && evidence) {
    if (FLOOR_SHELL_TOOLS.includes(String(toolName)) && classifyCommand(reduced.command ?? '') !== ruleId) {
      reduced.command = evidence
    } else if (
      !FLOOR_SHELL_TOOLS.includes(String(toolName)) &&
      !toolName.startsWith('mcp__') &&
      classifyPath(reduced.file_path ?? '') !== ruleId &&
      classifyPath(reduced.notebook_path ?? '') !== ruleId
    ) {
      reduced.file_path = evidence
    }
  }
  let rendered = JSON.stringify(reduced)
  if (rendered.length > FLOOR_CHECK_INPUT_PREVIEW_MAX && typeof reduced.command === 'string') {
    reduced.command = evidence
    rendered = JSON.stringify(reduced)
  }
  // Still over: fit the field the rule reads by dropping ARGUMENTS, never the
  // operator (lib/floor-evidence.mjs). A head cut here was the hole the
  // review found: the redirect or the `--force` at the END of a long simple
  // command went, the server read a harmless command and answered hold:false.
  if (rendered.length > FLOOR_CHECK_INPUT_PREVIEW_MAX && ruleId) {
    const key = (['command', 'file_path', 'notebook_path'] as const).find(
      (k) => typeof reduced[k] === 'string' && reduced[k]!.length > 0,
    )
    if (key) {
      const others = { ...reduced }
      delete others[key]
      const fitted = compactFloorEvidence({
        toolName: String(toolName ?? ''),
        ruleId,
        evidence: reduced[key]!,
        max: FLOOR_CHECK_INPUT_PREVIEW_MAX,
        measure: (text: string) => JSON.stringify({ ...others, [key]: text }).length,
      })
      if (fitted.fits) {
        reduced[key] = fitted.evidence
        rendered = JSON.stringify(reduced)
      }
    }
  }
  while (rendered.length > FLOOR_CHECK_INPUT_PREVIEW_MAX) {
    // Still over (a path or an evidence segment of thousands of characters):
    // cut the longest field and re-render, so what is sent is always JSON.
    const longest = Object.keys(reduced).sort((a, b) => reduced[b]!.length - reduced[a]!.length)[0]
    if (!longest) break
    const over = rendered.length - FLOOR_CHECK_INPUT_PREVIEW_MAX
    reduced[longest] = reduced[longest]!.slice(0, Math.max(0, reduced[longest]!.length - over - 8))
    rendered = JSON.stringify(reduced)
  }
  return { toolName: name, inputPreview: rendered }
}

/**
 * Read the route's answer. A 2xx whose body is `{ hold: boolean, ... }` is
 * the answer; a 404 is a backend without the floor (see the header); anything
 * else is an error, which refuses.
 */
export function readFloorCheckResponse(response: { status: number; text: string }): FloorAnswer {
  const status = Number(response?.status)
  if (status === 404) {
    return { kind: 'unsupported', reason: 'the backend has no floor check route (404)' }
  }
  if (!(status >= 200 && status < 300)) {
    return { kind: 'error', reason: `the floor check answered ${status}` }
  }
  let body: unknown
  try {
    body = JSON.parse(String(response.text ?? ''))
  } catch {
    return { kind: 'error', reason: 'the floor check answer is not JSON' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'error', reason: 'the floor check answer is not an object' }
  }
  const record = body as Record<string, unknown>
  const rulesVersion =
    typeof record.rulesVersion === 'number' && Number.isFinite(record.rulesVersion)
      ? record.rulesVersion
      : null
  if (record.hold === true) {
    return {
      kind: 'hold',
      ruleId: typeof record.ruleId === 'string' ? record.ruleId : null,
      rulesVersion,
    }
  }
  if (record.hold === false) return { kind: 'proceed', rulesVersion }
  return { kind: 'error', reason: 'the floor check answer carries no hold' }
}

/**
 * The three answers, and the two readings that proceed, on an install that
 * auto approves (the default). With auto approve off (see the header) a
 * proceed allows only a request that exists because the floor hook asked in a
 * full access session, and everything else goes to the owner as it always did.
 */
export function floorRouteFor(
  answer: FloorAnswer,
  context: { autoApprove?: boolean; permissionMode?: string | null; bodyReadable?: boolean } = {},
): FloorRoute {
  const autoApprove = context.autoApprove ?? true
  switch (answer.kind) {
    case 'hold':
      return 'hold'
    case 'proceed':
      // A hold:false about a body the list itself no longer reads (the
      // listed part could not be fitted into the route's limit) is an answer
      // about a DIFFERENT, harmless command, not about this one. It is not a
      // reason to let a listed action through, so the owner decides.
      if (context.bodyReadable === false) return 'owner'
    // falls through
    case 'unsupported':
      if (autoApprove) return 'auto_approve'
      return context.permissionMode === 'bypassPermissions' ? 'auto_approve' : 'owner'
    default:
      return autoApprove ? 'refuse' : 'owner'
  }
}

export interface FloorDecision {
  route: FloorRoute
  answer: FloorAnswer
  /** One line for the daemon log, saying what was decided and why. */
  line: string
}

/**
 * Ask, and decide. Never throws: every failure is a refusal, and a send that
 * outlives `timeoutMs` is one too, even if the transport ignores its own
 * deadline (the race is the deadline, the transport's abort is a courtesy).
 */
export async function consultFloor(opts: {
  toolName: string
  inputPreview: string | undefined
  requestId: string
  match: HardFloorMatch
  path: string | null
  send: (path: string, body: FloorCheckBody) => Promise<{ status: number; text: string }>
  timeoutMs?: number
  /** Omitted: an install that auto approves, the default and the original contract. */
  autoApprove?: boolean
  /** The session's permission mode, from the hook's floor record. */
  permissionMode?: string | null
}): Promise<FloorDecision> {
  const { toolName, requestId, match, path } = opts
  const context = { autoApprove: opts.autoApprove ?? true, permissionMode: opts.permissionMode ?? null }
  const where = `${toolName} [${requestId}] (rule ${match.ruleId})`
  if (path === null) {
    const answer: FloorAnswer = {
      kind: 'unsupported',
      reason: 'an API key connection has no pairing scoped floor check',
    }
    const route = floorRouteFor(answer, context)
    return {
      route,
      answer,
      line:
        route === 'auto_approve'
          ? `Floor check skipped for ${where}: ${answer.reason}; auto approving as before`
          : `Floor check skipped for ${where}: ${answer.reason}; asking the owner as before`,
    }
  }
  const timeoutMs = opts.timeoutMs ?? FLOOR_CHECK_TIMEOUT_MS
  const body = buildFloorCheckBody(toolName, opts.inputPreview, match)
  // Does the list still read an action in what is sent? When it does not, the
  // server's answer cannot be about this action (see floorRouteFor).
  const bodyReadable = classifyPermissionRequest(toolName, body.inputPreview) !== null
  const routeContext = { ...context, bodyReadable }
  let timer: ReturnType<typeof setTimeout> | undefined
  let answer: FloorAnswer
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    const sent = opts.send(path, body)
    sent.catch(() => {})
    const response = await Promise.race([sent, deadline])
    answer = readFloorCheckResponse(response)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    answer = { kind: 'error', reason: `the floor check failed: ${reason}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
  const route = floorRouteFor(answer, routeContext)
  const line =
    route === 'hold'
      ? `Floor HOLDS ${where} for the owner: the card waits for their answer`
      : route === 'refuse'
        ? `Floor check could not decide ${where}, REFUSING it: ${
            answer.kind === 'error' ? answer.reason : answer.kind
          }`
        : route === 'owner' && answer.kind === 'proceed' && !bodyReadable
          ? `Floor check for ${where}: the listed part did not fit the check's limit, so its answer is not about this action; asking the owner`
          : route === 'owner'
          ? `Floor check for ${where} (auto approve off): ${
              answer.kind === 'error' ? `could not decide, ${answer.reason}` : 'not held'
            }; asking the owner as this install always does`
          : answer.kind === 'unsupported'
            ? `Floor check unavailable for ${where}: ${answer.reason}; auto approving as before`
            : `Floor check for ${where}: the owner has not asked to hold it; ${
                context.autoApprove ? 'auto approving' : 'allowing it, as it ran before the floor (full access)'
              }`
  return { route, answer, line }
}

/**
 * THE CUT SHELL COMMAND NO RECORD NAMES (planFloorRequest's `ask_elided`, the
 * stage 6 backend review). The CLI cut the preview in the middle, so the list
 * cannot read what was cut, and the floor hook left no record, which it does
 * when it matched, so either nothing listed was in the command or the hook
 * did not run (it fails open on a crash or its own budget). This used to go
 * straight to the owner whatever the switch said, so an install that auto
 * approves posted a card for every long unlisted command although its owner
 * had never touched the switch: the one change spec section 8 forbids with
 * the switch off.
 *
 * So the server is asked with `elided: true`, and it holds the request
 * exactly when the owner's switch is on (what was cut cannot be checked, so
 * the owner decides). hold takes the owner's card, held, so only a tap allows
 * it; proceed (the switch is off) and an API key connection or a backend
 * without the route auto approve as before this release; an error goes to
 * the owner, the answer this branch always gave, rather than a silent allow.
 */
export async function consultElidedFloor(opts: {
  toolName: string
  inputPreview: string | undefined
  requestId: string
  path: string | null
  send: (path: string, body: FloorCheckBody) => Promise<{ status: number; text: string }>
  timeoutMs?: number
}): Promise<FloorDecision> {
  const where = `${opts.toolName} [${opts.requestId}] (a cut command no floor record names)`
  if (opts.path === null) {
    const answer: FloorAnswer = {
      kind: 'unsupported',
      reason: 'an API key connection has no pairing scoped floor check',
    }
    return {
      route: 'auto_approve',
      answer,
      line: `Floor check skipped for ${where}: ${answer.reason}; auto approving as before`,
    }
  }
  const timeoutMs = opts.timeoutMs ?? FLOOR_CHECK_TIMEOUT_MS
  const body: FloorCheckBody = {
    ...buildFloorCheckBody(opts.toolName, opts.inputPreview, { evidence: '' }),
    elided: true,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let answer: FloorAnswer
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    const sent = opts.send(opts.path, body)
    sent.catch(() => {})
    answer = readFloorCheckResponse(await Promise.race([sent, deadline]))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    answer = { kind: 'error', reason: `the floor check failed: ${reason}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
  switch (answer.kind) {
    case 'hold':
      return {
        route: 'hold',
        answer,
        line: `Floor HOLDS ${where} for the owner: the switch is on and what was cut cannot be checked`,
      }
    case 'proceed':
      return {
        route: 'auto_approve',
        answer,
        line: `Floor check for ${where}: the owner has not asked to hold anything; auto approving as before`,
      }
    case 'unsupported':
      return {
        route: 'auto_approve',
        answer,
        line: `Floor check unavailable for ${where}: ${answer.reason}; auto approving as before`,
      }
    default:
      return {
        route: 'owner',
        answer,
        line: `Floor check could not decide ${where}: ${answer.reason}; asking the owner`,
      }
  }
}
