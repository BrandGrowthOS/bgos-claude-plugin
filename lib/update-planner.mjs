/**
 * update-planner: the pure function at the centre of the zero-terminal
 * connector lifecycle.
 *
 * Given ONE observation of a machine (how the plugin is installed, what the
 * marketplace or the clone says is latest, which agents live here and how
 * each one can be restarted) and an intent, produce an ordered plan of steps
 * for lib/update-executor.mjs to run. The planner decides; the executor acts.
 * Nothing in here reads a clock, the filesystem, the environment or
 * randomness, and the same input always yields the same output, so the
 * fixture file test/fixtures/update-planner-cases.json doubles as the eval
 * dataset for this module in both repos.
 *
 * Rules encoded (each one is at least one fixture case):
 *   - rollbackLatched means "install nothing": update / reconcile / repair are
 *     blocked (`rollback_latched`) until a human clears the latch, but a
 *     restart_only run installs nothing and still proceeds (with a note), so
 *     an operator can bounce agents while updates are latched.
 *   - autoUpdateEnabled=false blocks update / reconcile / repair
 *     (`updates_disabled`); restart_only is still allowed. A missing flag
 *     fails closed.
 *   - marketplace installs: register the marketplace when it is missing, then
 *     refresh it; install when nothing is installed; update when the
 *     marketplace holds a newer same-major version; reinstall on `repair`.
 *     A different major blocks (`major_version_blocked`). When the latest
 *     version is unknown the plan only refreshes and verifies; the executor
 *     re-observes afterwards. The planner never guesses a version.
 *   - clone installs: fast-forward when origin holds a newer same-major
 *     version; a dirty tree (`dirty_tree`) or a non fast-forwardable branch
 *     (`not_fast_forward`) blocks, but only when there is something to pull.
 *   - a `snapshot` step always precedes the single mutating install step, and
 *     `verify_installed` always follows it.
 *   - agents are handled in ascending numeric id order: restart via the
 *     launcher marker (supervisor launcher-live), the service unit
 *     (supervisor service, never on win32) or the launch recipe (recipe file
 *     plus a cwd); each restart is followed by its own verify. An agent with
 *     no authority gets a named `manual_restart_required` step and the plan
 *     still completes for the others.
 *   - after an install, every agent restarts; otherwise only agents that are
 *     not running or run a version other than the installed one (intent
 *     update / reconcile). restart_only and repair restart every agent.
 *   - an install that no agent can pick up ends in `stage_pending_restart`.
 *   - `refreshWatcher: true` appends `refresh_watcher` as the last step.
 *   - no steps at all is the `nothing_to_do` verdict.
 *
 * Self-contained plain JavaScript: no imports at all. The semver helpers are
 * a copy of the parse / compare rule in lib/self-update.ts because this file
 * must load in bare node (the watcher bundle) where TS sources do not exist.
 */

// -- Vocabulary ---------------------------------------------------------------

/**
 * @typedef {'darwin'|'linux'|'win32'} Platform
 * @typedef {'marketplace'|'clone'} InstallMethod
 * @typedef {'update'|'reconcile'|'restart_only'|'repair'} Intent
 * @typedef {'launcher-live'|'service'|'none'} Supervisor
 * @typedef {'marker'|'service'|'recipe'} RestartMechanism
 * @typedef {'escalate'|'rollback'|'stop'|'continue'} OnFailure
 * @typedef {'snapshot'|'register_marketplace'|'refresh_marketplace'|'install_plugin'|'update_plugin'|'reinstall_plugin'|'git_fast_forward'|'verify_installed'|'restart_agent'|'verify_agent'|'rollback'|'stage_pending_restart'|'manual_restart_required'|'refresh_watcher'} StepKind
 * @typedef {'rollback_latched'|'updates_disabled'|'major_version_blocked'|'dirty_tree'|'not_fast_forward'|'installed_version_unknown'|'unknown_install_method'|'unknown_intent'} BlockedReason
 * @typedef {{ major: number, minor: number, patch: number }} Semver
 */

