/**
 * OpenClaw agent analyzer for optimizer milestone 3.
 *
 * This module is read-only by construction. Its filesystem dependency exposes
 * readFile and stat only. Its process dependency receives two fixed diagnostic
 * calls: a help gate followed by the daemon doctor when that flag is supported.
 * Findings contain serializable proposed changes and there is no apply path.
 */

import { execFile } from 'node:child_process'
import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { promisify } from 'node:util'

import type {
  BrokenMcpCategory,
  ClaudeMdRulesCategory,
  ContextRotCategory,
  FileBudget,
  Finding,
  FindingCategory,
  FindingClassification,
  FindingsReport,
  FindingSeverity,
  InstructionFileReport,
  ProposedChange,
  StartingContextCategory,
} from './types.js'

const COMMAND_TIMEOUT_MS = 15_000
const COMMAND_MAX_BYTES = 1024 * 1024
const DOCTOR_EXECUTABLE = 'bgos-openclaw-daemon'
const DEFAULT_HISTORY_LIMIT = 50
const RETAINED_HISTORY_ROW_CAP = 50
const DEFAULT_CONTEXT_WINDOW = 200_000
const MAX_CANON_BYTES = 256 * 1024
const HIGH_CONTEXT_PCT = 80
const CANON_GATE_MARKERS = ['BGOS Channel', 'Agent Capabilities'] as const
const FROZEN_PROTOCOL_MARKERS = [
  'ea:<decision>:<reqId>',
  '[[BGOS_TOOL_PROGRESS]]',
  '[[/BGOS_TOOL_PROGRESS]]',
] as const

const MODEL_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ['gpt-4.1', 1_000_000],
  ['gemini', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['deepseek', 128_000],
  ['llama', 128_000],
  ['mistral', 128_000],
  ['claude', 200_000],
]

export interface OpenClawAnalyzerReadOnlyFs {
  readFile(path: string): Promise<string>
  stat(path: string): Promise<{
    isFile(): boolean
    isDirectory(): boolean
    mode: number
  }>
}

export interface OpenClawCommandRequest {
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}

export interface OpenClawCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface OpenClawAnalyzerDependencies {
  fs?: OpenClawAnalyzerReadOnlyFs
  runCommand?: (
    request: OpenClawCommandRequest,
  ) => Promise<OpenClawCommandResult>
  /** Optional host-provided, read-only runtime observation. */
  inspectRuntime?: () => Promise<unknown>
  homeDir?: string
}

export interface OpenClawAnalyzerOptions {
  agentRoot: string
  openclawHome?: string
  configPath?: string
  updateStatePath?: string
  /** Alias accepted for callers that use the runtime name. */
  rollbackStatePath?: string
  cursorFilePath?: string
  /** Alias accepted for callers that use the daemon name. */
  cursorPath?: string
  peersTokenPath?: string
  daemonLogPath?: string
  env?: Record<string, string | undefined>
  nowMs?: number
}

interface TextRead {
  text: string | null
  error: 'missing' | 'unreadable' | null
}

interface PathInspection {
  status: 'present' | 'missing' | 'unreadable'
  mode: number | null
}

interface CommandCapture {
  stdout: string
  exitCode: number
  failedToStart: boolean
}

interface DoctorCapture extends CommandCapture {
  supported: boolean
}

interface DoctorCheck {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

interface ParsedDoctor {
  recognized: boolean
  checks: DoctorCheck[]
  structured: Record<string, unknown> | null
}

interface ParsedConfig {
  status: 'valid' | 'missing' | 'malformed'
  value: Record<string, unknown>
}

interface RuntimeObservation {
  contextPct: number | null
  promptTokens: number | null
  model: string | null
  contextWindowTokens: number | null
  durableGatewaySession: boolean | null
  dispatchPath: 'gateway' | 'cli' | 'none' | null
  hintChars: number | null
  hintBytes: number | null
  hintLines: number | null
  hostWiredHints: boolean | null
  canonSource: 'backend' | 'bundled' | 'unknown'
  servedCanonVersion: string | null
  bundledCanonVersion: string | null
  servedCanonChars: number | null
  canonMarkersValid: boolean | null
  peersTokenWired: boolean | null
  replayedHistoryTokens: number | null
}

interface UpdateStateInspection {
  status: 'readable' | 'missing' | 'unreadable' | 'corrupt'
  disabledAfterRollback: boolean | null
  earlyCrashCount: number | null
  pinnedVersion: string | null
}

interface OpenClawAnalysisInput {
  agentRoot: string
  openclawHome: string
  configPath: string
  updateStatePath: string
  cursorFilePath: string
  peersTokenPath: string
  daemonLogPath: string
  env: Record<string, string | undefined>
  configRead: TextRead
  config: ParsedConfig
  cursorRead: TextRead
  updateState: UpdateStateInspection
  peersToken: PathInspection
  doctorCapture: DoctorCapture
  doctor: ParsedDoctor
  runtime: RuntimeObservation
}

const defaultFs: OpenClawAnalyzerReadOnlyFs = {
  readFile: async (path) => nodeReadFile(path, 'utf8'),
  stat: async (path) => nodeStat(path),
}

const execFileAsync = promisify(execFile)

async function defaultRunCommand(
  request: OpenClawCommandRequest,
): Promise<OpenClawCommandResult> {
  try {
    const result = await execFileAsync(request.executable, [...request.args], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BYTES,
    })
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      exitCode: 0,
    }
  } catch (error) {
    const record = isRecord(error) ? error : {}
    return {
      stdout: typeof record.stdout === 'string' ? record.stdout : '',
      stderr: typeof record.stderr === 'string' ? record.stderr : '',
      exitCode:
        typeof record.code === 'number'
          ? record.code
          : record.code === 'ENOENT' || record.code === 'EACCES'
            ? 127
            : 1,
    }
  }
}

/** OpenClaw's coarse context gauge calculation. */
export function computeOpenClawContextPct(
  promptTokens: number,
  windowTokens: number,
): number | null {
  if (!Number.isFinite(promptTokens) || promptTokens < 0) return null
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return null
  return Math.max(
    0,
    Math.min(100, Math.round((100 * promptTokens) / windowTokens)),
  )
}

/** OpenClaw's shipped coarse model map plus its positive env override. */
export function openClawContextWindowForModel(
  model?: string | null,
  env: Record<string, string | undefined> = process.env,
): number {
  const rawOverride = env.OPENCLAW_CONTEXT_WINDOW
  if (rawOverride !== undefined && rawOverride.trim() !== '') {
    const override = Number(rawOverride)
    if (Number.isFinite(override) && override > 0) {
      return Math.floor(override)
    }
  }
  const normalized = (model ?? '').toLowerCase()
  for (const [pattern, tokens] of MODEL_WINDOWS) {
    if (normalized.includes(pattern)) return tokens
  }
  return DEFAULT_CONTEXT_WINDOW
}

