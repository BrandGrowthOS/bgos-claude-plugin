/**
 * Source guard: skills_rpc is wired into server.ts the way its tests assume
 * (skills view design, section 7 row 3).
 *
 * lib/skills-inventory.ts and lib/skills-rpc.ts are tested on their own; what
 * they cannot see is how server.ts hands them the world:
 *
 * 1. The lane: answers go to integrations/skills-rpc/:rpcId/ack and /result.
 * 2. The folder: the agent folder is the launcher-supplied BGOS_LAUNCH_CWD, and
 *    NOTHING when that env is absent (LAUNCH_CWD falls back to process.cwd(),
 *    which is the plugin cache on a marketplace install, and a Remove there
 *    would delete the plugin's own skills). The config dir is the resolved
 *    CLAUDE_CONFIG_DIR, never a hardcoded ~/.claude.
 * 3. The guards: whenArmed, the update drain, and the boot home check.
 * 4. The token: skills_list is declared only because this handler exists.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { closingTeachWindows, createCardDeliveries, createTeachWindows, noteTeachTap } from '../lib/skill-origins.ts'
import { createTurnChatTracker } from '../lib/turn-chat.ts'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const REGISTRATION = "realtimeSocket.on('skills_rpc', whenArmed('skills_rpc',"

test('origin errors are written to the daemon log', () => {
  assert.match(server, /\nconst teachWindows = createTeachWindows\(\)\nlogOriginsTo\(log\)\n/)
})

test('every delivery the turn chat tracker notes closes that chat\'s teach window', () => {
  assert.match(server, /\nconst turnChat = closingTeachWindows\(createTurnChatTracker\(\), teachWindows, ASSISTANT_ID\)\n/)
  assert.ok(server.indexOf('const teachWindows = createTeachWindows()') < server.indexOf('const turnChat = closingTeachWindows('))
  assert.equal((server.match(/createTurnChatTracker\(\)/g) ?? []).length, 1, 'no second tracker skips the close')
})

test('inventory list applies origins from the sidecar beside the skills trash', () => {
  assert.match(constructionSlice(), /list: \(\) =>\s*applyOrigins\(\s*listSkills\(/)
  assert.match(constructionSlice(), /\}\),\s*SKILL_ORIGINS_FILE/)
  assert.match(server, /const SKILL_ORIGINS_FILE = pathJoin\(pathDirname\(skillsTrashDir\(\)\), 'skill-origins.json'\)/)
})

test('all six tap delivery sites note the teach window through one wrapper', () => {
  assert.equal((server.match(/\bprivateTapCard\(/g) ?? []).length, 1)
  assert.equal((server.match(/\bprivateTapCardNoting\(\{/g) ?? []).length, 6)
  const wrapper = server.slice(server.indexOf('function privateTapCardNoting('), server.indexOf('function privateTapCardNoting(') + 950)
  assert.match(wrapper, /try\s*\{\s*own = noteTeachTap\(\{ windows: teachWindows, assistantId: ASSISTANT_ID, deliveries: turnChat \}, \{/)
  for (const field of ['chatId', 'messageId', 'tapperUserId', 'ownerUserId', 'callbackData', 'customText', 'humanPrincipal', 'posted']) assert.ok(wrapper.includes(`${field}: input.${field}`), field)
  assert.match(wrapper, /now: Date.now\(\)/)
  assert.match(wrapper, /const card = privateTapCard\(input\)\n\s*if \(own\) teachCards\.ownTap\(card\)\n\s*return card/)
  assert.match(server, /function privateTapCardNoting\(input: Parameters<typeof privateTapCard>\[0\] & \{ humanPrincipal: unknown \}\)/)
})

test('each tap site hands the click\'s own humanPrincipal to the teach window', () => {
  const calls = [...server.matchAll(/privateTapCardNoting\(\{[^\n]*\}\)/g)].map((m) => m[0])
  assert.equal(calls.length, 6)
  const lanes = calls.map((call) => /lane: '(\w+)'/.exec(call)?.[1])
  assert.deepEqual(lanes, ['boot', 'poll', 'poll', 'ask', 'ask', 'stream'])
  for (const call of calls.filter((c) => /lane: '(boot|poll)'/.test(c))) {
    assert.ok(call.includes('tapperUserId: readTapperUserId(payload)'), call)
    assert.ok(call.includes('humanPrincipal: isHumanClick(mm)'), call)
  }
  const stream = calls[5]!
  assert.ok(stream.includes('tapperUserId: answer.tapperUserId'))
  assert.ok(stream.includes('humanPrincipal: isHumanClick(view.raw)'))
  for (const call of calls.filter((c) => c.includes("lane: 'ask'"))) {
    assert.ok(call.includes('tapperUserId: null'), call)
    assert.ok(call.includes('humanPrincipal: isHumanClick(null)'), call)
  }
  assert.equal((server.match(/humanPrincipal: isHumanClick\(/g) ?? []).length, 6, 'one reader at all six sites')
  assert.equal((server.match(/\bisHumanClick\(/g) ?? []).length, 6, 'and nowhere else')
  assert.doesNotMatch(server, /clickHumanPrincipal|(?<!input)\.humanPrincipal\b|human_principal/, 'no site reads the field itself')
})

test('every PostToolUse goes to the teach window, judged by the hook line\'s receivedAt', () => {
  const hook = server.slice(server.indexOf('function onHookPayload('), server.indexOf('function startHookIntakeIfHolder('))
  const received = hook.indexOf('const receivedAt = line?.receivedAt ?? Date.now()')
  const use = hook.indexOf("if (event.name === 'PostToolUse') {")
  assert.ok(received > 0 && use > received, 'receivedAt is read before the tool use is judged')
  const call = hook.slice(use, hook.indexOf('})', use))
  assert.match(call, /noteSkillToolUse\(\{/)
  assert.match(call, /toolName: payload.tool_name/)
  assert.match(call, /toolInput: payload.tool_input/)
  assert.match(call, /agentDir: SKILLS_AGENT_DIR/)
  assert.match(call, /file: SKILL_ORIGINS_FILE/)
  assert.match(call, /windows: teachWindows/)
  assert.match(call, /chatId: String\(turnChat.current\(Date.now\(\)\)\?\.chatId \?\? ''\)/)
  assert.match(call, /assistantId: ASSISTANT_ID/)
  assert.match(call, /writtenAt: receivedAt/)
  assert.doesNotMatch(hook, /teachWindows.take\(|stampTaughtWrite\(/, 'the window is taken only inside noteSkillToolUse')
})

test('install wiring stamps shared origin with destination identity and the offer', () => {
  const built = constructionSlice()
  assert.match(built, /onInstalled: \(dest\) =>/)
  assert.match(built, /const ident = originIdentOf\(dest\)/)
  assert.match(built, /stampOrigin\(SKILL_ORIGINS_FILE, pathBasename\(dest\),/)
  assert.match(built, /origin: 'shared'/)
  assert.match(built, /offerId: typeof payload.offerId === 'string' \? payload.offerId : undefined/)
})

function handlerSlice(): string {
  const at = server.indexOf(REGISTRATION)
  assert.ok(at > 0, 'skills_rpc is not registered')
  const next = server.indexOf('realtimeSocket.on(', at + REGISTRATION.length)
  return server.slice(at, next > at ? next : at + 1200)
}

function constructionSlice(): string {
  const at = server.indexOf('new SkillsRpcHandler(')
  assert.ok(at > 0, 'server.ts never constructs a SkillsRpcHandler')
  const end = server.indexOf('\n})\n', at)
  assert.ok(end > at)
  return server.slice(at, end)
}

test('the handler answers on the skills lane, behind the drain and the lock', () => {
  const built = constructionSlice()
  assert.match(built, /bgosPost\(`integrations\/skills-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/ack`/)
  assert.match(built, /bgosPost\(\s*`integrations\/skills-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/result`/)
  assert.doesNotMatch(built, /memory-rpc|voice-rpc/)
  const handler = handlerSlice()
  assert.match(handler, /^realtimeSocket\.on\('skills_rpc', whenArmed\('skills_rpc', \(payload: any\) => \{\n\s*if \(updateDrainMode\) return\n/)
  assert.ok(handler.includes('normalizeSkillsRpc('))
  assert.ok(handler.includes('trackMessageOperation(() => skillsRpc.handle(frame))'))
})

test('the agent folder is BGOS_LAUNCH_CWD or nothing, the config dir the resolved one', () => {
  assert.match(
    server,
    /\nconst SKILLS_AGENT_DIR: string \| null = process\.env\.BGOS_LAUNCH_CWD\?\.trim\(\) \? LAUNCH_CWD : null\n/,
  )
  const built = constructionSlice()
  assert.ok(built.includes('agentDir: SKILLS_AGENT_DIR'))
  assert.ok(built.includes('configDir: CLAUDE_CONFIG_DIR'))
  assert.ok(!built.includes('process.cwd()'))
  assert.ok(!built.includes("'.claude'"))
  assert.match(built, /trashDir: skillsTrashDir\(\)/)
  const trash = server.slice(server.indexOf('const skillsTrashDir = '), server.indexOf('const skillsRpc = new SkillsRpcHandler('))
  assert.match(trash, /pluginStateDirFor\(/)
  assert.ok(trash.includes("'skills-trash'"))
  assert.match(built, /\n\s*homeConfirmed: \(\) => HOME_CONFIRMED,\n/)
})

test('the share ops (row 6) get the same agent folder and post progress on the skills lane', () => {
  const built = constructionSlice()
  for (const op of ['exportSkill: (payload) =>', 'installBundle: (payload, progress) =>']) {
    const at = built.indexOf(op)
    assert.ok(at > 0, `${op} is not wired`)
    const slice = built.slice(at, built.indexOf('}),', at))
    assert.ok(slice.includes('agentDir: SKILLS_AGENT_DIR'), op)
    assert.ok(slice.includes('configDir: CLAUDE_CONFIG_DIR'), op)
    assert.ok(slice.includes('managedDir: SKILLS_MANAGED_DIR'), op)
  }
  const install = built.slice(built.indexOf('installBundle: (payload, progress) =>'))
  assert.ok(install.includes('trashDir: skillsTrashDir()'))
  assert.ok(install.includes('platform: process.platform'))
  assert.ok(install.includes('progress,'))
  assert.match(built, /postProgress: \(rpcId, body\) =>\n\s*bgosPost\(`integrations\/skills-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/progress`, body\)/)
})

function tapWrapper(scope: Record<string, unknown>) {
  const start = server.indexOf('function privateTapCardNoting(')
  const end = server.indexOf('\n}\n', start) + 3
  assert.ok(start > 0 && end > start)
  const js = ts.transpileModule(server.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(scope), `${js}\nreturn privateTapCardNoting`)(...Object.values(scope)) as (input: Record<string, unknown>) => unknown
}

const ownApprove = { tracker: {}, lane: 'stream', ownerUserId: 'owner', chatId: 'chat', messageId: 5, tapperUserId: 'owner', humanPrincipal: true, answeredAt: null, receivedAt: 0, callbackData: 'teach_approve', customText: undefined, posted: true, content: 'tap' }

test('privateTapCardNoting, run as server.ts has it: the owner\'s Approve opens its window and the card is privateTapCard\'s', () => {
  const teachWindows = createTeachWindows()
  const turnChat = closingTeachWindows(createTurnChatTracker(), teachWindows, 'assistant')
  const cards: unknown[] = []
  const wrapper = tapWrapper({ noteTeachTap, teachWindows, turnChat, teachCards: createCardDeliveries(teachWindows), ASSISTANT_ID: 'assistant', privateTapCard: (input: unknown) => { cards.push(input); return 'card' }, log: () => {} })
  assert.equal(wrapper(ownApprove), 'card')
  assert.deepEqual(cards, [ownApprove], 'privateTapCard gets the tap as given')
  assert.equal(turnChat.current(Date.now())?.chatId, 'chat', 'the tap is its chat\'s delivery')
  assert.ok(teachWindows.take('chat', 'assistant', Date.now() + 1), 'the window opened, for this assistant')
  wrapper(ownApprove)
  wrapper({ ...ownApprove, tapperUserId: 'teammate', callbackData: 'yes' })
  assert.equal(teachWindows.take('chat', 'assistant', Date.now() + 1), null, 'a teammate\'s tap closed it')
  for (const change of [{ humanPrincipal: 'true' }, { customText: 'words' }, { posted: false }, { tapperUserId: 'teammate' }]) {
    const windows = createTeachWindows()
    tapWrapper({ noteTeachTap, teachWindows: windows, turnChat, teachCards: createCardDeliveries(windows), ASSISTANT_ID: 'assistant', privateTapCard: () => 'card', log: () => {} })({ ...ownApprove, ...change })
    assert.equal(windows.take('chat', 'assistant', Date.now() + 1), null, JSON.stringify(change))
  }
})

test('privateTapCardNoting still returns the card when the teach code throws', () => {
  const lines: string[] = []
  const wrapper = tapWrapper({ noteTeachTap: () => { throw new Error('broken') }, teachWindows: {}, turnChat: {}, teachCards: { ownTap: () => { throw new Error('unreached') } }, ASSISTANT_ID: 'assistant', privateTapCard: () => 'card', log: (msg: string) => { lines.push(msg) } })
  assert.equal(wrapper(ownApprove), 'card')
  assert.deepEqual(lines, ['skills: origin unavailable'])
})

/** server.ts's own card record step (the innermost mcp.notification wrapper), run with stubs for everything else. */
function cardStep(scope: Record<string, unknown>) {
  const start = server.indexOf('const sendMcpNotification = mcp.notification.bind(mcp)')
  const end = server.indexOf('}) as typeof mcp.notification', start) + '}) as typeof mcp.notification'.length
  assert.ok(start > 0 && end > start)
  const js = ts.transpileModule(server.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const sent: unknown[] = []
  const mcp = { notification: (n: unknown) => { sent.push(n); return Promise.resolve() } }
  new Function('mcp', ...Object.keys(scope), js)(mcp, ...Object.values(scope))
  return { send: mcp.notification as (n: unknown) => Promise<void>, sent }
}

test('every channel card that reaches the session, run as server.ts has it, closes the teach windows but the owner\'s own tap card', async () => {
  const teachWindows = createTeachWindows()
  const teachCards = createCardDeliveries(teachWindows)
  const turnChat = closingTeachWindows(createTurnChatTracker(), teachWindows, 'assistant')
  const scope = { groupNotificationStep: () => null, privateTurns: { tagRawCard: (c: unknown) => c, rawCard: () => {} }, teachCards }
  const { send, sent } = cardStep(scope)
  const wrapper = tapWrapper({ noteTeachTap, teachWindows, turnChat, teachCards, ASSISTANT_ID: 'assistant', privateTapCard: () => 'the owner tapped Approve', log: () => {} })
  const card = (content: string) => ({ method: 'notifications/claude/channel', params: { content, meta: { chat_id: 'other' } } })
  await send(card(String(wrapper(ownApprove))))
  assert.equal(sent.length, 1)
  assert.ok(teachWindows.take('chat', 'assistant', Date.now() + 1), 'the own tap card kept the window it opened')
  for (const content of ['voice consult: save a helper skill', 'mission notice: goal 2 waits', 'a held member card, released']) {
    await send(card(String(wrapper(ownApprove))))
    await send(card(content))
    assert.equal(teachWindows.take('chat', 'assistant', Date.now() + 1), null, content)
  }
  await send({ method: 'notifications/message', params: { level: 'info', data: 'log' } })
})
