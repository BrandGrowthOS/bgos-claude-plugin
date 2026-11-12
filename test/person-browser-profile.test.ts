/**
 * A revoked share takes the person's browser profile off this computer
 * (shared agent vault, plugin 0.90.0; BGOS plan 2026-11-13 section 8):
 *
 *   - the folders are the ones the browser host keys by the person's
 *     principal (`user-<id>`), the profile and its page output, never the
 *     owner's and never another person's;
 *   - only a share that ENDED says so (share_revoked, view_removed,
 *     agent_transferred), never a lane stopped for any other reason;
 *   - the owner's daemon deletes on `lane_revoked` and leaves the reason in
 *     the revoke marker the browser host reads.
 *
 * No em or en dashes in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { browserPathsFor, principalDirName } from '../bin/hoai-browser-host.mjs'
import { lanePaths } from '../lib/lane-core.mjs'
import { handleLaneRevoked } from '../lib/lane-owner.ts'
import {
  deletePersonBrowserProfile,
  personBrowserDirs,
  personShareEnded,
  SHARE_ENDED_REASONS,
  personRevokedPath,
  laneRevokedProfileCleanup,
} from '../lib/person-browser-profile.mjs'

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-'))
  const agentRoot = join(dir, '.bgos-agent')
  const make = (principal: string) => {
    const p = browserPathsFor({ agentRoot, assistantId: 1076, principal })
    for (const d of [p.profileDir, p.outputDir, p.heldDir]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'Cookies'), 'made-up') }
    return p
  }
  return { dir, agentRoot, make, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the person\'s folders are exactly the host\'s for user-<id>', () => {
  const h = home()
  try {
    const p = browserPathsFor({ agentRoot: h.agentRoot, assistantId: 1076, principal: 'user-user_Ana1' })
    // The profile, its page output and its downloads (review finding 5: held/ sits inside the downloads folder).
    assert.deepEqual(personBrowserDirs({ agentRoot: h.agentRoot, assistantId: 1076, userId: 'user_Ana1' }), [p.profileDir, p.outputDir, join(p.heldDir, '..')])
    assert.equal(typeof principalDirName, 'function', 'the host still exports it')
  } finally { h.done() }
})

test('delete removes that person\'s profile only', () => {
  const h = home()
  try {
    const ana = h.make('user-user_Ana1')
    const ben = h.make('user-user_Ben1')
    const owner = h.make('owner')
    const removed = deletePersonBrowserProfile({ agentRoot: h.agentRoot, assistantId: 1076, userId: 'user_Ana1' })
    assert.deepEqual(removed, [ana.profileDir, ana.outputDir, join(ana.heldDir, '..')])
    assert.ok(!existsSync(ana.profileDir) && !existsSync(ana.outputDir) && !existsSync(ana.heldDir))
    for (const kept of [ben.profileDir, ben.heldDir, owner.profileDir, owner.outputDir, owner.heldDir]) assert.ok(existsSync(kept), kept)
    assert.deepEqual(deletePersonBrowserProfile({ agentRoot: h.agentRoot, assistantId: 1076, userId: 'user_Ana1' }), [], 'nothing left')
    assert.throws(() => deletePersonBrowserProfile({ agentRoot: h.agentRoot, assistantId: 1076, userId: 'user_Own1', ownerUserId: 'user_Own1' }), 'never the owner')
    for (const bad of ['../owner', '', 'user_x/../../y']) {
      assert.throws(() => deletePersonBrowserProfile({ agentRoot: h.agentRoot, assistantId: 1076, userId: bad }), bad)
    }
    assert.throws(() => deletePersonBrowserProfile({ agentRoot: h.agentRoot, assistantId: '../1', userId: 'user_Ana1' }))
  } finally { h.done() }
})

test('only a share that ended counts, read from the lane\'s revoke marker', () => {
  const h = home()
  try {
    assert.deepEqual([...SHARE_ENDED_REASONS], ['share_revoked', 'view_removed', 'agent_transferred'])
    const marker = personRevokedPath({ agentRoot: h.agentRoot, assistantId: 1076, userId: 'user_Ana1' })
    assert.equal(marker, lanePaths({ home: h.dir, assistantId: '1076', userId: 'user_Ana1' }).revokedPath)
    const ended = () => personShareEnded({ agentRoot: h.agentRoot, assistantId: 1076, userId: 'user_Ana1' })
    assert.equal(ended(), false, 'no marker')
    mkdirSync(join(marker, '..'), { recursive: true })
    writeFileSync(marker, JSON.stringify({ reason: 'revoked', by: 'owner-daemon' }))
    assert.equal(ended(), false, 'an older marker names no share reason')
    writeFileSync(marker, JSON.stringify({ reason: 'revoked', shareReason: 'session_refused' }))
    assert.equal(ended(), false)
    writeFileSync(marker, JSON.stringify({ reason: 'revoked', shareReason: 'share_revoked' }))
    assert.equal(ended(), true)
    writeFileSync(marker, 'not json')
    assert.equal(ended(), false)
  } finally { h.done() }
})

test('the owner daemon deletes the profile on a share that ended, and leaves the reason in the marker', () => {
  const h = home()
  try {
    const ana = h.make('user-user_Ana1')
    const paths = lanePaths({ home: h.dir, assistantId: '1076', userId: 'user_Ana1' })
    mkdirSync(paths.laneDir, { recursive: true })
    const deps = { assistantId: '1076', home: h.dir, log: () => {} }
    assert.equal(handleLaneRevoked({ assistantId: 1076, actorUserId: 'user_Ana1', reason: 'share_revoked' }, deps as never), true)
    assert.ok(!existsSync(ana.profileDir), 'deleted')
    assert.equal(JSON.parse(readFileSync(paths.revokedPath, 'utf8')).shareReason, 'share_revoked')
    // A lane stopped for another reason keeps the person's profile.
    const ben = h.make('user-user_Ben1')
    mkdirSync(lanePaths({ home: h.dir, assistantId: '1076', userId: 'user_Ben1' }).laneDir, { recursive: true })
    assert.equal(handleLaneRevoked({ assistantId: 1076, actorUserId: 'user_Ben1', reason: 'session_refused' }, deps as never), true)
    assert.ok(existsSync(ben.profileDir), 'kept')
    // No lane folder (the person never had a lane here): the profile still goes.
    const cy = h.make('user-user_Cy1')
    assert.equal(handleLaneRevoked({ assistantId: 1076, actorUserId: 'user_Cy1', reason: 'agent_transferred' }, deps as never), false)
    assert.ok(!existsSync(cy.profileDir))
    // The owner is never a person whose share ended.
    const own = h.make('user-user_Own1')
    handleLaneRevoked({ assistantId: 1076, actorUserId: 'user_Own1', reason: 'share_revoked' }, { ...deps, ownerUserId: 'user_Own1' } as never)
    assert.ok(existsSync(own.profileDir))
  } finally { h.done() }
})

test('the lane daemon deletes on its own lane_revoked only when the share ended, and only for its own person', () => {
  const h = home()
  try {
    const ana = h.make('user-user_Ana1')
    const lane = { userId: 'user_Ana1', assistantId: '1076' }
    assert.deepEqual(laneRevokedProfileCleanup({ assistantId: 1076, actorUserId: 'user_Ana1', reason: 'session_refused' }, lane, h.agentRoot), [])
    assert.deepEqual(laneRevokedProfileCleanup({ assistantId: 1076, actorUserId: 'user_Ben1', reason: 'share_revoked' }, lane, h.agentRoot), [])
    assert.deepEqual(laneRevokedProfileCleanup({ assistantId: 9, actorUserId: 'user_Ana1', reason: 'share_revoked' }, lane, h.agentRoot), [])
    assert.ok(existsSync(ana.profileDir))
    assert.deepEqual(laneRevokedProfileCleanup({ assistantId: 1076, actorUserId: 'user_Ana1', reason: 'view_removed' }, lane, h.agentRoot), [ana.profileDir, ana.outputDir, join(ana.heldDir, '..')])
  } finally { h.done() }
})