export async function analyzeOpenClawAgent(
  options: OpenClawAnalyzerOptions,
  dependencies: OpenClawAnalyzerDependencies = {},
): Promise<FindingsReport> {
  const fs = dependencies.fs ?? defaultFs
  const runCommand = dependencies.runCommand ?? defaultRunCommand
  const homeDir = dependencies.homeDir ?? homedir()
  const nowMs = options.nowMs ?? Date.now()
  const agentRoot = normalize(resolve(options.agentRoot))
  const openclawHome = normalize(
    resolve(options.openclawHome ?? join(homeDir, '.openclaw')),
  )
  const configPath = normalize(
    resolve(options.configPath ?? join(openclawHome, 'secrets', 'bgos.json')),
  )
  const updateStatePath = normalize(
    resolve(
      options.updateStatePath ??
        options.rollbackStatePath ??
        join(openclawHome, 'state', 'bgos-auto-update.json'),
    ),
  )
  const cursorFilePath = normalize(
    resolve(
      options.cursorFilePath ??
        options.cursorPath ??
        join(openclawHome, 'state', 'bgos-cursor.json'),
    ),
  )
  const peersTokenPath = normalize(
    resolve(
      options.peersTokenPath ??
        join(openclawHome, 'secrets', 'bgos-peers-token'),
    ),
  )
  const daemonLogPath = normalize(
    resolve(
      options.daemonLogPath ??
        join(openclawHome, 'state', 'bgos-daemon.log'),
    ),
  )
  const env = options.env ?? process.env

  const [
    configRead,
    updateRead,
    cursorRead,
    logRead,
    peersToken,
    doctorCapture,
    runtimeValue,
  ] = await Promise.all([
    readText(fs, configPath),
    readText(fs, updateStatePath),
    readText(fs, cursorFilePath),
    readText(fs, daemonLogPath),
    inspectPath(fs, peersTokenPath),
    runDoctorReadOnly(runCommand, agentRoot),
    dependencies.inspectRuntime
      ? Promise.resolve()
          .then(() => dependencies.inspectRuntime!())
          .catch(() => null)
      : Promise.resolve(null),
  ])

  const config = parseConfig(configRead)
  const doctor = parseDoctor(doctorCapture.stdout)
  const runtime = parseRuntimeObservation(
    runtimeValue,
    doctor.structured,
    logRead.text,
  )
  const updateState = parseUpdateState(updateRead)

  const input: OpenClawAnalysisInput = {
    agentRoot,
    openclawHome,
    configPath,
    updateStatePath,
    cursorFilePath,
    peersTokenPath,
    daemonLogPath,
    env,
    configRead,
    config,
    cursorRead,
    updateState,
    peersToken,
    doctorCapture,
    doctor,
    runtime,
  }

  const contextRot = analyzeContextRot(input)
  const startingContext = analyzeStartingContext(input)
  const claudeMdRules = analyzeInstructionSurface(input)
  const brokenMcp = analyzeBrokenIntegration(input, contextRot.contextPct)
  const findings = [
    ...contextRot.findings,
    ...startingContext.findings,
    ...claudeMdRules.findings,
    ...brokenMcp.findings,
  ]
  makeFindingIdsUnique(findings)

  return {
    schemaVersion: 1,
    analyzedAt: new Date(nowMs).toISOString(),
    readOnly: true,
    agent: { kind: 'openclaw', root: agentRoot },
    categories: { contextRot, startingContext, claudeMdRules, brokenMcp },
    findings,
    summary: summarize(findings),
  }
}

function analyzeContextRot(input: OpenClawAnalysisInput): ContextRotCategory {
  const findings: Finding[] = []
  const history = parseHistoryLimit(input.env.OPENCLAW_HISTORY_LIMIT)
  const explicitWindow = parseContextWindowOverride(
    input.env.OPENCLAW_CONTEXT_WINDOW,
  )
  const hasContextEvidence =
    input.runtime.contextPct !== null ||
    input.runtime.promptTokens !== null ||
    input.runtime.model !== null ||
    explicitWindow.value !== null
  const nominalWindowTokens =
    positiveInteger(input.runtime.contextWindowTokens) ??
    (hasContextEvidence
      ? openClawContextWindowForModel(input.runtime.model, input.env)
      : null)
  const contextPct =
    boundedPercentage(input.runtime.contextPct) ??
    (input.runtime.promptTokens !== null && nominalWindowTokens !== null
      ? computeOpenClawContextPct(
          input.runtime.promptTokens,
          nominalWindowTokens,
        )
      : null)
  const effectiveHistoryRows =
    history.value === null
      ? null
      : history.value === 0
        ? RETAINED_HISTORY_ROW_CAP
        : Math.min(history.value, RETAINED_HISTORY_ROW_CAP)
  const gatewaySession = input.runtime.durableGatewaySession

  findings.push(
    makeFinding({
      id: 'openclaw-dual-context-store',
      category: 'context-rot',
      severity: gatewaySession === true ? 'warning' : 'info',
      explanation:
        gatewaySession === true
          ? 'OpenClaw replays daemon DB history while the gateway also has an opaque durable session for this route.'
          : 'OpenClaw replays daemon DB history and can also address an opaque gateway session, whose live contents were not observed.',
      file: input.daemonLogPath,
      line: 1,
      classification: 'analyze-only',
      proposedChange: {
        kind: 'observe-dual-context-stores',
        operation: 'none',
        description:
          'Keep daemon replay and gateway-session evidence separate in the report.',
        data: {
          daemonReplayRowCap: effectiveHistoryRows,
          retainedRowCap: RETAINED_HISTORY_ROW_CAP,
          durableGatewaySession: gatewaySession,
        },
      },
      whySafe:
        'The analyzer observes the replay budget and never reads, clears, or rewrites the opaque gateway session.',
    }),
  )

  if (gatewaySession === true) {
    findings.push(
      makeFinding({
        id: 'openclaw-new-half-reset',
        category: 'context-rot',
        severity: 'warning',
        explanation:
          'The bridge-local /new command resets daemon replay only and does not clear the opaque gateway session.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'preserve-owner-session-control',
          operation: 'none',
          description:
            'Tell the owner that /new is a partial reset before they choose any session action.',
          data: {
            resetsDaemonReplay: true,
            clearsGatewaySession: false,
          },
        },
        whySafe:
          'The analyzer never invokes /new and never clears the opaque gateway session.',
      }),
    )
  }

  if (contextPct !== null && contextPct >= HIGH_CONTEXT_PCT) {
    findings.push(
      makeFinding({
        id: 'openclaw-context-pressure',
        category: 'context-rot',
        severity: 'warning',
        explanation:
          'The coarse OpenClaw context gauge reports ' +
          Math.round(contextPct) +
          ' percent use.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'owner-controlled-context-review',
          operation: 'none',
          description:
            'Let the owner review the replay and opaque session before choosing /new.',
          data: { contextPct, coarse: true },
        },
        whySafe:
          'The gauge is reported as coarse. No live session command, reset, or history mutation is performed.',
      }),
    )
  } else if (contextPct === null) {
    findings.push(
      makeFinding({
        id: 'openclaw-context-unavailable',
        category: 'context-rot',
        severity: 'info',
        explanation:
          'No live contextPct or gateway prompt-token observation was available.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-context-telemetry',
          operation: 'none',
          description:
            'Supply the existing coarse gauge from the running host before judging pressure.',
          data: {},
        },
        whySafe:
          'Missing telemetry stays unknown instead of being estimated from unrelated config.',
      }),
    )
  }

  if (history.invalid) {
    findings.push(
      makeFinding({
        id: 'openclaw-history-limit-invalid',
        category: 'context-rot',
        severity: 'error',
        explanation:
          'OPENCLAW_HISTORY_LIMIT is not a nonnegative integer and can produce unreliable replay behavior.',
        file: input.configPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-history-limit',
          operation: 'manual-action',
          description:
            'Review a valid replay limit no greater than the retained 50-row store.',
          data: { retainedRowCap: RETAINED_HISTORY_ROW_CAP },
        },
        whySafe:
          'The analyzer does not change the env value and never raises OPENCLAW_HISTORY_LIMIT.',
      }),
    )
  }

  if (history.value === 0) {
    findings.push(
      makeFinding({
        id: 'openclaw-history-zero-replays-all',
        category: 'context-rot',
        severity: 'warning',
        explanation:
          'OPENCLAW_HISTORY_LIMIT=0 maps to slice(-0), so every retained history row is replayed instead of none.',
        file: input.configPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-zero-history-limit',
          operation: 'manual-action',
          description:
            'Choose an explicit positive replay count only after confirming owner intent.',
          data: {
            configuredHistoryLimit: 0,
            effectiveReplayRowCap: RETAINED_HISTORY_ROW_CAP,
          },
        },
        whySafe:
          'The analyzer preserves the env value and does not reset history or change the replay cap.',
      }),
    )
  }

  if (explicitWindow.invalid) {
    findings.push(
      makeFinding({
        id: 'openclaw-context-window-invalid',
        category: 'context-rot',
        severity: 'warning',
        explanation:
          'OPENCLAW_CONTEXT_WINDOW is not a positive finite token count, so the coarse model map applies instead.',
        file: input.configPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-context-window-override',
          operation: 'manual-action',
          description:
            'Confirm the real model window before setting an override.',
          data: { fallbackWindowTokens: DEFAULT_CONTEXT_WINDOW },
        },
        whySafe:
          'The analyzer leaves the override untouched and does not claim a model window it did not observe.',
      }),
    )
  }

  const measuredPromptPressure =
    nominalWindowTokens !== null &&
    input.runtime.replayedHistoryTokens !== null &&
    input.runtime.replayedHistoryTokens +
        estimateTokens(input.runtime.hintChars ?? 0) >=
      nominalWindowTokens * 0.8
  const coarseSmallWindowRisk =
    nominalWindowTokens !== null &&
    nominalWindowTokens <= 64_000 &&
    history.value !== null &&
    history.value >= RETAINED_HISTORY_ROW_CAP
  const ineffectiveRaisedLimit =
    history.value !== null && history.value > RETAINED_HISTORY_ROW_CAP
  if (
    !history.invalid &&
    (measuredPromptPressure || coarseSmallWindowRisk || ineffectiveRaisedLimit)
  ) {
    findings.push(
      makeFinding({
        id: 'openclaw-history-window-mismatch',
        category: 'context-rot',
        severity: 'warning',
        explanation: ineffectiveRaisedLimit
          ? 'OPENCLAW_HISTORY_LIMIT exceeds the daemon retained store, which is hard capped at 50 rows.'
          : 'The configured replay cap can consume a large share of the observed context window before the live turn.',
        file: input.configPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-history-window-budget',
          operation: 'manual-action',
          description:
            'Review a lower replay cap or correct a proven context-window override.',
          data: {
            historyLimit: history.value ?? DEFAULT_HISTORY_LIMIT,
            contextWindowTokens: nominalWindowTokens,
            retainedRowCap: RETAINED_HISTORY_ROW_CAP,
            measuredTokenPressure: measuredPromptPressure,
            coarse: !measuredPromptPressure,
          },
        },
        whySafe:
          'The analyzer records the mismatch only, never raises OPENCLAW_HISTORY_LIMIT, and never rewrites replay state.',
      }),
    )
  }

  return {
    contextPct,
    model: input.runtime.model,
    nominalWindowTokens,
    binding: null,
    tmuxCompaction: { available: false, source: null },
    resting: { state: 'not-detected', resetAt: null },
    findings,
  }
}

