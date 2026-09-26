/**
 * The changes collector (HOAI P7 stage 3, C-31): what this daemon runs when
 * the owner's Changes panel asks for the agent's uncommitted changes.
 *
 * The backend (backend/src/changes-panel/changes-view.ts) does every hard
 * part: it splits the patch, counts from numstat, masks secrets and caps what
 * reaches the app. This daemon is thin on purpose. It runs READ ONLY Git in
 * the agent's launch folder and sends the raw output, cut at the byte caps the
 * frame carries, plus the text of a few small untracked files. So the things
 * that can go wrong here are few and each one is pinned below:
 *
 *  - running something that writes (the index, the working tree, a lock),
 *  - reading the wrong folder (process.cwd() is the plugin cache on a
 *    marketplace install; the untracked names are relative to the ROOT),
 *  - buffering a huge diff instead of cutting the stream and killing Git,
 *  - trusting caps from the frame above the backend's own numbers,
 *  - sending an absolute path (it names the operating system user),
 *  - hanging past the budget.
 *
 * Git is faked for all but one test: a scripted runGit records argv, cwd and
 * env, and an in memory fs answers the untracked reads. The real Git test at
 * the end runs the node adapter against a scratch repository, and skips on a
 * host without Git.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHANGES_DEFAULT_CAPS,
  collectChanges,
  createNodeRunGit,
  nodeChangesFs,
  readCaps,
  type ChangesCaps,
  type ChangesFs,
  type GitRun,
  type RunGit,
} from '../lib/git-changes.ts'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** The agent's launch folder: a SUBFOLDER of its repository. */
const WORKDIR = 'E:/agents/billing/services'
/** What `git rev-parse --show-toplevel` prints for it (forward slashes, as Git does on Windows). */
const ROOT = 'E:/agents/billing'
const NOW = Date.parse('2026-09-26T10:00:00.000Z')
const TAKEN_AT = '2026-09-26T10:00:00.000Z'

/** The seven commands of spec 10.1 item 7, in order, written out whole. */
const ARGV_TOPLEVEL = ['rev-parse', '--show-toplevel']
const ARGV_VERIFY = ['rev-parse', '--verify', '--quiet', 'HEAD']
const ARGV_BRANCH = ['symbolic-ref', '--quiet', '--short', 'HEAD']
const ARGV_SHORT = ['rev-parse', '--short', 'HEAD']
const ARGV_NUMSTAT = [
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.autoRefreshIndex=false',
  'diff',
  '--numstat',
  '-z',
  '--no-ext-diff',
  '--no-textconv',
  '--find-renames',
  'HEAD',
  '--',
]
const ARGV_PATCH = [
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.autoRefreshIndex=false',
  '--no-pager',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--find-renames',
  'HEAD',
  '--',
]
const ARGV_UNTRACKED = ['ls-files', '--others', '--exclude-standard', '-z']

const NUMSTAT = '5\t2\tservices/export.py\0-\t-\tassets/logo.png\0' + '1\t1\t\0src/old.ts\0src/new.ts\0'
const PATCH = [
  'diff --git a/services/export.py b/services/export.py',
  'index 1111111..2222222 100644',
  '--- a/services/export.py',
  '+++ b/services/export.py',
  '@@ -1,3 +1,6 @@',
  '+import os',
  ' def export():',
  '',
].join('\n')
const UNTRACKED = 'notes.md\0'

type Reply = Partial<GitRun>

const ok = (text: string): Reply => ({ code: 0, stdout: Buffer.from(text, 'utf8') })

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** A repository with one commit and changes: every command answers. */
function repoReply(overrides: Array<[readonly string[], Reply]> = []) {
  const table: Array<[readonly string[], Reply]> = [
    ...overrides,
    [ARGV_TOPLEVEL, ok(ROOT + '\n')],
    [ARGV_VERIFY, ok('0123456789abcdef0123456789abcdef01234567\n')],
    [ARGV_BRANCH, ok('fix/export-dupes\n')],
    [ARGV_SHORT, ok('0123456\n')],
    [ARGV_NUMSTAT, ok(NUMSTAT)],
    [ARGV_PATCH, ok(PATCH)],
    [ARGV_UNTRACKED, ok(UNTRACKED)],
  ]
  return (args: readonly string[]): Reply => {
    const hit = table.find(([argv]) => same(argv, args))
    // An argv this fixture does not know answers like Git would to nonsense.
    return hit ? hit[1] : { code: 129, stderr: `unknown command ${args.join(' ')}` }
  }
}

