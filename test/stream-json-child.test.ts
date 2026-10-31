/**
 * The stream json plumbing thread lanes and By the way share: the NDJSON line
 * splitter, the user message line, the child's environment, and the real
 * spawner (driven here with node standing in for claude).
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { laneChildEnv, lineSplitter, spawnStreamJson, userMessageLine } from '../lib/stream-json-child.ts'

test('frames split across chunks are parsed whole, blank and broken lines are skipped', () => {
  const seen: Array<Record<string, unknown>> = []
  const feed = lineSplitter((f) => seen.push(f))
  feed('{"type":"system","subt')
  feed('ype":"init","session_id":"a"}\n\nnot json\n{"type":"res')
  assert.equal(seen.length, 1)
  feed('ult","result":"ok"}\n')
  assert.deepEqual(seen, [
    { type: 'system', subtype: 'init', session_id: 'a' },
    { type: 'result', result: 'ok' },
  ])
})

test('a JSON value that is not an object is not a frame', () => {
  const seen: unknown[] = []
  const feed = lineSplitter((f) => seen.push(f))
  feed('42\n"s"\nnull\n[1]\n')
  assert.deepEqual(seen, [])
})

test('the user message line is one NDJSON line in the CLI stream json input shape', () => {
  const line = userMessageLine('hello\nworld')
  assert.ok(line.endsWith('\n'))
  assert.equal(line.indexOf('\n'), line.length - 1, 'one line, the text newline is escaped')
  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello\nworld' }] },
  })
})

test('a lane child never inherits the main session identity or its messaging bridge', () => {
  const env = laneChildEnv({
    PATH: '/bin',
    HOME: '/h',
    CLAUDE_CONFIG_DIR: '/c',
    CLAUDE_CODE_SESSION_ID: 'main',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'b',
    CLAUDE_CODE_MESSAGING_SOCKET: '/s',
    CLAUDE_CODE_MESSAGING_TOKEN: 't',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_PID: '1',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })
})

test('the real spawner writes stdin, reads stdout chunks and reports the exit', async () => {
  // node stands in for claude: it echoes each stdin line back upper cased.
  const child = spawnStreamJson(process.execPath, [
    '-e',
    'process.stdin.setEncoding("utf8");let b="";process.stdin.on("data",d=>{b+=d});process.stdin.on("end",()=>{process.stdout.write(b.toUpperCase());process.exit(3)})',
  ], { cwd: process.cwd() })
  let out = ''
  child.onStdout((c) => { out += c })
  const exited = new Promise<number | null>((resolve) => child.onExit((code) => resolve(code)))
  child.write('{"a":1}\n')
  child.end()
  assert.equal(await exited, 3)
  assert.equal(out, '{"A":1}\n')
})

test('a command that cannot start reports an exit instead of throwing', async () => {
  const child = spawnStreamJson('/nonexistent/claude-binary', [], { cwd: process.cwd() })
  const code = await new Promise<number | null>((resolve) => child.onExit((c) => resolve(c)))
  assert.equal(code, null)
  // Writing to a dead child is a no op, never a crash.
  child.write('x\n')
  child.end()
  child.kill('SIGTERM')
})
