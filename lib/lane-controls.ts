/**
 * PERSON LANES, what a lane daemon does for its person's own controls
 * (shared agents Phase 3: P5 for `/new`, `/model` and `/effort`, P7 for the
 * share's policy). lane-server.ts wires these to its socket and its files;
 * every effect is a parameter here, so the rules are tested without a lane.
 *
 *   /new         a new conversation: a FRESH session pin and a restart, now;
 *                the memory folder (inside `work/`) is not touched.
 *   /model x     x must be on the owner's list (K7) or `default`; recorded in
 *   /effort x    `choices.json` (outside `work/`, out of the model's reach)
 *                and applied by a restart now. Off the list: nothing changes
 *                and the person is told.
 *   /login       nothing is signed in, started, read or restarted: the
 *                person is told which Claude sign in our conversations use,
 *                by the lane's login mode and by whether their message
 *                carried the owner's /login grant (laneLoginNotice).
 *   the policy   compared with the policy this Claude was launched with:
 *                TIGHTER restarts now (a turn in flight is cut and its
 *                person told); LOOSER restarts at the lane's next idle
 *                moment. Asked once per change, not on every heartbeat.
 *
 * The person hears what happened through a fixed notice the owner's daemon
 * posts (lib/lane-core.mjs LANE_NOTICES), because BGOS main does not take a
 * lane's own reply yet.
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { dirname } from 'node:path'

import {
  compareToolPolicy,
  LANE_EFFORT_LEVELS,
  LANE_MODEL_RE,
  laneChoiceVerdict,
  mergeLaneRestartRequests,
  readLaneAllowedChoices,
  readLaneChoices,
  readLaneRestartRequest,
  readToolPolicy,
} from './lane-policy.mjs'
import { LANE_LOGIN_OWN_TOKEN } from './lane-core.mjs'
import { laneChoiceQuestion } from './lane-slash.ts'

export type ToolPolicy = ReturnType<typeof readToolPolicy>
export type RestartAsk = { reasons: string[]; when: 'now' | 'idle'; fresh: boolean; chatId: string | null }

export interface LaneControlPaths {
  choicesPath: string
  allowedChoicesPath: string
  restartRequestPath: string
}

function readText(fs: typeof nodeFs, path: string): string {
  try {
    return String(fs.readFileSync(path, 'utf8'))
  } catch {
    return ''
  }
}

function writePrivateJson(fs: typeof nodeFs, path: string, value: unknown): void {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, path)
}

/**
 * Ask the supervisor for a restart. Merged with a request already waiting,
 * so a policy change never swallows a `/new` and `now` always wins.
 */
export function requestLaneRestart(path: string, next: RestartAsk, deps: { fs?: typeof nodeFs; now?: () => number } = {}): RestartAsk {
  const fs = deps.fs ?? nodeFs
  const merged = mergeLaneRestartRequests(readLaneRestartRequest(readText(fs, path)), next) as RestartAsk
  writePrivateJson(fs, path, { ...merged, at: new Date((deps.now ?? Date.now)()).toISOString(), by: 'lane-daemon' })
  return merged
}

export interface LaneCommandDeps {
  paths: LaneControlPaths
  notice: (name: string, chatIds: string[]) => void
  requestRestart: (next: RestartAsk) => void
  log: (line: string) => void
  /** The lane's login mode, from its own environment (HOAI_LANE_LOGIN_MODE). */
  loginMode?: string
  fs?: typeof nodeFs
  now?: () => number
}

/**
 * Which sentence a `/login` in a lane gets (lib/lane-core.mjs LANE_NOTICES).
 * Under the person's own token (K2 option b), `claude auth login` cannot
 * change the token the lane runs on, and the owner's login is not theirs to
 * touch, grant or no grant. Under inherit, and any mode this file does not
 * know, the lane runs on the owner's own sign in, which no lane can sign back
 * in: the owner does, from their own chat.
 *
 * `granted` is whether THIS /login carried the owner's grant ("Can sign this
 * agent back in", lib/daemon-command-sender.ts carriesLoginGrant). A lane
 * cannot honour it: honouring it needs either the owner's daemon to run its
 * sign-in for a lane's chat, or a sign-in that writes credentials from
 * inside the confined lane process, and neither is done here. So the person
 * is told plainly that their permission does not apply in our conversation
 * (login_lane_shared_granted), rather than answered as if they had none.
 * Only `true` is the grant.
 */
export function laneLoginNotice(
  loginMode: string,
  granted = false,
): 'login_lane_own_token' | 'login_lane_shared' | 'login_lane_shared_granted' {
  if (loginMode === LANE_LOGIN_OWN_TOKEN) return 'login_lane_own_token'
  return granted === true ? 'login_lane_shared_granted' : 'login_lane_shared'
}

/**
 * Perform `/new`, `/model x`, `/effort x` or `/login` for the person in
 * `chatId`. Returns what was done, for the log and the tests. `granted` is
 * read for `/login` only (laneLoginNotice).
 */
