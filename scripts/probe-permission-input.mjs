#!/usr/bin/env node
// Real CLI, local canned model, synthetic input only. The hook denies execution.
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const command = `printf '%s' 'alpha\u200Bbeta\u2060gamma\u202Edelta${'\u2028'.repeat(60)}omega'`

if (process.argv[2] === '--hook') {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const payload = JSON.parse(raw)
  // Keep no machine paths, generated session ids, or credentials.
  writeFileSync(process.argv[3], JSON.stringify({
    hook_event_name: payload.hook_event_name,
    tool_name: payload.tool_name,
    tool_input: payload.tool_input,
    tool_use_id: payload.tool_use_id,
  }, null, 2))
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'Synthetic permission input probe; never execute.',
  } }))
} else {
  const scratch = join(root, '.permhidden-tmp', 'cli-probe')
  mkdirSync(scratch, { recursive: true })
  const capture = join(scratch, 'hook.json')
  rmSync(capture, { force: true })
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
  const settings = join(scratch, 'settings.json')
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{
    type: 'command', command: `${quote(process.execPath)} ${quote(script)} --hook ${quote(capture)}`,
  }] }] } }))
  let requests = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.url?.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ input_tokens: 10 }))
    }
    const input = JSON.parse(body || '{}')
    const isTurn = Array.isArray(input.tools) && input.tools.some((tool) => tool.name === 'Bash')
    const useTool = isTurn && requests++ === 0
    const content = useTool
      ? [{ type: 'tool_use', id: 'toolu_permhidden_probe', name: 'Bash', input: { command, description: 'Synthetic hidden character probe' } }]
      : [{ type: 'text', text: 'Synthetic probe finished.' }]
    const message = { id: 'msg_permhidden_probe', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content, stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 } }
    if (!input.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(message))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    event('message_start', { message: { ...message, content: [], stop_reason: null } })
    content.forEach((block, index) => {
      event('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
      event('content_block_delta', { index, delta: block.type === 'tool_use'
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text } })
      event('content_block_stop', { index })
    })
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
    event('message_stop', {})
    res.end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const child = spawn('claude', ['-p', 'Run the synthetic probe.', '--model', 'claude-sonnet-4-6',
    '--tools', 'Bash', '--settings', settings, '--setting-sources', '', '--strict-mcp-config',
    '--no-session-persistence', '--output-format', 'json'], {
    cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TMPDIR: scratch, CLAUDE_CONFIG_DIR: join(scratch, 'config'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'synthetic-probe-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' },
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
  const code = await new Promise((done) => child.once('close', done))
  clearTimeout(timer)
  server.closeAllConnections()
  server.close()
  if (code !== 0 || !existsSync(capture)) {
    writeFileSync(join(scratch, 'failure.log'), output)
    throw new Error(`Probe did not complete; CLI exit ${code}; local failure log retained.`)
  }
  const hook = JSON.parse(readFileSync(capture, 'utf8'))
  if (hook.tool_input.command !== command) throw new Error('Hook changed command bytes')
  const fixture = { cli: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    provenance: 'Real CLI with local canned model response; hook denied execution. Envelope paths and session id omitted.',
    model_command: command, hook }
  const evidence = join(root, 'docs', 'evidence', '2026-11-09-permhidden')
  mkdirSync(evidence, { recursive: true })
  // Escapes make every invisible character visible in the public evidence.
  writeFileSync(join(evidence, 'payload.json'), `${JSON.stringify(fixture, null, 2).replace(/[\u200b\u2060\u202e\u2028]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`)
  console.log(`CLI ${fixture.cli}: PreToolUse command bytes preserved (${Buffer.byteLength(command)} UTF-8 bytes). Execution denied.`)
}
