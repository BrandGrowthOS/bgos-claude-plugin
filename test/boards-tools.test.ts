/**
 * boards_* MCP tool family: declarations, argument validation, wire shapes.
 *
 * The contract this pins (agent-boards C3/C7/C8):
 *  - 12 tools, every schema closed (additionalProperties false) so a model
 *    that invents an argument is told, not silently ignored.
 *  - Validation is PURE and instructive: unknown field, wrong type and
 *    missing required all name what is allowed.
 *  - Backend denial bodies (404 not_found / 403 permission_denied) reach the
 *    model VERBATIM. They are the leak-proof contract: softening or
 *    re-stringifying them is a security regression, not a cosmetic one.
 *  - The board path segment is percent-encoded (board NAMES are legal), and
 *    row_key is shape-checked so neither can escape the URL path.
 *
 * Run with:  bun test test/boards-tools.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, truncate, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  BOARDS_TOOL_DECLS,
  BOARDS_ERROR_BODY_MAX_CHARS,
  handleBoardsTool,
  compileFilter,
  createBoardsTransports,
  renderBoardsResponse,
  extractBackendErrorBody,
  type BoardsToolDeps,
} from '../lib/boards-tools.ts'

// ── Fake deps ────────────────────────────────────────────────────────────────

interface RecordedCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  path: string
  body?: Record<string, unknown>
  bytes?: Uint8Array
}

interface Fake {
  calls: RecordedCall[]
  deps: BoardsToolDeps
}

function fakeDeps(opts?: {
  get?: (path: string) => Promise<unknown>
  post?: (path: string, body: Record<string, unknown>) => Promise<unknown>
  patch?: (path: string, body: Record<string, unknown>) => Promise<unknown>
  del?: (path: string) => Promise<unknown>
  put?: (url: string, bytes: Uint8Array, mime: string) => Promise<void>
  assistantId?: string
}): Fake {
  const calls: RecordedCall[] = []
  const deps: BoardsToolDeps = {
    assistantId: opts?.assistantId ?? '42',
    bgosGet: async (path) => {
      calls.push({ method: 'GET', path })
      return opts?.get ? opts.get(path) : { markdown: 'GET ok' }
    },
    bgosPost: async (path, body) => {
      calls.push({ method: 'POST', path, body })
      return opts?.post ? opts.post(path, body) : { markdown: 'POST ok' }
    },
    bgosPatch: async (path, body) => {
      calls.push({ method: 'PATCH', path, body })
      return opts?.patch ? opts.patch(path, body) : { markdown: 'PATCH ok' }
    },
    bgosDelete: async (path) => {
      calls.push({ method: 'DELETE', path })
      return opts?.del ? opts.del(path) : { markdown: 'DELETE ok' }
    },
    putBytes: async (url, bytes, mime) => {
      calls.push({ method: 'PUT', path: url, bytes })
      if (opts?.put) await opts.put(url, bytes, mime)
    },
  }
  return { calls, deps }
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join('\n')
}

function decl(name: string) {
  const found = BOARDS_TOOL_DECLS.find((d) => d.name === name)
  assert.ok(found, `missing declaration for ${name}`)
  return found!
}

// ── Declarations ─────────────────────────────────────────────────────────────

const EXPECTED_NAMES = [
  'boards_list',
  'boards_describe',
  'boards_create',
  'boards_update_schema',
  'boards_query',
  'boards_get_row',
  'boards_insert',
  'boards_update',
  'boards_attach',
  'boards_search',
  'boards_changes',
  'boards_grant',
]

test('declares exactly the 12 contract tools, in roster order', () => {
  assert.deepEqual(
    BOARDS_TOOL_DECLS.map((d) => d.name),
    EXPECTED_NAMES,
  )
})

test('every declaration is a closed object schema with a real description', () => {
  for (const d of BOARDS_TOOL_DECLS) {
    assert.equal(typeof d.description, 'string', `${d.name} description`)
    assert.ok(d.description.length > 40, `${d.name} description too thin`)
    const schema = d.inputSchema as Record<string, unknown>
    assert.equal(schema.type, 'object', `${d.name} schema type`)
    assert.equal(
      schema.additionalProperties,
      false,
      `${d.name} must close its schema`,
    )
    assert.equal(typeof schema.properties, 'object', `${d.name} properties`)
    const props = schema.properties as Record<string, unknown>
    for (const [key, value] of Object.entries(props)) {
      assert.equal(
        typeof (value as { description?: unknown }).description,
        'string',
        `${d.name}.${key} needs a description`,
      )
    }
    if (schema.required !== undefined) {
      assert.ok(Array.isArray(schema.required), `${d.name} required`)
      for (const r of schema.required as string[]) {
        assert.ok(r in props, `${d.name} requires unknown property ${r}`)
      }
    }
  }
})

test('nested object schemas are closed too (no escape hatch through field specs)', () => {
  const closed: string[] = []
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (obj.type === 'object' && obj.properties) {
      assert.equal(obj.additionalProperties, false, `${path} must be closed`)
      closed.push(path)
    }
    for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`)
  }
  for (const d of BOARDS_TOOL_DECLS) walk(d.inputSchema, d.name)
  // create.fields[].* and update_schema.field.* are the nested ones.
  assert.ok(closed.length >= BOARDS_TOOL_DECLS.length + 2, closed.join(','))
})

test('required arguments match the locked contract', () => {
  const required = (name: string) =>
    ((decl(name).inputSchema as Record<string, unknown>).required as
      | string[]
      | undefined) ?? []
  assert.deepEqual(required('boards_list'), [])
  assert.deepEqual(required('boards_describe'), ['board'])
  assert.deepEqual(required('boards_create'), ['name'])
  assert.deepEqual(required('boards_update_schema'), ['board', 'op'])
  assert.deepEqual(required('boards_query'), ['board'])
  assert.deepEqual(required('boards_get_row'), ['board', 'row_key'])
  assert.deepEqual(required('boards_insert'), ['board', 'cells'])
  assert.deepEqual(required('boards_update'), ['board', 'row_key', 'cells'])
  assert.deepEqual(required('boards_attach'), ['board', 'row_key'])
  assert.deepEqual(required('boards_search'), ['board', 'query'])
  assert.deepEqual(required('boards_changes'), ['board'])
  assert.deepEqual(required('boards_grant'), ['board', 'assistant_id', 'role'])
})

test('boards_list takes no arguments at all', () => {
  const schema = decl('boards_list').inputSchema as Record<string, unknown>
  assert.deepEqual(schema.properties, {})
})

test('descriptions carry the etiquette the canon promises', () => {
  const all = BOARDS_TOOL_DECLS.map((d) => d.description).join('\n').toLowerCase()
  assert.ok(all.includes('one row per real thing'), 'one row per real thing')
  assert.ok(all.includes('select options'), 'select options as written')
  assert.ok(all.includes('boards_describe'), 'points at boards_describe')
  assert.ok(all.includes('never guess'), 'never guess column names')
  assert.ok(all.includes('assigned rows'), 'update assigned rows')
  assert.ok(all.includes('instead of pasting'), 'attach instead of pasting')
})

test('no em dashes or en dashes anywhere in the shipped copy or the module', () => {
  const scan = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      assert.ok(!node.includes('\u2014'), `em dash in ${path}`)
      assert.ok(!node.includes('\u2013'), `en dash in ${path}`)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      scan(v, `${path}.${k}`)
    }
  }
  scan(BOARDS_TOOL_DECLS, 'BOARDS_TOOL_DECLS')

  const src = readFileSync(
    fileURLToPath(new URL('../lib/boards-tools.ts', import.meta.url)),
    'utf8',
  )
  assert.ok(!src.includes('\u2014'), 'em dash in lib/boards-tools.ts')
  assert.ok(!src.includes('\u2013'), 'en dash in lib/boards-tools.ts')
})

// ── Argument validation ──────────────────────────────────────────────────────

test('unknown argument is rejected and the allowed set is spelled out', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_query',
    { board: 'decisions', limits: 3 },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  assert.ok(t.includes('"limits"'), t)
  assert.ok(t.includes('boards_query'), t)
  assert.ok(t.includes('response_format'), t)
  assert.ok(t.includes('filter'), t)
  assert.equal(f.calls.length, 0, 'must not reach the backend')
})

test('missing required argument names the argument', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool('boards_describe', {}, f.deps)
  assert.equal(r.isError, true)
  assert.ok(textOf(r).includes('board'), textOf(r))
  assert.equal(f.calls.length, 0)
})

test('wrong type names the argument and the type it wanted', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_query',
    { board: 'decisions', limit: 'ten' },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  assert.ok(t.includes('limit'), t)
  assert.ok(t.includes('number'), t)
  assert.equal(f.calls.length, 0)
})

test('limit outside the allowed band is rejected', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool('boards_query', { board: 'b', limit: 0 }, f.deps)
  assert.equal(r.isError, true)
  assert.equal(f.calls.length, 0)
})

test('enum arguments list the values they accept', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_grant',
    { board: 'decisions', assistant_id: 7, role: 'owner' },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  assert.ok(t.includes('read'), t)
  assert.ok(t.includes('write'), t)
  assert.ok(t.includes('admin'), t)
  assert.equal(f.calls.length, 0)
})

test('cells must be a flat map of strings, and the offending key is named', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_insert',
    { board: 'decisions', cells: { Decision: 'Ship it', Urgency: 3 } },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  assert.ok(t.includes('Urgency'), t)
  assert.ok(t.includes('string'), t)
  assert.equal(f.calls.length, 0)
})

test('unknown tool name is refused rather than guessed at', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool('boards_delete_everything', {}, f.deps)
  assert.equal(r.isError, true)
  assert.equal(f.calls.length, 0)
})

test('update_schema rejects an unknown op and lists the real ones', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'drop_table' },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  for (const op of [
    'add_field',
    'rename_field',
    'delete_field',
    'set_description',
    'set_options',
    'move_field',
  ]) {
    assert.ok(t.includes(op), `${op} missing from ${t}`)
  }
  assert.equal(f.calls.length, 0)
})

test('update_schema names the argument each op needs', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'rename_field', field_key: 'status' },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.ok(textOf(r).includes('label'), textOf(r))
  assert.equal(f.calls.length, 0)
})

test('create rejects an unknown field type and lists the real ones', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_create',
    { name: 'Ops', fields: [{ label: 'When', type: 'timestamp' }] },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  assert.ok(t.includes('datetime'), t)
  assert.ok(t.includes('attachment'), t)
  assert.equal(f.calls.length, 0)
})

// ── Path safety ──────────────────────────────────────────────────────────────

test('row_key accepts the 8-char short key and passes it through verbatim', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_get_row',
    { board: 'decisions', row_key: '3f9a2b7c' },
    f.deps,
  )
  assert.equal(f.calls.length, 1)
  assert.ok(
    f.calls[0]!.path.includes('/rows/3f9a2b7c'),
    f.calls[0]!.path,
  )
})

test('row_key accepts a full uuid and passes it through verbatim', async () => {
  const f = fakeDeps()
  const uuid = '0c27e4b0-8b22-4a52-b433-32efd1a60cee'
  await handleBoardsTool(
    'boards_get_row',
    { board: 'decisions', row_key: uuid },
    f.deps,
  )
  assert.ok(f.calls[0]!.path.includes(`/rows/${uuid}`), f.calls[0]!.path)
})

test('row_key cannot escape the URL path', async () => {
  for (const bad of ['../../assistants/9/boards', 'a/b', 'row key', '']) {
    const f = fakeDeps()
    const r = await handleBoardsTool(
      'boards_get_row',
      { board: 'decisions', row_key: bad },
      f.deps,
    )
    assert.equal(r.isError, true, `accepted ${JSON.stringify(bad)}`)
    assert.equal(f.calls.length, 0, `called out with ${JSON.stringify(bad)}`)
  }
})

test('a board NAME is percent-encoded into the path, never spliced raw', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_describe',
    { board: 'Decisions Pending Kc' },
    f.deps,
  )
  const path = f.calls[0]!.path
  assert.ok(path.includes('Decisions%20Pending%20Kc'), path)
  assert.ok(!path.includes(' '), path)
})

test('a board argument that is a path segment trick is refused outright', async () => {
  // "." and ".." survive percent-encoding and are collapsed by URL
  // normalization, so encoding alone is not enough: refuse them, and refuse
  // any board carrying a slash.
  for (const bad of ['.', '..', 'decisions/../admin', 'a/b', '/decisions']) {
    const f = fakeDeps()
    const r = await handleBoardsTool('boards_describe', { board: bad }, f.deps)
    assert.equal(r.isError, true, `accepted board ${JSON.stringify(bad)}`)
    assert.equal(f.calls.length, 0, `called out with ${JSON.stringify(bad)}`)
    assert.ok(textOf(r).includes('board'), textOf(r))
  }
})

// ── Paths and wire shapes ────────────────────────────────────────────────────

const BASE = 'integrations/assistants/42/boards'

test('boards_list reads the agent board list as markdown', async () => {
  const f = fakeDeps()
  await handleBoardsTool('boards_list', {}, f.deps)
  assert.deepEqual(f.calls, [{ method: 'GET', path: `${BASE}?format=markdown` }])
})

test('boards_describe hits the describe path', async () => {
  const f = fakeDeps()
  await handleBoardsTool('boards_describe', { board: 'decisions' }, f.deps)
  assert.equal(f.calls[0]!.path, `${BASE}/decisions/describe?format=markdown`)
})

test('boards_create posts name, description and field specs', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_create',
    {
      name: 'Comms Log',
      description: 'Every outbound message.',
      fields: [
        { label: 'Item', type: 'text' },
        {
          label: 'Status',
          type: 'select',
          options: ['Pending', 'Answered'],
          option_tones: { Pending: 'working', Answered: 'done' },
          description: 'Where it stands.',
          width: 160,
        },
      ],
    },
    f.deps,
  )
  assert.equal(f.calls[0]!.method, 'POST')
  assert.equal(f.calls[0]!.path, BASE)
  assert.deepEqual(f.calls[0]!.body, {
    name: 'Comms Log',
    description: 'Every outbound message.',
    fields: [
      { label: 'Item', type: 'text' },
      {
        label: 'Status',
        type: 'select',
        options: ['Pending', 'Answered'],
        optionTones: { Pending: 'working', Answered: 'done' },
        description: 'Where it stands.',
        width: 160,
      },
    ],
  })
})

test('update_schema maps each op onto its own verb and path', async () => {
  const add = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'add_field', field: { label: 'Owner', type: 'agent' } },
    add.deps,
  )
  assert.deepEqual(add.calls[0], {
    method: 'POST',
    path: `${BASE}/decisions/fields`,
    body: { label: 'Owner', type: 'agent' },
  })

  const rename = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'rename_field', field_key: 'status', label: 'State' },
    rename.deps,
  )
  assert.deepEqual(rename.calls[0], {
    method: 'PATCH',
    path: `${BASE}/decisions/fields/status`,
    body: { label: 'State' },
  })

  const del = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'delete_field', field_key: 'domain' },
    del.deps,
  )
  assert.deepEqual(del.calls[0], {
    method: 'DELETE',
    path: `${BASE}/decisions/fields/domain`,
  })

  const opts = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    {
      board: 'decisions',
      op: 'set_options',
      field_key: 'status',
      options: ['Pending', 'Answered', 'Escalated'],
      option_tones: { Escalated: 'stale' },
    },
    opts.deps,
  )
  assert.deepEqual(opts.calls[0]!.body, {
    options: ['Pending', 'Answered', 'Escalated'],
    optionTones: { Escalated: 'stale' },
  })

  const moved = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'move_field', field_key: 'asked', position: 2 },
    moved.deps,
  )
  assert.deepEqual(moved.calls[0]!.body, { position: 2 })

  const described = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    {
      board: 'decisions',
      op: 'set_description',
      field_key: 'context',
      description: 'Why it matters.',
    },
    described.deps,
  )
  assert.deepEqual(described.calls[0]!.body, { description: 'Why it matters.' })
})

test('boards_insert posts cells to the rows collection', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_insert',
    { board: 'decisions', cells: { Decision: 'Restart the fee test', Urgency: 'High' } },
    f.deps,
  )
  assert.deepEqual(f.calls[0], {
    method: 'POST',
    path: `${BASE}/decisions/rows`,
    body: { cells: { Decision: 'Restart the fee test', Urgency: 'High' } },
  })
})

test('boards_update patches the single row', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_update',
    { board: 'decisions', row_key: '3f9a2b7c', cells: { Status: 'Answered' } },
    f.deps,
  )
  assert.deepEqual(f.calls[0], {
    method: 'PATCH',
    path: `${BASE}/decisions/rows/3f9a2b7c`,
    body: { cells: { Status: 'Answered' } },
  })
})

test('boards_search posts the plain-language query', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_search',
    { board: 'decisions', query: 'overdue money approvals', limit: 3 },
    f.deps,
  )
  assert.equal(f.calls[0]!.path, `${BASE}/decisions/search?format=markdown`)
  assert.deepEqual(f.calls[0]!.body, { query: 'overdue money approvals', limit: 3 })
})

test('boards_changes carries the since cursor', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_changes',
    { board: 'decisions', since: '2026-07-30T10:00:00.000Z' },
    f.deps,
  )
  assert.equal(
    f.calls[0]!.path,
    `${BASE}/decisions/changes?format=markdown&since=2026-07-30T10%3A00%3A00.000Z`,
  )
})

test('boards_changes without a cursor asks for everything it can see', async () => {
  const f = fakeDeps()
  await handleBoardsTool('boards_changes', { board: 'decisions' }, f.deps)
  assert.equal(f.calls[0]!.path, `${BASE}/decisions/changes?format=markdown`)
})

test('boards_grant posts the grant in backend casing', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_grant',
    { board: 'decisions', assistant_id: 7, role: 'read' },
    f.deps,
  )
  assert.deepEqual(f.calls[0], {
    method: 'POST',
    path: `${BASE}/decisions/grants`,
    body: { assistantId: 7, role: 'read' },
  })
})

// ── Filter shorthand ─────────────────────────────────────────────────────────

test('the shorthand filter map compiles to is-conditions', () => {
  const out = compileFilter({ Status: 'Pending', Urgency: 'Critical' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.ok && out.conditions, [
    { id: 'c1', fieldKey: 'Status', op: 'is', values: ['Pending'] },
    { id: 'c2', fieldKey: 'Urgency', op: 'is', values: ['Critical'] },
  ])
})

test('an empty shorthand filter means no conditions, not a broken one', () => {
  const out = compileFilter({})
  assert.equal(out.ok && out.conditions.length, 0)
})

test('explicit conditions survive with their operator and date modifier', () => {
  const out = compileFilter([
    { fieldKey: 'asked', op: 'is_before', values: [''], dateMod: 'week_ago' },
    { id: 'keep-me', fieldKey: 'status', op: 'is_any_of', values: ['Pending', 'Expired'] },
  ])
  assert.equal(out.ok, true)
  assert.deepEqual(out.ok && out.conditions, [
    { id: 'c1', fieldKey: 'asked', op: 'is_before', values: [''], dateMod: 'week_ago' },
    { id: 'keep-me', fieldKey: 'status', op: 'is_any_of', values: ['Pending', 'Expired'] },
  ])
})

test('an unknown operator is refused with the operator list', () => {
  const out = compileFilter([{ fieldKey: 'status', op: 'like', values: ['x'] }])
  assert.equal(out.ok, false)
  const err = out.ok ? '' : out.error
  assert.ok(err.includes('like'), err)
  assert.ok(err.includes('is_any_of'), err)
  assert.ok(err.includes('contains'), err)
})

test('a shorthand value that is not a string is refused by key', () => {
  const out = compileFilter({ Urgency: 3 } as unknown as Record<string, string>)
  assert.equal(out.ok, false)
  assert.ok(!out.ok && out.error.includes('Urgency'), out.ok ? '' : out.error)
})

test('boards_query sends the compiled conditions, conjunction and sorts', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_query',
    {
      board: 'decisions',
      filter: { Status: 'Pending' },
      conjunction: 'or',
      sort: [{ fieldKey: 'urgency', dir: 'desc' }],
      search: 'promo',
      limit: 3,
      cursor: 'abc',
    },
    f.deps,
  )
  assert.equal(f.calls[0]!.method, 'POST')
  assert.equal(f.calls[0]!.path, `${BASE}/decisions/rows/query?format=markdown`)
  assert.deepEqual(f.calls[0]!.body, {
    conditions: [{ id: 'c1', fieldKey: 'Status', op: 'is', values: ['Pending'] }],
    conjunction: 'or',
    sorts: [{ id: 's1', fieldKey: 'urgency', dir: 'desc' }],
    search: 'promo',
    limit: 3,
    cursor: 'abc',
  })
})

test('a filter that is neither a map nor a condition list is refused', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_query',
    { board: 'decisions', filter: 'Status = Pending' },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.equal(f.calls.length, 0)
})

test('an unknown sort direction is refused', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_query',
    { board: 'decisions', sort: [{ fieldKey: 'urgency', dir: 'up' }] },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.ok(textOf(r).includes('asc'), textOf(r))
  assert.equal(f.calls.length, 0)
})

// ── Response rendering ───────────────────────────────────────────────────────

test('markdown is the default and passes through untouched', () => {
  assert.equal(
    renderBoardsResponse({ markdown: '# Decisions Pending Kc\n| a |' }, 'markdown'),
    '# Decisions Pending Kc\n| a |',
  )
})

test('json response_format hands the model the whole body', () => {
  const body = { rows: [{ id: 'r1' }], count: 1 }
  assert.equal(renderBoardsResponse(body, 'json'), JSON.stringify(body, null, 2))
})

test('a body with no markdown field still reaches the model as JSON', () => {
  assert.equal(
    renderBoardsResponse({ row_id: 'r1', recorded: true }, 'markdown'),
    JSON.stringify({ row_id: 'r1', recorded: true }, null, 2),
  )
})

test('response_format json asks the backend for json too', async () => {
  const f = fakeDeps({ get: async () => ({ rows: [] }) })
  const r = await handleBoardsTool(
    'boards_get_row',
    { board: 'decisions', row_key: '3f9a2b7c', response_format: 'json' },
    f.deps,
  )
  assert.ok(f.calls[0]!.path.endsWith('?format=json'), f.calls[0]!.path)
  assert.equal(textOf(r), JSON.stringify({ rows: [] }, null, 2))
})

test('response_format only accepts markdown or json', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_query',
    { board: 'decisions', response_format: 'yaml' },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.equal(f.calls.length, 0)
})

// ── Backend error passthrough (the leak-proof contract) ──────────────────────

const NOT_FOUND_BODY =
  '{ "error": "not_found", "message": "No board matches this request." }'
const READ_ONLY_BODY =
  '{ "error": "permission_denied", "message": "Read access: this agent cannot change rows." }'

test('a 404 denial body reaches the model byte for byte', async () => {
  const f = fakeDeps({
    get: async () => {
      throw new Error(`GET 404: ${NOT_FOUND_BODY}`)
    },
  })
  const r = await handleBoardsTool('boards_describe', { board: 'nope' }, f.deps)
  assert.equal(r.isError, true)
  assert.equal(textOf(r), NOT_FOUND_BODY)
})

test('a 403 denial body is never softened or re-worded', async () => {
  const f = fakeDeps({
    patch: async () => {
      throw new Error(`PATCH 403: ${READ_ONLY_BODY}`)
    },
  })
  const r = await handleBoardsTool(
    'boards_update',
    { board: 'decisions', row_key: '3f9a2b7c', cells: { Status: 'Answered' } },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.equal(textOf(r), READ_ONLY_BODY)
})

test('the row denial body passes through from a POST too', async () => {
  const body = '{ "error": "not_found", "message": "No such row." }'
  const f = fakeDeps({
    post: async () => {
      throw new Error(`POST 404: ${body}`)
    },
  })
  const r = await handleBoardsTool(
    'boards_insert',
    { board: 'decisions', cells: { Decision: 'x' } },
    f.deps,
  )
  assert.equal(textOf(r), body)
})

test('extractBackendErrorBody keeps the exact bytes, spacing included', () => {
  assert.equal(
    extractBackendErrorBody(new Error(`GET 403: ${READ_ONLY_BODY}`)),
    READ_ONLY_BODY,
  )
  // A fake that throws the bare body (no status prefix) is passed through too.
  assert.equal(extractBackendErrorBody(new Error(NOT_FOUND_BODY)), NOT_FOUND_BODY)
})

test('a transport failure is reported, not disguised as a denial', async () => {
  const f = fakeDeps({
    get: async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    },
  })
  const r = await handleBoardsTool('boards_list', {}, f.deps)
  assert.equal(r.isError, true)
  const t = textOf(r)
  assert.ok(t.includes('ECONNREFUSED'), t)
  assert.ok(!t.includes('permission_denied'), t)
})

// ── Boards transports (their own, so error bodies survive) ───────────────────

interface FakeResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

function fakeFetch(
  reply: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    status?: number
    body?: string
    contentLength?: string | null
  },
) {
  const seen: Array<{
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }> = []
  const impl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<FakeResponse> => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body })
    const r = reply(url, init)
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n) => (n.toLowerCase() === 'content-length' ? r.contentLength ?? null : null) },
      text: async () => r.body ?? '',
    }
  }
  return { seen, impl }
}

function transports(
  reply: Parameters<typeof fakeFetch>[0],
  opts?: { maxBytes?: number },
) {
  const f = fakeFetch(reply)
  const t = createBoardsTransports({
    apiBase: 'https://api.example/api/v1',
    headers: () => ({ 'X-BGOS-Pairing': 'tok' }),
    fetchImpl: f.impl as never,
    maxBytes: opts?.maxBytes,
  })
  return { seen: f.seen, ...t }
}

test('the boards transports send the auth header to the resolved url', async () => {
  const t = transports(() => ({ body: '{"markdown":"ok"}' }))
  await t.bgosPost('integrations/assistants/42/boards', { name: 'Ops' })
  assert.equal(t.seen[0]!.url, 'https://api.example/api/v1/integrations/assistants/42/boards')
  assert.equal(t.seen[0]!.method, 'POST')
  assert.equal(t.seen[0]!.headers['X-BGOS-Pairing'], 'tok')
  assert.equal(t.seen[0]!.headers['Content-Type'], 'application/json')
  assert.equal(t.seen[0]!.body, '{"name":"Ops"}')
})

test('a long error body survives to the model instead of being cut at 200', async () => {
  // The ambiguity error lists name (id) pairs, which runs past 200 chars.
  const pairs = Array.from(
    { length: 5 },
    (_, i) => `Decisions Pending Kc ${i} (0c27e4b0-8b22-4a52-b433-32efd1a60ce${i})`,
  ).join(', ')
  const body = JSON.stringify({
    error: 'ambiguous_board',
    message: `More than one board matches that name. Ask for one of: ${pairs}.`,
  })
  assert.ok(body.length > 200, 'fixture must exceed the old 200-char cut')

  const t = transports(() => ({ status: 409, body }))
  let thrown: unknown
  await t.bgosGet('integrations/assistants/42/boards/x/describe').catch((e) => {
    thrown = e
  })
  assert.ok(thrown instanceof Error)
  assert.equal(extractBackendErrorBody(thrown), body)

  // And through the tool, verbatim.
  const r = await handleBoardsTool(
    'boards_describe',
    { board: 'Decisions Pending Kc' },
    { assistantId: '42', bgosGet: t.bgosGet, bgosPost: t.bgosPost, bgosPatch: t.bgosPatch },
  )
  assert.equal(r.isError, true)
  assert.equal(textOf(r), body)
})

test('an error body past the boards ceiling is cut at the ceiling, not before', async () => {
  const body = `{"error":"huge","message":"${'x'.repeat(4000)}"}`
  const t = transports(() => ({ status: 500, body }))
  let thrown: unknown
  await t.bgosGet('boards').catch((e) => {
    thrown = e
  })
  const message = (thrown as Error).message
  assert.equal(
    message.length,
    `GET 500: `.length + BOARDS_ERROR_BODY_MAX_CHARS,
    message.slice(0, 60),
  )
  assert.ok(BOARDS_ERROR_BODY_MAX_CHARS >= 2048)
})

test('an empty success body is a success, not a parse failure', async () => {
  const t = transports(() => ({ status: 204, body: '' }))
  assert.deepEqual(await t.bgosPatch('boards/x/rows/y', { cells: {} }), {})
})

test('a non-JSON success body is tolerated instead of crashing the tool', async () => {
  const t = transports(() => ({ status: 200, body: 'OK' }))
  assert.deepEqual(await t.bgosPost('boards/x/rows', { cells: {} }), {})
})

test('an empty success body renders as a plain success line', async () => {
  const t = transports(() => ({ status: 204, body: '' }))
  const r = await handleBoardsTool(
    'boards_update',
    { board: 'decisions', row_key: '3f9a2b7c', cells: { Status: 'Answered' } },
    { assistantId: '42', bgosGet: t.bgosGet, bgosPost: t.bgosPost, bgosPatch: t.bgosPatch },
  )
  assert.notEqual(r.isError, true, textOf(r))
  assert.equal(textOf(r), 'Done.')
})

test('renderBoardsResponse turns an empty body into a success line, not "{}"', () => {
  assert.equal(renderBoardsResponse({}, 'markdown'), 'Done.')
  assert.equal(renderBoardsResponse(undefined, 'markdown'), 'Done.')
  // json stays honest about what came back
  assert.equal(renderBoardsResponse({}, 'json'), '{}')
})

test('a response over the size ceiling is refused', async () => {
  const t = transports(() => ({ body: '{"a":1}', contentLength: String(9 * 1024 * 1024) }), {
    maxBytes: 4 * 1024 * 1024,
  })
  let thrown: unknown
  await t.bgosGet('boards').catch((e) => {
    thrown = e
  })
  assert.ok(thrown instanceof Error)
  assert.ok((thrown as Error).message.toLowerCase().includes('too large'))
})

test('the DELETE transport exists for delete_field', async () => {
  const t = transports(() => ({ status: 204, body: '' }))
  assert.equal(typeof t.bgosDelete, 'function')
  assert.deepEqual(await t.bgosDelete!('boards/x/fields/y'), {})
  assert.equal(t.seen[0]!.method, 'DELETE')
})

// ── Attachments ──────────────────────────────────────────────────────────────

async function withTempFile(
  name: string,
  bytes: Uint8Array | string,
  fn: (path: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'boards-attach-'))
  const path = join(dir, name)
  await writeFile(path, bytes)
  try {
    await fn(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a small file_path is read, sized and base64 encoded inline', async () => {
  await withTempFile('brief.md', '# Two clauses\nneed sign-off.\n', async (path) => {
    const f = fakeDeps()
    const r = await handleBoardsTool(
      'boards_attach',
      { board: 'decisions', row_key: '3f9a2b7c', file_path: path, field_key: 'files' },
      f.deps,
    )
    assert.notEqual(r.isError, true, textOf(r))
    assert.equal(f.calls.length, 1)
    assert.equal(
      f.calls[0]!.path,
      `${BASE}/decisions/rows/3f9a2b7c/attachments`,
    )
    const body = f.calls[0]!.body as Record<string, unknown>
    assert.equal(body.name, 'brief.md')
    assert.equal(body.size, 29)
    assert.equal(body.mime, 'text/markdown')
    assert.equal(body.field_key, 'files')
    assert.equal(
      Buffer.from(body.content_base64 as string, 'base64').toString('utf8'),
      '# Two clauses\nneed sign-off.\n',
    )
  })
})

test('an explicit name and mime win over the ones guessed from the path', async () => {
  await withTempFile('download.tmp', 'hello', async (path) => {
    const f = fakeDeps()
    await handleBoardsTool(
      'boards_attach',
      {
        board: 'decisions',
        row_key: '3f9a2b7c',
        file_path: path,
        name: 'notes.md',
        mime: 'text/plain',
      },
      f.deps,
    )
    const body = f.calls[0]!.body as Record<string, unknown>
    assert.equal(body.name, 'notes.md')
    assert.equal(body.mime, 'text/plain')
  })
})

test('a file over 1 MB is presigned, uploaded, then completed', async () => {
  const big = Buffer.alloc(1024 * 1024 + 10, 7)
  await withTempFile('big.bin', big, async (path) => {
    const f = fakeDeps({
      post: async (p) => {
        if (p.endsWith('/attachments')) {
          return { attachmentId: 'att-9', uploadUrl: 'https://s3.example/put?sig=1' }
        }
        return { markdown: 'attached' }
      },
    })
    const r = await handleBoardsTool(
      'boards_attach',
      { board: 'decisions', row_key: '3f9a2b7c', file_path: path },
      f.deps,
    )
    assert.notEqual(r.isError, true, textOf(r))
    assert.equal(f.calls.length, 3)
    assert.equal(f.calls[0]!.method, 'POST')
    assert.equal(f.calls[0]!.path, `${BASE}/decisions/rows/3f9a2b7c/attachments`)
    const meta = f.calls[0]!.body as Record<string, unknown>
    assert.equal(meta.size, big.length)
    assert.equal(meta.content_base64, undefined, 'must not inline a big file')
    assert.equal(f.calls[1]!.method, 'PUT')
    assert.equal(f.calls[1]!.path, 'https://s3.example/put?sig=1')
    assert.equal(f.calls[1]!.bytes?.length, big.length)
    assert.equal(f.calls[2]!.method, 'POST')
    assert.equal(f.calls[2]!.path, `${BASE}/decisions/attachments/att-9/complete`)
  })
})

test('content_base64 with a name attaches without touching the disk', async () => {
  const f = fakeDeps()
  const b64 = Buffer.from('inline bytes').toString('base64')
  await handleBoardsTool(
    'boards_attach',
    {
      board: 'decisions',
      row_key: '3f9a2b7c',
      name: 'inline.txt',
      content_base64: b64,
      mime: 'text/plain',
    },
    f.deps,
  )
  const body = f.calls[0]!.body as Record<string, unknown>
  assert.equal(body.content_base64, b64)
  assert.equal(body.size, 12)
})

test('content_base64 without a name is refused', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_attach',
    {
      board: 'decisions',
      row_key: '3f9a2b7c',
      content_base64: Buffer.from('x').toString('base64'),
    },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.ok(textOf(r).includes('name'), textOf(r))
  assert.equal(f.calls.length, 0)
})

test('attach needs bytes from somewhere', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_attach',
    { board: 'decisions', row_key: '3f9a2b7c' },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  assert.ok(t.includes('file_path'), t)
  assert.ok(t.includes('content_base64'), t)
  assert.equal(f.calls.length, 0)
})

test('a missing file is reported with the path, not a stack trace', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_attach',
    { board: 'decisions', row_key: '3f9a2b7c', file_path: '/no/such/file.md' },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.ok(textOf(r).includes('/no/such/file.md'), textOf(r))
  assert.equal(f.calls.length, 0)
})

test('the inline attach path is complete in ONE post, never a /complete call', async () => {
  await withTempFile('note.txt', 'small enough to ride inline', async (path) => {
    const f = fakeDeps({
      post: async () => ({ attachmentId: 'att-1', ok: true }),
    })
    const r = await handleBoardsTool(
      'boards_attach',
      { board: 'decisions', row_key: '3f9a2b7c', file_path: path },
      f.deps,
    )
    assert.notEqual(r.isError, true, textOf(r))
    assert.equal(f.calls.length, 1)
    assert.ok(
      !f.calls.some((c) => c.path.includes('/complete')),
      'inline attach must not call /complete',
    )
  })
})

test('an upload url that is not https is refused before any bytes leave', async () => {
  const big = Buffer.alloc(1024 * 1024 + 10, 3)
  await withTempFile('big.bin', big, async (path) => {
    for (const url of [
      'http://s3.example/put',
      'file:///etc/passwd',
      'ftp://s3.example/put',
    ]) {
      const f = fakeDeps({
        post: async (p) =>
          p.endsWith('/attachments')
            ? { attachmentId: 'att-9', uploadUrl: url }
            : { markdown: 'attached' },
      })
      const r = await handleBoardsTool(
        'boards_attach',
        { board: 'decisions', row_key: '3f9a2b7c', file_path: path },
        f.deps,
      )
      assert.equal(r.isError, true, `accepted ${url}`)
      assert.ok(textOf(r).includes('https'), textOf(r))
      assert.ok(
        !f.calls.some((c) => c.method === 'PUT'),
        `bytes left over ${url}`,
      )
    }
  })
})

test('an oversized file is refused from its size on disk, never read in', async () => {
  // Sparse file, then chmod 000: stat() still reports the size, read() would
  // fail with EACCES. If the cap were checked after readFile the error would
  // be the permission error, not the size one.
  const dir = await mkdtemp(join(tmpdir(), 'boards-huge-'))
  const path = join(dir, 'huge.bin')
  try {
    await writeFile(path, '')
    await truncate(path, 26 * 1024 * 1024)
    await chmod(path, 0o000)
    const f = fakeDeps()
    const r = await handleBoardsTool(
      'boards_attach',
      { board: 'decisions', row_key: '3f9a2b7c', file_path: path },
      f.deps,
    )
    assert.equal(r.isError, true)
    const t = textOf(r)
    assert.ok(t.includes('25 MB'), t)
    assert.ok(!t.toUpperCase().includes('EACCES'), `read before stat: ${t}`)
    assert.equal(f.calls.length, 0)
  } finally {
    await chmod(path, 0o600).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('an oversized content_base64 is refused before it is decoded', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_attach',
    {
      board: 'decisions',
      row_key: '3f9a2b7c',
      name: 'huge.bin',
      content_base64: 'A'.repeat(40 * 1024 * 1024),
    },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.ok(textOf(r).includes('25 MB'), textOf(r))
  assert.equal(f.calls.length, 0)
})

test('file_path and content_base64 together are refused rather than guessed', async () => {
  await withTempFile('a.txt', 'x', async (path) => {
    const f = fakeDeps()
    const r = await handleBoardsTool(
      'boards_attach',
      {
        board: 'decisions',
        row_key: '3f9a2b7c',
        file_path: path,
        content_base64: Buffer.from('y').toString('base64'),
        name: 'a.txt',
      },
      f.deps,
    )
    assert.equal(r.isError, true)
    assert.equal(f.calls.length, 0)
  })
})

// ── Multi-table boards (the optional table arg + table lifecycle ops) ─────────
//
// A board owns N ordered tables. The optional `table` arg (a table id or its
// exact name) scopes the table-scoped reads and writes; the server resolves
// name-or-id, the plugin never resolves names, exactly like the board segment.
// Omitting it means the board's default table (Main), so a call without a table
// stays byte-identical to the single-table wire. The four table lifecycle ops
// fold under boards_update_schema, addressing the /tables collection.

test('boards_query threads the optional table arg into the query string', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_query',
    { board: 'decisions', table: 'Assets', filter: { Status: 'Pending' } },
    f.deps,
  )
  assert.equal(
    f.calls[0]!.path,
    `${BASE}/decisions/rows/query?format=markdown&table=Assets`,
  )
})

test('boards_query without a table is byte-identical to the single-table wire', async () => {
  const f = fakeDeps()
  await handleBoardsTool('boards_query', { board: 'decisions' }, f.deps)
  assert.equal(f.calls[0]!.path, `${BASE}/decisions/rows/query?format=markdown`)
})

test('boards_insert threads the optional table arg into the query string', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_insert',
    { board: 'decisions', table: 'Assets', cells: { Item: 'Logo' } },
    f.deps,
  )
  assert.deepEqual(f.calls[0], {
    method: 'POST',
    path: `${BASE}/decisions/rows?table=Assets`,
    body: { cells: { Item: 'Logo' } },
  })
})

test('boards_insert without a table keeps the plain rows path', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_insert',
    { board: 'decisions', cells: { Item: 'Logo' } },
    f.deps,
  )
  assert.equal(f.calls[0]!.path, `${BASE}/decisions/rows`)
})

test('the table arg is percent-encoded, never spliced raw', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_insert',
    { board: 'decisions', table: 'Brand Assets', cells: { Item: 'Logo' } },
    f.deps,
  )
  assert.ok(f.calls[0]!.path.includes('table=Brand%20Assets'), f.calls[0]!.path)
  assert.ok(!f.calls[0]!.path.includes(' '), f.calls[0]!.path)
})

test('tools that are not table-scoped still reject a table arg as unknown', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['boards_get_row', { board: 'decisions', row_key: '3f9a2b7c', table: 'Assets' }],
    [
      'boards_update',
      { board: 'decisions', row_key: '3f9a2b7c', cells: { A: 'b' }, table: 'Assets' },
    ],
    ['boards_search', { board: 'decisions', query: 'x', table: 'Assets' }],
    ['boards_changes', { board: 'decisions', table: 'Assets' }],
    ['boards_describe', { board: 'decisions', table: 'Assets' }],
  ]
  for (const [tool, args] of cases) {
    const f = fakeDeps()
    const r = await handleBoardsTool(tool, args, f.deps)
    assert.equal(r.isError, true, `${tool} accepted table`)
    assert.ok(textOf(r).includes('"table"'), `${tool}: ${textOf(r)}`)
    assert.equal(f.calls.length, 0, `${tool} reached the backend`)
  }
})

test('update_schema add_table posts the new table name to the tables collection', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'add_table', label: 'Assets' },
    f.deps,
  )
  assert.deepEqual(f.calls[0], {
    method: 'POST',
    path: `${BASE}/decisions/tables`,
    body: { name: 'Assets' },
  })
})

test('update_schema rename_table patches the table with its new name', async () => {
  const f = fakeDeps()
  const tableId = '0c27e4b0-8b22-4a52-b433-32efd1a60cee'
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'rename_table', table: tableId, label: 'Brand Assets' },
    f.deps,
  )
  assert.deepEqual(f.calls[0], {
    method: 'PATCH',
    path: `${BASE}/decisions/tables/${tableId}`,
    body: { name: 'Brand Assets' },
  })
})

test('update_schema move_table patches the table position', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'move_table', table: 'abc', position: 2 },
    f.deps,
  )
  assert.deepEqual(f.calls[0], {
    method: 'PATCH',
    path: `${BASE}/decisions/tables/abc`,
    body: { position: 2 },
  })
})

test('update_schema delete_table deletes the table', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'delete_table', table: 'abc' },
    f.deps,
  )
  assert.deepEqual(f.calls[0], {
    method: 'DELETE',
    path: `${BASE}/decisions/tables/abc`,
  })
})

test('a table name is percent-encoded into the tables path, never spliced raw', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'rename_table', table: 'Brand Assets', label: 'Assets' },
    f.deps,
  )
  assert.ok(f.calls[0]!.path.endsWith('/tables/Brand%20Assets'), f.calls[0]!.path)
  assert.ok(!f.calls[0]!.path.includes(' '), f.calls[0]!.path)
})

test('update_schema add_table without a name is refused before the network', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'add_table' },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.ok(textOf(r).includes('label'), textOf(r))
  assert.equal(f.calls.length, 0)
})

test('a table lifecycle op rejects a stray field-op argument', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'delete_table', table: 'abc', field_key: 'status' },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.ok(textOf(r).includes('field_key'), textOf(r))
  assert.equal(f.calls.length, 0)
})

test('the table path segment cannot escape the URL path', async () => {
  for (const bad of ['..', '.', 'a/b', 'x\\y', '']) {
    const f = fakeDeps()
    const r = await handleBoardsTool(
      'boards_update_schema',
      { board: 'decisions', op: 'delete_table', table: bad },
      f.deps,
    )
    assert.equal(r.isError, true, `accepted table ${JSON.stringify(bad)}`)
    assert.equal(f.calls.length, 0)
  }
})

test('update_schema lists the table ops when the op is unknown', async () => {
  const f = fakeDeps()
  const r = await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'drop_table' },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  for (const op of ['add_table', 'rename_table', 'delete_table', 'move_table']) {
    assert.ok(t.includes(op), `${op} missing from ${t}`)
  }
})

// ── Column lines: set_column_lines and option_renames (0.45.0) ───────────────
//
// Kanban phase 1 (plan 3.8, P1.11): an agent may describe what each column of
// a workflow select means, in one plain sentence plus a few closed facts. The
// server owns every length and every cross reference and its refusal reaches
// the model verbatim; this module owns the shape, the enums and the snake
// case to camel case wire.
//
// MUTATION PROOFS (each applied to lib/boards-tools.ts, confirmed red,
// restored):
//
//  1. WIRE MAPPING. Sent `waits_on` through as it came instead of `waitsOn`
//     -> "set_column_lines sends exactly optionRules and workflow, in camel
//     case" fails. The DTO whitelists camelCase only, so a snake key would be
//     stripped and the line would lose the fact without a word.
//  2. CLEAR AS NULL. Made clear_lines send `{}` instead of `null` -> the same
//     case fails on `Dropped: null`, and so does "only a workflow flag, or
//     only a clear, is a legal write"; the server removes a line only on null.
//  3. ECHO CHECK. Returned the PATCH answer as it came for set_column_lines
//     (neither the `playbook` check nor the `filed` report) -> "a server that
//     answers without playbook stored nothing, and the tool says so" and "a
//     filed change is reported, not claimed" fail: an older server strips the
//     unknown keys, answers 200 with `{ field }`, and the model would read a
//     write that never happened as done.
//  4. FILED IS NOT DONE. Ignored `filed` and rendered the body -> "a filed
//     change is reported, not claimed" fails: the model would read the 200 as
//     done and send the same structural change again on every run.
//  5. RENAMES. Dropped the `body.optionRenames` line in set_options -> "a
//     set_options with option_renames sends optionRenames" fails.
//  6. BOTH LINES AND CLEAR. Dropped the both-places refusal -> "an option in
//     both lines and clear_lines is refused before the network" fails (the
//     later assignment would silently win).
//  7. ENUMS. Dropped the `WAITS_ON.includes` check -> "an enum refusal names
//     the allowed values" fails, and "owner" would reach the server as a fact.
//
// W1 close 2 (review R3; each applied to lib/boards-tools.ts, confirmed red,
// restored from one pristine copy byte for byte):
//
//  8. THE OLD FILED SENTENCE. Put back "The owner confirmed this board, so
//     your change ... was saved as a suggestion for the owner" -> "a filed
//     change is reported, not claimed" and "a filed sentence never claims a
//     confirmation or a suggestion" fail. The server also files on an
//     unconfirmed board, over a line the owner wrote, and nothing shows a
//     suggestion to him in this release.
//  9. THE SAVED SENTENCE UNNAMED. The `saved` clause never taken -> "a filed
//     sentence never claims ..." fails: the answer would say the column kept
//     its setting about words that changed.
// 10. SUGGESTION IN THE LINES TEXT. The `lines` description back to "kept as
//     a suggestion for the owner" -> "set_column_lines is an op, and the tool
//     roster is still the 12" and "no text the boards tools declare says
//     suggestion" fail. Re proved in 0.50.0, where the roster case pins the
//     new last sentence instead: "any other change you send is kept as a
//     suggestion for the owner" put into the lines text -> "no text the
//     boards tools declare says suggestion, outside the instruction part"
//     fails (one red), so the descriptive half still never says it.
// 11. A RESTACK PROMISED. The `workflow` description back to "marks this
//     select as the board's workflow, the one the Kanban stacks by" -> the
//     roster case fails: an agent's flag stacks nothing until the owner
//     confirms.

const LINES_BASE = { board: 'decisions', op: 'set_column_lines', field_key: 'status' }

function playbookEcho(filed: string[] = []) {
  return async () => ({
    field: { key: 'status', label: 'Status', type: 'select' },
    playbook: { status: { workflow: true, lines: {} } },
    filed,
  })
}

test('set_column_lines is an op, and the tool roster is still the 12', () => {
  assert.deepEqual(
    BOARDS_TOOL_DECLS.map((d) => d.name),
    EXPECTED_NAMES,
  )
  const props = (decl('boards_update_schema').inputSchema as unknown as {
    properties: Record<string, { enum?: string[]; description?: string }>
  }).properties
  assert.ok(props.op!.enum!.includes('set_column_lines'))
  assert.ok(props.op!.description!.includes('set_column_lines'))
  for (const key of ['lines', 'clear_lines', 'workflow', 'option_renames']) {
    assert.equal(typeof props[key]?.description, 'string', `${key} is declared`)
  }
  // The confirmed table qualifier travels with the lines argument (E4), so
  // the model knows before it writes that a structural change can be filed,
  // and it names the second case a filing happens in: a column whose line the
  // owner wrote, on a board he never confirmed (W1 close 2, review R3).
  assert.ok(props.lines!.description!.includes('On a confirmed board'))
  assert.ok(props.lines!.description!.includes('whose line the owner wrote'))
  // Changed ON PURPOSE in 0.50.0 (Kanban phase 2, plan 3.7): the lines text
  // now ends by saying the does part is a suggestion until the owner approves
  // it, because from phase 2 the owner is shown that suggestion. The
  // descriptive half still never says it ("no text the boards tools declare
  // says suggestion, outside the instruction part").
  assert.ok(
    props.lines!.description!.endsWith(
      'A line\'s sentence and facts only describe the board; its does part ' +
        'is a suggestion until the owner approves it.',
    ),
    props.lines!.description,
  )
  // An agent's workflow flag restacks nothing until the owner confirms.
  assert.ok(props.workflow!.description!.includes('once the owner confirms'))
  assert.ok(decl('boards_update_schema').description.includes('set_column_lines'))
  assert.ok(decl('boards_update_schema').description.includes('nothing you write there starts work'))
})

test('set_column_lines sends exactly optionRules and workflow, in camel case', async () => {
  const f = fakeDeps({ patch: playbookEcho() })
  const r = await handleBoardsTool(
    'boards_update_schema',
    {
      ...LINES_BASE,
      lines: {
        'Waiting on me': {
          means: 'Cards that need the owner\'s answer.',
          waits_on: 'you',
          rest: 'open',
          sort_by: { field_key: 'due', dir: 'asc' },
          answers: [
            { label: 'Approve', move_to: 'Done' },
            { label: 'Kill', move_to: 'Dropped', ask_note: true },
          ],
        },
        Done: { rest: 'finished' },
      },
      clear_lines: ['Dropped'],
      workflow: true,
    },
    f.deps,
  )
  assert.equal(r.isError, undefined, textOf(r))
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.method, 'PATCH')
  assert.equal(f.calls[0]!.path, `${BASE}/decisions/fields/status`)
  assert.deepEqual(f.calls[0]!.body, {
    optionRules: {
      'Waiting on me': {
        means: 'Cards that need the owner\'s answer.',
        waitsOn: 'you',
        rest: 'open',
        sortBy: { fieldKey: 'due', dir: 'asc' },
        answers: [
          { label: 'Approve', moveTo: 'Done' },
          { label: 'Kill', moveTo: 'Dropped', askNote: true },
        ],
      },
      Done: { rest: 'finished' },
      Dropped: null,
    },
    workflow: true,
  })
})

test('set_column_lines never sends a key the server owns', async () => {
  // v, writtenBy, at, approved and textHash are the server's: the tool
  // refuses them as unknown keys of a line. Changed ON PURPOSE in 0.50.0
  // (Kanban phase 2, plan 3.7): `does` left this list because it is now the
  // agent's own key (its instruction, filed as a suggestion), and `approved`
  // and `textHash` joined it, because the owner's approval and the hash of
  // the words he approved are the server's alone and an agent that could send
  // them could approve its own instruction. The camel case spelling of a line
  // key is still refused (the tool takes snake case only).
  for (const key of ['v', 'writtenBy', 'at', 'approved', 'textHash', 'waitsOn']) {
    const f = fakeDeps({ patch: playbookEcho() })
    const r = await handleBoardsTool(
      'boards_update_schema',
      { ...LINES_BASE, lines: { Done: { means: 'Shipped.', [key]: 'x' } } },
      f.deps,
    )
    assert.equal(r.isError, true, `accepted ${key}`)
    const t = textOf(r)
    assert.ok(t.includes(`"${key}"`), t)
    assert.ok(t.includes('means, waits_on, rest, sort_by, answers'), t)
    assert.equal(f.calls.length, 0)
  }
})

test('an answer and a sort_by are closed shapes too', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ waits_on: 'you', answers: [{ label: 'Yes', move_to: 'Done', note: 'x' }] }, '"note"'],
    [{ waits_on: 'you', answers: [{ label: 'Yes' }] }, 'move_to'],
    [{ waits_on: 'you', answers: [{ label: 'Yes', move_to: 'Done', ask_note: 'yes' }] }, 'ask_note'],
    [{ waits_on: 'you', answers: 'Approve' }, 'answers'],
    [{ sort_by: { field_key: 'due' } }, 'dir'],
    [{ sort_by: { field_key: 'due', dir: 'up' } }, 'asc, desc'],
    [{ sort_by: { field_key: 'due', dir: 'asc', nulls: 'last' } }, '"nulls"'],
    [{ means: 42 }, 'means'],
  ]
  for (const [line, needle] of cases) {
    const f = fakeDeps({ patch: playbookEcho() })
    const r = await handleBoardsTool(
      'boards_update_schema',
      { ...LINES_BASE, lines: { Done: line } },
      f.deps,
    )
    assert.equal(r.isError, true, `accepted ${JSON.stringify(line)}`)
    assert.ok(textOf(r).includes(needle), `${needle} not in ${textOf(r)}`)
    assert.equal(f.calls.length, 0)
  }
})

test('an enum refusal names the allowed values', async () => {
  const waits = fakeDeps({ patch: playbookEcho() })
  const r1 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Review: { waits_on: 'owner' } } },
    waits.deps,
  )
  assert.equal(r1.isError, true)
  const t1 = textOf(r1)
  assert.ok(t1.includes('lines.Review.waits_on'), t1)
  assert.ok(t1.includes('you, agent, someone_else, nobody'), t1)
  assert.ok(t1.includes('"owner"'), t1)
  assert.equal(waits.calls.length, 0)

  const rest = fakeDeps({ patch: playbookEcho() })
  const r2 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { rest: 'done' } } },
    rest.deps,
  )
  assert.equal(r2.isError, true)
  assert.ok(textOf(r2).includes('open, parked, finished, dropped'), textOf(r2))
  assert.equal(rest.calls.length, 0)
})

test('lengths and cross references are the server\'s, and its sentence reaches the model verbatim', async () => {
  // A 300 character sentence and an answer aimed at an option that does not
  // exist both leave this module untouched: the server measures in code
  // points and knows the options, and its 400 body is the model's answer.
  const body =
    '{"statusCode":400,"error":"boards.validation","message":"The line for \\"Done\\" is 300 characters; a column line is at most 140."}'
  const f = fakeDeps({
    patch: async () => {
      throw new Error(`PATCH 400: ${body}`)
    },
  })
  const r = await handleBoardsTool(
    'boards_update_schema',
    {
      ...LINES_BASE,
      lines: {
        Done: {
          means: 'x'.repeat(300),
          waits_on: 'you',
          answers: [{ label: 'Go', move_to: 'Nowhere' }],
        },
      },
    },
    f.deps,
  )
  assert.equal(f.calls.length, 1, 'reached the server')
  assert.equal(r.isError, true)
  assert.equal(textOf(r), body)
})

test('an option in both lines and clear_lines is refused before the network', async () => {
  const f = fakeDeps({ patch: playbookEcho() })
  const r = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { rest: 'finished' } }, clear_lines: ['Done'] },
    f.deps,
  )
  assert.equal(r.isError, true)
  const t = textOf(r)
  assert.ok(t.includes('"Done"'), t)
  assert.ok(t.includes('clear_lines'), t)
  assert.equal(f.calls.length, 0)
})

test('a line that is not an object, and a lines call with nothing in it, are refused', async () => {
  const notObject = fakeDeps({ patch: playbookEcho() })
  const r1 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: 'finished' } },
    notObject.deps,
  )
  assert.equal(r1.isError, true)
  assert.ok(textOf(r1).includes('clear_lines'), textOf(r1))
  assert.equal(notObject.calls.length, 0)

  const empty = fakeDeps({ patch: playbookEcho() })
  const r2 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: {} },
    empty.deps,
  )
  assert.equal(r2.isError, true)
  assert.ok(textOf(r2).includes('nothing to write'), textOf(r2))
  assert.equal(empty.calls.length, 0)

  const emptyLine = fakeDeps({ patch: playbookEcho() })
  const r3 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: {} } },
    emptyLine.deps,
  )
  assert.equal(r3.isError, true)
  assert.equal(emptyLine.calls.length, 0)

  const wrongWorkflow = fakeDeps({ patch: playbookEcho() })
  const r4 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: {}, workflow: 'yes' },
    wrongWorkflow.deps,
  )
  assert.equal(r4.isError, true)
  assert.ok(textOf(r4).includes('workflow'), textOf(r4))
  assert.equal(wrongWorkflow.calls.length, 0)
})

test('only a workflow flag, or only a clear, is a legal write', async () => {
  const flag = fakeDeps({ patch: playbookEcho() })
  await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: {}, workflow: false },
    flag.deps,
  )
  assert.deepEqual(flag.calls[0]!.body, { workflow: false })

  const clear = fakeDeps({ patch: playbookEcho() })
  await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: {}, clear_lines: ['Done', 'Dropped'] },
    clear.deps,
  )
  assert.deepEqual(clear.calls[0]!.body, { optionRules: { Done: null, Dropped: null } })
})

test('an option named __proto__ is an own key on the wire, never a prototype', async () => {
  const f = fakeDeps({ patch: playbookEcho() })
  const lines = JSON.parse('{"__proto__": {"rest": "finished"}}') as Record<string, unknown>
  await handleBoardsTool('boards_update_schema', { ...LINES_BASE, lines }, f.deps)
  assert.equal(f.calls.length, 1)
  assert.equal(
    JSON.stringify(f.calls[0]!.body),
    '{"optionRules":{"__proto__":{"rest":"finished"}}}',
  )
})

test('set_options still refuses lines, and set_column_lines refuses options', async () => {
  const opts = fakeDeps({ patch: playbookEcho() })
  const r1 = await handleBoardsTool(
    'boards_update_schema',
    {
      board: 'decisions',
      op: 'set_options',
      field_key: 'status',
      options: ['Pending', 'Done'],
      lines: { Done: { rest: 'finished' } },
    },
    opts.deps,
  )
  assert.equal(r1.isError, true)
  assert.ok(textOf(r1).includes('"lines"'), textOf(r1))
  assert.equal(opts.calls.length, 0)

  const lines = fakeDeps({ patch: playbookEcho() })
  const r2 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { rest: 'finished' } }, options: ['Done'] },
    lines.deps,
  )
  assert.equal(r2.isError, true)
  assert.ok(textOf(r2).includes('"options"'), textOf(r2))
  assert.equal(lines.calls.length, 0)
})

test('option_renames is refused on every op but set_options', async () => {
  for (const extra of [
    { op: 'set_column_lines', field_key: 'status', lines: { Done: { rest: 'finished' } } },
    { op: 'rename_field', field_key: 'status', label: 'State' },
    { op: 'set_description', field_key: 'status', description: 'Where it is.' },
  ]) {
    const f = fakeDeps({ patch: playbookEcho() })
    const r = await handleBoardsTool(
      'boards_update_schema',
      { board: 'decisions', ...extra, option_renames: [{ from: 'Todo', to: 'Next' }] },
      f.deps,
    )
    assert.equal(r.isError, true, `${extra.op} accepted option_renames`)
    assert.ok(textOf(r).includes('"option_renames"'), textOf(r))
    assert.equal(f.calls.length, 0)
  }
})

test('a set_options with option_renames sends optionRenames', async () => {
  const f = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    {
      board: 'decisions',
      op: 'set_options',
      field_key: 'status',
      options: ['Next', 'Doing', 'Done'],
      option_renames: [{ from: 'Todo', to: 'Next' }],
    },
    f.deps,
  )
  assert.deepEqual(f.calls[0]!.body, {
    options: ['Next', 'Doing', 'Done'],
    optionRenames: [{ from: 'Todo', to: 'Next' }],
  })

  // Without renames the wire is byte for byte what 0.44.0 sent.
  const plain = fakeDeps()
  await handleBoardsTool(
    'boards_update_schema',
    { board: 'decisions', op: 'set_options', field_key: 'status', options: ['A', 'B'] },
    plain.deps,
  )
  assert.deepEqual(plain.calls[0]!.body, { options: ['A', 'B'] })
})

test('a malformed rename pair is refused before the network', async () => {
  for (const renames of [
    'Todo to Next',
    [{ from: 'Todo' }],
    [{ from: 'Todo', to: 7 }],
    [{ from: 'Todo', to: 'Next', merge: true }],
    [['Todo', 'Next']],
  ]) {
    const f = fakeDeps()
    const r = await handleBoardsTool(
      'boards_update_schema',
      {
        board: 'decisions',
        op: 'set_options',
        field_key: 'status',
        options: ['Next'],
        option_renames: renames,
      },
      f.deps,
    )
    assert.equal(r.isError, true, `accepted ${JSON.stringify(renames)}`)
    assert.ok(textOf(r).includes('option_renames'), textOf(r))
    assert.equal(f.calls.length, 0)
  }
})

test('a server that answers without playbook stored nothing, and the tool says so', async () => {
  // An older server's whitelist strips optionRules and workflow and answers
  // 200 with the field alone.
  const f = fakeDeps({
    patch: async () => ({ field: { key: 'status', label: 'Status', type: 'select' } }),
  })
  const r = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { rest: 'finished' } } },
    f.deps,
  )
  assert.equal(r.isError, true)
  assert.equal(
    textOf(r),
    'This BGOS server does not store column descriptions yet, so nothing was written.',
  )

  // A body that is not an object at all is the same answer, never a crash.
  for (const answer of [{}, 'ok', null]) {
    const g = fakeDeps({ patch: async () => answer })
    const r2 = await handleBoardsTool(
      'boards_update_schema',
      { ...LINES_BASE, lines: { Done: { rest: 'finished' } } },
      g.deps,
    )
    assert.equal(r2.isError, true, JSON.stringify(answer))
  }
})

test('a phase 1 server answer is rendered like any other schema write', async () => {
  const f = fakeDeps({ patch: playbookEcho() })
  const r = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { means: 'Shipped and checked.' } } },
    f.deps,
  )
  assert.equal(r.isError, undefined)
  const t = textOf(r)
  assert.ok(t.includes('"playbook"'), t)
  assert.ok(!t.includes('suggestion'), t)
})

test('a filed change is reported, not claimed', async () => {
  const f = fakeDeps({ patch: playbookEcho(['Done']) })
  const r = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { rest: 'parked' } } },
    f.deps,
  )
  assert.equal(r.isError, undefined, 'the call itself landed')
  assert.equal(
    textOf(r),
    'The owner decides how "Done" works, so your change to it was not ' +
      'applied and the column keeps its current setting. Do not send it again.',
  )
  assert.ok(!textOf(r).includes('"playbook"'), 'the body is not handed over as a success')

  const two = fakeDeps({ patch: playbookEcho(['Done', 'Dropped']) })
  const r2 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { rest: 'parked' } }, clear_lines: ['Dropped'] },
    two.deps,
  )
  assert.equal(
    textOf(r2),
    'The owner decides how "Done", "Dropped" work, so your change to them was ' +
      'not applied and those columns keep their current setting. Do not send ' +
      'them again.',
  )
})

test('a filed sentence never claims a confirmation or a suggestion, and names the sentence it saved (W1 close 2, review R3)', async () => {
  // The server files a change in two cases: the owner confirmed the board,
  // or the owner wrote that column's line on a board he never confirmed. The
  // answer is true in both, and a sentence sent for a filed column landed.
  const f = fakeDeps({ patch: playbookEcho(['Done']) })
  const r = await handleBoardsTool(
    'boards_update_schema',
    {
      ...LINES_BASE,
      lines: {
        Done: { means: 'Shipped and checked.', rest: 'parked' },
        Doing: { means: 'In hand.' },
      },
      workflow: true,
    },
    f.deps,
  )
  const t = textOf(r)
  assert.equal(
    t,
    'The owner decides how "Done" works, so your change to it was not ' +
      'applied and the column keeps its current setting, except the sentence ' +
      '(means) you sent for "Done", which was saved. Do not send the rest ' +
      'again. Everything else in this call was saved.',
  )
  assert.ok(!t.includes('confirmed'), t)
  assert.ok(!t.toLowerCase().includes('suggest'), t)

  // A sentence of spaces is no sentence: the server drops it, so it is not
  // claimed as saved.
  const g = fakeDeps({ patch: playbookEcho(['Done']) })
  const r2 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { means: '   ', rest: 'parked' } } },
    g.deps,
  )
  assert.ok(!textOf(r2).includes('which was saved'), textOf(r2))
})

test('no text the boards tools declare says suggestion, outside the instruction part (W1 close 2, review R3; retargeted in 0.50.0)', () => {
  // The descriptive half (a line's sentence and facts, a filed change, every
  // other tool) is never a suggestion: the owner is shown none for it, and the
  // tool text is what the model repeats to him. Retargeted ON PURPOSE in
  // 0.50.0 (Kanban phase 2, plan 3.7): the instruction part (`does`) IS a
  // suggestion the owner is shown and approves, so its own schema and the one
  // sentence of the lines text that names it are left out of this walk, and
  // the next case pins that they DO say it.
  const lines = linesSchema()
  const skipped = new Set<unknown>([lines.additionalProperties.properties.does])
  const strings: string[] = []
  const walk = (value: unknown) => {
    if (skipped.has(value)) return
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(BOARDS_TOOL_DECLS)
  assert.ok(strings.length > 100, `walked ${strings.length} strings`)
  const doesSentence =
    'A line\'s sentence and facts only describe the board; its does part is ' +
    'a suggestion until the owner approves it.'
  for (const s of strings) {
    const descriptive = s === lines.description ? s.replace(doesSentence, '') : s
    assert.ok(!descriptive.toLowerCase().includes('suggestion'), s)
  }
})

// ── The instruction part: a line's does (0.50.0) ─────────────────────────────
//
// Kanban phase 2 (plan 3.7, P2.13): a column line may carry a standing
// instruction for the agent a card is handed to. The tool takes it in snake
// case and sends the server's camel case, rebuilt key by key from a closed
// schema; the server files an agent's instruction as a SUGGESTION the owner
// approves word for word in the app, and answers the PATCH with the options it
// filed that way (`suggested`) and the ones whose words the owner already
// turned down (`declined`). The tool turns each list into one sentence the
// model reads, so it neither reports a suggestion as a working instruction nor
// sends the same words again. The server keeps every length and every
// reference; its refusal reaches the model verbatim.
//
// MUTATION PROOFS (each applied to lib/boards-tools.ts, confirmed red,
// restored from one pristine copy byte for byte):
//
// 12. SNAKE CASE THROUGH. Sent the model's `does` object as it came instead
//     of the rebuilt camel case one -> "set_column_lines with a does sends
//     exactly the camel case does", "ask_for_note maps to askForNote" and "the
//     compiled does body equals the golden fixture" fail (three red). The
//     server's rebuild refuses a snake key, so every instruction would be
//     refused.
// 13. THE NOTE LEFT OUT. Dropped the ask_for_note assignment -> "ask_for_note
//     maps to askForNote", "set_column_lines with a does sends exactly the
//     camel case does" and the golden fixture case fail (three red).
// 14. AN OPEN SCHEMA. Dropped the stray key check of the does object ->
//     "an unknown does key is refused by name, the server owned ones
//     included" fails (one red): `approved` and `textHash` would reach the
//     wire.
// 15. SUGGESTED IGNORED. Stopped reading `suggested` from the echo -> "a
//     suggested instruction is answered with one sentence naming the
//     column", "filed, suggested and declined answer together", the golden
//     fixture case and "the does description, the lines text and the
//     suggested sentence DO say suggestion" fail (four red): the model would
//     read the raw echo as an instruction that works and send it again.
// 16. DECLINED IGNORED. Stopped reading `declined` -> "a declined
//     instruction is answered with the declined sentence" and the combined
//     case fail (two red).
// 17. A LATE STARTS WHEN. Allowed every value of starts_when through ->
//     "a does shape or enum outside the schema is refused before the
//     network" fails (one red) on agent_moves_in, which nothing honours
//     today.
// 18. THE REST UNSAID. Never added "Everything else in this call was saved."
//     -> the suggested case fails on the line that also carried a sentence
//     (means), which WAS saved, and so do the combined case and phase 1's "a
//     filed sentence never claims a confirmation or a suggestion" (three red):
//     the closing sentence moved out of the filed sentence to be said once.

/** The `lines` property of boards_update_schema, as declared. */
function linesSchema(): {
  description: string
  additionalProperties: {
    properties: Record<string, unknown> & {
      does: {
        type: string
        additionalProperties: boolean
        description: string
        properties: Record<string, Record<string, unknown>>
      }
    }
  }
} {
  const props = (decl('boards_update_schema').inputSchema as unknown as {
    properties: Record<string, unknown>
  }).properties
  return props.lines as ReturnType<typeof linesSchema>
}

