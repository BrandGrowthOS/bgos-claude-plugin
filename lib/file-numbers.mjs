/**
 * Device and file numbers: the plugin's one rule for "two looks saw one file or folder", and the one file in the
 * source tree where a plain compare of a `dev` or an `ino` is allowed (test/file-identity.guard.test.ts fails a new
 * one anywhere else). BGOS keeps the same sameFile rule in its profile-sync file-numbers.js, which the plugin also
 * ships as lib/browser-profile-core/file-numbers.js once that copy is taken.
 *
 * Three ways a file number is not what it seems, and all three make it unknown here:
 * - A JavaScript number holds every whole number only up to 2^53, and a Windows file number is 64 bits (NTFS keeps how
 *   often a record was reused in the top 16). So a look is read with WHOLE_NUMBERS, which gives bigints, and a plain
 *   number past 2^53, which may already be rounded, is unknown.
 * - Left out, zero (a drive that keeps no file numbers) or all ones (Windows' "no file id") is unknown.
 * - ReFS, and so every Dev Drive (a Dev Drive is a ReFS volume), gives each file a 128 bit id. Node's stat shows only
 *   64 bits of it, and Windows says those 64 bits are not guaranteed unique on ReFS: two files can show one number.
 *   No bit pattern tells a cut id from a whole one, so the volume's file system decides: on a volume whose ids do
 *   not fit in 64 bits the file number of every look is unknown (lookOn, numbersOnVolume).
 *
 * An unknown number is never a match by itself; sameFile then asks the size and the times to agree.
 */
import { execFile, execFileSync } from 'node:child_process'
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

// --- Volumes whose file ids are 128 bits -----------------------------------------------------------------------

/** File systems whose file ids do not fit in the 64 bits Node shows. A Dev Drive reports ReFS. */
const WIDE_FILE_ID_SYSTEMS = new Set(['refs'])

/**
 * The file ids of this file system fit in 64 bits. An unknown name (null, or a look that failed) counts as fitting.
 * @param {unknown} fileSystem
 * @returns {boolean}
 */
export function fileIdsFit(fileSystem) {
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
/** @param {string} path */
const RUN_OPTIONS = path => ({
  encoding: /** @type {const} */ ('utf8'), timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024,
  env: { ...process.env, HOAI_FILE_NUMBERS_PATH: path },
})

/**
 * Runs FILE_SYSTEM_SCRIPT for one path and gives what it printed; '' on any failure.
 * @param {string} path
 * @returns {string}
 */
export function runFileSystemScriptSync(path) {
  try { return execFileSync('powershell.exe', POWERSHELL_ARGS, { ...RUN_OPTIONS(path), stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' }
}

/**
 * The same, without blocking.
 * @param {string} path
 * @returns {Promise<string>}
 */
export function runFileSystemScript(path) {
  return new Promise(resolveRun => {
    execFile('powershell.exe', POWERSHELL_ARGS, RUN_OPTIONS(path), (error, stdout) => resolveRun(error ? '' : String(stdout)))
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

/**
 * What a volume was found to be, by device number (the volume serial on Windows) or by path root. Kept per process.
 * @type {Map<string, string | null>}
 */
const VOLUMES = new Map()

/**
 * How fileSystemOf looks: the platform, and a runner that gives what FILE_SYSTEM_SCRIPT printed for a path. A test
 * hands in its own; the real platform and PowerShell are the default.
 * @typedef {{ platform?: string, run?: (path: string) => string }} VolumeDeps
 * @typedef {{ platform?: string, run?: (path: string) => string | Promise<string> }} VolumeDepsAsync
 */

/** Forgets every volume seen; for tests. */
export function forgetVolumes() { VOLUMES.clear() }

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
 * The name of the file system the path is on, or null where it is not needed or cannot be found. Only Windows is
 * asked: Linux and macOS file numbers are 64 bits and Node shows them whole. One look per volume per process; a
 * failed look is kept too, as null, so a broken PowerShell is not asked again for every file.
 * @param {string} path
 * @param {Look} stat the look at path, for its device number
 * @param {VolumeDeps} [deps]
 * @returns {string | null}
 */
export function fileSystemOf(path, stat, deps = {}) {
  if ((deps.platform ?? process.platform) !== 'win32') return null
  const key = volumeKey(path, stat)
  const seen = VOLUMES.get(key)
  if (seen !== undefined) return seen
  const name = fileSystemName((deps.run ?? runFileSystemScriptSync)(String(path)))
  VOLUMES.set(key, name)
  return name
}

/**
 * fileSystemOf without blocking: deps.run may give a promise. Shares the volumes seen with fileSystemOf.
 * @param {string} path
 * @param {Look} stat
 * @param {VolumeDepsAsync} [deps]
 * @returns {Promise<string | null>}
 */
export async function fileSystemOfAsync(path, stat, deps = {}) {
  if ((deps.platform ?? process.platform) !== 'win32') return null
  const key = volumeKey(path, stat)
  const seen = VOLUMES.get(key)
  if (seen !== undefined) return seen
  const name = fileSystemName(await (deps.run ?? runFileSystemScript)(String(path)))
  VOLUMES.set(key, name)
  return name
}

/**
 * A look at `path` as the rule reads it: its file number unknown when the volume's file ids are 128 bits.
 * @template T
 * @param {T} stat
 * @param {string} path
 * @param {VolumeDeps} [deps]
 * @returns {T}
 */
export const numbersOnVolume = (stat, path, deps) => lookOn(stat, fileSystemOf(path, /** @type {Look} */ (stat), deps))

/**
 * numbersOnVolume without blocking.
 * @template T
 * @param {T} stat
 * @param {string} path
 * @param {VolumeDepsAsync} [deps]
 * @returns {Promise<T>}
 */
export const numbersOnVolumeAsync = async (stat, path, deps) => lookOn(stat, await fileSystemOfAsync(path, /** @type {Look} */ (stat), deps))
