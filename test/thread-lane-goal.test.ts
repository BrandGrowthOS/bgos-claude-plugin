/**
 * THREADGOAL2: restricted forks retain trusted non-Stop hooks and clear only
 * their inherited goal state. The opt-in real CLI test uses a local fake API,
 * dummy credentials and isolated state. It checks the active parent, a fork,
 * a later process resuming that fork, guard canaries and a looping control.
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
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { assertConfined, threadLaneArgs, threadLaneSettings, threadLaneTranscript, threadTurnPrompt } from '../lib/thread-lane-args.ts'
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
  test(`a ${name} lane keeps trusted guards on first start and resume, with no Stop hook`, () => {
    for (const forkSessionId of [null, FORK]) {
      const args = threadLaneArgs({ mainSessionId: MAIN, forkSessionId, emptyMcpConfigPath: MCP, confinement })
      const settings = settingsOf(args)
      assert.notEqual(settings.disableAllHooks, true)
      const hooks = settings.hooks as Record<string, unknown>
      assert.ok(hooks?.UserPromptSubmit, 'the private prompt boundary remains')
      assert.ok(hooks?.PreToolUse, 'the floor and private tool guard remain')
      assert.equal(hooks.Stop, undefined, 'no parent Stop hook is installed')
    }
  })
}

test('a lane refuses global hook suppression, missing or altered trusted guards, Stop hooks and malformed settings', () => {
  const args = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: CONFINEMENTS['working without Bash'] })
  assert.doesNotThrow(() => assertConfined(args))
  const at = args.indexOf('--settings')
  const patched = (patch: Record<string, unknown>) => {
    const copy = [...args]
    copy[at + 1] = JSON.stringify({ ...settingsOf(args), ...patch })
    return copy
  }
  assert.throws(() => assertConfined(patched({ disableAllHooks: true })), /hook/)
  assert.throws(() => assertConfined(patched({ disableAllHooks: 'true' })), /hook/)
  assert.throws(() => assertConfined(patched({ hooks: undefined })), /hook/)
  assert.throws(() => assertConfined(patched({ hooks: { ...settingsOf(args).hooks as object, PreToolUse: [] } })), /hook/)
  assert.throws(() => assertConfined(patched({ hooks: { ...settingsOf(args).hooks as object, Stop: [] } })), /hook/)
  const broken = [...args]
  broken[at + 1] = 'not json'
  assert.throws(() => assertConfined(broken), /hook/)
})

test('goal clearing preserves completed goals and transcript links, and is idempotent', () => {
  const row = { type: 'attachment', uuid: 'fixture-row', parentUuid: 'fixture-parent', attachment: { type: 'goal_status', met: false, condition: 'fixture goal', reason: 'not met yet' } }
  const source = `${JSON.stringify(row)}\n{"type":"user","message":"keep me"}\n`
  const cleared = threadLaneTranscript(source)
  assert.deepEqual(JSON.parse(cleared.split('\n')[0]!), { ...row, attachment: { type: 'goal_status', condition: row.attachment.condition, met: true, sentinel: true } })
  assert.ok(cleared.endsWith('\n{"type":"user","message":"keep me"}\n'))
  assert.equal(threadLaneTranscript(cleared), cleared)
  for (const attachment of [{ ...row.attachment, met: true }, { ...row.attachment, failed: true }]) {
    const history = `${source}${JSON.stringify({ ...row, attachment })}\n`
    assert.equal(threadLaneTranscript(history), history, 'a terminal goal never revives an earlier active one')
  }
  assert.equal(threadLaneTranscript(''), '')
})

test('the first turn of a thread tells the fork that the main chat\'s goal does not apply here', () => {
  const text = threadTurnPrompt({ mode: 'start', text: 'What is two plus two?', title: 'Sum', rootText: 'A question.' })
  assert.match(text, /goal \(\/goal\) set in the main conversation does not apply in this thread/)
  assert.match(text, /Answer only this thread's message\./)
  assert.ok(text.endsWith('\n\nWhat is two plus two?'))
})

// The real CLI

const claude = process.env.THREADS_GOAL_CLAUDE
const CONDITION = 'the file done.txt contains GOALPROBE'
const QUESTION = 'THREAD-QUESTION: what is two plus two?'

interface ApiLog { judge: number; main: number; mainAnswers: string[]; tools: number }

/** The scripted API: the goal checker always answers "not met", any other request gets a plain answer. */
async function fakeApi(): Promise<{ url: string; log: ApiLog; reset(): void; close(): Promise<void> }> {
  const log: ApiLog = { judge: 0, main: 0, mainAnswers: [], tools: 0 }
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
    const questionAt = body.messages?.findLastIndex((m: { role: string; content: unknown }) => m.role === 'user' && JSON.stringify(m.content).includes(QUESTION)) ?? -1
    const probeAt = body.messages?.findLastIndex((m: { role: string; content: unknown }) => m.role === 'assistant' && JSON.stringify(m.content).includes('mcp__hoai-browser__probe')) ?? -1
    const tool = !judge && questionAt > probeAt
      ? body.tools?.find((t: { name: string }) => t.name === 'mcp__hoai-browser__probe') : undefined
    if (tool) log.tools++
    const content = tool ? { type: 'tool_use', id: `tool_${step}`, name: tool.name, input: {} } : { type: 'text', text }
    const usage = { input_tokens: 1, output_tokens: 1 }
    const message = { id: `msg_${step}`, type: 'message', role: 'assistant', model: body.model, content: [content], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage }
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    event('message_start', { message: { ...message, content: [], stop_reason: null } })
    event('content_block_start', { index: 0, content_block: tool ? content : { type: 'text', text: '' } })
    if (!tool) event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    event('content_block_stop', { index: 0 })
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage })
    event('message_stop', {})
    res.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    reset() { log.judge = 0; log.main = 0; log.mainAnswers = []; log.tools = 0 },
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

