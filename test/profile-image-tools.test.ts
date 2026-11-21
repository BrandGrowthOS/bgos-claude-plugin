import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PROFILE_IMAGE_MAX_BYTES,
  PROFILE_IMAGE_OWNER_ONLY,
  PROFILE_IMAGE_SIZE_REFUSAL,
  PROFILE_IMAGE_SOURCE_REFUSAL,
  PROFILE_IMAGE_TOOL_DECLS,
  PROFILE_IMAGE_TYPE_REFUSAL,
  handleProfileImageTool,
  sniffImageType,
} from '../lib/profile-image-tools.ts'
import { PRIVATE_TOOL_MATCHER } from '../lib/private-turn.mjs'

// Each refusal sits beside its positive control: the same call with the one
// wrong fact put right, which goes through.

const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')

function harness(files: Record<string, Uint8Array> = {}, opts: { actingUserId?: string; headers?: Record<string, string>; answer?: unknown; error?: Error } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const reads: string[] = []
  const deps = {
    assistantId: '42',
    ownerUserId: OWNER,
    actingUserId: opts.actingUserId ?? OWNER,
    privateHeaders: opts.headers ?? {},
    bgosPut: async (path: string, body: Record<string, unknown>, headers: Record<string, string>) => {
      calls.push({ path, body, headers })
      if (opts.error) throw opts.error
      return opts.answer ?? { avatarUrl: 'https://api.example.test/api/v1/files/avatar/uploads/u/x.png' }
    },
    readBytes: async (p: string) => { reads.push(p); if (!(p in files)) throw new Error('ENOENT'); return files[p] },
    fileSize: async (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p].length },
  }
  return { deps, calls, reads }
}

