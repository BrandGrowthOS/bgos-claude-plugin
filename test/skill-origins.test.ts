import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { identOf, type SkillItem, type SkillScope } from '../lib/skills-inventory.ts'
import { scratchDir } from './helpers/scratch-dirs.ts'
import { linkFolder } from './helpers/links.ts'

// Keep every case named in the red run, even before the module exists.
const loaded = await import('../lib/skill-origins.ts').catch(() => null)
function api() {
  assert.ok(loaded, 'skill-origins module must exist')
  return loaded
}

function world() {
  const root = realpathSync(scratchDir('skill-origins-'))
  const agent = join(root, 'agent')
  const folder = join(agent, '.claude', 'skills', 'foo')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: foo\ndescription: Take notes.\n---\n')
  return { root, agent, folder, file: join(root, 'state', 'skill-origins.json') }
}

function row(path: string, scope: SkillScope = 'agent'): SkillItem {
  return { name: 'display-name', description: '', path, scope, provenance: 'local', removable: true, shareable: true }
}

const tap = { chatId: 'chat', tapperUserId: 'owner', ownerUserId: 'owner', callbackData: 'teach_approve', posted: true, now: 100 }

for (const callbackData of ['teach_approve', 'u:teach_approve']) {
  test(`teach window accepts owner posted ${callbackData}, once in the same chat`, () => {
    const windows = api().createTeachWindows()
    windows.noteTap({ ...tap, callbackData })
    assert.equal(windows.take('other-chat', 101), null)
    assert.deepEqual(windows.take('chat', 101), { by: 'owner' })
    assert.equal(windows.take('chat', 102), null)
  })
}

for (const [name, change] of Object.entries({
  'generic approve': { callbackData: 'approve' },
  'teach edit': { callbackData: 'teach_edit' },
  'another tapper': { tapperUserId: 'visitor' },
  'empty owner': { ownerUserId: '' },
  'empty tapper': { tapperUserId: '' },
  'not posted': { posted: false },
})) {
  test(`teach window refuses ${name}`, () => {
    const windows = api().createTeachWindows()
    windows.noteTap({ ...tap, ...change })
    assert.equal(windows.take('chat', 101), null)
  })
}

test('teach window expires after fifteen minutes', () => {
  const { createTeachWindows, TEACH_APPROVE, TEACH_WINDOW_MS } = api()
  assert.equal(TEACH_APPROVE, 'teach_approve')
  assert.equal(TEACH_WINDOW_MS, 15 * 60_000)
  const windows = createTeachWindows()
  windows.noteTap(tap)
  assert.deepEqual(windows.take('chat', 100 + TEACH_WINDOW_MS), { by: 'owner' })
  windows.noteTap(tap)
  assert.equal(windows.take('chat', 101 + TEACH_WINDOW_MS), null)
  assert.equal(windows.take('chat', 101), null)
})

test('skill write accepts only the immediate agent skill folder', () => {
  const { skillFolderOfWrite } = api()
  const w = world()
  assert.equal(skillFolderOfWrite(join(w.folder, 'SKILL.md'), w.agent), 'foo')
  assert.equal(skillFolderOfWrite(join(w.folder, 'SKILL.md'), null), null)
  assert.equal(skillFolderOfWrite(join(w.folder, 'notes.md'), w.agent), null)
  mkdirSync(join(w.folder, 'nested'))
  writeFileSync(join(w.folder, 'nested', 'SKILL.md'), '')
  assert.equal(skillFolderOfWrite(join(w.folder, 'nested', 'SKILL.md'), w.agent), null)
})

test('skill write refuses the computer skills folder and bad names', () => {
  const { skillFolderOfWrite } = api()
  const w = world()
  const computer = join(w.root, 'home', '.claude', 'skills', 'foo')
  const bad = join(w.agent, '.claude', 'skills', 'Bad_Name')
  for (const folder of [computer, bad]) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), '')
    assert.equal(skillFolderOfWrite(join(folder, 'SKILL.md'), w.agent), null)
  }
})

test('skill write compares real paths and refuses a linked skill folder', () => {
  const { skillFolderOfWrite } = api()
  const w = world()
  const alias = join(w.root, 'agent-alias')
  linkFolder(w.agent, alias)
  assert.equal(skillFolderOfWrite(join(w.folder, 'SKILL.md'), alias), 'foo')
  const linked = join(w.agent, '.claude', 'skills', 'linked')
  linkFolder(w.folder, linked)
  assert.equal(skillFolderOfWrite(join(linked, 'SKILL.md'), w.agent), null)
})

test('skill write refuses a skills parent redirected to another tree', () => {
  const { skillFolderOfWrite } = api()
  const w = world()
  const other = join(w.root, 'other-agent')
  mkdirSync(join(other, '.claude'), { recursive: true })
  linkFolder(join(w.agent, '.claude', 'skills'), join(other, '.claude', 'skills'))
  assert.equal(skillFolderOfWrite(join(other, '.claude', 'skills', 'foo', 'SKILL.md'), other), null)
})

