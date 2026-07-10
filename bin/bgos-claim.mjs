#!/usr/bin/env node
/**
 * bgos-claim: one-command Agent Pack claim installer (Home of Agents).
 *
 * The recipient of a Type 3 "Full handoff" runs, as shown on the claim page:
 *
 *   npx --yes --package github:BrandGrowthOS/bgos-claude-plugin bgos-claim <claimToken>
 *
 * Flow:
 *   1. GET <apiBase>/handoffs/claim/<token>/pack (token bearer, works only
 *      after the handoff was claimed in the app)
 *   2. download the pack zip and verify EVERY manifest files[] sha256
 *      (any mismatch aborts loudly; nothing touches disk before this passes)
 *   3. scaffold ~/bgos-agents/<slug>/ per the bgos-build-agent pattern
 *      (CLAUDE.md, .claude/rules/, .claude/skills/, memory/, .gitignore,
 *      .claude/settings.local.json)
 *   4. prompt for the RECIPIENT'S OWN X-API-Key (hidden input; keys are
 *      never shipped in packs)
 *   5. write .mcp.json (chmod 600) with the REAL env keys server.ts
 *      requires: BGOS_BACKEND_URL, BGOS_API_KEY, BGOS_USER_ID,
 *      BGOS_ASSISTANT_ID
 *   6. print the required_env key NAMES the agent still needs and the
 *      launch command
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports
 * from the TS plugin sources. Import-safe: every helper is exported and
 * main() only runs when the file is executed directly, so tests can import
 * the pure pieces.
 *
 * NOTE: the platform scaffold template mcp.json.tmpl uses WRONG env key
 * names (API_KEY / API_BASE, no user id); this installer emits the real
 * ones exactly like bin/bgos-agent's write_mcp_json does.
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile, chmod, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEFAULT_API_BASE = 'https://api.brandgrowthos.ai/api/v1'
export const PLUGIN_REPO =
  'https://github.com/BrandGrowthOS/bgos-claude-plugin.git'
/** .mcp.json holds the recipient's API key; keep it owner-read/write only. */
export const MCP_JSON_MODE = 0o600
export const GITIGNORE_BODY = '.mcp.json\n.claude/settings.local.json\n*.log\n'
export const SETTINGS_LOCAL_JSON = { enableAllProjectMcpServers: true }
/** Env keys the installer itself provides; anything else in required_env
 *  still needs the recipient's own value. */
export const PROVIDED_ENV_KEYS = [
  'BGOS_BACKEND_URL',
  'BGOS_API_KEY',
  'BGOS_USER_ID',
  'BGOS_ASSISTANT_ID',
]

// ── Small pure helpers ───────────────────────────────────────────────────────

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** kebab slug, the bgos-build-agent convention: lowercase, non-alphanumeric
 *  runs become "-", trimmed; never empty. */
export function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'agent'
}

/** A scaffold slug is a single short folder name, never a path; longer
 *  network-sourced values are rejected. */
export const MAX_SLUG_LENGTH = 64

/**
 * Validate a NETWORK-SOURCED agent slug before it is joined onto a filesystem
 * path. The /pack endpoint and the manifest are attacker-influenceable (the
 * slug ultimately derives from an owner-chosen agent name), so the slug is
 * trusted only when it is exactly one lowercase kebab segment: no path
 * separators, no "..", no leading dot, not absolute, not empty, not overlong.
 * Returns the slug when safe, else null so the caller falls back to a locally
 * derived slug. This is the primary path-traversal gate; resolveAgentDir is
 * the belt-and-suspenders containment assert.
 */
export function safeAgentSlug(candidate) {
  if (typeof candidate !== 'string') return null
  const value = candidate.trim()
  if (!value || value.length > MAX_SLUG_LENGTH) return null
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) return null
  return value
}

/**
 * Choose the scaffold slug, never trusting the network. A network-provided
 * slug is used ONLY when it validates as a safe single segment; otherwise the
 * slug falls back to the locally derived name (slugify always yields a safe
 * single segment), so a hostile or regressed server slug can never steer the
 * scaffold path.
 */
