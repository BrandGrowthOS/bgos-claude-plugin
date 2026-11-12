/**
 * The REAL daemon (a copy of server.ts under bun) with a REAL Claude Code CLI,
 * for the thread end to end tests (test/thread-live.e2e.test.ts).
 *
 * Everything around them is a stand in on 127.0.0.1: the BGOS backend (http and
 * socket.io), Claude Code's MCP side (an MCP client over stdio), and the
 * Anthropic API (test/helpers/fake-anthropic-api.ts, a made up key). The agent
 * gets its own HOME and CLAUDE_CONFIG_DIR in a temp folder: no real account,
 * no real key, nothing of the person running the test is read or written.
 *
 * The main session is made the way an agent makes it: one real `claude -p`
 * turn in the agent folder against the fake API. The daemon is told that
 * session through CLAUDE_CODE_SESSION_ID (how Claude Code launches it), so a
 * thread forks a real transcript with the real CLI.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

import { startFakeAnthropicApi, type FakeAnthropicApi } from './fake-anthropic-api.ts'
import { KEYED_ASSISTANT_REFUSAL, threadReplyRefused } from './keyed-assistant-rule.ts'

const ROOT = join(import.meta.dirname, '..', '..')
export const ASSISTANT_ID = 42
export const MAIN_CHAT = 7
const USER_ID = 'u1'

export const BUN = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout ?? ''

/** The real claude on this machine (HOAI_LIVE_CLAUDE, else PATH), or ''. */
export function realClaude(): string {
  const named = process.env.HOAI_LIVE_CLAUDE?.trim()
  if (named) return existsSync(named) ? named : ''
  const found = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout?.trim() ?? ''
  return found && existsSync(found) ? found : ''
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await sleep(50)
  return check()
}

export type Post = { method: string; path: string; body: Record<string, unknown> | null; at: number; headers?: Record<string, unknown> }

export interface DaemonHarness {
  root: string
  home: string
  configDir: string
  folder: string
  mainSessionId: string
  mainTranscript: string
  stateDir: string
  posts: Post[]
  /** Posts the stand in refused with a 403, as the server would. */
  refused: Post[]
  stderr: string[]
  api: FakeAnthropicApi
  /** Set when the daemon process went away, with when. */
  exited: { at: number } | null
  /** Pending threads the fake backend lists (GET integrations/threads/pending). */
  pending: Array<Record<string, unknown>>
  emit(event: string, payload: unknown): void
  /**
   * `person`: stamp the frame for a person the agent is shared with (`lane` and `actorUserId` at its top level, as
   * the server stamps a person's frame). Without it the frame is the owner's own: no stamp, no person.
   */
  threadTurn(input: { rpcId: string; chatId: string; rootId: string; replyId: string; text: string; mode?: string; person?: string }): void
  /** The owner closes (or, with removeWorktree, deletes) a thread. */
  threadClose(input: { rpcId: string; chatId: string; rootId: string; removeWorktree?: boolean }): void
  /** The owner writes in the main chat: stored, and pushed on the socket like the backend does. Answers its id. */
  pushChatMessage(text: string): number
  /** The channel notifications the daemon sent Claude Code (main chat messages handed to the session). */
  channelCards: Array<{ messageId: number; content: string; at: number }>
  /** The daemon's process id. */
  pid: number | null
  tail(): string
  close(): Promise<void>
}

export interface HarnessOptions {
  claude: string
  /** Refuse these thread replies with a 403 even though they pass the server's rule. */
  refuseThreadReply?: (body: Record<string, unknown> | null) => boolean
  /** Bytes of extra history appended to the main transcript (a long lived agent). */
  padMainTranscriptBytes?: number
  /** Files added to the agent's git repository before the first commit, path to bytes. */
  repoFiles?: Record<string, number>
  /** Extra daemon environment. */
  env?: Record<string, string>
  /** A wrapper the daemon runs as claude (CLAUDE_CODE_EXECPATH); default the real one. */
  execPath?: string
  /** The main session starts a background `sleep` and keeps running, so a thread forks a session with a live background task. */
  mainBackgroundTask?: boolean
}

