/**
 * Preview and edit a skill (skills view plan, decision 8, the Claude Code
 * part): read_skill answers a listed SKILL.md whole, for any scope the list
 * shows, and write_skill saves an agent scope SKILL.md in place.
 *
 * Every case runs on a REAL fixture tree in a temp folder, with a fake home,
 * because the rules under test are file system rules (a link where a folder
 * or a file should be, a hard link, a swap between the checks and the rename)
 * and a faked fs would only test the fake. A write that escaped the agent
 * scope would land somewhere this test can see.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sha256Hex } from '../lib/skill-share-content-rules.ts'
import { SKILLS_ROOT_MAX, SKILL_DISPLAY_PATH_PATTERN, listSkills } from '../lib/skills-inventory.ts'
import {
  SKILL_READ_MAX_BYTES,
  SKILL_WRITE_MAX_BYTES,
  readSkillFile,
  writeAgentSkill,
} from '../lib/skills-edit.ts'
import { exportSkill } from '../lib/skills-share.ts'
import { fileSymlinkRefused, linkFolder } from './helpers/links.ts'

const LEAK = 'LEAKED-FILE-CONTENT-must-never-be-read'
const AWS = 'AKIAIOSFODNN7EXAMPLQ'
const TEMP_MARK = '.SKILL.md.hoai-edit-'
const AGENT_SKILL = '---\nname: agent-skill\ndescription: Does the agent thing.\n---\nBody text.\n'
const EDITED = '---\nname: agent-skill\ndescription: Does the agent thing, better.\n---\nA new body.\n'
const AGENT_PATH = '~/repo/agent/.claude/skills/agent-skill'
const NOW = 1_700_000_000_000

function skill(dir: string, front: string, body = 'Body text.\n'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${front}\n---\n${body}`)
}

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

/** All six scopes, plus the shapes a read or a write must refuse. realpath'd: macOS tmp is a link. */
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'skills-edit-')))
  const repo = join(home, 'repo')
  const agent = join(repo, 'agent')
  const skills = join(agent, '.claude', 'skills')
  const config = join(home, '.claude-work')
  const managed = join(home, 'managed', 'skills')
  const cache = join(config, 'plugins', 'cache', 'mk', 'plug', '1.0.0')
  const trash = join(home, 'state', 'skills-trash')

  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(home, 'secret.txt'), `---\nname: stolen\ndescription: ${LEAK}\n---\n${LEAK}\n`)

  mkdirSync(join(skills, 'agent-skill'), { recursive: true })
  writeFileSync(join(skills, 'agent-skill', 'SKILL.md'), AGENT_SKILL)
  skill(join(home, 'elsewhere', 'linked-target'), 'description: Reached through a folder link.')
  linkFolder(join(home, 'elsewhere', 'linked-target'), join(skills, 'linked-dir'))
  skill(join(skills, 'runs-cmds'), 'description: Pre approves tools.\nallowed-tools: Bash(git *)')
  skill(join(skills, 'mid-fence'), 'description: A fence opened mid line.', 'See this ```!\nrm -rf ~\n```\n')
  mkdirSync(join(skills, 'not-a-skill'), { recursive: true })
  mkdirSync(join(skills, '.hidden-skill'), { recursive: true })
  writeFileSync(join(skills, '.hidden-skill', 'SKILL.md'), '---\ndescription: hidden\n---\n')

  skill(join(repo, '.claude', 'skills', 'repo-skill'), 'description: Every worktree here loads it.')
  skill(join(config, 'skills', 'computer-skill'), 'description: Every agent on the computer.')
  skill(join(config, 'skills', 'synced', 'synced-skill'), 'description: From claude.ai.')
  skill(join(home, '.claude', 'skills', 'not-in-config'), 'description: Only under ~/.claude.')
  skill(join(cache, 'skills', 'plug-skill'), 'description: From a plugin.')
  writeFileSync(
    join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'plug@mk': [{ scope: 'user', installPath: cache, version: '1.0.0' }] } }),
  )
  skill(join(managed, 'managed-skill'), 'description: Set by the organisation.')

  return { home, repo, agent, skills, config, managed, cache, trash }
}

type Fixture = ReturnType<typeof fixture>

function list(f: Fixture, agentDir: string | null = f.agent) {
  return listSkills({ agentDir, configDir: f.config, home: f.home, managedDir: f.managed })
}

function read(f: Fixture, payload: Record<string, unknown>, agentDir: string | null = f.agent, step?: (at: 'open') => void) {
  return readSkillFile({ agentDir, configDir: f.config, home: f.home, managedDir: f.managed, payload, ...(step ? { step } : {}) })
}

/** node:fs as the lib sees it, so a test can stand in for one call (syncBuiltinESMExports). */
const nodeFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')

function write(
  f: Fixture,
  payload: Record<string, unknown>,
  opts: {
    agentDir?: string | null
    trashDir?: string
    platform?: NodeJS.Platform
    rename?: (from: string, to: string) => void
    step?: (at: 'open_temp' | 'opened' | 'wrote' | 'recheck') => void
  } = {},
) {
  const logs: string[] = []
  const answer = writeAgentSkill({
    agentDir: opts.agentDir === undefined ? f.agent : opts.agentDir,
    configDir: f.config,
    home: f.home,
    managedDir: f.managed,
    trashDir: opts.trashDir ?? f.trash,
    now: () => NOW,
    platform: opts.platform ?? process.platform,
    payload,
    ...(opts.rename ? { rename: opts.rename } : {}),
    ...(opts.step ? { step: opts.step } : {}),
    log: (m) => logs.push(m),
  })
  return { answer, logs }
}

function edit(content: string, extra: Record<string, unknown> = {}) {
  return { name: 'agent-skill', scope: 'agent', path: AGENT_PATH, content, expectSha256: sha256Hex(AGENT_SKILL), ...extra }
}

/** Temp files an edit left in a folder; none may ever stay. */
function temps(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(TEMP_MARK)) : []
}

function trashed(f: Fixture): string[] {
  return existsSync(f.trash) ? readdirSync(f.trash).sort() : []
}

function codeOf(answer: { ok: true } | { ok: false; code: string }): string {
  return answer.ok ? 'ok' : answer.code
}

// ── read_skill ──────────────────────────────────────────────────────────────

test('read answers a listed skill of every scope, whole, hashed over its bytes', () => {
  const f = fixture()
  const rows = list(f).skills
  const want: Record<string, string> = {
    agent: 'agent-skill',
    repo: 'repo-skill',
    computer: 'computer-skill',
    synced: 'synced-skill',
    plugin: 'plug:plug-skill',
    managed: 'managed-skill',
  }
  for (const [scope, name] of Object.entries(want)) {
    const row = rows.find((r) => r.scope === scope && r.name === name)
    assert.ok(row, `${scope} row listed`)
    const answer = read(f, { name: row.name, scope: row.scope, path: row.path })
    assert.equal(answer.ok, true, `${scope}: ${JSON.stringify(answer)}`)
    if (!answer.ok) continue
    const p = answer.payload
    assert.equal(p.scope, scope)
    assert.equal(p.path, row.path)
    assert.equal(p.name, name)
    assert.equal(typeof p.content, 'string')
    assert.equal(p.withheld, undefined)
    assert.equal(p.sha256, sha256Hex(p.content!))
    assert.equal(p.bytes, Buffer.byteLength(p.content!))
    assert.match(p.modifiedAt, /^\d{4}-\d{2}-\d{2}T/)
    if (scope === 'agent') {
      assert.equal(p.content, AGENT_SKILL)
      assert.equal(p.sha256, sha(readFileSync(join(f.skills, 'agent-skill', 'SKILL.md'))))
      assert.equal(p.editable, true)
      assert.equal(p.editBlock, undefined)
    } else {
      assert.equal(p.editable, false, scope)
      assert.equal(p.editBlock, 'scope', scope)
    }
  }
})

test('read answers not_found for anything the list does not show', () => {
  const f = fixture()
  const cases: Array<Record<string, unknown>> = [
    { name: 'hidden-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/.hidden-skill' },
    { name: 'not-a-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/not-a-skill' },
    // the right path under the wrong scope, and the right row under the wrong name
    { name: 'agent-skill', scope: 'repo', path: AGENT_PATH },
    { name: 'other-name', scope: 'agent', path: AGENT_PATH },
    // a spelling of the path the list never shows
    { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/x/../agent-skill' },
    // ~/.claude/skills is replaced by the config dir, so it is not listed
    { name: 'not-in-config', scope: 'computer', path: '~/.claude/skills/not-in-config' },
    { name: 'secret', scope: 'computer', path: '~/secret.txt' },
  ]
  for (const payload of cases) {
    const answer = read(f, payload)
    assert.equal(codeOf(answer), 'not_found', JSON.stringify(payload))
    assert.ok(!JSON.stringify(answer).includes(LEAK))
  }
  // with no launch folder there is no agent row to read
  assert.equal(codeOf(read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH }, null)), 'not_found')
})

