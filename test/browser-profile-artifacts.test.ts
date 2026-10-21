import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { AgentProfileArtifacts } from '../lib/browser-profile-artifacts.mjs'
const require = createRequire(import.meta.url), { ProfileFileStaging } = require('../lib/browser-profile-core/profile-file-staging.js')
type Row = Record<string, any>
const check = () => true
async function fixture(t: { after: (callback: () => unknown) => void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hoai-artifact-')), area = { directory, assertPrivateDirectory: async (target: string) => { assert.ok(target === directory || target.startsWith(directory + path.sep)); const stat = await fs.lstat(target); assert.equal(stat.isSymbolicLink(), false); return true } }, staging = new ProfileFileStaging({ directory, scope: 'a'.repeat(64), assertPrivateDirectory: area.assertPrivateDirectory })
  const artifacts: any = new AgentProfileArtifacts({ area, staging })
  const capture = (args: Row = {}, execute = async (_name: string, value: Row) => { await fs.writeFile(value.filename, 'synthetic generated image'); return { content: [{ type: 'text', text: value.filename }] } }) => artifacts.capture({ name: 'browser_take_screenshot', args, assertCurrent: check, execute })
  const token = (result: Row) => JSON.parse(result.content.at(-1).text).artifactToken
  t.after(async () => { await artifacts.dispose().catch(() => {}); await staging.dispose().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }) })
  return { directory, artifacts, staging, capture, token }
}

test('ordinary jpg and jpeg basenames retain exact engine-inferred JPEG metadata', async t => {
  for (const filename of ['picture.jpg', 'picture.jpeg', 'PICTURE.JPG']) {
    const f = await fixture(t), value = await f.capture({ filename }); assert.equal(value.content.length, 1); assert.equal(value.content[0].text.includes(f.directory), false)
    await f.artifacts.consume(f.token(value), { assertCurrent: check, use: async (bytes: Buffer, name: string, type: string) => { assert.equal(bytes.toString(), 'synthetic generated image'); assert.equal(name, filename); assert.equal(type, 'image/jpeg') } })
  }
})

test('global busy admission does not spend an untouched original artifact capability', async t => {
  const a = await fixture(t), b = await fixture(t), c = await fixture(t), original = await a.capture(), artifactToken = a.token(original)
  let release!: () => void, started!: () => void, count = 0; const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
  const hold = async (_name: string, args: Row) => { if (++count === 2) started(); await gate; await fs.writeFile(args.filename, 'held artifact'); return { content: [] } }
  const first = b.capture({}, hold), second = c.capture({}, hold)
  try { await entered; await assert.rejects(a.artifacts.consume(artifactToken, { assertCurrent: check, use: async () => { throw Error('busy must not consume') } }), /io_capacity/) }
  finally { release(); await Promise.allSettled([first, second]) }
  assert.equal(await a.artifacts.consume(artifactToken, { assertCurrent: check, use: async (bytes: Buffer) => bytes.toString() }), 'synthetic generated image'); await assert.rejects(a.artifacts.consume(artifactToken, { assertCurrent: check, use: async () => {} }), /artifact_required/)
})
