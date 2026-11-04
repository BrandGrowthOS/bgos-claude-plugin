import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserHost } from '../bin/hoai-browser-host.mjs'

test('a newly connected agent retires page output left by an earlier host', t => {
  const agentRoot = mkdtempSync(join(tmpdir(), 'page-cleanup-'))
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
