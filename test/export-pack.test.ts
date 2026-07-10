/**
 * export_pack RPC core tests (Agent Packs, Type 3 Full handoff).
 *
 * Coverage: frame normalization, the collection allowlist (body + requested
 * memory only), hard exclusions (.mcp.json, .claude/settings*, *.log,
 * dotfiles), path escape rejection (.., absolute, backslash, symlink
 * escapes via the realpath gate), the secret scan block with file + line,
 * the manifest shape, every result body (ok, SECRET_SCAN_BLOCKED,
 * PACK_TOO_LARGE, UPLOAD_FAILED, MANIFEST_ONLY, INVALID_MEMORY_FILE,
 * PATH_ESCAPE, BAD_FRAME, PLUGIN_ERROR), the maxBytes gate running BEFORE
 * upload, the export_pack_manifest dry run, rpcId dedupe, best-effort ACK,
 * and end-to-end determinism (same inputs, byte-identical uploads).
 *
 * Deps are injected fakes (this repo's voice-rpc test pattern); no real fs,
 * network, or clock is ever touched.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ExportPackHandler,
  normalizeExportPack,
  normalizeExportPackManifest,
  classifyPackFile,
  discoverCandidates,
  collectCandidates,
  extractRequiredEnv,
  buildErrorResult,
  normalizeToUtf8,
  slugify,
  sha256Hex,
  DEFAULT_MAX_PACK_BYTES,
  type ExportPackDeps,
  type ExportPackFrame,
  type ExportPackResultBody,
} from '../lib/export-pack.ts'
import { readStoredZip, MANIFEST_ENTRY_NAME } from '../lib/pack-zip.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** UTF-16LE bytes with a leading BOM (what "Unicode" in a Windows editor
 *  writes). ASCII/BMP content only, which is all these tests need. */
function utf16leWithBom(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2)
  out[0] = 0xff
  out[1] = 0xfe
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    out[2 + i * 2] = code & 0xff
    out[2 + i * 2 + 1] = (code >> 8) & 0xff
  }
  return out
}

/** UTF-8 bytes with a leading BOM (EF BB BF). */
function utf8WithBom(text: string): Uint8Array {
  const body = enc.encode(text)
  const out = new Uint8Array(3 + body.length)
  out[0] = 0xef
  out[1] = 0xbb
  out[2] = 0xbf
  out.set(body, 3)
  return out
}

// ── Fakes ────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-07-10T10:00:00.000Z')

interface Recorded {
  acks: string[]
  results: Array<{ rpcId: string; body: ExportPackResultBody }>
  puts: Array<{
    url: string
    method: string | undefined
    headers: Record<string, string>
    body: Uint8Array
  }>
}

function makeDeps(over: {
  files?: Record<string, string | Uint8Array>
  realOverrides?: Record<string, string>
  fetchStatus?: number
  fetchThrows?: boolean
  ackFails?: boolean
  listFails?: boolean
} = {}): { deps: ExportPackDeps; rec: Recorded } {
  const rec: Recorded = { acks: [], results: [], puts: [] }
  const files = over.files ?? {}
  const bytesOf = (content: string | Uint8Array): Uint8Array =>
    typeof content === 'string' ? enc.encode(content) : content
  const deps: ExportPackDeps = {
    config: { workspaceRoot: '/ws', assistantId: '901' },
    postAck: async (rpcId) => {
      if (over.ackFails) throw new Error('ack endpoint down')
      rec.acks.push(rpcId)
    },
    postResult: async (rpcId, body) => {
      rec.results.push({ rpcId, body })
    },
    listWorkspaceFiles: async () => {
      if (over.listFails) throw new Error('filesystem exploded')
      return Object.entries(files).map(([path, content]) => ({
        path,
        bytes: bytesOf(content).length,
      }))
    },
    readFile: async (relPath) => {
      const content = files[relPath]
      if (content === undefined) throw new Error(`ENOENT: ${relPath}`)
      return bytesOf(content)
    },
    realpath: async (relPath) => {
      if (relPath === '') return '/ws'
      const overridden = over.realOverrides?.[relPath]
      if (overridden) return overridden
      if (files[relPath] === undefined) throw new Error(`ENOENT: ${relPath}`)
      return `/ws/${relPath}`
    },
    log: () => {},
    fetchImpl: (async (url: any, init?: any) => {
      if (over.fetchThrows) throw new Error('network down')
      rec.puts.push({
        url: String(url),
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as Uint8Array,
      })
      return new Response('', { status: over.fetchStatus ?? 200 })
    }) as typeof fetch,
    now: () => FIXED_NOW,
  }
  return { deps, rec }
}

