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
 *     `ask` for a match and nothing otherwise, and leaves a floor record the
 *     relay reads (lib/floor-state.mjs);
 *   - the permission relay in server.ts, which asks the server's floor check
 *     before it auto approves a request the hook's record (or, failing that,
 *     the request's own preview) says is on the list.
 * The two copies are held to each other by a shared fixture
 * (lib/hard-floor-fixture.ts, copied byte for byte from the server's), the
 * `secret-scan` pattern: the rule ids, their words and every named case are
 * pinned, and HARD_FLOOR_RULES_VERSION is the cross repo key. Whether the two
 * files ARE the same bytes is the reconciliation step's check, because
 * neither suite can read the other repo. Renaming a rule id is a breaking
 * wire change: the server stamps it on the card.
 *
 * THE SAME READING AS THE SERVER'S, ON PURPOSE. The command reader below is a
 * port of the server's (`lexShell`, `programsIn`, `innerScript` and the rest
 * keep their names), because a case the two read differently is either an
 * action the hook never asks about while the server lists it, or a round
 * trip, a terminal prompt and, when the check errors, a REFUSED call for an
 * action the server does not list. The one addition is the EVIDENCE: the
 * simple command that matched, re quoted so the server reads it the same way,
 * which the relay sends when a command is too long to send whole.
 *
 * WHY THIS IS A .mjs AND NOT A .ts. The hook is launched as a bare `node`
 * process by the CLI, on whatever node the host has (the plugin declares node
 * >= 18). No node before 22.18 can import a .ts file, and a hook whose import
 * fails is a floor that is silently off. So the list lives in plain JavaScript
 * that every supported node loads, lib/hard-floor.ts gives the daemon and the
 * tests the typed surface over it, and there is exactly one implementation.
 *
 * NARROW ON PURPOSE, and the omissions are decisions, spec 4.2. A subagent's
 * `git status`, an `rm` of a single file, `git rm -r` (git's subcommand, not
 * the `rm` program), `del /s` (files, not the folder), a push with no force
 * flag and no `+` refspec, an ordinary edit, a `Read` of `.env`, and this
 * channel's own tools never match. A command that only MENTIONS a listed
 * action in quotes (`echo "rm -rf build"`, a commit message, `rg 'git push
 * -f'`) is not that action; quoted text is read as a command only as the
 * script of a shell (`bash -c`, `su -c`, `eval`, `cmd /c`, `powershell
 * -Command` or Windows PowerShell's positional command, a heredoc, here
 * string or `echo ... |` fed to a shell). A `# comment` is not a command. A
 * heredoc's body is the DATA of the command that owns it, so writing a script
 * that contains `rm -rf` does not ask (`cat > clean.sh <<'EOF'`). A home
 * settings file is one directly in the home folder or directly in a dot
 * folder of it, so `~/.config/gh/hosts.yml` and an agent workspace under
 * `~/.bgos-agent/` do not ask. The HOAI exemption is the channel's exact
 * server names (HOAI_OWN_SERVERS), never a pattern, so another plugin that
 * happens to name its server `bgos` is not exempt.
 *
 * What it does parse, it parses as the server does: shell separators, quotes
 * (ANSI-C `$'...'` with its escapes too), the backslash a POSIX shell removes
 * (`r\m`, `rm -\rf`), comments, `$(...)` and backticks (inside double quotes
 * too), PowerShell's backtick line continuation, `sudo`/`env`/`xargs`/
 * `timeout`/`wsl` prefixes with their long options and their short option
 * clusters (`sudo -iu root`), `env -S`, `find -exec`, GNU's long option
 * prefixes (`rm --rec`), and a script handed to a shell, one level deep at a
 * time and at most four levels.
 *
 * IT IS A LIST, NOT A SANDBOX, said here the way lib/secret-scan.ts says what
 * it has no detector for, and the same list the server's header gives: a
 * script file run later (`bash cleanup.sh`, `cat x | bash`), an interpreter
 * one liner (`python3 -c`, `node -e`, `powershell -EncodedCommand`), another
 * delete verb (`git clean -fdx`, `find -delete`, `rsync --delete`, `rimraf`),
 * a history rewrite that is not a push (`git reset --hard`, `git push
 * --mirror`, `git push origin :branch`), a git alias, a variable, an alias or
 * a function standing for the program, a copied binary, a remote or container
 * shell (`ssh`, `docker exec`), wrappers it does not know (`watch`, `strace`),
 * a shell redirect into a listed file (`echo X=1 >> .env`), and a third party
 * MCP tool that runs a shell (read by its NAME only). The canon tells the
 * model never to split, rename or wrap an action to step around the list;
 * this file cannot enforce that and does not pretend to.
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
 * @typedef {{ words: string[], stdin: string[], pipedFrom: SimpleCommand | null }} SimpleCommand
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