export function performLaneCommand(
  route: { kind: 'new' | 'model' | 'effort' | 'login'; commandArgs: string; granted?: boolean },
  chatId: string,
  deps: LaneCommandDeps,
): 'new_session' | 'changed' | 'unchanged' | 'refused' | 'failed' {
  const fs = deps.fs ?? nodeFs
  if (route.kind === 'login') {
    // Before anything reads a file: a /login here touches nothing.
    const notice = laneLoginNotice(String(deps.loginMode ?? ''), route.granted === true)
    deps.log(`/login: not run in a lane; the person is told which sign in this lane uses (${notice})`)
    deps.notice(notice, [chatId])
    return 'refused'
  }
  if (route.kind === 'new') {
    deps.log('/new: a new conversation for this person; the memory folder stays')
    deps.notice('new_session', [chatId])
    deps.requestRestart({ reasons: ['new'], when: 'now', fresh: true, chatId })
    return 'new_session'
  }
  const kind = route.kind
  const allowed = readLaneAllowedChoices(readText(fs, deps.paths.allowedChoicesPath))
  const verdict = laneChoiceVerdict({ kind, value: route.commandArgs, allowed })
  if (!verdict.ok) {
    deps.log(`/${kind}: not on the owner's list; kept`)
    deps.notice('choice_refused', [chatId])
    return 'refused'
  }
  const current = readLaneChoices(readText(fs, deps.paths.choicesPath))
  const next = { model: current.model, effort: current.effort }
  next[kind] = verdict.value
  try {
    writePrivateJson(fs, deps.paths.choicesPath, {
      v: 1,
      model: next.model ?? null,
      effort: next.effort ?? null,
      chatId,
      at: new Date((deps.now ?? Date.now)()).toISOString(),
    })
  } catch (err) {
    deps.log(`/${kind}: could not record the choice: ${String(err)}`)
    return 'failed'
  }
  deps.notice(kind === 'model' ? 'model_changed' : 'effort_changed', [chatId])
  if (current[kind] === verdict.value) {
    deps.log(`/${kind} ${verdict.value ?? 'default'}: already so`)
    return 'unchanged'
  }
  deps.log(`/${kind} ${verdict.value ?? 'default'}: recorded; restarting onto it`)
  deps.requestRestart({ reasons: [kind], when: 'now', fresh: false, chatId })
  return 'changed'
}

/**
 * What THIS lane's Claude was launched with, from the lane daemon's own
 * environment (the supervisor writes it into the lane's mcp.json for every
 * launch, and it is fixed for the process's life): the policy, and the model
 * and effort. Nothing the lane can rewrite (security review M1): with no
 * launch policy in the environment (a P3 launch) the policy is the locked
 * base, and an unreadable one is locked too. Model and effort are checked
 * again before they are reported (review M2).
 */
export function launchedFacts(env: Record<string, string | undefined>): { policy: ToolPolicy; model: string | null; effort: string | null } {
  let policy = readToolPolicy(null)
  try {
    if (typeof env.HOAI_LANE_LAUNCH_POLICY === 'string') policy = readToolPolicy(JSON.parse(env.HOAI_LANE_LAUNCH_POLICY))
  } catch { /* locked */ }
  const model = typeof env.HOAI_LANE_LAUNCH_MODEL === 'string' && LANE_MODEL_RE.test(env.HOAI_LANE_LAUNCH_MODEL) ? env.HOAI_LANE_LAUNCH_MODEL : null
  const effort = typeof env.HOAI_LANE_LAUNCH_EFFORT === 'string' && (LANE_EFFORT_LEVELS as readonly string[]).includes(env.HOAI_LANE_LAUNCH_EFFORT) ? env.HOAI_LANE_LAUNCH_EFFORT : null
  return { policy, model, effort }
}

/** `/model` or `/effort` alone: a question for the model, with the facts it cannot see. */
export function laneChoiceQuestionFor(kind: 'model' | 'effort', paths: LaneControlPaths, env: Record<string, string | undefined>, fs: typeof nodeFs = nodeFs) {
  const launched = launchedFacts(env)
  const allowed = readLaneAllowedChoices(readText(fs, paths.allowedChoicesPath))
  return laneChoiceQuestion({
    kind,
    current: kind === 'model' ? launched.model : launched.effort,
    allowed: kind === 'model' ? allowed.models : allowed.efforts,
  })
}

export interface LanePolicyWatchDeps {
  launchedPolicy: () => ToolPolicy
  /** The chats with a turn in flight right now (a tighter restart cuts them). */
  inFlightChats: () => string[]
  notice: (name: string, chatIds: string[]) => void
  requestRestart: (next: RestartAsk) => void
  log: (line: string) => void
}

/**
 * The share's policy, seen on `lanes/me` (boot and every
 * `lane_policy_changed`) and on every heartbeat answer, against the policy
 * this Claude was launched with.
 */
export class LanePolicyWatch {
  private asked: string | null = null

  constructor(private readonly deps: LanePolicyWatchDeps) {}

  onPolicy(current: ToolPolicy, where: string): 'same' | 'tighter' | 'looser' | 'already_asked' {
    const verdict = compareToolPolicy(this.deps.launchedPolicy(), current)
    if (verdict === 'same') {
      this.asked = null
      return 'same'
    }
    const key = `${verdict}:${JSON.stringify(readToolPolicy(current))}`
    if (this.asked === key) return 'already_asked'
    this.asked = key
    if (verdict === 'tighter') {
      this.deps.log(`the share's policy is tighter than this launch (${where}); restarting at once`)
      const cut = this.deps.inFlightChats()
      if (cut.length > 0) this.deps.notice('policy_tightened', cut)
      this.deps.requestRestart({ reasons: ['policy_tightened'], when: 'now', fresh: false, chatId: null })
    } else {
      this.deps.log(`the share's policy is looser than this launch (${where}); restarting at the next idle moment`)
      this.deps.requestRestart({ reasons: ['policy_loosened'], when: 'idle', fresh: false, chatId: null })
    }
    return verdict
  }
}
