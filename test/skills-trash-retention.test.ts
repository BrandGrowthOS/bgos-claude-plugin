import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { removeAgentSkill } from '../lib/skills-inventory.ts'
import { installBundle } from '../lib/skills-share.ts'
import { bundleSha256, sha256Hex } from '../lib/skill-share-content-rules.ts'

const DAY = 24 * 60 * 60 * 1000
const START = Date.UTC(2026, 10, 13)

function fixture(t: { after(fn: () => void): void }) {
  // All test data stays in the checkout, including the pretend home and trash.
  const root = mkdtempSync(resolve('.skills-trash-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const agentDir = join(home, 'agent')
  const skills = join(agentDir, '.claude', 'skills')
  const trashDir = join(root, 'state', 'skills-trash')
  mkdirSync(skills, { recursive: true })
  let clock = START
  const input = {
    agentDir, home, configDir: join(home, 'config'), managedDir: join(root, 'managed'),
    trashDir, now: () => clock,
  }
  function write(name: string, words: string) {
    const folder = join(skills, name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill\n---\n${words}\n`)
    return folder
  }
  function remove(name: string) {
    const answer = removeAgentSkill({ ...input, payload: { scope: 'agent', name, path: join(skills, name) } })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.ok(answer.ok && answer.trashedTo)
    return answer.trashedTo
  }
  function backups(name: string) {
    return readdirSync(trashDir).filter(n => n.endsWith('.json')).filter(n => {
      const note = JSON.parse(readFileSync(join(trashDir, n), 'utf8'))
      return note.name === name
    }).map(n => {
      const path = join(trashDir, n.slice(0, -5))
      assert.ok(existsSync(path), `orphaned backup label: ${n}`)
      return path
    }).sort()
  }
  return { ...input, root, skills, write, remove, backups, at: (time: number) => { clock = time } }
}

test('25 backups keep only the newest 20, then a new write removes backups older than 30 days', t => {
  const f = fixture(t)
  const written: string[] = []
  for (let i = 0; i < 25; i++) {
    f.at(START + i)
    f.write('review', `version ${i}`)
    written.push(f.remove('review'))
  }
  assert.deepEqual(f.backups('review'), written.slice(-20))
  for (const path of written.slice(0, 5)) {
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(path + '.json'), false)
  }
  f.at(START + 31 * DAY)
  f.write('review', 'after expiry')
  const newest = f.remove('review')
  assert.deepEqual(f.backups('review'), [newest])
  assert.deepEqual(readdirSync(f.trashDir).sort(), [newest, newest + '.json'].map(p => p.slice(f.trashDir.length + 1)).sort())
})

test('the newest backup always survives, including old source mtimes and 25 writes in the same millisecond', t => {
  const f = fixture(t)
  const written: string[] = []
  for (let i = 0; i < 25; i++) {
    const folder = f.write('review', `version ${i}`)
    const old = new Date(START - 90 * DAY)
    utimesSync(folder, old, old)
    written.push(f.remove('review'))
    assert.ok(existsSync(written.at(-1)!))
  }
  assert.deepEqual(f.backups('review'), written.slice(-20).sort())
  assert.match(readFileSync(join(written.at(-1)!, 'SKILL.md'), 'utf8'), /version 24/)
})

test('expiry is strictly older than 30 days and uses backup time rather than source modification time', t => {
  const f = fixture(t)
  f.write('review', 'original')
  const first = f.remove('review')
  f.at(START + 30 * DAY)
  f.write('review', 'at the cutoff')
  const boundary = f.remove('review')
  assert.deepEqual(f.backups('review'), [first, boundary].sort())
  f.at(START + 30 * DAY + 1)
  f.write('review', 'past the cutoff')
  const newest = f.remove('review')
  assert.deepEqual(f.backups('review'), [boundary, newest].sort())
  assert.equal(existsSync(first + '.json'), false)
})

test('the just-written backup survives a clock that moves backwards behind the 20 retained timestamps', t => {
  const f = fixture(t)
  for (let i = 0; i < 25; i++) {
    f.at(START + i)
    f.write('review', `version ${i}`)
    f.remove('review')
  }
  f.at(START - 90 * DAY)
  f.write('review', 'newest write on a regressed clock')
  const newest = f.remove('review')
  assert.equal(f.backups('review').length, 20)
  assert.ok(existsSync(newest))
  assert.match(readFileSync(join(newest, 'SKILL.md'), 'utf8'), /newest write/)
})

test('a skill with a numeric prefix is never pruned as another skill collision', t => {
  const f = fixture(t)
  f.write('2-review', 'another skill')
  const other = f.remove('2-review')
  for (let i = 0; i < 25; i++) {
    f.write('review', `version ${i}`)
    f.remove('review')
  }
  assert.deepEqual(f.backups('2-review'), [other])
  assert.match(readFileSync(join(other, 'SKILL.md'), 'utf8'), /another skill/)
  assert.equal(f.backups('review').length, 20)
})

test('writing any skill also expires backups of skills that have not been touched in 30 days', t => {
  const f = fixture(t)
  f.write('old-skill', 'old words')
  const old = f.remove('old-skill')
  f.at(START + 31 * DAY)
  f.write('new-skill', 'new words')
  const newest = f.remove('new-skill')
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(old + '.json'), false)
  assert.deepEqual(f.backups('new-skill'), [newest])
})

test('pruning a removed symlink removes only the backup link and its label', t => {
  const f = fixture(t)
  const outside = join(f.root, 'other-skill')
  mkdirSync(outside)
  writeFileSync(join(outside, 'SKILL.md'), 'leave this target alone')
  symlinkSync(outside, join(f.skills, 'review'), process.platform === 'win32' ? 'junction' : 'dir')
  const linked = f.remove('review')
  f.at(START + 31 * DAY)
  f.write('review', 'new copy')
  const newest = f.remove('review')
  assert.equal(existsSync(linked), false)
  assert.equal(existsSync(linked + '.json'), false)
  assert.equal(readFileSync(join(outside, 'SKILL.md'), 'utf8'), 'leave this target alone')
  assert.deepEqual(f.backups('review'), [newest])
})

test('Replace uses the same cap and a failed install can still restore its newest backup', async t => {
  const f = fixture(t)
  for (let i = 0; i < 25; i++) {
    f.at(START + i)
    f.write('review', `version ${i}`)
    f.remove('review')
  }
  f.write('review', 'restore these words')
  const content = '---\nname: review\ndescription: A test skill\n---\nNew words.\n'
  const files = [{ path: 'SKILL.md', content, sha256: sha256Hex(content) }]
  const input = { ...f, platform: process.platform, payload: { offerId: '11111111-1111-4111-8111-111111111111', name: 'review', replace: true, files, sha256: bundleSha256(files) } }
  const failed = await installBundle({ ...input, rename: () => { throw new Error('injected final move failure') } })
  assert.equal(failed.ok, false)
  assert.match(readFileSync(join(f.skills, 'review', 'SKILL.md'), 'utf8'), /restore these words/)
  // A rollback may leave its old label, but never its restored folder in trash.
  const installed = await installBundle(input)
  assert.equal(installed.ok, true, JSON.stringify(installed))
  assert.equal(f.backups('review').length, 20)
  assert.match(readFileSync(join(f.skills, 'review', 'SKILL.md'), 'utf8'), /New words/)
})
