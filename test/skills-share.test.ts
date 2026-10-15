/**
 * Share a skill, Claude Code part (skills view design, section 7 row 6):
 * export_skill reads one skill folder symlink safe and answers what the shared
 * content rules send; install_bundle writes an approved bundle into the
 * agent's OWN skills folder and nowhere else.
 *
 * Every case runs on a real folder tree under the OS temp folder, with a fake
 * home, so a write outside the agent scope would land somewhere this test can
 * see.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { bundleSha256, sha256Hex } from '../lib/skill-share-content-rules.ts'
import { exportSkill, installBundle, readSkillFolder } from '../lib/skills-share.ts'
import { fileSymlinkRefused, linkFolder } from './helpers/links.ts'

const SKILL = '---\nname: notes\ndescription: Take notes.\n---\n\n# Notes\n'

type World = { root: string; home: string; agent: string; config: string; managed: string; trash: string }

function world(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skills-share-')))
  const home = join(root, 'home')
  const agent = join(home, 'agents', 'data')
  const config = join(home, '.claude')
  mkdirSync(agent, { recursive: true })
  mkdirSync(join(config, 'skills'), { recursive: true })
  return { root, home, agent, config, managed: join(root, 'managed'), trash: join(home, 'state', 'skills-trash') }
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function agentSkill(w: World, name: string, files: Record<string, string | Buffer>): string {
  const dir = join(w.agent, '.claude', 'skills', name)
  for (const [rel, content] of Object.entries(files)) write(join(dir, rel), content)
  return dir
}

function exp(w: World, payload: Record<string, unknown>, agentDir: string | null = w.agent) {
  return exportSkill({ agentDir, configDir: w.config, home: w.home, managedDir: w.managed, payload })
}

function bundle(files: Array<{ path: string; content: string }>, extra: Record<string, unknown> = {}) {
  const withSha = files.map((f) => ({ ...f, sha256: sha256Hex(f.content) }))
  return {
    offerId: 'offer-1',
    name: 'notes',
    files: withSha,
    sha256: bundleSha256(withSha.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content), sha256: f.sha256 }))),
    ...extra,
  }
}

function inst(
  w: World,
  payload: Record<string, unknown>,
  opts: { agentDir?: string | null; platform?: NodeJS.Platform; rename?: (a: string, b: string) => void } = {},
) {
  const stages: string[] = []
  return installBundle({
    agentDir: opts.agentDir === undefined ? w.agent : opts.agentDir,
    configDir: w.config,
    home: w.home,
    managedDir: w.managed,
    trashDir: w.trash,
    // the host's own, as server.ts passes it: a win32 host takes the win32 branch
    platform: opts.platform ?? process.platform,
    now: () => 1_700_000_000_000,
    payload,
    progress: (s) => {
      stages.push(s)
    },
    ...(opts.rename ? { rename: opts.rename } : {}),
  }).then((answer) => ({ answer, stages }))
}

/** Every file under a folder, relative, for "nothing else was written" checks. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (at: string, rel: string) => {
    for (const n of readdirSync(at).sort()) {
      const abs = join(at, n)
      const r = rel ? `${rel}/${n}` : n
      if (statSync(abs).isDirectory()) walk(abs, r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out
}

// ── export_skill ────────────────────────────────────────────────────────────

test('export reads an agent skill: text files with their sha256, scripts and dot folders left behind', () => {
  const w = world()
  agentSkill(w, 'notes', {
    'SKILL.md': SKILL,
    'reference/terms.md': 'Terms.\n',
    'scripts/run.sh': 'echo hi\n',
    '.git/config': 'x\n',
  })
  const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  assert.equal(answer.ok, true)
  if (!answer.ok) return
  const p = answer.payload
  assert.deepEqual(
    p.files.map((f) => [f.path, f.content, f.sha256]),
    [
      ['SKILL.md', SKILL, sha256Hex(SKILL)],
      ['reference/terms.md', 'Terms.\n', sha256Hex('Terms.\n')],
    ],
  )
  assert.equal(p.sha256, bundleSha256(p.files))
  assert.equal(p.description, 'Take notes.')
  assert.equal(p.rulesVersion, 1)
  assert.equal(p.block, undefined)
  assert.deepEqual(p.excluded, [
    { path: 'scripts/run.sh', reason: 'not_text' },
    { path: '.git', reason: 'hidden' },
  ])
})

test('export never reads a link that leaves the skill folder, nor a hard linked file', { skip: fileSymlinkRefused }, () => {
  const w = world()
  const dir = agentSkill(w, 'notes', { 'SKILL.md': SKILL })
  write(join(w.home, 'private.md'), 'PRIVATE-MARKER\n')
  symlinkSync(join(w.home, 'private.md'), join(dir, 'escape.md'))
  symlinkSync(w.home, join(dir, 'homelink'))
  linkSync(join(w.home, 'private.md'), join(dir, 'hard.md'))
  const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  assert.equal(answer.ok, true)
  if (!answer.ok) return
  assert.ok(!JSON.stringify(answer).includes('PRIVATE-MARKER'))
  assert.deepEqual(
    answer.payload.files.map((f) => f.path),
    ['SKILL.md'],
  )
  assert.deepEqual(answer.payload.excluded, [
    { path: 'escape.md', reason: 'symlink' },
    { path: 'hard.md', reason: 'outside' },
    { path: 'homelink', reason: 'symlink' },
  ])
})

test('export never follows a link inside the folder either: it could name a dot file under a harmless name', { skip: fileSymlinkRefused }, () => {
  const w = world()
  const dir = agentSkill(w, 'notes', { 'SKILL.md': SKILL, '.private/creds.md': 'DB pw is HIDDEN-MARKER\n', '.env': 'PW=x\n' })
  symlinkSync(join(dir, '.private', 'creds.md'), join(dir, 'notes.md'))
  symlinkSync(join(dir, '.env'), join(dir, 'env.txt'))
  const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: false })
  assert.ok(answer.ok)
  if (!answer.ok) return
  assert.ok(!JSON.stringify(answer).includes('HIDDEN-MARKER'))
  assert.deepEqual(
    answer.payload.files.map((f) => f.path),
    ['SKILL.md'],
  )
  assert.ok(answer.payload.excluded.some((e) => e.path === 'notes.md' && e.reason === 'symlink'))
  assert.ok(answer.payload.excluded.some((e) => e.path === 'env.txt' && e.reason === 'symlink'))
})

test('files left behind as not text do not use up the read budget, and a folder past it is too large, never sent empty', () => {
  const w = world()
  const latin1 = Buffer.alloc(60 * 1024, 0xe9)
  agentSkill(w, 'notes', {
    'A1.csv': latin1,
    'A2.csv': latin1,
    'A3.csv': latin1,
    'A4.csv': latin1,
    'A5.csv': latin1,
    'SKILL.md': SKILL,
    'reference.md': 'Ref.\n',
  })
  const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: false })
  assert.ok(answer.ok)
  if (!answer.ok) return
  assert.deepEqual(
    answer.payload.files.map((f) => [f.path, f.content]),
    [
      ['SKILL.md', SKILL],
      ['reference.md', 'Ref.\n'],
    ],
  )
  const big = world()
  const files: Record<string, string> = { 'SKILL.md': SKILL }
  for (let i = 0; i < 60; i++) files[`r/${String(i).padStart(2, '0')}.md`] = 'x\n'
  agentSkill(big, 'notes', files)
  const tooMany = exp(big, { name: 'notes', scope: 'agent', dryRun: true })
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) assert.equal(tooMany.message, 'this skill cannot be shared (too_large)')
})

test('a file that cannot be read refuses the export rather than leave it out silently (chmod, not on Windows: mode bits do not gate reads there)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const w = world()
  const dir = agentSkill(w, 'notes', { 'SKILL.md': SKILL, 'reference.md': 'Ref.\n' })
  chmodSync(join(dir, 'reference.md'), 0o000)
  const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  chmodSync(join(dir, 'reference.md'), 0o644)
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'read_failed')
})

test('a shell fence opened anywhere in a line is refused, on export and on install', async () => {
  for (const body of ['Step one, run this: ```!\ntouch /tmp/x\n```\n', '> ```!\nid\n```\n', '- ~~~!\nid\n~~~\n']) {
    const w = world()
    agentSkill(w, 'notes', { 'SKILL.md': SKILL + body })
    const preview = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
    assert.ok(preview.ok)
    if (preview.ok) assert.equal(preview.payload.block, 'runs_commands', body)
    const real = exp(w, { name: 'notes', scope: 'agent', dryRun: false })
    assert.equal(real.ok, false, body)
    const { answer } = await inst(w, bundle([{ path: 'SKILL.md', content: SKILL + body }], { name: 'other' }))
    assert.equal(answer.ok, false, body)
    if (!answer.ok) assert.equal(answer.code, 'scope_refused')
    assert.ok(!existsSync(join(w.agent, '.claude', 'skills', 'other')))
  }
})

test('a blocked skill answers its verdict for the preview, and is refused for the real export', () => {
  const w = world()
  agentSkill(w, 'notes', { 'SKILL.md': '---\nname: notes\nhooks: x\n---\n' })
  const preview = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  assert.ok(preview.ok)
  if (preview.ok) assert.equal(preview.payload.block, 'runs_commands')
  const real = exp(w, { name: 'notes', scope: 'agent', dryRun: false })
  assert.deepEqual(real.ok, false)
  if (!real.ok) assert.equal(real.code, 'share_blocked')
  assert.ok(!JSON.stringify(real).includes('hooks'))
})

test('a skill holding a secret is refused even for the preview, and its content never leaves', () => {
  const w = world()
  const key = ['AKIA', 'IOSFODNN7', 'REALKEY'].join('')
  agentSkill(w, 'notes', { 'SKILL.md': SKILL + `aws_access_key_id = ${key}\n` })
  for (const dryRun of [true, false, undefined, 'true']) {
    const answer = exp(w, { name: 'notes', scope: 'agent', dryRun })
    assert.equal(answer.ok, false, String(dryRun))
    if (!answer.ok) assert.equal(answer.code, 'share_blocked')
    assert.ok(!JSON.stringify(answer).includes('IOSFODNN7'))
  }
})

test('a secret never leaves on a preview even when another block outranks it', () => {
  const key = ['AKIA', 'IOSFODNN7', 'REALKEY'].join('')
  const line = `aws_access_key_id = ${key}\n`
  const cases: Array<Record<string, string>> = [
    { 'SKILL.md': SKILL + line, 'big.md': 'x'.repeat(70 * 1024) },
    { 'SKILL.md': SKILL + line, 'nul.md': 'a\u0000b' },
    { 'README.md': line },
  ]
  for (const files of cases) {
    const w = world()
    agentSkill(w, 'notes', files)
    const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
    assert.ok(!JSON.stringify(answer).includes('IOSFODNN7'), Object.keys(files).join(','))
  }
})

test('a secret shaped name the walk leaves behind is never listed, the export is refused', { skip: fileSymlinkRefused }, () => {
  const w = world()
  const dir = agentSkill(w, 'notes', { 'SKILL.md': SKILL })
  const name = ['AKIA', 'IOSFODNN7', 'EXAMPLQ'].join('') + '.md'
  symlinkSync(join(w.root, 'nowhere'), join(dir, name))
  for (const dryRun of [true, false]) {
    const answer = exp(w, { name: 'notes', scope: 'agent', dryRun })
    assert.equal(answer.ok, false)
    assert.ok(!JSON.stringify(answer).includes('IOSFODNN7'))
  }
})

test('a subfolder that cannot be listed refuses the export rather than leave its files out (chmod, not on Windows: mode bits do not gate reads there)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const w = world()
  const dir = agentSkill(w, 'notes', { 'SKILL.md': SKILL, 'sub/c.md': 'C\n' })
  chmodSync(join(dir, 'sub'), 0o000)
  const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  chmodSync(join(dir, 'sub'), 0o755)
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'read_failed')
})

/** Windows: deny this user a right on a path with an ACL, the way Windows makes a file unreadable. */
function denyAcl(path: string, right: string): () => void {
  const who = userInfo().username
  execFileSync('icacls', [path, '/deny', `${who}:(${right})`], { stdio: 'ignore' })
  return () => execFileSync('icacls', [path, '/remove:d', who], { stdio: 'ignore' })
}