function doesEcho(lists: { filed?: string[]; suggested?: string[]; declined?: string[] }) {
  return async () => ({
    field: { key: 'status', label: 'Status', type: 'select' },
    playbook: { status: { workflow: true, lines: {} } },
    filed: lists.filed ?? [],
    suggested: lists.suggested ?? [],
    ...(lists.declined ? { declined: lists.declined } : {}),
  })
}

/** The canonical does case: the args behind the golden fixture. */
const CANONICAL_DOES_LINES = {
  Ready: {
    does: {
      kind: 'start',
      instruction: 'Draft the brief from the card, then move it to Review.',
      starts_when: ['person_moves_in'],
      who: { by: 'ask_at_drop' },
      needs: [{ field_key: 'brief' }],
      ask_for_note: 'offer',
      lands_in: ['Review'],
      plan_first: 'ask',
    },
  },
}

const SUGGESTED_READY =
  'Your instruction for "Ready" is saved as a suggestion. Nothing starts ' +
  'until your owner approves those exact words in the app. Do not send it again.'

const DECLINED_READY =
  'Your owner turned down that instruction for "Ready". Do not send it ' +
  'again unless your owner asks for a different one.'

test('the does schema is closed and says what the plan says', () => {
  const does = linesSchema().additionalProperties.properties.does
  assert.equal(does.type, 'object')
  assert.equal(does.additionalProperties, false)
  assert.deepEqual(Object.keys(does.properties), [
    'kind',
    'instruction',
    'starts_when',
    'who',
    'only_when',
    'needs',
    'ask_for_note',
    'fills',
    'lands_in',
    'plan_first',
  ])
  assert.deepEqual(does.properties.kind!.enum, ['start', 'tell'])
  assert.deepEqual(
    (does.properties.starts_when!.items as { enum: string[] }).enum,
    ['person_moves_in'],
  )
  const who = does.properties.who as {
    additionalProperties: boolean
    required: string[]
    properties: { by: { enum: string[] } }
  }
  assert.equal(who.additionalProperties, false)
  assert.deepEqual(who.required, ['by'])
  assert.deepEqual(who.properties.by.enum, ['agent', 'card_field', 'ask_at_drop'])
  assert.deepEqual(does.properties.ask_for_note!.enum, ['offer', 'require'])
  assert.deepEqual(does.properties.plan_first!.enum, ['ask', 'always', 'never'])
  for (const key of ['approved', 'textHash', 'text_hash', 'v', 'paused']) {
    assert.equal(key in does.properties, false, `${key} is declared`)
  }
})

