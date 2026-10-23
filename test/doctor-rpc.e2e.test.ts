/**
 * THE CHECK UP IS ANSWERED BY A RUNNING DAEMON (BGOS board row 01a16795).
 *
 * Production, 2026-10-23 07:04:30Z: KC ran the check up for Cho (pairing 144,
 * plugin 0.74.0, online). POST /api/v1/integrations/pairings/144/doctor
 * answered 200, the backend emitted `doctor_rpc` to the pairing room, and no
 * POST doctor-rpc/:rpcId/ack or /result ever arrived: the daemon had no
 * listener for the frame.
 *
 * This runs the REAL daemon (a copy of server.ts under bun) against a stand in
 * BGOS backend (http and socket.io) and a stand in for Claude Code (an MCP
 * client), sends the frame exactly as backend/src/integrations/
 * doctor-rpc.service.ts builds it, and checks the two answers the backend
 * waits for arrive, on the doctor lane, inside its 10 s ack deadline, with a
 * body its DoctorRpcResultDto accepts.
 *
 * Run with: npx tsx --test test/doctor-rpc.e2e.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const USER_ID = 'u1'
/** The backend's ACK_TIMEOUT_MS: past it the owner reads "did not respond". */
const BACKEND_ACK_DEADLINE_MS = 10_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitQuietly(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await sleep(25)
}

type Post = { path: string; body: unknown; at: number }

test('a doctor_rpc frame from the backend is acked and answered by the running daemon', { skip: SKIP, timeout: 120_000 }, async () => {
  const posts: Post[] = []
  let connectedAt = 0

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://backend').pathname.replace(/^\/api\/v1\//, '')
      if (req.method === 'POST' && path.startsWith('integrations/doctor-rpc/')) {
        const raw = Buffer.concat(chunks).toString('utf8')
        posts.push({ path, body: raw ? JSON.parse(raw) : null, at: Date.now() })
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.method === 'GET' && path === 'peers/inbox') return res.end(JSON.stringify({ chats: [] }))
      if (req.method === 'GET' && path === 'meetings') return res.end('[]')
      res.end('{}')
    })
  })
  const io = new SocketServer(http)
  io.on('connection', () => {
    connectedAt = Date.now()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const backendUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-rpc-')))
  const pluginRoot = join(root, 'plugin')
  const home = join(root, 'home')
  const folder = join(root, 'agent')
  for (const dir of [pluginRoot, folder, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json', '.claude-plugin']) {
    cpSync(join(ROOT, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(pluginRoot, 'node_modules'))
  writeFileSync(
    join(home, '.bgos-agent', `credentials-${ASSISTANT_ID}.json`),
    JSON.stringify({ backendUrl, pairingToken: 'TESTTOKEN', pairingId: 144, userId: USER_ID, assistantId: ASSISTANT_ID, homeDir: folder, homeSource: 'pairing' }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), `${ASSISTANT_ID}\n`)

  const stderr: string[] = []
  const transport = new StdioClientTransport({
    command: BUN,
    args: [join(pluginRoot, 'server.ts')],
    cwd: folder,
    env: {
      PATH: [dirname(BUN), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      BGOS_LAUNCH_CWD: folder,
      HOAI_BROWSER_HOST: 'off',
      BGOS_BOOT_HELLO: 'off',
      BGOS_AUTO_UPDATE: 'disabled',
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

  try {
    await client.connect(transport)
    await client.listTools()
    await waitQuietly(
      () => connectedAt > 0 && stderr.some((l) => l.includes('startup complete: polling armed')),
      60_000,
    )
    assert.ok(connectedAt > 0, `the daemon never joined the socket; stderr tail:\n${stderr.slice(-20).join('\n')}`)
    await sleep(300)

    // A frame for ANOTHER agent sharing the pairing room gets nothing.
    io.emit('doctor_rpc', { rpcId: 'not-mine', op: 'run', assistantId: 7, payload: {} })
    // The frame exactly as DoctorRpcService.start builds it today.
    const sentAt = Date.now()
    io.emit('doctor_rpc', { rpcId: 'rpc-cho', op: 'run', payload: {} })

    await waitQuietly(() => posts.some((p) => p.path === 'integrations/doctor-rpc/rpc-cho/result'), 15_000)
    const tail = `\nposts: ${JSON.stringify(posts)}\nstderr tail:\n${stderr.slice(-15).join('\n')}`

    const ack = posts.find((p) => p.path === 'integrations/doctor-rpc/rpc-cho/ack')
    assert.ok(ack, `no ack arrived (the production silence)${tail}`)
    assert.ok(ack.at - sentAt < BACKEND_ACK_DEADLINE_MS, `the ack missed the backend's 10 s deadline${tail}`)

    const result = posts.find((p) => p.path === 'integrations/doctor-rpc/rpc-cho/result')
    assert.ok(result, `no result arrived${tail}`)
    const body = result.body as { ok: boolean; payload?: { result: string; checks: Array<Record<string, string>> } }
    assert.equal(body.ok, true)
    assert.ok(body.payload && ['ok', 'fail'].includes(body.payload.result))
    const names = body.payload.checks.map((c) => c.name)
    for (const want of ['Connection', 'Connector', 'Agent folder', 'Claude login', 'Claude usage']) {
      assert.ok(names.includes(want), `a ${want} row (rows: ${names.join(', ')})`)
    }
    for (const c of body.payload.checks) {
      assert.ok(['OK', 'WARN', 'FAIL'].includes(c.status))
      assert.ok(c.name.length <= 64 && c.detail.length <= 400 && (c.fix ?? '').length <= 400)
    }

    await sleep(500)
    assert.equal(
      posts.filter((p) => p.path.includes('not-mine')).length,
      0,
      `a frame for another agent was answered${tail}`,
    )
    assert.equal(
      posts.filter((p) => p.path === 'integrations/doctor-rpc/rpc-cho/result').length,
      1,
      'one result per frame',
    )
  } finally {
    await client.close().catch(() => {})
    await new Promise<void>((resolve) => io.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
