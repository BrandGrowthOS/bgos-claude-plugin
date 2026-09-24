/**
 * The hard floor, rules_version 1: the list, the words, and the classifier.
 *
 * WHAT THIS IS. "Always ask before risky actions" is a per agent switch the
 * owner turns on in the app, OFF by default. With it on, a short fixed list of
 * risky actions stops and asks the owner on the request card even though every
 * HOAI agent runs with full access. This file is the list and the only thing
 * in the plugin that decides whether an action is on it.
 *
 * ONE LIST, OWNED BY THE SERVER, MIRRORED HERE. The server's copy
 * (backend/src/services/hard-floor.ts) is the one that decides what the owner
 * is asked; this copy exists because two things on the host must decide
 * LOCALLY, with no network, whether to ask the server at all:
 *   - bin/hoai-floor-hook.mjs, the blocking PreToolUse hook, which answers
 *     `ask` for a match and nothing otherwise;
 *   - the permission relay in server.ts, which asks the server's floor check
 *     before it auto approves a request that matched.
 * The two copies are held together by a shared fixture
 * (lib/hard-floor-fixture.ts, byte identical to the server's), the
 * `secret-scan` pattern: the rule ids, their words and every named case are
 * pinned, and HARD_FLOOR_RULES_VERSION is the cross repo key. Renaming a rule
 * id is a breaking wire change: the server stamps it on the card.
 *
 * WHY THIS IS A .mjs AND NOT A .ts. The hook is launched as a bare `node`
 * process by the CLI, on whatever node the host has (the plugin declares node
 * >= 18). No node before 22.18 can import a .ts file, and a hook whose import
 * fails is a floor that is silently off. So the list lives in plain JavaScript
 * that every supported node loads, lib/hard-floor.ts gives the daemon and the
 * tests the typed surface over it, and there is exactly one implementation.
 *
 * NARROW ON PURPOSE. A subagent's `git status`, an `rm` of a single file, an
 * ordinary edit, and this channel's own tools (reply, send_to_peer and the
 * rest of the tool list, which talk TO the owner and not on the owner's
 * behalf) never match. The hook runs on every shell, edit and MCP call, the
 * CLI's own background subagents included, so a noisy list is a floor nobody
 * keeps switched on.
 *
 * WHAT IT DELIBERATELY DOES NOT CATCH, said here the way lib/secret-scan.ts
 * says what it has no detector for, because the copy must never promise more
 * than the list delivers. It matches TEXT, not intent: a delete done by a
 * script file, an alias, a variable (`$CMD`), `python -c`, `find -delete`,
 * `git clean`, or a write to `.env` made by a shell redirect is not on it. A
 * command that merely MENTIONS a listed action inside quotes (a grep for
 * "rm -rf", a commit message) does ask, because quoted text is read as the
 * command a `bash -c` would run, and the list errs toward asking. Deeper files
 * under a home dot folder (`~/.claude/projects/.../memory/*.md`, an agent
 * workspace under `~/.bgos-agent/`) are not settings files and do not ask;
 * `~/.config/<app>/<file>` does. The canon tells the model never to split,
 * rename or wrap an action to step around the list; this file cannot enforce
 * that and does not pretend to.
 *
 * Pure and import safe: no imports, no env reads, no network, no clock, no
 * process exit. Plain JavaScript that node 18 parses, JSDoc for the types.
 */

/** The cross repo key. Bump on BOTH sides, with both fixtures, together. */
export const HARD_FLOOR_RULES_VERSION = 1

/**
 * @typedef {'recursive_delete' | 'force_push' | 'git_dir_write' | 'env_file_write'
 *   | 'home_dotfile_write' | 'acts_on_owners_behalf'} HardFloorRuleId
 * @typedef {{ readonly id: HardFloorRuleId, readonly words: string }} HardFloorRule
 * @typedef {{ ruleId: HardFloorRuleId, rulesVersion: number, words: string, evidence: string }} HardFloorMatch
 * @typedef {{ kind: 'command', command: string }
 *   | { kind: 'path', path: string }
 *   | { kind: 'tool', toolName: string }
 *   | { kind: 'request', toolName: string, inputPreview: string }} HardFloorInput
 */

/**
 * The six rules, in evaluation order (the order decides which rule a card
 * names when two match). `words` finishes the sentence "{Agent} always asks
 * before this: {words}." on the owner's card and is the hook's reason on the
 * terminal, so it is the owner's language, not a technical label.
 *
 * @type {readonly HardFloorRule[]}
 */