test('the does description, the lines text and the suggested sentence DO say suggestion', async () => {
  const lines = linesSchema()
  assert.ok(lines.additionalProperties.properties.does.description.includes('suggestion'))
  assert.ok(
    lines.additionalProperties.properties.does.description.includes(
      'nothing starts until the owner approves these exact words in the app',
    ),
  )
  assert.ok(lines.description.includes('its does part is a suggestion'))
  const f = fakeDeps({ patch: doesEcho({ suggested: ['Ready'] }) })
  const r = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: CANONICAL_DOES_LINES },
    f.deps,
  )
  assert.ok(textOf(r).includes('saved as a suggestion'), textOf(r))
})

test('set_column_lines with a does sends exactly the camel case does', async () => {
  const f = fakeDeps({ patch: doesEcho({ suggested: ['Ready', 'Review', 'Parked'] }) })
  const r = await handleBoardsTool(
    'boards_update_schema',
    {
      ...LINES_BASE,
      lines: {
        Ready: {
          means: 'Cards an agent can start on.',
          does: {
            kind: 'start',
            instruction: 'Draft the brief.',
            starts_when: ['person_moves_in'],
            who: { by: 'agent', assistant_id: 3 },
            only_when: { field_key: 'priority', in: ['High', 'Medium'] },
            needs: [{ field_key: 'brief' }, { field_key: 'area', in: ['Ads'] }],
            ask_for_note: 'require',
            fills: ['brief', 'due'],
            lands_in: ['Review', 'Done'],
            plan_first: 'always',
          },
        },
        Review: {
          does: {
            kind: 'tell',
            instruction: 'Tell the owner of the card it is in review.',
            who: { by: 'card_field', field_key: 'owner' },
            only_when: { field_key: 'due', empty: true },
          },
        },
        Parked: { does: { kind: 'tell', who: { by: 'ask_at_drop' }, plan_first: 'never' } },
      },
    },
    f.deps,
  )
  assert.equal(r.isError, undefined, textOf(r))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0]!.body, {
    optionRules: {
      Ready: {
        means: 'Cards an agent can start on.',
        does: {
          kind: 'start',
          instruction: 'Draft the brief.',
          startsWhen: ['person_moves_in'],
          who: { by: 'agent', assistantId: 3 },
          onlyWhen: { fieldKey: 'priority', in: ['High', 'Medium'] },
          needs: [{ fieldKey: 'brief' }, { fieldKey: 'area', in: ['Ads'] }],
          askForNote: 'require',
          fills: ['brief', 'due'],
          landsIn: ['Review', 'Done'],
          planFirst: 'always',
        },
      },
      Review: {
        does: {
          kind: 'tell',
          instruction: 'Tell the owner of the card it is in review.',
          who: { by: 'card_field', fieldKey: 'owner' },
          onlyWhen: { fieldKey: 'due', empty: true },
        },
      },
      Parked: { does: { kind: 'tell', who: { by: 'ask_at_drop' }, planFirst: 'never' } },
    },
  })
  // The plugin never sends the owner's approval, the hash of the words he
  // approved, a version stamp or the owner's pause, anywhere in the body.
  const wire = JSON.stringify(f.calls[0]!.body)
  for (const key of ['approved', 'textHash', '"v"', 'paused', 'writtenBy']) {
    assert.equal(wire.includes(key), false, `${key} on the wire: ${wire}`)
  }
  // And no snake case key anywhere (values such as person_moves_in are the
  // server's own enum spellings and stay as they are).
  const keys: string[] = []
  const walkKeys = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walkKeys)
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        keys.push(k)
        walkKeys(v)
      }
    }
  }
  walkKeys(f.calls[0]!.body)
  for (const k of keys) {
    if (k === 'Ready' || k === 'Review' || k === 'Parked') continue
    assert.equal(k.includes('_'), false, `snake case key ${k} on the wire`)
  }
})