/**
 * One agent living on the machine, as observed by the inventory.
 * @typedef {object} AgentState
 * @property {string} assistantId   digits only; anything else is dropped with a note
 * @property {string|null} cwd      the folder the agent launches in (from its recipe)
 * @property {Supervisor} supervisor live hoai supervisor.json, a launchd/systemd unit, or nothing
 * @property {boolean} recipe       ~/.bgos-agent/<id>/launch.json exists
 * @property {boolean} running      process evidence (heartbeat / pid)
 * @property {string|null} [version] the plugin version this agent is running, when known
 */

/**
 * @typedef {object} ObservedMachineState
 * @property {Platform} platform
 * @property {InstallMethod} installMethod
 * @property {string|null} runningVersion   the checkout's version for clone installs (null = unknown)
 * @property {{ registered: boolean, latestVersion: string|null }} [marketplace]
 * @property {{ present: boolean, version: string|null, installPath: string|null }} [installed]
 * @property {{ latestVersion: string|null, dirty: boolean, canFastForward: boolean, currentCommit?: string|null, targetCommit?: string|null }} [clone]
 * @property {boolean} autoUpdateEnabled
 * @property {boolean} rollbackLatched
 * @property {AgentState[]} agents
 * @property {Intent} intent
 * @property {boolean} [refreshWatcher]     the installed watcher bundle is stale
 */

/**
 * @typedef {object} PlanStep
 * @property {string} id              stable and unique: s01-register_marketplace, s07-restart_agent-912
 * @property {StepKind} kind
 * @property {string} [target]        agent id for restart_agent / verify_agent / manual_restart_required
 * @property {RestartMechanism} [via] restart_agent only: how the executor restarts this agent
 * @property {OnFailure} onFailure
 * @property {string} why             short, human, no em or en dashes
 */

/**
 * @typedef {object} MachinePlan
 * @property {'nothing_to_do'|'plan'|'blocked'} verdict
 * @property {BlockedReason} [reason]   present only when blocked
 * @property {true} [reobserve]         present only on a partial plan (marketplace latest unknown):
 *                                      run its steps, re-observe the machine, plan again. Such a plan
 *                                      never carries agent or watcher steps, so nothing restarts twice
 *                                      and the watcher never exits mid job.
 * @property {string|null} targetVersion the version agents should run when the plan completes (null = unknown)
 * @property {PlanStep[]} steps
 * @property {string[]} notes            things the planner ignored or could not know, never secrets
 */

/** @type {readonly string[]} */
export const STEP_KINDS = Object.freeze([
  'snapshot',
  'register_marketplace',
  'refresh_marketplace',
  'install_plugin',
  'update_plugin',
  'reinstall_plugin',
  'git_fast_forward',
  'verify_installed',
  'restart_agent',
  'verify_agent',
  'rollback',
  'stage_pending_restart',
  'manual_restart_required',
  'refresh_watcher',
])

/** The kinds that change the install on disk; exactly one per plan, always after a snapshot. */
/** @type {readonly string[]} */
export const MUTATING_STEP_KINDS = Object.freeze(['install_plugin', 'update_plugin', 'reinstall_plugin', 'git_fast_forward'])

/** @type {readonly string[]} */
export const BLOCKED_REASONS = Object.freeze([
  'rollback_latched',
  'updates_disabled',
  'major_version_blocked',
  'dirty_tree',
  'not_fast_forward',
  'installed_version_unknown',
  'unknown_install_method',
  'unknown_intent',
])

/** @type {readonly string[]} */
export const INTENTS = Object.freeze(['update', 'reconcile', 'restart_only', 'repair'])

/** @type {readonly string[]} */
export const INSTALL_METHODS = Object.freeze(['marketplace', 'clone'])

/** @type {readonly string[]} */
export const ON_FAILURE = Object.freeze(['escalate', 'rollback', 'stop', 'continue'])

/** @type {readonly string[]} */
export const RESTART_MECHANISMS = Object.freeze(['marker', 'service', 'recipe'])

