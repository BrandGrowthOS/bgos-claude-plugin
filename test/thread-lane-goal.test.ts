/**
 * A thread never answers when the main session has an active /goal (THREADGOAL).
 *
 * A thread lane forks the agent's MAIN session. Claude Code's /goal is a
 * session scoped Stop hook restored from the transcript, so before this fix
 * the fork inherited it: every time the thread tried to end its turn the goal
 * checker answered "Not satisfied" and blocked the stop, the CLI gave up after
 * 9 blocks with an EMPTY result, and the person saw "This turn failed before
 * the agent could answer". The lane's own `--settings` now carry
 * `disableAllHooks: true` (the documented switch, honoured under
 * --restricted; the CLI refuses /goal itself while it is set), and the start
 * prompt says the main chat's goal does not apply in the thread.
 *
 * The pure half always runs. The real CLI half is opt in like
 * test/thread-lane-sandbox.test.ts: THREADS_GOAL_CLAUDE=/absolute/path/to/claude.
 * It makes a real parent session with a real /goal against a local scripted
 * API (no model runs, a dummy key), then runs a real thread through
 * ThreadLaneManager. A control run of the same fork without the switch shows
 * the fixture's goal is live in a fork (it loops on the checker), and that the
 * manager's defence stops it with a failure that names the cause.
 */

import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { assertConfined, threadLaneArgs, threadLaneSettings, threadTurnPrompt } from '../lib/thread-lane-args.ts'
import { ThreadLaneManager, type ThreadLaneDeps } from '../lib/thread-lanes.ts'
import { spawnStreamJson } from '../lib/stream-json-child.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
const FORK = 'dbd3b62b-f099-4f95-be1d-4687b4af9042'
const MCP = '/state/threads/empty-mcp.json'
const ROOT = '/work/atlas/.hoai/threads/101'
const CONFINEMENTS = {
  'working with the Bash sandbox': { root: ROOT, readOnly: false, shellSandbox: true, protectedPaths: ['/work/atlas/.git/index'], platform: 'darwin' as const },
  'working without Bash': { root: ROOT, readOnly: false, shellSandbox: false, platform: 'darwin' as const },
  'read only': { root: ROOT, readOnly: true, shellSandbox: false, readDirs: ['/work/atlas'], platform: 'darwin' as const },
}

function settingsOf(args: readonly string[]): Record<string, unknown> {
  const at = args.indexOf('--settings')
  assert.ok(at >= 0, '--settings is present')
  return JSON.parse(args[at + 1]!) as Record<string, unknown>
}

for (const [name, confinement] of Object.entries(CONFINEMENTS)) {
  test(`a ${name} lane runs no hook at all, so it never inherits the main session's /goal Stop hook`, () => {
    assert.equal(threadLaneSettings(confinement).disableAllHooks, true)
    const first = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement })
    const later = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: FORK, emptyMcpConfigPath: MCP, confinement })
    assert.equal(settingsOf(first).disableAllHooks, true, 'the first start, which forks the main session')
    assert.equal(settingsOf(later).disableAllHooks, true, 'every later start, which resumes the fork (it holds the goal too)')
  })
}

test('a lane command whose settings would let hooks run is refused, like any other unconfined lane', () => {
  const args = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: CONFINEMENTS['working without Bash'] })
  assert.doesNotThrow(() => assertConfined(args))
  const at = args.indexOf('--settings')
  const without = (patch: Record<string, unknown>) => {
    const copy = [...args]
    copy[at + 1] = JSON.stringify({ ...settingsOf(args), ...patch })
    return copy
  }
  assert.throws(() => assertConfined(without({ disableAllHooks: false })), /hook/)
  assert.throws(() => assertConfined(without({ disableAllHooks: undefined })), /hook/)
  const broken = [...args]
  broken[at + 1] = 'not json'
  assert.throws(() => assertConfined(broken), /hook/)
})

