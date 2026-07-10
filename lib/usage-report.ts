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