function analyzeStartingContext(
  input: OpenClawAnalysisInput,
): StartingContextCategory {
  const findings: Finding[] = []
  const claudeMd = budgetFor(join(input.agentRoot, 'CLAUDE.md'), null)
  const hintBudget = budgetFromObservation(
    input.daemonLogPath,
    input.runtime.hintChars,
    input.runtime.hintBytes,
    input.runtime.hintLines,
  )
  const opaqueGateway = budgetFor(
    join(input.openclawHome, 'opaque-gateway-session'),
    null,
  )
  const total = addBudgets(claudeMd, hintBudget, opaqueGateway)
  const cursorStore = inspectCursorStore(input.cursorFilePath, input.cursorRead)
  const hintsDisabled = input.env.BGOS_DISABLE_AUTO_HINTS === '1'
  const hostWired = input.runtime.hostWiredHints
  const doubleLoad = !hintsDisabled && hostWired === true

  if (hintBudget.exists) {
    findings.push(
      makeFinding({
        id: 'openclaw-hints-rebilled-per-turn',
        category: 'starting-context',
        severity: 'warning',
        explanation:
          'Stateless dispatch re-sends the measured BGOS capability block on every turn.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-per-turn-hint-overhead',
          operation: 'none',
          description:
            'Keep the complete per-turn capability overhead visible.',
          data: {
            hintChars: hintBudget.chars,
            hintBytes: hintBudget.utf8Bytes,
            hintLines: hintBudget.lines,
            statelessDispatch: true,
            everyTurn: true,
          },
        },
        whySafe:
          'The analyzer measures only and never strips hint sections or changes frozen wire formats.',
      }),
    )
  } else if (!hintBudget.exists) {
    findings.push(
      makeFinding({
        id: 'openclaw-hints-unmeasured',
        category: 'starting-context',
        severity: 'info',
        explanation:
          'The live injected hint size was unavailable, so no byte estimate was invented.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-hint-size',
          operation: 'none',
          description:
            'Supply a read-only host measurement before judging starting-context size.',
          data: {},
        },
        whySafe:
          'Unknown hint size remains zero in the measured lower bound and no capability text is changed.',
      }),
    )
  }

  if (doubleLoad) {
    findings.push(
      makeFinding({
        id: 'openclaw-host-wired-auto-hints',
        category: 'starting-context',
        severity: 'warning',
        explanation:
          'The host already wires BGOS hints while daemon auto-injection remains enabled.',
        file: input.configPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-disable-auto-hints',
          operation: 'manual-action',
          description:
            'Review BGOS_DISABLE_AUTO_HINTS=1 only for this proven host-wired setup.',
          data: {
            envKey: 'BGOS_DISABLE_AUTO_HINTS',
            proposedValue: '1',
            hostWired: true,
            preserveHostCapabilities: true,
          },
        },
        whySafe:
          'No env value is changed. Approval must confirm the host preserves every capability section and exact marker.',
      }),
    )
  }

  if (hintsDisabled && hostWired === false) {
    findings.push(
      makeFinding({
        id: 'openclaw-hints-disabled-without-host-wiring',
        category: 'starting-context',
        severity: 'error',
        explanation:
          'Daemon hint injection is disabled and the host explicitly reports no replacement wiring.',
        file: input.configPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'review-capability-loss',
          operation: 'none',
          description:
            'Confirm the intended capability source with the owner before any env change.',
          data: { autoHintsDisabled: true, hostWired: false },
        },
        whySafe:
          'Adding or removing capability guidance changes agent behavior, so the analyzer does not alter the setting.',
      }),
    )
  } else if (hintsDisabled && hostWired === null) {
    findings.push(
      makeFinding({
        id: 'openclaw-disabled-hints-wiring-unknown',
        category: 'starting-context',
        severity: 'info',
        explanation:
          'Daemon hints are disabled but host-side replacement wiring was not observable.',
        file: input.configPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-host-hint-wiring',
          operation: 'none',
          description:
            'Verify host-side capability coverage without changing either surface.',
          data: { autoHintsDisabled: true },
        },
        whySafe:
          'The analyzer preserves the current setting until capability coverage is proven.',
      }),
    )
  }

  if (input.runtime.canonSource === 'bundled') {
    findings.push(
      makeFinding({
        id: 'openclaw-canon-bundled-fallback',
        category: 'starting-context',
        severity: 'info',
        explanation:
          'The bundled frozen canon is active because served canon was unavailable or rejected.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-canon-fallback',
          operation: 'none',
          description:
            'Keep the graceful fallback visible without replacing its content.',
          data: { canonSource: 'bundled' },
        },
        whySafe:
          'The fallback remains intact and the analyzer does not weaken the served-canon acceptance gate.',
      }),
    )
  }

  if (cursorStore.status !== 'readable') {
    findings.push(
      makeFinding({
        id: 'openclaw-cursor-store-unavailable',
        category: 'starting-context',
        severity: cursorStore.status === 'corrupt' ? 'warning' : 'info',
        explanation:
          'The daemon cursor store is ' + cursorStore.status + '.',
        file: cursorStore.path,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-cursor-store',
          operation: 'none',
          description:
            'Inspect replay cursor availability without creating or repairing state.',
          data: { status: cursorStore.status },
        },
        whySafe:
          'The cursor is read only. It is never created, truncated, reset, or repaired.',
      }),
    )
  }

  return {
    budget: {
      claudeMd,
      mcpInstructions: hintBudget,
      memoryIndex: opaqueGateway,
      total,
    },
    mcpInstructionsSourceChars: hintBudget.chars,
    canonSource: input.runtime.canonSource,
    canonSummaryDoubleLoad: doubleLoad,
    cursorStore,
    findings,
  }
}

