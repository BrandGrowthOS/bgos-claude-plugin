/**
 * bgos-claim installer tests (pure helpers + tiny real-fs checks).
 *
 * Coverage: slug derivation, sha256, claim-token extraction, arg parsing,
 * the STORED zip reader as a cross-twin of lib/pack-zip.ts (a zip written
 * by the TS writer must read back identically in the plain-JS installer),
 * the manifest hash verification logic (ok, sha mismatch, bytes mismatch,
 * missing entry, smuggled extra), pack-entry to workspace mapping with
 * zip-slip rejection, the exact .mcp.json shape with the REAL server.ts env
 * keys (the scaffold template's API_KEY/API_BASE names are known wrong),
 * the 0o600 mode on disk, required_env filtering, and the scaffold layout.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  slugify,
  safeAgentSlug,
  chooseAgentSlug,
  resolveAgentDir,
  MAX_SLUG_LENGTH,
  sha256Hex,
  extractClaimToken,
  parseClaimArgs,
  crc32,
  readStoredZip,
  verifyManifestFiles,
  packEntryToWorkspacePath,
  buildMcpJson,
  requiredEnvStillNeeded,
  shellQuote,
  buildLaunchCommand,
  writeMcpJsonFile,
  scaffoldWorkspace,
  MCP_JSON_MODE,
  GITIGNORE_BODY,
  SETTINGS_LOCAL_JSON,
  PROVIDED_ENV_KEYS,
  DEFAULT_API_BASE,
  PACK_ZIP_MAX_BYTES,
  packZipTooLarge,
} from '../bin/bgos-claim.mjs'
import { buildStoredZip } from '../lib/pack-zip.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('slugify derives the bgos-build-agent slug', () => {
  assert.equal(slugify('Deep Research Agent'), 'deep-research-agent')
  assert.equal(slugify('  Atlas!! v2  '), 'atlas-v2')
  assert.equal(slugify('___'), 'agent')
  assert.equal(slugify(''), 'agent')
  assert.equal(slugify(undefined), 'agent')
})

test('sha256Hex matches the known empty-input vector', () => {
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
})

test('extractClaimToken accepts raw tokens and pasted claim URLs', () => {
  assert.equal(extractClaimToken('handoff_abc123-XYZ'), 'handoff_abc123-XYZ')
  assert.equal(
    extractClaimToken('https://app.brandgrowthos.ai/h/handoff_abc123'),
    'handoff_abc123',
  )
  assert.equal(extractClaimToken('not a token!!'), '')
  assert.equal(extractClaimToken(''), '')
})

test('parseClaimArgs parses token and flags, rejects junk', () => {
  const ok = parseClaimArgs(['handoff_tok', '--api-base', 'https://x.dev/api/v1/', '--force'])
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.args.token, 'handoff_tok')
  assert.equal(ok.args.apiBase, 'https://x.dev/api/v1')
  assert.equal(ok.args.force, true)

  const missing = parseClaimArgs([])
  assert.ok(missing.errors.some((e: string) => e.includes('missing claim token')))

  const unknown = parseClaimArgs(['handoff_tok', '--wat'])
  assert.ok(unknown.errors.some((e: string) => e.includes('--wat')))

  const help = parseClaimArgs(['--help'])
  assert.equal(help.args.help, true)
  assert.deepEqual(help.errors, [])

  const defaulted = parseClaimArgs(['handoff_tok'])
  assert.equal(defaulted.args.apiBase, DEFAULT_API_BASE)
})

// ── Zip reader: cross-twin with lib/pack-zip.ts ──────────────────────────────

test('crc32 twin matches the published vector', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926)
})

test('the installer reads zips written by the plugin writer (twin round trip)', () => {
  const zip = buildStoredZip(
    [
      { path: 'manifest.json', data: enc.encode('{"schema_version":1}') },
      { path: 'agent/CLAUDE.md', data: enc.encode('# Agent') },
      { path: 'memory/ملاحظات.md', data: enc.encode('مرحبا') },
    ],
    new Date('2026-07-10T12:00:00Z'),
  )
  const entries = readStoredZip(zip)
  assert.deepEqual(
    entries.map((e: { path: string }) => e.path),
    ['manifest.json', 'agent/CLAUDE.md', 'memory/ملاحظات.md'],
  )
  assert.equal(dec.decode(entries[1].data), '# Agent')
  assert.equal(dec.decode(entries[2].data), 'مرحبا')
})

test('the installer zip reader detects corruption', () => {
  const zip = buildStoredZip(
    [{ path: 'agent/CLAUDE.md', data: enc.encode('hello world') }],
    new Date('2026-07-10T12:00:00Z'),
  )
  const corrupted = Uint8Array.from(zip)
  const nameOffset = Buffer.from(zip).indexOf(Buffer.from('agent/CLAUDE.md'))
  corrupted[nameOffset + 'agent/CLAUDE.md'.length] ^= 0xff
  assert.throws(() => readStoredZip(corrupted), /crc mismatch/)
})

// ── Manifest verification (the integrity gate) ───────────────────────────────

function packFixture() {
  const claudeMd = enc.encode('# Agent body')
  const notes = enc.encode('memory note')
  const manifest = {
    schema_version: 1,
    files: [
      { path: 'agent/CLAUDE.md', sha256: sha256Hex(claudeMd), bytes: claudeMd.length },
      { path: 'memory/notes.md', sha256: sha256Hex(notes), bytes: notes.length },
    ],
  }
  const entries = [
    { path: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) },
    { path: 'agent/CLAUDE.md', data: claudeMd },
    { path: 'memory/notes.md', data: notes },
  ]
  return { manifest, entries }
}

test('verifyManifestFiles passes a clean pack', () => {
  const { manifest, entries } = packFixture()
  assert.deepEqual(verifyManifestFiles(manifest, entries), [])
})

test('verifyManifestFiles flags a sha256 mismatch (tampered content)', () => {
  const { manifest, entries } = packFixture()
  entries[1] = { path: 'agent/CLAUDE.md', data: enc.encode('# Tampered!!') }
  const problems = verifyManifestFiles(manifest, entries)
  assert.deepEqual(problems, [
    { path: 'agent/CLAUDE.md', reason: 'sha256_mismatch' },
  ])
})

test('verifyManifestFiles flags a bytes mismatch before hashing', () => {
  const { manifest, entries } = packFixture()
  entries[2] = { path: 'memory/notes.md', data: enc.encode('short') }
  assert.deepEqual(verifyManifestFiles(manifest, entries), [
    { path: 'memory/notes.md', reason: 'bytes_mismatch' },
  ])
})

test('verifyManifestFiles flags missing entries and smuggled extras', () => {
  const { manifest, entries } = packFixture()
  const withoutNotes = entries.filter((e) => e.path !== 'memory/notes.md')
  assert.deepEqual(verifyManifestFiles(manifest, withoutNotes), [
    { path: 'memory/notes.md', reason: 'missing_entry' },
  ])
  const withExtra = [
    ...entries,
    { path: 'agent/rules/evil.md', data: enc.encode('do bad things') },
  ]
  assert.deepEqual(verifyManifestFiles(manifest, withExtra), [
    { path: 'agent/rules/evil.md', reason: 'unlisted_entry' },
  ])
})

// ── Pack entry mapping (zip-slip safe) ───────────────────────────────────────

test('packEntryToWorkspacePath maps the pack layout to the scaffold', () => {
  assert.equal(packEntryToWorkspacePath('agent/CLAUDE.md'), 'CLAUDE.md')
  assert.equal(
    packEntryToWorkspacePath('agent/rules/style.md'),
    '.claude/rules/style.md',
  )
  assert.equal(
    packEntryToWorkspacePath('agent/skills/research/SKILL.md'),
    '.claude/skills/research/SKILL.md',
  )
  assert.equal(packEntryToWorkspacePath('memory/notes.md'), 'memory/notes.md')
  assert.equal(packEntryToWorkspacePath('manifest.json'), null)
  assert.equal(packEntryToWorkspacePath('workflow.json'), null)
})

test('packEntryToWorkspacePath rejects zip-slip shapes', () => {
  for (const evil of [
    '../outside.md',
    'agent/../../outside.md',
    '/etc/passwd',
    'agent\\rules\\win.md',
    'memory/../../.ssh/id_rsa',
    'agent//x.md',
    'agent/./x.md',
    '',
  ]) {
    assert.equal(packEntryToWorkspacePath(evil), null, evil)
  }
})

// ── .mcp.json: the REAL env keys + 600 mode ──────────────────────────────────

test('buildMcpJson emits the exact server.ts env keys (not the broken template names)', () => {
  const config = buildMcpJson({
    pluginServerPath: '/home/kc/bgos-agents/.plugin/bgos-claude-plugin/server.ts',
    backendUrl: 'https://api.brandgrowthos.ai/api/v1',
    apiKey: 'bgos_key_abc',
    userId: 'user_42',
    assistantId: '907',
  })
  assert.deepEqual(config, {
    mcpServers: {
      bgos: {
        command: 'bun',
        args: ['/home/kc/bgos-agents/.plugin/bgos-claude-plugin/server.ts'],
        env: {
          BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1',
          BGOS_API_KEY: 'bgos_key_abc',
          BGOS_USER_ID: 'user_42',
          BGOS_ASSISTANT_ID: '907',
        },
      },
    },
  })
  // The template's WRONG key names must never appear.
  const flat = JSON.stringify(config)
  assert.equal(flat.includes('"API_KEY"'), false)
  assert.equal(flat.includes('"API_BASE"'), false)
})

test('MCP_JSON_MODE is 600 and writeMcpJsonFile pins it on disk', async () => {
  assert.equal(MCP_JSON_MODE, 0o600)
  const dir = await mkdtemp(join(tmpdir(), 'bgos-claim-test-'))
  try {
    const path = join(dir, '.mcp.json')
    const config = buildMcpJson({
      pluginServerPath: '/p/server.ts',
      backendUrl: 'https://b',
      apiKey: 'k',
      userId: 'u',
      assistantId: '1',
    })
    await writeMcpJsonFile(path, config)
    const s = await stat(path)
    assert.equal(s.mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── required_env + launch command ────────────────────────────────────────────

test('requiredEnvStillNeeded filters the four keys the installer provides', () => {
  assert.deepEqual(PROVIDED_ENV_KEYS, [
    'BGOS_BACKEND_URL',
    'BGOS_API_KEY',
    'BGOS_USER_ID',
    'BGOS_ASSISTANT_ID',
  ])
  assert.deepEqual(
    requiredEnvStillNeeded([
      'OPENAI_API_KEY',
      'BGOS_API_KEY',
      'BGOS_BACKEND_URL',
      'SERP_API_TOKEN',
      'OPENAI_API_KEY',
    ]),
    ['OPENAI_API_KEY', 'SERP_API_TOKEN'],
  )
  assert.deepEqual(requiredEnvStillNeeded(undefined), [])
})

test('the launch command targets the scaffold dir with the channel flags', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(
    buildLaunchCommand('/home/kc/bgos-agents/atlas'),
    "cd '/home/kc/bgos-agents/atlas' && claude --dangerously-skip-permissions " +
      '--dangerously-load-development-channels server:bgos',
  )
})

// ── Scaffold layout ──────────────────────────────────────────────────────────

test('scaffoldWorkspace writes the bgos-build-agent layout from pack entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-claim-scaffold-'))
  try {
    const written = await scaffoldWorkspace(
      dir,
      [
        { path: 'manifest.json', data: enc.encode('{}') },
        { path: 'agent/CLAUDE.md', data: enc.encode('# Atlas') },
        { path: 'agent/rules/style.md', data: enc.encode('rules') },
        { path: 'agent/skills/research/SKILL.md', data: enc.encode('skill') },
        { path: 'memory/notes.md', data: enc.encode('note') },
        { path: 'workflow.json', data: enc.encode('{}') }, // unknown: skipped
      ],
      () => {},
    )
    assert.equal(written, 4)
    assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '# Atlas')
    assert.equal(
      await readFile(join(dir, '.claude/rules/style.md'), 'utf8'),
      'rules',
    )
    assert.equal(
      await readFile(join(dir, '.claude/skills/research/SKILL.md'), 'utf8'),
      'skill',
    )
    assert.equal(await readFile(join(dir, 'memory/notes.md'), 'utf8'), 'note')
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), GITIGNORE_BODY)
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, '.claude/settings.local.json'), 'utf8')),
      SETTINGS_LOCAL_JSON,
    )
    // manifest.json and unknown entries never land in the workspace.
    await assert.rejects(stat(join(dir, 'manifest.json')))
    await assert.rejects(stat(join(dir, 'workflow.json')))
    // The gitignore covers exactly the secret-bearing files.
    assert.ok(GITIGNORE_BODY.includes('.mcp.json'))
    assert.ok(GITIGNORE_BODY.includes('.claude/settings.local.json'))
    assert.ok(GITIGNORE_BODY.includes('*.log'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Slug path-traversal defense (network-sourced slug) ───────────────────────
// The /pack endpoint and the manifest are attacker-influenceable; a slug with
// "..", a separator, or an absolute path used to be joined onto ~/bgos-agents
// verbatim and escaped the root (e.g. '../../.ssh'). safeAgentSlug rejects
// anything that is not a single lowercase kebab segment; resolveAgentDir is
// the final containment assert.

test('safeAgentSlug rejects traversal, separators, absolute, dot, empty, overlong', () => {
  for (const bad of [
    '../../evil',
    '/etc/x',
    'a/b',
    '..',
    '',
    '.',
    '.hidden',
    'UPPER',
    'a b',
    'a\\b',
    'x'.repeat(MAX_SLUG_LENGTH + 1),
  ]) {
    assert.equal(safeAgentSlug(bad), null, JSON.stringify(bad))
  }
  assert.equal(safeAgentSlug(undefined as unknown as string), null)
  assert.equal(safeAgentSlug(42 as unknown as string), null)
})

test('safeAgentSlug accepts a safe single kebab segment (and trims)', () => {
  assert.equal(safeAgentSlug('good-agent'), 'good-agent')
  assert.equal(safeAgentSlug('atlas-v2'), 'atlas-v2')
  assert.equal(safeAgentSlug('agent'), 'agent')
  assert.equal(safeAgentSlug('  spaced-trims  '), 'spaced-trims')
})

test('chooseAgentSlug never trusts a hostile network slug (falls back to the local name)', () => {
  assert.equal(
    chooseAgentSlug({ packSlug: '../../evil', manifestSlug: undefined, agentName: 'Atlas' }),
    'atlas',
  )
  assert.equal(
    chooseAgentSlug({
      packSlug: '/etc/x',
      manifestSlug: 'a/b',
      agentName: 'My Agent',
    }),
    'my-agent',
  )
  // A good pack slug is honored; the manifest slug is the second choice.
  assert.equal(
    chooseAgentSlug({ packSlug: 'atlas-prime', manifestSlug: undefined, agentName: 'Atlas' }),
    'atlas-prime',
  )
  assert.equal(
    chooseAgentSlug({
      packSlug: '..',
      manifestSlug: 'atlas-alt',
      agentName: 'Atlas',
    }),
    'atlas-alt',
  )
})

test('resolveAgentDir keeps the scaffold strictly inside the agents root', () => {
  const root = '/home/kc/bgos-agents'
  assert.equal(resolveAgentDir(root, 'atlas'), '/home/kc/bgos-agents/atlas')
  for (const evil of ['..', '../evil', '../../x', '.']) {
    assert.throws(
      () => resolveAgentDir(root, evil),
      /outside the agents root/,
      evil,
    )
  }
})

test('a hostile network slug never escapes the root; a good slug scaffolds inside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgos-claim-root-'))
  try {
    // The pack endpoint tries to traverse out; the installer ignores it and
    // uses the safe local slug from the agent name instead.
    const slug = chooseAgentSlug({
      packSlug: '../../evil',
      manifestSlug: undefined,
      agentName: 'Atlas',
    })
    assert.equal(slug, 'atlas')
    const dir = resolveAgentDir(root, slug)
    assert.equal(dir, join(root, 'atlas'))

    const written = await scaffoldWorkspace(
      dir,
      [{ path: 'agent/CLAUDE.md', data: enc.encode('# Atlas') }],
      () => {},
    )
    assert.equal(written, 1)
    assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '# Atlas')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scaffoldWorkspace never writes a pack entry outside the scaffold dir (zip-slip)', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'bgos-claim-slip-'))
  const dir = join(parent, 'agent-x')
  try {
    const written = await scaffoldWorkspace(
      dir,
      [
        { path: 'agent/CLAUDE.md', data: enc.encode('# ok') },
        { path: '../x', data: enc.encode('nope') },
        { path: 'agent/../../escape2.md', data: enc.encode('nope') },
        { path: '/etc/evil.md', data: enc.encode('nope') },
      ],
      () => {},
    )
    assert.equal(written, 1)
    assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '# ok')
    // None of the traversal targets landed beside the scaffold dir.
    await assert.rejects(stat(join(parent, 'x')))
    await assert.rejects(stat(join(parent, 'escape2.md')))
    assert.deepEqual((await readdir(parent)).sort(), ['agent-x'])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('packZipTooLarge caps the backend-supplied pack download', () => {
  // Under the cap (declared or actual) is fine.
  assert.equal(packZipTooLarge(1024), false)
  assert.equal(packZipTooLarge(PACK_ZIP_MAX_BYTES), false)
  // Over the cap is rejected (a hostile backend streaming a giant zip).
  assert.equal(packZipTooLarge(PACK_ZIP_MAX_BYTES + 1), true)
  // Absent / unparseable Content-Length (NaN) is NOT flagged here; the
  // actual-bytes re-check is the backstop.
  assert.equal(packZipTooLarge(Number.NaN), false)
  assert.equal(packZipTooLarge(-1), false)
})
