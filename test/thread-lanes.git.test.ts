/**
 * Thread lanes against a REAL git, in a throwaway repository made in a temp
 * folder (the unit tests in test/thread-lanes.test.ts use a fake git): the
 * worktree and its branch are made, the `-b` refusal falls back to the branch
 * left from an earlier worktree, the lane's sandbox protects the source
 * repository's own git state, and Delete removes the worktree and only its
 * branch. Since 0.88.0 a plain close removes the worktree too (remove and
 * prune) and its branch unless the branch holds work found nowhere else;
 * uncommitted changes are saved on the branch first. claude itself is a
 * fake: no process starts.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ThreadLaneManager, type ThreadTurnInput } from '../lib/thread-lanes.ts'
import type { StreamJsonChild } from '../lib/stream-json-child.ts'
import { diskUsage } from '../lib/thread-access.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

const run = promisify(execFile)
const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'

class FakeChild implements StreamJsonChild {
  killed: string[] = []
  private exits: Array<(code: number | null, signal: string | null) => void> = []
  write() {}
  end() {}
  kill(s: 'SIGTERM' | 'SIGKILL') { this.killed.push(s) }
  onStdout() {}
  onExit(cb: (code: number | null, signal: string | null) => void) { this.exits.push(cb) }
  exit() { for (const cb of this.exits) cb(0, null) }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', timeout: 10_000 })
}

function setup(opts: { platform?: NodeJS.Platform } = {}) {
  // Git for Windows expands 8.3 temp names; use the same physical spelling.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'thread-git-')))
  const agent = join(dir, 'agent')
  mkdirSync(agent)
  git(agent, 'init', '-q', '-b', 'main')
  // Exercise a default Windows clone on every host. Git may warn when the
  // initial LF file is added; the checkout in the new worktree is CRLF.
  git(agent, 'config', 'core.autocrlf', 'true')
  writeFileSync(join(agent, 'a.txt'), 'a\n')
  git(agent, 'add', '.')
  git(agent, 'commit', '-qm', 'init')
  git(agent, 'branch', 'feature/x')
  const home = join(dir, 'home')
  const config = join(dir, 'config')
  const main = sessionTranscriptPath(home, agent, MAIN, config)
  mkdirSync(dirname(main), { recursive: true })
  writeFileSync(main, '{}\n')
  const spawned: Array<{ args: string[]; cwd: string; child: FakeChild }> = []
  const kept: Array<{ rootId: string; branch: string; folder?: string; reason: string }> = []
  const logs: string[] = []
  const manager = new ThreadLaneManager({
    spawn: (_command, args, o) => {
      const child = new FakeChild()
      spawned.push({ args, cwd: o.cwd, child })
      return child
    },
    claudeBin: () => '/bin/claude',
    cliProblem: () => null,
    mainSessionId: () => MAIN,
    agentFolder: agent,
    stateDir: join(dir, 'state'),
    home,
    configDir: config,
    emptyMcpConfigPath: () => join(dir, 'empty-mcp.json'),
    // Windows has no supported lane Bash sandbox. Do not invent one here.
    shellSandbox: () => process.platform !== 'win32',
    platform: opts.platform ?? process.platform,
    processes: { stamp: async () => null, runsIn: async () => false, kill: () => {} },
    git: async (args, cwd) => {
      try {
        const { stdout } = await run('git', args, { cwd, timeout: 10_000 })
        return { ok: true, stdout: String(stdout) }
      } catch {
        return { ok: false, stdout: '' }
      }
    },
    fs: {
      exists: (p) => existsSync(p),
      mkdir: (p) => { mkdirSync(p, { recursive: true }) },
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, d) => writeFileSync(p, d),
      appendFile: (p, d) => appendFileSync(p, d),
      copyFile: (a, b) => copyFileSync(a, b),
      unlink: (p) => unlinkSync(p),
      rmrf: (p) => rmSync(p, { recursive: true, force: true }),
      createExclusive: (p, d) => writeFileSync(p, d, { flag: 'wx' }),
      rename: (a, b) => renameSync(a, b),
      list: (d) => readdirSync(d),
    },
    post: async () => {},
    now: () => 1,
    setTimer: () => ({}),
    clearTimer: () => {},
    log: (line) => { logs.push(line) },
    onBranchKept: (info) => { kept.push(info) },
    diskUsage: (path) => diskUsage(path),
  })
  return { dir, agent, manager, spawned, kept, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A thread with its worktree made and its process gone, ready to be closed. */