export function chooseAgentSlug({ packSlug, manifestSlug, agentName }) {
  return (
    safeAgentSlug(packSlug) || safeAgentSlug(manifestSlug) || slugify(agentName)
  )
}

/**
 * Resolve the scaffold directory for a slug and hard-assert it stays inside
 * the agents root (path.resolve + separator-bounded prefix). Even with a
 * validated slug this is a final containment check so no traversal can ever
 * escape ~/bgos-agents; it throws loudly rather than writing outside the root.
 */
export function resolveAgentDir(agentsRoot, slug) {
  const rootResolved = resolve(agentsRoot)
  const dir = join(rootResolved, slug)
  const dirResolved = resolve(dir)
  if (
    dirResolved === rootResolved ||
    !dirResolved.startsWith(rootResolved + sep)
  ) {
    throw new Error(
      `refusing to scaffold outside the agents root: ` +
        `${dirResolved} is not inside ${rootResolved}`,
    )
  }
  return dir
}

/** Accept a raw claim token or a pasted claim URL (…/h/<token>). */
export function extractClaimToken(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  const urlMatch = value.match(/\/h\/([A-Za-z0-9_-]+)/)
  if (urlMatch) return urlMatch[1]
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value
  return ''
}

export function parseClaimArgs(argv) {
  const args = {
    token: '',
    apiBase: DEFAULT_API_BASE,
    agentsRoot: '',
    force: false,
    help: false,
  }
  const errors = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--force') {
      args.force = true
    } else if (arg === '--api-base') {
      const value = argv[++i]
      if (!value) errors.push('--api-base needs a value')
      else args.apiBase = value.replace(/\/+$/, '')
    } else if (arg === '--agents-root') {
      const value = argv[++i]
      if (!value) errors.push('--agents-root needs a value')
      else args.agentsRoot = value
    } else if (arg.startsWith('-')) {
      errors.push(`unknown flag: ${arg}`)
    } else if (!args.token) {
      args.token = extractClaimToken(arg)
      if (!args.token) errors.push(`that does not look like a claim token: ${arg}`)
    } else {
      errors.push(`unexpected extra argument: ${arg}`)
    }
  }
  if (!args.help && !args.token && errors.length === 0) {
    errors.push('missing claim token')
  }
  return { args, errors }
}

export const USAGE = `bgos-claim: install your copy of a handed-off agent (Home of Agents)

Usage:
  npx --yes --package github:BrandGrowthOS/bgos-claude-plugin bgos-claim <claimToken>

Options:
  --api-base <url>      backend API base (default ${DEFAULT_API_BASE})
  --agents-root <dir>   where agent folders live (default ~/bgos-agents)
  --force               overwrite an existing non-empty agent folder
  -h, --help            show this help
`

// ── STORED zip reader (plain JS twin of lib/pack-zip.ts readStoredZip) ──────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data) {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Read a single-disk zip whose entries are all STORED (packs always are).
 * Verifies each entry's CRC32; throws descriptive errors on anything
 * malformed, compressed, or corrupted. Keep in lockstep with
 * lib/pack-zip.ts (the cross-twin test pins the round trip).
 */
export function readStoredZip(zip) {
  if (zip.length < 22) throw new Error('zip too short')
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocdOffset = -1
  const scanFloor = Math.max(0, zip.length - 22 - 0xffff)
  for (let i = zip.length - 22; i >= scanFloor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('zip end of central directory not found')
  if (
    view.getUint16(eocdOffset + 4, true) !== 0 ||
    view.getUint16(eocdOffset + 6, true) !== 0
  ) {
    throw new Error('multi-disk zips are not supported')
  }
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  if (cdOffset > zip.length) throw new Error('zip central directory out of range')
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const entries = []
  let cursor = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > zip.length) throw new Error('zip central directory truncated')
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('bad zip central directory signature')
    }
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const path = decoder.decode(zip.subarray(cursor + 46, cursor + 46 + nameLength))
    if (method !== 0) {
      throw new Error(`unsupported zip compression method for ${path}`)
    }
    if (compressedSize !== uncompressedSize) {
      throw new Error(`stored entry size mismatch for ${path}`)
    }
    if (localOffset + 30 > zip.length) {
      throw new Error(`zip local header out of range for ${path}`)
    }
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`bad zip local header signature for ${path}`)
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + uncompressedSize > zip.length) {
      throw new Error(`zip entry data out of range for ${path}`)
    }
    const data = zip.subarray(dataStart, dataStart + uncompressedSize)
    if (crc32(data) !== crc) throw new Error(`zip crc mismatch for ${path}`)
    entries.push({ path, data })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

