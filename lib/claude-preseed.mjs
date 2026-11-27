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
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { fileIdentity, identityOfStat } from './file-identity.mjs'

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

/**
 * Load an agent folder's settings file for the hook entries, or REFUSE.
 *
 * The folder's .claude/settings.local.json is the plugin's to put its entries in, and it is the
 * owner's too: their own hooks and their permissions live in the same file. "Unreadable means
 * empty, then write" replaced such a file outright the day it carried a byte order mark (Windows
 * PowerShell 5.1 writes one, and JSON.parse refuses it) or a comment, and reported success. So: no
 * file, or an empty one, is an empty settings object, since there is nothing in it to lose. A byte
 * order mark is read past. A file that is there and is still not a JSON object is left EXACTLY as
 * it is and this throws, naming the file; every caller turns that into a line a person can read.
 */
function loadSettingsOrRefuse(fs, path) {
  const raw = fs.readFile(path)
  const present = typeof fs.exists === 'function' ? fs.exists(path) : raw != null
  if (!present) return {}
  if (raw == null) throw new Error(`${path} is there but could not be read, so it was left untouched`)
  const text = String(raw)
  const tooMuch = () =>
    new Error(
      `${path} holds far more than an agent folder's settings ever need (over ${SETTINGS_FILE_MAX_BYTES} bytes or ` +
        `${SETTINGS_MAX_HOOK_ENTRIES} hook entries), so it was left untouched`,
    )
  // Bounded before it is parsed: a file this large is never anyone's agent settings.
  if (text.length > SETTINGS_FILE_MAX_BYTES) throw tooMuch()
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body.trim() === '') return {}
  let parsed = null
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${path} is not a JSON object (a comment or a stray comma is enough), so it was left untouched: ` +
        'it may hold your own hooks and permissions. Fix the file, then run this again',
    )
  }
  if (hookEntryCount(parsed.hooks) > SETTINGS_MAX_HOOK_ENTRIES) throw tooMuch()
  return parsed
}

/** The most an agent folder's settings file may hold before the hook writer leaves it alone unread: 1 MiB. */
export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024
/** The most hook entries (matcher groups and the hooks in them) it may hold. The plugin's own full set is 36. */
export const SETTINGS_MAX_HOOK_ENTRIES = 1000

/** Matcher groups and hooks in a settings file's hooks block, counted. */
function hookEntryCount(hooks) {
  if (!isPlainObject(hooks)) return 0
  let count = 0
  for (const groups of Object.values(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) count += 1 + (Array.isArray(group?.hooks) ? group.hooks.length : 0)
  }
  return count
}

/** A JSON object, not an array and not null. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The error code of a settings file another program changed between this one's read and its rename. */
const SETTINGS_CHANGED = 'EHOAI_SETTINGS_CHANGED'

/** The real path of a file or folder, the volume's own spelling where it gives one, or '' when it cannot be named. */
function realPathOf(path) {
  try {
    return realpathSync.native(path)
  } catch {
    // A volume the native call cannot name: the portable walk.
  }
  try {
    return realpathSync(path)
  } catch {
    return ''
  }
}

/** Do two paths name one folder: the same real path, or the same volume identity? */
function sameFolder(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const idA = fileIdentity(a)
  return idA !== null && idA === fileIdentity(b)
}

/**
 * The file layer of the hook entries' write: every read and write of an agent folder's settings file stays in
 * that folder, whatever is in it.
 *
 * The folder is the agent's, and so is what is in it: its .claude folder, or the settings file, may be a link to
 * a file anywhere. Followed, a read takes in whatever it points at and the write lands there. So:
 *   - the settings folder (`.claude`) must be a real folder directly inside the agent folder: a link or a
 *     junction is refused, and so is any other redirection, a folder whose real place is not inside the agent
 *     folder's real place;
 *   - the settings file must be a plain file in it: a symbolic link or a hard link (a file with another name
 *     elsewhere) is refused, as is a file larger than SETTINGS_FILE_MAX_BYTES, which is never read whole;
 *   - the temp file is always a new file, created exclusively under a name nobody can guess, in the folder that
 *     was checked;
 *   - the rename happens only while that folder is still the one checked (its real path and its identity), and
 *     only from that temp file.
 * A refusal throws with the file's path, and the caller turns it into a line a person can read.
 * @param {string} settingsPath
 */
export function folderBoundSettingsFs(settingsPath) {
  const leaf = resolve(String(settingsPath ?? ''))
  const dir = dirname(leaf)
  const folder = dirname(dir)
  /** The settings folder as it was checked before the temp file was made, and that temp file. */
  let checked = null
  const refuse = (what) => {
    throw new Error(`${what}, so it was left untouched`)
  }
  const isLeaf = (path) => resolve(String(path)) === leaf
  const isTemp = (path) => {
    const at = resolve(String(path))
    return at !== leaf && dirname(at) === dir && at.startsWith(`${leaf}.`) && at.endsWith('.tmp')
  }
  /** The settings folder checked now: null when there is none, else its real path and identity. Throws on a link. */
  const checkDir = () => {
    let stat
    try {
      stat = lstatSync(dir, { bigint: true })
    } catch (err) {
      if (err?.code === 'ENOENT') return null
      throw err
    }
    if (stat.isSymbolicLink()) refuse(`${dir} is a link to another folder`)
    if (!stat.isDirectory()) refuse(`${dir} is not a folder`)
    const real = realPathOf(dir)
    if (!real || !sameFolder(dirname(real), realPathOf(folder))) refuse(`${dir} leads outside ${folder}`)
    return { real, id: identityOfStat(stat) }
  }
  /** The settings file's text, or null when there is none. Throws on a link, a hard link or a file too large. */
  const readLeaf = () => {
    if (checkDir() === null) return null
    let stat
    try {
      stat = lstatSync(leaf, { bigint: true })
    } catch (err) {
      if (err?.code === 'ENOENT') return null
      throw err
    }
    if (stat.isSymbolicLink()) refuse(`${leaf} is a link to another file`)
    if (!stat.isFile()) refuse(`${leaf} is not a file`)
    if (stat.nlink > 1n) refuse(`${leaf} is a hard link, another name for a file elsewhere`)
    if (stat.size > BigInt(SETTINGS_FILE_MAX_BYTES)) refuse(`${leaf} is larger than ${SETTINGS_FILE_MAX_BYTES} bytes`)
    const real = realPathOf(leaf)
    if (!real || !sameFolder(dirname(real), realPathOf(dir))) refuse(`${leaf} leads outside ${dir}`)
    const fd = openSync(leaf, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    try {
      // The file that was opened is the one that was checked, not one put in its place in between.
      const opened = identityOfStat(fstatSync(fd, { bigint: true }))
      const seen = identityOfStat(stat)
      if (opened !== null && seen !== null && opened !== seen) refuse(`${leaf} was replaced while it was read`)
      const buffer = Buffer.alloc(SETTINGS_FILE_MAX_BYTES + 1)
      let length = 0
      for (;;) {
        const got = readSync(fd, buffer, length, buffer.length - length, null)
        if (got === 0) break
        length += got
        if (length > SETTINGS_FILE_MAX_BYTES) refuse(`${leaf} is larger than ${SETTINGS_FILE_MAX_BYTES} bytes`)
      }
      return buffer.subarray(0, length).toString('utf8')
    } finally {
      closeSync(fd)
    }
  }
  return {
    readFile: (path) => {
      if (!isLeaf(path)) refuse(`${path} is not the settings file this write is for`)
      return readLeaf()
    },
    exists: (path) => {
      try {
        lstatSync(resolve(String(path)))
        return true
      } catch {
        return false
      }
    },
    tempPathFor: () => `${leaf}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    writeFile: (path, text, opts) => {
      if (!isTemp(path)) refuse(`${path} is not a temp file of ${leaf}`)
      if (checkDir() === null) mkdirSync(dir)
      const at = checkDir()
      if (at === null) refuse(`${dir} could not be made`)
      // 'wx': created here and now, never a file or a link that was already at this name.
      const fd = openSync(path, 'wx', opts?.mode ?? 0o600)
      try {
        writeFileSync(fd, text)
        checked = { ...at, temp: resolve(String(path)), tempId: identityOfStat(fstatSync(fd, { bigint: true })) }
      } finally {
        closeSync(fd)
      }
    },
    rename: (from, to) => {
      if (!isLeaf(to) || !checked || resolve(String(from)) !== checked.temp) refuse(`${to} is not the settings file this write is for`)
      const now = checkDir()
      const idChanged = now !== null && now.id !== null && checked.id !== null && now.id !== checked.id
      if (now === null || now.real !== checked.real || idChanged) refuse(`${dir} changed before the settings were saved`)
      const temp = lstatSync(checked.temp, { bigint: true })
      const tempId = identityOfStat(temp)
      if (temp.isSymbolicLink() || !temp.isFile() || (tempId !== null && checked.tempId !== null && tempId !== checked.tempId)) {
        refuse(`${checked.temp} changed before the settings were saved`)
      }
      renameSync(checked.temp, leaf)
    },
    modeOf: (path) => {
      try {
        return Number(lstatSync(resolve(String(path))).mode & 0o777)
      } catch {
        return null
      }
    },
    chmod: (path, mode) => {
      if (isTemp(path)) chmodSync(path, mode)
    },
    remove: (path) => {
      if (!isTemp(path)) return
      try {
        if (lstatSync(path).isFile()) unlinkSync(path)
      } catch {
        // Never made, or already gone.
      }
    },
  }
}