test('read refuses a payload that is not a read: bad_request', () => {
  const f = fixture()
  for (const payload of [
    { name: 'agent-skill', scope: 'nope', path: AGENT_PATH },
    { name: 'agent-skill', scope: 'agent', path: 42 },
    { name: 'agent-skill', scope: 'agent', path: `${AGENT_PATH}\u0000x` },
    { name: 'agent-skill', scope: 'agent', path: '~/' + 'a'.repeat(1100) },
    { scope: 'agent', path: AGENT_PATH },
    { name: '', scope: 'agent', path: AGENT_PATH },
    { name: 'a\nb', scope: 'agent', path: AGENT_PATH },
  ]) {
    assert.equal(codeOf(read(f, payload)), 'bad_request', JSON.stringify(payload).slice(0, 80))
  }
})

test('a hard linked SKILL.md is never read', () => {
  const f = fixture()
  mkdirSync(join(f.skills, 'hard-linked'))
  linkSync(join(f.home, 'secret.txt'), join(f.skills, 'hard-linked', 'SKILL.md'))
  const answer = read(f, { name: 'hard-linked', scope: 'agent', path: '~/repo/agent/.claude/skills/hard-linked' })
  assert.equal(codeOf(answer), 'not_found')
  assert.ok(!JSON.stringify(answer).includes(LEAK))
  // and under the name the file itself carries
  assert.ok(!JSON.stringify(read(f, { name: 'stolen', scope: 'agent', path: '~/repo/agent/.claude/skills/hard-linked' })).includes(LEAK))
})

test('a SKILL.md link that leaves its skill folder is never read', { skip: fileSymlinkRefused }, () => {
  const f = fixture()
  mkdirSync(join(f.skills, 'escaper'))
  symlinkSync(join(f.home, 'secret.txt'), join(f.skills, 'escaper', 'SKILL.md'))
  for (const name of ['escaper', 'stolen']) {
    const answer = read(f, { name, scope: 'agent', path: '~/repo/agent/.claude/skills/escaper' })
    assert.equal(codeOf(answer), 'not_found')
    assert.ok(!JSON.stringify(answer).includes(LEAK))
  }
})

test('a SKILL.md swapped for a file link between the checks and the open is never read', { skip: fileSymlinkRefused }, () => {
  const f = fixture()
  const md = join(f.skills, 'agent-skill', 'SKILL.md')
  const steps: string[] = []
  const answer = read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH }, f.agent, (at) => {
    steps.push(at)
    renameSync(md, join(f.home, 'moved-aside.md'))
    symlinkSync(join(f.home, 'secret.txt'), md, 'file')
  })
  assert.deepEqual(steps, ['open'])
  assert.equal(codeOf(answer), 'read_failed')
  assert.ok(!JSON.stringify(answer).includes(LEAK))
})

test('a SKILL.md opened through a link where no O_NOFOLLOW exists (win32) is never read', (t) => {
  // Windows has no O_NOFOLLOW, so the open and a following stat both reach a
  // link's target. Simulated on every platform through the fs the lib
  // imports: from the open on, SKILL.md opens and stats as the secret file,
  // while lstat still sees what sits at the path itself, as a link's own
  // lstat would. A check against a following stat matches and leaks.
  const f = fixture()
  const md = join(f.skills, 'agent-skill', 'SKILL.md')
  const secret = join(f.home, 'secret.txt')
  const real = { openSync: nodeFs.openSync, statSync: nodeFs.statSync }
  const restore = () => {
    ;(nodeFs as any).openSync = real.openSync
    ;(nodeFs as any).statSync = real.statSync
    syncBuiltinESMExports()
  }
  t.after(restore)
  const steps: string[] = []
  const answer = read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH }, f.agent, (at) => {
    steps.push(at)
    ;(nodeFs as any).openSync = (path: any, ...rest: any[]) => (real.openSync as any)(path === md ? secret : path, ...rest)
    ;(nodeFs as any).statSync = (path: any, ...rest: any[]) => (real.statSync as any)(path === md ? secret : path, ...rest)
    syncBuiltinESMExports()
  })
  restore()
  assert.deepEqual(steps, ['open'])
  assert.equal(codeOf(answer), 'read_failed')
  assert.ok(!JSON.stringify(answer).includes(LEAK))
  // and with nothing standing in, the same read answers the file
  const plain = read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH })
  assert.ok(plain.ok)
  assert.equal(plain.payload.content, AGENT_SKILL)
})

test('a link followed at the open (win32) and a hard link put at SKILL.md after the fstat is never read', (t) => {
  // The open follows a link to the secret file, readHead's fstat sees a
  // single link file, and only then is a hard link to that file put at
  // SKILL.md, so the no-follow lstat after the open finds a regular file
  // with the opened identity. Its link count is what gives it away.
  const f = fixture()
  const md = join(f.skills, 'agent-skill', 'SKILL.md')
  const secret = join(f.home, 'secret.txt')
  const real = { openSync: nodeFs.openSync, fstatSync: nodeFs.fstatSync }
  const restore = () => {
    ;(nodeFs as any).openSync = real.openSync
    ;(nodeFs as any).fstatSync = real.fstatSync
    syncBuiltinESMExports()
  }
  t.after(restore)
  let swapped = false
  const answer = read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH }, f.agent, () => {
    ;(nodeFs as any).openSync = (path: any, ...rest: any[]) => (real.openSync as any)(path === md ? secret : path, ...rest)
    ;(nodeFs as any).fstatSync = (fd: any, ...rest: any[]) => {
      const st = (real.fstatSync as any)(fd, ...rest)
      if (!swapped) {
        swapped = true
        renameSync(md, join(f.home, 'moved-aside.md'))
        linkSync(secret, md)
      }
      return st
    }
    syncBuiltinESMExports()
  })
  restore()
  assert.ok(swapped)
  assert.equal(codeOf(answer), 'read_failed')
  assert.ok(!JSON.stringify(answer).includes(LEAK))
})

test('a SKILL.md link repointed between the checks and the open is never read', { skip: fileSymlinkRefused }, () => {
  // The path the list names is the lexical <skill>/SKILL.md; once it no
  // longer leads to the file opened, the read is not of the listed file.
  const f = fixture()
  const dir = join(f.skills, 'md-link')
  mkdirSync(dir)
  writeFileSync(join(dir, 'real.md'), '---\nname: md-link\ndescription: Linked file.\n---\n')
  symlinkSync(join(dir, 'real.md'), join(dir, 'SKILL.md'), 'file')
  const payload = { name: 'md-link', scope: 'agent', path: '~/repo/agent/.claude/skills/md-link' }
  assert.ok(read(f, payload).ok, 'a link inside its folder reads, preview only')
  const answer = read(f, payload, f.agent, () => {
    rmSync(join(dir, 'SKILL.md'))
    symlinkSync(join(f.home, 'secret.txt'), join(dir, 'SKILL.md'), 'file')
  })
  assert.equal(codeOf(answer), 'read_failed')
  assert.ok(!JSON.stringify(answer).includes(LEAK))
})

test('a file too large, binary or holding a secret is withheld whole, never cut', () => {
  const f = fixture()
  const big = `---\nname: big\ndescription: Big.\n---\n${'a'.repeat(SKILL_READ_MAX_BYTES)}\n`
  skill(join(f.skills, 'big'), 'name: big\ndescription: Big.', `${'a'.repeat(SKILL_READ_MAX_BYTES)}\n`)
  const binary = Buffer.concat([Buffer.from('---\nname: bin\ndescription: Bin.\n---\n'), Buffer.from([0xff, 0xfe, 0x41])])
  mkdirSync(join(f.skills, 'bin'))
  writeFileSync(join(f.skills, 'bin', 'SKILL.md'), binary)
  skill(join(f.skills, 'nul'), 'name: nul\ndescription: Nul.', 'a\u0000b\n')
  skill(join(f.skills, 'leaky'), 'name: leaky\ndescription: Calls the API.', `key ${AWS}\n`)

  const cases: Array<[string, 'too_large' | 'binary' | 'secret', Buffer]> = [
    ['big', 'too_large', Buffer.from(big)],
    ['bin', 'binary', binary],
    ['nul', 'binary', readFileSync(join(f.skills, 'nul', 'SKILL.md'))],
    ['leaky', 'secret', readFileSync(join(f.skills, 'leaky', 'SKILL.md'))],
  ]
  for (const [name, why, bytes] of cases) {
    const answer = read(f, { name, scope: 'agent', path: `~/repo/agent/.claude/skills/${name}` })
    assert.equal(answer.ok, true, name)
    if (!answer.ok) continue
    assert.equal(answer.payload.withheld, why, name)
    assert.equal('content' in answer.payload, false, name)
    // past the cap nothing more is read, so a too large file carries no hash at all
    if (why === 'too_large') assert.equal('sha256' in answer.payload, false, name)
    else assert.equal(answer.payload.sha256, sha(bytes), name)
    assert.equal(answer.payload.bytes, bytes.length, name)
    assert.equal(answer.payload.editable, false, name)
    assert.equal(answer.payload.editBlock, why, name)
    assert.ok(!JSON.stringify(answer).includes(AWS))
  }
})