const RULE_ORDER = HARD_FLOOR_RULES.map((rule) => rule.id)

/** The CLI's shell tools: their `command` is classified. */
export const FLOOR_SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell'])

/** The CLI's edit tools: their `file_path` (or a notebook's `notebook_path`) is classified. */
export const FLOOR_EDIT_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * The most text any one classification reads. A heredoc can carry a whole
 * file; a megabyte of it is read, well inside the hook's budget, and a
 * listed action past that point is not seen (said, not hidden). The server
 * reads no such bound, and no fixture case comes near it.
 */
export const HARD_FLOOR_MAX_TEXT = 1024 * 1024

/**
 * The HOAI channel's own MCP server, and ONLY it, by exact name (spec 4.2):
 * the standalone server (`bgos`) and the plugin install names the channel has
 * shipped under (`hoai` today, `bgos` before the rename, and `hoaiq`, the
 * local QA install), each of which names its server `bgos`, so the tools
 * arrive as `mcp__plugin_<plugin>_bgos__<tool>`. Its tools talk TO the owner,
 * so none of them is an action on the owner's behalf. The server's
 * HOAI_OWN_SERVERS is the same list. A pattern would be wider than the
 * channel: another plugin that names its server `bgos`
 * (`mcp__plugin_mail_bgos__send_email`) is NOT exempt.
 */
export const HOAI_OWN_SERVERS = Object.freeze([
  'bgos',
  'plugin_hoai_bgos',
  'plugin_bgos_bgos',
  'plugin_hoaiq_bgos',
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

/**
 * The first rule, in the list's order, of everything found, with the evidence
 * recorded when it was first found.
 * @param {Map<HardFloorRuleId, string>} found
 * @returns {HardFloorMatch | null}
 */
function firstMatch(found) {
  for (const id of RULE_ORDER) {
    if (found.has(id)) return matchFor(id, found.get(id) ?? '')
  }
  return null
}

/** @param {Map<HardFloorRuleId, string>} found @param {HardFloorRuleId} id @param {string} evidence */
function note(found, id, evidence) {
  if (!found.has(id)) found.set(id, evidence)
}

// ── Commands ─────────────────────────────────────────────────────────────────

const MAX_DEPTH = 4

/**
 * Collect every rule a piece of shell text matches, each with the simple
 * command that matched as its evidence.
 * @param {string} text @param {Map<HardFloorRuleId, string>} found @param {number} depth
 */
function commandRules(text, found, depth) {
  if (!text || depth > MAX_DEPTH) return
  const lexed = lexShell(text)
  for (const command of lexed.commands) {
    for (const call of programsIn(command.words)) {
      checkProgram(call.program, call.args, command, found, depth)
    }
  }
  // `$(...)` and backticks inside double quotes still run.
  for (const body of lexed.nested) commandRules(body, found, depth + 1)
  // A backtick at the end of a line is PowerShell's line continuation
  // (`Remove-Item build `<newline>  -Recurse`), and to a POSIX shell the start
  // of a substitution. The text names no shell, so it is read BOTH ways.
  if (POWERSHELL_CONTINUATION_RE.test(text)) {
    commandRules(text.replace(POWERSHELL_CONTINUATION_ALL_RE, ' '), found, depth + 1)
  }
}

const POWERSHELL_CONTINUATION_RE = /`\r?\n/
const POWERSHELL_CONTINUATION_ALL_RE = /`\r?\n/g

/**
 * @param {string} program @param {string[]} args @param {SimpleCommand} command
 * @param {Map<HardFloorRuleId, string>} found @param {number} depth
 */
function checkProgram(program, args, command, found, depth) {
  // A POSIX shell removes a backslash from an unquoted flag (`rm -\rf`).
  const flags = args.map((arg) => (/^[-+]/.test(arg) ? posixUnescape(arg) : arg))
  if (program === 'rm') {
    if (rmIsRecursive(flags)) note(found, 'recursive_delete', quoteWords(command.words))
    return
  }
  if (REMOVE_ITEM_NAMES.has(program)) {
    if (args.some(isPowerShellRecurse)) note(found, 'recursive_delete', quoteWords(command.words))
    return
  }
  if (program === 'rd' || program === 'rmdir') {
    if (args.some((a) => isCmdSlashS(a) || isPowerShellRecurse(a))) {
      note(found, 'recursive_delete', quoteWords(command.words))
    }
    return
  }
  if (program === 'git') {
    if (gitIsForcePush(flags)) note(found, 'force_push', quoteWords(command.words))
    return
  }
  const script = innerScript(program, args, command)
  if (script !== null) commandRules(script, found, depth + 1)
}

/** PowerShell's own name for the cmdlet and the aliases that are not `rm`, `rd` or `rmdir`. */
const REMOVE_ITEM_NAMES = new Set(['remove-item', 'ri', 'del', 'erase'])

/** @param {string[]} args */
function rmIsRecursive(args) {
  for (const arg of args) {
    if (arg === '--') return false
    // A short option cluster made only of rm's own letters, holding r or R.
    if (/^-[fiIrRvd]+$/.test(arg) && /[rR]/.test(arg)) return true
    // --recursive, or any unambiguous prefix of it GNU rm accepts (--r, --rec).
    if (arg.length >= 3 && '--recursive'.startsWith(arg)) return true
    // PowerShell's rm alias with -Recurse spelled out.
    if (isPowerShellRecurse(arg)) return true
  }
  return false
}

/** `-Recurse`, any prefix of it down to `-r`, in any case, optionally `:$true`. */
function isPowerShellRecurse(arg) {
  const match = /^(-[a-z]+)(:\$?true)?$/i.exec(arg)
  if (!match) return false
  const flag = match[1].toLowerCase()
  return flag.length >= 2 && '-recurse'.startsWith(flag)
}

/** cmd's `/s` on rd and rmdir, alone or joined with others (`/s/q`, `/q/s`, `/Q/S`). */
function isCmdSlashS(arg) {
  return /^(?:\/[a-z])+$/i.test(arg) && /\/s(?:\/|$)/i.test(arg)
}

/** git's global options that take the next token as their value. */
const GIT_GLOBAL_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
])

