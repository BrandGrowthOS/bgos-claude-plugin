/**
 * Exact file identities past 2^53, deterministically (the third review round's
 * bigint change). NTFS file ids pass 2^53 on a churned volume, but a fresh
 * temp folder rarely hands one out, so a test on real ids alone cannot fail
 * when an identity goes back to a Number stat. Here node:fs's statSync,
 * lstatSync and fstatSync answer a chosen ino above 2^53 for the fixture's
 * own files, through the module the lib imports (syncBuiltinESMExports), and
 * the REAL code paths run on them: identOf, Remove's target identity, the edit
 * path's identities (idOf) and the id readHead hands its caller.
 *
 * Only a stat asked with { bigint: true } carries the exact ino; a Number stat
 * of the same file carries Number(ino), rounded exactly as a real Number stat
 * of such a file is. Every other file keeps its real stat.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sha256Hex } from '../lib/skill-share-content-rules.ts'
import { identOf, removeAgentSkill } from '../lib/skills-inventory.ts'
import { writeAgentSkill } from '../lib/skills-edit.ts'
import { readHead } from '../lib/skills-share.ts'

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')

const ODD = 2n ** 53n + 1n // 9007199254740993: a Number rounds it to 9007199254740992
const EVEN = 2n ** 53n + 2n // 9007199254740994
const COLLIDES = 2n ** 53n // 9007199254740992: the Number of ODD, a different file

/** The fake ino of a file, keyed by its real dev:ino (a rename keeps it). */
const fakes = new Map<string, bigint>()
let calls = 0

type AnyStat = { dev: number | bigint; ino: number | bigint } | undefined

function install(): () => void {
  const real = { statSync: fs.statSync, lstatSync: fs.lstatSync, fstatSync: fs.fstatSync }
  const wrap = <F extends (...a: any[]) => any>(orig: F): F =>
    ((target: unknown, opts?: { bigint?: boolean }) => {
      const st = (orig as any)(target, opts) as AnyStat
      if (!st) return st
      // the real exact identity, whatever was asked, to find the fake
      const exact = opts?.bigint ? (st as { dev: bigint; ino: bigint }) : (orig as any)(target, { ...opts, bigint: true })
      const fake = exact ? fakes.get(`${exact.dev}:${exact.ino}`) : undefined
      if (fake === undefined) return st
      calls++
      ;(st as { ino: number | bigint }).ino = opts?.bigint ? fake : Number(fake)
      return st
    }) as unknown as F
  ;(fs as any).statSync = wrap(real.statSync)
  ;(fs as any).lstatSync = wrap(real.lstatSync)
  ;(fs as any).fstatSync = wrap(real.fstatSync)
  syncBuiltinESMExports()
  return () => {
    ;(fs as any).statSync = real.statSync
    ;(fs as any).lstatSync = real.lstatSync
    ;(fs as any).fstatSync = real.fstatSync
    syncBuiltinESMExports()
    fakes.clear()
  }
}

/** Gives `path` the fake ino `ino` from now on (by its real identity). */
function fake(path: string, ino: bigint): void {
  const st = fs.lstatSync(path, { bigint: true })
  fakes.set(`${st.dev}:${st.ino}`, ino)
}

const devOf = (path: string) => fs.lstatSync(path, { bigint: true }).dev.toString()

const AGENT_SKILL = '---\nname: agent-skill\ndescription: Does the agent thing.\n---\nBody text.\n'
const EDITED = '---\nname: agent-skill\ndescription: Does the agent thing, better.\n---\nA new body.\n'
const AGENT_PATH = '~/repo/agent/.claude/skills/agent-skill'

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'skills-ident-')))
  const agent = join(home, 'repo', 'agent')
  const skills = join(agent, '.claude', 'skills')
  const config = join(home, '.claude-work')
  const managed = join(home, 'managed', 'skills')
  const trash = join(home, 'state', 'skills-trash')
  mkdirSync(join(home, 'repo', '.git'), { recursive: true })
  mkdirSync(join(skills, 'agent-skill'), { recursive: true })
  writeFileSync(join(skills, 'agent-skill', 'SKILL.md'), AGENT_SKILL)
  mkdirSync(join(skills, 'other-skill'), { recursive: true })
  writeFileSync(join(skills, 'other-skill', 'SKILL.md'), '---\nname: other-skill\n---\n')
  mkdirSync(join(config, 'skills'), { recursive: true })
  mkdirSync(managed, { recursive: true })
  return { home, agent, skills, config, managed, trash, target: join(skills, 'agent-skill'), md: join(skills, 'agent-skill', 'SKILL.md') }
}

test('the fake reaches the lib: a bigint stat carries the exact ino, a Number one the rounded one', (t) => {
  const restore = install()
  t.after(restore)
  const f = fixture()
  fake(f.target, ODD)
  assert.equal(fs.statSync(f.target, { bigint: true }).ino, ODD)
  assert.equal(fs.statSync(f.target).ino, 9007199254740992)
  const before = calls
  identOf(f.target)
  assert.ok(calls > before, 'identOf went through the faked statSync')
})