/** Does this file text start with a byte order mark (U+FEFF)? */
function startsWithByteOrderMark(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff
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
 * variable with home /home/you and CLAUDE_CONFIG_DIR=/home/you/.claude both
 * produce '/home/you/.claude', and they want DIFFERENT files), which is why the
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
function writeJsonAtomic(fs, path, value, expected) {
  const text = JSON.stringify(value, null, 2)
  if (typeof fs.rename !== 'function') {
    fs.writeFile(path, text)
    return
  }
  const tmp = typeof fs.tempPathFor === 'function' ? fs.tempPathFor(path) : `${path}.${process.pid}.tmp`
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
    // `expected`: the text this write was made from. Another program that saved the file since (the CLI saving an
    // "always allow") would lose its edit under the rename, so the write is abandoned and made again from the file
    // as it now is.
    if (expected !== undefined && fs.readFile(path) !== expected) {
      throw Object.assign(new Error(`${path} changed while it was being written`), { code: SETTINGS_CHANGED })
    }
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
// then write), for a file nothing of the owner's can be lost from. A caller touching a file the
// OWNER owns passes loadOwnerConfigOrRefuse instead, and the hook entries pass loadSettingsOrRefuse:
// an agent folder's settings.local.json holds the owner's own hooks and permissions too.
// `unchanged`: before the rename, the file must still read as it did when this attempt read it. A file that changed
// is read again and the change made again on top of it (the next attempt); after the last attempt it is null.
function mutateJsonVerified(fs, path, mutate, holds, attempts = 3, load = (f, p) => loadJsonOrEmpty(f.readFile, p), { unchanged = false } = {}) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    const before = unchanged ? fs.readFile(path) : undefined
    const current = load(fs, path)
    const next = mutate(current)
    if (next === null) return null
    try {
      writeJsonAtomic(fs, path, next, before)
    } catch (err) {
      if (err?.code === SETTINGS_CHANGED) continue
      throw err
    }
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
/**
 * Claude Code's own AskUserQuestion tool stops the session at a terminal
 * nobody watches: the agent waits for a keypress that never comes while its
 * daemon still reports online. Vexa sat at one for 2h49m on 2026-09-07 with
 * four of the owner's messages queued behind it (board row 01a07b28).
 * Questions reach the owner through the app instead (ask_user_input).
 */
export const DENIED_TOOLS = Object.freeze(['AskUserQuestion'])

/** Does this settings object already deny every tool in DENIED_TOOLS? */
function deniedToolsHold(settings) {
  const perms = settings && typeof settings === 'object' ? settings.permissions : null
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return false
  const deny = Array.isArray(perms.deny) ? perms.deny : []
  return DENIED_TOOLS.every((tool) => deny.includes(tool))
}

/**
 * Deny the tools in DENIED_TOOLS in ONE agent folder's settings.local.json.
 *
 * WHY THIS EXISTS AT ALL. Both bootstraps write this deny, and a bootstrap
 * runs once, at first install, so every agent installed before the deny
 * existed never receives it and nothing revisits them. Measured 2026-10-02 on
 * a nine agent machine: ONE carried it. The fix has to land on a path an
 * EXISTING agent takes, which is install and restart.
 *
 * WHY IT IS SEPARATE FROM ensureHookEntries, which writes the same file. That
 * function is called from `bgos-agent`'s restart path only when the settings
 * file ALREADY names hoai-hook.mjs, because stacking a second hook entry on a
 * workspace that gets its hooks elsewhere leaves a dead one firing. **A
 * permission cannot duplicate anything**, so it must not inherit that gate.
 *
 * Never the owner's own settings.json: with CLAUDE_CONFIG_DIR unset that file
 * is read by every Claude Code session they run themselves.
 *
 * Idempotent, and it keeps every other permission key (allow, ask,
 * defaultMode) and every entry a person or another tool put in deny.
 */
export function ensureDeniedTools({ settingsPath, fs = defaultPreseedFs() }) {
  const path = String(settingsPath ?? '').trim()
  if (!path) throw new Error('ensureDeniedTools: settingsPath is required')

  // MISSING and UNPARSEABLE are different answers and `loadJsonOrEmpty` gives
  // the same {} for both. A file we cannot parse is somebody's settings, so it
  // is left exactly as it is: guessing at it would overwrite content, and one
  // tool staying allowed is the smaller harm. A file that is absent is ours to
  // create.
  const raw = fs.readFile(path)
  if (raw !== null && raw !== undefined) {
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { changed: false, reason: 'unparseable' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { changed: false, reason: 'unparseable' }
    }
  }

  const before = loadJsonOrEmpty(fs.readFile, path)
  if (deniedToolsHold(before)) return { changed: false, reason: 'already' }

  // Same race as every other key here: a concurrent `claude` can write its own
  // snapshot over ours between the read and the write. Write, read back, and
  // only then report success.
  const written = mutateJsonVerified(
    fs,
    path,
    (settings) => {
      const perms =
        settings.permissions &&
        typeof settings.permissions === 'object' &&
        !Array.isArray(settings.permissions)
          ? settings.permissions
          : {}
      const deny = Array.isArray(perms.deny) ? [...perms.deny] : []
      for (const tool of DENIED_TOOLS) {
        if (!deny.includes(tool)) deny.push(tool)
      }
      perms.deny = deny
      settings.permissions = perms
      return settings
    },
    deniedToolsHold,
  )

  if (!written) return { changed: false, reason: 'not_persisted' }
  return { changed: true, reason: 'set' }
}

export const HOOK_TIMEOUT_SECONDS = 5
/** The private turn hook's timeout, as hooks/hooks.json registers it (0.68.4; it was 3). The hook bounds its own wait
 *  to 3 s from its process start (bin/hoai-private-turn-hook.mjs PRIVATE_TURN_HOOK_DEADLINE_MS); a test pins both. */
export const PRIVATE_HOOK_TIMEOUT_SECONDS = 5
/** The mission turn check's timeout, as hooks/hooks.json registers it (missions that stay true). The hook bounds its
 *  own wait for the daemon's answer to 4 s from its process start (lib/mission-turn.mjs MISSION_TURN_ASK_WAIT_MS). */
export const MISSION_TURN_HOOK_TIMEOUT_SECONDS = 8

/** The floor hook's own entry, exactly as hooks/hooks.json writes it (a test pins the two). */
export const FLOOR_HOOK_MATCHER = '^(Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*)$'
export const FLOOR_HOOK_TIMEOUT_SECONDS = 3
/** The private turn hook's helper guard, the same string as lib/private-turn.mjs
 *  (test/private-turn.test.ts pins both installs to it). Not imported: this
 *  file ships in the watcher bundle and must not grow its import closure. */
export const PRIVATE_TOOL_MATCHER = '^mcp__(.*_)?(hoai-browser__.+|bgos__(schedule|list_schedules|cancel_schedule|boards_.+|artifact_.+|vault_.+|email_send|email_draft|call_owner|create_mission|tick_mini_goal|set_mission_goals|add_mission_goals|cancel_mission_goal|set_goal_working|set_goal_waiting|complete_mission|list_chats))$'

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
 * forwarder path that moved is corrected rather than duplicated. An entry is the
 * plugin's only when it is exactly one of its hooks (ownedHookOf: the script, run
 * by node, on that hook's event, under its matcher, blocking as it does); every
 * other entry is the owner's and stays, and the hooks hold only when each of the
 * plugin's is there exactly once.
 *
 * That is also how a clone install picks up a NEW event: an agent folder that
 * was already provisioned self heals on its next launch, when this runs again
 * and rewrites the block for the current list. It does not happen on upgrade,
 * so the event starts arriving one launch later than for a marketplace install.
 *
 * THE FLOOR HOOK RIDES THE SAME RAIL (0.53.0). hooks/hooks.json registers a
 * second, BLOCKING PreToolUse entry for bin/hoai-floor-hook.mjs, the hook that
 * asks before a listed risky action. A clone reads that file no more than it
 * reads the forwarder's entries, so without this a clone agent had no floor
 * at all while the canon told its model a hook stops a listed action. The
 * floor script sits beside the forwarder in every checkout, so its path is
 * the forwarder's sibling unless a caller names one, and it is written with
 * the manifest's own matcher, timeout and `async: false`.
 *
 * THE FILE IS THE OWNER'S TOO. A settings file that is there and cannot be read as a JSON object
 * (a comment in it, a stray comma) is left exactly as it is and this THROWS, naming the file
 * (loadSettingsOrRefuse). A byte order mark is read past and the file is written without it, even
 * when its hooks already hold, and an empty file is an empty one. With no `fs` given, every read
 * and write stays in the agent folder (folderBoundSettingsFs), and a file another program saved
 * between the read and the rename is read again and merged.
 *
 * `floorHookPath: null` writes the floor hook only where the file already has the plugin's rail or
 * its floor hook, decided from the file's entries; a floor hook that is there is never removed.
 *
 * @param {{ settingsPath: string, forwarderPath: string, floorHookPath?: string | null,
 *   nodePath?: string, fs?: PreseedFs }} params
 * @returns {{ changed: boolean, reason: 'set'|'already'|'not_persisted'|'no_path', floor?: boolean }}
 *   `floor` (with `floorHookPath: null` only): whether the floor hook is in the set
 */
export function ensureHookEntries({
  settingsPath,
  forwarderPath,
  floorHookPath,
  nodePath = 'node',
  fs: given,
}) {
  const path = String(settingsPath ?? '').trim()
  const forwarder = String(forwarderPath ?? '').trim()
  if (!path) throw new Error('ensureHookEntries: settingsPath is required')
  if (!forwarder) return { changed: false, reason: 'no_path' }
  const fs = given ?? folderBoundSettingsFs(path)
  // null: the floor hook only where the file already has the plugin's rail or its floor hook (a registration that
  // writes the rail leaves it out, lib/clone-hooks.mjs), and a floor hook that is there is never taken away.
  const floorOnlyWhereThere = floorHookPath === null
  const floorHook = String(floorHookPath ?? floorHookBesideForwarder(forwarder)).trim()

  const privateHook = forwarder.replace(/hoai-hook\.mjs$/, 'hoai-private-turn-hook.mjs')
  const privateEvents = ['UserPromptSubmit', 'Stop', 'SessionEnd']
  // The mission turn check (missions that stay true): blocking, on a prompt and at Stop, after the private boundary.
  const missionHook = forwarder.replace(/hoai-hook\.mjs$/, 'hoai-mission-turn-hook.mjs')
  const missionEvents = ['UserPromptSubmit', 'Stop']
  const command = (script, timeout, async) => ({ type: 'command', command: String(nodePath), args: [script], timeout, async })
  const entry = () => command(forwarder, HOOK_TIMEOUT_SECONDS, true)
  const privateEntry = () => command(privateHook, PRIVATE_HOOK_TIMEOUT_SECONDS, false)
  const missionEntry = () => command(missionHook, MISSION_TURN_HOOK_TIMEOUT_SECONDS, false)
  const floorEntry = () => command(floorHook, FLOOR_HOOK_TIMEOUT_SECONDS, false)

  /** Every entry the plugin writes, in the order it writes them: one per hook per event, and nothing else. */
  const wanted = (withFloor) => {
    const out = []
    for (const name of HOOK_EVENT_NAMES) {
      if (privateEvents.includes(name)) out.push({ event: name, matcher: null, hook: privateEntry() })
      if (missionEvents.includes(name) && missionHook !== forwarder) out.push({ event: name, matcher: null, hook: missionEntry() })
      out.push({ event: name, matcher: null, hook: entry() })
      // Helpers (subagents) are bound to the turn that started them: SubagentStart records it, and a narrowed
      // PreToolUse entry refuses a helper's private call outside that turn. SubagentStart is the private hook's alone.
      if (name === 'PreToolUse' && withFloor) out.push({ event: name, matcher: FLOOR_HOOK_MATCHER, hook: floorEntry() })
      if (name === 'PreToolUse') out.push({ event: name, matcher: PRIVATE_TOOL_MATCHER, hook: privateEntry() })
    }
    out.push({ event: 'SubagentStart', matcher: null, hook: privateEntry() })
    return out
  }
  /** Does this file carry the floor hook? Decided from its parsed entries, never from its text. */
  const wantsFloor = (settings) => {
    if (!floorHook) return false
    if (!floorOnlyWhereThere) return true
    const found = ownedHookEntries(settings?.hooks)
    return found.some(({ owned }) => owned.script === 'hoai-hook.mjs' || owned.script === FLOOR_HOOK_SCRIPT_NAME)
  }
  // Decided once per attempt, from the file that attempt read: the read back is checked against that decision.
  let withFloor = false
  const same = (a, b) =>
    a.type === b.type && a.command === b.command && Array.isArray(a.args) && a.args.length === 1 && a.args[0] === b.args[0] && a.timeout === b.timeout && a.async === b.async
  /** Exactly the wanted entries, each once, and no other entry of the plugin's anywhere: a copy is not current. */
  const holds = (settings) => {
    const hooks = isPlainObject(settings) ? settings.hooks : null
    if (!isPlainObject(hooks)) return false
    const want = wanted(withFloor)
    const found = ownedHookEntries(hooks)
    if (found.length !== want.length) return false
    return want.every(
      (w) => found.filter((f) => f.event === w.event && matcherOf(f.group) === w.matcher && same(f.hook, w.hook)).length === 1,
    )
  }

  const before = loadSettingsOrRefuse(fs, path)
  withFloor = wantsFloor(before)
  // Hooks that hold behind a byte order mark are written once more, without it. Our own load reads
  // past the mark, but a strict reader of this file refuses it whole, the daemon's readers were
  // among them, and then the hooks are in the file and count as missing.
  if (holds(before) && !startsWithByteOrderMark(fs.readFile(path))) {
    return { changed: false, reason: 'already', ...(floorOnlyWhereThere ? { floor: withFloor } : {}) }
  }

  // Same race as every other key here: a concurrent `claude` can write its own
  // snapshot over ours between our read and our write, and a plain write could
  // not tell. A file that changed before the rename is read and merged again;
  // after the write it is read back, and only then is success reported.
  const written = mutateJsonVerified(
    fs,
    path,
    (settings) => {
      withFloor = wantsFloor(settings)
      const hooks = isPlainObject(settings.hooks) ? settings.hooks : {}
      const want = wanted(withFloor)
      for (const name of [...HOOK_EVENT_NAMES, 'SubagentStart']) {
        // Every entry of the plugin's goes (an older checkout's path, a changed timeout, a copy), so a moved
        // checkout does not leave a second, dead hook firing beside the live one. Everything else stays.
        hooks[name] = [
          ...withoutOwnedHooks(name, hooks[name]),
          ...want.filter((w) => w.event === name).map((w) => (w.matcher === null ? { hooks: [w.hook] } : { matcher: w.matcher, hooks: [w.hook] })),
        ]
      }
      settings.hooks = hooks
      return settings
    },
    holds,
    3,
    loadSettingsOrRefuse,
    { unchanged: true },
  )

  if (!written) return { changed: false, reason: 'not_persisted', ...(floorOnlyWhereThere ? { floor: withFloor } : {}) }
  return { changed: true, reason: 'set', ...(floorOnlyWhereThere ? { floor: withFloor } : {}) }
}

const FLOOR_HOOK_SCRIPT_NAME = 'hoai-floor-hook.mjs'

/** The shape of every private tool matcher this plugin has written: the current one, and each one before it. */
const PRIVATE_TOOL_MATCHER_SHAPE = /^\^mcp__\(\.\*_\)\?\(hoai-browser__\.\+\|bgos__\([a-z_.+|]+\)\)\)\$$/