function throwsNow(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

test('Windows: a file its ACL denies reading refuses the export rather than leave it out silently (skips where an elevated runner reads through the deny)', { skip: process.platform !== 'win32' }, (t) => {
  const w = world()
  const dir = agentSkill(w, 'notes', { 'SKILL.md': SKILL, 'reference.md': 'Ref.\n' })
  const undo = denyAcl(join(dir, 'reference.md'), 'R')
  let answer
  try {
    if (!throwsNow(() => readFileSync(join(dir, 'reference.md')))) {
      t.skip('this account reads through a deny ACL (an elevated runner), so nothing here is unreadable')
      return
    }
    answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  } finally {
    undo()
  }
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'read_failed')
})

test('Windows: a subfolder its ACL denies listing refuses the export rather than leave its files out (skips where an elevated runner lists through the deny)', { skip: process.platform !== 'win32' }, (t) => {
  const w = world()
  const dir = agentSkill(w, 'notes', { 'SKILL.md': SKILL, 'sub/c.md': 'C\n' })
  const undo = denyAcl(join(dir, 'sub'), 'RD')
  let answer
  try {
    if (!throwsNow(() => readdirSync(join(dir, 'sub')))) {
      t.skip('this account lists through a deny ACL (an elevated runner), so nothing here is unlistable')
      return
    }
    answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  } finally {
    undo()
  }
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'read_failed')
})

