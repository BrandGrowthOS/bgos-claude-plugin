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
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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


// --- the real filesystem path, which had no coverage at all -----------------
//
// Every test above injects a memory fs, so defaultFs itself was never executed: a mutation harness
// showed four separate breakages to it surviving the whole suite. These run it for real, in a temp
// home, which is cheap and is the only thing that can catch them.

test('the default fs really lands the record on disk and reads it back', () => {
  const home = mkdtempSync(join(tmpdir(), 'kg-'))
  assert.equal(recordKnownGood({ home, version: '0.38.10' }).changed, true)
  // Read through a FRESH default fs, not the one that wrote it, so a store that only ever existed
  // in a closure would fail here.
  assert.equal(readKnownGood({ home })?.version, '0.38.10')
  assert.equal(recordKnownGood({ home, version: '0.38.10' }).reason, 'already')
  assert.deepEqual(
    readdirSync(join(home, '.bgos-agent')),
    ['known-good.json'],
    'the atomic write must leave no temp file behind',
  )
})

test('the record is written owner-only, like every other file this repo puts in the home', () => {
  // Skipped on win32, where chmod is a no-op: an unguarded assert here would only add to the
  // known Windows-only baseline failures rather than catch anything.
  if (process.platform === 'win32') return
  const home = mkdtempSync(join(tmpdir(), 'kg-mode-'))
  recordKnownGood({ home, version: '0.38.10' })
  assert.equal(statSync(knownGoodPath(home)).mode & 0o777, 0o600)
})

test('a second version replaces the first, and the file stays a single record', () => {
  const home = mkdtempSync(join(tmpdir(), 'kg-two-'))
  recordKnownGood({ home, version: '0.38.10' })
  recordKnownGood({ home, version: '0.38.11' })
  assert.equal(readKnownGood({ home })?.version, '0.38.11')
  const parsed = JSON.parse(readFileSync(knownGoodPath(home), 'utf8'))
  assert.deepEqual(Object.keys(parsed).sort(), ['at', 'version'])
})

// --- the recovery line must not name a cause it cannot observe --------------

test('the recovery line reports what was observed, not why, when the files are unreadable', () => {
  // Driving the real executePlan twice, differing only in whether plugin.json was deleted or left
  // in place with a throwing read, produced the same sentence blaming Claude Code's cache sweep.
  // On a recovery path that sends someone to look in the wrong place.
  const unreadable = describeRollbackRecovery({
    knownGood: { version: '0.38.5', at: 'x' },
    current: '0.38.9',
    missing: false,
    path: '/cache/hoai/0.38.9/.claude-plugin/plugin.json',
  })
  assert.match(unreadable, /could not be read/)
  assert.match(unreadable, /permissions/i, 'and points at the thing worth checking')
  assert.equal(/cache sweep/.test(unreadable), false, 'that cause was not observed here')
  assert.ok(unreadable.includes('/cache/hoai/0.38.9/.claude-plugin/plugin.json'), 'names the path')
})

test('when the files really are gone the sweep is offered as the usual explanation, not as fact', () => {
  const gone = describeRollbackRecovery({
    knownGood: { version: '0.38.5', at: 'x' },
    current: '0.38.9',
    missing: true,
  })
  assert.match(gone, /are not on this disk/)
  assert.match(gone, /Usually/, 'hedged, because the caller still has not proven the cause')
  // The half that is cause-independent stays exactly as it was: it is the actionable half.
  assert.match(gone, /revert plugins\[0\]\.source\.ref/)
  assert.match(gone, /v0\.38\.5/)
})
