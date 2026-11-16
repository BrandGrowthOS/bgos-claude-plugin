/**
 * PERSON LANES, the real CLI under a lane's own environment and settings.
 *
 * Person lanes run in dontAsk and refuse command access on every host.
 * These drive the installed `claude` with laneChildEnv,
 * laneSettingsBody, the lane's real floor hook and, for the launch, the real
 * supervised expect script, against a scripted API on 127.0.0.1. HOME and the
 * config folder are temp folders and every value is made up. No model is
 * called. Any other HTTPS call goes to the same local server, which refuses it.
 *
 * The version each run used is in the diagnostics. With no CLI, no expect or
 * no CLI support on this host the tests report NOT RUN with the reason.
 *
 * Choose the binary with LANE_SANDBOX_CLAUDE=/absolute/path/to/claude.
 * Run with: npx tsx --test test/lane-subprocess-env.test.ts
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { delimiter, dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildGateAutoAcceptExpect, tclQuote } from '../bin/hoai-core.mjs'
import { LANE_BUILTIN_TOOLS, laneChildEnv, laneLaunchArgsFor, lanePaths, laneSettingsBody } from '../lib/lane-core.mjs'
import { scratchDir } from './helpers/scratch-dirs.ts'
import { cleanupLaneFixture } from './helpers/lane-fixture-cleanup.ts'
import { prepareLaneLaunch } from '../lib/lane-supervisor.mjs'
import { LOCKED_TOOL_POLICY, laneAllowAdditions, laneToolsFor } from '../lib/lane-policy.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const onPath = (name: string): string | null => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  }
  return null
}
const claude = process.env.LANE_SANDBOX_CLAUDE || onPath('claude')

function notRunBecause(): string | null {
  if (process.platform === 'win32') return 'lanes are not offered on Windows'
  if (!claude) return 'no claude binary on PATH and LANE_SANDBOX_CLAUDE is not set'
  if (!onPath('expect')) return 'no expect on this host'
  return null
}

function reported(t: TestContext): boolean {
  const reason = notRunBecause()
  if (reason) {
    if (process.env.HOAI_REQUIRE_LANE_CLI === '1') assert.fail(`Required lane CLI test could not run: ${reason}`)
    t.skip(`NOT RUN: ${reason}`)
    return false
  }
  t.diagnostic(`ran on ${execFileSync(claude!, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()}`)
  return true
}

type Step = { name: string; input: Record<string, unknown> }

/** A local API that answers the main loop's requests with the steps, one per request, then text. */
async function scriptedApi(stepsFor: () => Step[], answer = 'Lane check complete.') {
  const results: Array<{ is_error?: boolean }> = []
  const logins: string[] = []
  const seenResults = new Set<string>()
  const state = { sent: 0, epoch: 0, outsideCalls: [] as string[], tools: [] as string[] }
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
    logins.push(String(req.headers['x-api-key'] ?? req.headers.authorization ?? ''))
    for (const message of body.messages ?? []) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type !== 'tool_result' || seenResults.has(block.tool_use_id)) continue
        seenResults.add(block.tool_use_id)
        results.push(block)
      }
    }
    const steps = stepsFor()
    for (const tool of body.tools ?? []) if (!state.tools.includes(tool.name)) state.tools.push(tool.name)
    const mainLoop = Array.isArray(body.tools) && body.tools.some((tool: { name: string }) => tool.name === 'Read')
    const step = mainLoop && state.sent < steps.length ? state.sent++ : -1
    const block: { type: 'tool_use', id: string, name: string, input: Record<string, unknown> } | { type: 'text', text: string } = step >= 0
      ? { type: 'tool_use', id: `tool_${state.epoch}_${step}`, ...steps[step]! }
      : { type: 'text', text: answer }
    const usage = { input_tokens: 1, output_tokens: 1 }
    const stop = block.type === 'tool_use' ? 'tool_use' : 'end_turn'
    const message = { id: `msg_${state.sent}_${logins.length}`, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage }
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
    event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage })
    event('message_stop', {})
    res.end()
  })
  // A call that is not for the scripted API arrives here as a proxy CONNECT and goes no further.
  server.on('connect', (req, socket) => { state.outsideCalls.push(String(req.url)); socket.destroy() })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    results, logins, state, local: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

