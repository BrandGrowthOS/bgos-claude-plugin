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
 * CONFINEMENT (spec 7.3; measured on CLI 2.1.316, docs/thread-lanes-spike.md
 * section (g)): a lane never inherits the owner's permission settings. It runs
 * `--restricted` (user, project and local settings ignored, the file tools
 * confined to its working directories, bypass refused), with its own tool
 * list, its own permission mode and its own `--settings`: edits allowed only
 * under its worktree, and Bash only inside the CLI's sandbox, whose writes
 * stop at the worktree (plus the git state the worktree needs, minus the
 * source repository's index, HEAD and other branches). A read only lane has
 * no Bash and no editing tool at all. assertConfined refuses any lane command
 * without these flags.
 *
 * SELECTIVE HOOKS (THREADGOAL2): --restricted drops inherited settings and
 * plugins. Reinstall this plugin's trusted non-Stop hooks explicitly. The
 * manager clears the active goal only in the child transcript before resume,
 * using the CLI's goal-clear sentinel, so its session Stop hook is not restored.
 * Other hook events remain enabled, including the private prompt boundary,
 * tool floor and private tool guard. Never disable all hooks in a thread.
 *
 * Erasable TypeScript only (no enums, no parameter properties).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { permissionRulePath } from './lane-core.mjs'

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A working lane's tools: Bash only when the host can sandbox it (threadLaneTools). */
export const THREAD_LANE_TOOLS: readonly string[] = Object.freeze([
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch',
])

/** A read only lane's tools (its folder is not a git repository): it reads, it never writes. */
export const THREAD_LANE_READ_ONLY_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

/** Refused outright in a read only lane, a belt under the tool list that already leaves them out. */
export const READ_ONLY_DENIED_TOOLS: readonly string[] = Object.freeze(['Bash', 'Edit', 'Write', 'NotebookEdit'])

/**
 * The Bash sandbox a working lane runs under. allowUnsandboxedCommands false,
 * or one `dangerouslyDisableSandbox` argument undoes it (spike S6 for person
 * lanes, measured again for thread lanes).
 */
export const THREAD_LANE_SANDBOX = Object.freeze({
  enabled: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: false,
})

/**
 * `git add` and `git commit` still ask for approval inside the sandbox
 * (measured), and nobody answers a `-p` prompt: a lane commits on its own
 * branch, so they are allowed. The sandbox still decides where they may write.
 */
export const THREAD_LANE_GIT_RULES: readonly string[] = Object.freeze(['Bash(git add:*)', 'Bash(git commit:*)'])

/** Flags no lane command may carry. */
export const THREAD_LANE_FORBIDDEN_FLAGS: readonly string[] = Object.freeze([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--add-dir',
])

/** Where a lane may work, and what else it may touch. */
export interface ThreadLaneConfinement {
  /** The lane's worktree root (or its plain folder): the only place it may write. Absolute. */
  root: string
  /** The folder is not a git repository: the lane reads, never writes, and has no Bash. */
  readOnly: boolean
  /** The host can run the CLI's Bash sandbox. Without it a working lane gets no Bash. */
  shellSandbox: boolean
  /** Paths the sandbox must refuse to write although they are git state a worktree may touch. */
  protectedPaths?: readonly string[]
  /** Paths the sandbox must refuse Bash to read: credential files and keys (laneSecretPaths). */
  secretPaths?: readonly string[]
  /** Specific directories reopened inside the denied credential tree. */
  readablePaths?: readonly string[]
  /** Folders a read only lane may read (the agent folder). Absolute. */
  readDirs?: readonly string[]
  /**
   * A person's lane (lib/lane-thread-rpc.ts): the tools that lane itself was
   * launched with. The thread's list is cut to them, never widened.
   */
  tools?: readonly string[]
  /** A person's lane: the allow rules that lane's own policy adds (its web option), read only lanes only. */
  allowExtra?: readonly string[]
  /**
   * A person's lane: its own floor hook IN PLACE of the owner's plugin hooks,
   * which belong to the owner's session. It must hold a PreToolUse hook and
   * no Stop hook (assertLaneHooks).
   */
  hooks?: Record<string, unknown>
  platform?: NodeJS.Platform
}

/** Throws unless hooks handed in for a person's lane hold a PreToolUse hook and no Stop hook. */
export function assertLaneHooks(hooks: unknown): Record<string, unknown> {
  const own = hooks as { PreToolUse?: unknown; Stop?: unknown } | null
  if (!own || typeof own !== 'object' || !Array.isArray(own.PreToolUse) || own.PreToolUse.length === 0 || 'Stop' in own) {
    throw new Error('refusing a thread lane whose own hooks lost the floor hook or carry a Stop hook')
  }
  return own as Record<string, unknown>
}

/** The lane's hooks: the owner's trusted plugin hooks, or a person's lane's own. */
function hooksFor(c: ThreadLaneConfinement): Record<string, unknown> {
  return c.hooks === undefined ? threadLaneHooks() : assertLaneHooks(c.hooks)
}

/** Trusted hooks come from the manifest, so matcher, timeout and guard changes follow the child. */
export function threadLaneHooks(): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  return Object.fromEntries(Object.entries(manifest.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; args?: string[]; timeout?: number; async?: boolean }> }>>)
    .filter(([event]) => event !== 'Stop')
    .map(([event, matchers]) => [event, matchers.map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks.map(({ args, command, ...hook }) => ({
        ...hook,
        // Settings hooks use a shell command, unlike the plugin's command/args form.
        command: [command, ...(args ?? []).map((arg: string) => quote(arg.replace('${CLAUDE_PLUGIN_ROOT}', root)))].join(' '),
      })),
    }))]))
}