type Call = { args: string[]; cwd: string; env: Record<string, string | undefined>; maxBytes: number }

function fakeGit(reply: (args: readonly string[], signal: AbortSignal) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  const runGit: RunGit = async (args, opts) => {
    calls.push({ args: [...args], cwd: opts.cwd, env: { ...opts.env }, maxBytes: opts.maxBytes })
    const r = await reply(args, opts.signal)
    return { code: 0, stdout: Buffer.alloc(0), stderr: '', truncated: false, ...r }
  }
  return { runGit, calls }
}

type MemEntry = { kind: 'file' | 'symlink' | 'dir'; data?: Buffer; size?: number }

function memFs(entries: Record<string, MemEntry>) {
  const lstats: string[] = []
  const reads: string[] = []
  const fs: ChangesFs = {
    lstat: async (p) => {
      lstats.push(p)
      const e = entries[p]
      if (!e) throw Object.assign(new Error(`ENOENT: no such file, lstat '${p}'`), { code: 'ENOENT' })
      return { isFile: () => e.kind === 'file', size: e.size ?? e.data?.length ?? 0 }
    },
    readFile: async (p) => {
      reads.push(p)
      const e = entries[p]
      if (!e?.data) throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' })
      return e.data
    },
  }
  return { fs, lstats, reads }
}

const BASE_ENV = { PATH: '/usr/bin', HOME: '/home/kc' }

async function collect(
  opts: {
    reply?: (args: readonly string[], signal: AbortSignal) => Reply | Promise<Reply>
    fs?: ChangesFs
    caps?: ChangesCaps
    workdir?: string
    runGit?: RunGit
  } = {},
) {
  const git = fakeGit(opts.reply ?? repoReply())
  const result = await collectChanges({
    workdir: opts.workdir ?? WORKDIR,
    caps: opts.caps ?? { ...CHANGES_DEFAULT_CAPS },
    runGit: opts.runGit ?? git.runGit,
    fs: opts.fs ?? memFs({ [`${ROOT}/notes.md`]: { kind: 'file', data: Buffer.from('# Notes\n') } }).fs,
    now: () => NOW,
    env: BASE_ENV,
  })
  return { result, calls: git.calls }
}

function emptyAnswer(state: string, folder: string) {
  return {
    ok: true,
    payload: {
      v: 1,
      state,
      folder,
      branch: null,
      head: null,
      numstat: '',
      numstatTruncated: false,
      patch: '',
      patchTruncated: false,
      untracked: '',
      untrackedTruncated: false,
      untrackedFiles: [],
      takenAt: TAKEN_AT,
    },
  }
}

// ---------------------------------------------------------------------------
// the answers that are not a diff
// ---------------------------------------------------------------------------

test('a folder that is not a repository answers not_git with its basename', async () => {
  const { result, calls } = await collect({
    workdir: 'C:\\Users\\kc\\notes',
    reply: (args) =>
      same(args, ARGV_TOPLEVEL)
        ? { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }
        : { code: 0 },
  })
  assert.deepEqual(result, emptyAnswer('not_git', 'notes'))
  assert.equal(calls.length, 1, 'nothing else runs outside a repository')
})

test('any other failure of the first command is a failure, never a folder that is not a repository', async () => {
  await assert.rejects(
    collect({
      reply: (args) =>
        same(args, ARGV_TOPLEVEL)
          ? { code: 128, stderr: "fatal: detected dubious ownership in repository at 'E:/agents/billing'\n" }
          : { code: 0 },
    }),
  )
})

test('Git missing answers git_missing', async () => {
  const { result, calls } = await collect({
    reply: () => ({ code: null, spawnError: 'ENOENT' }),
  })
  assert.deepEqual(result, emptyAnswer('git_missing', 'services'))
  assert.equal(calls.length, 1)
})

test('no first commit answers no_commits', async () => {
  const { result, calls } = await collect({
    reply: repoReply([[ARGV_VERIFY, { code: 1 }]]),
  })
  assert.deepEqual(result, emptyAnswer('no_commits', 'billing'))
  assert.deepEqual(
    calls.map((c) => c.args),
    [ARGV_TOPLEVEL, ARGV_VERIFY],
    'no diff runs without a first commit',
  )
})

