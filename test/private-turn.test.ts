import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { startHookIntake } from '../lib/hook-intake.js'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { privatePromptHash } from '../lib/private-turn.mjs'
import { PRIVATE_TOOL_MATCHER, createPrivateTurnTracker, privateActor, privateContextPath, privateMarkerPath, publishPrivateContext, readPrivateJson, requirePrivateTurn, writePrivateJson } from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { clipPayload } from '../bin/hoai-hook.mjs'
import { ensureHookEntries } from '../lib/claude-preseed.mjs'
import { managedLaunchRequired, relayEnvFromResolution } from '../bin/hoai-browser-launch.mjs'

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-private-turn-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/')); rmSync(root, { recursive: true, force: true }) })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateMarkerPath(root, floorKey(cwd))]
  // The owner every requirePrivateTurn below names, as server.ts tells its tracker (board row f81a527c).
  const tracker = createPrivateTurnTracker({ ownerUserId: 'user_owner' })
  const start = (actor: string | null, text = 'identical incoming user text', session = 'session-a') => {
    const prompt = tracker.deliver({ content: text, actingUserId: actor, chatId: actor === 'user_owner' ? '10' : '20' })
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt }
    recordPrivateBoundary(payload, env)
    tracker.begin({ prompt, sessionId: session })
    return { prompt, payload }
  }
  return { root, cwd, env, markerPaths, tracker, start }
}

test('authoritative sender ignores owner transport IDs and forged scheduled actor shapes', () => {
  assert.equal(privateActor({ senderType: 'user', senderUserId: 'user_recipient' }), 'user_recipient')
  assert.equal(privateActor({ senderType: 'system', eventMeta: { source: 'scheduler', payload: { actingUserId: 'user_recipient' } } }), 'user_recipient')
  for (const payload of ['{"actingUserId":"user_owner"}', [{ actingUserId: 'user_owner' }], { payload: { actingUserId: 'user_owner' } }, null]) {
    assert.equal(privateActor({ senderType: 'system', eventMeta: { source: 'scheduler', payload } }), null)
  }
  for (const value of [
    { senderType: 'system', senderUserId: 'user_owner', eventMeta: { source: 'scheduler', payload: {} } },
    { senderType: 'agent', senderUserId: 'user_owner' },
    { senderType: 'user', senderUserId: 'user_recipient', agentOrigin: {} },
    { senderType: 'system', eventMeta: { source: 'user', payload: { actingUserId: 'user_owner' } } },
    { senderType: 'user', user_id: 'user_owner' },
  ]) assert.equal(privateActor(value), null)
})

test('same text from two recipients cannot select the latest actor', (t) => {
  const f = fixture(t)
  const first = f.tracker.deliver({ content: 'same question', actingUserId: 'user_alice', chatId: '21' })
  f.tracker.deliver({ content: 'same question', actingUserId: 'user_bob', chatId: '22' })
  recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: f.cwd, prompt: first }, f.env)
  f.tracker.begin({ prompt: first, sessionId: 's' })
  assert.equal(requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner').actingUserId, 'user_alice')
})

test('synchronous next prompt invalidates previous actor before async intake and a scheduled wake freezes its actor', (t) => {
  const f = fixture(t)
  f.start('user_alice')
  const admitted = requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner')
  const wake = f.tracker.deliver({ content: 'scheduled wake', actingUserId: 'user_bob', chatId: '22' })
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/, 'another actor delivered mid turn revokes it')
  recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 'session-a', cwd: f.cwd, prompt: wake }, f.env)
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
  f.tracker.begin({ prompt: wake, sessionId: 'session-a' })
  assert.equal(requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner').actingUserId, 'user_bob')
  assert.equal(admitted.headers['X-BGOS-Acting-User'], 'user_alice', 'already admitted work keeps its actor')
})

test('replay, ambiguous, unattributed and absent delivery markers fail closed', (t) => {
  const f = fixture(t)
  const { prompt } = f.start('user_alice')
  assert.equal(requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner').actingUserId, 'user_alice')
  f.tracker.end()
  f.tracker.begin({ prompt, sessionId: 'session-a' })
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
  f.start(null)
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
  const a = f.tracker.deliver({ content: 'a', actingUserId: 'user_alice', chatId: '21' })
  const b = f.tracker.deliver({ content: 'b', actingUserId: 'user_bob', chatId: '22' })
  recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: f.cwd, prompt: a + b }, f.env)
  f.tracker.begin({ prompt: a + b, sessionId: 's' })
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
  f.tracker.begin({ prompt: 'old text without identity marker', sessionId: 's' })
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
})

