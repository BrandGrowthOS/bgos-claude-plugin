/**
 * Thread lanes against a REAL git, in a throwaway repository made in a temp
 * folder (the unit tests in test/thread-lanes.test.ts use a fake git): the
 * worktree and its branch are made, the `-b` refusal falls back to the branch
 * left from an earlier worktree, the lane's sandbox protects the source
 * repository's own git state, and Delete removes the worktree and only its
 * branch. claude itself is a fake: no process starts.
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
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
}

function setup(opts: { platform?: NodeJS.Platform } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'thread-git-')))
  const agent = join(dir, 'agent')
  mkdirSync(agent)
  git(agent, 'init', '-q', '-b', 'main')
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
    shellSandbox: () => true,
    platform: opts.platform ?? process.platform,
    processes: { stamp: () => null, kill: () => {} },
    git: async (args, cwd) => {
      try {
        const { stdout } = await run('git', args, { cwd })
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
    log: () => {},
  })
  return { dir, agent, manager, spawned, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

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
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'hoai/thread-101')
    assert.match(readFileSync(join(r.agent, '.git', 'info', 'exclude'), 'utf8'), /^\.hoai\/$/m)
    assert.equal(git(r.agent, 'status', '--porcelain'), '', 'the main checkout sees nothing new')
    const common = join(r.agent, '.git')
    assert.deepEqual(denyWrite(r.spawned[0]!.args).sort(), [
      join(common, 'HEAD'),
      join(common, 'index'),
      join(common, 'packed-refs'),
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
    const deny = denyWrite(r.spawned[1]!.args)
    assert.ok(deny.includes(join(r.agent, '.git', 'worktrees', '103')))
    assert.equal(deny.includes(join(r.agent, '.git', 'worktrees', '102')), false)
    assert.ok(deny.includes(join(r.agent, '.git', 'refs', 'heads', 'hoai', 'thread-103')))
    await r.manager.close({ rootId: '102', removeWorktree: true })
    r.spawned[1]!.child.exit()
    await r.manager.idle()
    assert.equal(existsSync(wt), false)
    const branches = git(r.agent, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()
    assert.deepEqual(branches, ['feature/x', 'hoai/thread-103', 'main'])
    assert.doesNotMatch(git(r.agent, 'worktree', 'list'), /threads\/102/)
  } finally {
    r.cleanup()
  }
})

test('a real git on Linux: branches kept only in packed-refs are written out loose, same commits, and git reads the repository as before', async () => {
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
