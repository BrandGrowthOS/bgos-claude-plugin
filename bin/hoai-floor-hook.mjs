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
 * 2. IT FAILS OPEN ON WHAT IT CANNOT READ, AND ASKS ON WHAT IT READ AND COULD
 *    NOT CHECK. Bad JSON, an empty stdin, a core that will not load, or a
 *    budget that runs out before the call is read all end the same way:
 *    nothing on stdout and exit code 0, so the call runs as it would have
 *    without this hook. A floor hook that failed closed there would stop
 *    every shell call of every install, including the many whose owner never
 *    turned the switch on. But a call it did read is never let through
 *    unchecked (the fix round, hf28): a classifier that throws, or that
 *    has not answered by the budget, asks (FLOOR_HOOK_UNCHECKED_WORDS), and so
 *    does a shell command longer than the list reads (the core's
 *    HARD_FLOOR_MAX_TEXT, FLOOR_HOOK_TOO_LONG_WORDS), unless the part it read
 *    already names a kind, and so does a call whose read stopped at the
 *    list's nesting limit (`eval` five deep, the core's readToolCall). A
 *    shell command longer than FLOOR_HOOK_INLINE_MAX is read on a worker
 *    thread the budget can stop, since a timer cannot stop a read in this
 *    one. Those asks leave no floor record,
 *    since no kind was read: the relay finds a cut preview with no record and
 *    asks the server (planFloorRequest ask_elided), where the owner's switch
 *    decides. Like every ask, only in a session a HOAI daemon is attached to.
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

/**
 * A shell command longer than this is read on a worker thread. The list reads
 * up to its own limit (the core's HARD_FLOOR_MAX_TEXT, a megabyte), and even
 * read in step with its length a megabyte of some shapes (a line of `$[]`
 * each, a group each) takes it one to three seconds: past the budget, near
 * the CLI's own kill, and a timer cannot stop a read in the hook's thread.
 * A worker can be stopped: a read it has not finished by the budget asks
 * (FLOOR_HOOK_UNCHECKED_WORDS). It was 64 KiB, and the fix round's review
 * found shapes that took 6 s inline under it, so the CLI killed the hook and
 * nothing asked. Under 4 KiB a nested shape still read for 1.8 s, because a
 * script was read again at each level (the second review); the core now
 * reads a text once per depth and lexes at most eight times its length plus
 * 16 KB, then stops and says so (the hook asks), so the slowest shape
 * measured under 4 KiB reads in tens of milliseconds. Ordinary commands stay
 * on this thread, and a worker costs its start (tens of milliseconds) only
 * for a longer command.
 */
export const FLOOR_HOOK_INLINE_MAX = 4 * 1024

