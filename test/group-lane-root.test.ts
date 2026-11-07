/**
 * Round 4 (findings 3 and 7): the group lanes' own root folder, private to the
 * user, and whether the host's CLI sandbox really WORKS (not only that its
 * binaries exist). A host with no working sandbox runs With approvals as Talk
 * only (lib/group-lanes.ts), because the CLI then runs Bash unfenced.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { ensureGroupLaneRoot, groupSandboxWorks } from '../lib/group-lane-root.ts'

function fsRig(st: { link?: boolean; dir?: boolean; uid?: number; mode?: number } = {}) {
  const made: Array<[string, number]> = []
  const chmods: Array<[string, number]> = []
  return {
    made, chmods,
    fs: {
      mkdir: (p: string, mode: number) => { made.push([p, mode]) },
      lstat: () => ({ isSymbolicLink: () => st.link === true, isDirectory: () => st.dir !== false, uid: st.uid ?? 1000, mode: st.mode ?? 0o40700 }),
      chmod: (p: string, mode: number) => { chmods.push([p, mode]) },
    },
  }
}

test('round 4, finding 7: the lane root is base/hoai-group-lanes-<uid>/<assistant>, made 0700', () => {
  const r = fsRig()
  assert.equal(ensureGroupLaneRoot({ base: '/var/tmp', uid: 1000, assistantId: '7', fs: r.fs }), '/var/tmp/hoai-group-lanes-1000/7')
  assert.deepEqual(r.made, [['/var/tmp/hoai-group-lanes-1000', 0o700], ['/var/tmp/hoai-group-lanes-1000/7', 0o700]])
  assert.deepEqual(r.chmods, [])
})

test('round 4, finding 7: a top folder that is a link is refused', () => {
  assert.throws(() => ensureGroupLaneRoot({ base: '/var/tmp', uid: 1000, assistantId: '7', fs: fsRig({ link: true }).fs }), /not this user's own/)
})

test('round 4, finding 7: a top folder that is not a folder is refused', () => {
  assert.throws(() => ensureGroupLaneRoot({ base: '/var/tmp', uid: 1000, assistantId: '7', fs: fsRig({ dir: false }).fs }), /not this user's own/)
})

test('round 4, finding 7: a top folder another user owns is refused', () => {
  assert.throws(() => ensureGroupLaneRoot({ base: '/var/tmp', uid: 1000, assistantId: '7', fs: fsRig({ uid: 1001 }).fs }), /not this user's own/)
})

test('round 4, finding 7: a top folder others can open is made 0700 again', () => {
  const r = fsRig({ mode: 0o40755 })
  ensureGroupLaneRoot({ base: '/var/tmp', uid: 1000, assistantId: '7', fs: r.fs })
  assert.deepEqual(r.chmods, [['/var/tmp/hoai-group-lanes-1000', 0o700]])
})

test('round 4, finding 3: a sandbox counts only when it really starts', async () => {
  const runs: string[] = []
  const run = (ok: Record<string, boolean>) => async (cmd: string, args: string[]) => { runs.push(`${cmd} ${args.join(' ')}`); return ok[cmd] === true }
  assert.equal(await groupSandboxWorks({ platform: 'linux', run: run({ bwrap: true, socat: true }) }), true)
  assert.ok(runs.some((r) => r.startsWith('bwrap ')), 'bwrap is really started')
  assert.equal(await groupSandboxWorks({ platform: 'linux', run: run({ bwrap: false, socat: true }) }), false, 'bwrap present but not starting')
  assert.equal(await groupSandboxWorks({ platform: 'linux', run: run({ bwrap: true, socat: false }) }), false)
  assert.equal(await groupSandboxWorks({ platform: 'darwin', run: run({ '/usr/bin/sandbox-exec': true }) }), true)
  assert.equal(await groupSandboxWorks({ platform: 'darwin', run: run({}) }), false)
  assert.equal(await groupSandboxWorks({ platform: 'win32', run: run({}) }), false)
  assert.equal(await groupSandboxWorks({ platform: 'linux', run: async () => { throw new Error('ENOENT') } }), false)
})