test('editable is false for a linked folder, a skill that runs commands, and one past 64 KiB', () => {
  const f = fixture()
  skill(join(f.skills, 'roomy'), 'name: roomy\ndescription: Roomy.', `${'b'.repeat(SKILL_WRITE_MAX_BYTES)}\n`)
  skill(join(f.skills, 'inline-cmd'), 'name: inline-cmd\ndescription: Inline.', 'Run !`date` now.\n')
  const cases: Array<[string, string]> = [
    ['linked-dir', 'linked'],
    ['runs-cmds', 'runs_commands'],
    ['mid-fence', 'runs_commands'],
    ['inline-cmd', 'runs_commands'],
    ['roomy', 'too_large'],
  ]
  for (const [name, block] of cases) {
    const answer = read(f, { name, scope: 'agent', path: `~/repo/agent/.claude/skills/${name}` })
    assert.equal(answer.ok, true, name)
    if (!answer.ok) continue
    // the preview still shows the text; only Edit is withheld
    assert.equal(typeof answer.payload.content, 'string', name)
    assert.equal(answer.payload.editable, false, name)
    assert.equal(answer.payload.editBlock, block, name)
  }
})

test('editable is false when the agent skills folder is a link', () => {
  const f = fixture()
  const agent = join(f.home, 'agent-linked-skills')
  skill(join(f.home, 'real-skills', 'via-link'), 'name: via-link\ndescription: Through a linked skills folder.')
  mkdirSync(join(agent, '.claude'), { recursive: true })
  linkFolder(join(f.home, 'real-skills'), join(agent, '.claude', 'skills'))
  const answer = read(f, { name: 'via-link', scope: 'agent', path: '~/agent-linked-skills/.claude/skills/via-link' }, agent)
  assert.equal(answer.ok, true, JSON.stringify(answer))
  if (!answer.ok) return
  assert.equal(answer.payload.editable, false)
  assert.equal(answer.payload.editBlock, 'linked')
})

test('read takes any listed name up to 200 characters, a plugin row past 128 too', () => {
  const f = fixture()
  const long = 'l'.repeat(128)
  skill(join(f.cache, 'skills', 'long-name'), `name: ${long}\ndescription: A long plugin skill name.`)
  skill(join(f.config, 'skills', 'brief-writer'), "name: Brief Writer (v2) & co's\ndescription: A display name.")
  const rows = list(f).skills
  for (const name of [`plug:${long}`, "Brief Writer (v2) & co's"]) {
    const row = rows.find((r) => r.name === name)
    assert.ok(row, name)
    const answer = read(f, { name: row.name, scope: row.scope, path: row.path })
    assert.equal(answer.ok, true, `${name.slice(0, 20)}: ${JSON.stringify(answer).slice(0, 200)}`)
    if (answer.ok) assert.equal(typeof answer.payload.content, 'string')
  }
  // past 200, or a control character: not a name the list can carry
  for (const name of ['n'.repeat(201), 'a\u007fb', 'a\tb']) {
    assert.equal(codeOf(read(f, { name, scope: 'agent', path: AGENT_PATH })), 'bad_request', JSON.stringify(name).slice(0, 30))
  }
})

test('editable is false, editBlock invalid, when the frontmatter name the backend reads is not the listed name', () => {
  const f = fixture()
  // the backend reads `Name:` as the name (any case, - and _ ignored); Claude Code and the list do not
  skill(join(f.skills, 'cased'), 'Name: Other\ndescription: Cased key.')
  skill(join(f.skills, 'na-me'), 'NA_ME: other\ndescription: Underscored key.')
  for (const name of ['cased', 'na-me']) {
    const row = list(f).skills.find((r) => r.scope === 'agent' && r.path.endsWith(`/${name}`))
    assert.equal(row?.name, name)
    const answer = read(f, { name, scope: 'agent', path: row!.path })
    assert.equal(answer.ok, true, name)
    if (!answer.ok) continue
    assert.equal(typeof answer.payload.content, 'string', name)
    assert.equal(answer.payload.editable, false, name)
    assert.equal(answer.payload.editBlock, 'invalid', name)
  }
})

test('a frontmatter closed on the last line with no newline is read as the backend reads it', () => {
  const f = fixture()
  const text = '---\nname: other\ndescription: d\n---'
  mkdirSync(join(f.skills, 'nonl'))
  writeFileSync(join(f.skills, 'nonl', 'SKILL.md'), text)
  const row = list(f).skills.find((r) => r.scope === 'agent' && r.path.endsWith('/nonl'))
  // the name in the block, as the backend's frontmatterNameOf reads it, not the folder's
  assert.equal(row?.name, 'other')
  const answer = read(f, { name: 'other', scope: 'agent', path: row!.path })
  assert.equal(answer.ok, true, JSON.stringify(answer))
  if (!answer.ok) return
  assert.equal(answer.payload.editable, true, JSON.stringify(answer.payload))
  const next = '---\nname: other\ndescription: e\n---'
  const saved = write(f, { name: 'other', scope: 'agent', path: row!.path, content: next, expectSha256: answer.payload.sha256 }).answer
  assert.equal(codeOf(saved), 'ok', JSON.stringify(saved))
  assert.equal(readFileSync(join(f.skills, 'nonl', 'SKILL.md'), 'utf8'), next)
})

test('read walks only the root its path names, and only that entry in it', () => {
  const f = fixture()
  // A hard linked SKILL.md in every root, one beside the agent skill too: the
  // list logs each one it skips, so a read that walked a root, or another
  // entry of its own root, would log it as well.
  const hard = [
    join(f.skills, 'a-hard'),
    join(f.repo, '.claude', 'skills', 'a-hard'),
    join(f.config, 'skills', 'a-hard'),
    join(f.config, 'skills', 'synced', 'a-hard'),
    join(f.cache, 'skills', 'a-hard'),
    join(f.managed, 'a-hard'),
  ]
  for (const dir of hard) {
    mkdirSync(dir)
    linkSync(join(f.home, 'secret.txt'), join(dir, 'SKILL.md'))
  }
  const listLogs: string[] = []
  const rows = listSkills({ agentDir: f.agent, configDir: f.config, home: f.home, managedDir: f.managed, log: (m) => listLogs.push(m) }).skills
  assert.equal(listLogs.filter((l) => /hard link/.test(l)).length, hard.length, listLogs.join('\n'))
  const scopes = new Set(rows.map((r) => r.scope))
  assert.deepEqual([...scopes].sort(), ['agent', 'computer', 'managed', 'plugin', 'repo', 'synced'])
  for (const row of rows) {
    const logs: string[] = []
    const answer = readSkillFile({
      agentDir: f.agent,
      configDir: f.config,
      home: f.home,
      managedDir: f.managed,
      payload: { name: row.name, scope: row.scope, path: row.path },
      log: (m) => logs.push(m),
    })
    assert.equal(answer.ok, true, `${row.scope} ${row.path}: ${JSON.stringify(answer).slice(0, 200)}`)
    assert.deepEqual(logs, [], `${row.scope} ${row.path}`)
  }
})