/** A lane's folders, environment, settings and argv, built by the lane's own functions. */
function laneOnDisk(local: string, shell: boolean) {
  const dir = realpathSync(scratchDir('lane-subprocess-env-'))
  const home = join(dir, 'home')
  const paths = lanePaths({ home, assistantId: '1076', userId: 'user_made_up' })
  const configDir = shell ? paths.configDir : join(dir, 'config')
  for (const path of [paths.workDir, configDir, join(paths.workDir, '.tmp')]) mkdirSync(path, { recursive: true })
  const fixtureBin = join(dir, 'bin')
  mkdirSync(fixtureBin, { recursive: true })
  writeFileSync(join(fixtureBin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 })
  const apiKey = 'made-up-api-key'
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
    projects: { [paths.workDir]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }))
  const ownerEnv = {
    HOME: home, PATH: `${fixtureBin}:${process.env.PATH ?? ''}`, USER: 'lane-made-up', TMPDIR: dir, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: 'made-up-oauth-token', ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: 'made-up-auth-token',
    ANTHROPIC_BASE_URL: local,
    AWS_ACCESS_KEY_ID: 'made-up-aws', GITHUB_TOKEN: 'made-up-github', FOO_TOKEN: 'made-up-unknown',
  }
  const policy = { ...LOCKED_TOOL_POLICY }
  const env: Record<string, string> = {
    ...laneChildEnv({
      ownerEnv, login: shell ? { mode: 'own_token', token: 'made-up-oauth-token', configDir } : { mode: 'inherit' }, assistantId: '1076', userId: 'user_made_up',
      workDir: paths.workDir, laneDir: paths.laneDir, stateDir: paths.stateDir, backendUrl: `${local}/api/v1`,
    }),
    // The test's own fence, on top of the lane's environment.
    ANTHROPIC_BASE_URL: local, ANTHROPIC_API_KEY: apiKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTPS_PROXY: local, NO_PROXY: '127.0.0.1',
  }
  writeFileSync(paths.settingsPath, JSON.stringify(laneSettingsBody({
    workDir: paths.workDir, userId: 'user_made_up', nodePath: process.execPath,
    floorHookPath: join(repoRoot, 'bin', 'hoai-lane-floor-hook.mjs'),
    allowExtra: laneAllowAdditions(policy),
  })))
  writeFileSync(paths.mcpPath, '{"mcpServers":{}}')
  const args = laneLaunchArgsFor({ mcpConfigPath: paths.mcpPath, settingsPath: paths.settingsPath, tools: laneToolsFor(policy, LANE_BUILTIN_TOOLS) })
  return { dir, home, paths, env, args, remove: () => cleanupLaneFixture(dir) }
}