async function openThread(r: ReturnType<typeof setup>, rootId: string): Promise<string> {
  r.manager.turn(turn(rootId))
  await r.manager.idle()
  const folder = join(r.agent, '.hoai', 'threads', rootId)
  assert.ok(existsSync(join(folder, '.git')), 'the worktree is made')
  r.spawned.at(-1)!.child.exit()
  await r.manager.idle()
  return folder
}
const branches = (agent: string) => git(agent, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split(/\r?\n/).filter(Boolean).sort()
const worktrees = (agent: string) => git(agent, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length

const turn = (rootId: string): ThreadTurnInput => ({ chatId: '55', rootId, replyId: `${rootId}0`, mode: 'start', text: 'go', title: 't', rootText: 'r' })

function denyWrite(args: string[]): string[] {
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!)
  return settings.sandbox.filesystem.denyWrite
}

test('a real git: the worktree and its branch are made, and the sandbox protects the source repository state', async () => {
  const r = setup()
  try {
    r.manager.turn(turn('101'))
    await r.manager.idle()
    const wt = join(r.agent, '.hoai', 'threads', '101')
    assert.equal(r.spawned.length, 1)
    assert.equal(r.spawned[0]!.cwd, wt)
    assert.ok(existsSync(join(wt, 'a.txt')), 'the worktree has the checkout')
    assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'a\r\n', 'the autocrlf checkout is usable')
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'hoai/thread-101')
    assert.match(readFileSync(join(r.agent, '.git', 'info', 'exclude'), 'utf8'), /^\.hoai\/$/m)
    assert.equal(git(r.agent, 'status', '--porcelain'), '', 'the main checkout sees nothing new')
    const common = join(r.agent, '.git')
    if (process.platform === 'win32') {
      const settings = JSON.parse(r.spawned[0]!.args[r.spawned[0]!.args.indexOf('--settings') + 1]!)
      assert.deepEqual(settings.permissions.deny, ['Bash'])
      assert.deepEqual(settings.permissions.additionalDirectories, [wt])
      assert.equal(settings.sandbox, undefined, 'no unprotected Bash fallback')
    } else assert.deepEqual(denyWrite(r.spawned[0]!.args).sort(), [
      join(common, 'HEAD'),
      join(common, 'index'),
      join(common, 'packed-refs'),
      join(common, 'config'),
      join(common, 'hooks'),
      join(common, 'refs', 'stash'),
      join(common, 'logs', 'refs', 'stash'),
      join(common, 'refs', 'tags'),
      join(common, 'refs', 'remotes'),
      join(common, 'refs', 'notes'),
      join(common, 'refs', 'replace'),
      join(common, 'refs', 'heads', 'feature', 'x'),
      join(common, 'refs', 'heads', 'main'),
    ].sort(), 'never the lane\'s own branch or its own worktree admin dir')
  } finally {
    r.cleanup()
  }
})

test('a real git: a branch left from an earlier worktree is reused, and Delete removes the worktree and only that branch', async () => {
  const r = setup()
  try {
    git(r.agent, 'branch', 'hoai/thread-102')
    r.manager.turn(turn('103'))
    await r.manager.idle()
    r.manager.turn(turn('102'))
    await r.manager.idle()
    const wt = join(r.agent, '.hoai', 'threads', '102')
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'hoai/thread-102', 'the fallback checked out the existing branch')
    // A lane's sandbox protects the worktree admin dir of a lane that existed when it started.
    if (process.platform !== 'win32') {
      const deny = denyWrite(r.spawned[1]!.args)
      assert.ok(deny.includes(join(r.agent, '.git', 'worktrees', '103')))
      assert.equal(deny.includes(join(r.agent, '.git', 'worktrees', '102')), false)
      assert.ok(deny.includes(join(r.agent, '.git', 'refs', 'heads', 'hoai', 'thread-103')))
    }
    await r.manager.close({ rootId: '102', removeWorktree: true })
    r.spawned[1]!.child.exit()
    await r.manager.idle()
    assert.equal(existsSync(wt), false)
    const branches = git(r.agent, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean).sort()
    assert.deepEqual(branches, ['feature/x', 'hoai/thread-103', 'main'])
    assert.equal(git(r.agent, 'worktree', 'list', '--porcelain').replace(/\\/g, '/').includes('/threads/102'), false)
  } finally {
    r.cleanup()
  }
})

const LINUX_SANDBOX = { skip: process.platform === 'win32' ? 'Linux sandbox ref placeholders are not used on Windows' : false }