/**
 * Clear only the latest active goal in a child transcript. Keep UUID and parent
 * links, all conversation rows and historical verdicts. This is the same
 * met:true/sentinel:true record the CLI writes for /goal clear (2.1.319).
 * Never call this on the parent's transcript.
 */
export function threadLaneTranscript(transcript: string): string {
  const lines = transcript.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let row
    try { row = JSON.parse(lines[i]!) } catch { continue }
    if (row?.type !== 'attachment' || row.attachment?.type !== 'goal_status') continue
    if (row.attachment.met || row.attachment.failed) return transcript
    row.attachment = { type: 'goal_status', met: true, sentinel: true, condition: row.attachment.condition }
    lines[i] = JSON.stringify(row)
    return lines.join('\n')
  }
  return transcript
}

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

function requireAbsolute(path: unknown, what: string): string {
  if (typeof path !== 'string' || !(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path))) {
    throw new Error(`${what} is not an absolute path`)
  }
  return path
}

/** The lane's tool list: read only, working with Bash, or working without (no sandbox on this host). */
export function threadLaneTools(c: ThreadLaneConfinement): string[] {
  const own = c.readOnly
    ? [...THREAD_LANE_READ_ONLY_TOOLS]
    : c.shellSandbox ? [...THREAD_LANE_TOOLS] : THREAD_LANE_TOOLS.filter((t) => t !== 'Bash')
  // A person's lane: at most the tools that lane has.
  return c.tools ? own.filter((t) => c.tools!.includes(t)) : own
}

/** acceptEdits: edits inside the working directories go through; dontAsk: anything not allowed is refused. */
export function threadLanePermissionMode(c: ThreadLaneConfinement): 'acceptEdits' | 'dontAsk' {
  return c.readOnly ? 'dontAsk' : 'acceptEdits'
}

/**
 * The lane's own settings (passed as `--settings <json>`; under --restricted
 * nothing else of the owner's applies). Measured (spike section (g)): the
 * worktree as an additional directory widens both the file tools and the
 * sandbox's writes to the whole worktree when the lane runs in a subfolder of
 * it; `filesystem.denyWrite` beats the sandbox's own git allowances.
 */
