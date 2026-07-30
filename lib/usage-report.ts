/**
 * Per-turn usage self-report (BGOS capability #18, Fleet Pulse).
 *
 * Ground truth for a Claude Code agent's token usage lives in the session
 * transcript JSONL (`~/.claude/projects/<munged-cwd>/<session>.jsonl`): every
 * assistant turn is a line whose `message.usage` block carries the real
 * input/output/cache token counts and `message.model`. The MODEL cannot
 * self-report (it does not know its counts), so the plugin reads the
 * transcript on each `reply` and attaches the sum of the not-yet-reported
 * assistant entries to the send-message body.
 *
 * Accounting model: a byte-offset cursor per transcript file. Whatever was
 * appended since the last report is summed and the cursor advances, so
 * nothing is ever double-counted, and turns that end without a `reply`
 * (meeting replies, ask_user_input, pure-notification turns) roll into the
 * NEXT report instead of being lost. On first attach to a file that already
 * existed at server startup, the cursor starts at the file's startup size
 * (never re-report history a previous server instance already reported).
 *
 * Billing mode: Claude Code runs on Kc's Claude Max plan -> default
 * `subscription` (tokens only, NEVER dollars; the backend also drops
 * dollars defensively). `BGOS_USAGE_BILLING_MODE=api` marks API-key-billed
 * sessions; `BGOS_USAGE_REPORT=off` disables reporting entirely.
 *
 * Pure parsing/summing lives in `sumUsageFromJsonl` (unit-tested with no
 * fs); `UsageTracker` owns the fs walk + cursors.
 *
 * Canonical contract: hermes-channel-bgos/docs/bgos-agent-capabilities.md #18.
 */

import { readdirSync, readFileSync, openSync, readSync, closeSync, fstatSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface UsageReport {
  billingMode: 'subscription' | 'api'
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  source: string
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Last (most recent) model seen in the window. */
  model: string | null
  /** Assistant entries that contributed (0 -> nothing to report). */
  entries: number
}

/**
 * Sum the `message.usage` blocks of assistant entries in a JSONL chunk.
 * Dedupes by message id WITHIN the chunk: Claude Code appends one line per
 * streamed content block, so a single API turn (one message id, one billed
 * usage) can appear on several consecutive lines with the same usage
 * object; counting each line would multiply the turn by its block count.
 * Malformed lines (or a trailing partial line from reading a file that is
 * being appended to) are skipped.
 */
export function sumUsageFromJsonl(chunk: string): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: null,
    entries: 0,
  }
  const seenMessageIds = new Set<string>()
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue // partial/corrupt line, normal at a live file's tail
    }
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (e.type !== 'assistant') continue
    const message = e.message
    if (typeof message !== 'object' || message === null) continue
    const m = message as Record<string, unknown>
    const usage = m.usage
    if (typeof usage !== 'object' || usage === null) continue
    const msgId = typeof m.id === 'string' ? m.id : null
    if (msgId) {
      if (seenMessageIds.has(msgId)) continue
      seenMessageIds.add(msgId)
    }
    const u = usage as Record<string, unknown>
    const count = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
    totals.inputTokens += count(u.input_tokens)
    totals.outputTokens += count(u.output_tokens)
    totals.cacheReadTokens += count(u.cache_read_input_tokens)
    totals.cacheCreationTokens += count(u.cache_creation_input_tokens)
    if (typeof m.model === 'string' && m.model) totals.model = m.model
    totals.entries += 1
  }
  return totals
}

