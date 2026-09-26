#!/usr/bin/env node
/**
 * hoai-floor-hook: the hard floor's blocking PreToolUse hook (0.53.0).
 *
 * THE ONE BLOCKING HOOK THIS PLUGIN REGISTERS, and it is a different script
 * from the telemetry forwarder (bin/hoai-hook.mjs) on purpose: the forwarder
 * stays async and can never stop a tool call, this one exists to stop a few.
 *
 * Claude Code runs it before every shell, edit and MCP tool call (the matcher
 * in hooks/hooks.json), with the call as JSON on stdin. When the call is on
 * the hard floor's short list (lib/hard-floor-core.mjs: a recursive delete, a
 * force push, a change inside .git, to an .env file or to a settings file in
 * the home folder, an MCP tool that sends, posts, pays or deletes), it prints
 *
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *     "permissionDecision":"ask","permissionDecisionReason":"<the rule's words>"}}
 *
 * and the CLI raises a permission request even under
 * --dangerously-skip-permissions (map part 24, run D1). The request reaches
 * the permission relay in server.ts, which asks the server whether this
 * agent's owner turned on "Always ask before risky actions": if so the owner
 * gets the card and nothing runs until they answer; if not, the relay allows
 * it as it always did. Anything else: nothing on stdout, and the call runs.
 *
 * ONLY IN A SESSION A HOAI DAEMON IS ATTACHED TO. The plugin's hooks run in
 * every session on a machine that has it enabled, and an ask with no relay
 * behind it is a terminal prompt (or, headless, a call nobody can answer)
 * that the owner never switched on. So a match asks only when the daemon's
 * attached marker for this session's folder is present and its pid alive
 * (lib/floor-state.mjs); anywhere else the hook prints nothing, exactly as
 * before 0.53.0.
 *
 * AND IT LEAVES A RECORD FOR THE RELAY. Before it asks, it writes a floor
 * record (the rule, the matched command, the session's permission mode) under
 * the plugin state folder, because the request the CLI then sends the relay
 * carries the input only as a preview the CLI cuts in the middle when it is
 * long, and the relay must hold what the hook matched, not what survived the
 * cut. A record that cannot be written does not stop the ask.
 *
 * Rules this file exists to hold:
 *
 * 1. IT ONLY EVER ASKS. It never prints `deny` and never exits 2. A deny is a
 *    hard stop the owner cannot override from the phone (part 24, run D2);
 *    the floor is a question for the owner, not a wall.
 * 2. IT FAILS OPEN. Bad JSON, an empty stdin, a classifier that throws, a core
 *    that will not load, or a budget that runs out all end the same way:
 *    nothing on stdout and exit code 0, so the call runs as it would have
 *    without this hook. A floor hook that failed closed would stop every
 *    shell call of every install, including the many whose owner never turned
 *    the switch on.
 * 3. IT HAS A HARD BUDGET UNDER TWO SECONDS (FLOOR_HOOK_BUDGET_MS), inside the
 *    manifest's 3 second timeout, so the CLI never has to kill it and a stuck
 *    stdin cannot hold a tool call.
 * 4. IT OPENS NO SOCKET AND READS NO CREDENTIALS, like the forwarder. It does
 *    not know the owner's switch and does not try to: the relay asks the
 *    server. It knows the list, and it reads and writes two small files under
 *    the plugin state folder (the attached marker, its own floor record).
 * 5. IT READS STDIN AS BYTES and decodes UTF-8 itself (the forwarder's rule 2:
 *    a Windows console code page once crashed a text mode read).
 *
 * The hook runs on `node`, the same runtime the plugin's own MCP server is
 * launched with (.claude-plugin/plugin.json), so a host that cannot run this
 * hook cannot run the channel either. Plain JavaScript, node >= 18, import
 * safe: main() runs only when this file is argv[1].
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The whole hook, stdin to stdout, must finish inside this or give up. */
export const FLOOR_HOOK_BUDGET_MS = 1500

/** A Write can carry a whole file; past this the payload is not read (open). */
export const FLOOR_HOOK_STDIN_MAX_BYTES = 16 * 1024 * 1024

const BUDGET_SPENT = Symbol('budget spent')

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The core, loaded lazily so a load failure is caught like any other. */
export function loadFloorCore() {
  return import('../lib/hard-floor-core.mjs')
}

/** The marker and record files, loaded the same way. */
export function loadFloorState() {
  return import('../lib/floor-state.mjs')
}

/**
 * The two host side steps, bound to one state root and environment: is a
 * HOAI daemon attached to this session, and leave the relay the record.
 * Each fails on its own terms: an unreadable marker is not attached (the
 * hook stays silent, as before 0.53.0); an unwritable record still asks.
 */
