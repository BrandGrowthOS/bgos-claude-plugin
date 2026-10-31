/**
 * The pure command builders for thread lanes and By the way (Threads phase 1,
 * spec sections 7.3, 8.4 and 19).
 *
 * A thread lane is a long lived headless `claude -p` fed stream json on stdin.
 * Its first start forks the agent's MAIN session (`--resume <main>
 * --fork-session`), so the thread knows everything the chat knew; every later
 * start resumes the lane's own session id. A By the way answer is a one shot
 * fork of the main session with no tools at all.
 *
 * THE INVARIANT: a command that resumes the main session always carries
 * --fork-session. A `-p --resume <main>` without it on a running session would
 * send the question or the thread's turn as that session's next turn.
 * assertForksMain refuses to hand out such a command and both builders call
 * it.
 *
 * Both commands load an empty MCP config with --strict-mcp-config, so a lane
 * never starts a second copy of this channel plugin (which would deliver every
 * chat message twice). --mcp-config is variadic, so it stays LAST and the
 * prompt always goes on stdin (the spike, docs/thread-lanes-spike.md: a prompt
 * after it was read as a config file name).
 *
 * Erasable TypeScript only (no enums, no parameter properties).
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The tools a lane in a folder that is not a git repository may not use. */
export const READ_ONLY_DISALLOWED_TOOLS = 'Edit,Write,MultiEdit,NotebookEdit'

/** How many earlier By the way exchanges ride along with a new question. */
export const ASIDE_HISTORY_MAX = 20

/** Inside the user message, never the system prompt (spec 8.4). */
export const ASIDE_INSTRUCTION =
  '[Side question from the owner. Answer only from what you already know in this conversation. Do not use tools. Do not resume or steer the main task.]'

export const SUMMARY_INSTRUCTION =
  '[Write a short summary of this thread for the main chat: what was asked, what you did, the outcome and any open point. Markdown bullets, at most 8 lines. Reply with the summary only.]'

export type ThreadTurnMode = 'start' | 'reply' | 'summary'

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

function requireSessionId(value: unknown, what: string): string {
  if (!isSessionId(value)) throw new Error(`${what} session id is not a UUID`)
  return value
}

function requireMcpConfig(path: unknown): string {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('the empty MCP config path is missing')
  return path
}

/**
 * Throws when `args` resume the main session without --fork-session. Every
 * spelling counts: `--resume <id>`, `--resume=<id>`, `-r <id>`, and
 * `--continue` / `-c` (which resumes the folder's newest session, the main one).
 */
export function assertForksMain(args: readonly string[], mainSessionId: string): void {
  if (args.includes('--fork-session')) return
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const resumesMain =
      ((arg === '--resume' || arg === '-r') && args[i + 1] === mainSessionId) ||
      arg === `--resume=${mainSessionId}` ||
      arg === '--continue' ||
      arg === '-c'
    if (resumesMain) {
      throw new Error('refusing to resume the main session without --fork-session: it would run as that session\'s next turn')
    }
  }
}

/**
 * A thread lane. First start (no fork id yet): fork the main session. Later
 * starts: resume the lane's own session, which is not the main one, so no
 * --fork-session. A read only lane (its folder is not a git repository)
 * refuses the editing tools at the permission layer.
 */
export function threadLaneArgs(input: {
  mainSessionId: string | null | undefined
  forkSessionId: string | null | undefined
  emptyMcpConfigPath: string
  readOnly?: boolean
}): string[] {
  const mcp = requireMcpConfig(input.emptyMcpConfigPath)
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  if (input.forkSessionId != null) {
    args.push('--resume', requireSessionId(input.forkSessionId, 'the lane\'s own'))
  } else {
    args.push('--resume', requireSessionId(input.mainSessionId, 'the main'), '--fork-session')
  }
  if (input.readOnly === true) args.push('--disallowedTools', READ_ONLY_DISALLOWED_TOOLS)
  args.push('--strict-mcp-config', '--mcp-config', mcp)
  if (isSessionId(input.mainSessionId)) assertForksMain(args, input.mainSessionId)
  return args
}

/**
 * A By the way answer: a one shot fork of the main session. `--tools ""`
 * removes every tool (the spike showed `--permission-mode dontAsk` alone still
 * let Read run), dontAsk and one turn stay as belts.
 */
export function asideArgs(input: { mainSessionId: string; emptyMcpConfigPath: string }): string[] {
  const main = requireSessionId(input.mainSessionId, 'the main')
  const mcp = requireMcpConfig(input.emptyMcpConfigPath)
  const args = [
    '-p', '--resume', main, '--fork-session',
    '--tools', '',
    '--permission-mode', 'dontAsk', '--max-turns', '1',
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--strict-mcp-config', '--mcp-config', mcp,
  ]
  assertForksMain(args, main)
  return args
}

export interface AsideExchange {
  q: string
  a: string
}

/** The user message of a By the way fork: the instruction, earlier exchanges, the quote, the question. */
export function asidePrompt(question: string, quote: string, history: readonly AsideExchange[]): string {
  const parts = [ASIDE_INSTRUCTION]
  const earlier = history.slice(-ASIDE_HISTORY_MAX)
  if (earlier.length > 0) {
    parts.push(
      'Earlier side questions and your answers:\n' +
        earlier.map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n\n'),
    )
  }
  if (quote.trim() !== '') parts.push(`About this message: ${quote}`)
  parts.push(question)
  return parts.join('\n\n')
}

/** The user message a thread lane gets for one turn. */
export function threadTurnPrompt(input: {
  mode: ThreadTurnMode
  text: string
  title: string
  rootText: string
  readOnly?: boolean
}): string {
  if (input.mode === 'summary') return SUMMARY_INSTRUCTION
  if (input.mode === 'reply') return input.text
  const readOnly = input.readOnly === true
    ? ' This folder is not a git repository, so this thread is read only: do not edit files.'
    : ''
  // The root's own full stop is kept, never doubled.
  const root = input.rootText.trim()
  const rootSentence = /[.!?]$/.test(root) ? root : `${root}.`
  return (
    `[You are now working in a thread of this chat titled "${input.title}". ` +
    `It is a separate conversation about this message: ${rootSentence} ` +
    `Work on it in this folder only.${readOnly} The main conversation continues without you.]\n\n` +
    input.text
  )
}

/** A thread reply is final unless it ends asking the person a question. */
export function isFinalReply(text: string): boolean {
  return !text.trim().endsWith('?')
}