function frame(over: Partial<ExportPackFrame> = {}): ExportPackFrame {
  return {
    rpcId: 'rpc-1',
    handoffId: 'h-1',
    assistantId: '901',
    tier: 'fresh',
    memoryFiles: [],
    uploadUrl: 'https://s3.example/packs/put?sig=abc',
    maxBytes: DEFAULT_MAX_PACK_BYTES,
    rulesVersion: 1,
    agentName: 'Atlas',
    sourceGeneration: 0,
    ...over,
  }
}

/** A realistic workspace: allowlisted body, memory, and plenty that must
 *  NEVER ship. */
const WORKSPACE: Record<string, string> = {
  'CLAUDE.md': '# Atlas\n\nServe well. Set OPENAI_API_KEY before web search.\n',
  '.claude/rules/style.md': 'No tables in replies.\n',
  '.claude/skills/research/SKILL.md':
    '---\nname: research\n---\nNeeds SERP_API_TOKEN in the environment.\n',
  'memory/notes.md': 'User prefers dark mode.\n',
  '.claude/memory/deep.md': 'Deep memory line.\n',
  '.mcp.json': '{"mcpServers":{}}',
  '.claude/settings.local.json': '{"enableAllProjectMcpServers":true}',
  '.claude/settings.json': '{}',
  'debug.log': 'log line',
  'memory/trace.log': 'log line',
  'memory/.hidden.md': 'dotfile memory',
  '.env': 'API_KEY=not-packed-ever',
  'src/index.ts': 'export {}',
}

function lastResult(rec: Recorded): ExportPackResultBody {
  assert.ok(rec.results.length > 0, 'expected a result to be posted')
  return rec.results[rec.results.length - 1]!.body
}

// ── Frame normalization ──────────────────────────────────────────────────────

test('normalizeExportPack passes a full camelCase frame through', () => {
  const out = normalizeExportPack({
    rpcId: 'r1',
    handoffId: 'h1',
    assistantId: 901,
    tier: 'experienced',
    memoryFiles: ['memory/a.md', 42, null, 'memory/b.md'],
    uploadUrl: 'https://s3/put',
    maxBytes: 1000,
    rulesVersion: 1,
  })!
  assert.equal(out.rpcId, 'r1')
  assert.equal(out.handoffId, 'h1')
  assert.equal(out.assistantId, '901')
  assert.equal(out.tier, 'experienced')
  assert.deepEqual(out.memoryFiles, ['memory/a.md', 'memory/b.md'])
  assert.equal(out.uploadUrl, 'https://s3/put')
  assert.equal(out.maxBytes, 1000)
  assert.equal(out.rulesVersion, 1)
})

test('normalizeExportPack drops frames without an rpcId, defaults the rest', () => {
  assert.equal(normalizeExportPack(null), null)
  assert.equal(normalizeExportPack('x'), null)
  assert.equal(normalizeExportPack({ handoffId: 'h1' }), null)
  const out = normalizeExportPack({ rpcId: 'r1' })!
  assert.equal(out.tier, 'fresh')
  assert.deepEqual(out.memoryFiles, [])
  assert.equal(out.uploadUrl, '')
  assert.equal(out.maxBytes, DEFAULT_MAX_PACK_BYTES)
  assert.equal(out.rulesVersion, 1)
  assert.equal(out.sourceGeneration, 0)
})

test('normalizeExportPackManifest requires rpcId only', () => {
  assert.equal(normalizeExportPackManifest({}), null)
  const out = normalizeExportPackManifest({ rpcId: 'm1', assistantId: 901 })!
  assert.deepEqual(out, { rpcId: 'm1', assistantId: '901' })
})

// ── Pure collection contract ─────────────────────────────────────────────────

test('classifyPackFile maps the allowlist and rejects everything else', () => {
  assert.deepEqual(classifyPackFile('CLAUDE.md'), {
    packPath: 'agent/CLAUDE.md',
    kind: 'body',
  })
  assert.deepEqual(classifyPackFile('.claude/rules/style.md'), {
    packPath: 'agent/rules/style.md',
    kind: 'body',
  })
  assert.deepEqual(classifyPackFile('.claude/skills/research/SKILL.md'), {
    packPath: 'agent/skills/research/SKILL.md',
    kind: 'body',
  })
  assert.deepEqual(classifyPackFile('memory/notes.md'), {
    packPath: 'memory/notes.md',
    kind: 'memory',
  })
  assert.deepEqual(classifyPackFile('.claude/memory/deep.md'), {
    packPath: 'memory/deep.md',
    kind: 'memory',
  })
  // Hard exclusions and non-allowlisted files.
  for (const path of [
    '.mcp.json',
    '.claude/settings.local.json',
    '.claude/settings.json',
    'debug.log',
    'memory/trace.log',
    'memory/.hidden.md',
    '.env',
    'src/index.ts',
    '.claude/rules/nested/dir.md',
    '.claude/skills/research/helper.md',
    '.claude/rules/readme.txt',
    'memory/',
    '../outside.md',
    '/abs/CLAUDE.md',
    'memory\\win.md',
  ]) {
    assert.equal(classifyPackFile(path), null, `${path} must not classify`)
  }
})