export function floorDeps(state, { env = process.env, root } = {}) {
  const stateRoot = root ?? state.floorStateRoot(env)
  return {
    attachedKey: (payload) =>
      state.findAttachedKey({ root: stateRoot, folders: state.sessionFolders(payload, env) }),
    recordAsk: (key, payload, match) =>
      state.writeFloorRecord({
        root: stateRoot,
        key,
        record: state.buildFloorRecord({
          toolName: payload.tool_name,
          toolInput: payload.tool_input,
          match,
          payload,
        }),
      }),
  }
}

/** The exact line printed for a match. Pure. */
export function floorAskOutput(words) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: String(words ?? ''),
    },
  })
}

/**
 * What to print for one hook payload: the ask line, or '' for nothing.
 * Never throws: every failure is ''.
 *
 * `deps` is the host side (floorDeps): with it, a match asks only in a
 * session a HOAI daemon is attached to, and leaves its floor record first.
 * main() always passes it; without it this is the bare list contract the
 * tests pin rule by rule.
 *
 * @param {string} text the raw stdin
 * @param {{ classifyToolCall: (name: unknown, input: unknown) => { words: string } | null }} core
 * @param {{ attachedKey: (payload: any) => string | null,
 *   recordAsk: (key: string, payload: any, match: any) => unknown }} [deps]
 */
export function decideFloorHook(text, core, deps) {
  try {
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return ''
    const payload = JSON.parse(trimmed)
    if (!isRecord(payload)) return ''
    const event = payload.hook_event_name
    if (event !== undefined && event !== 'PreToolUse') return ''
    const match = core.classifyToolCall(payload.tool_name, payload.tool_input)
    if (!match || typeof match.words !== 'string' || !match.words) return ''
    if (deps) {
      const key = deps.attachedKey(payload)
      if (!key) return ''
      try {
        deps.recordAsk(key, payload, match)
      } catch {
        /* the record is the relay's aid; the ask stands without it */
      }
    }
    return floorAskOutput(match.words)
  } catch {
    return ''
  }
}

/** Read the whole of a stream as BYTES, bounded, then decode UTF-8. Resolves
 *  null when the payload is over the bound (the floor does not guess). */
export async function readStdinBytes(stream, maxBytes = FLOOR_HOOK_STDIN_MAX_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    total += buf.length
    if (total > maxBytes) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeOut(text) {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, () => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * The hook, with every edge injectable for the tests. Resolves with what it
 * printed ('' for nothing). Never rejects.
 *
 * @param {{ stdin?: AsyncIterable<Buffer|string>, write?: (text: string) => Promise<void>,
 *   budgetMs?: number, loadCore?: () => Promise<any>, loadState?: () => Promise<any>,
 *   env?: Record<string, string | undefined>, stateRoot?: string, maxBytes?: number }} [opts]
 */
export async function main(opts = {}) {
  const budgetMs = opts.budgetMs ?? FLOOR_HOOK_BUDGET_MS
  const write = opts.write ?? writeOut
  const loadCore = opts.loadCore ?? loadFloorCore
  const loadState = opts.loadState ?? loadFloorState
  let timer
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_SPENT), budgetMs)
  })
  let out = ''
  try {
    const work = (async () => {
      const [text, core, state] = await Promise.all([
        readStdinBytes(opts.stdin ?? process.stdin, opts.maxBytes),
        loadCore(),
        loadState(),
      ])
      if (text === null) return ''
      return decideFloorHook(
        text,
        core,
        floorDeps(state, { env: opts.env ?? process.env, root: opts.stateRoot }),
      )
    })()
    // A late failure of the losing side must not surface as an unhandled
    // rejection after the race is decided.
    work.catch(() => {})
    const result = await Promise.race([work, budget])
    out = result === BUDGET_SPENT || typeof result !== 'string' ? '' : result
  } catch {
    out = ''
  } finally {
    clearTimeout(timer)
  }
  if (out) {
    try {
      await write(out)
    } catch {
      /* nothing more can be done, and the answer is still exit 0 */
    }
  }
  process.exitCode = 0
  return out
}

/**
 * Is this file the process's entry point? The URL comparison is the fast
 * path; the realpath comparison catches a plugin root reached through a
 * symlink, where node resolves the module's own URL and argv keeps the link.
 * A false NO here would be a floor that silently never runs, so both are
 * tried. The tests import this file and are never the entry point.
 */
export function isEntryPoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string' || !argv1) return false
  try {
    if (moduleUrl === pathToFileURL(argv1).href) return true
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  // The last word on the budget: whatever main is doing, the process is gone
  // shortly after it, with exit code 0 and nothing more on stdout.
  const hardStop = setTimeout(() => process.exit(0), FLOOR_HOOK_BUDGET_MS + 300)
  main().then(
    () => {
      clearTimeout(hardStop)
      process.exit(0)
    },
    () => process.exit(0),
  )
}
