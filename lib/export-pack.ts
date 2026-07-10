/**
 * export_pack RPC core: Agent Pack packaging for Type 3 "Full handoff"
 * (Home of Agents).
 *
 * The backend pushes `export_pack {rpcId, handoffId, assistantId, tier,
 * memoryFiles, uploadUrl, maxBytes, rulesVersion}` frames to the
 * `assistant:<id>` room this plugin's socket already joined (the same lane
 * as voice_rpc). The plugin ACKs, collects the agent body from the
 * workspace, secret-scans it, builds a deterministic zip, uploads it to the
 * presigned URL, and ALWAYS posts a result (never silence, the voice_rpc G2
 * lesson):
 *
 *   POST /api/v1/integrations/export-pack/:rpcId/ack     {}
 *   POST /api/v1/integrations/export-pack/:rpcId/result
 *     {ok:true, payload:{manifest, packSha256, packBytes}}
 *     | {ok:false, error:{code, message, findings?}}
 *
 * A second lightweight RPC `export_pack_manifest {rpcId, assistantId}` is
 * the dry run: it lists candidate files (kind 'body' | 'memory') without
 * building or uploading anything, so the handoff wizard can offer per-file
 * memory opt-in.
 *
 * Collection contract (the security core, every rule tested):
 *   - Body allowlist: CLAUDE.md, .claude/rules/*.md, .claude/skills/<s>/SKILL.md
 *   - Memory: ONLY files the frame requested AND living under memory/ or
 *     .claude/memory/
 *   - HARD EXCLUDED always: .mcp.json, .claude/settings*, any *.log,
 *     dotfiles outside the allowlist, chat history (never a pack input),
 *     and anything resolving outside the workspace root (".." segments,
 *     absolute paths, and symlink escapes via a realpath check)
 *
 * Pure core in the voice_rpc deps-injection style: all effects
 * (listWorkspaceFiles, readFile, realpath, fetchImpl, now, ack/result
 * posts) are injected so tests run against fakes. sha256 uses node:crypto,
 * which is deterministic and side-effect free.
 *
 * No TS enums or parameter properties: node --test runs these files in
 * strip-only mode (see lib/voice-rpc.ts:210).
 */

import { createHash } from 'node:crypto'

import {
  scanFiles,
  SECRET_SCAN_RULES_VERSION,
  type SecretFinding,
} from './secret-scan.ts'
import {
  buildStoredZip,
  MANIFEST_ENTRY_NAME,
  type ZipEntryInput,
} from './pack-zip.ts'

// ── Wire shapes ──────────────────────────────────────────────────────────────

export type PackTier = 'fresh' | 'experienced'

export interface ExportPackFrame {
  rpcId: string
  handoffId: string
  assistantId: string
  tier: PackTier
  memoryFiles: string[]
  uploadUrl: string
  maxBytes: number
  rulesVersion: number
  /** Optional backend enrichment; the stored manifest row is authoritative
   *  for display names either way. */
  agentName: string
  sourceGeneration: number
}

export interface ExportPackManifestFrame {
  rpcId: string
  assistantId: string
}

export interface ExportPackResultBody {
  ok: boolean
  payload?: Record<string, unknown>
  error?: { code: string; message: string; findings?: SecretFinding[] }
}

/** Default size gate when the frame carries none: 25 MiB. */
export const DEFAULT_MAX_PACK_BYTES = 26214400

/** Result error codes (wire contract; the backend switches on these). */
export const EXPORT_PACK_ERROR_CODES = [
  'SECRET_SCAN_BLOCKED',
  'PACK_TOO_LARGE',
  'UPLOAD_FAILED',
  'MANIFEST_ONLY',
  'INVALID_MEMORY_FILE',
  'PATH_ESCAPE',
  'NON_UTF8_FILE',
  'BAD_FRAME',
  'PLUGIN_ERROR',
] as const

/**
 * Validate an export_pack control frame (backend emits camelCase). Frames
 * without an rpcId are dropped (nothing to correlate a result to; the
 * backend's own timeout surfaces the failure). Everything else is defaulted
 * so a well-formed rpcId ALWAYS gets an explicit result.
 */