/**
 * Each hook this plugin registers, by one definition: the script it runs (by file name, in the install's bin
 * folder), the events it runs on, the matcher of its group, and whether it blocks. The writer above, and the
 * daemon's readers (lib/floor-hook-presence.ts, lib/private-hook-presence.ts), all go by these.
 */
export const OWNED_HOOKS = Object.freeze([
  Object.freeze({ script: 'hoai-hook.mjs', events: Object.freeze([...HOOK_EVENT_NAMES]), matcher: null, blocking: false }),
  Object.freeze({ script: 'hoai-private-turn-hook.mjs', events: Object.freeze(['UserPromptSubmit', 'Stop', 'SessionEnd', 'SubagentStart']), matcher: null, blocking: true }),
  Object.freeze({ script: 'hoai-private-turn-hook.mjs', events: Object.freeze(['PreToolUse']), matcher: PRIVATE_TOOL_MATCHER, blocking: true }),
  Object.freeze({ script: 'hoai-mission-turn-hook.mjs', events: Object.freeze(['UserPromptSubmit', 'Stop']), matcher: null, blocking: true }),
  Object.freeze({ script: FLOOR_HOOK_SCRIPT_NAME, events: Object.freeze(['PreToolUse']), matcher: FLOOR_HOOK_MATCHER, blocking: true }),
])