test('export reads no folder the list does not show as a skill', () => {
  const w = world()
  agentSkill(w, 'notes', { 'README.md': 'not a skill\n' })
  const noMd = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  assert.equal(noMd.ok, false)
  if (!noMd.ok) assert.equal(noMd.code, 'not_found')
  const v = world()
  write(join(v.home, 'outside.md'), SKILL)
  const dir = join(v.agent, '.claude', 'skills', 'notes')
  mkdirSync(dir, { recursive: true })
  linkSync(join(v.home, 'outside.md'), join(dir, 'SKILL.md'))
  const hard = exp(v, { name: 'notes', scope: 'agent', dryRun: true })
  assert.equal(hard.ok, false)
})

test('only a literal dryRun true is a preview', () => {
  const w = world()
  agentSkill(w, 'notes', { 'SKILL.md': '---\nname: notes\nhooks: x\n---\n' })
  for (const dryRun of [undefined, 'true', 1, null]) {
    const answer = exp(w, { name: 'notes', scope: 'agent', dryRun })
    assert.equal(answer.ok, false, String(dryRun))
  }
})

test('export of a clean skill is the same with dryRun false', () => {
  const w = world()
  agentSkill(w, 'notes', { 'SKILL.md': SKILL })
  assert.deepEqual(
    exp(w, { name: 'notes', scope: 'agent', dryRun: false }),
    exp(w, { name: 'notes', scope: 'agent', dryRun: true }),
  )
})