export const HARD_FLOOR_RULES = Object.freeze([
  Object.freeze({ id: 'recursive_delete', words: 'deleting a folder and everything in it' }),
  Object.freeze({ id: 'force_push', words: 'force pushing, which can overwrite history' }),
  Object.freeze({ id: 'git_dir_write', words: 'changing a file inside .git' }),
  Object.freeze({ id: 'env_file_write', words: 'changing an .env file' }),
  Object.freeze({ id: 'home_dotfile_write', words: 'changing a settings file in your home folder' }),
  Object.freeze({ id: 'acts_on_owners_behalf', words: 'sending, posting or paying on your behalf' }),
])

/** The CLI's shell tools: their `command` is classified. */
export const FLOOR_SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell'])

/** The CLI's edit tools: their `file_path` (or a notebook's `notebook_path`) is classified. */
export const FLOOR_EDIT_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * The most text any one classification reads. A heredoc can carry a whole
 * file; a megabyte of it is read, well inside the hook's budget, and a
 * listed action past that point is not seen (said, not hidden).
 */
export const HARD_FLOOR_MAX_TEXT = 1024 * 1024

/** How deep quoted text is re-read as a command (`bash -c "sh -c '...'"`). */
const MAX_NESTING = 3

/** An `rm` that is the SUBCOMMAND of one of these is that program's own
 *  remove (`git rm -r --cached`, `pnpm rm -r`), not a delete of a folder. */
const SUBCOMMAND_HOSTS = new Set(['git', 'pnpm', 'npm', 'yarn', 'bun', 'docker', 'podman'])

/** PowerShell's Remove-Item and its aliases that take `-Recurse`. `rm`,
 *  `rd` and `rmdir` are handled beside their own POSIX and cmd readings. */
const REMOVE_ITEM_WORDS = new Set(['remove-item', 'ri', 'del', 'erase'])

/** A short option cluster made only of rm's own letters (GNU and BSD), so a
 *  PowerShell word such as `-Force` is not read as `-f -o -r -c -e`. */
const RM_SHORT_CLUSTER = /^-[fiIrRdvPWx]+$/

/** `-Recurse` and every unambiguous prefix of it PowerShell accepts, with an
 *  optional `:$true`. `-Recurse:$false` is not recursive and does not match. */
const RECURSE_PARAM = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$?true)?$/i

/** cmd's `/s` on rd and rmdir, alone or combined (`/s/q`, `/Q/S`). */
const CMD_SLASH_FLAGS = /^(?:\/[a-z])+$/i

/** git's global options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
])

/** An `.env` file, in any folder: `.env` or `.env.<anything>`. */
const ENV_FILE_RE = /^\.env(?:\..+)?$/i

/**
 * The home folder, recognised by the SHAPE of the path alone. Neither copy of
 * this list can know the real home: the server has none, and the daemon can
 * run on a different machine view than the CLI (a Windows daemon behind a WSL
 * session). So every copy reads the same shapes.
 */
const HOME_PREFIXES = [
  /^~(?=\/|$)/,
  /^\$HOME(?=\/|$)/,
  /^\$\{HOME\}(?=\/|$)/,
  /^%USERPROFILE%(?=\/|$)/i,
  /^\$env:(?:USERPROFILE|HOME)(?=\/|$)/i,
  /^\/home\/[^/]+(?=\/|$)/,
  /^\/Users\/[^/]+(?=\/|$)/i,
  /^\/root(?=\/|$)/,
  /^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/i,
  /^\/mnt\/[A-Za-z]\/Users\/[^/]+(?=\/|$)/i,
]

/**
 * The words that make an MCP tool act on the owner's behalf: each verb with
 * its -s and -ing forms, whole words only, so payload, poster, sender and
 * publisher never match. Past forms (sent, posted, deleted) and the -s forms
 * of post, tweet and reply are left out on purpose, because they name a list
 * (list_sent_messages, list_posts) rather than an action: the browser's
 * SENSITIVE_PATTERNS reasoning, applied to a tool's name.
 */
const ACTING_WORDS = new Set([
  'send', 'sends', 'sending',
  'post', 'posting',
  'publish', 'publishes', 'publishing',
  'tweet', 'tweeting',
  'reply', 'replying',
  'submit', 'submits', 'submitting',
  'pay', 'pays', 'paying',
  'purchase', 'purchases', 'purchasing',
  'transfer', 'transfers', 'transferring',
  'delete', 'deletes', 'deleting',
  'remove', 'removes', 'removing',
  'erase', 'erases', 'erasing',
])

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value) => (typeof value === 'string' ? value : '')