// ── Pack verification (the integrity gate) ───────────────────────────────────

/**
 * Verify the pack against its manifest: every manifest files[] entry must
 * exist with matching bytes and sha256, and every non-manifest zip entry
 * must be listed (no smuggled extras). Returns [] when clean, else a list
 * of { path, reason } problems.
 */
export function verifyManifestFiles(manifest, entries) {
  const problems = []
  const listed = new Map()
  for (const f of Array.isArray(manifest?.files) ? manifest.files : []) {
    if (f && typeof f.path === 'string') listed.set(f.path, f)
  }
  const byPath = new Map()
  for (const e of entries) {
    if (e.path !== 'manifest.json') byPath.set(e.path, e)
  }
  for (const [path, f] of listed) {
    const entry = byPath.get(path)
    if (!entry) {
      problems.push({ path, reason: 'missing_entry' })
      continue
    }
    if (entry.data.length !== f.bytes) {
      problems.push({ path, reason: 'bytes_mismatch' })
    } else if (sha256Hex(entry.data) !== f.sha256) {
      problems.push({ path, reason: 'sha256_mismatch' })
    }
  }
  for (const path of byPath.keys()) {
    if (!listed.has(path)) problems.push({ path, reason: 'unlisted_entry' })
  }
  return problems
}

/**
 * Map a pack entry to its workspace destination (zip-slip safe): returns
 * null for manifest.json, unknown layouts, and any path that is absolute or
 * carries "..", empty, or backslash segments.
 */
export function packEntryToWorkspacePath(packPath) {
  if (typeof packPath !== 'string' || !packPath) return null
  if (packPath === 'manifest.json') return null
  if (packPath.startsWith('/') || packPath.includes('\\')) return null
  if (packPath.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return null
  }
  if (packPath === 'agent/CLAUDE.md') return 'CLAUDE.md'
  if (packPath.startsWith('agent/rules/')) {
    return `.claude/rules/${packPath.slice('agent/rules/'.length)}`
  }
  if (packPath.startsWith('agent/skills/')) {
    return `.claude/skills/${packPath.slice('agent/skills/'.length)}`
  }
  if (packPath.startsWith('memory/')) return packPath
  return null
}

/** The exact .mcp.json config server.ts requires (see its env validation). */
export function buildMcpJson({
  pluginServerPath,
  backendUrl,
  apiKey,
  userId,
  assistantId,
}) {
  return {
    mcpServers: {
      bgos: {
        command: 'bun',
        args: [pluginServerPath],
        env: {
          BGOS_BACKEND_URL: String(backendUrl),
          BGOS_API_KEY: String(apiKey),
          BGOS_USER_ID: String(userId),
          BGOS_ASSISTANT_ID: String(assistantId),
        },
      },
    },
  }
}

/** required_env names the recipient still has to provide themselves. */
export function requiredEnvStillNeeded(requiredEnv) {
  const provided = new Set(PROVIDED_ENV_KEYS)
  return [...new Set(Array.isArray(requiredEnv) ? requiredEnv : [])]
    .filter((name) => typeof name === 'string' && name && !provided.has(name))
    .sort()
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function buildLaunchCommand(dir) {
  return (
    `cd ${shellQuote(dir)} && claude --dangerously-skip-permissions ` +
    `--dangerously-load-development-channels server:bgos`
  )
}

// ── Effectful pieces (kept small; main() composes them) ──────────────────────

/** Write .mcp.json with mode 600 (writeFile mode is umask-affected, so an
 *  explicit chmod pins the exact bits). */
export async function writeMcpJsonFile(path, config) {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: MCP_JSON_MODE,
  })
  await chmod(path, MCP_JSON_MODE)
}