/** A group's matcher, null for none (absent or empty, which match every tool). */
function matcherOf(group) {
  const matcher = isPlainObject(group) ? group.matcher : undefined
  return matcher === undefined || matcher === null || matcher === '' ? null : matcher
}

/**
 * Which of the plugin's hooks this entry is, or null when it is the owner's.
 *
 * The plugin's entry is exactly one shape: a command entry that runs node with one of its hook scripts, named by
 * an absolute path, as its one argument, on one of that hook's events, in a group with that hook's matcher (for
 * the private tool guard, the current matcher or an earlier one this plugin wrote), blocking or not as that hook
 * is. Anything else is the owner's, whatever its text says: a script name inside a path, a command line in one
 * string, another matcher, another runtime. The owner's hook is never dropped, and only this shape is counted.
 * `pluginRootVariable`: the plugin's own hooks file, where a path may start with ${CLAUDE_PLUGIN_ROOT}.
 * @param {string} event
 * @param {unknown} group  the matcher group the entry sits in
 * @param {unknown} hook
 * @param {{ pluginRootVariable?: boolean }} [opts]
 * @returns {{ script: string, events: readonly string[], matcher: string | null, blocking: boolean } | null}
 */
export function ownedHookOf(event, group, hook, { pluginRootVariable = false } = {}) {
  if (!isPlainObject(group) || !isPlainObject(hook) || hook.type !== 'command') return null
  if (typeof hook.command !== 'string' || !/^(?:.*[\\/])?node(?:\.exe)?$/i.test(hook.command.trim())) return null
  if (!Array.isArray(hook.args) || hook.args.length !== 1 || typeof hook.args[0] !== 'string') return null
  const target = hook.args[0]
  const absolute =
    target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target) || /^\\\\[^\\]/.test(target) ||
    (pluginRootVariable && target.startsWith('${CLAUDE_PLUGIN_ROOT}/'))
  if (!absolute) return null
  const name = target.split(/[\\/]/).pop()
  const matcher = matcherOf(group)
  for (const owned of OWNED_HOOKS) {
    if (owned.script !== name || !owned.events.includes(event) || (hook.async === true) === owned.blocking) continue
    const sameMatcher =
      matcher === owned.matcher ||
      (owned.matcher === PRIVATE_TOOL_MATCHER && typeof matcher === 'string' && PRIVATE_TOOL_MATCHER_SHAPE.test(matcher))
    if (sameMatcher) return owned
  }
  return null
}

