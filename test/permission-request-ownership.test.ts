/**
 * One live permission request per request id, and an operation acts only on
 * its own pending entry.
 *
 * A request id is five letters. Two producers mint them (the CLI's permission
 * requests, and the group lanes' prompts this daemon numbers itself), and the
 * relay's card post is asynchronous. So the daemon keeps ONE registry of the
 * ids that are live right now (lib/permission-request-ids.ts): an id is
 * reserved before any asynchronous step, a repeat of the same request (same
 * tool, description and preview) is joined to the one already open, and a
 * different request under an id that is already open is denied, together with
 * the open one, because a verdict names only the id.
 *
 * Inside the relay, each operation keeps the entry object it registered and
 * binds, settles, deletes, retries and watches only while the map still holds
 * that same object.
 *
 * Run with: npx tsx --test test/permission-request-ownership.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as peerRefusal from '../lib/peer-refusal.ts'
import { createRefusedChats, pickPermissionChat } from '../lib/peer-refusal.ts'
import { isOwnSendingTool } from '../lib/hard-floor.ts'
import {
  buildPermissionRequestBody,
  cardMessageIdFrom,
  choiceToBehavior,
  permissionBackstopMs,
  resolvePermissionClick,
  storedWaitSeconds,
} from '../lib/permission-relay.ts'

const ids = (await import('../lib/permission-request-ids.ts').catch(() => null)) as any
const ownershipModule = (await import('../lib/chat-ownership.ts')) as any

const OWNER = 'user_owner'
const source = readFileSync('server.ts', 'utf8')
const relaySource = source.slice(source.indexOf('function relayPermissionToOwner('), source.indexOf('\n/**\n * A request the hard floor matched'))

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * The relay as server.ts has it, run with its collaborators injected. Each
 * card post waits on a deferred the test settles, so two operations can be
 * interleaved in any order.
 */
function relayRig() {
  const posts: Array<Deferred<unknown>> = []
  const waits: Array<{ requestId: string; card: number | null; stillHeld: (() => boolean) | undefined }> = []
  const verdicts: Array<{ requestId: string; behavior: string }> = []
  const logs: string[] = []
  const pending = new Map<string, any>()
  const verdictGates: Array<Deferred<string>> = []
  const bindings: Record<string, unknown> = {
    updateDrainMode: false,
    log: (line: string) => logs.push(line),
    mcp: { notification: async (n: any) => { verdicts.push({ requestId: n.params.request_id, behavior: n.params.behavior }) } },
    trackMessageOperation: (fn: () => Promise<unknown>) => fn(),
    pickPermissionChat,
    monitoredChatIds: ['10'],
    hookRailRefusedChats: createRefusedChats(),
    a2aRouteRefusedChats: createRefusedChats(),
    permissionCardRefusedChats: createRefusedChats(),
    chatOwnership: ownershipModule.createChatOwnership(OWNER),
    USER_ID: OWNER,
    AUTH: { mode: 'pairing' },
    pendingPermissions: pending,
    buildPermissionRequestBody,
    cardMessageIdFrom,
    storedWaitSeconds,
    permissionBackstopMs,
    choiceToBehavior,
    isPermissionCardOwnerChatOnly: (peerRefusal as any).isPermissionCardOwnerChatOnly,
    refuseHookRailChat: () => false,
    isOwnSendingTool,
    // A held Bash request is not an email: the email arms are never reached.
    emailSendFilesGetNoCard: () => false,
    bgosPost: () => {
      const post = deferred<unknown>()
      posts.push(post)
      return post.promise
    },
    waitForVerdict: (
      requestId: string,
      _chatId: string,
      card: number | null,
      _ms: number,
      _requester: string,
      _floorHeld: boolean,
      _onTap: unknown,
      stillHeld?: () => boolean,
    ) => {
      waits.push({ requestId, card, stillHeld })
      const gate = deferred<string>()
      verdictGates.push(gate)
      return gate.promise
    },
  }
  const relay = (requestId: string, command = 'ls ~', floorHeld = false) =>
    execute(`${relaySource}\nreturn relayPermissionToOwner(params, undefined, floorHeld);`, {
      ...bindings,
      floorHeld,
      params: { request_id: requestId, tool_name: 'Bash', description: 'Run a command', input_preview: JSON.stringify({ command }) },
    }) as Promise<void>
  return { relay, pending, posts, waits, verdicts, logs, verdictGates }
}

const tick = () => new Promise((r) => setImmediate(r))

// ── The relay keeps to its own entry ────────────────────────────────────────

