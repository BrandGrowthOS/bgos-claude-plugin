/**
 * claude-binary: which `claude` an always-on install may bake (board row
 * 84296679, kc-server, 2026-10-12).
 *
 * WHAT WENT WRONG. A keep-alive reinstall ran under the watcher's service PATH,
 * which led with /usr/local/bin. A stale /usr/local/bin/claude 2.1.22 sat there
 * ahead of the user's own ~/.local/bin/claude, `command -v claude` returned it,
 * and bin/bgos-agent baked its directory into five agents' units. That CLI
 * does not know --dangerously-load-development-channels, so every launch printed
 * `error: unknown option` and exited rc=1: about 420 silent crash loops.
 *
 * THE RULE. No version number is guessed. The flag every launch carries is
 * hidden from `--help`, but a CLI that knows it answers a bare use of it with
 * `argument missing` and one that does not answers `unknown option`. That is
 * the capability, asked of the exact binary that would be baked:
 *
 *   - `unsupported`  the output names an unknown option: never baked.
 *   - `supported`    the output names the missing argument: preferred.
 *   - `unknown`      anything else (a stand-in, a wrapper, a CLI that changed
 *                    its wording): accepted, with its version recorded, so a
 *                    new wording can never lock an install out.
 *
 * Candidates, in order: ~/.local/bin/claude (the native installer's own
 * location, the one that updates itself), then every `claude` on PATH in PATH
 * order. The first one that is not `unsupported` wins; the ones skipped are
 * named so the install can say why.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe. File and process
 * access is injectable so tests run on a temp dir with stand-in binaries.
 * No em dashes or en dashes in this file.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

/** The flag every unattended launch carries. */
export const DEV_CHANNELS_FLAG = '--dangerously-load-development-channels'

/** How long one probe may take. A bare option error returns at once. */
export const PROBE_TIMEOUT_MS = 10_000

/**
 * What a bare use of the flag printed, read as a capability.
 * @param {{ status?: number | null, stdout?: string, stderr?: string }} out
 * @returns {'supported' | 'unsupported' | 'unknown'}
 */
export function classifyFlagProbe(out) {
  const text = `${out?.stdout ?? ''}\n${out?.stderr ?? ''}`.toLowerCase()
  // Commander's wording for a flag the CLI has never heard of.
  if (/unknown option/.test(text) && text.includes('development-channels')) return 'unsupported'
  if (/unknown option/.test(text)) return 'unsupported'
  // A known option given no value.
  if (/argument missing|missing required argument|requires an argument|expected an argument/.test(text)) {
    return 'supported'
  }
  return 'unknown'
}

/**
 * The version a CLI printed for `--version`: "2.1.296 (Claude Code)" gives
 * "2.1.296". Empty string when nothing readable.
 * @param {string} text
 */
export function parseClaudeVersion(text) {
  const match = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(String(text ?? ''))
  return match ? match[1] : ''
}

/**
 * Ask one binary what it is and whether it knows the launch flag.
 * @param {string} path
 * @param {{ spawn?: typeof spawnSync, timeoutMs?: number, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ path: string, version: string, flag: 'supported' | 'unsupported' | 'unknown', ran: boolean, detail: string }}
 */
export function probeClaude(path, { spawn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  const run = (args) => {
    try {
      return spawn(path, args, { encoding: 'utf8', timeout: timeoutMs, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return { status: null, stdout: '', stderr: String(error?.message ?? error), error }
    }
  }
  const versionOut = run(['--version'])
  const version = parseClaudeVersion(`${versionOut?.stdout ?? ''}\n${versionOut?.stderr ?? ''}`)
  const flagOut = run([DEV_CHANNELS_FLAG])
  const ran = !(flagOut?.error && flagOut.status === null && !(flagOut.stdout || flagOut.stderr))
  const flag = ran ? classifyFlagProbe(flagOut) : 'unknown'
  const first = String(flagOut?.stderr || flagOut?.stdout || '').trim().split('\n')[0] ?? ''
  return { path, version, flag, ran, detail: first.slice(0, 160) }
}

function isExecutableFile(path, exists, isFile) {
  try {
    return exists(path) === true && isFile(path) === true
  } catch {
    return false
  }
}

/**
 * Every `claude` this host could run, best first, one entry per real file.
 * @param {{ pathVar?: string, home?: string, exists?: (p: string) => boolean,
 *   isFile?: (p: string) => boolean, real?: (p: string) => string }} [opts]
 * @returns {string[]}
 */
export function claudeCandidates({
  pathVar = process.env.PATH ?? '',
  home = homedir(),
  exists = existsSync,
  isFile = (p) => statSync(p).isFile(),
  real = (p) => realpathSync(p),
} = {}) {
  const dirs = [join(home, '.local', 'bin'), ...String(pathVar).split(delimiter)]
  const out = []
  const seen = new Set()
  for (const raw of dirs) {
    const dir = String(raw ?? '').trim()
    if (!dir || !dir.startsWith('/')) continue
    const candidate = join(resolve(dir), 'claude')
    if (!isExecutableFile(candidate, exists, isFile)) continue
    let key = candidate
    try {
      key = real(candidate)
    } catch {
      key = candidate
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

/**
 * Pick the `claude` to bake.
 * @param {{ candidates?: string[], probe?: (p: string) => ReturnType<typeof probeClaude>,
 *   pathVar?: string, home?: string }} [opts]
 * @returns {{ ok: true, path: string, version: string, flag: string, skipped: Array<{ path: string, version: string, flag: string, detail: string }> }
 *   | { ok: false, reason: 'no-claude' | 'none-supports-flag', skipped: Array<{ path: string, version: string, flag: string, detail: string }> }}
 */
export function chooseClaude({ candidates, probe = (p) => probeClaude(p), pathVar, home } = {}) {
  const list = candidates ?? claudeCandidates({ pathVar, home })
  if (list.length === 0) return { ok: false, reason: 'no-claude', skipped: [] }
  const skipped = []
  for (const path of list) {
    const result = probe(path)
    if (result.flag === 'unsupported') {
      skipped.push({ path, version: result.version, flag: result.flag, detail: result.detail })
      continue
    }
    return { ok: true, path, version: result.version, flag: result.flag, skipped }
  }
  return { ok: false, reason: 'none-supports-flag', skipped }
}

/**
 * The words an install says about a skipped or refused binary.
 * @param {{ path: string, version: string, detail?: string }} entry
 */
export function describeSkipped(entry) {
  const version = entry.version ? ` ${entry.version}` : ''
  return `${entry.path}${version} does not know ${DEV_CHANNELS_FLAG}${entry.detail ? ` (${entry.detail})` : ''}`
}