test('discoverCandidates sorts body first and dedupes colliding pack paths', () => {
  const listing = [
    { path: 'memory/x.md', bytes: 3 },
    { path: '.claude/memory/x.md', bytes: 4 },
    { path: 'CLAUDE.md', bytes: 5 },
  ]
  const out = discoverCandidates(listing)
  assert.deepEqual(
    out.map((c) => `${c.kind}:${c.workspacePath}->${c.packPath}`),
    ['body:CLAUDE.md->agent/CLAUDE.md', 'memory:.claude/memory/x.md->memory/x.md'],
  )
})

test('collectCandidates on fresh tier ships body only and ignores memory requests', () => {
  const listing = Object.keys(WORKSPACE).map((path) => ({ path, bytes: 1 }))
  const out = collectCandidates(listing, {
    tier: 'fresh',
    memoryFiles: ['memory/notes.md'],
  })
  assert.ok(out.ok)
  assert.deepEqual(
    out.candidates.map((c) => c.workspacePath),
    ['.claude/rules/style.md', '.claude/skills/research/SKILL.md', 'CLAUDE.md'],
  )
  assert.deepEqual(
    out.candidates.map((c) => c.packPath),
    ['agent/rules/style.md', 'agent/skills/research/SKILL.md', 'agent/CLAUDE.md'],
  )
})

test('extractRequiredEnv finds only referenced _KEY/_TOKEN/_SECRET names', () => {
  const names = extractRequiredEnv([
    'Set OPENAI_API_KEY and GITHUB_TOKEN before running.',
    'Also honors WEBHOOK_SIGNING_SECRET. PATH and MY_VAR and DB_PASSWORD do not count.',
    'OPENAI_API_KEY again (dedupe me).',
  ])
  assert.deepEqual(names, [
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'WEBHOOK_SIGNING_SECRET',
  ])
  assert.deepEqual(extractRequiredEnv(['nothing secret referenced here']), [])
})

test('slugify follows the bgos-build-agent convention', () => {
  assert.equal(slugify('Deep Research Agent'), 'deep-research-agent')
  assert.equal(slugify('  Atlas!! v2  '), 'atlas-v2')
  assert.equal(slugify(''), 'agent')
})

test('buildErrorResult omits findings when absent', () => {
  assert.deepEqual(buildErrorResult('BAD_FRAME', 'nope'), {
    ok: false,
    error: { code: 'BAD_FRAME', message: 'nope' },
  })
})

// ── handleExport: happy paths ────────────────────────────────────────────────

