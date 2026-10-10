/**
 * The Claude Code skills inventory (skills view design, section 7 row 3): what
 * the owner's Abilities screen lists for this agent, and the one Remove it may
 * do.
 *
 * Every case runs against a REAL fixture tree in a temp folder, because the
 * rules under test are file system rules (a symlinked folder, a file symlink
 * that leaves its skill, a parent that is a link) and a faked fs would only
 * test the fake. The tree holds all six scopes, a symlinked skill folder, an
 * escaping file symlink, a `synced` folder, a hidden duplicate, a symlink
 * loop, a personal folder the config dir REPLACES, and a plugin cache that
 * stands in for process.cwd() on a marketplace install.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FRONTMATTER_READ_MAX,
  SKILLS_ROOT_MAX,
  SKILL_NAME_RE,
  listSkills,
  managedSkillsDir,
  parseFrontmatter,
  readSkillHead,
  removeAgentSkill,
  type SkillItem,
} from '../lib/skills-inventory.ts'

const LEAK = 'LEAKED-FILE-CONTENT-must-never-be-read'
const AWS = 'AKIAIOSFODNN7EXAMPLQ'

function skill(dir: string, front: string, body = 'Body text.\n'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${front}\n---\n${body}`)
}

/** Builds the fixture and answers its folders. realpath'd: macOS tmp is a link. */
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'skills-inv-')))
  const repo = join(home, 'repo')
  const agent = join(repo, 'agent')
  const config = join(home, '.claude-work')
  const managed = join(home, 'managed', 'skills')
  const cache = join(config, 'plugins', 'cache', 'mk', 'plug', '1.0.0')

  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(home, 'secret.txt'), `${LEAK}\n---\nname: stolen\ndescription: ${LEAK}\n---\n`)

  // agent scope
  skill(join(agent, '.claude', 'skills', 'agent-skill'), 'name: agent-skill\ndescription: Does the agent thing.')
  skill(join(agent, '.claude', 'skills', 'dup-skill'), 'description: The project copy.')
  skill(join(home, 'elsewhere', 'linked-target'), 'description: Reached through a folder link.')
  symlinkSync(join(home, 'elsewhere', 'linked-target'), join(agent, '.claude', 'skills', 'linked-dir'))
  mkdirSync(join(agent, '.claude', 'skills', 'escaper'), { recursive: true })
  symlinkSync(join(home, 'secret.txt'), join(agent, '.claude', 'skills', 'escaper', 'SKILL.md'))
  // a loop and an escaping extra file inside a real skill
  symlinkSync(join(agent, '.claude', 'skills', 'agent-skill'), join(agent, '.claude', 'skills', 'agent-skill', 'loop'))
  symlinkSync(join(home, 'secret.txt'), join(agent, '.claude', 'skills', 'agent-skill', 'leak.md'))
  skill(
    join(agent, '.claude', 'skills', 'runs-cmds'),
    'description: Pre approves tools.\nallowed-tools: Bash(git *)',
  )
  skill(join(agent, '.claude', 'skills', 'leaky-desc'), `description: uses key ${AWS} to call the API`)
  skill(
    join(agent, '.claude', 'skills', 'folded'),
    'name: folded\ndescription: >\n  First line\n  second line.\nmodel: sonnet',
  )
  mkdirSync(join(agent, '.claude', 'skills', 'not-a-skill'), { recursive: true })
  mkdirSync(join(agent, '.claude', 'skills', '.hidden-skill'), { recursive: true })
  writeFileSync(join(agent, '.claude', 'skills', '.hidden-skill', 'SKILL.md'), '---\ndescription: hidden\n---\n')

  // repo scope (a parent of the agent folder, up to the .git root)
  skill(join(repo, '.claude', 'skills', 'repo-skill'), 'description: Every worktree here loads it.')

  // computer scope, under CLAUDE_CONFIG_DIR, and the synced folder inside it
  skill(join(config, 'skills', 'computer-skill'), 'description: Every agent on the computer.')
  skill(join(config, 'skills', 'dup-skill'), 'description: The personal copy wins.')
  skill(join(config, 'skills', 'synced', 'synced-skill'), 'description: From claude.ai.')

  // ~/.claude/skills, which CLAUDE_CONFIG_DIR REPLACES
  skill(join(home, '.claude', 'skills', 'not-in-config'), 'description: Only under ~/.claude.')

  // plugin scope
  skill(join(cache, 'skills', 'plug-skill'), 'description: From a plugin.')
  mkdirSync(join(config, 'plugins'), { recursive: true })
  writeFileSync(
    join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'plug@mk': [{ scope: 'user', installPath: cache, version: '1.0.0' }],
        'other@mk': [{ scope: 'project', projectPath: join(home, 'someone-else'), installPath: join(home, 'nope') }],
      },
    }),
  )

  // managed scope
  skill(join(managed, 'managed-skill'), 'description: Set by the organisation.')

  // the plugin cache a marketplace install runs in (process.cwd())
  const pluginCwd = join(home, 'plugin-cache-cwd')
  skill(join(pluginCwd, '.claude', 'skills', 'cache-skill'), 'description: The plugin repo own skill.')

  return { home, repo, agent, config, managed, cache, pluginCwd }
}