/** @param {HardFloorRuleId} ruleId @param {string} evidence @returns {HardFloorMatch} */
function matchFor(ruleId, evidence) {
  const rule = HARD_FLOOR_RULES.find((r) => r.id === ruleId)
  return {
    ruleId,
    rulesVersion: HARD_FLOOR_RULES_VERSION,
    words: rule ? rule.words : '',
    evidence,
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * Split shell text into SEGMENTS (simple commands) of WORDS.
 *
 * A segment ends at `;`, `&`, `|`, a newline, `(`, `)`, a backtick or `$(`,
 * outside quotes, which covers `&&`, `||`, pipes, subshells and command
 * substitution in bash, PowerShell and cmd alike. Quotes are removed from a
 * word, and the text inside every quoted string is ALSO returned, so the
 * caller can read it as a command of its own (`bash -c "rm -rf x"`). A
 * backslash is kept as a character (it is a path separator on Windows)
 * except before a newline, where it continues the line.
 *
 * @param {string} text
 * @returns {{ segments: string[][], quoted: string[] }}
 */
export function splitShellWords(text) {
  /** @type {string[][]} */
  const segments = []
  /** @type {string[]} */
  const quoted = []
  /** @type {string[]} */
  let words = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  const n = text.length
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (ch === '\\') {
      if (text[i + 1] === '\n') {
        endWord()
        i += 2
        continue
      }
      if (text[i + 1] === '\r' && text[i + 2] === '\n') {
        endWord()
        i += 3
        continue
      }
      word += ch
      inWord = true
      i += 1
      continue
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      const content = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end)
      word += content
      inWord = true
      quoted.push(content)
      i = end === -1 ? n : end + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let content = ''
      while (j < n && text[j] !== '"') {
        const next = text[j + 1]
        if (text[j] === '\\' && (next === '"' || next === '\\' || next === '$' || next === '`')) {
          content += next
          j += 2
          continue
        }
        content += text[j]
        j += 1
      }
      word += content
      inWord = true
      quoted.push(content)
      i = j < n ? j + 1 : n
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      endSegment()
      i += 2
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '(' || ch === ')' || ch === '`') {
      endSegment()
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord()
      i += 1
      continue
    }
    word += ch
    inWord = true
    i += 1
  }
  endSegment()
  return { segments, quoted }
}

/** Every segment of a command, then every segment of the text inside its
 *  quotes, in reading order. */
function collectSegments(text, depth) {
  const { segments, quoted } = splitShellWords(text)
  const out = [...segments]
  if (depth < MAX_NESTING) {
    for (const inner of quoted) {
      if (/\s/.test(inner)) out.push(...collectSegments(inner, depth + 1))
    }
  }
  return out
}

/** The program a word names: its base name, lowercased, `.exe` dropped. */
export function commandWord(word) {
  const parts = String(word ?? '').split(/[\\/]/)
  let base = (parts[parts.length - 1] ?? '').toLowerCase()
  if (base.endsWith('.exe')) base = base.slice(0, -4)
  return base
}

function rmIsRecursive(words, from) {
  for (let j = from; j < words.length; j += 1) {
    const w = words[j]
    if (w === '--') return false
    if (w === '--recursive') return true
    if (RM_SHORT_CLUSTER.test(w) && /[rR]/.test(w)) return true
    if (RECURSE_PARAM.test(w)) return true
  }
  return false
}

function hasRecurseParam(words, from) {
  for (let j = from; j < words.length; j += 1) {
    if (RECURSE_PARAM.test(words[j])) return true
  }
  return false
}

function hasCmdSlashS(words, from) {
  for (let j = from; j < words.length; j += 1) {
    const w = words[j]
    if (CMD_SLASH_FLAGS.test(w) && w.toLowerCase().split('/').includes('s')) return true
  }
  return false
}

/** `rm` with -r, -R, --recursive or a cluster holding one; Remove-Item (or an
 *  alias) with -Recurse; rd or rmdir with /s. */
function isRecursiveDelete(words) {
  for (let i = 0; i < words.length; i += 1) {
    const w = commandWord(words[i])
    if (w === 'rm') {
      if (i > 0 && SUBCOMMAND_HOSTS.has(commandWord(words[i - 1]))) continue
      if (rmIsRecursive(words, i + 1)) return true
    } else if (REMOVE_ITEM_WORDS.has(w)) {
      if (hasRecurseParam(words, i + 1)) return true
    } else if (w === 'rd' || w === 'rmdir') {
      if (hasCmdSlashS(words, i + 1) || hasRecurseParam(words, i + 1)) return true
    }
  }
  return false
}

