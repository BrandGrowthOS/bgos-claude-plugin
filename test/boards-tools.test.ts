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
      assert.ok(!node.includes('—'), `em dash in ${path}`)
      assert.ok(!node.includes('–'), `en dash in ${path}`)
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
  assert.ok(!src.includes('—'), 'em dash in lib/boards-tools.ts')
  assert.ok(!src.includes('–'), 'en dash in lib/boards-tools.ts')
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
