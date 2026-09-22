/**
 * claude-preseed: pre-seed Claude Code's one-time prompts for an agent folder
 * so an UNATTENDED first launch never stops on a hidden question.
 *
 * A verbatim port (behaviour, not just intent) of the preseed snippet both
 * bootstraps embed (bin/hoai-bootstrap.sh ~544-581, bin/hoai-bootstrap.ps1
 * ~400-445), kept as a library so the per-machine watcher can create an agent
 * with no terminal at all:
 *   the config file            hasCompletedOnboarding (default true) and theme
 *                              (default "dark") for the first-run wizard, and
 *                              projects[<cwd>] = the FULL entry shape Claude
 *                              Code itself writes on a real trust accept. A
 *                              minimal {hasTrustDialogAccepted:true} entry is
 *                              NOT honoured (verified live 2026-08-22 on
 *                              2.1.239: the dialog still rendered until the
 *                              sibling fields existed), and the key must match
 *                              process.cwd() byte for byte, so a win32 cwd is
 *                              seeded under both slash spellings (the ps1 rule).
 *   <configDir>/settings.json  skipDangerousModePermissionPrompt = true: the
 *                              bypass warning's DEFAULT answer is exit, so it
 *                              must never be blind-Entered (landmine 2).
 *
 * THE TWO FILES DO NOT LIVE IN THE SAME PLACE, and assuming they did is the
 * defect this module shipped with. settings.json really is inside the config
 * dir. The config file is NOT: Claude Code reads $CLAUDE_CONFIG_DIR/.claude.json
 * when that variable is set, and $HOME/.claude.json when it is not. See
 * claudeConfigFilePath.
 *
 * Merge rule per project entry, exactly the snippet's:
 *   Object.assign({defaults}, existing, {hasTrustDialogAccepted: true})
 * so a user's own allowedTools survive and the trust flag always wins.
 * Idempotent: a second run rewrites identical bytes.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; the fs is injected
 * (readFile -> string|null, writeFile(path, text)) so tests run in memory.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

/** The default entry fields, in the bootstrap's key order (the trust flag is
 *  applied last, on top, so it is not part of the defaults object). */
export const TRUST_ENTRY_DEFAULTS = Object.freeze({
  allowedTools: [],
  disabledMcpjsonServers: [],
  enabledMcpjsonServers: [],
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
  mcpContextUris: [],
  projectOnboardingSeenCount: 1,
  hasCompletedProjectOnboarding: true,
})

/** @typedef {{ readFile: (path: string) => string | null, writeFile: (path: string, text: string) => void,
 *   rename?: (from: string, to: string) => void
 * }} PreseedFs */

/** @returns {PreseedFs} */
function defaultPreseedFs() {
  return {
    rename: (from, to) => renameSync(from, to),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (path, text, opts) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text, opts?.mode === undefined ? undefined : { mode: opts.mode })
    },
    // Tells "there is no file yet" apart from "there is one and it could not be read". Optional on
    // the injected shape: without it, a null read means absent, which is what a test fs means by it.
    exists: (path) => existsSync(path),
    // The mode of the file being replaced, so a rename never widens it. Claude Code keeps
    // ~/.claude.json at 0600; a fresh temp file under umask 022 is 0644.
    modeOf: (path) => {
      try {
        return statSync(path).mode & 0o777
      } catch {
        return null
      }
    },
    chmod: (path, mode) => chmodSync(path, mode),
    // Only ever used to clear a temp file whose rename failed. Optional on the injected shape, so a
    // test fs without it stays valid; writeJsonAtomic calls it with ?. for that reason.
    remove: (path) => {
      try {
        unlinkSync(path)
      } catch {
        // Never existed, or already gone.
      }
    },
  }
}