/** Build the wire block from summed totals; null when there is nothing. */
export function buildUsageReport(
  totals: UsageTotals,
  env: Record<string, string | undefined> = process.env,
): UsageReport | null {
  if ((env.BGOS_USAGE_REPORT ?? '').toLowerCase() === 'off') return null
  if (totals.entries === 0) return null
  const billingMode =
    (env.BGOS_USAGE_BILLING_MODE ?? '').toLowerCase() === 'api' ? 'api' : 'subscription'
  const report: UsageReport = { billingMode, source: 'claude-code-jsonl' }
  if (totals.model) report.model = totals.model
  if (totals.inputTokens > 0) report.inputTokens = totals.inputTokens
  if (totals.outputTokens > 0) report.outputTokens = totals.outputTokens
  if (totals.cacheReadTokens > 0) report.cacheReadTokens = totals.cacheReadTokens
  if (totals.cacheCreationTokens > 0) report.cacheCreationTokens = totals.cacheCreationTokens
  if (
    report.inputTokens === undefined &&
    report.outputTokens === undefined &&
    report.cacheReadTokens === undefined &&
    report.cacheCreationTokens === undefined
  ) {
    return null
  }
  return report
}

/**
 * Claude Code's project-directory munging: every non-alphanumeric character
 * of the workspace cwd becomes `-` (verified against real
 * `~/.claude/projects` entries, e.g. `Marketing Data - Documents` ->
 * `Marketing-Data---Documents`).
 */
export function mungeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Stateful transcript reader. One instance per server process; `collect()`
 * is called from the `reply` tool and returns the not-yet-reported usage
 * (advancing the cursor), or null when there is nothing new / reporting is
 * disabled / the transcript is unreachable. All failures are swallowed:
 * a reply must never fail because usage could not be read.
 */
export class UsageTracker {
  private readonly projectDir: string
  /** Byte sizes of transcript files at server startup (never re-report history). */
  private readonly startupSizes = new Map<string, number>()
  private readonly cursors = new Map<string, number>()

  constructor(cwd: string, claudeHome: string = join(homedir(), '.claude')) {
    this.projectDir = join(claudeHome, 'projects', mungeCwd(cwd))
    try {
      for (const name of readdirSync(this.projectDir)) {
        if (!name.endsWith('.jsonl')) continue
        try {
          this.startupSizes.set(name, statSync(join(this.projectDir, name)).size)
        } catch {
          /* file vanished between readdir and stat */
        }
      }
    } catch {
      /* project dir missing, collect() will keep returning null */
    }
  }

  /**
   * Sum usage appended to ANY session transcript in the project dir since
   * the last collect (files created after startup count from byte 0). The
   * newest-active-session heuristic is unnecessary: cursors make reading
   * every file cheap (only appended bytes) and correct (a workspace with
   * two live sessions attributes both to this assistant, which is exactly
   * what "what does this agent cost" means).
   */
  collect(env: Record<string, string | undefined> = process.env): UsageReport | null {
    if ((env.BGOS_USAGE_REPORT ?? '').toLowerCase() === 'off') return null
    let names: string[]
    try {
      names = readdirSync(this.projectDir).filter(n => n.endsWith('.jsonl'))
    } catch {
      return null
    }
    const combined: UsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: null,
      entries: 0,
    }
    for (const name of names) {
      const filePath = join(this.projectDir, name)
      const from = this.cursors.get(name) ?? this.startupSizes.get(name) ?? 0
      let chunk: string | null = null
      let end = from
      try {
        const fd = openSync(filePath, 'r')
        try {
          const size = fstatSync(fd).size
          if (size > from) {
            const buf = Buffer.alloc(size - from)
            const read = readSync(fd, buf, 0, buf.length, from)
            chunk = buf.subarray(0, read).toString('utf8')
            end = from + read
          } else if (size < from) {
            // File truncated/rotated, restart from 0 next time.
            this.cursors.set(name, 0)
            continue
          }
        } finally {
          closeSync(fd)
        }
      } catch {
        continue
      }
      if (chunk === null) continue
      // Only advance past COMPLETE lines: a partial tail line is left for
      // the next collect so its usage is not lost mid-append.
      const lastNewline = chunk.lastIndexOf('\n')
      if (lastNewline === -1) continue
      const complete = chunk.slice(0, lastNewline + 1)
      this.cursors.set(name, from + Buffer.byteLength(complete, 'utf8'))
      void end
      const totals = sumUsageFromJsonl(complete)
      combined.inputTokens += totals.inputTokens
      combined.outputTokens += totals.outputTokens
      combined.cacheReadTokens += totals.cacheReadTokens
      combined.cacheCreationTokens += totals.cacheCreationTokens
      combined.entries += totals.entries
      if (totals.model) combined.model = totals.model
    }
    return buildUsageReport(combined, env)
  }
}