function byName(skills: SkillItem[], name: string, scope?: string): SkillItem | undefined {
  return skills.find((s) => s.name === name && (scope === undefined || s.scope === scope))
}

function list(f: ReturnType<typeof fixture>, agentDir: string | null = f.agent) {
  return listSkills({ agentDir, configDir: f.config, home: f.home, managedDir: f.managed })
}

test('the strict skill name rule is Claude Code own', () => {
  assert.ok(SKILL_NAME_RE.test('agent-skill'))
  for (const bad of ['', 'A', '../x', 'a/b', 'a..b'.replace('..', '/'), '-x', 'x'.repeat(65), 'a b', 'a.b']) {
    assert.ok(!SKILL_NAME_RE.test(bad), bad)
  }
})

test('every scope is listed with its own folder, and process.cwd() is never read', () => {
  const f = fixture()
  const before = process.cwd()
  process.chdir(f.pluginCwd)
  try {
    const { skills, omitted } = list(f)
    assert.equal(omitted, undefined)
    const want: Array<[string, string]> = [
      ['agent-skill', 'agent'],
      ['repo-skill', 'repo'],
      ['computer-skill', 'computer'],
      ['synced-skill', 'synced'],
      ['plug:plug-skill', 'plugin'],
      ['managed-skill', 'managed'],
    ]
    for (const [name, scope] of want) assert.ok(byName(skills, name, scope), `${name} in ${scope}`)
    assert.equal(byName(skills, 'cache-skill'), undefined, 'the plugin cache cwd is not the agent folder')
    assert.equal(byName(skills, 'not-in-config'), undefined, 'CLAUDE_CONFIG_DIR replaces ~/.claude/skills')
    assert.equal(byName(skills, 'synced', 'computer'), undefined, 'synced is its own scope, not a computer skill')
    assert.equal(byName(skills, 'not-a-skill'), undefined, 'a folder without SKILL.md is not a skill')
    assert.equal(byName(skills, '.hidden-skill'), undefined)
    assert.equal(byName(skills, 'other:x'), undefined)
    assert.ok(!skills.some((s) => s.scope === 'plugin' && s.name.startsWith('other:')), 'another project plugin')
  } finally {
    process.chdir(before)
  }
})

