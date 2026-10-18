/**
 * PERSON LANES, a lane's FIRST turn reaches Claude only after Claude has the
 * lane's `reply` tool (mission 161 goal 9; 0.71.1).
 *
 * Measured on Claude Code 2.1.302 with the lane's locked launch: the CLI
 * registers a server's channel handler as soon as the server connects, but it
 * puts that server's tools into its tool pool on a 16 ms batch. A turn that
 * reaches it in between is built without `mcp__bgos__reply`, and the CLI then
 * keeps the tool deferred for the whole session, where nothing can load it
 * (ToolSearch is not in the lane's `--tools`). The lane daemon handed the
 * waiting turn over the moment it connected, so a lane's very first message
 * was answered in plain text nobody sees, until a `/new`.
 *
 * These tests run the REAL lane daemon (`lane-server.ts`, launched by
 * `bin/bgos-launch.mjs` exactly as the lane's mcp.json does) against a stand
 * in backend, with a stand in for Claude Code as its MCP client:
 *   - Claude lists the tools straight after the handshake (as the CLI does):
 *     the turn waiting since the lane woke goes out only after that list, and
 *     the settle after it, and is acknowledged only after it went out.
 *   - Claude lists the tools late: no turn goes out before the list.
 *
 * Run with: npx tsx --test test/lane-first-turn.test.ts
 */
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server as SocketServer } from 'socket.io'

import { laneDaemonEnv, lanePaths, personLaneStamp } from '../lib/lane-core.mjs'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32).
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS, timeout: 60_000 }, fn as never)

const ROOT = join(import.meta.dirname, '..')
const ASSISTANT_ID = '1076'
const USER_ID = 'user_ana'
const CHAT_ID = 77
const MESSAGE_ID = 501
/** lib/lane-daemon.ts LANE_CLAUDE_SETTLE_MS is 2 s; this leaves timer slack. */
const SETTLE_FLOOR_MS = 1_900

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, what: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

interface Backend {
  url: string
  acks: Array<{ id: number; at: number }>
  close: () => Promise<void>
}

/** The backend routes the lane daemon uses, with ONE turn waiting for her. */
async function startBackend(): Promise<Backend> {
  const acks: Backend['acks'] = []
  const stamp = personLaneStamp(USER_ID)
  const row = {
    id: MESSAGE_ID,
    message_id: MESSAGE_ID,
    chat_id: CHAT_ID,
    chat_kind: 'main',
    text: 'Hello, are you there?',
    created_at: new Date().toISOString(),
    lane: stamp,
    assistantId: Number(ASSISTANT_ID),
    sender_user_id: USER_ID,
  }
  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/api\/v1\//, '')
    req.resume()
    if (req.method === 'POST' && path === 'integrations/lanes/session') {
      return json(res, {
        sessionToken: 'lsess_firstturn_standin_0001',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        lane: { actorUserId: USER_ID, assistantId: ASSISTANT_ID, stamp, pairingId: '9' },
      })
    }
    if (req.method === 'GET' && path === 'integrations/lanes/me') return json(res, { actorUserId: USER_ID, assistantId: ASSISTANT_ID, lane: stamp })
    if (req.method === 'GET' && path === 'integrations/lanes/inbound') {
      const since = Number(url.searchParams.get('since_message_id') ?? 0)
      return json(res, { messages: since < MESSAGE_ID ? [row] : [] })
    }
    const ack = /^integrations\/messages\/(\d+)\/ack$/.exec(path)
    if (req.method === 'POST' && ack) {
      acks.push({ id: Number(ack[1]), at: Date.now() })
      return json(res, {})
    }
    return json(res, {})
  }
  const http: HttpServer = createServer(handler)
  const io = new SocketServer(http)
  io.on('connection', () => { /* the lane socket; its connect makes the daemon poll */ })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  const port = (http.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    acks,
    close: () => new Promise<void>((r) => { io.close(); http.close(() => r()) }),
  }
}

interface Rig {
  client: Client
  transport: StdioClientTransport
  channel: Array<{ at: number; params: Record<string, unknown> }>
  connectedAt: number
  home: string
  backend: Backend
}

