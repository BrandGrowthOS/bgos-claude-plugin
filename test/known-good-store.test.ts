/**
 * What version last proved itself on this machine, and what to do when rollback cannot use it.
 *
 * THE GAP THIS CLOSES. rollbackCore restores a previous version by re-pointing at its cache
 * directory. That directory belongs to Claude Code, which actively sweeps superseded plugin
 * generations: they carry .orphaned_at markers and there is a .last_inuse_sweep timestamp beside
 * them. When the sweep has been there first, rollback returns impossible('install_path_missing')
 * and simply stops. A dead end, with nothing said about what would actually get the machine back.
 *
 * WHAT WE DELIBERATELY DO NOT DO, and why. The obvious fix is to keep our own copy of the payload
 * outside the swept directory. Measured on a real install, one generation is 71 MB, of which 67 MB
 * is node_modules, and the daemon genuinely needs those modules to run. So a full copy costs 71 MB
 * per retained version, and a source-only copy (3.9 MB) cannot be restored without a network
 * install, which is exactly the situation the local copy was supposed to survive.
 *
 * Meanwhile reverting the marketplace ref was measured to work as a real recall: the CLI applies a
 * downgrade and RE-FETCHES the older version, so it does not depend on any local cache surviving.
 *
 * So the cheap fix is the better one: remember which version last proved itself, in a few bytes, and
 * make the dead end name the recovery instead of stopping at it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeRollbackRecovery,
  knownGoodPath,
  readKnownGood,
  recordKnownGood,
} from '../lib/known-good-store.mjs'

const HOME = '/home/kc'

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readFile: (p: string) => files.get(p) ?? null,
    writeFile: (p: string, c: string) => {
      files.set(p, c)
    },
  }
}

test('the record lives outside the directories Claude Code sweeps', () => {
  const path = knownGoodPath(HOME)
  assert.match(path, /\.bgos-agent/, 'must live under our own state dir')
  assert.doesNotMatch(path, /plugins[\\/]cache/, 'must not live in the cache Claude Code sweeps')
})

test('recording a healthy version round trips', () => {
  const fs = memFs()
  const written = recordKnownGood({ home: HOME, version: '0.38.5', now: () => 1_700_000_000_000, fs })
  assert.equal(written.changed, true)
  assert.equal(readKnownGood({ home: HOME, fs })?.version, '0.38.5')
})

test('recording the same version twice does not rewrite the file', () => {
  const fs = memFs()
  recordKnownGood({ home: HOME, version: '0.38.5', now: () => 1, fs })
  const before = fs.files.get(knownGoodPath(HOME))
  const second = recordKnownGood({ home: HOME, version: '0.38.5', now: () => 2, fs })
  assert.equal(second.changed, false)
  assert.equal(fs.files.get(knownGoodPath(HOME)), before, 'a no-op must not churn the file')
})

test('a newer healthy version replaces the record', () => {
  const fs = memFs()
  recordKnownGood({ home: HOME, version: '0.38.5', now: () => 1, fs })
  recordKnownGood({ home: HOME, version: '0.38.6', now: () => 2, fs })
  assert.equal(readKnownGood({ home: HOME, fs })?.version, '0.38.6')
})

test('an unparseable version is refused rather than recorded', () => {
  // Recording rubbish here would produce a recovery message telling a human to revert to nothing.
  const fs = memFs()
  const r = recordKnownGood({ home: HOME, version: 'not-a-version', now: () => 1, fs })
  assert.equal(r.changed, false)
  assert.equal(readKnownGood({ home: HOME, fs }), null)
})

test('a corrupt record reads as absent rather than throwing', () => {
  const fs = memFs({ [knownGoodPath(HOME)]: '{ not json' })
  assert.equal(readKnownGood({ home: HOME, fs }), null)
})

test('the recovery message names the version AND the lever that actually works', () => {
  const msg = describeRollbackRecovery({ knownGood: { version: '0.38.5', at: 'x' }, current: '0.38.9' })
  assert.match(msg, /0\.38\.5/, 'must name the version to go back to')
  assert.match(msg, /ref/i, 'must name reverting the marketplace ref, the lever measured to work')
  assert.doesNotMatch(msg, /undefined|null/)
})

test('the recovery message is still useful when nothing was ever recorded', () => {
  const msg = describeRollbackRecovery({ knownGood: null, current: '0.38.9' })
  assert.ok(msg.length > 0)
  assert.match(msg, /ref/i, 'the lever is still the answer even without a recorded version')
  assert.doesNotMatch(msg, /undefined|null/)
})