test('expired delivery, missing boundary and changed session never reuse owner context', (t) => {
  const f = fixture(t)
  let clock = 1
  const tracker = createPrivateTurnTracker({ now: () => clock })
  const prompt = tracker.deliver({ content: 'test', actingUserId: 'user_owner', chatId: '10' })
  clock += 16 * 60_000
  recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: f.cwd, prompt }, f.env)
  tracker.begin({ prompt, sessionId: 's' })
  assert.equal(tracker.current({ markerPaths: f.markerPaths }), null)
  const fresh = tracker.deliver({ content: 'new', actingUserId: 'user_owner', chatId: '10' })
  tracker.begin({ prompt: fresh, sessionId: 's' })
  assert.equal(tracker.current({ markerPaths: f.markerPaths }), null)
  recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 'other', cwd: f.cwd, prompt: fresh }, f.env)
  assert.equal(tracker.current({ markerPaths: f.markerPaths }), null)
})

test('fresh clone and marketplace register sync private hook without changing async telemetry', (t) => {
  const f = fixture(t)
  const settingsPath = join(f.root, 'settings.json')
  const forwarderPath = join(process.cwd(), 'bin', 'hoai-hook.mjs')
  assert.equal(ensureHookEntries({ settingsPath, forwarderPath }).reason, 'set')
  assert.equal(ensureHookEntries({ settingsPath, forwarderPath }).reason, 'already')
  const clone = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const marketplace = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  for (const config of [clone, marketplace]) {
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd']) {
      const hooks = config.hooks[event].flatMap((entry: any) => entry.hooks)
      assert.equal(hooks.find((entry: any) => entry.args[0].endsWith('hoai-private-turn-hook.mjs')).async, false)
      assert.equal(hooks.find((entry: any) => entry.args[0].endsWith('/hoai-hook.mjs') || entry.args[0].endsWith('\\hoai-hook.mjs')).async, true)
    }
    // Helpers are bound to the turn that started them, before any private tool runs.
    const start = config.hooks.SubagentStart.flatMap((entry: any) => entry.hooks)
    assert.equal(start.find((entry: any) => entry.args[0].endsWith('hoai-private-turn-hook.mjs')).async, false)
    const guard = config.hooks.PreToolUse.find((entry: any) => entry.hooks.some((h: any) => h.args[0].endsWith('hoai-private-turn-hook.mjs')))
    assert.equal(guard.matcher, PRIVATE_TOOL_MATCHER)
    assert.equal(guard.hooks[0].async, false)
  }
})

test('fresh installed real hooks and intake publish usable signed context before tools, then Stop revokes', async (t) => {
  const f = fixture(t)
  const transcript = join(f.cwd, 'session.jsonl')
  writeFileSync(transcript, '')
  const path = privateContextPath(f.root, '7')
  let admittedEvents = 0
  const intake = startHookIntake({
    stateRoot: f.root, projectDir: f.cwd, baseDir: f.cwd,
    isArmed: () => true, provesDelivery: (prompt) => prompt.includes('<hoai-private-turn id="'),
    onEvent: (payload) => {
      if (payload.hook_event_name !== 'UserPromptSubmit') return
      admittedEvents += 1
      f.tracker.begin({ prompt: payload.prompt, sessionId: payload.session_id })
    },
  })
  const heartbeat = setInterval(() => {
    intake.pump()
    const turn = f.tracker.current({ markerPaths: f.markerPaths })
    publishPrivateContext({ path, secret: 'synthetic-test-key', assistantId: '7', ownerUserId: 'user_owner', claudePid: process.pid, turn })
  }, 25)
  t.after(() => { clearInterval(heartbeat); intake.stop() })
  const runHook = (file: string, payload: any) => {
    const child = spawn(process.execPath, [file], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stdin.end(JSON.stringify(payload))
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    return new Promise<void>((done, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? done() : reject(new Error(stderr))) })
  }
  for (const actor of ['user_owner', 'user_recipient']) {
    const prompt = f.tracker.deliver({ content: 'private browser request', actingUserId: actor, chatId: '20' })
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: f.cwd, transcript_path: transcript, prompt, prompt_id: actor }
    // These are the two shipped handlers for the same event, run concurrently by Claude.
    await Promise.all([runHook('bin/hoai-private-turn-hook.mjs', payload), runHook('bin/hoai-hook.mjs', payload)])
    const envelope = readPrivateJson(path)
    const marker = readPrivateJson(f.markerPaths[0])
    const ready = readPrivateJson(f.markerPaths[0] + '.ready')
    assert.equal(ready.turnId, marker.turnId, 'daemon receipt landed before the synchronous hook released tools')
    assert.equal(envelope.context.turnId, marker.turnId)
    assert.equal(envelope.context.actingUserId, actor)
    assert.equal(envelope.context.live, true)
    assert.equal(envelope.signature, createHmac('sha256', 'synthetic-test-key').update(JSON.stringify(envelope.context)).digest('hex'))
    const turn = requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner')
    assert.deepEqual(turn.headers, actor === 'user_owner' ? {} : { 'X-BGOS-Acting-User': actor })
    recordPrivateBoundary({ hook_event_name: 'Stop', session_id: 's', cwd: f.cwd }, f.env)
    assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
  }
  assert.equal(admittedEvents, 2)
})

