import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ARTIFACT_TOOL_DECLS, ARTIFACTS_GUIDANCE, handleArtifactTool } from '../lib/artifacts-tools.ts'
import { createBoardsTransports } from '../lib/boards-tools.ts'
import { authHeaders, resolveAuth } from '../lib/agent-credentials.ts'
import { BGOS_CAPABILITIES_FALLBACK } from '../lib/capabilities.ts'
import { PRIVATE_TOOL_MATCHER } from '../lib/private-turn.mjs'
import { actingUserHeaders } from '../lib/acting-user.ts'

// Snapshot of GET schema's envelope from the controller in BRIEF.md.
const liveSchema = {
  contentKind: 'ui_card',
  artifactEnvelope: {
    required: ['kind', 'body', 'fallback'],
    optional: ['v', 'title', 'eyebrow', 'badge', 'markdown'],
    markdown: { type: 'string', maxLength: 64000, maxNodes: 1024 },
    body: { type: 'array', minItems: 0, maxItems: 32 },
    readOnlyAtEveryDepth: true,
  },
  readOnlyBlockTypes: ['text', 'note', 'stat', 'keyvalue', 'table', 'chart', 'heatmap', 'compare', 'list', 'steps'],
  maxBodyBlocks: 32,
  markdownMaxLength: 64000,
  maxBytes: 128 * 1024,
}
const base = 'https://api.example.test/api/v1/integrations/assistants/42/artifacts'
const artifact = { id: 'artifact-test', title: 'Weekly report', version: 2, linkVersion: 3 }
const document = { kind: 'ui_card', v: 1, markdown: '# Weekly report\n\nMeasured results.', body: [], fallback: 'Weekly report' }
const createBody = { chatId: 100, messageId: 101, title: artifact.title, summary: 'Weekly results', content: document, sources: [{ label: 'Measurement', chatId: 100, messageId: 101, from: '2026-11-01', to: '2026-11-05', asOf: '2026-11-06T00:00:00Z', timeZone: 'UTC', sampleSize: 0, note: 'Snapshot' }], missingDataNote: 'No missing data' }

function fixture(reply: (url: string, method: string) => unknown = () => artifact) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const auth = resolveAuth({ env: {
    BGOS_BACKEND_URL: 'https://api.example.test', BGOS_PAIRING_TOKEN: 'synthetic-pairing-token',
    BGOS_USER_ID: 'synthetic-person', BGOS_ASSISTANT_ID: '42',
  } })
  const deps = {
    assistantId: auth.assistantId,
    ...createBoardsTransports({
      apiBase: 'https://api.example.test/api/v1',
      headers: () => ({ ...authHeaders(auth), ...actingUserHeaders('synthetic-recipient', auth.userId) }),
      fetchImpl: async (url: string, init: any) => {
        calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) })
        const value = url.endsWith('/schema') ? liveSchema : reply(url, init.method)
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) }
      },
    }),
  }
  return { deps, calls }
}

function assertCall(call: ReturnType<typeof fixture>['calls'][number], method: string, url: string, body?: unknown) {
  assert.equal(call.method, method)
  assert.equal(call.url, url)
  assert.deepEqual(call.headers, {
    'X-BGOS-Pairing': 'synthetic-pairing-token', 'X-BGOS-Acting-User': 'synthetic-recipient',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  })
  assert.deepEqual(call.body === undefined ? undefined : JSON.parse(call.body), body)
}

function value(result: Awaited<ReturnType<typeof handleArtifactTool>>) {
  assert.equal(result.isError, undefined, result.content[0]!.text)
  return JSON.parse(result.content[0]!.text)
}
function assertReference(result: Record<string, unknown>) {
  assert.equal(result.id, artifact.id)
  assert.equal(result.title, artifact.title)
  assert.equal(result.link, '/artifacts/artifact-test?linkVersion=3')
}

test('artifact_create fetches schema then POSTs only contract fields with paired and acting-user headers', async () => {
  const f = fixture(() => ({ artifact, version: 2 }))
  assertReference(value(await handleArtifactTool('artifact_create', createBody, f.deps)))
  assert.equal(f.calls.length, 2)
  assertCall(f.calls[0]!, 'GET', `${base}/schema`)
  assertCall(f.calls[1]!, 'POST', base, createBody)
})

test('artifact_update PATCHes the same id with expectedVersion and no routing field in its body', async () => {
  const f = fixture()
  const body = { expectedVersion: 1, title: artifact.title, summary: 'Revised results', content: document, sources: createBody.sources, missingDataNote: 'No missing data' }
  assertReference(value(await handleArtifactTool('artifact_update', { id: artifact.id, ...body }, f.deps)))
  assert.equal(f.calls.length, 2)
  assertCall(f.calls[0]!, 'GET', `${base}/schema`)
  assertCall(f.calls[1]!, 'PATCH', `${base}/${artifact.id}`, body)
})

