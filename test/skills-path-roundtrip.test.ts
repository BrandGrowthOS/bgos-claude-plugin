/**
 * A skill row's path round trips through the backend (skills view review,
 * findings 10 and 11): the plugin shows a path with only ITS home folded,
 * the backend then folds any user's home prefix (redactHomePath, twinned as
 * backendFoldedPath), and the app sends that form back. read_skill,
 * write_skill and Remove must each take it for the same row.
 *
 * The backend only folds a real home prefix (/Users/<x>, /home/<x>, /root,
 * <drive>:\Users\<x>), so these fixtures live in a temp folder under the
 * account's own home folder, with the daemon's home injected elsewhere: an
 * agent folder outside the daemon's home (the /Users/Shared/proj shape), and
 * a daemon whose home is root's or the system profile, its project in a
 * user's home. The cases skip where the account's home is not such a prefix.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { sha256Hex } from '../lib/skill-share-content-rules.ts'
import { backendFoldedPath, listSkills, removeAgentSkill } from '../lib/skills-inventory.ts'
import { readSkillFile, writeAgentSkill } from '../lib/skills-edit.ts'

const SKILL = '---\nname: agent-skill\ndescription: Does the agent thing.\n---\nBody text.\n'
const EDITED = '---\nname: agent-skill\ndescription: Does the agent thing, better.\n---\nA new body.\n'
const HOME_PREFIX = 'skills-roundtrip-'
const foldable = backendFoldedPath(homedir()) !== homedir()
const noFold = foldable ? false : 'this account has no home folder the backend folds (/Users, /home, /root or <drive>:\\Users)'
const notWindows = process.platform === 'win32' ? false : 'a drive letter is a Windows path'

const made: string[] = []

/** An agent folder in a repo under the account's home, the daemon's state in the temp folder. */
function fixture(agentSpelling: (agent: string) => string = (a) => a) {
  const base = realpathSync(mkdtempSync(join(homedir(), `.hoai-${HOME_PREFIX}`)))
  const state = realpathSync(mkdtempSync(join(tmpdir(), HOME_PREFIX)))
  made.push(base, state)
  const repo = join(base, 'proj')
  const agent = join(repo, 'agent')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(agent, '.claude', 'skills', 'agent-skill'), { recursive: true })
  writeFileSync(join(agent, '.claude', 'skills', 'agent-skill', 'SKILL.md'), SKILL)
  const config = join(state, '.claude-work')
  mkdirSync(join(config, 'skills'), { recursive: true })
  return {
    agentDir: agentSpelling(agent),
    md: join(agent, '.claude', 'skills', 'agent-skill', 'SKILL.md'),
    folder: join(agent, '.claude', 'skills', 'agent-skill'),
    configDir: config,
    managedDir: join(state, 'managed'),
    trashDir: join(state, 'trash'),
    removeTrash: join(base, 'trash'),
    state,
  }
}

type Fixture = ReturnType<typeof fixture>

/** The path the app sends back: the plugin's row path, folded as the backend folds it. */
function sentBack(f: Fixture, home: string): { name: string; path: string; shown: string } {
  const row = listSkills({ agentDir: f.agentDir, configDir: f.configDir, home, managedDir: f.managedDir }).skills.find(
    (r) => r.scope === 'agent' && r.name === 'agent-skill',
  )
  assert.ok(row, 'the agent row is listed')
  return { name: row.name, path: backendFoldedPath(row.path), shown: row.path }
}