/** A brand new lane folder (her lane's first launch) and the real lane daemon under a stand in Claude Code. */
async function startLane(): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), 'lane-first-turn-'))
  const backend = await startBackend()
  const p = lanePaths({ home, assistantId: ASSISTANT_ID, userId: USER_ID })
  mkdirSync(p.workDir, { recursive: true, mode: 0o700 })
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
  // The ticket the owner's daemon leaves for a lane it wakes.
  writeFileSync(p.ticketPath, JSON.stringify({ laneTicket: 'lt_firstturn_standin', ticketExpiresAt: new Date(Date.now() + 120_000).toISOString() }), { mode: 0o600 })
  const env: Record<string, string> = {
    ...laneDaemonEnv({ assistantId: ASSISTANT_ID, userId: USER_ID, workDir: p.workDir, laneDir: p.laneDir, stateDir: p.stateDir, backendUrl: backend.url, loginMode: 'inherit' }),
    HOME: home,
    PATH: process.env.PATH ?? '',
    ...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'bin', 'bgos-launch.mjs'), join(ROOT, 'lane-server.ts')],
    env,
    cwd: p.workDir,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'claude-code-standin', version: '0.0.0' }, { capabilities: {} })
  const channel: Rig['channel'] = []
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') channel.push({ at: Date.now(), params: (n.params ?? {}) as Record<string, unknown> })
  }
  await client.connect(transport)
  return { client, transport, channel, connectedAt: Date.now(), home, backend }
}

async function stopLane(rig: Rig): Promise<void> {
  // Closing stdin ends the daemon; the lane.json pid is the daemon this test started.
  const p = lanePaths({ home: rig.home, assistantId: ASSISTANT_ID, userId: USER_ID })
  let daemonPid: number | null = null
  try { daemonPid = JSON.parse(readFileSync(p.laneJsonPath, 'utf8')).pid ?? null } catch { /* never wrote it */ }
  await rig.client.close().catch(() => {})
  if (daemonPid) {
    const until = Date.now() + 5_000
    while (Date.now() < until) {
      try { process.kill(daemonPid, 0) } catch { break }
      await sleep(50)
    }
    try { process.kill(daemonPid, 'SIGKILL') } catch { /* exited */ }
  }
  await rig.backend.close()
  rmSync(rig.home, { recursive: true, force: true })
}

test('first launch: the waiting turn reaches Claude only after Claude listed the tools and the settle passed, and is acked after', async () => {
  const rig = await startLane()
  try {
    // Claude Code asks for the tool list straight after the handshake.
    const listed = await rig.client.listTools()
    const listedAt = Date.now()
    assert.deepEqual(listed.tools.map((t) => t.name), ['reply'])
    await waitFor(() => rig.channel.length > 0, 'the waiting turn')
    const turn = rig.channel[0]
    assert.match(String(turn.params.content), /Hello, are you there\?/)
    assert.equal((turn.params.meta as Record<string, string>).lane, personLaneStamp(USER_ID))
    const gap = turn.at - listedAt
    assert.ok(gap >= SETTLE_FLOOR_MS, `the turn went out ${gap} ms after Claude listed the tools; Claude may not have reply in its pool yet (needs at least ${SETTLE_FLOOR_MS} ms)`)
    await waitFor(() => rig.backend.acks.length > 0, 'the ack')
    assert.equal(rig.backend.acks[0].id, MESSAGE_ID)
    assert.ok(rig.backend.acks[0].at >= turn.at, 'a turn is acknowledged only after Claude was handed it')
    assert.equal(rig.channel.length, 1, 'handed over once')
  } finally {
    await stopLane(rig)
  }
})

test('first launch: a Claude that lists the tools late gets no turn before its list', async () => {
  const rig = await startLane()
  try {
    // The daemon is up and the turn is waiting; this Claude has not asked for the tools yet.
    await sleep(2_500)
    assert.equal(rig.channel.length, 0, 'no turn may reach a Claude that has not listed the tools')
    await rig.client.listTools()
    const listedAt = Date.now()
    await waitFor(() => rig.channel.length > 0, 'the waiting turn after the list')
    const gap = rig.channel[0].at - listedAt
    assert.ok(gap >= SETTLE_FLOOR_MS, `the turn went out ${gap} ms after the late list (needs at least ${SETTLE_FLOOR_MS} ms)`)
  } finally {
    await stopLane(rig)
  }
})
