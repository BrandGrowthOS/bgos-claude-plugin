/**
 * The skill share content rules (skills view design 4.2), run over THE SAME
 * fixture as the backend (backend/src/skills/skill-share-content-rules.spec.ts
 * on BGOS branch feat/skills-share-backend). The fixture file is a byte for
 * byte copy and its sha256 is pinned to the backend's pin, so an edit on
 * either side is a deliberate rules version bump on both.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { SKILL_SHARE_FIXTURE } from '../lib/skill-share-content-fixture.ts'
import {
  SKILL_SHARE_RULES_VERSION,
  bundleSha256,
  checkSkillShareBundle,
  isStrictSkillName,
  readSkillFrontmatter,
  verifyStoredBundle,
} from '../lib/skill-share-content-rules.ts'

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

for (const fixture of SKILL_SHARE_FIXTURE) {
  test(`fixture case ${fixture.id} gives the pinned verdict`, () => {
    const verdict = checkSkillShareBundle(fixture.files)
    assert.equal(verdict.block, fixture.block)
    assert.deepEqual(verdict.excluded, fixture.excluded)
  })
}

test('the fixture is the backend file byte for byte, rules version 1', () => {
  const text = readFileSync(new URL('../lib/skill-share-content-fixture.ts', import.meta.url), 'utf8')
  assert.equal(SKILL_SHARE_RULES_VERSION, 1)
  // The backend spec pins the same digest.
  assert.equal(sha(text), '72a85d33fd5f2d2ca3e5450db57846706cc2fcec9c1ef6d697cb5fcf4c3d55d1')
  assert.equal(SKILL_SHARE_FIXTURE.length, 46)
})

test('hashes each included file and the bundle canonically', () => {
  const verdict = checkSkillShareBundle([
    { path: 'b.md', content: 'b\n' },
    { path: 'SKILL.md', content: '---\nname: x\n---\n' },
  ])
  assert.equal(verdict.block, null)
  assert.deepEqual(
    verdict.files.map((f) => f.path),
    ['SKILL.md', 'b.md'],
  )
  assert.deepEqual(verdict.files[1], { path: 'b.md', bytes: 2, sha256: sha('b\n') })
  const expected = sha(`SKILL.md\n${sha('---\nname: x\n---\n')}\nb.md\n${sha('b\n')}\n`)
  assert.equal(verdict.sha256, expected)
  assert.equal(bundleSha256([...verdict.files].reverse()), expected)
})

test('sorts paths by UTF-8 bytes (code points), as the backend does', () => {
  const verdict = checkSkillShareBundle([
    { path: 'a\u{1F600}.md', content: 'x\n' },
    { path: 'a\uFF5E.md', content: 'y\n' },
    { path: 'SKILL.md', content: '---\nname: x\n---\n' },
  ])
  assert.deepEqual(
    verdict.files.map((f) => f.path),
    ['SKILL.md', 'a\uFF5E.md', 'a\u{1F600}.md'],
  )
})

test('reports the secret rule ids without the secret', () => {
  const fixture = SKILL_SHARE_FIXTURE.find((c) => c.id === 'secret-in-content')!
  const verdict = checkSkillShareBundle(fixture.files)
  assert.equal(verdict.scan.clean, false)
  assert.ok(verdict.scan.rules.length > 0)
  assert.ok(!JSON.stringify(verdict).includes('IOSFODNN7'))
})

test('a bundle from elsewhere carrying a file that should have stayed behind is refused', () => {
  assert.equal(
    verifyStoredBundle([
      { path: 'SKILL.md', content: '---\nname: x\n---\n' },
      { path: 'run.sh', content: 'rm -rf ~\n' },
    ]).block,
    'invalid',
  )
  assert.equal(verifyStoredBundle([{ path: 'SKILL.md', content: '---\nname: x\n---\n' }]).block, null)
})

test('the frontmatter reader matches the backend on the plain shape', () => {
  assert.deepEqual(readSkillFrontmatter('---\nname: notes\ndescription: Take notes.\n---\n'), {
    ok: true,
    keys: ['name', 'description'],
    description: 'Take notes.',
  })
  assert.equal(readSkillFrontmatter('---\ndescription: "Quoted: yes"\n---\n').description, 'Quoted: yes')
  assert.deepEqual(readSkillFrontmatter('---\ndescription: >-\n  One\n  two.\n# note\nname: n\n---\n'), {
    ok: true,
    keys: ['description', 'name'],
    description: 'One two.',
  })
  assert.equal(readSkillFrontmatter('---\ndescription: Notes # internal\n---\n').description, 'Notes')
  assert.deepEqual(readSkillFrontmatter('---\nAllowed_Tools: x\n---\n').keys, ['allowedtools'])
  assert.deepEqual(readSkillFrontmatter('# Notes\n'), { ok: true, keys: [], description: '' })
})

test('the strict skill name', () => {
  for (const ok of ['notes', 'a', 'my-skill-2', 'a'.repeat(64)]) assert.equal(isStrictSkillName(ok), true, ok)
  for (const bad of ['a/../x', '../x', 'A', 'my skill', '-x', 'x.md', 'a'.repeat(65), '', 'café']) {
    assert.equal(isStrictSkillName(bad), false, bad)
  }
})