test('read answers exactly the rows the list shows: a second link to one skill, the skipped synced folder, an entry past the root cap', () => {
  const f = fixture()
  // sorted after the skill it leads to: the list skips it as already seen
  linkFolder(join(f.skills, 'agent-skill'), join(f.skills, 'z-alias'))
  // sorted before: the list shows the link and skips the skill it leads to
  linkFolder(join(f.skills, 'runs-cmds'), join(f.skills, 'a-alias'))
  for (let i = 0; i < SKILLS_ROOT_MAX; i++) mkdirSync(join(f.config, 'skills', `f${String(i).padStart(3, '0')}`))
  skill(join(f.config, 'skills', 'zz-past-cap'), 'description: Past the cap.')
  const rows = list(f).skills
  assert.ok(!rows.some((r) => r.path.endsWith('/z-alias')))
  assert.ok(rows.some((r) => r.path.endsWith('/a-alias')))
  assert.ok(!rows.some((r) => r.path.endsWith('/runs-cmds')))
  assert.ok(!rows.some((r) => r.name === 'zz-past-cap'))
  const payloads: Array<{ name: string; scope: string; path: string }> = [
    ...rows.map((r) => ({ name: r.name, scope: r.scope, path: r.path })),
    { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/z-alias' },
    { name: 'z-alias', scope: 'agent', path: '~/repo/agent/.claude/skills/z-alias' },
    { name: 'runs-cmds', scope: 'agent', path: '~/repo/agent/.claude/skills/runs-cmds' },
    { name: 'zz-past-cap', scope: 'computer', path: '~/.claude-work/skills/zz-past-cap' },
    { name: 'synced', scope: 'computer', path: '~/.claude-work/skills/synced' },
    { name: 'synced-skill', scope: 'computer', path: '~/.claude-work/skills/synced/synced-skill' },
    { name: 'plug-skill', scope: 'plugin', path: rows.find((r) => r.name === 'plug:plug-skill')!.path },
  ]
  for (const p of payloads) {
    const listed = rows.some((r) => r.scope === p.scope && r.path === p.path && r.name === p.name)
    const answer = read(f, p)
    assert.equal(answer.ok, listed, `${JSON.stringify(p)}: ${JSON.stringify(answer).slice(0, 160)}`)
    if (!listed) assert.equal(codeOf(answer), 'not_found', JSON.stringify(p))
  }
})

/** Earlier sorted links to 'tidy' whose names the list skips (a DEL, a trailing dot, a trailing space). */
const SKIPPED_LINKS = ['a\u007f', 'a.', 'a ']

test(
  'read answers exactly the rows the list shows: an earlier link the list skips on its name claims nothing',
  { skip: folderNamesTaken(SKIPPED_LINKS) ?? false },
  () => {
    for (const link of SKIPPED_LINKS) {
      const f = fixture()
      skill(join(f.config, 'skills', 'tidy'), 'description: The clean tidy, no name key.')
      // sorted before 'tidy' and leading to it, but skipped on its name: the
      // list shows 'tidy', so read must answer that row too
      linkFolder(join(f.config, 'skills', 'tidy'), join(f.config, 'skills', link))
      assert.ok(readdirSync(join(f.config, 'skills')).includes(link), `the fs kept ${JSON.stringify(link)}`)
      const rows = list(f).skills.filter((r) => r.scope === 'computer' && r.name === 'tidy')
      assert.deepEqual(rows.map((r) => r.path), ['~/.claude-work/skills/tidy'], JSON.stringify(link))
      const answer = read(f, { name: 'tidy', scope: 'computer', path: '~/.claude-work/skills/tidy' })
      assert.equal(answer.ok, true, `${JSON.stringify(link)}: ${JSON.stringify(answer).slice(0, 160)}`)
      if (answer.ok) assert.equal(answer.payload.content, '---\ndescription: The clean tidy, no name key.\n---\nBody text.\n')
    }
  },
)

test('a name with a C1 or bidi control is listed cleaned, and read refuses a name that carries one', () => {
  const f = fixture()
  skill(join(f.config, 'skills', 'arabic-writer'), 'name: \u0643\u0627\u062a\u0628\u200f\ndescription: Writes in Arabic.\u200f')
  skill(join(f.config, 'skills', 'overridden'), 'name: x\u202ey\ndescription: An override inside.')
  skill(join(f.config, 'skills', 'c-one'), 'name: a\u0085b\u061cc\u2066d\u200ee\u009ff\ndescription: C1 and marks.')
  // the plugin half of a plugin row's name comes from installed_plugins.json, not from a frontmatter
  const bidiCache = join(f.config, 'plugins', 'cache', 'mk', 'bidi', '1.0.0')
  skill(join(bidiCache, 'skills', 'bidi-skill'), 'description: From a plugin whose id holds a mark.')
  writeFileSync(
    join(f.config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'plug@mk': [{ scope: 'user', installPath: f.cache, version: '1.0.0' }],
        'bi\u200fdi\u202e@mk': [{ scope: 'user', installPath: bidiCache, version: '1.0.0' }],
      },
    }),
  )
  const rows = list(f).skills
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
  const want: Array<[string, string]> = [
    ['arabic-writer', '\u0643\u0627\u062a\u0628'],
    ['overridden', 'x y'],
    ['c-one', 'a b c d e f'],
    ['bidi-skill', 'bi di:bidi-skill'],
  ]
  for (const [folder, name] of want) {
    const row = rows.find((r) => r.path.endsWith(`/${folder}`))
    assert.equal(row?.name, name, folder)
    const answer = read(f, { name: row!.name, scope: row!.scope, path: row!.path })
    assert.equal(answer.ok, true, `${folder}: ${JSON.stringify(answer).slice(0, 160)}`)
  }
  assert.deepEqual(rows.filter((r) => CONTROL.test(r.name) || CONTROL.test(r.description)).map((r) => r.path), [])
  for (const name of ['\u0643\u0627\u062a\u0628\u200f', 'x\u202ey', 'a\u0085b', 'a\u061cb', 'a\u2066b', 'a\u2069b', 'a\u200eb', 'a\u009fb', 'a\u202ab']) {
    const answer = read(f, { name, scope: 'computer', path: '~/.claude-work/skills/arabic-writer' })
    assert.equal(codeOf(answer), 'bad_request', JSON.stringify(name))
  }
})