test('real CLI: active parent goal stays in the parent, trusted guards fire in the fork and its resume, third-block control terminates', {
  skip: !claude || process.platform === 'win32', timeout: 180_000,
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
  // Only the canary run swaps the empty MCP config for a harmless local tool.
  // Production commands still expose no MCP tool. Matchers and guard bodies stay intact.
  const canaryLog = join(dir, 'guards.jsonl')
  const wrapper = join(dir, 'guard-canary.mjs')
  writeFileSync(wrapper, `import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const input = readFileSync(0);
const child = spawnSync(process.execPath, [process.argv[2]], { input, env: process.env });
appendFileSync(process.argv[3], JSON.stringify({ hook: process.argv[2].split('/').pop(), event: JSON.parse(input).hook_event_name, code: child.status }) + '\\n');
process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? ''); process.exit(child.status ?? 1);
`)
  const mcpScript = join(dir, 'probe-mcp.mjs')
  writeFileSync(mcpScript, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : m.method === 'tools/list' ? { tools: [{ name: 'probe', description: 'A harmless canary', inputSchema: { type: 'object', properties: {} } }] }
    : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'CANARY-OK' }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`)
  const canaryMcp = join(dir, 'canary-mcp.json')
  writeFileSync(canaryMcp, JSON.stringify({ mcpServers: { 'hoai-browser': { command: process.execPath, args: [mcpScript] } } }))
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  const canaries = (args: string[]) => {
    const copy = [...args]
    const at = copy.indexOf('--settings')
    const settings = JSON.parse(copy[at + 1]!)
    for (const event of ['UserPromptSubmit', 'PreToolUse']) {
      for (const matcher of settings.hooks[event]) {
        for (const hook of matcher.hooks) {
          const name = ['hoai-private-turn-hook.mjs', 'hoai-floor-hook.mjs'].find((name) => hook.command.includes(name))
          if (name) hook.command = `node ${quote(wrapper)} ${quote(fileURLToPath(new URL(`../bin/${name}`, import.meta.url)))} ${quote(canaryLog)}`
        }
      }
    }
    settings.permissions.allow.push('mcp__hoai-browser__probe')
    copy[at + 1] = JSON.stringify(settings)
    copy[copy.indexOf('--mcp-config') + 1] = canaryMcp
    return copy
  }
  const guardRows = () => transcriptRows(canaryLog)
  const assertCanaries = (rows: Array<Record<string, any>>) => {
    for (const [hook, event] of [
      ['hoai-private-turn-hook.mjs', 'UserPromptSubmit'],
      ['hoai-floor-hook.mjs', 'PreToolUse'],
      ['hoai-private-turn-hook.mjs', 'PreToolUse'],
    ]) assert.ok(rows.some((r) => r.hook === hook && r.event === event && r.code === 0), `${event}: ${hook} executed successfully`)
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
    const parentBytes = readFileSync(mainPath, 'utf8')
    const parentRows = transcriptRows(mainPath)
    const goalRows = parentRows.filter((r) => r.type === 'attachment' && r.attachment?.type === 'goal_status')
    assert.deepEqual(goalRows[0]?.attachment, { type: 'goal_status', met: false, sentinel: true, condition: CONDITION }, 'the goal was armed')
    assert.equal(goalRows.some((r) => r.attachment.met === true || r.attachment.failed === true), false, 'and is still active')
    assert.ok(api.log.judge >= 3, 'the parent goal Stop hook really blocked the parent')
    // Compare our sentinel to the supported CLI command, without changing the parent.
    const cleared = await promisify(execFile)(claude!, ['-p', '--resume', mainId, '--fork-session', '--output-format', 'stream-json', '--verbose', '/goal clear'], {
      cwd: agent, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    })
    const clearInit = cleared.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((r) => r.type === 'system' && r.subtype === 'init')
    const clearRows = transcriptRows(sessionTranscriptPath(home, agent, clearInit.session_id, configDir))
    assert.deepEqual(clearRows.filter((r) => r.type === 'attachment' && r.attachment?.type === 'goal_status').at(-1)?.attachment,
      { type: 'goal_status', met: true, sentinel: true, condition: CONDITION }, 'real /goal clear uses the documented sentinel')
    const preparedRows = threadLaneTranscript(parentBytes).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(preparedRows.filter((r) => r.type === 'attachment' && r.attachment?.type === 'goal_status').at(-1)?.attachment, clearRows.filter((r) => r.type === 'attachment' && r.attachment?.type === 'goal_status').at(-1)?.attachment)
    const inherited = feedbackRows(parentRows).length
    assert.ok(inherited >= 3)

    // 2. A thread through the real manager, real spawn, real files.
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const logs: string[] = []
    const signals: Array<{ cwd: string; signal: string }> = []
    const manager = (patchArgs: (args: string[], cwd: string) => string[]) => {
      const deps: ThreadLaneDeps = {
        spawn: (command, args, opts) => {
          const saved = process.env
          process.env = env
          try {
            const child = spawnStreamJson(command, patchArgs(args, opts.cwd), opts)
            return { ...child, kill(signal) { signals.push({ cwd: opts.cwd, signal }); child.kill(signal) } }
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
    const replyFor = async (rootId: string, nth = 0) => {
      const until = Date.now() + 60_000
      while (Date.now() < until) {
        const reply = posts.filter((p) => p.path === 'integrations/threads/reply' && p.body.rootId === rootId)[nth]
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

    // First prove the unmodified production command, with its empty MCP config.
    api.reset()
    const plain = manager((args) => args)
    plain.turn(turn('900'))
    assert.equal((await replyFor('900')).final, true)
    assert.equal(api.log.judge, 0)
    assert.equal(api.log.main, 1)
    await plain.stopAll()

    // Exercise the exact trusted matchers with a harmless fixture MCP tool.
    api.reset()
    const fixed = manager(canaries)
    fixed.turn(turn('901'))
    const answer = await replyFor('901')
    assert.equal(api.log.judge, 0, 'the goal checker never ran in the thread')
    assert.equal(api.log.main, 2, 'one harmless tool call followed by the answer')
    assert.equal(api.log.tools, 1)
    assertCanaries(guardRows())
    assert.deepEqual(answer, { chatId: '55', rootId: '901', text: api.log.mainAnswers.at(-1), final: true })
    assert.equal(feedbackRows(forkTranscript('901')).length, inherited, 'no new Stop hook feedback in the fork')
    const sent = forkTranscript('901').filter((r) => r.type === 'user' && JSON.stringify(r.message?.content ?? '').includes(QUESTION))
    assert.equal(sent.length, 1, 'the thread received its own message')
    await fixed.stopAll()
    const count = guardRows().length
    const firstState = JSON.parse(readFileSync(join(stateDir, '901.json'), 'utf8'))
    api.reset()
    const resumed = manager(canaries)
    resumed.turn({ ...turn('901'), mode: 'reply', replyId: '9011', text: QUESTION })
    const second = await replyFor('901', 1)
    assert.equal(second.final, true)
    assert.equal(api.log.judge, 0, 'no inherited goal on a later resumed process')
    assert.equal(api.log.main, 2)
    assert.equal(api.log.tools, 1)
    assertCanaries(guardRows().slice(count))
    assert.equal(JSON.parse(readFileSync(join(stateDir, '901.json'), 'utf8')).forkSessionId, firstState.forkSessionId)
    assert.equal(readFileSync(mainPath, 'utf8'), parentBytes, 'the active parent is unchanged')
    await resumed.stopAll()

    // The control bypasses only goal clearing; trusted hooks remain identical.
    // The defence stops the inherited goal loop and names its cause.
    api.reset()
    const hooksOn = manager((args, cwd) => {
      // Restore the untouched active parent in the child copy, bypassing only goal clearing.
      writeFileSync(sessionTranscriptPath(home, cwd, mainId, configDir), parentBytes)
      return args
    })
    hooksOn.turn(turn('902'))
    const failure = await replyFor('902')
    assert.equal(api.log.judge, 3, 'the control is terminated on the third block, before the CLI cap of nine')
    assert.deepEqual(signals.filter((s) => s.cwd.endsWith('/902')).map((s) => s.signal), ['SIGTERM'])
    assert.equal(failure.final, false)
    assert.match(String(failure.text), /Stop hook/)
    assert.match(String(failure.text), /\/goal/)
    assert.equal(posts.filter((p) => p.path === 'integrations/threads/reply' && p.body.rootId === '902').length, 1, 'one failure, never a loop of them')
    assert.ok(logs.some((l) => /Stop hook blocked it 3 times/.test(l)), logs.join(' | '))
    console.log(`CLI proof: parent active; fork and resume 0 goal checks, all 3 guard canaries each; control blocked ${api.log.judge} times, one named failure`)
  } finally {
    for (const m of managers) await m.stopAll().catch(() => {})
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
