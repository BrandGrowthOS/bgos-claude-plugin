/**
 * PERSON LANES, the locked launch (shared agents Phase 3, P3; design 4.2,
 * 4.3 and 7.2, spikes S2 and S1).
 *
 * A recipient's lane runs on the OWNER's computer, so its launch is the
 * lock: these tests hold every part of it.
 *   - The lane builder NEVER emits --dangerously-skip-permissions (or any
 *     flag that widens the lane) and ALWAYS emits the locked flags, the
 *     built in tool list written out in full and the channel in server form.
 *   - The allow list always names `reply` (a lane whose reply is refused
 *     goes silent) and only Read and Edit rules on the working folder (the
 *     only file rule forms the CLI matches, spike S2).
 *   - Remote Control is off (S2 finding 2), AskUserQuestion is denied, the
 *     lane floor hook runs on every tool with the lane's person.
 *   - The MCP config is the lane server alone, named `bgos`.
 *   - The environment is an allow list: none of the owner's tmux names,
 *     project dir, supervision variables or BGOS secrets reach the lane.
 *   - K2 option (a): every login variable passes through only if the owner
 *     had it, byte for byte; CLAUDE_CONFIG_DIR is never invented.
 *   - K2 option (b): the lane's own config folder and token, and none of the
 *     owner's login variables.
 *   - Tool search is off in every lane (0.71.1): ToolSearch is not in its
 *     --tools, so a tool the CLI deferred could never be loaded.
 *
 * Run with: npx tsx --test test/lane-launch.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  laneAllowList,
  laneChildEnv,
  laneLaunchArgsFor,
  laneMcpConfigBody,
  lanePaths,
  laneSessionArgs,
  laneSettingsBody,
  LANE_BUILTIN_TOOLS,
  LANE_CLAUDE_FIXED_ENV,
  LANE_FORBIDDEN_FLAGS,
  LANE_LOGIN_ENV,
} from '../lib/lane-core.mjs'

const HOME = '/Users/owner'
const PATHS = lanePaths({ home: HOME, assistantId: '1076', userId: 'user_ana', platform: 'darwin' })
const PIN = '0b9c6d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'

function argsFor(sessionArgs: string[]) {
  return laneLaunchArgsFor({ mcpConfigPath: PATHS.mcpPath, settingsPath: PATHS.settingsPath, sessionArgs })
}

test('the lane builder never emits a flag that widens the lane, on either session form', () => {
  for (const session of [laneSessionArgs(PIN, false), laneSessionArgs(PIN, true)]) {
    const args = argsFor(session)
    for (const flag of LANE_FORBIDDEN_FLAGS) assert.ok(!args.includes(flag), `${flag} must never reach a lane`)
    assert.ok(!args.some((a) => /skip-permissions|bypass/i.test(a)))
  }
})

test('the lane builder always emits the locked flags in the measured shape', () => {
  const args = argsFor(laneSessionArgs(PIN, false))
  assert.deepEqual(args.slice(0, 2), ['--restricted', '--strict-mcp-config'])
  const after = (flag: string) => args[args.indexOf(flag) + 1]
  assert.equal(after('--mcp-config'), PATHS.mcpPath)
  assert.equal(after('--settings'), PATHS.settingsPath)
  assert.equal(after('--permission-mode'), 'dontAsk')
  // Written out in full, never "add to": WebSearch and WebFetch stay absent.
  assert.equal(after('--tools'), 'Read,Edit,Write,Glob,Grep')
  assert.deepEqual([...LANE_BUILTIN_TOOLS], ['Read', 'Edit', 'Write', 'Glob', 'Grep'])
  assert.ok(!after('--tools').includes('WebSearch') && !after('--tools').includes('Bash'))
  assert.equal(after('--dangerously-load-development-channels'), 'server:bgos')
  assert.deepEqual(args.slice(-2), ['--session-id', PIN])
})

test('the debug file rides only when asked for (the person\'s own sign in), never displacing a locked flag', () => {
  const plain = argsFor(laneSessionArgs(PIN, false))
  assert.ok(!plain.includes('--debug-file'))
  const withDebug = laneLaunchArgsFor({ mcpConfigPath: PATHS.mcpPath, settingsPath: PATHS.settingsPath, sessionArgs: laneSessionArgs(PIN, true), debugFile: PATHS.claudeDebugPath })
  assert.deepEqual(withDebug.filter((a) => a !== '--debug-file' && a !== PATHS.claudeDebugPath), argsFor(laneSessionArgs(PIN, true)))
  assert.equal(withDebug[withDebug.indexOf('--debug-file') + 1], '/Users/owner/.bgos-agent/1076/people/user_ana/claude-debug.log')
})

test('the session pin: --resume when the transcript exists, --session-id when not, never --continue', () => {
  assert.deepEqual(laneSessionArgs(PIN, true), ['--resume', PIN])
  assert.deepEqual(laneSessionArgs(PIN, false), ['--session-id', PIN])
  assert.throws(() => laneSessionArgs('not-a-uuid', true))
  assert.throws(() => argsFor(['--dangerously-skip-permissions']), /forbidden/)
  assert.throws(() => argsFor(['--continue']), /forbidden/)
})

test('the allow list always names reply, and only Read and Edit rules on the working folder', () => {
  const allow = laneAllowList(PATHS.workDir, 'darwin')
  assert.ok(allow.includes('mcp__bgos__reply'))
  assert.deepEqual(allow, [
    'mcp__bgos__reply',
    `Read(//Users/owner/.bgos-agent/1076/people/user_ana/work/**)`,
    `Edit(//Users/owner/.bgos-agent/1076/people/user_ana/work/**)`,
  ])
  // Windows spells C:\x as //c/x in a rule.
  assert.equal(laneAllowList('C:\\Users\\o\\work', 'win32')[1], 'Read(//c/Users/o/work/**)')
})

test('the settings: Remote Control off, AskUserQuestion denied, the lane floor hook on every tool', () => {
  const body = laneSettingsBody({ workDir: PATHS.workDir, userId: 'user_ana', nodePath: '/usr/local/bin/node', floorHookPath: '/p/bin/hoai-lane-floor-hook.mjs', platform: 'darwin' })
  assert.equal(body.remoteControlAtStartup, false)
  assert.deepEqual(body.permissions.deny, ['AskUserQuestion'])
  assert.deepEqual(body.permissions.allow, laneAllowList(PATHS.workDir, 'darwin'))
  const hook = body.hooks.PreToolUse[0]
  assert.equal(hook.matcher, '*')
  assert.equal(hook.hooks[0].command, "'/usr/local/bin/node' '/p/bin/hoai-lane-floor-hook.mjs' --lane user_ana")
  // Single quoted shell words: nothing inside expands, a quote in a path is escaped.
  const odd = laneSettingsBody({ workDir: PATHS.workDir, userId: 'user_ana', nodePath: "/opt/my $node`x`/no'de", floorHookPath: '/p/h.mjs', platform: 'darwin' })
  assert.equal(odd.hooks.PreToolUse[0].hooks[0].command, "'/opt/my $node`x`/no'\\''de' '/p/h.mjs' --lane user_ana")
  assert.throws(() => laneSettingsBody({ workDir: PATHS.workDir, userId: 'a b; rm -rf ~', nodePath: 'node', floorHookPath: 'h' }))
})

test('the MCP config is the lane server alone, under the name bgos', () => {
  const body = laneMcpConfigBody({ nodePath: '/n', pluginRoot: '/plugin', env: { BGOS_LANE_USER_ID: 'user_ana' }, platform: 'darwin' })
  assert.deepEqual(Object.keys(body.mcpServers), ['bgos'])
  assert.deepEqual(body.mcpServers.bgos.args, ['/plugin/bin/bgos-launch.mjs', '/plugin/lane-server.ts'])
  assert.ok(!JSON.stringify(body).includes('hoai-browser'))
})

const OWNER_ENV = {
  PATH: '/usr/bin:/bin',
  HOME,
  USER: 'owner',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TMPDIR: '/var/tmp/',
  BGOS_TMUX_SESSION: 'hoai-1076-home-x',
  BGOS_TMUX_SOCKET: 'hoai-1076-home-x',
  TMUX: '/tmp/tmux-501/default,1,0',
  TMUX_PANE: '%3',
  CLAUDE_PROJECT_DIR: '/Users/owner/agent',
  HOAI_SUPERVISED: '1',
  HOAI_SUPERVISED_ASSISTANT_ID: '1076',
  BGOS_PAIRING_TOKEN: 'pt_secret',
  BGOS_API_KEY: 'sk_secret',
  BGOS_CREDENTIALS_PATH: '/Users/owner/.bgos-agent/credentials-1076.json',
  GITHUB_TOKEN: 'ghp_secret',
  BGOS_AUTO_APPROVE: 'true',
  CLAUDECODE: '1',
}

function envFor(ownerEnv: Record<string, string>, login: { mode: 'inherit' } | { mode: 'own_token'; token: string; configDir: string }) {
  return laneChildEnv({
    ownerEnv,
    platform: 'darwin',
    login,
    assistantId: '1076',
    userId: 'user_ana',
    workDir: PATHS.workDir,
    laneDir: PATHS.laneDir,
    stateDir: PATHS.stateDir,
    backendUrl: 'http://127.0.0.1:8971/api/v1',
  })
}

test('the lane environment is an allow list: no tmux names, project dir, supervision or secrets', () => {
  const env = envFor(OWNER_ENV, { mode: 'inherit' })
  for (const name of ['BGOS_TMUX_SESSION', 'BGOS_TMUX_SOCKET', 'TMUX', 'TMUX_PANE', 'CLAUDE_PROJECT_DIR', 'HOAI_SUPERVISED', 'HOAI_SUPERVISED_ASSISTANT_ID', 'BGOS_PAIRING_TOKEN', 'BGOS_API_KEY', 'BGOS_CREDENTIALS_PATH', 'GITHUB_TOKEN', 'CLAUDECODE']) {
    assert.equal(env[name], undefined, `${name} must not reach a lane`)
  }
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.HOME, HOME)
  assert.equal(env.LC_ALL, 'en_US.UTF-8')
  // The lane's own variables, and the relay never auto approves in a lane.
  assert.equal(env.BGOS_AUTO_APPROVE, 'false')
  assert.equal(env.BGOS_LANE_USER_ID, 'user_ana')
  assert.equal(env.BGOS_ASSISTANT_ID, '1076')
  assert.equal(env.BGOS_LAUNCH_CWD, PATHS.workDir)
  assert.equal(env.BGOS_BACKEND_URL, 'http://127.0.0.1:8971/api/v1')
})

test('K2 (a), inherit: CLAUDE_CONFIG_DIR is NOT set when the owner had none', () => {
  const env = envFor(OWNER_ENV, { mode: 'inherit' })
  assert.equal('CLAUDE_CONFIG_DIR' in env, false)
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false)
  assert.equal(env.HOAI_LANE_LOGIN_MODE, 'inherit')
})

test('K2 (a), inherit: every login variable the owner had passes through byte for byte', () => {
  const owner = { ...OWNER_ENV, CLAUDE_CONFIG_DIR: '/Users/owner/.claude-work ', ANTHROPIC_BASE_URL: 'https://proxy.example/x' }
  const env = envFor(owner, { mode: 'inherit' })
  assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/owner/.claude-work ', 'not trimmed, not resolved: byte for byte')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://proxy.example/x')
  assert.deepEqual([...LANE_LOGIN_ENV].sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'].sort())
})

test('K2 (b), own token: the lane\'s own config folder and token, never the owner\'s login', () => {
  const owner = { ...OWNER_ENV, CLAUDE_CONFIG_DIR: '/Users/owner/.claude-work', CLAUDE_CODE_OAUTH_TOKEN: 'owner-token', ANTHROPIC_API_KEY: 'owner-key', ANTHROPIC_AUTH_TOKEN: 'owner-auth' }
  const env = envFor(owner, { mode: 'own_token', token: 'sk-ant-oat01-standin-person-token', configDir: PATHS.configDir })
  assert.equal(env.CLAUDE_CONFIG_DIR, PATHS.configDir)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-standin-person-token')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.ok(!Object.values(env).includes('owner-token'))
  assert.equal(env.HOAI_LANE_LOGIN_MODE, 'own_token')
  assert.throws(() => envFor(owner, { mode: 'own_token', token: '', configDir: PATHS.configDir }), /without a token/)
  assert.throws(() => envFor(owner, { mode: 'bogus' } as never), /unknown login mode/)
})

test('tool search is off in every lane, whatever the owner exported, under either login (0.71.1)', () => {
  // ToolSearch is not in a lane's --tools, so a tool the CLI deferred could
  // never be loaded; off, a tool that arrives late is sent in full next turn.
  const logins = [{ mode: 'inherit' as const }, { mode: 'own_token' as const, token: 'sk-ant-oat01-standin-person-token', configDir: PATHS.configDir }]
  for (const login of logins) {
    assert.equal(envFor(OWNER_ENV, login).ENABLE_TOOL_SEARCH, 'false')
    assert.equal(envFor({ ...OWNER_ENV, ENABLE_TOOL_SEARCH: 'true' }, login).ENABLE_TOOL_SEARCH, 'false', 'the owner\'s own setting never reaches a lane')
  }
  assert.deepEqual(LANE_CLAUDE_FIXED_ENV, { ENABLE_TOOL_SEARCH: 'false' }, 'the one fixed variable, and nothing that widens the lane')
})

test('lane folders: the floor\'s own-lane key, secrets in the plugin state folder, unsafe ids refused', () => {
  assert.equal(PATHS.laneDir, '/Users/owner/.bgos-agent/1076/people/user_ana')
  assert.equal(PATHS.workDir, '/Users/owner/.bgos-agent/1076/people/user_ana/work')
  assert.equal(PATHS.ticketPath, '/Users/owner/.bgos-plugin-state/1076/lanes/user_ana/ticket.json')
  assert.equal(PATHS.sessionPath, '/Users/owner/.bgos-plugin-state/1076/lanes/user_ana/session.json')
  assert.equal(PATHS.configDir, '/Users/owner/.bgos-agent/1076/people/user_ana/claude-config')
  for (const bad of ['../user_ben', 'a/b', '', 'user ana', '..', 'x'.repeat(129)]) {
    assert.throws(() => lanePaths({ home: HOME, assistantId: '1076', userId: bad }), /unsafe/)
  }
  assert.throws(() => lanePaths({ home: HOME, assistantId: '../1', userId: 'user_ana' }), /unsafe/)
})
