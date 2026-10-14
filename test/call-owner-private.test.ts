/**
 * call_owner acts for the verified sender of this turn (shared agents Phase 0,
 * item 0.3; BGOS docs/reports/2026-10-14-shared-agents-review PLAN.md and
 * MATRIX M7.6).
 *
 * THE DEFECT. On a share recipient's turn the agent's call_owner rang the
 * OWNER with a reason written from the recipient's turn: the tool was not a
 * private tool, so no turn was checked and no acting header was sent, and the
 * backend could only read the request as the owner's own. The backend half
 * refuses a recipient actor with one sentence; this half makes the daemon say
 * who the turn is for.
 *
 * WHAT THESE TESTS HOLD.
 *   - call_owner is in the helper guard (PRIVATE_TOOL_MATCHER, the same string
 *     in lib/private-turn.mjs, lib/claude-preseed.mjs and hooks/hooks.json), so
 *     a helper started in an earlier turn cannot ring anyone for the current
 *     sender;
 *   - the daemon's admission gate freezes the verified turn for call_owner
 *     before any work, and refuses it when the sender is not verified;
 *   - the outbound call request carries that turn's headers: on a recipient's
 *     turn X-BGOS-Acting-User names them, on the owner's own turn nothing is
 *     added, so the owner's request is byte identical to before.
 *
 * Run with: npx tsx --test test/call-owner-private.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { PRIVATE_TOOL_MATCHER, createPrivateTurnTracker, privateMarkerPath } from '../lib/private-turn.mjs'
import { PRIVATE_TOOL_MATCHER as PRESEED_MATCHER } from '../lib/claude-preseed.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { buildCallOwnerBody } from '../lib/call-owner.ts'

const source = readFileSync('server.ts', 'utf8')
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
const callOwnerSource = source.slice(source.indexOf("    case 'call_owner': {"), source.indexOf("    case 'schedule': {"))

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-call-owner-private-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }) })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const tracker = createPrivateTurnTracker()
  const start = (actor: string, text: string, session = 's') => {
    const prompt = tracker.deliver({ content: text, actingUserId: actor, chatId: actor === 'user_owner' ? '10' : '20' })
    recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt }, env)
    tracker.begin({ prompt, sessionId: session })
  }
  const hook = (payload: Record<string, unknown>) => spawnSync(process.execPath, ['bin/hoai-private-turn-hook.mjs'], {
    env, input: JSON.stringify({ session_id: 's', cwd, ...payload }), encoding: 'utf8',
  })
  return { root, cwd, env, start, hook, markerPaths: [privateMarkerPath(root, floorKey(cwd))] }
}

test('call_owner is a private tool for the helper guard, under any install prefix, in every install', () => {
  const marketplace = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  const guard = marketplace.hooks.PreToolUse.find((entry: any) => entry.hooks.some((h: any) => String(h.args?.[0]).endsWith('hoai-private-turn-hook.mjs')))
  for (const matcher of [PRIVATE_TOOL_MATCHER, PRESEED_MATCHER, guard.matcher]) {
    const re = new RegExp(matcher)
    for (const name of ['mcp__bgos__call_owner', 'mcp__plugin_hoai_bgos__call_owner']) assert.equal(re.test(name), true, `${name} against ${matcher}`)
    // Controls: an ordinary tool and a look-alike name stay outside.
    assert.equal(re.test('mcp__bgos__reply'), false)
    assert.equal(re.test('mcp__bgos__call_owner_now'), false)
  }
})

test('a helper started in an earlier turn cannot ring anyone for the current sender', (t) => {
  const f = fixture(t)
  const call = (tool: string, agentId?: string) => f.hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}) })
  f.start('user_alice', 'ask my owner to call me')
  assert.equal(f.hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-a', agent_type: 'general-purpose' }).status, 0)
  // Inside the turn that started it, the helper may call.
  assert.equal(call('mcp__bgos__call_owner', 'agent-a').status, 0)
  // The owner's turn begins while Alice's helper still runs: it is refused.
  f.start('user_owner', 'anything new?')
  const refused = call('mcp__plugin_hoai_bgos__call_owner', 'agent-a')
  assert.equal(refused.status, 2, 'call_owner from a helper of an earlier turn must be refused')
  assert.match(refused.stderr, /earlier turn|started/)
  // The main agent is left to the daemon's own gate.
  assert.equal(call('mcp__bgos__call_owner').status, 0)
})

test('the admission gate freezes the verified turn for call_owner, and refuses an unverified one before any work', async () => {
  const bindings = {
    req: { params: { name: 'call_owner' } }, lockHeld: true, privateTurns: {}, PRIVATE_MARKER_PATHS: [],
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: 'user_owner',
  }
  let called = 0
  const refused = await execute(admissionSource + '\nreturn privateCall;', {
    ...bindings, requirePrivateTurn: () => { called++; throw new Error('This private action did not start because its current sender could not be verified.') },
  })
  assert.equal(called, 1, 'the gate ran for call_owner')
  assert.equal(refused?.isError, true, 'an unverified sender rings nobody')
  assert.match(refused.content[0].text, /did not start/)
  const frozen = { actingUserId: 'user_recipient', chatId: '20', headers: { 'X-BGOS-Acting-User': 'user_recipient' } }
  const admitted = await execute(admissionSource + '\nreturn privateCall;', { ...bindings, requirePrivateTurn: () => frozen })
  assert.deepEqual(admitted, frozen)
})

function runCallOwner(privateCall: unknown, response: { status: number; body: unknown }) {
  const sent: Array<{ url: string; init: any }> = []
  const bindings = {
    name: 'call_owner', privateCall, buildCallOwnerBody, log: () => {},
    rawArgs: { reason: 'Quick question about the invoice' },
    resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
    monitoredChatIds: ['10'], ASSISTANT_ID: '900', API_BASE: 'https://hoai.invalid/api/v1',
    AUTH: { mode: 'pairing' }, authHeaders: () => ({ 'X-BGOS-Pairing': 'pairing-token' }), HTTP_TIMEOUT_MS: 1000,
    bgosCall: async (call: { url: string; init: any }, consume: (res: any) => Promise<unknown>) => {
      sent.push(call)
      const raw = JSON.stringify(response.body)
      return consume({ ok: response.status >= 200 && response.status < 300, status: response.status, text: async () => raw })
    },
  }
  const result = execute(`return (async () => { switch(name) { ${callOwnerSource} } })();`, bindings)
  return { sent, result }
}

test('call_owner names a recipient turn to the backend, and the owner request is byte identical', async () => {
  const recipient = runCallOwner(
    { actingUserId: 'user_recipient', chatId: '20', headers: { 'X-BGOS-Acting-User': 'user_recipient' } },
    { status: 200, body: { status: 'ringing' } },
  )
  await recipient.result
  assert.equal(recipient.sent.length, 1)
  assert.equal(recipient.sent[0]!.init.headers['X-BGOS-Acting-User'], 'user_recipient', 'the recipient turn is named')

  const owner = runCallOwner({ actingUserId: 'user_owner', chatId: '10', headers: {} }, { status: 200, body: { status: 'ringing' } })
  const ownerResult = await owner.result
  assert.equal(owner.sent.length, 1)
  assert.deepEqual(owner.sent[0]!.init.headers, { 'Content-Type': 'application/json', 'X-BGOS-Pairing': 'pairing-token' })
  assert.equal(owner.sent[0]!.url, 'https://hoai.invalid/api/v1/voice/outbound-call')
  assert.deepEqual(JSON.parse(owner.sent[0]!.init.body), { assistantId: 900, chatId: 10, reason: 'Quick question about the invoice' })
  assert.match(ownerResult.content[0].text, /Calling your owner now \(ringing\)/)
})

test('the backend refusal for a recipient reaches the model as its own sentence, not a ring', async () => {
  const sentence = 'This agent can only call its owner, and this turn is for someone it is shared with.'
  const { result } = runCallOwner(
    { actingUserId: 'user_recipient', chatId: '20', headers: { 'X-BGOS-Acting-User': 'user_recipient' } },
    { status: 403, body: { statusCode: 403, message: sentence } },
  )
  const answer = await result
  assert.equal(answer.isError, true)
  assert.ok(answer.content[0].text.includes(sentence), answer.content[0].text)
  assert.doesNotMatch(answer.content[0].text, /Calling your owner now/)
})
