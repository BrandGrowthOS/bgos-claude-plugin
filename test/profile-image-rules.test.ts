/**
 * The three rules set_profile_image keeps before anything leaves the computer
 * (board row 01a1b4fe, the plugin side of BGOS #4353):
 *
 *  1. Only on the owner's own ask: any other turn is refused, for the agent's
 *     own picture AND a group's, and nothing is read or sent.
 *  2. A group picture only as an admin agent of that group: the call names
 *     this agent (its own valid id, never one the model passes), goes to the
 *     group route only, and the server's admin refusal is the answer, with no
 *     fallback to any other route.
 *  3. Nothing but the image the agent's own image tool made: one regular
 *     image file or the base64 of one, sent as its bytes alone. A folder, a
 *     device or a pipe, text that is not base64, a web address or any other
 *     field never leaves the computer.
 *
 * Each refusal sits beside its positive control.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as tools from '../lib/profile-image-tools.ts'

const { PROFILE_IMAGE_NOT_OWNER_ASK, PROFILE_IMAGE_OWNER_ONLY, PROFILE_IMAGE_TYPE_REFUSAL, handleProfileImageTool, profileImageTurn } = tools
// Read through the namespace, so a refusal the module does not name yet fails its own test, not the whole file.
const named = tools as Record<string, unknown>
const PROFILE_IMAGE_BASE64_REFUSAL = named.PROFILE_IMAGE_BASE64_REFUSAL ?? 'PROFILE_IMAGE_BASE64_REFUSAL is not exported'
const PROFILE_IMAGE_NOT_FILE_REFUSAL = named.PROFILE_IMAGE_NOT_FILE_REFUSAL ?? 'PROFILE_IMAGE_NOT_FILE_REFUSAL is not exported'
const PROFILE_IMAGE_NO_AGENT_REFUSAL = named.PROFILE_IMAGE_NO_AGENT_REFUSAL ?? 'PROFILE_IMAGE_NO_AGENT_REFUSAL is not exported'

const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'
const ADMIN = 'user_other_admin'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])

type Call = { path: string; body: Record<string, unknown>; headers: Record<string, string> }

function harness(opts: { assistantId?: string | number; actingUserId?: string | null; headers?: Record<string, string>; error?: Error; files?: Record<string, Uint8Array>; realFs?: boolean } = {}) {
  const calls: Call[] = []
  const reads: string[] = []
  const files: Record<string, Uint8Array> = opts.files ?? { '/tmp/me.png': PNG }
  const deps: any = {
    assistantId: opts.assistantId ?? '42',
    ownerUserId: OWNER,
    actingUserId: opts.actingUserId === undefined ? OWNER : opts.actingUserId,
    privateHeaders: opts.headers ?? {},
    bgosPut: async (path: string, body: Record<string, unknown>, headers: Record<string, string>) => {
      calls.push({ path, body, headers })
      if (opts.error) throw opts.error
      return { ok: true }
    },
  }
  if (!opts.realFs) {
    deps.readBytes = async (p: string) => { reads.push(p); if (!(p in files)) throw new Error('ENOENT'); return files[p] }
    deps.fileSize = async (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p].length }
  }
  return { deps, calls, reads }
}

const call = (args: Record<string, unknown>, h: ReturnType<typeof harness>) => handleProfileImageTool('set_profile_image', args, h.deps)
const OWN = { path: '/tmp/me.png' }
const GROUP = { path: '/tmp/me.png', groupChatId: 6 }

/** A tracker whose current turn is `turn` (null: no verified turn), for profileImageTurn. */
const trackerOf = (turn: Record<string, unknown> | null) => ({ current: () => turn, onCall: () => false })
const turnFor = (turn: Record<string, unknown> | null) => { try { return profileImageTurn(trackerOf(turn), [], OWNER) } catch (err) { return (err as Error).message } }

// ── 1. Only on the owner's own ask ──────────────────────────────────────────

test("rule 1: the owner's own message and the owner's own tap are admitted (the controls)", () => {
  for (const fireKey of ['owner:101', 'tap:102', null]) {
    const turn = turnFor({ actingUserId: OWNER, chatId: 5, fireKey, emailBasis: null })
    assert.equal(typeof turn, 'object', String(fireKey))
    assert.deepEqual((turn as any).headers, {})
    assert.equal((turn as any).actingUserId, OWNER)
  }
})