/** git push's options that take the next token as their value. */
const GIT_PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo'])

/** @param {string[]} args */
function gitIsForcePush(args) {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    i += GIT_GLOBAL_WITH_VALUE.has(args[i]) ? 2 : 1
  }
  if (args[i] !== 'push') return false
  for (let j = i + 1; j < args.length; j++) {
    const arg = args[j]
    if (GIT_PUSH_WITH_VALUE.has(arg)) {
      j++
      continue
    }
    if (/^--force(-with-lease(=.*)?)?$/.test(arg)) return true
    if (/^-[uvqnd46f]+$/.test(arg) && arg.includes('f')) return true
    if (arg.startsWith('+') && arg.length > 1) return true
  }
  return false
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish'])
const POWERSHELLS = new Set(['powershell', 'pwsh', 'powershell_ise'])

/**
 * Windows PowerShell's options that take the next token as their value, so
 * the first token that is NOT one of them, or their value, is the positional
 * command (`powershell "Remove-Item build -Recurse"`). `pwsh` reads a
 * positional as a FILE, so only Windows PowerShell gets this reading.
 */
const POWERSHELL_WITH_VALUE = new Set([
  '-executionpolicy',
  '-ep',
  '-ex',
  '-exec',
  '-windowstyle',
  '-w',
  '-win',
  '-version',
  '-v',
  '-psconsolefile',
  '-inputformat',
  '-inp',
  '-if',
  '-outputformat',
  '-o',
  '-of',
  '-configurationname',
  '-config',
  '-workingdirectory',
  '-wd',
])

/**
 * The script a shell was handed to run, or null when this is no such call.
 * @param {string} program @param {string[]} args @param {SimpleCommand} command
 * @returns {string | null}
 */
function innerScript(program, args, command) {
  if (POSIX_SHELLS.has(program)) {
    const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
    if (at >= 0) {
      // `bash -c -- 'script'`: the `--` ends the options, the script follows.
      const script = args[at + 1] === '--' ? at + 2 : at + 1
      return script < args.length ? args[script] : null
    }
    // No -c: the shell reads its script from stdin, a heredoc, a here
    // string, or a pipe (`bash <<< 'x'`, `echo 'x' | bash`).
    return stdinScript(command)
  }
  if (POWERSHELLS.has(program)) {
    const at = args.findIndex((a) => {
      const flag = a.toLowerCase()
      return flag.length >= 2 && '-command'.startsWith(flag)
    })
    if (at >= 0) return args.slice(at + 1).join(' ')
    if (program === 'pwsh') return null
    return powershellPositional(args)
  }
  if (program === 'cmd') {
    const at = args.findIndex((a) => /^\/[ck]$/i.test(a))
    return at >= 0 ? args.slice(at + 1).join(' ') : null
  }
  if (program === 'su') {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--command') {
        return i + 1 < args.length ? args[i + 1] : null
      }
      if (args[i].startsWith('--command=')) {
        return args[i].slice('--command='.length)
      }
    }
    return null
  }
  if (program === 'eval') return args.join(' ')
  return null
}

