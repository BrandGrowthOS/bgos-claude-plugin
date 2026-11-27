/**
 * file-identity: what the volume itself calls a file or a folder, its device and file numbers, the same under
 * every spelling of its path and different for another file.
 *
 * The numbers are read as whole numbers (bigint): on NTFS a file number passes 2^53, and as plain numbers two
 * different files can round to one. A number left out, or a zero, is unknown (a volume that keeps no file numbers
 * reports a zero), and an unknown identity is null, which a caller never takes for a match. The same rule as
 * lib/skills-inventory.ts identOf, in plain JavaScript for the files that run under node without a loader.
 *
 * Node builtins only, import-safe.
 */

import { lstatSync, statSync } from 'node:fs'

/** A number the system gave: one left out, or a zero, is unknown. */
function known(value) {
  return value !== undefined && value !== null && String(value) !== '0'
}

/**
 * The identity of a stat read with `{ bigint: true }`, or null when either number is unknown.
 * @param {{ dev?: unknown, ino?: unknown } | null | undefined} stat
 * @returns {string | null}
 */
export function identityOfStat(stat) {
  if (!stat || !known(stat.dev) || !known(stat.ino)) return null
  return `${String(stat.dev)}:${String(stat.ino)}`
}

/**
 * The identity of the file or folder at `path` (a link followed, or with `follow: false` the link itself), or null
 * when it cannot be read or a number is unknown. Never throws.
 * @param {string} path
 * @param {{ follow?: boolean }} [opts]
 * @returns {string | null}
 */
export function fileIdentity(path, { follow = true } = {}) {
  try {
    return identityOfStat(follow ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true }))
  } catch {
    return null
  }
}