export function normalizeExportPack(raw: unknown): ExportPackFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const rpcId = typeof r.rpcId === 'string' ? r.rpcId : ''
  if (!rpcId) return null
  const maxBytes =
    typeof r.maxBytes === 'number' && Number.isFinite(r.maxBytes) && r.maxBytes > 0
      ? Math.floor(r.maxBytes)
      : DEFAULT_MAX_PACK_BYTES
  const rulesVersion =
    typeof r.rulesVersion === 'number' && Number.isFinite(r.rulesVersion)
      ? r.rulesVersion
      : SECRET_SCAN_RULES_VERSION
  const sourceGeneration =
    typeof r.sourceGeneration === 'number' && Number.isFinite(r.sourceGeneration)
      ? r.sourceGeneration
      : 0
  return {
    rpcId,
    handoffId: typeof r.handoffId === 'string' ? r.handoffId : '',
    assistantId:
      typeof r.assistantId === 'string' || typeof r.assistantId === 'number'
        ? String(r.assistantId)
        : '',
    tier: r.tier === 'experienced' ? 'experienced' : 'fresh',
    memoryFiles: Array.isArray(r.memoryFiles)
      ? r.memoryFiles.filter((m): m is string => typeof m === 'string')
      : [],
    uploadUrl: typeof r.uploadUrl === 'string' ? r.uploadUrl : '',
    maxBytes,
    rulesVersion,
    agentName: typeof r.agentName === 'string' ? r.agentName : '',
    sourceGeneration,
  }
}

export function normalizeExportPackManifest(
  raw: unknown,
): ExportPackManifestFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const rpcId = typeof r.rpcId === 'string' ? r.rpcId : ''
  if (!rpcId) return null
  return {
    rpcId,
    assistantId:
      typeof r.assistantId === 'string' || typeof r.assistantId === 'number'
        ? String(r.assistantId)
        : '',
  }
}

// ── Candidate collection (pure; the allowlist contract) ─────────────────────

export interface WorkspaceFileEntry {
  /** Workspace-relative forward-slash path. */
  path: string
  bytes: number
}

export interface PackCandidate {
  /** The real file the owner can open and fix (scan findings use this). */
  workspacePath: string
  /** The entry name inside the pack zip (agent/..., memory/...). */
  packPath: string
  bytes: number
  kind: 'body' | 'memory'
}

const RULES_FILE_RE = /^\.claude\/rules\/[^/]+\.md$/
const SKILL_FILE_RE = /^\.claude\/skills\/[^/]+\/SKILL\.md$/
const MEMORY_PREFIX = 'memory/'
const CLAUDE_MEMORY_PREFIX = '.claude/memory/'

/** True when the path is banned from packs no matter what requested it. */
export function isHardExcluded(path: string): boolean {
  const segments = path.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (base === '.mcp.json') return true
  if (/^\.claude\/settings/.test(path)) return true
  if (/\.log$/i.test(path)) return true
  return false
}

/** Dotfile rule: no dot-leading segment anywhere, except the ".claude"
 *  workspace root that the explicit allowlist patterns themselves use. */
function hasDisallowedDotSegment(path: string): boolean {
  const segments = path.split('/')
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    if (!segment.startsWith('.')) continue
    if (i === 0 && segment === '.claude') continue
    return true
  }
  return false
}

/**
 * Classify one workspace file against the pack allowlist. Returns the pack
 * entry mapping, or null when the file is not packageable. Pure.
 */
export function classifyPackFile(
  path: string,
): { packPath: string; kind: 'body' | 'memory' } | null {
  if (!path || path.startsWith('/') || path.includes('\\')) return null
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return null
  }
  if (isHardExcluded(path)) return null
  if (hasDisallowedDotSegment(path)) return null
  if (path === 'CLAUDE.md') return { packPath: 'agent/CLAUDE.md', kind: 'body' }
  if (RULES_FILE_RE.test(path)) {
    return {
      packPath: `agent/rules/${path.slice('.claude/rules/'.length)}`,
      kind: 'body',
    }
  }
  if (SKILL_FILE_RE.test(path)) {
    return {
      packPath: `agent/skills/${path.slice('.claude/skills/'.length)}`,
      kind: 'body',
    }
  }
  if (path.startsWith(MEMORY_PREFIX) && path.length > MEMORY_PREFIX.length) {
    return { packPath: path, kind: 'memory' }
  }
  if (
    path.startsWith(CLAUDE_MEMORY_PREFIX) &&
    path.length > CLAUDE_MEMORY_PREFIX.length
  ) {
    return {
      packPath: `memory/${path.slice(CLAUDE_MEMORY_PREFIX.length)}`,
      kind: 'memory',
    }
  }
  return null
}