test('fresh export packs exactly the body allowlist and uploads once', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(deps).handleExport(frame())

  assert.deepEqual(rec.acks, ['rpc-1'])
  assert.equal(rec.puts.length, 1)
  const put = rec.puts[0]!
  assert.equal(put.url, 'https://s3.example/packs/put?sig=abc')
  assert.equal(put.method, 'PUT')
  assert.equal(put.headers['Content-Type'], 'application/zip')

  const body = lastResult(rec)
  assert.equal(body.ok, true)
  const payload = body.payload as {
    manifest: Record<string, any>
    packSha256: string
    packBytes: number
  }
  assert.equal(payload.packBytes, put.body.length)
  assert.equal(payload.packSha256, sha256Hex(put.body))

  // The uploaded zip is readable, manifest.json first, body entries sorted.
  const entries = readStoredZip(put.body)
  assert.deepEqual(
    entries.map((e) => e.path),
    [
      MANIFEST_ENTRY_NAME,
      'agent/CLAUDE.md',
      'agent/rules/style.md',
      'agent/skills/research/SKILL.md',
    ],
  )
  // The in-zip manifest is byte-for-byte the reported manifest.
  assert.deepEqual(JSON.parse(dec.decode(entries[0]!.data)), payload.manifest)
  // Packed file bytes are the source bytes.
  assert.equal(dec.decode(entries[1]!.data), WORKSPACE['CLAUDE.md'])

  // Manifest shape (schema_version 1).
  assert.deepEqual(payload.manifest, {
    schema_version: 1,
    pack: {
      name: 'Atlas',
      slug: 'atlas',
      packaged_at: '2026-07-10T10:00:00.000Z',
    },
    agent_class: 'claude-code',
    tier: 'fresh',
    persona: null,
    starter_prompts: null,
    model_prefs: { tone: null },
    required_env: ['OPENAI_API_KEY', 'SERP_API_TOKEN'],
    files: [
      {
        path: 'agent/CLAUDE.md',
        sha256: sha256Hex(enc.encode(WORKSPACE['CLAUDE.md']!)),
        bytes: enc.encode(WORKSPACE['CLAUDE.md']!).length,
      },
      {
        path: 'agent/rules/style.md',
        sha256: sha256Hex(enc.encode(WORKSPACE['.claude/rules/style.md']!)),
        bytes: enc.encode(WORKSPACE['.claude/rules/style.md']!).length,
      },
      {
        path: 'agent/skills/research/SKILL.md',
        sha256: sha256Hex(
          enc.encode(WORKSPACE['.claude/skills/research/SKILL.md']!),
        ),
        bytes: enc.encode(WORKSPACE['.claude/skills/research/SKILL.md']!).length,
      },
    ],
    secret_scan: {
      status: 'pass',
      rules_version: 1,
      files_scanned: 3,
      scanned_at: '2026-07-10T10:00:00.000Z',
    },
    lineage: {
      source_assistant_id: '901',
      source_generation: 0,
      platform: 'home-of-agents',
    },
  })
})

test('experienced export ships ONLY the requested memory files', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(deps).handleExport(
    frame({
      tier: 'experienced',
      memoryFiles: ['memory/notes.md', '.claude/memory/deep.md'],
    }),
  )
  const body = lastResult(rec)
  assert.equal(body.ok, true)
  const entries = readStoredZip(rec.puts[0]!.body)
  assert.deepEqual(
    entries.map((e) => e.path),
    [
      MANIFEST_ENTRY_NAME,
      'agent/CLAUDE.md',
      'agent/rules/style.md',
      'agent/skills/research/SKILL.md',
      'memory/deep.md',
      'memory/notes.md',
    ],
  )
  const manifest = (body.payload as any).manifest
  assert.equal(manifest.tier, 'experienced')
  assert.equal(manifest.secret_scan.files_scanned, 5)
})

test('experienced export with NO opted-in memory ships body only', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(deps).handleExport(
    frame({ tier: 'experienced', memoryFiles: [] }),
  )
  const entries = readStoredZip(rec.puts[0]!.body)
  assert.equal(entries.some((e) => e.path.startsWith('memory/')), false)
})

test('fresh export never ships memory even when the frame smuggles requests', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(deps).handleExport(
    frame({ tier: 'fresh', memoryFiles: ['memory/notes.md'] }),
  )
  const entries = readStoredZip(rec.puts[0]!.body)
  assert.equal(entries.some((e) => e.path.startsWith('memory/')), false)
})

test('same inputs produce byte-identical uploads (determinism end to end)', async () => {
  const a = makeDeps({ files: WORKSPACE })
  const b = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(a.deps).handleExport(frame())
  await new ExportPackHandler(b.deps).handleExport(frame())
  assert.deepEqual(
    Buffer.from(a.rec.puts[0]!.body),
    Buffer.from(b.rec.puts[0]!.body),
  )
  assert.equal(
    (lastResult(a.rec).payload as any).packSha256,
    (lastResult(b.rec).payload as any).packSha256,
  )
})

// ── handleExport: rejection paths (no upload on ANY of these) ────────────────

test('requested file outside memory dirs is rejected as INVALID_MEMORY_FILE', async () => {
  const { deps, rec } = makeDeps({
    files: { ...WORKSPACE, 'src/secrets.md': 'not memory' },
  })
  await new ExportPackHandler(deps).handleExport(
    frame({ tier: 'experienced', memoryFiles: ['src/secrets.md'] }),
  )
  const body = lastResult(rec)
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'INVALID_MEMORY_FILE')
  assert.ok(body.error!.message.includes('src/secrets.md'))
  assert.equal(rec.puts.length, 0, 'nothing may upload on a rejected request')
})

test('excluded memory files (logs, dotfiles) cannot be requested', async () => {
  for (const path of ['memory/trace.log', 'memory/.hidden.md']) {
    const { deps, rec } = makeDeps({ files: WORKSPACE })
    await new ExportPackHandler(deps).handleExport(
      frame({ tier: 'experienced', memoryFiles: [path] }),
    )
    const body = lastResult(rec)
    assert.equal(body.ok, false)
    assert.equal(body.error!.code, 'INVALID_MEMORY_FILE', path)
    assert.equal(rec.puts.length, 0)
  }
})

