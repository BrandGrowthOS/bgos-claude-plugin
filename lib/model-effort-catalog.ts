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

// ── The BGOS picker catalog (model_effort_picker, BGOS #3060) ────────────────
// BGOS main is authoritative: backend/src/integrations/model-effort-picker.model.ts
// at 1ec6bbf4. Its reader is vendored below, verbatim but for the house style,
// so the daemon never sends a catalog BGOS would refuse (the list answer is
// read back through it before it leaves) and test/model-effort-picker-contract
// pins it to BGOS's own spec cases.

/** The runtime name BGOS's own spec gives Claude Code (model-effort-picker.spec.ts:62). */
export const PICKER_RUNTIME = 'claude-code'

/** BGOS's selection session id pattern (dto/integrations/model-effort-picker.dto.ts ModelEffortApplyDto). */
export const PICKER_SESSION_ID_PATTERN = /^[\w.:-]{1,200}$/

export interface PickerEffortOption {
  id: string
  label: string
  enabled: boolean
  reason: string | null
}

export interface PickerModelOption {
  id: string
  label: string
  description: string
  enabled: boolean
  defaultEffort: string
  efforts: PickerEffortOption[]
  fastModeAvailable?: boolean
}

export interface PickerCatalog {
  runtime: string
  sessionId: string
  current: { model: string; effort: string | null } | null
  models: PickerModelOption[]
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const isText = (x: unknown, max: number): x is string =>
  typeof x === 'string' &&
  x.length > 0 &&
  x.length <= max &&
  !Array.from(x).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || /[‎‏‪-‮⁦-⁩]/.test(c))
const isId = (x: unknown): x is string => typeof x === 'string' && /^[\w./:-]{1,160}$/.test(x)
/** model-effort-picker.model.ts:43. */
export const MODEL_EFFORT_MODEL_PATTERN = /^[\w./:-]+(?:\[[a-zA-Z0-9_-]{1,20}\])?$/
const isModelId = (x: unknown): x is string => typeof x === 'string' && x.length <= 160 && MODEL_EFFORT_MODEL_PATTERN.test(x)

/** BGOS's readModelEffortCatalog (model-effort-picker.model.ts:46-120). */
export function readModelEffortCatalog(raw: unknown): PickerCatalog | null {
  if (!isRecord(raw) || !isText(raw.runtime, 40) || !isText(raw.sessionId, 200) || !Array.isArray(raw.models) || !raw.models.length || raw.models.length > 100) return null
  let current: PickerCatalog['current'] = null
  if (raw.current !== null) {
    if (!isRecord(raw.current) || !isModelId(raw.current.model) || !(raw.current.effort === null || isId(raw.current.effort))) return null
    current = { model: raw.current.model, effort: raw.current.effort }
  }
  const models: PickerModelOption[] = []
  for (const m of raw.models) {
    if (
      !isRecord(m) ||
      !isModelId(m.id) ||
      !isText(m.label, 100) ||
      typeof m.description !== 'string' ||
      (m.description !== '' && !isText(m.description, 500)) ||
      typeof m.enabled !== 'boolean' ||
      (m.fastModeAvailable !== undefined && typeof m.fastModeAvailable !== 'boolean') ||
      !isId(m.defaultEffort) ||
      !Array.isArray(m.efforts) ||
      !m.efforts.length ||
      m.efforts.length > 20
    ) return null
    const efforts: PickerEffortOption[] = []
    for (const e of m.efforts) {
      if (!isRecord(e) || !isId(e.id) || !isText(e.label, 80) || typeof e.enabled !== 'boolean' || !(e.reason === null || isText(e.reason, 200)) || (!e.enabled && !e.reason)) return null
      efforts.push({ id: e.id, label: e.label, enabled: e.enabled, reason: e.reason as string | null })
    }
    if (new Set(efforts.map((e) => e.id)).size !== efforts.length) return null
    models.push({
      id: m.id,
      label: m.label,
      description: m.description,
      enabled: m.enabled,
      defaultEffort: m.defaultEffort,
      efforts,
      ...(m.fastModeAvailable === undefined ? {} : { fastModeAvailable: m.fastModeAvailable as boolean }),
    })
  }
  if (new Set(models.map((m) => m.id)).size !== models.length) return null
  return { runtime: raw.runtime, sessionId: raw.sessionId, current, models }
}

/** The app's own effort words (ModelEffortPicker.tsx effortLabel). */
export function effortLabel(id: string): string {
  if (id === 'ultracode') return 'Ultra Code'
  if (id === 'xhigh') return 'Extra high'
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** A family's display word: `opus` is Opus. */
export function familyLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * The picker id of a running model: null when BGOS's pattern refuses the
 * session's own id (a report is never reinterpreted), else its table family
 * when it names exactly one, else that id.
 * A family is what the picker offers and what a switch types, so the row the
 * app highlights is the one that would be chosen again.
 */
export function pickerModelOf(modelId: string): string | null {
  if (!isModelId(modelId)) return null
  return modelFamilyOf(modelId) ?? modelId
}

/** Why the efforts of a model that reports none are offered disabled. */
export const NO_EFFORT_REASON = 'The model this agent runs reports no effort setting, so a change could not be confirmed.'

/**
 * The catalog the app's picker reads, from the installed CLI's own catalog
 * and the session's own report. Null when there is nothing honest to offer:
 * no proven session, a session id BGOS would refuse, no fresh report of that
 * session, or no model or effort at all.
 *
 * Every model offers the CLI's efforts, and Ultra Code disabled with the
 * host's reason. The RUNNING model is always listed (by its family, or by its
 * own id when the table has no literal for it, so the effort can still be
 * changed by naming it), and when it reports no effort its efforts are
 * disabled: a change to it could never be confirmed. The default effort is
 * the session's own, else high, else the first offered.
 */
export function buildPickerCatalog(input: {
  catalog: HostCatalog
  observation: ModelObservation | null
  sessionId: string | null
}): PickerCatalog | null {
  const { catalog, observation: o, sessionId } = input
  if (!sessionId || !PICKER_SESSION_ID_PATTERN.test(sessionId)) return null
  // No fresh report of THIS session: the current model and which efforts it
  // takes are unknown, so nothing is offered.
  if (!o || o.sessionId !== sessionId) return null
  const running = pickerModelOf(o.modelId)
  const runningEffort = o.effort !== null && isId(o.effort) ? o.effort : null
  const ids: string[] = [...catalog.models]
  if (running && !ids.includes(running)) ids.push(running)
  if (ids.length === 0 || catalog.efforts.length === 0) return null
  const defaultEffort = runningEffort && (catalog.efforts as string[]).includes(runningEffort)
    ? runningEffort
    : (catalog.efforts as string[]).includes('high') ? 'high' : catalog.efforts[0]!
  const runningLabel = isText(o.modelDisplayName, 100) ? o.modelDisplayName : running
  const models = ids.map((id): PickerModelOption => {
    const noEffort = id === running && o.effort === null
    return {
      id,
      label: isModelFamily(id) ? familyLabel(id) : (runningLabel ?? id),
      description: '',
      enabled: true,
      defaultEffort,
      efforts: [
        ...catalog.efforts.map((e) => ({
          id: e,
          label: effortLabel(e),
          enabled: !noEffort,
          reason: noEffort ? NO_EFFORT_REASON : null,
        })),
        { id: 'ultracode', label: effortLabel('ultracode'), enabled: false, reason: ULTRACODE_UNCONFIRMABLE },
      ],
    }
  })
  return {
    runtime: PICKER_RUNTIME,
    sessionId,
    current: running ? { model: running, effort: runningEffort } : null,
    models,
  }
}
