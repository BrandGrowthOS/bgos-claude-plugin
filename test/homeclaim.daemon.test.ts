/**
 * homeclaim (board 01a072c5), with the REAL daemon: two copies of server.ts
 * under bun, one computer, one agent paired in the shared legacy
 * ~/.bgos-agent/credentials.json, against a stand-in BGOS backend.
 *
 *   1. A stray session (a folder with no pin) boots first. It finds the agent
 *      by elimination, takes the free pairing lock and arms delivery.
 *   2. The real agent boots from its pinned folder. The resolver still says
 *      'legacy' for it (there is no credentials-<id>.json), but its pin names
 *      the file's own assistantId, so it takes the lock over by route, the
 *      stray stands down on its next heartbeat, and the agent confirms its own
 *      folder as the home (homeSource 'pin').
 *
 * Up to 0.90.32 step 2 logged the passive banner instead: the agent sat behind
 * the stray as a guest on its own channel. test/homeclaim.test.ts drives the
 * same race through the lib calls; this file proves server.ts wires them.
 *
 * Run with: npx tsx --test test/homeclaim.daemon.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

const ROOT = join(import.meta.dirname, '..')
const BUN = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout ?? ''
const SKIP = process.platform === 'win32' ? 'posix only' : BUN ? false : 'needs bun'

const ASSISTANT_ID = 42
const TOKEN = 'TESTTOKEN-homeclaim-e2e'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitQuietly(check: () => boolean, ms: number, step = 50): Promise<void> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await sleep(step)
}

/** The stand-in backend: enough of the API for a daemon to arm delivery. */
async function standInBackend() {
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {})
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://backend').pathname.replace(/^\/api\/v1\//, '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.method === 'GET' && path === 'integrations/me') {
        return res.end(JSON.stringify({ pairing_id: 144, user_id: 'u1', assistants: [{ assistant_id: ASSISTANT_ID, agent_route: 'claude-code', name: 'Ava' }] }))
      }
      if (req.method === 'GET' && path === 'peers/inbox') return res.end(JSON.stringify({ chats: [] }))
      if (req.method === 'GET' && path === 'meetings') return res.end('[]')
      res.end('{}')
    })
  })
  const io = new SocketServer(http)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`,
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  }
}

/**
 * A stand-in `claude` parent. The daemon reads whether its channel is loaded
 * off the nearest claude process's command line (lib/channel-presence.ts), so
 * each daemon runs under a process whose argv[0] is named `claude` and whose
 * command line registers this clone's channel, as `hoai` launches an agent:
 * `claude <stub> --dangerously-load-development-channels server:bgos`. The
 * stub starts the real server.ts under bun with the stdio passed through.
 * Without it the probe finds whatever claude runs the test (or none), and the
 * result would depend on who ran it.
 */
function makeClaudeStandIn(root: string): { claude: string; stub: string } {
  const dir = join(root, 'claude-stand-in')
  mkdirSync(dir, { recursive: true })
  const claude = join(dir, 'claude')
  symlinkSync(process.execPath, claude)
  const stub = join(dir, 'session.mjs')
  writeFileSync(
    stub,
    [
      "import { spawn } from 'node:child_process'",
      "const child = spawn(process.env.HOMECLAIM_BUN, [process.env.HOMECLAIM_SERVER], { stdio: 'inherit' })",
      "for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))",
      "child.on('exit', (code) => process.exit(code ?? 0))",
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
  return { claude, stub }
}

/** One Claude Code session's daemon: the real server.ts, launched from `folder`. */
async function startDaemon(pluginRoot: string, home: string, folder: string, standIn: { claude: string; stub: string }) {
  const stderr: string[] = []
  const transport = new StdioClientTransport({
    command: standIn.claude,
    args: [standIn.stub, '--dangerously-load-development-channels', 'server:bgos'],
    cwd: folder,
    env: {
      PATH: [dirname(BUN), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      BGOS_LAUNCH_CWD: folder,
      HOAI_BROWSER_HOST: 'off',
      BGOS_BOOT_HELLO: 'off',
      BGOS_AUTO_UPDATE: 'disabled',
      HOMECLAIM_BUN: BUN,
      HOMECLAIM_SERVER: join(pluginRoot, 'server.ts'),
    },
    stderr: 'pipe',
  })
  let partial = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const lines = (partial + String(chunk)).split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) if (line) stderr.push(line)
  })
  const client = new Client({ name: 'claude-code-stand-in', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  await client.listTools()
  const has = (text: string) => stderr.some((l) => l.includes(text))
  await waitQuietly(() => has('channel loaded in this session:'), 60_000)
  // The daemon's own pid (the lock records it), from its presence line: the
  // transport's pid is the stand-in claude's.
  const presence = stderr.find((l) => l.includes('channel loaded in this session:')) ?? ''
  const pid = Number(/pid (\d+): channel loaded in this session:/.exec(presence)?.[1] ?? 0)
  return {
    stderr,
    pid,
    presence,
    has,
    tail: (label: string) => `\n${label} stderr tail:\n${stderr.slice(-25).join('\n')}`,
    close: () => client.close().catch(() => {}),
  }
}

test('real daemons on a legacy-file host: the stray boots first, the agent from its pinned folder takes the channel and the home back', { skip: SKIP, timeout: 240_000 }, async () => {
  const backend = await standInBackend()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'homeclaim-e2e-')))
  const pluginRoot = join(root, 'plugin')
  const home = join(root, 'home')
  const agentFolder = join(root, 'agents', 'ava')
  const repo = join(root, 'code', 'some-repo')
  for (const dir of [pluginRoot, agentFolder, repo, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json', '.claude-plugin']) {
    cpSync(join(ROOT, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(pluginRoot, 'node_modules'))
  const standIn = makeClaudeStandIn(root)
  // The legacy layout: ONE shared credentials.json, no credentials-<id>.json, no home recorded.
  const credsPath = join(home, '.bgos-agent', 'credentials.json')
  const lockPath = `${credsPath}.lock`
  writeFileSync(
    credsPath,
    `${JSON.stringify({ backendUrl: backend.url, pairingToken: TOKEN, pairingId: 144, userId: 'u1', assistantId: ASSISTANT_ID, pairedAt: '2026-05-01T08:00:00.000Z' }, null, 2)}\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(agentFolder, '.bgos-agent-id'), `${ASSISTANT_ID}\n`)

  const daemons: Array<Awaited<ReturnType<typeof startDaemon>>> = []
  try {
    // 1. The stray boots first and takes the free lock.
    const stray = await startDaemon(pluginRoot, home, repo, standIn)
    daemons.push(stray)
    assert.match(stray.presence, /channel loaded in this session: true/, `the stand-in claude registers the channel${stray.tail('stray')}`)
    await waitQuietly(() => stray.has('pairing lock acquired (unlocked)') && stray.has('startup complete: polling armed'), 60_000)
    assert.ok(stray.has('pairing lock acquired (unlocked)'), `the stray never took the free lock${stray.tail('stray')}`)
    assert.ok(stray.has('via: legacy'), `the stray found the agent by elimination (the legacy file)${stray.tail('stray')}`)
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).route, 'elimination')

    // 2. The real agent boots from its pinned folder.
    const agent = await startDaemon(pluginRoot, home, agentFolder, standIn)
    daemons.push(agent)
    assert.match(agent.presence, /channel loaded in this session: true/)
    assert.notEqual(agent.pid, stray.pid)
    await waitQuietly(() => agent.has('pairing lock taken over from') || agent.has('passive: the pairing is already held'), 60_000)
    assert.ok(agent.has('via: legacy'), `the resolver still says legacy for the agent${agent.tail('agent')}`)
    assert.ok(
      !agent.has('passive: the pairing is already held'),
      `the real agent sat passive behind the stray (the bug)${agent.tail('agent')}`,
    )
    assert.ok(
      agent.has(`pairing lock taken over from pid ${stray.pid}: it found this agent by elimination and this daemon is pinned to it (the folder pin)`),
      `the agent never took the lock over by route${agent.tail('agent')}`,
    )

    // 3. The stray stands down on its next heartbeat; the lock is the agent's, recorded as pinned.
    await waitQuietly(() => stray.has(`pairing lock now held by pid ${agent.pid}`), 30_000)
    assert.ok(stray.has(`pairing lock now held by pid ${agent.pid}`), `the stray never stood down${stray.tail('stray')}`)
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.equal(lock.pid, agent.pid)
    assert.equal(lock.route, 'pin')

    // 4. Holding the channel, the agent confirms its own folder as the home.
    await waitQuietly(() => JSON.parse(readFileSync(credsPath, 'utf8')).homeSource === 'pin', 30_000)
    const after = JSON.parse(readFileSync(credsPath, 'utf8'))
    assert.equal(after.homeDir, agentFolder, `the agent confirmed its home${agent.tail('agent')}`)
    assert.equal(after.homeSource, 'pin')
    assert.equal(after.pairingToken, TOKEN, 'the token is carried through untouched')
    for (const d of daemons) assert.ok(!d.stderr.join('\n').includes(TOKEN), 'the token is never logged')
    console.log(
      `[homeclaim e2e] stray pid ${stray.pid} took the free lock; agent pid ${agent.pid} took it over by route; ` +
        `lock now ${JSON.stringify({ pid: lock.pid, route: lock.route })}; home ${after.homeSource}`,
    )
    console.log(`[homeclaim e2e] agent: ${agent.stderr.find((l) => l.includes('pairing lock taken over from'))}`)
    console.log(`[homeclaim e2e] stray: ${stray.stderr.find((l) => l.includes('pairing lock now held by pid'))}`)
  } finally {
    for (const d of daemons.reverse()) await d.close()
    await backend.close()
    rmSync(root, { recursive: true, force: true })
  }
})