test('ask_for_note maps to askForNote', async () => {
  for (const value of ['offer', 'require']) {
    const f = fakeDeps({ patch: doesEcho({ suggested: ['Ready'] }) })
    const r = await handleBoardsTool(
      'boards_update_schema',
      { ...LINES_BASE, lines: { Ready: { does: { kind: 'start', ask_for_note: value } } } },
      f.deps,
    )
    assert.equal(r.isError, undefined, textOf(r))
    assert.deepEqual(f.calls[0]!.body, {
      optionRules: { Ready: { does: { kind: 'start', askForNote: value } } },
    })
  }
})

test('an unknown does key is refused by name, the server owned ones included', async () => {
  for (const key of ['approved', 'textHash', 'v', 'paused', 'writtenBy', 'askForNote', 'note']) {
    const f = fakeDeps({ patch: doesEcho({ suggested: ['Ready'] }) })
    const r = await handleBoardsTool(
      'boards_update_schema',
      {
        ...LINES_BASE,
        lines: { Ready: { does: { kind: 'start', instruction: 'Go.', [key]: 'x' } } },
      },
      f.deps,
    )
    assert.equal(r.isError, true, `accepted ${key}`)
    const t = textOf(r)
    assert.ok(t.includes(`"${key}"`), t)
    assert.ok(t.includes('lines.Ready.does'), t)
    assert.ok(
      t.includes(
        'kind, instruction, starts_when, who, only_when, needs, ask_for_note, ' +
          'fills, lands_in, plan_first',
      ),
      t,
    )
    assert.equal(f.calls.length, 0)
  }
})