test('a row carries the contract fields: display path, provenance, removable only for agent', () => {
  const f = fixture()
  const { skills } = list(f)
  const a = byName(skills, 'agent-skill', 'agent')!
  assert.equal(a.path, '~/repo/agent/.claude/skills/agent-skill')
  assert.equal(a.description, 'Does the agent thing.')
  assert.equal(a.provenance, 'local')
  assert.equal(a.removable, true)
  assert.equal(a.shareable, true)
  assert.equal(a.shareBlock, undefined)
  assert.equal(typeof a.modifiedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(a.modifiedAt!)))
  for (const s of skills) {
    assert.equal(s.removable, s.scope === 'agent', `${s.name} ${s.scope}`)
    assert.ok(!s.path.includes(f.home), `no raw home in ${s.path}`)
    for (const [k, v] of Object.entries(s)) assert.ok(v !== null && v !== undefined, `${s.name}.${k} is absent, not null`)
  }
  assert.equal(byName(skills, 'plug:plug-skill')!.provenance, 'plugin')
  assert.equal(byName(skills, 'plug:plug-skill')!.identifier, 'plug@mk')
  assert.equal(byName(skills, 'computer-skill')!.shareable, true, 'KC decision 4: computer skills are shareable')
  for (const scope of ['repo', 'synced', 'plugin', 'managed']) {
    const row = skills.find((s) => s.scope === scope)!
    assert.equal(row.shareable, false, scope)
    assert.equal(row.shareBlock, 'scope', scope)
  }
})

test('a symlinked skill folder is followed; a SKILL.md that leaves its folder is never read', () => {
  const f = fixture()
  const { skills } = list(f)
  const linked = byName(skills, 'linked-dir', 'agent')!
  assert.ok(linked, 'the folder link is followed')
  assert.equal(linked.description, 'Reached through a folder link.')
  assert.equal(linked.path, '~/repo/agent/.claude/skills/linked-dir', 'shown where the agent sees it')
  assert.equal(byName(skills, 'escaper'), undefined)
  assert.equal(byName(skills, 'stolen'), undefined)
  assert.ok(!JSON.stringify(skills).includes(LEAK), 'nothing from the escaping target reaches the answer')
})

test('the size walk survives a loop and does not count a file that leaves the skill', () => {
  const f = fixture()
  const a = byName(list(f).skills, 'agent-skill', 'agent')!
  assert.equal(a.files, 1, 'SKILL.md only: the loop and the escaping leak.md are not counted')
  assert.ok(a.bytes! > 0 && a.bytes! < 200)
})

test('a name another scope wins is shown with hiddenBy, never dropped', () => {
  const f = fixture()
  const { skills } = list(f)
  const project = byName(skills, 'dup-skill', 'agent')!
  const personal = byName(skills, 'dup-skill', 'computer')!
  assert.equal(project.hiddenBy, 'computer')
  assert.equal(personal.hiddenBy, undefined)
})

test('frontmatter: folded blocks, executable keys, and a secret in the description', () => {
  const f = fixture()
  const { skills } = list(f)
  assert.equal(byName(skills, 'folded')!.description, 'First line second line.')
  const runs = byName(skills, 'runs-cmds')!
  assert.equal(runs.shareable, false)
  assert.equal(runs.shareBlock, 'runs_commands')
  const leaky = byName(skills, 'leaky-desc')!
  assert.equal(leaky.description, '', 'the description with a key shape is dropped')
  assert.equal(leaky.shareBlock, 'secret')
  assert.ok(!JSON.stringify(skills).includes(AWS))
})

test('a name with a secret shape drops the whole row', () => {
  const f = fixture()
  skill(join(f.agent, '.claude', 'skills', 'named'), `name: ${AWS}\ndescription: fine`)
  const { skills } = list(f)
  assert.equal(byName(skills, 'named'), undefined)
  assert.ok(!JSON.stringify(skills).includes(AWS))
})

