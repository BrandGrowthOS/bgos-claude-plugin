/**
 * "The doctor fails on Node 26" (HOAI board row 05893eed, finding B; the
 * Helper production test on KC's MacBook, 2026-11-12).
 *
 * The doctor's row read: `MCP handshake (initialize): server exited (code 1)
 * before answering initialize ... Node.js v26.0.0`. Node 26 was not the cause.
 * The doctor's version check (assertBrowserNodeVersion: 22.12.0 or newer)
 * passes 26. The handshake starts `node <installed plugin>/bin/bgos-launch.mjs`
 * and the installed plugin was 0.31.0, which has no bin/bgos-launch.mjs, so
 * node exited with "Cannot find module". The row showed only the last three
 * stderr lines, and the last line node prints after any crash is its own
 * version, `Node.js v26.0.0`. It read like a Node version failure.
 *
 * Now: a missing launch shim is named as that, with the installed version and
 * the two commands that update it; any other crash shows node's error line,
 * never the version trailer; and Node 26 is pinned as passing the version row.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildDoctorRows, probeHandshake } from '../bin/bgos-doctor.mjs'

/** The rows a healthy machine produces, with one probe replaced. */
function rowsWith(over: Record<string, unknown>) {
  return buildDoctorRows({
    platform: 'darwin',
    claude: { found: true, version: '2.1.322 (Claude Code)', path: '/Users/x/.local/bin/claude' },
    auth: { ok: true, loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
    node: { found: true, version: 'v26.0.0' },
    bun: { found: true, path: '/Users/x/.bun/bin/bun', via: 'home' },
    bunx: { found: true, path: '/Users/x/.bun/bin/bunx' },
    method: { method: 'marketplace', channelSpec: 'plugin:hoai@hoai', pluginRoot: '/Users/x/.claude/plugins/cache/hoai/hoai/0.87.5' },
    route: { spec: 'plugin:hoai@hoai', source: 'install-method', method: 'marketplace', serverName: '', conflict: false, reason: '' },
    credentials: { path: '/Users/x/.bgos-agent/credentials-1175.json', exists: true, assistantId: 1175, expectedAssistantId: '1175' },
    handshake: { ok: true, detail: 'server bgos 0.87.5 answered initialize', command: 'node launch server' },
    mcpList: { ok: true, state: 'connected', raw: 'bgos: ... Connected' },
    backend: { ok: true, status: 200, url: 'https://api.brandgrowthos.ai/api/v1/service-options/health' },
    logPath: '/Users/x/.bgos-agent/logs/bgos-plugin-1175.log',
    ...over,
  } as never)
}

const nodeTrailer = /Node\.js v\d+\.\d+\.\d+\s*$/

test('B: Node 26 passes the Node.js row (the doctor supports 22.12.0 and newer)', () => {
  for (const version of ['v26.0.0', 'v26.3.0']) {
    const row = rowsWith({ node: { found: true, version } }).find((r: { id: string }) => r.id === 'node')
    assert.ok(row)
    assert.equal(row.ok, true, version)
  }
})

test('B: an installed plugin with no launch shim (0.31.0) is named as that, not as a Node.js crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oldconnect-b-'))
  try {
    // 0.31.0's layout: a package.json and a server.ts, and no bin/bgos-launch.mjs.
    await mkdir(join(root, 'bin'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'claude-channel-bgos', version: '0.31.0' }))
    await writeFile(join(root, 'server.ts'), '')
    const result = await probeHandshake({
      launchArgv: [join(root, 'bin', 'bgos-launch.mjs'), join(root, 'server.ts')],
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 20_000,
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /has no bin\/bgos-launch\.mjs/)
    assert.match(result.detail, /0\.31\.0/)
    assert.doesNotMatch(result.detail, nodeTrailer)
    const row = rowsWith({ handshake: result }).find((r: { id: string }) => r.id === 'handshake')
    assert.ok(row)
    assert.equal(row.ok, false)
    assert.match(row.fix, /claude plugin marketplace update hoai/)
    assert.match(row.fix, /claude plugin update hoai@hoai/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('B: a server that crashes shows node\'s error line, never only the version trailer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oldconnect-b2-'))
  try {
    const script = join(root, 'crash.mjs')
    await writeFile(script, "throw new Error('boom from the server')\n")
    const result = await probeHandshake({
      launchArgv: [script],
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 20_000,
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /server exited \(code 1\)/)
    assert.match(result.detail, /Error: boom from the server/)
    assert.doesNotMatch(result.detail, nodeTrailer)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