/** The snippet's load(): parse JSON, or {} for absent / empty / corrupt. */
/**
 * Load the owner's Claude Code config for a read-modify-write, or REFUSE.
 *
 * This file is not ours. It holds the owner's account, every project entry and
 * their MCP servers, live Claude Code sessions rewrite it constantly, and this
 * seed runs on every pairing and every hoai launch. loadJsonOrEmpty's rule
 * ("unreadable means empty, then write") was measured on 2026-09-22 replacing a
 * 0600 file it could not parse with a five line config, no backup, no log line,
 * and the callers printed success. Every way of failing to read it did the
 * same: a parse error, a zero byte file, a non-object, EACCES. A torn read of a
 * file another process is mid-way through writing is one of those.
 *
 * So: no file yet is an empty config (a brand new machine, creating it is the
 * job). A file that is there and cannot be read as a JSON object is left
 * EXACTLY as it is and the seed throws; every caller already turns that into a
 * note. Skipping a seed is cheap now, because the startup gate block answers
 * the trust and bypass screens itself when they do appear.
 */
function loadOwnerConfigOrRefuse(fs, path) {
  const raw = fs.readFile(path)
  const present = typeof fs.exists === 'function' ? fs.exists(path) : raw != null
  if (!present) return {}
  let parsed
  try {
    parsed = JSON.parse(String(raw ?? ''))
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${path} exists but could not be read as a JSON object, so it was left untouched ` +
        '(it holds your Claude Code account and projects; replacing it is not worth one skipped prompt)',
    )
  }
  return parsed
}

function loadJsonOrEmpty(readFile, path) {
  const raw = readFile(path)
  if (raw == null) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Join preserving the directory's separator style (a win32 config dir stays win32). */
function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** The file name of Claude Code's own config file, in both places it can live. */
export const CLAUDE_CONFIG_FILE_NAME = '.claude.json'

/**
 * WHERE Claude Code actually keeps .claude.json.
 *
 * NOT inside the config dir, unless CLAUDE_CONFIG_DIR says so. The rule the CLI
 * itself follows is:
 *   CLAUDE_CONFIG_DIR set    -> $CLAUDE_CONFIG_DIR/.claude.json
 *   CLAUDE_CONFIG_DIR unset  -> $HOME/.claude.json        (NOT $HOME/.claude/.claude.json)
 *
 * WHY THIS IS ITS OWN FUNCTION, and the fact that cost a real install: the
 * config dir resolver (bin/bgos-install-method.mjs claudeConfigDir) answers
 * "$CLAUDE_CONFIG_DIR, else $HOME/.claude", and settings.json genuinely does
 * live in there. Joining '.claude.json' onto that same directory is therefore
 * right exactly half the time, and the wrong half is the DEFAULT one: with the
 * variable unset it writes $HOME/.claude/.claude.json, a file Claude Code never
 * opens, while the live $HOME/.claude.json keeps its untouched trust state.
 * Nothing fails. The seed simply does not take, and the first launch still
 * stops on the trust dialog with every log line reporting success. Measured on
 * this machine 2026-09-21: $HOME/.claude.json 143,684 bytes with numStartups,
 * firstStartTime and 34 projects; $HOME/.claude/.claude.json absent.
 *
 * The two spellings cannot be told apart from the config dir alone (an unset
 * variable with home /home/kc and CLAUDE_CONFIG_DIR=/home/kc/.claude both
 * produce '/home/kc/.claude', and they want DIFFERENT files), which is why the
 * environment is read here rather than inferred from a path.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [params]
 * @returns {string}
 */
export function claudeConfigFilePath({ env = process.env, home = homedir() } = {}) {
  const override = String(env?.CLAUDE_CONFIG_DIR ?? '').trim()
  if (override) return joinDir(override, CLAUDE_CONFIG_FILE_NAME)
  const base = String(home ?? '').trim()
  if (!base) {
    throw new Error(
      'claudeConfigFilePath: no CLAUDE_CONFIG_DIR and no home directory, so Claude Code\'s ' +
        '.claude.json cannot be located. Refusing to guess: a seed written to the wrong file ' +
        'reports success and changes nothing.',
    )
  }
  return joinDir(base, CLAUDE_CONFIG_FILE_NAME)
}

/**
 * One seeded project entry: defaults, then the existing entry, then the trust
 * flag forced on. Pure.
 * @param {Record<string, unknown> | undefined | null} existing
 */
export function seedProjectEntry(existing) {
  const current = existing && typeof existing === 'object' ? existing : {}
  return Object.assign(
    { ...TRUST_ENTRY_DEFAULTS, allowedTools: [], disabledMcpjsonServers: [], enabledMcpjsonServers: [], mcpContextUris: [] },
    current,
    { hasTrustDialogAccepted: true },
  )
}

/** The ps1 rule: the other slash spelling of a path (every separator flipped). */
export function alternateSlashSpelling(path) {
  const value = String(path ?? '')
  return value.includes('\\') ? value.split('\\').join('/') : value.split('/').join('\\')
}

/** A win32-shaped cwd (drive letter or a backslash) gets both spellings seeded. */
function looksWin32(path) {
  const value = String(path ?? '')
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
}

/**
 * The path with every symlink resolved, or null when it cannot be resolved.
 *
 * WHY THIS EXISTS, measured 2026-09-21 on a fresh folder. Claude Code keys
 * `projects` on the RESOLVED cwd, and this function seeds the cwd AS GIVEN.
 * `/var` is a symlink to `/private/var` on every Mac, so a seed for a folder
 * under `/tmp` or `/var` lands on a key the CLI never looks up:
 *
 *   seeded /var/folders/.../x          -> the trust dialog STILL APPEARED
 *   seeded /private/var/folders/.../x  -> the dialog was GONE
 *
 * That is F4's shape one level down. F4 fixed the FILE this writes to; this is
 * the KEY inside it, and it fails the same way, by reporting success while
 * changing nothing. `~/hoai-agents/<name>` is unaffected because no component
 * of that path is a symlink, which is why it survived every existing test.
 *
 * Returns null rather than throwing: an unresolvable path (it does not exist
 * yet, or a permission refuses the walk) must leave the literal seed in place,
 * never cost the caller the seed it asked for.
 *
 * @param {string} path
 * @param {(p: string) => string} resolve
 *   injected so a test can describe a symlink without making one. Typed as a
 *   plain function rather than `typeof realpathSync`, whose `.native` member a
 *   test double would otherwise have to fake for no behavioural reason.
 * @returns {string | null}
 */
export function resolvedPathOrNull(path, resolve = /** @type {(p: string) => string} */ (realpathSync)) {
  const value = String(path ?? '').trim()
  if (!value) return null
  try {
    const resolved = String(resolve(value) ?? '')
    return resolved && resolved !== value ? resolved : null
  } catch {
    return null
  }
}

/**
 * Pre-seed trust + prompt acceptance for `cwd`.
 *
 * `configDir` locates settings.json only. The config file is located from the
 * ENVIRONMENT (claudeConfigFilePath), because those two answers differ whenever
 * CLAUDE_CONFIG_DIR is unset, which is every default install.
 * @param {{ configDir: string, cwd: string, fs?: PreseedFs,
 *   env?: Record<string, string | undefined>, home?: string }} params
 * @returns {{ configPath: string, settingsPath: string, seededKeys: string[] }}
 */
/** Write-then-rename when the fs offers rename, so a concurrent reader (a live
 *  claude process) never sees a half-written .claude.json / settings.json. */
function writeJsonAtomic(fs, path, value) {
  const text = JSON.stringify(value, null, 2)
  if (typeof fs.rename !== 'function') {
    fs.writeFile(path, text)
    return
  }
  const tmp = `${path}.${process.pid}.tmp`
  // Keep the mode of the file being replaced, and give a file that is being CREATED the mode
  // Claude Code itself uses for it. Measured 2026-09-22: a 0600 ~/.claude.json came back 0644.
  const mode = fs.modeOf?.(path) ?? 0o600
  fs.writeFile(tmp, text, { mode })
  try {
    fs.chmod?.(tmp, mode)
  } catch {
    // A filesystem with no modes. The write itself is what matters.
  }
  try {
    fs.rename(tmp, path)
  } catch (err) {
    // A failed rename used to leave the temp file on disk forever. That matters here more than it
    // looks: this path runs on every daemon boot, in the user's ~/.claude, and the residue sits
    // beside the file Claude Code itself reads. Cross-device renames and a locked target are the
    // two ways it actually fails on Windows. Clean up, then rethrow: the caller's try/catch turns
    // this into a log line, which is right, because the write genuinely did not happen.
    try {
      fs.remove?.(tmp)
    } catch {
      // Never existed, or already gone. Either way there is nothing left to do about it.
    }
    throw err
  }
}

/**
 * Write, then read back, and only report success if the change survived.
 *
 * WHY A PLAIN WRITE IS NOT ENOUGH. Two separate OS processes write these files: this daemon, and
 * the `claude` binary itself. Neither takes a lock, and the CLI does not, so a lock on our side
 * would protect nothing. The sequence that loses our key is ordinary: we read settings.json, claude
 * reads it too, we write, claude writes its own copy from the snapshot it read before ours. Our
 * change is gone, and the old code had already logged that the machine now self-updates.
 *
 * The retry is immediate and deliberately has no delay: this is a synchronous function on a daemon
 * boot path, so a delay would have to be a busy wait. It still helps, because by the time we observe
 * that we lost, the writer that beat us has FINISHED its write; re-reading and writing again lands
 * unless it writes twice in a row. What matters more than the retry is the READ BACK: after this
 * returns null the caller knows the key is not on disk, and can say so instead of claiming a state
 * that does not exist. The windows for context: ours is about 2.5 ms, claude's 80 to 300 ms.
 *
 * @param {PreseedFs} fs
 * @param {string} path
 * @param {(current: Record<string, unknown>) => Record<string, unknown> | null} mutate
 *   returns the value to write, or null to abandon the attempt entirely
 * @param {(reread: Record<string, unknown>) => boolean} holds
 *   given the file as it now reads, did our change survive?
 * @param {number} attempts
 * @returns {Record<string, unknown> | null} the written value, or null if it never held
 */
// `load` decides what an unreadable file means. The default keeps this module's old rule (empty,
// then write), which is deliberate for files the PLUGIN owns, such as an agent folder's
// settings.local.json: a corrupt one is replaced rather than failing the install. A caller
// touching a file the OWNER owns passes loadOwnerConfigOrRefuse instead.
function mutateJsonVerified(fs, path, mutate, holds, attempts = 3, load = (f, p) => loadJsonOrEmpty(f.readFile, p)) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    const current = load(fs, path)
    const next = mutate(current)
    if (next === null) return null
    writeJsonAtomic(fs, path, next)
    last = next
    if (holds(loadJsonOrEmpty(fs.readFile, path))) return next
  }
  return null
}

export function preseedClaudeTrust({
  configDir,
  cwd,
  fs = defaultPreseedFs(),
  env = process.env,
  home = homedir(),
  realpath = /** @type {(p: string) => string} */ (realpathSync),
}) {
  const dir = String(configDir ?? '').trim()
  const workdir = String(cwd ?? '')
  if (!dir) throw new Error('preseedClaudeTrust: configDir is required')
  if (!workdir.trim()) throw new Error('preseedClaudeTrust: cwd is required')

  // NOT joinDir(dir, '.claude.json'). See claudeConfigFilePath: with
  // CLAUDE_CONFIG_DIR unset the config file sits BESIDE the config dir, not in
  // it, and seeding the wrong one is a silent no-op that still reports success.
  const configPath = claudeConfigFilePath({ env, home })
  const cfg = loadOwnerConfigOrRefuse(fs, configPath)
  // Checked BEFORE anything is written, so an unreadable settings.json cannot leave a half-made seed.
  loadOwnerConfigOrRefuse(fs, joinDir(dir, 'settings.json'))
  if (cfg.hasCompletedOnboarding === undefined) cfg.hasCompletedOnboarding = true
  if (cfg.theme === undefined) cfg.theme = 'dark'
  cfg.projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}
  // BOTH spellings, always: the literal cwd the caller gave us AND the resolved
  // one, because we cannot tell from here which the CLI will look up, and a
  // key that is never read is a seed that reported success and did nothing.
  const seededKeys = [workdir]
  const resolved = resolvedPathOrNull(workdir, realpath)
  if (resolved) seededKeys.push(resolved)
  if (looksWin32(workdir)) seededKeys.push(alternateSlashSpelling(workdir))
  for (const key of seededKeys) cfg.projects[key] = seedProjectEntry(cfg.projects[key])
  writeJsonAtomic(fs, configPath, cfg)

  const settingsPath = joinDir(dir, 'settings.json')
  // Same race as the marketplace key, same fix: a concurrent `claude` can write its own snapshot
  // over ours between our read and our write, and the old code could not tell.
  mutateJsonVerified(
    fs,
    settingsPath,
    (settings) => {
      settings.skipDangerousModePermissionPrompt = true
      return settings
    },
    (reread) => reread.skipDangerousModePermissionPrompt === true,
    3,
    // The owner's settings.json (permissions, hooks, env) is no more ours to replace than their
    // config file: present and unreadable means leave it exactly as it is, and say so.
    loadOwnerConfigOrRefuse,
  )

  return { configPath, settingsPath, seededKeys }
}

/**
 * The hook events a HOAI clone install registers in its workspace settings.
 *
 * Byte-for-byte the same list hooks/hooks.json registers for a marketplace
 * install, because both shapes end in the same forwarder and the mapper is one
 * module. A test pins the two lists equal.
 */
export const HOOK_EVENT_NAMES = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
])

/** Seconds. The forwarder appends one line and exits; five is generous. */
export const HOOK_TIMEOUT_SECONDS = 5

/**
 * Give a CLONE install the hook rail a marketplace install gets for free.
 *
 * WHY THIS EXISTS, and it is the fact most likely to cost somebody a day: the
 * CLI reads a plugin's hooks/hooks.json ONLY for an INSTALLED plugin, under
 * ~/.claude/plugins. A clone install is not an installed plugin. It is a
 * checkout that publishes an MCP server entry through the workspace .mcp.json
 * and launches with `--dangerously-load-development-channels server:bgos`, so
 * nothing anywhere ever reads that checkout's hooks/hooks.json. The failure is
 * silence: the agent works, the chat works, and the tool activity rail is
 * simply never there, with no error to notice.
 *
 * The fix is the workspace settings file, which the CLI does read, holding the
 * same entries with the checkout's ABSOLUTE forwarder path. ${CLAUDE_PLUGIN_ROOT}
 * is unavailable outside a plugin's own hooks file ("This variable is only
 * available in hooks defined in a plugin's hooks/hooks.json file, not in
 * settings.json"), so the path is resolved by the caller and written literally.
 *
 * Idempotent by construction: it rewrites the whole `hooks` block for these
 * event names from one template, so a second run produces identical bytes and a
 * forwarder path that moved is corrected rather than duplicated. Any hook entry
 * a user added for another command is preserved.
 *
 * That is also how a clone install picks up a NEW event: an agent folder that
 * was already provisioned self heals on its next launch, when this runs again
 * and rewrites the block for the current list. It does not happen on upgrade,
 * so the event starts arriving one launch later than for a marketplace install.
 *
 * @param {{ settingsPath: string, forwarderPath: string, nodePath?: string, fs?: PreseedFs }} params
 * @returns {{ changed: boolean, reason: 'set'|'already'|'not_persisted'|'no_path' }}
 */
export function ensureHookEntries({
  settingsPath,
  forwarderPath,
  nodePath = 'node',
  fs = defaultPreseedFs(),
}) {
  const path = String(settingsPath ?? '').trim()
  const forwarder = String(forwarderPath ?? '').trim()
  if (!path) throw new Error('ensureHookEntries: settingsPath is required')
  if (!forwarder) return { changed: false, reason: 'no_path' }

  const entry = () => ({
    type: 'command',
    command: String(nodePath),
    args: [forwarder],
    timeout: HOOK_TIMEOUT_SECONDS,
    async: true,
  })

  /** Is our entry (and only ours) already in place for every event? */
  const holds = (settings) => {
    const hooks = settings && typeof settings === 'object' ? settings.hooks : null
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false
    return HOOK_EVENT_NAMES.every((name) => {
      const matchers = hooks[name]
      if (!Array.isArray(matchers)) return false
      return matchers.some(
        (matcher) =>
          matcher &&
          typeof matcher === 'object' &&
          Array.isArray(matcher.hooks) &&
          matcher.hooks.some(
            (h) =>
              h &&
              typeof h === 'object' &&
              h.type === 'command' &&
              Array.isArray(h.args) &&
              h.args.length === 1 &&
              h.args[0] === forwarder &&
              h.command === String(nodePath) &&
              h.timeout === HOOK_TIMEOUT_SECONDS &&
              h.async === true,
          ),
      )
    })
  }

  const before = loadJsonOrEmpty(fs.readFile, path)
  if (holds(before)) return { changed: false, reason: 'already' }

  // Same race as every other key here: a concurrent `claude` can write its own
  // snapshot over ours between our read and our write, and a plain write could
  // not tell. Write, read back, and only then report success.
  const written = mutateJsonVerified(
    fs,
    path,
    (settings) => {
      const hooks =
        settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
          ? settings.hooks
          : {}
      for (const name of HOOK_EVENT_NAMES) {
        const existing = Array.isArray(hooks[name]) ? hooks[name] : []
        // Drop any previous HOAI entry (an older forwarder path, a changed
        // timeout) so a moved checkout does not leave a second, dead hook
        // firing beside the live one. Everything else the user wrote stays.
        const kept = existing
          .map((matcher) => {
            if (!matcher || typeof matcher !== 'object' || !Array.isArray(matcher.hooks)) {
              return matcher
            }
            const hooksLeft = matcher.hooks.filter((h) => !isHoaiHookEntry(h))
            return hooksLeft.length > 0 ? { ...matcher, hooks: hooksLeft } : null
          })
          .filter((matcher) => matcher != null)
        hooks[name] = [...kept, { hooks: [entry()] }]
      }
      settings.hooks = hooks
      return settings
    },
    holds,
  )

  if (!written) return { changed: false, reason: 'not_persisted' }
  return { changed: true, reason: 'set' }
}

/** Does this hook entry point at a HOAI forwarder (any checkout)? Used to
 *  replace our own entry rather than stacking a second copy of it. */
function isHoaiHookEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  const args = Array.isArray(entry.args) ? entry.args : []
  const command = typeof entry.command === 'string' ? entry.command : ''
  return [...args, command].some(
    (value) => typeof value === 'string' && value.includes('hoai-hook.mjs'),
  )
}

/**
 * Enrol a marketplace in Claude Code's own plugin auto-update.
 *
 * WHY THIS EXISTS. Claude Code refreshes marketplaces and updates their plugins by itself, on
 * startup, with nothing typed. That behaviour is opt-in per marketplace: it defaults ON for a fixed
 * list of Anthropic's own marketplace names and OFF for everybody else. Ours is not on that list, so
 * without this key a machine stays on whatever version it first installed, forever, while every
 * check reports success.
 *
 * The cost is not hypothetical. On the author's own machine, openai-codex, the most-used plugin
 * there by a wide margin, had not been refreshed once since the day it was installed four months
 * earlier, for exactly this reason, and nothing anywhere said a word about it.
 *
 * The setting is confirmed in the shipped Claude Code binary, whose own schema describes it as
 * "Whether to automatically update this marketplace and its installed plugins on startup". There is
 * no CLI flag for it: `claude plugin marketplace add --help` offers only --scope and --sparse, and
 * `marketplace list` does not report it. So writing the key ourselves is the only route.
 *
 * ORDER MATTERS AT THE CALL SITES. `claude plugin marketplace add` rewrites the entry to just its
 * source, on both the "added" and the "already on disk" branches. Ensuring BEFORE an add is silently
 * undone. Every caller must ensure AFTER.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO. It never creates a marketplace entry. If the user has not
 * declared this marketplace, writing one would silently register a source on their machine that they
 * never asked for. Absent entry means we do nothing and say so.
 *
 * @param {object} opts
 * @param {string} opts.configDir      the Claude config dir holding settings.json
 * @param {string} [opts.marketplace]  the marketplace NAME as registered on THIS machine. Callers
 *   should pass the detected name rather than assuming 'hoai': a machine that added the marketplace
 *   by another route can hold a different name, which has already confused an external tester twice.
 * @param {boolean} [opts.enabled]     false turns enrolment back off
 * @param {object} [opts.fs]
 * @returns {{changed: boolean, reason: 'set'|'already'|'no_entry'|'declined'|'not_persisted'}}
 */
export function ensureMarketplaceAutoUpdate({
  configDir,
  marketplace = 'hoai',
  enabled = true,
  fs = defaultPreseedFs(),
}) {
  const dir = String(configDir ?? '').trim()
  if (!dir) throw new Error('ensureMarketplaceAutoUpdate: configDir is required')

  const name = String(marketplace ?? '').trim()
  if (!name) throw new Error('ensureMarketplaceAutoUpdate: marketplace is required')

  const settingsPath = joinDir(dir, 'settings.json')

  /** Read the marketplace's own entry, or undefined. Shared by the mutate and the verify. */
  const readEntry = (settings) => {
    const entries = settings.extraKnownMarketplaces
    const haveEntries = entries && typeof entries === 'object' && !Array.isArray(entries)
    // Own-property only. The marketplace name is read off the FILESYSTEM (a cache directory name),
    // so a machine with a directory called __proto__ would otherwise reach Object.prototype here:
    // the lookup returns a truthy object and the write lands on the prototype, not on settings.
    const entry =
      haveEntries && Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : undefined
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : undefined
  }

  // Corrupt or absent parses to {}, so a half-written settings.json can never fail a daemon boot.
  const entry = readEntry(loadJsonOrEmpty(fs.readFile, settingsPath))

  if (!entry) return { changed: false, reason: 'no_entry' }

  if (entry.autoUpdate === enabled) return { changed: false, reason: 'already' }

  // An explicit false is a DECISION, and this function runs at every daemon boot. Turning it back on
  // would override a user who deliberately opted out, silently, on a schedule they cannot see. Only
  // an ABSENT key means "never asked", which is the case this exists to fix.
  if (enabled && entry.autoUpdate === false) {
    return { changed: false, reason: 'declined' }
  }

  // Write, then read back. A plain write here reported success for a key that a concurrent `claude`
  // process had already overwritten from an older snapshot, and the caller then logged that the
  // machine self-updates when it does not. See mutateJsonVerified for why a lock is not the answer.
  const written = mutateJsonVerified(
    fs,
    settingsPath,
    (settings) => {
      const current = readEntry(settings)
      // Re-checked inside the attempt, not just before it: between attempts a competing writer may
      // have removed the entry entirely, and recreating it here would invent a marketplace the CLI
      // never registered.
      if (!current) return null
      current.autoUpdate = enabled
      return settings
    },
    (reread) => readEntry(reread)?.autoUpdate === enabled,
  )

  if (!written) return { changed: false, reason: 'not_persisted' }
  return { changed: true, reason: 'set' }
}

/**
 * Is this marketplace enrolled in Claude Code's plugin auto-update?
 *
 * Read-only, and deliberately three-valued: null means we could not tell, which /status must report
 * as "could not tell" rather than as either answer. A machine wrongly told it self-updates is the
 * exact silent failure this whole release exists to end, so guessing here would undo the work.
 *
 * Shares the writer's own-property rule, because a reader and a writer that disagree about what
 * counts as an entry would report a state nobody wrote.
 *
 * @param {{configDir: string, marketplace?: string, fs?: PreseedFs}} params
 * @returns {boolean | null}
 */
export function readMarketplaceAutoUpdate({ configDir, marketplace = 'hoai', fs = defaultPreseedFs() }) {
  const dir = String(configDir ?? '').trim()
  const name = String(marketplace ?? '').trim()
  if (!dir || !name) return null

  const raw = fs.readFile(joinDir(dir, 'settings.json'))
  // Absent is not "not enrolled": we never saw the file, so we do not know.
  if (raw == null) return null
  let settings
  try {
    settings = JSON.parse(raw)
  } catch {
    return null
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null

  const entries = settings.extraKnownMarketplaces
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null
  if (!Object.prototype.hasOwnProperty.call(entries, name)) return null
  const entry = entries[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null

  // An absent key IS a real answer here, unlike an absent file: Claude Code defaults it off for
  // every marketplace that is not one of its own, so an entry without the key does not self-update.
  // Only an exact true counts, so a truthy non-boolean is not read as enrolment either.
  return entry.autoUpdate === true
}