test('only the head of SKILL.md is read, at most FRONTMATTER_READ_MAX bytes', () => {
  const f = fixture()
  const big = join(f.home, 'big.md')
  writeFileSync(big, '---\ndescription: big\n---\n' + 'x'.repeat(200_000))
  const head = readSkillHead(big)
  assert.ok(head.length <= FRONTMATTER_READ_MAX)
  assert.equal(FRONTMATTER_READ_MAX, 8192)
  // a frontmatter that does not close inside the cap is no frontmatter
  assert.equal(parseFrontmatter('---\ndescription: open\n' + 'y'.repeat(9000)), null)
  skill(join(f.agent, '.claude', 'skills', 'long-front'), 'description: late\nnote: ' + 'z'.repeat(9000))
  assert.equal(byName(list(f).skills, 'long-front')!.description, '')
})

test('without BGOS_LAUNCH_CWD there are no agent or repo rows, and the answer says why', () => {
  const f = fixture()
  const { skills, omitted } = list(f, null)
  assert.ok(!skills.some((s) => s.scope === 'agent' || s.scope === 'repo'))
  assert.ok(byName(skills, 'computer-skill', 'computer'))
  assert.deepEqual(omitted, [
    { scope: 'agent', reason: 'no_launch_cwd' },
    { scope: 'repo', reason: 'no_launch_cwd' },
  ])
})

test('an agent folder whose skills ARE the computer skills lists them once, as computer, never removable', () => {
  const f = fixture()
  const { skills, omitted } = listSkills({
    agentDir: f.home,
    configDir: join(f.home, '.claude'),
    home: f.home,
    managedDir: f.managed,
  })
  const row = byName(skills, 'not-in-config')!
  assert.equal(row.scope, 'computer')
  assert.equal(row.removable, false)
  assert.ok(!skills.some((s) => s.scope === 'agent'))
  assert.deepEqual(omitted, [{ scope: 'agent', reason: 'agent_is_computer' }])
})

test('the managed folder per platform', () => {
  assert.equal(managedSkillsDir('darwin', {}), '/Library/Application Support/ClaudeCode/.claude/skills')
  assert.equal(managedSkillsDir('linux', {}), '/etc/claude-code/.claude/skills')
  assert.match(managedSkillsDir('win32', {}), /ClaudeCode[\\/]\.claude[\\/]skills$/)
})

// ── Remove ─────────────────────────────────────────────────────────────────

function remove(
  f: ReturnType<typeof fixture>,
  payload: Record<string, unknown>,
  agentDir: string | null = f.agent,
  extra: { trashDir?: string; configDir?: string; rename?: (from: string, to: string) => void } = {},
) {
  const trashDir = extra.trashDir ?? join(f.home, 'state', 'skills-trash')
  return {
    trashDir,
    answer: removeAgentSkill({
      agentDir,
      configDir: extra.configDir ?? f.config,
      home: f.home,
      trashDir,
      now: () => 1_700_000_000_000,
      payload,
      ...(extra.rename ? { rename: extra.rename } : {}),
    }),
  }
}

