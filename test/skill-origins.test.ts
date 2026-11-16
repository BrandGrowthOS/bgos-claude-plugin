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

const tap = { chatId: 'chat', assistantId: 'assistant', tapperUserId: 'owner', ownerUserId: 'owner', callbackData: 'teach_approve', customText: undefined as unknown, humanPrincipal: true as unknown, posted: true, now: 100 }

for (const callbackData of ['teach_approve', 'u:teach_approve']) {
  test(`teach window accepts owner posted ${callbackData}, once in the same chat`, () => {
    const windows = api().createTeachWindows()
    windows.noteTap({ ...tap, callbackData })
    assert.equal(windows.take('other-chat', 'assistant', 101), null)
    assert.deepEqual(windows.take('chat', 'assistant', 101), { by: 'owner' })
    assert.equal(windows.take('chat', 'assistant', 102), null)
  })
}

test('teach window is keyed by chat plus assistant', () => {
  const windows = api().createTeachWindows()
  windows.noteTap(tap)
  assert.equal(windows.take('chat', 'other-assistant', 101), null)
  assert.equal(windows.take('chat', '', 101), null)
  assert.deepEqual(windows.take('chat', 'assistant', 101), { by: 'owner' })
  windows.noteTap({ ...tap, assistantId: '' })
  assert.equal(windows.take('chat', '', 101), null)
})

test('a pairing or API key click with the owner id and no humanPrincipal stays unmarked', () => {
  const windows = api().createTeachWindows()
  const { humanPrincipal: _dropped, ...credentialClick } = tap
  windows.noteTap(credentialClick)
  assert.equal(windows.take('chat', 'assistant', 101), null)
})

for (const humanPrincipal of [false, 1, 'true', 'True', null, {}, [true]]) {
  test(`teach window refuses humanPrincipal ${JSON.stringify(humanPrincipal)}`, () => {
    const windows = api().createTeachWindows()
    windows.noteTap({ ...tap, humanPrincipal })
    assert.equal(windows.take('chat', 'assistant', 101), null)
  })
}

for (const [name, change] of Object.entries({
  'typed words with the approve value': { customText: 'yes, teach it' },
  'typed words that are not a string': { customText: 0 },
  'a Custom reply': { callbackData: '__custom__', customText: 'teach_approve' },
})) {
  test(`teach window refuses ${name}`, () => {
    const windows = api().createTeachWindows()
    windows.noteTap({ ...tap, ...change })
    assert.equal(windows.take('chat', 'assistant', 101), null)
  })
}

test('teach window opens with empty typed words, as ownerTapOpens reads them', () => {
  for (const customText of [undefined, null, '']) {
    const windows = api().createTeachWindows()
    windows.noteTap({ ...tap, customText })
    assert.deepEqual(windows.take('chat', 'assistant', 101), { by: 'owner' }, JSON.stringify(customText))
  }
})

test('the click reader returns the raw humanPrincipal field and nothing else', () => {
  const { clickHumanPrincipal } = api()
  assert.equal(clickHumanPrincipal({ humanPrincipal: true }), true)
  assert.equal(clickHumanPrincipal({ humanPrincipal: 'true' }), 'true')
  assert.equal(clickHumanPrincipal({ human_principal: true }), undefined)
  assert.equal(clickHumanPrincipal({ HumanPrincipal: true }), undefined)
  for (const payload of [null, undefined, 'humanPrincipal', true]) assert.equal(clickHumanPrincipal(payload), undefined)
})

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
    assert.equal(windows.take('chat', 'assistant', 101), null)
  })
}

test('teach window expires after fifteen minutes', () => {
  const { createTeachWindows, TEACH_APPROVE, TEACH_WINDOW_MS } = api()
  assert.equal(TEACH_APPROVE, 'teach_approve')
  assert.equal(TEACH_WINDOW_MS, 15 * 60_000)
  const windows = createTeachWindows()
  windows.noteTap(tap)
  assert.deepEqual(windows.take('chat', 'assistant', 100 + TEACH_WINDOW_MS), { by: 'owner' })
  windows.noteTap(tap)
  assert.equal(windows.take('chat', 'assistant', 101 + TEACH_WINDOW_MS), null)
  assert.equal(windows.take('chat', 'assistant', 101), null)
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

function writeOf(w: ReturnType<typeof world>, windows: unknown, writtenAt: number, extra: Record<string, unknown> = {}) {
  return api().stampTaughtWrite({ filePath: join(w.folder, 'SKILL.md'), agentDir: w.agent, file: w.file, windows, chatId: 'chat', assistantId: 'assistant', writtenAt, ...extra })
}

test('a SKILL.md written before the Approve never reads taught, even when its line drains after it', () => {
  const { createTeachWindows, applyOrigins } = api()
  const w = world()
  const windows = createTeachWindows()
  windows.noteTap(tap)
  assert.equal(writeOf(w, windows, 99), false, 'the line drains after the tap, but the write came first')
  assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file).skills[0]?.origin, undefined)
  assert.equal(writeOf(w, windows, 101), true, 'the earlier write left the window for the write the owner approved')
  assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file).skills[0]?.origin, 'taught')
})

test('a taught write needs the window of its own chat and assistant, and takes it once', () => {
  const { createTeachWindows, applyOrigins } = api()
  const w = world()
  const windows = createTeachWindows()
  windows.noteTap(tap)
  assert.equal(writeOf(w, windows, 101, { chatId: 'other-chat' }), false)
  assert.equal(writeOf(w, windows, 101, { assistantId: 'other-assistant' }), false)
  assert.equal(writeOf(w, windows, 101, { filePath: join(w.folder, 'notes.md') }), false)
  assert.equal(writeOf(w, windows, 101, { agentDir: null }), false)
  assert.equal(writeOf(w, windows, 101), true)
  assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file).skills[0]?.origin, 'taught')
  assert.equal(windows.take('chat', 'assistant', 102), null, 'the stamp consumed the window')
})

test('a write to a skill already stamped for this folder leaves the window open', () => {
  const { createTeachWindows, stampOrigin } = api()
  const w = world()
  const ident = identOf(w.folder, false)
  assert.ok(ident)
  stampOrigin(w.file, 'foo', { origin: 'shared', ident }, 50)
  const windows = createTeachWindows()
  windows.noteTap(tap)
  assert.equal(writeOf(w, windows, 101), false)
  assert.deepEqual(windows.take('chat', 'assistant', 102), { by: 'owner' })
})

test('a skill write with unknown identity consumes the teach window before another write', () => {
  const { createTeachWindows, readOrigins } = api()
  const w = world()
  const windows = createTeachWindows()
  windows.noteTap(tap)
  const unknown = { statSync: () => { throw new Error('unavailable') }, lstatSync: () => { throw new Error('unavailable') } }
  assert.equal(writeOf(w, windows, 101, { identFs: unknown }), false)
  assert.equal(writeOf(w, windows, 102), false, 'a later write must not inherit the consumed approval')
  assert.deepEqual(readOrigins(w.file), { v: 1, skills: {} })
  windows.noteTap({ ...tap, now: 200 })
  assert.equal(writeOf(w, windows, 201), true)
})

test('a taught write never throws', () => {
  const w = world()
  const windows = { take: () => { throw new Error('broken') } }
  assert.doesNotThrow(() => assert.equal(writeOf(w, windows, 101), false))
})