function analyzeInstructionSurface(
  input: OpenClawAnalysisInput,
): ClaudeMdRulesCategory {
  const findings: Finding[] = []
  const claudePath = join(input.agentRoot, 'CLAUDE.md')
  const files: InstructionFileReport[] = [
    {
      ...budgetFor(claudePath, null),
      kind: 'claude-md',
      frontmatter: 'not-applicable',
    },
  ]

  findings.push(
    makeFinding({
      id: 'openclaw-no-claude-md',
      category: 'claude-md-rules',
      severity: 'info',
      explanation:
        'CLAUDE.md is not an OpenClaw instruction surface and its absence is expected.',
      file: claudePath,
      line: 1,
      classification: 'analyze-only',
      proposedChange: {
        kind: 'preserve-openclaw-scope',
        operation: 'none',
        description:
          'Keep OpenClaw analysis scoped to canon, env knobs, doctor output, and reporting.',
        data: { claudeMdSupported: false },
      },
      whySafe:
        'The analyzer does not create a framework-irrelevant CLAUDE.md file.',
    }),
  )

  findings.push(
    makeFinding({
      id: 'openclaw-gateway-prompt-opaque',
      category: 'claude-md-rules',
      severity: 'warning',
      explanation:
        'The real agent system prompt lives on the external gateway, which this plugin cannot read or edit.',
      file: input.configPath,
      line: 1,
      classification: 'analyze-only',
      proposedChange: {
        kind: 'report-external-prompt-boundary',
        operation: 'none',
        description:
          'State that injected canon and env controls are the complete observable scope.',
        data: {
          externalGatewayPromptReadable: false,
          externalGatewayPromptEditable: false,
          observableScope: ['injected-canon', 'env', 'doctor', 'reporting'],
        },
      },
      whySafe:
        'The optimizer makes no complete instruction-surface claim and never sends prompt changes to the gateway.',
    }),
  )

  findings.push(
    makeFinding({
      id: 'openclaw-protocol-markers-frozen',
      category: 'claude-md-rules',
      severity: 'info',
      explanation:
        'OpenClaw capability and tool-progress markers are frozen wire contracts.',
      file: input.daemonLogPath,
      line: 1,
      classification: 'analyze-only',
      proposedChange: {
        kind: 'preserve-frozen-markers',
        operation: 'none',
        description:
          'Preserve exact marker literals and all capability sections.',
        data: {
          canonGateMarkers: [...CANON_GATE_MARKERS],
          protocolMarkers: [...FROZEN_PROTOCOL_MARKERS],
        },
      },
      whySafe:
        'No literal is normalized, rewritten, or removed, preventing silent capability loss.',
    }),
  )

  const servedVersion = input.runtime.servedCanonVersion
  const bundledVersion = input.runtime.bundledCanonVersion
  if (
    servedVersion !== null &&
    bundledVersion !== null &&
    servedVersion !== bundledVersion
  ) {
    findings.push(
      makeFinding({
        id: 'openclaw-canon-drift',
        category: 'claude-md-rules',
        severity: 'warning',
        explanation:
          'The observed served and bundled canon versions differ.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-served-bundled-canon-drift',
          operation: 'manual-action',
          description:
            'Review the served-first source while preserving the offline fallback.',
          data: {
            servedVersion,
            bundledVersion,
            maxCanonBytes: MAX_CANON_BYTES,
            requiredMarkers: [...CANON_GATE_MARKERS],
          },
        },
        whySafe:
          'No canon is replaced. Any later review must retain the 256 KB gate, exact markers, and offline fallback.',
      }),
    )
  }

  const servedCanonOverLimit =
    input.runtime.servedCanonChars !== null &&
    input.runtime.servedCanonChars > MAX_CANON_BYTES
  if (input.runtime.canonMarkersValid === false || servedCanonOverLimit) {
    findings.push(
      makeFinding({
        id: 'openclaw-canon-marker-gate',
        category: 'claude-md-rules',
        severity: 'warning',
        explanation: servedCanonOverLimit
          ? 'Observed served canon exceeds the 256 KB acceptance gate and must remain rejected.'
          : 'Observed served canon failed the required marker gate and must remain rejected.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'preserve-canon-rejection',
          operation: 'none',
          description:
            'Keep the bundled fallback active until a valid served canon is available.',
          data: {
            maxCanonBytes: MAX_CANON_BYTES,
            requiredMarkers: [...CANON_GATE_MARKERS],
            observedServedCanonChars: input.runtime.servedCanonChars,
            overLimit: servedCanonOverLimit,
          },
        },
        whySafe:
          'The frozen marker gate is not weakened and rejected text is never injected or rewritten.',
      }),
    )
  }

  return { files, deadReferences: [], ruleBlocks: [], findings }
}