/** What a reading off the hook's thread can answer: the match (or null) and whether it stopped early, a throw, or nothing in time. */
const CORE_URL = new URL('../lib/hard-floor-core.mjs', import.meta.url).href
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.coreUrl).then(
  (core) => {
    let answer
    try {
      const read = core.readToolCall(workerData.name, workerData.input)
      answer = { match: read.lead ?? null, stoppedEarly: read.stoppedEarly === true }
    } catch {
      answer = { threw: true }
    }
    parentPort.postMessage(answer)
  },
  () => parentPort.postMessage({ threw: true }),
)
`

/** The question for a call the hook read and could not check: its classifier threw, or answered after the budget. */
export const FLOOR_HOOK_UNCHECKED_WORDS = 'an action the safety check could not finish checking'

/** The question for a shell command longer than the hook reads. */
export const FLOOR_HOOK_TOO_LONG_WORDS = 'a command too long to check in full'

/** The shell tools whose command is read as shell text (the core's FLOOR_SHELL_TOOLS). */
const SHELL_TOOLS = ['Bash', 'PowerShell']

/** The list's own size limit, as the core says it (a megabyte when a core does not say). */
const listReads = (core) =>
  typeof core?.HARD_FLOOR_MAX_TEXT === 'number' && core.HARD_FLOOR_MAX_TEXT > 0 ? core.HARD_FLOOR_MAX_TEXT : 1024 * 1024

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
 * EVERY KIND, THE MOST DANGEROUS FIRST (0.88.1). A call can fall under more
 * than one kind (an `.env` append, then a key file uploaded with `curl -T`).
 * The hook reads them all (the core's classifyToolCallLead): its reason names
 * the most dangerous kind, and the match it records carries every kind in
 * `ruleIds` and every kind's command in `evidence`, so the relay can tell the
 * server about all of them, not only the first in the list's order.
 *
 * A CALL IT READ IS NEVER LET THROUGH UNCHECKED (rule 2): a classifier that
 * throws, or returns after `clock.deadline`, asks with
 * FLOOR_HOOK_UNCHECKED_WORDS, and a shell command longer than the list reads
 * (the core's HARD_FLOOR_MAX_TEXT), when the part it read names no kind,
 * asks with FLOOR_HOOK_TOO_LONG_WORDS, and a read that stopped at the list's
 * nesting limit (the core's readToolCall `stoppedEarly`) asks with
 * FLOOR_HOOK_UNCHECKED_WORDS. None of them leaves a record. A classifier that
 * answers something that is not a match is read as no match.
 *
 * @param {string} text the raw stdin
 * @param {{ classifyToolCallLead: (name: unknown, input: unknown) => { words: string } | null,
 *   readToolCall?: (name: unknown, input: unknown) => { lead: { words: string } | null, stoppedEarly: boolean } }} core
 * @param {{ attachedKey: (payload: any) => string | null,
 *   recordAsk: (key: string, payload: any, match: any) => unknown }} [deps]
 * @param {{ deadline?: number, now?: () => number }} [clock] performance.now() time past which a quiet answer is late
 */
export function decideFloorHook(text, core, deps, clock = {}) {
  try {
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return ''
    const payload = JSON.parse(trimmed)
    if (!isRecord(payload)) return ''
    const event = payload.hook_event_name
    if (event !== undefined && event !== 'PreToolUse') return ''
    const command = shellCommandOf(payload)
    const tooLong = command !== null && command.length > listReads(core)
    let words = ''
    let match = null
    let stoppedEarly = false
    try {
      ;({ match, stoppedEarly } = readCall(core, payload.tool_name, payload.tool_input))
    } catch {
      words = FLOOR_HOOK_UNCHECKED_WORDS
    }
    const named = !words && isRecord(match) && typeof match.words === 'string' && match.words !== ''
    if (named) words = match.words
    else if (!words && tooLong) words = FLOOR_HOOK_TOO_LONG_WORDS
    else if (!words && stoppedEarly) words = FLOOR_HOOK_UNCHECKED_WORDS
    else if (!words && typeof clock.deadline === 'number' && (clock.now ? clock.now() : performance.now()) > clock.deadline) {
      words = FLOOR_HOOK_UNCHECKED_WORDS
    }
    if (!words) return ''
    if (deps) {
      const key = deps.attachedKey(payload)
      if (!key) return ''
      if (named) {
        try {
          deps.recordAsk(key, payload, match)
        } catch {
          /* the record is the relay's aid; the ask stands without it */
        }
      }
    }
    return floorAskOutput(words)
  } catch {
    return ''
  }
}

/**
 * The core's answer for one call: its lead, and whether the read stopped at
 * the list's nesting limit (readToolCall), or the lead alone from a core
 * that only has classifyToolCallLead.
 * @param {any} core @param {unknown} name @param {unknown} input
 * @returns {{ match: unknown, stoppedEarly: boolean }}
 */
function readCall(core, name, input) {
  if (typeof core.readToolCall === 'function') {
    const read = core.readToolCall(name, input)
    return { match: isRecord(read) ? read.lead : null, stoppedEarly: isRecord(read) && read.stoppedEarly === true }
  }
  return { match: core.classifyToolCallLead(name, input), stoppedEarly: false }
}

/** A shell tool's command, or null for any other call. @param {any} payload */
function shellCommandOf(payload) {
  const input = payload.tool_input
  if (!SHELL_TOOLS.includes(payload.tool_name) || !isRecord(input)) return null
  return typeof input.command === 'string' ? input.command : null
}

/**
 * Read one call on a worker thread, given `msLeft` to answer. Resolves
 * `{ match, stoppedEarly }` (a match or null, and whether the read stopped
 * at the list's nesting limit), `{ threw: true }` (the reading or the core
 * load failed), `{ late: true }` (no answer in time; the worker is stopped),
 * or `{ inline: true }` when no worker can be started here (the caller reads
 * it inline, as before). Never rejects.
 * @param {unknown} name @param {unknown} input @param {number} msLeft
 */
export function readOffThread(name, input, msLeft) {
  return import('node:worker_threads').then(
    ({ Worker }) =>
      new Promise((resolve) => {
        let worker = null
        let settled = false
        const settle = (answer) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(answer)
          if (worker) worker.terminate().catch(() => {})
        }
        const timer = setTimeout(() => settle({ late: true }), Math.max(0, msLeft))
        try {
          worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { coreUrl: CORE_URL, name, input } })
        } catch {
          settle({ inline: true })
          return
        }
        worker.once('message', (answer) => settle(isRecord(answer) ? answer : { threw: true }))
        worker.once('error', () => settle({ threw: true }))
        worker.once('exit', () => settle({ threw: true }))
      }),
    () => ({ inline: true }),
  )
}

/**
 * decideFloorHook for a call already read, inside the budget: inline for
 * most calls, and on a worker thread (`offThread`, readOffThread) for a
 * shell command longer than FLOOR_HOOK_INLINE_MAX, whose answer then goes
 * through decideFloorHook as if the core had given it, so the two ways
 * decide alike: a throw or no answer in time asks (FLOOR_HOOK_UNCHECKED_WORDS).
 * Never throws.
 */
async function decideInTime(text, core, deps, deadline, offThread) {
  let call = null
  try {
    const payload = JSON.parse(String(text ?? '').trim())
    const command = isRecord(payload) ? shellCommandOf(payload) : null
    if (command !== null && command.length > FLOOR_HOOK_INLINE_MAX) call = payload
  } catch {
    /* decideFloorHook reads the same text and answers nothing for it */
  }
  if (!call || !offThread) return decideFloorHook(text, core, deps, { deadline })
  let answer
  try {
    answer = await offThread(call.tool_name, call.tool_input, deadline - performance.now())
  } catch {
    answer = { threw: true }
  }
  if (isRecord(answer) && answer.inline === true) return decideFloorHook(text, core, deps, { deadline })
  const given = {
    HARD_FLOOR_MAX_TEXT: listReads(core),
    classifyToolCallLead: () => {
      throw new Error('read through readToolCall')
    },
    readToolCall: () => {
      if (isRecord(answer) && 'match' in answer) return { lead: answer.match, stoppedEarly: answer.stoppedEarly === true }
      throw new Error('not checked in time')
    },
  }
  return decideFloorHook(text, given, deps)
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
 * The budget bounds READING the call (stdin, the core, the state files):
 * not read by then, nothing is printed (rule 2). Once read, the call is
 * decided inside what is left of it (decideInTime), and a reading that does
 * not finish asks. `onDecided` hears the answer once it is known, before it
 * is written: the entry point stops its hard stop there, so a late ask is
 * not cut off. `offThread` reads a long shell command (readOffThread).
 *
 * @param {{ stdin?: AsyncIterable<Buffer|string>, write?: (text: string) => Promise<void>,
 *   budgetMs?: number, loadCore?: () => Promise<any>, loadState?: () => Promise<any>,
 *   env?: Record<string, string | undefined>, stateRoot?: string, maxBytes?: number,
 *   onDecided?: (answer: string) => void,
 *   offThread?: ((name: unknown, input: unknown, msLeft: number) => Promise<unknown>) | null }} [opts]
 */
export async function main(opts = {}) {
  const budgetMs = opts.budgetMs ?? FLOOR_HOOK_BUDGET_MS
  const deadline = performance.now() + budgetMs
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
      if (text === null) return null
      return { text, core, state }
    })()
    // A late failure of the losing side must not surface as an unhandled
    // rejection after the race is decided.
    work.catch(() => {})
    const read = await Promise.race([work, budget])
    clearTimeout(timer)
    if (read !== BUDGET_SPENT && isRecord(read)) {
      const decided = await decideInTime(
        read.text,
        read.core,
        floorDeps(read.state, { env: opts.env ?? process.env, root: opts.stateRoot }),
        deadline,
        opts.offThread === undefined ? readOffThread : opts.offThread,
      )
      out = typeof decided === 'string' ? decided : ''
    }
  } catch {
    out = ''
  } finally {
    clearTimeout(timer)
  }
  try {
    opts.onDecided?.(out)
  } catch {
    /* the entry point's own concern; the answer stands */
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
  // shortly after it, with exit code 0 and nothing more on stdout. Once the
  // answer is known (a classifier that ran late still answers, since a timer
  // cannot fire during its read), the stop gives the write a short time of
  // its own instead, so a late ask is written, not cut off.
  let hardStop = setTimeout(() => process.exit(0), FLOOR_HOOK_BUDGET_MS + 300)
  const onDecided = () => {
    clearTimeout(hardStop)
    hardStop = setTimeout(() => process.exit(0), 500)
  }
  main({ onDecided }).then(
    () => {
      clearTimeout(hardStop)
      process.exit(0)
    },
    () => process.exit(0),
  )
}