// ── Context-window fill (session controls, capability: contextPct) ──────────
// The LATEST assistant entry's usage block is a live snapshot of how full the
// context window is: input_tokens + cache_read_input_tokens +
// cache_creation_input_tokens is what the last API turn actually carried in.
// This is deliberately separate from the cumulative UsageTracker above (a
// running SUM says nothing about window fill). Approximate by nature: it lags
// one turn and resets after host compaction.

/**
 * Model families whose context window is 1M tokens. Matched as a PREFIX of the
 * transcript's model id, so dated and suffixed variants of the same family
 * resolve correctly.
 *
 * This table exists because the '[1m]' marker is not a usable signal: none of
 * the model ids Claude Code actually writes into a transcript carries it.
 * Measured on the live fleet 2026-07-30 - every running session logged a bare
 * id ('claude-opus-5', 'claude-opus-4-8', 'claude-fable-5'), all of which are
 * 1M-context models, and all of which the marker-only rule scored against a
 * 200k denominator. That inflated every reading below the overflow back-stop
 * by 5x (assistant 929: 114,485 tokens used reported as 57 percent when the
 * true fill was 11.4), and the gauge fires at 80, so the "context nearly full"
 * prompt reached the user at roughly a sixth of the real window.
 *
 * Keep this list conservative: an id that is NOT listed falls through to the
 * 200k default plus the overflow inference below, which is the previous
 * behaviour. Widening a genuinely-200k model would be the worse error - the
 * gauge would then never warn at all.
 *
 * REVISIT ON EVERY MODEL LAUNCH. Because these are matched as prefixes, a
 * future NARROWER-context variant published under a listed family prefix
 * (say a 200k 'claude-opus-5-mini') would be silently widened to 1M, which
 * is the failure direction that costs the user a warning. Prefix matching is
 * still right for the id shapes that actually occur - dated suffixes
 * ('claude-haiku-4-5-20251001'), '-fast', and '[1m]' variants all resolve
 * correctly - but the tradeoff is deliberate, not incidental.
 */
const MILLION_TOKEN_MODEL_PREFIXES = [
  'claude-opus-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5',
  'claude-mythos-5',
  // Predecessor of claude-mythos-5, same 1M window.
  'claude-mythos-preview',
] as const

/** Context-window size for a Claude Code model id: 1M when the id carries the
 *  '[1m]' long-context marker or names a known 1M-context family, else the
 *  standard 200k. */
export function windowForModel(model: string): number {
  const id = model.toLowerCase()
  // Normalised before the marker check so a '[1M]' variant is not missed.
  if (id.includes('[1m]')) return 1_000_000
  for (const prefix of MILLION_TOKEN_MODEL_PREFIXES) {
    if (id.startsWith(prefix)) return 1_000_000
  }
  return 200_000
}

/** Beyond any plausible overflow of the standard 200k window. A single API
 *  turn can slightly exceed 200k right before auto-compaction (observed
 *  ~205k), but a turn that carried MORE input than this must have run in a
 *  1M-context session even when the model id lacks the '[1m]' marker
 *  (observed in the wild: 1M Fable sessions log model 'claude-fable-5'
 *  with no marker, so used/200k computed 219 percent and the gauge sat
 *  pinned at a false 100). */
export const STANDARD_WINDOW_OVERFLOW_LIMIT = 220_000