/** `claude -p` under the lane's argv, to its end. */
async function runPrint(lane: ReturnType<typeof laneOnDisk>) {
  const child = spawn(claude!, ['-p', 'Run the scripted lane check.', '--output-format', 'stream-json', '--verbose', '--max-turns', '12', ...lane.args], { cwd: lane.paths.workDir, env: lane.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const timer = setTimeout(() => child.kill('SIGKILL'), 100_000)
  const exit = await new Promise<number | null>((done) => child.on('close', done))
  clearTimeout(timer)
  return { exit, output }
}

/** The lane's real supervised launch through expect, nobody at the terminal, until a tool result comes back or the wait ends. */
async function runSupervised(lane: ReturnType<typeof laneOnDisk>, api: Awaited<ReturnType<typeof scriptedApi>>, waitMs = 45_000, extraArgs: string[] = [], prompt = 'Run the scripted lane check.') {
  const script = buildGateAutoAcceptExpect({
    claudePath: tclQuote(claude!),
    args: [...(prompt ? [prompt] : []), ...lane.args, ...extraArgs],
    supervised: { stateDir: lane.paths.laneDir, interactive: false, compact: 'compact=off reason=lane', denyPermissionPrompts: true },
  })
  const child = spawn('expect', ['-c', script.replace('set timeout 300', 'set timeout 1')], { cwd: lane.paths.workDir, env: lane.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let screen = ''
  child.stdout.on('data', (data) => { screen += data })
  child.stderr.on('data', (data) => { screen += data })
  const closed = new Promise<void>((done) => child.on('close', () => done()))
  const started = Date.now()
  while (api.results.length === 0 && Date.now() - started < waitMs && child.exitCode === null) {
    await new Promise((done) => setTimeout(done, 100))
  }
  const answeredInMs = api.results.length > 0 ? Date.now() - started : null
  // expect's own trap ends the claude it spawned.
  const exitBeforeStop = child.exitCode
  child.kill('SIGTERM')
  const hard = setTimeout(() => child.kill('SIGKILL'), 5_000)
  await closed
  clearTimeout(hard)
  return { answeredInMs, exitBeforeStop, exitCode: child.exitCode, screen: screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ').replace(/\s+/g, ' ').slice(-1500) }
}

test('a lane without shell on the real CLI runs in the dontAsk permission mode it asks for', { timeout: 120_000 }, async (t) => {
  if (!reported(t)) return
  const api = await scriptedApi(() => [])
  const lane = laneOnDisk(api.local, false)
  try {
    const { exit, output } = await runPrint(lane)
    assert.equal(exit, 0, output)
    assert.equal(/"permissionMode":"([A-Za-z]+)"/.exec(output)?.[1], 'dontAsk', output)
  } finally {
    await api.close()
    await lane.remove()
  }
})

// A write the CLI's own safety check would ask about, inside the lane's own folder, which the lane's allow rule covers.
for (const { shell, refusal } of [
  { shell: false, refusal: /don't ask mode/ },
]) {
  test(`the real supervised launch, nobody at the terminal: a ${shell ? 'shell lane' : 'lane without shell'} refuses what would ask, at once`, { timeout: 120_000 }, async (t) => {
    if (!reported(t)) return
    const stepHolder: Step[] = []
    const api = await scriptedApi(() => stepHolder)
    const lane = laneOnDisk(api.local, shell)
    const target = join(lane.paths.workDir, '.claude', 'settings.json')
    stepHolder.push({ name: 'Write', input: { file_path: target, content: '{}' } })
    try {
      const { answeredInMs, screen } = await runSupervised(lane, api)
      assert.notEqual(answeredInMs, null, `no tool result came back. The screen ends: ${screen}`)
      t.diagnostic(`answered ${answeredInMs} ms after launch`)
      assert.equal(api.results[0]!.is_error, true, JSON.stringify(api.results[0]))
      assert.match(JSON.stringify(api.results[0]), refusal)
      assert.equal(existsSync(target), false, 'nothing was written')
      t.diagnostic(`calls stopped at the local server: ${[...new Set(api.state.outsideCalls)].join(' ') || 'none'}`)
    } finally {
      await api.close()
      await lane.remove()
    }
  })
}

for (const shell of [false]) {
  test(`the real unattended ${shell ? 'shell' : 'locked'} lane stays available across a resume`, { timeout: 120_000 }, async (t) => {
    if (!reported(t)) return
    const text = 'Would you like to proceed? 1) Yes 2) No'
    const api = await scriptedApi(() => [], text)
    const lane = laneOnDisk(api.local, shell)
    const pin = (await import('node:crypto')).randomUUID()
    try {
      writeFileSync(lane.paths.laneJsonPath, '{"inFlight":true}')
      const first = await runSupervised(lane, api, 14_000, ['--session-id', pin], text)
      assert.ok(api.logins.length > 0, first.screen)
      assert.match(first.screen, /Would you like to proceed/)
      assert.equal(first.exitBeforeStop, null, first.screen)
      const resumed = await runSupervised(lane, api, 14_000, ['--resume', pin], '')
      assert.match(resumed.screen, /Would you like to proceed/)
      assert.equal(resumed.exitBeforeStop, null, resumed.screen)
      t.diagnostic('fresh and resumed sessions remained available after the turn ended')
    } finally { await api.close(); await lane.remove() }
  })
}

// Real hoai -> real agent CLI -> MCP child -> production supervisor builder ->
// real hoai-lane command -> supervisor -> expect -> real lane CLI. Only the
// credential store, policy service and notice delivery use local fixtures.
for (const scenario of [
  { label: 'oauth', extra: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-owner-oauth' }, shell: false },
  { label: 'oauth and api key', extra: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-owner-oauth', ANTHROPIC_API_KEY: 'made-up-owner-api' }, shell: false },
  { label: 'auth token', extra: { ANTHROPIC_AUTH_TOKEN: 'made-up-owner-auth' }, shell: false },
  { label: 'scrubbed oauth', extra: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-owner-oauth', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', ANTHROPIC_API_KEY: 'made-up-owner-api' }, shell: false },
  { label: 'other names', extra: Object.fromEntries(['AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'WHATEVER_FUTURE_LOGIN'].map((name) => [name, 'made-up-unknown-owner'])), shell: false },
  { label: 'non-login config', extra: {}, shell: false },
  { label: 'inherited input', extra: { ANTHROPIC_API_KEY: 'made-up-owner-api' }, shell: false, inherit: true },
]) {
  test(`real launcher chain: ${scenario.label}`, { timeout: 120_000 }, async (t) => {
    if (!reported(t)) return
    const { openSync, closeSync, readFileSync } = await import('node:fs')
    const lane = laneOnDisk('http://127.0.0.1:1', true)
    const libraryRoot = process.env.LANE_CHAIN_LIBRARY_ROOT || repoRoot
    const paths = lane.paths
    const configDir = join(lane.home, 'owner-config')
    const bin = join(lane.dir, 'bin')
    const agent = join(lane.dir, 'agent')
    for (const dir of [configDir, bin, agent, join(lane.home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(claude!, join(bin, 'claude'))
    // No real keychain access, including during CLI startup.
    writeFileSync(join(bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 })
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['made-up-owner-api'], rejected: [] }, projects: { [agent]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, enabledMcpjsonServers: ['bgos'], allowedTools: ['mcp__bgos'] } } }))
    mkdirSync(join(agent, '.claude'), { recursive: true })
    writeFileSync(join(agent, '.claude/settings.json'), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ['bgos'] }))
    writeFileSync(join(agent, '.bgos-agent-id'), '1076\n')
    writeFileSync(paths.loginModesPath, JSON.stringify({ modes: { user_made_up: 'inherit' in scenario ? 'inherit' : 'own_token' } }))
    writeFileSync(join(lane.home, '.bgos-agent/shell-host.json'), JSON.stringify({ v: 1, assistantId: '1076', userId: 'user_made_up', dedicatedAccount: true }))
    const resultFile = join(lane.dir, 'result.json')
    const daemonFile = join(lane.dir, 'daemon.json')
    const configFile = join(lane.dir, 'fixture.json')
    const launchPid = join(lane.dir, 'launcher.pid')
    const screenFile = join(lane.dir, 'screen.log')
    const api = await scriptedApi(() => [{ name: 'Bash', input: { command: 'printf COMMAND_UNAVAILABLE', description: 'Lane check' } }])
    writeFileSync(configFile, JSON.stringify({ home: lane.home, local: api.local, libraryRoot, resultFile, daemonFile, expectInherited: 'inherit' in scenario, hideOwnerConfig: ['oauth', 'oauth and api key', 'auth token', 'scrubbed oauth', 'other names'].includes(scenario.label), agentMcp: join(agent, '.mcp.json'), tsx: import.meta.resolve('tsx') }))
    writeFileSync(join(agent, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), join(repoRoot, 'test/fixtures/lane-context-daemon.mjs'), configFile] } } }))
    const env = { HOME: lane.home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: lane.dir, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: api.local, HTTPS_PROXY: api.local, NO_PROXY: '127.0.0.1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '1076', BGOS_BACKEND_URL: `${api.local}/api/v1`, ...scenario.extra }
    const out = openSync(screenFile, 'w')
    const starter = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const p=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(join(repoRoot, 'test/fixtures/lane-context-launcher.mjs'))},${JSON.stringify(configFile)}],{env:${JSON.stringify(env)},cwd:${JSON.stringify(agent)},detached:true,stdio:['ignore',1,2]});writeFileSync(${JSON.stringify(launchPid)},String(p.pid));p.unref()`
    let pid = 0
    let stopped = false
    try {
      execFileSync(process.execPath, ['-e', starter], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', out, out] })
      closeSync(out)
      pid = Number(readFileSync(launchPid, 'utf8'))
      const started = Date.now()
      while (!existsSync(resultFile) && Date.now() - started < 65_000) {
        if (!stopped && api.results.length > 0) { writeFileSync(paths.stopRequestPath, '{"reason":"test_done"}'); stopped = true }
        await new Promise((r) => setTimeout(r, 100))
      }
      const screen = readFileSync(screenFile, 'utf8').slice(-2500)
      assert.ok(existsSync(resultFile), `no supervisor result: ${screen}`)
      const result = JSON.parse(readFileSync(resultFile, 'utf8'))
      assert.equal(result.error, undefined, JSON.stringify(result))
      const daemon = JSON.parse(readFileSync(daemonFile, 'utf8'))
      t.diagnostic(JSON.stringify({ label: scenario.label, daemon, shell: result.policy.policy.shell, notices: result.notices, results: api.results }))
      assert.equal(daemon.oauthVisible, false, 'the real agent CLI hides OAuth from its MCP child')
      assert.equal(result.policy.policy.shell, scenario.shell, JSON.stringify({ result, daemon }))
      assert.equal(daemon.unknownVisible, false, 'unknown values do not reach the supervisor')
      assert.equal(result.policy.shellRefused, 'unavailable')
      assert.deepEqual(result.notices, ['shell_refused'])
      assert.equal(daemon.proof, undefined)
      assert.equal(api.results.length, 1)
      assert.equal(api.results[0]!.is_error, true)
      if ('inherit' in scenario) {
        assert.equal(result.inheritedApiVisible, true)
        assert.ok(api.logins.some((login) => login.includes('made-up-owner-api')))
      }
      t.diagnostic(JSON.stringify({ label: scenario.label, daemon, shell: result.policy.policy.shell, notices: result.notices, elapsedMs: Date.now() - started }))
    } finally {
      // Snapshot descendants while the launcher is still their parent.
      // End detached CLI and MCP children before removing the fixture home.
      try { await cleanupLaneFixture(lane.dir, pid || undefined) } finally { await api.close() }
    }
  })
}

test('a real unattended locked lane ends on a tool dialog', { timeout: 120_000 }, async (t) => {
  if (!reported(t)) return
  const api = await scriptedApi(() => [{ name: 'mcp__ask__question', input: {} }])
  const lane = laneOnDisk(api.local, false)
  const { readFileSync } = await import('node:fs')
  writeFileSync(lane.paths.mcpPath, JSON.stringify({ mcpServers: { ask: { command: process.execPath, args: [join(repoRoot, 'test/fixtures/lane-dialog.mjs')] } } }))
  const settings = JSON.parse(readFileSync(lane.paths.settingsPath, 'utf8'))
  settings.permissions.allow.push('mcp__ask__question')
  writeFileSync(lane.paths.settingsPath, JSON.stringify(settings))
  try {
    const started = Date.now()
    const { exitBeforeStop, screen } = await runSupervised(lane, api, 25_000)
    assert.equal(exitBeforeStop, 88, screen)
    assert.ok(Date.now() - started < 20_000)
    assert.equal(readFileSync(join(lane.paths.laneDir, 'permission-pending'), 'utf8').trim().length > 0, true)
    t.diagnostic(`locked dialog ended after ${Date.now() - started} ms`)
  } finally { await api.close(); await lane.remove() }
})


const ownerInputs = [
  { label: 'no grant', grant: false, env: {} },
  { label: 'stored grant', grant: true, env: {} },
  { label: 'clean environment', grant: true, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } },
  { label: 'daemon claiming eligibility', grant: true, env: { HOAI_LANE_SHELL_CONTEXT: 'clean' } },
  { label: 'owner login', grant: true, env: { ANTHROPIC_API_KEY: 'made-up-owner-key' } },
  { label: 'unknown input', grant: true, env: { FUTURE_LOGIN: 'made-up-value' } },
]

for (const mode of ['inherit', 'own_token']) {
  for (const input of ownerInputs) {
    test(`real CLI owner tools refused: ${input.label}, ${mode}, fresh and resumed`, { timeout: 120_000 }, async (t) => {
      if (!reported(t)) return
      const api = await scriptedApi(() => [{ name: 'mcp__runner__run', input: { command: 'printf OWNER_RUNNER_MUST_NOT_RUN' } }])
      const lane = laneOnDisk(api.local, mode === 'own_token')
      const startedPath = join(lane.dir, 'runner-started')
      try {
        if (input.grant) {
          mkdirSync(join(lane.home, '.bgos-agent'), { recursive: true })
          writeFileSync(join(lane.home, '.bgos-agent/shell-host.json'), JSON.stringify({ v: 1, assistantId: '1076', userId: 'user_made_up', dedicatedAccount: true }))
        }
        const launch = await prepareLaneLaunch({
          o: { home: lane.home, assistantId: '1076', userId: 'user_made_up', ownerEnv: input.env, launchContext: 'clean', nodePath: process.execPath, pluginRoot: repoRoot },
          fs: await import('node:fs'), paths: lane.paths, platform: process.platform, login: { mode, configDir: lane.paths.configDir },
          launchFacts: async () => ({ policy: { v: 1, shell: input.grant, ownerMcpServers: input.grant }, read: true }),
          readClaudeJson: () => ({ mcpServers: { runner: { command: process.execPath, args: [join(repoRoot, 'test/fixtures/lane-owner-runner.mjs'), startedPath] } } }),
          log: () => {}, now: Date.now,
        } as never)
        // Keep every owner server the production builder emitted. The lane
        // daemon alone is omitted here; the launcher-chain cases exercise it.
        const { readFileSync } = await import('node:fs')
        const mcp = JSON.parse(readFileSync(lane.paths.mcpPath, 'utf8'))
        delete mcp.mcpServers.bgos
        writeFileSync(lane.paths.mcpPath, JSON.stringify(mcp))
        const pin = (await import('node:crypto')).randomUUID()
        lane.args = laneLaunchArgsFor({ mcpConfigPath: lane.paths.mcpPath, settingsPath: lane.paths.settingsPath, tools: launch.tools, sessionArgs: ['--session-id', pin] })
        const fresh = await runPrint(lane)
        assert.equal(fresh.exit, 0, fresh.output)
        assert.equal(api.results.length, 1, fresh.output)
        assert.equal(api.results[0]!.is_error, true, JSON.stringify(api.results))
        assert.equal(existsSync(startedPath), false, 'the owner server never starts')
        assert.equal(api.state.tools.includes('mcp__runner__run'), false)
        api.state.sent = 0
        api.state.epoch += 1
        lane.args = laneLaunchArgsFor({ mcpConfigPath: lane.paths.mcpPath, settingsPath: lane.paths.settingsPath, tools: launch.tools, sessionArgs: ['--resume', pin] })
        // Each resumed turn gets a distinct tool call id.
        const before = api.logins.length
        const resumed = await runPrint(lane)
        assert.equal(resumed.exit, 0, resumed.output)
        assert.ok(api.logins.length > before)
        assert.equal(api.results.length, 2, resumed.output)
        assert.equal(api.results[1]!.is_error, true, JSON.stringify(api.results))
        assert.equal(existsSync(startedPath), false, 'resume cannot start an owner server')
        assert.equal(api.state.tools.includes('mcp__runner__run'), false)
        assert.doesNotMatch(JSON.stringify(api.results), /OWNER_RUNNER_MUST_NOT_RUN/)
      } finally { await api.close(); await lane.remove() }
    })
  }
}

test('the made up owner server control really runs a command on the real CLI', { timeout: 120_000 }, async (t) => {
  if (!reported(t)) return
  const api = await scriptedApi(() => [{ name: 'mcp__runner__run', input: { command: 'printf OWNER_RUNNER_CONTROL' } }])
  const lane = laneOnDisk(api.local, false)
  try {
    writeFileSync(lane.paths.mcpPath, JSON.stringify({ mcpServers: { runner: { command: process.execPath, args: [join(repoRoot, 'test/fixtures/lane-owner-runner.mjs'), join(lane.dir, 'runner-started')] } } }))
    const { readFileSync } = await import('node:fs')
    const settings = JSON.parse(readFileSync(lane.paths.settingsPath, 'utf8'))
    settings.permissions.allow.push('mcp__runner')
    writeFileSync(lane.paths.settingsPath, JSON.stringify(settings))
    const result = await runPrint(lane)
    assert.equal(result.exit, 0, result.output)
    assert.equal(api.results.length, 1, result.output)
    assert.notEqual(api.results[0]!.is_error, true, JSON.stringify(api.results))
    assert.match(JSON.stringify(api.results[0]), /OWNER_RUNNER_CONTROL/)
    assert.equal(existsSync(join(lane.dir, 'runner-started')), true)
  } finally { await api.close(); await lane.remove() }
})