/** Hidden terminal prompt (no echo). Falls back to visible input when not
 *  a TTY (e.g. piped), with a warning. */
export function promptHidden(question, opts = {}) {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stderr
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      output.write(`${question}(input not hidden here) `)
      let buffered = ''
      const onData = (chunk) => {
        buffered += chunk.toString('utf8')
        const newline = buffered.indexOf('\n')
        if (newline >= 0) {
          input.off('data', onData)
          input.pause()
          resolve(buffered.slice(0, newline).trim())
        }
      }
      input.on('data', onData)
      input.resume()
      return
    }
    output.write(question)
    input.setRawMode(true)
    input.resume()
    let value = ''
    const cleanup = () => {
      input.setRawMode(false)
      input.pause()
      input.off('data', onData)
    }
    const onData = (chunk) => {
      const text = chunk.toString('utf8')
      for (const ch of text) {
        if (ch === '\u0003') {
          cleanup()
          output.write('\n')
          reject(new Error('cancelled'))
          return
        }
        if (ch === '\r' || ch === '\n') {
          cleanup()
          output.write('\n')
          resolve(value.trim())
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += ch
      }
    }
    input.on('data', onData)
  })
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const text = await res.text().catch(() => '')
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, ok: res.ok, body, text }
}

async function isDirNonEmpty(dir) {
  try {
    const entries = await readdir(dir)
    return entries.length > 0
  } catch {
    return false
  }
}

async function hasCommand(cmd) {
  try {
    await execFileAsync('/bin/sh', ['-c', `command -v ${cmd}`])
    return true
  } catch {
    return false
  }
}

/**
 * Ensure a durable plugin checkout the agent's .mcp.json can point at
 * (~/bgos-agents/.plugin/bgos-claude-plugin, the bgos-build-agent shared
 * clone pattern). BGOS_PLUGIN_DIR overrides; BGOS_PLUGIN_REPO overrides the
 * clone source. Returns the absolute path to server.ts.
 */
export async function ensurePluginCheckout(agentsRoot, env = process.env, log = console.error) {
  const overrideDir = env.BGOS_PLUGIN_DIR
  if (overrideDir) {
    const overrideServer = join(overrideDir, 'server.ts')
    if (!existsSync(overrideServer)) {
      throw new Error(`BGOS_PLUGIN_DIR has no server.ts: ${overrideDir}`)
    }
    return overrideServer
  }
  const pluginDir = join(agentsRoot, '.plugin', 'bgos-claude-plugin')
  const serverPath = join(pluginDir, 'server.ts')
  const repo = env.BGOS_PLUGIN_REPO || PLUGIN_REPO
  if (!(await hasCommand('git'))) {
    throw new Error('git is required (install git, then re-run this command)')
  }
  if (existsSync(serverPath)) {
    try {
      await execFileAsync('git', ['-C', pluginDir, 'pull', '--ff-only'], {
        timeout: 60_000,
      })
    } catch {
      log('[bgos-claim] warning: could not update the plugin checkout; using it as-is')
    }
  } else {
    await mkdir(dirname(pluginDir), { recursive: true })
    await execFileAsync('git', ['clone', '--depth', '1', repo, pluginDir], {
      timeout: 180_000,
    })
  }
  if (await hasCommand('bun')) {
    try {
      await execFileAsync('bun', ['install', '--no-summary'], {
        cwd: pluginDir,
        timeout: 180_000,
      })
    } catch {
      log(
        '[bgos-claim] warning: bun install failed; the plugin installs its own deps on first launch',
      )
    }
  } else {
    log(
      '[bgos-claim] warning: bun is not installed; install it from https://bun.sh before launching the agent',
    )
  }
  if (!existsSync(serverPath)) {
    throw new Error(`plugin checkout has no server.ts: ${pluginDir}`)
  }
  return serverPath
}