test('nonexistent requested memory file is rejected', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(deps).handleExport(
    frame({ tier: 'experienced', memoryFiles: ['memory/gone.md'] }),
  )
  assert.equal(lastResult(rec).error!.code, 'INVALID_MEMORY_FILE')
  assert.equal(rec.puts.length, 0)
})

test('traversal, absolute, and backslash requests are PATH_ESCAPE', async () => {
  for (const path of [
    '../outside.md',
    'memory/../.env',
    '/etc/passwd',
    'memory\\win.md',
    'memory/./notes.md',
  ]) {
    const { deps, rec } = makeDeps({ files: WORKSPACE })
    await new ExportPackHandler(deps).handleExport(
      frame({ tier: 'experienced', memoryFiles: [path] }),
    )
    const body = lastResult(rec)
    assert.equal(body.ok, false)
    assert.equal(body.error!.code, 'PATH_ESCAPE', path)
    assert.equal(rec.puts.length, 0)
  }
})

test('a symlink escaping the workspace root blocks the export (realpath gate)', async () => {
  const { deps, rec } = makeDeps({
    files: WORKSPACE,
    realOverrides: { '.claude/rules/style.md': '/home/owner/.ssh/id_rsa' },
  })
  await new ExportPackHandler(deps).handleExport(frame())
  const body = lastResult(rec)
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'PATH_ESCAPE')
  assert.ok(body.error!.message.includes('.claude/rules/style.md'))
  assert.equal(rec.puts.length, 0)
})

test('a planted secret blocks packaging with the exact file and line', async () => {
  const { deps, rec } = makeDeps({
    files: {
      ...WORKSPACE,
      'CLAUDE.md': '# Atlas\n\nkey: sk-ant-api03-abcdefghijklmnopqrstuvwx\n',
    },
  })
  await new ExportPackHandler(deps).handleExport(frame())
  const body = lastResult(rec)
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'SECRET_SCAN_BLOCKED')
  assert.deepEqual(body.error!.findings, [
    {
      file: 'CLAUDE.md',
      line: 3,
      rule: 'anthropic_api_key',
      excerpt: 'sk-a...',
    },
  ])
  assert.equal(rec.puts.length, 0, 'a blocked scan must never upload')
})

test('requested memory files are scanned too', async () => {
  const { deps, rec } = makeDeps({
    files: {
      ...WORKSPACE,
      'memory/notes.md': 'remember\nghp_abcdefghijklmnopqrst1234\n',
    },
  })
  await new ExportPackHandler(deps).handleExport(
    frame({ tier: 'experienced', memoryFiles: ['memory/notes.md'] }),
  )
  const body = lastResult(rec)
  assert.equal(body.error!.code, 'SECRET_SCAN_BLOCKED')
  assert.deepEqual(
    body.error!.findings!.map((f) => `${f.file}:${f.line}:${f.rule}`),
    ['memory/notes.md:2:github_token'],
  )
  assert.equal(rec.puts.length, 0)
})

test('oversize packs are refused BEFORE any upload byte leaves', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(deps).handleExport(frame({ maxBytes: 10 }))
  const body = lastResult(rec)
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'PACK_TOO_LARGE')
  assert.ok(body.error!.message.includes('10'))
  assert.equal(rec.puts.length, 0)
})

test('a failed upload reports UPLOAD_FAILED (HTTP error and thrown fetch)', async () => {
  const httpFail = makeDeps({ files: WORKSPACE, fetchStatus: 500 })
  await new ExportPackHandler(httpFail.deps).handleExport(frame())
  assert.equal(lastResult(httpFail.rec).error!.code, 'UPLOAD_FAILED')

  const netFail = makeDeps({ files: WORKSPACE, fetchThrows: true })
  await new ExportPackHandler(netFail.deps).handleExport(frame())
  assert.equal(lastResult(netFail.rec).error!.code, 'UPLOAD_FAILED')
})

test('a frame without uploadUrl is BAD_FRAME (still answered, never silent)', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(deps).handleExport(frame({ uploadUrl: '' }))
  assert.equal(lastResult(rec).error!.code, 'BAD_FRAME')
})

