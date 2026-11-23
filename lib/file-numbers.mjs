/**
 * Device and file numbers: the plugin's one rule for "two looks saw one file or folder". It reads every number
 * through wholeNumber, the same way BGOS's profile-sync file-numbers.js does (the plugin also ships that one as
 * lib/browser-profile-core/file-numbers.js once that copy is taken). test/file-identity.guard.test.ts fails a plain
 * compare of a `dev` or an `ino` anywhere in the source tree, this file included.
 *
 * Three ways a file number is not what it seems, and all three make it unknown here:
 * - A JavaScript number holds every whole number only up to 2^53, and a Windows file number is 64 bits (NTFS keeps how
 *   often a record was reused in the top 16). So a look is read with WHOLE_NUMBERS, which gives bigints, and a plain
 *   number past 2^53, which may already be rounded, is unknown.
 * - Left out, zero (a drive that keeps no file numbers) or all ones (Windows' "no file id") is unknown.
 * - ReFS, and so every Dev Drive (a Dev Drive is a ReFS volume), gives each file a 128 bit id. Node's stat shows only
 *   64 bits of it, and Windows says those 64 bits are not guaranteed unique on ReFS: two files can show one number.
 *   No bit pattern tells a cut id from a whole one, so the volume's file system decides: on a volume whose ids do
 *   not fit in 64 bits, or whose file system is not known (yet), the file number of every look is unknown (lookOn,
 *   numbersOnVolume).
 *
 * An unknown number is never a match by itself; sameFile then asks the size and the times to agree.
 */