test('export of a computer skill reads the config dir, never synced', () => {
  const w = world()
  write(join(w.config, 'skills', 'notes', 'SKILL.md'), SKILL)
  write(join(w.config, 'skills', 'synced', 'SKILL.md'), SKILL)
  const answer = exp(w, { name: 'notes', scope: 'computer', dryRun: true })
  assert.ok(answer.ok)
  const synced = exp(w, { name: 'synced', scope: 'computer', dryRun: true })
  assert.equal(synced.ok, false)
  if (!synced.ok) assert.equal(synced.code, 'scope_refused')
})

test('export refuses a bad name, another scope, an agent folder that is the computer one, and a missing launch folder', () => {
  const w = world()
  agentSkill(w, 'notes', { 'SKILL.md': SKILL })
  const code = (a: ReturnType<typeof exp>) => (a.ok ? 'ok' : a.code)
  assert.equal(code(exp(w, { name: '../notes', scope: 'agent' })), 'bad_request')
  assert.equal(code(exp(w, { name: 'Notes', scope: 'agent' })), 'bad_request')
  for (const scope of ['repo', 'plugin', 'synced', 'managed', undefined]) {
    assert.equal(code(exp(w, { name: 'notes', scope })), 'scope_refused', String(scope))
  }
  // an agent launched in the home folder: its .claude/skills IS the computer's
  write(join(w.config, 'skills', 'notes', 'SKILL.md'), SKILL)
  assert.equal(code(exp(w, { name: 'notes', scope: 'agent' }, w.home)), 'scope_refused')
  assert.equal(code(exp(w, { name: 'notes', scope: 'agent' }, null)), 'unavailable')
  assert.equal(code(exp(w, { name: 'nothere', scope: 'agent' })), 'not_found')
})