test('rule 1: no verified turn, and every scheduled wake of the owner, are refused before the handler runs', () => {
  assert.equal(turnFor(null), PROFILE_IMAGE_NOT_OWNER_ASK)
  for (const fireKey of ['native:f1', 'n8n:act:7', 'scheduler:8']) {
    assert.equal(turnFor({ actingUserId: OWNER, chatId: 5, fireKey, emailBasis: null }), PROFILE_IMAGE_NOT_OWNER_ASK, fireKey)
  }
  assert.equal(turnFor({ actingUserId: OWNER, chatId: 5, fireKey: null, emailBasis: { kind: 'owner_task', id: '9' } }), PROFILE_IMAGE_NOT_OWNER_ASK)
})

test("rule 1: a share recipient's or another group admin's turn is refused for the agent's own picture AND a group's, before anything is read or sent", async () => {
  for (const person of [RECIPIENT, ADMIN]) {
    const turn = turnFor({ actingUserId: person, chatId: 6, fireKey: 'owner:200', emailBasis: null }) as any
    assert.deepEqual(turn.headers, { 'X-BGOS-Acting-User': person })
    for (const args of [OWN, GROUP]) {
      const h = harness({ actingUserId: turn.actingUserId, headers: turn.headers })
      const out = await call(args, h)
      assert.equal(out.isError, true)
      assert.equal(out.content[0].text, PROFILE_IMAGE_OWNER_ONLY)
      assert.deepEqual(h.calls, [], `${person} ${JSON.stringify(args)}`)
      assert.deepEqual(h.reads, [])
    }
  }
  // Control: the owner's own turn sends both.
  for (const args of [OWN, GROUP]) {
    const h = harness()
    assert.equal((await call(args, h)).isError, undefined)
    assert.equal(h.calls.length, 1)
  }
})

test('rule 1: a handler reached with no admitted turn refuses and sends nothing', async () => {
  for (const args of [OWN, GROUP]) {
    const h = harness({ actingUserId: null })
    const out = await call(args, h)
    assert.equal(out.content[0].text, PROFILE_IMAGE_NOT_OWNER_ASK)
    assert.deepEqual(h.calls, [])
    assert.deepEqual(h.reads, [])
  }
})

// ── 2. A group picture only as an admin agent of that group ─────────────────

test('rule 2: the group call names this agent only, on the group route only, with no acting header', async () => {
  const h = harness({ assistantId: '42' })
  await call(GROUP, h)
  assert.deepEqual(h.calls, [{ path: 'agent-profile-image/groups/6', body: { assistantId: 42, imageBase64: PNG.toString('base64') }, headers: {} }])
  // The model cannot name another agent as the caller.
  const other = harness()
  const out = await call({ ...GROUP, assistantId: 7 }, other)
  assert.equal(out.isError, true)
  assert.deepEqual(other.calls, [])
})

test("rule 2: the server's refusal of a non admin agent is the answer: one call, no fallback to the agent's own picture", async () => {
  const msg = 'PUT 403: This agent is not an admin agent of this group.'
  const h = harness({ error: new Error(msg) })
  const out = await call(GROUP, h)
  assert.equal(out.isError, true)
  assert.equal(out.content[0].text, msg)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].path, 'agent-profile-image/groups/6')
})

test('rule 2: with no valid agent id of its own, nothing is read or sent, for a group or its own picture; a valid id is the control', async () => {
  for (const assistantId of ['', 'abc', '0', '-3', '1.5', '9007199254740993']) {
    for (const args of [OWN, GROUP]) {
      const h = harness({ assistantId })
      const out = await call(args, h)
      assert.equal(out.isError, true, `${assistantId} ${JSON.stringify(args)}`)
      assert.equal(out.content[0].text, PROFILE_IMAGE_NO_AGENT_REFUSAL)
      assert.deepEqual(h.calls, [])
      assert.deepEqual(h.reads, [])
    }
  }
  const h = harness({ assistantId: 42 })
  assert.equal((await call(GROUP, h)).isError, undefined)
  assert.equal(h.calls[0].body.assistantId, 42)
})