/** Folder names a file system takes: null when it refuses one (then the case skips). */
function folderNamesTaken(names: string[]): string | null {
  const probe = realpathSync(mkdtempSync(join(tmpdir(), 'skills-edit-names-')))
  try {
    for (const n of names) mkdirSync(join(probe, n))
    for (const n of names) if (!readdirSync(probe).includes(n)) return `the file system renamed ${JSON.stringify(n)}`
    return null
  } catch (err) {
    return `this file system refuses such a folder name: ${String((err as Error)?.message ?? err)}`
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

const MARKED_FOLDERS = ['inv‮oice', 'rlm‏skill', 'tidy‏', '‏‮']

test(
  'a skill with no frontmatter name is listed under its folder name cleaned, read on that row, and shared by it',
  { skip: folderNamesTaken(MARKED_FOLDERS) ?? false },
  () => {
    const f = fixture()
    for (const folder of MARKED_FOLDERS) skill(join(f.config, 'skills', folder), 'description: No name key here.')
    const rows = list(f).skills
    const CONTROL = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/
    assert.deepEqual(rows.filter((r) => CONTROL.test(r.name)).map((r) => r.name), [], 'no listed name carries a mark')
    const want: Array<[string, string]> = [
      ['inv‮oice', 'inv oice'],
      ['rlm‏skill', 'rlm skill'],
      ['tidy‏', 'tidy'],
    ]
    for (const [folder, name] of want) {
      const row = rows.find((r) => r.scope === 'computer' && r.path === `~/.claude-work/skills/${folder}`)
      assert.equal(row?.name, name, JSON.stringify(folder))
      const answer = read(f, { name: row!.name, scope: row!.scope, path: row!.path })
      assert.equal(answer.ok, true, `${JSON.stringify(folder)}: ${JSON.stringify(answer).slice(0, 160)}`)
      if (answer.ok) assert.equal(answer.payload.content, '---\ndescription: No name key here.\n---\nBody text.\n')
    }
    // a folder name of marks alone cleans to nothing: no row with an empty name
    assert.equal(rows.some((r) => r.path === '~/.claude-work/skills/‏‮'), false)
    assert.equal(rows.some((r) => r.name === ''), false)
    // share takes a strict name only, and resolves it the way the list named the row
    const shared = exportSkill({
      agentDir: f.agent,
      configDir: f.config,
      home: f.home,
      managedDir: f.managed,
      payload: { name: 'tidy', scope: 'computer', dryRun: true },
    })
    assert.equal(shared.ok, true, JSON.stringify(shared).slice(0, 200))
    if (shared.ok) assert.equal(JSON.stringify(shared.payload).includes('No name key here.'), true)
  },
)

test(
  'hiddenBy keys on the name Claude Code loads (the raw folder or frontmatter name), not the cleaned one the list shows',
  { skip: folderNamesTaken(['tidy‏']) ?? false },
  () => {
    const f = fixture()
    // Claude Code loads 'tidy‏' and 'tidy' as two skills: neither hides the other
    mkdirSync(join(f.skills, 'tidy‏'), { recursive: true })
    writeFileSync(join(f.skills, 'tidy‏', 'SKILL.md'), '---\ndescription: Agent copy, no name key.\n---\n')
    skill(join(f.config, 'skills', 'tidy'), 'description: Computer copy, no name key.')
    // the same for a frontmatter name with a mark in it
    skill(join(f.skills, 'neat-agent'), 'name: neat‏\ndescription: Agent copy, a marked name.')
    skill(join(f.config, 'skills', 'neat'), 'description: Computer copy, no name key.')
    // and a real collision still hides: the raw names fold alike
    skill(join(f.skills, 'dup'), 'description: Agent copy.')
    skill(join(f.config, 'skills', 'Dup'), 'description: Computer copy.')
    const rows = list(f).skills
    const at = (scope: string, folder: string) => rows.find((r) => r.scope === scope && r.path.endsWith(`/skills/${folder}`))
    assert.equal(at('agent', 'tidy‏')?.name, 'tidy', 'still shown cleaned')
    assert.equal(at('computer', 'tidy')?.name, 'tidy')
    assert.equal(at('agent', 'neat-agent')?.name, 'neat')
    assert.equal(at('computer', 'neat')?.name, 'neat')
    const hidden = (scope: string, folder: string) => at(scope, folder)?.hiddenBy
    assert.deepEqual(
      [hidden('agent', 'tidy‏'), hidden('computer', 'tidy'), hidden('agent', 'neat-agent'), hidden('computer', 'neat')],
      [undefined, undefined, undefined, undefined],
      'no row is hidden by a skill Claude Code loads beside it',
    )
    assert.equal(hidden('agent', 'dup'), 'computer')
    assert.equal(hidden('computer', 'Dup'), undefined)
  },
)

const CONTROL_FOLDERS = ['tidy\u007f', 'del\u007fnamed']

test(
  'a folder whose raw name holds a C0 control or DEL is not listed, read or shared: its path can never round trip',
  { skip: folderNamesTaken(CONTROL_FOLDERS) ?? false },
  () => {
    const f = fixture()
    skill(join(f.config, 'skills', 'tidy\u007f'), 'description: DEL folder, no name key.')
    skill(join(f.config, 'skills', 'del\u007fnamed'), 'name: del-named\ndescription: DEL folder, a clean name key.')
    skill(join(f.config, 'skills', 'tidy'), 'description: The clean tidy.')
    const logs: string[] = []
    const rows = listSkills({ agentDir: f.agent, configDir: f.config, home: f.home, managedDir: f.managed, log: (m) => logs.push(m) }).skills
    assert.deepEqual(rows.filter((r) => /[\u0000-\u001f\u007f]/.test(r.path)).map((r) => r.path), [], 'no listed path holds a control')
    assert.deepEqual(rows.filter((r) => r.name === 'tidy').map((r) => r.path), ['~/.claude-work/skills/tidy'])
    assert.equal(rows.some((r) => r.name === 'del-named'), false)
    assert.equal(logs.filter((m) => /skipped, its path is not one the app can send back/.test(m)).length, 2, logs.join('\n'))
    assert.equal(logs.some((m) => m.includes('\u007f')), false, 'the log never carries the raw name')
    for (const folder of CONTROL_FOLDERS) {
      const name = folder === 'tidy\u007f' ? 'tidy' : 'del-named'
      const answer = read(f, { name, scope: 'computer', path: `~/.claude-work/skills/${folder}` })
      assert.notEqual(codeOf(answer), 'ok', JSON.stringify(folder))
    }
    // share resolves 'tidy' to the one listed folder, not to the DEL one as well
    const share = (name: string) =>
      exportSkill({ agentDir: f.agent, configDir: f.config, home: f.home, managedDir: f.managed, payload: { name, scope: 'computer', dryRun: true } })
    const tidy = share('tidy')
    assert.equal(tidy.ok, true, JSON.stringify(tidy).slice(0, 200))
    if (tidy.ok) assert.equal(JSON.stringify(tidy.payload).includes('The clean tidy.'), true)
    assert.equal(codeOf(share('del-named')), 'not_found')
  },
)

const TRAILING_FOLDERS = ['tidy.', 'notes ']

test(
  'a folder whose path the backend refuses (a name ending in a dot or a space) is not listed, read or shared',
  { skip: folderNamesTaken(TRAILING_FOLDERS) ?? false },
  () => {
    const f = fixture()
    skill(join(f.config, 'skills', 'tidy.'), 'description: A trailing dot, no name key.')
    skill(join(f.config, 'skills', 'notes '), 'name: notes\ndescription: A trailing space, a clean name key.')
    // a dot inside a name is fine: only a segment that ENDS in a dot or a space is refused
    skill(join(f.config, 'skills', 'v1.2'), 'description: A dot inside.')
    const logs: string[] = []
    const rows = listSkills({ agentDir: f.agent, configDir: f.config, home: f.home, managedDir: f.managed, log: (m) => logs.push(m) }).skills
    assert.deepEqual(rows.filter((r) => !SKILL_DISPLAY_PATH_PATTERN.test(r.path)).map((r) => r.path), [], 'every listed path is one the backend takes back')
    assert.deepEqual(rows.filter((r) => r.scope === 'computer' && r.path.endsWith('/v1.2')).map((r) => r.name), ['v1.2'])
    assert.equal(rows.some((r) => r.path.endsWith('/tidy.') || r.name === 'tidy.'), false)
    assert.equal(rows.some((r) => r.path.endsWith('/notes ') || r.name === 'notes'), false)
    assert.equal(logs.filter((m) => /skipped, its path is not one the app can send back/.test(m)).length, 2, logs.join('\n'))
    assert.equal(logs.some((m) => m.includes('tidy.') || m.includes('notes ')), false, 'the log never carries the raw name')
    for (const [folder, name] of [['tidy.', 'tidy.'], ['notes ', 'notes']] as const) {
      const answer = read(f, { name, scope: 'computer', path: `~/.claude-work/skills/${folder}` })
      assert.notEqual(codeOf(answer), 'ok', JSON.stringify(folder))
    }
    const shared = exportSkill({
      agentDir: f.agent,
      configDir: f.config,
      home: f.home,
      managedDir: f.managed,
      payload: { name: 'notes', scope: 'computer', dryRun: true },
    })
    assert.equal(codeOf(shared), 'not_found')
  },
)

const REFUSED_WINNERS = ['review ', 'tidy.', 'stolen ', 'deploy ', 'ship ']

test(
  'a folder the list skips on its path still wins its loaded name for hiddenBy, and is never a row, read or shared',
  { skip: folderNamesTaken(REFUSED_WINNERS) ?? false },
  () => {
    const f = fixture()
    // Claude Code still loads 'review ' (under its frontmatter name 'review'): it hides the agent's 'review'
    skill(join(f.config, 'skills', 'review '), 'name: review\ndescription: Computer copy, a trailing space.')
    skill(join(f.skills, 'review'), 'description: Agent copy, no name key.')
    // with no name key it loads under the raw entry 'tidy.', which is not 'tidy': nothing hidden
    skill(join(f.config, 'skills', 'tidy.'), 'description: Computer copy, a trailing dot, no name key.')
    skill(join(f.skills, 'tidy'), 'description: Agent copy, no name key.')
    // a refused entry gets the rules a listed one gets: a hard linked SKILL.md gives no name at all
    mkdirSync(join(f.config, 'skills', 'stolen '))
    linkSync(join(f.home, 'secret.txt'), join(f.config, 'skills', 'stolen ', 'SKILL.md'))
    skill(join(f.skills, 'stolen'), 'description: Agent copy, no name key.')
    // every scope in precedence order, not only computer over agent
    skill(join(f.managed, 'deploy '), 'name: deploy\ndescription: Managed copy, a trailing space.')
    skill(join(f.config, 'skills', 'deploy'), 'description: Computer copy.')
    skill(join(f.skills, 'ship '), 'name: ship\ndescription: Agent copy, a trailing space.')
    skill(join(f.repo, '.claude', 'skills', 'ship'), 'description: Repo copy.')

    const logs: string[] = []
    const rows = listSkills({ agentDir: f.agent, configDir: f.config, home: f.home, managedDir: f.managed, log: (m) => logs.push(m) }).skills
    const at = (scope: string, folder: string) => rows.find((r) => r.scope === scope && r.path.endsWith(`/skills/${folder}`))
    assert.equal(at('agent', 'review')?.hiddenBy, 'computer', 'the agent review is hidden by the computer one Claude Code loads')
    assert.equal(at('agent', 'tidy')?.hiddenBy, undefined, "'tidy.' loads as 'tidy.', not 'tidy'")
    assert.equal(at('agent', 'stolen')?.hiddenBy, undefined, 'a hard linked SKILL.md names nothing')
    assert.equal(at('computer', 'deploy')?.hiddenBy, 'managed')
    assert.equal(at('repo', 'ship')?.hiddenBy, 'agent')

    // a refused entry is never a row
    assert.deepEqual(
      rows.filter((r) => REFUSED_WINNERS.some((folder) => r.path.endsWith(`/${folder}`))).map((r) => r.path),
      [],
      'no row for a refused folder',
    )
    assert.deepEqual(rows.filter((r) => !SKILL_DISPLAY_PATH_PATTERN.test(r.path)).map((r) => r.path), [])
    assert.equal(rows.some((r) => r.scope === 'computer' && r.name === 'review'), false)
    assert.equal(rows.some((r) => r.scope === 'managed' && r.name === 'deploy'), false)
    assert.equal(rows.some((r) => r.scope === 'agent' && r.name === 'ship'), false)
    assert.ok(!JSON.stringify(rows).includes(LEAK))
    assert.equal(logs.some((m) => REFUSED_WINNERS.some((folder) => m.includes(folder))), false, 'the log never carries the raw name')

    // never read, never shared
    for (const [scope, folder, name] of [
      ['computer', '~/.claude-work/skills/review ', 'review'],
      ['agent', '~/repo/agent/.claude/skills/ship ', 'ship'],
    ] as const) {
      assert.notEqual(codeOf(read(f, { name, scope, path: folder })), 'ok', folder)
    }
    const share = (name: string, scope: string) =>
      exportSkill({ agentDir: f.agent, configDir: f.config, home: f.home, managedDir: f.managed, payload: { name, scope, dryRun: true } })
    assert.equal(codeOf(share('review', 'computer')), 'not_found')
    const agentShip = share('ship', 'agent')
    assert.notEqual(codeOf(agentShip), 'ok')
  },
)

test('a folder the list skips because its name looks like a secret still wins its loaded name for hiddenBy', () => {
  const f = fixture()
  // the folder name trips the secret scan, so the row is dropped; Claude Code still loads it as 'review'
  skill(join(f.config, 'skills', 'AKIAIOSFODNN7EXAMPLQ'), 'name: review\ndescription: Computer copy under a key shaped folder.')
  skill(join(f.skills, 'review'), 'description: Agent copy, no name key.')
  const logs: string[] = []
  const rows = listSkills({ agentDir: f.agent, configDir: f.config, home: f.home, managedDir: f.managed, log: (m) => logs.push(m) }).skills
  assert.equal(rows.find((r) => r.scope === 'agent' && r.name === 'review')?.hiddenBy, 'computer')
  assert.equal(rows.some((r) => r.path.includes('AKIAIOSFODNN7EXAMPLQ')), false, 'never a row')
  assert.equal(logs.some((m) => m.includes('AKIAIOSFODNN7EXAMPLQ')), false, 'never in a log line')
})

// ── write_skill ─────────────────────────────────────────────────────────────

test('write saves an agent skill in place and keeps the old bytes in the trash', () => {
  const f = fixture()
  const before = read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH })
  assert.ok(before.ok)
  const { answer } = write(f, edit(EDITED, { expectSha256: before.payload.sha256 }))
  assert.equal(answer.ok, true, JSON.stringify(answer))
  if (!answer.ok) return
  const md = join(f.skills, 'agent-skill', 'SKILL.md')
  assert.equal(readFileSync(md, 'utf8'), EDITED)
  assert.deepEqual(Object.keys(answer.payload).sort(), ['bytes', 'modifiedAt', 'name', 'path', 'scope', 'sha256'])
  assert.equal(answer.payload.scope, 'agent')
  assert.equal(answer.payload.path, AGENT_PATH)
  assert.equal(answer.payload.name, 'agent-skill')
  assert.equal(answer.payload.sha256, sha256Hex(EDITED))
  assert.equal(answer.payload.bytes, Buffer.byteLength(EDITED))
  assert.equal(answer.payload.modifiedAt, statSync(md).mtime.toISOString())
  assert.deepEqual(temps(join(f.skills, 'agent-skill')), [])

  // The old bytes are in the plugin state trash, beside a note, and nowhere a skills root loads.
  const stamp = String(NOW).padStart(15, '0')
  assert.deepEqual(trashed(f), [`${stamp}-agent-skill.SKILL.md`, `${stamp}-agent-skill.SKILL.md.json`])
  assert.equal(readFileSync(join(f.trash, `${stamp}-agent-skill.SKILL.md`), 'utf8'), AGENT_SKILL)
  const note = JSON.parse(readFileSync(join(f.trash, `${stamp}-agent-skill.SKILL.md.json`), 'utf8'))
  assert.deepEqual(note, {
    name: 'agent-skill',
    scope: 'agent',
    path: AGENT_PATH,
    editedAt: new Date(NOW).toISOString(),
    sha256: sha256Hex(AGENT_SKILL),
  })
  assert.ok(!list(f).skills.some((s) => s.description.includes('Does the agent thing.')))

  // A read afterwards sees the edit and may edit again.
  const after = read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH })
  assert.ok(after.ok)
  assert.equal(after.payload.content, EDITED)
  assert.equal(after.payload.sha256, answer.payload.sha256)
  assert.equal(after.payload.editable, true)

  // A second edit on the same stamp never overwrites the first backup.
  const again = write(f, edit(AGENT_SKILL, { expectSha256: sha256Hex(EDITED) })).answer
  assert.equal(again.ok, true)
  assert.equal(trashed(f).length, 4)
})

