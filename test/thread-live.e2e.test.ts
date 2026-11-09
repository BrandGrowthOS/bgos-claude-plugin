/**
 * A THREAD ON A REAL CLAUDE CODE AGENT GETS AN ANSWER (THREADCRASH, 0.87.1).
 *
 * 0.87.0 shipped threads whose unit tests all passed, and on a real agent
 * (days of history in its main session, a 6.5 GB repository as its folder)
 * the first thread message took the daemon down: it read the whole main
 * transcript into one string on its event loop to clear an inherited /goal.
 * Fakes never ran that path at that size. This runs the REAL daemon (server.ts
 * under bun) with the REAL Claude Code CLI as its thread lane, against a stand
 * in BGOS backend and a stand in Anthropic API on 127.0.0.1, in a sandboxed
 * HOME and CLAUDE_CONFIG_DIR with a made up key: no real account, no real key
 * (test/helpers/thread-daemon-harness.ts).
 *
 * Release gate (docs/release-checklist.md): a release that touches threads
 * runs this with HOAI_LIVE_THREAD=1, which turns a skip (no claude here) into
 * a failure:
 *
 *   HOAI_LIVE_THREAD=1 npx tsx --test test/thread-live.e2e.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { BUN, realClaude, startDaemonHarness, waitFor, sleep, type DaemonHarness } from './helpers/thread-daemon-harness.ts'

const REQUIRED = process.env.HOAI_LIVE_THREAD === '1'
const CLAUDE = realClaude()
const CLAUDE_VERSION = CLAUDE ? (spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '').trim() : ''
const missing =
  process.platform === 'win32' ? 'threads run on macOS and Linux only' : !BUN ? 'needs bun' : !CLAUDE ? 'needs the claude CLI (or HOAI_LIVE_CLAUDE)' : ''
if (REQUIRED && missing) {
  test('the live thread gate can run here', () => {
    assert.fail(`HOAI_LIVE_THREAD=1 but this machine cannot run the live thread test: ${missing}`)
  })
}
const SKIP = missing || false
const OPTS = { skip: SKIP, timeout: 200_000 }

const replies = (h: DaemonHarness) => h.posts.filter((p) => p.path === 'integrations/threads/reply').map((p) => p.body ?? {})
const states = (h: DaemonHarness) => h.posts.filter((p) => p.path === 'integrations/threads/state').map((p) => `${p.body?.rootId}:${p.body?.state}`)

/** The daemon's resident memory in bytes, sampled until stopped. */
function sampleRss(pid: number): { stop(): Promise<{ first: number; peak: number }> } {
  let first = 0
  let peak = 0
  let running = true
  const loop = (async () => {
    while (running) {
      try {
        const { stdout } = await promisify(execFile)('ps', ['-o', 'rss=', '-p', String(pid)])
        const kb = Number(String(stdout).trim())
        if (Number.isFinite(kb) && kb > 0) {
          if (!first) first = kb * 1024
          peak = Math.max(peak, kb * 1024)
        }
      } catch {}
      await sleep(50)
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop
      return { first, peak }
    },
  }
}

test(`a thread on a real Claude Code agent (${CLAUDE_VERSION || 'no claude'}) gets an answer in the thread`, OPTS, async () => {
  const h = await startDaemonHarness({ claude: CLAUDE })
  try {
    h.threadTurn({ rpcId: 'rpc-live-1', chatId: '7', rootId: 'R1', replyId: 'p1', text: 'THREAD-QUESTION which word did I ask you to remember?' })
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 120_000)
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    const [reply] = replies(h)
    assert.ok(reply, `no thread reply${h.tail()}`)
    assert.match(String(reply.text), /^THREAD-ANSWER-\d+$/, `the lane's own answer${h.tail()}`)
    assert.equal(reply.rootId, 'R1')
    assert.deepEqual(states(h).slice(0, 1), ['R1:working'])
    // The lane really forked the main session: the fake API saw the main turn's word in the thread's request.
    const threadRequest = h.api.requests.find((r) => JSON.stringify(r.messages ?? '').includes('THREAD-QUESTION'))
    assert.ok(threadRequest && JSON.stringify(threadRequest.messages).includes('PELICAN'), 'the thread knows the main conversation')
    assert.ok(existsSync(join(h.folder, '.hoai', 'threads', 'R1', '.git')), 'a small repository gets its worktree')
  } finally {
    await h.close()
  }
})

