/**
 * model-effort-pane: what the daemon reads from the agent's tmux pane before
 * it types a model or effort command into it (owner model and effort control,
 * Route A). Pure readers over tmux and ps output; the argv that produce that
 * output are built in lib/compact-inject.ts, and the transaction that decides
 * on the answers is lib/model-effort-control.ts.
 *
 * Every reader is fail closed. A pane whose state cannot be parsed is lost; a
 * pane the daemon cannot prove is its own is not the agent's; a screen with
 * no recognisable composer is "unknown", never "empty". Nothing here clears
 * or discards anything: an owner's draft is a refusal, not an obstacle.
 *
 * THE COMPOSER LAYOUTS are the two the CLI is known to draw, as tmux
 * capture-pane -e prints them (styling kept, so a dimmed placeholder can be
 * told from typed text):
 *
 *   the rule framed prompt        the older box
 *   ────────────────────          ╭──────────────────╮
 *   ❯ <draft>                     │ > <draft>        │
 *   ────────────────────          ╰──────────────────╯
 *
 * The LAST such composer on screen is the live one. Empty must be PROVEN,
 * from what the CLI itself draws (Claude Code 2.1.310, measured in its light
 * and dark themes, 256 and true colour, and read from its own placeholder
 * code: test/fixtures/claude-2.1.310-composer, RESULT.md "Round 2"):
 *
 *   - the cursor is an inverse cell; in an empty composer it sits right
 *     after the prompt (the glyph, then a no-break space);
 *   - the placeholder is SGR 2 (dim) text with the cursor's inverse cell on
 *     its first letter, which itself is not dim;
 *   - typed text is drawn in whatever colour the theme or a highlight gives
 *     it, black and grey included, so colour never makes text "faint".
 *
 * So the composer is empty only when the cursor is drawn at its very start
 * and is followed by nothing, or by an SGR 2 placeholder that is not one of
 * the CLI's own reference tags ([Pasted text #1], [Image #1]). Anything
 * before the cursor, anything not dim after it, or any line between the
 * prompt and the closing frame is the owner's draft; no cursor drawn, or a
 * shape the CLI does not draw, is unknown. When in doubt, never empty.
 */

export interface PaneState {
  /** tmux pane id, %N. */
  paneId: string
  /** The pane's terminal, /dev/... */
  tty: string
  /** The pane's process exited (remain-on-exit keeps a dead pane). */
  dead: boolean
  /** Copy or view mode: keys go to tmux, not to the program. */
  inMode: boolean
  /** The pane's root process. */
  pid: number
}

/** Parse lib/compact-inject.ts PANE_STATE_FORMAT, or null for anything else. */
export function parsePaneState(stdout: string): PaneState | null {
  const fields = String(stdout ?? '').replace(/\r?\n$/, '').split('\t')
  if (fields.length !== 5) return null
  const [paneId, tty, dead, inMode, pid] = fields as [string, string, string, string, string]
  if (!/^%\d+$/.test(paneId)) return null
  if (!/^\/dev\/\S+$/.test(tty)) return null
  if (!/^[01]$/.test(dead) || !/^[01]$/.test(inMode)) return null
  if (!/^\d+$/.test(pid)) return null
  return { paneId, tty, dead: dead === '1', inMode: inMode === '1', pid: Number(pid) }
}

/** One process as `ps -o pid=,ppid=,tty=,pgid=,tpgid=` reports it. */
export interface ProcessEntry {
  pid: number
  /** As ps prints it: ttys012 on macOS, pts/3 on Linux, ?? or ? for none. */
  tty: string
  pgid: number
  /** The terminal's foreground process group, -1 or 0 with no terminal. */
  tpgid: number
}

/**
 * Is the pane the agent's own, with the agent's job in front?
 *
 * `ancestry` runs from the daemon up (the daemon first, then its parent, and
 * so on). Two things must hold:
 *
 *   1. the pane's root process is one of the daemon's ancestors, so the pane
 *      the target names is the terminal this agent's CLI really runs in, and
 *      not a pane that merely exists;
 *   2. the terminal's foreground group is the group of a process of the
 *      daemon's chain BELOW that root. The root itself does not count: when
 *      the pane runs a shell that started the CLI, a suspended CLI puts that
 *      shell in front, and the shell is an ancestor too.
 *
 * Every process counted must be on the pane's terminal.
 */
export function agentOwnsPane(paneTty: string, panePid: number, ancestry: readonly ProcessEntry[]): boolean {
  if (!/^\/dev\/\S+$/.test(paneTty)) return false
  const ttyName = paneTty.slice('/dev/'.length)
  const rootAt = ancestry.findIndex((p) => p.pid === panePid)
  if (rootAt < 0) return false
  const root = ancestry[rootAt]!
  if (root.tty !== ttyName) return false
  const foreground = root.tpgid
  if (!(foreground > 0)) return false
  // A pane whose root IS the CLI (no shell between): the daemon, the CLI's
  // child, is below it and in its group.
  return ancestry.slice(0, rootAt).some((p) => p.tty === ttyName && p.tpgid === foreground && p.pgid === foreground)
}