/**
 * Discover every packageable candidate in a workspace listing: the body
 * allowlist plus every memory candidate (the dry-run universe). Sorted by
 * kind (body first) then workspace path; duplicate pack paths (a memory/x
 * vs .claude/memory/x collision) keep the first in that order.
 */
export function discoverCandidates(
  listing: WorkspaceFileEntry[],
): PackCandidate[] {
  const candidates: PackCandidate[] = []
  for (const entry of listing) {
    const classified = classifyPackFile(entry.path)
    if (!classified) continue
    candidates.push({
      workspacePath: entry.path,
      packPath: classified.packPath,
      bytes: entry.bytes,
      kind: classified.kind,
    })
  }
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'body' ? -1 : 1
    return a.workspacePath < b.workspacePath
      ? -1
      : a.workspacePath > b.workspacePath
        ? 1
        : 0
  })
  const seenPackPaths = new Set<string>()
  return candidates.filter((c) => {
    if (seenPackPaths.has(c.packPath)) return false
    seenPackPaths.add(c.packPath)
    return true
  })
}

export interface CollectError {
  code: 'INVALID_MEMORY_FILE' | 'PATH_ESCAPE'
  message: string
}

/**
 * Resolve the exact file set an export_pack frame may package: the body
 * allowlist plus ONLY the requested memory files (experienced tier). A
 * requested path that is absolute, contains "..", uses backslashes, is
 * excluded, or is not an existing memory candidate rejects the whole export
 * (loud beats silently shipping a pack the owner did not approve).
 */
export function collectCandidates(
  listing: WorkspaceFileEntry[],
  opts: { tier: PackTier; memoryFiles: string[] },
): { ok: true; candidates: PackCandidate[] } | { ok: false; error: CollectError }
{
  const discovered = discoverCandidates(listing)
  const body = discovered.filter((c) => c.kind === 'body')
  if (opts.tier !== 'experienced') {
    // Fresh start ships setup only; requested memory files are ignored by
    // contract (the wizard never offers them on this tier).
    return { ok: true, candidates: body }
  }
  const memoryByPath = new Map(
    discovered
      .filter((c) => c.kind === 'memory')
      .map((c) => [c.workspacePath, c] as const),
  )
  const selected: PackCandidate[] = [...body]
  const seenPackPaths = new Set(body.map((c) => c.packPath))
  const requested = [...new Set(opts.memoryFiles)].sort()
  for (const path of requested) {
    if (
      typeof path !== 'string' ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((s) => s === '' || s === '.' || s === '..')
    ) {
      return {
        ok: false,
        error: {
          code: 'PATH_ESCAPE',
          message: `requested memory file resolves outside the workspace: ${path}`,
        },
      }
    }
    const candidate = memoryByPath.get(path)
    if (!candidate) {
      return {
        ok: false,
        error: {
          code: 'INVALID_MEMORY_FILE',
          message:
            `requested memory file is not a packageable memory candidate ` +
            `(must exist under memory/ or .claude/memory/, never logs or ` +
            `dotfiles): ${path}`,
        },
      }
    }
    if (seenPackPaths.has(candidate.packPath)) continue
    seenPackPaths.add(candidate.packPath)
    selected.push(candidate)
  }
  return { ok: true, candidates: selected }
}

// ── Manifest (schema_version 1) ──────────────────────────────────────────────

export interface PackManifestFile {
  path: string
  sha256: string
  bytes: number
}

