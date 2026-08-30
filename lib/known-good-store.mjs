/**
 * Remember which plugin version last proved itself on this machine, so a failed rollback can name
 * the way back instead of stopping.
 *
 * THE GAP. rollbackCore restores a previous version by re-pointing at its cache directory. That
 * directory belongs to Claude Code, which actively sweeps superseded generations: they carry
 * .orphaned_at markers and there is a .last_inuse_sweep timestamp beside them. When the sweep got
 * there first, rollback returns impossible('install_path_missing') and stops. Nothing anywhere then
 * tells a human, or the server, what would actually recover the machine.
 *
 * WHY THIS IS A FEW BYTES AND NOT A COPY OF THE PAYLOAD. Keeping our own copy outside the swept
 * directory is the obvious fix and it was measured before being rejected: one generation on a real
 * install is 71 MB, of which 67 MB is node_modules, and the daemon genuinely needs those modules to
 * start. A full copy therefore costs 71 MB per retained version on every machine. A source-only copy
 * is 3.9 MB but cannot be restored without a network install, which is precisely the situation an
 * offline local copy was supposed to survive. Neither trade is worth it, because:
 *
 * WHAT ACTUALLY RECOVERS A MACHINE. Reverting `plugins[0].source.ref` in the marketplace repo was
 * measured end to end in an isolated config: the CLI reports "updated from 1.1.0 to 1.0.0" and
 * RE-FETCHES the older version. It does not depend on any local cache surviving, and it recalls the
 * whole fleet at once rather than one machine. That is the lever. This module exists so the failure
 * path points at it, with a specific version rather than a shrug.
 *
 * WHAT "PROVED ITSELF" MEANS HERE, stated plainly because it is a weaker claim than "healthy": the
 * version started and reached the point where message delivery is live. That is the bar rollback
 * exists for, since the failure it recovers from is a version that cannot run. A version that starts
 * cleanly and is subtly wrong will still be recorded, and no local mechanism can catch that one; the
 * marketplace ref revert is the answer there too.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)/

/** Join preserving the separator style already in use, so a win32 home stays win32. */
function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** Where the record lives. Under our own state dir, never inside the cache Claude Code sweeps. */
export function knownGoodPath(home) {
  return joinDir(joinDir(String(home ?? ''), '.bgos-agent'), 'known-good.json')
}

function defaultFs() {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (p, text) => {
      mkdirSync(dirname(p), { recursive: true })
      const tmp = `${p}.${process.pid}.tmp`
      // 0600 on the temp, which renameSync preserves. The same pattern as cursor-store.ts and
      // stream-cursor-store.ts: this file sits in the user's home beside the credential stores, and
      // a record of what this machine runs is not something to leave world-readable just because it
      // happens to be small. A no-op on win32, where chmod does nothing.
      writeFileSync(tmp, text, { mode: 0o600 })
      try {
        renameSync(tmp, p)
      } catch (err) {
        // Otherwise a failed rename leaves the temp beside the real file forever.
        try {
          unlinkSync(tmp)
        } catch {
          // Never existed, or already gone.
        }
        throw err
      }
    },
  }
}

/**
 * The last version recorded as having started successfully, or null when there is none or the file
 * is unreadable. Never throws: this is consulted on a failure path, and a second failure there would
 * replace an actionable message with no message at all.
 * @returns {{version: string, at: string} | null}
 */
export function readKnownGood({ home, fs = defaultFs() }) {
  const raw = fs.readFile(knownGoodPath(home))
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const version = typeof parsed.version === 'string' ? parsed.version : ''
    if (!SEMVER_RE.test(version)) return null
    return { version, at: typeof parsed.at === 'string' ? parsed.at : '' }
  } catch {
    return null
  }
}

/**
 * Record a version as having started successfully. Idempotent: recording the same version again is a
 * no-op and does not rewrite the file, so a daemon that restarts often does not churn the disk.
 * @returns {{changed: boolean, reason: 'recorded'|'already'|'unparseable'}}
 */
export function recordKnownGood({ home, version, now = Date.now, fs = defaultFs() }) {
  const value = String(version ?? '').trim()
  // Refusing rubbish matters: a recovery message naming an unparseable version would send a human
  // to revert the marketplace ref to something that was never published.
  if (!SEMVER_RE.test(value)) return { changed: false, reason: 'unparseable' }

  const current = readKnownGood({ home, fs })
  if (current?.version === value) return { changed: false, reason: 'already' }

  fs.writeFile(
    knownGoodPath(home),
    `${JSON.stringify({ version: value, at: new Date(now()).toISOString() }, null, 2)}\n`,
  )
  return { changed: true, reason: 'recorded' }
}

/**
 * @param {{
 *   knownGood: {version: string, at: string} | null,
 *   current: string | null,
 *   missing?: boolean,
 *   path?: string | null,
 * }} params
 *
 * The line a failed rollback should say. Names the version to return to when we know it, and always
 * names the lever that works regardless of what is left on this disk.
 */
export function describeRollbackRecovery({ knownGood, current, missing = true, path = null }) {
  const running = String(current ?? '').trim()
  const runningPart = SEMVER_RE.test(running) ? ` This machine is running ${running}.` : ''

  // The observation, not a diagnosis. The old wording said the files "were removed by Claude Code's
  // cache sweep", which the caller cannot know: the identical branch is reached when the directory
  // is still there and the read fails with EACCES, and it is reached when a disk is full or a path
  // is too long. Proven by driving the real executePlan twice, differing only in whether plugin.json
  // was deleted or left in place with a throwing read. Telling someone the wrong cause on a recovery
  // path sends them to look in the wrong place, which is worse than telling them less.
  const where = path ? ` (${path})` : ''
  const observed = missing
    ? `the previous version's files are not on this disk${where}`
    : `the previous version's files could not be read${where}`
  const usually = missing
    ? ' Usually that is Claude Code sweeping the superseded generation, so check the directory before acting.'
    : ' Check permissions on that path before acting.'

  if (knownGood?.version) {
    return (
      `Local rollback is not possible: ${observed}.${usually}${runningPart} The last version that ` +
      `started cleanly here was ${knownGood.version}. To recover this machine, and every other ` +
      `machine at once, revert plugins[0].source.ref in the marketplace to v${knownGood.version}: ` +
      `the CLI applies that as an update and re-fetches, so it does not need anything left on this disk.`
    )
  }

  return (
    `Local rollback is not possible: ${observed}, and no known-good version has been recorded on ` +
    `this machine yet.${usually}${runningPart} To recover, revert plugins[0].source.ref in the ` +
    `marketplace to the last release known to work: the CLI applies that as an update and ` +
    `re-fetches, so it does not need anything left on this disk.`
  )
}