/** Write the scaffold folder from verified pack entries. Pure layout logic
 *  lives in packEntryToWorkspacePath; this only touches the target dir. */
export async function scaffoldWorkspace(dir, entries, log = console.error) {
  await mkdir(dir, { recursive: true })
  for (const sub of ['.claude/rules', '.claude/skills', 'memory']) {
    await mkdir(join(dir, sub), { recursive: true })
  }
  const dirResolved = resolve(dir)
  let written = 0
  for (const entry of entries) {
    const rel = packEntryToWorkspacePath(entry.path)
    if (!rel) {
      if (entry.path !== 'manifest.json') {
        log(`[bgos-claim] skipping unknown pack entry: ${entry.path}`)
      }
      continue
    }
    const target = join(dir, rel)
    // Zip-slip re-check: packEntryToWorkspacePath already rejects "..",
    // absolute, and backslash paths, but assert the resolved target stays
    // inside the scaffold dir before writing (defense in depth on extraction).
    if (!resolve(target).startsWith(dirResolved + sep)) {
      log(`[bgos-claim] skipping pack entry escaping the workspace: ${entry.path}`)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.data)
    written++
  }
  await writeFile(join(dir, '.gitignore'), GITIGNORE_BODY)
  await mkdir(join(dir, '.claude'), { recursive: true })
  await writeFile(
    join(dir, '.claude', 'settings.local.json'),
    `${JSON.stringify(SETTINGS_LOCAL_JSON, null, 2)}\n`,
  )
  return written
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const { args, errors } = parseClaimArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[bgos-claim] ${error}`)
    process.stdout.write(USAGE)
    return 2
  }

  console.log('[bgos-claim] fetching your pack from Home of Agents...')
  const packUrl = `${args.apiBase}/handoffs/claim/${encodeURIComponent(args.token)}/pack`
  const packRes = await fetchJson(packUrl)
  if (!packRes.ok) {
    const message =
      packRes.body?.message ||
      packRes.body?.code ||
      (packRes.status === 404
        ? 'unknown or expired claim link'
        : `HTTP ${packRes.status}`)
    console.error(
      `[bgos-claim] could not fetch the pack: ${message}\n` +
        '[bgos-claim] make sure you claimed the handoff in the app first, then re-run this command.',
    )
    return 1
  }
  const pack = packRes.body ?? {}
  if (!pack.downloadUrl) {
    console.error('[bgos-claim] the pack endpoint returned no downloadUrl; try again in a minute')
    return 1
  }

  console.log('[bgos-claim] downloading the pack zip...')
  const zipRes = await fetch(pack.downloadUrl)
  if (!zipRes.ok) {
    console.error(`[bgos-claim] pack download failed: HTTP ${zipRes.status}`)
    return 1
  }
  const zip = new Uint8Array(await zipRes.arrayBuffer())

  // Integrity gate: nothing is written to disk unless EVERY hash checks out.
  if (typeof pack.packSha256 === 'string' && pack.packSha256) {
    if (sha256Hex(zip) !== pack.packSha256) {
      console.error(
        '[bgos-claim] ABORT: the downloaded pack does not match its recorded sha256. ' +
          'The download was discarded; nothing was installed. Re-run to retry.',
      )
      return 1
    }
  }
  let entries
  try {
    entries = readStoredZip(zip)
  } catch (err) {
    console.error(`[bgos-claim] ABORT: unreadable pack zip (${err.message}). Nothing was installed.`)
    return 1
  }
  const manifestEntry = entries.find((e) => e.path === 'manifest.json')
  if (!manifestEntry) {
    console.error('[bgos-claim] ABORT: the pack has no manifest.json. Nothing was installed.')
    return 1
  }
  if (typeof pack.manifestSha256 === 'string' && pack.manifestSha256) {
    if (sha256Hex(manifestEntry.data) !== pack.manifestSha256) {
      console.error(
        '[bgos-claim] ABORT: manifest.json does not match its recorded sha256. ' +
          'The download was discarded; nothing was installed.',
      )
      return 1
    }
  }
  let manifest
  try {
    manifest = JSON.parse(new TextDecoder('utf-8').decode(manifestEntry.data))
  } catch {
    console.error('[bgos-claim] ABORT: manifest.json is not valid JSON. Nothing was installed.')
    return 1
  }
  const problems = verifyManifestFiles(manifest, entries)
  if (problems.length > 0) {
    console.error('[bgos-claim] ABORT: pack integrity check failed:')
    for (const p of problems) console.error(`  - ${p.path}: ${p.reason}`)
    console.error('[bgos-claim] the download was discarded; nothing was installed.')
    return 1
  }
  console.log(`[bgos-claim] pack verified (${entries.length - 1} files, all sha256 match)`)

  // Scaffold target.
  const agentsRoot =
    args.agentsRoot || process.env.BGOS_AGENTS_ROOT || join(homedir(), 'bgos-agents')
  const agentName = pack.agentName || manifest?.pack?.name || 'agent'
  // The slug lands in a filesystem path, so never trust the network value:
  // it is used only when it validates as a safe single segment, else we fall
  // back to the locally derived slug. resolveAgentDir then hard-asserts the
  // target stays inside the agents root (path traversal defense).
  const slug = chooseAgentSlug({
    packSlug: pack.slug,
    manifestSlug: manifest?.pack?.slug,
    agentName,
  })
  let dir
  try {
    dir = resolveAgentDir(agentsRoot, slug)
  } catch (err) {
    console.error(`[bgos-claim] ABORT: ${err.message}. Nothing was installed.`)
    return 1
  }
  if (!args.force && (await isDirNonEmpty(dir))) {
    console.error(
      `[bgos-claim] ABORT: ${dir} already exists and is not empty. ` +
        'Re-run with --force to overwrite it.',
    )
    return 1
  }

  console.log('[bgos-claim] preparing the channel plugin checkout...')
  const pluginServerPath = await ensurePluginCheckout(agentsRoot)

  const written = await scaffoldWorkspace(dir, entries)
  console.log(`[bgos-claim] scaffolded ${dir} (${written} pack files)`)

  // The recipient's OWN key: never shipped in the pack, never echoed.
  let apiKey = (process.env.BGOS_API_KEY || '').trim()
  if (!apiKey) {
    for (let attempt = 0; attempt < 3 && !apiKey; attempt++) {
      apiKey = await promptHidden(
        'Paste YOUR Home of Agents X-API-Key (Settings > API access; input is hidden): ',
      )
    }
  }
  if (!apiKey) {
    console.error(
      '[bgos-claim] ABORT: no API key entered. Get yours in the Home of Agents app ' +
        '(Settings > API access), then re-run this command.',
    )
    return 1
  }

  const backendUrl = pack.apiBase || args.apiBase
  const mcpConfig = buildMcpJson({
    pluginServerPath,
    backendUrl,
    apiKey,
    userId: pack.recipientUserId ?? '',
    assistantId: pack.assistantId ?? '',
  })
  await writeMcpJsonFile(join(dir, '.mcp.json'), mcpConfig)
  console.log('[bgos-claim] wrote .mcp.json (chmod 600)')

  const stillNeeded = requiredEnvStillNeeded(
    pack.requiredEnv ?? manifest?.required_env ?? [],
  )
  console.log('')
  console.log(`Your copy of ${agentName} is installed at ${dir}`)
  if (stillNeeded.length > 0) {
    console.log('')
    console.log(
      'This agent references these env key NAMES; add YOUR OWN values on this machine ' +
        '(the previous owner\'s keys are never included):',
    )
    for (const name of stillNeeded) console.log(`  - ${name}`)
  }
  console.log('')
  console.log('Launch it with:')
  console.log(`  ${buildLaunchCommand(dir)}`)
  console.log('')
  return 0
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`[bgos-claim] fatal: ${err?.message ?? err}`)
      process.exitCode = 1
    })
}