test('identOf keeps every digit of two inos past 2^53, so two files never share an identity', (t) => {
  const restore = install()
  t.after(restore)
  const f = fixture()
  fake(f.target, ODD)
  fake(join(f.skills, 'other-skill'), EVEN)
  const dev = devOf(f.target)
  for (const follow of [true, false]) {
    const a = identOf(f.target, follow)
    const b = identOf(join(f.skills, 'other-skill'), follow)
    assert.equal(a, `${dev}:9007199254740993`, `follow ${follow}`)
    assert.equal(b, `${dev}:9007199254740994`, `follow ${follow}`)
    assert.notEqual(a, b)
  }
  // a file whose ino rounds to the same Number is still another file
  fake(join(f.skills, 'other-skill'), COLLIDES)
  assert.notEqual(identOf(f.target), identOf(join(f.skills, 'other-skill')))
})

test('readHead hands the exact identity of the file it opened', (t) => {
  const restore = install()
  t.after(restore)
  const f = fixture()
  const other = join(f.skills, 'other-skill', 'SKILL.md')
  fake(f.md, ODD)
  fake(other, EVEN)
  const ids: string[] = []
  assert.ok(readHead(f.md, 1024, { stat: (_st, id) => ids.push(id) }))
  assert.ok(readHead(other, 1024, { stat: (_st, id) => ids.push(id) }))
  const dev = devOf(f.md)
  assert.deepEqual(ids, [`${dev}:9007199254740993`, `${dev}:9007199254740994`])
})

function remove(f: ReturnType<typeof fixture>, rename?: (from: string, to: string) => void) {
  return removeAgentSkill({
    agentDir: f.agent,
    configDir: f.config,
    home: f.home,
    managedDir: f.managed,
    trashDir: f.trash,
    now: () => 1_700_000_000_000,
    payload: { name: 'agent-skill', scope: 'agent', path: AGENT_PATH },
    ...(rename ? { rename } : {}),
  })
}

test("Remove's target identity is exact: the moved folder is the one it checked", (t) => {
  const restore = install()
  t.after(restore)
  const f = fixture()
  fake(f.target, ODD)
  fake(join(f.skills, 'other-skill'), EVEN)
  const answer = remove(f)
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.equal(existsSync(f.target), false)
})

test('Remove puts back a folder swapped in whose ino only a Number would confuse with the target', (t) => {
  const restore = install()
  t.after(restore)
  const f = fixture()
  const decoy = join(f.home, 'decoy')
  mkdirSync(decoy)
  writeFileSync(join(decoy, 'SKILL.md'), AGENT_SKILL)
  fake(f.target, ODD)
  fake(decoy, COLLIDES)
  const away = join(f.home, 'away')
  const answer = remove(f, (from, to) => {
    renameSync(from, away)
    renameSync(decoy, to)
  })
  assert.equal(answer.ok, false, JSON.stringify(answer))
  if (!answer.ok) assert.equal(answer.code, 'scope_refused')
  assert.equal(existsSync(away), true, 'the real skill was moved aside by the swap, not trashed by Remove')
})

function write(f: ReturnType<typeof fixture>, step?: (at: 'open_temp' | 'opened' | 'wrote' | 'recheck') => void) {
  return writeAgentSkill({
    agentDir: f.agent,
    configDir: f.config,
    home: f.home,
    managedDir: f.managed,
    trashDir: f.trash,
    now: () => 1_700_000_000_000,
    platform: process.platform,
    payload: { name: 'agent-skill', scope: 'agent', path: AGENT_PATH, content: EDITED, expectSha256: sha256Hex(AGENT_SKILL) },
    ...(step ? { step } : {}),
  })
}

test('an edit saves when the folder and SKILL.md carry inos past 2^53 (its identities are exact)', (t) => {
  const restore = install()
  t.after(restore)
  const f = fixture()
  fake(f.target, EVEN)
  fake(f.md, ODD)
  const answer = write(f)
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.equal(readFileSync(f.md, 'utf8'), EDITED)
})

test('an edit refuses a SKILL.md swapped in whose ino only a Number would confuse with the one it read', (t) => {
  const restore = install()
  t.after(restore)
  const f = fixture()
  // the same bytes, so only the identity tells the two files apart
  const decoy = join(f.home, 'decoy.md')
  writeFileSync(decoy, AGENT_SKILL)
  fake(f.target, EVEN)
  fake(f.md, ODD)
  fake(decoy, COLLIDES)
  const answer = write(f, (at) => {
    if (at === 'recheck') renameSync(decoy, f.md)
  })
  assert.equal(answer.ok, false, JSON.stringify(answer))
  if (!answer.ok) assert.equal(answer.code, 'changed_since_preview')
  assert.equal(readFileSync(f.md, 'utf8'), AGENT_SKILL, 'the swapped in file was not overwritten')
  assert.deepEqual(readdirSync(f.target).filter((n) => n.startsWith('.SKILL.md.hoai-edit-')), [], 'no temp left')
})

test.after(() => {
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith('skills-ident-')) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
})