test('a real git on Linux: branches kept only in packed-refs are written out loose, same commits, and git reads the repository as before', LINUX_SANDBOX, async () => {
  const r = setup({ platform: 'linux' })
  try {
    git(r.agent, 'tag', 'v1')
    git(r.agent, 'pack-refs', '--all')
    const heads = join(r.agent, '.git', 'refs', 'heads')
    assert.equal(existsSync(join(heads, 'main')), false, 'packed only before')
    const before = git(r.agent, 'for-each-ref', '--format=%(refname) %(objectname)')
    r.manager.turn(turn('101'))
    await r.manager.idle()
    assert.equal(readFileSync(join(heads, 'main'), 'utf8').trim(), git(r.agent, 'rev-parse', 'main').trim())
    assert.equal(readFileSync(join(heads, 'feature', 'x'), 'utf8').trim(), git(r.agent, 'rev-parse', 'feature/x').trim())
    assert.equal(git(r.agent, 'for-each-ref', '--format=%(refname) %(objectname)'), before.replace('\n', `\nrefs/heads/hoai/thread-101 ${git(r.agent, 'rev-parse', 'main').trim()}\n`).replace(/\n\n$/, '\n'), 'the same refs, plus the lane branch')
    for (const d of ['tags', 'remotes', 'notes', 'replace']) assert.ok(existsSync(join(r.agent, '.git', 'refs', d)), d)
    assert.equal(git(r.agent, 'status', '--porcelain'), '')
    git(r.agent, 'fsck', '--no-progress')
  } finally {
    r.cleanup()
  }
})