/** Long enough to outlive any one test, short enough that a copy the cleanup missed ends by itself. */
const BACKGROUND_COMMAND = 'sleep 600'

/**
 * The main session as a long lived stream json process whose one turn started a
 * background task that is still running. Answers its session id and the process.
 */
async function mainWithBackgroundTask(claude: string, cwd: string, env: Record<string, string>, root: string): Promise<{ sessionId: string; child: ChildProcess }> {
  const child = spawn(claude, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  })
  child.stdin!.on('error', () => {})
  let out = ''
  let exited = false
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => { out += chunk })
  child.on('exit', () => { exited = true })
  child.on('error', () => { exited = true })
  child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Remember the word PELICAN.' }] } })}\n`)
  const frames = (): Array<Record<string, unknown>> => out.split('\n').flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
  await waitFor(() => exited || frames().some((f) => f.type === 'result'), 90_000)
  const sessionId = String(frames().find((f) => f.type === 'system' && f.subtype === 'init')?.session_id ?? '')
  const started = frames().some((f) => f.type === 'system' && f.subtype === 'task_started')
  if (exited || !started || !/^[0-9a-f-]{36}$/.test(sessionId)) {
    stopTree(child, root)
    throw new Error(`the main session with a background task could not be made: ${out.slice(-2000)}`)
  }
  return { sessionId, child }
}