test('export finds a skill by the name its list row showed, never a folder another row is named by', () => {
  const w = world()
  agentSkill(w, 'folder-x', { 'SKILL.md': SKILL })
  const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  assert.ok(answer.ok)
  // folder alpha is listed as beta, folder beta as gamma: row beta is folder alpha
  const v = world()
  agentSkill(v, 'alpha', { 'SKILL.md': '---\nname: beta\n---\nALPHA\n' })
  agentSkill(v, 'beta', { 'SKILL.md': '---\nname: gamma\n---\nBETA\n' })
  const beta = exp(v, { name: 'beta', scope: 'agent', dryRun: true })
  assert.ok(beta.ok)
  if (beta.ok) assert.ok(beta.payload.files[0]!.content.includes('ALPHA'))
  // two rows of one name: which one is meant cannot be told
  agentSkill(v, 'other', { 'SKILL.md': '---\nname: gamma\n---\n' })
  const both = exp(v, { name: 'gamma', scope: 'agent', dryRun: true })
  assert.equal(both.ok, false)
  if (!both.ok) assert.equal(both.code, 'bad_request')
})

test('a file that is not UTF-8 stays behind as not text, and a huge one is never read whole', () => {
  const w = world()
  agentSkill(w, 'notes', {
    'SKILL.md': SKILL,
    'bad.md': Buffer.from([0xc3, 0x28, 0x0a]),
    'big.md': 'x'.repeat(5 * 1024 * 1024),
  })
  const answer = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  // too large: no content leaves, not even for the preview
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'share_blocked')
  // the not UTF-8 file alone stays behind, the rest shares
  rmSync(join(w.agent, '.claude', 'skills', 'notes', 'big.md'))
  const small = exp(w, { name: 'notes', scope: 'agent', dryRun: true })
  assert.ok(small.ok)
  if (small.ok) assert.ok(small.payload.excluded.some((e) => e.path === 'bad.md' && e.reason === 'not_text'))
})

test('a too large file cut mid secret never sends the part before the cut', () => {
  const w = world()
  const key = ['AKIA', 'Q7XRTZ3MPLKW9DJ', 'X'].join('')
  const big = 'x'.repeat(64 * 1024 - 18) + `id ${key}\n`
  agentSkill(w, 'notes', { 'SKILL.md': SKILL, 'big.md': big })
  for (const dryRun of [true, false]) {
    const answer = exp(w, { name: 'notes', scope: 'agent', dryRun })
    assert.equal(answer.ok, false)
    assert.ok(!JSON.stringify(answer).includes('Q7XRTZ'))
  }
})

test('export never reaches a skill the list hides for a secret shaped name', () => {
  const w = world()
  const folder = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-')
  agentSkill(w, folder, { 'SKILL.md': '---\nname: benign\n---\n' })
  assert.equal(exp(w, { name: 'benign', scope: 'agent', dryRun: true }).ok, false)
})

// ── install_bundle ──────────────────────────────────────────────────────────

const FILES = [
  { path: 'SKILL.md', content: SKILL },
  { path: 'reference/terms.md', content: 'Terms.\n' },
]

test('install writes the bundle into the agent skills folder, through a temp folder, with progress', async () => {
  const w = world()
  const { answer, stages } = await inst(w, bundle(FILES))
  assert.deepEqual(answer, { ok: true, payload: { path: '~/agents/data/.claude/skills/notes', name: 'notes' } })
  assert.deepEqual(stages, ['verifying', 'writing'])
  const dest = join(w.agent, '.claude', 'skills', 'notes')
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), SKILL)
  assert.equal(readFileSync(join(dest, 'reference', 'terms.md'), 'utf8'), 'Terms.\n')
  // nothing left beside it, no temp folder, nothing in the computer folder
  assert.deepEqual(readdirSync(join(w.agent, '.claude')), ['skills'])
  assert.deepEqual(tree(join(w.config, 'skills')), [])
})

test('a file whose content does not match its sha256 is refused, nothing written', async () => {
  const w = world()
  const b = bundle(FILES)
  // Tampered content, and a whole bundle sha256 recomputed to match it: only
  // the file's own stale sha256 still tells.
  b.files[1]!.content = 'Tampered.\n'
  b.sha256 = bundleSha256(
    b.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha256Hex(f.content) })),
  )
  const { answer } = await inst(w, b)
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'hash_mismatch')
  assert.ok(!existsSync(join(w.agent, '.claude')))
})

test('a bundle whose whole sha256 does not match is refused, nothing written', async () => {
  const w = world()
  const { answer } = await inst(w, bundle(FILES, { sha256: 'a'.repeat(64) }))
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'hash_mismatch')
  assert.ok(!existsSync(join(w.agent, '.claude')))
})