import { execFile as nodeExecFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { win32 } from 'node:path'

/** Every look a check compares asks for this, so the device and file numbers come whole, as bigints. */
export const WHOLE_NUMBERS = Object.freeze({ bigint: true })

/** All 64 bits set: what Windows gives for a file with no file id. */
export const NO_FILE_ID = (1n << 64n) - 1n

/**
 * A device or file number as a whole number, or null when it is unknown: left out, zero, all ones, or a plain number
 * past 2^53. Node hands whole numbers over signed, so a number with the top bit set comes as a negative bigint; it is
 * read back as the unsigned number it is.
 * @param {unknown} value
 * @returns {bigint | null}
 */
export function wholeNumber(value) {
  if (typeof value === 'bigint') {
    const unsigned = BigInt.asUintN(64, value)
    return unsigned > 0n && unsigned !== NO_FILE_ID ? unsigned : null
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value)
  return null
}

/**
 * A look, as far as these checks read it: any stat (plain or bigint, real or a test's) or nothing.
 * @typedef {{ dev?: unknown, ino?: unknown, size?: unknown, mtimeNs?: unknown, ctimeNs?: unknown, birthtimeNs?: unknown } | null | undefined} Look
 */

/**
 * Both the device and the file number of a look are known.
 * @param {Look} stat
 * @returns {boolean}
 */
export const knownNumbers = stat => wholeNumber(stat?.dev) !== null && wholeNumber(stat?.ino) !== null

/** @param {Look} a @param {Look} b @returns {Array<[bigint | null, bigint | null]>} */
const numberPairs = (a, b) => [[wholeNumber(a?.dev), wholeNumber(b?.dev)], [wholeNumber(a?.ino), wholeNumber(b?.ino)]]

/**
 * A device or file number that both looks give differs: another file, whatever else is unknown.
 * @param {Look} a
 * @param {Look} b
 * @returns {boolean}
 */
export const numbersDiffer = (a, b) => numberPairs(a, b).some(([x, y]) => x !== null && y !== null && x !== y)

const timeNs = value => (typeof value === 'bigint' ? value : null)
const sizeOf = value => (typeof value === 'bigint' || typeof value === 'number' ? Number(value) : Number.NaN)

/**
 * One file or folder:
 * - a device or file number that both looks give and that differs: another file;
 * - both numbers known on both looks and equal: the same file;
 * - otherwise a number is unknown, which is never a match by itself: the size, the modified time and the change time
 *   in ns must all be given and equal, and the birth time too where both looks give one (Linux gives zero when it
 *   has none).
 * @param {Look} a
 * @param {Look} b
 * @returns {boolean}
 */
export function sameFile(a, b) {
  if (numbersDiffer(a, b)) return false
  if (numberPairs(a, b).every(([x, y]) => x !== null && x === y)) return true
  if (!(sizeOf(a?.size) === sizeOf(b?.size))) return false
  const am = timeNs(a?.mtimeNs), bm = timeNs(b?.mtimeNs), ac = timeNs(a?.ctimeNs), bc = timeNs(b?.ctimeNs)
  if (am === null || am !== bm || ac === null || ac !== bc) return false
  const ab = timeNs(a?.birthtimeNs), bb = timeNs(b?.birthtimeNs)
  return !ab || !bb || ab === bb
}

/** A birth time in ns, or null where the look gives none (left out, or Linux's zero). */
const birthNs = value => (typeof value === 'bigint' && value !== 0n ? value : null)

/** Both known and equal, or both unknown. */
const bothOrNeither = (x, y) => (x === null ? y === null : x === y)

/**
 * The entry a rename left at its new name is the one it moved, judged by what a rename on one volume keeps, for a
 * look whose file number is unknown (ReFS, a Dev Drive, a drive with no file numbers): the device number and the
 * birth time must each be given by both looks and agree, or be given by neither. A number only one look gives is a
 * change. The change time is not asked: a rename moves it. Where neither look gives either (a drive with no numbers
 * and no birth times) nothing differs, and the caller's other checks decide.
 * @param {Look} before
 * @param {Look} after
 * @returns {boolean}
 */
export function renameKept(before, after) {
  if (!before || !after) return false
  return bothOrNeither(wholeNumber(before.dev), wholeNumber(after.dev)) &&
    bothOrNeither(birthNs(before.birthtimeNs), birthNs(after.birthtimeNs))
}

// --- Volumes whose file ids are 128 bits -----------------------------------------------------------------------

/** File systems whose file ids do not fit in the 64 bits Node shows. A Dev Drive reports ReFS. */
const WIDE_FILE_ID_SYSTEMS = new Set(['refs'])

/**
 * What fileSystemOf gives on Windows for a volume whose file system is not known: its look failed (a timeout, a
 * blocked or missing PowerShell, an answer that names nothing) or has not answered yet. Its ids count as not fitting.
 * No script output can be this name (fileSystemName takes no spaces).
 */
export const UNKNOWN_VOLUME = 'unknown volume'

/**
 * The file ids of this file system fit in 64 bits. Not asked (null: not Windows) fits; ReFS and UNKNOWN_VOLUME do not.
 * @param {unknown} fileSystem
 * @returns {boolean}
 */
export function fileIdsFit(fileSystem) {
  if (fileSystem === UNKNOWN_VOLUME) return false
  return !(typeof fileSystem === 'string' && WIDE_FILE_ID_SYSTEMS.has(fileSystem.trim().toLowerCase()))
}

/**
 * The look as the file-number rule should read it on a volume of this file system: unchanged where the ids fit, and
 * with the file number unknown where they do not. The device number stays. The look is not copied field by field: the
 * answer inherits every field and method (isFile and the rest) from the look and shadows only `ino`.
 * @template T
 * @param {T} stat
 * @param {unknown} fileSystem
 * @returns {T}
 */
export function lookOn(stat, fileSystem) {
  if (stat === null || typeof stat !== 'object' || fileIdsFit(fileSystem)) return stat
  return Object.create(stat, { ino: { value: undefined, enumerable: true } })
}

/**
 * PowerShell that prints the file system name of the volume a path is on. The path comes in the environment, never
 * in the command line, so no spelling of it can change the command. Get-Volume -FilePath finds the volume even when
 * it is mounted in a folder (a Dev Drive often is); DriveInfo, for a drive letter, is the fallback where the Storage
 * module is missing or refuses. Neither needs an administrator. A failure prints nothing.
 */
export const FILE_SYSTEM_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$p = $env:HOAI_FILE_NUMBERS_PATH',
  'try { $v = Get-Volume -FilePath $p; if ($v.FileSystem) { [Console]::Out.WriteLine([string]$v.FileSystem); exit 0 } } catch {}',
  'try { [Console]::Out.WriteLine(([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($p))).DriveFormat) } catch {}',
].join('\n')

const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', FILE_SYSTEM_SCRIPT]
/** How long one volume look may take before it counts as failed. */
export const POWERSHELL_TIMEOUT_MS = 30_000

