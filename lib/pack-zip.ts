/**
 * Deterministic STORED-entry zip writer + reader for Agent Packs (Type 3
 * "Full handoff", Home of Agents).
 *
 * No zip library exists in this repo's node_modules and installs are
 * forbidden, so the pack format is produced by this small pure module. The
 * SAME code is duplicated backend-side as
 * backend/src/agent-handoffs/pack-zip.util.ts (tests adapted per repo);
 * keep the two in lockstep.
 *
 * Format guarantees (the wire contract for packs):
 *   - Every entry is STORED (method 0, no compression), so per-entry bytes
 *     equal the source file bytes and sha256 inventories stay meaningful.
 *   - Entry order is deterministic: "manifest.json" always first when
 *     present, everything else sorted by path (code-unit order).
 *   - The DOS timestamp of every entry derives from the packagedAt input
 *     (UTC fields, 2 second resolution), never from the wall clock, so the
 *     same inputs always produce byte-identical zips.
 *   - Names are UTF-8 (general purpose flag bit 11 set).
 *   - CRC32 is computed inline (table below); the reader verifies it.
 *
 * Pure and import-safe: no env reads, no network, no clock, no process
 * exit (this repo's lib/ convention, see lib/call-owner.ts). No TS enums or
 * parameter properties: node --test runs these files in strip-only mode.
 */

export interface ZipEntryInput {
  /** Forward-slash relative path inside the zip (e.g. "agent/CLAUDE.md"). */
  path: string
  data: Uint8Array
}

export interface ZipEntryOutput {
  path: string
  data: Uint8Array
}

/** manifest.json is pinned first so pack consumers can stream-read it. */
export const MANIFEST_ENTRY_NAME = 'manifest.json'

// ── CRC32 (IEEE 802.3, the zip polynomial) ───────────────────────────────────

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ── DOS date/time (fixed from packagedAt, UTC, deterministic) ────────────────

/**
 * Convert packagedAt to the zip DOS date/time pair using UTC fields so the
 * result never depends on the packaging host's timezone. DOS time has a two
 * second resolution; years clamp to the representable 1980..2107 window.
 */
export function toDosDateTime(packagedAt: Date): {
  dosTime: number
  dosDate: number
} {
  let year = packagedAt.getUTCFullYear()
  let month = packagedAt.getUTCMonth() + 1
  let day = packagedAt.getUTCDate()
  let hours = packagedAt.getUTCHours()
  let minutes = packagedAt.getUTCMinutes()
  let seconds = packagedAt.getUTCSeconds()
  if (!Number.isFinite(year)) {
    year = 1980
    month = 1
    day = 1
    hours = 0
    minutes = 0
    seconds = 0
  }
  if (year < 1980) {
    year = 1980
    month = 1
    day = 1
    hours = 0
    minutes = 0
    seconds = 0
  }
  if (year > 2107) {
    year = 2107
    month = 12
    day = 31
    hours = 23
    minutes = 59
    seconds = 58
  }
  const dosDate = ((year - 1980) << 9) | (month << 5) | day
  const dosTime = (hours << 11) | (minutes << 5) | (seconds >> 1)
  return { dosTime, dosDate }
}

// ── Path validation (writer-level zip-slip guard) ────────────────────────────

/** Reject anything that could not be a safe relative pack entry path. */
export function isValidEntryPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.includes('\\')) return false
  if (path.startsWith('/')) return false
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/** Deterministic pack order: manifest.json first, then code-unit order. */
export function comparePackPaths(a: string, b: string): number {
  if (a === MANIFEST_ENTRY_NAME && b !== MANIFEST_ENTRY_NAME) return -1
  if (b === MANIFEST_ENTRY_NAME && a !== MANIFEST_ENTRY_NAME) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

// ── Writer ───────────────────────────────────────────────────────────────────

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP_VERSION = 20
/** General purpose bit 11: entry names are UTF-8. */
const FLAG_UTF8 = 0x0800
const METHOD_STORED = 0

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: false })

/**
 * Build a deterministic zip of STORED entries. Same entries (in any input
 * order) + same packagedAt always produce byte-identical output.
 * Throws on invalid or duplicate paths and on 32-bit overflow (packs are
 * size-gated far below that anyway).
 */
