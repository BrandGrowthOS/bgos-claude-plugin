/**
 * PERSON LANES, the share's tool policy at launch and a person's own model
 * and effort (shared agents Phase 3, P7 and P5; design 7.2, section 6,
 * decision K7; lib/lane-policy.mjs).
 *
 *   - ABSENT MEANS LOCKED: a missing, malformed or unknown version policy,
 *     and any option that is not literally true, launches the locked base.
 *   - DENY, per option: with an option off its tools, its allow rules and its
 *     folder are absent; on, exactly its own additions appear, nothing more.
 *     `browser` is never loaded (the relay refuses a lane credential).
 *   - readAgentFolder is refused for the home folder, any folder that holds
 *     or sits inside the agent state folders, a relative or missing folder.
 *   - ownerMcpServers never copies this channel's server, the browser shim,
 *     or a definition that carries the pairing.
 *   - A change: tighter beats looser, browser alone changes no launch.
 *   - K7: only models and effort levels on the owner's list, or `default`;
 *     a list narrowed later drops the pinned choice at the next start.
 *   - Restart requests: `now` beats `idle`, a fresh pin is never lost, idle
 *     waits for no turn in flight and a quiet minute.
 *
 * Run with: npx tsx --test test/lane-policy.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and the
// folder tests below use POSIX paths and symlinks, so the file is skipped there.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LANE_BUILTIN_TOOLS } from '../lib/lane-core.mjs'
import {
  agentFolderVerdict,
  laneAgentFolderSecretDenies,
  laneShellReadDenies,
  laneShellSandboxAvailable,
  LANE_SHELL_SANDBOX,
  compareToolPolicy,
  decideLaneRestart,
  effectiveLaneChoices,
  heartbeatToolPolicy,
  laneAllowAdditions,
  laneChoiceVerdict,
  laneDenyAdditions,
  laneMePolicy,
  laneToolsFor,
  LOCKED_TOOL_POLICY,
  mergeLaneRestartRequests,
  ownerMcpServersFrom,
  readLaneAllowedChoices,
  readLaneChoices,
  readLaneRestartRequest,
  readToolPolicy,
  TOOL_POLICY_OPTIONS,
} from '../lib/lane-policy.mjs'

const ALL_ON = { v: 1, webFetch: true, readAgentFolder: true, browser: true, shell: true, ownerMcpServers: true }
const ANA = { userId: 'user_ana', assistantId: '1076' }
const AGENT = '/Users/owner/agents/cho'

function only(option: string) {
  return { ...LOCKED_TOOL_POLICY, [option]: true }
}

test('absent means locked: missing, malformed, another version, or not literally true', () => {
  for (const raw of [undefined, null, 'webFetch', 7, [], {}, { ...ALL_ON, v: 0 }, { ...ALL_ON, v: 2 }, { ...ALL_ON, v: '1' }]) {
    assert.deepEqual(readToolPolicy(raw), { ...LOCKED_TOOL_POLICY }, `${JSON.stringify(raw)} must read as locked`)
  }
  assert.deepEqual(readToolPolicy({ v: 1, webFetch: 'true', shell: 1, browser: true }), { ...LOCKED_TOOL_POLICY, browser: true })
  assert.deepEqual(readToolPolicy({ v: 1 }), { ...LOCKED_TOOL_POLICY })
  assert.deepEqual(readToolPolicy(ALL_ON), ALL_ON)
  assert.deepEqual([...TOOL_POLICY_OPTIONS].sort(), ['browser', 'ownerMcpServers', 'readAgentFolder', 'shell', 'webFetch'])
})

test('the heartbeat answer: no policy key means keep the launch flags; a present one is read, absent means locked', () => {
  assert.equal(heartbeatToolPolicy({ ok: true }), null)
  assert.equal(heartbeatToolPolicy(null), null)
  assert.deepEqual(heartbeatToolPolicy({ ok: true, toolPolicy: null }), { ...LOCKED_TOOL_POLICY })
  assert.deepEqual(heartbeatToolPolicy({ ok: true, toolPolicy: { v: 1, shell: true } }), only('shell'))
})

test('lanes/me: the policy is read only from an answer naming exactly this lane', () => {
  const me = { pairingId: 1, assistantId: 1076, actorUserId: 'user_ana', lane: 'person:user_ana', agentName: 'Cho', toolPolicy: { v: 1, webFetch: true } }
  assert.deepEqual(laneMePolicy(me, ANA), only('webFetch'))
  assert.equal(laneMePolicy({ ...me, actorUserId: 'user_ben' }, ANA), null)
  assert.equal(laneMePolicy({ ...me, lane: 'person:user_ben' }, ANA), null)
  assert.equal(laneMePolicy({ ...me, assistantId: 9 }, ANA), null)
  assert.deepEqual(laneMePolicy({ ...me, toolPolicy: undefined }, ANA), { ...LOCKED_TOOL_POLICY })
})

test('DENY, the locked base: no web, no shell, no agent folder, no owner servers', () => {
  const locked = readToolPolicy(null)
  assert.deepEqual(laneToolsFor(locked, LANE_BUILTIN_TOOLS), ['Read', 'Edit', 'Write', 'Glob', 'Grep'])
  assert.deepEqual(laneAllowAdditions(locked, { agentFolder: AGENT, ownerServerNames: ['mail'], platform: 'darwin' }), [])
  assert.deepEqual(laneDenyAdditions(locked, { agentFolder: AGENT, platform: 'darwin' }), [])
})

test('DENY webFetch: off, WebFetch and WebSearch are absent; on, exactly they are added', () => {
  const off = { ...ALL_ON, webFetch: false }
  assert.ok(!laneToolsFor(off, LANE_BUILTIN_TOOLS).some((t: string) => /^Web/.test(t)))
  assert.ok(!laneAllowAdditions(off, { platform: 'darwin' }).some((r: string) => /^Web/.test(r)))
  assert.deepEqual(laneToolsFor(only('webFetch'), LANE_BUILTIN_TOOLS), [...LANE_BUILTIN_TOOLS, 'WebFetch', 'WebSearch'])
  assert.deepEqual(laneAllowAdditions(only('webFetch'), { platform: 'darwin' }), ['WebFetch', 'WebSearch'])
})

test('DENY shell: off, Bash is absent; on, exactly Bash is added', () => {
  const off = { ...ALL_ON, shell: false }
  assert.ok(!laneToolsFor(off, LANE_BUILTIN_TOOLS).includes('Bash'))
  assert.ok(!laneAllowAdditions(off, { platform: 'darwin' }).includes('Bash'))
  assert.deepEqual(laneToolsFor(only('shell'), LANE_BUILTIN_TOOLS), [...LANE_BUILTIN_TOOLS, 'Bash'])
  assert.deepEqual(laneAllowAdditions(only('shell'), { platform: 'darwin' }), ['Bash'])
})

test('DENY readAgentFolder: off, no rule names the agent folder; on, Read is allowed and Edit denied there', () => {
  const off = { ...ALL_ON, readAgentFolder: false }
  assert.ok(!laneAllowAdditions(off, { agentFolder: AGENT, platform: 'darwin' }).some((r: string) => r.includes(AGENT)))
  assert.deepEqual(laneDenyAdditions(off, { agentFolder: AGENT, platform: 'darwin' }), [])
  assert.deepEqual(laneAllowAdditions(only('readAgentFolder'), { agentFolder: AGENT, platform: 'darwin' }), [`Read(/${AGENT}/**)`])
  assert.deepEqual(laneDenyAdditions(only('readAgentFolder'), { agentFolder: AGENT, platform: 'darwin' }), [`Edit(/${AGENT}/**)`, ...laneAgentFolderSecretDenies(AGENT, 'darwin')])
  // On, but no folder passed the verdict: nothing.
  assert.deepEqual(laneAllowAdditions(only('readAgentFolder'), { agentFolder: null, platform: 'darwin' }), [])
  assert.deepEqual(laneToolsFor(only('readAgentFolder'), LANE_BUILTIN_TOOLS), [...LANE_BUILTIN_TOOLS], 'no new tool: Read already reads it')
})

test('readAgentFolder never opens the agent folder\'s credentials: MCP config, git, its Claude settings, .env, credentials (review H1)', () => {
  const denies = laneDenyAdditions(only('readAgentFolder'), { agentFolder: AGENT, platform: 'darwin' })
  for (const rule of [`Read(/${AGENT}/.mcp.json)`, `Read(/${AGENT}/**/.mcp.json)`, `Read(/${AGENT}/.git/**)`, `Read(/${AGENT}/.claude/**)`, `Read(/${AGENT}/**/.env*)`, `Read(/${AGENT}/**/credentials*.json)`]) {
    assert.ok(denies.includes(rule), `${rule} is denied`)
  }
  assert.deepEqual(laneAgentFolderSecretDenies(AGENT, 'darwin').every((r: string) => denies.includes(r)), true)
})

test('shell: the sandbox with unsandboxed commands OFF, and every secret, other lane and control file denied to it (review C1, H3)', () => {
  assert.deepEqual({ ...LANE_SHELL_SANDBOX }, { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false })
  const laneDir = '/Users/owner/.bgos-agent/1076/people/user_ana'
  const denies = laneShellReadDenies({ home: '/Users/owner', laneDir, otherLaneDirs: ['/Users/owner/.bgos-agent/1076/people/user_ben', '/Users/owner/.bgos-agent/900/people/user_cy'], agentFolder: AGENT, platform: 'darwin' })
  for (const rule of [
    'Read(//Users/owner/.ssh/**)', 'Read(//Users/owner/.claude/**)', 'Read(//Users/owner/.claude.json)', 'Read(//Users/owner/Library/Keychains/**)',
    'Read(//Users/owner/.bgos-plugin-state/**)', 'Read(//Users/owner/.bgos-agent/*.json)', 'Read(//Users/owner/.bgos-agent/**/credentials*.json)',
    'Read(//Users/owner/.bgos-agent/*/browser/**)',
    'Read(//Users/owner/.bgos-agent/1076/people/user_ben/**)', 'Read(//Users/owner/.bgos-agent/900/people/user_cy/**)',
    `Read(/${laneDir}/mcp.json)`, `Read(/${laneDir}/launch-policy.json)`, `Read(/${laneDir}/restart-request.json)`, `Read(/${laneDir}/events.jsonl)`,
    `Read(/${AGENT}/.mcp.json)`,
  ]) assert.ok(denies.includes(rule), `${rule} is denied`)
  assert.ok(!denies.some((r: string) => r.includes(`${laneDir}/work`)), 'never the lane\'s own working folder')
  for (const rule of ['Read(//Users/owner/**/.env*)', 'Read(//Users/owner/**/.mcp.json)', 'Read(//Users/owner/**/credentials*.json)', 'Read(//Users/owner/.bgos-agent/logs/**)', 'Read(//Users/owner/.bgos-agent/**/*.log)']) {
    assert.ok(denies.includes(rule), `${rule} is denied (round 2, N3 and N4)`)
  }
})

test('the Bash sandbox exists only where the operating system provides it (round 2, N1)', () => {
  assert.equal(laneShellSandboxAvailable({ platform: 'darwin', exists: (p: string) => p === '/usr/bin/sandbox-exec', onPath: () => false }), true)
  assert.equal(laneShellSandboxAvailable({ platform: 'darwin', exists: () => false, onPath: () => true }), false)
  assert.equal(laneShellSandboxAvailable({ platform: 'linux', exists: () => true, onPath: (n: string) => n === 'bwrap' || n === 'socat' }), true)
  assert.equal(laneShellSandboxAvailable({ platform: 'linux', exists: () => true, onPath: (n: string) => n === 'bwrap' }), false)
  assert.equal(laneShellSandboxAvailable({ platform: 'win32', exists: () => true, onPath: () => true }), false)
})

test('DENY ownerMcpServers: off, no owner server is allowed; on, each loaded server by name and nothing else', () => {
  const off = { ...ALL_ON, ownerMcpServers: false }
  assert.ok(!laneAllowAdditions(off, { ownerServerNames: ['mail', 'drive'], platform: 'darwin' }).some((r: string) => r.startsWith('mcp__')))
  assert.deepEqual(laneAllowAdditions(only('ownerMcpServers'), { ownerServerNames: ['mail', 'drive'], platform: 'darwin' }), ['mcp__mail', 'mcp__drive'])
})

test('DENY browser: never loaded and never allowed, whatever the policy says', () => {
  for (const policy of [only('browser'), ALL_ON]) {
    const extras = [...laneToolsFor(policy, LANE_BUILTIN_TOOLS), ...laneAllowAdditions(policy, { agentFolder: AGENT, ownerServerNames: ['mail'], platform: 'darwin' })]
    assert.ok(!extras.some((t: string) => /browser/i.test(t)), 'no browser tool or rule')
  }
  assert.equal(compareToolPolicy(LOCKED_TOOL_POLICY, only('browser')), 'same', 'browser alone changes no launch')
})

test('a change: tighter when anything launched is now off (even if another came on), looser when only additions', () => {
  assert.equal(compareToolPolicy(only('shell'), LOCKED_TOOL_POLICY), 'tighter')
  assert.equal(compareToolPolicy(only('shell'), only('webFetch')), 'tighter')
  assert.equal(compareToolPolicy(LOCKED_TOOL_POLICY, only('webFetch')), 'looser')
  assert.equal(compareToolPolicy(only('webFetch'), { ...only('webFetch'), shell: true }), 'looser')
  assert.equal(compareToolPolicy(ALL_ON, ALL_ON), 'same')
  assert.equal(compareToolPolicy(null, null), 'same')
  assert.equal(compareToolPolicy(ALL_ON, { v: 2 }), 'tighter', 'an unknown version reads locked: tighter')
})

test('readAgentFolder is refused for home, for a folder holding the agent state folders, or inside them', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-folder-')))
  try {
    const home = join(root, 'home')
    const agentState = join(home, '.bgos-agent')
    const pluginState = join(home, '.bgos-plugin-state')
    const project = join(home, 'agents', 'cho')
    for (const d of [agentState, join(agentState, '1076', 'people', 'user_ben'), pluginState, project]) mkdirSync(d, { recursive: true })
    symlinkSync(home, join(root, 'home-link'))
    symlinkSync(join(agentState, '1076'), join(project, 'state-link'))
    const deps = { home, stateRoots: [agentState, pluginState], realpath: realpathSync, platform: 'darwin' }
    assert.deepEqual(agentFolderVerdict(project, deps), { ok: true, path: project })
    assert.equal(agentFolderVerdict(home, deps).ok, false, 'home')
    assert.equal(agentFolderVerdict(join(root, 'home-link'), deps).ok, false, 'home through a link')
    assert.equal(agentFolderVerdict(root, deps).ok, false, 'above home')
    // Home is refused on its own rule, wherever the state folders live.
    const elsewhere = join(root, 'state-elsewhere')
    mkdirSync(elsewhere)
    assert.equal((agentFolderVerdict(home, { ...deps, stateRoots: [elsewhere] }) as { reason?: string }).reason, 'home_or_above')
    assert.equal((agentFolderVerdict(root, { ...deps, stateRoots: [elsewhere] }) as { reason?: string }).reason, 'home_or_above')
    assert.equal(agentFolderVerdict('/', deps).ok, false, 'the root')
    assert.equal(agentFolderVerdict(join(agentState, '1076'), deps).ok, false, 'inside .bgos-agent (other lanes)')
    assert.equal(agentFolderVerdict(join(project, 'state-link'), deps).ok, false, 'a link into .bgos-agent')
    assert.equal(agentFolderVerdict(pluginState, deps).ok, false, 'the plugin state folder')
    assert.equal((agentFolderVerdict('agents/cho', deps) as { reason?: string }).reason, 'not_absolute')
    assert.equal((agentFolderVerdict(join(home, 'gone'), deps) as { reason?: string }).reason, 'missing')
    assert.equal((agentFolderVerdict(`${project})`, deps) as { reason?: string }).reason, 'unsafe_characters')
    assert.equal((agentFolderVerdict(null, deps) as { reason?: string }).reason, 'none')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ownerMcpServers: user and local scope, never this channel, the browser shim, or a definition carrying the pairing', () => {
  const claudeJson = {
    mcpServers: {
      mail: { command: 'npx', args: ['mail-mcp'], env: { MAIL_TOKEN: 'x' } },
      bgos: { command: 'bun', args: ['server.ts'] },
      'hoai-browser': { command: 'node', args: ['hoai-browser-mcp.mjs'] },
      sneaky: { command: 'bun', args: ['/p/claude-channel-bgos/server.ts'] },
      creds: { command: 'node', args: ['x.js'], env: { BGOS_PAIRING_TOKEN: 'p' } },
      'bad name': { command: 'x' },
      noshape: { foo: 1 },
      web: { type: 'http', url: 'https://mcp.example/x' },
    },
    projects: { [AGENT]: { mcpServers: { drive: { command: 'drive-mcp' }, mail: { command: 'mail-local' } } } },
  }
  const found = ownerMcpServersFrom(claudeJson, { agentFolder: AGENT })
  assert.deepEqual(Object.keys(found.servers).sort(), ['drive', 'mail', 'web'])
  assert.deepEqual((found.servers.mail as { command: string }).command, 'mail-local', 'the local scope wins')
  assert.deepEqual(found.skipped.sort(), ['bad name', 'bgos', 'creds', 'hoai-browser', 'noshape', 'sneaky'])
  assert.deepEqual(ownerMcpServersFrom(null).servers, {})
  assert.deepEqual(Object.keys(ownerMcpServersFrom(claudeJson).servers).sort(), ['mail', 'web'], 'no agent folder: user scope only')
})

test('K7: only models and effort levels on the owner\'s list, or default; no list allows nothing but default', () => {
  const allowed = readLaneAllowedChoices(JSON.stringify({ models: ['sonnet', 'opus[1m]', 'bad;rm'], efforts: ['low', 'high', 'turbo'] }))
  assert.deepEqual(allowed, { models: ['sonnet', 'opus[1m]'], efforts: ['low', 'high'] })
  assert.deepEqual(laneChoiceVerdict({ kind: 'model', value: 'sonnet', allowed }), { ok: true, value: 'sonnet' })
  assert.deepEqual(laneChoiceVerdict({ kind: 'model', value: 'opus[1m]', allowed }), { ok: true, value: 'opus[1m]' })
  assert.deepEqual(laneChoiceVerdict({ kind: 'model', value: 'haiku', allowed }), { ok: false, reason: 'not_allowed' })
  assert.deepEqual(laneChoiceVerdict({ kind: 'model', value: 'Sonnet', allowed }), { ok: false, reason: 'not_allowed' })
  assert.deepEqual(laneChoiceVerdict({ kind: 'model', value: 'default', allowed }), { ok: true, value: null })
  assert.deepEqual(laneChoiceVerdict({ kind: 'effort', value: 'high', allowed }), { ok: true, value: 'high' })
  assert.deepEqual(laneChoiceVerdict({ kind: 'effort', value: 'max', allowed }), { ok: false, reason: 'not_allowed' })
  assert.deepEqual(laneChoiceVerdict({ kind: 'effort', value: 'sonnet', allowed }), { ok: false, reason: 'not_allowed' })
  assert.deepEqual(laneChoiceVerdict({ kind: 'model', value: '  ', allowed }), { ok: false, reason: 'empty' })
  const none = readLaneAllowedChoices('')
  assert.deepEqual(none, { models: [], efforts: [] })
  assert.deepEqual(laneChoiceVerdict({ kind: 'model', value: 'sonnet', allowed: none }), { ok: false, reason: 'not_allowed' })
  assert.deepEqual(laneChoiceVerdict({ kind: 'model', value: 'default', allowed: none }), { ok: true, value: null })
})

test('K7: a pinned choice the owner later took off the list is not launched', () => {
  const choices = readLaneChoices(JSON.stringify({ model: 'opus', effort: 'high', chatId: '5' }))
  assert.deepEqual(choices, { model: 'opus', effort: 'high', chatId: '5' })
  assert.deepEqual(effectiveLaneChoices(choices, { models: ['opus'], efforts: ['high'] }), { model: 'opus', effort: 'high' })
  assert.deepEqual(effectiveLaneChoices(choices, { models: ['sonnet'], efforts: [] }), { model: null, effort: null })
  assert.deepEqual(readLaneChoices(JSON.stringify({ model: 'x y', effort: 'warp', chatId: 'abc' })), { model: null, effort: null, chatId: null })
})

test('restart requests: now beats idle, a fresh pin is never lost, unknown reasons are dropped', () => {
  assert.equal(readLaneRestartRequest('nope'), null)
  assert.equal(readLaneRestartRequest(JSON.stringify({ reasons: ['reboot'], when: 'now' })), null)
  const fresh = readLaneRestartRequest(JSON.stringify({ reasons: ['new'], when: 'now', fresh: true, chatId: '5' }))
  assert.deepEqual(fresh, { reasons: ['new'], when: 'now', fresh: true, chatId: '5' })
  const idle = { reasons: ['policy_loosened'], when: 'idle' as const, fresh: false, chatId: null }
  assert.deepEqual(mergeLaneRestartRequests(fresh, idle), { reasons: ['new', 'policy_loosened'], when: 'now', fresh: true, chatId: '5' })
  assert.deepEqual(mergeLaneRestartRequests(idle, fresh), { reasons: ['policy_loosened', 'new'], when: 'now', fresh: true, chatId: '5' })
  assert.deepEqual(mergeLaneRestartRequests(null, idle), idle)
})

test('restart timing: now at once; idle only with no turn in flight and a quiet minute', () => {
  const now = { reasons: ['policy_tightened'], when: 'now' as const, fresh: false, chatId: null }
  const idle = { reasons: ['policy_loosened'], when: 'idle' as const, fresh: false, chatId: null }
  const t = 1_000_000
  assert.equal(decideLaneRestart({ request: now, inFlight: true, lastActivityAtMs: t, startedAtMs: 0, nowMs: t }), 'now')
  assert.equal(decideLaneRestart({ request: idle, inFlight: true, lastActivityAtMs: t - 600_000, startedAtMs: 0, nowMs: t }), 'wait')
  assert.equal(decideLaneRestart({ request: idle, inFlight: false, lastActivityAtMs: t - 30_000, startedAtMs: 0, nowMs: t }), 'wait')
  assert.equal(decideLaneRestart({ request: idle, inFlight: false, lastActivityAtMs: t - 60_000, startedAtMs: 0, nowMs: t }), 'now')
  assert.equal(decideLaneRestart({ request: idle, inFlight: false, lastActivityAtMs: null, startedAtMs: t - 10_000, nowMs: t }), 'wait')
  assert.equal(decideLaneRestart({ request: null, inFlight: false, lastActivityAtMs: null, startedAtMs: 0, nowMs: t }), 'wait')
})