test('marker write failure blocks prompt and missing marker refuses private work', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'private-turn'), 'a file blocks the marker directory')
  const prompt = f.tracker.deliver({ content: 'test', actingUserId: 'user_alice', chatId: '21' })
  const result = spawnSync(process.execPath, ['bin/hoai-private-turn-hook.mjs'], { env: f.env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: f.cwd, prompt }), encoding: 'utf8' })
  assert.equal(result.status, 2)
  f.tracker.begin({ prompt, sessionId: 's' })
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
})

test('managed launch carries mandatory signed context while explicit standalone lane is unchanged', () => {
  const manifest = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'))
  assert.equal(manifest.mcpServers['hoai-browser'].env.HOAI_RELAY_MANAGED, '1')
  assert.equal(managedLaunchRequired({ HOAI_RELAY_MANAGED: '1' }, '/standalone', () => false), true)
  assert.equal(managedLaunchRequired({}, '/agent', path => String(path).endsWith('.bgos-agent-id')), true)
  assert.equal(managedLaunchRequired({}, '/standalone', () => false), false)
  const resolution = { complete: true, backendUrl: 'https://example.test', pairingToken: 'synthetic', assistantId: '7', ownerUserId: 'user_owner', contextFile: 'C:/synthetic/browser-turn.json', mode: 'pairing' }
  const managed = relayEnvFromResolution(resolution).env!
  assert.equal(managed.HOAI_RELAY_CONTEXT_FILE, resolution.contextFile)
  assert.equal(managed.HOAI_RELAY_OWNER_USER_ID, 'user_owner')
  assert.equal(managed.HOAI_RELAY_CLIENT_PID, String(process.ppid))
  assert.equal(relayEnvFromResolution({ ...resolution, contextFile: '' }).env!.HOAI_RELAY_CONTEXT_FILE, undefined)
})

test('a mid-turn delivery from another person or an unattributed sender revokes the live private turn until the next prompt', (t) => {
  const f = fixture(t)
  const path = privateContextPath(f.root, '7')
  const revoked: number[] = []
  const tracker = createPrivateTurnTracker({ ownerUserId: 'user_owner', onRevoke: () => {
    revoked.push(1)
    publishPrivateContext({ path, secret: 'synthetic-test-key', assistantId: '7', ownerUserId: 'user_owner', claudePid: process.pid, turn: tracker.current({ markerPaths: f.markerPaths }) })
  } })
  const begin = (actor: string | null, chatId: string) => {
    const prompt = tracker.deliver({ content: 'check my inbox in the browser', actingUserId: actor, chatId })
    recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: f.cwd, prompt }, f.env)
    tracker.begin({ prompt, sessionId: 's' })
  }
  begin('user_alice', '21')
  assert.equal(requirePrivateTurn(tracker, f.markerPaths, 'user_owner').actingUserId, 'user_alice')
  // Same person, same chat, mid turn: the turn keeps its actor.
  tracker.deliver({ content: 'also the calendar', actingUserId: 'user_alice', chatId: '21' })
  assert.equal(requirePrivateTurn(tracker, f.markerPaths, 'user_owner').actingUserId, 'user_alice')
  assert.equal(revoked.length, 0)
  // Bob's card lands mid turn with no UserPromptSubmit: nobody may act.
  tracker.deliver({ content: 'open my bank site', actingUserId: 'user_bob', chatId: '22' })
  assert.throws(() => requirePrivateTurn(tracker, f.markerPaths, 'user_owner'), /did not start/)
  assert.equal(tracker.current({ markerPaths: f.markerPaths }), null)
  assert.equal(readPrivateJson(path).context.live, false, 'signed browser context is revoked at once')
  assert.equal(revoked.length, 1)
  // It never rebinds to the newcomer either, even after another delivery.
  tracker.deliver({ content: 'and my schedules', actingUserId: 'user_bob', chatId: '22' })
  assert.equal(tracker.current({ markerPaths: f.markerPaths }), null)
  // The next prompt admits exactly one actor again.
  begin('user_bob', '22')
  assert.equal(requirePrivateTurn(tracker, f.markerPaths, 'user_owner').actingUserId, 'user_bob')
  for (const intruder of [{ actingUserId: null, chatId: '23' }, { actingUserId: 'user_bob', chatId: '99' }]) {
    begin('user_bob', '22')
    assert.equal(requirePrivateTurn(tracker, f.markerPaths, 'user_owner').actingUserId, 'user_bob')
    tracker.deliver({ content: 'peer or other chat', ...intruder })
    assert.throws(() => requirePrivateTurn(tracker, f.markerPaths, 'user_owner'), /did not start/)
  }
})

