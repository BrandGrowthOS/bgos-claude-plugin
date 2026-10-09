/**
 * Is THIS daemon's channel loaded in its Claude Code session (0.63.2)?
 *
 * THE BUG (assistant 873, 2026-10-09). A session launched with
 * `--dangerously-load-development-channels server:bgos` (a clone registered in
 * .mcp.json as `bgos`) whose global settings also enable the hoai@hoai
 * marketplace plugin starts TWO daemons for one pairing: the clone, whose
 * channel is loaded, and the plugin, whose channel is not (no
 * `plugin:hoai@hoai` on the command line). Both race for the pairing lock.
 * When the plugin won, every inbound message was pushed into a channel the
 * session never registered, and Claude Code drops those silently: five hours
 * offline with both processes healthy.
 *
 * WHICH SIGNAL IS REAL (proven 2026-10-09 on macOS, Claude Code 2.1.295, with
 * two probe MCP servers in one interactive session). Two MCP servers in one session, one named in
 * --dangerously-load-development-channels and one not, received byte for byte
 * the same `initialize` request (same capabilities, same clientInfo) and the
 * same environment; only the named one's notifications/claude/channel push
 * reached the session. So the client tells a server nothing at initialize.
 * What does differ is the claude process's own argv, which every MCP server
 * can read from its ancestry: `--channels <specs...>` and
 * `--dangerously-load-development-channels <specs...>` (both commander
 * variadics, space separated) list exactly the channels that session
 * registers. Matched against this daemon's own identity (a marketplace
 * install is `plugin:<plugin>@<marketplace>`, read off its cache path; a
 * clone is `server:bgos`, the name every launcher and the README register it
 * under), that answers the question.
 *
 * FAIL OPEN. Every answer we cannot prove is `null` (unknown), and unknown
 * means the lock behaves exactly as before this module existed: no claude
 * ancestor found, a command line we could not read, Windows (no ps), an
 * install we could not identify, or a clone whose session names some other
 * `server:` channel (the clone may simply be registered under that name).
 * Also a claude command line that is ONLY `claude`: the binary sets
 * process.title to "claude", and on Linux a title rewrite can overwrite argv
 * in place, so a bare line may be a hidden one rather than a session with no
 * flags. Unverified on Linux, so it fails open.
 *
 * Pure core (parseChannelSpecs, specMatches, decideChannelLoaded) plus a thin
 * shell (probeChannelLoaded) whose every process read is injected.
 */

import { readProcessAncestry, type SyncExecResult } from './update-readiness.js'

/** The two flags whose values are the channels a session registers. */
export const CHANNEL_FLAGS = ['--channels', '--dangerously-load-development-channels'] as const

/** What we concluded, and why, for the log line and the lock record. */
export interface ChannelPresence {
  /** true: our spec is on the claude command line. false: provably not.
   *  null: unknown, so the lock keeps today's behaviour. */
  loaded: boolean | null
  /** A short human reason, safe to log (specs and flags only, never a path
   *  or anything secret). */
  reason: string
}

/**
 * The channel specs a claude command line registers, in order. ps hands us
 * the argv joined by spaces with the quoting gone, which is fine here: a spec
 * (`plugin:x@y`, `server:x`) never contains a space. A variadic flag takes
 * every following token up to the next one that starts with `-`; the
 * `--flag=value` form carries one value. Empty when neither flag is present.
 */
export function parseChannelSpecs(command: string | readonly string[]): string[] {
  const tokens = Array.isArray(command)
    ? command.map(String)
    : String(command ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
  const flags: readonly string[] = CHANNEL_FLAGS
  const specs: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const eq = token.indexOf('=')
    if (eq > 0 && flags.includes(token.slice(0, eq))) {
      const value = token.slice(eq + 1)
      if (value) specs.push(value)
      continue
    }
    if (!flags.includes(token)) continue
    while (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
      specs.push(tokens[i + 1])
      i++
    }
  }
  return specs
}

/**
 * Does a listed spec name us? Exact, plus one tolerance: `plugin:hoai` with
 * no marketplace names the plugin in whatever marketplace it is installed
 * from, so it matches `plugin:hoai@<any>`.
 */
export function specMatches(listed: string, ownSpec: string): boolean {
  if (!listed || !ownSpec) return false
  if (listed === ownSpec) return true
  if (ownSpec.startsWith('plugin:') && listed.startsWith('plugin:') && !listed.includes('@')) {
    const at = ownSpec.indexOf('@')
    return (at < 0 ? ownSpec : ownSpec.slice(0, at)) === listed
  }
  return false
}

