#!/usr/bin/env node
/**
 * bgos-doctor: one-command diagnostic for a HOAI Claude Code agent machine
 * (fix 08 of the one-click onboarding design), and the preflight gate that
 * setup must pass before claiming success (fix 03).
 *
 * It prints one prerequisite table: STATUS / CHECK / DETAIL, one row per
 * prerequisite, plus the single exact fix command per failing row, so the
 * next problem on any machine is legible instead of silent. The rows, in
 * order: the claude CLI, claude auth (subscription auth specifically, since
 * API-key auth silently drops inbound channel messages), node, bun, bunx,
 * the detected install method (marketplace vs clone, which decides the
 * channel spec), the pairing credentials file, a REAL MCP initialize
 * handshake against the server via the launch shim, `claude mcp list`
 * reading Connected, backend reachability, and the daemon log path.
 *
 * --preflight makes the exit code the verdict: 0 only when the claude CLI,
 * auth, the initialize handshake, and `claude mcp list` are ALL green and
 * nothing else failed (backend reachability is implied by a live handshake
 * and is reported but exempted then).
 *
 * Wire note: the MCP stdio transport is newline-delimited JSON (one JSON-RPC
 * document per \n-terminated line; see @modelcontextprotocol/sdk
 * shared/stdio.js serializeMessage). The handshake client here speaks that
 * framing, and its parser additionally tolerates Content-Length framed
 * responses (LSP style) so a foreign server still classifies instead of
 * hanging the probe.
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports from
 * the TS plugin sources (it runs under bare node via npx on machines without
 * bun). Import-safe: every helper is exported and main() only runs when the
 * file is executed directly, so tests can import the pure pieces.
 *
 * Never prints secrets: no pairing token, no key material; the credentials
 * row shows the file path and assistant id only.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { resolveBunPath, bunInstallHint, executableNames, pathFlavor } from './bgos-launch.mjs'
import { detectInstallMethod, launchCommand } from './bgos-install-method.mjs'
import { resolveReadCredentialsPath, normalizeApiBase, FOLDER_PIN_FILE_NAME } from './bgos-pair.mjs'

export const DEFAULT_BACKEND_URL = 'https://api.brandgrowthos.ai/api/v1'
/** The MCP server names `claude mcp list` may print for this plugin. */
export const MCP_SERVER_NAMES = Object.freeze(['bgos', 'plugin:hoai:bgos'])
export const HANDSHAKE_TIMEOUT_MS = 60_000

// -- Pure layer ---------------------------------------------------------------

/** The platform install one-liner for the claude CLI, from claude.ai. */
export function claudeInstallHint(platform) {
  return platform === 'win32'
    ? 'powershell -c "irm https://claude.ai/install.ps1 | iex"'
    : 'curl -fsSL https://claude.ai/install.sh | bash'
}

/**
 * Is this auth method the claude.ai subscription? Anything else (console,
 * apiKey, an env key) makes the channel look alive while inbound messages are
 * silently dropped, so it is a failing row, not a footnote.
 */
export function isSubscriptionAuth(authMethod) {
  const normalized = String(authMethod ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized.includes('claudeai')
}

/**
 * Parse `claude auth status` output. The current CLI prints a JSON object
 * (possibly after a non-JSON preamble); older or wrapped invocations may
 * print prose. Returns { loggedIn, authMethod, subscriptionType } or null
 * when nothing in the text answers the question.
 */
export function parseAuthStatusOutput(text) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  if (start >= 0) {
    const slice = raw.slice(start)
    for (let end = slice.lastIndexOf('}'); end >= 0; end = slice.lastIndexOf('}', end - 1)) {
      try {
        const obj = JSON.parse(slice.slice(0, end + 1))
        if (obj && typeof obj === 'object') {
          return {
            loggedIn: Boolean(obj.loggedIn ?? obj.logged_in ?? obj.isLoggedIn),
            authMethod: String(obj.authMethod ?? obj.auth_method ?? obj.method ?? ''),
            subscriptionType: String(obj.subscriptionType ?? obj.subscription_type ?? obj.subscription ?? ''),
          }
        }
      } catch {
        // keep shrinking toward the previous closing brace
      }
    }
  }
  const plain = stripAnsi(raw)
  if (/not\s+logged\s+in|logged\s+out/i.test(plain)) {
    return { loggedIn: false, authMethod: '', subscriptionType: '' }
  }
  if (/logged\s?in/i.test(plain)) {
    const method =
      /(?:login|auth)\s*method\s*[:=]?\s*(\S+)/i.exec(plain)?.[1] ??
      (/claude\.?ai/i.test(plain) ? 'claude.ai' : '')
    return { loggedIn: true, authMethod: method, subscriptionType: '' }
  }
  return null
}

