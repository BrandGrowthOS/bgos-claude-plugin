/**
 * set_profile_image runs only on a verified turn the owner's own message
 * opened (AVATARSELF review round 2, finding 1), and the server hands the
 * handler the turn it admitted, never the owner by default (finding 2).
 * Real tracker, real private turn hook, and the server's own admission and
 * dispatch blocks, executed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import * as privateTurn from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { PROFILE_IMAGE_NOT_OWNER_ASK, PROFILE_IMAGE_OWNER_ONLY, handleProfileImageTool, profileImageTurn } from '../lib/profile-image-tools.ts'

const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'
const source = readFileSync('server.ts', 'utf8')
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
const dispatchStart = source.indexOf("  if (req.params.name === 'set_profile_image') {\n    // Gated (admitted above)")
const dispatchSource = source.slice(dispatchStart, source.indexOf('\n  }\n', dispatchStart) + 4)

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

function session(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-profile-image-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }) })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateTurn.privateMarkerPath(root, floorKey(cwd))]
  const tracker = (privateTurn as any).createPrivateTurnTracker()
  let n = 0
  const deliver = (actingUserId: string | null, chatId: string, extra: Record<string, unknown> = {}) =>
    tracker.deliver({ content: `message ${++n}`, actingUserId, chatId, ...extra })
  const prompt = (text: string) => {
    recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd, prompt: text }, env)
    tracker.begin({ prompt: text, sessionId: 's' })
  }
  const stop = () => { recordPrivateBoundary({ hook_event_name: 'Stop', session_id: 's', cwd }, env); tracker.end() }
  /** The server's admission block for set_profile_image, executed. */
  const admit = () => execute(admissionSource + '\nreturn privateCall;', {
    req: { params: { name: 'set_profile_image' } }, lockHeld: true, privateTurns: tracker, PRIVATE_MARKER_PATHS: markerPaths,
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: OWNER, log: () => {},
    requirePrivateTurn: (privateTurn as any).requirePrivateTurn, turnAwarePrivateTurn: (privateTurn as any).turnAwarePrivateTurn,
    profileImageTurn, recordPeerRefusal: () => ({ line: '' }), pathDirname: () => '/s', CURSOR_FILE_PATH: '/s/c', ASSISTANT_ID: 900,
  })
  const current = () => { try { return (privateTurn as any).requirePrivateTurn(tracker, markerPaths, OWNER) } catch { return null } }
  return { deliver, prompt, stop, admit, current }
}

const refused = async (pending: any) => { const out = await pending; return out?.isError === true && out.content[0].text === PROFILE_IMAGE_NOT_OWNER_ASK }

test("the owner's own verified message is admitted as the owner (the control)", async (t) => {
  const s = session(t)
  s.prompt(s.deliver(OWNER, '10'))
  const call = await s.admit()
  assert.deepEqual([call.actingUserId, call.headers], [OWNER, {}])
})

test("a peer agent's message, as its own prompt or mid owner turn, is refused", async (t) => {
  const s = session(t)
  s.prompt(s.deliver(null, 'a2a-55', { peerSourceAssistantId: 947 }))
  assert.ok(await refused(s.admit()), 'its own prompt')
  s.stop()
  s.prompt(s.deliver(OWNER, '10'))
  s.deliver(null, 'a2a-55', { peerSourceAssistantId: 947 })
  assert.ok(await refused(s.admit()), 'mid owner turn')
})

test('an email or other system card that names no person is refused', async (t) => {
  const s = session(t)
  s.prompt(s.deliver(null, '10'))
  assert.ok(await refused(s.admit()))
})

test('the goal lane, a continuation after a Stop and a mission card are refused', async (t) => {
  const s = session(t)
  s.prompt('/goal ship the landing page')
  assert.ok(await refused(s.admit()), 'a typed /goal')
  s.stop()
  assert.ok(await refused(s.admit()), 'a continuation with no prompt')
  s.prompt('[mission_resumed] Keep working on mission 77')
  assert.ok(await refused(s.admit()), 'a mission card')
})

test("a scheduled wake is refused, though it is the owner's verified turn for the other private tools", async (t) => {
  const s = session(t)
  s.prompt(s.deliver(OWNER, '10', { fireKey: 'scheduler:5:f1', emailBasis: { kind: 'owner_task', id: '5' } }))
  assert.equal(s.current()?.actingUserId, OWNER, 'the wake is a verified owner turn (boards would run)')
  assert.ok(await refused(s.admit()))
})

test("a share recipient's verified turn is admitted naming them, and the handler refuses it before reading anything", async (t) => {
  const s = session(t)
  s.prompt(s.deliver(RECIPIENT, '20'))
  const call = await s.admit()
  assert.deepEqual([call.actingUserId, call.headers], [RECIPIENT, { 'X-BGOS-Acting-User': RECIPIENT }])
})

test('the dispatch hands the handler the admitted turn, never the owner by default', async () => {
  assert.ok(dispatchStart > 0, 'dispatch block found')
  const seen: any[] = []
  const run = (privateCall: unknown) => execute(dispatchSource, {
    req: { params: { name: 'set_profile_image' } }, rawArgs: { path: '/tmp/x.png' }, privateCall,
    ASSISTANT_ID: '42', USER_ID: OWNER, bgosPut: async () => ({}),
    handleProfileImageTool: (_n: string, _a: unknown, deps: any) => { seen.push(deps); return 'called' },
  })
  assert.equal(run({ actingUserId: RECIPIENT, headers: { 'X-BGOS-Acting-User': RECIPIENT } }), 'called')
  assert.deepEqual([seen[0].actingUserId, seen[0].privateHeaders], [RECIPIENT, { 'X-BGOS-Acting-User': RECIPIENT }])
  run(null)
  assert.equal(seen[1].actingUserId, null)
  // And the real handler refuses both, without reading or sending.
  const sent: unknown[] = []
  const deps = { assistantId: '42', ownerUserId: OWNER, bgosPut: async (...a: unknown[]) => { sent.push(a); return {} }, readBytes: async () => { throw new Error('read') }, fileSize: async () => { throw new Error('stat') } }
  assert.equal((await handleProfileImageTool('set_profile_image', { path: '/tmp/x.png' }, { ...deps, actingUserId: seen[0].actingUserId, privateHeaders: seen[0].privateHeaders })).content[0].text, PROFILE_IMAGE_OWNER_ONLY)
  assert.equal((await handleProfileImageTool('set_profile_image', { path: '/tmp/x.png' }, { ...deps, actingUserId: null, privateHeaders: {} })).content[0].text, PROFILE_IMAGE_NOT_OWNER_ASK)
  assert.deepEqual(sent, [])
})