/**
 * The System32 PowerShell, by its whole path, or null with no usable SystemRoot. Never the bare `powershell.exe`:
 * Windows looks a bare name up in the current folder (the agent's) before PATH (bin/hoai-core.mjs listWin32Processes
 * holds the same rule). A SystemRoot that is not a whole path from a drive letter (relative, or rooted at no drive)
 * names nothing either, so the look fails, and a failed look counts as unknown.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function powershellPath(env) {
  const root = String(env.SystemRoot ?? env.SYSTEMROOT ?? '').trim()
  if (!/^[A-Za-z]:[\\/]/.test(root)) return null
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * How runFileSystemScript starts PowerShell: node's execFile and process.env by default; a test hands in its own.
 * @typedef {{ execFile?: (file: string, args: string[], options: object, done: (error: Error | null, stdout: string) => void) => unknown, env?: Record<string, string | undefined> }} RunDeps
 */

/**
 * Runs FILE_SYSTEM_SCRIPT for one path without blocking and gives what it printed; '' on any failure, including
 * one that throws before the spawn (a path with a NUL in it) and no SystemRoot to name PowerShell by.
 * @param {string} path
 * @param {RunDeps} [deps]
 * @returns {Promise<string>}
 */
export function runFileSystemScript(path, deps = {}) {
  const env = deps.env ?? process.env
  const execFile = deps.execFile ?? nodeExecFile
  return new Promise(resolveRun => {
    const powershell = powershellPath(env)
    if (!powershell) { resolveRun(''); return }
    try {
      execFile(powershell, POWERSHELL_ARGS, {
        // Nothing waits on this look, so a cold start (the Storage module loading under antivirus took 9.8 s on CI)
        // has room; one that still runs out is a failure, which counts as unknown and is asked again later.
        encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024,
        env: { ...env, HOAI_FILE_NUMBERS_PATH: path },
      }, (error, stdout) => resolveRun(error ? '' : String(stdout)))
    } catch {
      resolveRun('')
    }
  })
}

/**
 * The file system name in what the script printed (its first non-empty line, at most 32 letters), or null.
 * @param {unknown} printed
 * @returns {string | null}
 */
export function fileSystemName(printed) {
  const line = String(printed ?? '').split(/\r?\n/).map(part => part.trim()).find(Boolean)
  return line && /^[A-Za-z0-9_-]{1,32}$/.test(line) ? line : null
}

/** How long a failed volume look is kept before the volume is asked again: one slow cold start decides a minute. */
export const FAILED_LOOK_RETRY_MS = 60_000

/**
 * What each volume was found to be, by device number (the volume serial on Windows) or by path root, and when. An
 * answer is kept for the process; a failure (name null) only for FAILED_LOOK_RETRY_MS.
 * @type {Map<string, { name: string | null, at: number }>}
 */
const VOLUMES = new Map()
/** The looks still out, by the same key, so one volume is asked once at a time. @type {Map<string, Promise<string | null>>} */
const ASKING = new Map()
/** Bumped by forgetVolumes, so a look still out from before it is not kept. */
let generation = 0

/**
 * How fileSystemOf looks: the platform, a clock, and a runner that gives what FILE_SYSTEM_SCRIPT printed for a path
 * (now or as a promise). A test hands in its own; the real platform, Date.now and runFileSystemScript (with the
 * test's execFile and env, if it gives them) are the default.
 * @typedef {{ platform?: string, now?: () => number, run?: (path: string) => string | Promise<string> } & RunDeps} VolumeDeps
 */

/** Forgets every volume seen and every look still out; for tests. */
export function forgetVolumes() {
  VOLUMES.clear()
  ASKING.clear()
  generation++
}

/** Resolves once every volume look out now has been answered and kept; for tests. */
export async function volumeLooksSettled() {
  while (ASKING.size) await Promise.all([...ASKING.values()])
}

/**
 * The key a volume is kept under: its device number when the look gives one, every file on one volume sharing it;
 * else the root of the path, which for a volume mounted in a folder is only the drive it hangs from (and so a miss
 * that the device number would not make).
 * @param {string} path
 * @param {Look} stat
 */
function volumeKey(path, stat) {
  const dev = wholeNumber(stat?.dev)
  if (dev !== null) return `dev:${dev}`
  return `root:${win32.parse(win32.resolve(String(path))).root.toLowerCase()}`
}

/**
 * The volume's kept answer, if it still holds: a name, or UNKNOWN_VOLUME for a failure younger than
 * FAILED_LOOK_RETRY_MS. Undefined when the volume should be asked.
 * @param {string} key
 * @param {VolumeDeps} deps
 * @returns {string | undefined}
 */