/** @param {string[]} args @returns {string | null} */
function powershellPositional(args) {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    const flag = args[i].toLowerCase()
    // A file or an encoded command is not text this list can read.
    if (flag.length >= 2 && '-file'.startsWith(flag)) return null
    if (flag === '-e' || flag === '-ec' || (flag.length >= 3 && '-encodedcommand'.startsWith(flag))) {
      return null
    }
    i += POWERSHELL_WITH_VALUE.has(flag) ? 2 : 1
  }
  return i < args.length ? args.slice(i).join(' ') : null
}

/**
 * What a shell with no `-c` reads as its script: its heredoc or here string,
 * or what a pipe feeds it.
 * @param {SimpleCommand} command @returns {string | null}
 */
function stdinScript(command) {
  if (command.stdin.length > 0) return command.stdin.join('\n')
  const source = command.pipedFrom
  if (!source) return null
  const at = skipPrefixes(source.words, 0)
  if (at >= source.words.length) {
    return source.stdin.length > 0 ? source.stdin.join('\n') : null
  }
  const feeder = programName(source.words[at])
  if (feeder === 'echo' || feeder === 'printf') {
    let i = at + 1
    while (feeder === 'echo' && i < source.words.length && /^-[neE]+$/.test(source.words[i])) {
      i++
    }
    return source.words.slice(i).join(' ')
  }
  if (feeder === 'cat' && source.stdin.length > 0) {
    return source.stdin.join('\n')
  }
  return null
}

const SPLITS = ';&|\n(){}`'

// Spelled by char code, so no quote character sits inside a string or a
// pattern in this file (test/permission-relay.test.ts scans every lib file
// with a comment stripper that such a literal would throw off).
const BACKSLASH = String.fromCharCode(92)
const SINGLE_QUOTE = String.fromCharCode(39)
const DOUBLE_QUOTE = String.fromCharCode(34)
const BACKTICK = String.fromCharCode(96)

/** What a backslash escapes inside double quotes, the way bash keeps it. */
const DOUBLE_QUOTE_ESCAPES = new Set([DOUBLE_QUOTE, BACKSLASH, '$', BACKTICK])

/** What a backslash escapes outside quotes, besides a separator. */
const BACKSLASH_ESCAPES = new Set([' ', '\t', DOUBLE_QUOTE, SINGLE_QUOTE, '$', '#', '<', '>'])

/**
 * Split shell text into simple commands, each a list of words. Quotes are
 * honoured (single quotes literal, double quotes with the escapes bash keeps,
 * and a `$(...)` or backtick inside double quotes read as the command it
 * runs), and a command ends at `;`, `&`, `|`, a newline, a bracket, a brace,
 * a backtick or `$(`. A `#` that starts a word starts a comment. A heredoc's
 * body is DATA for the command that owns it (`cat > x.sh <<'EOF'` writes a
 * script, it does not run it) and is read as a script only when that command
 * is a shell. A backslash escapes only a character that would otherwise
 * split or quote, so a Windows path keeps its backslashes.
 *
 * @param {string} text
 * @returns {{ commands: SimpleCommand[], nested: string[] }}
 */
