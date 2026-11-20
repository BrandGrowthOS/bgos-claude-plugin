import { delimiter, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listAgents } from './agent-inventory.mjs'
import { restartAgent } from './agent-restart.mjs'
import { verifyAgent } from './agent-verify.mjs'
import { createHelperAccounts, profileDirectory, readAccountRegistry } from './helper-accounts.mjs'
import { isLocalProfile, isolateProfileEnv, prepareHelperTranscript } from './helper-account-launch.mjs'
import { supportsSafeAuthStatus, subscriptionSignedIn } from './claude-subscription-status.mjs'
import { AGENT_STATE_FILE_NAME, decideSafeMoment, isAgentStateFresh, parseAgentState } from './keepalive-plan.mjs'
import { observeAgentForCheckup, observeInstall, readTail } from './watcher-checkup.mjs'
import { agentLimitFrom, agentModelFrom } from './helper-account-limits.mjs'
import { transcriptPathFor } from './watcher-keepalive.mjs'
import { claudeCliCandidates } from './plugin-cli.mjs'

const execFileAsync = promisify(execFile)

async function signedIn(env, cwd) {
  const opts = { env, cwd, encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true }
  const run = async (args) => {
    for (const candidate of claudeCliCandidates(args, process.platform, env)) {
      try {
        return await execFileAsync(candidate.file, candidate.args, opts)
      } catch (error) {
        if (!['ENOENT', 'EINVAL'].includes(error.code) && !candidate.notFoundExitCodes.includes(error.code))
          throw error
      }
    }
    throw new Error('claude_unavailable')
  }
  try {
    const version = await run(['--version'])
    if (!supportsSafeAuthStatus(version.stdout)) return false
    return subscriptionSignedIn((await run(['auth', 'status', '--json'])).stdout)
  } catch {
    return false
  }
}

/** May an agent at its usage limit be restarted on another login now? It cannot run a turn: the owner
 *  message it holds waits BECAUSE of the limit, and the limit picker keeps the turn flag up. What a
 *  restart would still cut is refused: a permission question, thread work, a background job, a state
 *  that is not fresh, or a process tree that cannot be read. */
export function atLimitSafe(o, now) {
  if (o?.claudeAlive === false) return true
  if (o?.claudeAlive !== true || !Array.isArray(o.descendants)) return false
  const state = o.stateFresh ? o.agentState : null
  if (!state || state.pendingPermissions > 0 || state.threadWork) return false
  return decideSafeMoment({
    running: true,
    state: { ...state, turnInFlight: false, pendingMessages: 0, activeOperations: 0 },
    stateFresh: true,
    descendants: o.descendants,
    activityMs: [],
    now,
  }).safe
}

/** The existing inventory and restart/verify routines are the process
 * authority. Only metadata from this account's fresh CLI status leaves here. */