function keptAnswer(key, deps) {
  const seen = VOLUMES.get(key)
  if (!seen) return undefined
  if (seen.name !== null) return seen.name
  return (deps.now ?? Date.now)() - seen.at < FAILED_LOOK_RETRY_MS ? UNKNOWN_VOLUME : undefined
}

/**
 * Asks the volume, or joins the look already out for it. The runner is called after the caller's own code has run
 * (on a later microtask), never inside it, and a runner that throws or rejects is a failure.
 * @param {string} key
 * @param {string} path
 * @param {VolumeDeps} deps
 * @returns {Promise<string | null>}
 */
function ask(key, path, deps) {
  const out = ASKING.get(key)
  if (out) return out
  const asked = generation
  const run = deps.run ?? (at => runFileSystemScript(at, deps))
  const look = Promise.resolve()
    .then(() => run(String(path)))
    .then(fileSystemName, () => null)
    .then(name => {
      if (asked === generation) {
        VOLUMES.set(key, { name, at: (deps.now ?? Date.now)() })
        ASKING.delete(key)
      }
      return name
    })
  ASKING.set(key, look)
  return look
}

/**
 * The name of the file system the path is on, null where it is not needed (only Windows is asked: Linux and macOS
 * file numbers are 64 bits and Node shows them whole), or UNKNOWN_VOLUME where it is not known: the look failed in
 * the last FAILED_LOOK_RETRY_MS, or has not answered yet. Never blocks: a volume not known yet is asked without
 * waiting, and the answer counts from the next call. One look per volume at a time.
 * @param {string} path
 * @param {Look} stat the look at path, for its device number
 * @param {VolumeDeps} [deps]
 * @returns {string | null}
 */
export function fileSystemOf(path, stat, deps = {}) {
  if ((deps.platform ?? process.platform) !== 'win32') return null
  const key = volumeKey(path, stat)
  const kept = keptAnswer(key, deps)
  if (kept !== undefined) return kept
  void ask(key, path, deps)
  return UNKNOWN_VOLUME
}

/**
 * fileSystemOf that waits for the answer: the kept one, the look already out, or a new look. A failure is
 * UNKNOWN_VOLUME. Shares the volumes seen with fileSystemOf.
 * @param {string} path
 * @param {Look} stat
 * @param {VolumeDeps} [deps]
 * @returns {Promise<string | null>}
 */
export async function fileSystemOfAsync(path, stat, deps = {}) {
  if ((deps.platform ?? process.platform) !== 'win32') return null
  const key = volumeKey(path, stat)
  const kept = keptAnswer(key, deps)
  if (kept !== undefined) return kept
  return (await ask(key, path, deps)) ?? UNKNOWN_VOLUME
}

/**
 * Asks ahead, without blocking, about the volumes of these folders (the agent folder, the config folder, ~/.claude),
 * each by its real path, so the first sync look on them finds the answer. A missing or empty one is skipped. Off
 * Windows nothing is asked. Never rejects.
 * @param {Array<string | null | undefined>} folders
 * @param {VolumeDeps} [deps]
 * @returns {Promise<void>}
 */
export async function warmVolumes(folders, deps = {}) {
  if ((deps.platform ?? process.platform) !== 'win32') return
  await Promise.all(folders.map(async folder => {
    if (typeof folder !== 'string' || !folder.trim()) return
    try {
      const real = await realpath(folder)
      await fileSystemOfAsync(real, await lstat(real, WHOLE_NUMBERS), deps)
    } catch { /* a folder that is not there has no volume to ask about yet */ }
  }))
}

/**
 * A look at `path` as the rule reads it: its file number unknown when the volume's file ids are 128 bits, or when
 * the volume is not known yet.
 * @template T
 * @param {T} stat
 * @param {string} path
 * @param {VolumeDeps} [deps]
 * @returns {T}
 */
export const numbersOnVolume = (stat, path, deps) => lookOn(stat, fileSystemOf(path, /** @type {Look} */ (stat), deps))

/**
 * numbersOnVolume, waiting for the volume's answer.
 * @template T
 * @param {T} stat
 * @param {string} path
 * @param {VolumeDeps} [deps]
 * @returns {Promise<T>}
 */
export const numbersOnVolumeAsync = async (stat, path, deps) => lookOn(stat, await fileSystemOfAsync(path, /** @type {Look} */ (stat), deps))
