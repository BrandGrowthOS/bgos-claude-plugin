import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markFloorAttached, floorKey, attachedMarkerPath } from '../lib/floor-state.mjs'
import { privateContextPath, privateMarkerPath, publishPrivateContext, writePrivateJson } from '../lib/private-turn.mjs'

test('real launcher and shim force attached operator credentials through verified recipient context', async t => {
  const shippedManagedFlag = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).mcpServers['hoai-browser'].env.HOAI_RELAY_MANAGED
  assert.equal(shippedManagedFlag, '1')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-managed-launch-')))
  const cwd = join(root, 'agent'); mkdirSync(cwd)
  markFloorAttached({ root, folders: [cwd] })
  const seen: any[] = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    seen.push({ actor: req.headers['x-bgos-acting-user'] || null, body })
    const message = body?.message
    const answer = req.url?.includes('/host') ? { online: true } : { status: 'done', message: { jsonrpc: '2.0', id: message?.id,
      result: message?.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {} } : { content: [{ type: 'text', text: 'synthetic result' }] } } }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(answer))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const markerPath = privateMarkerPath(root, floorKey(cwd))
  const turn = { actingUserId: 'user_recipient', chatId: '20', sessionId: 'synthetic-session', turnId: 'synthetic-turn', promptHash: 'a'.repeat(64), markerPath }
  const publish = () => {
    writePrivateJson(markerPath, { schemaVersion: 1, ...turn, live: true })
    publishPrivateContext({ path: privateContextPath(root, '901'), secret: 'synthetic-pairing', assistantId: '901', ownerUserId: 'user_owner', claudePid: process.pid, turn })
  }
  publish()
  const children: any[] = []
  const start = (managed: boolean, owner = 'user_owner', beforeAttachment = false) => {
    const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: managed ? cwd : join(root, 'standalone'), BGOS_LAUNCH_CWD: '', BGOS_USER_ID: owner,
      HOAI_RELAY_MANAGED: beforeAttachment ? shippedManagedFlag : '', BGOS_ASSISTANT_ID: beforeAttachment ? '901' : '', BGOS_CREDENTIALS_PATH: beforeAttachment ? join(root, 'missing-credentials.json') : '', BGOS_PAIRING_TOKEN: beforeAttachment ? 'synthetic-pairing' : '', BGOS_BACKEND_URL: beforeAttachment ? origin : '',
      HOAI_HOME: root, HOAI_RELAY_BACKEND_URL: origin, HOAI_RELAY_ASSISTANT_ID: '901', HOAI_RELAY_PAIRING_TOKEN: 'synthetic-pairing', HOAI_RELAY_API_KEY: '', HOAI_RELAY_PROBE_MS: '600000' }
    for (const name of ['HOAI_RELAY_CONTEXT_FILE', 'HOAI_RELAY_OWNER_USER_ID', 'HOAI_RELAY_CLIENT_PID']) delete (env as any)[name]
    const child = spawn(process.execPath, ['bin/hoai-browser-launch.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.push(child)
    const responses: any[] = []; let buffer = '', id = 0
    child.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop()!; for (const line of lines.filter(Boolean)) responses.push(JSON.parse(line)) })
    child.stderr.resume()
    return async () => {
      const requestId = ++id
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }) + '\n')
      const deadline = Date.now() + 10000
      while (!responses.some(response => response.id === requestId)) { if (Date.now() > deadline) throw new Error('launcher response timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
      return responses.find(response => response.id === requestId)
    }
  }
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end(); await exited }
    }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    assert.ok(root.includes('hoai-managed-launch-')); rmSync(root, { recursive: true, force: true })
  })
  // Browser MCP starts before the channel daemon has attached or published.
  unlinkSync(attachedMarkerPath(root, floorKey(cwd)))
  unlinkSync(privateContextPath(root, '901'))
  const earlyRequest = start(true, 'user_owner', true)
  assert.equal((await earlyRequest()).result.isError, true)
  assert.equal(seen.length, 0, 'no owner RPC while the managed daemon is still starting')
  publish()
  assert.notEqual((await earlyRequest()).result.isError, true, 'same MCP process becomes usable after signed context publication')
  assert.ok(seen.every(row => row.actor === 'user_recipient'))
  markFloorAttached({ root, folders: [cwd] })
  const recipientRequest = start(true)
  assert.notEqual((await recipientRequest()).result.isError, true)
  assert.ok(seen.length > 0)
  assert.ok(seen.every(row => row.actor === 'user_recipient'))
  const count = seen.length
  writePrivateJson(markerPath, { schemaVersion: 1, ...turn, turnId: 'next-unknown-turn', live: true })
  assert.equal((await recipientRequest()).result.isError, true)
  assert.equal(seen.length, count, 'stale turn emitted no owner or recipient request')
  publish()
  const missingOwner = start(true, '')
  assert.equal((await missingOwner()).result.isError, true)
  assert.equal(seen.length, count, 'incomplete managed identity emitted no request')
  const standalone = start(false)
  assert.notEqual((await standalone()).result.isError, true)
  assert.ok(seen.slice(count).every(row => row.actor === null), 'manual standalone credentials retain their owner route')
})