// ── 3. Nothing but the image ────────────────────────────────────────────────

function scratch(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-profile-image-rules-'))
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()))); rmSync(dir, { recursive: true, force: true }) })
  return dir
}

test('rule 3: a real image file on disk is sent as its bytes alone (the control for the folder, device and pipe cases)', async (t) => {
  const dir = scratch(t)
  writeFileSync(join(dir, 'me.png'), PNG)
  const h = harness({ realFs: true })
  const out = await call({ path: join(dir, 'me.png') }, h)
  assert.equal(out.isError, undefined)
  assert.deepEqual(h.calls, [{ path: 'agent-profile-image/agents/42', body: { imageBase64: PNG.toString('base64') }, headers: {} }])
})

test('rule 3: a folder or a device is refused as not a file, and nothing is sent', async (t) => {
  const dir = scratch(t)
  for (const path of [dir, '/dev/null']) {
    const h = harness({ realFs: true })
    const out = await call({ path }, h)
    assert.equal(out.isError, true, path)
    assert.equal(out.content[0].text, PROFILE_IMAGE_NOT_FILE_REFUSAL, path)
    assert.deepEqual(h.calls, [])
  }
})

test('rule 3: a named pipe is refused at once, without waiting for a writer, and nothing is sent', { skip: process.platform === 'win32' }, async (t) => {
  const dir = scratch(t)
  const fifo = join(dir, 'me.png')
  execFileSync('mkfifo', [fifo])
  const h = harness({ realFs: true })
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'hung'>((done) => { timer = setTimeout(() => done('hung'), 2000) })
  const out = await Promise.race([call({ path: fifo }, h), late])
  clearTimeout(timer)
  if (out === 'hung') {
    // Release a reader blocked on the pipe, so the failure is reported instead of the process hanging.
    const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => null)
    await writer?.close()
  }
  assert.notEqual(out, 'hung', 'set_profile_image waited on a named pipe')
  assert.equal((out as any).content[0].text, PROFILE_IMAGE_NOT_FILE_REFUSAL)
  assert.deepEqual(h.calls, [])
})

test('rule 3: imageBase64 with anything but base64 in it is refused and never sent; the same image as clean, wrapped or data URL base64 is the control', async () => {
  const clean = PNG.toString('base64')
  for (const bad of [`${clean}%%%`, `${clean.slice(0, 8)}<script>${clean.slice(8)}`, `${clean}?secret=1`, 'https://example.com/me.png']) {
    const h = harness()
    const out = await call({ imageBase64: bad }, h)
    assert.equal(out.isError, true, bad)
    assert.ok([PROFILE_IMAGE_BASE64_REFUSAL, PROFILE_IMAGE_TYPE_REFUSAL].includes(out.content[0].text), out.content[0].text)
    assert.deepEqual(h.calls, [], bad)
  }
  for (const good of [clean, clean.replace(/(.{20})/g, '$1\r\n'), `data:image/png;base64,${clean}`]) {
    const h = harness()
    const out = await call({ imageBase64: good }, h)
    assert.equal(out.isError, undefined, good)
    assert.deepEqual(h.calls[0].body, { imageBase64: clean })
  }
})

test('rule 3: a web address as path is never fetched or sent; only the two image fields reach the wire', async () => {
  const h = harness()
  const out = await call({ path: 'https://example.com/me.png' }, h)
  assert.equal(out.isError, true)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.reads, [])
  for (const extra of [{ uploadKey: 'uploads/u/x.png' }, { avatarUrl: 'https://example.com/x.png' }, { name: 'New name' }, { caption: 'hi' }]) {
    const x = harness()
    const res = await call({ ...OWN, ...extra }, x)
    assert.equal(res.isError, true, JSON.stringify(extra))
    assert.deepEqual(x.calls, [], JSON.stringify(extra))
  }
  // Control: own and group bodies carry exactly the image (and, for a group, this agent).
  const own = harness()
  await call(OWN, own)
  assert.deepEqual(Object.keys(own.calls[0].body), ['imageBase64'])
  const group = harness()
  await call(GROUP, group)
  assert.deepEqual(Object.keys(group.calls[0].body).sort(), ['assistantId', 'imageBase64'])
})