export function threadLaneSettings(c: ThreadLaneConfinement): Record<string, unknown> {
  const platform = c.platform ?? process.platform
  const root = requireAbsolute(c.root, 'the lane folder')
  const rule = (abs: string) => `${permissionRulePath(abs, platform)}/**`
  if (c.readOnly) {
    const dirs = (c.readDirs ?? []).map((d) => requireAbsolute(d, 'a folder the lane reads'))
    return {
      permissions: {
        allow: [...dirs.map((d) => `Read(${rule(d)})`), ...(c.allowExtra ?? [])],
        deny: [...READ_ONLY_DENIED_TOOLS],
        ...(dirs.length > 0 ? { additionalDirectories: dirs } : {}),
      },
      remoteControlAtStartup: false,
      hooks: hooksFor(c),
    }
  }
  const shell = c.shellSandbox
  return {
    permissions: {
      allow: [`Read(${rule(root)})`, `Edit(${rule(root)})`, ...(shell ? THREAD_LANE_GIT_RULES : [])],
      deny: shell ? [] : ['Bash'],
      additionalDirectories: [root],
    },
    ...(shell
      ? {
          sandbox: {
            ...THREAD_LANE_SANDBOX,
            filesystem: {
              denyWrite: [...(c.protectedPaths ?? [])],
              ...(c.secretPaths ? { denyRead: [...c.secretPaths] } : {}),
              ...(c.readablePaths?.length ? { allowRead: [...c.readablePaths] } : {}),
            },
          },
        }
      : {}),
    // A lane left alone would open a Remote Control session on the owner's
    // account (spike S2 finding 2, person lanes).
    remoteControlAtStartup: false,
    // Keep trusted guards while the manager clears the child's inherited goal.
    hooks: hooksFor(c),
  }
}

/**
 * Throws unless `args` are a confined lane command: --restricted, its own
 * tools, permission mode and trusted hooks without Stop, and none of the
 * forbidden flags. `laneHooks` is a person's lane's own hooks
 * (ThreadLaneConfinement.hooks): only a caller that names them may carry
 * them in place of the owner's plugin hooks.
 */
export function assertConfined(args: readonly string[], laneHooks?: Record<string, unknown>): void {
  for (const flag of ['--restricted', '--tools', '--permission-mode', '--settings']) {
    if (!args.includes(flag)) throw new Error(`refusing a thread lane without ${flag}: it would run with the owner's permissions`)
  }
  let settings: unknown = null
  try {
    settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '')
  } catch {}
  const own = settings as { disableAllHooks?: unknown; hooks?: unknown } | null
  const expected = laneHooks === undefined ? threadLaneHooks() : assertLaneHooks(laneHooks)
  if (!own || (own.disableAllHooks !== undefined && own.disableAllHooks !== false) || !isDeepStrictEqual(own.hooks, expected)) {
    throw new Error('refusing a thread lane without its trusted hooks or with a Stop hook')
  }
  for (const arg of args) {
    if (THREAD_LANE_FORBIDDEN_FLAGS.includes(arg) || arg === 'bypassPermissions') {
      throw new Error(`refusing a thread lane with ${arg}`)
    }
  }
}

/**
 * A thread lane. First start (no fork id yet): fork the main session. Later
 * starts: resume the lane's own session, which is not the main one, so no
 * --fork-session. Always confined (see the file header and assertConfined).
 */
export function threadLaneArgs(input: {
  mainSessionId: string | null | undefined
  forkSessionId: string | null | undefined
  emptyMcpConfigPath: string
  confinement: ThreadLaneConfinement
}): string[] {
  const mcp = requireMcpConfig(input.emptyMcpConfigPath)
  if (!input.confinement) throw new Error('a thread lane needs its confinement')
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  if (input.forkSessionId != null) {
    args.push('--resume', requireSessionId(input.forkSessionId, 'the lane\'s own'))
  } else {
    args.push('--resume', requireSessionId(input.mainSessionId, 'the main'), '--fork-session')
  }
  args.push(
    '--restricted',
    '--tools', threadLaneTools(input.confinement).join(','),
    '--permission-mode', threadLanePermissionMode(input.confinement),
    '--settings', JSON.stringify(threadLaneSettings(input.confinement)),
  )
  args.push('--strict-mcp-config', '--mcp-config', mcp)
  if (isSessionId(input.mainSessionId)) assertForksMain(args, input.mainSessionId)
  assertConfined(args, input.confinement.hooks)
  return args
}

