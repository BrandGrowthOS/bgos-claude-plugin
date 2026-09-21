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
 * channel spec), the channel route, the four LAUNCH rows (folder trust, the
 * bypass prompt, the startup-gate strategy, an incumbent session), the
 * pairing credentials file, a REAL MCP initialize handshake against the
 * server via the launch shim, `claude mcp list` reading Connected, backend
 * reachability, and the daemon log path.
 *
 * WHY THE LAUNCH ROWS EXIST (2026-09-21). A real machine printed 12 PASS and
 * 1 SKIP while EVERY `hoai` invocation exited instantly: every row validated
 * the CHANNEL and not one validated the LAUNCH. A folder Claude Code does not
 * trust, an unsuppressed bypass warning whose default answer is exit, a
 * relaunch that needs the expect wrapper on a host with no expect, and a
 * claude already holding the cwd all stop a launch dead while every channel
 * row stays green. Each is one cheap read and each can FAIL.
 *
 * --preflight makes the exit code the verdict: 0 only when the claude CLI,
 * auth, the initialize handshake, and `claude mcp list` are ALL green and
 * nothing else failed (backend reachability is implied by a live handshake
 * and is reported but exempted then; the startup-gate and incumbent rows
 * report without gating, see ADVISORY_ROW_IDS).
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
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { resolveBunPath, bunInstallHint, executableNames, pathFlavor } from './bgos-launch.mjs'
import { claudeConfigDir, detectInstallMethod, launchCommandFor } from './bgos-install-method.mjs'
import {
  defaultListProcesses,
  findIncumbentClaude,
  incumbentBlocks,
  relaunchNeedsGateAutoAccept,
  resolveChannelSpec,
  selfAndAncestorPids,
} from './hoai-core.mjs'
import { alternateSlashSpelling, claudeConfigFilePath } from '../lib/claude-preseed.mjs'
import { observeMarketplaceInstall } from '../lib/plugin-cli.mjs'
import { mcpServerEntries, parseMcpChannelServerName } from '../lib/service-supervision.mjs'
import {
  resolveReadCredentialsPath,
  normalizeApiBase,
  FOLDER_PIN_FILE_NAME,
  launchFolderLiveSafe,
  perAssistantCredentialsPath,
} from './bgos-pair.mjs'

export const DEFAULT_BACKEND_URL = 'https://api.brandgrowthos.ai/api/v1'
/** The MCP server names `claude mcp list` may print for this plugin. */
export const MCP_SERVER_NAMES = Object.freeze(['bgos', 'plugin:hoai:bgos'])
export const HANDSHAKE_TIMEOUT_MS = 60_000

/**
 * The fourth row status, beside PASS / FAIL / SKIP.
 *
 * WHY IT IS NOT SKIP (2026-09-21). The one honest row in the 12-PASS report
 * that started this fix read SKIP: "Channel liveness: never proven". A reader
 * takes SKIP to mean "not applicable on this machine" and moves on, so the
 * single row that was telling the truth about a dead install was the one it
 * read past. UNPROVEN says the other thing: the check APPLIES, it simply has
 * no evidence yet. SKIP keeps its exact old meaning, a probe that genuinely
 * did not run or does not apply here.
 *
 * It is deliberately not a boolean: like ok:null it is neither a pass nor a
 * failure, so preflightVerdict treats it exactly as ok:null and an unproven
 * row can never fail the bootstrap gate.
 */
export const UNPROVEN = 'unproven'

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
 * The install command for `expect`, by platform. Named per platform because a
 * fix line a user cannot paste is not a fix line.
 * @param {string} platform
 * @returns {string}
 */
export function expectInstallHint(platform) {
  return platform === 'darwin' ? 'brew install expect' : 'sudo apt install expect'
}

/**
 * The absolute paths hoai-core's own expect detection probes, in its order.
 * Mirrored (not imported: it is private there) so the doctor cannot report an
 * availability the launcher does not see.
 */
export const EXPECT_PROBE_PATHS = Object.freeze([
  '/usr/bin/expect',
  '/opt/homebrew/bin/expect',
  '/usr/local/bin/expect',
  '/bin/expect',
])

/** Join dir + name preserving the directory's separator style, so a win32
 *  config dir stays win32 on a posix host. The doctor must name the SAME file
 *  lib/claude-preseed.mjs writes, and node's join would re-spell it. */
