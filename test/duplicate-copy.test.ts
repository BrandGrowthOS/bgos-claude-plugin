/**
 * The plugin's SECOND copy stands aside when the session already runs the
 * checkout as its channel (kc-server, 2026-10-13: agents 863, 867, 871, 872,
 * 873, 876 each started two daemons for one pairing).
 *
 * What these pin:
 *   - the decision (lib/duplicate-copy.mjs): a duplicate only when the copy is
 *     the marketplace install, its own spec is NOT loaded, server:bgos IS, and
 *     the folder's .mcp.json registers a real checkout elsewhere; every doubt
 *     keeps the daemon as it was;
 *   - what the session can read from it, over a real in-memory MCP client: ONE
 *     tool, no claude/channel capability, so the checkout stays the only
 *     channel the session can push into;
 *   - the probe of the session's channels from the process table;
 *   - that server.ts asks FIRST, before it takes the pairing lock, writes a
 *     supervisor record or starts a poll.
 *
 * Run: npx tsx --test test/duplicate-copy.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { probeSessionChannelSpecs, specMatches } from '../lib/channel-presence.ts'
import { CLONE_SPEC, decideDuplicateCopy, findSiblingClone } from '../lib/duplicate-copy.mjs'
import {
  DUPLICATE_COPY_TOOL_NAME,
  PAIR_REQUIRED_TOOL_NAME,
  createDuplicateCopyServer,
  duplicateCopyInstructions,
  serveDuplicateCopy,
} from '../lib/pair-required-server.mjs'
import { linkFolder } from './helpers/links.ts'

const OWN_SPEC = 'plugin:hoai@hoai'
const sibling = { root: '/home/karim/bgos-claude-plugin' }
const decide = (over: Record<string, unknown> = {}) =>
  decideDuplicateCopy({
    installMethod: 'marketplace',
    ownSpec: OWN_SPEC,
    sessionSpecs: [CLONE_SPEC],
    sibling,
    specMatches,
    ...over,
  } as Parameters<typeof decideDuplicateCopy>[0])

test('the kc-server shape is a duplicate: marketplace copy, session loads server:bgos only, a checkout registered', () => {
  const verdict = decide()
  assert.equal(verdict.duplicate, true)
  assert.match(verdict.reason, /server:bgos/)
  assert.match(verdict.reason, /\/home\/karim\/bgos-claude-plugin/)
})

test('every doubt keeps the daemon: it is a duplicate only when ALL the proofs hold', () => {
  const kept = (over: Record<string, unknown>) => assert.equal(decide(over).duplicate, false, JSON.stringify(over))
  kept({ installMethod: 'clone' }) // the checkout itself is never the duplicate
  kept({ installMethod: null })
  kept({ sessionSpecs: null }) // channels unknown (Windows, no claude ancestor, hidden argv)
  kept({ sessionSpecs: undefined })
  kept({ sessionSpecs: [] }) // the session loads no channel: nothing proves the checkout is one
  kept({ sessionSpecs: ['server:other'] }) // some other server: cannot tell
  kept({ sessionSpecs: [OWN_SPEC] }) // this copy IS the channel
  kept({ sessionSpecs: [CLONE_SPEC, OWN_SPEC] }) // both are channels: leave the lock to decide
  kept({ sessionSpecs: ['plugin:hoai'], sibling }) // marketplace-less spelling of our own spec
  kept({ sibling: null }) // no checkout registered in this folder
  kept({ sibling: undefined })
})

function folder(mcp: unknown, withServer = true) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-dup-'))
  const cwd = join(root, 'agent')
  const checkout = join(root, 'bgos-claude-plugin')
  const cache = join(root, 'cache', 'hoai', 'hoai', '0.68.5')
  for (const dir of [cwd, checkout, cache]) mkdirSync(dir, { recursive: true })
  if (withServer) writeFileSync(join(checkout, 'server.ts'), '// stand-in\n')
  if (mcp !== undefined) writeFileSync(join(cwd, '.mcp.json'), typeof mcp === 'string' ? mcp : JSON.stringify(mcp))
  return { root, cwd, checkout, cache }
}
const registers = (serverTs: string) => ({ mcpServers: { bgos: { command: 'bun', args: [serverTs] } } })

test('findSiblingClone reads the checkout the folder registers as its bgos server', () => {
  const f = folder(undefined)
  writeFileSync(join(f.cwd, '.mcp.json'), JSON.stringify(registers(join(f.checkout, 'server.ts'))))
  const found = findSiblingClone({ cwd: f.cwd, ownRoot: f.cache })
  assert.ok(found)
  assert.equal(found.serverTs, join(f.checkout, 'server.ts'))
})

test('a relative server.ts path resolves against the folder, and a symlinked checkout counts as the same real directory', () => {
  const f = folder(undefined)
  writeFileSync(join(f.cwd, '.mcp.json'), JSON.stringify(registers('../bgos-claude-plugin/server.ts')))
  assert.ok(findSiblingClone({ cwd: f.cwd, ownRoot: f.cache }))
  // The "checkout" is this very copy through a link: not a sibling.
  const alias = join(f.root, 'alias')
  linkFolder(f.cache, alias)
  writeFileSync(join(f.cache, 'server.ts'), '// own\n')
  writeFileSync(join(f.cwd, '.mcp.json'), JSON.stringify(registers(join(alias, 'server.ts'))))
  assert.equal(findSiblingClone({ cwd: f.cwd, ownRoot: f.cache }), null)
})

test('no sibling when there is no .mcp.json, it is not JSON, it names no bgos server, or its server.ts is gone', () => {
  const none = folder(undefined)
  assert.equal(findSiblingClone({ cwd: none.cwd, ownRoot: none.cache }), null)
  const junk = folder('{not json')
  assert.equal(findSiblingClone({ cwd: junk.cwd, ownRoot: junk.cache }), null)
  const other = folder({ mcpServers: { other: { args: ['x/server.ts'] } } })
  assert.equal(findSiblingClone({ cwd: other.cwd, ownRoot: other.cache }), null)
  const gone = folder(undefined, false)
  writeFileSync(join(gone.cwd, '.mcp.json'), JSON.stringify(registers(join(gone.checkout, 'server.ts'))))
  assert.equal(findSiblingClone({ cwd: gone.cwd, ownRoot: gone.cache }), null, 'a checkout whose server.ts is gone is no channel: this copy keeps running')
  assert.equal(findSiblingClone({ cwd: '', ownRoot: none.cache }), null)
})

// -- what the session reads ---------------------------------------------------------------------

async function connected() {
  const server = createDuplicateCopyServer({ reason: 'the session loads server:bgos from /home/karim/bgos-claude-plugin' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'probe-client', version: '1.0.0' }, { capabilities: {} })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, server }
}

test('the duplicate answers initialize as a notice: tools only, NO channel capability, no instructions', async () => {
  const { client, server } = await connected()
  try {
    const caps = client.getServerCapabilities() as Record<string, unknown>
    assert.ok(caps.tools)
    assert.equal(caps.experimental, undefined, 'declaring claude/channel would advertise a second channel the session never registered')
    assert.equal(client.getInstructions(), undefined, 'nothing goes into the session prompt')
  } finally {
    await client.close()
    await server.close()
  }
})

test('it lists EXACTLY one tool, names the server to use, and refuses every other name with the same explanation', async () => {
  const { client, server } = await connected()
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((t) => t.name), [DUPLICATE_COPY_TOOL_NAME])
    assert.match(listed.tools[0]!.description ?? '', /mcp__bgos__/)
    const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '')
    const called = await client.callTool({ name: DUPLICATE_COPY_TOOL_NAME, arguments: {} })
    assert.match(text(called), /Use the tools of the `bgos` server/)
    assert.match(text(called), /mcp__plugin_hoai_bgos__/)
    const other = await client.callTool({ name: 'schedule', arguments: {} })
    assert.equal((other as { isError?: boolean }).isError, true)
    assert.match(text(other), /publishes only hoai_duplicate_copy/)
    assert.doesNotMatch(listed.tools.map((t) => t.name).join(), new RegExp(PAIR_REQUIRED_TOOL_NAME))
  } finally {
    await client.close()
    await server.close()
  }
})

test('serveDuplicateCopy says it stands aside, serves until the host goes, and ends with stdin', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const lines: string[] = []
  const stdin = { destroyed: false, once: (_e: string, f: () => void) => setTimeout(f, 20) } as unknown as NodeJS.ReadStream
  const served = serveDuplicateCopy({ reason: 'x', transport: serverTransport, stdin, log: (l: string) => lines.push(l) })
  const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  assert.equal(await served, true)
  assert.match(lines.join('\n'), /DUPLICATE copy/)
  assert.match(lines.join('\n'), /No lock is taken and no channel is declared/)
  assert.match(duplicateCopyInstructions('why'), /Why this copy stands aside: why/)
})

// -- the process table ---------------------------------------------------------------------------

type Exec = (file: string, args: string[]) => { code: number; stdout: string; stderr: string }
function table(rows: Record<number, { ppid: number; command: string }>): Exec {
  return (file, args) => {
    const pid = Number(args[args.length - 1])
    const row = rows[pid]
    if (!row) return { code: 1, stdout: '', stderr: '' }
    if (args.includes('ppid=')) return { code: 0, stdout: `${row.ppid}\n`, stderr: '' }
    if (args.includes('command=')) return { code: 0, stdout: `${row.command}\n`, stderr: '' }
    return { code: 1, stdout: '', stderr: '' }
  }
}

test('probeSessionChannelSpecs reads the specs off the claude ancestor, and answers null where it cannot prove them', () => {
  const claude = '/home/karim/.local/bin/claude --dangerously-skip-permissions --dangerously-load-development-channels server:bgos'
  const rows = { 300: { ppid: 200, command: 'bun server.ts' }, 200: { ppid: 100, command: claude }, 100: { ppid: 1, command: 'node hoai-core' } }
  assert.deepEqual(probeSessionChannelSpecs({ platform: 'linux', ownPid: 300, execSync: table(rows) }), ['server:bgos'])
  // The plugin copy's own session names plugin:hoai@hoai: that is a list too.
  const both = { ...rows, 200: { ppid: 100, command: `${claude} plugin:hoai@hoai` } }
  assert.deepEqual(probeSessionChannelSpecs({ platform: 'linux', ownPid: 300, execSync: table(both) }), ['server:bgos', 'plugin:hoai@hoai'])
  // No channel flag at all is a real, empty answer.
  const bare = { ...rows, 200: { ppid: 100, command: '/home/karim/.local/bin/claude --dangerously-skip-permissions' } }
  assert.deepEqual(probeSessionChannelSpecs({ platform: 'linux', ownPid: 300, execSync: table(bare) }), [])
  // A bare `claude` (a rewritten process title), no claude above, Windows: unknown.
  assert.equal(probeSessionChannelSpecs({ platform: 'linux', ownPid: 300, execSync: table({ ...rows, 200: { ppid: 100, command: 'claude' } }) }), null)
  assert.equal(probeSessionChannelSpecs({ platform: 'linux', ownPid: 300, execSync: table({ 300: { ppid: 1, command: 'bun server.ts' } }) }), null)
  assert.equal(probeSessionChannelSpecs({ platform: 'win32', ownPid: 300, execSync: table(rows) }), null)
})

// -- server.ts ---------------------------------------------------------------------------------

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('server.ts asks the duplicate question FIRST in main(), and a duplicate exits before the lock, the supervisor record and any poll', () => {
  const main = serverSource.slice(serverSource.indexOf('async function main(): Promise<void> {'))
  const ask = main.indexOf('decideDuplicateCopy({')
  assert.ok(ask > 0, 'main() must ask decideDuplicateCopy')
  const exit = main.indexOf('process.exit(served ? 0 : 1)', ask)
  assert.ok(exit > ask, 'a duplicate serves its notice and exits')
  const before = main.slice(0, exit)
  for (const later of ['initializeSelfUpdater(', 'writeSupervisorRecordAtBoot()', 'acquirePairingLock(', 'armDelivery(', 'mcp.connect(transport)']) {
    assert.equal(before.includes(later), false, `${later} must come after the duplicate exit`)
  }
  assert.match(main.slice(ask, exit), /INSTALL_METHOD === 'marketplace'/)
  assert.match(main.slice(ask, exit), /serveDuplicateCopy\(/)
})

test('a clone is never asked to stand aside: both probes are gated on the marketplace install', () => {
  const main = serverSource.slice(serverSource.indexOf('async function main(): Promise<void> {'))
  const block = main.slice(main.indexOf('decideDuplicateCopy({'), main.indexOf('process.exit(served ? 0 : 1)'))
  // The method itself, the session probe and the sibling lookup: three gates on one install method.
  assert.equal((block.match(/INSTALL_METHOD === 'marketplace'/g) ?? []).length, 2)
  assert.match(block, /installMethod: INSTALL_METHOD/)
})