test('a does shape or enum outside the schema is refused before the network', async () => {
  const cases: Array<[unknown, string]> = [
    ['Draft the brief.', 'lines.Ready.does'],
    [{}, 'is empty'],
    [{ kind: 'begin' }, 'start, tell'],
    [{ instruction: 42 }, 'lines.Ready.does.instruction'],
    [{ starts_when: 'person_moves_in' }, 'lines.Ready.does.starts_when'],
    [{ starts_when: ['agent_moves_in'] }, 'person_moves_in'],
    [{ starts_when: ['card_created_here'] }, 'person_moves_in'],
    [{ who: 'Nova' }, 'lines.Ready.does.who'],
    [{ who: {} }, 'agent, card_field, ask_at_drop'],
    [{ who: { by: 'someone' } }, 'agent, card_field, ask_at_drop'],
    [{ who: { by: 'agent' } }, 'assistant_id'],
    [{ who: { by: 'agent', assistant_id: '3' } }, 'assistant_id'],
    [{ who: { by: 'agent', assistant_id: 0 } }, 'assistant_id'],
    [{ who: { by: 'agent', assistant_id: 1.5 } }, 'assistant_id'],
    [{ who: { by: 'agent', assistant_id: 3, field_key: 'owner' } }, '"field_key"'],
    [{ who: { by: 'card_field' } }, 'field_key'],
    [{ who: { by: 'card_field', field_key: 'owner', assistant_id: 3 } }, '"assistant_id"'],
    [{ who: { by: 'ask_at_drop', assistant_id: 3 } }, '"assistant_id"'],
    [{ who: { by: 'agent', assistant_id: 3, name: 'Nova' } }, '"name"'],
    [{ only_when: { in: ['High'] } }, 'field_key'],
    [{ only_when: { field_key: 'priority' } }, 'in or empty'],
    [{ only_when: { field_key: 'priority', in: ['High'], empty: true } }, 'in or empty'],
    [{ only_when: { field_key: 'priority', empty: false } }, 'empty'],
    [{ only_when: { field_key: 'priority', in: 'High' } }, 'lines.Ready.does.only_when.in'],
    [{ only_when: { field_key: 'priority', is: ['High'] } }, '"is"'],
    [{ needs: { field_key: 'brief' } }, 'lines.Ready.does.needs'],
    [{ needs: ['brief'] }, 'lines.Ready.does.needs[0]'],
    [{ needs: [{ in: ['x'] }] }, 'field_key'],
    [{ needs: [{ field_key: 'brief', filled: true }] }, '"filled"'],
    [{ needs: [{ field_key: 'area', in: [1] }] }, 'lines.Ready.does.needs[0].in'],
    [{ ask_for_note: 'always' }, 'offer, require'],
    [{ fills: 'brief' }, 'lines.Ready.does.fills'],
    [{ lands_in: [1] }, 'lines.Ready.does.lands_in'],
    [{ plan_first: 'sometimes' }, 'ask, always, never'],
  ]
  for (const [does, needle] of cases) {
    const f = fakeDeps({ patch: doesEcho({ suggested: ['Ready'] }) })
    const r = await handleBoardsTool(
      'boards_update_schema',
      { ...LINES_BASE, lines: { Ready: { does } } },
      f.deps,
    )
    assert.equal(r.isError, true, `accepted ${JSON.stringify(does)}`)
    assert.ok(textOf(r).includes(needle), `${needle} not in ${textOf(r)}`)
    assert.equal(f.calls.length, 0, `reached the server with ${JSON.stringify(does)}`)
  }
})

