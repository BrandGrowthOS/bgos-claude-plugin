import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SkillItem, SkillScope } from '../lib/skills-inventory.ts'
import { scratchDir } from './helpers/scratch-dirs.ts'
import { createTurnChatTracker } from '../lib/turn-chat.ts'
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

const WRONG = [false, 1, 'true', 'True', null, {}, [true], 0]

test('a click is human only when its row or live click event says exactly true at the top level', () => {
  const { isHumanClick } = api()
  assert.equal(isHumanClick({ humanPrincipal: true }), true, 'a top-level row field, or a live click event')
  assert.equal(isHumanClick({ humanPrincipal: true, answerPayload: { callbackData: 'teach_approve' } }), true, 'beside the answer payload')
  assert.equal(isHumanClick({ humanPrincipal: true, answerPayload: { humanPrincipal: false } }), true, 'the top level decides')
  for (const value of WRONG) {
    assert.equal(isHumanClick({ humanPrincipal: value }), false, `row ${JSON.stringify(value)}`)
    assert.equal(isHumanClick({ humanPrincipal: value, answerPayload: { humanPrincipal: true } }), false, `row ${JSON.stringify(value)}, payload true`)
  }
  assert.equal(isHumanClick({}), false, 'absent')
  assert.equal(isHumanClick({ answerPayload: { humanPrincipal: true } }), false, 'never read inside the answer payload')
  assert.equal(isHumanClick({ answer_payload: { humanPrincipal: true } }), false, 'nor the snake case payload')
  assert.equal(isHumanClick({ answeredByPerson: true, answerPayload: { answeredByPerson: true } }), false, 'the card alias is not the canon field')
  assert.equal(isHumanClick({ human_principal: true, HumanPrincipal: true, humanprincipal: true }), false, 'camelCase only')
  for (const row of [null, undefined, 'humanPrincipal', true, 1]) assert.equal(isHumanClick(row), false, JSON.stringify(row))
})

test('the human click reader never throws', () => {
  const { isHumanClick } = api()
  const hostile = { get humanPrincipal() { throw new Error('boom') } }
  assert.doesNotThrow(() => assert.equal(isHumanClick(hostile), false))
})

test('a teach window opens when the click row says human at the top level, and nothing else opens one', () => {
  const { createTeachWindows, isHumanClick } = api()
  const rows: Array<[unknown, boolean]> = [
    [{ humanPrincipal: true }, true],
    [{ humanPrincipal: true, answerPayload: {} }, true],
    [{ answerPayload: { humanPrincipal: true } }, false],
    [{}, false],
    ...WRONG.map((value): [unknown, boolean] => [{ humanPrincipal: value }, false]),
  ]
  for (const [row, opens] of rows) {
    const windows = createTeachWindows()
    windows.noteTap({ ...tap, humanPrincipal: isHumanClick(row) })
    assert.equal(windows.take('chat', 'assistant', 101) !== null, opens, JSON.stringify(row))
  }
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
  const ident = api().originIdentOf(w.folder)
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

test('deleting and recreating a folder invalidates its stamp', async () => {
  const { stampOrigin, applyOrigins, originIdentOf } = api()
  const w = world()
  const ident = originIdentOf(w.folder)
  assert.ok(ident)
  stampOrigin(w.file, 'foo', { origin: 'taught', ident }, 123)
  unlinkSync(join(w.folder, 'SKILL.md'))
  rmdirSync(w.folder)
  // Made again a moment later, as by hand: past the filesystem's clock tick, so its birth time is its own.
  await new Promise((done) => setTimeout(done, 50))
  mkdirSync(w.folder)
  assert.notEqual(originIdentOf(w.folder), ident)
  assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file).skills[0]?.origin, undefined)
})

function bornFs(born: bigint | undefined) {
  const stat = { dev: 1n, ino: 2n, ...(born === undefined ? {} : { birthtimeNs: born }) }
  return { statSync: () => { throw new Error('must not follow') }, lstatSync: () => stat }
}

test('a folder made again with a reused file number but a new birth time loses its stamp', () => {
  const { stampOrigin, applyOrigins, originIdentOf } = api()
  const w = world()
  const ident = originIdentOf(w.folder, bornFs(1000n))
  assert.equal(ident, '1:2:1000')
  stampOrigin(w.file, 'foo', { origin: 'taught', ident: ident! }, 123)
  assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file, bornFs(1000n)).skills[0]?.origin, 'taught', 'control: the same folder')
  assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file, bornFs(2000n)).skills[0]?.origin, undefined, 'ext4: same dev:ino, new birth')
})

