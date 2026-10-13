/**
 * duplicate-copy: is THIS daemon the plugin's second copy of a channel the
 * session already runs from a checkout?
 *
 * kc-server, 2026-10-13 (agents 863, 867, 871, 872, 873, 876). An agent whose
 * folder registers the checkout as the `bgos` server in .mcp.json, launched
 * with `--dangerously-load-development-channels server:bgos`, and whose user
 * settings also enable the marketplace plugin hoai@hoai, starts TWO daemons for
 * one pairing: the checkout's, which carries the channel, and the plugin
 * cache's, which does not (lib/channel-presence.ts: it proves that and stays
 * passive). Passive is not silent. The session lists the plugin's tools too
 * (mcp__plugin_hoai_bgos__*), the model may pick them, and a private tool
 * (schedule, boards) answers "does not hold the active agent connection": the
 * second copy is a trap for the model, a lock flip at every boot, and a stand
 * down report each time.
 *
 * THE RULE. The plugin copy serves a one tool notice instead of a second
 * daemon (lib/pair-required-server.mjs, hoai_duplicate_copy) when ALL of:
 *   - it is the marketplace install (a clone is never the duplicate);
 *   - its own channel spec is NOT on the session's claude command line, and
 *     the clone's spec (server:bgos) IS: the session provably loads the
 *     checkout as its channel, so the plugin copy can never be the one a
 *     message is pushed into;
 *   - the launch folder's .mcp.json registers a `bgos` server whose server.ts
 *     exists and lives in ANOTHER checkout than this one: the sibling is real.
 * Anything unknown (no claude ancestor, a command line it cannot read, no
 * .mcp.json, a sibling whose server.ts is gone) means NOT a duplicate: the
 * copy runs exactly as before. A copy that is wrongly kept costs a passive
 * daemon; a copy that is wrongly silenced could leave the session with no
 * tools at all, so every doubt keeps it.
 *
 * Plain JavaScript, node builtins only, import-safe; file access is
 * injectable so the tests run on a temp dir. No em dashes or en dashes.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** The spec a session names the checkout under. Mirrors bin/bgos-install-method.mjs. */
export const CLONE_SPEC = 'server:bgos'

/**
 * The checkout the launch folder registers as its `bgos` server, or null.
 * @param {{ cwd: string, ownRoot: string, readFile?: (p: string) => string | null,
 *   exists?: (p: string) => boolean, realpath?: (p: string) => string }} input
 * @returns {{ serverTs: string, root: string } | null}
 */
export function findSiblingClone({
  cwd,
  ownRoot,
  readFile = (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  exists = existsSync,
  realpath = realpathSync,
}) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return null
  const raw = readFile(join(dir, '.mcp.json'))
  if (raw == null) return null
  let args
  try {
    args = JSON.parse(raw)?.mcpServers?.bgos?.args
  } catch {
    return null
  }
  if (!Array.isArray(args)) return null
  const serverTs = args.find((a) => typeof a === 'string' && a.endsWith('server.ts'))
  if (!serverTs) return null
  const full = resolve(dir, serverTs)
  try {
    if (exists(full) !== true) return null
    const root = realpath(dirname(full))
    const own = realpath(resolve(String(ownRoot ?? '')))
    if (!root || !own || root === own) return null
    return { serverTs: full, root }
  } catch {
    return null
  }
}

/**
 * @param {{ installMethod: string | null | undefined, ownSpec: string,
 *   sessionSpecs: readonly string[] | null | undefined,
 *   sibling: { root: string } | null | undefined,
 *   specMatches: (listed: string, own: string) => boolean }} input
 * @returns {{ duplicate: boolean, reason: string }}
 */
export function decideDuplicateCopy({ installMethod, ownSpec, sessionSpecs, sibling, specMatches }) {
  if (installMethod !== 'marketplace') return { duplicate: false, reason: 'not a marketplace install' }
  if (!Array.isArray(sessionSpecs)) return { duplicate: false, reason: 'the session channels are unknown' }
  if (sessionSpecs.some((spec) => specMatches(spec, ownSpec))) {
    return { duplicate: false, reason: 'the session loads this copy as a channel' }
  }
  if (!sessionSpecs.includes(CLONE_SPEC)) {
    return { duplicate: false, reason: `the session does not load ${CLONE_SPEC}` }
  }
  if (!sibling) return { duplicate: false, reason: 'no checkout copy is registered in this folder' }
  return {
    duplicate: true,
    reason: `the session loads ${CLONE_SPEC} from ${sibling.root}, not ${ownSpec}`,
  }
}