export function lexShell(text) {
  /** @type {SimpleCommand[]} */
  const commands = []
  /** @type {string[]} */
  const nested = []
  /** @returns {SimpleCommand} */
  const fresh = (pipedFrom) => ({ words: [], stdin: [], pipedFrom })
  let current = fresh(null)
  let word = ''
  let inWord = false
  /** @type {'herestring' | 'heredoc' | 'heredoc-tabs' | null} */
  let redirect = null
  /** @type {{ delimiter: string, stripTabs: boolean, owner: SimpleCommand }[]} */
  const heredocs = []
  const endWord = () => {
    if (inWord) {
      if (redirect === 'herestring') {
        current.stdin.push(word)
      } else if (redirect === 'heredoc' || redirect === 'heredoc-tabs') {
        heredocs.push({ delimiter: word, stripTabs: redirect === 'heredoc-tabs', owner: current })
      } else {
        current.words.push(word)
      }
      redirect = null
    }
    word = ''
    inWord = false
  }
  const endCommand = (pipe = false) => {
    endWord()
    const ended = current
    const kept = ended.words.length > 0 || ended.stdin.length > 0
    if (kept) commands.push(ended)
    current = fresh(pipe && kept ? ended : null)
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      const close = text.indexOf("'", i + 1)
      const stop = close === -1 ? text.length : close
      word += text.slice(i + 1, stop)
      inWord = true
      i = stop + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length && DOUBLE_QUOTE_ESCAPES.has(text[j + 1])) {
          word += text[j + 1]
          j += 2
          continue
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const close = closingParen(text, j + 2)
          nested.push(text.slice(j + 2, close))
          word += text.slice(j, close + 1)
          j = close + 1
          continue
        }
        if (text[j] === '`') {
          const close = closingBacktick(text, j + 1)
          nested.push(text.slice(j + 1, close))
          word += text.slice(j, close + 1)
          j = close + 1
          continue
        }
        word += text[j]
        j++
      }
      inWord = true
      i = j + 1
      continue
    }
    if (ch === '$' && text[i + 1] === SINGLE_QUOTE) {
      // ANSI-C quoting: `$'rm'` is the word rm, with its escapes decoded.
      const close = closingAnsiQuote(text, i + 2)
      word += decodeAnsiC(text.slice(i + 2, close))
      inWord = true
      i = close + 1
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]
      if (next === '\n') {
        i += 2
        continue
      }
      if (SPLITS.includes(next) || BACKSLASH_ESCAPES.has(next)) {
        word += next
        inWord = true
        i += 2
        continue
      }
    }
    if (ch === '#' && !inWord) {
      // A comment runs to the end of the line; the newline still ends the command.
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord()
      i++
      continue
    }
    if (ch === '$' && text[i + 1] === '{') {
      // A parameter expansion (`${#list[@]}`, `${x:-y}`) is one word, so its
      // `#` is not a comment and its brace is not a group.
      const close = text.indexOf('}', i + 2)
      const stop = close === -1 ? text.length : close + 1
      word += text.slice(i, stop)
      inWord = true
      i = stop
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      endCommand()
      i += 2
      continue
    }
    if (ch === '\n') {
      endCommand()
      i = readHeredocBodies(text, i + 1, heredocs)
      continue
    }
    if (ch === '|') {
      // `|` and `|&` pipe into the next command; `||` only sequences it.
      const orOr = text[i + 1] === '|'
      endCommand(!orOr)
      i += orOr || text[i + 1] === '&' ? 2 : 1
      continue
    }
    if (SPLITS.includes(ch)) {
      endCommand()
      i++
      continue
    }
    if (ch === '<' && text.startsWith('<<<', i)) {
      endWord()
      redirect = 'herestring'
      i += 3
      continue
    }
    if (ch === '<' && text[i + 1] === '<') {
      endWord()
      const tabs = text[i + 2] === '-'
      redirect = tabs ? 'heredoc-tabs' : 'heredoc'
      i += tabs ? 3 : 2
      continue
    }
    if (ch === '<' || ch === '>') {
      endWord()
      i++
      continue
    }
    word += ch
    inWord = true
    i++
  }
  endCommand()
  return { commands, nested }
}

/**
 * Read the bodies of the heredocs opened on the line that just ended, from
 * `start`, each up to its delimiter line, onto the command that owns it.
 * Answers where reading resumes.
 */
function readHeredocBodies(text, start, heredocs) {
  let at = start
  while (heredocs.length > 0) {
    const doc = heredocs.shift()
    const lines = []
    while (at < text.length) {
      const newline = text.indexOf('\n', at)
      const end = newline === -1 ? text.length : newline
      const raw = text.slice(at, end).replace(/\r$/, '')
      at = newline === -1 ? text.length : newline + 1
      const line = doc.stripTabs ? raw.replace(/^\t+/, '') : raw
      if (line === doc.delimiter) break
      lines.push(line)
    }
    doc.owner.stdin.push(lines.join('\n'))
  }
  return at
}

/** Where the ANSI-C quote opened just before `start` closes (an escaped quote does not close it). */
function closingAnsiQuote(text, start) {
  let i = start
  while (i < text.length) {
    if (text[i] === BACKSLASH) {
      i += 2
      continue
    }
    if (text[i] === SINGLE_QUOTE) return i
    i++
  }
  return text.length
}

/** @type {Readonly<Record<string, string>>} */
const ANSI_C_NAMED = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
}

/** The escapes of `$'...'`: named ones, hex, unicode and octal; a backslash before anything else is that character. */
function decodeAnsiC(body) {
  return body.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g,
    (_match, esc) => {
      const head = esc[0]
      if (esc.length > 1 && (head === 'x' || head === 'u' || head === 'U')) {
        const code = parseInt(esc.slice(1), 16)
        return code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
      if (/[0-7]/.test(head)) return String.fromCharCode(parseInt(esc, 8))
      return ANSI_C_NAMED[esc] ?? esc
    },
  )
}

/** Where the `(` opened just before `start` closes, skipping quoted text. */
function closingParen(text, start) {
  let depth = 1
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1)
      i = close === -1 ? text.length : close + 1
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return text.length
}

/** Where the backtick opened just before `start` closes. */
function closingBacktick(text, start) {
  let i = start
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === '`') return i
    i++
  }
  return text.length
}

/** Words that may stand before the program without being it. */
const KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time'])

/**
 * Programs that run the command after them, with the options of theirs that
 * take a value as a SEPARATE token (the `--opt=value` form is one token and
 * needs no entry). `timeout` also takes one positional duration.
 * @type {Record<string, readonly string[]>}
 */
