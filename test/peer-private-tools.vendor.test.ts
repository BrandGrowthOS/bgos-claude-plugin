import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { BOARDS_TOOL_DECLS } from '../lib/boards-tools.js'
import { ARTIFACT_TOOL_DECLS } from '../lib/artifacts-tools.js'
import { VAULT_TOOL_DECLS } from '../lib/vault-tools.js'
import { PEER_PRIVATE_TOOL_NAMES, peerRefusalReport } from '../lib/peer-refusal-counter.mjs'

// TRUSTCOUNT2 (BGOS security review of the peer refusal count, finding 1): the tool names a refused peer request is
// counted under are ONE list, BGOS backend/src/peer-refusals/peer-private-tools.json, vendored here byte for byte as
// lib/peer-private-tools.json and pinned by lib/peer-private-tools.vendor.json. The backend counts only those names
// and its table's CHECK names the same ones; this daemon sends only those names. This file fails when the copy drifts
// from its pin, when a private tool this daemon gates is missing from the list, or when the list names a tool this
// daemon does not have.

const bytes = readFileSync(new URL('../lib/peer-private-tools.json', import.meta.url))
const pin = JSON.parse(readFileSync(new URL('../lib/peer-private-tools.vendor.json', import.meta.url), 'utf8'))
const doc = JSON.parse(bytes.toString('utf8')) as { schemaVersion: number, kinds: Record<string, string[]> }
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('the vendored list is the pinned bytes of the BGOS file', () => {
  assert.equal(pin.file, 'lib/peer-private-tools.json')
  assert.equal(pin.source, 'BGOS: backend/src/peer-refusals/peer-private-tools.json')
  assert.match(pin.sourceCommit, /^[0-9a-f]{40}$/)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256)
  // A local checkout audit, like the shim's: HOAI_PEER_TOOLS_SOURCE=<BGOS file> compares the bytes themselves.
  if (process.env.HOAI_PEER_TOOLS_SOURCE) assert.ok(bytes.equals(readFileSync(process.env.HOAI_PEER_TOOLS_SOURCE)), 'byte for byte')
})

test("every private tool this daemon declares and gates is on the list, under its kind, and the list names no other daemon tool", () => {
  // The gate's own predicate, sliced from server.ts, so a new gated prefix is seen here.
  const gate = /if \(req\.params\.name\.startsWith\('boards_'\) \|\| req\.params\.name\.startsWith\('artifact_'\) \|\| req\.params\.name\.startsWith\('vault_'\) \|\| \['schedule', 'list_schedules', 'cancel_schedule'\]\.includes\(req\.params\.name\)\) \{/
  assert.match(source, gate, 'the gate is the four families this test reads')
  const declared = [...BOARDS_TOOL_DECLS, ...ARTIFACT_TOOL_DECLS, ...VAULT_TOOL_DECLS].map((t: { name: string }) => t.name)
  for (const name of ['schedule', 'list_schedules', 'cancel_schedule']) assert.match(source, new RegExp(`name: '${name}'`))
  const kindOf = (name: string) => name.startsWith('boards_') ? 'boards' : name.startsWith('artifact_') ? 'artifacts' : name.startsWith('vault_') ? 'vault' : 'schedule'
  const gated = [...declared, 'schedule', 'list_schedules', 'cancel_schedule']
  for (const name of gated) assert.ok(doc.kinds[kindOf(name)]?.includes(name), `${name} is listed under ${kindOf(name)}`)
  const daemonListed = [...doc.kinds.boards, ...doc.kinds.artifacts, ...doc.kinds.schedule, ...doc.kinds.vault.filter((n) => !n.startsWith('hoai_'))]
  assert.deepEqual([...daemonListed].sort(), [...gated].sort())
})

test('the daemon builds a report only for a listed name', () => {
  const all = Object.values(doc.kinds).flat()
  assert.equal(PEER_PRIVATE_TOOL_NAMES.size, all.length)
  for (const tool of all) assert.ok(peerRefusalReport({ assistantId: 1050, delegate: '888', tool }), tool)
  for (const tool of ['boards_made_up', 'boards_probe0', 'browser_anything', 'vault_get', 'artifact_delete', 'hoai_browser_status', 'reply']) {
    assert.equal(peerRefusalReport({ assistantId: 1050, delegate: '888', tool }), null, tool)
  }
})
