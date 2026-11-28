/**
 * The kit check's finding 1, end to end (2026-11-25): the real server.ts,
 * spawned under bun as Claude Code spawns it, paired to a fixture backend that
 * serves the real 207,587 character guide.
 *
 * As shipped in 0.90.18 the model was told nothing of rule 1 unless it called
 * bgos_capabilities, and that call answered the whole guide in one result,
 * which Claude Code refused and saved to a file the model did not read. Here:
 *  - the initialize handshake's instructions carry the core rules, rule 1
 *    included, inside the 4,096 characters Claude Code 2.1.332 shows;
 *  - every bgos_capabilities answer (the default, each topic, each part) is
 *    under GUIDE_ANSWER_MAX_BYTES, measured in UTF-8 bytes on the wire.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from 'socket.io'
import { CORE_RULES_TEXT, OWNER_CHAT_ACK_RULE, SAVE_SKILLS_PARAGRAPH } from '../lib/core-rules.ts'

const SERVED = gunzipSync(readFileSync(new URL('./fixtures/served-canon-claude-2026-11-25.txt.gz', import.meta.url))).toString('utf8')
const SHOWN = 4096
const CAP = 20_000

test('initialize shows the reaction and skill rules and when to apply them, and every guide answer is small', { timeout: 90_000 }, async () => {
  const assistantId = randomInt(1, 1000000)
  const chatId = randomInt(1, 1000000)
  const owner = 'user_' + randomUUID()
  const root = mkdtempSync(join(tmpdir(), 'capsize-daemon-'))
  const home = join(root, 'home')
  const folder = join(root, 'work')
  let capabilityFetches = 0
  const http = createServer((req, res) => {
    req.resume()
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    let data: unknown = {}
    if (path.endsWith('/integrations/capabilities')) {
      capabilityFetches += 1
      data = { channel: 'claude', version: 'fixture-capsize', text: SERVED }
    } else if (path.endsWith('/peers/inbox')) data = { chats: [{ id: chatId, assistantId, kind: 'main', userId: owner }] }
    else if (path.endsWith('/messages')) data = { messages: [] }
    else if (path.endsWith('/meetings')) data = []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  })
  const io = new Server(http)
  const client = new Client({ name: 'capsize-test', version: '1' }, { capabilities: {} })
  try {
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok))
    const backendUrl = 'http://127.0.0.1:' + (http.address() as AddressInfo).port + '/api/v1'
    const dir = join(home, '.bgos-agent')
    mkdirSync(dir, { recursive: true })
    mkdirSync(folder)
    writeFileSync(join(dir, 'credentials-' + assistantId + '.json'), JSON.stringify({
      backendUrl, pairingToken: randomUUID(), pairingId: randomInt(1, 1000000), userId: owner, assistantId, homeDir: folder, homeSource: 'pairing',
    }))
    writeFileSync(join(folder, '.bgos-agent-id'), String(assistantId))
    const bun = spawnSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout?.trim()
    assert.ok(bun, 'bun is installed')
    const transport = new StdioClientTransport({
      command: bun,
      args: [resolve(import.meta.dirname, '../server.ts')],
      cwd: folder,
      stderr: 'pipe',
      env: {
        PATH: [dirname(bun), dirname(process.execPath)].join(delimiter),
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        TMPDIR: root, TMP: root, TEMP: root,
        CLAUDE_PLUGIN_ROOT: resolve(import.meta.dirname, '..'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_CODE_EXECPATH: join(root, 'absent'),
        BGOS_LAUNCH_CWD: folder,
        CLAUDE_PROJECT_DIR: folder,
        BGOS_AUTO_UPDATE: 'disabled',
        HOAI_BROWSER_HOST: 'off',
        BGOS_BOOT_HELLO: 'off',
      },
    })
    let log = ''
    transport.stderr?.on('data', (chunk) => { log += String(chunk) })
    await client.connect(transport)

    // 1. The handshake: the rules are in what Claude Code shows the model.
    const instructions = client.getInstructions() ?? ''
    const shown = instructions.slice(0, SHOWN)
    assert.ok(shown.includes(CORE_RULES_TEXT), 'the core rules are not inside the first 4,096 characters')
    assert.ok(shown.includes(OWNER_CHAT_ACK_RULE))
    assert.ok(shown.includes('Every response to a BGOS message MUST go through the `reply` tool.'))
    assert.ok(shown.includes(SAVE_SKILLS_PARAGRAPH), 'initialize must include the whole skill rule before any tool call')
    assert.ok(shown.includes('Before your final `reply` to your owner, apply the skill rule above to the work you just finished.'),
      'initialize must remind the agent to apply the skill rule before its final reply')

    // 2. The tool: every answer on the wire is under the cap.
    const tools = await client.listTools()
    const tool = tools.tools.find((t) => t.name === 'bgos_capabilities')
    assert.ok(tool, 'bgos_capabilities is listed')
    assert.deepEqual(Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).sort(), ['part', 'topic'])
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'bgos_capabilities', arguments: args })
      const content = result.content as Array<{ type: string; text: string }>
      assert.equal(content.length, 1)
      const text = content[0]!.text
      assert.ok(Buffer.byteLength(text, 'utf8') <= CAP, `${JSON.stringify(args)}: ${Buffer.byteLength(text, 'utf8')} bytes`)
      return { text, isError: result.isError === true }
    }
    const first = await call({})
    assert.equal(first.isError, false)
    assert.ok(log.includes('Capability canon ready: vfixture-capsize'), 'the fixture guide was served, not the fallback')
    assert.ok(capabilityFetches >= 1)
    assert.ok(first.text.includes(CORE_RULES_TEXT))
    const ids = [...first.text.matchAll(/^- ([a-z0-9-]+): /gm)].map((m) => m[1]!)
    assert.ok(ids.length >= 30, `the index lists ${ids.length} topics`)
    let total = 0
    for (const id of ids) {
      let part = 1
      for (;;) {
        const answer = await call({ topic: id, part })
        assert.equal(answer.isError, false, `${id} part ${part}`)
        total += Buffer.byteLength(answer.text, 'utf8')
        const next = answer.text.match(/\{"topic": "[a-z0-9-]+", "part": (\d+)\}/)
        if (!next) break
        part = Number(next[1])
      }
    }
    // Reading every topic reaches the whole guide (with the parts' own notes).
    assert.ok(total >= Buffer.byteLength(SERVED, 'utf8') * 0.95, `the topics hold ${total} bytes of ${Buffer.byteLength(SERVED, 'utf8')}`)
    const conversation = await call({ topic: 'conversation-model' })
    assert.ok(conversation.text.includes('ACKNOWLEDGE WITH A REACTION, NOT A REPLY.'))
    assert.equal((await call({ topic: 'nope' })).isError, true)
  } finally {
    try { await client.close() } finally {
      await new Promise<void>((ok) => { io.close(() => ok()); http.closeAllConnections() })
      rmSync(root, { recursive: true, force: true })
    }
  }
})