test('an identical resend answers unchanged and writes nothing', () => {
  const f = fixture()
  assert.equal(write(f, edit(EDITED)).answer.ok, true)
  const md = join(f.skills, 'agent-skill', 'SKILL.md')
  const mtime = statSync(md).mtimeMs
  const held = trashed(f)
  // the same Save again, its expectSha256 now stale
  const { answer } = write(f, edit(EDITED))
  assert.equal(answer.ok, true)
  if (!answer.ok) return
  assert.equal(answer.payload.unchanged, true)
  assert.equal(answer.payload.sha256, sha256Hex(EDITED))
  assert.equal(statSync(md).mtimeMs, mtime)
  assert.deepEqual(trashed(f), held)
})

test('a skill changed since the preview answers changed_since_preview and keeps the disk copy', () => {
  const f = fixture()
  const md = join(f.skills, 'agent-skill', 'SKILL.md')
  const theirs = AGENT_SKILL.replace('Body text.', 'Edited on the computer.')
  writeFileSync(md, theirs)
  const { answer } = write(f, edit(EDITED))
  assert.equal(codeOf(answer), 'changed_since_preview')
  assert.equal(readFileSync(md, 'utf8'), theirs)
  assert.deepEqual(trashed(f), [])
  assert.deepEqual(temps(join(f.skills, 'agent-skill')), [])
})

test('write refuses every scope but agent, and leaves those skills alone', () => {
  const f = fixture()
  const rows = list(f).skills.filter((s) => s.scope !== 'agent')
  assert.deepEqual([...new Set(rows.map((r) => r.scope))].sort(), ['computer', 'managed', 'plugin', 'repo', 'synced'])
  for (const row of rows) {
    const { answer } = write(f, { ...edit(EDITED), name: row.name, scope: row.scope, path: row.path })
    assert.equal(codeOf(answer), 'scope_refused', row.scope)
    assert.ok(!(answer as any).message.includes(f.home))
  }
  for (const [dir, scope] of [
    [join(f.config, 'skills', 'computer-skill'), 'computer'],
    [join(f.repo, '.claude', 'skills', 'repo-skill'), 'repo'],
  ] as const) {
    assert.ok(!readFileSync(join(dir, 'SKILL.md'), 'utf8').includes('A new body'), scope)
  }
})

test('write refuses a path that is not exactly a skill in this agent folder', () => {
  const f = fixture()
  const computerMd = join(f.config, 'skills', 'computer-skill', 'SKILL.md')
  const computerSha = sha(readFileSync(computerMd))
  for (const path of [
    '~/repo/agent/.claude/skills/../../../.claude-work/skills/computer-skill',
    '~/repo/agent/.claude/skills/x/../agent-skill',
    join(f.config, 'skills', 'computer-skill'),
    '~/.claude-work/skills/computer-skill',
    '~/repo/agent/.claude/skills/agent-skill/sub',
    'repo/agent/.claude/skills/agent-skill',
  ]) {
    const { answer } = write(f, edit(EDITED, { name: 'computer-skill', path, expectSha256: computerSha }))
    assert.equal(codeOf(answer), 'scope_refused', path)
    assert.ok(!(answer as any).message.includes(f.home), (answer as any).message)
  }
  assert.ok(!readFileSync(computerMd, 'utf8').includes('A new body'))
})

test('write refuses a symlinked .claude or skills parent', () => {
  const f = fixture()
  // .claude is a link to a real folder elsewhere
  const a2 = join(f.home, 'agent2')
  skill(join(f.home, 'claude-elsewhere', 'skills', 'victim'), 'name: victim\ndescription: Behind a linked .claude.')
  mkdirSync(a2)
  linkFolder(join(f.home, 'claude-elsewhere'), join(a2, '.claude'))
  // .claude is real, .claude/skills is a link to the computer skills folder
  const a3 = join(f.home, 'agent3')
  mkdirSync(join(a3, '.claude'), { recursive: true })
  linkFolder(join(f.config, 'skills'), join(a3, '.claude', 'skills'))
  const victim = join(f.home, 'claude-elsewhere', 'skills', 'victim', 'SKILL.md')
  const computerMd = join(f.config, 'skills', 'computer-skill', 'SKILL.md')
  for (const [agentDir, path, name, md] of [
    [a2, '~/agent2/.claude/skills/victim', 'victim', victim],
    [a3, '~/agent3/.claude/skills/computer-skill', 'computer-skill', computerMd],
  ] as const) {
    const before = readFileSync(md, 'utf8')
    const { answer } = write(f, edit(EDITED, { name, path, expectSha256: sha256Hex(before) }), { agentDir })
    assert.equal(codeOf(answer), 'scope_refused', path)
    assert.equal(readFileSync(md, 'utf8'), before)
    assert.deepEqual(temps(join(md, '..')), [])
  }
})