test('a long lived agent: a thread on a 300 MB main transcript keeps the daemon up and small, and the main chat keeps working', OPTS, async () => {
  const h = await startDaemonHarness({ claude: CLAUDE, padMainTranscriptBytes: 300 * 1024 * 1024 })
  try {
    assert.ok(h.pid, 'the daemon pid')
    const rss = sampleRss(h.pid!)
    await sleep(300)
    h.threadTurn({ rpcId: 'rpc-live-2', chatId: '7', rootId: 'R2', replyId: 'p2', text: 'THREAD-QUESTION are you there?' })
    // The owner keeps talking in the main chat while the thread opens.
    const sentAt = Date.now()
    const id = h.pushChatMessage('main chat while a thread opens')
    await waitFor(() => h.channelCards.some((c) => c.messageId === id) || h.exited !== null, 30_000)
    const card = h.channelCards.find((c) => c.messageId === id)
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 120_000)
    const { first, peak } = await rss.stop()
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    assert.ok(card, `the main chat message never reached the session${h.tail()}`)
    assert.ok(card.at - sentAt < 15_000, `the main chat waited ${card.at - sentAt} ms`)
    assert.match(String(replies(h)[0]?.text), /^THREAD-ANSWER-\d+$/, `the thread answered${h.tail()}`)
    // 0.87.0 grew by about 4.5 times the transcript here (over 1.3 GB) before it died on a real agent.
    const grew = peak - first
    assert.ok(grew < 256 * 1024 * 1024, `the daemon grew ${Math.round(grew / 1048576)} MB while the thread opened`)
  } finally {
    await h.close()
  }
})

test('a thread that cannot open says so in its own thread, and the daemon and the main chat go on', OPTS, async () => {
  const h = await startDaemonHarness({ claude: CLAUDE })
  try {
    // A file where the threads folder must go: no worktree can be made.
    mkdirSync(join(h.folder, '.hoai'), { recursive: true })
    writeFileSync(join(h.folder, '.hoai', 'threads'), 'not a folder\n')
    h.threadTurn({ rpcId: 'rpc-live-3', chatId: '7', rootId: 'R3', replyId: 'p3', text: 'THREAD-QUESTION hello?' })
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 60_000)
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    assert.match(String(replies(h)[0]?.text), /^I could not open this thread: /, `a plain failure in the thread${h.tail()}`)
    assert.equal(replies(h)[0]?.rootId, 'R3')
    assert.ok(states(h).includes('R3:open'), 'the thread is open again, never stuck at working')
    assert.ok(h.stderr.some((l) => l.includes('threads: turn R3 could not start')), 'one plain log line')
    const id = h.pushChatMessage('main chat after a failed thread')
    await waitFor(() => h.channelCards.some((c) => c.messageId === id), 30_000)
    assert.ok(h.channelCards.some((c) => c.messageId === id), `the main chat still works${h.tail()}`)
  } finally {
    await h.close()
  }
})

test('a repository too large to copy runs its thread read only in place, with no worktree, and it answers', OPTS, async () => {
  const h = await startDaemonHarness({
    claude: CLAUDE,
    repoFiles: { 'data/blob.bin': 3 * 1024 * 1024 },
    env: { HOAI_THREAD_COPY_LIMIT_BYTES: String(1024 * 1024) },
  })
  try {
    h.threadTurn({ rpcId: 'rpc-live-4', chatId: '7', rootId: 'R4', replyId: 'p4', text: 'THREAD-QUESTION read only?' })
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 120_000)
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    assert.match(String(replies(h)[0]?.text), /^THREAD-ANSWER-\d+$/, `the thread answered${h.tail()}`)
    assert.ok(h.stderr.some((l) => l.includes('threads: thread R4 runs read only in the agent folder, no worktree')), h.tail())
    assert.equal(existsSync(join(h.folder, '.hoai', 'threads', 'R4', '.git')), false, 'no checkout')
    assert.equal(existsSync(join(h.folder, '.hoai', 'threads', 'R4', 'data', 'blob.bin')), false, 'nothing copied')
    const worktrees = spawnSync('git', ['worktree', 'list'], { cwd: h.folder, encoding: 'utf8' }).stdout
    assert.equal(worktrees.trim().split('\n').length, 1, `only the agent folder itself: ${worktrees}`)
  } finally {
    await h.close()
  }
})