// ---------------------------------------------------------------------------
// the diff
// ---------------------------------------------------------------------------

test('runs exactly the read only commands, in order, the first in the working folder and the rest in the root it printed, with GIT_OPTIONAL_LOCKS=0', async () => {
  const mem = memFs({ [`${ROOT}/notes.md`]: { kind: 'file', data: Buffer.from('# Notes\n') } })
  const { result, calls } = await collect({ fs: mem.fs })
  assert.deepEqual(
    calls.map((c) => c.args),
    [ARGV_TOPLEVEL, ARGV_VERIFY, ARGV_BRANCH, ARGV_SHORT, ARGV_NUMSTAT, ARGV_PATCH, ARGV_UNTRACKED],
  )
  assert.deepEqual(
    calls.map((c) => c.cwd),
    [WORKDIR, ROOT, ROOT, ROOT, ROOT, ROOT, ROOT],
    'the first command finds the root, every later one runs in it',
  )
  for (const c of calls) {
    assert.equal(c.env.GIT_OPTIONAL_LOCKS, '0', `${c.args.join(' ')}: no optional lock, so Git never rewrites the index`)
    assert.equal(c.env.GIT_TERMINAL_PROMPT, '0', 'Git never waits on a prompt')
    assert.equal(c.env.LC_ALL, 'C', 'stable messages')
    assert.equal(c.env.PATH, '/usr/bin', 'the rest of the environment rides along')
  }
  // Each read is cut at its own cap.
  assert.deepEqual(
    calls.slice(4).map((c) => c.maxBytes),
    [CHANGES_DEFAULT_CAPS.maxNumstatBytes, CHANGES_DEFAULT_CAPS.maxPatchBytes, CHANGES_DEFAULT_CAPS.maxUntrackedListBytes],
  )
  // The untracked names are relative to the ROOT, so the reads are too.
  assert.deepEqual(mem.lstats, [`${ROOT}/notes.md`])
  assert.deepEqual(result, {
    ok: true,
    payload: {
      v: 1,
      state: 'ok',
      folder: 'billing',
      branch: 'fix/export-dupes',
      head: '0123456',
      numstat: NUMSTAT,
      numstatTruncated: false,
      patch: PATCH,
      patchTruncated: false,
      untracked: UNTRACKED,
      untrackedTruncated: false,
      untrackedFiles: [{ path: 'notes.md', bytes: 8, text: '# Notes\n' }],
      takenAt: TAKEN_AT,
    },
  })
})

test('a detached HEAD has no branch and keeps its head', async () => {
  const { result } = await collect({ reply: repoReply([[ARGV_BRANCH, { code: 1 }]]) })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.payload.branch, null)
  assert.equal(result.payload.head, '0123456')
})

test('a repository whose Git environment points elsewhere is still read in the folder it is given', async () => {
  // A daemon launched from inside a Git hook, or with GIT_DIR exported, would
  // otherwise read THAT repository whatever cwd says.
  const git = fakeGit(repoReply())
  await collectChanges({
    workdir: WORKDIR,
    caps: { ...CHANGES_DEFAULT_CAPS },
    runGit: git.runGit,
    fs: memFs({ [`${ROOT}/notes.md`]: { kind: 'file', data: Buffer.from('# Notes\n') } }).fs,
    now: () => NOW,
    env: { ...BASE_ENV, GIT_DIR: 'D:/other/.git', GIT_WORK_TREE: 'D:/other', GIT_INDEX_FILE: 'D:/other/.git/index' },
  })
  for (const c of git.calls) {
    assert.equal(c.env.GIT_DIR, undefined)
    assert.equal(c.env.GIT_WORK_TREE, undefined)
    assert.equal(c.env.GIT_INDEX_FILE, undefined)
  }
})