/** Strip ANSI escape sequences (colors, cursor moves) from CLI output. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b/g, '')
}

/**
 * Classify `claude mcp list` output for this plugin's server row. Names may
 * be bare (bgos) or plugin-prefixed (plugin:hoai:bgos), and a name can itself
 * contain colons, so the match is "line starts with <name>:" after trimming
 * decoration, not "split on the first colon". Status words are checked in
 * failure-first order because "Failed to connect" contains "connect".
 * @param {string} text
 * @param {readonly string[]} serverNames
 * @returns {{ found: boolean, state: 'connected'|'failed'|'needs-auth'|'unknown', line?: string }}
 */
export function parseMcpListOutput(text, serverNames) {
  const names = (serverNames ?? []).map((n) => String(n ?? '').trim()).filter(Boolean)
  for (const rawLine of stripAnsi(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    // Drop leading list decoration (bullets, check marks, whitespace) so the
    // name comparison sees the name itself first.
    const stripped = line.replace(/^[\s*•✓✔✖✗⚠-]+/, '')
    const matched = names.find((name) => stripped.startsWith(`${name}:`))
    if (!matched) continue
    if (/needs\s+authentication/i.test(line)) return { found: true, state: 'needs-auth', line }
    if (/failed|error/i.test(line)) return { found: true, state: 'failed', line }
    if (/connected/i.test(line)) return { found: true, state: 'connected', line }
    return { found: true, state: 'unknown', line }
  }
  return { found: false, state: 'unknown' }
}

/** Encode one JSON-RPC message in MCP stdio framing: JSON, one line, \n. */
export function encodeJsonRpcMessage(obj) {
  return `${JSON.stringify(obj)}\n`
}

/**
 * Incremental parser for an MCP stdio byte stream. feed(chunk) returns every
 * complete JSON-RPC message the buffer now holds. Primary framing is
 * newline-delimited JSON (the MCP spec and the SDK's StdioServerTransport);
 * a Content-Length header block (LSP framing) is also consumed correctly so
 * a server speaking that dialect still parses. Non-JSON lines (logs, blank
 * lines) are skipped, never fatal.
 */
export class McpFrameParser {
  constructor() {
    this.buffer = ''
  }

  /** @param {string | Buffer} chunk @returns {any[]} */
  feed(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    const messages = []
    for (;;) {
      // Content-Length framing: consume exactly the announced byte count,
      // which may end without a newline.
      const header = /^[\r\n]*Content-Length:\s*(\d+)\r?\n(?:[^\r\n]+\r?\n)*\r?\n/i.exec(this.buffer)
      if (header) {
        const bodyStart = header[0].length
        const byteLength = Number(header[1])
        const bytes = Buffer.from(this.buffer.slice(bodyStart), 'utf8')
        if (bytes.length < byteLength) break
        const body = bytes.subarray(0, byteLength).toString('utf8')
        this.buffer = bytes.subarray(byteLength).toString('utf8')
        try {
          messages.push(JSON.parse(body))
        } catch {
          // an unparsable framed body is skipped, not fatal
        }
        continue
      }
      const index = this.buffer.indexOf('\n')
      if (index === -1) break
      const line = this.buffer.slice(0, index).replace(/\r$/, '').trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line.startsWith('{')) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        // a non-message line that merely looks like JSON is skipped
      }
    }
    return messages
  }
}

/**
 * The stable daemon log path. Plain-JS mirror of lib/log-path.ts
 * resolveLogPath (this file must not import TS sources): BGOS_LOG_FILE wins,
 * else <home>/.bgos-agent/logs/bgos-plugin-<assistantId|unknown>.log.
 */
export function doctorLogPath({ env = {}, home = homedir(), assistantId = '' } = {}) {
  const override = String(env?.BGOS_LOG_FILE ?? '').trim()
  if (override) return override
  const id = String(assistantId ?? '').trim() || 'unknown'
  return join(home, '.bgos-agent', 'logs', `bgos-plugin-${id}.log`)
}

/** Read the launch-folder identity pin (<dir>/.bgos-agent-id): a numeric id
 *  or '' when absent or junk. Mirrors server.ts's folder-pin resolution. */
export function readFolderPin(dir, read = (p) => readFileSync(p, 'utf8')) {
  try {
    const value = String(read(join(String(dir ?? ''), FOLDER_PIN_FILE_NAME))).trim()
    return /^\d+$/.test(value) ? value : ''
  } catch {
    return ''
  }
}

/**
 * Turn raw probe results into the ordered diagnostic rows. Pure: everything
 * it needs rides in `probes`. ok:null means the probe did not run (rendered
 * SKIP); every ok:false row carries the single fix command for that failure.
 * @param {{
 *   platform?: string,
 *   claude: { found: boolean, version?: string, path?: string },
 *   auth: { ok: boolean, loggedIn?: boolean, authMethod?: string, subscriptionType?: string, error?: string },
 *   node: { found: boolean, version?: string },
 *   bun: { found: boolean, path?: string, via?: string },
 *   bunx: { found: boolean, path?: string },
 *   method: { method: string, channelSpec: string, pluginRoot: string } | null,
 *   credentials: { path?: string, exists: boolean, assistantId?: string | number, expectedAssistantId?: string },
 *   handshake: { ok: boolean, detail?: string, command?: string } | null,
 *   mcpList: { ok: boolean, state?: string, raw?: string } | null,
 *   backend: { ok: boolean, status?: number, url: string, error?: string },
 *   logPath: string,
 * }} probes
 * @returns {Array<{ id: string, label: string, ok: boolean | null, detail: string, fix: string }>}
 */