test('lengths and references in a does are the server\'s, and its sentence reaches the model verbatim', async () => {
  const body =
    '{"statusCode":400,"error":"boards.validation","message":"The instruction for \\"Ready\\" is longer than 1200 characters."}'
  const f = fakeDeps({
    patch: async () => {
      throw new Error(`PATCH 400: ${body}`)
    },
  })
  const r = await handleBoardsTool(
    'boards_update_schema',
    {
      ...LINES_BASE,
      lines: {
        Ready: {
          does: {
            kind: 'start',
            instruction: 'x'.repeat(2000),
            needs: Array.from({ length: 25 }, (_, i) => ({ field_key: `f${i}` })),
            lands_in: ['Nowhere'],
            who: { by: 'agent', assistant_id: 999999 },
          },
        },
      },
    },
    f.deps,
  )
  assert.equal(f.calls.length, 1, 'reached the server')
  assert.equal(r.isError, true)
  assert.equal(textOf(r), body)
})

test('the compiled does body equals the golden fixture', async () => {
  // S2-VIS's PLG-01 posts these exact bytes to the phase 2 server's agent
  // route and reads `suggested` back, so the fixture must be what the tool
  // really compiles, never a hand written guess.
  const golden = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('./fixtures/set-column-lines-does.json', import.meta.url)),
      'utf8',
    ),
  ) as unknown
  const f = fakeDeps({ patch: doesEcho({ suggested: ['Ready'] }) })
  const r = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: CANONICAL_DOES_LINES },
    f.deps,
  )
  assert.equal(r.isError, undefined, textOf(r))
  assert.equal(f.calls[0]!.method, 'PATCH')
  assert.equal(f.calls[0]!.path, `${BASE}/decisions/fields/status`)
  assert.deepEqual(f.calls[0]!.body, golden)
  assert.equal(textOf(r), SUGGESTED_READY)
})