/** Stop a process group, and whatever still runs with `marker` (the test's temp folder) in its command line: the CLI gives a background shell its own group. */
function stopTree(child: ChildProcess, marker: string): void {
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch {}
  const pids = (spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout ?? '').split('\n').map((l) => Number(l.trim())).filter((n) => n > 0 && n !== process.pid)
  for (const pid of pids) {
    spawnSync('pkill', ['-KILL', '-P', String(pid)])
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

/** Valid transcript rows of filler, the shape a long agent session carries (big tool results). */
function padTranscript(path: string, bytes: number, sessionId: string, cwd: string): void {
  const filler = 'x'.repeat(8_000)
  let written = 0
  let i = 0
  let chunk = ''
  while (written < bytes) {
    const row = JSON.stringify({
      type: 'progress',
      sessionId,
      cwd,
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      timestamp: new Date(0).toISOString(),
      data: { type: 'filler', output: filler },
    })
    chunk += `${row}\n`
    written += row.length + 1
    i++
    if (chunk.length > 4_000_000) {
      appendFileSync(path, chunk)
      chunk = ''
    }
  }
  if (chunk) appendFileSync(path, chunk)
}

export async function startDaemonHarness(opts: HarnessOptions): Promise<DaemonHarness> {
  const posts: Post[] = []
  const refused: Post[] = []
  const pending: Array<Record<string, unknown>> = []
  // The owner's main chat with this agent, as the backend stores it.
  const rows: Array<Record<string, unknown> & { id: number; chatId: number }> = []
  let messageSeq = 1000
  let connected = false

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://backend')
      const path = url.pathname.replace(/^\/api\/v1\//, '')
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> | null = null
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      } catch {}
      const post: Post = { method: req.method ?? '', path, body, at: Date.now(), headers: req.headers }
      if (req.method === 'POST' && path === 'integrations/threads/reply' && (threadReplyRefused(req.headers, body) || opts.refuseThreadReply?.(body))) {
        refused.push(post)
        res.writeHead(403, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ statusCode: 403, message: KEYED_ASSISTANT_REFUSAL, error: 'Forbidden' }))
      }
      if (req.method !== 'GET') posts.push(post)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.method === 'GET' && path === 'peers/inbox') {
        return res.end(JSON.stringify({ chats: [{ id: MAIN_CHAT, assistantId: ASSISTANT_ID, kind: 'main', userId: USER_ID }] }))
      }
      if (req.method === 'GET' && path === 'meetings') return res.end('[]')
      if (req.method === 'GET' && path === 'integrations/threads/pending') return res.end(JSON.stringify({ turns: pending }))
      const history = /^chats\/(\d+)\/messages$/.exec(path)
      if (req.method === 'GET' && history) {
        const afterId = Number(url.searchParams.get('afterId') ?? 0)
        const page = rows.filter((r) => r.chatId === Number(history[1]) && r.id > afterId).sort((a, b) => a.id - b.id).slice(-50)
        return res.end(JSON.stringify({ messages: page.map((message) => ({ message, messageFiles: [], messageOptions: [] })) }))
      }
      res.end('{}')
    })
  })
  const io = new SocketServer(http)
  io.on('connection', () => {
    connected = true
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const backendUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`

  const api = await startFakeAnthropicApi((body, n) => {
    const text = JSON.stringify(body.messages ?? '')
    if (text.includes('THREAD-QUESTION')) return `THREAD-ANSWER-${n}`
    // The main turn asks twice: its first request starts the background task, its second (after the tool result) answers.
    const offersBash = Array.isArray(body.tools) && body.tools.some((t) => (t as { name?: unknown } | null)?.name === 'Bash')
    if (opts.mainBackgroundTask && offersBash && !text.includes('tool_result')) {
      return { toolUse: { name: 'Bash', input: { command: BACKGROUND_COMMAND, description: 'A background task', run_in_background: true } } }
    }
    return `MAIN-ANSWER-${n}`
  })

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thread-live-')))
  const pluginRoot = join(root, 'plugin')
  const home = join(root, 'home')
  const configDir = join(home, '.claude')
  const folder = join(root, 'agent')
  for (const dir of [pluginRoot, folder, configDir, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'hooks', 'package.json', 'tsconfig.json', '.claude-plugin']) {
    if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(pluginRoot, 'node_modules'))
  writeFileSync(
    join(home, '.bgos-agent', `credentials-${ASSISTANT_ID}.json`),
    JSON.stringify({ backendUrl, pairingToken: 'TESTTOKEN', pairingId: 144, userId: USER_ID, assistantId: ASSISTANT_ID, homeDir: folder, homeSource: 'pairing' }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), `${ASSISTANT_ID}\n`)

  // The agent folder is a git repository with one commit, as most agents' are.
  const git = (args: string[]) => spawnSync('git', args, { cwd: folder, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'agent@example.invalid'])
  git(['config', 'user.name', 'Test Agent'])
  writeFileSync(join(folder, 'README.md'), '# test agent\n')
  for (const [rel, size] of Object.entries(opts.repoFiles ?? {})) {
    mkdirSync(dirname(join(folder, rel)), { recursive: true })
    writeFileSync(join(folder, rel), Buffer.alloc(size, 7))
  }
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'first'])

  const cliEnv = {
    PATH: [dirname(opts.claude), dirname(BUN), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
    ANTHROPIC_BASE_URL: api.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }

  // The main session: one real turn in the agent folder.
  let mainSessionId = ''
  let mainProcess: ChildProcess | null = null
  if (opts.mainBackgroundTask) {
    const main = await mainWithBackgroundTask(opts.claude, folder, cliEnv, root)
    mainSessionId = main.sessionId
    mainProcess = main.child
  } else {
    const made = await promisify(execFile)(opts.claude, ['-p', 'Remember the word PELICAN.', '--output-format', 'json'], {
      cwd: folder,
      env: cliEnv,
      timeout: 90_000,
      encoding: 'utf8',
    }).catch((err: unknown) => ({ stdout: '', stderr: String(err) }))
    try {
      mainSessionId = String((JSON.parse(made.stdout) as { session_id?: unknown }).session_id ?? '')
    } catch {}
    if (!/^[0-9a-f-]{36}$/.test(mainSessionId)) throw new Error(`the main session could not be made: ${made.stdout} ${made.stderr}`)
  }
  const projects = join(configDir, 'projects')
  const projectDir = readdirSync(projects).map((d) => join(projects, d)).find((d) => existsSync(join(d, `${mainSessionId}.jsonl`)))
  if (!projectDir) {
    if (mainProcess) stopTree(mainProcess, root)
    throw new Error('the main transcript is not where the CLI keeps it')
  }
  const mainTranscript = join(projectDir, `${mainSessionId}.jsonl`)
  if (opts.padMainTranscriptBytes) padTranscript(mainTranscript, opts.padMainTranscriptBytes, mainSessionId, folder)

  const stderr: string[] = []
  const transport = new StdioClientTransport({
    command: BUN,
    args: [join(pluginRoot, 'server.ts')],
    cwd: folder,
    env: {
      ...cliEnv,
      CLAUDE_CODE_SESSION_ID: mainSessionId,
      CLAUDE_CODE_EXECPATH: opts.execPath ?? opts.claude,
      BGOS_LAUNCH_CWD: folder,
      HOAI_BROWSER_HOST: 'off',
      BGOS_BOOT_HELLO: 'off',
      BGOS_AUTO_UPDATE: 'disabled',
      ...(opts.env ?? {}),
    },
    stderr: 'pipe',
  })
  let partial = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const lines = (partial + String(chunk)).split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) if (line) stderr.push(line)
  })
  const channelCards: Array<{ messageId: number; content: string; at: number }> = []
  const client = new Client({ name: 'claude-code-stand-in', version: '0.0.0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async (n) => {
    if (n.method !== 'notifications/claude/channel') return
    const params = (n.params ?? {}) as { meta?: Record<string, string>; content?: unknown }
    channelCards.push({ messageId: Number(params.meta?.message_id), content: String(params.content ?? ''), at: Date.now() })
  }
  const harness: DaemonHarness = {
    root,
    home,
    configDir,
    folder,
    mainSessionId,
    mainTranscript,
    stateDir: join(home, '.bgos-agent', String(ASSISTANT_ID), 'threads'),
    posts,
    refused,
    stderr,
    api,
    exited: null,
    pending,
    channelCards,
    emit: (event, payload) => {
      io.emit(event, payload)
    },
    threadTurn: (t) => {
      io.emit('voice_rpc', {
        rpcId: t.rpcId,
        op: 'thread_turn',
        assistantId: ASSISTANT_ID,
        chatId: t.chatId,
        ...(t.person ? { actorUserId: t.person, lane: `person:${t.person}` } : {}),
        payload: { chatId: t.chatId, rootId: t.rootId, replyId: t.replyId, mode: t.mode ?? 'start', text: t.text, title: 'A thread', rootText: 'The root message' },
      })
    },
    threadClose: (t) => {
      io.emit('voice_rpc', {
        rpcId: t.rpcId,
        op: 'thread_close',
        assistantId: ASSISTANT_ID,
        chatId: t.chatId,
        payload: { chatId: t.chatId, rootId: t.rootId, removeWorktree: t.removeWorktree === true },
      })
    },
    pushChatMessage: (text) => {
      const id = messageSeq++
      rows.push({ id, chatId: MAIN_CHAT, sender: 'user', text, senderUserId: USER_ID, senderAssistantId: null, messageType: 'standard', sentDate: new Date().toISOString() })
      io.emit('inbound_message', { assistantId: ASSISTANT_ID, userId: USER_ID, chatId: MAIN_CHAT, messageId: id, text, files: [], messageType: 'standard' })
      return id
    },
    pid: null,
    tail: () => `\nposts: ${JSON.stringify(posts.map((p) => ({ path: p.path, body: p.body })).slice(-12))}\nstderr tail:\n${stderr.slice(-25).join('\n')}`,
    close: async () => {
      await client.close().catch(() => {})
      await new Promise<void>((resolve) => io.close(() => resolve()))
      await api.close()
      if (mainProcess) stopTree(mainProcess, root)
      // A lane worktree is a folder git knows; the temp root goes as a whole.
      rmSync(root, { recursive: true, force: true })
    },
  }
  transport.onclose = () => {
    if (!harness.exited) harness.exited = { at: Date.now() }
  }
  await client.connect(transport)
  harness.pid = transport.pid
  await client.listTools()
  await waitFor(() => connected && stderr.some((l) => l.includes('startup complete: polling armed')), 60_000)
  if (!connected) {
    await harness.close()
    throw new Error(`the daemon never joined the socket${harness.tail()}`)
  }
  await sleep(300)
  return harness
}