test('the first turn of a thread tells the fork that the main chat\'s goal does not apply here', () => {
  const text = threadTurnPrompt({ mode: 'start', text: 'What is two plus two?', title: 'Sum', rootText: 'A question.' })
  assert.match(text, /goal \(\/goal\) set in the main conversation does not apply in this thread/)
  assert.match(text, /Answer only this thread's message\./)
  assert.ok(text.endsWith('\n\nWhat is two plus two?'))
})

// ── The real CLI ─────────────────────────────────────────────────────────────

const claude = process.env.THREADS_GOAL_CLAUDE
const CONDITION = 'the file done.txt contains GOALPROBE'
const QUESTION = 'THREAD-QUESTION: what is two plus two?'

interface ApiLog { judge: number; main: number; mainAnswers: string[] }

/** The scripted API: the goal checker always answers "not met", any other request gets a plain answer. */
async function fakeApi(): Promise<{ url: string; log: ApiLog; reset(): void; close(): Promise<void> }> {
  const log: ApiLog = { judge: 0, main: 0, mainAnswers: [] }
  let n = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (req.url?.includes('count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":1}')
      return
    }
    if (!req.url?.includes('/messages')) {
      res.writeHead(404).end()
      return
    }
    // The goal checker: a stop-condition prompt with no tools (its system prompt, measured on 2.1.319).
    const judge = /stop-condition hook/.test(JSON.stringify(body.system ?? '')) && !(body.tools?.length > 0)
    const step = n++
    const text = judge ? '{"ok": false, "reason": "Not satisfied: done.txt is missing"}' : `PLAIN-ANSWER-${step}`
    if (judge) log.judge++
    else {
      log.main++
      log.mainAnswers.push(text)
    }
    const usage = { input_tokens: 1, output_tokens: 1 }
    const message = { id: `msg_${step}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    event('message_start', { message: { ...message, content: [], stop_reason: null } })
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    event('content_block_stop', { index: 0 })
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })
    event('message_stop', {})
    res.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    reset() { log.judge = 0; log.main = 0; log.mainAnswers = [] },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

function transcriptRows(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const feedbackRows = (rows: Array<Record<string, any>>) =>
  rows.filter((r) => r.type === 'user' && JSON.stringify(r.message?.content ?? '').includes('Stop hook feedback'))

test('a real thread forked from a session with an active /goal answers its own message, and a fork with hooks on is stopped with its cause', {
  skip: !claude || process.platform === 'win32', timeout: 120_000,
}, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'thread-goal-')))
  const home = join(dir, 'home')
  const configDir = join(dir, 'config')
  const agent = join(dir, 'agent')
  const stateDir = join(home, '.bgos-agent', '7', 'threads')
  for (const path of [home, configDir, agent, stateDir]) mkdirSync(path, { recursive: true })
  const emptyMcp = join(stateDir, 'empty-mcp.json')
  writeFileSync(emptyMcp, '{"mcpServers":{}}')
  const api = await fakeApi()
  const env: Record<string, string> = {
    HOME: home, PATH: process.env.PATH ?? '', TMPDIR: dir,
    CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'local-test-not-a-real-key',
    ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const managers: ThreadLaneManager[] = []
  try {
    // 1. The parent: a real session with a real /goal that the checker never finds met.
    // Asynchronous: the scripted API answers from this same process.
    const parent = await promisify(execFile)(claude!, ['-p', '--output-format', 'stream-json', '--verbose', `/goal ${CONDITION}`], {
      cwd: agent, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    })
    const init = parent.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === 'system' && f.subtype === 'init')
    const mainId = String(init?.session_id)
    const mainPath = sessionTranscriptPath(home, agent, mainId, configDir)
    assert.ok(existsSync(mainPath), `the parent transcript is where the daemon looks for it: ${mainPath}`)
    const parentRows = transcriptRows(mainPath)
    const goalRows = parentRows.filter((r) => r.type === 'attachment' && r.attachment?.type === 'goal_status')
    assert.deepEqual(goalRows[0]?.attachment, { type: 'goal_status', met: false, sentinel: true, condition: CONDITION }, 'the goal was armed')
    assert.equal(goalRows.some((r) => r.attachment.met === true || r.attachment.failed === true), false, 'and is still active')
    assert.ok(api.log.judge >= 3, 'the parent goal Stop hook really blocked the parent')
    const inherited = feedbackRows(parentRows).length
    assert.ok(inherited >= 3)

    // 2. A thread through the real manager, real spawn, real files.
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const logs: string[] = []
    const manager = (patchArgs: (args: string[]) => string[]) => {
      const deps: ThreadLaneDeps = {
        spawn: (command, args, opts) => {
          const saved = process.env
          process.env = env
          try {
            return spawnStreamJson(command, patchArgs(args), opts)
          } finally {
            process.env = saved
          }
        },
        claudeBin: () => claude!,
        cliProblem: () => null,
        mainSessionId: () => mainId,
        agentFolder: agent,
        stateDir,
        home,
        configDir,
        emptyMcpConfigPath: () => emptyMcp,
        shellSandbox: () => false,
        platform: process.platform,
        processes: { stamp: async () => null, runsIn: async () => false, kill: () => {} },
        // The agent folder is no repository: a read only lane in a plain folder.
        git: async () => ({ ok: false, stdout: '' }),
        fs: {
          exists: (p) => existsSync(p),
          mkdir: (p) => { mkdirSync(p, { recursive: true }) },
          readFile: (p) => readFileSync(p, 'utf8'),
          writeFile: (p, d) => writeFileSync(p, d),
          appendFile: (p, d) => appendFileSync(p, d),
          copyFile: (a, b) => copyFileSync(a, b),
          unlink: (p) => unlinkSync(p),
          rmrf: (p) => rmSync(p, { recursive: true, force: true }),
          list: (d) => readdirSync(d),
          createExclusive: (p, d) => writeFileSync(p, d, { flag: 'wx' }),
          rename: (a, b) => renameSync(a, b),
        },
        post: async (path, body) => { posts.push({ path, body }) },
        now: () => Date.now(),
        setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        log: (msg) => { logs.push(msg) },
        killGraceMs: 2_000,
      }
      const m = new ThreadLaneManager(deps)
      managers.push(m)
      return m
    }
    const replyFor = async (rootId: string) => {
      const until = Date.now() + 60_000
      while (Date.now() < until) {
        const reply = posts.find((p) => p.path === 'integrations/threads/reply' && p.body.rootId === rootId)
        if (reply) return reply.body
        await new Promise((done) => setTimeout(done, 100))
      }
      assert.fail(`no reply was posted for thread ${rootId}: ${JSON.stringify(posts)} ${logs.join(' | ')}`)
    }
    const turn = (rootId: string) => ({ chatId: '55', rootId, replyId: `${rootId}0`, mode: 'start' as const, text: QUESTION, title: 'Sum', rootText: 'A question.' })
    const forkTranscript = (rootId: string) => {
      const state = JSON.parse(readFileSync(join(stateDir, `${rootId}.json`), 'utf8')) as { forkSessionId: string; cwd: string }
      return transcriptRows(sessionTranscriptPath(home, state.cwd, state.forkSessionId, configDir))
    }

    // The fix: the thread's own answer, one plain turn, no goal check at all.
    api.reset()
    const fixed = manager((args) => args)
    fixed.turn(turn('901'))
    const answer = await replyFor('901')
    assert.equal(api.log.judge, 0, 'the goal checker never ran in the thread')
    assert.equal(api.log.main, 1, 'one model call: the thread answered its message and its turn ended')
    assert.deepEqual(answer, { chatId: '55', rootId: '901', text: api.log.mainAnswers[0], final: true, clientId: 'thread-901-9010' })
    assert.equal(feedbackRows(forkTranscript('901')).length, inherited, 'no new Stop hook feedback in the fork')
    const sent = forkTranscript('901').filter((r) => r.type === 'user' && JSON.stringify(r.message?.content ?? '').includes(QUESTION))
    assert.equal(sent.length, 1, 'the thread received its own message')
    await fixed.stopAll()

    // The control (the mutant: the same fork with hooks on). The goal is live in a
    // fork, and the defence stops the loop with a failure that names its cause.
    api.reset()
    const hooksOn = manager((args) => {
      const at = args.indexOf('--settings')
      const copy = [...args]
      copy[at + 1] = JSON.stringify({ ...JSON.parse(args[at + 1]!), disableAllHooks: false })
      return copy
    })
    hooksOn.turn(turn('902'))
    const failure = await replyFor('902')
    assert.ok(api.log.judge >= 3, `with hooks on the fork ran the inherited goal checker (${api.log.judge} checks)`)
    assert.equal(failure.final, false)
    assert.match(String(failure.text), /Stop hook/)
    assert.match(String(failure.text), /\/goal/)
    assert.equal(posts.filter((p) => p.path === 'integrations/threads/reply' && p.body.rootId === '902').length, 1, 'one failure, never a loop of them')
    assert.ok(logs.some((l) => /Stop hook blocked/.test(l)), logs.join(' | '))
  } finally {
    for (const m of managers) await m.stopAll().catch(() => {})
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