/**
 * Context fill percent (0..100) of a single parsed transcript entry, or null
 * when the entry is not an assistant entry with a usage block. Shared by the
 * tail scanner below and by the compaction-confirmation watcher
 * (lib/compact-confirm.ts), so both compute the pct identically.
 */
export function contextPctOfAssistantEntry(entry: unknown): number | null {
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as Record<string, unknown>
  if (e.type !== 'assistant') return null
  const message = e.message
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>
  const usage = m.usage
  if (typeof usage !== 'object' || usage === null) return null
  const u = usage as Record<string, unknown>
  const count = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const used =
    count(u.input_tokens) +
    count(u.cache_read_input_tokens) +
    count(u.cache_creation_input_tokens)
  const model = typeof m.model === 'string' ? m.model : ''
  let window = windowForModel(model)
  // Window inference: when the marker-based guess says 200k but the turn
  // provably carried more input than a 200k window can hold, this was a
  // 1M-context session whose model id lacks the '[1m]' marker. Without
  // this, such sessions report a permanently pinned (and false) 100.
  if (window === 200_000 && used > STANDARD_WINDOW_OVERFLOW_LIMIT) {
    window = 1_000_000
  }
  // used * 100 first: keeps integer-divisible cases exact in floats.
  return Math.min(100, Math.max(0, (used * 100) / window))
}

/**
 * Scan a transcript JSONL chunk from the END and return the context fill
 * percent (0..100) of the most recent assistant entry that has a usage
 * block, or null when no such entry exists. Malformed lines are skipped.
 */
export function latestContextPctFromJsonl(chunk: string): number | null {
  const lines = chunk.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue // partial/corrupt line, normal at a live file's tail
    }
    const pct = contextPctOfAssistantEntry(entry)
    if (pct !== null) return pct
  }
  return null
}

/** How much of a live transcript's tail to inspect for the latest usage
 *  block. 256 KB spans far more than one turn's JSONL lines while keeping
 *  the heartbeat read cheap on multi-MB transcripts. */
const CONTEXT_PCT_TAIL_BYTES = 256 * 1024

/**
 * LEGACY newest-mtime heuristic, kept only as a test surface and as the
 * documented last-resort fallback. The live daemon now binds positively to
 * ITS OWN session transcript via lib/session-binding.ts
 * (SessionTranscriptBinder): newest-mtime can belong to a DIFFERENT session
 * sharing the same cwd, which produced frozen or wrong contextPct gauges.
 *
 * Best-effort context-window fill (0..100): the most recently modified
 * transcript in this workspace's Claude project dir, read from its tail.
 * Returns null when anything is unknown (no project dir, no transcript, no
 * usage entry in the tail, unparseable). Never throws.
 */
export async function readContextPct(
  cwd: string = process.cwd(),
  claudeHome: string = join(homedir(), '.claude'),
): Promise<number | null> {
  try {
    const projectDir = join(claudeHome, 'projects', mungeCwd(cwd))
    let newest: string | null = null
    let newestMtime = -1
    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const mtime = statSync(join(projectDir, name)).mtimeMs
        if (mtime > newestMtime) {
          newestMtime = mtime
          newest = name
        }
      } catch {
        /* file vanished between readdir and stat */
      }
    }
    if (!newest) return null
    const filePath = join(projectDir, newest)
    const fd = openSync(filePath, 'r')
    try {
      const size = fstatSync(fd).size
      const from = Math.max(0, size - CONTEXT_PCT_TAIL_BYTES)
      const buf = Buffer.alloc(size - from)
      const read = readSync(fd, buf, 0, buf.length, from)
      return latestContextPctFromJsonl(buf.subarray(0, read).toString('utf8'))
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Test hook: read a whole transcript file (no cursor) and report it. */
export function reportFromTranscriptFile(
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): UsageReport | null {
  try {
    return buildUsageReport(sumUsageFromJsonl(readFileSync(filePath, 'utf8')), env)
  } catch {
    return null
  }
}
