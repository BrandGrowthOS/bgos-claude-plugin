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
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
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
    assert.deepEqual(h.refused, [], `the server rule refused a thread reply${h.tail()}`)
    const sent = h.posts.find((p) => p.path === 'integrations/threads/reply')!.headers!
    assert.equal(sent['x-bgos-pairing'], 'TESTTOKEN', 'the real daemon sends its pairing token')
    assert.deepEqual(states(h).slice(0, 1), ['R1:working'])
    // The lane really forked the main session: the fake API saw the main turn's word in the thread's request.
    const threadRequest = h.api.requests.find((r) => JSON.stringify(r.messages ?? '').includes('THREAD-QUESTION'))
    assert.ok(threadRequest && JSON.stringify(threadRequest.messages).includes('PELICAN'), 'the thread knows the main conversation')
    // 0.88.0: the owner's own thread is a true fork in the agent's own folder: no worktree, no copy.
    assert.equal(existsSync(join(h.folder, '.hoai', 'threads', 'R1')), false, 'the owner\'s thread gets no worktree')
    const state = JSON.parse(readFileSync(join(h.stateDir, 'R1.json'), 'utf8'))
    assert.equal(state.access, 'full')
    assert.equal(realpathSync(state.cwd), realpathSync(h.folder), 'it runs in the agent\'s own folder')
    // It was told the folder is shared with the main session.
    assert.match(JSON.stringify(threadRequest!.messages), /the main session is still running here and may be editing files right now/)
    // The fork carries the main session's permission mode and is not confined.
    const system = JSON.stringify(threadRequest!.tools ?? [])
    assert.match(system, /"name":"Bash"/, 'Bash is among its tools')
    assert.match(system, /"name":"Edit"/)

    // Closing it leaves nothing of it on this computer, and the close line says how much it freed.
    const forkId = state.forkSessionId as string
    assert.match(forkId, /^[0-9a-f-]{36}$/)
    h.threadClose({ rpcId: 'rpc-live-1-close', chatId: '7', rootId: 'R1' })
    await waitFor(() => !existsSync(join(h.stateDir, 'R1.json')) || h.exited !== null, 30_000)
    assert.equal(existsSync(join(h.stateDir, 'R1.json')), false, `its lane state is gone${h.tail()}`)
    await waitFor(() => h.stderr.some((l) => /threads: thread R1 closed/.test(l)), 15_000)
    assert.match(h.stderr.find((l) => /threads: thread R1 closed/.test(l)) ?? '', /freed [1-9]\d* bytes \(\d+ (KB|MB)\)/, h.tail())
    const leftOfFork = spawnSync('find', [h.home, '-name', `${forkId}*`], { encoding: 'utf8' }).stdout.trim()
    assert.equal(leftOfFork, '', 'no file or folder named by the fork\'s session id is left under the home folder')

    // A thread a person the agent is shared with opens is confined as before: its own worktree.
    h.threadTurn({ rpcId: 'rpc-live-1b', chatId: '7', rootId: 'R1b', replyId: 'p1b', text: 'THREAD-QUESTION and for a person?', person: 'user_2person' })
    await waitFor(() => replies(h).some((r) => r.rootId === 'R1b') || h.exited !== null, 120_000)
    assert.match(String(replies(h).find((r) => r.rootId === 'R1b')?.text), /^THREAD-ANSWER-\d+$/, `the person's thread answered${h.tail()}`)
    assert.ok(existsSync(join(h.folder, '.hoai', 'threads', 'R1b', '.git')), 'a recipient\'s thread gets its own worktree')
    assert.equal(JSON.parse(readFileSync(join(h.stateDir, 'R1b.json'), 'utf8')).access, 'confined')
    // And closing that one removes its worktree.
    h.threadClose({ rpcId: 'rpc-live-1b-close', chatId: '7', rootId: 'R1b' })
    await waitFor(() => !existsSync(join(h.folder, '.hoai', 'threads', 'R1b')) || h.exited !== null, 30_000)
    assert.equal(existsSync(join(h.folder, '.hoai', 'threads', 'R1b')), false, `its worktree is removed at close${h.tail()}`)
    assert.equal(spawnSync('git', ['worktree', 'list'], { cwd: h.folder, encoding: 'utf8' }).stdout.trim().split('\n').length, 1, 'and pruned')
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
  } finally {
    await h.close()
  }
})