/**
 * Walk up from `pid` with ps, one process per call, at most `max` steps.
 * Stops at pid 1 or at the first process ps cannot describe.
 */
export async function processAncestry(
  pid: number,
  run: (argv: string[]) => Promise<string>,
  max = 12,
): Promise<ProcessEntry[]> {
  const chain: ProcessEntry[] = []
  let next = pid
  while (next > 1 && chain.length < max) {
    let out: string
    try {
      out = await run(['ps', '-o', 'pid=,ppid=,tty=,pgid=,tpgid=', '-p', String(next)])
    } catch {
      break
    }
    const parts = out.trim().split(/\s+/)
    if (parts.length !== 5) break
    const [p, pp, tty, pgid, tpgid] = parts as [string, string, string, string, string]
    if (![p, pp, pgid, tpgid].every((n) => /^-?\d+$/.test(n))) break
    chain.push({ pid: Number(p), tty, pgid: Number(pgid), tpgid: Number(tpgid) })
    next = Number(pp)
  }
  return chain
}

export type ComposerState = 'empty' | 'draft' | 'unknown'

interface Glyph {
  ch: string
  faint: boolean
  inverse: boolean
}

// SGR, any other CSI, and OSC sequences; anything else is one character.
// eslint-disable-next-line no-control-regex
const TOKEN_RE = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b.|([\s\S])/gu

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./g

function plain(line: string): string {
  return line.replace(ANSI_RE, '')
}

/**
 * The visible characters of a raw line, with whether each is drawn faint.
 * Faint is SGR 2 and nothing else: the CLI draws its placeholder with it
 * (chalk dim). No colour is faint, grey and black included: the light themes
 * draw text in rgb(0,0,0) (round 2 on PR #275).
 */
function glyphs(raw: string): Glyph[] {
  const out: Glyph[] = []
  let dim = false
  let inverse = false
  for (const m of raw.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) {
      const params = m[1] === '' ? [0] : m[1].split(';').map((n) => Number(n))
      for (let i = 0; i < params.length; i++) {
        const p = params[i]!
        if (p === 0) {
          dim = false
          inverse = false
        } else if (p === 2) dim = true
        else if (p === 22) dim = false
        else if (p === 7) inverse = true
        else if (p === 27) inverse = false
        else if ((p === 38 || p === 48 || p === 58) && (params[i + 1] === 5 || params[i + 1] === 2)) {
          // A colour's own numbers are never attributes: 38;5;2 is not dim.
          i += params[i + 1] === 5 ? 2 : 4
        }
      }
      continue
    }
    if (m[2] === undefined) continue
    out.push({ ch: m[2], faint: dim, inverse })
  }
  return out
}

function isBlank(g: Glyph): boolean {
  return g.ch.trim() === ''
}