test('a failed Stop or SessionEnd boundary never blocks stopping and still closes the live marker', (t) => {
  const f = fixture(t)
  for (const event of ['Stop', 'SessionEnd']) {
    f.start('user_alice')
    assert.equal(readPrivateJson(f.markerPaths[0]).live, true)
    // No session identity makes the boundary write throw.
    const result = spawnSync(process.execPath, ['bin/hoai-private-turn-hook.mjs'], { env: f.env, input: JSON.stringify({ hook_event_name: event, cwd: f.cwd }), encoding: 'utf8' })
    assert.equal(result.status, 0, `${event} exit 2 would block stopping: ${result.stderr}`)
    assert.match(result.stderr, /HOAI/)
    assert.notEqual(readPrivateJson(f.markerPaths[0])?.live, true, `${event} leaves no live marker behind`)
    assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
  }
  // An unwritable state folder at Stop is reported, not a block.
  rmSync(join(f.root, 'private-turn'), { recursive: true, force: true })
  writeFileSync(join(f.root, 'private-turn'), 'a file blocks the marker directory')
  const blocked = spawnSync(process.execPath, ['bin/hoai-private-turn-hook.mjs'], { env: f.env, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: f.cwd }), encoding: 'utf8' })
  assert.equal(blocked.status, 0)
})

test('a prompt past the forwarder clip still admits its verified sender without spooling the prompt text', (t) => {
  const f = fixture(t)
  const secret = 'pasted document '.repeat(20_000)
  const prompt = f.tracker.deliver({ content: secret, actingUserId: 'user_alice', chatId: '21' })
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: f.cwd, prompt }
  recordPrivateBoundary(payload, f.env)
  const clipped: any = clipPayload(payload)
  assert.equal(clipped.hoai_clipped, true)
  assert.ok(!JSON.stringify(clipped).includes('pasted document'), 'the prompt text is not kept')
  // The daemon's intake hands exactly these fields to begin().
  f.tracker.begin({ prompt: clipped.prompt, promptHash: clipped.hoai_clipped === true ? clipped.prompt_sha256 : undefined, sessionId: clipped.session_id })
  assert.equal(requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner').actingUserId, 'user_alice')
  // Two tokens stay ambiguous after the clip.
  const other = f.tracker.deliver({ content: 'b', actingUserId: 'user_bob', chatId: '22' })
  const both = { ...payload, prompt: f.tracker.deliver({ content: secret, actingUserId: 'user_alice', chatId: '21' }) + other }
  recordPrivateBoundary(both, f.env)
  const clippedBoth: any = clipPayload(both)
  f.tracker.begin({ prompt: clippedBoth.prompt, promptHash: clippedBoth.prompt_sha256, sessionId: 's' })
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
  // A forged hash that does not match the marker admits nobody.
  const again = { ...payload, prompt: f.tracker.deliver({ content: secret, actingUserId: 'user_alice', chatId: '21' }) }
  recordPrivateBoundary(again, f.env)
  const clippedAgain: any = clipPayload(again)
  f.tracker.begin({ prompt: clippedAgain.prompt, promptHash: '0'.repeat(64), sessionId: 's' })
  assert.throws(() => requirePrivateTurn(f.tracker, f.markerPaths, 'user_owner'), /did not start/)
})