for (const [label, path] of [
  ['a .. segment', '../../../escaped.md'],
  ['a nested .. segment', 'reference/../../escaped.md'],
  ['an absolute path', '/tmp/escaped.md'],
  ['a backslash path', '..\\..\\escaped.md'],
  ['a Windows drive path', 'C:/escaped.md'],
] as const) {
  test(`a bundle path with ${label} is refused before anything is written`, async () => {
    const w = world()
    const { answer } = await inst(w, bundle([...FILES, { path, content: 'x\n' }]))
    assert.equal(answer.ok, false)
    if (!answer.ok) assert.equal(answer.code, 'scope_refused')
    assert.ok(!existsSync(join(w.agent, '.claude')))
    assert.deepEqual(tree(w.root).filter((p) => p.includes('escaped')), [])
  })
}

test('a skill name that is not Claude Code rule is refused, nothing written', async () => {
  const w = world()
  for (const name of ['../evil', 'a/b', '.claude', 'Notes', '']) {
    const { answer } = await inst(w, bundle(FILES, { name }))
    assert.equal(answer.ok, false, name)
    if (!answer.ok) assert.equal(answer.code, 'scope_refused', name)
  }
  assert.ok(!existsSync(join(w.agent, '.claude')))
})

test('a symlinked .claude parent is refused and nothing is written through it', async () => {
  const w = world()
  const elsewhere = join(w.root, 'elsewhere')
  mkdirSync(join(elsewhere, 'skills'), { recursive: true })
  linkFolder(elsewhere, join(w.agent, '.claude'))
  const { answer } = await inst(w, bundle(FILES))
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'scope_refused')
  assert.deepEqual(tree(elsewhere), [])
})

test('a symlinked .claude/skills parent (into the computer folder) is refused', async () => {
  const w = world()
  mkdirSync(join(w.agent, '.claude'))
  linkFolder(join(w.config, 'skills'), join(w.agent, '.claude', 'skills'))
  const { answer } = await inst(w, bundle(FILES))
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'scope_refused')
  assert.deepEqual(tree(join(w.config, 'skills')), [])
})

test('an agent launched in the home folder never installs into the computer skills folder', async () => {
  const w = world()
  const { answer } = await inst(w, bundle(FILES), { agentDir: w.home })
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'scope_refused')
  assert.deepEqual(tree(join(w.config, 'skills')), [])
})

test('an agent launched inside the computer skills folder is refused too', async () => {
  const w = world()
  const inner = join(w.config, 'skills', 'deep')
  mkdirSync(inner, { recursive: true })
  const { answer } = await inst(w, bundle(FILES), { agentDir: inner })
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'scope_refused')
  assert.deepEqual(tree(join(w.config, 'skills')), [])
})

test('with no launch folder there is no agent scope to write to', async () => {
  const w = world()
  const { answer } = await inst(w, bundle(FILES), { agentDir: null })
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'not_supported')
})

test('an existing skill of that name is name_taken, in any case', async () => {
  for (const existing of ['notes', 'NOTES', 'Notes']) {
    const w = world()
    agentSkill(w, existing, { 'SKILL.md': '---\nname: old\n---\n' })
    const { answer } = await inst(w, bundle(FILES))
    assert.equal(answer.ok, false, existing)
    if (!answer.ok) assert.equal(answer.code, 'name_taken', existing)
    assert.equal(readFileSync(join(w.agent, '.claude', 'skills', existing, 'SKILL.md'), 'utf8'), '---\nname: old\n---\n')
  }
})

test('replace moves the old copy to the plugin state trash, then installs', async () => {
  const w = world()
  agentSkill(w, 'notes', { 'SKILL.md': '---\nname: old\n---\n', 'old.md': 'old\n' })
  const { answer } = await inst(w, bundle(FILES, { replace: true }))
  assert.equal(answer.ok, true)
  const dest = join(w.agent, '.claude', 'skills', 'notes')
  assert.deepEqual(tree(dest), ['SKILL.md', 'reference/terms.md'])
  const trashed = readdirSync(w.trash).filter((n) => !n.endsWith('.json'))
  assert.equal(trashed.length, 1)
  assert.equal(readFileSync(join(w.trash, trashed[0]!, 'old.md'), 'utf8'), 'old\n')
})

