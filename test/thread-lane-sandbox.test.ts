/**
 * Optional real CLI sandbox check, with a local scripted API and dummy login.
 * Run with THREADS_SANDBOX_CLAUDE=/absolute/path/to/claude. No model is called.
 */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { laneSecretPaths, threadLaneSettings, threadLaneTools } from '../lib/thread-lane-args.ts'
import { spawnStreamJson } from '../lib/stream-json-child.ts'

const claude = process.env.THREADS_SANDBOX_CLAUDE

test('the real thread starts with filtered credentials and its sandbox reads only permitted files', {
  skip: !claude || process.platform === 'win32', timeout: 45_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thread-sandbox-'))
  const home = join(dir, 'home')
  const root = join(dir, 'workspace')
  const configDir = join(dir, 'config')
  const agents = join(home, '.bgos-agent')
  const emailFiles = join(agents, 'email-files', '7')
  const attachment = join(emailFiles, 'attachment-1.txt')
  const credential = join(agents, 'credentials-8.json')
  for (const path of [root, configDir, emailFiles]) mkdirSync(path, { recursive: true })
  writeFileSync(attachment, 'ATTACHMENT_OK_7')
  writeFileSync(join(agents, 'credentials-7.json'), 'EXISTING_CREDENTIAL_7')
  const emptyMcp = join(dir, 'empty-mcp.json')
  writeFileSync(emptyMcp, '{"mcpServers":{}}')
  // Keep the input shape compatible with the old policy for mutation checks.
  const secretInput = { home, configDir, agentFolder: root, keepReadable: [emailFiles], exists: existsSync, list: readdirSync }
  const confinement = { root, readOnly: false, shellSandbox: true, secretPaths: laneSecretPaths(secretInput), readablePaths: [emailFiles] }
  const results: unknown[] = []
  let requests = 0
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
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
    const last = body.messages?.at(-1)
    if (last?.role === 'user' && Array.isArray(last.content)) {
      results.push(...last.content.filter((block: { type: string }) => block.type === 'tool_result'))
    }
    const step = requests++
    // Pair only after the first sandboxed command has finished.
    if (step === 1) writeFileSync(credential, 'FUTURE_CREDENTIAL_8')
    const envCheck = 'printenv AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN GITHUB_TOKEN FOO_TOKEN; echo ENV_CHECK_COMPLETE'
    const block = step < 3
      ? { type: 'tool_use', id: `tool_${step}`, name: 'Bash', input: { command: step === 2 ? envCheck : `cat ${quote(step === 0 ? attachment : credential)}`, description: 'Check thread isolation' } }
      : { type: 'text', text: 'Sandbox check complete.' }
    const usage = { input_tokens: 1, output_tokens: 1 }
    const message = { id: `msg_${step}`, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: step < 3 ? 'tool_use' : 'end_turn', stop_sequence: null, usage }
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    event('message_start', { message: { ...message, content: [], stop_reason: null } })
    event('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
    event('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
    event('content_block_stop', { index: 0 })
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage })
    event('message_stop', {})
    res.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number }
  let output = ''
  const parentEnv = process.env
  let child: ReturnType<typeof spawnStreamJson>
  try {
    process.env = {
      HOME: home, PATH: parentEnv.PATH, TMPDIR: dir,
      CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'local-test-not-a-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      AWS_ACCESS_KEY_ID: 'fake-aws-id', AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
      AWS_SESSION_TOKEN: 'fake-aws-session', GITHUB_TOKEN: 'fake-github', FOO_TOKEN: 'fake-unknown',
    }
    child = spawnStreamJson(claude!, [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--restricted', '--tools', threadLaneTools(confinement).join(','), '--permission-mode', 'acceptEdits',
      '--settings', JSON.stringify(threadLaneSettings(confinement)), '--max-turns', '4',
      '--strict-mcp-config', '--mcp-config', emptyMcp,
    ], { cwd: root })
  } finally {
    process.env = parentEnv
  }
  child.onStdout((data) => { output += data })
  const timer = setTimeout(() => child.kill('SIGKILL'), 35_000)
  try {
    child.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Run the scripted sandbox checks.' } })}\n`)
    child.end()
    const exit = await new Promise<number | null>((done) => child.onExit(done))
    assert.equal(exit, 0, output)
    assert.match(output, /"subtype":"init"/, 'a real Claude thread child initialized')
    assert.equal(requests, 4, output)
    assert.equal(results.length, 3, output)
    assert.match(JSON.stringify(results[0]), /ATTACHMENT_OK_7/, output)
    assert.doesNotMatch(JSON.stringify(results[1]), /FUTURE_CREDENTIAL_8/, output)
    assert.match(JSON.stringify(results[1]), /Operation not permitted|Permission denied/, output)
    assert.match(JSON.stringify(results[2]), /ENV_CHECK_COMPLETE/, output)
    assert.doesNotMatch(JSON.stringify(results[2]), /fake-aws|fake-github|fake-unknown/, output)
  } finally {
    clearTimeout(timer)
    child.kill('SIGKILL')
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(dir, { recursive: true, force: true })
  }
})
