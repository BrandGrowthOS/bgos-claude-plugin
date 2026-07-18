// ── Compaction confirmation (pure transcript analysis) ───────────────────────
//
// After the daemon injects `/compact` into the CLI's tmux pane
// (lib/compact-inject.ts), it confirms the compaction actually happened by
// watching the session transcript. Ground truth (verified against real
// transcripts on this fleet): a host compaction appends
//
//   { "type": "system", "subtype": "compact_boundary",
//     "content": "Conversation compacted", "timestamp": "..." }
//
// to the SAME session .jsonl, followed by a `user` entry with
// isCompactSummary: true. The next assistant entry AFTER the boundary
// carries a materially smaller input (its usage block), which is the
// after-compaction context fill.
//
// This module is pure (string in, verdict out) so it is unit-testable with
// real transcript fixtures; the polling loop lives in server.ts.

import { contextPctOfAssistantEntry } from './usage-report.js'

export type CompactOutcome =
  | { state: 'pending' }
  | {
      state: 'compacted'
      /** Epoch ms of the compact_boundary entry. */
      boundaryMs: number
      /**
       * Context fill (0..100) of the first assistant usage entry AFTER the
       * boundary, or null when no post-boundary assistant turn exists yet
       * (an idle session compacts without producing a new turn).
       */
      afterPct: number | null
    }

/**
 * Scan a transcript JSONL chunk for a compact_boundary at or after
 * `sinceMs` (epoch ms). When found, also derive the after-compaction
 * context pct from the first assistant usage entry that follows it.
 * Malformed lines are skipped (normal at a live file's tail).
 */
export function evaluateCompactionOutcome(
  chunk: string,
  sinceMs: number,
): CompactOutcome {
  const lines = chunk.split('\n')
  let boundaryMs: number | null = null
  let boundaryIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (e.type !== 'system' || e.subtype !== 'compact_boundary') continue
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    if (!Number.isFinite(ts) || ts < sinceMs) continue
    boundaryMs = ts
    boundaryIdx = i
    break
  }
  if (boundaryMs === null) return { state: 'pending' }

  let afterPct: number | null = null
  for (let i = boundaryIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    const pct = contextPctOfAssistantEntry(entry)
    if (pct !== null) {
      afterPct = pct
      break
    }
  }
  return { state: 'compacted', boundaryMs, afterPct }
}