const WRAPPERS = {
  sudo: [
    '-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T',
    '--user', '--group', '--close-from', '--chdir', '--host', '--prompt',
    '--role', '--type', '--other-user', '--command-timeout',
  ],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'],
  nohup: [],
  command: [],
  builtin: [],
  exec: ['-a'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '--class', '--classdata', '--pid'],
  xargs: [
    '-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a',
    '--max-args', '--max-procs', '--delimiter', '--max-lines', '--max-chars', '--eof', '--arg-file',
  ],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  busybox: [],
  chronic: [],
  unbuffer: [],
  // WSL runs the rest of its line in the distribution (`wsl rm -rf build`,
  // `wsl.exe -e rm -rf build`, `wsl -d Ubuntu -u root -- rm -rf build`).
  wsl: ['-d', '--distribution', '-u', '--user', '--cd', '--shell-type'],
}

/** @param {string[]} words @returns {{ program: string, args: string[] }[]} */
function programsIn(words) {
  const tokens = expandEnvSplitString(words)
  const calls = []
  const first = skipPrefixes(tokens, 0)
  if (first >= tokens.length) return calls
  calls.push({ program: programName(tokens[first]), args: tokens.slice(first + 1) })
  // find's -exec family starts a second command inside the first.
  for (let j = first + 1; j < tokens.length - 1; j++) {
    if (/^-(exec|execdir|ok|okdir)$/.test(tokens[j])) {
      const at = skipPrefixes(tokens, j + 1)
      if (at < tokens.length) {
        calls.push({ program: programName(tokens[at]), args: tokens.slice(at + 1) })
      }
    }
  }
  return calls
}

/**
 * `env -S "rm -rf build"` (and `--split-string`, joined or not) hands env ONE
 * string that it splits into the command it runs, so the string's words take
 * its place (split on blanks, as env does for a plain string).
 * @param {string[]} tokens
 */
function expandEnvSplitString(tokens) {
  const out = []
  let inEnvOptions = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!inEnvOptions) {
      out.push(token)
      inEnvOptions = programName(token) === 'env'
      continue
    }
    let value = null
    if ((token === '-S' || token === '--split-string') && i + 1 < tokens.length) {
      i++
      value = tokens[i]
    } else if (token.startsWith('--split-string=')) {
      value = token.slice('--split-string='.length)
    } else if (/^-S./.test(token)) {
      value = token.slice(2)
    }
    if (value !== null) {
      out.push(...value.split(/\s+/).filter((word) => word !== ''))
      continue
    }
    out.push(token)
    if (!token.startsWith('-')) inEnvOptions = false
  }
  return out
}

/**
 * How many tokens one wrapper option takes: 2 when it takes the next token as
 * its value, else 1. A short option cluster reads as getopt reads it, so the
 * first letter that takes a value takes the REST of the cluster, or the next
 * token when it is the cluster's last letter (`sudo -iu root`, `sudo -uroot`).
 * @param {string} token @param {readonly string[]} withValue
 */
function optionWidth(token, withValue) {
  if (withValue.includes(token)) return 2
  if (!/^-[A-Za-z]/.test(token)) return 1
  for (let k = 1; k < token.length; k++) {
    if (!/[A-Za-z]/.test(token[k])) return 1
    if (withValue.includes(`-${token[k]}`)) {
      return k === token.length - 1 ? 2 : 1
    }
  }
  return 1
}

/** @param {string[]} tokens @param {number} start */
function skipPrefixes(tokens, start) {
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || KEYWORDS.has(token)) {
      i++
      continue
    }
    const name = programName(token)
    const withValue = Object.prototype.hasOwnProperty.call(WRAPPERS, name) ? WRAPPERS[name] : null
    if (!withValue) return i
    i++
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i += optionWidth(tokens[i], withValue)
    }
    if (name === 'timeout' && i < tokens.length) i++
  }
  return i
}

/**
 * `/usr/bin/rm`, `C:\Windows\rm.exe` and `RM` are all `rm`. A backslash is a
 * Windows separator AND, to a POSIX shell, an escape it removes (`r\m` and
 * `\rm` run `rm`), so when the Windows reading names nothing this list acts
 * on and the POSIX reading does, the POSIX reading wins.
 */
function programName(token) {
  const text = String(token)
  const windows = baseName(text.split(/[\\/]/).pop() ?? text)
  if (!text.includes(BACKSLASH) || ACTED_ON.has(windows)) return windows
  const posix = baseName(posixUnescape(text).split('/').pop() ?? text)
  return ACTED_ON.has(posix) ? posix : windows
}

function baseName(name) {
  return name.toLowerCase().replace(/\.exe$/, '')
}

