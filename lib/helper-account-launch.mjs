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

function continueTranscript(source, destination, base, required) {
  if (!existsSync(source)) {
    if (required) throw new Error('account_session_unavailable')
    return
  }
  if (!lstatSync(source).isFile()) throw new Error('account_session_unavailable')
  ensurePrivateParent(base, destination)
  if (existsSync(destination)) {
    const old = statSync(source),
      next = lstatSync(destination)
    if (!next.isFile() || old.ino !== next.ino || old.dev !== next.dev) throw new Error('account_session_conflict')
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
}) {
  const unassigned = () => {
    if (isManagedProfile(home, env.CLAUDE_CONFIG_DIR))
      throw new Error('account_profile_unavailable')
    return false
  }
  if (!/^\d+$/.test(String(assistantId))) return unassigned()
  const registry = readAccountRegistry(home)
  if (!registry) return unassigned()
  const agentHome = join(home, '.bgos-agent')
  const watcher = json(join(agentHome, 'watcher', 'credentials.json'))
  if (watcher?.machineId !== registry.machineId || Number(watcher?.pairingId) !== registry.pairingId) return unassigned()
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
  if (choice !== null && !registry.accounts.some((a) => a.id === choice)) throw new Error('account_profile_unavailable')
  const configDir = choice ? profileDirectory(home, choice) : target?.originalDir || null
  if (configDir && !isLocalProfile(configDir)) throw new Error('account_profile_unavailable')
  const from = previousConfigDir === undefined ? env.CLAUDE_CONFIG_DIR || null : previousConfigDir
  const oldDir = from || join(home, '.claude'),
    newDir = configDir || join(home, '.claude')
  if (choice && resolve(oldDir) !== resolve(newDir)) carryMarketplace(oldDir, newDir, scriptDir)
  if (sessionId && resolve(oldDir) !== resolve(newDir)) {
    prepareHelperTranscript({ home, cwd, sessionId, from, to: configDir, sessionTranscriptPath, required: Boolean(target?.transition) })
  }
  isolateProfileEnv(env, configDir)
  return target?.transition ? 'switching' : true
}