test('a workspace with no agent body is MANIFEST_ONLY', async () => {
  const { deps, rec } = makeDeps({
    files: { 'memory/notes.md': 'only memory here' },
  })
  await new ExportPackHandler(deps).handleExport(
    frame({ tier: 'experienced', memoryFiles: ['memory/notes.md'] }),
  )
  assert.equal(lastResult(rec).error!.code, 'MANIFEST_ONLY')
  assert.equal(rec.puts.length, 0)
})

test('an unexpected dep failure still posts a PLUGIN_ERROR result', async () => {
  const { deps, rec } = makeDeps({ listFails: true })
  await new ExportPackHandler(deps).handleExport(frame())
  const body = lastResult(rec)
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'PLUGIN_ERROR')
})

test('a failed ACK is non-fatal (the export still runs and reports)', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE, ackFails: true })
  await new ExportPackHandler(deps).handleExport(frame())
  assert.deepEqual(rec.acks, [])
  assert.equal(lastResult(rec).ok, true)
})

test('duplicate rpcIds are deduped while in flight', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  const handler = new ExportPackHandler(deps)
  await Promise.all([
    handler.handleExport(frame()),
    handler.handleExport(frame()),
  ])
  assert.equal(rec.results.length, 1)
  assert.equal(rec.puts.length, 1)
})

// ── export_pack_manifest (dry run) ───────────────────────────────────────────

test('the dry run lists body + memory candidates and never uploads', async () => {
  const { deps, rec } = makeDeps({ files: WORKSPACE })
  await new ExportPackHandler(deps).handleManifest({
    rpcId: 'm-1',
    assistantId: '901',
  })
  assert.deepEqual(rec.acks, ['m-1'])
  assert.equal(rec.puts.length, 0)
  const body = lastResult(rec)
  assert.equal(body.ok, true)
  assert.deepEqual((body.payload as any).files, [
    {
      path: '.claude/rules/style.md',
      bytes: enc.encode(WORKSPACE['.claude/rules/style.md']!).length,
      kind: 'body',
    },
    {
      path: '.claude/skills/research/SKILL.md',
      bytes: enc.encode(WORKSPACE['.claude/skills/research/SKILL.md']!).length,
      kind: 'body',
    },
    {
      path: 'CLAUDE.md',
      bytes: enc.encode(WORKSPACE['CLAUDE.md']!).length,
      kind: 'body',
    },
    {
      path: '.claude/memory/deep.md',
      bytes: enc.encode(WORKSPACE['.claude/memory/deep.md']!).length,
      kind: 'memory',
    },
    {
      path: 'memory/notes.md',
      bytes: enc.encode(WORKSPACE['memory/notes.md']!).length,
      kind: 'memory',
    },
  ])
})

test('the dry run silently drops symlink escapees from the listing', async () => {
  const { deps, rec } = makeDeps({
    files: WORKSPACE,
    realOverrides: { 'memory/notes.md': '/somewhere/else.md' },
  })
  await new ExportPackHandler(deps).handleManifest({
    rpcId: 'm-2',
    assistantId: '901',
  })
  const files = (lastResult(rec).payload as any).files as Array<{ path: string }>
  assert.equal(files.some((f) => f.path === 'memory/notes.md'), false)
  assert.ok(files.some((f) => f.path === 'CLAUDE.md'))
})

test('the dry run reports PLUGIN_ERROR instead of going silent', async () => {
  const { deps, rec } = makeDeps({ listFails: true })
  await new ExportPackHandler(deps).handleManifest({
    rpcId: 'm-3',
    assistantId: '901',
  })
  assert.equal(lastResult(rec).error!.code, 'PLUGIN_ERROR')
})

// ── Real-filesystem mirror of the server.ts deps wiring ──────────────────────
// server.ts wires ExportPackHandler with fs-backed deps (a targeted walk of
// CLAUDE.md + .claude/rules + .claude/skills + memory + .claude/memory,
// stat sizes, node realpath). That wiring is module-scoped and not
// exported, so per this repo's convention (see ws-inbound-meta.test.ts)
// this section MIRRORS listWorkspaceFilesForPack and the readFile/realpath
// deps exactly; update it in lockstep with server.ts. It pins the two
// load-bearing behaviors against a real temp workspace: the walk feeds the
// allowlist correctly, and a real on-disk symlink pointing outside the
// workspace blocks the export via the realpath gate (macOS tmpdirs sit
// behind the /var -> /private/var symlink, so root canonicalization is
// genuinely exercised here).