/** `git push` with --force, -f (alone or in a cluster), --force-with-lease,
 *  or a `+` refspec. */
function isForcePush(words) {
  for (let i = 0; i < words.length; i += 1) {
    if (commandWord(words[i]) !== 'git') continue
    let j = i + 1
    while (j < words.length && words[j].startsWith('-')) {
      j += GIT_OPTIONS_WITH_VALUE.has(words[j]) ? 2 : 1
    }
    if (words[j] !== 'push') continue
    for (let k = j + 1; k < words.length; k += 1) {
      const w = words[k]
      if (w === '--force' || w === '--force-with-lease' || w.startsWith('--force-with-lease=')) return true
      if (/^-[A-Za-z]+$/.test(w) && w.includes('f')) return true
      if (w.length > 1 && w.startsWith('+')) return true
    }
  }
  return false
}

/** @type {ReadonlyArray<{ id: HardFloorRuleId, test: (words: string[]) => boolean }>} */
const COMMAND_RULES = [
  { id: 'recursive_delete', test: isRecursiveDelete },
  { id: 'force_push', test: isForcePush },
]

/**
 * The rule a shell command matches, with the segment that matched as
 * evidence (so a caller with a size limit can send the part that matters),
 * or null.
 *
 * @param {unknown} command
 * @returns {{ ruleId: HardFloorRuleId, evidence: string } | null}
 */
export function commandFloorMatch(command) {
  const text = asString(command).slice(0, HARD_FLOOR_MAX_TEXT)
  if (!text.trim()) return null
  const segments = collectSegments(text, 0)
  for (const rule of COMMAND_RULES) {
    for (const words of segments) {
      if (rule.test(words)) return { ruleId: rule.id, evidence: words.join(' ') }
    }
  }
  return null
}

/** @param {unknown} command @returns {HardFloorRuleId | null} */
export function classifyCommand(command) {
  const match = commandFloorMatch(command)
  return match ? match.ruleId : null
}

// ── Paths ────────────────────────────────────────────────────────────────────

function normalizePath(filePath) {
  return asString(filePath)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/\/[?.]\//, '')
    .replace(/\/{2,}/g, '/')
}

/** The path's segments below the home folder, or null when it is not under one. */
function homeRelative(path) {
  for (const prefix of HOME_PREFIXES) {
    const m = prefix.exec(path)
    if (m) return path.slice(m[0].length).split('/').filter((s) => s !== '' && s !== '.')
  }
  return null
}

/**
 * A settings file in the home folder: a dot file directly in it (`~/.bashrc`),
 * a file directly inside one of its dot folders (`~/.ssh/config`,
 * `~/.claude/settings.json`), or a file one folder down in `~/.config`
 * (`~/.config/gh/hosts.yml`, the XDG layout). Anything deeper is a project or
 * a cache that happens to live under a dot folder, not a settings file.
 */
function isHomeSettingsFile(rest) {
  const first = rest[0]
  if (!first || first === '..' || !first.startsWith('.')) return false
  if (rest.length <= 2) return true
  return rest.length === 3 && first.toLowerCase() === '.config'
}

/** @param {unknown} filePath @returns {HardFloorRuleId | null} */
export function classifyPath(filePath) {
  const path = normalizePath(filePath)
  if (!path) return null
  const segments = path.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) return null
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i].toLowerCase() === '.git') return 'git_dir_write'
  }
  if (ENV_FILE_RE.test(segments[segments.length - 1])) return 'env_file_write'
  const rest = homeRelative(path)
  if (rest && isHomeSettingsFile(rest)) return 'home_dotfile_write'
  return null
}

// ── Tool names ───────────────────────────────────────────────────────────────

/** This channel's own MCP server: `bgos` in a workspace .mcp.json, or
 *  `plugin_<plugin>_bgos` for a marketplace install. Its tools talk TO the
 *  owner, so none of them is ever on the list. */
export function isOwnChannelServer(server) {
  const s = asString(server).toLowerCase()
  return s === 'bgos' || (s.startsWith('plugin_') && s.endsWith('_bgos'))
}

/** A tool name's words: split on anything that is not a letter and on
 *  camelCase, lowercased. `sendMessage` and `send_message` read the same. */
export function toolNameWords(name) {
  return asString(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase())
}

/** An MCP tool (`mcp__<server>__<name>`) whose NAME sends, posts, pays or
 *  deletes, from any server but this channel's own.
 *  @param {unknown} toolName @returns {HardFloorRuleId | null} */