test('a thread answer the server refuses is tried once, is saved, and the owner is told in the thread', OPTS, async () => {
  const h = await startDaemonHarness({ claude: CLAUDE, refuseThreadReply: (body) => /^THREAD-ANSWER/.test(String(body?.text)) })
  try {
    h.threadTurn({ rpcId: 'rpc-live-refused', chatId: '7', rootId: 'R9', replyId: 'p9', text: 'THREAD-QUESTION are you there?' })
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 120_000)
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    assert.match(String(replies(h)[0]?.text), /refused/, `the owner is told${h.tail()}`)
    assert.equal(h.refused.length, 1, 'a real 403 reaches the lane as a refusal: no retry')
    assert.ok(states(h).includes('R9:open'), 'the thread is open again')
    assert.match(readFileSync(join(h.stateDir, 'R9.undelivered.txt'), 'utf8'), /THREAD-ANSWER-\d+/)
    assert.equal(statSync(join(h.stateDir, 'R9.undelivered.txt')).mode & 0o777, 0o600, 'only this user can read it')
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
    // 0.88.0: a confined thread (a person's) needs that folder; the owner's own full access thread does not (below).
    h.threadTurn({ rpcId: 'rpc-live-3', chatId: '7', rootId: 'R3', replyId: 'p3', text: 'THREAD-QUESTION hello?', person: 'user_2person' })
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 60_000)
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    assert.match(String(replies(h)[0]?.text), /^I could not open this thread: /, `a plain failure in the thread${h.tail()}`)
    assert.equal(replies(h)[0]?.rootId, 'R3')
    assert.ok(states(h).includes('R3:open'), 'the thread is open again, never stuck at working')
    assert.ok(h.stderr.some((l) => l.includes('threads: turn R3 could not start')), 'one plain log line')
    const id = h.pushChatMessage('main chat after a failed thread')
    await waitFor(() => h.channelCards.some((c) => c.messageId === id), 30_000)
    assert.ok(h.channelCards.some((c) => c.messageId === id), `the main chat still works${h.tail()}`)
    // The owner's own thread opens all the same: it needs no folder of its own.
    h.threadTurn({ rpcId: 'rpc-live-3o', chatId: '7', rootId: 'R3o', replyId: 'p3o', text: 'THREAD-QUESTION and the owner?' })
    await waitFor(() => replies(h).some((r) => r.rootId === 'R3o') || h.exited !== null, 120_000)
    assert.match(String(replies(h).find((r) => r.rootId === 'R3o')?.text), /^THREAD-ANSWER-\d+$/, `the owner's thread answered${h.tail()}`)
  } finally {
    await h.close()
  }
})

test('a repository too large to copy: a recipient\'s thread runs read only in place with no worktree, and the owner\'s thread is a full fork all the same', OPTS, async () => {
  const h = await startDaemonHarness({
    claude: CLAUDE,
    repoFiles: { 'data/blob.bin': 3 * 1024 * 1024 },
    env: { HOAI_THREAD_COPY_LIMIT_BYTES: String(1024 * 1024) },
  })
  try {
    h.threadTurn({ rpcId: 'rpc-live-4', chatId: '7', rootId: 'R4', replyId: 'p4', text: 'THREAD-QUESTION read only?', person: 'user_2person' })
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 120_000)
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    assert.match(String(replies(h)[0]?.text), /^THREAD-ANSWER-\d+$/, `the thread answered${h.tail()}`)
    assert.ok(h.stderr.some((l) => l.includes('threads: thread R4 runs read only in the agent folder, no worktree')), h.tail())
    assert.equal(existsSync(join(h.folder, '.hoai', 'threads', 'R4', '.git')), false, 'no checkout')
    assert.equal(existsSync(join(h.folder, '.hoai', 'threads', 'R4', 'data', 'blob.bin')), false, 'nothing copied')
    const worktrees = spawnSync('git', ['worktree', 'list'], { cwd: h.folder, encoding: 'utf8' }).stdout
    assert.equal(worktrees.trim().split('\n').length, 1, `only the agent folder itself: ${worktrees}`)
    // The recipient's thread was offered no Bash and no editing tool.
    const recipientRequest = h.api.requests.find((r) => JSON.stringify(r.messages ?? '').includes('THREAD-QUESTION read only?'))!
    const recipientTools = ((recipientRequest.tools ?? []) as Array<{ name: string }>).map((t) => t.name)
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) assert.equal(recipientTools.includes(tool), false, `${tool} is not offered to a read only thread`)
    assert.ok(recipientTools.includes('Read'))

    // 0.88.0: the owner, same repository, same limit: a full fork with every tool, nothing copied, not read only.
    h.threadTurn({ rpcId: 'rpc-live-4o', chatId: '7', rootId: 'R4o', replyId: 'p4o', text: 'THREAD-QUESTION full access?' })
    await waitFor(() => replies(h).some((r) => r.rootId === 'R4o') || h.exited !== null, 120_000)
    assert.match(String(replies(h).find((r) => r.rootId === 'R4o')?.text), /^THREAD-ANSWER-\d+$/, `the owner's thread answered${h.tail()}`)
    assert.equal(h.stderr.some((l) => l.includes('threads: thread R4o runs read only')), false, 'the owner\'s thread is never read only')
    assert.equal(existsSync(join(h.folder, '.hoai', 'threads', 'R4o')), false, 'and nothing is copied for it')
    const ownerRequest = h.api.requests.find((r) => JSON.stringify(r.messages ?? '').includes('THREAD-QUESTION full access?'))!
    const ownerTools = ((ownerRequest.tools ?? []) as Array<{ name: string }>).map((t) => t.name)
    for (const tool of ['Bash', 'Edit', 'Write', 'Read']) assert.ok(ownerTools.includes(tool), `${tool} is offered to the owner's thread`)
    assert.doesNotMatch(JSON.stringify(ownerRequest.messages), /This thread is read only/)
  } finally {
    await h.close()
  }
})