test('write refuses a linked skill folder and a hard linked SKILL.md', () => {
  const f = fixture()
  const target = join(f.home, 'elsewhere', 'linked-target', 'SKILL.md')
  const before = readFileSync(target, 'utf8')
  const linked = write(f, edit(EDITED, { name: 'linked-dir', path: '~/repo/agent/.claude/skills/linked-dir', expectSha256: sha256Hex(before) }))
  assert.equal(codeOf(linked.answer), 'scope_refused')
  assert.equal(readFileSync(target, 'utf8'), before)

  linkSync(join(f.skills, 'agent-skill', 'SKILL.md'), join(f.home, 'hard-copy.md'))
  const hard = write(f, edit(EDITED))
  assert.equal(codeOf(hard.answer), 'scope_refused')
  assert.equal(readFileSync(join(f.home, 'hard-copy.md'), 'utf8'), AGENT_SKILL)
  assert.deepEqual(temps(join(f.skills, 'agent-skill')), [])
})

test('write refuses a SKILL.md that is a file link', { skip: fileSymlinkRefused }, () => {
  const f = fixture()
  mkdirSync(join(f.skills, 'md-link'))
  writeFileSync(join(f.skills, 'md-link', 'real.md'), '---\nname: md-link\ndescription: Linked file.\n---\n')
  symlinkSync(join(f.skills, 'md-link', 'real.md'), join(f.skills, 'md-link', 'SKILL.md'))
  const before = readFileSync(join(f.skills, 'md-link', 'real.md'), 'utf8')
  const { answer } = write(f, edit(EDITED, { name: 'md-link', path: '~/repo/agent/.claude/skills/md-link', expectSha256: sha256Hex(before) }))
  assert.equal(codeOf(answer), 'scope_refused')
  assert.equal(readFileSync(join(f.skills, 'md-link', 'real.md'), 'utf8'), before)
  // and the read says the same: preview only
  const shown = read(f, { name: 'md-link', scope: 'agent', path: '~/repo/agent/.claude/skills/md-link' })
  assert.ok(shown.ok)
  assert.equal(shown.payload.editable, false)
  assert.equal(shown.payload.editBlock, 'linked')
})

test('write refuses content the rules refuse, before anything is written', () => {
  const f = fixture()
  const front = '---\nname: agent-skill\ndescription: Edited.\n---\n'
  const cases: Array<[string, string]> = [
    ['too large', front + 'x'.repeat(SKILL_WRITE_MAX_BYTES)],
    ['NUL', front + 'a\u0000b\n'],
    ['executable frontmatter', '---\nname: agent-skill\ndescription: Edited.\nallowed-tools: Bash\n---\n'],
    ['hooks frontmatter', '---\nname: agent-skill\ndescription: Edited.\nhooks: x\n---\n'],
    ['shell fence mid line', front + 'Look ```!\nrm -rf ~\n```\n'],
    ['shell fence at line start', front + '```!\nrm -rf ~\n```\n'],
    ['inline shell', front + 'Run !`date`.\n'],
    ['secret', front + `key ${AWS}\n`],
    ['invalid frontmatter', '---\nname: agent-skill\nname: twice\n---\n'],
  ]
  for (const [label, content] of cases) {
    const { answer } = write(f, edit(content))
    assert.equal(codeOf(answer), 'content_refused', label)
    assert.ok(!(answer as any).message.includes(AWS), label)
    assert.equal(readFileSync(join(f.skills, 'agent-skill', 'SKILL.md'), 'utf8'), AGENT_SKILL, label)
    assert.deepEqual(temps(join(f.skills, 'agent-skill')), [], label)
  }
  assert.deepEqual(trashed(f), [])
})

test('write refuses a payload that is not an edit: bad_request', () => {
  const f = fixture()
  const cases: Array<[string, Record<string, unknown>]> = [
    ['no expectSha256', edit(EDITED, { expectSha256: undefined })],
    ['short expectSha256', edit(EDITED, { expectSha256: 'abc' })],
    ['upper case expectSha256', edit(EDITED, { expectSha256: sha256Hex(AGENT_SKILL).toUpperCase() })],
    ['content not a string', edit(EDITED, { content: 42 })],
    ['a lone surrogate', edit(EDITED.replace('better', 'b\ud800tter'))],
    ['a frontmatter name Claude Code refuses', edit(EDITED.replace('name: agent-skill', 'name: Agent Skill'))],
    ['a name that is not this skill', edit(EDITED, { name: 'other-skill' })],
    ['a name that is not a name', edit(EDITED, { name: '../x' })],
    ['no path', edit(EDITED, { path: undefined })],
  ]
  for (const [label, payload] of cases) {
    assert.equal(codeOf(write(f, payload).answer), 'bad_request', label)
  }
  assert.equal(readFileSync(join(f.skills, 'agent-skill', 'SKILL.md'), 'utf8'), AGENT_SKILL)
})

test('write with no launch folder answers unavailable; a missing skill not_found', () => {
  const f = fixture()
  assert.equal(codeOf(write(f, edit(EDITED), { agentDir: null }).answer), 'unavailable')
  assert.equal(codeOf(write(f, edit(EDITED, { name: 'gone', path: '~/repo/agent/.claude/skills/gone' })).answer), 'not_found')
  assert.equal(codeOf(write(f, edit(EDITED, { name: 'not-a-skill', path: '~/repo/agent/.claude/skills/not-a-skill' })).answer), 'not_found')
})

test('a trash inside a skills folder refuses the write, so the backup never loads as a skill', () => {
  const f = fixture()
  for (const trashDir of [join(f.skills, 'trash'), join(f.config, 'skills', 'trash'), join(f.repo, '.claude', 'skills', 'trash')]) {
    const { answer } = write(f, edit(EDITED), { trashDir })
    assert.equal(codeOf(answer), 'write_failed', trashDir)
    assert.ok(!existsSync(trashDir))
  }
  assert.equal(readFileSync(join(f.skills, 'agent-skill', 'SKILL.md'), 'utf8'), AGENT_SKILL)
  assert.deepEqual(temps(join(f.skills, 'agent-skill')), [])
})

test('a skill folder swapped for a link to a computer skill before the rename is never written through', () => {
  const f = fixture()
  const target = join(f.skills, 'agent-skill')
  const moved = join(f.home, 'moved-away')
  const computerMd = join(f.config, 'skills', 'computer-skill', 'SKILL.md')
  const before = readFileSync(computerMd, 'utf8')
  const { answer } = write(f, edit(EDITED), {
    rename: (from, to) => {
      renameSync(target, moved)
      linkFolder(join(f.config, 'skills', 'computer-skill'), target)
      renameSync(from, to)
    },
  })
  assert.notEqual(codeOf(answer), 'ok')
  assert.equal(readFileSync(computerMd, 'utf8'), before)
  assert.deepEqual(temps(join(f.config, 'skills', 'computer-skill')), [])
})

test('a skill folder swapped while the rename runs is caught after it', () => {
  const f = fixture()
  const target = join(f.skills, 'agent-skill')
  const moved = join(f.home, 'moved-away')
  const { answer, logs } = write(f, edit(EDITED), {
    rename: (from, to) => {
      renameSync(target, moved)
      linkFolder(moved, target)
      renameSync(from, to)
    },
  })
  assert.equal(codeOf(answer), 'scope_refused')
  assert.ok(logs.some((l) => /changed while saving/.test(l)), logs.join('\n'))
  assert.ok(!(answer as any).message.includes(f.home))
})

test('a read only SKILL.md is not offered for edit, and a save refuses it before any backup or temp', () => {
  // Windows cannot rename over a read only file, so every save would fail at
  // the rename after keeping a backup: neither read nor write may pretend.
  const f = fixture()
  const md = join(f.skills, 'agent-skill', 'SKILL.md')
  chmodSync(md, 0o444)
  try {
    const answer = read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    if (answer.ok) {
      assert.equal(answer.payload.editable, false)
      assert.equal(answer.payload.editBlock, 'read_only')
      assert.equal(answer.payload.content, AGENT_SKILL)
    }
    const { answer: saved } = write(f, edit(EDITED))
    assert.equal(codeOf(saved), 'read_only', JSON.stringify(saved))
    assert.match((saved as any).message, /read only/)
    assert.doesNotMatch((saved as any).message, /try again/)
    assert.ok(!(saved as any).message.includes(f.home))
    assert.deepEqual(trashed(f), [], 'no backup kept for a save that cannot happen')
    assert.deepEqual(temps(join(f.skills, 'agent-skill')), [])
    assert.equal(readFileSync(md, 'utf8'), AGENT_SKILL)
  } finally {
    chmodSync(md, 0o644)
  }
  // writable again: offered and saved
  const again = read(f, { name: 'agent-skill', scope: 'agent', path: AGENT_PATH })
  assert.equal(again.ok && again.payload.editable, true, JSON.stringify(again))
  assert.equal(codeOf(write(f, edit(EDITED)).answer), 'ok')
})