const MECHANISM_LABEL = Object.freeze({
  marker: 'launcher marker',
  service: 'service unit',
  recipe: 'launch recipe',
})

// -- Semver (copy of lib/self-update.ts parseSemver / compareSemver) ---------

/**
 * Strict three part semver only: no leading v, no prerelease, no leading zeros.
 * @param {unknown} value
 * @returns {Semver|null}
 */
export function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return null
  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
  return Object.values(parsed).every(Number.isSafeInteger) ? parsed : null
}

/**
 * @param {Semver} left
 * @param {Semver} right
 * @returns {number} -1, 0 or 1
 */
export function compareSemver(left, right) {
  if (left.major !== right.major) return Math.sign(left.major - right.major)
  if (left.minor !== right.minor) return Math.sign(left.minor - right.minor)
  return Math.sign(left.patch - right.patch)
}

/**
 * The raw string when it is a valid semver, otherwise null. Every
 * targetVersion the planner emits goes through here, so a consumer can rely
 * on "null or strict semver" and never sees `v0.38.3` or garbage.
 * @param {unknown} value
 * @returns {string|null}
 */
function validVersion(value) {
  return parseSemver(value) ? /** @type {string} */ (value) : null
}

// -- Small pure helpers ------------------------------------------------------

/** @param {unknown} value @returns {Record<string, any>} */
function asObject(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}
}

/**
 * Ascending numeric order for digit-only ids without going through Number
 * (ids are database integers today but the rule must not break on a wide one).
 * @param {string} a
 * @param {string} b
 */