test('remove moves an agent skill to the state trash, never a sibling in the skills tree', () => {
  const f = fixture()
  const target = join(f.agent, '.claude', 'skills', 'agent-skill')
  const { trashDir, answer } = remove(f, { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/agent-skill' })
  assert.deepEqual(answer, {
    ok: true,
    removed: { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/agent-skill' },
  })
  assert.ok(!existsSync(target))
  const trashed = readdirSync(trashDir)
  assert.ok(trashed.some((n) => n.endsWith('-agent-skill')), trashed.join(','))
  assert.deepEqual(
    readdirSync(join(f.agent, '.claude', 'skills')).filter((n) => n.includes('agent-skill')),
    [],
    'nothing left beside it in the skills tree',
  )
})

test('remove accepts the exact absolute path of the agent skill', () => {
  const f = fixture()
  const abs = join(f.agent, '.claude', 'skills', 'agent-skill')
  assert.equal(remove(f, { name: 'agent-skill', scope: 'agent', path: abs }).answer.ok, true)
})

test('remove refuses any scope but agent, even with a path that exists', () => {
  const f = fixture()
  for (const scope of ['computer', 'synced', 'repo', 'plugin', 'managed', 'system', undefined]) {
    const { answer } = remove(f, { name: 'computer-skill', scope, path: '~/.claude-work/skills/computer-skill' })
    assert.equal(answer.ok, false, String(scope))
    assert.equal((answer as any).code, 'scope_refused', String(scope))
  }
  assert.ok(existsSync(join(f.config, 'skills', 'computer-skill')))
  // the scope alone refuses: a valid agent path under another scope is not removed
  for (const scope of ['computer', 'synced', 'repo']) {
    const { answer } = remove(f, { name: 'agent-skill', scope, path: '~/repo/agent/.claude/skills/agent-skill' })
    assert.equal((answer as any).code, 'scope_refused', scope)
  }
  assert.ok(existsSync(join(f.agent, '.claude', 'skills', 'agent-skill')))
})

test('remove refuses a path with .. that climbs out of the agent scope', () => {
  const f = fixture()
  const { answer } = remove(f, {
    name: 'computer-skill',
    scope: 'agent',
    path: '~/repo/agent/.claude/skills/../../../../.claude-work/skills/computer-skill',
  })
  assert.equal((answer as any).code, 'scope_refused')
  assert.ok(existsSync(join(f.config, 'skills', 'computer-skill')))
  // a .. that would land back inside is refused too: a path is the listed one or nothing
  const inside = remove(f, { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/x/../agent-skill' })
  assert.equal((inside.answer as any).code, 'scope_refused')
  assert.ok(existsSync(join(f.agent, '.claude', 'skills', 'agent-skill')))
})

test('remove refuses an absolute path outside the agent scope', () => {
  const f = fixture()
  for (const path of [
    join(f.config, 'skills', 'computer-skill'),
    join(f.repo, '.claude', 'skills', 'repo-skill'),
    join(f.agent, '.claude', 'agent-skill'),
    join(f.agent, '.claude', 'skills', 'agent-skill', 'nested'),
    '/etc',
  ]) {
    const { answer } = remove(f, { name: 'computer-skill', scope: 'agent', path })
    assert.equal((answer as any).code, 'scope_refused', path)
  }
  assert.ok(existsSync(join(f.config, 'skills', 'computer-skill')))
  assert.ok(existsSync(join(f.repo, '.claude', 'skills', 'repo-skill')))
})

test('remove refuses when the skills folder of the agent is a symlinked parent', () => {
  const f = fixture()
  const agent2 = join(f.home, 'agent2')
  mkdirSync(join(agent2, '.claude'), { recursive: true })
  symlinkSync(join(f.config, 'skills'), join(agent2, '.claude', 'skills'))
  const { answer } = remove(f, { name: 'computer-skill', scope: 'agent', path: '~/agent2/.claude/skills/computer-skill' }, agent2)
  assert.equal((answer as any).code, 'scope_refused')
  assert.ok(existsSync(join(f.config, 'skills', 'computer-skill')))
  // and a link to a folder that is not the computer's: the link alone refuses
  skill(join(f.home, 'other-skills', 'victim'), 'description: Not this agent own.')
  const agent4 = join(f.home, 'agent4')
  mkdirSync(join(agent4, '.claude'), { recursive: true })
  symlinkSync(join(f.home, 'other-skills'), join(agent4, '.claude', 'skills'))
  const other = remove(f, { name: 'victim', scope: 'agent', path: '~/agent4/.claude/skills/victim' }, agent4)
  assert.equal((other.answer as any).code, 'scope_refused')
  assert.ok(existsSync(join(f.home, 'other-skills', 'victim', 'SKILL.md')))
})

test('remove refuses when .claude itself is a symlinked parent', () => {
  const f = fixture()
  const agent3 = join(f.home, 'agent3')
  mkdirSync(agent3, { recursive: true })
  symlinkSync(f.config, join(agent3, '.claude'))
  const { answer } = remove(f, { name: 'computer-skill', scope: 'agent', path: '~/agent3/.claude/skills/computer-skill' }, agent3)
  assert.equal((answer as any).code, 'scope_refused')
  assert.ok(existsSync(join(f.config, 'skills', 'computer-skill')))
  skill(join(f.home, 'other-claude', 'skills', 'victim'), 'description: Not this agent own.')
  const agent5 = join(f.home, 'agent5')
  mkdirSync(agent5, { recursive: true })
  symlinkSync(join(f.home, 'other-claude'), join(agent5, '.claude'))
  const other = remove(f, { name: 'victim', scope: 'agent', path: '~/agent5/.claude/skills/victim' }, agent5)
  assert.equal((other.answer as any).code, 'scope_refused')
  assert.ok(existsSync(join(f.home, 'other-claude', 'skills', 'victim', 'SKILL.md')))
})

test('remove refuses an agent folder whose skills are the computer skills', () => {
  const f = fixture()
  const trashDir = join(f.home, 'state', 'skills-trash')
  const answer = removeAgentSkill({
    agentDir: f.home,
    configDir: join(f.home, '.claude'),
    home: f.home,
    trashDir,
    now: () => 1,
    payload: { name: 'not-in-config', scope: 'agent', path: '~/.claude/skills/not-in-config' },
  })
  assert.equal((answer as any).code, 'scope_refused')
  assert.ok(existsSync(join(f.home, '.claude', 'skills', 'not-in-config')))
})

test('removing a symlinked skill folder moves the link, never its target', () => {
  const f = fixture()
  const { answer } = remove(f, { name: 'linked-dir', scope: 'agent', path: '~/repo/agent/.claude/skills/linked-dir' })
  assert.equal(answer.ok, true)
  assert.ok(!existsSync(join(f.agent, '.claude', 'skills', 'linked-dir')))
  assert.ok(existsSync(join(f.home, 'elsewhere', 'linked-target', 'SKILL.md')), 'the target is untouched')
})

test('remove: a bad name, a missing skill, a file, and no agent folder', () => {
  const f = fixture()
  assert.equal((remove(f, { name: '../x', scope: 'agent', path: '~/repo/agent/.claude/skills/x' }).answer as any).code, 'bad_request')
  assert.equal((remove(f, { name: 'ok', scope: 'agent', path: 42 }).answer as any).code, 'bad_request')
  assert.equal((remove(f, { name: 'gone', scope: 'agent', path: '~/repo/agent/.claude/skills/gone' }).answer as any).code, 'not_found')
  writeFileSync(join(f.agent, '.claude', 'skills', 'plain-file'), 'x')
  assert.equal((remove(f, { name: 'plain-file', scope: 'agent', path: '~/repo/agent/.claude/skills/plain-file' }).answer as any).code, 'not_found')
  assert.ok(lstatSync(join(f.agent, '.claude', 'skills', 'plain-file')).isFile())
  assert.equal(
    (remove(f, { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/agent-skill' }, null).answer as any).code,
    'unavailable',
  )
  assert.ok(existsSync(join(f.agent, '.claude', 'skills', 'agent-skill')))
})

// ── Review fixes ───────────────────────────────────────────────────────────

test('~/.claude/skills is the computer folder even when CLAUDE_CONFIG_DIR points elsewhere', () => {
  const f = fixture()
  // agent launched in home, config dir moved: ~/.claude/skills is still every session's default
  const { skills, omitted } = listSkills({ agentDir: f.home, configDir: f.config, home: f.home, managedDir: f.managed })
  assert.ok(!skills.some((s) => s.scope === 'agent'), JSON.stringify(skills.filter((s) => s.scope === 'agent')))
  assert.deepEqual(omitted, [{ scope: 'agent', reason: 'agent_is_computer' }])
  const { answer } = remove(f, { name: 'not-in-config', scope: 'agent', path: '~/.claude/skills/not-in-config' }, f.home)
  assert.equal((answer as any).code, 'scope_refused')
  assert.ok(existsSync(join(f.home, '.claude', 'skills', 'not-in-config')))
})

/** Another spelling of the same folder: the last segment of `dir` in upper case. */
function upperLast(dir: string): string {
  const parts = dir.split('/')
  parts[parts.length - 1] = parts[parts.length - 1]!.toUpperCase()
  return parts.join('/')
}

test('the same folder spelled in another case or in NFD is still the computer folder', (t) => {
  const f = fixture()
  if (!existsSync(upperLast(f.home)) || upperLast(f.home) === f.home) {
    t.skip('case sensitive file system')
    return
  }
  const spellings = [upperLast(f.home)]
  const nfc = join(f.home, 'café')
  skill(join(nfc, '.claude', 'skills', 'cafe-skill'), 'description: In a folder with an accent.')
  if (existsSync(join(f.home, 'café'))) spellings.push(join(f.home, 'café'))
  for (const spelled of spellings) {
    const real = spelled === upperLast(f.home) ? f.home : nfc
    const configDir = join(spelled, '.claude')
    const { skills, omitted } = listSkills({ agentDir: real, configDir, home: f.home, managedDir: f.managed })
    assert.ok(!skills.some((s) => s.scope === 'agent' && s.removable), spelled)
    assert.deepEqual(omitted, [{ scope: 'agent', reason: 'agent_is_computer' }], spelled)
    const name = real === nfc ? 'cafe-skill' : 'not-in-config'
    const shown = real === nfc ? '~/café/.claude/skills/cafe-skill' : '~/.claude/skills/not-in-config'
    const { answer } = remove(f, { name, scope: 'agent', path: shown }, real, { configDir })
    assert.equal((answer as any).code, 'scope_refused', spelled)
    assert.ok(existsSync(join(real, '.claude', 'skills', name)), spelled)
  }
})

test('a FIFO in the config dir never blocks the list', () => {
  const f = fixture()
  rmSync(join(f.config, 'plugins', 'installed_plugins.json'))
  const made = spawnSync('mkfifo', [join(f.config, 'plugins', 'installed_plugins.json'), join(f.config, 'settings.json')])
  assert.equal(made.status, 0)
  const script = `import { listSkills } from ${JSON.stringify(new URL('../lib/skills-inventory.ts', import.meta.url).pathname)}
const r = listSkills(${JSON.stringify({ agentDir: f.agent, configDir: f.config, home: f.home, managedDir: f.managed })})
console.log(r.skills.length)`
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 20_000, encoding: 'utf8' })
  assert.equal(run.signal, null, 'the list hung on a FIFO')
  assert.equal(run.status, 0, run.stderr)
  assert.ok(Number(run.stdout.trim()) > 0)
})

test('a failed remove answers a fixed message with no absolute path in it', () => {
  const f = fixture()
  writeFileSync(join(f.home, 'notadir'), 'x')
  const { answer } = remove(f, { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/agent-skill' }, f.agent, {
    trashDir: join(f.home, 'notadir', 'trash'),
  })
  assert.equal((answer as any).code, 'write_failed')
  assert.ok(!(answer as any).message.includes(f.home), (answer as any).message)
  assert.ok(!(answer as any).message.includes('/'), (answer as any).message)
  assert.ok(existsSync(join(f.agent, '.claude', 'skills', 'agent-skill')))
})

test('a trash on another drive refuses with write_failed and moves nothing', () => {
  const f = fixture()
  const { answer } = remove(f, { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/agent-skill' }, f.agent, {
    rename: () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    },
  })
  assert.equal((answer as any).code, 'write_failed')
  assert.match((answer as any).message, /another drive/)
  assert.ok(existsSync(join(f.agent, '.claude', 'skills', 'agent-skill')))
})

test('a parent swapped for a link between the checks and the move is caught and undone', () => {
  const f = fixture()
  skill(join(f.config, 'skills', 'agent-skill'), 'description: The computer copy with the same name.')
  const skillsDir = join(f.agent, '.claude', 'skills')
  const { answer } = remove(f, { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/agent-skill' }, f.agent, {
    rename: (from, to) => {
      // the swap: the agent's skills folder becomes a link to the computer's
      renameSync(skillsDir, skillsDir + '-moved')
      symlinkSync(join(f.config, 'skills'), skillsDir)
      renameSync(from, to)
    },
  })
  assert.equal((answer as any).code, 'scope_refused', JSON.stringify(answer))
  assert.ok(existsSync(join(f.config, 'skills', 'agent-skill', 'SKILL.md')), 'the computer skill is back where it was')
})

test('a trash folder inside any skills root is refused', () => {
  const f = fixture()
  for (const trashDir of [
    join(f.config, 'skills', 'trash'),
    join(f.home, '.claude', 'skills', 'trash'),
    join(f.repo, '.claude', 'skills', 'trash'),
  ]) {
    const { answer } = remove(f, { name: 'agent-skill', scope: 'agent', path: '~/repo/agent/.claude/skills/agent-skill' }, f.agent, { trashDir })
    assert.equal((answer as any).code, 'write_failed', trashDir)
    assert.ok(!existsSync(trashDir), trashDir)
  }
  assert.ok(existsSync(join(f.agent, '.claude', 'skills', 'agent-skill')))
})

test('the list never marks a row removable that Remove would refuse (a linked skills folder)', () => {
  const f = fixture()
  skill(join(f.home, 'other-skills', 'victim'), 'description: Not this agent own.')
  const agent4 = join(f.home, 'agent4')
  mkdirSync(join(agent4, '.claude'), { recursive: true })
  symlinkSync(join(f.home, 'other-skills'), join(agent4, '.claude', 'skills'))
  const { skills } = listSkills({ agentDir: agent4, configDir: f.config, home: f.home, managedDir: f.managed })
  const row = byName(skills, 'victim', 'agent')!
  assert.ok(row)
  assert.equal(row.removable, false)
})

test('a hard linked SKILL.md is never read', () => {
  const f = fixture()
  const dir = join(f.agent, '.claude', 'skills', 'hardlinked')
  mkdirSync(dir, { recursive: true })
  linkSync(join(f.home, 'secret.txt'), join(dir, 'SKILL.md'))
  const { skills } = list(f)
  assert.equal(byName(skills, 'hardlinked'), undefined)
  assert.ok(!JSON.stringify(skills).includes(LEAK))
})

test('remove needs the name of the folder the path names, or its listed name', () => {
  const f = fixture()
  const wrong = remove(f, { name: 'zzz', scope: 'agent', path: '~/repo/agent/.claude/skills/agent-skill' })
  assert.equal((wrong.answer as any).code, 'bad_request')
  assert.ok(existsSync(join(f.agent, '.claude', 'skills', 'agent-skill')))
  skill(join(f.agent, '.claude', 'skills', 'folder-x'), 'name: shown-x\ndescription: listed as shown-x')
  assert.equal(remove(f, { name: 'shown-x', scope: 'agent', path: '~/repo/agent/.claude/skills/folder-x' }).answer.ok, true)
})

test('a root lists at most SKILLS_ROOT_MAX skills', () => {
  const f = fixture()
  for (let i = 0; i < SKILLS_ROOT_MAX + 5; i++) skill(join(f.config, 'skills', `bulk-${String(i).padStart(4, '0')}`), 'description: bulk')
  const { skills } = list(f)
  assert.ok(skills.filter((s) => s.scope === 'computer').length <= SKILLS_ROOT_MAX)
})

test.after(() => {
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith('skills-inv-')) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
})