export function classifyToolName(toolName) {
  const name = asString(toolName)
  if (!name.startsWith('mcp__')) return null
  const parts = name.split('__')
  if (parts.length < 3) return null
  if (isOwnChannelServer(parts[1])) return null
  const words = toolNameWords(parts.slice(2).join('__'))
  return words.some((w) => ACTING_WORDS.has(w)) ? 'acts_on_owners_behalf' : null
}

// ── Tool calls and permission requests ───────────────────────────────────────

/**
 * Classify one tool call as the hook sees it: the tool's name and its
 * structured input. A shell tool is read by its command, an edit tool by its
 * path, an MCP tool by its name; anything else (a Read, a WebFetch, the CLI's
 * own Agent tool) is never on the list.
 *
 * @param {unknown} toolName
 * @param {unknown} toolInput
 * @returns {HardFloorMatch | null}
 */
export function classifyToolCall(toolName, toolInput) {
  const name = asString(toolName)
  const input = isRecord(toolInput) ? toolInput : {}
  if (FLOOR_SHELL_TOOLS.includes(name)) {
    const match = commandFloorMatch(input.command)
    return match ? matchFor(match.ruleId, match.evidence) : null
  }
  if (FLOOR_EDIT_TOOLS.includes(name)) {
    for (const key of ['file_path', 'notebook_path']) {
      const path = asString(input[key])
      const ruleId = classifyPath(path)
      if (ruleId) return matchFor(ruleId, path)
    }
    return null
  }
  const ruleId = classifyToolName(name)
  return ruleId ? matchFor(ruleId, name) : null
}

/** Undo JSON string escapes on a fragment that may have been cut short:
 *  a complete escape is decoded, a cut one at the very end is dropped. */
function unescapeJsonFragment(fragment) {
  return fragment.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])|\\u[0-9a-fA-F]{0,3}$|\\$/g, (whole, esc) => {
    if (!esc) return ''
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16))
    const table = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
    return table[esc]
  })
}

/**
 * The tool input a permission request's `input_preview` carries.
 *
 * The CLI renders the WHOLE tool input as JSON (`{ "command": "rm -rf doomed",
 * "description": "..." }`, map part 24). A preview cut short is not JSON, so
 * the fields the floor reads (`command`, `file_path`, `notebook_path`) are
 * read out of the text leniently, which keeps the head of a long command. A
 * preview that is not JSON at all is read as the command itself for a shell
 * tool and as the path for an edit tool.
 *
 * @param {unknown} toolName
 * @param {unknown} inputPreview
 * @returns {Record<string, unknown>}
 */
export function readToolInput(toolName, inputPreview) {
  const name = asString(toolName)
  const text = asString(inputPreview).slice(0, HARD_FLOOR_MAX_TEXT).trim()
  if (!text) return {}
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (isRecord(parsed)) return parsed
    } catch {
      /* cut short: read the fields below */
    }
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of ['command', 'file_path', 'notebook_path']) {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text)
      if (m) out[key] = unescapeJsonFragment(m[1])
    }
    return out
  }
  if (FLOOR_SHELL_TOOLS.includes(name)) return { command: text }
  if (FLOOR_EDIT_TOOLS.includes(name)) return { file_path: text }
  return {}
}

/**
 * Classify a permission request as the relay receives it: a tool name and the
 * CLI's `input_preview` string.
 *
 * @param {unknown} toolName
 * @param {unknown} inputPreview
 * @returns {HardFloorMatch | null}
 */
export function classifyPermissionRequest(toolName, inputPreview) {
  return classifyToolCall(toolName, readToolInput(toolName, inputPreview))
}

/**
 * The shared fixture's entry point: one of four input kinds, the same four on
 * both sides.
 *
 * @param {HardFloorInput} input
 * @returns {HardFloorMatch | null}
 */
export function classifyFloor(input) {
  if (!isRecord(input)) return null
  switch (input.kind) {
    case 'command': {
      const match = commandFloorMatch(input.command)
      return match ? matchFor(match.ruleId, match.evidence) : null
    }
    case 'path': {
      const ruleId = classifyPath(input.path)
      return ruleId ? matchFor(ruleId, asString(input.path)) : null
    }
    case 'tool': {
      const ruleId = classifyToolName(input.toolName)
      return ruleId ? matchFor(ruleId, asString(input.toolName)) : null
    }
    case 'request':
      return classifyPermissionRequest(input.toolName, input.inputPreview)
    default:
      return null
  }
}