function analyzeBrokenIntegration(
  input: OpenClawAnalysisInput,
  contextPct: number | null,
): BrokenMcpCategory {
  const findings: Finding[] = []
  const doctorReady =
    input.doctorCapture.supported && input.doctor.recognized
  const doctorHasFail = input.doctor.checks.some(
    (check) => check.status === 'fail',
  )

  if (!doctorReady) {
    findings.push(
      makeFinding({
        id: 'openclaw-doctor-unavailable',
        category: 'broken-mcp',
        severity: 'warning',
        explanation:
          'The BGOS OpenClaw daemon did not expose recognizable read-only doctor checks.',
        file: input.configPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-doctor-availability',
          operation: 'none',
          description:
            'Use a daemon version whose help explicitly lists the read-only doctor flag.',
          data: {
            executable: DOCTOR_EXECUTABLE,
            exitCode: input.doctorCapture.exitCode,
            doctorFlagSupported: input.doctorCapture.supported,
          },
        },
        whySafe:
          'The analyzer never tries an unsupported doctor flag and never substitutes a repair command.',
      }),
    )
  } else {
    for (const check of input.doctor.checks) {
      if (check.status === 'pass') continue
      findings.push(doctorFinding(input, check))
    }
  }

  findings.push(
    makeFinding({
      id: 'openclaw-no-mcp',
      category: 'broken-mcp',
      severity: 'info',
      explanation:
        'OpenClaw does not use MCP servers; its tool surface belongs to the gateway and localhost peers server.',
      file: input.configPath,
      line: 1,
      classification: 'analyze-only',
      proposedChange: {
        kind: 'report-no-mcp-by-design',
        operation: 'none',
        description:
          'Do not treat the absence of MCP configuration as a defect.',
        data: { mcpSupported: false, peersPortDefault: 31_848 },
      },
      whySafe:
        'No new server or capability is inferred, added, connected, or removed.',
    }),
  )

  const dispatchPath = input.runtime.dispatchPath
  if (dispatchPath === 'none') {
    findings.push(
      makeFinding({
        id: 'openclaw-dispatch-none',
        category: 'broken-mcp',
        severity: 'error',
        explanation:
          'dispatchPath is none, so neither the gateway nor CLI can carry text turns.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-dispatch-path',
          operation: 'manual-action',
          description:
            'Investigate gateway health and the trusted OpenClaw CLI installation.',
          data: { dispatchPath: 'none' },
        },
        whySafe:
          'The analyzer reports the derived runtime result without starting, restarting, or signaling either process.',
      }),
    )
  } else if (dispatchPath === 'gateway' || dispatchPath === 'cli') {
    findings.push(
      makeFinding({
        id: 'openclaw-dispatch-path',
        category: 'broken-mcp',
        severity: 'info',
        explanation:
          'The observed OpenClaw dispatch path is ' + dispatchPath + '.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-dispatch-path',
          operation: 'none',
          description:
            'Keep the derived dispatch path visible without probing a live turn.',
          data: {
            dispatchPath,
            usageTelemetryAvailable: dispatchPath === 'gateway',
          },
        },
        whySafe:
          'The analyzer consumes existing evidence and does not send a gateway request or CLI turn.',
      }),
    )
  } else {
    findings.push(
      makeFinding({
        id: 'openclaw-dispatch-unavailable',
        category: 'broken-mcp',
        severity: 'info',
        explanation:
          'dispatchPath was not present in runtime or daemon-log evidence.',
        file: input.daemonLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-dispatch-capabilities',
          operation: 'none',
          description:
            'Supply detectCapabilities output without inferring it from a gateway URL.',
          data: {},
        },
        whySafe:
          'Unknown runtime health remains unknown and no synthetic connectivity result is produced.',
      }),
    )
  }

  const peers = resolvePeersWiring(input)
  if (peers.authRequired && peers.wired === false) {
    const runtimeReportsBroken = peers.runtimeWired === false
    findings.push(
      makeFinding({
        id: 'openclaw-peers-token-missing',
        category: 'broken-mcp',
        severity: 'error',
        explanation:
          runtimeReportsBroken
            ? 'Peers runtime reports that bearer-token wiring is broken, so calls can return 401.'
            : 'Peers auth is required but no shared token source is present, so calls can return 401.',
        file: input.peersTokenPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-peers-token-wiring',
          operation: 'manual-action',
          description:
            'Confirm one shared token source for the daemon and gateway agent processes.',
          data: {
            authRequired: true,
            pinnedEnvPresent: peers.pinnedEnvPresent,
            tokenFilePresent: peers.tokenFilePresent,
            runtimeWired: peers.runtimeWired,
          },
        },
        whySafe:
          'The analyzer checks presence metadata only and does not read or print either token value.',
      }),
    )
  } else if (peers.authRequired && peers.wired === null) {
    findings.push(
      makeFinding({
        id: 'openclaw-peers-token-unknown',
        category: 'broken-mcp',
        severity: 'info',
        explanation:
          'Peers token wiring could not be confirmed from safe presence metadata.',
        file: input.peersTokenPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-peers-token-wiring',
          operation: 'none',
          description:
            'Inspect shared token visibility without opening or printing the secret.',
          data: {
            authRequired: true,
            pinnedEnvPresent: peers.pinnedEnvPresent,
            tokenFilePresent: peers.tokenFilePresent,
            runtimeWired: peers.runtimeWired,
          },
        },
        whySafe:
          'No secret content is read and no auth policy is changed.',
      }),
    )
  } else if (!peers.authRequired) {
    findings.push(
      makeFinding({
        id: 'openclaw-peers-auth-disabled',
        category: 'broken-mcp',
        severity: 'warning',
        explanation:
          'BGOS_PEERS_REQUIRE_AUTH=0 disables the localhost peers bearer gate.',
        file: input.configPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-peers-auth-policy',
          operation: 'manual-action',
          description:
            'Confirm that the explicit auth opt-out matches the owner topology.',
          data: { authRequired: false },
        },
        whySafe:
          'The analyzer does not enable auth, generate a token, or restart the daemon.',
      }),
    )
  }

  if (input.updateState.status === 'corrupt' || input.updateState.status === 'unreadable') {
    findings.push(
      makeFinding({
        id: 'openclaw-update-state-corrupt',
        category: 'broken-mcp',
        severity: 'warning',
        explanation:
          'The auto-update state is ' + input.updateState.status + ', so latch state is unknown and the daemon can fail closed.',
        file: input.updateStatePath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-update-state',
          operation: 'none',
          description:
            'Diagnose state provenance without rewriting or deleting it.',
          data: { status: input.updateState.status },
        },
        whySafe:
          'The state file is never repaired, cleared, renamed, or replaced.',
      }),
    )
  }

  if (input.updateState.disabledAfterRollback === true) {
    findings.push(
      makeFinding({
        id: 'openclaw-rollback-latch-set',
        category: 'broken-mcp',
        severity: 'error',
        explanation:
          'Automatic updates are disabled by validated rollback safety state.',
        file: input.updateStatePath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'diagnose-rollback-latch',
          operation: 'none',
          description:
            'Diagnose the failed release before the owner follows the documented reset sequence.',
          data: {
            disabledAfterRollback: true,
            earlyCrashCount: input.updateState.earlyCrashCount,
            pinnedVersion: input.updateState.pinnedVersion,
          },
        },
        whySafe:
          'The analyzer never clears the latch, which could re-arm the crashing release.',
      }),
    )
  }

  findings.push(
    makeFinding({
      id: 'openclaw-tool-progress-gap',
      category: 'broken-mcp',
      severity: 'info',
      explanation:
        'The v1/chat/completions bridge cannot observe tool lifecycle, so tool cards depend on agent self-report.',
      file: input.daemonLogPath,
      line: 1,
      classification: 'analyze-only',
      proposedChange: {
        kind: 'report-tool-progress-protocol-limit',
        operation: 'none',
        description:
          'Surface the protocol limit and preserve the exact self-report marker.',
        data: {
          marker: '[[BGOS_TOOL_PROGRESS]]',
          protocolLimit: true,
          surfaceOnly: true,
        },
      },
      whySafe:
        'The analyzer does not invent gateway tool events or rewrite the frozen marker protocol.',
    }),
  )

  if (input.config.status === 'malformed') {
    const unreadable = input.configRead.error === 'unreadable'
    findings.push(
      makeFinding({
        id: unreadable
          ? 'openclaw-config-unreadable'
          : 'openclaw-config-malformed',
        category: 'broken-mcp',
        severity: 'error',
        explanation: unreadable
          ? 'The OpenClaw BGOS config could not be read, so its contents remain unknown.'
          : 'The OpenClaw BGOS config is not a JSON object.',
        file: input.configPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: unreadable
            ? 'review-openclaw-config-access'
            : 'review-openclaw-config-parse',
          operation: 'manual-action',
          description:
            'Review the original bytes and owner intent before any repair.',
          data: {},
        },
        whySafe:
          'The analyzer does not rewrite malformed config or infer credential values.',
      }),
    )
  } else if (input.config.status === 'missing') {
    findings.push(
      makeFinding({
        id: 'openclaw-config-missing',
        category: 'broken-mcp',
        severity: 'info',
        explanation:
          'The default BGOS token config is absent; env configuration may still be in use.',
        file: input.configPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-effective-openclaw-config',
          operation: 'none',
          description:
            'Confirm effective env configuration without creating a token file.',
          data: {},
        },
        whySafe:
          'No config or pairing token is created, copied, or inferred.',
      }),
    )
  }

  const pairingConfigured =
    configuredSecret(input.env.BGOS_PAIRING_TOKEN) ||
    configuredSecret(valueString(input.config.value.pairingToken) ?? undefined)
  const backendConfigured =
    validHttpUrl(input.env.BGOS_BASE_URL) ||
    validHttpUrl(valueString(input.config.value.baseUrl))
  const diagnosticExecutableFound = !input.doctorCapture.failedToStart
  const dispatchWorking = dispatchPath === 'gateway' || dispatchPath === 'cli'
  const hasUnhealthyState =
    doctorHasFail ||
    dispatchPath === 'none' ||
    (peers.authRequired && peers.wired === false) ||
    input.config.status === 'malformed'
  const hasUnavailableState =
    !doctorReady ||
    dispatchPath === null ||
    (peers.authRequired && peers.wired === null)
  const healthStatus: BrokenMcpCategory['health']['status'] = hasUnhealthyState
    ? 'unhealthy'
    : hasUnavailableState
      ? 'unreachable'
      : 'healthy'

  return {
    configPath: input.configPath,
    configStatus: input.config.status,
    serverName: null,
    bun: {
      found: diagnosticExecutableFound,
      path: diagnosticExecutableFound ? DOCTOR_EXECUTABLE : null,
    },
    serverEntry: {
      path: input.configPath,
      exists: input.config.status !== 'missing',
    },
    requiredEnv: {
      BGOS_BACKEND_URL: backendConfigured,
      BGOS_API_KEY: pairingConfigured,
      BGOS_USER_ID: !peers.authRequired || peers.wired === true,
      BGOS_ASSISTANT_ID: dispatchWorking,
    },
    health: {
      status: healthStatus,
      httpStatus: null,
      service: dispatchPath,
      database: null,
    },
    canonSource: input.runtime.canonSource,
    authMode: pairingConfigured ? 'pairing' : 'missing',
    versionHeartbeat: 'unavailable',
    statusPatchActivity:
      contextPct !== null
        ? 'observed'
        : dispatchPath === 'cli'
          ? 'not-observed'
          : 'unknown',
    findings,
  }
}

function doctorFinding(
  input: OpenClawAnalysisInput,
  check: DoctorCheck,
): Finding {
  const name = check.name.toLowerCase()
  const severity = severityForDoctor(check.status)
  if (name === 'token-file perms') {
    return makeFinding({
      id: 'openclaw-token-permissions',
      category: 'broken-mcp',
      severity,
      explanation:
        'The daemon doctor reports unsafe or unavailable pairing-token file permissions.',
      file: input.configPath,
      line: 1,
      classification: 'needs-approval',
      proposedChange: {
        kind: 'review-token-file-permissions',
        operation: 'manual-action',
        description:
          'Let the owner inspect the token file mode and daemon pairing flow.',
        data: {
          status: check.status,
          observedMode: firstMode(check.detail),
          requiredMode: '0600',
        },
      },
      whySafe:
        'The analyzer never changes mode on a live token and never reads or prints its contents.',
    })
  }
  if (name === 'secrets-dir perms') {
    return makeFinding({
      id: 'openclaw-secrets-permissions',
      category: 'broken-mcp',
      severity,
      explanation:
        'The daemon doctor reports unsafe or unavailable secrets-directory permissions.',
      file: join(input.openclawHome, 'secrets'),
      line: 1,
      classification: 'needs-approval',
      proposedChange: {
        kind: 'review-secrets-directory-permissions',
        operation: 'manual-action',
        description:
          'Let the owner inspect the secrets directory and installation ownership.',
        data: {
          status: check.status,
          observedMode: firstMode(check.detail),
          requiredMode: '0700',
        },
      },
      whySafe:
        'The analyzer never changes directory mode, ownership, or secret files.',
    })
  }
  if (name === 'keepalive (restart survival)') {
    return makeFinding({
      id: 'openclaw-keepalive-not-loaded',
      category: 'broken-mcp',
      severity,
      explanation:
        'The daemon doctor reports that BGOS keepalive is not loaded.',
      file: input.configPath,
      line: 1,
      classification: 'needs-approval',
      proposedChange: {
        kind: 'review-keepalive-installation',
        operation: 'manual-action',
        description:
          'Review the daemon-provided keepalive recipe with the owner.',
        data: { status: check.status },
      },
      whySafe:
        'The analyzer never runs the installation recipe, reloads services, or restarts the daemon.',
    })
  }
  return makeFinding({
    id: 'openclaw-doctor-check:' + slug(check.name),
    category: 'broken-mcp',
    severity,
    explanation:
      'The daemon doctor reports ' +
      check.status.toUpperCase() +
      ': ' +
      redactDiagnosticText(check.detail),
    file: input.configPath,
    line: 1,
    classification: 'needs-approval',
    proposedChange: {
      kind: 'review-doctor-check',
      operation: 'manual-action',
      description: 'Review this daemon diagnostic with the owner.',
      data: {
        check: redactDiagnosticText(check.name),
        status: check.status,
      },
    },
    whySafe:
      'Diagnostic text is redacted and no suggested command is executed.',
  })
}

