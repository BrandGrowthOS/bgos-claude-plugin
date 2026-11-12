/**
 * An owner's thread is a true fork with the agent's full access; a share
 * recipient's thread keeps the confinement it had (0.88.0).
 *
 * The split is one function (threadAccess) fed by who opened the thread
 * (threadOpener, read from the frame's own lane stamp) and the owner's
 * setting `threads.fullAccess`. Everything here runs on fakes; the same
 * commands are run against the real CLI in test/thread-full-fork.cli.test.ts.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'

import * as laneArgs from '../lib/thread-lane-args.ts'
import * as threadRpc from '../lib/thread-rpc.ts'
import * as streamChild from '../lib/stream-json-child.ts'
import * as access from '../lib/thread-access.ts'
import { THREAD_LANE_ENV } from '../lib/thread-lane-marker.mjs'
import { normalizeVoiceRpc } from '../lib/voice-rpc.ts'
import { THREAD_TURN, THREAD_CLOSE } from '../lib/thread-rpc.ts'
import { AGENT, COPY_ID, FORK_A, HOME, MAIN, MCP, STATE, WINDOWS, flush, projectDir, rig, transcript, turn, wt } from './helpers/thread-lane-rig.ts'

const { threadLaneArgs, threadTurnPrompt } = laneArgs
const POSIX = { skip: WINDOWS ? 'the lane Bash sandbox is POSIX only' : false }

const settingsOf = (args: readonly string[]) => JSON.parse(args[args.indexOf('--settings') + 1]!) as Record<string, any>
const flag = (args: readonly string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const owner = (rootId: string, over = {}) => turn(rootId, { opener: 'owner', ...over } as never)
const recipient = (rootId: string, over = {}) => turn(rootId, { opener: 'recipient', ...over } as never)

// -- who opened the thread ----------------------------------------------------

test('the opener is the owner only for a frame with no lane stamp (or the owner\'s) that names no person', () => {
  const frame = { rpcId: 'r1', op: THREAD_TURN, assistantId: '7', agentRoute: '', chatId: '55', payload: {} }
  assert.equal(threadRpc.threadOpener(frame), 'owner')
  assert.equal(threadRpc.threadOpener({ ...frame, lane: 'owner' }), 'owner')
  assert.equal(threadRpc.threadOpener({ ...frame, lane: 'person:user_2abc', actorUserId: 'user_2abc' }), 'recipient')
  assert.equal(threadRpc.threadOpener({ ...frame, lane: 'person:user_2abc' }), 'recipient', 'a person\'s stamp alone')
  assert.equal(threadRpc.threadOpener({ ...frame, actorUserId: 'user_2abc' }), 'recipient', 'a person named with no stamp')
  assert.equal(threadRpc.threadOpener({ ...frame, actor_user_id: 'user_2abc' }), 'recipient', 'the poll row spelling')
  assert.equal(threadRpc.threadOpener({ ...frame, lane: 42 }), 'recipient', 'a stamp that cannot be read')
  assert.equal(threadRpc.threadOpener({ ...frame, lane: 'group:9' }), 'recipient')
  for (const junk of [null, undefined, 'owner', 7, []]) assert.equal(threadRpc.threadOpener(junk), 'recipient')
})

test('the frame carries its opener to the turn, and a payload can never claim to be the owner', () => {
  const raw = { rpcId: 'r1', op: THREAD_TURN, assistantId: '7', agentRoute: '', chatId: '55', payload: { rootId: '101', mode: 'start', opener: 'owner' } }
  assert.equal(normalizeVoiceRpc(raw)?.opener, 'owner')
  const person = normalizeVoiceRpc({ ...raw, lane: 'person:user_2abc', actorUserId: 'user_2abc' })
  assert.equal(person?.opener, 'recipient')
  assert.equal(threadRpc.threadTurnPayload(person!.payload, person!.chatId, person!.opener).opener, 'recipient', 'the payload\'s own claim is ignored')
  assert.equal(threadRpc.threadTurnPayload(raw.payload, '55', 'owner').opener, 'owner')
  assert.equal(threadRpc.threadTurnPayload(raw.payload, '55').opener, undefined, 'no opener given: none set, so the lane runs confined')
  assert.equal(normalizeVoiceRpc({ ...raw, op: THREAD_CLOSE })?.opener, 'owner')
  assert.equal(normalizeVoiceRpc({ ...raw, op: 'stop_turn' })?.opener, undefined, 'only thread ops carry one')
})

test('full access needs the owner AND the setting on; everything else is confined', () => {
  const { threadAccess } = laneArgs
  assert.equal(threadAccess({ opener: 'owner', fullAccess: true }), 'full')
  assert.equal(threadAccess({ opener: 'owner', fullAccess: false }), 'confined')
  assert.equal(threadAccess({ opener: 'recipient', fullAccess: true }), 'confined')
  for (const opener of [undefined, null, '', 'Owner', 'person:1', true]) assert.equal(threadAccess({ opener, fullAccess: true }), 'confined')
  for (const fullAccess of [undefined, null, 'true', 1]) assert.equal(threadAccess({ opener: 'owner', fullAccess }), 'confined')
})

test('threads.fullAccess is on by default, and only an explicit off turns it off', () => {
  const { threadsFullAccess, THREADS_FULL_ACCESS_ENV } = access
  const read = (text: string | null) => () => text
  assert.equal(threadsFullAccess({ env: {}, readSettings: read(null) }), true, 'no settings file')
  assert.equal(threadsFullAccess({ env: {}, readSettings: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }) } }), true, 'a file that is not there')
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('') }), true)
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('{}') }), true)
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('{"threads":{}}') }), true)
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('{"threads":{"fullAccess":true}}') }), true)
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('{"threads":{"fullAccess":false}}') }), false)
})

test('a setting that cannot be read is never read as on: the owner may have meant off', () => {
  const { threadsFullAccess, THREADS_FULL_ACCESS_ENV } = access
  const read = (text: string | null) => () => text
  // A typo in the file the owner wrote to turn it off.
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('{"threads":{"fullAccess":false') }), false, 'JSON cut short')
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('not json') }), false)
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('[]') }), false, 'not a settings object')
  assert.equal(threadsFullAccess({ env: {}, readSettings: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) } }), false, 'a file that is there and cannot be read')
  assert.equal(threadsFullAccess({ env: {}, readSettings: () => { throw new Error('unknown') } }), false)
  for (const value of ['"false"', '0', 'null', '"off"', '{}']) {
    assert.equal(threadsFullAccess({ env: {}, readSettings: read(`{"threads":{"fullAccess":${value}}}`) }), false, `fullAccess ${value}: anything but true, once written, is off`)
  }
  assert.equal(threadsFullAccess({ env: {}, readSettings: read('{"threads":"off"}') }), false)
  for (const value of ['disabled', 'none', 'maybe', 'nope']) {
    assert.equal(threadsFullAccess({ env: { [THREADS_FULL_ACCESS_ENV]: value }, readSettings: read('{"threads":{"fullAccess":true}}') }), false, `HOAI_THREADS_FULL_ACCESS=${value} is not a yes`)
  }
})

test('the variable, when it says yes or no, wins over the file', () => {
  const { threadsFullAccess, THREADS_FULL_ACCESS_ENV } = access
  const read = (text: string | null) => () => text
  assert.equal(threadsFullAccess({ env: { [THREADS_FULL_ACCESS_ENV]: 'false' }, readSettings: read('{"threads":{"fullAccess":true}}') }), false, 'the variable wins')
  assert.equal(threadsFullAccess({ env: { [THREADS_FULL_ACCESS_ENV]: ' OFF ' }, readSettings: read(null) }), false)
  assert.equal(threadsFullAccess({ env: { [THREADS_FULL_ACCESS_ENV]: 'true' }, readSettings: read('{"threads":{"fullAccess":false}}') }), true)
  assert.equal(threadsFullAccess({ env: { [THREADS_FULL_ACCESS_ENV]: '  ' }, readSettings: read('{"threads":{"fullAccess":false}}') }), false, 'an empty variable says nothing: the file decides')
  assert.equal(threadsFullAccess({ env: { [THREADS_FULL_ACCESS_ENV]: '' }, readSettings: read(null) }), true)
})

// -- the owner's command ------------------------------------------------------

test('an owner\'s thread command is a true fork: --resume <main> --fork-session, the main session\'s mode, the owner\'s own settings and MCP servers', () => {
  const args = laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: null, permissionMode: 'bypassPermissions' })
  assert.deepEqual(args.slice(0, 9), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--resume', MAIN, '--fork-session'])
  assert.ok(args.includes('--dangerously-skip-permissions'), 'the main session\'s own mode: full access')
  assert.equal(flag(args, '--permission-prompt-tool'), 'stdio', 'what still asks reaches the daemon')
  for (const confined of ['--restricted', '--tools', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--add-dir']) {
    assert.equal(args.includes(confined), false, `${confined} would take the owner's own access away`)
  }
  // --settings adds to the owner's files, it never replaces them: no allow list, no sandbox, no hook list of its own.
  const settings = settingsOf(args)
  assert.deepEqual(Object.keys(settings).sort(), ['permissions', 'remoteControlAtStartup'])
  assert.deepEqual(Object.keys(settings.permissions), ['deny'])
  assert.equal(settings.remoteControlAtStartup, false)
  assert.equal(settings.sandbox, undefined, 'no Bash sandbox: Bash reaches the network and the whole disk as in the main session')
  assert.equal(settings.hooks, undefined, 'the owner\'s own hooks load from the owner\'s own settings')
})

test('the thread starts in the main session\'s own permission mode; plan, a missing and an unknown mode read as default', () => {
  const mode = (m: unknown) => laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: null, permissionMode: m })
  for (const m of ['default', 'acceptEdits', 'auto', 'dontAsk']) {
    assert.equal(flag(mode(m), '--permission-mode'), m)
    assert.equal(mode(m).includes('--dangerously-skip-permissions'), false, `${m} is never widened to bypass`)
  }
  for (const m of ['plan', null, undefined, '', 'bypass', 'BYPASSPERMISSIONS', 7]) {
    assert.equal(flag(mode(m), '--permission-mode'), 'default', `${String(m)} reads as default`)
    assert.equal(mode(m).includes('--dangerously-skip-permissions'), false)
  }
  assert.equal(mode('bypassPermissions').includes('--permission-mode'), false)
})

test('a later start resumes the thread\'s own session, never the main one, with the same access', () => {
  const args = laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: FORK_A, permissionMode: 'bypassPermissions' })
  assert.equal(flag(args, '--resume'), FORK_A)
  assert.equal(args.includes('--fork-session'), false)
  assert.ok(args.includes('--dangerously-skip-permissions'))
})

test('assertForksMain is kept: no full access command resumes the main session as its next turn', () => {
  const args = laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: null, permissionMode: 'default' })
  const noFork = args.filter((a) => a !== '--fork-session')
  assert.throws(() => laneArgs.assertFullFork(noFork, MAIN), /--fork-session/)
  assert.throws(() => laneArgs.assertForksMain(noFork, MAIN), /--fork-session/)
  assert.throws(() => laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: 'not-a-uuid', permissionMode: 'default' }), /UUID/)
  assert.throws(() => laneArgs.threadFullArgs({ mainSessionId: null, forkSessionId: null, permissionMode: 'default' }), /UUID/)
  assert.throws(() => laneArgs.assertFullFork(args.filter((a) => a !== 'stdio'), MAIN), /prompts/)
  const at = args.indexOf('--settings')
  const noDeny = [...args]
  noDeny[at + 1] = JSON.stringify({ remoteControlAtStartup: false })
  assert.throws(() => laneArgs.assertFullFork(noDeny, MAIN), /shared folder/)
  assert.throws(() => laneArgs.assertFullFork([...args, '--restricted'], MAIN), /--restricted/)
  assert.throws(() => laneArgs.assertFullFork([...args, '--strict-mcp-config'], MAIN), /--strict-mcp-config/)
  assert.throws(() => laneArgs.assertFullFork([...args, '--continue'], MAIN), /--fork-session|--continue/)
})

test('two sessions in one folder: git checkout, switch, reset, restore, stash and clean are refused to the thread, and its first turn says the folder is shared', () => {
  const deny = settingsOf(laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: null, permissionMode: 'bypassPermissions' })).permissions.deny as string[]
  for (const verb of ['checkout', 'switch', 'reset', 'restore', 'stash', 'clean']) assert.ok(deny.includes(`Bash(git ${verb}:*)`), `git ${verb} is refused`)
  const text = threadTurnPrompt({ mode: 'start', text: 'Fix the test.', title: 'Flaky', rootText: 'CI is red', access: 'full' } as never)
  assert.match(text, /the main session is still running here and may be editing files right now/)
  assert.match(text, /Never run git checkout, git switch, git reset, git restore, git stash or git clean in this folder/)
  assert.match(text, /say so in your answer before or instead of changing it/)
  assert.match(text, /make your own worktree outside this folder/)
  assert.doesNotMatch(text, /read only|in this folder only/)
  assert.ok(text.endsWith('\n\nFix the test.'))
  assert.equal([...text].some((ch) => ch.charCodeAt(0) === 0x2013 || ch.charCodeAt(0) === 0x2014), false, 'no em or en dash')
})

test('a full access thread gets the main session\'s environment, without this plugin\'s own variables', () => {
  const env = streamChild.ownerLaneEnv({
    PATH: '/bin', HOME: '/home/u', SSH_AUTH_SOCK: '/tmp/agent.sock', AWS_PROFILE: 'work', GH_TOKEN: 'g', ANTHROPIC_MODEL: 'm',
    BGOS_API_KEY: 'k', BGOS_PAIRING_TOKEN: 'p', HOAI_GROUP_LEVELS: 'true', HOAI_THREAD_LANE: 'stale',
    CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_PLUGIN_DATA: '/data', CLAUDE_PROJECT_DIR: '/work/atlas', CLAUDE_CONFIG_DIR: '/cfg', GONE: undefined,
  })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/u', SSH_AUTH_SOCK: '/tmp/agent.sock', AWS_PROFILE: 'work', GH_TOKEN: 'g', ANTHROPIC_MODEL: 'm', CLAUDE_CONFIG_DIR: '/cfg' })
  // The one plugin variable a thread keeps: where the plugin's hooks look for the daemon, so "Always ask" still finds it in a thread.
  assert.deepEqual(streamChild.ownerLaneEnv({ BGOS_PLUGIN_STATE_DIR: '/state', BGOS_API_KEY: 'k', BGOS_PLUGIN_STATE_DIRX: 'no' }), { BGOS_PLUGIN_STATE_DIR: '/state' })
  // The confined list is what it was: none of the owner's own credentials.
  assert.equal(streamChild.laneChildEnv({ SSH_AUTH_SOCK: '/tmp/agent.sock', GH_TOKEN: 'g', PATH: '/bin' }).SSH_AUTH_SOCK, undefined)
})

// -- the manager: owner -------------------------------------------------------

test('OWNER: a thread on a repository above the copy limit is a full fork in the agent\'s own folder, with Bash, the network and the owner\'s permission mode', async () => {
  const r = rig({ fullAccess: true, tooLarge: 'it holds more than 1.0 GB of files', mainMode: 'bypassPermissions' })
  assert.deepEqual(r.manager.turn(owner('101')), { accepted: true, state: 'working' })
  await r.manager.idle()
  assert.equal(r.spawned.length, 1)
  const s = r.spawned[0]!
  assert.equal(s.cwd, AGENT, 'it runs in the agent\'s own folder')
  assert.deepEqual(s.args, laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: null, permissionMode: 'bypassPermissions' }))
  assert.ok(s.args.includes('--dangerously-skip-permissions'), 'the owner\'s permission mode')
  assert.equal(s.args.includes('--tools'), false, 'every tool of the main session, Bash included')
  assert.equal(settingsOf(s.args).sandbox, undefined, 'Bash is not sandboxed: it has the network')
  assert.equal(s.ownerEnv, true, 'the main session\'s environment')
  assert.deepEqual(s.env, { [THREAD_LANE_ENV]: join(STATE, '101.json') }, 'and the mark that keeps a second copy of this plugin out: its own state file')
  assert.equal(r.state('101')!.pid, s.child.pid, 'which names the thread\'s process from the moment it is started')
  assert.equal(r.gitCalls.some((c) => c.includes('worktree')), false, 'no worktree, whatever the repository\'s size')
  assert.equal(r.exists(wt('101')), false, 'nothing is made under .hoai/threads')
  assert.equal(r.files.has(transcript(wt('101'), MAIN)), false, 'the main transcript is not copied: the fork is in its own project folder')
  assert.match(s.child.said(), /the main session is still running here/)
  assert.doesNotMatch(s.child.said(), /read only/)
  const state = r.state('101')!
  assert.equal(state.access, 'full')
  assert.equal(state.cwd, AGENT)
  assert.equal(state.readOnly, false)
  assert.equal(state.worktree, false)
})

test('OWNER: the mode is the main session\'s own, read at each start', async () => {
  for (const [mainMode, expected] of [['acceptEdits', 'acceptEdits'], ['default', 'default'], ['plan', 'default'], [null, 'default']] as const) {
    const r = rig({ fullAccess: true, mainMode })
    r.manager.turn(owner('101'))
    await r.manager.idle()
    assert.equal(flag(r.spawned[0]!.args, '--permission-mode'), expected, `main in ${String(mainMode)}`)
    assert.equal(r.spawned[0]!.args.includes('--dangerously-skip-permissions'), false)
  }
})

test('OWNER: a folder that is no git repository still gets the full fork (a confined lane there is read only)', async () => {
  const r = rig({ fullAccess: true, repo: false })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  assert.equal(r.spawned[0]!.cwd, AGENT)
  assert.ok(r.spawned[0]!.args.includes('--dangerously-skip-permissions'))
  assert.equal(r.state('101')!.readOnly, false)
})

test('OWNER: the next start resumes the thread\'s own session in the agent folder with the same access', async () => {
  const r = rig({ fullAccess: true })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const first = r.spawned[0]!.child
  first.init(FORK_A)
  first.result('Done.')
  await r.manager.idle()
  assert.equal(r.state('101')!.forkSessionId, FORK_A)
  first.exit(0)
  r.files.set(transcript(AGENT, FORK_A), '{"fork":true}\n')
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1011', text: 'And then?' }))
  await r.manager.idle()
  assert.equal(r.spawned.length, 2)
  assert.equal(r.spawned[1]!.cwd, AGENT)
  assert.deepEqual(r.spawned[1]!.args, laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: FORK_A, permissionMode: 'bypassPermissions' }))
  assert.equal(r.spawned[1]!.child.said(), 'And then?', 'a reply is the person\'s own words')
})

test('OWNER: an active /goal of the main chat never comes along: the thread forks a goal cleared copy made beside the main transcript, removed once it was read', async () => {
  const r = rig({ fullAccess: true, activeGoal: true })
  const before = r.files.get(r.mainPath)
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const copy = transcript(AGENT, COPY_ID)
  assert.equal(r.files.get(copy), '{"main":true,"goal":"cleared"}\n', 'the copy sits in the agent folder\'s own project folder, its goal cleared')
  assert.deepEqual(r.spawned[0]!.args, laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: null, forkFrom: COPY_ID, permissionMode: 'bypassPermissions' }))
  assert.deepEqual(r.spawned[0]!.args.slice(6, 9), ['--resume', COPY_ID, '--fork-session'])
  assert.equal(r.state('101')!.tempCopy, copy, 'named in the lane state, so a crash here leaves nothing unknown')
  r.spawned[0]!.child.init(FORK_A)
  assert.equal(r.files.has(copy), false, 'gone once the fork read it')
  assert.equal(r.state('101')!.tempCopy, null)
  assert.equal(r.files.get(r.mainPath), before, 'the main transcript is byte for byte unchanged')
})

test('OWNER: with no active goal the fork reads the main transcript where it is, and nothing is copied', async () => {
  const r = rig({ fullAccess: true })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  assert.equal(r.spawned[0]!.cwd, AGENT)
  assert.deepEqual(r.spawned[0]!.args.slice(6, 9), ['--resume', MAIN, '--fork-session'])
  assert.deepEqual(r.left(projectDir(AGENT)), [r.mainPath])
  assert.equal(r.state('101')!.tempCopy, null)
})

test('OWNER: what still asks in the thread (a rule, the "Always ask" hook) is answered by the owner\'s own approval path', async () => {
  const asked: Array<Record<string, unknown>> = []
  let verdict: { allow: boolean; message?: string } = { allow: true }
  const r = rig({ fullAccess: true, approve: async (input) => { asked.push(input as never); return verdict } })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const child = r.spawned[0]!.child
  child.init(FORK_A)
  child.frame({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push --force' } } })
  await flush()
  assert.equal(asked.length, 1)
  assert.equal(asked[0]!.toolName, 'Bash')
  assert.equal(asked[0]!.rootId, '101')
  assert.equal(asked[0]!.title, 'T101')
  assert.deepEqual(asked[0]!.input, { command: 'git push --force' })
  assert.deepEqual(child.answers()[0], { type: 'control_response', response: { subtype: 'success', request_id: 'q1', response: { behavior: 'allow', updatedInput: { command: 'git push --force' } } } })
  verdict = { allow: false }
  child.frame({ type: 'control_request', request_id: 'q2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x' } } })
  await flush()
  assert.equal(child.answers()[1]!.response.response.behavior, 'deny')
  assert.match(child.answers()[1]!.response.response.message, /owner/)
  child.frame({ type: 'control_request', request_id: 'q3', request: { subtype: 'interrupt' } })
  await flush()
  assert.equal(child.answers()[2]!.response.subtype, 'error')
})

test('OWNER: with no approval path a prompt is refused, never left hanging and never allowed', async () => {
  const r = rig({ fullAccess: true })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const child = r.spawned[0]!.child
  child.init(FORK_A)
  child.frame({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } } })
  await flush()
  assert.equal(child.answers()[0]!.response.response.behavior, 'deny')
})

// -- the manager: recipient, and everything that is not positively the owner --

test('RECIPIENT: a working thread is exactly the confined command of before: --restricted, its own tools, the Bash sandbox, the deny rules, its own worktree', POSIX, async () => {
  const r = rig({ fullAccess: true })
  r.manager.turn(recipient('101'))
  await r.manager.idle()
  const s = r.spawned[0]!
  assert.equal(s.cwd, wt('101'), 'its own worktree, never the agent folder')
  const settings = settingsOf(s.args)
  assert.deepEqual(s.args, threadLaneArgs({
    mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP,
    confinement: { root: wt('101'), readOnly: false, shellSandbox: true, protectedPaths: settings.sandbox.filesystem.denyWrite, secretPaths: settings.sandbox.filesystem.denyRead, readablePaths: [] },
  }), 'byte for byte the command threadLaneArgs builds, as before 0.88.0')
  assert.ok(settings.sandbox.filesystem.denyRead.includes(join(HOME, '.bgos-agent')), 'the agents\' credentials stay unreadable to its Bash')
  assert.ok(s.args.includes('--restricted'))
  assert.equal(flag(s.args, '--tools'), 'Bash,Read,Edit,Write,Glob,Grep,NotebookEdit,WebFetch,WebSearch')
  assert.equal(flag(s.args, '--permission-mode'), 'acceptEdits')
  assert.deepEqual({ enabled: settings.sandbox.enabled, auto: settings.sandbox.autoAllowBashIfSandboxed, unsandboxed: settings.sandbox.allowUnsandboxedCommands }, { enabled: true, auto: true, unsandboxed: false })
  assert.ok(settings.sandbox.filesystem.denyWrite.includes(join(AGENT, '.git', 'index')), 'the source repository\'s state is protected')
  assert.deepEqual(s.args.slice(-3), ['--strict-mcp-config', '--mcp-config', MCP], 'the empty MCP config')
  assert.equal(s.args.includes('--dangerously-skip-permissions'), false)
  assert.equal(s.args.includes('--permission-prompt-tool'), false)
  assert.equal(s.ownerEnv, undefined, 'the allow listed environment, never the owner\'s')
  assert.equal(s.env, undefined)
  assert.doesNotThrow(() => laneArgs.assertConfined(s.args))
  assert.equal(s.child.said(), threadTurnPrompt({ ...recipient('101'), readOnly: false, agentFolder: AGENT }), 'and the same first words')
  assert.ok(r.files.has(transcript(wt('101'), MAIN)), 'the main transcript is copied beside its worktree, as before')
  assert.equal(r.state('101')!.access, 'confined')
})

test('RECIPIENT: on a repository above the copy limit the thread is read only, as before: no Bash, no editing tool, dontAsk', async () => {
  const r = rig({ fullAccess: true, tooLarge: 'it holds more than 1.0 GB of files' })
  r.manager.turn(recipient('101'))
  await r.manager.idle()
  const s = r.spawned[0]!
  assert.deepEqual(s.args, threadLaneArgs({
    mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP,
    confinement: { root: wt('101'), readOnly: true, shellSandbox: false, readDirs: [AGENT] },
  }))
  assert.equal(flag(s.args, '--tools'), 'Read,Glob,Grep,WebFetch,WebSearch')
  assert.equal(flag(s.args, '--permission-mode'), 'dontAsk')
  assert.deepEqual(settingsOf(s.args).permissions.deny, ['Bash', 'Edit', 'Write', 'NotebookEdit'])
  assert.equal(r.gitCalls.some((c) => c.includes('worktree') && c.includes('add')), false)
  assert.equal(s.cwd, wt('101'))
  assert.match(s.child.said(), /This thread is read only/)
  assert.equal(r.state('101')!.readOnly, true)
})

test('a recipient\'s prompt is never answered by the owner\'s approval path', async () => {
  let asked = 0
  const r = rig({ fullAccess: true, approve: async () => { asked++; return { allow: true } } })
  r.manager.turn(recipient('101'))
  await r.manager.idle()
  const child = r.spawned[0]!.child
  child.init(FORK_A)
  child.frame({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'curl example.com' } } })
  await flush()
  assert.equal(asked, 0)
  assert.equal(child.answers().some((a) => a.response?.response?.behavior === 'allow'), false)
})

for (const [name, opts, input] of [
  ['a turn with no known opener', { fullAccess: true }, turn('101')],
  ['the owner with threads.fullAccess off', { fullAccess: false }, owner('101')],
  ['the owner on a daemon with no setting wired', {}, owner('101')],
  ['an opener that is not a known word', { fullAccess: true }, turn('101', { opener: 'OWNER' } as never)],
] as const) {
  test(`CONFINED: ${name} runs confined, on a big repository read only`, async () => {
    const r = rig({ ...opts, tooLarge: 'it holds more than 1.0 GB of files' })
    r.manager.turn(input)
    await r.manager.idle()
    const s = r.spawned[0]!
    assert.ok(s.args.includes('--restricted'))
    assert.equal(flag(s.args, '--tools'), 'Read,Glob,Grep,WebFetch,WebSearch')
    assert.equal(s.args.includes('--dangerously-skip-permissions'), false)
    assert.equal(s.cwd, wt('101'))
    assert.equal(s.ownerEnv, undefined)
  })
}

test('the setting is read at each start: turned off, the owner\'s thread goes back to its own worktree with its memory', POSIX, async () => {
  let on = true
  const r = rig({ fullAccess: () => on })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const first = r.spawned[0]!.child
  first.init(FORK_A)
  r.files.set(transcript(AGENT, FORK_A), '{"fork":"memory"}\n')
  first.result('Done.')
  await r.manager.idle()
  first.exit(0)
  on = false
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1011', text: 'More.' }))
  await r.manager.idle()
  const s = r.spawned[1]!
  assert.equal(s.cwd, wt('101'))
  assert.ok(s.args.includes('--restricted'))
  assert.equal(flag(s.args, '--resume'), FORK_A)
  assert.equal(r.files.get(transcript(wt('101'), FORK_A)), '{"fork":"memory"}\n', 'its session moved with it')
  assert.equal(r.files.has(transcript(AGENT, FORK_A)), false)
  assert.equal(r.state('101')!.access, 'confined')
  assert.ok(r.files.has(r.mainPath), 'the main transcript is never moved')
})

test('a thread opened confined before 0.88.0 gets full access on its owner\'s next message: its session moves to the agent folder and it is told where its earlier work is', async () => {
  const r = rig({ fullAccess: true })
  r.dirs.add(wt('101'))
  r.files.set(join(wt('101'), '.git'), 'gitdir: x\n')
  r.files.set(transcript(wt('101'), FORK_A), '{"fork":"memory"}\n')
  // A state file as 0.87.4 wrote it: no access field.
  r.files.set(join(HOME, '.bgos-agent', '7', 'threads', '101.json'), JSON.stringify({
    rootId: '101', chatId: '55', title: 'T101', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: null, lastReplyId: '1010', lastDelivered: true, pid: null, pidStamp: null,
  }))
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1011', text: 'Now push it.' }))
  await r.manager.idle()
  const s = r.spawned[0]!
  assert.equal(s.cwd, AGENT)
  assert.deepEqual(s.args, laneArgs.threadFullArgs({ mainSessionId: MAIN, forkSessionId: FORK_A, permissionMode: 'bypassPermissions' }))
  assert.equal(r.files.get(transcript(AGENT, FORK_A)), '{"fork":"memory"}\n')
  assert.equal(r.files.has(transcript(wt('101'), FORK_A)), false)
  const said = s.child.said()
  assert.match(said, /same access as the main conversation/)
  assert.ok(said.includes(JSON.stringify(wt('101'))), 'it is told where its earlier work is')
  assert.match(said, /hoai\/thread-101/)
  assert.ok(said.endsWith('\n\nNow push it.'))
  const state = r.state('101')!
  assert.equal(state.access, 'full')
  assert.equal(state.folder, wt('101'), 'the worktree is still the thread\'s own, removed when the thread closes')
  assert.equal(state.worktree, true)
})

test('a full access process that is still alive is stopped, not reused, once the setting is off: the next message runs confined', POSIX, async () => {
  let on = true
  const r = rig({ fullAccess: () => on })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const first = r.spawned[0]!.child
  first.init(FORK_A)
  r.files.set(transcript(AGENT, FORK_A), '{"fork":"memory"}\n')
  first.result('Done.')
  await r.manager.idle()
  // The process idles (20 minutes) with the owner's access. The owner turns the setting off and writes again.
  on = false
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1011', text: 'Still full?' }))
  await flush()
  assert.deepEqual(first.killed, ['SIGTERM'], 'the full access process is stopped')
  assert.equal(first.stdin.some((l) => l.includes('Still full?')), false, 'and the message is never written to it')
  assert.equal(r.spawned.length, 1, 'nothing starts while it is still exiting')
  first.exit(0)
  await r.manager.idle()
  assert.equal(r.spawned.length, 2)
  assert.ok(r.spawned[1]!.args.includes('--restricted'))
  assert.equal(r.spawned[1]!.cwd, wt('101'))
  assert.equal(r.spawned[1]!.child.said(), 'Still full?')
  assert.equal(r.posts.some((p) => p.path === 'integrations/threads/reply' && /failed/.test(String(p.body.text))), false, 'the stop is no failure of the turn')
})

test('a turn that is not the owner\'s never runs on a full access process that is still alive', POSIX, async () => {
  const r = rig({ fullAccess: true })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const first = r.spawned[0]!.child
  first.init(FORK_A)
  r.files.set(transcript(AGENT, FORK_A), '{"fork":"memory"}\n')
  first.result('Done.')
  await r.manager.idle()
  r.manager.turn(recipient('101', { mode: 'reply', replyId: '1011', text: 'From a person.' }))
  await flush()
  assert.deepEqual(first.killed, ['SIGTERM'])
  assert.equal(first.stdin.some((l) => l.includes('From a person.')), false)
  first.exit(0)
  await r.manager.idle()
  assert.ok(r.spawned[1]!.args.includes('--restricted'))
  assert.equal(r.spawned[1]!.ownerEnv, undefined)
})

test('and the other way: a confined process that is still alive gives way to the full fork once the setting is on', POSIX, async () => {
  let on = false
  const r = rig({ fullAccess: () => on })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const first = r.spawned[0]!.child
  first.init(FORK_A)
  r.files.set(transcript(wt('101'), FORK_A), '{"fork":"memory"}\n')
  first.result('Done.')
  await r.manager.idle()
  on = true
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1011', text: 'Full now?' }))
  await flush()
  assert.deepEqual(first.killed, ['SIGTERM'])
  first.exit(0)
  await r.manager.idle()
  assert.equal(r.spawned[1]!.cwd, AGENT)
  assert.ok(r.spawned[1]!.args.includes('--dangerously-skip-permissions'))
  assert.match(r.spawned[1]!.child.said(), /This thread now runs with full access/)
})

test('a process whose access still fits is reused as before: no stop, no second process', async () => {
  const r = rig({ fullAccess: true })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const first = r.spawned[0]!.child
  first.init(FORK_A)
  first.result('Done.')
  await r.manager.idle()
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1011', text: 'Again.' }))
  await r.manager.idle()
  assert.deepEqual(first.killed, [])
  assert.equal(r.spawned.length, 1)
  assert.equal(first.said(1), 'Again.')
})

test('an approval path that answers nonsense refuses the prompt, never leaves it unanswered', async () => {
  const r = rig({ fullAccess: true, approve: (async () => null) as never })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const child = r.spawned[0]!.child
  child.init(FORK_A)
  child.frame({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })
  await flush()
  assert.equal(child.answers().length, 1)
  assert.equal(child.answers()[0]!.response.response.behavior, 'deny')
})

test('a thread that moved to full access goes back to its own worktree, in that worktree, when the setting is turned off', POSIX, async () => {
  let on = true
  const r = rig({ fullAccess: () => on })
  r.dirs.add(wt('101'))
  r.files.set(join(wt('101'), '.git'), 'gitdir: x\n')
  r.files.set(transcript(wt('101'), FORK_A), '{"fork":"memory"}\n')
  r.files.set(join(STATE, '101.json'), JSON.stringify({
    rootId: '101', chatId: '55', title: 'T101', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: null, lastReplyId: '1010', lastDelivered: true, pid: null, pidStamp: null,
  }))
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1011', text: 'Full now.' }))
  await r.manager.idle()
  assert.equal(r.spawned[0]!.cwd, AGENT)
  r.spawned[0]!.child.init(FORK_A)
  r.spawned[0]!.child.result('Done.')
  await r.manager.idle()
  r.spawned[0]!.child.exit(0)
  on = false
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1012', text: 'Confined again.' }))
  await r.manager.idle()
  const s = r.spawned[1]!
  assert.equal(s.cwd, wt('101'), 'the confined command runs in the thread\'s own worktree, never in the agent folder')
  assert.ok(s.args.includes('--restricted'))
  assert.equal(flag(s.args, '--resume'), FORK_A)
  assert.equal(settingsOf(s.args).permissions.additionalDirectories[0], wt('101'))
  assert.equal(r.files.get(transcript(wt('101'), FORK_A)), '{"fork":"memory"}\n')
  assert.equal(r.files.has(transcript(AGENT, FORK_A)), false)
  const state = r.state('101')!
  assert.deepEqual([state.access, state.cwd, state.folder, state.worktree], ['confined', wt('101'), wt('101'), true])
})

test('a pending row read after a reconnect carries its opener the same way: the owner\'s is full, a person\'s is confined', async () => {
  const r = rig({ fullAccess: true, tooLarge: 'it holds more than 1.0 GB of files' })
  const rows = [
    { chatId: '55', rootId: '101', replyId: '1010', mode: 'reply', text: 'a', title: 'A', rootText: 'ra', assistantId: '7' },
    { chatId: '56', rootId: '102', replyId: '1020', mode: 'reply', text: 'b', title: 'B', rootText: 'rb', assistantId: '7', lane: 'person:user_2abc', actorUserId: 'user_2abc' },
  ]
  assert.equal(await r.manager.reconcile(async () => ({ turns: rows }), { assistantIds: ['7'] }), 2)
  await r.manager.idle()
  const byRoot = (root: string) => r.spawned.find((s) => r.state(root)!.cwd === s.cwd)!
  assert.equal(r.state('101')!.access, 'full')
  assert.equal(byRoot('101').cwd, AGENT)
  assert.equal(r.state('102')!.access, 'confined')
  assert.ok(byRoot('102').args.includes('--restricted'))
})