export interface PackManifest {
  schema_version: number
  pack: { name: string; slug: string; packaged_at: string }
  agent_class: 'claude-code'
  tier: PackTier
  persona: unknown
  starter_prompts: unknown
  model_prefs: { tone: unknown }
  required_env: string[]
  files: PackManifestFile[]
  secret_scan: {
    status: 'pass'
    rules_version: number
    files_scanned: number
    scanned_at: string
  }
  lineage: {
    source_assistant_id: string
    source_generation: number
    platform: 'home-of-agents'
  }
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** kebab slug, the bgos-build-agent convention: lowercase, non-alphanumeric
 *  runs become "-", trimmed. */
export function slugify(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'agent'
}

/**
 * Extract required env KEY NAMES referenced in the collected text: uppercase
 * env-style tokens containing _KEY, _TOKEN, or _SECRET. Names only, never
 * values, and never invented: a name rides the manifest only when it
 * literally appears in a packed file.
 */
export function extractRequiredEnv(texts: string[]): string[] {
  const names = new Set<string>()
  const tokenRe = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
  for (const text of texts) {
    for (const match of text.matchAll(tokenRe)) {
      const name = match[0]!
      if (/_KEY|_TOKEN|_SECRET/.test(name)) names.add(name)
    }
  }
  return [...names].sort()
}

export function buildManifest(args: {
  agentName: string
  assistantId: string
  tier: PackTier
  sourceGeneration: number
  rulesVersion: number
  packagedAt: Date
  files: Array<{ packPath: string; data: Uint8Array }>
  requiredEnv: string[]
}): PackManifest {
  const name = args.agentName.trim() || `agent-${args.assistantId || 'unknown'}`
  const iso = args.packagedAt.toISOString()
  const files = [...args.files]
    .sort((a, b) => (a.packPath < b.packPath ? -1 : a.packPath > b.packPath ? 1 : 0))
    .map((f) => ({
      path: f.packPath,
      sha256: sha256Hex(f.data),
      bytes: f.data.length,
    }))
  return {
    schema_version: 1,
    pack: { name, slug: slugify(name), packaged_at: iso },
    agent_class: 'claude-code',
    tier: args.tier,
    // The backend enriches its stored manifest row with the assistant's
    // persona / starter prompts / tone at pack-finalize; the plugin does not
    // know them and never guesses.
    persona: null,
    starter_prompts: null,
    model_prefs: { tone: null },
    required_env: args.requiredEnv,
    files,
    secret_scan: {
      status: 'pass',
      rules_version: args.rulesVersion,
      files_scanned: args.files.length,
      scanned_at: iso,
    },
    lineage: {
      source_assistant_id: args.assistantId,
      source_generation: args.sourceGeneration,
      platform: 'home-of-agents',
    },
  }
}

// ── Result body builders ─────────────────────────────────────────────────────

export function buildOkResult(
  manifest: PackManifest,
  packSha256: string,
  packBytes: number,
): ExportPackResultBody {
  return { ok: true, payload: { manifest, packSha256, packBytes } }
}

export function buildErrorResult(
  code: string,
  message: string,
  findings?: SecretFinding[],
): ExportPackResultBody {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(findings && findings.length > 0 ? { findings } : {}),
    },
  }
}

// ── Handler (deps-injected orchestration) ────────────────────────────────────

export interface ExportPackDeps {
  config: {
    /** Absolute workspace root (server.ts passes process.cwd()). */
    workspaceRoot: string
    assistantId: string
  }
  /** POST integrations/export-pack/:rpcId/ack (X-API-Key). Best effort. */
  postAck(rpcId: string): Promise<unknown>
  /** POST integrations/export-pack/:rpcId/result (X-API-Key). ALWAYS sent. */
  postResult(rpcId: string, body: ExportPackResultBody): Promise<unknown>
  /** Workspace listing (relative paths + byte sizes) covering at least the
   *  allowlist trees. Extra entries are fine; the lib filters. */
  listWorkspaceFiles(): Promise<WorkspaceFileEntry[]>
  /** Read one workspace-relative file. */
  readFile(relPath: string): Promise<Uint8Array>
  /** realpath of a workspace-relative path; '' resolves the root itself.
   *  The symlink-escape gate compares results against the root's realpath. */
  realpath(relPath: string): Promise<string>
  log(msg: string): void
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable clock (packaged_at / scanned_at); defaults to Date. */
  now?: () => Date
}

