/**
 * A PERSON'S LANE FOLDERS ARE NAMED BY A CASE-STABLE KEY OF THE WHOLE ID (fix
 * round 377, finding 7).
 *
 * The rule: each person's lane work, state and revoke marker live in a folder
 * of their own on any disk, case-insensitive ones included, and containment
 * follows the disk's own case behaviour.
 *
 * WHAT THESE TESTS HOLD.
 *   - laneUserKey is lower case and injective: ids that differ only by case
 *     get different folders, and lanePaths, the revoke marker and the floor
 *     all use it;
 *   - openLaneFolders checks the folder's identity, moves an earlier
 *     version's folder under the key only when it is unambiguously this
 *     person's, and quarantines anything else;
 *   - the owner's scans read a keyed folder's person from its identity, and a
 *     revoke reaches a legacy folder still run by an old supervisor;
 *   - containment folds case only where the disk itself does.
 *
 * Run with: npx tsx --test test/lane-folder-key.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as core from '../lib/lane-core.mjs'
import { lanePathIsSecret } from '../lib/hard-floor-lane.mjs'
import { personRevokedPath } from '../lib/person-browser-profile.mjs'
import * as owner from '../lib/lane-owner.ts'

const c: any = core
const o: any = owner
const AGENT = '1076'
const ANA_UPPER = 'user_Ana'
const ANA_LOWER = 'user_ana'

function home() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-key-')))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('two ids that differ only by case get two folders, both lower case', () => {
  const a = c.laneUserKey(ANA_UPPER)
  const b = c.laneUserKey(ANA_LOWER)
  assert.notEqual(a, b)
  for (const key of [a, b]) {
    assert.match(key, c.LANE_KEY_RE)
    assert.equal(key, key.toLowerCase(), 'a case-insensitive disk cannot merge them')
  }
  assert.notEqual(a.toLowerCase(), b.toLowerCase())
  const pa = c.lanePaths({ home: '/h', assistantId: AGENT, userId: ANA_UPPER, platform: 'darwin' })
  const pb = c.lanePaths({ home: '/h', assistantId: AGENT, userId: ANA_LOWER, platform: 'darwin' })
  assert.notEqual(pa.laneDir.toLowerCase(), pb.laneDir.toLowerCase(), 'work folders')
  assert.notEqual(pa.stateDir.toLowerCase(), pb.stateDir.toLowerCase(), 'state folders')
  assert.ok(pa.laneDir.endsWith(`/people/${a}`))
  assert.ok(pa.stateDir.endsWith(`/lanes/${a}`))
  assert.ok(personRevokedPath({ agentRoot: '/h/.bgos-agent', assistantId: AGENT, userId: ANA_UPPER }).includes(`/people/${a}/`), 'the revoke marker too')
  assert.throws(() => c.laneUserKey('../x'))
})

test('a lane folder is opened only for the person its identity names', () => {
  const h = home()
  try {
    const paths = c.lanePaths({ home: h.root, assistantId: AGENT, userId: ANA_UPPER })
    assert.deepEqual(c.openLaneFolders({ paths, userId: ANA_UPPER, fs: nodeFs }), { opened: 'new' })
    assert.deepEqual(JSON.parse(readFileSync(paths.identityPath, 'utf8')), { v: 1, userId: ANA_UPPER })
    assert.deepEqual(c.openLaneFolders({ paths, userId: ANA_UPPER, fs: nodeFs }), { opened: 'existing' })
    // A folder whose identity names somebody else is refused.
    writeFileSync(paths.identityPath, JSON.stringify({ v: 1, userId: ANA_LOWER }))
    assert.throws(() => c.openLaneFolders({ paths, userId: ANA_UPPER, fs: nodeFs }), (e: any) => e.code === 'lane_identity_mismatch')
    // The owner's scans read the person from the identity, checked against the name.
    writeFileSync(paths.identityPath, JSON.stringify({ v: 1, userId: ANA_UPPER }))
    assert.equal(c.laneFolderOwner({ peopleDir: paths.peopleDir, name: paths.laneKey, fs: nodeFs }), ANA_UPPER)
    writeFileSync(paths.identityPath, JSON.stringify({ v: 1, userId: ANA_LOWER }))
    assert.equal(c.laneFolderOwner({ peopleDir: paths.peopleDir, name: paths.laneKey, fs: nodeFs }), null, 'an identity that does not hash to the name is nobody')
  } finally { h.done() }
})

test('an earlier version\'s folder moves under the key when it is unambiguously this person\'s, with its state', () => {
  const h = home()
  try {
    const paths = c.lanePaths({ home: h.root, assistantId: AGENT, userId: ANA_UPPER })
    mkdirSync(join(paths.legacyLaneDir, 'work'), { recursive: true })
    writeFileSync(join(paths.legacyLaneDir, 'session-id'), 'pin-of-ana')
    mkdirSync(paths.legacyStateDir, { recursive: true })
    writeFileSync(join(paths.legacyStateDir, 'cursor.json'), '{"c":1}')
    assert.deepEqual(c.openLaneFolders({ paths, userId: ANA_UPPER, fs: nodeFs }), { opened: 'migrated' })
    assert.equal(readFileSync(paths.sessionIdPath, 'utf8'), 'pin-of-ana')
    assert.equal(readFileSync(paths.cursorPath, 'utf8'), '{"c":1}')
    assert.equal(existsSync(paths.legacyLaneDir), false)
  } finally { h.done() }
})

test('a keyed folder made early (the stopped lane\'s memory) still takes in an unambiguous earlier folder', async () => {
  const h = home()
  try {
    const { resolveLaneMemoryFolder } = await import('../lib/lane-memory-rpc.ts')
    const paths = c.lanePaths({ home: h.root, assistantId: AGENT, userId: ANA_UPPER })
    mkdirSync(join(paths.legacyLaneDir, 'work', 'memory'), { recursive: true })
    writeFileSync(join(paths.legacyLaneDir, 'work', 'memory', 'MEMORY.md'), 'ana remembers')
    writeFileSync(join(paths.legacyLaneDir, 'session-id'), 'pin-of-ana')
    // The owner's daemon answers a memory frame before the lane ever launched again.
    assert.equal((resolveLaneMemoryFolder(paths) as any).ok, true)
    assert.deepEqual(c.openLaneFolders({ paths, userId: ANA_UPPER, fs: nodeFs }), { opened: 'migrated' })
    assert.equal(readFileSync(paths.sessionIdPath, 'utf8'), 'pin-of-ana')
    assert.equal(readFileSync(join(paths.memoryDir, 'MEMORY.md'), 'utf8'), 'ana remembers')
    assert.equal(existsSync(paths.legacyLaneDir), false)
  } finally { h.done() }
})

test('an earlier version\'s folder that may be another person\'s is quarantined, never used', () => {
  const h = home()
  try {
    const paths = c.lanePaths({ home: h.root, assistantId: AGENT, userId: ANA_LOWER })
    // On a folding disk the folder that opens for user_ana is user_Ana's; modelled here by its spelling on disk.
    const fakeFs = { ...nodeFs, readdirSync: (dir: any, ...rest: any[]) => (String(dir) === paths.peopleDir ? [ANA_UPPER] : (nodeFs.readdirSync as any)(dir, ...rest)) }
    mkdirSync(join(paths.legacyLaneDir, 'work'), { recursive: true })
    writeFileSync(join(paths.legacyLaneDir, 'session-id'), 'pin-of-the-other')
    assert.deepEqual(c.openLaneFolders({ paths, userId: ANA_LOWER, fs: fakeFs }), { opened: 'quarantined' })
    assert.equal(existsSync(paths.sessionIdPath), false, 'the other person\'s pin is not this lane\'s')
    assert.ok(nodeFs.readdirSync(join(paths.peopleDir, '.quarantine')).length === 1)
    // A legacy folder beside an existing keyed lane is quarantined too.
    mkdirSync(join(paths.legacyLaneDir, 'work'), { recursive: true })
    assert.deepEqual(c.openLaneFolders({ paths, userId: ANA_LOWER, fs: nodeFs }), { opened: 'quarantined' })
    assert.equal(existsSync(paths.legacyLaneDir), false)
  } finally { h.done() }
})

test('the owner\'s scans find keyed folders by identity and legacy folders by name; a revoke reaches a legacy folder', () => {
  const h = home()
  try {
    const keyed = c.lanePaths({ home: h.root, assistantId: AGENT, userId: ANA_UPPER })
    c.openLaneFolders({ paths: keyed, userId: ANA_UPPER, fs: nodeFs })
    const ben = c.lanePaths({ home: h.root, assistantId: AGENT, userId: 'user_Ben' })
    mkdirSync(ben.legacyLaneDir, { recursive: true })
    const found = o.laneFoldersIn(keyed.peopleDir, nodeFs).map((f: any) => [f.userId, f.legacy]).sort()
    assert.deepEqual(found, [[ANA_UPPER, false], ['user_Ben', true]])
    const handled = o.handleLaneRevoked({ assistantId: AGENT, actorUserId: 'user_Ben', reason: 'paused' }, { assistantId: AGENT, home: h.root, ownerUserId: 'user_owner', log: () => {}, fs: nodeFs })
    assert.equal(handled, true)
    assert.ok(existsSync(join(ben.legacyLaneDir, 'stop-request.json')), 'the old supervisor reads its stop where it runs')
  } finally { h.done() }
})

test('the file floor: the own key and the exact id are the person\'s own lane; a case variant of the id never is', () => {
  const key = c.laneUserKey(ANA_LOWER)
  const own = (p: string) => !lanePathIsSecret(p, { actorUserId: ANA_LOWER })
  assert.equal(own(`/Users/kc/.bgos-agent/1076/people/${key}/work/notes.md`), true, 'the keyed lane')
  assert.equal(own(`/Users/kc/.bgos-agent/1076/people/${ANA_LOWER}/work/notes.md`), true, 'the exact id (the shared case list)')
  assert.equal(own(`/Users/kc/.bgos-agent/1076/people/${ANA_UPPER}/work/notes.md`), false, 'another person who differs only by case')
  assert.equal(own(`/Users/kc/.bgos-agent/1076/people/${c.laneUserKey(ANA_UPPER)}/work/notes.md`), false, 'the other person\'s key')
  assert.equal(own(`/Users/kc/.bgos-agent/1076/people/${key.toUpperCase()}/work/notes.md`), true, 'the key read case folded is still the key (a folding disk opens the same folder)')
})

test('containment folds case only where the disk does', () => {
  // A folding disk resolves the case-swapped name to the folder itself; a case-sensitive one does not resolve it.
  const folding = (p: string) => (p.toLowerCase() === "/vol/work" ? "/Vol/Work" : p)
  const sensitive = (p: string) => { if (p === "/Vol/Work" || p.startsWith("/vol/work")) return p; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }
  assert.equal(c.folderFoldsCase("/Vol/Work", { realpath: folding, platform: "darwin" }), true)
  assert.equal(c.folderFoldsCase("/Vol/Work", { realpath: sensitive, platform: "darwin" }), false, "a case-sensitive macOS volume")
  assert.equal(c.isInsideFolder('/vol/work/x', '/Vol/Work', 'darwin', false), false)
  assert.equal(c.isInsideFolder('/vol/work/x', '/Vol/Work', 'darwin', true), true)
  assert.equal(c.isInsideFolder('/Vol/Work/x', '/Vol/Work', 'darwin', false), true)
  // confineLanePath asks the disk when it can.
  assert.deepEqual(c.confineLanePath('/vol/work/x', { workDir: '/Vol/Work', realpath: sensitive, platform: 'darwin', probeCase: true }), { ok: false, reason: 'outside' })
  // The lane daemon hands it the disk's own spelling and asks.
  const lane = readFileSync(join(import.meta.dirname, '..', 'lane-server.ts'), 'utf8')
  assert.match(lane, /checkLaneReply\(req\.params\.arguments, \{ workDir: CFG\.workDir, realpath: \(p\) => realpathSync\.native\(p\), deliveredChats, probeCase: true \}\)/)
})

test('the supervisor opens the folders through openLaneFolders before it makes any, and the daemon checks the identity', () => {
  const sup = readFileSync(join(import.meta.dirname, '..', 'lib', 'lane-supervisor.mjs'), 'utf8')
  const run = sup.slice(sup.indexOf('export async function superviseLane('))
  assert.ok(run.indexOf('openLaneFolders({ paths, userId: o.userId, fs, now, platform })') < run.indexOf('fs.mkdirSync(paths.workDir'))
  const lane = readFileSync(join(import.meta.dirname, '..', 'lane-server.ts'), 'utf8')
  assert.match(lane, /let owner: unknown = LANE\.userId[\s\S]*!== 'ENOENT'\) owner = null[\s\S]*if \(owner !== LANE\.userId\) \{\n\s*process\.stderr\.write\('\[hoai lane\] refusing to start: the lane folder does not name this person\\n'\)/)
})