function compareIds(a, b) {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** @param {Record<string, any>} agent @returns {string|null} */
function cwdOf(agent) {
  return typeof agent.cwd === 'string' && agent.cwd.trim().length > 0 ? agent.cwd : null
}

/**
 * Drop malformed and duplicate agent entries (named in notes, never silent)
 * and return the rest normalized and sorted ascending by id.
 * @param {unknown} agents
 * @returns {{ agents: AgentState[], notes: string[] }}
 */
export function normalizeAgents(agents) {
  /** @type {string[]} */
  const notes = []
  /** @type {AgentState[]} */
  const kept = []
  if (!Array.isArray(agents)) return { agents: kept, notes }
  const seen = new Set()
  for (const raw of agents) {
    if (!raw || typeof raw !== 'object') {
      notes.push('ignored agent entry that is not an object')
      continue
    }
    const entry = asObject(raw)
    const id = entry.assistantId
    if (typeof id !== 'string') {
      notes.push(`ignored agent with non-string id (${id === null ? 'null' : typeof id})`)
      continue
    }
    if (!/^\d+$/.test(id)) {
      notes.push(`ignored agent with malformed id ${JSON.stringify(id)}`)
      continue
    }
    if (seen.has(id)) {
      notes.push(`ignored duplicate agent id ${JSON.stringify(id)}`)
      continue
    }
    seen.add(id)
    kept.push({
      assistantId: id,
      cwd: cwdOf(entry),
      supervisor: entry.supervisor === 'launcher-live' || entry.supervisor === 'service' ? entry.supervisor : 'none',
      recipe: entry.recipe === true,
      running: entry.running === true,
      version: validVersion(entry.version),
    })
  }
  kept.sort((a, b) => compareIds(a.assistantId, b.assistantId))
  return { agents: kept, notes }
}

/**
 * The supervisor the executor can actually use. win32 has no launchd /
 * systemd unit, so a `service` supervisor there reads as `none`.
 * @param {Record<string, any>} agent
 * @param {string} platform
 * @returns {Supervisor}
 */
export function effectiveSupervisor(agent, platform) {
  const supervisor = asObject(agent).supervisor
  if (supervisor === 'launcher-live') return 'launcher-live'
  if (supervisor === 'service') return platform === 'win32' ? 'none' : 'service'
  return 'none'
}

/**
 * The restart authority ladder: launcher marker, then service unit, then
 * relaunch from the launch recipe (needs the recipe AND a cwd). Null means
 * a human has to do it.
 * @param {Record<string, any>} agent
 * @param {string} platform
 * @returns {RestartMechanism|null}
 */
export function restartMechanism(agent, platform) {
  const entry = asObject(agent)
  const supervisor = effectiveSupervisor(entry, platform)
  if (supervisor === 'launcher-live') return 'marker'
  if (supervisor === 'service') return 'service'
  if (entry.recipe === true && cwdOf(entry)) return 'recipe'
  return null
}

/**
 * Why no mechanism applies, for the manual_restart_required step.
 * @param {Record<string, any>} agent
 * @param {string} platform
 */
function manualReason(agent, platform) {
  const entry = asObject(agent)
  const prefix = platform === 'win32' && entry.supervisor === 'service' ? 'service supervisor ignored on win32, ' : ''
  if (entry.recipe !== true) return `${prefix}no supervisor and no launch recipe`
  if (!cwdOf(entry)) return `${prefix}launch recipe has no cwd`
  return `${prefix}no restart authority`
}

// -- Step builders -----------------------------------------------------------

/**
 * @param {StepKind} kind
 * @param {OnFailure} onFailure
 * @param {string} why
 * @param {{ target?: string, via?: RestartMechanism }} [extra]
 */
function step(kind, onFailure, why, extra) {
  /** @type {Record<string, any>} */
  const out = { kind }
  if (extra && extra.target !== undefined) out.target = extra.target
  if (extra && extra.via !== undefined) out.via = extra.via
  out.onFailure = onFailure
  out.why = why
  return out
}

/** @param {InstallMethod} method */
function snapshotStep(method) {
  return method === 'clone'
    ? step('snapshot', 'stop', 'record HEAD before fast-forward')
    : step('snapshot', 'stop', 'snapshot installed_plugins.json and settings.json before mutating')
}

/**
 * Assign the positional, stable ids and fix the key order of every step.
 * @param {Record<string, any>[]} steps
 * @returns {PlanStep[]}
 */
function withIds(steps) {
  return steps.map((raw, index) => {
    const suffix = raw.target !== undefined ? `-${raw.target}` : ''
    const id = `s${String(index + 1).padStart(2, '0')}-${raw.kind}${suffix}`
    /** @type {Record<string, any>} */
    const out = { id, kind: raw.kind }
    if (raw.target !== undefined) out.target = raw.target
    if (raw.via !== undefined) out.via = raw.via
    out.onFailure = raw.onFailure
    out.why = raw.why
    return /** @type {PlanStep} */ (out)
  })
}

/**
 * @param {BlockedReason} reason
 * @param {string|null} targetVersion
 * @param {string[]} [notes]
 * @returns {MachinePlan}
 */
function blocked(reason, targetVersion, notes) {
  return { verdict: 'blocked', reason, targetVersion, steps: [], notes: notes ? [...notes] : [] }
}

/** @param {Record<string, any>} input @returns {string|null} */
function observedLatest(input) {
  if (input.installMethod === 'marketplace') return validVersion(asObject(input.marketplace).latestVersion)
  if (input.installMethod === 'clone') return validVersion(asObject(input.clone).latestVersion)
  return null
}

// -- Install phase -----------------------------------------------------------

/**
 * @typedef {object} InstallPhase
 * @property {BlockedReason} [blocked]
 * @property {Record<string, any>[]} steps
 * @property {string|null} targetVersion
 * @property {boolean} mutated   true when the phase installs / updates / reinstalls / fast-forwards
 * @property {boolean} [reobserve] true when the phase could not decide and the executor must plan again
 */

/**
 * @param {Record<string, any>} input
 * @param {Intent} intent
 * @returns {InstallPhase}
 */
function planMarketplace(input, intent) {
  const marketplace = asObject(input.marketplace)
  const installed = asObject(input.installed)
  const registered = marketplace.registered === true
  const present = installed.present === true
  const latestRaw = validVersion(marketplace.latestVersion)
  const installedRaw = validVersion(installed.version)
  const latest = parseSemver(latestRaw)
  const current = parseSemver(installedRaw)

  if (intent === 'restart_only') {
    return { steps: [], targetVersion: present ? installedRaw : null, mutated: false }
  }

  /** @type {Record<string, any>[]} */
  const steps = []
  if (!registered) steps.push(step('register_marketplace', 'stop', 'hoai marketplace not registered'))

  if (!present) {
    steps.push(step('refresh_marketplace', 'stop', 'refresh marketplace index before install'))
    steps.push(snapshotStep('marketplace'))
    steps.push(step('install_plugin', 'escalate', 'plugin not installed'))
    steps.push(step('verify_installed', 'rollback', latestRaw ? `confirm installed version is ${latestRaw}` : 'confirm plugin installed, version unknown until refresh'))
    return { steps, targetVersion: latestRaw, mutated: true }
  }

  if (!latest) {
    // The planner never guesses: refresh, verify what is there, let the
    // executor re-observe with a readable marketplace.json.
    steps.push(step('refresh_marketplace', 'stop', 'latest unknown before refresh'))
    steps.push(step('verify_installed', 'stop', 'latest unknown before refresh'))
    return { steps, targetVersion: null, mutated: false, reobserve: true }
  }

  if (!current) return { blocked: 'installed_version_unknown', steps: [], targetVersion: latestRaw, mutated: false }
  if (current.major !== latest.major) return { blocked: 'major_version_blocked', steps: [], targetVersion: latestRaw, mutated: false }

  if (intent === 'repair') {
    steps.push(step('refresh_marketplace', 'stop', 'refresh marketplace index before reinstall'))
    steps.push(snapshotStep('marketplace'))
    steps.push(step('reinstall_plugin', 'rollback', `repair requested, reinstall ${latestRaw}`))
    steps.push(step('verify_installed', 'rollback', `confirm installed version is ${latestRaw}`))
    return { steps, targetVersion: latestRaw, mutated: true }
  }

  if (compareSemver(latest, current) > 0) {
    steps.push(step('refresh_marketplace', 'stop', 'refresh marketplace index before update'))
    steps.push(snapshotStep('marketplace'))
    steps.push(step('update_plugin', 'escalate', `installed ${installedRaw}, marketplace has ${latestRaw}`))
    steps.push(step('verify_installed', 'rollback', `confirm installed version is ${latestRaw}`))
    return { steps, targetVersion: latestRaw, mutated: true }
  }

  // Nothing newer (or a local build ahead of the marketplace: never downgrade).
  if (steps.length > 0) steps.push(step('refresh_marketplace', 'stop', 'refresh marketplace index after registering'))
  return { steps, targetVersion: installedRaw, mutated: false }
}

/**
 * @param {Record<string, any>} input
 * @param {Intent} intent
 * @param {string[]} notes
 * @returns {InstallPhase}
 */
function planClone(input, intent, notes) {
  const clone = asObject(input.clone)
  const runningRaw = validVersion(input.runningVersion)
  const latestRaw = validVersion(clone.latestVersion)

  if (intent === 'restart_only') return { steps: [], targetVersion: runningRaw, mutated: false }

  const latest = parseSemver(latestRaw)
  if (!latest) {
    notes.push('clone latest unknown, no fast-forward planned')
    return { steps: [], targetVersion: runningRaw, mutated: false }
  }
  const running = parseSemver(runningRaw)
  if (!running) return { blocked: 'installed_version_unknown', steps: [], targetVersion: latestRaw, mutated: false }
  if (running.major !== latest.major) return { blocked: 'major_version_blocked', steps: [], targetVersion: latestRaw, mutated: false }
  if (compareSemver(latest, running) <= 0) return { steps: [], targetVersion: runningRaw, mutated: false }

  // Something to pull: only now do the tree checks matter.
  if (clone.dirty === true) return { blocked: 'dirty_tree', steps: [], targetVersion: latestRaw, mutated: false }
  if (clone.canFastForward !== true) return { blocked: 'not_fast_forward', steps: [], targetVersion: latestRaw, mutated: false }

  return {
    steps: [
      snapshotStep('clone'),
      step('git_fast_forward', 'rollback', `clone at ${runningRaw}, origin has ${latestRaw}`),
      step('verify_installed', 'rollback', `confirm checkout is ${latestRaw}`),
    ],
    targetVersion: latestRaw,
    mutated: true,
  }
}

// -- Agent phase -------------------------------------------------------------

/**
 * Why this agent restarts in this plan, or null when it is left alone.
 * @param {AgentState} agent
 * @param {Intent} intent
 * @param {boolean} mutated
 * @param {string|null} target
 * @returns {string|null}
 */
function restartReason(agent, intent, mutated, target) {
  if (mutated) return `after install of ${target ?? 'new version'}`
  if (intent === 'restart_only') return 'restart requested'
  if (intent === 'repair') return 'repair requested'
  if (agent.running !== true) return 'agent not running'
  const running = parseSemver(agent.version)
  const wanted = parseSemver(target)
  if (running && wanted && compareSemver(running, wanted) !== 0) return `agent runs ${agent.version}, installed ${target}`
  return null
}

// -- The planner -------------------------------------------------------------

/**
 * @param {ObservedMachineState} state
 * @returns {MachinePlan}
 */
export function planMachine(state) {
  const input = asObject(state)
  const intent = input.intent
  const installMethod = input.installMethod
  const platform = typeof input.platform === 'string' ? input.platform : 'linux'

  if (!INTENTS.includes(intent)) return blocked('unknown_intent', observedLatest(input))
  if (!INSTALL_METHODS.includes(installMethod)) return blocked('unknown_install_method', null)
  if (input.rollbackLatched === true && intent !== 'restart_only') return blocked('rollback_latched', observedLatest(input))
  if (input.autoUpdateEnabled !== true && intent !== 'restart_only') return blocked('updates_disabled', observedLatest(input))

  const normalized = normalizeAgents(input.agents)
  const agents = normalized.agents
  const notes = input.rollbackLatched === true ? ['updates latched, restart only', ...normalized.notes] : normalized.notes
  const install = installMethod === 'marketplace' ? planMarketplace(input, intent) : planClone(input, intent, notes)
  if (install.blocked) return blocked(install.blocked, install.targetVersion, notes)
  if (install.reobserve) {
    // A partial plan: nothing about agents or the watcher until the executor
    // has re-observed with a readable marketplace index and planned again.
    return {
      verdict: 'plan',
      reobserve: true,
      targetVersion: null,
      steps: withIds(install.steps),
      notes: [...notes, 'agent steps deferred until latest version is known'],
    }
  }

  const steps = [...install.steps]
  const target = install.targetVersion
  let restarted = 0
  for (const agent of agents) {
    const reason = restartReason(agent, intent, install.mutated, target)
    if (!reason) continue
    const via = restartMechanism(agent, platform)
    if (!via) {
      steps.push(step('manual_restart_required', 'continue', `${manualReason(agent, platform)}: ${reason}`, { target: agent.assistantId }))
      continue
    }
    steps.push(step('restart_agent', 'continue', `restart via ${MECHANISM_LABEL[via]}: ${reason}`, { target: agent.assistantId, via }))
    steps.push(step('verify_agent', install.mutated ? 'rollback' : 'continue', 'channel-live marker newer than restart', { target: agent.assistantId }))
    restarted += 1
  }
  if (install.mutated && restarted === 0) {
    steps.push(step('stage_pending_restart', 'stop', `installed ${target ?? 'new version'} but no agent can be restarted`))
  }
  if (input.refreshWatcher === true) steps.push(step('refresh_watcher', 'continue', 'watcher bundle is stale'))

  return {
    verdict: steps.length > 0 ? 'plan' : 'nothing_to_do',
    targetVersion: target,
    steps: withIds(steps),
    notes,
  }
}
