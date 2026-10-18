/**
 * PERSON LANES, the CLI probe (shared agents Phase 3, P3; design 4.4
 * `person_lanes` "declared only when the CLI supports every flag in section
 * 7, else lanes stay off and the backend keeps today's behaviour").
 *
 * The locked launch needs flags `claude --help` lists (--restricted,
 * --strict-mcp-config, --mcp-config, --settings, --permission-mode, --tools,
 * --session-id, --resume), the `dontAsk` permission mode (the CLI lists its
 * modes when handed one it does not know), and the development channels flag,
 * which the help hides: given bare, a known flag answers "argument missing"
 * and an unknown one "unknown option" (the same probe lib/claude-binary.mjs
 * runs). Each spawn returns at once without starting a session.
 *
 * The answer is CACHED per binary (its real path, size and modification
 * time), so the heartbeat never spawns the CLI again until it changes. A host
 * without `expect` (the development channels screen must be answered) or on
 * Windows (a lane needs its own console, spike S5) never declares lanes.
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'

import {
  classifyLaneCliProbe,
  LANE_HIDDEN_VALUE_FLAGS,
  LANE_MODE_PROBE_VALUE,
} from './lane-core.mjs'

export const LANE_PROBE_TIMEOUT_MS = 10_000
/** Bump when the probe's questions change, so an old cached yes is asked again. */
export const LANE_PROBE_VERSION = 3

/**
 * Ask one binary every question.
 *
 * @param {string} claudePath
 * @param {{ run?: typeof spawnSync, env?: Record<string, string | undefined>, timeoutMs?: number }} [deps]
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function probeLaneCli(claudePath, { run = spawnSync, env = process.env, timeoutMs = LANE_PROBE_TIMEOUT_MS } = {}) {
  const ask = (args) => {
    try {
      return run(claudePath, args, { encoding: 'utf8', timeout: timeoutMs, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return { status: null, stdout: '', stderr: String(err?.message ?? err) }
    }
  }
  const hidden = {}
  for (const flag of LANE_HIDDEN_VALUE_FLAGS) hidden[flag] = ask([flag])
  return classifyLaneCliProbe({
    help: ask(['--help']),
    mode: ask(['--permission-mode', LANE_MODE_PROBE_VALUE]),
    hidden,
  })
}

/** The first executable named `name` on PATH, or null. */
export function findOnPath(name, { pathVar = process.env.PATH ?? '', fs = nodeFs } = {}) {
  for (const dir of String(pathVar).split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      const st = fs.statSync(candidate)
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate
    } catch { /* not here */ }
  }
  return null
}

/**
 * Lanes can run on this host with this CLI, asked once per binary.
 *
 * @param {{ claudePath: string | null, cachePath: string, platform?: string,
 *   pathVar?: string, fs?: typeof nodeFs, probe?: typeof probeLaneCli, now?: () => number }} params
 * @returns {{ ok: boolean, missing: string[], cached: boolean, reason?: string }}
 */
export function laneCliSupport({ claudePath, cachePath, platform = process.platform, pathVar = process.env.PATH ?? '', fs = nodeFs, probe = probeLaneCli, now = Date.now }) {
  if (platform === 'win32') return { ok: false, missing: [], cached: false, reason: 'platform' }
  if (!findOnPath('expect', { pathVar, fs })) return { ok: false, missing: [], cached: false, reason: 'no_expect' }
  if (!claudePath) return { ok: false, missing: [], cached: false, reason: 'no_claude' }
  let key
  try {
    const real = fs.realpathSync(claudePath)
    const st = fs.statSync(real)
    key = `${LANE_PROBE_VERSION}:${real}:${st.size}:${Math.trunc(st.mtimeMs)}`
  } catch {
    return { ok: false, missing: [], cached: false, reason: 'no_claude' }
  }
  try {
    const cached = JSON.parse(String(fs.readFileSync(cachePath, 'utf8')))
    if (cached?.key === key && typeof cached.ok === 'boolean') {
      return { ok: cached.ok, missing: Array.isArray(cached.missing) ? cached.missing : [], cached: true }
    }
  } catch { /* no cache yet */ }
  const answer = probe(claudePath)
  try {
    fs.mkdirSync(dirname(cachePath), { recursive: true })
    const tmp = `${cachePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ key, ok: answer.ok, missing: answer.missing, at: new Date(now()).toISOString() })}\n`)
    fs.renameSync(tmp, cachePath)
  } catch { /* a cache that cannot be written only costs a re-probe */ }
  return { ok: answer.ok, missing: answer.missing, cached: false }
}