export function buildDoctorRows(probes) {
  const p = probes ?? {}
  const platform = p.platform ?? process.platform
  const rows = []
  const row = (id, label, ok, detail, fix = '') =>
    rows.push({ id, label, ok, detail: oneLine(detail), fix: oneLine(fix) })

  // claude CLI
  const claude = p.claude ?? { found: false }
  if (claude.found) {
    row('claude', 'Claude Code CLI', true, [claude.version, claude.path && `at ${claude.path}`].filter(Boolean).join(' '))
  } else {
    row('claude', 'Claude Code CLI', false, 'claude was not found on this machine', claudeInstallHint(platform))
  }

  // claude auth
  const auth = p.auth ?? { ok: false }
  if (!auth.ok) {
    row(
      'auth',
      'Claude authentication',
      false,
      auth.error || 'could not read claude auth status',
      'claude auth login (run it in a visible terminal)',
    )
  } else if (!auth.loggedIn) {
    row('auth', 'Claude authentication', false, 'not logged in', 'claude auth login (run it in a visible terminal)')
  } else if (!isSubscriptionAuth(auth.authMethod)) {
    row(
      'auth',
      'Claude authentication',
      false,
      `logged in via ${auth.authMethod || 'an unknown method'}, not the claude.ai subscription; API-key auth silently drops inbound channel messages`,
      'claude /login (switch to claude.ai subscription auth)',
    )
  } else {
    row(
      'auth',
      'Claude authentication',
      true,
      `logged in via ${auth.authMethod}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ''}`,
    )
  }

  // node
  const node = p.node ?? { found: false }
  row(
    'node',
    'Node.js',
    Boolean(node.found),
    node.found ? node.version ?? '' : 'not found',
    node.found ? '' : 'install Node.js 18 or newer from https://nodejs.org',
  )

  // bun / bunx
  const bun = p.bun ?? { found: false }
  const bunFix = `${bunInstallHint(platform)} (then ensure BOTH bun and bunx are on PATH)`
  if (bun.found) {
    row('bun', 'Bun runtime', true, `${bun.path ?? ''}${bun.via ? ` (via ${bun.via})` : ''}`)
  } else {
    row('bun', 'Bun runtime', false, 'bun was not found (checked BUN_INSTALL, ~/.bun/bin, PATH)', bunFix)
  }
  const bunx = p.bunx ?? { found: false }
  if (bunx.found) {
    row('bunx', 'bunx', true, bunx.path ?? '')
  } else {
    row('bunx', 'bunx', false, 'bunx was not found (checked BUN_INSTALL, ~/.bun/bin, PATH)', bunFix)
  }

  // install method
  const method = p.method ?? null
  if (method) {
    row('method', 'Install method', true, `${method.method} install, channel ${method.channelSpec}, root ${method.pluginRoot}`)
  } else {
    row('method', 'Install method', null, '')
  }

  // pairing credentials (path + assistant id only; never the token)
  const creds = p.credentials ?? { exists: false }
  const expected = String(creds.expectedAssistantId ?? '').trim()
  const actual = String(creds.assistantId ?? '').trim()
  if (!creds.exists) {
    row(
      'credentials',
      'Pairing credentials',
      false,
      `no credentials file at ${creds.path ?? 'the default location'}`,
      'hoai pair <code from the HOAI app>',
    )
  } else if (expected && actual !== expected) {
    row(
      'credentials',
      'Pairing credentials',
      false,
      `${creds.path} holds assistant ${actual || 'none'}, expected ${expected}`,
      `hoai pair <code from the HOAI app> --assistant-id ${expected}`,
    )
  } else {
    row('credentials', 'Pairing credentials', true, `${creds.path}${actual ? ` (assistant ${actual})` : ''}`)
  }

  // MCP initialize handshake
  const handshake = p.handshake ?? null
  if (!handshake) {
    row('handshake', 'MCP handshake (initialize)', null, 'skipped')
  } else if (handshake.ok) {
    row('handshake', 'MCP handshake (initialize)', true, handshake.detail ?? 'server answered initialize')
  } else {
    const command = String(handshake.command ?? '').trim()
    row(
      'handshake',
      'MCP handshake (initialize)',
      false,
      handshake.detail ?? 'no initialize response',
      `${command ? `${command}; then ` : ''}run hoai doctor again after fixing the row above`,
    )
  }

  // claude mcp list
  const mcpList = p.mcpList ?? null
  if (!mcpList) {
    row('mcp-list', 'claude mcp list', null, 'skipped')
  } else if (mcpList.ok) {
    row('mcp-list', 'claude mcp list', true, mcpList.raw ?? 'Connected')
  } else {
    row(
      'mcp-list',
      'claude mcp list',
      false,
      mcpList.raw ?? `state: ${mcpList.state ?? 'unknown'}`,
      launchCommand(method?.method === 'marketplace' ? 'marketplace' : 'clone'),
    )
  }

  // backend reachability
  const backend = p.backend ?? { ok: false, url: '' }
  if (backend.ok) {
    row('backend', 'HOAI backend', true, `HTTP ${backend.status} from ${backend.url}`)
  } else {
    row(
      'backend',
      'HOAI backend',
      false,
      backend.error ? `${backend.url}: ${backend.error}` : `HTTP ${backend.status ?? '?'} from ${backend.url}`,
      "check this computer's internet connection",
    )
  }

  // daemon log path (always ok; the path IS the information)
  row('log', 'Daemon log', true, String(p.logPath ?? ''))

  // Channel liveness (fix 09): has this install EVER proven it can hear a
  // channel event (the marker the first tool call of a boot writes)? Not a
  // hard failure when absent (a machine that has not launched yet is not
  // broken), but the one row that separates "Connected" from "actually
  // hearing", so it renders WARN with the exact next action.
  if (p.liveMarker !== undefined) {
    const marker = p.liveMarker
    if (marker && marker.exists) {
      const age = Number(marker.ageMs)
      const ageText = Number.isFinite(age)
        ? `last proven ${Math.max(0, Math.round(age / 60_000))} min ago`
        : 'proven'
      row('live', 'Channel liveness', true, `the session has acted on a channel event (${ageText})`)
    } else {
      row(
        'live',
        'Channel liveness',
        null,
        'never proven: no session has acted on a channel event yet',
        'launch the agent (open its folder, run: hoai) and wait for its hello; if it never arrives, the channel launch flag is wrong (see the Install method row)',
      )
    }
  }

  return rows
}

