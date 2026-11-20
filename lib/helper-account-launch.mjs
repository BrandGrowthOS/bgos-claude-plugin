import { randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { readInstalledHoaiPlugins } from '../bin/bgos-install-method.mjs'
import { accountsRoot, profileDirectory, readAccountRegistry } from './helper-accounts.mjs'

function json(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Only the identity of the local pairing is used. Never return its credential. */
export function localPairing(path) {
  const entry = json(path)
  if (!entry || typeof entry.userId !== 'string' || !Number.isSafeInteger(entry.pairingId)) return null
  return {
    userId: entry.userId,
    pairingId: entry.pairingId,
    assistantId: Number(entry.assistantId),
    backendUrl: entry.backendUrl,
  }
}

const PROFILE_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
])

/** The login and provider settings a launch carried, kept so a return to that login restores them. */
export function profileEnvOf(env) {
  const kept = {}
  for (const key of Object.keys(env)) {
    if (PROFILE_ENV_KEYS.has(key.toUpperCase()) && typeof env[key] === 'string') kept[key] = env[key]
  }
  return kept
}

/** Put the launch login back: drop any login setting a saved account added, restore the launch's own. */
export function restoreProfileEnv(env, launchEnv) {
  for (const key of Object.keys(env)) {
    if (PROFILE_ENV_KEYS.has(key.toUpperCase())) delete env[key]
  }
  for (const [key, value] of Object.entries(launchEnv)) {
    if (PROFILE_ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string') env[key] = value
  }
}

const denied = () => {
  throw new Error('account_profile_unavailable')
}

/** The settings that limit what an agent may do. Agents run with --dangerously-skip-permissions,
 *  so these are the only checks left: a saved login must never run without them. */
const GUARDRAIL_KEYS = ['permissions', 'hooks', 'sandbox', 'disableAllHooks']
const MAX_INSTRUCTIONS_BYTES = 1024 * 1024

/** Mirror the source login's guardrail settings and its global CLAUDE.md into a saved login, at
 *  every start, so a rule the owner adds or removes takes effect there too. Source settings that
 *  cannot be read stop the start: an agent never runs without the owner's guardrails. */
export function carryGuardrails(source, profile) {
  if (resolve(source) === resolve(profile)) return
  const settingsPath = join(source, 'settings.json')
  let settings = {}
  const entry = lstatSync(settingsPath, { throwIfNoEntry: false })
  if (entry) {
    if (!entry.isFile()) denied()
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      denied()
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) denied()
  }
  writeProfileJson(profile, join(profile, 'settings.json'), (doc) => {
    const next = { ...doc }
    for (const key of GUARDRAIL_KEYS) {
      if (Object.hasOwn(settings, key)) next[key] = settings[key]
      else delete next[key]
    }
    return next
  })
  const instructions = join(source, 'CLAUDE.md')
  const target = join(profile, 'CLAUDE.md')
  const found = lstatSync(instructions, { throwIfNoEntry: false })
  const present = lstatSync(target, { throwIfNoEntry: false })
  if (present && !present.isFile()) denied()
  if (!found) {
    if (present) unlinkSync(target)
    return
  }
  if (!found.isFile() || found.size > MAX_INSTRUCTIONS_BYTES) denied()
  const text = readFileSync(instructions)
  if (present && readFileSync(target).equals(text)) return
  const temp = join(profile, randomUUID() + '.tmp')
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
  renameSync(temp, target)
}

export function isolateProfileEnv(env, configDir) {
  for (const key of Object.keys(env)) {
    if (PROFILE_ENV_KEYS.has(key.toUpperCase())) delete env[key]
  }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
}

export function isManagedProfile(home, dir) {
  return Boolean(dir && resolve(dir).startsWith(resolve(accountsRoot(home)) + sep))
}

export function isLocalProfile(dir) {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false
  return ['.credentials.json', '.claude.json', 'settings.json', 'settings.local.json'].every((name) => {
    const entry = lstatSync(join(dir, name), { throwIfNoEntry: false })
    return !entry || entry.isFile()
  })
}

function ensurePrivateParent(base, path) {
  let parent = base
  if (!lstatSync(base).isDirectory()) throw new Error('account_profile_unavailable')
  for (const part of relative(base, dirname(path)).split(sep).filter(Boolean)) {
    if (part === '..') throw new Error('account_profile_unavailable')
    parent = join(parent, part)
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 })
    if (!lstatSync(parent).isDirectory()) throw new Error('account_profile_unavailable')
  }
}