/**
 * The git state of the SOURCE repository a working lane's sandbox must refuse
 * to write. The CLI's sandbox lets a worktree write its repository's common
 * git dir (objects, refs, every worktree's admin dir; measured: only hooks and
 * config are protected), so a lane could otherwise move the main checkout's
 * branch, rewrite its index or HEAD, or another lane's worktree. Refused here:
 * the main checkout's index, HEAD and packed-refs, every branch that exists
 * when the lane starts except the lane's own, and every other worktree's
 * admin dir. Objects stay writable (content addressed, a commit needs them).
 *
 * Gate review finding 4: and every other ref a lane has no business moving,
 * whole: the stash (refs/stash, and logs/refs/stash where its older entries
 * live), tags, remotes, notes and replace refs (a replace ref would change
 * what every other branch appears to hold). A branch new since the lane
 * started is still not here (THREAD_LANE_REF_DIRS lists the folders; the
 * daemon makes them exist on Linux, lib/thread-lanes.ts). And the
 * repository's config and hooks (follow up to finding 4): a lane that set
 * core.hooksPath or core.fsmonitor, or wrote a hook, would run code the next
 * time the owner runs git, outside any sandbox.
 */
/** Ref folders a lane may not write anything in (protectedGitPaths). */
export const THREAD_LANE_REF_DIRS: readonly string[] = Object.freeze(['refs/tags', 'refs/remotes', 'refs/notes', 'refs/replace'])

export function protectedGitPaths(input: {
  commonDir: string
  ownGitDir: string
  ownBranch: string
  branches: readonly string[]
  worktreeNames: readonly string[]
}): string[] {
  const common = input.commonDir.replace(/\/+$/, '')
  const own = input.ownGitDir.replace(/\/+$/, '')
  const out = [
    `${common}/index`, `${common}/HEAD`, `${common}/packed-refs`,
    // The repository's config (core.hooksPath, core.fsmonitor, a filter or a
    // diff driver) and its hooks run commands for the owner's own git,
    // outside any sandbox.
    `${common}/config`, `${common}/hooks`,
    `${common}/refs/stash`, `${common}/logs/refs/stash`,
  ]
  for (const dir of THREAD_LANE_REF_DIRS) out.push(`${common}/${dir}`)
  for (const ref of input.branches) {
    if (!ref.startsWith('refs/heads/') || ref.split('/').includes('..')) continue
    if (ref === `refs/heads/${input.ownBranch}`) continue
    out.push(`${common}/${ref}`)
  }
  for (const name of input.worktreeNames) {
    if (name === '' || name.includes('/') || name === '.' || name === '..') continue
    const dir = `${common}/worktrees/${name}`
    if (dir !== own) out.push(dir)
  }
  return out
}

/**
 * What a working lane's Bash may not read (gate review finding 6 and its
 * follow up). The sandbox lets Bash read the whole disk except what
 * `filesystem.denyRead` names, and --restricted confines only the file tools.
 * Refused: ~/.ssh, the CLI's own credentials file (Linux keeps the sign in
 * there; with CLAUDE_CONFIG_DIR, in that folder too), the AWS, GitHub CLI,
 * netrc, Docker and npm credentials, the default plugin state and any
 * BGOS_PLUGIN_STATE_DIR override, and ~/.bgos-agent, where every agent's
 * HOAI credentials, browser profile and state live.
 *
 * Deny ~/.bgos-agent whole, including credentials created after startup.
 * The manager supplies narrow allowRead exceptions for its workspace and
 * its own email files. Enumerating current siblings misses future secrets.
 * Only paths that exist are named (the Linux sandbox binds over real paths).
 */