test('a suggested instruction is answered with one sentence naming the column', async () => {
  const f = fakeDeps({ patch: doesEcho({ suggested: ['Ready'] }) })
  const r = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: CANONICAL_DOES_LINES },
    f.deps,
  )
  assert.equal(r.isError, undefined, 'the call itself landed')
  assert.equal(textOf(r), SUGGESTED_READY)
  assert.ok(!textOf(r).includes('"playbook"'), 'the echo is not handed over as a working instruction')

  // Two columns, quoted and comma joined; a sentence sent beside the
  // instruction WAS saved, and the answer says so.
  const two = fakeDeps({ patch: doesEcho({ suggested: ['Ready', 'Review'] }) })
  const r2 = await handleBoardsTool(
    'boards_update_schema',
    {
      ...LINES_BASE,
      lines: {
        Ready: { means: 'Cards an agent can start on.', does: { kind: 'start', instruction: 'Go.' } },
        Review: { does: { kind: 'tell', instruction: 'Look.' } },
      },
    },
    two.deps,
  )
  assert.equal(
    textOf(r2),
    'Your instruction for "Ready", "Review" is saved as a suggestion. Nothing ' +
      'starts until your owner approves those exact words in the app. Do not ' +
      'send it again. Everything else in this call was saved.',
  )

  // An instruction equal to the approved one is in neither list: the echo is
  // rendered like any other schema write.
  const same = fakeDeps({ patch: doesEcho({}) })
  const r3 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: CANONICAL_DOES_LINES },
    same.deps,
  )
  assert.ok(textOf(r3).includes('"playbook"'), textOf(r3))
  assert.ok(!textOf(r3).includes('suggestion'), textOf(r3))
})