function writeProfileJson(base, path, change) {
  ensurePrivateParent(base, path)
  let before = {}
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw new Error('account_profile_unavailable')
    before = JSON.parse(readFileSync(path, 'utf8'))
  }
  const next = change(before)
  if (JSON.stringify(next) === JSON.stringify(before)) return
  const temp = join(dirname(path), randomUUID() + '.tmp')
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
  renameSync(temp, path)
}

// Reuse the machine's existing tap only when its owner selected that command.
// Other status lines can run arbitrary programs and stay in their own profile.
function inheritUsageTap(home, profile) {
  const script = '.claude/scripts/capkeeper-usage-tap.sh'
  const installed = join(home, script)
  try {
    if (!lstatSync(installed, { throwIfNoEntry: false })?.isFile()) return
    const source = json(join(home, '.claude', 'settings.json'))?.statusLine
    if (source?.type !== 'command' || typeof source.command !== 'string') return
    const path = source.command.trim().replace(/^(?:\/bin\/)?bash\s+/, '')
    if (![`~/${script}`, `$HOME/${script}`, `"$HOME/${script}"`, installed, `"${installed}"`, `'${installed}'`].includes(path)) return
    writeProfileJson(profile, join(profile, 'settings.json'), (doc) =>
      Object.hasOwn(doc, 'statusLine') ? doc : {
        ...doc, statusLine: { type: 'command', command: `bash "$HOME/${script}"` },
      })
  } catch {
    // Telemetry is optional. A profile whose settings cannot be read still launches.
  }
}

// A new login has no plugin inventory. For an already-installed HOAI
// marketplace launcher register exactly its existing code and marketplace
// name. The target keeps its own settings and all its login material.
function carryMarketplace(from, to, scriptDir) {
  if (!scriptDir) return
  const root = resolve(scriptDir, '..')
  const entry = readInstalledHoaiPlugins({ configDir: from }).find((p) => resolve(p.installPath) === root)
  if (!entry) return
  const record = { scope: 'user', version: entry.version, installPath: entry.installPath }
  writeProfileJson(to, join(to, 'plugins', 'installed_plugins.json'), (doc) => ({
    ...doc,
    version: 2,
    plugins: { ...doc.plugins, [entry.id]: [record] },
  }))
  writeProfileJson(to, join(to, 'settings.json'), (doc) => ({
    ...doc,
    enabledPlugins: { ...doc.enabledPlugins, [entry.id]: true },
  }))
}

const knownNumber = (value) => typeof value === 'bigint' && value > 0n

/** "dev:ino" from a bigint stat, or null when either number is unknown. Never throws. */
function fileIdentOf(path, follow) {
  try {
    const { dev, ino } = follow ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true })
    return knownNumber(dev) && knownNumber(ino) ? `${dev}:${ino}` : null
  } catch {
    return null
  }
}

function continueTranscript(source, destination, base, required) {
  if (!existsSync(source)) {
    if (required) throw new Error('account_session_unavailable')
    return
  }
  if (!lstatSync(source).isFile()) throw new Error('account_session_unavailable')
  ensurePrivateParent(base, destination)
  if (existsSync(destination)) {
    // The same file only when both file numbers are known and equal: an unknown number (0 on
    // some drives) or a large id a plain number would round is never taken as the conversation.
    const old = fileIdentOf(source, true),
      next = fileIdentOf(destination, false)
    if (!lstatSync(destination).isFile() || old === null || old !== next) throw new Error('account_session_conflict')
    return
  }
  // Link only this conversation. The old profile and the new profile continue
  // to see the same append-only transcript, including after a rollback.
  linkSync(source, destination)
}

/** Verify and link this one session before requesting a stop, then check the
 * same paths again after exit in the supervisor. This also checks that the
 * file systems actually support the required hard link. */
export function prepareHelperTranscript({ home, cwd, sessionId, from, to, sessionTranscriptPath, required }) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(sessionId) || !cwd) throw new Error('account_session_invalid')
  const oldDir = from || join(home, '.claude')
  const newDir = to || join(home, '.claude')
  const source = sessionTranscriptPath(home, cwd, sessionId, from)
  const destination = sessionTranscriptPath(home, cwd, sessionId, to)
  if (existsSync(source) && !realpathSync(source).startsWith(realpathSync(oldDir) + sep))
    throw new Error('account_session_invalid')
  continueTranscript(source, destination, newDir, required)
}

