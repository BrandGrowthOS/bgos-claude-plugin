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
 * The LAST such composer on screen is the live one. A placeholder is text
 * drawn faint (SGR 2, bright black, or a grey of the 256 or true colour
 * ranges); the cursor may sit on its first letter in inverse video. Anything
 * else visible between the prompt and the closing frame is the owner's draft.
 * These layouts are the CLI's today; a live check on the supported version
 * must confirm them before the capability is advertised to anyone (RESULT.md).
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

function isGreyIndex(n: number): boolean {
  return n === 8 || (n >= 236 && n <= 250)
}

/** The visible characters of a raw line, with whether each is drawn faint. */
function glyphs(raw: string): Glyph[] {
  const out: Glyph[] = []
  let dim = false
  let greyFg = false
  let inverse = false
  for (const m of raw.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) {
      const params = m[1] === '' ? [0] : m[1].split(';').map((n) => Number(n))
      for (let i = 0; i < params.length; i++) {
        const p = params[i]!
        if (p === 0) {
          dim = false
          greyFg = false
          inverse = false
        } else if (p === 2) dim = true
        else if (p === 22) dim = false
        else if (p === 7) inverse = true
        else if (p === 27) inverse = false
        else if (p === 90) greyFg = true
        else if (p === 39 || (p >= 30 && p <= 37) || (p >= 91 && p <= 97)) greyFg = false
        else if (p === 38 && params[i + 1] === 5) {
          greyFg = isGreyIndex(params[i + 2] ?? -1)
          i += 2
        } else if (p === 38 && params[i + 1] === 2) {
          const [r, g, b] = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0]
          greyFg = Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r <= 180
          i += 4
        } else if (p === 48 && (params[i + 1] === 5 || params[i + 1] === 2)) {
          i += params[i + 1] === 5 ? 2 : 4
        }
      }
      continue
    }
    if (m[2] === undefined) continue
    out.push({ ch: m[2], faint: dim || greyFg, inverse })
  }
  return out
}

function isBlank(g: Glyph): boolean {
  return g.ch.trim() === ''
}

/** Does this run of visible characters hold anything the owner typed? */
function holdsDraft(chars: readonly Glyph[]): boolean {
  const visible = chars.filter((g) => !isBlank(g))
  if (visible.length === 0) return false
  if (visible.every((g) => g.faint)) return false
  // The cursor, drawn inverse on the first letter of a faint placeholder.
  const [head, ...rest] = visible
  if (head!.inverse && rest.length > 0 && rest.every((g) => g.faint)) return false
  return true
}

/**
 * Anything drawn before the cursor is typed, spaces included: the cursor sits
 * right after the prompt in an empty composer, so spaces the owner typed show
 * only as the distance to it.
 */
function typedBeforeCursor(chars: readonly Glyph[]): boolean {
  const at = chars.findIndex((g) => g.inverse)
  return at > 0 && chars.slice(0, at).some((g) => !g.faint)
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
  if (holdsDraft(composer.first) || typedBeforeCursor(composer.first)) return 'draft'
  for (const line of composer.more) {
    const visible = line.filter((g) => !isBlank(g))
    if (visible.length === 0 || visible.some((g) => !g.faint)) return 'draft'
  }
  return composer.more.length > 0 ? 'unknown' : 'empty'
}

/**
 * The text typed into the composer, exactly: faint text (a placeholder or a
 * hint) left out, trailing blanks and the drawn cursor trimmed from each line,
 * lines joined with a newline. Null when no composer is recognisable.
 */
export function composerText(capture: string): string | null {
  const composer = locateComposer(capture)
  if (!composer) return null
  const typed = (chars: Glyph[]) => chars.filter((g) => !g.faint).map((g) => g.ch).join('').replace(/\s+$/u, '')
  return [composer.first, ...composer.more].map(typed).join('\n')
}

/** Is `literal` sitting in the composer (typed and never submitted)? */
export function composerHolds(capture: string, literal: string): boolean {
  const composer = locateComposer(capture)
  if (!composer) return false
  const text = [composer.first, ...composer.more].map((chars) => chars.map((g) => g.ch).join('')).join(' ')
  return text.includes(literal)
}