test('a real git on Linux with no stash: the placeholders are invisible to git, and the owner can still stash and pop', LINUX_SANDBOX, async () => {
  const r = setup({ platform: 'linux' })
  try {
    r.manager.turn(turn('101'))
    await r.manager.idle()
    const common = join(r.agent, '.git')
    assert.deepEqual(readdirSync(join(common, 'refs', 'stash')), [], 'an empty folder')
    assert.equal(readFileSync(join(common, 'logs', 'refs', 'stash'), 'utf8'), '')
    const refs = execFileSync('git', ['for-each-ref'], { cwd: r.agent, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.doesNotMatch(refs, /stash/)
    assert.equal(execFileSync('git', ['stash', 'list'], { cwd: r.agent, encoding: 'utf8' }), '')
    git(r.agent, 'fsck', '--no-progress')
    writeFileSync(join(r.agent, 'a.txt'), 'changed\n')
    git(r.agent, 'stash')
    assert.match(git(r.agent, 'stash', 'list'), /stash@\{0\}/)
    git(r.agent, 'stash', 'pop', '-q')
    assert.equal(readFileSync(join(r.agent, 'a.txt'), 'utf8'), 'changed\r\n', 'stash pop honors the configured checkout endings')
  } finally {
    r.cleanup()
  }
})

// -- 0.88.0: a closed thread leaves nothing behind, with a real git ------------

test('close removes the worktree and prunes it, and the branch with it when the branch holds nothing of its own', async () => {
  const r = setup()
  try {
    const folder = await openThread(r, '301')
    assert.equal(worktrees(r.agent), 2)
    await r.manager.close({ rootId: '301', removeWorktree: false })
    await r.manager.idle()
    assert.equal(existsSync(folder), false, 'the checkout is gone')
    assert.equal(worktrees(r.agent), 1, 'git knows no second worktree')
    assert.deepEqual(branches(r.agent), ['feature/x', 'main'], 'its branch pointed at a commit main has: removed')
    assert.deepEqual(r.kept, [])
    assert.equal(existsSync(join(r.dir, 'state', '301.json')), false)
    assert.match(r.logs.find((l) => /thread 301 closed/.test(l)) ?? '', /freed [1-9]\d* bytes/)
    assert.equal(git(r.agent, 'status', '--porcelain').trim(), '', 'the main checkout is untouched')
  } finally {
    r.cleanup()
  }
})

test('close keeps a branch that holds a commit found in no other branch, and removes the checkout', async () => {
  const r = setup()
  try {
    const folder = await openThread(r, '302')
    writeFileSync(join(folder, 'work.txt'), 'the thread\'s own work\n')
    git(folder, 'add', '.')
    git(folder, 'commit', '-qm', 'thread work')
    const tip = git(r.agent, 'rev-parse', 'hoai/thread-302').trim()
    await r.manager.close({ rootId: '302', removeWorktree: false })
    await r.manager.idle()
    assert.equal(existsSync(folder), false)
    assert.equal(worktrees(r.agent), 1)
    assert.equal(git(r.agent, 'rev-parse', 'hoai/thread-302').trim(), tip, 'the commit is still reachable by its branch')
    assert.equal(r.kept.length, 1)
    assert.equal(r.kept[0]!.branch, 'hoai/thread-302')
    assert.match(r.kept[0]!.reason, /commits that are in no other branch/)
  } finally {
    r.cleanup()
  }
})

test('close removes a branch whose commit was merged into another branch', async () => {
  const r = setup()
  try {
    const folder = await openThread(r, '303')
    writeFileSync(join(folder, 'work.txt'), 'merged work\n')
    git(folder, 'add', '.')
    git(folder, 'commit', '-qm', 'thread work')
    git(r.agent, 'merge', '-q', '--ff-only', 'hoai/thread-303')
    await r.manager.close({ rootId: '303', removeWorktree: false })
    await r.manager.idle()
    assert.equal(existsSync(folder), false)
    assert.deepEqual(branches(r.agent), ['feature/x', 'main'])
    assert.deepEqual(r.kept, [])
    assert.ok(existsSync(join(r.agent, 'work.txt')), 'the merged work is in main')
  } finally {
    r.cleanup()
  }
})

test('close saves uncommitted changes, tracked and new, as a commit on the thread\'s branch before the checkout goes', async () => {
  const r = setup()
  try {
    const folder = await openThread(r, '304')
    writeFileSync(join(folder, 'a.txt'), 'changed by the thread\n')
    writeFileSync(join(folder, 'new.txt'), 'made by the thread\n')
    await r.manager.close({ rootId: '304', removeWorktree: false })
    await r.manager.idle()
    assert.equal(existsSync(folder), false, 'the checkout is gone')
    assert.equal(git(r.agent, 'show', 'hoai/thread-304:new.txt').replace(/\r\n/g, '\n'), 'made by the thread\n', 'the new file is in the saved commit')
    assert.equal(git(r.agent, 'show', 'hoai/thread-304:a.txt').replace(/\r\n/g, '\n'), 'changed by the thread\n')
    assert.match(git(r.agent, 'log', '-1', '--format=%s', 'hoai/thread-304'), /Uncommitted work of the thread/)
    assert.equal(r.kept.length, 1)
    assert.match(r.kept[0]!.reason, /uncommitted changes of its worktree were saved/)
    assert.equal(readFileSync(join(r.agent, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'a\n', 'the main checkout\'s file is as it was')
  } finally {
    r.cleanup()
  }
})

test('close keeps a worktree whose HEAD is detached, with whatever it holds', async () => {
  const r = setup()
  try {
    const folder = await openThread(r, '305')
    git(folder, 'checkout', '-q', '--detach')
    writeFileSync(join(folder, 'loose.txt'), 'on no branch\n')
    git(folder, 'add', '.')
    git(folder, 'commit', '-qm', 'detached work')
    await r.manager.close({ rootId: '305', removeWorktree: false })
    await r.manager.idle()
    assert.ok(existsSync(join(folder, 'loose.txt')), 'the only copy of that commit\'s checkout stays')
    assert.deepEqual(await r.manager.sweepLeftovers(), [], 'and no later sweep takes it for an orphan')
    assert.ok(existsSync(join(folder, 'loose.txt')))
    assert.equal(r.kept.length, 1)
    assert.equal(r.kept[0]!.folder, folder)
    assert.match(r.kept[0]!.reason, /not on the thread's own branch/)
  } finally {
    r.cleanup()
  }
})

test('the start sweep removes an orphan worktree with a real git, and keeps its branch only when it holds work', async () => {
  const r = setup()
  try {
    git(r.agent, 'worktree', 'add', '-q', join('.hoai', 'threads', '401'), '-b', 'hoai/thread-401')
    git(r.agent, 'worktree', 'add', '-q', join('.hoai', 'threads', '402'), '-b', 'hoai/thread-402')
    writeFileSync(join(r.agent, '.hoai', 'threads', '402', 'kept.txt'), 'uncommitted in an orphan\n')
    assert.deepEqual((await r.manager.sweepLeftovers()).sort(), ['401', '402'])
    assert.equal(existsSync(join(r.agent, '.hoai', 'threads', '401')), false)
    assert.equal(existsSync(join(r.agent, '.hoai', 'threads', '402')), false)
    assert.equal(worktrees(r.agent), 1)
    assert.deepEqual(branches(r.agent), ['feature/x', 'hoai/thread-402', 'main'])
    assert.equal(git(r.agent, 'show', 'hoai/thread-402:kept.txt').replace(/\r\n/g, '\n'), 'uncommitted in an orphan\n')
  } finally {
    r.cleanup()
  }
})