test('a subagent may use private tools only inside the turn that started it', (t) => {
  const f = fixture(t)
  const hook = (payload: any) => spawnSync(process.execPath, ['bin/hoai-private-turn-hook.mjs'], { env: f.env, input: JSON.stringify({ session_id: 's', cwd: f.cwd, ...payload }), encoding: 'utf8' })
  const call = (tool: string, agentId?: string) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}) })
  const browser = 'mcp__plugin_hoai_hoai-browser__browser_snapshot'
  f.start('user_alice', 'research and fill the form', 's')
  assert.equal(hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-a', agent_type: 'general-purpose' }).status, 0)
  // Inside the turn that started it, the helper works like the main agent.
  for (const tool of [browser, 'mcp__bgos__schedule', 'mcp__plugin_hoai_bgos__boards_list']) assert.equal(call(tool, 'agent-a').status, 0, tool)
  // A helper whose start was never recorded is refused.
  assert.equal(call(browser, 'agent-unknown').status, 2)
  // Bob's turn begins while the background helper from Alice's turn still runs.
  f.start('user_bob', 'open my bank', 's')
  for (const tool of [browser, 'mcp__hoai-browser__browser_click', 'mcp__bgos__schedule', 'mcp__plugin_hoai_bgos__list_schedules', 'mcp__bgos__cancel_schedule', 'mcp__bgos__boards_update']) {
    const refused = call(tool, 'agent-a')
    assert.equal(refused.status, 2, `${tool} from a helper of an earlier turn must be refused`)
    assert.match(refused.stderr, /earlier turn|started/)
  }
  // The main agent and non-private tools are never touched by this guard.
  assert.equal(call(browser).status, 0)
  assert.equal(call('mcp__plugin_hoai_bgos__reply', 'agent-a').status, 0)
  assert.equal(call('Bash', 'agent-a').status, 0)
  // After the turn stops, no helper may act either.
  assert.equal(hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-b' }).status, 0)
  assert.equal(call(browser, 'agent-b').status, 0)
  recordPrivateBoundary({ hook_event_name: 'Stop', session_id: 's', cwd: f.cwd }, f.env)
  assert.equal(call(browser, 'agent-b').status, 2)
})

// KC 2026-10-12: a peer agent's request is never a verified sender, and the refusal is COUNTED so the delegation
// question can be decided on numbers (docs/proposals/peer-delegation-private-tools.md). The tracker remembers which
// peer behind the turn, apart from the actor, and never lets it satisfy the gate.
test('a peer turn is remembered for counting and still has no actor: the gate stays closed', () => {
  let n = 0
  const tracker = createPrivateTurnTracker({ randomId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })
  const content = tracker.deliver({ content: 'please add a card', actingUserId: null, chatId: '5', peerSourceAssistantId: 888 })
  const token = /id="([^"]+)"/.exec(content)![1]
  tracker.begin({ prompt: content, sessionId: 's1' })
  assert.deepEqual(tracker.peerTurn(), { sourceAssistantId: '888', chatId: '5' })
  // Even with a live marker the hook wrote for exactly this prompt and session, a peer turn is no verified sender.
  const root = mkdtempSync(join(tmpdir(), 'peer-turn-'))
  const markerPath = privateMarkerPath(root, 'k')
  writePrivateJson(markerPath, { schemaVersion: 1, turnId: 't1', sessionId: 's1', promptHash: privatePromptHash(content), live: true })
  assert.equal(tracker.current({ markerPaths: [markerPath] }), null)
  assert.throws(() => requirePrivateTurn(tracker, [markerPath], 'user_owner'), /could not be verified/)
  assert.ok(token)
  tracker.end()
  assert.equal(tracker.peerTurn(), null)
})

test('a human turn, a scheduler card and the next prompt are not peer turns', () => {
  let n = 0
  const tracker = createPrivateTurnTracker({ randomId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })
  const human = tracker.deliver({ content: 'hello', actingUserId: 'user_owner', chatId: '1' })
  tracker.begin({ prompt: human, sessionId: 's1' })
  assert.equal(tracker.peerTurn(), null)
  const peer = tracker.deliver({ content: 'from a peer', actingUserId: null, chatId: '2', peerSourceAssistantId: 910 })
  tracker.begin({ prompt: peer, sessionId: 's1' })
  assert.equal(tracker.peerTurn()?.sourceAssistantId, '910')
  const next = tracker.deliver({ content: 'back to the owner', actingUserId: 'user_owner', chatId: '1' })
  tracker.begin({ prompt: next, sessionId: 's1' })
  assert.equal(tracker.peerTurn(), null, 'the next prompt clears it')
})