async function makeRealFsDeps(root: string): Promise<{
  deps: ExportPackDeps
  rec: Recorded
}> {
  const { stat, readdir, readFile, realpath } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const rec: Recorded = { acks: [], results: [], puts: [] }
  // Mirror of server.ts listWorkspaceFilesForPack (keep in lockstep).
  const listWorkspaceFiles = async (): Promise<
    Array<{ path: string; bytes: number }>
  > => {
    const out: Array<{ path: string; bytes: number }> = []
    const addFile = async (rel: string): Promise<void> => {
      try {
        const s = await stat(join(root, rel))
        if (s.isFile()) out.push({ path: rel, bytes: s.size })
      } catch {}
    }
    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (depth > 6) return
      let entries
      try {
        entries = await readdir(join(root, relDir), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const rel = `${relDir}/${entry.name}`
        if (entry.isDirectory()) await walk(rel, depth + 1)
        else await addFile(rel)
      }
    }
    await addFile('CLAUDE.md')
    await walk('.claude/rules', 0)
    await walk('.claude/skills', 0)
    await walk('memory', 0)
    await walk('.claude/memory', 0)
    return out
  }
  const deps: ExportPackDeps = {
    config: { workspaceRoot: root, assistantId: '901' },
    postAck: async (rpcId) => {
      rec.acks.push(rpcId)
    },
    postResult: async (rpcId, body) => {
      rec.results.push({ rpcId, body })
    },
    listWorkspaceFiles,
    readFile: (relPath) => readFile(join(root, relPath)),
    realpath: (relPath) => realpath(relPath ? join(root, relPath) : root),
    log: () => {},
    fetchImpl: (async (url: any, init?: any) => {
      rec.puts.push({
        url: String(url),
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as Uint8Array,
      })
      return new Response('', { status: 200 })
    }) as typeof fetch,
    now: () => FIXED_NOW,
  }
  return { deps, rec }
}