test('both diffs turn off the index refresh, which GIT_OPTIONAL_LOCKS alone does not stop', async () => {
  // Found while building this collector (Git 2.55 on Windows, a scratch
  // repository): a file touched but unchanged makes `git diff HEAD` refresh
  // the stat data and REWRITE .git/index, GIT_OPTIONAL_LOCKS=0 or not. The
  // refresh is diff.autoRefreshIndex, so both diffs turn it off for the call.
  // The real Git test below proves the index is untouched.
  const { calls } = await collect()
  const diffs = calls.filter((c) => c.args.includes('diff'))
  assert.equal(diffs.length, 2)
  for (const c of diffs) {
    const at = c.args.indexOf('diff.autoRefreshIndex=false')
    assert.ok(at > 0 && c.args[at - 1] === '-c', `${c.args.join(' ')} refreshes the index`)
    assert.ok(at < c.args.indexOf('diff'), 'a -c option goes before the command')
  }
})

test("asks Git for its own a/ and b/ prefixes on the patch, whatever the host's diff config", async () => {
  // Lane B's review (P7 stage 3, B-3): a host whose Git config sets
  // diff.mnemonicPrefix, diff.noprefix, diff.srcPrefix or diff.dstPrefix
  // writes other prefixes. The backend reads c/ and w/ and any one folder
  // prefix, but under diff.noprefix a top folder named a or b reads wrong
  // unless the patch carries Git's own prefixes, so the daemon asks for them.
  const { calls } = await collect()
  const patch = calls.find((c) => c.args.includes('--no-color'))
  assert.ok(patch, 'the patch command ran')
  const head = patch.args.indexOf('HEAD')
  const src = patch.args.indexOf('--src-prefix=a/')
  const dst = patch.args.indexOf('--dst-prefix=b/')
  assert.ok(src > 0 && src < head, 'the old side is a/')
  assert.ok(dst > 0 && dst < head, 'the new side is b/')
  // numstat names paths without any prefix, so it needs none.
  const numstat = calls.find((c) => c.args.includes('--numstat'))
  assert.ok(numstat && !numstat.args.some((a) => a.startsWith('--src-prefix') || a.startsWith('--dst-prefix')))
})

const WRITING_COMMANDS = [
  'add',
  'status',
  'checkout',
  'reset',
  'stash',
  'commit',
  'update-index',
  'restore',
  'switch',
  'clean',
  'gc',
  'apply',
  'merge',
  'rebase',
  'fetch',
  'pull',
  'push',
  'init',
  'rm',
  'mv',
]

test('never runs anything that writes', async () => {
  const scenarios = [
    repoReply(),
    repoReply([[ARGV_BRANCH, { code: 1 }]]),
    repoReply([[ARGV_VERIFY, { code: 1 }]]),
    repoReply([[ARGV_TOPLEVEL, { code: 128, stderr: 'fatal: not a git repository' }]]),
    repoReply([[ARGV_PATCH, { code: null, stdout: Buffer.from('diff --git a/x b/x\n'), truncated: true }]]),
  ]
  const seen: string[][] = []
  for (const reply of scenarios) {
    const { calls } = await collect({ reply })
    seen.push(...calls.map((c) => c.args))
  }
  assert.ok(seen.length >= 15, `every scenario ran (${seen.length} commands)`)
  for (const argv of seen) {
    for (const word of WRITING_COMMANDS) {
      assert.ok(!argv.includes(word), `${argv.join(' ')} runs ${word}`)
    }
  }
  // And the source spells none of them as an argument.
  const source = readFileSync(new URL('../lib/git-changes.ts', import.meta.url), 'utf8')
  for (const word of WRITING_COMMANDS) {
    assert.ok(!source.includes(`'${word}'`), `lib/git-changes.ts names '${word}'`)
    assert.ok(!source.includes(`"${word}"`), `lib/git-changes.ts names "${word}"`)
  }
})

// ---------------------------------------------------------------------------
// the stream cap, through the node adapter
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): boolean {
    if (this.killed) return true
    this.killed = true
    setImmediate(() => this.emit('close', null, 'SIGTERM'))
    return true
  }
}

type SpawnPlan = { out?: string; code?: number; stream?: { chunk: Buffer; count: number }; error?: string }

