import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import ts from 'typescript'
import { main as hook } from '../bin/hoai-floor-hook.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import * as relay from '../lib/permission-relay.ts'
import { takePermissionInput, writePermissionInput, PERMISSION_INPUT_MAX_BYTES, PERMISSION_INPUT_MAX_RECORDS,
  PERMISSION_INPUT_TTL_MS } from '../lib/permission-input.mjs'

const fixture = JSON.parse(readFileSync(new URL('../docs/evidence/2026-11-09-permhidden/payload.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf('mcp.setNotificationHandler(PermissionRequestSchema,'), source.indexOf('\n/**\n * The interactive path, whole:'))
const interactive = source.slice(source.indexOf('function relayPermissionToOwner('), source.indexOf('\n/**\n * A request the hard floor matched'))
const folded = (s: string) => s.replace(/[\u200b\u2060\u202e\u2028]/g, ' ')

async function postCard(root: string, preview: string, sessionId = 'session-probe') {
  const inputModule = await import('../lib/permission-input.mjs').catch(() => null)
  let receive!: (request: unknown) => Promise<void>
  let body: any
  const bindings = {
    ...relay, PermissionRequestSchema: {},
    mcp: { setNotificationHandler: (_schema: unknown, fn: typeof receive) => { receive = fn }, notification: async () => {} },
    log: () => {}, AUTH: { mode: 'pairing', pairingToken: '' }, outboundFileCtx: () => ({}),
    emailSendPreflight: () => null, takeOwnFloorRecord: () => null,
    planFloorRequest: () => ({ action: 'ask' }), AUTO_APPROVE: false,
    // The actual filesystem reader, bound as it is in the daemon.
    takeOwnPermissionInput: (toolName: string, inputPreview: string | undefined) => inputModule?.takePermissionInput({
      root, keys: [floorKey(root)], sessionId, toolName, inputPreview,
    }) ?? inputPreview,
    updateDrainMode: false, trackMessageOperation: (fn: () => unknown) => fn(),
    isOwnSendingTool: () => false, pickPermissionChat: () => '1', monitoredChatIds: ['1'],
    hookRailRefusedChats: new Set(), a2aRouteRefusedChats: new Set(), permissionCardRefusedChats: new Set(),
    chatOwnership: {}, USER_ID: 'user_owner', pendingPermissions: new Map(),
    bgosPost: async (_path: string, posted: unknown) => { body = JSON.parse(JSON.stringify(posted)); return { id: 1 } },
    waitForVerdict: async () => 'deny',
  }
  const js = ts.transpileModule(`${interactive}\n${handler}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  new Function(...Object.keys(bindings), js)(...Object.values(bindings))
  await receive({ params: { request_id: 'abcde', tool_name: 'Bash', description: 'Synthetic probe', input_preview: preview } })
  assert.ok(body, 'the real relay posted a request body')
  return body
}

async function record(root: string, command = fixture.hook.tool_input.command, toolUseId = 'toolu_probe') {
  const payload = { ...fixture.hook, session_id: 'session-probe', cwd: root, tool_use_id: toolUseId,
    tool_input: { ...fixture.hook.tool_input, command } }
  assert.equal(await hook({ stdin: Readable.from([Buffer.from(JSON.stringify(payload))]), env: {}, stateRoot: root,
    write: async () => {} }), '', 'unlisted Bash still prints nothing')
}

test('real recorded PreToolUse input reaches the posted card byte for byte despite the CLI preview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'permhidden-'))
  try {
    markFloorAttached({ root, folders: [root], pid: process.pid })
    const command = fixture.model_command
    assert.equal(fixture.hook.tool_input.command, command)
    for (const [char, count] of [['\u200b', 1], ['\u2060', 1], ['\u202e', 1], ['\u2028', 60]] as const) {
      assert.equal(command.split(char).length - 1, count)
    }
    await record(root)
    const preview = JSON.stringify({ command: folded(command), description: 'Synthetic hidden character probe' }, null, 2)
    const body = await postCard(root, preview)
    const actual = JSON.parse(body.approvalMeta.tool).command
    assert.deepEqual(Buffer.from(actual), Buffer.from(command), 'all 227 UTF-8 bytes must reach the request body')
    assert.equal((await postCard(root, preview)).approvalMeta.tool, preview, 'record consumed once')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('no hook input falls back to input_preview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'permhidden-'))
  try {
    const preview = JSON.stringify({ command: 'echo fallback' })
    assert.equal((await postCard(root, preview)).approvalMeta.tool, preview)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a different session, redaction, malformed or elided preview never borrows raw input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'permhidden-'))
  try {
    markFloorAttached({ root, folders: [root], pid: process.pid })
    await record(root)
    const preview = JSON.stringify({ command: folded(fixture.model_command) })
    assert.equal((await postCard(root, preview, 'session-other')).approvalMeta.tool, preview)
    for (const input of [JSON.stringify({ command: 'printf [REDACTED]' }), '{"command":"cut',
      JSON.stringify({ command: 'printf ⋯ 63 code points elided ⋯ omega' }), JSON.stringify({ command: 'echo unrelated' })]) {
      assert.equal((await postCard(root, input)).approvalMeta.tool, input)
    }
    assert.equal(JSON.parse((await postCard(root, preview)).approvalMeta.tool).command, fixture.model_command,
      'unmatched records remain available to their own request')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('parallel commands with the same folded preview fall back instead of guessing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'permhidden-'))
  try {
    markFloorAttached({ root, folders: [root], pid: process.pid })
    await record(root)
    await record(root, folded(fixture.model_command), 'toolu_plain_twin')
    const preview = JSON.stringify({ command: folded(fixture.model_command) })
    assert.equal((await postCard(root, preview)).approvalMeta.tool, preview)
    assert.equal((await postCard(root, preview)).approvalMeta.tool, preview, 'neither twin is replayed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('raw leading and trailing line separators survive JSON transport and the card builder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'permhidden-'))
  try {
    markFloorAttached({ root, folders: [root], pid: process.pid })
    const command = `\u2028\u2028${fixture.model_command}\u2028\u2028`
    await record(root, command)
    const preview = JSON.stringify({ command: folded(command).replace(/\s+/g, ' ').trim() })
    assert.deepEqual(Buffer.from(JSON.parse((await postCard(root, preview)).approvalMeta.tool).command), Buffer.from(command))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('hook copies are private, bounded, expire, and are ignored outside their session and tool', () => {
  const root = mkdtempSync(join(tmpdir(), 'permhidden-'))
  const key = floorKey(root)
  const dir = join(root, 'permission-input', key)
  const payload = { ...fixture.hook, session_id: 'session-probe' }
  const preview = JSON.stringify({ command: folded(fixture.model_command) })
  const take = (overrides = {}) => takePermissionInput({ root, keys: [key], toolName: 'Bash', sessionId: 'session-probe',
    inputPreview: preview, now: 1000, ...overrides })
  try {
    writePermissionInput({ root, key, payload, now: 1000 })
    if (process.platform !== 'win32') {
      assert.equal(statSync(dir).mode & 0o777, 0o700)
      assert.equal(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777, 0o600)
    }
    assert.equal(take({ sessionId: null }), preview)
    assert.equal(take({ toolName: 'PowerShell' }), preview)
    assert.equal(take({ now: 1000 + PERMISSION_INPUT_TTL_MS + 1 }), preview)
    assert.equal(readdirSync(dir).length, 0)
    for (let i = 0; i < PERMISSION_INPUT_MAX_RECORDS + 4; i++) {
      writePermissionInput({ root, key, payload: { ...payload, tool_use_id: `toolu_${i}` }, now: 1000 })
    }
    assert.equal(readdirSync(dir).length, PERMISSION_INPUT_MAX_RECORDS)
    for (const path of readdirSync(dir)) rmSync(join(dir, path))
    writePermissionInput({ root, key, payload: { ...payload, tool_input: { command: 'x'.repeat(PERMISSION_INPUT_MAX_BYTES + 1) } }, now: 1000 })
    assert.equal(readdirSync(dir).length, 0)
    writeFileSync(join(dir, `${'a'.repeat(64)}.json`), '{bad')
    assert.equal(take(), preview)
    assert.equal(readdirSync(dir).length, 0, 'bad records are swept')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an unattached hook writes no command copy and a storage failure keeps the floor ask', async () => {
  const root = mkdtempSync(join(tmpdir(), 'permhidden-'))
  try {
    await record(root)
    assert.deepEqual(readdirSync(root), [], 'ordinary sessions retain nothing')
    markFloorAttached({ root, folders: [root], pid: process.pid })
    writeFileSync(join(root, 'permission-input'), 'cannot create a folder here')
    const payload = { ...fixture.hook, session_id: 'session-probe', cwd: root, tool_input: { command: 'rm -rf build' } }
    const out = await hook({ stdin: Readable.from([Buffer.from(JSON.stringify(payload))]), env: {}, stateRoot: root, write: async () => {} })
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'ask')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the daemon binds restored input to its admitted session and carries it through floor routes', () => {
  const own = source.slice(source.indexOf('function takeOwnPermissionInput('), source.indexOf('\n/**', source.indexOf('function takeOwnPermissionInput(')))
  assert.match(own, /sessionId: hookIntake\?\.bound\(\) \?\? liveSessionId/)
  assert.match(handler, /settleFloorRequest\(cardParams, floorPlan\)/)
  assert.match(handler, /settleElidedFloorRequest\(cardParams\)/)
  assert.match(interactive, /inputPreview: params\.card_input_preview \?\? input_preview/)
})