function joinPreservingStyle(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/**
 * Turn raw probe results into the ordered diagnostic rows. Pure: everything
 * it needs rides in `probes`. ok:true renders PASS, ok:false FAIL, the string
 * UNPROVEN renders UNPROVEN (the check applies and has no evidence yet), and
 * ok:null means the probe did not run or does not apply (rendered SKIP); every
 * ok:false row carries the single fix command for that failure. The four
 * launch probes (trust, bypass, gate, incumbent) and liveMarker are optional:
 * an absent key emits no row at all, so an older caller keeps its old table.
 * @param {{
 *   platform?: string,
 *   claude: { found: boolean, version?: string, path?: string },
 *   auth: { ok: boolean, loggedIn?: boolean, authMethod?: string, subscriptionType?: string, error?: string },
 *   node: { found: boolean, version?: string },
 *   bun: { found: boolean, path?: string, via?: string },
 *   bunx: { found: boolean, path?: string },
 *   method: { method: string, channelSpec: string, pluginRoot: string } | null,
 *   trust?: { cwd: string, configPath: string, accepted: boolean, reason: string, matchedKey?: string, inheritedFrom?: string, error?: string },
 *   launchFolder?: { dir: string, source: 'flag' | 'cwd-pin' | 'default-workspace' | 'cwd-unpinned' },
 *   bypass?: { settingsPath: string, accepted: boolean, reason: string },
 *   gate?: { needed: boolean, method?: string, helper: 'expect' | 'win32-console', expectPath?: string },
 *   incumbent?: { cwd: string, hit: { pid: number, reason: string } | null, blocks: boolean, error?: string },
 *   credentials: { path?: string, exists: boolean, assistantId?: string | number, expectedAssistantId?: string },
 *   handshake: { ok: boolean, detail?: string, command?: string } | null,
 *   mcpList: { ok: boolean, state?: string, raw?: string } | null,
 *   backend: { ok: boolean, status?: number, url: string, error?: string },
 *   logPath: string,
 * }} probes
 * @returns {Array<{ id: string, label: string, ok: boolean | null | 'unproven', detail: string, fix: string }>}
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
  //
  // UNDETERMINED is a FAIL row, not a PASS with a hedge. On 2026-08-24 a real
  // user's doctor run printed "PASS Install method clone install, channel
  // server:bgos" one line above "claude mcp list ... /.claude/plugins/cache/
  // .../server.ts - Connected": the two lines contradicted each other and the
  // green tick was the one that lied, because doctor had been reached through
  // npx and the old detector read its temp directory as a checkout.
  const method = p.method ?? null
  if (!method) {
    row('method', 'Install method', null, '')
  } else if (method.method === 'unknown') {
    row(
      'method',
      'Install method',
      false,
      String(method.reason ?? '').trim() ||
        'the install method could not be determined, so no channel spec is known',
      'run hoai from the folder the agent was set up in (not through npx), or run hoai setup <code from the HOAI app> to install the plugin properly',
    )
  } else {
    row('method', 'Install method', true, `${method.method} install, channel ${method.channelSpec}, root ${method.pluginRoot}`)
  }

  // channel route
  //
  // The Install method row names ONE install. The launcher does not launch on
  // the install method when the workspace .mcp.json declares a server named
  // bgos: that route wins (hoai-core resolveChannelSpec). A host with a folder
  // clone AND a marketplace install therefore has two registered routes, one
  // live and one deaf, and a doctor that printed only the install method could
  // name the deaf one. This row names both and says which carries traffic.
  const route = p.route ?? null
  const installKnown = Boolean(method && method.method !== 'unknown')
  const installSpec = installKnown ? String(method.channelSpec ?? '').trim() : ''
  if (!route) {
    row('route', 'Channel route', null, '')
  } else if (route.conflict) {
    row(
      'route',
      'Channel route',
      false,
      'the .mcp.json in this folder declares more than one HOAI server, so the launcher cannot tell which route is meant',
      'keep exactly one HOAI server entry in .mcp.json (the one named bgos) and remove the others',
    )
  } else if (route.source === 'workspace') {
    const ws = `workspace .mcp.json server ${route.serverName} (${route.spec})`
    if (!installSpec) {
      row('route', 'Channel route', true, `${ws} is the route; the install method is undetermined, so no second route is known`)
    } else if (installSpec === route.spec) {
      row('route', 'Channel route', true, `${ws}; the ${method.method} install publishes the same route`)
    } else {
      row(
        'route',
        'Channel route',
        false,
        `TWO routes on this host: the agent launches through the ${ws}, while the ${method.method} install publishes ${installSpec}, which carries no traffic for this agent`,
        `leave .mcp.json alone, it is the live route; the ${installSpec} entry is the duplicate, so a failing ${installSpec} line in claude mcp list is not this agent, and removing that ${method.method} install (never the .mcp.json) is what clears it`,
      )
    }
  } else if (!String(route.spec ?? '').trim()) {
    // Undetermined detection and no workspace server: the Install method row
    // already fails loudly for this; a second red row would say nothing new.
    row('route', 'Channel route', null, '')
  } else {
    row('route', 'Channel route', true, `${route.method} install route ${route.spec} (no workspace .mcp.json server declares one)`)
  }

  // Folder trust
  //
  // Claude Code stops on a full-screen "Do you trust the files in this
  // folder?" dialog until projects[<cwd>].hasTrustDialogAccepted is true in
  // its OWN config file, and an unattended launch answers nothing, so it sits
  // there and then exits. The preseed writes that flag on every hoai launch;
  // 0.42.1 is the release where it turned out to have been writing it to
  // $HOME/.claude/.claude.json, a file Claude Code never opens, while the live
  // $HOME/.claude.json kept its untouched state. Nothing failed, every log
  // line said success. This row reads the flag back out of the file the CLI
  // actually opens, which is the only way that class of bug is visible.
  if (p.trust !== undefined) {
    const trust = p.trust ?? {}
    const trustFix = 'run hoai in this folder (every launch seeds the trust entry), or hoai pair <code from the HOAI app>'
    if (trust.accepted && trust.inheritedFrom) {
      row('trust', 'Folder trust', true, `Claude Code trusts ${trust.cwd} through its trusted parent ${trust.inheritedFrom} (hasTrustDialogAccepted in ${trust.configPath})`)
    } else if (trust.accepted) {
      row('trust', 'Folder trust', true, `Claude Code trusts ${trust.cwd} (hasTrustDialogAccepted in ${trust.configPath})`)
    } else if (p.launchFolder?.source === 'cwd-unpinned') {
      // NOBODY NAMED AN AGENT FOLDER (2026-09-22). The desktop one-click runs
      // `hoai doctor --preflight --assistant-id N` from the HOME directory with
      // no --workdir. This row then probed $HOME, which pairing never seeds and
      // now refuses as an agent folder, so it FAILed, and because it gates the
      // preflight every desktop install stopped dead AFTER the one time pair
      // code was spent (measured end to end against main on 2026-09-21). A
      // folder with no .bgos-agent-id pin is not known to be anybody's launch
      // folder, so its trust state is not evidence about the agent. Say what
      // was seen, fail nothing.
      row(
        'trust',
        'Folder trust',
        UNPROVEN,
        `no agent folder was named: --workdir was not given and ${trust.cwd} carries no ${FOLDER_PIN_FILE_NAME} pin, so there is no launch folder to check. Pass --workdir <the agent folder> to check one (for the record, Claude Code does not trust ${trust.cwd} itself: ${trust.reason})`,
        '',
      )
    } else if (trust.reason === 'no-config-path') {
      row('trust', 'Folder trust', false, `Claude Code's config file could not be located: ${trust.error ?? 'no CLAUDE_CONFIG_DIR and no home directory'}`, trustFix)
    } else if (trust.reason === 'no-config-file') {
      row('trust', 'Folder trust', false, `no config file at ${trust.configPath}, so no folder is trusted yet and the first launch stops on the trust dialog`, trustFix)
    } else if (trust.reason === 'unreadable-config') {
      row('trust', 'Folder trust', false, `${trust.configPath} is not readable JSON, so the trust state for ${trust.cwd} cannot be confirmed`, `repair or remove ${trust.configPath}: hoai will not replace a Claude Code config it cannot read`)
    } else if (trust.reason === 'not-accepted') {
      row('trust', 'Folder trust', false, `${trust.configPath} has an entry for ${trust.cwd} but hasTrustDialogAccepted is not true, so the launch stops on the trust dialog`, trustFix)
    } else {
      row('trust', 'Folder trust', false, `${trust.configPath} has no entry for ${trust.cwd}, so the launch stops on the trust dialog with nobody there to answer it`, trustFix)
    }
  }

  // Bypass prompt
  //
  // The bypass-permissions warning's DEFAULT answer is exit, so it can never
  // be blind-Entered; the only safe handling is the settings key that stops it
  // being shown at all. Missing key, silent instant exit on every launch.
  if (p.bypass !== undefined) {
    const bypass = p.bypass ?? {}
    if (bypass.accepted) {
      row('bypass', 'Bypass prompt', true, `skipDangerousModePermissionPrompt is true in ${bypass.settingsPath}`)
    } else {
      row(
        'bypass',
        'Bypass prompt',
        false,
        bypass.reason === 'no-settings-file'
          ? `no settings file at ${bypass.settingsPath}, so the bypass warning is still shown and its default answer is exit`
          : `skipDangerousModePermissionPrompt is not true in ${bypass.settingsPath}, so the bypass warning is still shown and its default answer is exit`,
        'run hoai in this folder (every launch seeds the setting), or hoai pair <code from the HOAI app>',
      )
    }
  }

  // Startup gate strategy
  //
  // Every launch carrying --dangerously-load-development-channels shows a
  // confirm at (re)start, for a marketplace install as much as for a clone.
  // Posix accepts it by wrapping claude in expect; win32 has no expect and
  // uses the console-input helper instead. A posix host that needs the wrapper
  // and has no expect installed strands an unattended relaunch on a
  // full-screen prompt, which looks exactly like a hung agent.
  if (p.gate !== undefined) {
    const gate = p.gate ?? {}
    if (gate.helper === 'win32-console') {
      row('gate', 'Startup gate', true, 'win32: the dev-channels gate is accepted by the console input helper, not by expect, so expect is not needed on this host')
    } else if (!gate.needed) {
      row('gate', 'Startup gate', null, `install method ${gate.method || 'undetermined'}: no relaunch wrapper is used, so the gate strategy is not known (see the Install method row)`)
    } else if (gate.expectPath) {
      row('gate', 'Startup gate', true, `the expect wrapper will accept the dev-channels gate on relaunch (expect at ${gate.expectPath})`)
    } else {
      row(
        'gate',
        'Startup gate',
        false,
        `a ${gate.method} install relaunches through the expect wrapper and expect is not installed here (checked ${EXPECT_PROBE_PATHS.join(', ')}), so an unattended relaunch strands on the full-screen dev-channels prompt`,
        expectInstallHint(platform),
      )
    }
  }

  // Incumbent session
  //
  // A pinned conversation can only be resumed once, so hoai waits for any
  // claude that demonstrably owns this folder rather than starting a second
  // session beside it. From the outside that wait is indistinguishable from a
  // launch that does nothing, so the doctor names the pid instead.
  //
  // An unreadable cwd does NOT make the launcher wait (F8, 2026-09-21). The
  // rule used to be "fail toward waiting" and it stranded a real first
  // install: one claude under the same uid whose cwd lsof would not show made
  // every launch wait forever. incumbentBlocks now returns false for
  // 'unreadable-cwd', so the launcher warns once and launches immediately.
  // This row is the one place a user looks to explain a launch that seems to
  // do nothing, so its non-blocking branch has to say THAT, not the symptom
  // F8 removed, and it must not point at a pid to kill for no reason.
  if (p.incumbent !== undefined) {
    const incumbent = p.incumbent ?? {}
    const hit = incumbent.hit ?? null
    if (!hit) {
      row('incumbent', 'Incumbent session', true, `no other claude is holding ${incumbent.cwd}`)
    } else if (incumbent.blocks) {
      row(
        'incumbent',
        'Incumbent session',
        false,
        `claude pid ${hit.pid} is already running in ${incumbent.cwd}; hoai waits for it rather than starting a second session on the same pinned conversation, so a launch here looks like it does nothing`,
        `quit that session, or stop it with: kill ${hit.pid} (confirm the pid is really that claude first), then run hoai again here`,
      )
    } else {
      row(
        'incumbent',
        'Incumbent session',
        true,
        `nothing is holding ${incumbent.cwd}; claude pid ${hit.pid} is running under this user with an unreadable cwd, which may or may not be this folder, so hoai mentions it once and then launches anyway`,
      )
    }
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
  //
  // UNPROVEN, not SKIP (2026-09-21). The clause "render a never-run check as
  // UNPROVEN rather than SKIP" reached the liveness row and stopped there,
  // and this is a never-run check in exactly that sense: a reader takes SKIP
  // for "not applicable on this machine" and reads past it, and this is the
  // row the whole preflight gate is built on. The detail now says WHY it did
  // not run instead of the bare word 'skipped'. The gate is untouched:
  // handshake is a REQUIRED row and only ok:true satisfies one, so unproven
  // fails preflight exactly as the old ok:null did.
  const handshake = p.handshake ?? null
  if (!handshake) {
    row(
      'handshake',
      'MCP handshake (initialize)',
      UNPROVEN,
      'not run: the live initialize handshake was skipped, so nothing here has proven the server can boot and speak MCP',
    )
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
  //
  // UNPROVEN for the same reason as the handshake row above, and the detail
  // names the one thing that stops this probe running: main() only asks
  // `claude mcp list` when the claude CLI was found, so an absent CLI is the
  // honest WHY, and it points at the row that carries the fix for it.
  const mcpList = p.mcpList ?? null
  if (!mcpList) {
    row(
      'mcp-list',
      'claude mcp list',
      UNPROVEN,
      claude.found
        ? 'not run: claude mcp list was never asked whether this plugin reads Connected'
        : 'not run: the claude CLI was not found, so claude mcp list could not be asked whether this plugin reads Connected (see the Claude Code CLI row)',
    )
  } else if (mcpList.ok) {
    row('mcp-list', 'claude mcp list', true, mcpList.raw ?? 'Connected')
  } else {
    // The fix line uses the spec DETECTION resolved (which carries this
    // machine's real marketplace name), and when detection came back
    // undetermined there is deliberately no command here: the old code fell
    // back to `clone` on anything that was not literally 'marketplace', which
    // is the fail-OPEN direction and would tell a marketplace user to launch
    // the spec that made them deaf in the first place.
    row(
      'mcp-list',
      'claude mcp list',
      false,
      mcpList.raw ?? `state: ${mcpList.state ?? 'unknown'}`,
      launchCommandFor(method) ||
        'fix the Install method row first: until the install method is known, no launch command can be given',
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
  // hearing", so it renders UNPROVEN with the exact next action.
  //
  // UNPROVEN, not SKIP (2026-09-21): this is the row that lied. On the machine
  // where every hoai invocation exited instantly it printed SKIP beside twelve
  // PASSes, and SKIP reads as "not applicable here". Its own detail already
  // said "never proven"; the status word now says the same thing. The gate
  // behaviour is unchanged, UNPROVEN fails no preflight, exactly as ok:null
  // did.
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
        UNPROVEN,
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
 *
 * Four statuses. PASS, FAIL and SKIP mean exactly what they always meant;
 * UNPROVEN is the row that applies and has no evidence yet (see UNPROVEN),
 * which used to print as SKIP and was read as "not applicable".
 */
export function renderDoctorTable(rows) {
  const statusOf = (ok) =>
    ok === true ? 'PASS' : ok === false ? 'FAIL' : ok === UNPROVEN ? 'UNPROVEN' : 'SKIP'
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
 *
 * ADVISORY ROWS are the second exemption, and it exists because adding a row
 * here silently changes what aborts an install. bin/hoai-bootstrap.sh runs
 * this gate at line 611 and calls `fail 'preflight-failed'` on a false, so
 * every FAIL-capable row is also a way for a first-time install to stop dead.
 * Two rows report rather than gate:
 *
 *   gate: the startup-gate row is about a FUTURE unattended RELAUNCH. It fails
 *   when the expect wrapper will be used and expect is not installed. That is
 *   worth reporting loudly, and it is not a reason to abandon an install that
 *   is otherwise complete. macOS ships /usr/bin/expect so this never shows
 *   there, but a minimal Linux image does not, and the bootstrap never
 *   installs it, so gating on it would have turned "your restarts may stall"
 *   into "your install failed" for every such host.
 *
 *   incumbent: an already-running claude in this folder is the NORMAL state of
 *   a healthy always-on agent, whose service keeps one alive with cwd set to
 *   the workspace permanently. Re-running the one-click installer against such
 *   a machine used to complete; with this row gating it aborted with
 *   `preflight FAILED: incumbent`, after the one-time pair code had already
 *   been spent. The bootstrap LAUNCHES after preflight, and that launch does
 *   its own incumbent handling (waitForIncumbent, and incumbentBlocks decides
 *   what is worth waiting for), so refusing to FINISH an install over a
 *   session the next step already knows how to handle helps nobody.
 *
 * Both rows still render FAIL with their pid and their fix line; they just do
 * not carry the gate.
 *
 * UNPROVEN is not a failure here, by construction: only ok:false fails a
 * non-required row and only ok:true satisfies a required one, so an unproven
 * row gates exactly as ok:null always did. Changing that would turn a machine
 * that has simply not launched yet into a failed bootstrap.
 * @param {Array<{ id: string, ok: boolean | null | 'unproven' }>} rows
 * @returns {{ ok: boolean, failing: string[] }}
 */
export const ADVISORY_ROW_IDS = Object.freeze(['gate', 'incumbent'])

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
    if (ADVISORY_ROW_IDS.includes(r.id)) continue
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
 * The channel route the RUNNER (hoai) would launch through from `cwd`, from
 * the same resolver the launcher uses: a workspace .mcp.json server named bgos
 * wins, the install method is only the fallback. Not re-derived here, so the
 * doctor and the launcher cannot disagree about which route is live. On a host
 * carrying BOTH a folder clone and a marketplace install, the Install method
 * row alone named the deaf one (Alex's Mac, 2026-08-30; KC and Alex again,
 * 2026-09-02); this probe is what lets the route row name both.
 */
export function probeChannelRoute({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  scriptDir = dirname(fileURLToPath(import.meta.url)),
} = {}) {
  try {
    return resolveChannelSpec({ cwd, env, home, scriptDir })
  } catch (err) {
    return { spec: '', source: 'install-method', method: 'unknown', serverName: '', conflict: false, reason: String(err?.message ?? err) }
  }
}

// -- The paired topology: proving a folder with no .mcp.json is launchable -----
//
// `hoai-agent install --always-on` used to refuse any workspace with no
// .mcp.json, and that gate was load bearing: it guaranteed the session had a
// `bgos` MCP server to load, so `server:bgos` was correct by construction. It
// also made desktop one-click impossible on a fresh workspace, because the
// one-click path installs the MARKETPLACE plugin and pairs with a code: it
// never has a key to write a .mcp.json with. Measured 2026-09-21: the desktop's
// exact launch line died on "no .mcp.json ... and no creds given".
//
// The gate exists because an agent once came back DEAF on the wrong channel
// spec (2026-08-21): it starts, `claude mcp list` says Connected, and not one
// inbound message is ever delivered. So a missing .mcp.json is never simply
// waved through. The supervisor may launch such a folder only when the paired
// topology is PROVEN, by the two readers the rest of this repo already trusts,
// not by a third reading written here:
//
//   launchFolderLiveSafe (bin/bgos-pair.mjs)   the folder pin names this agent
//                                              and its credentials-<id>.json is
//                                              there: what pairing itself
//                                              verifies before it calls a
//                                              pairing live-safe.
//   probeChannelRoute (the Channel route row)  the launcher's own resolver says
//                                              the route from this folder is a
//                                              marketplace install.
//
// Both are asked about the environment the SUPERVISED claude will have, not the
// installer's: the launchd plist and the systemd unit carry no CLAUDE_CONFIG_DIR,
// so a plugin installed only under the installing shell's custom config dir is
// a plugin the supervised session will never load. That is a refusal, by name.
// A deaf agent is worse than a refused install.

/** Refusal reasons, stable strings: bin/bgos-agent prints them and tests pin them. */
export const PAIRED_TOPOLOGY_REASONS = Object.freeze({
  NO_ASSISTANT_ID: 'paired-topology:no-assistant-id',
  NO_FOLDER_PIN: 'paired-topology:no-folder-pin',
  PIN_MISMATCH: 'paired-topology:pin-mismatch',
  NO_AGENT_CREDENTIALS: 'paired-topology:no-agent-credentials',
  NOT_LIVE_SAFE: 'paired-topology:not-live-safe',
  WORKSPACE_DECLARES_SERVER: 'paired-topology:workspace-declares-server',
  PLUGIN_NOT_INSTALLED: 'paired-topology:plugin-not-installed',
  INSTALLER_IS_A_CLONE: 'paired-topology:installer-is-a-clone',
  CREDENTIALS_FOR_ANOTHER_AGENT: 'paired-topology:credentials-belong-to-another-agent',
  PLUGIN_DISABLED: 'paired-topology:plugin-disabled',
  PLUGIN_FILES_MISSING: 'paired-topology:plugin-files-missing',
})

/** Variables the generated launchd plist and systemd unit do NOT carry. */
const NOT_IN_SUPERVISED_ENV = ['CLAUDE_CONFIG_DIR', 'CLAUDE_PLUGIN_ROOT', 'BGOS_ASSISTANT_ID', 'BGOS_CREDENTIALS_PATH']

/** The installer's env minus everything the supervised session will not have. */
export function supervisedEnv(env = process.env) {
  const out = { ...env }
  for (const name of NOT_IN_SUPERVISED_ENV) delete out[name]
  return out
}

/**
 * Can an always-on supervisor launch `workdir` for `assistantId` with no
 * workspace .mcp.json? Only when all three hold, each by an existing reader.
 * @param {{ workdir: string, assistantId: string | number, env?: Record<string, string | undefined>,
 *           home?: string, scriptDir?: string, readPin?: (dir: string) => string,
 *           exists?: (path: string) => boolean,
 *           liveSafe?: (o: { cwd: string, assistantId: string, env: Record<string, string | undefined>, home: string }) => boolean,
 *           route?: (o: { cwd: string, env: Record<string, string | undefined>, home: string, scriptDir: string }) =>
 *             { spec?: string, source?: string, method?: string, serverName?: string, reason?: string } }} opts
 * @returns {Promise<{ ok: boolean, channel: string, reason: string, detail: string }>}
 */
export async function provePairedTopology({
  workdir,
  assistantId,
  env = process.env,
  home = homedir(),
  scriptDir = dirname(fileURLToPath(import.meta.url)),
  readPin = readFolderPin,
  exists = existsSync,
  liveSafe = launchFolderLiveSafe,
  route = probeChannelRoute,
  credentials = probeCredentials,
  observeInstall = observeMarketplaceInstall,
} = {}) {
  const R = PAIRED_TOPOLOGY_REASONS
  const refused = (reason, detail) => ({ ok: false, channel: '', reason, detail })
  const dir = String(workdir ?? '').trim()
  const id = String(assistantId ?? '').trim()
  if (!/^\d+$/.test(id) || !dir) return refused(R.NO_ASSISTANT_ID, 'a numeric --assistant-id and a --workdir are both needed')
  const runtimeEnv = supervisedEnv(env)

  // 1 and 2, named first so the refusal says WHICH one is missing...
  const pin = readPin(dir)
  if (!pin) {
    return refused(R.NO_FOLDER_PIN, `${dir} carries no ${FOLDER_PIN_FILE_NAME} pin, so this folder was never paired as an agent folder; pair from inside it first (hoai-pair <code> --assistant-id ${id})`)
  }
  if (pin !== id) {
    return refused(R.PIN_MISMATCH, `${dir} is pinned to agent ${pin}, not ${id}; launching ${id} from here would run as the wrong agent`)
  }
  const credsPath = perAssistantCredentialsPath(home, id)
  if (!exists(credsPath)) {
    return refused(R.NO_AGENT_CREDENTIALS, `no credentials for agent ${id} at ${credsPath}; pair this machine as that agent first`)
  }
  // ...then the verdict itself comes from pairing's OWN verifier, under the
  // supervised environment, so this function cannot drift from what the daemon
  // will actually resolve from that folder.
  // The file NAME says agent <id>. The daemon takes its identity from what is INSIDE
  // it, so a file carrying another agent's id is that other agent, launched from here.
  // Read through the doctor's own credentials probe.
  const inner = credentials({ env: runtimeEnv, home, expectedAssistantId: id })
  if (inner?.assistantId != null && String(inner.assistantId) !== id) {
    return refused(R.CREDENTIALS_FOR_ANOTHER_AGENT, `${credsPath} is named for agent ${id} but holds the credentials of agent ${inner.assistantId}; pair this machine as agent ${id} again`)
  }
  if (!liveSafe({ cwd: dir, assistantId: id, env: runtimeEnv, home })) {
    return refused(R.NOT_LIVE_SAFE, `pairing's own verifier says a session launched from ${dir} would not resolve agent ${id}`)
  }

  // 3. The route, from the launcher's resolver through the doctor's row reader.
  const resolved = route({ cwd: dir, env: runtimeEnv, home, scriptDir })
  if (resolved?.source === 'workspace') {
    return refused(R.WORKSPACE_DECLARES_SERVER, `${dir} declares its own MCP server ${resolved.serverName}, so it is not a marketplace folder; its route is ${resolved.spec}`)
  }
  const spec = String(resolved?.spec ?? '').trim()
  if (resolved?.method === 'clone') {
    // Found by review: an installer running FROM a marketplace install that lives
    // under a custom CLAUDE_CONFIG_DIR also reads as "clone" here, because the
    // supervised environment has no such variable and the script is then outside
    // the default plugins dir. Calling that a clone would be false. If the
    // installing shell's own environment says marketplace, the true reason is
    // that the background service will not see that install.
    const shellView = route({ cwd: dir, env, home, scriptDir })
    if (shellView?.method === 'marketplace') {
      return refused(
        R.PLUGIN_NOT_INSTALLED,
        `the HOAI marketplace plugin is installed for this shell (${claudeConfigDir({ env, home })}) but not where the background agent will look (${claudeConfigDir({ env: runtimeEnv, home })}); the background service does not inherit CLAUDE_CONFIG_DIR`,
      )
    }
    // Its own reason, because "the plugin is not installed" would be a false
    // statement here: it may well be installed. What the resolver says is that
    // the code being run is a CLONE, and a clone's route from a folder with no
    // .mcp.json is a channel nothing in that folder publishes.
    return refused(
      R.INSTALLER_IS_A_CLONE,
      `this installer is running from a plugin clone, whose route from ${dir} would be ${spec || 'unresolved'}, a channel nothing in that folder publishes; a clone agent is loaded from a workspace .mcp.json (pass --key and --user to write one), and a paired marketplace folder is installed through npx or the marketplace plugin itself`,
    )
  }
  if (resolved?.method !== 'marketplace' || !spec.startsWith('plugin:')) {
    const configDir = claudeConfigDir({ env: runtimeEnv, home })
    const custom = String(env?.CLAUDE_CONFIG_DIR ?? '').trim()
    const why = String(resolved?.reason ?? '').trim()
    return refused(
      R.PLUGIN_NOT_INSTALLED,
      `the HOAI marketplace plugin is not installed where the background agent will look (${configDir})` +
        (custom ? `; this shell has CLAUDE_CONFIG_DIR=${custom}, which the background service does not inherit` : '') +
        `. Install method read as ${resolved?.method ?? 'unknown'}${why ? `: ${why}` : ''}`,
    )
  }
  // "The resolver says marketplace" is an install RECORD. The supervised claude needs the
  // plugin enabled and its files on disk, and lib/plugin-cli.mjs already reads exactly that
  // (a real `claude plugin install` writes enabledPlugins["hoai@hoai"]: true, measured).
  const configDir = claudeConfigDir({ env: runtimeEnv, home })
  const observed = await observeInstall({ configDir })
  if (observed?.installed?.present && observed.enabled !== true) {
    return refused(R.PLUGIN_DISABLED, `the HOAI plugin is installed in ${configDir} but not enabled there (settings.json enabledPlugins), so the background session would start without it`)
  }
  const installPath = String(observed?.installed?.installPath ?? '').trim()
  if (installPath && !exists(installPath)) {
    return refused(R.PLUGIN_FILES_MISSING, `the install record in ${configDir} points at ${installPath}, which is not on disk; reinstall the plugin (claude plugin install hoai@hoai)`)
  }
  return { ok: true, channel: spec, reason: '', detail: `folder pin ${id}, credentials ${credsPath}, route ${spec}` }
}

/**
 * What does <workdir>/.mcp.json publish that a supervisor could launch on?
 *
 * `hoai-agent install` takes its old arm ("using existing .mcp.json", channel
 * server:bgos) for any folder that HAS the file. But a .mcp.json that belongs
 * to another tool only (playwright, context7) publishes no HOAI server at all,
 * and launching server:bgos there is the 2026-08-21 signature again: the
 * marketplace plugin still loads, the app says Connected, nothing is delivered.
 * Found by review, reproduced with the real installer.
 *
 * Two readings, both by lib/service-supervision.mjs, the readers the launcher's
 * own resolver uses:
 *   ours   the entry whose env carries a BGOS_ key (parseMcpChannelServerName):
 *          a name, 'conflict', 'unnameable' (ours, but a name no channel can carry), or 'none'
 *   named  whether ANY entry is named `serverName` (bgos). A hand-written entry
 *          called bgos with no env block is still a server that server:bgos
 *          launches, so it keeps the old arm too.
 * Only ours=none AND named=no means the folder publishes nothing of ours. An
 * unreadable or absent file says 'unknown', and the caller keeps today's arm.
 * @param {{ workdir: string, serverName?: string, readFile?: (path: string) => string | null }} opts
 * @returns {{ ours: string, named: 'yes' | 'no' | 'unknown' }}
 */
export function workspacePublishes({ workdir, serverName = 'bgos', readFile = defaultReadText } = {}) {
  const read = readFile(join(String(workdir ?? ''), '.mcp.json'))
  if (read == null) return { ours: 'unknown', named: 'unknown' }
  // The same BOM rule mcpServerEntries applies, or a BOM-prefixed file that belongs to another tool
  // reads as "unknown" here and keeps the deaf arm this exists to end (found by the mutation pass).
  const raw = String(read).replace(/^\uFEFF/, '')
  let entries
  try {
    JSON.parse(raw)
    entries = mcpServerEntries(raw)
  } catch {
    return { ours: 'unknown', named: 'unknown' }
  }
  const name = parseMcpChannelServerName(raw)
  // An entry that IS ours (a BGOS_ env key) but whose name the resolver will not spell into a
  // channel is still ours. Calling that folder "another tool's" would be false, so it is not 'none'.
  const anyOurs = entries.some((entry) => entry.env && Object.keys(entry.env).some((key) => key.startsWith('BGOS_')))
  return {
    ours: name != null ? name : anyOurs ? 'unnameable' : 'none',
    named: entries.some((entry) => entry.name === serverName) ? 'yes' : 'no',
  }
}

/** One line, for bash. */
export function workspacePublishesLine(answer) {
  return `HOAI_WORKSPACE ours=${answer.ours} named=${answer.named}`
}

/** The one line bin/bgos-agent parses. Kept to a single line on purpose. */
export function pairedTopologyLine(verdict) {
  const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
  return verdict.ok
    ? `HOAI_TOPOLOGY_OK ${verdict.channel}`
    : `HOAI_TOPOLOGY_REFUSED ${verdict.reason} ${oneLine(verdict.detail)}`
}

/** Read a text file, or null when it cannot be read. The one injection point
 *  the launch probes need, so a test never touches a real home. */
function defaultReadText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * realpath that never throws: an unresolvable path (one that does not exist
 * yet, or that this user cannot read through) compares as itself. Byte for
 * byte the rule bgos-pair.mjs defaultResolvePath uses, deliberately, because
 * the read side and the write side of the trust entry have to agree about what
 * a path IS.
 */
function defaultResolvePath(path) {
  try {
    return realpathSync(String(path ?? ''))
  } catch {
    return String(path ?? '')
  }
}

/**
 * Every projects[] key that could carry this cwd's trust flag, in the order
 * they are tried: the literal cwd, its other slash spelling (win32 is seeded
 * under both), then the same pair for the REALPATH of the cwd. Deduplicated,
 * so the common case where the two spellings coincide reads one key once.
 * @param {string} cwd
 * @param {(path: string) => string} resolvePath
 * @returns {string[]}
 */
function trustLookupKeys(cwd, resolvePath) {
  const literal = String(cwd ?? '')
  const resolved = String(resolvePath(literal) ?? '')
  const keys = []
  for (const key of [literal, alternateSlashSpelling(literal), resolved, alternateSlashSpelling(resolved)]) {
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * Does Claude Code already trust `cwd`? Reads hasTrustDialogAccepted back out
 * of Claude Code's OWN config file.
 *
 * THE FILE IS LOCATED BY claudeConfigFilePath, never by joining '.claude.json'
 * onto the config dir: with CLAUDE_CONFIG_DIR unset the two differ, the config
 * file sitting at $HOME/.claude.json BESIDE $HOME/.claude, and reading the
 * wrong one answers "not trusted" on a machine that is trusted (or, as in
 * 0.42.1's write-side twin of this bug, reports success having changed
 * nothing). A win32-shaped cwd is seeded under both slash spellings, so either
 * key counts as the answer.
 *
 * THE CWD IS LOOKED UP UNDER BOTH ITS SPELLINGS, literal and resolved
 * (2026-09-21). preseedClaudeTrust keys the entry on the cwd it is handed,
 * which on the write path is process.cwd(), and node reports that as a
 * REALPATH; the doctor is handed whatever a caller typed at --workdir. On any
 * host whose home or workspace runs through a symlink (a /tmp home on macOS
 * resolving under /private/tmp, an ostree /home to /var/home, a bind-mounted
 * container home) the two strings differ, the lookup missed a row sitting
 * right there, and the trust row rendered FAIL on a folder Claude Code
 * trusts. `trust` gates preflightVerdict, so hoai-bootstrap.sh line 611 turned
 * that miss into `fail 'preflight-failed'` and stopped a first install dead,
 * after the one-time pair code had already been spent.
 *
 * It is the same two-spellings bug commit 9090363 fixed on the WRITE side in
 * bgos-pair's classifyPairCwd, and the resolver is injected and never throws
 * for the same reasons it is there: a test must not touch a real filesystem,
 * and a path that cannot be resolved simply compares as itself. The DIRECTION
 * differs. classifyPairCwd had to fail CLOSED, any spelling matching home
 * being enough to refuse; this has to fail toward FINDING the entry that
 * exists, so any spelling carrying the flag is the answer.
 * @param {{ env?: Record<string, string | undefined>, home?: string, cwd?: string,
 *           readFile?: (path: string) => string | null,
 *           resolvePath?: (path: string) => string }} [opts]
 * @returns {{ cwd: string, configPath: string, accepted: boolean, reason: string, matchedKey: string, inheritedFrom?: string, error?: string }}
 */
export function probeFolderTrust({
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  readFile = defaultReadText,
  resolvePath = defaultResolvePath,
} = {}) {
  const result = { cwd: String(cwd ?? ''), configPath: '', accepted: false, reason: 'no-entry', matchedKey: '' }
  try {
    result.configPath = claudeConfigFilePath({ env, home })
  } catch (err) {
    result.reason = 'no-config-path'
    result.error = String(err?.message ?? err)
    return result
  }
  const raw = readFile(result.configPath)
  if (raw == null) {
    result.reason = 'no-config-file'
    return result
  }
  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch {
    result.reason = 'unreadable-config'
    return result
  }
  const projects = cfg && typeof cfg === 'object' ? cfg.projects : null
  if (!projects || typeof projects !== 'object') return result
  for (const key of trustLookupKeys(result.cwd, resolvePath)) {
    const entry = projects[key]
    if (!entry || typeof entry !== 'object') continue
    result.matchedKey = key
    if (entry.hasTrustDialogAccepted === true) {
      result.accepted = true
      result.reason = 'accepted'
      return result
    }
    result.reason = 'not-accepted'
  }
  // TRUST IS INHERITED (measured on Claude Code 2.1.278, 2026-09-21). A folder
  // under a trusted ancestor never shows the trust dialog, with no entry of its
  // own AND with an explicit hasTrustDialogAccepted:false entry of its own: a
  // fresh folder under a trusted /private/tmp went straight past the gate, and
  // so did a child seeded false beside a parent seeded true, while a sibling
  // outside that parent still got the dialog. An exact-key lookup therefore
  // FAILs folders Claude Code launches in without a word, and this row gates
  // the install.
  for (const key of trustLookupKeys(result.cwd, resolvePath)) {
    for (const ancestor of ancestorDirs(key)) {
      if (projects[ancestor]?.hasTrustDialogAccepted === true) {
        result.accepted = true
        result.reason = 'accepted'
        result.matchedKey = ancestor
        result.inheritedFrom = ancestor
        return result
      }
    }
  }
  return result
}

/**
 * Every ancestor directory of `path`, nearest first, root included, in the
 * path's own separator style. Pure string work: the keys in Claude Code's
 * config are strings, and the doctor may be reading a config written on
 * another platform's spelling.
 * @param {string} path
 * @returns {string[]}
 */
export function ancestorDirs(path) {
  let current = String(path ?? '').replace(/[\\/]+$/, '')
  const out = []
  for (let guard = 0; guard < 256; guard += 1) {
    const cut = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'))
    if (cut < 0) break
    const isDriveRoot = /^[A-Za-z]:$/.test(current.slice(0, cut))
    const parent = cut === 0 ? current.slice(0, 1) : isDriveRoot ? current.slice(0, cut + 1) : current.slice(0, cut)
    if (!parent || parent === current) break
    out.push(parent)
    if (cut === 0 || isDriveRoot) break
    current = parent
  }
  return out
}

/**
 * WHICH folder do the launch rows describe? Strongest evidence first:
 *   flag               --workdir was given
 *   cwd-pin            the doctor is standing in a folder that carries an agent pin
 *   default-workspace  --assistant-id N was given and ~/.bgos-agent/N-workspace
 *                      carries that pin (where desktop one-click and
 *                      `hoai-agent install` put an agent nobody chose a folder for)
 *   cwd-unpinned       none of those: cwd, which is not known to be an agent folder
 * @param {{ workdirFlag?: string, cwd?: string, home?: string, assistantId?: string,
 *           readPin?: (dir: string) => string }} [opts]
 * @returns {{ dir: string, source: 'flag' | 'cwd-pin' | 'default-workspace' | 'cwd-unpinned' }}
 */
export function resolveLaunchFolder({
  workdirFlag = '',
  cwd = process.cwd(),
  home = homedir(),
  assistantId = '',
  readPin = readFolderPin,
} = {}) {
  const flag = String(workdirFlag ?? '').trim()
  if (flag) return { dir: flag, source: 'flag' }
  const id = String(assistantId ?? '').trim()
  const cwdPin = readPin(cwd)
  // No id was asked about: whatever agent this folder is pinned to is the subject.
  if (!/^\d+$/.test(id)) return cwdPin ? { dir: cwd, source: 'cwd-pin' } : { dir: cwd, source: 'cwd-unpinned' }
  // An id WAS asked about, so a pin only counts when it is that agent's. A HOME that
  // still carries a stale pin from a pairing made there (what F9 now refuses) must not
  // drag the desktop preflight back to probing HOME for a different agent.
  if (cwdPin === id) return { dir: cwd, source: 'cwd-pin' }
  if (home) {
    const workspace = joinPreservingStyle(joinPreservingStyle(home, '.bgos-agent'), `${id}-workspace`)
    if (readPin(workspace) === id) return { dir: workspace, source: 'default-workspace' }
  }
  return { dir: cwd, source: 'cwd-unpinned' }
}

/**
 * Is the bypass-permissions warning suppressed? That one really does live in
 * <configDir>/settings.json (claudeConfigDir), which is why this probe and
 * probeFolderTrust resolve their paths differently on purpose.
 * @param {{ env?: Record<string, string | undefined>, home?: string,
 *           readFile?: (path: string) => string | null }} [opts]
 * @returns {{ settingsPath: string, accepted: boolean, reason: string }}
 */
export function probeBypassPrompt({ env = process.env, home = homedir(), readFile = defaultReadText } = {}) {
  const settingsPath = joinPreservingStyle(claudeConfigDir({ env, home }), 'settings.json')
  const raw = readFile(settingsPath)
  if (raw == null) return { settingsPath, accepted: false, reason: 'no-settings-file' }
  let settings
  try {
    settings = JSON.parse(raw)
  } catch {
    return { settingsPath, accepted: false, reason: 'unreadable-settings' }
  }
  const accepted = Boolean(settings) && settings.skipDangerousModePermissionPrompt === true
  return { settingsPath, accepted, reason: accepted ? 'accepted' : 'not-set' }
}

/**
 * Will a relaunch need the dev-channels gate accepted, and can this host do
 * it? The decision is hoai-core's own relaunchNeedsGateAutoAccept, so the
 * doctor cannot disagree with the launcher about it; the availability check
 * mirrors hoai-core's private expect detection path for path.
 * @param {{ platform?: string, method?: { method?: string } | null,
 *           exists?: (path: string) => boolean }} [opts]
 * @returns {{ needed: boolean, method: string, helper: 'expect' | 'win32-console', expectPath: string }}
 */
export function probeGateStrategy({ platform = process.platform, method = null, exists = existsSync } = {}) {
  const installMethod = String(method?.method ?? '').trim()
  const needed = relaunchNeedsGateAutoAccept(installMethod)
  if (platform === 'win32') return { needed, method: installMethod, helper: 'win32-console', expectPath: '' }
  let expectPath = ''
  for (const candidate of EXPECT_PROBE_PATHS) {
    try {
      if (exists(candidate)) {
        expectPath = candidate
        break
      }
    } catch {
      // an unreadable path is simply not the expect we found
    }
  }
  return { needed, method: installMethod, helper: 'expect', expectPath }
}

/**
 * Is another claude already holding this cwd? The same rules the launcher
 * waits on (findIncumbentClaude), classified by hoai-core's own
 * incumbentBlocks so "blocking" means here what it means there. The process
 * list is injected, so a test never reads the real process table.
 *
 * ANOTHER claude, never this one. `hoai doctor` is normally typed INTO a
 * claude session whose cwd is the folder being screened, so the node process
 * running this probe has a claude PARENT sitting right there. Excluding only
 * ownPid left that parent looking like a same-cwd incumbent: measured on
 * 2026-09-21, this probe named the pid of the claude running it and the row
 * told the operator to kill the session they were typing into. The ancestor
 * walk (hoai-core selfAndAncestorPids, keyed on the ppid defaultListProcesses
 * now reports) is what tells the caller apart from a rival.
 * @param {{ cwd?: string, platform?: string, uid?: number | null, ownPid?: number,
 *           listProcesses?: () => Array<{ pid: number, ppid?: number | null, uid?: number | null, comm: string, cwd: string | null }>,
 *           ignorePidsFor?: (input: { processes: unknown[], pid: number }) => Iterable<number> }} [opts]
 * @returns {{ cwd: string, hit: { pid: number, reason: string } | null, blocks: boolean, error?: string }}
 */
export function probeIncumbent({
  cwd = process.cwd(),
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  ownPid = process.pid,
  listProcesses = () => defaultListProcesses(platform),
  ignorePidsFor = selfAndAncestorPids,
} = {}) {
  const target = String(cwd ?? '')
  let processes
  try {
    processes = listProcesses() ?? []
  } catch (err) {
    // A process list we could not read is not evidence of an incumbent, and
    // the launcher's own failure mode here is the same: it sees no hit.
    return { cwd: target, hit: null, blocks: false, error: String(err?.message ?? err) }
  }
  const ignorePids = ignorePidsFor({ processes, pid: ownPid })
  const hit = findIncumbentClaude({ processes, cwd: target, uid, ownPid, ignorePids })
  return { cwd: target, hit, blocks: hit ? incumbentBlocks(hit) === true : false }
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
  --prove-paired-topology  with --workdir and --assistant-id: print ONE line saying whether a
                         folder with no .mcp.json is a proven paired marketplace folder
                         (folder pin, agent credentials, plugin install record) and which
                         channel it launches on. Used by hoai-agent install. Exit 0 or 1.
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
    provePairedTopology: false,
    workspacePublishes: false,
  }
  const errors = []
  for (let i = 0; i < (argv ?? []).length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--preflight') args.preflight = true
    else if (arg === '--json') args.json = true
    else if (arg === '--skip-handshake') args.skipHandshake = true
    else if (arg === '--prove-paired-topology') args.provePairedTopology = true
    else if (arg === '--workspace-publishes') args.workspacePublishes = true
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
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: string,
 *           cwd?: string, scriptDir?: string, print?: (line: string) => void }} [opts]
 *   `cwd`, `scriptDir` and `print` are seams for tests: where the doctor stands, where its own
 *   files live (decides the install method), and where the prove-only line goes.
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

  // What the folder's .mcp.json publishes, for `hoai-agent install`: one line, nothing else runs.
  if (args.workspacePublishes) {
    ;(opts.print ?? console.log)(workspacePublishesLine(workspacePublishes({ workdir: args.workdir })))
    return 0
  }

  // Prove-only mode, for `hoai-agent install`: one line, no table, no network,
  // no claude. Exit 0 when the paired topology is proven, 1 when it is refused.
  if (args.provePairedTopology) {
    const verdict = await provePairedTopology({
      workdir: args.workdir,
      assistantId: args.assistantId,
      env,
      home,
      ...(opts.scriptDir ? { scriptDir: opts.scriptDir } : {}),
    })
    ;(opts.print ?? console.log)(pairedTopologyLine(verdict))
    return verdict.ok ? 0 : 1
  }

  // The folder the launch rows describe. It used to be `--workdir || cwd`, which
  // made the desktop one-click preflight (no --workdir, cwd = HOME) check HOME.
  const launchFolder = resolveLaunchFolder({
    workdirFlag: args.workdir,
    cwd: opts.cwd ?? (args.workdir ? args.workdir : process.cwd()),
    home,
    assistantId: args.assistantId || String(env.BGOS_ASSISTANT_ID ?? '').trim(),
  })
  const workdir = launchFolder.dir

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
  const route = probeChannelRoute({ cwd: workdir, env })

  // The launch rows: four cheap reads, none of which touches the channel.
  // They run before the handshake because they are the ones that answer "why
  // does hoai exit instantly", and the handshake takes up to a minute.
  const trust = probeFolderTrust({ env, home, cwd: workdir })
  const bypass = probeBypassPrompt({ env, home })
  const gate = probeGateStrategy({ platform, method })
  const incumbent = probeIncumbent({ cwd: workdir, platform })

  // Identity, strongest evidence first: the explicit flag, the env var, the
  // launch-folder pin. It scopes the credentials row, the handshake env, and
  // the log path, exactly as the daemon itself would resolve it.
  const assistantId =
    args.assistantId || String(env.BGOS_ASSISTANT_ID ?? '').trim() || readFolderPin(workdir)
  const credentials = probeCredentials({ env, home, expectedAssistantId: assistantId })

  let handshake = null
  if (!args.skipHandshake) {
    // The handshake proves the code CAN boot and speak MCP, so it runs the
    // copy this doctor is executing (executionRoot) when detection could not
    // name an installed root. It is not a statement about which install the
    // channel loads; the Install method row is, and it fails loudly on its own
    // when undetermined.
    const handshakeRoot = String(method.pluginRoot ?? '').trim() || String(method.executionRoot ?? '').trim()
    const launchArgv = [join(handshakeRoot, 'bin', 'bgos-launch.mjs'), join(handshakeRoot, 'server.ts')]
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
    route,
    trust,
    launchFolder,
    bypass,
    gate,
    incumbent,
    credentials,
    handshake,
    mcpList,
    backend,
    logPath,
    liveMarker,
  })

  if (args.json) {
    // The rows verbatim, ok included. A JSON consumer already had to handle
    // three values (true / false / null); UNPROVEN is a fourth, and the two
    // tests that matter, ok === true for green and ok === false for broken,
    // classify it the same way they classified null.
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