test('sniffs the four accepted kinds and nothing else', () => {
  assert.equal(sniffImageType(PNG), 'image/png')
  assert.equal(sniffImageType(JPEG), 'image/jpeg')
  assert.equal(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp')
  assert.equal(sniffImageType(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(sniffImageType(SVG), null)
  assert.equal(sniffImageType(new Uint8Array()), null)
})

test("the owner's ask: a local file is sent as base64 to the agent's own route", async () => {
  const h = harness({ '/tmp/me.png': PNG })
  const out = await handleProfileImageTool('set_profile_image', { path: '/tmp/me.png' }, h.deps)
  assert.equal(out.isError, undefined)
  assert.deepEqual(h.calls, [{ path: 'agent-profile-image/agents/42', body: { imageBase64: PNG.toString('base64') }, headers: {} }])
  assert.equal(JSON.parse(out.content[0].text).target, 'agent')
})

test("a share recipient's turn is refused before the file is even read; the owner's turn is the control", async () => {
  for (const opts of [{ actingUserId: RECIPIENT, headers: { 'X-BGOS-Acting-User': RECIPIENT } }, { actingUserId: RECIPIENT }, { headers: { 'X-BGOS-Acting-User': RECIPIENT } }]) {
    const h = harness({ '/tmp/me.png': PNG }, opts)
    const out = await handleProfileImageTool('set_profile_image', { path: '/tmp/me.png' }, h.deps)
    assert.equal(out.isError, true)
    assert.equal(out.content[0].text, PROFILE_IMAGE_OWNER_ONLY)
    assert.deepEqual(h.calls, [])
    assert.deepEqual(h.reads, [])
  }
  const owner = harness({ '/tmp/me.png': PNG })
  assert.equal((await handleProfileImageTool('set_profile_image', { path: '/tmp/me.png' }, owner.deps)).isError, undefined)
})

test('a group picture goes to the group route with this agent as the caller', async () => {
  const h = harness({}, { answer: { chatId: 6, imageUrl: 'x' } })
  const out = await handleProfileImageTool('set_profile_image', { imageBase64: PNG.toString('base64'), groupChatId: 6 }, h.deps)
  assert.equal(out.isError, undefined)
  assert.deepEqual(h.calls, [{ path: 'agent-profile-image/groups/6', body: { assistantId: 42, imageBase64: PNG.toString('base64') }, headers: {} }])
})

test("the backend's refusal (a non admin agent) passes through verbatim", async () => {
  const msg = 'PUT 403: Only an admin agent of this group can change its picture.'
  const h = harness({}, { error: new Error(msg) })
  const out = await handleProfileImageTool('set_profile_image', { imageBase64: PNG.toString('base64'), groupChatId: 7 }, h.deps)
  assert.equal(out.isError, true)
  assert.equal(out.content[0].text, msg)
})

test('a file that is not an image is refused and never sent; a JPEG is the control', async () => {
  const h = harness({ '/tmp/a.png': SVG, '/tmp/b.jpg': JPEG })
  const bad = await handleProfileImageTool('set_profile_image', { path: '/tmp/a.png' }, h.deps)
  assert.equal(bad.content[0].text, PROFILE_IMAGE_TYPE_REFUSAL)
  assert.deepEqual(h.calls, [])
  const good = await handleProfileImageTool('set_profile_image', { path: '/tmp/b.jpg' }, h.deps)
  assert.equal(good.isError, undefined)
  assert.equal(h.calls.length, 1)
})

test('an image over 5 MB is refused from its size, before it is read; exactly 5 MB is the control', async () => {
  const exact = Buffer.concat([PNG, Buffer.alloc(PROFILE_IMAGE_MAX_BYTES - PNG.length)])
  const over = Buffer.concat([exact, Buffer.alloc(1)])
  const h = harness({ '/tmp/big.png': over, '/tmp/ok.png': exact })
  const bad = await handleProfileImageTool('set_profile_image', { path: '/tmp/big.png' }, h.deps)
  assert.equal(bad.content[0].text, PROFILE_IMAGE_SIZE_REFUSAL)
  assert.deepEqual(h.reads, [])
  assert.equal((await handleProfileImageTool('set_profile_image', { path: '/tmp/ok.png' }, h.deps)).isError, undefined)
  const b64 = await handleProfileImageTool('set_profile_image', { imageBase64: over.toString('base64') }, h.deps)
  assert.equal(b64.content[0].text, PROFILE_IMAGE_SIZE_REFUSAL)
})

test('exactly one source; a relative path and an unknown argument are refused', async () => {
  const h = harness({ '/tmp/me.png': PNG })
  assert.equal((await handleProfileImageTool('set_profile_image', {}, h.deps)).content[0].text, PROFILE_IMAGE_SOURCE_REFUSAL)
  assert.equal((await handleProfileImageTool('set_profile_image', { path: '/tmp/me.png', imageBase64: 'eA==' }, h.deps)).content[0].text, PROFILE_IMAGE_SOURCE_REFUSAL)
  assert.match((await handleProfileImageTool('set_profile_image', { path: 'me.png' }, h.deps)).content[0].text, /absolute/)
  assert.match((await handleProfileImageTool('set_profile_image', { path: '/tmp/me.png', assistantId: 9 }, h.deps)).content[0].text, /Invalid arguments/)
  assert.deepEqual(h.calls, [])
})

test('the declaration tells the owner-ask rule, and the tool is gated in the server and in the helper guard', () => {
  const [decl] = PROFILE_IMAGE_TOOL_DECLS
  assert.equal(decl.name, 'set_profile_image')
  assert.match(decl.description, /ONLY when your owner asks/)
  assert.match(decl.description, /only when your owner asks you there/)
  assert.match(decl.description, /HOAI does not make the image/)
  assert.ok(new RegExp(PRIVATE_TOOL_MATCHER).test('mcp__bgos__set_profile_image'))
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(server, /'complete_mission', 'set_profile_image'\]/, 'not turn aware')
  assert.match(server, /privateCall = profileImageTurn\(privateTurns, PRIVATE_MARKER_PATHS, USER_ID\)/)
  assert.match(server, /\.\.\.PROFILE_IMAGE_TOOL_DECLS,/)
})
