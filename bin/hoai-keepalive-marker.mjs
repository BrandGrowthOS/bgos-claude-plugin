#!/usr/bin/env node
/**
 * hoai-keepalive-marker: let a keepalive SCRIPT declare itself to the daemon
 * it just launched, so a one-click update can restart the session.
 *
 * WHY THIS EXISTS. On KC's Mac every agent is started by a keepalive: a
 * launchd job `ai.bgos.session.<id>` runs `~/.bgos-session-<id>/keepalive.sh`,
 * which starts claude inside a DETACHED tmux session and waits; when claude
 * exits the script relaunches it within seconds. That is a real restart
 * authority, but launchd's pid is nowhere in the daemon's ancestry (the chain
 * is claude > expect > tmux server > launchd), so the daemon's ownership
 * pre-flight refused it and every one-click update stopped at "restart
 * pending" (2026-09-13, nine sessions). This marker is how the keepalive says
 * "I launched THIS session and I will bring it back", in a form the daemon can
 * verify rather than take on trust.
 *
 * USAGE, from inside the keepalive, once the session is up:
 *
 *   node <plugin>/bin/hoai-keepalive-marker.mjs \
 *     --assistant 910 --keepalive-pid $$ --claude-pid "$cpid" --tmux agent-910
 *
 * `cpid` is the claude process the keepalive launched, which the script
 * already knows how to find (its own `running()` helper matches a claude whose
 * cwd is the agent's workspace). Writing the marker BEFORE that pid is known
 * is worse than not writing it: the daemon verifies the session pid is one of
 * its own ancestors, so a guess is simply ignored.
 *
 * What it writes, to ~/.bgos-agent/<id>/keepalive.json:
 *   {"kind":"keepalive","pid":<script pid>,"claudePid":<session pid>,
 *    "tmuxSession":<name|null>,"capabilities":["relaunch"],"startedAt":<iso>}
 *
 * The daemon (lib/update-readiness.ts resolveKeepalive) accepts it only while
 * the script pid is ALIVE and the session pid is one of its own ancestors, and
 * restarts by sending SIGTERM to that session pid. A stale marker, another
 * agent's marker, or one from a keepalive that has exited all read as no
 * authority, and the daemon falls back to the older tiers exactly as before.
 *
 * Exit codes: 0 written, 1 bad arguments, 2 could not write. A keepalive
 * should not abort its launch on a non-zero exit here; the worst case is the
 * pre-marker behaviour.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { KEEPALIVE_MARKER_FILE_NAME, keepaliveMarkerBody } from './hoai-core.mjs'

/**
 * `--flag value` and `--flag=value`, nothing else. Unknown flags are ignored
 * rather than rejected, so a keepalive that passes an extra hint to a newer
 * writer still works against an older one.
 * @param {readonly string[]} argv
 * @returns {Record<string, string>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {}
  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i += 1) {
    const arg = String(list[i] ?? '')
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq > -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1)
    else flags[arg.slice(2)] = String(list[i + 1] ?? '')
  }
  return flags
}

/** Digits only, mirroring bin/bgos-agent valid_id and the daemon's own reader. */
function validId(value) {
  const id = String(value ?? '').trim()
  return /^\d+$/.test(id) ? id : null
}

/** An integer above 1: pid 1 is init, which restarts no one. */
function validPid(value) {
  const raw = String(value ?? '').trim()
  if (!/^\d+$/.test(raw)) return null
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 1 ? pid : null
}

/**
 * The whole decision, pure so it is unit-testable without a disk or a process:
 * argv in, the file to write and its body out. Anything missing or unusable is
 * 'usage', which writes NOTHING: a marker the daemon would reject is no better
 * than no marker, and a marker with a wrong pid is worse.
 * @param {{ argv: readonly string[], home: string, startedAt: string }} input
 * @returns {{ action: 'write', path: string, body: string } | { action: 'usage' }}
 */
export function decideKeepaliveMarkerWrite({ argv, home, startedAt }) {
  const flags = parseArgs(argv)
  const id = validId(flags.assistant)
  const pid = validPid(flags['keepalive-pid'])
  const claudePid = validPid(flags['claude-pid'])
  if (!id || pid === null || claudePid === null) return { action: 'usage' }
  const tmuxSession = String(flags.tmux ?? '').trim() || null
  return {
    action: 'write',
    path: join(home, '.bgos-agent', id, KEEPALIVE_MARKER_FILE_NAME),
    body: keepaliveMarkerBody({ pid, claudePid, tmuxSession, startedAt }),
  }
}

const USAGE =
  'usage: hoai-keepalive-marker --assistant <id> --keepalive-pid <pid> ' +
  '--claude-pid <pid> [--tmux <session>]\n'

/** @param {readonly string[]} argv */
export function main(argv) {
  const decision = decideKeepaliveMarkerWrite({
    argv,
    home: homedir(),
    startedAt: new Date().toISOString(),
  })
  if (decision.action !== 'write') {
    process.stderr.write(USAGE)
    return 1
  }
  try {
    mkdirSync(dirname(decision.path), { recursive: true })
    writeFileSync(decision.path, `${decision.body}\n`)
  } catch (err) {
    process.stderr.write(
      `hoai-keepalive-marker: could not write ${decision.path}: ${String(err)}\n`,
    )
    return 2
  }
  process.stdout.write(`${decision.path}\n`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