/**
 * THE PURE DECISION. `ownSpec` is how a session would name this daemon's
 * channel (empty when the install is unidentified); `claudeCommand` is the
 * command line of the claude process above us (null when none was found or
 * it could not be read).
 *
 *   no identity, or no claude command      -> null (fail open)
 *   a bare `claude`, no arguments at all   -> null (argv may be hidden by a
 *                                             process title rewrite)
 *   our spec is listed                     -> true
 *   no channel flag at all                 -> false (the session loads none)
 *   a plugin spec, ours not listed         -> false (a plugin's spec is its
 *                                             exact identity)
 *   a server spec, some other server:
 *     name listed                          -> null (we may be registered
 *                                             under that name; cannot prove)
 *   a server spec, only plugin: specs      -> false
 */
export function decideChannelLoaded(input: {
  ownSpec: string
  claudeCommand: string | null
}): ChannelPresence {
  const ownSpec = String(input.ownSpec ?? '').trim()
  if (!ownSpec) return { loaded: null, reason: 'install not identified' }
  if (input.claudeCommand == null || !String(input.claudeCommand).trim()) {
    return { loaded: null, reason: 'claude command line not readable' }
  }
  if (String(input.claudeCommand).trim().split(/\s+/).length < 2) {
    return { loaded: null, reason: 'claude command line shows no arguments (possibly a rewritten process title)' }
  }
  const specs = parseChannelSpecs(input.claudeCommand)
  if (specs.some((s) => specMatches(s, ownSpec))) {
    return { loaded: true, reason: `${ownSpec} is on the claude command line` }
  }
  if (specs.length === 0) {
    return { loaded: false, reason: 'the claude command line loads no channel' }
  }
  if (ownSpec.startsWith('server:') && specs.some((s) => s.startsWith('server:'))) {
    return { loaded: null, reason: `the claude command line names ${specs.join(' ')}, not ${ownSpec}; cannot tell` }
  }
  return { loaded: false, reason: `the claude command line loads ${specs.join(' ')}, not ${ownSpec}` }
}

/**
 * Is this command line a claude session? The native binary by basename
 * (`claude`, `claude.exe`, or a versioned binary under .../claude/versions/),
 * or the npm install's cli.js run by node. Mirrors lib/process-tree.mjs
 * isClaudeCommand, plus the versioned binary path.
 */
export function isClaudeCommandLine(command: string | null | undefined): boolean {
  const text = String(command ?? '').trim()
  if (!text) return false
  const first = text.split(/\s+/)[0]
  const base = first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1).toLowerCase()
  if (base === 'claude' || base === 'claude.exe') return true
  if (/[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(first)) return true
  return /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.m?js(?:\s|$)/.test(text)
}

/** `ps -ww -o command= -p <pid>`: the full command line, or null. `-ww`
 *  matters: procps can cut a piped listing at 80 columns, and 873's launch
 *  line is longer than that with the channel flag at its end. */
export function readFullCommand(
  pid: number,
  execSync: (file: string, args: string[]) => SyncExecResult,
): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    const result = execSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)])
    const text = String(result.stdout ?? '').trim()
    return result.code === 0 && text && !text.includes('\n') ? text : null
  } catch {
    return null
  }
}

/**
 * The effectful shell: walk up from our pid to the nearest claude, read its
 * command line, decide. Windows answers null (no ps; fail open). Never throws.
 */
export function probeChannelLoaded(input: {
  platform: string
  ownPid: number
  ownSpec: string
  execSync: (file: string, args: string[]) => SyncExecResult
}): ChannelPresence {
  try {
    if (input.platform === 'win32') return { loaded: null, reason: 'not read on Windows' }
    if (!String(input.ownSpec ?? '').trim()) return { loaded: null, reason: 'install not identified' }
    const ancestry = readProcessAncestry(input.ownPid, input.execSync)
    for (const pid of ancestry.slice(1)) {
      const command = readFullCommand(pid, input.execSync)
      if (isClaudeCommandLine(command)) {
        return decideChannelLoaded({ ownSpec: input.ownSpec, claudeCommand: command })
      }
    }
    return { loaded: null, reason: 'no claude process above this daemon' }
  } catch {
    return { loaded: null, reason: 'claude command line not readable' }
  }
}