test('a failed earlier post leaves the later request of the same id waiting', async () => {
  const r = relayRig()
  const first = r.relay('abcde', 'echo one')
  const second = r.relay('abcde', 'echo two')
  const current = r.pending.get('abcde')
  assert.ok(current)
  assert.equal(r.posts.length, 2)
  r.posts[0]!.reject(new Error('the earlier post failed'))
  await first
  assert.equal(r.pending.get('abcde'), current, 'the later entry survives the earlier failure')
  // The later one still posts, binds its own card and watches.
  r.posts[1]!.resolve({ id: 9002 })
  await tick()
  assert.equal(current.cardMessageId, 9002)
  assert.deepEqual(r.waits.map((w) => w.card), [9002])
  r.verdictGates[0]!.resolve('deny')
  await second
  assert.equal(r.pending.has('abcde'), false)
})

test('an earlier post that returns late never binds its card to the later request', async () => {
  const r = relayRig()
  const first = r.relay('abcde', 'echo one')
  const second = r.relay('abcde', 'echo two')
  const current = r.pending.get('abcde')
  r.posts[0]!.resolve({ id: 9001 })
  await first
  assert.notEqual(current.cardMessageId, 9001, 'the earlier card is not the later request\'s card')
  assert.equal(r.pending.get('abcde'), current, 'the earlier operation left the later entry alone')
  assert.deepEqual(r.waits, [], 'the earlier operation does not watch a request it no longer holds')
  assert.deepEqual(r.verdicts, [{ requestId: 'abcde', behavior: 'deny' }], 'the earlier operation ends with a deny')
  // A click on the earlier card settles nothing; the later card still answers.
  const onEarlier = resolvePermissionClick({ callbackData: 'ea:once:abcde', clickerUserId: OWNER, pending: r.pending, cardMessageId: 9001 })
  assert.equal(onEarlier.kind, 'other_card')
  r.posts[1]!.resolve({ id: 9002 })
  await tick()
  assert.equal(current.cardMessageId, 9002)
  r.verdictGates[0]!.resolve('deny')
  await second
})

test('a verdict for an operation whose entry was replaced is a deny, and deletes nothing it does not own', async () => {
  const r = relayRig()
  const first = r.relay('abcde', 'echo one')
  r.posts[0]!.resolve({ id: 9001 })
  await tick()
  assert.equal(r.waits.length, 1)
  // Another operation of the same id replaces the entry while the first watches.
  const second = r.relay('abcde', 'echo two')
  const current = r.pending.get('abcde')
  assert.equal(r.waits[0]!.stillHeld?.(), false, 'the first watch is told it no longer holds the request')
  r.verdictGates[0]!.resolve('once')
  await first
  assert.equal(r.pending.get('abcde'), current, 'the second entry survives the first verdict')
  assert.deepEqual(r.verdicts, [{ requestId: 'abcde', behavior: 'deny' }], 'never an allow for a request this operation no longer holds')
  r.posts[1]!.reject(new Error('end of fixture'))
  await second
})

test('control: a click on the request\'s own card still allows it, though the intake takes the entry out first', async () => {
  const r = relayRig()
  const done = r.relay('abcde')
  r.posts[0]!.resolve({ id: 9001 })
  await tick()
  const outcome = resolvePermissionClick({ callbackData: 'ea:once:abcde', clickerUserId: OWNER, pending: r.pending, cardMessageId: 9001 })
  assert.equal(outcome.kind, 'resolved')
  await done
  assert.deepEqual(r.verdicts, [{ requestId: 'abcde', behavior: 'allow' }])
  assert.equal(r.pending.has('abcde'), false)
})

test('a click on the earlier card after a later request replaced it settles neither', async () => {
  const r = relayRig()
  const first = r.relay('abcde', 'echo one')
  r.posts[0]!.resolve({ id: 9001 })
  await tick()
  const second = r.relay('abcde', 'echo two')
  const current = r.pending.get('abcde')
  const onEarlier = resolvePermissionClick({ callbackData: 'ea:once:abcde', clickerUserId: OWNER, pending: r.pending, cardMessageId: 9001 })
  assert.equal(onEarlier.kind, 'other_card', 'the map holds the later request, whose card is not known yet')
  assert.equal(r.pending.get('abcde'), current)
  r.verdictGates[0]!.resolve('deny')
  await first
  r.posts[1]!.reject(new Error('end of fixture'))
  await second
  assert.deepEqual(r.verdicts.map((v) => v.behavior), ['deny', 'deny'])
})