// ── Encoding normalization (scan input == packed bytes) ─────────────────────

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
const utf16leDecoder = new TextDecoder('utf-16le', { fatal: false })
const utf16beDecoder = new TextDecoder('utf-16be', { fatal: false })
const utf8Encoder = new TextEncoder()

export interface NormalizedFile {
  /** The text the secret scanner sees. */
  text: string
  /** The bytes the pack ships: exactly the UTF-8 encoding of `text`, so no
   *  byte can ship that the scanner did not see. */
  data: Uint8Array
}

export type NormalizeResult =
  | { ok: true; file: NormalizedFile }
  | { ok: false; message: string }

/** Detect a leading byte-order mark. UTF-32 is checked before UTF-16 because
 *  the UTF-32LE BOM (FF FE 00 00) begins with the UTF-16LE BOM (FF FE). */
function detectBom(
  data: Uint8Array,
): 'utf-32le' | 'utf-32be' | 'utf-16le' | 'utf-16be' | 'utf-8' | null {
  const b = data
  if (
    b.length >= 4 &&
    b[0] === 0xff &&
    b[1] === 0xfe &&
    b[2] === 0x00 &&
    b[3] === 0x00
  ) {
    return 'utf-32le'
  }
  if (
    b.length >= 4 &&
    b[0] === 0x00 &&
    b[1] === 0x00 &&
    b[2] === 0xfe &&
    b[3] === 0xff
  ) {
    return 'utf-32be'
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le'
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be'
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return 'utf-8'
  }
  return null
}

/**
 * Normalize a file's raw bytes to the canonical UTF-8 form used for BOTH the
 * secret scan AND the packed zip entry. The scanner is line/regex based over
 * text, but the zip historically shipped the RAW bytes, so a non-UTF-8 file
 * (e.g. a UTF-16LE CLAUDE.md from a Windows editor) could smuggle a live key
 * past the scan: the lossy UTF-8 decode turned "AKIA..." into "A\0K\0I\0A..."
 * (matching no rule) while the original key-bearing bytes still shipped.
 *
 * The fix keeps scan input and shipped bytes identical:
 *   - A UTF-16 (or UTF-8) BOM selects the matching decoder; the decoded text is
 *     re-encoded as UTF-8, so a UTF-16 CLAUDE.md STILL scans and STILL packs,
 *     just as UTF-8.
 *   - With no BOM the bytes are read as UTF-8; if the decoded text still holds
 *     a NUL (a BOM-less UTF-16 file, or a binary file) it cannot be safely
 *     scanned as text, so the whole pack is rejected rather than shipping
 *     unscanned bytes.
 *   - UTF-32 is not a TextDecoder text encoding, so a UTF-32 BOM is rejected.
 *
 * Invariant: no byte ships in a pack that the scanner did not see.
 */
export function normalizeToUtf8(data: Uint8Array): NormalizeResult {
  const bom = detectBom(data)
  if (bom === 'utf-32le' || bom === 'utf-32be') {
    return {
      ok: false,
      message: `file is ${bom}, which is not a scannable text encoding; save it as UTF-8`,
    }
  }
  let text: string
  if (bom === 'utf-16le') {
    text = utf16leDecoder.decode(data)
  } else if (bom === 'utf-16be') {
    text = utf16beDecoder.decode(data)
  } else {
    // 'utf-8' BOM (stripped by the decoder) or no BOM at all.
    text = utf8Decoder.decode(data)
  }
  if (text.includes('\u0000')) {
    return {
      ok: false,
      message:
        'file contains NUL bytes and cannot be safely secret-scanned as text ' +
        '(a BOM-less UTF-16 or binary file); save it as UTF-8',
    }
  }
  return { ok: true, file: { text, data: utf8Encoder.encode(text) } }
}

export class ExportPackHandler {
  private readonly deps: ExportPackDeps
  /** Duplicate-frame guard: the backend re-emits once when its ACK does not
   *  land in time; a pack built twice would double-upload. */
  private readonly inFlight = new Set<string>()

  constructor(deps: ExportPackDeps) {
    this.deps = deps
  }

