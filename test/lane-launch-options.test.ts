/**
 * PERSON LANES, the launch a share's policy and a person's own choices build
 * (shared agents Phase 3, P5 and P7; design 7.2, section 6; lib/lane-core.mjs).
 *
 *   - The tool list is the policy's, written out in full, and never more than
 *     the locked base plus WebFetch, WebSearch and Bash: an unknown tool, or a
 *     list that lost a base tool, is refused by the builder itself.
 *   - `--model` and `--effort` ride only when set, only with a safe model
 *     name and a known effort level, and never displace a locked flag or the
 *     session args (still last).
 *   - `--append-system-prompt-file` carries the lane's memory index (P5).
 *   - readAgentFolder NEVER reaches the command line as `--add-dir` (it would
 *     make findAgentClaudePids take the lane for the owner, spike S5): the
 *     settings file lists it in `additionalDirectories`, with Read allowed
 *     and Edit denied, after the locked base's own rules.
 *   - The owner's MCP servers join the lane's mcp.json, but none of them can
 *     take the name `bgos`, and the browser shim never loads.
 *
 * Run with: npx tsx --test test/lane-launch-options.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  laneAllowList,
  laneLaunchArgsFor,
  laneMcpConfigBody,
  lanePaths,
  laneSessionArgs,
  laneSettingsBody,
  LANE_BUILTIN_TOOLS,
  LANE_FORBIDDEN_FLAGS,
} from '../lib/lane-core.mjs'
import { laneAllowAdditions, laneDenyAdditions, laneToolsFor } from '../lib/lane-policy.mjs'

const HOME = '/Users/owner'
const PATHS = lanePaths({ home: HOME, assistantId: '1076', userId: 'user_ana', platform: 'darwin' })
const PIN = '0b9c6d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
const AGENT = '/Users/owner/agents/cho'
const ALL_ON = { v: 1, webFetch: true, readAgentFolder: true, browser: true, shell: true, ownerMcpServers: true }

function args(extra: Record<string, unknown> = {}) {
  return laneLaunchArgsFor({ mcpConfigPath: PATHS.mcpPath, settingsPath: PATHS.settingsPath, sessionArgs: laneSessionArgs(PIN, false), ...extra })
}
const after = (list: string[], flag: string) => list[list.indexOf(flag) + 1]

test('the lane paths of P5 and P7: memory inside work/, controls and markers outside it', () => {
  assert.equal(PATHS.memoryDir, `${PATHS.workDir}/memory`)
  for (const key of ['choicesPath', 'restartRequestPath', 'launchPolicyPath', 'systemPromptPath', 'memoryRpcDir'] as const) {
    assert.ok(PATHS[key].startsWith(`${PATHS.laneDir}/`), `${key} is in the lane folder`)
    assert.ok(!PATHS[key].startsWith(`${PATHS.workDir}/`), `${key} is out of the model's reach`)
  }
  assert.equal(PATHS.memoryTrashDir, `${PATHS.stateDir}/memory-trash`)
  assert.equal(PATHS.allowedChoicesPath, `${PATHS.peopleDir}/lane-models.json`)
})

test('the tool list is the policy\'s, in full, and the builder refuses anything past the options', () => {
  assert.equal(after(args(), '--tools'), 'Read,Edit,Write,Glob,Grep', 'no policy: the locked base')
  assert.equal(after(args({ tools: laneToolsFor(ALL_ON, LANE_BUILTIN_TOOLS) }), '--tools'), 'Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Bash')
  assert.throws(() => args({ tools: [...LANE_BUILTIN_TOOLS, 'Task'] }), /not a lane tool/)
  assert.throws(() => args({ tools: [...LANE_BUILTIN_TOOLS, 'PowerShell'] }), /not a lane tool/)
  assert.throws(() => args({ tools: ['Read', 'Write', 'Glob', 'Grep', 'Bash'] }), /lost Edit/)
})

test('model, effort and the system prompt file ride only when set, before the session args', () => {
  const plain = args()
  for (const flag of ['--model', '--effort', '--append-system-prompt-file']) assert.ok(!plain.includes(flag), `${flag} only when set`)
  const full = args({ model: 'opus[1m]', effort: 'high', systemPromptFile: PATHS.systemPromptPath })
  assert.equal(after(full, '--model'), 'opus[1m]')
  assert.equal(after(full, '--effort'), 'high')
  assert.equal(after(full, '--append-system-prompt-file'), PATHS.systemPromptPath)
  assert.deepEqual(full.slice(-2), ['--session-id', PIN])
  assert.deepEqual(full.slice(0, 2), ['--restricted', '--strict-mcp-config'])
  assert.equal(after(full, '--permission-mode'), 'dontAsk')
  for (const flag of LANE_FORBIDDEN_FLAGS) assert.ok(!full.includes(flag))
  assert.throws(() => args({ model: 'sonnet --dangerously-skip-permissions' }), /unsafe model/)
  assert.throws(() => args({ model: 'a{b}' }), /unsafe model/)
  assert.throws(() => args({ effort: 'ludicrous' }), /unknown effort/)
})

test('readAgentFolder never reaches the command line: the settings list it, Read allowed, Edit denied', () => {
  const launched = args({ tools: laneToolsFor(ALL_ON, LANE_BUILTIN_TOOLS), model: 'sonnet', systemPromptFile: PATHS.systemPromptPath })
  assert.ok(!launched.includes('--add-dir'))
  assert.ok(!launched.some((a) => a.includes(AGENT)), 'the agent folder is in no argument')
  const body = laneSettingsBody({
    workDir: PATHS.workDir,
    userId: 'user_ana',
    nodePath: '/n',
    floorHookPath: '/h',
    platform: 'darwin',
    allowExtra: laneAllowAdditions(ALL_ON, { agentFolder: AGENT, ownerServerNames: ['mail'], platform: 'darwin' }),
    denyExtra: laneDenyAdditions(ALL_ON, { agentFolder: AGENT, platform: 'darwin' }),
    additionalDirectories: [AGENT],
  })
  assert.deepEqual(body.permissions.allow.slice(0, 3), laneAllowList(PATHS.workDir, 'darwin'), 'the locked base comes first')
  assert.ok(body.permissions.allow.includes(`Read(/${AGENT}/**)`))
  assert.deepEqual(body.permissions.deny.slice(0, 2), ['AskUserQuestion', `Edit(/${AGENT}/**)`])
  assert.ok(body.permissions.deny.includes(`Read(/${AGENT}/.mcp.json)`), 'and the folder\'s credentials stay closed')
  assert.deepEqual(body.permissions.additionalDirectories, [AGENT])
  assert.equal(body.remoteControlAtStartup, false)
})

test('the locked settings carry no extra rule and no additional folder', () => {
  const body = laneSettingsBody({ workDir: PATHS.workDir, userId: 'user_ana', nodePath: '/n', floorHookPath: '/h', platform: 'darwin' })
  assert.deepEqual(body.permissions.allow, laneAllowList(PATHS.workDir, 'darwin'))
  assert.deepEqual(body.permissions.deny, ['AskUserQuestion'])
  assert.equal('additionalDirectories' in body.permissions, false)
})

test('the owner\'s MCP servers join the lane config, but never as bgos and never the browser shim', () => {
  const body = laneMcpConfigBody({
    nodePath: '/n',
    pluginRoot: '/plugin',
    env: { BGOS_LANE_USER_ID: 'user_ana' },
    platform: 'darwin',
    extraServers: { mail: { command: 'mail-mcp' }, bgos: { command: 'evil' }, 'hoai-browser': { command: 'shim' } },
  })
  assert.deepEqual(Object.keys(body.mcpServers).sort(), ['bgos', 'mail'])
  assert.deepEqual(body.mcpServers.bgos.args, ['/plugin/bin/bgos-launch.mjs', '/plugin/lane-server.ts'], 'the lane server keeps its name')
  assert.deepEqual(Object.keys(laneMcpConfigBody({ nodePath: '/n', pluginRoot: '/plugin', env: {}, platform: 'darwin' }).mcpServers), ['bgos'])
})