async function runDoctorReadOnly(
  runCommand: (
    request: OpenClawCommandRequest,
  ) => Promise<OpenClawCommandResult>,
  agentRoot: string,
): Promise<DoctorCapture> {
  const help = await captureCommand(runCommand, {
    executable: DOCTOR_EXECUTABLE,
    args: ['--help'],
    cwd: agentRoot,
    env: {},
  })
  const supported =
    !help.failedToStart && /^\s*--doctor(?:\s|$)/m.test(help.stdout)
  if (!supported) {
    return { ...help, stdout: '', supported: false }
  }
  const doctor = await captureCommand(runCommand, {
    executable: DOCTOR_EXECUTABLE,
    args: ['--doctor'],
    cwd: agentRoot,
    env: {},
  })
  return { ...doctor, supported: true }
}

async function captureCommand(
  runCommand: (
    request: OpenClawCommandRequest,
  ) => Promise<OpenClawCommandResult>,
  request: OpenClawCommandRequest,
): Promise<CommandCapture> {
  try {
    const result = await runCommand(request)
    const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      exitCode,
      failedToStart: exitCode === 126 || exitCode === 127,
    }
  } catch {
    return { stdout: '', exitCode: 127, failedToStart: true }
  }
}

function parseDoctor(text: string): ParsedDoctor {
  const parsed = parseJsonValue(text)
  const candidate = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? parsed.checks ?? parsed.results
      : null
  if (Array.isArray(candidate)) {
    const checks = candidate
      .map(parseStructuredDoctorCheck)
      .filter((check): check is DoctorCheck => check !== null)
    return {
      recognized: checks.length > 0,
      checks,
      structured: isRecord(parsed) ? parsed : null,
    }
  }

  const checks: DoctorCheck[] = []
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const match = /^\s*\[(PASS|WARN|FAIL)\]\s+(.+?):\s*(.*)$/i.exec(line)
    if (!match) continue
    checks.push({
      name: redactDiagnosticText(match[2] ?? 'diagnostic'),
      status: normalizeDoctorStatus(match[1]) ?? 'warn',
      detail: redactDiagnosticText(match[3] ?? ''),
    })
  }
  return {
    recognized: checks.length > 0,
    checks,
    structured: isRecord(parsed) ? parsed : null,
  }
}

function parseStructuredDoctorCheck(value: unknown): DoctorCheck | null {
  if (!isRecord(value)) return null
  const status = normalizeDoctorStatus(value.status ?? value.state ?? value.level)
  if (!status) return null
  const name = firstString([
    valueString(value.name),
    valueString(value.id),
    valueString(value.check),
  ])
  if (!name) return null
  const detail = firstString([
    valueString(value.detail),
    valueString(value.message),
    valueString(value.description),
  ]) ?? name
  return {
    name: redactDiagnosticText(name),
    status,
    detail: redactDiagnosticText(detail),
  }
}

function normalizeDoctorStatus(value: unknown): DoctorCheck['status'] | null {
  if (typeof value !== 'string') return null
  const status = value.trim().toLowerCase()
  if (['pass', 'passed', 'ok', 'healthy', 'success'].includes(status)) {
    return 'pass'
  }
  if (['warn', 'warning', 'degraded', 'advisory'].includes(status)) {
    return 'warn'
  }
  if (['fail', 'failed', 'error', 'unhealthy'].includes(status)) {
    return 'fail'
  }
  return null
}

function parseRuntimeObservation(
  runtimeValue: unknown,
  doctorValue: Record<string, unknown> | null,
  logText: string | null,
): RuntimeObservation {
  const sources = [runtimeValue, doctorValue].filter(
    (value): value is Record<string, unknown> => isRecord(value),
  )
  const log = parseLogObservation(logText)
  const contextPct = findDeepNumber(sources, [
    'contextPct',
    'context_pct',
    'context_percent',
  ])
  const promptTokens = findDeepNumber(sources, [
    'promptTokens',
    'prompt_tokens',
    'inputTokens',
    'input_tokens',
  ])
  const model = findDeepString(sources, ['model', 'modelId', 'model_id'])
  const contextWindowTokens = findDeepNumber(sources, [
    'contextWindowTokens',
    'context_window_tokens',
    'windowTokens',
    'window_tokens',
  ])
  const durableGatewaySession = findDeepBoolean(sources, [
    'durableGatewaySession',
    'gatewaySessionDurable',
    'durable_gateway_session',
  ])
  const dispatchPath = dispatchPathValue(
    findDeepValueFromSources(sources, ['dispatchPath', 'dispatch_path']),
  ) ?? log.dispatchPath
  const hintChars = nonNegativeNumber(
    findDeepNumber(sources, [
      'hintChars',
      'hintsChars',
      'canonChars',
      'capabilityChars',
    ]),
  ) ?? log.hintChars
  const hintBytes = nonNegativeNumber(
    findDeepNumber(sources, [
      'hintBytes',
      'hintsBytes',
      'canonBytes',
      'capabilityBytes',
    ]),
  )
  const hintLines = nonNegativeNumber(
    findDeepNumber(sources, ['hintLines', 'hintsLines', 'canonLines']),
  )
  const hostWiredHints = findDeepBoolean(sources, [
    'hostWiredHints',
    'host_wired_hints',
  ])
  const explicitCanonSource = canonSourceValue(
    findDeepValueFromSources(sources, ['canonSource', 'canon_source']),
  )
  const servedCanonVersion = versionString(
    findDeepValueFromSources(sources, [
      'servedCanonVersion',
      'served_canon_version',
    ]),
  ) ?? log.servedCanonVersion
  const bundledCanonVersion = versionString(
    findDeepValueFromSources(sources, [
      'bundledCanonVersion',
      'bundled_canon_version',
    ]),
  )
  const canonMarkersValid = findDeepBoolean(sources, [
    'canonMarkersValid',
    'canon_markers_valid',
  ])
  const servedCanonChars = nonNegativeNumber(
    findDeepNumber(sources, [
      'servedCanonChars',
      'served_canon_chars',
      'servedCapabilityChars',
    ]),
  )
  const peersTokenWired = findDeepBoolean(sources, [
    'peersTokenWired',
    'peers_token_wired',
  ])
  const replayedHistoryTokens = nonNegativeNumber(
    findDeepNumber(sources, [
      'replayedHistoryTokens',
      'replayed_history_tokens',
      'historyTokens',
    ]),
  )

  return {
    contextPct: boundedPercentage(contextPct),
    promptTokens: nonNegativeNumber(promptTokens),
    model,
    contextWindowTokens: positiveInteger(contextWindowTokens),
    durableGatewaySession,
    dispatchPath,
    hintChars,
    hintBytes,
    hintLines,
    hostWiredHints,
    canonSource: explicitCanonSource ?? log.canonSource,
    servedCanonVersion,
    bundledCanonVersion,
    servedCanonChars,
    canonMarkersValid,
    peersTokenWired,
    replayedHistoryTokens,
  }
}

