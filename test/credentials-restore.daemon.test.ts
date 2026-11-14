/**
 * THE REAL DAEMON WRITES BACK A LOST CREDENTIALS FILE (stability, 2026-11-14).
 *
 * 2026-11-13 an accident deleted ~/.bgos-agent/credentials-<id>.json for every agent on a Mac; the
 * daemons ran on in memory and a restart would have come up unpaired. This runs the REAL daemon (a
 * copy of server.ts under bun) against a stand in BGOS backend, deletes its credentials file while
 * it runs, and checks:
 *   1. with the token still good, the file comes back (mode 0600, this assistant, the same token),
 *      one WARN names the path, nothing is posted, and a second deletion is caught again (the
 *      watch is re-armed on the restored file). The time from delete to file is printed.
 *   2. with integrations/me refusing the token, nothing is written through the file watch and the
 *      interval rechecks, and the backend is asked once inside the 60 s back-off.
 *
 * Run with: npx tsx --test test/credentials-restore.daemon.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
const TOKEN = 'TESTTOKEN-restore-e2e'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitQuietly(check: () => boolean, ms: number, step = 25): Promise<void> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await sleep(step)
}

type Call = { method: string; path: string; at: number; pairing: string }

async function bootDaemon(opts: { meStatus: () => number; recheckMs: number }) {
  const calls: Call[] = []
  let connectedAt = 0
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {})
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://backend').pathname.replace(/^\/api\/v1\//, '')
      calls.push({ method: req.method ?? '', path, at: Date.now(), pairing: String(req.headers['x-bgos-pairing'] ?? '') })
      if (req.method === 'GET' && path === 'integrations/me') {
        const status = opts.meStatus()
        res.writeHead(status, { 'Content-Type': 'application/json' })
        return res.end(
          status === 200
            ? JSON.stringify({ pairing_id: 144, user_id: 'u1', assistants: [{ assistant_id: ASSISTANT_ID, agent_route: 'claude-code', name: 'Ares' }] })
            : JSON.stringify({ message: 'Unauthorized' }),
        )
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

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'creds-restore-e2e-')))
  const pluginRoot = join(root, 'plugin')
  const home = join(root, 'home')
  const folder = join(root, 'agent')
  for (const dir of [pluginRoot, folder, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  for (const entry of ['server.ts', 'lib', 'bin', 'package.json', 'tsconfig.json', '.claude-plugin']) {
    cpSync(join(ROOT, entry), join(pluginRoot, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(pluginRoot, 'node_modules'))
  const credsPath = join(home, '.bgos-agent', `credentials-${ASSISTANT_ID}.json`)
  const original = { backendUrl, pairingToken: TOKEN, pairingId: 144, userId: 'u1', assistantId: ASSISTANT_ID, pairedAt: '2026-11-01T08:00:00.000Z', homeDir: folder, homeSource: 'pairing' }
  writeFileSync(credsPath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 })
  // A second agent on the same computer, whose file must never change.
  const otherPath = join(home, '.bgos-agent', 'credentials-935.json')
  writeFileSync(otherPath, `${JSON.stringify({ ...original, pairingToken: 'OTHER', assistantId: 935 }, null, 2)}\n`, { mode: 0o600 })
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
      BGOS_AUTH_RECHECK_INTERVAL_MS: String(opts.recheckMs),
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
  await waitQuietly(
    () => connectedAt > 0 && stderr.some((l) => l.includes('auth recheck enabled')) && stderr.some((l) => l.includes('startup complete: polling armed')),
    60_000,
  )
  assert.ok(stderr.some((l) => l.includes('auth recheck enabled')), `the recheck never armed; stderr tail:\n${stderr.slice(-20).join('\n')}`)
  await sleep(300)

  return {
    calls,
    stderr,
    credsPath,
    otherPath,
    original,
    tail: () => `\nstderr tail:\n${stderr.slice(-20).join('\n')}`,
    close: async () => {
      await client.close().catch(() => {})
      await new Promise<void>((resolve) => io.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('a deleted credentials file is written back by the running daemon while its token is good', { skip: SKIP, timeout: 180_000 }, async () => {
  // The default 10 min interval: only the file watch can be this fast.
  const d = await bootDaemon({ meStatus: () => 200, recheckMs: 600_000 })
  try {
    const otherBefore = readFileSync(d.otherPath)
    const timings: number[] = []
    for (const round of [1, 2]) {
      const posts = d.calls.filter((c) => c.method !== 'GET').length
      const deletedAt = Date.now()
      rmSync(d.credsPath)
      await waitQuietly(() => existsSync(d.credsPath), 20_000, 5)
      const restoredAt = Date.now()
      assert.ok(existsSync(d.credsPath), `round ${round}: the file never came back${d.tail()}`)
      await sleep(150)
      timings.push(restoredAt - deletedAt)

      assert.equal(statSync(d.credsPath).mode & 0o777, 0o600, `round ${round}: mode`)
      const back = JSON.parse(readFileSync(d.credsPath, 'utf8'))
      assert.deepEqual(back, d.original, `round ${round}: the same body bgos-pair wrote`)
      const me = d.calls.filter((c) => c.path === 'integrations/me' && c.at >= deletedAt)
      assert.ok(me.length >= 1 && me.every((c) => c.pairing === TOKEN), `round ${round}: checked with the in-memory token`)
      const warns = d.stderr.filter((l) => l.includes('WARN credentials file restored') && l.includes(d.credsPath))
      assert.equal(warns.length, round, `round ${round}: one WARN per restore naming the path${d.tail()}`)
      assert.equal(d.calls.filter((c) => c.method !== 'GET').length, posts, `round ${round}: nothing was posted${d.tail()}`)
    }
    assert.deepEqual(readFileSync(d.otherPath), otherBefore, "the other agent's file is byte for byte the same")
    assert.ok(!d.stderr.join('\n').includes(TOKEN), 'the token is never logged')
    console.log(`[credentials-restore e2e] delete to restored file: ${timings.map((t) => `${t} ms`).join(', ')}`)
  } finally {
    await d.close()
  }
})

test('the whole .bgos-agent folder deleted: this agent\'s file comes back, at 0700 and 0600, and only its own', { skip: SKIP, timeout: 180_000 }, async () => {
  const d = await bootDaemon({ meStatus: () => 200, recheckMs: 600_000 })
  try {
    const deletedAt = Date.now()
    rmSync(dirname(d.credsPath), { recursive: true, force: true })
    await waitQuietly(() => existsSync(d.credsPath), 20_000, 5)
    const took = Date.now() - deletedAt
    assert.ok(existsSync(d.credsPath), `the file never came back${d.tail()}`)
    await sleep(150)
    assert.equal(statSync(dirname(d.credsPath)).mode & 0o777, 0o700)
    assert.equal(statSync(d.credsPath).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(d.credsPath, 'utf8')), d.original)
    assert.equal(existsSync(d.otherPath), false, "another agent's lost file is that agent's daemon's to restore, never this one's")
    console.log(`[credentials-restore e2e] whole folder deleted, delete to restored file: ${took} ms`)
  } finally {
    await d.close()
  }
})

test('a deleted credentials file stays deleted when integrations/me refuses the token', { skip: SKIP, timeout: 180_000 }, async () => {
  let refuse = false
  const d = await bootDaemon({ meStatus: () => (refuse ? 401 : 200), recheckMs: 5_000 })
  try {
    refuse = true
    const deletedAt = Date.now()
    rmSync(d.credsPath)
    // The watch fires at once, then an interval recheck every 5 s, and the lock heartbeat beside
    // the file stirs the folder watch every 5 s: the backend is still asked only once inside the
    // 60 s back-off.
    await waitQuietly(() => d.calls.some((c) => c.path === 'integrations/me' && c.at >= deletedAt), 20_000)
    await sleep(16_000)
    const asked = d.calls.filter((c) => c.path === 'integrations/me' && c.at >= deletedAt).length
    assert.equal(asked, 1, `asked once inside the back-off, not on every recheck${d.tail()}`)
    assert.ok(
      d.stderr.filter((l) => l.includes('auth recheck') || l.includes('credentials resolution changed')).length >= 1,
      `the rechecks kept running${d.tail()}`,
    )
    assert.equal(existsSync(d.credsPath), false, `nothing was written on a refused token${d.tail()}`)
    const refusals = d.stderr.filter((l) => l.includes(`credentials file ${d.credsPath} is missing and was not restored`))
    assert.equal(refusals.length, 1, `said once, not every recheck${d.tail()}`)
    assert.ok(refusals[0]!.includes('answered 401'))
    assert.ok(!d.stderr.some((l) => l.includes('WARN credentials file restored')))
  } finally {
    await d.close()
  }
})
