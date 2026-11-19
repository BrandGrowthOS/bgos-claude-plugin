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
import { observeAgentForCheckup, observeInstall } from './watcher-checkup.mjs'
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
    return {
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
      const session = await (ports.probe ?? signedIn)(cliEnv, profile)
      // The status command supplies no model allowance. Do not derive one
      // from token spend or a weekly total.
      const reading = { signedIn: session === true, usage: null }
      seen.set(account.id, { at: now(), reading })
      return reading
    },
    restart: async (requested, choice) => {
      const raw = list().find((r) => Number(r.assistantId) === requested.assistantId)
      if (!raw || raw.sessionId !== requested.sessionId) return { started: false }
      const registry = readAccountRegistry(home)
      const fresh = view(raw, registry.accounts)
      if (!fresh || fresh.pairingId !== requested.pairingId || fresh.userId !== registry.ownerUserId)
        return { started: false }
      const install = ports.eligible ? { pluginRoot: raw.recipe?.pluginRoot } : await observeInstall({ ...ctx, row: raw })
      if (!(await eligible(raw, install))) return { started: false, wait: true }
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
