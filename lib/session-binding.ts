// ── Positive self-session transcript binding ─────────────────────────────────
//
// Problem: the contextPct gauge used to read the newest-mtime transcript in
// the Claude project dir mapped from the daemon's cwd. Any OTHER session
// sharing the cwd (an orchestrator shell, a second claude, a worker) could
// own the newest mtime, so the gauge froze or tracked a stranger's session.
//
// Signals investigated on this fleet (2026-07-18, live daemons inspected):
//
//   1. env CLAUDE_CODE_SESSION_ID: the CLI sets it for MCP stdio children.
//      RELIABLE for fresh launches (`claude` with no resume: the transcript
//      file <id>.jsonl exists and is written). UNRELIABLE for `--continue`
//      launches (most of this fleet, BGOS_CONTINUE=1): the env id is a
//      pre-generated id that is DISCARDED when the CLI resumes the previous
//      session and keeps appending to the OLD <old-id>.jsonl. Verified:
//      daemons 91759/95118/95678 each carried an env id with no matching
//      file, while a no-continue daemon (94034) matched exactly.
//   2. lsof on the parent CLI process: the CLI does not hold the transcript
//      open between appends. Dead end.
//   3. Reply markers (chosen): every successful `reply` tool call returns
//      "Sent (message_id: N)" and the CLI writes that tool_result VERBATIM
//      into OUR transcript as a type "user" entry (verified in live
//      transcripts). The daemon minted N, so finding it in a transcript tail
//      is positive proof that transcript belongs to THIS session. Survives
//      --continue AND mid-life session rotation (/clear), self-healing on
//      the next reply.
//
// Resolution chain (strongest evidence first):
//   marker hit > sticky marker binding > env session id file >
//   sticky previous binding > UNAMBIGUOUS newest-mtime (last resort, logged).
//
// The newest-mtime last resort is still correct at daemon BOOT for
// --continue launches: --continue itself picks the newest-mtime session at
// CLI start, and the daemon starts in the same instant. But when two or more
// sessions share the project dir, the newest mtime is a coin toss on a
// neighbour's transcript, so the last resort fires only when it cannot be
// wrong about WHICH file is plausibly ours: a sole candidate, or exactly one
// candidate active within AMBIGUITY_WINDOW_MS. Anything else and the binder
// refuses to guess, staying unbound (gauge unreported) until the first reply
// marker proves a transcript. The sticky rule then prevents a later foreign
// session from stealing the binding, and the first reply marker upgrades the
// binding to positive proof.