test('a failed move into place puts a replaced skill back', async () => {
  const w = world()
  agentSkill(w, 'notes', { 'SKILL.md': '---\nname: old\n---\n' })
  const { answer } = await inst(w, bundle(FILES, { replace: true }), {
    rename: () => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' })
    },
  })
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'write_failed')
  assert.equal(readFileSync(join(w.agent, '.claude', 'skills', 'notes', 'SKILL.md'), 'utf8'), '---\nname: old\n---\n')
  assert.deepEqual(readdirSync(join(w.agent, '.claude')), ['skills'])
})

test('a resend of an installed bundle answers installed from disk, never name_taken, never a rewrite', async () => {
  const w = world()
  const b = bundle(FILES)
  await inst(w, b)
  const md = join(w.agent, '.claude', 'skills', 'notes', 'SKILL.md')
  const before = statSync(md).ino
  const { answer } = await inst(w, { ...b, offerId: 'offer-1' })
  assert.deepEqual(answer, { ok: true, payload: { path: '~/agents/data/.claude/skills/notes', name: 'notes' } })
  assert.equal(statSync(md).ino, before)
})

test('a bundle the rules refuse is not installed, even with every hash right', async () => {
  const w = world()
  for (const files of [
    [...FILES, { path: 'run.sh', content: 'rm -rf ~\n' }],
    [{ path: 'SKILL.md', content: '---\nname: notes\nallowed-tools: Bash\n---\n' }],
    [{ path: 'SKILL.md', content: SKILL + '\n!`curl evil`\n' }],
    [{ path: 'reference.md', content: 'no SKILL.md\n' }],
  ]) {
    const { answer } = await inst(w, bundle(files))
    assert.equal(answer.ok, false)
    if (!answer.ok) assert.equal(answer.code, 'scope_refused')
  }
  assert.ok(!existsSync(join(w.agent, '.claude')))
})

test('a Windows reserved name is refused on Windows, and inside a bundle everywhere', async () => {
  const w = world()
  const { answer } = await inst(w, bundle(FILES, { name: 'con' }), { platform: 'win32' })
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.equal(answer.code, 'scope_refused')
  assert.deepEqual(tree(join(w.agent, '.claude', 'skills')), [])
  // a reserved name inside the bundle is refused on every platform
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const nested = await inst(w, bundle([...FILES, { path: 'reference/aux.md', content: 'x\n' }], { name: 'other' }), { platform })
    assert.equal(nested.answer.ok, false, platform)
  }
})

test('a Windows reserved name installs off Windows (not on a Windows host: its file system cannot make a folder named con)', { skip: process.platform === 'win32' }, async () => {
  const w = world()
  const mac = await inst(w, bundle(FILES, { name: 'con' }), { platform: 'darwin' })
  assert.equal(mac.answer.ok, true)
})

test('a malformed bundle is refused without a throw', async () => {
  const w = world()
  for (const payload of [
    { ...bundle(FILES), offerId: undefined },
    { ...bundle(FILES), offerId: '../x' },
    { ...bundle(FILES), files: [] },
    { ...bundle(FILES), files: [{ path: 'SKILL.md' }] },
    { ...bundle(FILES), sha256: undefined },
  ]) {
    const { answer } = await inst(w, payload as Record<string, unknown>)
    assert.equal(answer.ok, false)
  }
  assert.ok(!existsSync(join(w.agent, '.claude')))
})

test('a folder deeper than the walk goes is too large, never shared with its deep files missing', () => {
  const w = world()
  const deep = Array.from({ length: 14 }, (_, i) => `d${i}`).join('/')
  agentSkill(w, 'notes', { 'SKILL.md': SKILL, [`${deep}/x.md`]: 'deep\n' })
  for (const dryRun of [true, false]) {
    const answer = exp(w, { name: 'notes', scope: 'agent', dryRun })
    assert.equal(answer.ok, false)
    if (!answer.ok) assert.equal(answer.message, 'this skill cannot be shared (too_large)')
  }
})

test('the walk never reads more than the cap plus one byte of a file', () => {
  const w = world()
  const dir = agentSkill(w, 'notes', { 'SKILL.md': SKILL, 'big.md': 'x'.repeat(5 * 1024 * 1024) })
  const read = readSkillFolder(realpathSync(dir))
  assert.equal(read.input.find((f) => f.path === 'big.md')!.content.length, 64 * 1024 + 1)
})