test('a card post with no id: no click settles the request, and the wait ends it with a denial', async () => {
  for (const floorHeld of [false, true]) {
    for (const posted of [{}, { id: null }, { id: 1.5 }, { id: -1 }, { id: '0501' }]) {
      const r = relayRig()
      const done = r.relay('abcde', 'rm -rf build', floorHeld)
      r.posts[0]!.resolve(posted)
      await tick()
      const entry = r.pending.get('abcde')
      assert.equal(entry.cardMessageId, null, `no row is bound for ${JSON.stringify(posted)}`)
      assert.ok(
        r.logs.some((line) => line.includes('no click on the card can settle this request')),
        'the log says a click cannot end it',
      )
      for (const clicked of [null, 501, '501']) {
        const outcome = resolvePermissionClick({ callbackData: 'ea:once:abcde', clickerUserId: OWNER, pending: r.pending, cardMessageId: clicked })
        assert.equal(outcome.kind, 'other_card', `a click on ${String(clicked)} settles nothing (held ${floorHeld})`)
      }
      assert.equal(r.pending.get('abcde'), entry, 'the request is still waiting')
      assert.equal(r.waits.length, 1, 'the wait runs, with no card to read')
      assert.equal(r.waits[0]!.card, null)
      // The owner's typed denial, read by the wait.
      r.verdictGates[0]!.resolve('deny')
      await done
      assert.deepEqual(r.verdicts, [{ requestId: 'abcde', behavior: 'deny' }])
      assert.equal(r.pending.has('abcde'), false)
    }
  }
})

