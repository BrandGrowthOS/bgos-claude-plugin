import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserHost, ChromiumEngine, sweepPageFiles } from '../bin/hoai-browser-host.mjs'

test('a newly connected agent retires page output left by an earlier host', t => {
  const agentRoot = realpathSync(mkdtempSync(join(tmpdir(), 'page-cleanup-')))
  t.after(() => rmSync(agentRoot, { recursive: true, force: true }))
  const output = join(agentRoot, '42', 'browser-output', 'fixture', 'page.yml')
  mkdirSync(join(output, '..'), { recursive: true })
  writeFileSync(output, 'legacy fixture')
  const self: any = { agentRoot, _swept: new Set(), downloadStore: () => null }
  BrowserHost.prototype._agentsConnected.call(self, [42])
  assert.equal(existsSync(output), false, 'the connection must invoke cleanup')
  mkdirSync(join(output, '..'), { recursive: true })
  writeFileSync(output, 'new fixture')
  BrowserHost.prototype._agentsConnected.call(self, [42])
  assert.equal(existsSync(output), true, 'a reconnect must not erase active output')
})

for (const linked of ['output', 'agent', 'root', 'principal']) {
  test(`cleanup refuses a linked ${linked} and preserves the target`, t => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'page-link-')))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const root = join(home, 'agents'), outside = join(home, 'unrelated')
    mkdirSync(join(root, '42', 'browser-output'), { recursive: true })
    mkdirSync(join(outside, 'browser-output', 'k'), { recursive: true })
    mkdirSync(join(outside, '42', 'browser-output', 'k'), { recursive: true })
    writeFileSync(join(outside, '42', 'browser-output', 'k', 'keep.txt'), 'kept')
    writeFileSync(join(outside, 'keep.txt'), 'kept')
    writeFileSync(join(outside, 'browser-output', 'keep.txt'), 'kept')
    writeFileSync(join(outside, 'browser-output', 'k', 'keep.txt'), 'kept')
    const link = linked === 'output' ? join(root, '42', 'browser-output') : linked === 'agent' ? join(root, '42') : linked === 'root' ? root : join(root, '42', 'browser-output', 'k')
    rmSync(link, { recursive: true, force: true })
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const engine = new ChromiumEngine({ executable: 'unused', profileDir: join(root, '42', 'browser', 'k'), outputDir: join(root, '42', 'browser-output', 'k') })
    engine._clearPageFiles()
    sweepPageFiles({ agentRoot: root, assistantId: 42 })
    for (const file of ['keep.txt', 'browser-output/keep.txt', 'browser-output/k/keep.txt', '42/browser-output/k/keep.txt']) assert.equal(readFileSync(join(outside, file), 'utf8'), 'kept')
  })
}

test('cleanup unlinks nested links without visiting their targets and keeps downloads and other agents', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'page-nested-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const output = join(home, '42', 'browser-output'), kept = join(home, '43', 'downloads')
  mkdirSync(join(output, 'k', 'nested'), { recursive: true })
  mkdirSync(kept, { recursive: true })
  writeFileSync(join(kept, 'keep.txt'), 'kept')
  writeFileSync(join(output, 'k', 'nested', 'page.yml'), 'retired')
  symlinkSync(kept, join(output, 'k', 'nested', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(join(home, 'missing'), join(output, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
  sweepPageFiles({ agentRoot: home, assistantId: 42 })
  assert.deepEqual(readdirSync(output), [])
  assert.equal(readFileSync(join(kept, 'keep.txt'), 'utf8'), 'kept')
})

test('an engine refuses cleanup outside its own agent folder', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'page-outside-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const outside = join(home, '43', 'browser-output', 'k')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'keep.txt'), 'kept')
  const engine = new ChromiumEngine({ executable: 'unused', profileDir: join(home, '42', 'browser', 'k'), outputDir: outside })
  engine._clearPageFiles()
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'kept')
})