// The CLI's own references to content it holds for the owner: pasted text,
// an image, a truncated paste. Never a placeholder, dim or not.
const REFERENCE_TAG_RE = /^\[(?:Pasted text #\d+|Image #\d+|\.\.\.Truncated text #\d+|\u2726 Team setup guide #\d+)/u

/**
 * The prompt line, after the prompt: empty only in the CLI's two empty
 * shapes, the cursor alone or the cursor on the first letter of its
 * placeholder. Anything drawn before the cursor is typed, spaces and dim text
 * included: the cursor sits right after the prompt in an empty composer.
 */
function readPromptLine(chars: readonly Glyph[]): ComposerState {
  const at = chars.findIndex((g) => g.inverse)
  if (at > 0) return 'draft'
  const cursor = at === 0 ? chars[0]! : null
  const rest = at === 0 ? chars.slice(1) : chars
  if (rest.some((g) => !isBlank(g) && !g.faint)) return 'draft'
  // No cursor drawn: typed spaces and a dim draft cannot be told from nothing.
  if (!cursor) return 'unknown'
  if (rest.some((g) => g.inverse)) return 'unknown'
  const after = rest.filter((g) => !isBlank(g))
  if (isBlank(cursor)) return after.length === 0 ? 'empty' : 'unknown'
  // The cursor on a letter: one typed letter, or the placeholder's first.
  if (after.length === 0) return 'draft'
  if (cursor.faint) return 'unknown'
  const text = chars.map((g) => g.ch).join('')
  if (REFERENCE_TAG_RE.test(text)) return 'draft'
  return 'empty'
}

const RULE_RE = /^\s*[─━]{8,}\s*$/
const BOX_TOP_RE = /^\s*╭─{4,}╮?\s*$/
const BOX_BOTTOM_RE = /^\s*╰─{4,}╯?\s*$/
const RULE_PROMPT_RE = /^\s*[❯>](?:\s|$)/
const BOX_PROMPT_RE = /^\s*│\s*[❯>](?:\s|$)/

interface Composer {
  /** What follows the prompt glyph on the prompt line, its one separating space removed. */
  first: Glyph[]
  /** The continuation lines, frame characters removed. */
  more: Glyph[][]
}

/** A line of the older box without its left and right frame characters. */
function unframe(chars: Glyph[]): Glyph[] {
  let start = 0
  while (start < chars.length && isBlank(chars[start]!)) start++
  let end = chars.length
  while (end > start && isBlank(chars[end - 1]!)) end--
  const out = chars.slice()
  if (end - start >= 2 && out[end - 1]!.ch === '│') out.splice(end - 1, 1)
  if (end > start && out[start]!.ch === '│') out.splice(start, 1)
  return out
}

/**
 * The prompt line after its glyph. The glyph is the FIRST visible character
 * of the line (after the box's frame), the one the prompt patterns matched,
 * never a `❯` or `>` found further along: those are the owner's draft
 * (REVIEW-275 H1, a draft such as `const f = () =>` read as empty).
 */
function afterPrompt(chars: Glyph[]): Glyph[] | null {
  let at = 0
  while (at < chars.length && isBlank(chars[at]!)) at++
  const glyph = chars[at]
  if (!glyph || (glyph.ch !== '❯' && glyph.ch !== '>')) return null
  const rest = chars.slice(at + 1)
  if (rest.length > 0 && isBlank(rest[0]!) && !rest[0]!.inverse) rest.shift()
  return rest
}

function locateComposer(capture: string): Composer | null {
  const raws = String(capture ?? '').split('\n').map((l) => l.replace(/\r$/, ''))
  const lines = raws.map(plain)
  for (let i = lines.length - 1; i >= 1; i--) {
    const above = lines[i - 1]!
    const boxed = BOX_PROMPT_RE.test(lines[i]!) && BOX_TOP_RE.test(above)
    const ruled = RULE_PROMPT_RE.test(lines[i]!) && RULE_RE.test(above)
    if (!boxed && !ruled) continue
    const close = boxed ? BOX_BOTTOM_RE : RULE_RE
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (close.test(lines[j]!)) {
        end = j
        break
      }
    }
    if (end < 0) return null
    const read = (raw: string) => (boxed ? unframe(glyphs(raw)) : glyphs(raw))
    const first = afterPrompt(read(raws[i]!))
    if (!first) return null
    const more = raws.slice(i + 1, end).map(read)
    return { first, more }
  }
  return null
}

/**
 * Is the agent's composer empty, holding a draft, or not recognisable?
 *
 * Empty means exactly one prompt line with nothing typed on it. Any line
 * between the prompt and the closing frame is the owner's: text, or a blank
 * line (a newline they typed, or a draft that filled the line and wrapped the
 * cursor). A continuation line drawn only faint is not known to be anything,
 * so it is unknown, refused like a missing composer.
 */
export function readComposer(capture: string): ComposerState {
  const composer = locateComposer(capture)
  if (!composer) return 'unknown'
  const first = readPromptLine(composer.first)
  if (first === 'draft') return 'draft'
  for (const line of composer.more) {
    const visible = line.filter((g) => !isBlank(g))
    if (visible.length === 0 || visible.some((g) => !g.faint)) return 'draft'
  }
  return composer.more.length > 0 ? 'unknown' : first
}

/**
 * Everything drawn in the composer, dim text included (a placeholder is only
 * there while nothing is typed, so after typing anything dim is the owner's,
 * or not known to be anything else), each line's trailing blanks and the
 * drawn cursor trimmed, lines joined with a newline. Null when no composer is
 * recognisable.
 */
export function composerText(capture: string): string | null {
  const composer = locateComposer(capture)
  if (!composer) return null
  const drawn = (chars: Glyph[]) => chars.map((g) => g.ch).join('').replace(/\s+$/u, '')
  return [composer.first, ...composer.more].map(drawn).join('\n')
}

/**
 * Is `literal` provably what sits right before the cursor, at the very end of
 * the composer? The cursor must be drawn, once, as a blank inverse cell on the
 * composer's LAST line with nothing after it, and that line must end with the
 * whole literal right before it. One BSpace per character then removes the
 * literal and nothing else. False for anything else, a literal that wrapped
 * included (round 2 on PR #275, L1: an arrow key moves the cursor).
 */
export function cursorFollows(capture: string, literal: string): boolean {
  const composer = locateComposer(capture)
  if (!composer || literal === '') return false
  const lines = [composer.first, ...composer.more]
  const cursors = lines.flatMap((line, row) => line.flatMap((g, col) => (g.inverse ? [{ row, col }] : [])))
  if (cursors.length !== 1) return false
  const { row, col } = cursors[0]!
  if (row !== lines.length - 1) return false
  const line = lines[row]!
  if (!isBlank(line[col]!) || line.slice(col + 1).some((g) => !isBlank(g))) return false
  return line.slice(0, col).map((g) => g.ch).join('').endsWith(literal)
}

/** Is `literal` sitting in the composer (typed and never submitted)? */
export function composerHolds(capture: string, literal: string): boolean {
  const composer = locateComposer(capture)
  if (!composer) return false
  const text = [composer.first, ...composer.more].map((chars) => chars.map((g) => g.ch).join('')).join(' ')
  return text.includes(literal)
}