function fakeSpawn(plan: (args: readonly string[]) => SpawnPlan) {
  const children: Array<{ args: string[]; cwd: string; child: FakeChild }> = []
  const spawnImpl = (_cmd: string, args: readonly string[], options: { cwd: string }) => {
    const child = new FakeChild()
    children.push({ args: [...args], cwd: options.cwd, child })
    const p = plan(args)
    setImmediate(async () => {
      if (p.error) {
        child.emit('error', Object.assign(new Error(`spawn git ${p.error}`), { code: p.error }))
        return
      }
      if (p.stream) {
        for (let i = 0; i < p.stream.count && !child.killed; i += 1) {
          child.stdout.write(p.stream.chunk)
          await new Promise((resolve) => setImmediate(resolve))
        }
      } else if (p.out) {
        child.stdout.write(p.out)
      }
      if (child.killed) return
      child.stderr.end()
      child.stdout.once('end', () => child.emit('close', p.code ?? 0, null))
      child.stdout.end()
    })
    return child
  }
  return { spawnImpl, children }
}

test('stops reading at the byte cap, says it was cut, and kills the child', async () => {
  const MB = 1024 * 1024
  const chunk = Buffer.alloc(64 * 1024, 'x')
  const spawn = fakeSpawn((args) => {
    if (same(args, ARGV_TOPLEVEL)) return { out: ROOT + '\n' }
    if (same(args, ARGV_VERIFY)) return { out: 'abc\n' }
    if (same(args, ARGV_BRANCH)) return { out: 'main\n' }
    if (same(args, ARGV_SHORT)) return { out: 'abc1234\n' }
    if (same(args, ARGV_NUMSTAT)) return { out: NUMSTAT }
    if (same(args, ARGV_UNTRACKED)) return { out: '' }
    // The patch: three megabytes, far past the one megabyte cap.
    return { stream: { chunk, count: 48 } }
  })
  const { result } = await collect({ runGit: createNodeRunGit(spawn.spawnImpl as never) })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(Buffer.byteLength(result.payload.patch, 'utf8') <= CHANGES_DEFAULT_CAPS.maxPatchBytes)
  assert.equal(result.payload.patch.length, MB, 'everything up to the cap is kept')
  assert.equal(result.payload.patchTruncated, true)
  assert.equal(result.payload.numstatTruncated, false)
  const patchChild = spawn.children.find((c) => c.args.includes('--no-color'))
  assert.ok(patchChild, 'the patch command ran')
  assert.equal(patchChild.child.killed, true, 'Git is killed at the cap, not left writing into a closed reader')
  assert.equal(spawn.children.filter((c) => c.child.killed).length, 1, 'only the child past its cap is killed')
  // The adapter runs `git` with the working folder it is given.
  assert.equal(spawn.children[0].cwd, WORKDIR)
})

test('the node adapter reads a spawn ENOENT as Git missing', async () => {
  const spawn = fakeSpawn(() => ({ error: 'ENOENT' }))
  const { result } = await collect({ runGit: createNodeRunGit(spawn.spawnImpl as never) })
  assert.deepEqual(result, emptyAnswer('git_missing', 'services'))
})

// ---------------------------------------------------------------------------
// untracked files
// ---------------------------------------------------------------------------

test('reads the first 20 untracked regular files: text, binary by a NUL, too large by size, a symlink as binary', async () => {
  const withNul = Buffer.from('PNG\0\0header')
  const lateNul = Buffer.concat([Buffer.alloc(8000, 'a'), Buffer.from('\0tail')])
  const edge = Buffer.alloc(CHANGES_DEFAULT_CAPS.maxUntrackedTextBytes, 'e')
  const names = ['notes.md', 'blob.bin', 'big.log', 'link', 'late.txt', 'edge.txt', 'gone.txt', 'dir']
  for (let i = 1; names.length < 23; i += 1) names.push(`more/f${String(i).padStart(2, '0')}.txt`)
  const entries: Record<string, MemEntry> = {
    [`${ROOT}/notes.md`]: { kind: 'file', data: Buffer.from('# Notes\nsecond line\n') },
    [`${ROOT}/blob.bin`]: { kind: 'file', data: withNul },
    [`${ROOT}/big.log`]: { kind: 'file', size: 70_000 },
    [`${ROOT}/link`]: { kind: 'symlink', size: 11 },
    [`${ROOT}/late.txt`]: { kind: 'file', data: lateNul },
    [`${ROOT}/edge.txt`]: { kind: 'file', data: edge },
    [`${ROOT}/dir`]: { kind: 'dir', size: 0 },
  }
  for (const n of names.slice(8)) entries[`${ROOT}/${n}`] = { kind: 'file', data: Buffer.from(`${n}\n`) }
  const mem = memFs(entries)
  const list = names.join('\0') + '\0'
  const { result } = await collect({ fs: mem.fs, reply: repoReply([[ARGV_UNTRACKED, ok(list)]]) })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.payload.untracked, list, 'the raw list is sent whole')
  const expected = [
    { path: 'notes.md', bytes: 20, text: '# Notes\nsecond line\n' },
    { path: 'blob.bin', bytes: withNul.length, binary: true },
    { path: 'big.log', bytes: 70_000 },
    { path: 'link', bytes: 11, binary: true },
    { path: 'late.txt', bytes: lateNul.length, text: lateNul.toString('utf8') },
    { path: 'edge.txt', bytes: edge.length, text: edge.toString('utf8') },
    { path: 'gone.txt', bytes: 0 },
    { path: 'dir', bytes: 0, binary: true },
    ...names.slice(8, 20).map((n) => ({ path: n, bytes: n.length + 1, text: `${n}\n` })),
  ]
  assert.deepEqual(result.payload.untrackedFiles, expected)
  assert.equal(result.payload.untrackedFiles.length, 20)
  // Names 21 to 23 are never touched: the backend lists them as not read.
  assert.equal(mem.lstats.length, 20)
  for (const n of names.slice(20)) assert.ok(!mem.lstats.includes(`${ROOT}/${n}`))
  // A file too large, a symlink and a folder are never opened.
  for (const n of ['big.log', 'link', 'dir']) assert.ok(!mem.reads.includes(`${ROOT}/${n}`), `${n} was read`)
})