test('a rename that fails leaves no temp file and the old bytes in place', () => {
  const f = fixture()
  for (const platform of ['win32', 'linux'] as const) {
    const { answer } = write(f, edit(EDITED), {
      platform,
      rename: () => {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${f.home}'`), { code: 'EBUSY' })
      },
    })
    assert.equal(codeOf(answer), 'write_failed', platform)
    assert.ok(!(answer as any).message.includes(f.home))
    if (platform === 'win32') assert.match((answer as any).message, /in use/)
    assert.equal(readFileSync(join(f.skills, 'agent-skill', 'SKILL.md'), 'utf8'), AGENT_SKILL)
    assert.deepEqual(temps(join(f.skills, 'agent-skill')), [])
  }
})

test('write refuses content whose frontmatter name, as the backend reads it, is not this skill', () => {
  const f = fixture()
  for (const content of [
    '---\nName: other-name\ndescription: Renamed by key case.\n---\nBody.\n',
    '---\nna_me: other-name\ndescription: Renamed by an underscore.\n---\nBody.\n',
    '---\nname: other-name # a comment\ndescription: Renamed.\n---\nBody.\n',
    '---\nname: other-name\ndescription: Renamed, closed on the last line.\n---',
  ]) {
    const { answer } = write(f, edit(content))
    assert.equal(codeOf(answer), 'bad_request', content)
  }
  assert.equal(readFileSync(join(f.skills, 'agent-skill', 'SKILL.md'), 'utf8'), AGENT_SKILL)
  // the same name under another key case or a comment is still this skill
  const kept = '---\nNAME: agent-skill # kept\ndescription: Same name.\n---\nBody.\n'
  assert.equal(codeOf(write(f, edit(kept)).answer), 'ok')
})

test('a skill folder linked to a computer skill for the temp file, real for the checks and linked for the rename never writes it', () => {
  // the review's race probe, made deterministic: three swaps around one save
  const f = fixture()
  const target = join(f.skills, 'agent-skill')
  const moved = join(f.home, 'moved-away')
  const computer = join(f.config, 'skills', 'computer-skill')
  const before = readFileSync(join(computer, 'SKILL.md'), 'utf8')
  let linked = false
  const toLink = () => {
    renameSync(target, moved)
    linkFolder(computer, target)
    linked = true
  }
  const toReal = () => {
    if (!linked) return
    rmSync(target)
    renameSync(moved, target)
    linked = false
  }
  // Every step the save reached, and the size of each temp file seen in the
  // computer skill at any of them: the check right after the open must refuse
  // before a byte goes in, so the re check is never reached and no temp there
  // ever holds the owner's text. The 'wrote' step fires inside the write loop,
  // after each writeSync, so a write that ran anywhere (even ahead of the
  // placement check) is peeked at the moment it lands, before any clean up.
  const reached: string[] = []
  const sizes: number[] = []
  const peek = () => {
    for (const n of temps(computer)) sizes.push(statSync(join(computer, n)).size)
  }
  const { answer, logs } = write(f, edit(EDITED), {
    step: (at) => {
      reached.push(at)
      peek()
      if (at === 'open_temp') toLink()
      if (at === 'recheck') toReal()
    },
    rename: (from, to) => {
      toLink()
      try {
        renameSync(from, to)
      } finally {
        toReal()
      }
    },
  })
  peek()
  toReal()
  assert.equal(codeOf(answer), 'scope_refused', JSON.stringify(answer))
  assert.deepEqual(
    sizes.filter((n) => n > 0),
    [],
    'no temp file in the computer skill ever holds a byte',
  )
  assert.equal(reached.includes('wrote'), false, `no write ran; steps reached: ${reached.join(', ')}`)
  assert.equal(reached.includes('recheck'), false, `steps reached: ${reached.join(', ')}`)
  assert.ok(logs.some((l) => /temp file was not made in the skill folder/.test(l)), logs.join('\n'))
  assert.equal(readFileSync(join(computer, 'SKILL.md'), 'utf8'), before)
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), AGENT_SKILL)
  assert.deepEqual(temps(computer), [])
  assert.deepEqual(temps(target), [])
})

test('a save passes every test step in order, the write step once per write', () => {
  // the steps the swap tests lean on are live: 'wrote' really fires when bytes go in
  const f = fixture()
  const reached: string[] = []
  const { answer } = write(f, edit(EDITED), { step: (at) => reached.push(at) })
  assert.equal(codeOf(answer), 'ok', JSON.stringify(answer))
  assert.deepEqual(reached, ['open_temp', 'opened', 'wrote', 'recheck'])
})

test('a temp file replaced before the rename is never moved into place', () => {
  const f = fixture()
  const target = join(f.skills, 'agent-skill')
  const planted = '---\nname: agent-skill\ndescription: Planted between the write and the rename.\n---\n'
  const { answer } = write(f, edit(EDITED), {
    step: (at) => {
      if (at !== 'recheck') return
      for (const name of temps(target)) {
        renameSync(join(target, name), join(f.home, 'taken-temp'))
        writeFileSync(join(target, name), planted)
      }
    },
  })
  assert.equal(codeOf(answer), 'scope_refused', JSON.stringify(answer))
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), AGENT_SKILL)
})

test('a skill folder swapped back inside the open leaves at most one empty 0o600 file, never the text or the SKILL.md mode', () => {
  // The documented residual, made deterministic by the 'opened' step: the
  // temp is made through a link to the computer skill, and the folder is
  // real again before the save takes the temp's realpath, so the save can no
  // longer find the file it made. It refuses before a byte goes in, and the
  // file it leaves is empty, with the fixed create mode, not the agent's.
  const f = fixture()
  const target = join(f.skills, 'agent-skill')
  const md = join(target, 'SKILL.md')
  const moved = join(f.home, 'moved-away')
  const computer = join(f.config, 'skills', 'computer-skill')
  // a mode a temp must not be made with (a read only SKILL.md is refused
  // before any temp, so on Windows, which keeps only that bit, every SKILL.md
  // a save gets this far with is writable, and so is the temp)
  chmodSync(md, 0o640)
  let linked = false
  const toLink = () => {
    renameSync(target, moved)
    linkFolder(computer, target)
    linked = true
  }
  const toReal = () => {
    if (!linked) return
    rmSync(target)
    renameSync(moved, target)
    linked = false
  }
  const reached: string[] = []
  const { answer } = write(f, edit(EDITED), {
    step: (at) => {
      reached.push(at)
      if (at === 'open_temp') toLink()
      if (at === 'opened') toReal()
    },
  })
  toReal()
  chmodSync(md, 0o644)
  assert.equal(codeOf(answer), 'scope_refused', JSON.stringify(answer))
  assert.deepEqual(reached, ['open_temp', 'opened'])
  assert.equal(readFileSync(md, 'utf8'), AGENT_SKILL)
  assert.deepEqual(temps(target), [])
  const left = temps(computer)
  assert.equal(left.length, 1, 'the residual: one file the save cannot find again')
  const st = statSync(join(computer, left[0]!))
  assert.equal(st.size, 0)
  if (process.platform === 'win32') assert.notEqual(st.mode & 0o200, 0, 'made writable (0o600)')
  else assert.equal(st.mode & 0o777, 0o600, 'the fixed create mode, not the SKILL.md 0o640')
  rmSync(join(computer, left[0]!))
})

test(
  'a saved SKILL.md takes the mode of the old file, set only after the temp is placed',
  { skip: process.platform === 'win32' ? 'Windows keeps only a read only bit, not POSIX mode bits' : false },
  () => {
    const f = fixture()
    const md = join(f.skills, 'agent-skill', 'SKILL.md')
    for (const mode of [0o666, 0o640, 0o600]) {
      chmodSync(md, mode)
      const current = readFileSync(md)
      const content = EDITED.replace('better', `better ${mode.toString(8)}`)
      const { answer } = write(f, edit(content, { expectSha256: sha(current) }))
      assert.equal(codeOf(answer), 'ok', JSON.stringify(answer))
      assert.equal(statSync(md).mode & 0o777, mode, mode.toString(8))
    }
  },
)

test.after(() => {
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith('skills-edit-')) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
})