export function buildStoredZip(
  entries: ZipEntryInput[],
  packagedAt: Date,
): Uint8Array {
  if (entries.length > 0xffff) {
    throw new Error(`too many zip entries: ${entries.length}`)
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isValidEntryPath(entry.path)) {
      throw new Error(`invalid zip entry path: ${JSON.stringify(entry.path)}`)
    }
    if (seen.has(entry.path)) {
      throw new Error(`duplicate zip entry path: ${entry.path}`)
    }
    seen.add(entry.path)
  }
  const sorted = [...entries].sort((a, b) => comparePackPaths(a.path, b.path))
  const { dosTime, dosDate } = toDosDateTime(packagedAt)

  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  let centralSize = 0

  for (const entry of sorted) {
    const nameBytes = textEncoder.encode(entry.path)
    const crc = crc32(entry.data)
    const size = entry.data.length
    if (size > 0xffffffff) {
      throw new Error(`zip entry too large: ${entry.path}`)
    }

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, LOCAL_HEADER_SIG, true)
    lv.setUint16(4, ZIP_VERSION, true)
    lv.setUint16(6, FLAG_UTF8, true)
    lv.setUint16(8, METHOD_STORED, true)
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, CENTRAL_HEADER_SIG, true)
    cv.setUint16(4, ZIP_VERSION, true)
    cv.setUint16(6, ZIP_VERSION, true)
    cv.setUint16(8, FLAG_UTF8, true)
    cv.setUint16(10, METHOD_STORED, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number start
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs (deterministic)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    localParts.push(local, entry.data)
    centralParts.push(central)
    offset += local.length + size
    centralSize += central.length
    if (offset > 0xffffffff) {
      throw new Error('zip exceeds the 32 bit format limit')
    }
  }

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, EOCD_SIG, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, sorted.length, true)
  ev.setUint16(10, sorted.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  const total =
    offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of localParts) {
    out.set(part, cursor)
    cursor += part.length
  }
  for (const part of centralParts) {
    out.set(part, cursor)
    cursor += part.length
  }
  out.set(eocd, cursor)
  return out
}

// ── Reader ───────────────────────────────────────────────────────────────────

/**
 * Read a zip produced by buildStoredZip (or any single-disk zip whose
 * entries are all STORED). Verifies each entry's CRC32 and throws a
 * descriptive error on anything malformed, compressed, or corrupted.
 * Returns entries in central directory order (the deterministic pack order).
 */
export function readStoredZip(zip: Uint8Array): ZipEntryOutput[] {
  if (zip.length < 22) throw new Error('zip too short')
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)

  // Find the end-of-central-directory record (scan back over the comment).
  let eocdOffset = -1
  const scanFloor = Math.max(0, zip.length - 22 - 0xffff)
  for (let i = zip.length - 22; i >= scanFloor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('zip end of central directory not found')
  const diskNumber = view.getUint16(eocdOffset + 4, true)
  const cdDisk = view.getUint16(eocdOffset + 6, true)
  if (diskNumber !== 0 || cdDisk !== 0) {
    throw new Error('multi-disk zips are not supported')
  }
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  if (cdOffset > zip.length) throw new Error('zip central directory out of range')

  const entries: ZipEntryOutput[] = []
  let cursor = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > zip.length) throw new Error('zip central directory truncated')
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIG) {
      throw new Error('bad zip central directory signature')
    }
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const path = textDecoder.decode(
      zip.subarray(cursor + 46, cursor + 46 + nameLength),
    )
    if (method !== METHOD_STORED) {
      throw new Error(`unsupported zip compression method for ${path}`)
    }
    if (compressedSize !== uncompressedSize) {
      throw new Error(`stored entry size mismatch for ${path}`)
    }
    if (localOffset + 30 > zip.length) {
      throw new Error(`zip local header out of range for ${path}`)
    }
    if (view.getUint32(localOffset, true) !== LOCAL_HEADER_SIG) {
      throw new Error(`bad zip local header signature for ${path}`)
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + uncompressedSize > zip.length) {
      throw new Error(`zip entry data out of range for ${path}`)
    }
    const data = zip.subarray(dataStart, dataStart + uncompressedSize)
    if (crc32(data) !== crc) {
      throw new Error(`zip crc mismatch for ${path}`)
    }
    entries.push({ path, data })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}