function parseLogObservation(text: string | null): {
  dispatchPath: RuntimeObservation['dispatchPath']
  canonSource: RuntimeObservation['canonSource']
  servedCanonVersion: string | null
  hintChars: number | null
} {
  if (!text) {
    return {
      dispatchPath: null,
      canonSource: 'unknown',
      servedCanonVersion: null,
      hintChars: null,
    }
  }
  let dispatchPath: RuntimeObservation['dispatchPath'] = null
  const dispatchPattern =
    /(?:"dispatchPath"\s*:\s*"|\bdispatchPath\s*=\s*)(gateway|cli|none)"?/gi
  for (const match of text.matchAll(dispatchPattern)) {
    dispatchPath = dispatchPathValue(match[1])
  }

  let canonSource: RuntimeObservation['canonSource'] = 'unknown'
  let latestCanonIndex = -1
  const backendIndex = text.lastIndexOf('fetched served capability canon')
  if (backendIndex >= 0) {
    canonSource = 'backend'
    latestCanonIndex = backendIndex
  }
  for (const phrase of [
    'using bundled fallback',
    'bundled canon fallback',
    'source=bundled',
  ]) {
    const index = text.lastIndexOf(phrase)
    if (index > latestCanonIndex) {
      canonSource = 'bundled'
      latestCanonIndex = index
    }
  }
  const servedLine = backendIndex >= 0
    ? text.slice(backendIndex, text.indexOf('\n', backendIndex) < 0
        ? text.length
        : text.indexOf('\n', backendIndex))
    : ''
  const versionMatch = /"version"\s*:\s*"?([^",}\s]+)"?/.exec(servedLine)
  const charsMatch = /"chars"\s*:\s*(\d+)/.exec(servedLine)
  return {
    dispatchPath,
    canonSource,
    servedCanonVersion: versionMatch?.[1] ?? null,
    hintChars: charsMatch ? Number(charsMatch[1]) : null,
  }
}

function parseConfig(read: TextRead): ParsedConfig {
  if (read.text === null) {
    return {
      status: read.error === 'missing' ? 'missing' : 'malformed',
      value: {},
    }
  }
  try {
    const parsed: unknown = JSON.parse(read.text)
    return isRecord(parsed)
      ? { status: 'valid', value: parsed }
      : { status: 'malformed', value: {} }
  } catch {
    return { status: 'malformed', value: {} }
  }
}

function parseUpdateState(read: TextRead): UpdateStateInspection {
  if (read.text === null) {
    return {
      status: read.error === 'missing' ? 'missing' : 'unreadable',
      disabledAfterRollback: read.error === 'missing' ? false : null,
      earlyCrashCount: read.error === 'missing' ? 0 : null,
      pinnedVersion: null,
    }
  }
  try {
    const parsed: unknown = JSON.parse(read.text)
    if (!isRecord(parsed)) throw new Error('not an object')
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.disabledAfterRollback !== 'boolean' ||
      typeof parsed.resetObserved !== 'boolean' ||
      !Number.isInteger(parsed.earlyCrashCount) ||
      Number(parsed.earlyCrashCount) < 0 ||
      !isValidUpdateStateTransition(parsed)
    ) {
      throw new Error('invalid state')
    }
    return {
      status: 'readable',
      disabledAfterRollback: parsed.disabledAfterRollback,
      earlyCrashCount: Number(parsed.earlyCrashCount),
      pinnedVersion: strictVersion(parsed.pinnedVersion),
    }
  } catch {
    return {
      status: 'corrupt',
      disabledAfterRollback: null,
      earlyCrashCount: null,
      pinnedVersion: null,
    }
  }
}

function inspectCursorStore(
  path: string,
  read: TextRead,
): StartingContextCategory['cursorStore'] {
  if (read.text === null) {
    return {
      path,
      status: read.error === 'missing' ? 'missing' : 'unreadable',
      entries: 0,
    }
  }
  try {
    const parsed: unknown = JSON.parse(read.text)
    if (!isRecord(parsed)) throw new Error('not an object')
    const rawEntries = isRecord(parsed.lastContextMessageIds)
      ? parsed.lastContextMessageIds
      : isRecord(parsed.contextMessageIds)
        ? parsed.contextMessageIds
        : {}
    return { path, status: 'readable', entries: Object.keys(rawEntries).length }
  } catch {
    return { path, status: 'corrupt', entries: 0 }
  }
}

function resolvePeersWiring(input: OpenClawAnalysisInput): {
  authRequired: boolean
  wired: boolean | null
  pinnedEnvPresent: boolean
  tokenFilePresent: boolean | null
  runtimeWired: boolean | null
} {
  const authRequired = input.env.BGOS_PEERS_REQUIRE_AUTH !== '0'
  const pinnedEnvPresent = configuredSecret(input.env.BGOS_PEERS_AUTH_TOKEN)
  const tokenFilePresent = input.peersToken.status === 'present'
    ? true
    : input.peersToken.status === 'missing'
      ? false
      : null
  const runtimeWired = input.runtime.peersTokenWired
  if (!authRequired) {
    return {
      authRequired,
      wired: true,
      pinnedEnvPresent,
      tokenFilePresent,
      runtimeWired,
    }
  }
  if (input.runtime.peersTokenWired !== null) {
    return {
      authRequired,
      wired: input.runtime.peersTokenWired,
      pinnedEnvPresent,
      tokenFilePresent,
      runtimeWired,
    }
  }
  if (input.peersToken.status === 'present') {
    return {
      authRequired,
      wired: true,
      pinnedEnvPresent,
      tokenFilePresent,
      runtimeWired,
    }
  }
  if (input.peersToken.status === 'missing' && !pinnedEnvPresent) {
    return {
      authRequired,
      wired: false,
      pinnedEnvPresent,
      tokenFilePresent,
      runtimeWired,
    }
  }
  return {
    authRequired,
    wired: null,
    pinnedEnvPresent,
    tokenFilePresent,
    runtimeWired,
  }
}

async function readText(
  fs: OpenClawAnalyzerReadOnlyFs,
  path: string,
): Promise<TextRead> {
  try {
    return { text: await fs.readFile(path), error: null }
  } catch (error) {
    return {
      text: null,
      error: errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable',
    }
  }
}

async function inspectPath(
  fs: OpenClawAnalyzerReadOnlyFs,
  path: string,
): Promise<PathInspection> {
  try {
    const stats = await fs.stat(path)
    return {
      status: stats.isFile() ? 'present' : 'unreadable',
      mode: stats.mode & 0o777,
    }
  } catch (error) {
    return {
      status: errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable',
      mode: null,
    }
  }
}

function parseHistoryLimit(value: string | undefined): {
  value: number | null
  invalid: boolean
} {
  if (value === undefined || value.trim() === '') {
    return { value: DEFAULT_HISTORY_LIMIT, invalid: false }
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { value: null, invalid: true }
  }
  return { value: parsed, invalid: false }
}

function parseContextWindowOverride(value: string | undefined): {
  value: number | null
  invalid: boolean
} {
  if (value === undefined || value.trim() === '') {
    return { value: null, invalid: false }
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { value: null, invalid: true }
  }
  return { value: Math.floor(parsed), invalid: false }
}

function budgetFor(path: string, text: string | null): FileBudget {
  if (text === null) {
    return {
      path,
      exists: false,
      chars: 0,
      utf8Bytes: 0,
      lines: 0,
      estimatedTokens: 0,
    }
  }
  return {
    path,
    exists: true,
    chars: text.length,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    lines: countLines(text),
    estimatedTokens: estimateTokens(text.length),
  }
}

function budgetFromObservation(
  path: string,
  rawChars: number | null,
  rawBytes: number | null,
  rawLines: number | null,
): FileBudget {
  const measured = rawChars !== null || rawBytes !== null || rawLines !== null
  const chars = Math.floor(Math.max(0, rawChars ?? rawBytes ?? 0))
  const utf8Bytes = Math.floor(Math.max(0, rawBytes ?? chars))
  const lines = Math.floor(Math.max(0, rawLines ?? 0))
  return {
    path,
    exists: measured && (chars > 0 || utf8Bytes > 0 || lines > 0),
    chars,
    utf8Bytes,
    lines,
    estimatedTokens: estimateTokens(chars),
  }
}

function addBudgets(...budgets: FileBudget[]): Omit<FileBudget, 'path' | 'exists'> {
  const chars = budgets.reduce((sum, budget) => sum + budget.chars, 0)
  return {
    chars,
    utf8Bytes: budgets.reduce((sum, budget) => sum + budget.utf8Bytes, 0),
    lines: budgets.reduce((sum, budget) => sum + budget.lines, 0),
    estimatedTokens: estimateTokens(chars),
  }
}