export function createAccountWatcher(ctx, ports = {}) {
  const { home, fs, env, credentials, now, pidAlive } = ctx
  const list = ports.list ?? (() => listAgents({ ...ctx, now: now() }))
  const requestRestart = ports.requestRestart ?? restartAgent
  const verify = ports.verify ?? verifyAgent
  const seen = new Map()
  function view(row, accounts) {
    let pairing
    try {
      pairing = JSON.parse(fs.readFile(row.credentialsPath))
    } catch {
      return null
    }
    if (
      !credentials.backendUrl ||
      pairing?.backendUrl !== credentials.backendUrl ||
      Number(pairing?.assistantId) !== Number(row.assistantId) ||
      !Number.isSafeInteger(pairing?.pairingId) ||
      typeof pairing?.userId !== 'string'
    )
      return null
    const state = parseAgentState(fs.readFile(join(row.pluginStateDir, AGENT_STATE_FILE_NAME)), row.assistantId)
    const configDir = row.recipe?.claudeConfigDir ?? null
    const selected = configDir && accounts.find((a) => resolve(profileDirectory(home, a.id)) === resolve(configDir))
    // The agent's own limit line, read the way capkeeper reads it: the transcript it writes.
    const cwd = row.cwd || row.recipe?.cwd
    const tailSession = (isAgentStateFresh(state, { now: now(), pidAlive }) && state.sessionId) || row.sessionId
    let tail = null
    try {
      if (cwd && tailSession) tail = readTail(fs, transcriptPathFor({ configDir: configDir || join(home, '.claude'), cwd, sessionId: tailSession }))
    } catch {
      tail = null
    }
    const startedAtMs = Date.parse(row.recipe?.startedAt ?? '')
    return {
      limit: agentLimitFrom(tail, now()),
      model: agentModelFrom(tail),
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      assistantId: Number(row.assistantId),
      pairingId: pairing.pairingId,
      userId: pairing.userId,
      accountId: selected?.id ?? null,
      sessionId: row.sessionId,
      configDir,
      daemonPid: state?.pid,
      liveSessionId: isAgentStateFresh(state, { now: now(), pidAlive }) ? state.sessionId : null,
      ready:
        isAgentStateFresh(state, { now: now(), pidAlive }) &&
        state?.sessionId === row.sessionId &&
        state?.turnSignal === 'hooks' &&
        !state.turnInFlight &&
        !state.pendingMessages &&
        !state.pendingPermissions &&
        !state.activeOperations &&
        !state.threadWork,
    }
  }
  const inventory = () => {
    const accounts = readAccountRegistry(home)?.accounts ?? []
    return list()
      .map((row) => view(row, accounts))
      .filter(Boolean)
  }
  const eligible =
    ports.eligible ??
    (async (row, install) => {
      const observed = await observeAgentForCheckup({ ...ctx, row, install, now: now() })
      const o = observed.observation
      return (
        decideSafeMoment({
          running: o.claudeAlive,
          state: o.agentState,
          stateFresh: o.stateFresh,
          descendants: o.descendants,
          activityMs: o.activityMs,
          now: now(),
        }).safe && !o.agentState?.threadWork
      )
    })
  // At its limit an agent cannot run a turn: the owner message it holds is waiting BECAUSE of the
  // limit, and the limit picker keeps the turn flag up. What a restart would still cut is checked:
  // a permission question, thread work, a background job, or a process tree that cannot be read.
  const limitEligible =
    ports.limitEligible ??
    (async (row, install) => atLimitSafe((await observeAgentForCheckup({ ...ctx, row, install, now: now() })).observation, now()))
  return createHelperAccounts({
    home,
    credentials,
    now,
    uuid: ports.uuid,
    inventory,
    measure: async (account, model, force) => {
      const profile = profileDirectory(home, account.id)
      if (!isLocalProfile(profile)) return { signedIn: false, usage: null }
      const cached = seen.get(account.id)
      if (!force && cached && now() - cached.at < 30_000) return cached.reading
      const cliEnv = { ...env }
      isolateProfileEnv(cliEnv, profile)
      cliEnv.PATH = [join(home, '.local', 'bin'), join(home, '.bun', 'bin'), cliEnv.PATH].filter(Boolean).join(delimiter)
      // Never from inside the saved login: Windows looks for `claude` in the working folder
      // before PATH, so a file planted there would run on every check (finding F4).
      const session = await (ports.probe ?? signedIn)(cliEnv, home)
      // The status command supplies no model allowance. Do not derive one
      // from token spend or a weekly total.
      const reading = { signedIn: session === true, usage: null }
      seen.set(account.id, { at: now(), reading })
      return reading
    },
    restart: async (requested, choice, { atLimit = false } = {}) => {
      const raw = list().find((r) => Number(r.assistantId) === requested.assistantId)
      if (!raw || raw.sessionId !== requested.sessionId) return { started: false }
      const registry = readAccountRegistry(home)
      const fresh = view(raw, registry.accounts)
      if (!fresh || fresh.pairingId !== requested.pairingId || fresh.userId !== registry.ownerUserId)
        return { started: false }
      // A switch at a limit is judged on the limit seen NOW: a turn that answered since
      // ended the limit, and then the ordinary rule (finish the turn) applies.
      const limited = atLimit && fresh.limit !== null
      const install = ports.eligible ? { pluginRoot: raw.recipe?.pluginRoot } : await observeInstall({ ...ctx, row: raw })
      if (!(await (limited ? limitEligible : eligible)(raw, install))) return { started: false, wait: true }
      const to = choice ? profileDirectory(home, choice) : registry.targets[requested.assistantId]?.originalDir
      try {
        prepareHelperTranscript({
          home, cwd: raw.cwd || raw.recipe?.cwd, sessionId: raw.sessionId, from: fresh.configDir, to, required: true,
          sessionTranscriptPath: (home, cwd, sessionId, configDir) =>
            transcriptPathFor({ configDir: configDir || join(home, '.claude'), cwd, sessionId }),
        })
      } catch {
        return { started: false }
      }
      const at = now()
      const ran = await requestRestart(raw, { ...ctx, pluginRoot: install.pluginRoot })
      if (!ran.ok) return { started: false }
      const answer = await verify(raw, {
        ...ctx,
        restartedAtMs: at,
        requestProbe: true,
        sleep: async (ms) => {
          await ctx.sleep(ms)
          await ctx.heartbeatIfDue?.()
        },
      })
      if (!answer.ok) return false
      const after = inventory().find((r) => r.assistantId === requested.assistantId && r.pairingId === requested.pairingId)
      return (
        after?.sessionId === requested.sessionId &&
        after?.liveSessionId === requested.sessionId &&
        after?.accountId === choice &&
        after?.daemonPid != null &&
        after.daemonPid !== fresh.daemonPid
      )
    },
  })
}
