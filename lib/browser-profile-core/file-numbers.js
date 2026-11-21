"use strict";
// Device and file numbers kept whole, for every check in profile-sync that
// decides two looks saw one file or folder. A Windows file number is 64 bits
// (NTFS keeps how often a record was reused in the top 16), and a JavaScript
// number holds every whole number only up to 2^53. So every look a check
// compares is read with WHOLE_NUMBERS, which gives bigints, and sameFile
// compares them as bigints. The plugin's lib/file-numbers.mjs keeps the same rule.
const WHOLE_NUMBERS = Object.freeze({ bigint: true });
// All 64 bits set: what Windows gives for a file with no file id.
const NO_FILE_ID = (1n << 64n) - 1n;

/**
 * A device or file number as a whole number, or null when it is unknown: left
 * out, zero, all ones, or a plain number past 2^53, which may already be
 * rounded. Node hands whole numbers over signed, so a number with the top bit
 * set comes as a negative bigint; it is read back as the unsigned number it is.
 */
function wholeNumber(value) {
  if (typeof value === "bigint") { const unsigned = BigInt.asUintN(64, value); return unsigned > 0n && unsigned !== NO_FILE_ID ? unsigned : null; }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  return null;
}
/** Both the device and the file number of a look are known. */
const knownNumbers = stat => wholeNumber(stat?.dev) !== null && wholeNumber(stat?.ino) !== null;
const timeNs = value => typeof value === "bigint" ? value : null;
const sizeOf = value => typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;

const numberPairs = (a, b) => ["dev", "ino"].map(key => [wholeNumber(a?.[key]), wholeNumber(b?.[key])]);
/** A device or file number that both looks give differs: another file, whatever else is unknown. */
const numbersDiffer = (a, b) => numberPairs(a, b).some(([x, y]) => x !== null && y !== null && x !== y);
/**
 * One file or folder, by the rule the plugin uses:
 * - a device or file number that both looks give and that differs: another file;
 * - both numbers known on both looks and equal: the same file;
 * - otherwise a number is unknown, which is never a match by itself: the size,
 *   the modified time and the change time in ns must all be given and equal,
 *   and the birth time too where both looks give one (Linux gives zero when it
 *   has none). A folder whose entries changed in between does not pass then.
 */
function sameFile(a, b) {
  if (numbersDiffer(a, b)) return false;
  const pairs = numberPairs(a, b);
  if (pairs.every(([x, y]) => x !== null && x === y)) return true;
  if (!(sizeOf(a?.size) === sizeOf(b?.size))) return false;
  const am = timeNs(a?.mtimeNs), bm = timeNs(b?.mtimeNs), ac = timeNs(a?.ctimeNs), bc = timeNs(b?.ctimeNs);
  if (am === null || am !== bm || ac === null || ac !== bc) return false;
  const ab = timeNs(a?.birthtimeNs), bb = timeNs(b?.birthtimeNs);
  return !ab || !bb || ab === bb;
}
/** The device and the file number exactly as each look gave them are equal, as a plain compare asked. */
const sameGivenNumbers = (a, b) => ["dev", "ino"].every(key => a?.[key] === b?.[key]);
/**
 * sameFile, for a check that compared plain numbers before (dev === dev and
 * ino === ino), so that it is never weaker than that compare: where both looks
 * give both numbers it is sameFile; otherwise the numbers as given must also
 * be equal, and sameFile decides the rest.
 */
const sameFileStrict = (a, b) => (knownNumbers(a) && knownNumbers(b) || sameGivenNumbers(a, b)) && sameFile(a, b);

const plain = value => typeof value === "bigint" ? Number(value) : value;
// The ms Node's own plain stat gives (seconds * 1e3 + nanoseconds / 1e6), so a
// time read whole equals the same time read plain. (Before 1970 the bigint
// split rounds toward zero and the last bit can differ; no check mixes looks.)
function ms(stat, key) {
  const ns = stat[key + "Ns"];
  if (typeof ns !== "bigint") return plain(stat[key + "Ms"]);
  return Number(ns / 1_000_000_000n) * 1e3 + Number(ns % 1_000_000_000n) / 1e6;
}
/**
 * A stat read with WHOLE_NUMBERS, in the shape the checks written for a plain
 * stat read: the kind tests, and the mode, owner, link count, size and times in
 * ms as plain numbers. The device and file numbers and the times in ns stay as
 * they came, for sameFile. A plain stat (a test filesystem may give one) keeps
 * its plain fields.
 */
function statKeptWhole(stat) {
  return {
    isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink(),
    dev: stat.dev, ino: stat.ino, mode: plain(stat.mode), uid: plain(stat.uid), gid: plain(stat.gid), nlink: plain(stat.nlink), size: plain(stat.size),
    mtimeMs: ms(stat, "mtime"), ctimeMs: ms(stat, "ctime"), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, birthtimeNs: stat.birthtimeNs,
  };
}
/** lstat of `file` through `filesystem` (fs.promises shape), read whole. */
async function lstatWhole(filesystem, file) { return statKeptWhole(await filesystem.lstat(file, WHOLE_NUMBERS)); }
/** stat of an open file handle, read whole. */
async function statWhole(handle) { return statKeptWhole(await handle.stat(WHOLE_NUMBERS)); }

module.exports = { WHOLE_NUMBERS, wholeNumber, knownNumbers, numbersDiffer, sameFile, sameGivenNumbers, sameFileStrict, statKeptWhole, lstatWhole, statWhole };