test('artifact_read GETs the requested id and optional historical version, with no body', async () => {
  const f = fixture()
  assertReference(value(await handleArtifactTool('artifact_read', { id: artifact.id, version: 1 }, f.deps)))
  assert.equal(f.calls.length, 1)
  assertCall(f.calls[0]!, 'GET', `${base}/${artifact.id}?version=1`)
})

test('artifact_list GETs only the paired assistant collection and links every result', async () => {
  const f = fixture(() => [artifact])
  const listed = value(await handleArtifactTool('artifact_list', {}, f.deps))
  assert.equal(listed.length, 1)
  assertReference(listed[0])
  assert.equal(f.calls.length, 1)
  assertCall(f.calls[0]!, 'GET', base)
})

test('artifact_versions GETs history and current metadata, returning an open link', async () => {
  const history = [{ version: 2 }, { version: 1 }]
  const f = fixture(url => url.endsWith('/versions') ? history : artifact)
  const output = value(await handleArtifactTool('artifact_versions', { id: artifact.id }, f.deps))
  assertReference(output)
  assert.deepEqual(output.history, history)
  assert.equal(f.calls.length, 2)
  assertCall(f.calls[0]!, 'GET', `${base}/${artifact.id}/versions`)
  assertCall(f.calls[1]!, 'GET', `${base}/${artifact.id}`)
})

test('artifact_read without id exposes the live schema rather than inventing native block fields', async () => {
  const f = fixture()
  assert.deepEqual(value(await handleArtifactTool('artifact_read', {}, f.deps)), liveSchema)
  assertCall(f.calls[0]!, 'GET', `${base}/schema`)
  assert.equal(f.calls.length, 1)
})

test('minimal write responses still return a title and link without retrying the write', async () => {
  const f = fixture(() => ({ id: artifact.id, version: 1 }))
  const created = value(await handleArtifactTool('artifact_create', createBody, f.deps))
  assert.equal(created.id, artifact.id)
  assert.equal(created.title, artifact.title)
  assert.equal(created.link, '/artifacts/artifact-test')
  assert.equal(f.calls.length, 2)

  const revision = fixture((_url, method) => method === 'PATCH' ? { id: artifact.id, version: 2 } : artifact)
  assertReference(value(await handleArtifactTool('artifact_update', { id: artifact.id, expectedVersion: 1, summary: 'Revision' }, revision.deps)))
  assert.equal(revision.calls.filter(call => call.method === 'PATCH').length, 1)
  assertCall(revision.calls[2]!, 'GET', `${base}/${artifact.id}`)
})

test('no tool sends arguments outside its input schema or unknown wire fields', async () => {
  const validArgs = {
    artifact_create: createBody,
    artifact_update: { id: artifact.id, expectedVersion: 1, title: 'Revision' },
    artifact_read: { id: artifact.id },
    artifact_list: {},
    artifact_versions: { id: artifact.id },
  }
  for (const tool of ARTIFACT_TOOL_DECLS) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    for (const extra of ['assistantId', 'userId', 'url', 'html', 'linkVersion', 'chat_id', 'version']) {
      if (Object.hasOwn(tool.inputSchema.properties, extra)) continue
      const f = fixture()
      const output = await handleArtifactTool(tool.name, { ...validArgs[tool.name], [extra]: 'invented' }, f.deps)
      assert.equal(output.isError, true, `${tool.name}: ${extra}`)
      assert.deepEqual(f.calls, [])
    }
  }
  for (const extra of ['html', 'script', 'actions', 'contentKind']) {
    const f = fixture()
    assert.equal((await handleArtifactTool('artifact_create', { ...createBody, content: { ...document, [extra]: 'invented' } }, f.deps)).isError, true)
    assert.deepEqual(f.calls, [])
  }
  const f = fixture()
  assert.equal((await handleArtifactTool('artifact_create', { ...createBody, sources: [{ label: 'Source', url: 'https://example.test' }] }, f.deps)).isError, true)
  assert.deepEqual(f.calls, [])
})