/** Every entry of the plugin's in a hooks block, with its event and group. */
function ownedHookEntries(hooks) {
  const found = []
  if (!isPlainObject(hooks)) return found
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue
      for (const hook of group.hooks) {
        const owned = ownedHookOf(event, group, hook)
        if (owned) found.push({ event, group, hook, owned })
      }
    }
  }
  return found
}

/** An event's groups without the plugin's entries; a group left with no hook goes, every other group stays. */
function withoutOwnedHooks(event, groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return group
      const left = group.hooks.filter((hook) => !ownedHookOf(event, group, hook))
      return left.length > 0 ? { ...group, hooks: left } : null
    })
    .filter((group) => group != null)
}

/** The floor hook script beside a forwarder path (the same bin folder). */
export function floorHookBesideForwarder(forwarderPath) {
  const forwarder = String(forwarderPath ?? '')
  const at = forwarder.lastIndexOf('hoai-hook.mjs')
  if (at < 0 || at !== forwarder.length - 'hoai-hook.mjs'.length) return ''
  return `${forwarder.slice(0, at)}hoai-floor-hook.mjs`
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
 * @param {boolean} [opts.reclaim]     true takes back a false THIS plugin wrote: the idle update's
 *   rollback holds Claude Code's own update off and records that it did (lib/idle-update-host.mjs);
 *   only the caller holding that record passes it. A person's false is never reclaimed.
 * @param {object} [opts.fs]
 * @returns {{changed: boolean, reason: 'set'|'already'|'no_entry'|'declined'|'not_persisted'}}
 */
export function ensureMarketplaceAutoUpdate({
  configDir,
  marketplace = 'hoai',
  enabled = true,
  reclaim = false,
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
  if (enabled && entry.autoUpdate === false && reclaim !== true) {
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