export function laneSecretPaths(input: {
  home: string
  configDir: string
  /** BGOS_PLUGIN_STATE_DIR, else ~/.bgos-plugin-state. */
  pluginStateDir?: string
  exists(path: string): boolean
}): string[] {
  const trim = (p: string) => p.replace(/\/+$/, '')
  const home = trim(input.home)
  const out = [
    `${home}/.ssh`,
    `${home}/.claude/.credentials.json`,
    `${home}/.aws`,
    `${home}/.config/gh`,
    `${home}/.netrc`,
    `${home}/.docker/config.json`,
    `${home}/.npmrc`,
    `${home}/.bgos-plugin-state`,
    trim(input.pluginStateDir?.trim() || `${home}/.bgos-plugin-state`),
    `${home}/.bgos-agent`,
  ]
  const config = trim(input.configDir)
  if (config !== '') out.push(`${config}/.credentials.json`)
  return [...new Set(out)].filter((p) => {
    try {
      return input.exists(p)
    } catch {
      return false
    }
  })
}

/** What a thread reply or a summary may hold (the server's reply and summary DTOs). */
export const THREAD_TEXT_MAX = 20_000

export const THREAD_TEXT_CLIPPED_NOTE =
  '\n\n[This message was cut here: a thread message holds at most 20,000 characters.]'

/** The text as is, or cut to fit THREAD_TEXT_MAX with a plain note saying so. */
export function clipThreadText(text: string): string {
  if (text.length <= THREAD_TEXT_MAX) return text
  let end = THREAD_TEXT_MAX - THREAD_TEXT_CLIPPED_NOTE.length
  // Never split a surrogate pair.
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return `${text.slice(0, end)}${THREAD_TEXT_CLIPPED_NOTE}`
}

/**
 * The aside's own settings (gate review finding 5). Without them a fork runs
 * every hook of the owner: measured on CLI 2.1.317 against a fake API, the
 * user's and the project's SessionStart, UserPromptSubmit and Stop hooks all
 * ran for one side question. `disableAllHooks` from `--settings` (a flag
 * setting, above user, project and local) stops every one of them, also when
 * the project sets it false and adds hooks of its own in settings.local.json
 * (measured). Not `--restricted`: that would drop the owner's model, sign in
 * and env with them, and the aside has no tool to confine.
 */
export const ASIDE_SETTINGS = Object.freeze({ disableAllHooks: true })

/**
 * A By the way answer: a one shot fork of the main session. `--tools ""`
 * removes every tool (the spike showed `--permission-mode dontAsk` alone still
 * let Read run), dontAsk and one turn stay as belts, and no hook of the
 * owner's runs (ASIDE_SETTINGS).
 */
export function asideArgs(input: { mainSessionId: string; emptyMcpConfigPath: string }): string[] {
  const main = requireSessionId(input.mainSessionId, 'the main')
  const mcp = requireMcpConfig(input.emptyMcpConfigPath)
  const args = [
    '-p', '--resume', main, '--fork-session',
    '--tools', '',
    '--permission-mode', 'dontAsk', '--max-turns', '1',
    '--settings', JSON.stringify(ASIDE_SETTINGS),
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
  agentFolder?: string
}): string {
  if (input.mode === 'summary') return SUMMARY_INSTRUCTION
  if (input.mode === 'reply') return input.text
  const folderInstruction = input.readOnly === true
    ? input.agentFolder
      ? `This thread is read only: read files in the agent folder ${JSON.stringify(input.agentFolder)} and do not edit files.`
      : 'This folder is not a git repository, so this thread is read only: do not edit files.'
    : 'Work on it in this folder only.'
  // The root's own full stop is kept, never doubled.
  const root = input.rootText.trim()
  const rootSentence = /[.!?]$/.test(root) ? root : `${root}.`
  return (
    `[You are now working in a thread of this chat titled "${input.title}". ` +
    `It is a separate conversation about this message: ${rootSentence} ` +
    `${folderInstruction} The main conversation continues without you. ` +
    'Any goal (/goal) set in the main conversation does not apply in this thread. Answer only this thread\'s message.]\n\n' +
    input.text
  )
}

/** A thread reply is final unless it ends asking the person a question. */
export function isFinalReply(text: string): boolean {
  return !text.trim().endsWith('?')
}