function countLines(text: string): number {
  if (!text) return 0
  const newlines = text.match(/\n/g)?.length ?? 0
  return text.endsWith('\n') ? newlines : newlines + 1
}

function estimateTokens(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0
}

function parseJsonValue(text: string): unknown {
  const clean = stripAnsi(text).trim()
  if (!clean) return undefined
  try {
    return JSON.parse(clean) as unknown
  } catch {
    return undefined
  }
}

function dispatchPathValue(
  value: unknown,
): RuntimeObservation['dispatchPath'] {
  return value === 'gateway' || value === 'cli' || value === 'none'
    ? value
    : null
}

function canonSourceValue(
  value: unknown,
): RuntimeObservation['canonSource'] | null {
  if (value === 'backend' || value === 'served') return 'backend'
  if (value === 'bundled' || value === 'fallback') return 'bundled'
  if (value === 'unknown') return 'unknown'
  return null
}

function findDeepNumber(
  sources: Record<string, unknown>[],
  keys: readonly string[],
): number | null {
  return finiteNumber(findDeepValueFromSources(sources, keys))
}

function findDeepString(
  sources: Record<string, unknown>[],
  keys: readonly string[],
): string | null {
  return valueString(findDeepValueFromSources(sources, keys))
}

function findDeepBoolean(
  sources: Record<string, unknown>[],
  keys: readonly string[],
): boolean | null {
  const value = findDeepValueFromSources(sources, keys)
  return typeof value === 'boolean' ? value : null
}

function findDeepValueFromSources(
  sources: Record<string, unknown>[],
  keys: readonly string[],
): unknown {
  for (const source of sources) {
    const value = findDeepValue(source, keys)
    if (value !== undefined) return value
  }
  return undefined
}

function findDeepValue(
  root: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  const wanted = new Set(keys)
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ]
  const seen = new Set<object>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (
      current.depth > 8 ||
      current.value === null ||
      typeof current.value !== 'object'
    ) {
      continue
    }
    if (seen.has(current.value)) continue
    seen.add(current.value)
    if (isRecord(current.value)) {
      for (const [key, value] of Object.entries(current.value)) {
        if (wanted.has(key)) return value
      }
    }
    const values = Array.isArray(current.value)
      ? current.value
      : isRecord(current.value)
        ? Object.values(current.value)
        : []
    for (const value of values) {
      queue.push({ value, depth: current.depth + 1 })
    }
  }
  return undefined
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function nonNegativeNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null
}

function positiveInteger(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

function boundedPercentage(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) {
    return null
  }
  return value
}

function valueString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  return clean || null
}

function versionString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return valueString(value)
}

function strictVersion(value: unknown): string | null {
  return parseStrictSemver(value) === null ? null : String(value)
}

interface StrictSemver {
  major: string
  minor: string
  patch: string
  prerelease: string[] | null
}

function parseStrictSemver(value: unknown): StrictSemver | null {
  if (typeof value !== 'string') return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    value,
  )
  if (!match) return null
  const prerelease = match[4]?.split('.') ?? null
  if (
    prerelease?.some(
      (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'),
    )
  ) {
    return null
  }
  return {
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
  }
}

function isValidUpdateStateTransition(
  state: Record<string, unknown>,
): boolean {
  const versionKeys = [
    'previousVersion',
    'targetVersion',
    'pinnedVersion',
    'selectedVersion',
    'handoffAttemptedFromVersion',
  ] as const
  for (const key of versionKeys) {
    if (state[key] !== undefined && strictVersion(state[key]) === null) {
      return false
    }
  }
  const timestampKeys = [
    'validationBootStartedAtMs',
    'daemonBootStartedAtMs',
  ] as const
  for (const key of timestampKeys) {
    const value = state[key]
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      return false
    }
  }

  const previous = state.previousVersion as string | undefined
  const target = state.targetVersion as string | undefined
  const pinned = state.pinnedVersion as string | undefined
  const selected = state.selectedVersion as string | undefined
  const handoff = state.handoffAttemptedFromVersion as string | undefined
  const validationBoot = state.validationBootStartedAtMs as number | undefined
  const daemonBoot = state.daemonBootStartedAtMs as number | undefined
  const crashCount = Number(state.earlyCrashCount)
  const disabled = state.disabledAfterRollback === true
  const resetObserved = state.resetObserved === true
  const hasPrevious = previous !== undefined
  const hasTarget = target !== undefined
  if (hasPrevious !== hasTarget) return false

  if (hasPrevious && hasTarget) {
    const previousSemver = parseStrictSemver(previous)
    const targetSemver = parseStrictSemver(target)
    if (
      previousSemver === null ||
      targetSemver === null ||
      previousSemver.major !== targetSemver.major ||
      compareStrictSemver(targetSemver, previousSemver) <= 0
    ) {
      return false
    }
    if (disabled) {
      return (
        pinned === previous &&
        selected === previous &&
        handoff === previous &&
        crashCount === 2 &&
        validationBoot === undefined &&
        daemonBoot === undefined
      )
    }
    return (
      !resetObserved &&
      pinned === undefined &&
      selected === target &&
      handoff === previous &&
      crashCount >= 0 &&
      crashCount <= 1 &&
      (daemonBoot === undefined || validationBoot !== undefined) &&
      (daemonBoot === undefined || daemonBoot >= validationBoot!) &&
      (crashCount !== 1 || validationBoot !== undefined)
    )
  }

  return (
    pinned === undefined &&
    handoff === undefined &&
    crashCount === 0 &&
    validationBoot === undefined &&
    daemonBoot === undefined &&
    (!resetObserved || disabled) &&
    (!disabled || selected === undefined)
  )
}

function compareStrictSemver(left: StrictSemver, right: StrictSemver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const leftPart = BigInt(left[key])
    const rightPart = BigInt(right[key])
    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }
  if (left.prerelease === null && right.prerelease === null) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

function firstString(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function configuredSecret(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  const clean = value.trim()
  if (!clean) return false
  return !/^(?:<.*>|change[_-]?me|replace[_-]?me|placeholder|undefined|null|none|\$\{[^}]+\})$/i.test(
    clean,
  )
}

function validHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function firstMode(detail: string): string | null {
  return detail.match(/\b0[0-7]{3}\b/)?.[0] ?? null
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function redactDiagnosticText(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(
      /\b(api[_-]?key|pairing[_-]?token|access[_-]?token|gateway[_-]?token|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi,
      '$1$2[redacted]',
    )
    .replace(
      /([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .trim()
}

function severityForDoctor(status: DoctorCheck['status']): FindingSeverity {
  return status === 'fail' ? 'error' : status === 'warn' ? 'warning' : 'info'
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean || 'diagnostic'
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function makeFinding(input: {
  id: string
  category: FindingCategory
  severity: FindingSeverity
  explanation: string
  file: string
  line: number
  proposedChange: ProposedChange
  classification: FindingClassification
  whySafe: string
}): Finding {
  return {
    ...input,
    line: Number.isInteger(input.line) && input.line > 0 ? input.line : 1,
  }
}

function summarize(findings: Finding[]): FindingsReport['summary'] {
  const byCategory: Record<FindingCategory, number> = {
    'context-rot': 0,
    'starting-context': 0,
    'claude-md-rules': 0,
    'broken-mcp': 0,
  }
  const bySeverity: Record<FindingSeverity, number> = {
    info: 0,
    warning: 0,
    error: 0,
  }
  const byClassification: Record<FindingClassification, number> = {
    'auto-apply': 0,
    'needs-approval': 0,
    'analyze-only': 0,
  }
  for (const finding of findings) {
    byCategory[finding.category] += 1
    bySeverity[finding.severity] += 1
    byClassification[finding.classification] += 1
  }
  return { total: findings.length, byCategory, bySeverity, byClassification }
}

function makeFindingIdsUnique(findings: Finding[]): void {
  const totals = new Map<string, number>()
  for (const finding of findings) {
    totals.set(finding.id, (totals.get(finding.id) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  for (const finding of findings) {
    if ((totals.get(finding.id) ?? 0) < 2) continue
    const base = finding.id
    const ordinal = (seen.get(base) ?? 0) + 1
    seen.set(base, ordinal)
    finding.id = base + ':' + ordinal
  }
}
