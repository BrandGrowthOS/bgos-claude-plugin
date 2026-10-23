/**
 * model-effort-catalog: what the owner's picker may offer for this agent, and
 * the report it fills itself from (owner model and effort control, Route A).
 *
 * NEVER A HARD CODED LIST. Both halves come from what the installed Claude
 * Code reports about itself:
 *
 *   efforts  the choices its own `claude --help` lists for `--effort`
 *            ("(low, medium, high, xhigh, max)" on 2.1.309);
 *   models   the aliases its own help names for `--model`
 *            ("'fable', 'opus', or 'sonnet'" on 2.1.309);
 *
 * and each is then kept only where lib/compact-inject.ts has a frozen literal
 * for it, because a value with no literal cannot be typed. So a family the CLI
 * stops naming leaves the picker on the next version, and one it starts naming
 * joins only after a deliberate change to the table. Ultra Code is never
 * offered: no session native report this daemon reads tells it apart.
 *
 * What runs NOW is the status line bridge's latest observation
 * (lib/model-control-store.mjs), the session's own words, never translated.
 * A model that reports no effort (effort is absent from its status line JSON)
 * offers no efforts, because a change to it could never be confirmed.
 */

import { isEffortLevel, isModelFamily, MODEL_LITERALS, type EffortLevel, type ModelFamily } from './compact-inject.ts'
import type { ModelObservation } from './model-control-store.mjs'

export interface HostCatalog {
  efforts: EffortLevel[]
  models: ModelFamily[]
}

/** The proposal's own sentence for the one setting this host cannot confirm. */
export const ULTRACODE_UNCONFIRMABLE = 'This host cannot confirm Ultra Code remotely.'

/** The text of one option's help, from its flag line to the next option. */
function optionBlock(help: string, flag: string): string | null {
  const lines = help.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s+(?:-\\w, )?${flag}(?:\\s|$)`).test(l))
  if (start < 0) return null
  const block = [lines[start]!]
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s+-/.test(lines[i]!) || /^\S/.test(lines[i]!)) break
    block.push(lines[i]!)
  }
  return block.join(' ').replace(/\s+/g, ' ')
}

/** Parse the installed CLI's help for its own efforts and model aliases. */
export function parseHelpCatalog(help: string | null | undefined): HostCatalog {
  if (typeof help !== 'string' || help === '') return { efforts: [], models: [] }
  const efforts: EffortLevel[] = []
  const effortBlock = optionBlock(help, '--effort')
  const choices = effortBlock ? /\(([a-z, ]+)\)/.exec(effortBlock) : null
  for (const word of choices ? choices[1]!.split(',').map((w) => w.trim()) : []) {
    if (isEffortLevel(word) && !efforts.includes(word)) efforts.push(word)
  }
  const models: ModelFamily[] = []
  const modelBlock = optionBlock(help, '--model')
  for (const m of modelBlock ? modelBlock.matchAll(/'([a-z0-9-]+)'/g) : []) {
    const alias = m[1]
    if (isModelFamily(alias) && !models.includes(alias)) models.push(alias)
  }
  return { efforts, models }
}

/** The one table family a resolved model id names, or null for none or two. */
export function modelFamilyOf(modelId: string): ModelFamily | null {
  const tokens = String(modelId ?? '').toLowerCase().split(/[^a-z0-9]+/)
  const found = (Object.keys(MODEL_LITERALS) as ModelFamily[]).filter((f) => tokens.includes(f))
  return found.length === 1 ? found[0]! : null
}

export type CanChange = { ok: true } | { ok: false; code: string; reason: string }

/** What the picker reads: the truth now, and what it may offer. */
export interface ModelEffortReport {
  /** The session's resolved model id, verbatim. */
  model: string
  modelFamily: ModelFamily | null
  modelDisplayName: string | null
  /** The live effort, or null when the model reports none. */
  effort: string | null
  runtimeVersion: string | null
  availableModels: ModelFamily[]
  availableEfforts: EffortLevel[]
  ultracode: { available: false; reason: string }
  /** Would a set_model or set_effort be attempted now (preflight, no pane read)? */
  canChange: boolean
  cannotChangeCode: string | null
  cannotChangeReason: string | null
  /** When the bridge observed it, ISO. */
  observedAt: string
}

export function buildModelEffortReport(input: {
  catalog: HostCatalog
  observation: ModelObservation | null
  canChange: CanChange
}): ModelEffortReport | null {
  const o = input.observation
  if (!o) return null
  return {
    model: o.modelId,
    modelFamily: modelFamilyOf(o.modelId),
    modelDisplayName: o.modelDisplayName,
    effort: o.effort,
    runtimeVersion: o.version,
    availableModels: [...input.catalog.models],
    availableEfforts: o.effort === null ? [] : [...input.catalog.efforts],
    ultracode: { available: false, reason: ULTRACODE_UNCONFIRMABLE },
    canChange: input.canChange.ok,
    cannotChangeCode: input.canChange.ok ? null : input.canChange.code,
    cannotChangeReason: input.canChange.ok ? null : input.canChange.reason,
    observedAt: new Date(o.observedAtMs).toISOString(),
  }
}