function roundTrip(f: Fixture, home: string) {
  const { name, path } = sentBack(f, home)
  assert.match(path, /^~/, 'the app holds a folded path')

  const read = readSkillFile({ agentDir: f.agentDir, configDir: f.configDir, home, managedDir: f.managedDir, payload: { name, scope: 'agent', path } })
  assert.equal(read.ok, true, `read: ${JSON.stringify(read)}`)
  if (!read.ok) return
  assert.equal(read.payload.path, path, 'the answer names the path asked for')
  assert.equal(read.payload.content, SKILL)
  assert.equal(read.payload.editable, true, JSON.stringify(read.payload))

  const write = writeAgentSkill({
    agentDir: f.agentDir,
    configDir: f.configDir,
    home,
    managedDir: f.managedDir,
    trashDir: f.trashDir,
    now: () => 1_700_000_000_000,
    platform: process.platform,
    payload: { name, scope: 'agent', path, content: EDITED, expectSha256: sha256Hex(SKILL) },
  })
  assert.equal(write.ok, true, `write: ${JSON.stringify(write)}`)
  assert.equal(readFileSync(f.md, 'utf8'), EDITED)

  const removed = removeAgentSkill({
    agentDir: f.agentDir,
    configDir: f.configDir,
    home,
    managedDir: f.managedDir,
    // on the agent folder's drive: Remove moves, it never copies
    trashDir: f.removeTrash,
    now: () => 1_700_000_000_000,
    payload: { name, scope: 'agent', path },
  })
  assert.equal(removed.ok, true, `remove: ${JSON.stringify(removed)}`)
  assert.equal(existsSync(f.folder), false)
}

test('an agent folder outside the daemon home: read, write and Remove take the path the backend folded', { skip: noFold }, () => {
  const f = fixture()
  const home = join(f.state, 'daemon-home')
  mkdirSync(home)
  roundTrip(f, home)
})

test('a root daemon, its project in a user home: read, write and Remove take the path the backend folded', { skip: noFold }, () => {
  const f = fixture()
  roundTrip(f, process.platform === 'win32' ? 'C:\\Windows\\System32\\config\\systemprofile' : '/root')
})

test('an agent folder spelled with a lowercase drive letter round trips', { skip: notWindows || noFold }, () => {
  const lower = (p: string) => p.charAt(0).toLowerCase() + p.slice(1)
  const f = fixture(lower)
  assert.match(f.agentDir, /^[a-z]:\\/)
  const { shown } = sentBack(f, homedir())
  // the daemon's own fold now takes it: the backend has nothing left to fold
  assert.match(shown, /^~\//, shown)
  roundTrip(f, homedir())
})

test('write and Remove each take the folded path on their own, with no read first', { skip: noFold }, () => {
  const answers: Record<string, unknown> = {}
  for (const op of ['write', 'remove'] as const) {
    const f = fixture()
    const home = join(f.state, 'daemon-home')
    mkdirSync(home)
    const { name, path } = sentBack(f, home)
    const base = { agentDir: f.agentDir, configDir: f.configDir, home, managedDir: f.managedDir, now: () => 1 }
    answers[op] =
      op === 'write'
        ? writeAgentSkill({
            ...base,
            trashDir: f.trashDir,
            platform: process.platform,
            payload: { name, scope: 'agent', path, content: EDITED, expectSha256: sha256Hex(SKILL) },
          })
        : removeAgentSkill({ ...base, trashDir: f.removeTrash, payload: { name, scope: 'agent', path } })
  }
  const codes = Object.fromEntries(
    Object.entries(answers).map(([op, a]) => [op, (a as { ok: boolean }).ok ? 'ok' : (a as { code: string }).code]),
  )
  assert.deepEqual(codes, { write: 'ok', remove: 'ok' })
})

test('a request for a sibling outside the agent skills folder is still refused', { skip: noFold }, () => {
  const f = fixture()
  const home = join(f.state, 'daemon-home')
  mkdirSync(home)
  const { name, path } = sentBack(f, home)
  // the folded path one folder up, and one naming the skills folder itself
  const others = [path.replace(/[\\/]agent-skill$/, ''), path.replace(/([\\/])\.claude[\\/]skills[\\/]/, '$1.claude$1')]
  for (const other of others) {
    assert.notEqual(other, path)
    const answer = writeAgentSkill({
      agentDir: f.agentDir,
      configDir: f.configDir,
      home,
      managedDir: f.managedDir,
      trashDir: f.trashDir,
      now: () => 1,
      platform: process.platform,
      payload: { name, scope: 'agent', path: other, content: EDITED, expectSha256: sha256Hex(SKILL) },
    })
    assert.equal(answer.ok, false, other)
  }
  assert.equal(readFileSync(f.md, 'utf8'), SKILL)
})

test.after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
