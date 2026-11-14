import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateHookLiveness, privateHookLiveLine } from '../lib/private-hook-presence.ts'

// QUIETTURN4 (the two account test, 2026-11-13): the boot read of the settings files is not the last word. A boot
// that found no private turn hook writes it, and the CLI can run it from its next prompt on. The hook's own marker,
// read for an admitted turn, proves it is live in this session; from then on the quiet turn hold and the refusal
// wording follow that, for the rest of the daemon life.

const absent = { registered: false, where: 'no entry' }
const present = { registered: true, where: '/agent/.claude/settings.local.json' }

test('a hook found at boot is live from the start and says nothing more', () => {
  const lines: string[] = []
  const hook = createPrivateHookLiveness({ atBoot: present, log: (line) => { lines.push(line) } })
  assert.equal(hook.live(), true)
  assert.equal(hook.noteTurn({ markerPath: '/state/private/marker.json' }), true)
  assert.deepEqual(lines, [])
})

test('a hook missing at boot is not live until its own marker is read for a turn, then stays live, said once', () => {
  const lines: string[] = []
  const hook = createPrivateHookLiveness({ atBoot: absent, log: (line) => { lines.push(line) } })
  assert.equal(hook.live(), false)
  assert.equal(hook.noteTurn(null), false, 'no turn')
  assert.equal(hook.noteTurn(undefined), false)
  assert.equal(hook.noteTurn({}), false, 'a turn the tracker admitted from a forwarder line alone, with no marker')
  assert.equal(hook.noteTurn({ markerPath: null }), false)
  assert.equal(hook.noteTurn({ markerPath: '' }), false)
  assert.equal(hook.noteTurn({ markerPath: 42 as unknown as string }), false)
  assert.equal(hook.live(), false)
  assert.deepEqual(lines, [])
  assert.equal(hook.noteTurn({ markerPath: '/state/private/marker.json' }), true)
  assert.equal(hook.live(), true)
  assert.equal(hook.noteTurn(null), true, 'it latches: a later turn with no marker does not take it back')
  assert.equal(hook.noteTurn({ markerPath: '/state/private/marker.json' }), true)
  assert.deepEqual(lines, [privateHookLiveLine()])
  assert.match(lines[0]!, /^private turn: the private turn hook is live in this session/)
})

test('the presence view is the same answer in the boot read\'s shape, read at each use', () => {
  const hook = createPrivateHookLiveness({ atBoot: absent })
  const view = hook.presence
  assert.equal(view.registered, false)
  assert.equal(view.where, 'no entry', 'the boot read says why, until the marker proves otherwise')
  hook.noteTurn({ markerPath: '/m' })
  assert.equal(view.registered, true, 'the same object, read again')
  assert.match(view.where, /marker was read/)
  const atBoot = createPrivateHookLiveness({ atBoot: present }).presence
  assert.equal(atBoot.registered, true)
  assert.equal(atBoot.where, present.where)
})

test('a log that throws never breaks the read', () => {
  const hook = createPrivateHookLiveness({ atBoot: absent, log: () => { throw new Error('log down') } })
  assert.equal(hook.noteTurn({ markerPath: '/m' }), true)
  assert.equal(hook.live(), true)
})