test('a name the cut list did not finish is not read', async () => {
  const mem = memFs({ [`${ROOT}/a.txt`]: { kind: 'file', data: Buffer.from('a\n') } })
  const { result } = await collect({
    fs: mem.fs,
    reply: repoReply([[ARGV_UNTRACKED, { code: null, stdout: Buffer.from('a.txt\0b-half-na'), truncated: true }]]),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.payload.untrackedTruncated, true)
  assert.deepEqual(result.payload.untrackedFiles, [{ path: 'a.txt', bytes: 2, text: 'a\n' }])
  assert.deepEqual(mem.lstats, [`${ROOT}/a.txt`])
})

// ---------------------------------------------------------------------------
// caps and budget
// ---------------------------------------------------------------------------

test('takes caps from the frame, never above the defaults', async () => {
  // The backend's CHANGES_FRAME_PAYLOAD numbers, written out.
  assert.deepEqual(
    { ...CHANGES_DEFAULT_CAPS },
    {
      maxPatchBytes: 1_048_576,
      maxNumstatBytes: 262_144,
      maxUntrackedListBytes: 65_536,
      maxUntrackedTextFiles: 20,
      maxUntrackedTextBytes: 65_536,
      budgetMs: 10_000,
    },
  )
  assert.ok(Object.isFrozen(CHANGES_DEFAULT_CAPS))
  assert.deepEqual(readCaps({ maxPatchBytes: 999_999_999 }), { ...CHANGES_DEFAULT_CAPS })
  assert.deepEqual(readCaps(undefined), { ...CHANGES_DEFAULT_CAPS })
  assert.deepEqual(readCaps(null), { ...CHANGES_DEFAULT_CAPS })
  assert.deepEqual(readCaps([]), { ...CHANGES_DEFAULT_CAPS })
  for (const bad of [0, -5, 2.5, '1000', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(readCaps({ maxPatchBytes: bad }).maxPatchBytes, 1_048_576, `${String(bad)} is not a cap`)
  }
  assert.deepEqual(
    readCaps({
      scope: 'uncommitted',
      maxPatchBytes: 1000,
      maxNumstatBytes: 2000,
      maxUntrackedListBytes: 3000,
      maxUntrackedTextFiles: 4,
      maxUntrackedTextBytes: 5000,
      budgetMs: 6000,
      extra: 1,
    }),
    {
      maxPatchBytes: 1000,
      maxNumstatBytes: 2000,
      maxUntrackedListBytes: 3000,
      maxUntrackedTextFiles: 4,
      maxUntrackedTextBytes: 5000,
      budgetMs: 6000,
    },
  )
  assert.equal(readCaps({ maxUntrackedTextFiles: 21 }).maxUntrackedTextFiles, 20)
  assert.equal(readCaps({ budgetMs: 60_000 }).budgetMs, 10_000)
  // And the collector uses what it is given.
  const { calls } = await collect({ caps: readCaps({ maxNumstatBytes: 10, maxPatchBytes: 20, maxUntrackedListBytes: 30 }) })
  assert.deepEqual(calls.slice(4).map((c) => c.maxBytes), [10, 20, 30])
})

test('past the budget it answers too_slow', { timeout: 5000 }, async () => {
  let aborted = false
  const started = Date.now()
  const { result, calls } = await collect({
    caps: readCaps({ budgetMs: 50 }),
    reply: async (args, signal) => {
      if (!same(args, ARGV_PATCH)) return repoReply()(args)
      // Git hangs on the patch until the collector gives up on it.
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      aborted = true
      return { code: null, aborted: true }
    },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'too_slow')
  assert.ok(result.message.length > 0 && result.message.length <= 300)
  assert.ok(aborted, 'the running Git child was told to stop')
  assert.ok(Date.now() - started < 3000, 'the answer came at the budget, not after it')
  assert.ok(!calls.some((c) => same(c.args, ARGV_UNTRACKED)), 'nothing more runs past the budget')
})

// ---------------------------------------------------------------------------
// the folder
// ---------------------------------------------------------------------------

test('sends the basename, never the absolute path', async () => {
  const { result } = await collect()
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.payload.folder, 'billing')
  const wire = JSON.stringify(result.payload)
  assert.ok(!wire.includes('E:/agents'), 'the root never rides the answer')
  assert.ok(!wire.includes(WORKDIR))
  // A root at the top of a drive, a trailing slash, and a Windows working folder.
  const drive = await collect({ reply: repoReply([[ARGV_TOPLEVEL, ok('D:/billing-export/\n')]]) })
  assert.equal(drive.result.ok && drive.result.payload.folder, 'billing-export')
  const notGit = await collect({
    workdir: 'C:\\Users\\kc\\agents\\nova\\',
    reply: () => ({ code: 128, stderr: 'fatal: not a git repository' }),
  })
  assert.equal(notGit.result.ok && notGit.result.payload.folder, 'nova')
  // At most 120 characters.
  const long = 'r'.repeat(200)
  const longRoot = await collect({ reply: repoReply([[ARGV_TOPLEVEL, ok(`E:/${long}\n`)]]) })
  assert.equal(longRoot.result.ok && longRoot.result.payload.folder, 'r'.repeat(120))
})

test('never uses process.cwd(): the folder is the one it is given', async () => {
  const source = readFileSync(new URL('../lib/git-changes.ts', import.meta.url), 'utf8')
  assert.ok(!source.includes('process.cwd'), 'process.cwd() is the plugin cache on a marketplace install')
  const { calls } = await collect({ workdir: 'Z:/elsewhere/agent' })
  assert.equal(calls[0].cwd, 'Z:/elsewhere/agent')
})

// ---------------------------------------------------------------------------
// real Git, one scratch repository per test (skipped on a host without Git)
// ---------------------------------------------------------------------------

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

/**
 * A scratch repository isolated from the host's Git config: no system config,
 * and a global config of its own that trusts the scratch folder (a Windows
 * temp folder can read as another owner's while an antivirus scan holds it,
 * and Git then refuses it as "dubious ownership").
 */
function scratchRepo() {
  const base = mkdtempSync(join(tmpdir(), 'hoai-changes-'))
  const repo = join(base, 'repo')
  mkdirSync(join(repo, 'dir'), { recursive: true })
  const globalConfig = join(base, 'gitconfig')
  writeFileSync(globalConfig, '[safe]\n\tdirectory = *\n')
  const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env: env as NodeJS.ProcessEnv, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  const commitAll = () => {
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'init')
  }
  // Windows can hold a just closed file for a moment (an antivirus scan): retry, and never fail a test on its cleanup.
  const remove = (t: { diagnostic: (msg: string) => void }) => {
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch (err) {
      t.diagnostic(`scratch folder left behind: ${base} (${(err as Error).message})`)
    }
  }
  // A real read on a busy machine: the budget is the test timeout's, not the frame's.
  const read = (workdir: string) =>
    collectChanges({
      workdir,
      caps: { ...CHANGES_DEFAULT_CAPS, budgetMs: 60_000 },
      runGit: createNodeRunGit(),
      fs: nodeChangesFs,
      now: () => NOW,
      env,
    })
  return { base, repo, env, git, commitAll, remove, read }
}

const indexHash = (repo: string) => createHash('sha256').update(readFileSync(join(repo, '.git', 'index'))).digest('hex')

test('reads a real repository with real Git from a subfolder, and leaves its index as it was', { skip: !HAS_GIT, timeout: 120_000 }, async (t) => {
  const s = scratchRepo()
  try {
    s.git('init', '-q', '-b', 'main')
    writeFileSync(join(s.repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(s.repo, 'b.txt'), 'gone soon\n')
    writeFileSync(join(s.repo, 'dir', 'c.txt'), 'same\n')
    s.commitAll()
    writeFileSync(join(s.repo, 'a.txt'), 'one\n2\n')
    rmSync(join(s.repo, 'b.txt'))
    writeFileSync(join(s.repo, 'new.md'), 'hello\n')
    // Same content, a new time: the stat refresh a diff does by default would
    // rewrite the index here.
    writeFileSync(join(s.repo, 'dir', 'c.txt'), 'same\n')
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(s.repo, 'dir', 'c.txt'), later, later)
    const before = indexHash(s.repo)
    const result = await s.read(join(s.repo, 'dir'))
    assert.equal(indexHash(s.repo), before, 'the index is byte for byte what it was')
    assert.equal(result.ok, true)
    if (!result.ok) return
    const p = result.payload
    assert.equal(p.state, 'ok')
    assert.equal(p.folder, 'repo')
    assert.equal(p.branch, 'main')
    assert.match(p.head ?? '', /^[0-9a-f]{7,40}$/)
    assert.equal(p.numstat, '1\t1\ta.txt\x000\t1\tb.txt\x00')
    assert.ok(p.patch.includes('diff --git a/a.txt b/a.txt\n'), p.patch)
    assert.ok(p.patch.includes('+++ /dev/null\n') || p.patch.includes('deleted file mode'), 'the delete is in the patch')
    assert.equal(p.untracked, 'new.md\x00', 'root relative, from the subfolder too')
    assert.deepEqual(p.untrackedFiles, [{ path: 'new.md', bytes: 6, text: 'hello\n' }])
  } finally {
    s.remove(t)
  }
})

test("real Git writes a/ and b/ on a host that sets other prefixes, a top folder named b included", { skip: !HAS_GIT, timeout: 120_000 }, async (t) => {
  const s = scratchRepo()
  try {
    s.git('init', '-q', '-b', 'main')
    mkdirSync(join(s.repo, 'b'), { recursive: true })
    writeFileSync(join(s.repo, 'a.txt'), 'one\n')
    writeFileSync(join(s.repo, 'b', 'z.txt'), 'zed\n')
    s.commitAll()
    writeFileSync(join(s.repo, 'a.txt'), 'two\n')
    writeFileSync(join(s.repo, 'b', 'z.txt'), 'zee\n')
    // One host config at a time, in the repository's own config.
    const hosts: Array<[string, string[][]]> = [
      ['diff.mnemonicPrefix', [['config', 'diff.mnemonicPrefix', 'true']]],
      ['diff.noprefix', [['config', '--unset', 'diff.mnemonicPrefix'], ['config', 'diff.noprefix', 'true']]],
      [
        'diff.srcPrefix and diff.dstPrefix',
        [['config', '--unset', 'diff.noprefix'], ['config', 'diff.srcPrefix', 'old/'], ['config', 'diff.dstPrefix', 'new/']],
      ],
    ]
    for (const [name, settings] of hosts) {
      for (const setting of settings) s.git(...setting)
      const result = await s.read(s.repo)
      assert.equal(result.ok, true, name)
      if (!result.ok) continue
      const headers = result.payload.patch.split('\n').filter((l) => /^(diff --git |--- |\+\+\+ )/.test(l))
      assert.deepEqual(
        headers,
        [
          'diff --git a/a.txt b/a.txt',
          '--- a/a.txt',
          '+++ b/a.txt',
          'diff --git a/b/z.txt b/b/z.txt',
          '--- a/b/z.txt',
          '+++ b/b/z.txt',
        ],
        `${name}: ${headers.join(' | ')}`,
      )
    }
  } finally {
    s.remove(t)
  }
})