test('the watch is handed an identity check, not an id lookup', () => {
  assert.match(relaySource, /const own: PendingPermission = \{/)
  assert.match(relaySource, /pendingPermissions\.set\(request_id, own\)/)
  assert.match(relaySource, /\(\) => pendingPermissions\.get\(request_id\) === own,?\n/)
  const deletes = relaySource.split('\n').filter((line) => line.includes('pendingPermissions.delete('))
  assert.ok(deletes.length >= 2)
  for (const line of deletes) assert.match(line, /if \(holdsOwn\(\)\) pendingPermissions\.delete\(request_id\)/, 'every delete is guarded by identity')
  const watch = source.slice(source.indexOf('async function waitForVerdict('), source.indexOf('const verdict = await watchPermissionVerdict'))
  assert.match(watch, /stillHeld: \(\) => boolean/)
  assert.match(source, /stillPending: stillHeld,/)
})

// ── The registry ─────────────────────────────────────────────────────────────

test('the registry module exists', () => {
  assert.ok(ids?.createPermissionRequestIds, 'lib/permission-request-ids.ts exports createPermissionRequestIds')
  assert.ok(ids?.admitPermissionRequest, 'lib/permission-request-ids.ts exports admitPermissionRequest')
})

const BASH = { tool_name: 'Bash', description: 'Run a command', input_preview: '{"command":"ls"}' }

test('an id is reserved once; a repeat of the same request joins it; a different request under it collides', () => {
  if (!ids) return assert.fail('lib/permission-request-ids.ts is missing')
  const reg = ids.createPermissionRequestIds()
  const first = reg.claim('abcde', 'cli', ids.permissionRequestFingerprint(BASH))
  assert.equal(first.kind, 'reserved')
  assert.equal(reg.has('abcde'), true)
  const repeat = reg.claim('abcde', 'cli', ids.permissionRequestFingerprint({ ...BASH }))
  assert.equal(repeat.kind, 'retransmission')
  assert.equal(repeat.holder, first.reservation)
  const other = reg.claim('abcde', 'cli', ids.permissionRequestFingerprint({ ...BASH, input_preview: '{"command":"rm -rf ~"}' }))
  assert.equal(other.kind, 'collision')
  assert.equal(other.holder, first.reservation)
  assert.equal(reg.collided('abcde'), true, 'the open request is marked: it can no longer be allowed')
  // Same words from another producer is never a repeat.
  const fresh = ids.createPermissionRequestIds()
  const cli = fresh.claim('fghij', 'cli', ids.permissionRequestFingerprint(BASH))
  assert.equal(fresh.claim('fghij', 'group', ids.permissionRequestFingerprint(BASH)).kind, 'collision')
  assert.equal(fresh.holds(cli.reservation), true)
})

test('only the holder releases an id, and a released id can be reserved again', () => {
  if (!ids) return assert.fail('lib/permission-request-ids.ts is missing')
  const reg = ids.createPermissionRequestIds()
  const first = reg.claim('abcde', 'cli', 'a')
  assert.equal(reg.release(first.reservation), true)
  assert.equal(reg.has('abcde'), false)
  const second = reg.claim('abcde', 'cli', 'b')
  assert.equal(second.kind, 'reserved')
  assert.equal(reg.release(first.reservation), false, 'a stale reservation releases nothing')
  assert.equal(reg.holds(second.reservation), true)
  assert.equal(reg.holds(first.reservation), false)
  assert.equal(reg.collided('abcde'), false)
})

test('admission: a new id runs and is released when it ends, success or failure', async () => {
  if (!ids) return assert.fail('lib/permission-request-ids.ts is missing')
  const reg = ids.createPermissionRequestIds()
  const gate = deferred<void>()
  let ran = 0
  const done = ids.admitPermissionRequest({
    ids: reg,
    requestId: 'abcde',
    producer: 'cli',
    fingerprint: 'a',
    run: () => { ran += 1; return gate.promise },
    denyNewcomer: () => assert.fail('nothing collided'),
    endHolder: () => assert.fail('nothing collided'),
    log: () => {},
  })
  assert.equal(ran, 1)
  assert.equal(reg.has('abcde'), true, 'reserved for the whole wait')
  gate.resolve()
  await done
  assert.equal(reg.has('abcde'), false)

  const failing = ids.admitPermissionRequest({
    ids: reg,
    requestId: 'abcde',
    producer: 'cli',
    fingerprint: 'a',
    run: async () => { throw new Error('boom') },
    denyNewcomer: () => {},
    endHolder: () => {},
    log: () => {},
  })
  await assert.rejects(failing)
  assert.equal(reg.has('abcde'), false, 'released after a failure too')
})

test('admission: a retransmission runs nothing; a collision denies the newcomer and ends the holder', async () => {
  if (!ids) return assert.fail('lib/permission-request-ids.ts is missing')
  const reg = ids.createPermissionRequestIds()
  const gate = deferred<void>()
  const events: string[] = []
  const base = {
    ids: reg,
    requestId: 'abcde',
    producer: 'cli' as const,
    denyNewcomer: () => events.push('deny newcomer'),
    endHolder: () => events.push('end holder'),
    log: (line: string) => events.push(`log ${line}`),
  }
  const first = ids.admitPermissionRequest({ ...base, fingerprint: 'a', run: () => { events.push('run a'); return gate.promise } })
  await ids.admitPermissionRequest({ ...base, fingerprint: 'a', run: () => { events.push('run a again') } })
  assert.equal(events.includes('run a again'), false)
  assert.equal(events.includes('deny newcomer'), false)
  await ids.admitPermissionRequest({ ...base, fingerprint: 'b', run: () => { events.push('run b') } })
  assert.equal(events.includes('run b'), false)
  assert.ok(events.includes('deny newcomer'))
  assert.ok(events.includes('end holder'))
  assert.equal(reg.collided('abcde'), true)
  gate.resolve()
  await first
  assert.equal(reg.has('abcde'), false)
})

// ── server.ts wiring ─────────────────────────────────────────────────────────

test('server.ts reserves a CLI request id at the handler, before the floor or any other step', () => {
  const at = source.indexOf('mcp.setNotificationHandler(PermissionRequestSchema')
  const handler = source.slice(at, source.indexOf('\n)\n', at))
  assert.ok(handler.length > 0 && handler.length < 2000, 'the handler is the admission alone')
  assert.match(handler, /admitPermissionRequest\(\{/)
  assert.match(handler, /producer: 'cli'/)
  assert.match(handler, /run: \(\) => handlePermissionRequest\(params\)/)
  assert.doesNotMatch(handler, /takeOwnFloorRecord|consultFloor|relayPermissionToOwner/, 'the handler only admits; the steps are in handlePermissionRequest')
  // The newcomer's deny bypasses the group routing, which may hold the same id.
  assert.match(handler, /denyNewcomer: \(\) =>\s*sendMcpNotification\(/)
})

test('server.ts numbers a group prompt in the same registry and routes its verdict only while it holds the id', () => {
  const mint = source.slice(source.indexOf('function reserveGroupPermissionRequestId('), source.indexOf('function approveGroupTool('))
  assert.match(mint, /permissionRequestIds\.claim\(id, 'group', fingerprint\)/)
  const group = source.slice(source.indexOf('function approveGroupTool('), source.indexOf('const groupLanes = new GroupLaneManager({'))
  assert.match(group, /groupPermissionVerdicts\.set\(params\.request_id, \{ reservation, verdict:/)
  assert.match(group, /permissionRequestIds\.release\(reservation\)/)
  assert.match(group, /const ownHandler = input\.level === 'full' \? handlePermissionRequest : null/)
  const step = source.slice(source.indexOf('function groupNotificationStep('), source.indexOf('const sendMcpNotification = mcp.notification.bind(mcp)'))
  assert.match(step, /permissionRequestIds\.holds\(route\.reservation\)/)
  assert.match(step, /permissionRequestIds\.collided\(params\.request_id\)/)
})