test('folder identity without a birth time is the file number alone', () => {
  const { originIdentOf } = api()
  assert.equal(originIdentOf('x', bornFs(undefined)), '1:2')
  assert.equal(originIdentOf('x', bornFs(0n)), '1:2', 'a zero birth time is none')
  assert.equal(originIdentOf('x', { statSync: () => { throw new Error('no') }, lstatSync: () => ({ dev: 0n, ino: 2n }) }), null)
  assert.equal(originIdentOf('x', { statSync: () => { throw new Error('no') }, lstatSync: () => ({ dev: 1n, ino: 0n }) }), null)
  assert.equal(originIdentOf('x', { statSync: () => { throw new Error('no') }, lstatSync: () => { throw new Error('gone') } }), null)
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

type Take = { take: (chatId: string, assistantId: string, now: number) => { by: string } | null }

function writeOf(w: ReturnType<typeof world>, windows: Take, writtenAt: number, extra: Record<string, unknown> = {}) {
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

test('a write to a stamped folder uses the window, so a new folder write after it stays unmarked', () => {
  const { createTeachWindows, stampOrigin, applyOrigins } = api()
  const w = world()
  const ident = api().originIdentOf(w.folder)
  assert.ok(ident)
  stampOrigin(w.file, 'foo', { origin: 'shared', ident }, 50)
  const windows = createTeachWindows()
  windows.noteTap(tap)
  assert.equal(writeOf(w, windows, 101), false, 'a re-teach of a stamped skill stamps nothing new')
  const other = newSkill(w, 'helper')
  assert.equal(useOf(w, windows, 102, 'Write', { file_path: join(other, 'SKILL.md') }), false)
  assert.equal(applyOrigins({ skills: [row(other)] }, w.file).skills[0]?.origin, undefined)
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

const marksWithBadEntries = JSON.stringify({ v: 1, skills: {
  foo: { origin: 'taught', at: 10, ident: '1:2' },
  later: { origin: 'learned-later', at: 11, ident: '1:3' },
  'Bad_Name': { origin: 'taught', at: 12, ident: '1:4' },
  empty: null,
  noident: { origin: 'shared', at: 13, ident: '' },
  offer: { origin: 'shared', at: 14, ident: '1:5', offerId: 7 },
  kept: { origin: 'shared', at: 15, ident: '1:6', offerId: 'offer' },
} })

test('one bad entry in the marks file is skipped, never voids the file', () => {
  const { readOrigins } = api()
  const w = world()
  mkdirSync(join(w.root, 'state'))
  writeFileSync(w.file, marksWithBadEntries)
  assert.deepEqual(readOrigins(w.file), { v: 1, skills: {
    foo: { origin: 'taught', at: 10, ident: '1:2' },
    kept: { origin: 'shared', at: 15, ident: '1:6', offerId: 'offer' },
  } })
})

test('a later stamp keeps every other mark, the ones this build cannot read included', () => {
  const { readOrigins, stampOrigin } = api()
  const w = world()
  mkdirSync(join(w.root, 'state'))
  writeFileSync(w.file, marksWithBadEntries)
  stampOrigin(w.file, 'second', { origin: 'taught', ident: '2:2' }, 20)
  assert.deepEqual(readOrigins(w.file), { v: 1, skills: {
    foo: { origin: 'taught', at: 10, ident: '1:2' },
    kept: { origin: 'shared', at: 15, ident: '1:6', offerId: 'offer' },
    second: { origin: 'taught', at: 20, ident: '2:2' },
  } })
  const raw = JSON.parse(readFileSync(w.file, 'utf8'))
  assert.deepEqual(raw.skills.later, { origin: 'learned-later', at: 11, ident: '1:3' }, 'a newer build\'s mark survives a downgrade')
  assert.equal('Bad_Name' in raw.skills, false, 'an entry no build could name is dropped')
  assert.equal('empty' in raw.skills, false, 'an entry that is not an object is dropped')
})

test('teach window refuses a take on a clock set back before the tap, and keeps the window', () => {
  const { createTeachWindows, TEACH_WINDOW_MS } = api()
  const windows = createTeachWindows()
  windows.noteTap({ ...tap, now: 10 * TEACH_WINDOW_MS })
  assert.equal(windows.take('chat', 'assistant', 10 * TEACH_WINDOW_MS - 1), null)
  assert.equal(windows.take('chat', 'assistant', 2 * TEACH_WINDOW_MS), null, 'far back is refused too')
  assert.deepEqual(windows.take('chat', 'assistant', 10 * TEACH_WINDOW_MS + 1), { by: 'owner' })
})

for (const [name, id] of Object.entries({ 'both empty': '', 'both blank': '  ' })) {
  test(`teach window refuses an owner and tapper that are ${name}`, () => {
    const windows = api().createTeachWindows()
    windows.noteTap({ ...tap, ownerUserId: id, tapperUserId: id })
    assert.equal(windows.take('chat', 'assistant', 101), null)
  })
}

const skill = (agent: string) => join(agent, '.claude', 'skills', 'foo')

function driveFs(agentReal: string, folderReal: string) {
  return {
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    realpathSync: (path: string) => path === 'agent-dir' ? agentReal : folderReal,
  } as unknown as Parameters<typeof import('../lib/skill-origins.ts').skillFolderOfWrite>[2]
}

test('on Windows the skill folder compare ignores only the drive letter case', () => {
  const { skillFolderOfWrite } = api()
  const write = 'x/foo/SKILL.md'
  assert.equal(skillFolderOfWrite(write, 'agent-dir', driveFs('c:/agent', skill('C:/agent')), 'win32'), 'foo')
  assert.equal(skillFolderOfWrite(write, 'agent-dir', driveFs('E:/agent', skill('e:/agent')), 'win32'), 'foo')
  assert.equal(skillFolderOfWrite(write, 'agent-dir', driveFs('c:/agent', skill('c:/agent')), 'win32'), 'foo', 'control: same case')
})

test('the skill folder compare fails closed on any other difference', () => {
  const { skillFolderOfWrite } = api()
  const write = 'x/foo/SKILL.md'
  assert.equal(skillFolderOfWrite(write, 'agent-dir', driveFs('c:/agent', skill('C:/agent')), 'linux'), null, 'not Windows')
  assert.equal(skillFolderOfWrite(write, 'agent-dir', driveFs('c:/agent', skill('C:/Agent')), 'win32'), null, 'case beyond the drive letter')
  assert.equal(skillFolderOfWrite(write, 'agent-dir', driveFs('c:/agent', skill('D:/agent')), 'win32'), null, 'another drive')
  assert.equal(skillFolderOfWrite(write, 'agent-dir', driveFs('//server/agent', skill('//Server/agent')), 'win32'), null, 'no drive letter')
  assert.equal(skillFolderOfWrite(write, 'agent-dir', driveFs('k:/agent', '\u212a' + skill('k:/agent').slice(1)), 'win32'), null, 'a sign that lowercases to a drive letter')
})

test('origin errors go to the daemon log, one line each, never to the console', (t) => {
  const { logOriginsTo, readOrigins, stampOrigin, skillFolderOfWrite } = api()
  const w = world()
  const lines: string[] = []
  const consoleLines: unknown[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { consoleLines.push(args) })
  logOriginsTo((msg: string) => { lines.push(msg) })
  t.after(() => logOriginsTo(() => {}))
  mkdirSync(join(w.root, 'state'))
  writeFileSync(w.file, '{broken')
  readOrigins(w.file)
  stampOrigin(join(w.folder, 'SKILL.md', 'origins.json'), 'foo', { origin: 'taught', ident: '1:2' }, 123)
  skillFolderOfWrite(join(w.root, 'missing', 'SKILL.md'), w.agent)
  assert.deepEqual(lines, ['skills: origin unavailable', 'skills: origin unavailable', 'skills: origin unavailable'])
  assert.deepEqual(consoleLines, [])
  logOriginsTo(() => { throw new Error('log down') })
  assert.doesNotThrow(() => readOrigins(w.file))
})

for (const [name, data] of Object.entries({
  'bad JSON': '{"v":1,"skills":{"foo":{"origin":"taught","at":10,"ident":"1:2"}',
  'a newer file version': '{"v":2,"skills":{"foo":{"origin":"taught","at":10,"ident":"1:2"}}}',
  'a skills list that is not an object': '{"v":1,"skills":[]}',
})) {
  test(`a stamp never overwrites a marks file it cannot read: ${name}`, (t) => {
    const { logOriginsTo, stampOrigin } = api()
    const w = world()
    const lines: string[] = []
    logOriginsTo((msg: string) => { lines.push(msg) })
    t.after(() => logOriginsTo(() => {}))
    mkdirSync(join(w.root, 'state'))
    writeFileSync(w.file, data)
    stampOrigin(w.file, 'second', { origin: 'taught', ident: '2:2' }, 20)
    assert.equal(readFileSync(w.file, 'utf8'), data, 'the file is left as it was')
    assert.deepEqual(readdirSync(join(w.root, 'state')), ['skill-origins.json'], 'no temp file is left')
    assert.deepEqual(lines, ['skills: origin unavailable'])
  })
}

test('a stamp never overwrites a marks file whose read fails', (t) => {
  const { logOriginsTo, stampOrigin } = api()
  const w = world()
  const lines: string[] = []
  logOriginsTo((msg: string) => { lines.push(msg) })
  t.after(() => logOriginsTo(() => {}))
  mkdirSync(join(w.file, 'inside'), { recursive: true })
  stampOrigin(w.file, 'second', { origin: 'taught', ident: '2:2' }, 20)
  assert.deepEqual(readdirSync(w.file), ['inside'], 'the unreadable path is left as it was')
  assert.deepEqual(readdirSync(join(w.root, 'state')), ['skill-origins.json'], 'no temp file is left')
  assert.equal(lines.length, 1)
})

test('a signed-in teammate is a person too, and still opens no teach window', () => {
  const { createTeachWindows, isHumanClick } = api()
  const windows = createTeachWindows()
  windows.noteTap({ ...tap, tapperUserId: 'teammate', humanPrincipal: isHumanClick({ humanPrincipal: true }) })
  assert.equal(windows.take('chat', 'assistant', 101), null)
})

test('a watch or notification reply says false and opens no teach window', () => {
  const { createTeachWindows, isHumanClick } = api()
  const windows = createTeachWindows()
  windows.noteTap({ ...tap, humanPrincipal: isHumanClick({ humanPrincipal: false, answerPayload: { callbackData: 'teach_approve' } }) })
  assert.equal(windows.take('chat', 'assistant', 101), null)
})

function newSkill(w: ReturnType<typeof world>, name: string): string {
  const folder = join(w.agent, '.claude', 'skills', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: A skill.\n---\n`)
  return folder
}

function useOf(w: ReturnType<typeof world>, windows: Take, writtenAt: number, toolName: unknown, toolInput: unknown) {
  return api().noteSkillToolUse({ toolName, toolInput, agentDir: w.agent, file: w.file, windows, chatId: 'chat', assistantId: 'assistant', writtenAt })
}

for (const [toolName, toolInput] of [
  ['Edit', (w: ReturnType<typeof world>) => ({ file_path: join(w.folder, 'SKILL.md'), old_string: 'a', new_string: 'b' })],
  ['MultiEdit', (w: ReturnType<typeof world>) => ({ file_path: join(w.folder, 'SKILL.md'), edits: [] })],
  ['NotebookEdit', (w: ReturnType<typeof world>) => ({ notebook_path: join(w.folder, 'notes.ipynb') })],
  ['Write', (w: ReturnType<typeof world>) => ({ file_path: join(w.folder, 'notes.md') })],
  ['Write', (w: ReturnType<typeof world>) => ({ file_path: join(w.folder, 'nested', 'SKILL.md') })],
  ['Write', (w: ReturnType<typeof world>) => ({ file_path: join(w.agent, '.claude', 'skills', 'Bad_Name', 'SKILL.md') })],
  ['Bash', () => ({ command: "cat > .claude/skills/foo/SKILL.md <<'EOF'" })],
  ['Bash', () => ({ command: 'cp -r /tmp/x .claude\\skills\\foo' })],
  ['Bash', (w: ReturnType<typeof world>) => ({ command: `rm -rf ${join(w.agent, '.claude', 'skills', 'foo')}` })],
] as const) {
  test(`${toolName} into the agent skills folder uses the window: ${JSON.stringify(toolInput(world())).slice(0, 60)}`, () => {
    const { createTeachWindows, applyOrigins } = api()
    const w = world()
    const windows = createTeachWindows()
    windows.noteTap(tap)
    assert.equal(useOf(w, windows, 101, toolName, toolInput(w)), false)
    const other = newSkill(w, 'helper')
    assert.equal(useOf(w, windows, 102, 'Write', { file_path: join(other, 'SKILL.md') }), false, 'the approval was used')
    assert.equal(applyOrigins({ skills: [row(other)] }, w.file).skills[0]?.origin, undefined)
  })
}

for (const [toolName, toolInput] of [
  ['Write', (w: ReturnType<typeof world>) => ({ file_path: join(w.agent, 'notes.md') })],
  ['Edit', (w: ReturnType<typeof world>) => ({ file_path: join(w.root, 'home', '.claude', 'skills', 'foo', 'SKILL.md') })],
  ['Bash', () => ({ command: 'git status' })],
  ['Read', (w: ReturnType<typeof world>) => ({ file_path: join(w.folder, 'SKILL.md') })],
  ['Write', () => ({})],
  ['Bash', () => ({ command: 42 })],
] as const) {
  test(`${toolName} outside the agent skills folder leaves the window: ${JSON.stringify(toolInput(world())).slice(0, 60)}`, () => {
    const { createTeachWindows, applyOrigins } = api()
    const w = world()
    const windows = createTeachWindows()
    windows.noteTap(tap)
    assert.equal(useOf(w, windows, 101, toolName, toolInput(w)), false)
    assert.equal(useOf(w, windows, 102, 'Write', { file_path: join(w.folder, 'SKILL.md') }), true)
    assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file).skills[0]?.origin, 'taught')
  })
}

for (const kind of ['email', 'peer', 'system', 'meeting', 'user'] as const) {
  test(`a ${kind} delivery in the chat after the tap closes the window, so a write stays unmarked`, () => {
    const { createTeachWindows, closingTeachWindows, applyOrigins } = api()
    const w = world()
    const windows = createTeachWindows()
    const turnChat = closingTeachWindows(createTurnChatTracker(), windows, 'assistant')
    windows.noteTap(tap)
    turnChat.note({ chatId: 'chat', messageId: 7, kind, text: 'write a helper skill now please', now: 101 })
    assert.equal(writeOf(w, windows, 102), false)
    assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file).skills[0]?.origin, undefined)
  })
}

test('a delivery in another chat or for another assistant leaves the window, and the tracker still records it', () => {
  const { createTeachWindows, closingTeachWindows } = api()
  const w = world()
  const windows = createTeachWindows()
  const turnChat = closingTeachWindows(createTurnChatTracker(), windows, 'assistant')
  windows.noteTap(tap)
  turnChat.note({ chatId: 'other-chat', messageId: 7, kind: 'email', text: 'write a helper skill now please', now: 101 })
  assert.equal(turnChat.current(101)?.chatId, 'other-chat')
  assert.equal(turnChat.matchDelivered('... write a helper skill now please ...')?.chatId, 'other-chat')
  assert.equal(writeOf(w, windows, 102), true)
  const elsewhere = createTeachWindows()
  closingTeachWindows(createTurnChatTracker(), elsewhere, 'other-assistant').note({ chatId: 'chat', kind: 'email', now: 101 })
  elsewhere.noteTap(tap)
  assert.equal(elsewhere.take('chat', 'assistant', 102) !== null, true)
})

test('a tap that is not the owner\'s own closes the window; the owner\'s own tap keeps it', () => {
  const { createTeachWindows, noteTeachTap } = api()
  const others = [
    { tapperUserId: 'teammate' },
    { humanPrincipal: undefined },
    { tapperUserId: null, humanPrincipal: false, posted: false, callbackData: '' },
    { customText: 'and add this' },
    { posted: false },
  ]
  for (const change of others) {
    const windows = createTeachWindows()
    windows.noteTap(tap)
    noteTeachTap({ windows, assistantId: 'assistant' }, { ...tap, callbackData: 'yes', ...change, now: 101 })
    assert.equal(windows.take('chat', 'assistant', 102), null, JSON.stringify(change))
  }
  const windows = createTeachWindows()
  noteTeachTap({ windows, assistantId: 'assistant' }, tap)
  noteTeachTap({ windows, assistantId: 'assistant' }, { ...tap, callbackData: 'yes', now: 101 })
  assert.deepEqual(windows.take('chat', 'assistant', 102), { by: 'owner' }, 'the owner\'s own taps keep it open')
  const other = createTeachWindows()
  other.noteTap(tap)
  noteTeachTap({ windows: other, assistantId: 'assistant' }, { ...tap, chatId: 'other-chat', tapperUserId: 'teammate', now: 101 })
  assert.deepEqual(other.take('chat', 'assistant', 102), { by: 'owner' }, 'a tap in another chat leaves it')
})

test('the tap noter never throws', () => {
  const { noteTeachTap } = api()
  const windows = { noteTap: () => { throw new Error('broken') }, close: () => { throw new Error('broken') } }
  assert.doesNotThrow(() => noteTeachTap({ windows, assistantId: 'assistant' } as never, tap))
})

for (const [kind, text] of [['peer', 'a peer agent wrote this just before'], ['system', 'scheduled wake: check the inbox now']] as const) {
  test(`the write after a tap is filed under the tapped chat, even when a ${kind} message arrived just before`, () => {
    const { createTeachWindows, closingTeachWindows, noteTeachTap, applyOrigins } = api()
    const w = world()
    const windows = createTeachWindows()
    const turnChat = closingTeachWindows(createTurnChatTracker(), windows, 'assistant')
    turnChat.note({ chatId: 'other-chat', messageId: 4, kind, text, now: 99 })
    noteTeachTap({ windows, assistantId: 'assistant', deliveries: turnChat }, { ...tap, messageId: 5 })
    // The tap's prompt carries no delivered text of another chat, so the turn takes the last delivery: the tap.
    turnChat.beginTurn({ chatId: turnChat.matchDelivered('[button_clicked] Clicked: Approve')?.chatId ?? null, now: 101 })
    const chatId = String(turnChat.current(101)?.chatId ?? '')
    assert.equal(chatId, 'chat')
    assert.equal(api().noteSkillToolUse({ toolName: 'Write', toolInput: { file_path: join(w.folder, 'SKILL.md') }, agentDir: w.agent, file: w.file, windows, chatId, assistantId: 'assistant', writtenAt: 102 }), true)
    assert.equal(applyOrigins({ skills: [row(w.folder)] }, w.file).skills[0]?.origin, 'taught')
  })
}

test('a tap is noted as its chat\'s delivery with its message, and adds no delivered text', () => {
  const { createTeachWindows, closingTeachWindows, noteTeachTap } = api()
  const windows = createTeachWindows()
  const turnChat = closingTeachWindows(createTurnChatTracker(), windows, 'assistant')
  noteTeachTap({ windows, assistantId: 'assistant', deliveries: turnChat }, { ...tap, tapperUserId: 'teammate', chatId: 'team-chat', messageId: 9 })
  assert.deepEqual(turnChat.current(101), { chatId: 'team-chat', messageId: 9, at: 100, kind: 'user' })
  assert.equal(turnChat.matchDelivered('[button_clicked] Clicked: teach_approve (in reply to message_id=9)'), null)
  noteTeachTap({ windows, assistantId: 'assistant', deliveries: turnChat }, { ...tap, messageId: 'not a number' })
  assert.deepEqual(turnChat.current(101), { chatId: 'chat', messageId: null, at: 100, kind: 'user' })
  assert.deepEqual(windows.take('chat', 'assistant', 101), { by: 'owner' }, 'the owner\'s own tap note keeps its window')
})

test('a clock set back never keeps a window open past fifteen minutes from the tap', () => {
  const { createTeachWindows, TEACH_WINDOW_MS } = api()
  let elapsed = 0
  const windows = createTeachWindows({ monotonic: () => elapsed })
  windows.noteTap({ ...tap, now: 10 * TEACH_WINDOW_MS })
  elapsed = TEACH_WINDOW_MS + 1
  assert.equal(windows.take('chat', 'assistant', 5 * TEACH_WINDOW_MS), null, 'the wall clock went back five windows')
  assert.equal(windows.take('chat', 'assistant', 10 * TEACH_WINDOW_MS + 1), null, 'and the window is gone')
})

test('a window inside fifteen minutes of the tap still opens after a clock set back and forward', () => {
  const { createTeachWindows, TEACH_WINDOW_MS } = api()
  let elapsed = 0
  const windows = createTeachWindows({ monotonic: () => elapsed })
  windows.noteTap({ ...tap, now: 10 * TEACH_WINDOW_MS })
  elapsed = TEACH_WINDOW_MS
  assert.equal(windows.take('chat', 'assistant', 5 * TEACH_WINDOW_MS), null, 'still refused as a write from before the tap')
  assert.deepEqual(windows.take('chat', 'assistant', 10 * TEACH_WINDOW_MS + 1), { by: 'owner' })
})