/** What a POSIX shell leaves of an unquoted word: every backslash escape removed. */
function posixUnescape(word) {
  return word.replace(/\\(.)/g, '$1')
}

/** Every program name this list reads, as a program or as a wrapper around one. */
const ACTED_ON = new Set([
  'rm',
  'rd',
  'rmdir',
  'git',
  'cmd',
  'su',
  'eval',
  ...REMOVE_ITEM_NAMES,
  ...POSIX_SHELLS,
  ...POWERSHELLS,
  ...Object.keys(WRAPPERS),
])

/**
 * A simple command's words written back as shell text the lexer above (and
 * the server's, which is the same reader) splits into the same words: a word
 * with nothing special in it as it is, anything else in quotes. This is the
 * EVIDENCE the relay sends when a command is too long to send whole, so the
 * server reads the matched command and not a head that stops before it.
 * @param {string[]} words
 */
export function quoteWords(words) {
  return words
    .map((w) => {
      // A trailing backslash would escape the space after it, so it is quoted.
      if (w !== '' && /^[A-Za-z0-9_\-.,/:=+@%~^\\]+$/.test(w) && !w.endsWith('\\')) return w
      if (!w.includes(SINGLE_QUOTE)) return SINGLE_QUOTE + w + SINGLE_QUOTE
      let quoted = DOUBLE_QUOTE
      for (const c of w) quoted += DOUBLE_QUOTE_ESCAPES.has(c) ? BACKSLASH + c : c
      return quoted + DOUBLE_QUOTE
    })
    .join(' ')
}

/**
 * The rule a shell command matches, with the simple command that matched as
 * evidence (so a caller with a size limit can send the part that matters),
 * or null.
 *
 * @param {unknown} command
 * @returns {{ ruleId: HardFloorRuleId, evidence: string } | null}
 */
export function commandFloorMatch(command) {
  const text = asString(command).slice(0, HARD_FLOOR_MAX_TEXT)
  if (!text.trim()) return null
  /** @type {Map<HardFloorRuleId, string>} */
  const found = new Map()
  commandRules(text, found, 0)
  const match = firstMatch(found)
  return match ? { ruleId: match.ruleId, evidence: match.evidence } : null
}

/** @param {unknown} command @returns {HardFloorRuleId | null} */
export function classifyCommand(command) {
  const match = commandFloorMatch(command)
  return match ? match.ruleId : null
}

// ── Paths ────────────────────────────────────────────────────────────────────

/**
 * The home folder as a path is written on Linux, macOS, Windows and WSL, and
 * as a variable. Neither copy of this list knows the owner's real home (the
 * server has none, and a daemon can see a different machine view than the
 * CLI), so every copy reads the same shapes.
 */
const HOME_PREFIXES = [
  /^~(?=\/|$)/,
  /^\$home(?=\/|$)/i,
  /^\$\{home\}(?=\/|$)/i,
  /^\$env:(userprofile|home)(?=\/|$)/i,
  /^%userprofile%(?=\/|$)/i,
  /^\/home\/[^/]+(?=\/|$)/,
  /^\/users\/[^/]+(?=\/|$)/i,
  /^\/root(?=\/|$)/,
  /^\/+\?\/[a-z]:\/users\/[^/]+(?=\/|$)/i,
  /^[a-z]:\/users\/[^/]+(?=\/|$)/i,
  /^\/mnt\/[a-z]\/users\/[^/]+(?=\/|$)/i,
]

/** @param {string} path @returns {string[] | null} */
function pathUnderHome(path) {
  for (const prefix of HOME_PREFIXES) {
    const match = prefix.exec(path)
    if (match) {
      return path
        .slice(match[0].length)
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
    }
  }
  return null
}

/** `~/.bashrc` (a dot file in home) or `~/.ssh/config` (a file directly in a dot folder of home). */
function isHomeSettingsFile(rest) {
  if (rest.length === 0 || rest.length > 2) return false
  const top = rest[0]
  return top.startsWith('.') && top !== '..' && top.length > 1
}

/** @param {unknown} filePath @param {Map<HardFloorRuleId, string>} found */
function pathRules(filePath, found) {
  const raw = asString(filePath)
  const path = raw.trim().replace(/\\/g, '/')
  if (!path) return
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return
  const lower = segments.map((segment) => segment.toLowerCase())
  if (lower.slice(0, -1).includes('.git')) note(found, 'git_dir_write', raw)
  const name = lower[lower.length - 1]
  if (name === '.env' || name.startsWith('.env.')) note(found, 'env_file_write', raw)
  const rest = pathUnderHome(path)
  if (rest && isHomeSettingsFile(rest)) note(found, 'home_dotfile_write', raw)
}