/** Collapse whitespace runs and newlines so a detail stays one table cell. */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Render rows as an aligned monospace table (STATUS / CHECK / DETAIL), then
 * one Fix line per failing row, in order. Plain spaces and dashes only: no
 * box-drawing characters, which mangle in some Windows terminals.
 */
export function renderDoctorTable(rows) {
  const statusOf = (ok) => (ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP')
  const data = (rows ?? []).map((r) => ({
    status: statusOf(r.ok),
    check: String(r.label ?? r.id ?? ''),
    detail: String(r.detail ?? '') || '-',
    row: r,
  }))
  const statusWidth = Math.max(6, ...data.map((d) => d.status.length))
  const checkWidth = Math.max(5, ...data.map((d) => d.check.length))
  const lines = []
  lines.push(`${'STATUS'.padEnd(statusWidth)}  ${'CHECK'.padEnd(checkWidth)}  DETAIL`)
  lines.push(`${'-'.repeat(statusWidth)}  ${'-'.repeat(checkWidth)}  ${'-'.repeat(6)}`)
  for (const d of data) {
    lines.push(`${d.status.padEnd(statusWidth)}  ${d.check.padEnd(checkWidth)}  ${d.detail}`.trimEnd())
  }
  const failing = data.filter((d) => d.row.ok === false && String(d.row.fix ?? '').trim())
  if (failing.length > 0) {
    lines.push('')
    for (const d of failing) {
      lines.push(`Fix (${d.check}): ${d.row.fix}`)
    }
  }
  return lines.join('\n')
}

/**
 * The preflight gate (fix 03): ok only when claude, auth, the initialize
 * handshake, and `claude mcp list` are ALL ok:true AND no other row failed.
 * Exception: a failed backend row is exempt when handshake AND mcp list both
 * passed (live MCP traffic implies reachability; the row still reports).
 * @param {Array<{ id: string, ok: boolean | null }>} rows
 * @returns {{ ok: boolean, failing: string[] }}
 */
export function preflightVerdict(rows) {
  const required = ['claude', 'auth', 'handshake', 'mcp-list']
  const byId = new Map((rows ?? []).map((r) => [r.id, r]))
  const failing = []
  for (const id of required) {
    if (byId.get(id)?.ok !== true) failing.push(id)
  }
  const proven = byId.get('handshake')?.ok === true && byId.get('mcp-list')?.ok === true
  for (const r of rows ?? []) {
    if (required.includes(r.id)) continue
    if (r.ok === false && !(r.id === 'backend' && proven)) failing.push(r.id)
  }
  return { ok: failing.length === 0, failing }
}

// -- Effectful probes ---------------------------------------------------------

const SPAWN_OPTS = { shell: false, encoding: 'utf8', windowsHide: true, timeout: 30_000 }

/**
 * Find a runnable claude CLI. shell:false throughout; on win32 the .exe and
 * .cmd names are tried too (node cannot spawn a .cmd without a shell since
 * 18.20, so that shape falls through to an explicit cmd.exe /c resolution,
 * which is still a direct exe spawn from node's point of view).
 */
export function probeClaude({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  const names = platform === 'win32' ? ['claude', 'claude.exe', 'claude.cmd'] : ['claude']
  for (const name of names) {
    let res
    try {
      res = spawnSyncImpl(name, ['--version'], SPAWN_OPTS)
    } catch {
      continue
    }
    if (res && res.status === 0 && String(res.stdout ?? '').trim()) {
      return { found: true, version: firstLine(res.stdout), command: name, path: whichClaude(name, platform, spawnSyncImpl) }
    }
  }
  if (platform === 'win32') {
    try {
      const res = spawnSyncImpl('cmd.exe', ['/d', '/s', '/c', 'claude --version'], SPAWN_OPTS)
      if (res && res.status === 0 && String(res.stdout ?? '').trim()) {
        return {
          found: true,
          version: firstLine(res.stdout),
          command: 'claude',
          viaCmdShell: true,
          path: whichClaude('claude', platform, spawnSyncImpl),
        }
      }
    } catch {
      // fall through to not found
    }
  }
  return { found: false }
}

/** Best-effort absolute path of the claude executable ('' when unknown). */
function whichClaude(name, platform, spawnSyncImpl) {
  try {
    const res =
      platform === 'win32'
        ? spawnSyncImpl('cmd.exe', ['/d', '/s', '/c', `where ${name}`], SPAWN_OPTS)
        : spawnSyncImpl('sh', ['-c', `command -v ${name}`], SPAWN_OPTS)
    if (res && res.status === 0) return firstLine(res.stdout)
  } catch {
    // path is a nicety, never a failure
  }
  return ''
}

/**
 * Read `claude auth status`. ok means the status was READ; loggedIn and
 * authMethod say what it held. Secrets and PII from the output (email, org)
 * are never surfaced; only the three fields the row needs.
 */
export function probeAuth({ claude = { command: 'claude' }, spawnSyncImpl = spawnSync } = {}) {
  let res
  try {
    res = claude.viaCmdShell
      ? spawnSyncImpl('cmd.exe', ['/d', '/s', '/c', 'claude auth status'], SPAWN_OPTS)
      : spawnSyncImpl(claude.command ?? 'claude', ['auth', 'status'], SPAWN_OPTS)
  } catch (err) {
    return { ok: false, error: `could not run claude auth status: ${err?.message ?? err}` }
  }
  if (!res || res.error) {
    return { ok: false, error: `could not run claude auth status: ${res?.error?.message ?? 'unknown error'}` }
  }
  const parsed = parseAuthStatusOutput(`${res.stdout ?? ''}\n${res.stderr ?? ''}`)
  if (!parsed) {
    return { ok: false, error: `claude auth status output did not parse (exit ${res.status})` }
  }
  return { ok: true, ...parsed }
}

/** This process IS node, so the probe is a formality kept for the table. */
export function probeNode() {
  return { found: true, version: process.version }
}

/**
 * bun and bunx, probed separately: the launch shim can limp along on bunx,
 * but `claude mcp list` and the packaged plugin want both on PATH, so the
 * table shows each on its own row.
 */
export function probeBunAndBunx({ env = process.env, home = homedir(), platform = process.platform, exists = existsSync } = {}) {
  const resolved = resolveBunPath({ env, home, platform, exists })
  const bunItself = Boolean(resolved && !String(resolved.via).startsWith('bunx'))
  const bun = bunItself ? { found: true, path: resolved.path, via: resolved.via } : { found: false }
  const p = pathFlavor(platform)
  const dirs = []
  const bunInstall = String(env.BUN_INSTALL ?? '').trim()
  if (bunInstall) dirs.push(p.join(bunInstall, 'bin'))
  const homeDir = String(home ?? '').trim()
  if (homeDir) dirs.push(p.join(homeDir, '.bun', 'bin'))
  for (const entry of String(env.PATH ?? '').split(p.delimiter)) {
    const dir = entry.trim()
    if (dir) dirs.push(dir)
  }
  for (const dir of dirs) {
    for (const name of executableNames('bunx', platform)) {
      const candidate = p.join(dir, name)
      if (exists(candidate)) return { bun, bunx: { found: true, path: candidate } }
    }
  }
  return { bun, bunx: { found: false } }
}

/** Where and how this plugin is installed (decides the channel spec). */
export function probeMethod({ scriptPath = fileURLToPath(import.meta.url), env = process.env } = {}) {
  return detectInstallMethod({ scriptPath, env })
}

/**
 * The credentials file the daemon would read for this identity, and whether
 * it matches the expected assistant. Path and assistant id only, no token.
 */
export function probeCredentials({ env = process.env, home = homedir(), expectedAssistantId = '' } = {}) {
  const expected = String(expectedAssistantId ?? '').trim()
  const readEnv = { ...env }
  if (expected) readEnv.BGOS_ASSISTANT_ID = expected
  const path = resolveReadCredentialsPath({ env: readEnv, home })
  const result = { path, exists: existsSync(path) }
  if (expected) result.expectedAssistantId = expected
  if (result.exists) {
    try {
      const creds = JSON.parse(readFileSync(path, 'utf8'))
      if (creds && creds.assistantId != null) result.assistantId = creds.assistantId
    } catch {
      // unreadable file still reports exists:true; the handshake will judge it
    }
  }
  return result
}

/**
 * The real thing: spawn the server through the launch shim, speak MCP over
 * its stdio, and require an initialize result carrying serverInfo within
 * timeoutMs. The child is always killed afterwards. The exact command tried
 * rides back in `command` so the fix line can name it.
 * @param {{ launchArgv: string[], env?: Record<string, string | undefined>, cwd?: string,
 *           timeoutMs?: number, spawnImpl?: typeof spawn, nodePath?: string }} opts
 * @returns {Promise<{ ok: boolean, detail: string, command: string }>}
 */
export function probeHandshake({
  launchArgv,
  env = process.env,
  cwd,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  spawnImpl = spawn,
  nodePath = process.execPath,
} = {}) {
  const command = [nodePath, ...(launchArgv ?? [])].map(quoteArg).join(' ')
  return new Promise((resolve) => {
    let settled = false
    let child = null
    const stderrChunks = []
    const stderrTail = () => {
      const text = stderrChunks.join('').trim()
      if (!text) return ''
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      return `; stderr: ${lines.slice(-3).join(' | ')}`
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        // already gone
      }
      resolve({ ...result, command })
    }
    const timer = setTimeout(
      () => finish({ ok: false, detail: `no initialize response within ${timeoutMs}ms${stderrTail()}` }),
      timeoutMs,
    )
    try {
      child = spawnImpl(nodePath, launchArgv, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      finish({ ok: false, detail: `could not spawn the server: ${err?.message ?? err}` })
      return
    }
    child.on('error', (err) => finish({ ok: false, detail: `could not spawn the server: ${err?.message ?? err}` }))
    const parser = new McpFrameParser()
    child.stdout.on('data', (chunk) => {
      for (const message of parser.feed(chunk)) {
        if (!message || message.id !== 1) continue
        if (message.result && message.result.serverInfo) {
          const info = message.result.serverInfo
          finish({ ok: true, detail: `server ${info.name ?? 'unknown'} ${info.version ?? ''} answered initialize`.replace(/\s+/g, ' ').trim() })
        } else if (message.result) {
          finish({ ok: false, detail: 'initialize result arrived without serverInfo' })
        } else if (message.error) {
          finish({ ok: false, detail: `initialize error: ${message.error.message ?? JSON.stringify(message.error)}` })
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(String(chunk))
      while (stderrChunks.length > 1 && stderrChunks.join('').length > 4000) stderrChunks.shift()
    })
    child.on('exit', (code, signal) => {
      finish({
        ok: false,
        detail: `server exited (${signal ? `signal ${signal}` : `code ${code}`}) before answering initialize${stderrTail()}`,
      })
    })
    child.stdin.on('error', () => {
      // EPIPE from a child that died first; the exit handler reports it
    })
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bgos-doctor', version: '1.0.0' },
      },
    }
    try {
      child.stdin.write(encodeJsonRpcMessage(request))
    } catch {
      // the error/exit handlers will report the death
    }
  })
}

/** Quote one argv element for display (the fix line must be pastable). */
function quoteArg(arg) {
  const value = String(arg ?? '')
  return /\s/.test(value) ? `"${value}"` : value
}

/** Run `claude mcp list` (CI-safe env, no colors) and classify our row. */
export function probeMcpList({
  cwd,
  claude = { command: 'claude' },
  serverNames = MCP_SERVER_NAMES,
  spawnSyncImpl = spawnSync,
  timeoutMs = 120_000,
} = {}) {
  const opts = {
    ...SPAWN_OPTS,
    timeout: timeoutMs,
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  }
  let res
  try {
    res = claude.viaCmdShell
      ? spawnSyncImpl('cmd.exe', ['/d', '/s', '/c', 'claude mcp list'], opts)
      : spawnSyncImpl(claude.command ?? 'claude', ['mcp', 'list'], opts)
  } catch (err) {
    return { ok: false, state: 'unknown', raw: `could not run claude mcp list: ${err?.message ?? err}` }
  }
  if (!res || res.error) {
    return { ok: false, state: 'unknown', raw: `could not run claude mcp list: ${res?.error?.message ?? 'unknown error'}` }
  }
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  const parsed = parseMcpListOutput(text, serverNames)
  if (!parsed.found) {
    return { ok: false, state: 'missing', raw: `no ${serverNames.join(' / ')} row in claude mcp list output` }
  }
  return { ok: parsed.state === 'connected', state: parsed.state, raw: oneLine(parsed.line ?? '') }
}

/** GET <base>/service-options/health with a 10s abort. */
export async function probeBackend(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const target = `${String(url ?? '').replace(/\/+$/, '')}/service-options/health`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(target, { signal: controller.signal, headers: { Accept: 'application/json' } })
    return { ok: res.ok, status: res.status, url: target }
  } catch (err) {
    return { ok: false, status: 0, url: target, error: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/** First non-empty line of a text blob, trimmed. */
function firstLine(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

// -- CLI ----------------------------------------------------------------------

export const USAGE = `bgos-doctor: diagnose this machine's HOAI agent setup

Usage:
  node bin/bgos-doctor.mjs [options]

Options:
  --preflight            exit 0 only when the claude CLI, auth, the MCP
                         initialize handshake, and claude mcp list are all
                         green (the setup success gate)
  --assistant-id <n>     the HOAI assistant this machine should serve; checked
                         against the credentials file and pinned into the
                         handshake environment
  --workdir <dir>        working directory for claude mcp list and the
                         launch-folder identity pin (default: cwd)
  --backend <url>        backend base (default ${DEFAULT_BACKEND_URL})
  --json                 print the rows as JSON instead of the table
  --skip-handshake       skip the live MCP initialize handshake (fast mode)
  --wait-live-since <ms> wait-only mode: poll for the channel-live marker to
                         be touched at or after this epoch-ms instant (the
                         bootstrap passes its launch time), exit 0 on proof
  --wait-live-timeout <s> how long the wait-only mode polls (default 120)
  -h, --help             show this help
`

// ── Channel-live marker (fix 09) ─────────────────────────────────────────────
// The daemon writes <state dir>/channel-live.json on the first tool call of
// every boot: positive, on-disk proof the session HEARS channel events.
// `claude mcp list` saying Connected cannot prove that (a wrong launch flag
// loads tools, connects, and wires no inbound; Vulcan E2E 2026-08-22), so the
// bootstrap's final step waits for this marker instead of trusting Connected.

/** Mirror of lib/cursor-store.ts resolveCursorFilePath's directory rule, in
 *  plain JS: BGOS_PLUGIN_STATE_DIR else ~/.bgos-plugin-state, keyed by the
 *  assistant id (digits) else a cwd hash. */
export function liveMarkerPathFor({ env = process.env, home = homedir(), assistantId = '', cwd = process.cwd() } = {}) {
  const root = String(env.BGOS_PLUGIN_STATE_DIR ?? '').trim() || join(home, '.bgos-plugin-state')
  const raw = String(assistantId ?? '').trim()
  const key = /^[A-Za-z0-9_-]{1,64}$/.test(raw)
    ? raw
    : `cwd-${createHash('sha256').update(String(cwd)).digest('hex').slice(0, 16)}`
  return join(root, key, 'channel-live.json')
}

/**
 * Poll for the marker to be touched at or after `sinceMs`. Injectable clock,
 * stat, and sleep so tests never actually wait.
 * @param {{ path: string, sinceMs: number, timeoutMs?: number, pollMs?: number,
 *           statImpl?: (path: string) => { mtimeMs: number },
 *           now?: () => number, sleep?: (ms: number) => Promise<unknown>,
 *           onTick?: (mtimeMs: number | null) => void }} opts
 * @returns {Promise<{ ok: boolean, mtimeMs: number | null }>}
 */
export async function waitForLiveMarker({
  path,
  sinceMs,
  timeoutMs = 120_000,
  pollMs = 2_000,
  statImpl = statSync,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onTick = () => {},
} = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    let mtimeMs = null
    try {
      mtimeMs = statImpl(path).mtimeMs
    } catch {
      mtimeMs = null
    }
    if (mtimeMs != null && mtimeMs >= sinceMs) return { ok: true, mtimeMs }
    if (now() >= deadline) return { ok: false, mtimeMs }
    onTick(mtimeMs)
    await sleep(pollMs)
  }
}

export function parseDoctorArgs(argv) {
  const args = {
    preflight: false,
    assistantId: '',
    workdir: '',
    backend: DEFAULT_BACKEND_URL,
    json: false,
    skipHandshake: false,
    help: false,
    waitLiveSince: null,
    waitLiveTimeoutS: 120,
  }
  const errors = []
  for (let i = 0; i < (argv ?? []).length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--preflight') args.preflight = true
    else if (arg === '--json') args.json = true
    else if (arg === '--skip-handshake') args.skipHandshake = true
    else if (arg === '--assistant-id') {
      const value = argv[++i]
      if (!value) errors.push(`${arg} needs a value`)
      else args.assistantId = String(value).trim()
    } else if (arg === '--workdir') {
      const value = argv[++i]
      if (!value) errors.push(`${arg} needs a value`)
      else args.workdir = String(value).trim()
    } else if (arg === '--backend') {
      const value = argv[++i]
      if (!value) errors.push(`${arg} needs a value`)
      else args.backend = normalizeApiBase(value)
    } else if (arg === '--wait-live-since') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value <= 0) errors.push(`${arg} needs an epoch-ms value`)
      else args.waitLiveSince = value
    } else if (arg === '--wait-live-timeout') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value <= 0) errors.push(`${arg} needs a positive seconds value`)
      else args.waitLiveTimeoutS = value
    } else errors.push(`unknown flag: ${arg}`)
  }
  return { args, errors }
}

