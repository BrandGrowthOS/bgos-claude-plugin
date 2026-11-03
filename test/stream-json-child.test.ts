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

test('a lane child never inherits the daemon BGOS credentials or its terminal', () => {
  const env = laneChildEnv({
    PATH: '/bin',
    HOME: '/h',
    BGOS_PLUGIN_STATE_DIR: '/state',
    BGOS_ASSISTANT_ID: '7',
    BGOS_API_KEY: 'k',
    BGOS_PAIRING_TOKEN: 'p',
    BGOS_CREDENTIALS_PATH: '/c.json',
    BGOS_OPENAI_API_KEY: 'o',
    HOAI_BROWSER_HOST_PAIRING_TOKEN: 'b',
    HOAI_RELAY_PAIRING_TOKEN: 'r',
    BGOS_SOME_NEW_SECRET: 's',
    HOAI_FUTURE_TOKEN: 't',
    BGOS_TMUX_SESSION: 'agent',
    BGOS_TMUX_SOCKET: '/tmp/s',
    TMUX: '/tmp/tmux,1,0',
    TMUX_PANE: '%1',
  })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' })
})

test('the child environment allows only runtime and explicit Claude authentication variables', () => {
  const allowed = {
    PATH: '/bin', HOME: '/h', TMPDIR: '/tmp', LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'fake-claude-key',
    ANTHROPIC_AUTH_TOKEN: 'fake-claude-auth', CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
  }
  assert.deepEqual(laneChildEnv({
    ...allowed,
    AWS_ACCESS_KEY_ID: 'fake-aws-id', AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
    AWS_SESSION_TOKEN: 'fake-aws-session', GITHUB_TOKEN: 'fake-github',
    FOO_TOKEN: 'fake-unknown', UNRELATED_SETTING: 'also dropped',
    NODE_OPTIONS: '--require=/untrusted/preload.js',
  }), allowed)
})

test('the real thread child starts without AWS, GitHub, or unknown exported tokens', async () => {
  const parentEnv = process.env
  let child: ReturnType<typeof spawnStreamJson>
  try {
    // Only fabricated credentials are ever exposed to the pre-fix spawner.
    process.env = {
      PATH: parentEnv.PATH, HOME: parentEnv.HOME,
      ANTHROPIC_API_KEY: 'fake-claude-key',
      AWS_ACCESS_KEY_ID: 'fake-aws-id', AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
      AWS_SESSION_TOKEN: 'fake-aws-session', GITHUB_TOKEN: 'fake-github', FOO_TOKEN: 'fake-unknown',
    }
    child = spawnStreamJson(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { cwd: process.cwd() })
  } finally {
    process.env = parentEnv
  }
  let output = ''
  child.onStdout((chunk) => { output += chunk })
  const code = await new Promise<number | null>((done) => child.onExit(done))
  assert.equal(code, 0, 'the real child still starts')
  const env = JSON.parse(output)
  assert.equal(env.ANTHROPIC_API_KEY, 'fake-claude-key', 'Claude authentication survives')
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GITHUB_TOKEN', 'FOO_TOKEN']) {
    assert.equal(env[name], undefined, `${name} is absent in the actual child`)
  }
})

test('kill stops the lane whole process group, so a tool it started stops with it', { skip: process.platform === 'win32' }, async () => {
  // node stands in for claude and starts a grandchild (a tool), prints its pid, then waits.
  const child = spawnStreamJson(process.execPath, [
    '-e',
    "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(c.pid+'\\n');setInterval(()=>{},1000)",
  ], { cwd: process.cwd() })
  let out = ''
  const pid = await new Promise<number>((resolve) => child.onStdout((c) => { out += c; if (out.includes('\n')) resolve(Number(out.trim())) }))
  const exited = new Promise<void>((resolve) => child.onExit(() => resolve()))
  const alive = (p: number) => { try { process.kill(p, 0); return true } catch { return false } }
  assert.equal(alive(pid), true)
  child.kill('SIGTERM')
  await exited
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((d) => setTimeout(d, 20))
  const survived = alive(pid)
  if (survived) process.kill(pid, 'SIGKILL') // our own grandchild, never left behind
  assert.equal(survived, false, 'the grandchild got the signal too')
})