test('THREADGOAL: a thread clears the active main goal through the real daemon wiring, with no goal check', OPTS, async () => {
  const h = await startDaemonHarness({ claude: CLAUDE })
  try {
    const condition = 'the file threadgoal.txt contains THREADGOAL-LIVE-CONDITION'
    const rows: Array<{ uuid?: unknown }> = readFileSync(h.mainTranscript, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const parentUuid = rows.reverse().find((row) => typeof row.uuid === 'string')?.uuid
    assert.equal(typeof parentUuid, 'string', 'the goal attaches to the last transcript uuid so the CLI loads it')
    appendFileSync(h.mainTranscript, `${JSON.stringify({
      type: 'attachment', uuid: randomUUID(), parentUuid,
      sessionId: h.mainSessionId, cwd: h.folder, timestamp: new Date().toISOString(),
      attachment: { type: 'goal_status', met: false, sentinel: true, condition },
    })}\n`)
    const parent = readFileSync(h.mainTranscript, 'utf8')
    assert.equal(h.api.requests.length, 1, 'one request made the main session')
    h.threadTurn({ rpcId: 'rpc-live-5', chatId: '7', rootId: 'R5', replyId: 'p5', text: 'THREAD-QUESTION what is two plus two?' })
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 120_000)
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    assert.match(String(replies(h)[0]?.text), /^THREAD-ANSWER-\d+$/, `the thread answered${h.tail()}`)
    assert.equal(h.api.requests.length, 2, 'only the main turn and the thread turn, with no inherited goal check')
    assert.equal(h.api.requests.some((request) => JSON.stringify(request).includes(condition)), false, 'no API request names the main goal condition')
    assert.equal(readFileSync(h.mainTranscript, 'utf8'), parent, 'the main goal stays active and the parent is untouched')
  } finally {
    await h.close()
  }
})

test('THREADFIX: a thread on an agent whose main session has a live background task gets its answer, never the failure sentence', OPTS, async () => {
  const h = await startDaemonHarness({ claude: CLAUDE, mainBackgroundTask: true })
  try {
    h.threadTurn({ rpcId: 'rpc-live-6', chatId: '7', rootId: 'R6', replyId: 'p6', text: 'THREAD-QUESTION are you there?' })
    await waitFor(() => replies(h).length > 0 || h.exited !== null, 120_000)
    // Before the fix the failure sentence came first and the answer was dropped: give a second reply time to show.
    await waitFor(() => replies(h).some((r) => /^THREAD-ANSWER/.test(String(r.text))), 20_000)
    await sleep(1_000)
    assert.equal(h.exited, null, `the daemon went away${h.tail()}`)
    assert.deepEqual(replies(h).map((r) => String(r.text).replace(/\d+$/, 'N')), ['THREAD-ANSWER-N'], `one reply, the lane's own answer${h.tail()}`)
    assert.equal(states(h).includes('R6:open'), false, `never reported as failed${h.tail()}`)
    // The fork really was of a session with a background task: the thread's request carries the main turn that started it.
    const threadRequest = h.api.requests.find((r) => JSON.stringify(r.messages ?? '').includes('THREAD-QUESTION'))
    assert.ok(threadRequest && JSON.stringify(threadRequest.messages).includes('run_in_background'), 'the thread forked the session that started the background task')
    // Not asserted: a CLI that stops sending the empty result for the notice is fine too.
    console.log(`THREADFIX live: ${CLAUDE_VERSION}, results skipped as not the turn's answer: ${h.stderr.filter((l) => l.includes('skipped a result')).length}`)
  } finally {
    await h.close()
  }
})