test('real fs: the walk + allowlist package a temp workspace end to end', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'bgos-export-pack-'))
  try {
    await mkdir(join(root, '.claude/rules'), { recursive: true })
    await mkdir(join(root, '.claude/skills/research'), { recursive: true })
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'CLAUDE.md'), '# Atlas\n')
    await writeFile(join(root, '.claude/rules/style.md'), 'No tables.\n')
    await writeFile(
      join(root, '.claude/skills/research/SKILL.md'),
      'Needs SERP_API_TOKEN.\n',
    )
    await writeFile(join(root, 'memory/notes.md'), 'note\n')
    await writeFile(join(root, '.mcp.json'), '{}')
    await writeFile(join(root, 'memory/trace.log'), 'log')

    const { deps, rec } = await makeRealFsDeps(root)
    await new ExportPackHandler(deps).handleExport(
      frame({ tier: 'experienced', memoryFiles: ['memory/notes.md'] }),
    )
    const body = lastResult(rec)
    assert.equal(body.ok, true, JSON.stringify(body))
    const entries = readStoredZip(rec.puts[0]!.body)
    assert.deepEqual(
      entries.map((e) => e.path),
      [
        MANIFEST_ENTRY_NAME,
        'agent/CLAUDE.md',
        'agent/rules/style.md',
        'agent/skills/research/SKILL.md',
        'memory/notes.md',
      ],
    )
    assert.deepEqual(
      (body.payload as any).manifest.required_env,
      ['SERP_API_TOKEN'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('real fs: an on-disk symlink escaping the workspace blocks the export', async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import(
    'node:fs/promises'
  )
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'bgos-export-pack-'))
  const outside = await mkdtemp(join(tmpdir(), 'bgos-outside-'))
  try {
    await mkdir(join(root, '.claude/rules'), { recursive: true })
    await writeFile(join(root, 'CLAUDE.md'), '# Atlas\n')
    await writeFile(join(outside, 'loot.md'), 'private stuff outside the workspace')
    await symlink(join(outside, 'loot.md'), join(root, '.claude/rules/evil.md'))

    const { deps, rec } = await makeRealFsDeps(root)
    await new ExportPackHandler(deps).handleExport(frame())
    const body = lastResult(rec)
    assert.equal(body.ok, false)
    assert.equal(body.error!.code, 'PATH_ESCAPE')
    assert.ok(body.error!.message.includes('.claude/rules/evil.md'))
    assert.equal(rec.puts.length, 0)

    // A symlink that stays INSIDE the workspace is fine.
    await rm(join(root, '.claude/rules/evil.md'))
    await writeFile(join(root, '.claude/rules/real.md'), 'inside\n')
    await symlink(
      join(root, '.claude/rules/real.md'),
      join(root, '.claude/rules/alias.md'),
    )
    const second = await makeRealFsDeps(root)
    await new ExportPackHandler(second.deps).handleExport(frame({ rpcId: 'rpc-2' }))
    assert.equal(lastResult(second.rec).ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

// ── Encoding normalization: no byte ships unscanned ──────────────────────────
// A non-UTF-8 file (UTF-16 CLAUDE.md/memory from a Windows editor) used to be
// lossily decoded for the scan ("AKIA..." -> "A\0K\0I\0A...") while its RAW
// bytes still shipped, smuggling a live key past the gate. normalizeToUtf8
// makes the scanned text and the packed bytes identical.

test('normalizeToUtf8 decodes a UTF-16LE BOM file and re-encodes as UTF-8', () => {
  const res = normalizeToUtf8(utf16leWithBom('héllo key'))
  assert.ok(res.ok)
  assert.equal(res.file.text, 'héllo key')
  // Shipped bytes are the UTF-8 encoding of exactly the scanned text.
  assert.deepEqual(res.file.data, enc.encode('héllo key'))
})

test('normalizeToUtf8 strips a UTF-8 BOM and round-trips plain UTF-8 unchanged', () => {
  const bom = normalizeToUtf8(utf8WithBom('plain body'))
  assert.ok(bom.ok)
  assert.equal(bom.file.text, 'plain body')
  assert.deepEqual(bom.file.data, enc.encode('plain body')) // BOM dropped

  const raw = normalizeToUtf8(enc.encode('# Title\nbody\n'))
  assert.ok(raw.ok)
  assert.equal(raw.file.text, '# Title\nbody\n')
  assert.deepEqual(raw.file.data, enc.encode('# Title\nbody\n'))
})

test('normalizeToUtf8 rejects NUL-heavy (BOM-less UTF-16) and UTF-32 content', () => {
  // BOM-less UTF-16LE: BOM detection misses it, lossy UTF-8 decode is NUL-heavy.
  const noBom = normalizeToUtf8(utf16leWithBom('AKIAIOSFODNN7EXAMPLE').slice(2))
  assert.equal(noBom.ok, false)
  if (!noBom.ok) assert.ok(noBom.message.includes('NUL'))
  // UTF-32LE BOM (FF FE 00 00) is not a scannable text encoding.
  const utf32 = normalizeToUtf8(
    new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]),
  )
  assert.equal(utf32.ok, false)
})

test('a UTF-16LE (BOM) file with a planted key still scans and BLOCKS', async () => {
  const claude = utf16leWithBom(
    '# Atlas\n\nkey: sk-ant-api03-abcdefghijklmnopqrstuvwx\n',
  )
  const { deps, rec } = makeDeps({
    files: { ...WORKSPACE, 'CLAUDE.md': claude },
  })
  await new ExportPackHandler(deps).handleExport(frame())
  const body = lastResult(rec)
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'SECRET_SCAN_BLOCKED')
  assert.deepEqual(
    body.error!.findings!.map((f) => `${f.file}:${f.line}:${f.rule}`),
    ['CLAUDE.md:3:anthropic_api_key'],
  )
  assert.equal(rec.puts.length, 0, 'a blocked scan must never upload')
})

test('a UTF-8 (BOM) file scans normally and ships BOM-stripped UTF-8', async () => {
  const cleanText = '# Atlas\n\nServe well.\n'
  const { deps, rec } = makeDeps({
    files: { ...WORKSPACE, 'CLAUDE.md': utf8WithBom(cleanText) },
  })
  await new ExportPackHandler(deps).handleExport(frame())
  const body = lastResult(rec)
  assert.equal(body.ok, true, JSON.stringify(body))
  const entries = readStoredZip(rec.puts[0]!.body)
  const claudeEntry = entries.find((e) => e.path === 'agent/CLAUDE.md')!
  // Shipped bytes are the canonical UTF-8 (BOM stripped) = what was scanned.
  assert.equal(dec.decode(claudeEntry.data), cleanText)
  assert.deepEqual(Array.from(claudeEntry.data.slice(0, 3)), [0x23, 0x20, 0x41])
})

test('a BOM-less UTF-16 (NUL-heavy) file is refused NON_UTF8_FILE, never shipped', async () => {
  const noBom = utf16leWithBom('AKIAIOSFODNN7EXAMPLE\n').slice(2) // drop the BOM
  const { deps, rec } = makeDeps({
    files: { ...WORKSPACE, 'CLAUDE.md': noBom },
  })
  await new ExportPackHandler(deps).handleExport(frame())
  const body = lastResult(rec)
  assert.equal(body.ok, false)
  assert.equal(body.error!.code, 'NON_UTF8_FILE')
  assert.ok(body.error!.message.includes('CLAUDE.md'))
  assert.equal(rec.puts.length, 0)
})