import {
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// NB: .ts extension (not .js): node's type stripping resolves specifiers
// literally, so the .js form only works under bun. Same convention as
// lib/resting.ts; tsconfig has allowImportingTsExtensions.
import { latestContextPctFromJsonl, mungeCwd } from './usage-report.ts'

export type BindingSource = 'marker' | 'env' | 'sticky' | 'newest-mtime'

export interface Binding {
  /** Transcript file name (basename, <session-id>.jsonl). */
  name: string
  source: BindingSource
}

export interface TranscriptCandidate {
  name: string
  mtimeMs: number
}

export interface TailReading {
  name: string
  chunk: string
}

/**
 * Pure: does this JSONL chunk contain `marker` on a line that parses as a
 * type "user" transcript entry (the shape a tool_result is recorded as)?
 * The parse check keeps a foreign transcript that merely DISCUSSES a marker
 * string in prose from matching in most cases, and rejects garbage tails.
 */
export function tailContainsMarker(chunk: string, marker: string): boolean {
  if (!chunk.includes(marker)) return false
  for (const line of chunk.split('\n')) {
    if (!line.includes(marker)) continue
    try {
      const entry = JSON.parse(line.trim()) as Record<string, unknown>
      if (entry && entry.type === 'user') return true
    } catch {
      /* partial/corrupt line */
    }
  }
  return false
}

/**
 * Pure: find the transcript whose tail contains the NEWEST marker (markers
 * are ordered newest first). Returns its name or null.
 */
export function findMarkerFile(
  tails: TailReading[],
  markers: readonly string[],
): string | null {
  for (const marker of markers) {
    for (const t of tails) {
      if (tailContainsMarker(t.chunk, marker)) return t.name
    }
  }
  return null
}

/**
 * A candidate counts as "recent" when its mtime falls within this window of
 * now. The newest-mtime last resort fires only for a sole candidate or a
 * sole recent candidate; two or more recent candidates are ambiguous.
 */
export const AMBIGUITY_WINDOW_MS = 10 * 60_000

/**
 * Pure resolution chain. `previous` is the currently-held binding (sticky);
 * `markerFile` is the result of the marker scan (or null when no markers
 * exist yet / nothing matched); `envSessionId` is CLAUDE_CODE_SESSION_ID;
 * `now` (Date.now()) anchors the ambiguity window of the last resort.
 */
export function resolveBinding(args: {
  candidates: TranscriptCandidate[]
  envSessionId: string | null
  markerFile: string | null
  previous: Binding | null
  now: number
}): Binding | null {
  const names = new Set(args.candidates.map((c) => c.name))
  // 1. Fresh positive proof: a transcript containing OUR reply marker.
  if (args.markerFile && names.has(args.markerFile)) {
    return { name: args.markerFile, source: 'marker' }
  }
  // 2. Sticky positive proof: a marker-proven binding stays authoritative
  //    while its file exists (a scan miss just means the tail rolled past
  //    the marker, not that the binding went bad).
  if (args.previous?.source === 'marker' && names.has(args.previous.name)) {
    return args.previous
  }
  // 3. The CLI-assigned session id, when its transcript actually exists
  //    (fresh launches; --continue discards the id, see header).
  if (args.envSessionId) {
    const envName = `${args.envSessionId}.jsonl`
    if (names.has(envName)) return { name: envName, source: 'env' }
  }
  // 4. Sticky previous binding: never let a foreign session steal the
  //    binding just by having a newer mtime (the original bug).
  if (args.previous && names.has(args.previous.name)) return args.previous
  // 5. Last resort: newest mtime, but ONLY when unambiguous. A sole
  //    candidate is safe even when stale (nothing else exists to confuse it
  //    with). Otherwise exactly one candidate active within
  //    AMBIGUITY_WINDOW_MS is required; two or more recent candidates mean
  //    the newest mtime would guess a neighbour's transcript, so refuse and
  //    stay unbound until a reply marker proves a transcript (see header).
  if (args.candidates.length === 1) {
    return { name: args.candidates[0]!.name, source: 'newest-mtime' }
  }
  const recent = args.candidates.filter(
    (c) => args.now - c.mtimeMs <= AMBIGUITY_WINDOW_MS,
  )
  if (recent.length === 1) {
    return { name: recent[0]!.name, source: 'newest-mtime' }
  }
  return null
}

/** Reply markers kept for scanning (newest first). */
const MARKER_LIMIT = 8
/** Tail window per transcript for marker scans and pct reads. */
const TAIL_BYTES = 256 * 1024
/** Only marker-scan transcripts active within this window. */
const MARKER_SCAN_RECENT_MS = 30 * 60_000

/**
 * Stateful binder: one per daemon process. Owns the fs walk, the marker
 * list, and the cached binding. All failures degrade to null (telemetry
 * must never throw into the caller).
 */
export class SessionTranscriptBinder {
  private readonly projectDir: string
  private readonly envSessionId: string | null
  private readonly log: (msg: string) => void
  private markers: string[] = []
  private binding: Binding | null = null
  private loggedFallback = false
  private loggedRefusal = false

  constructor(
    cwd: string,
    opts: {
      claudeHome?: string
      envSessionId?: string | null
      log?: (msg: string) => void
    } = {},
  ) {
    this.projectDir = join(
      opts.claudeHome ?? join(homedir(), '.claude'),
      'projects',
      mungeCwd(cwd),
    )
    this.envSessionId = opts.envSessionId ?? null
    this.log = opts.log ?? (() => {})
  }

  /**
   * Record the message id a successful `reply` returned. The transcript
   * entry the CLI writes contains the literal "Sent (message_id: <id>";
   * that prefix is the marker.
   */
  recordReplyMessageId(messageId: string | number): void {
    const marker = `Sent (message_id: ${messageId}`
    this.markers = [marker, ...this.markers.filter((m) => m !== marker)].slice(
      0,
      MARKER_LIMIT,
    )
  }

  /** Resolve (and cache) THIS session's transcript path. Null when unknown. */
  resolve(now: number = Date.now()): { path: string; binding: Binding } | null {
    let candidates: TranscriptCandidate[]
    try {
      candidates = readdirSync(this.projectDir)
        .filter((n) => n.endsWith('.jsonl'))
        .map((name) => {
          try {
            return { name, mtimeMs: statSync(join(this.projectDir, name)).mtimeMs }
          } catch {
            return null
          }
        })
        .filter((c): c is TranscriptCandidate => c !== null)
    } catch {
      return null
    }

    let markerFile: string | null = null
    if (this.markers.length > 0) {
      // Cheap path first: if the current binding's tail still carries the
      // newest marker, skip scanning the rest of the directory.
      const newest = this.markers[0]!
      if (
        this.binding &&
        candidates.some((c) => c.name === this.binding!.name) &&
        tailContainsMarker(this.readTail(this.binding.name), newest)
      ) {
        markerFile = this.binding.name
      } else {
        const recent = candidates.filter(
          (c) => now - c.mtimeMs <= MARKER_SCAN_RECENT_MS,
        )
        const tails: TailReading[] = recent.map((c) => ({
          name: c.name,
          chunk: this.readTail(c.name),
        }))
        markerFile = findMarkerFile(tails, this.markers)
      }
    }

    const next = resolveBinding({
      candidates,
      envSessionId: this.envSessionId,
      markerFile,
      previous: this.binding,
      now,
    })
    if (!next) {
      // Several transcripts and no positive signal: refusing the guess is
      // the point of the ambiguity rule, so say so, once.
      if (candidates.length > 1 && !this.loggedRefusal) {
        this.log(
          'session binding: several recent transcripts and no positive ' +
            'signal yet, refusing to guess (binds on the first reply)',
        )
        this.loggedRefusal = true
      }
      return null
    }
    if (
      !this.binding ||
      this.binding.name !== next.name ||
      this.binding.source !== next.source
    ) {
      this.log(`session binding: ${next.name} via ${next.source}`)
    }
    if (next.source === 'newest-mtime' && !this.loggedFallback) {
      this.log(
        'session binding: no positive session signal yet, binding the ' +
          'unambiguous newest-mtime transcript as last resort (upgrades to ' +
          'positive proof on the first reply)',
      )
      this.loggedFallback = true
    }
    this.binding = next
    return { path: join(this.projectDir, next.name), binding: next }
  }

  /** Tail of the currently-bound transcript, or null when unbound. */
  readBoundTail(): string | null {
    const resolved = this.resolve()
    if (!resolved) return null
    const chunk = this.readTail(resolved.binding.name)
    return chunk.length > 0 ? chunk : null
  }

  /** Context-window fill (0..100) of THIS session, or null when unknown. */
  readContextPct(): number | null {
    try {
      const chunk = this.readBoundTail()
      if (chunk === null) return null
      return latestContextPctFromJsonl(chunk)
    } catch {
      return null
    }
  }

  private readTail(name: string, bytes: number = TAIL_BYTES): string {
    try {
      const fd = openSync(join(this.projectDir, name), 'r')
      try {
        const size = fstatSync(fd).size
        const from = Math.max(0, size - bytes)
        const buf = Buffer.alloc(size - from)
        const read = readSync(fd, buf, 0, buf.length, from)
        return buf.subarray(0, read).toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return ''
    }
  }
}
