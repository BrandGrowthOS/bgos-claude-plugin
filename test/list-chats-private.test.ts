/**
 * list_chats names the verified sender of the turn (shared agents Phase 0,
 * item 0.7; BGOS docs/reports/2026-10-14-shared-agents-review PLAN.md and
 * MATRIX M3.9).
 *
 * THE DEFECT. On a share recipient's turn list_chats returned every chat of
 * the agent, other recipients' ids and titles included: the request carried
 * nothing but the owner's pairing, so the backend could only answer for the
 * owner. The backend half filters by the actor; this half names the actor.
 *
 * WHAT THESE TESTS HOLD.
 *   - list_chats is in the helper guard (PRIVATE_TOOL_MATCHER, all three
 *     installs) and in the daemon's admission gate, so a turn with no
 *     verified sender lists nothing and a helper of an earlier turn cannot
 *     list for the current one;
 *   - GET peers/reachable carries the turn's headers: X-BGOS-Acting-User on a
 *     recipient's turn, nothing added on the owner's own turn.
 *
 * Run with: npx tsx --test test/list-chats-private.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import * as privateTurnModule from '../lib/private-turn.mjs'
import { PRIVATE_TOOL_MATCHER, createPrivateTurnTracker, requirePrivateTurn } from '../lib/private-turn.mjs'
// Read off the module, so a tree without them reports each case rather than failing to load.
const { TURN_AWARE_REFUSAL, turnAwarePrivateTurn } = privateTurnModule as any
import { PRIVATE_TOOL_MATCHER as PRESEED_MATCHER } from '../lib/claude-preseed.mjs'
import { markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { buildReachableChatsPath, summarizeReachableChats } from '../lib/reachable-chats.ts'

const source = readFileSync('server.ts', 'utf8')
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
const listChatsSource = source.slice(source.indexOf("    case 'list_chats': {"), source.indexOf("    case 'send_to_peer': {"))

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

test('list_chats is a private tool for the helper guard, under any install prefix, in every install', () => {
  const marketplace = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  const guard = marketplace.hooks.PreToolUse.find((entry: any) => entry.hooks.some((h: any) => String(h.args?.[0]).endsWith('hoai-private-turn-hook.mjs')))
  for (const matcher of [PRIVATE_TOOL_MATCHER, PRESEED_MATCHER, guard.matcher]) {
    const re = new RegExp(matcher)
    for (const name of ['mcp__bgos__list_chats', 'mcp__plugin_hoai_bgos__list_chats']) assert.equal(re.test(name), true, `${name} against ${matcher}`)
    // list_peers and send_to_peer are Phase 4 (D4), not this item.
    assert.equal(re.test('mcp__bgos__list_peers'), false)
    assert.equal(re.test('mcp__bgos__list_chats_all'), false)
  }
})

test('a helper started in an earlier turn cannot list chats for the current sender', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-list-chats-private-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }) })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const tracker = createPrivateTurnTracker()
  const start = (actor: string, text: string) => {
    const prompt = tracker.deliver({ content: text, actingUserId: actor, chatId: actor === 'user_owner' ? '10' : '20' })
    recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd, prompt }, env)
    tracker.begin({ prompt, sessionId: 's' })
  }
  const hook = (payload: Record<string, unknown>) => spawnSync(process.execPath, ['bin/hoai-private-turn-hook.mjs'], {
    env, input: JSON.stringify({ session_id: 's', cwd, ...payload }), encoding: 'utf8',
  })
  start('user_alice', 'which chats do you have?')
  assert.equal(hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-a', agent_type: 'general-purpose' }).status, 0)
  start('user_bob', 'hello')
  const refused = hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_hoai_bgos__list_chats', tool_input: {}, agent_id: 'agent-a', agent_type: 'general-purpose' })
  assert.equal(refused.status, 2, 'list_chats from a helper of an earlier turn must be refused')
})

test('the admission gate is turn aware for list_chats: a verified turn frozen, an unverified one in a recipient chat refused, else the owner', async () => {
  for (const name of ['list_chats']) {
    const run = (turn: unknown, turnChatId: string | null) => execute(admissionSource + '\nreturn privateCall;', {
      req: { params: { name } }, lockHeld: true, privateTurns: { current: () => turn }, PRIVATE_MARKER_PATHS: [],
      PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: 'user_owner', log: () => {},
      requirePrivateTurn, turnAwarePrivateTurn,
      turnChat: { current: () => (turnChatId ? { chatId: turnChatId } : null) },
      chatOwnership: { isOthers: (chatId: string) => chatId === '20' },
    })
    const frozen = await run({ actingUserId: 'user_recipient', chatId: '20', turnId: 't' }, '20')
    assert.deepEqual([frozen.actingUserId, frozen.chatId, frozen.headers], ['user_recipient', '20', { 'X-BGOS-Acting-User': 'user_recipient' }], name)
    const refused = await run(null, '20')
    assert.equal(refused?.isError, true, `${name}: an unverified sender in a recipient chat lists nothing`)
    assert.equal(refused.content[0].text, TURN_AWARE_REFUSAL, name)
    // The owner's own work on a turn no delivery opened (the goal lane, a mission card, a tap) runs as before.
    const owner = await run(null, '10')
    assert.deepEqual([owner.actingUserId, owner.headers], ['user_owner', {}], name)
  }
})

async function runListChats(privateCall: unknown) {
  const sent: Array<{ path: string; headers: Record<string, string> }> = []
  const result = await execute(`return (async () => { switch(name) { ${listChatsSource} } })();`, {
    name: 'list_chats', privateCall, buildReachableChatsPath, summarizeReachableChats,
    bgosPeerGet: async (path: string, headers?: Record<string, string>) => {
      sent.push({ path, headers: { ...(headers ?? {}) } })
      return { chats: [{ id: 20, assistantId: 900, kind: 'main', title: 'Mine' }] }
    },
  })
  return { sent, result }
}

test('list_chats names a recipient turn to the backend, and the owner request is what it was', async () => {
  const recipient = await runListChats({ actingUserId: 'user_recipient', chatId: '20', headers: { 'X-BGOS-Acting-User': 'user_recipient' } })
  assert.equal(recipient.result?.isError, undefined)
  assert.deepEqual(recipient.sent, [{ path: buildReachableChatsPath(), headers: { 'X-BGOS-Acting-User': 'user_recipient' } }])

  const owner = await runListChats({ actingUserId: 'user_owner', chatId: '10', headers: {} })
  assert.deepEqual(owner.sent, [{ path: buildReachableChatsPath(), headers: {} }])
  assert.match(owner.result.content[0].text, /"title": "Mine"/)
})