for (const [scope, expected] of Object.entries({ agent: 'taught', repo: 'repo', computer: undefined, synced: 'synced', plugin: 'installed', managed: 'installed' })) {
  test(`origin table for ${scope} preserves scope facts and requires a matching agent stamp`, () => {
    const { originForRow } = api()
    const item = row('unused', scope as SkillScope)
    const stamp = { origin: 'taught' as const, ident: '1:2', at: 100 }
    assert.equal(originForRow(item, stamp, '1:2'), expected)
    const unstamped = scope === 'agent' ? undefined : expected
    assert.equal(originForRow(item, undefined, '1:2'), unstamped)
    assert.equal(originForRow(item, stamp, '1:3'), unstamped)
    assert.equal(originForRow(item, stamp, null), unstamped)
  })
}

test('stamps survive a fresh read outside the skill folder without changing its bytes', () => {
  const { stampOrigin, readOrigins, applyOrigins } = api()
  const w = world()
  const before = readFileSync(join(w.folder, 'SKILL.md'))
  const ident = identOf(w.folder, false)
  assert.ok(ident)
  stampOrigin(w.file, 'foo', { origin: 'shared', ident, offerId: 'offer' }, 123)
  stampOrigin(w.file, 'second', { origin: 'taught', ident }, 124)
  assert.deepEqual(readOrigins(w.file), { v: 1, skills: {
    foo: { origin: 'shared', at: 123, ident, offerId: 'offer' },
    second: { origin: 'taught', at: 124, ident },
  } })
  assert.deepEqual(readdirSync(join(w.root, 'state')), ['skill-origins.json'])
  assert.deepEqual(readdirSync(w.folder), ['SKILL.md'])
  assert.deepEqual(readFileSync(join(w.folder, 'SKILL.md')), before)
  const input = { skills: [row(w.folder)] }
  assert.deepEqual(applyOrigins(input, w.file).skills[0], { ...input.skills[0], origin: 'shared' })
  assert.equal(input.skills[0]?.origin, undefined)
})

test('deleting and recreating a folder invalidates its stamp', () => {
  const { stampOrigin, applyOrigins } = api()
  const w = world()
  const ident = identOf(w.folder, false)
  assert.ok(ident)
  stampOrigin(w.file, 'foo', { origin: 'taught', ident }, 123)
  unlinkSync(join(w.folder, 'SKILL.md'))
  rmdirSync(w.folder)
  mkdirSync(join(w.root, 'occupy-released-folder-number'))
  mkdirSync(w.folder)
  assert.notEqual(identOf(w.folder, false), ident)
  assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file).skills[0]?.origin, undefined)
})

test('missing and corrupt stamps and hand copied agent skills have no origin', () => {
  const { readOrigins, applyOrigins } = api()
  const w = world()
  assert.deepEqual(readOrigins(w.file), { v: 1, skills: {} })
  const input = { skills: [row(w.folder)], omitted: [{ scope: 'repo' as const, reason: 'no_launch_cwd' as const }] }
  assert.deepEqual(applyOrigins(input, w.file), input)
  mkdirSync(join(w.root, 'state'))
  for (const data of ['{broken', '{"v":2,"skills":{}}', '{"v":1,"skills":{"foo":{"origin":"invented","ident":"1:2"}}}']) {
    writeFileSync(w.file, data)
    assert.deepEqual(readOrigins(w.file), { v: 1, skills: {} })
    assert.deepEqual(applyOrigins(input, w.file), input)
  }
})

test('origin lookup resolves displayed home paths before reading folder identity', () => {
  const { stampOrigin, applyOrigins } = api()
  const w = world()
  stampOrigin(w.file, 'foo', { origin: 'taught', ident: '1:2' }, 123)
  const seen: string[] = []
  const fs = { statSync: () => { throw new Error('must not follow') }, lstatSync: (path: string) => { seen.push(path); return { dev: 1n, ino: 2n } } }
  assert.equal(applyOrigins({ skills: [row('~/.claude/skills/foo')] }, w.file, fs).skills[0]?.origin, 'taught')
  assert.deepEqual(seen, [join(homedir(), '.claude', 'skills', 'foo')])
})

test('origin filesystem errors never escape', () => {
  const { stampOrigin, skillFolderOfWrite, applyOrigins } = api()
  const w = world()
  assert.doesNotThrow(() => stampOrigin(join(w.folder, 'SKILL.md', 'origins.json'), 'foo', { origin: 'taught', ident: '1:2' }, 123))
  assert.equal(skillFolderOfWrite(join(w.root, 'missing', 'SKILL.md'), w.agent), null)
  const fs = { statSync: () => { throw new Error('unavailable') }, lstatSync: () => { throw new Error('unavailable') } }
  assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file, fs).skills[0]?.origin, undefined)
})