/** @param {unknown} filePath @returns {HardFloorRuleId | null} */
export function classifyPath(filePath) {
  /** @type {Map<HardFloorRuleId, string>} */
  const found = new Map()
  pathRules(filePath, found)
  return firstMatch(found)?.ruleId ?? null
}

// ── Tool names ───────────────────────────────────────────────────────────────

/**
 * The words that mean acting on the owner's behalf, matched as WHOLE words of
 * the tool's own name, so `payload`, `poster`, `sender` and `sends` never ride
 * along (the Agent Browser's SENSITIVE_PATTERNS reasoning).
 */
const ACTION_WORDS = new Set([
  'send',
  'post',
  'publish',
  'tweet',
  'reply',
  'submit',
  'pay',
  'purchase',
  'transfer',
  'delete',
  'remove',
  'erase',
])

/** This channel's own MCP server, by exact name only (HOAI_OWN_SERVERS). */
export function isOwnChannelServer(server) {
  return HOAI_OWN_SERVERS.includes(asString(server).toLowerCase())
}

/** @param {string} name @returns {{ server: string, tool: string } | null} */
function splitMcpName(name) {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  if (cut <= 0 || cut + 2 >= rest.length) return null
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}

/** A tool name's words: split on spaces, `_`, `-`, `.`, `:`, `/` and camelCase, lowercased. */
export function toolNameWords(name) {
  return asString(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.:/]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase())
}

/** An MCP tool (`mcp__<server>__<name>`) whose NAME sends, posts, pays or
 *  deletes, from any server but this channel's own.
 *  @param {unknown} toolName @returns {HardFloorRuleId | null} */
export function classifyToolName(toolName) {
  const parts = splitMcpName(asString(toolName).trim())
  if (!parts || isOwnChannelServer(parts.server)) return null
  return toolNameWords(parts.tool).some((word) => ACTION_WORDS.has(word)) ? 'acts_on_owners_behalf' : null
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
    /** @type {Map<HardFloorRuleId, string>} */
    const found = new Map()
    for (const key of ['file_path', 'notebook_path']) {
      if (typeof input[key] === 'string') pathRules(input[key], found)
    }
    return firstMatch(found)
  }
  const ruleId = classifyToolName(name)
  return ruleId ? matchFor(ruleId, name) : null
}

/**
 * The CLI's mark for a field value it cut in the middle (Claude Code
 * 2.1.281, truncateForPreview): a value over 3500 code points keeps its first
 * 2000 and its last 1500, with this line between them.
 */
export const PREVIEW_ELISION_RE = /\n\u22EF \d+ code points? elided \u22EF\n/

/** True when a preview string carries the CLI's middle cut anywhere in it. */
export function previewIsElided(inputPreview) {
  return PREVIEW_ELISION_RE.test(asString(inputPreview))
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    if (isRecord(value)) return value
  } catch {
    /* Not JSON, or JSON cut short: the caller salvages the leading keys. */
  }
  return null
}

/**
 * A JSON string body read back to its text. An ODD run of trailing
 * backslashes is an escape the cut landed inside. A raw newline, which the
 * CLI's elision mark puts inside the string, is escaped first so it parses.
 */
function unescapeJsonString(body) {
  const trailing = /\\*$/.exec(body)?.[0].length ?? 0
  const safe = trailing % 2 === 1 ? body.slice(0, -1) : body
  try {
    const value = JSON.parse(`"${safe.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`)
    return typeof value === 'string' ? value : safe
  } catch {
    return safe
  }
}

/**
 * A preview cut short, or cut in the middle, is no longer JSON, but the keys
 * the floor reads come FIRST in a Claude Code input (`command` before
 * `description`, `file_path` before `content`), so they survive. A value that
 * was itself cut is read up to where it stops.
 */
function salvageJsonKeys(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const key of ['command', 'file_path', 'notebook_path']) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text)
    if (match) out[key] = unescapeJsonString(match[1])
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * The tool input a permission request's `input_preview` carries: the JSON
 * the CLI renders, or, cut, the leading keys that survived the cut; plain
 * text is the shell tool's command or the edit tool's path.
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
    return parseJsonObject(text) ?? salvageJsonKeys(text) ?? {}
  }
  if (FLOOR_SHELL_TOOLS.includes(name)) return { command: text }
  if (FLOOR_EDIT_TOOLS.includes(name)) return { file_path: text }
  return {}
}

/**
 * Classify a permission request as the relay receives it: a tool name and the
 * CLI's `input_preview` string. A LOSSY view (the CLI cuts a long value in the
 * middle), which is why the relay reads the hook's floor record first and
 * this only when there is none.
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
      /** @type {Map<HardFloorRuleId, string>} */
      const found = new Map()
      pathRules(input.path, found)
      return firstMatch(found)
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