  /** The export_pack WS event: build + upload + report. */
  async handleExport(frame: ExportPackFrame): Promise<void> {
    if (!frame?.rpcId) return
    if (this.inFlight.has(frame.rpcId)) {
      this.deps.log(`export_pack duplicate frame ignored (rpc=${frame.rpcId})`)
      return
    }
    this.inFlight.add(frame.rpcId)
    try {
      await this.ackBestEffort(frame.rpcId)
      let body: ExportPackResultBody
      try {
        body = await this.buildAndUpload(frame)
      } catch (err) {
        body = buildErrorResult(
          'PLUGIN_ERROR',
          err instanceof Error ? err.message : String(err),
        )
      }
      await this.postResult(frame.rpcId, body)
    } finally {
      this.inFlight.delete(frame.rpcId)
    }
  }

  /** The export_pack_manifest WS event: dry-run candidate listing. */
  async handleManifest(frame: ExportPackManifestFrame): Promise<void> {
    if (!frame?.rpcId) return
    if (this.inFlight.has(frame.rpcId)) {
      this.deps.log(
        `export_pack_manifest duplicate frame ignored (rpc=${frame.rpcId})`,
      )
      return
    }
    this.inFlight.add(frame.rpcId)
    try {
      await this.ackBestEffort(frame.rpcId)
      let body: ExportPackResultBody
      try {
        const candidates = await this.discoverInsideRoot()
        body = {
          ok: true,
          payload: {
            files: candidates.map((c) => ({
              path: c.workspacePath,
              bytes: c.bytes,
              kind: c.kind,
            })),
          },
        }
      } catch (err) {
        body = buildErrorResult(
          'PLUGIN_ERROR',
          err instanceof Error ? err.message : String(err),
        )
      }
      await this.postResult(frame.rpcId, body)
    } finally {
      this.inFlight.delete(frame.rpcId)
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async ackBestEffort(rpcId: string): Promise<void> {
    try {
      await this.deps.postAck(rpcId)
    } catch (err) {
      this.deps.log(
        `export_pack ack failed (non-fatal, rpc=${rpcId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  private async rootRealpath(): Promise<string> {
    const root = await this.deps.realpath('')
    return root.endsWith('/') ? root.slice(0, -1) : root
  }

  private async resolvesInsideRoot(
    rootReal: string,
    relPath: string,
  ): Promise<boolean> {
    try {
      const real = await this.deps.realpath(relPath)
      return real === rootReal || real.startsWith(`${rootReal}/`)
    } catch {
      // Unresolvable (vanished, broken symlink): never inside.
      return false
    }
  }

  /** Dry-run universe: discovered candidates minus realpath escapees
   *  (a listing should not fail wholesale over one stray symlink). */
  private async discoverInsideRoot(): Promise<PackCandidate[]> {
    const listing = await this.deps.listWorkspaceFiles()
    const discovered = discoverCandidates(listing)
    const rootReal = await this.rootRealpath()
    const inside: PackCandidate[] = []
    for (const candidate of discovered) {
      if (await this.resolvesInsideRoot(rootReal, candidate.workspacePath)) {
        inside.push(candidate)
      } else {
        this.deps.log(
          `export_pack_manifest: dropped candidate resolving outside the ` +
            `workspace: ${candidate.workspacePath}`,
        )
      }
    }
    return inside
  }

  private async buildAndUpload(
    frame: ExportPackFrame,
  ): Promise<ExportPackResultBody> {
    if (!frame.uploadUrl) {
      return buildErrorResult(
        'BAD_FRAME',
        'export_pack frame carried no uploadUrl',
      )
    }
    const listing = await this.deps.listWorkspaceFiles()
    const collected = collectCandidates(listing, {
      tier: frame.tier,
      memoryFiles: frame.memoryFiles,
    })
    if (!collected.ok) {
      return buildErrorResult(collected.error.code, collected.error.message)
    }
    const candidates = collected.candidates
    if (candidates.filter((c) => c.kind === 'body').length === 0) {
      return buildErrorResult(
        'MANIFEST_ONLY',
        'no agent body files found (CLAUDE.md, .claude/rules/*.md, ' +
          '.claude/skills/*/SKILL.md); the pack would contain only its manifest',
      )
    }

    // Symlink-escape gate: EVERY selected file must resolve inside the
    // workspace root. Loud failure so the owner can fix the workspace.
    const rootReal = await this.rootRealpath()
    for (const candidate of candidates) {
      if (!(await this.resolvesInsideRoot(rootReal, candidate.workspacePath))) {
        return buildErrorResult(
          'PATH_ESCAPE',
          `candidate file resolves outside the workspace root: ` +
            candidate.workspacePath,
        )
      }
    }

    const files: Array<{
      workspacePath: string
      packPath: string
      data: Uint8Array
      text: string
    }> = []
    for (const candidate of candidates) {
      const raw = await this.deps.readFile(candidate.workspacePath)
      // Normalize to canonical UTF-8 so the bytes we SCAN are the bytes we
      // SHIP: a non-UTF-8 file (e.g. a UTF-16 CLAUDE.md) must not smuggle a
      // key past the line-based scanner. Unscannable content (BOM-less UTF-16,
      // binary, UTF-32) is rejected loudly rather than shipped unscanned.
      const normalized = normalizeToUtf8(raw)
      if (!normalized.ok) {
        return buildErrorResult(
          'NON_UTF8_FILE',
          `${candidate.workspacePath}: ${normalized.message}`,
        )
      }
      files.push({
        workspacePath: candidate.workspacePath,
        packPath: candidate.packPath,
        data: normalized.file.data,
        text: normalized.file.text,
      })
    }

    // Secret scan gate: findings name the REAL workspace file + line so the
    // owner can open and fix it. ANY finding blocks packaging entirely; no
    // upload happens on a blocked scan. The scanned text is the canonical
    // UTF-8 decode of exactly the bytes packed below (see normalizeToUtf8).
    const findings = scanFiles(
      files.map((f) => ({ path: f.workspacePath, text: f.text })),
    )
    if (findings.length > 0) {
      return buildErrorResult(
        'SECRET_SCAN_BLOCKED',
        `secret scan blocked packaging: ${findings.length} finding(s)`,
        findings,
      )
    }

    const now = this.deps.now ?? (() => new Date())
    const packagedAt = now()
    const requiredEnv = extractRequiredEnv(files.map((f) => f.text))
    const manifest = buildManifest({
      agentName: frame.agentName,
      assistantId: frame.assistantId || this.deps.config.assistantId,
      tier: frame.tier,
      sourceGeneration: frame.sourceGeneration,
      rulesVersion: frame.rulesVersion,
      packagedAt,
      files: files.map((f) => ({ packPath: f.packPath, data: f.data })),
      requiredEnv,
    })

    const entries: ZipEntryInput[] = [
      {
        path: MANIFEST_ENTRY_NAME,
        data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      },
      ...files.map((f) => ({ path: f.packPath, data: f.data })),
    ]
    const zip = buildStoredZip(entries, packagedAt)
    const packBytes = zip.length
    const packSha256 = sha256Hex(zip)

    // Size gate BEFORE any upload byte leaves the machine.
    if (packBytes > frame.maxBytes) {
      return buildErrorResult(
        'PACK_TOO_LARGE',
        `pack is ${packBytes} bytes; the limit is ${frame.maxBytes}`,
      )
    }

    const fetchImpl = this.deps.fetchImpl ?? fetch
    let res: Response
    try {
      res = await fetchImpl(frame.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/zip' },
        // Fresh ArrayBuffer-backed view: BodyInit rejects ArrayBufferLike
        // views (same pattern as server.ts uploadViaS3).
        body: new Uint8Array(zip),
      })
    } catch (err) {
      return buildErrorResult(
        'UPLOAD_FAILED',
        `pack upload failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return buildErrorResult(
        'UPLOAD_FAILED',
        `pack upload failed: HTTP ${res.status}: ${text.slice(0, 200)}`,
      )
    }

    return buildOkResult(manifest, packSha256, packBytes)
  }

  private async postResult(
    rpcId: string,
    body: ExportPackResultBody,
  ): Promise<void> {
    try {
      await this.deps.postResult(rpcId, body)
    } catch (err) {
      // Nothing else we can do; the backend's own sweep retries the dispatch.
      this.deps.log(
        `export_pack result post failed (rpc=${rpcId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
