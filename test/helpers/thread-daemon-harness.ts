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
import { execFile, spawnSync } from 'node:child_process'
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

export type Post = { method: string; path: string; body: Record<string, unknown> | null; at: number }

export interface DaemonHarness {
  root: string
  home: string
  configDir: string
  folder: string
  mainSessionId: string
  mainTranscript: string
  stateDir: string
  posts: Post[]
  stderr: string[]
  api: FakeAnthropicApi
  /** Set when the daemon process went away, with when. */
  exited: { at: number } | null
  /** Pending threads the fake backend lists (GET integrations/threads/pending). */
  pending: Array<Record<string, unknown>>
  emit(event: string, payload: unknown): void
  threadTurn(input: { rpcId: string; chatId: string; rootId: string; replyId: string; text: string; mode?: string }): void
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
  /** Bytes of extra history appended to the main transcript (a long lived agent). */
  padMainTranscriptBytes?: number
  /** Files added to the agent's git repository before the first commit, path to bytes. */
  repoFiles?: Record<string, number>
  /** Extra daemon environment. */
  env?: Record<string, string>
  /** A wrapper the daemon runs as claude (CLAUDE_CODE_EXECPATH); default the real one. */
  execPath?: string
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
      if (req.method !== 'GET') posts.push({ method: req.method ?? '', path, body, at: Date.now() })
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
  const made = await promisify(execFile)(opts.claude, ['-p', 'Remember the word PELICAN.', '--output-format', 'json'], {
    cwd: folder,
    env: cliEnv,
    timeout: 90_000,
    encoding: 'utf8',
  }).catch((err: unknown) => ({ stdout: '', stderr: String(err) }))
  let mainSessionId = ''
  try {
    mainSessionId = String((JSON.parse(made.stdout) as { session_id?: unknown }).session_id ?? '')
  } catch {}
  if (!/^[0-9a-f-]{36}$/.test(mainSessionId)) throw new Error(`the main session could not be made: ${made.stdout} ${made.stderr}`)
  const projects = join(configDir, 'projects')
  const projectDir = readdirSync(projects).map((d) => join(projects, d)).find((d) => existsSync(join(d, `${mainSessionId}.jsonl`)))
  if (!projectDir) throw new Error('the main transcript is not where the CLI keeps it')
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
        payload: { chatId: t.chatId, rootId: t.rootId, replyId: t.replyId, mode: t.mode ?? 'start', text: t.text, title: 'A thread', rootText: 'The root message' },
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