/** Called in the launcher after the previous child has stopped. A different
 * OS home, HOAI owner or pairing never inherits this computer's default. */
export function applyHelperAccount({
  home,
  cwd,
  env,
  assistantId,
  sessionId,
  sessionTranscriptPath,
  previousConfigDir = undefined,
  scriptDir = '',
  launchEnv = undefined,
}) {
  // The folder the previous child ran with, read before the launch login is put back.
  const from = previousConfigDir === undefined ? env.CLAUDE_CONFIG_DIR || null : previousConfigDir
  // Every decision starts from the login this supervisor was launched with. A saved
  // login applied earlier must never leak into a later start that is not assigned one,
  // and a return to the launch login gets its provider settings back (finding F2).
  if (launchEnv) restoreProfileEnv(env, launchEnv)
  const unassigned = () => {
    if (isManagedProfile(home, env.CLAUDE_CONFIG_DIR))
      throw new Error('account_profile_unavailable')
    return false
  }
  if (!/^\d+$/.test(String(assistantId))) return unassigned()
  let registry
  try {
    registry = readAccountRegistry(home)
  } catch {
    // A registry that cannot be read names no agent: only an agent already
    // running in a saved login stops (unassigned throws for it). Finding F3.
    return unassigned()
  }
  if (!registry) return unassigned()
  const agentHome = join(home, '.bgos-agent')
  const watcher = json(join(agentHome, 'watcher', 'credentials.json'))
  if (watcher?.machineId !== registry.machineId || Number(watcher?.pairingId) !== registry.pairingId) return unassigned()
  // Review #4: a registry another backend issued never chooses a login (pairing numbers are per database).
  if (typeof watcher?.backendUrl !== 'string' || (registry.backendUrl ?? null) !== watcher.backendUrl) return unassigned()
  const ownPath = join(agentHome, `credentials-${assistantId}.json`)
  const owner = localPairing(env.BGOS_CREDENTIALS_PATH || (existsSync(ownPath) ? ownPath : join(agentHome, 'credentials.json')))
  if (
    !owner ||
    typeof owner.backendUrl !== 'string' || !owner.backendUrl ||
    owner.backendUrl !== watcher.backendUrl ||
    owner.assistantId !== Number(assistantId) ||
    registry.ownerUserId !== owner.userId
  )
    return unassigned()
  const target = registry.targets[String(assistantId)]
  const override = target?.pairingId === owner.pairingId && Object.hasOwn(target, 'choice')
  const choice = override ? target.choice : registry.targets.computer?.choice
  if (choice === undefined) return unassigned()
  // The computer default is a preference: when its saved login is gone, agents start
  // on their own login. The owner's choice for THIS agent is never silently replaced.
  const missing = () => (override ? denied() : unassigned())
  if (choice !== null && !registry.accounts.some((a) => a.id === choice)) return missing()
  const launchDir = launchEnv ? launchEnv.CLAUDE_CONFIG_DIR || null : null
  const unmanaged = (dir) => (dir && !isManagedProfile(home, dir) ? dir : null)
  const configDir = choice
    ? profileDirectory(home, choice)
    : target?.originalDir || unmanaged(launchDir)
  if (configDir && !isLocalProfile(configDir)) return choice ? missing() : denied()
  const oldDir = from || join(home, '.claude'),
    newDir = configDir || join(home, '.claude')
  if (choice) {
    // The saved login runs with the guardrails of the login the owner set up (finding F1).
    const source = unmanaged(launchDir) || unmanaged(target?.originalDir) || unmanaged(from) || join(home, '.claude')
    carryGuardrails(source, newDir)
  }
  if (choice && resolve(oldDir) !== resolve(newDir)) carryMarketplace(oldDir, newDir, scriptDir)
  if (choice) inheritUsageTap(home, newDir)
  if (sessionId && resolve(oldDir) !== resolve(newDir)) {
    prepareHelperTranscript({ home, cwd, sessionId, from, to: configDir, sessionTranscriptPath, required: Boolean(target?.transition) })
  }
  if (choice) isolateProfileEnv(env, configDir)
  else if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  else delete env.CLAUDE_CONFIG_DIR
  return target?.transition ? 'switching' : true
}