test('a declined instruction is answered with the declined sentence', async () => {
  const f = fakeDeps({ patch: doesEcho({ declined: ['Ready'] }) })
  const r = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: CANONICAL_DOES_LINES },
    f.deps,
  )
  assert.equal(r.isError, undefined)
  assert.equal(textOf(r), DECLINED_READY)
  assert.ok(!textOf(r).includes('saved as a suggestion'), textOf(r))
})

test('filed, suggested and declined answer together, in that order', async () => {
  const f = fakeDeps({
    patch: doesEcho({ filed: ['Done'], suggested: ['Ready'], declined: ['Review'] }),
  })
  const r = await handleBoardsTool(
    'boards_update_schema',
    {
      ...LINES_BASE,
      lines: {
        Done: { rest: 'parked' },
        Ready: CANONICAL_DOES_LINES.Ready,
        Review: { does: { kind: 'tell', instruction: 'Look.' } },
      },
    },
    f.deps,
  )
  assert.equal(
    textOf(r),
    'The owner decides how "Done" works, so your change to it was not ' +
      'applied and the column keeps its current setting. Do not send it again. ' +
      SUGGESTED_READY +
      ' Your owner turned down that instruction for "Review". Do not send it ' +
      'again unless your owner asks for a different one.',
  )

  // A workflow flag sent beside them was saved, and is said once, last.
  const g = fakeDeps({ patch: doesEcho({ filed: ['Done'], suggested: ['Ready'] }) })
  const r2 = await handleBoardsTool(
    'boards_update_schema',
    { ...LINES_BASE, lines: { Done: { rest: 'parked' }, ...CANONICAL_DOES_LINES }, workflow: true },
    g.deps,
  )
  assert.ok(textOf(r2).endsWith(`${SUGGESTED_READY} Everything else in this call was saved.`), textOf(r2))
})