/**
 * Run every probe, print the table (or JSON), and return the exit code:
 * always 0 in report mode, the preflight verdict under --preflight.
 * @param {string[]} [argv]
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: string }} [opts]
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const { args, errors } = parseDoctorArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[bgos-doctor] ${error}`)
    process.stdout.write(USAGE)
    return 1
  }

  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  const workdir = args.workdir || process.cwd()

  // Wait-only mode (the bootstrap's final gate): poll for the channel-live
  // marker to be touched after the launch instant. Positive proof the
  // just-launched session heard a channel event and ACTED (the boot hello's
  // reply). Everything else is skipped; this mode is called right after the
  // full preflight already ran.
  if (args.waitLiveSince != null) {
    const markerAssistantId =
      args.assistantId || String(env.BGOS_ASSISTANT_ID ?? '').trim() || readFolderPin(workdir)
    const markerPath = liveMarkerPathFor({ env, home, assistantId: markerAssistantId, cwd: workdir })
    console.log(
      `[bgos-doctor] waiting up to ${args.waitLiveTimeoutS}s for the agent's first reply ` +
        `(channel-live marker at ${markerPath})...`,
    )
    const waited = await waitForLiveMarker({
      path: markerPath,
      sinceMs: args.waitLiveSince,
      timeoutMs: args.waitLiveTimeoutS * 1000,
    })
    if (waited.ok) {
      console.log('[bgos-doctor] channel proven live: the session acted on a channel event.')
      return 0
    }
    console.error(
      waited.mtimeMs == null
        ? '[bgos-doctor] the agent never proved it can hear the channel (no live marker appeared). ' +
            'The usual cause is a wrong channel launch flag; run the full doctor for the exact command.'
        : '[bgos-doctor] a live marker exists but predates this launch; the NEW session has not proven itself. ' +
            'Give it a moment or run the full doctor.',
    )
    return 1
  }

  const claude = probeClaude({ platform })
  const auth = claude.found
    ? probeAuth({ claude })
    : { ok: false, error: 'the claude CLI was not found, so auth was not checked' }
  const node = probeNode()
  const { bun, bunx } = probeBunAndBunx({ env, home, platform })
  const method = probeMethod()

  // Identity, strongest evidence first: the explicit flag, the env var, the
  // launch-folder pin. It scopes the credentials row, the handshake env, and
  // the log path, exactly as the daemon itself would resolve it.
  const assistantId =
    args.assistantId || String(env.BGOS_ASSISTANT_ID ?? '').trim() || readFolderPin(workdir)
  const credentials = probeCredentials({ env, home, expectedAssistantId: assistantId })

  let handshake = null
  if (!args.skipHandshake) {
    const launchArgv = [join(method.pluginRoot, 'bin', 'bgos-launch.mjs'), join(method.pluginRoot, 'server.ts')]
    const handshakeEnv = { ...process.env }
    if (assistantId) handshakeEnv.BGOS_ASSISTANT_ID = assistantId
    handshake = await probeHandshake({ launchArgv, env: handshakeEnv, cwd: workdir })
  }

  const mcpList = claude.found ? probeMcpList({ cwd: workdir, claude }) : null
  const backend = await probeBackend(args.backend)
  const logPath = doctorLogPath({
    env,
    home,
    assistantId: assistantId || String(credentials.assistantId ?? ''),
  })
  const markerPath = liveMarkerPathFor({
    env,
    home,
    assistantId: assistantId || String(credentials.assistantId ?? ''),
    cwd: workdir,
  })
  let liveMarker = { exists: false, ageMs: null }
  try {
    const markerStat = statSync(markerPath)
    liveMarker = { exists: true, ageMs: Date.now() - markerStat.mtimeMs }
  } catch {
    // stays not-proven
  }

  const rows = buildDoctorRows({
    platform,
    claude,
    auth,
    node,
    bun,
    bunx,
    method,
    credentials,
    handshake,
    mcpList,
    backend,
    logPath,
    liveMarker,
  })

  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderDoctorTable(rows)}\n`)
  }

  if (args.preflight) {
    const verdict = preflightVerdict(rows)
    if (!verdict.ok) {
      console.error(`[bgos-doctor] preflight FAILED: ${verdict.failing.join(', ')}`)
      return 1
    }
    console.log('[bgos-doctor] preflight passed: initialize handshake and claude mcp list are both green.')
  }
  return 0
}

/**
 * True when this file is the process entry point. Compares REAL paths on both
 * sides so a symlinked bin (npm/npx puts a shim in node_modules/.bin, and paths
 * under /tmp resolve through /private/tmp on macOS) still runs main(); a plain
 * href compare would fail those and silently do nothing.
 */
export function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`[bgos-doctor] fatal: ${err?.message ?? err}`)
      process.exitCode = 1
    })
}