test('input declarations match the supplied create, revise, envelope and source contract', () => {
  const create = ARTIFACT_TOOL_DECLS.find(tool => tool.name === 'artifact_create')!.inputSchema
  const update = ARTIFACT_TOOL_DECLS.find(tool => tool.name === 'artifact_update')!.inputSchema
  assert.deepEqual(Object.keys(create.properties).sort(), ['chatId', 'messageId', 'title', 'summary', 'content', 'sources', 'missingDataNote'].sort())
  assert.deepEqual(Object.keys(update.properties).sort(), ['id', 'expectedVersion', 'title', 'summary', 'content', 'sources', 'missingDataNote'].sort())
  const contentSchema = create.properties.content as any
  assert.deepEqual(Object.keys(contentSchema.properties).sort(), [...liveSchema.artifactEnvelope.required, ...liveSchema.artifactEnvelope.optional].sort())
  assert.deepEqual(contentSchema.required, liveSchema.artifactEnvelope.required)
  assert.deepEqual(Object.keys((create.properties.sources as any).items.properties).sort(), ['label', 'chatId', 'messageId', 'from', 'to', 'asOf', 'timeZone', 'sampleSize', 'note'].sort())
})

test('validation rejects missing revision locks, invalid versions, path traversal and bad content before HTTP', async () => {
  for (const [name, args] of [
    ['artifact_update', { id: artifact.id, title: 'Revision' }],
    ['artifact_read', { version: 1 }],
    ['artifact_read', { id: '../schema' }],
    ['artifact_read', { id: '..' }],
    ['artifact_read', { id: artifact.id, version: 0 }],
    ['artifact_read', { id: artifact.id, version: 1.5 }],
    ['artifact_create', { ...createBody, content: { ...document, body: Array(33).fill({}) } }],
    ['artifact_create', { ...createBody, content: { ...document, markdown: 'x'.repeat(64001) } }],
  ] as const) {
    const f = fixture()
    assert.equal((await handleArtifactTool(name, args, f.deps)).isError, true)
    assert.deepEqual(f.calls, [])
  }
})

test('a stricter live envelope stops writes and schema failures never fall back to a guessed schema', async () => {
  for (const schema of [
    { ...liveSchema, artifactEnvelope: { ...liveSchema.artifactEnvelope, optional: [] } },
    { ...liveSchema, artifactEnvelope: { ...liveSchema.artifactEnvelope, markdown: { maxLength: 1 } } },
    { ...liveSchema, maxBytes: 10 },
    {},
  ]) {
    const calls: string[] = []
    const output = await handleArtifactTool('artifact_create', createBody, {
      assistantId: '42', bgosGet: async path => { calls.push(path); return schema },
      bgosPost: async () => { assert.fail('must not POST') }, bgosPatch: async () => { assert.fail('must not PATCH') },
    })
    assert.equal(output.isError, true)
    assert.deepEqual(calls, ['integrations/assistants/42/artifacts/schema'])
  }
})

test('backend denials and revision conflicts return errors without retries or replacement creates', async () => {
  for (const message of ['GET 403: forbidden', 'GET 404: not_found', 'PATCH 409: reopen before editing']) {
    let writes = 0
    const output = await handleArtifactTool('artifact_update', { id: artifact.id, expectedVersion: 1, title: 'Revision' }, {
      assistantId: '42', bgosGet: async () => liveSchema,
      bgosPost: async () => { assert.fail('must not create a replacement') },
      bgosPatch: async () => { writes++; throw new Error(message) },
    })
    assert.equal(output.isError, true)
    assert.equal(output.content[0]!.text, message)
    assert.equal(writes, 1)
  }
})

test('server instructions, all tool descriptions, agent docs and capability mirror teach Artifacts', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = server.indexOf('    instructions: [')
  const instructions = server.slice(start, server.indexOf("].join('\\n')", start))
  assert.ok(instructions.includes(ARTIFACTS_GUIDANCE))
  assert.match(ARTIFACTS_GUIDANCE, /dashboard, report, chart, table, plan, document/)
  assert.match(ARTIFACTS_GUIDANCE, /read, share or revisit/)
  assert.match(ARTIFACTS_GUIDANCE, /short reply with its link/)
  assert.match(ARTIFACTS_GUIDANCE, /Update the same Artifact/)
  assert.ok(BGOS_CAPABILITIES_FALLBACK.includes(ARTIFACTS_GUIDANCE))
  for (const tool of ARTIFACT_TOOL_DECLS) {
    assert.ok(tool.description.includes(ARTIFACTS_GUIDANCE))
    assert.ok(new RegExp(PRIVATE_TOOL_MATCHER).test(`mcp__bgos__${tool.name}`))
  }
  for (const file of ['../README.md', '../bin/bgos-agent', '../docs/artifacts.md']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(text.includes(ARTIFACTS_GUIDANCE), file)
  }
  assert.match(server, /\.\.\.ARTIFACT_TOOL_DECLS/)
  assert.match(server, /handleArtifactTool\(req\.params\.name, rawArgs, \{\s*\.\.\.boardsTransports\(privateCall!\.headers\),\s*assistantId: ASSISTANT_ID/)
  assert.match(server, /startsWith\('artifact_'\).*\|\|/)
})
