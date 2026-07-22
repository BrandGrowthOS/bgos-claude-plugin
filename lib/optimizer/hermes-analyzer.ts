/**
 * Hermes agent analyzer for optimizer milestone 2.
 *
 * This module is read-only by construction. Its filesystem dependency exposes
 * only readFile. Its process dependency receives four fixed diagnostic calls.
 * Findings contain proposed changes as serializable data and there is no apply
 * path in this module.
 */

import { execFile } from 'node:child_process'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
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

const COMMAND_TIMEOUT_MS = 30_000
const COMMAND_MAX_BYTES = 1024 * 1024
const SMALL_CONTEXT_WINDOW_TOKENS = 128_000
const LARGE_SKILLS_INDEX_BYTES = 8 * 1024
const LARGE_BGOS_HINT_BYTES = 4 * 1024
const MEMORY_NEAR_CAP_RATIO = 0.9
const DEFAULT_MEMORY_CHAR_LIMIT = 2_200
const DEFAULT_COMPRESSION_THRESHOLD = 0.5
const DEFAULT_PROTECT_LAST_N = 20
const HERMES_PROJECT_NAMES = ['.hermes.md', 'HERMES.md'] as const
const LOCAL_PROJECT_SURFACES = [
  ['AGENTS.md', 1],
  ['agents.md', 1],
  ['CLAUDE.md', 2],
  ['claude.md', 2],
  ['.cursorrules', 3],
] as const

export const HERMES_DEFAULT_SOUL_MD =
  'You are Hermes Agent, an intelligent AI assistant created by Nous Research. ' +
  'You are helpful, knowledgeable, and direct. You assist users with a wide ' +
  'range of tasks including answering questions, writing and editing code, ' +
  'analyzing information, creative work, and executing actions via your tools. ' +
  'You communicate clearly, admit uncertainty when appropriate, and prioritize ' +
  'being genuinely useful over being verbose unless otherwise directed below. ' +
  'Be targeted and efficient in your exploration and investigations.'

const HERMES_LEGACY_SOUL_TEMPLATES = [
  [
    '# Hermes Agent Persona',
    '',
    '<!--',
    "This file defines the agent's personality and tone.",
    'The agent will embody whatever you write here.',
    'Edit this to customize how Hermes communicates with you.',
    '',
    'Examples:',
    '  - "You are a warm, playful assistant who uses kaomoji occasionally."',
    '  - "You are a concise technical expert. No fluff, just facts."',
    '  - "You speak like a friendly coworker who happens to know everything."',
    '',
    'This file is loaded fresh each message -- no restart needed.',
    'Delete the contents (or this file) to use the default personality.',
    '-->',
  ].join('\n'),
  [
    '# Hermes Agent Persona',
    '',
    '<!--',
    "This file defines the agent's personality and tone.",
    'The agent will embody whatever you write here.',
    'Edit this to customize how Hermes communicates with you.',
    '',
    'This file is loaded fresh each message -- no restart needed.',
    'Delete the contents (or this file) to use the default personality.',
    '-->',
  ].join('\n'),
] as const

export interface HermesAnalyzerReadOnlyFs {
  readFile(path: string): Promise<string>
}

export interface HermesCommandRequest {
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}

export interface HermesCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface HermesAnalyzerDependencies {
  fs?: HermesAnalyzerReadOnlyFs
  runCommand?: (request: HermesCommandRequest) => Promise<HermesCommandResult>
  /** Optional live, read-only context_breakdown observation from a host UI. */
  inspectContext?: () => Promise<unknown>
  homeDir?: string
}

export interface HermesAnalyzerOptions {
  agentRoot: string
  hermesHome?: string
  nowMs?: number
}

interface TextRead {
  text: string | null
  error: 'missing' | 'unreadable' | null
}

interface CommandCapture {
  stdout: string
  exitCode: number
  failedToStart: boolean
}

interface ParsedConfig {
  status: 'valid' | 'missing' | 'malformed'
  value: Record<string, unknown>
}

interface PromptBreakdown {
  raw: Record<string, unknown>
  model: string | null
  systemPrompt: SizeObservation
  skillsIndex: SizeObservation
  memory: SizeObservation
  userProfile: SizeObservation
  tools: {
    count: number
    jsonBytes: number
  }
  sections: {
    stable: SizeObservation
    context: SizeObservation
    volatile: SizeObservation
  }
  platformHint: SizeObservation
  platformHintMeasured: boolean
}

interface SizeObservation {
  chars: number
  bytes: number
}

interface MeasuredSizeObservation {
  size: SizeObservation
  measured: boolean
}

interface DiagnosticCheck {
  name: string
  status: 'OK' | 'WARN' | 'FAIL'
  detail: string
  fix: string
}

interface ParsedDiagnostics {
  recognized: boolean
  checks: DiagnosticCheck[]
}

interface McpListObservation {
  recognized: boolean
  servers: Array<{
    name: string
    enabled: boolean
    issue: DiagnosticCheck | null
  }>
}

interface ProjectSurface {
  path: string
  label: string
  priority: number
  read: TextRead
}

interface HermesAnalysisInput {
  agentRoot: string
  hermesHome: string
  hermesExecutable: string
  bgosDoctorExecutable: string
  configPath: string
  soulPath: string
  memoryPath: string
  userPath: string
  configRead: TextRead
  soulRead: TextRead
  memoryRead: TextRead
  userRead: TextRead
  projectSurfaces: ProjectSurface[]
  config: ParsedConfig
  prompt: PromptBreakdown | null
  promptCapture: CommandCapture
  doctorCapture: CommandCapture
  mcpCapture: CommandCapture
  bgosCapture: CommandCapture
  doctor: ParsedDiagnostics
  bgosDoctor: ParsedDiagnostics
  mcpList: McpListObservation
  runtimeContext: unknown
  unusedToolsets: string[]
  unusedSkills: string[]
}

const defaultFs: HermesAnalyzerReadOnlyFs = {
  readFile: async (path) => nodeReadFile(path, 'utf8'),
}

const execFileAsync = promisify(execFile)

async function defaultRunCommand(
  request: HermesCommandRequest,
): Promise<HermesCommandResult> {
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

export async function analyzeHermesAgent(
  options: HermesAnalyzerOptions,
  dependencies: HermesAnalyzerDependencies = {},
): Promise<FindingsReport> {
  const fs = dependencies.fs ?? defaultFs
  const runCommand = dependencies.runCommand ?? defaultRunCommand
  const homeDir = dependencies.homeDir ?? homedir()
  const nowMs = options.nowMs ?? Date.now()
  const agentRoot = normalize(resolve(options.agentRoot))
  const hermesHome = normalize(
    resolve(options.hermesHome ?? join(homeDir, '.hermes')),
  )
  const hermesExecutable = normalize(
    resolve(join(homeDir, '.local', 'bin', 'hermes')),
  )
  const bgosDoctorExecutable = normalize(
    resolve(
      join(
        hermesHome,
        'hermes-agent',
        'venv',
        'bin',
        'hermes-bgos-doctor',
      ),
    ),
  )
  const configPath = join(hermesHome, 'config.yaml')
  const soulPath = join(hermesHome, 'SOUL.md')
  const nestedMemoryPath = join(hermesHome, 'memories', 'MEMORY.md')
  const nestedUserPath = join(hermesHome, 'memories', 'USER.md')
  const rootMemoryPath = join(hermesHome, 'MEMORY.md')
  const rootUserPath = join(hermesHome, 'USER.md')

  const commandEnv = { HERMES_HOME: hermesHome }
  const commandRequests: HermesCommandRequest[] = [
    {
      executable: hermesExecutable,
      args: ['prompt-size', '--json'],
      cwd: agentRoot,
      env: commandEnv,
    },
    {
      executable: hermesExecutable,
      args: ['doctor'],
      cwd: agentRoot,
      env: commandEnv,
    },
    {
      executable: hermesExecutable,
      args: ['mcp', 'list'],
      cwd: agentRoot,
      env: commandEnv,
    },
    {
      executable: bgosDoctorExecutable,
      args: ['--json'],
      cwd: agentRoot,
      env: commandEnv,
    },
  ]

  const [
    commandCaptures,
    configRead,
    soulRead,
    nestedMemoryRead,
    nestedUserRead,
    rootMemoryRead,
    rootUserRead,
    projectSurfaces,
    runtimeContext,
  ] = await Promise.all([
    Promise.all(
      commandRequests.map((request) => captureCommand(runCommand, request)),
    ),
    readText(fs, configPath),
    readText(fs, soulPath),
    readText(fs, nestedMemoryPath),
    readText(fs, nestedUserPath),
    readText(fs, rootMemoryPath),
    readText(fs, rootUserPath),
    loadProjectSurfaces(fs, agentRoot),
    dependencies.inspectContext
      ? dependencies.inspectContext().catch(() => null)
      : Promise.resolve(null),
  ])

  const memoryPath =
    nestedMemoryRead.text !== null || rootMemoryRead.text === null
      ? nestedMemoryPath
      : rootMemoryPath
  const memoryRead = memoryPath === nestedMemoryPath ? nestedMemoryRead : rootMemoryRead
  const userPath =
    nestedUserRead.text !== null || rootUserRead.text === null ? nestedUserPath : rootUserPath
  const userRead = userPath === nestedUserPath ? nestedUserRead : rootUserRead
  const config = parseConfig(configRead)
  const prompt = parsePromptBreakdown(commandCaptures[0]!.stdout)
  const doctor = parseDiagnostics(commandCaptures[1]!.stdout)
  const mcpList = parseMcpList(commandCaptures[2]!.stdout)
  const bgosDoctor = parseDiagnostics(commandCaptures[3]!.stdout)
  const evidenceSources = [runtimeContext, prompt?.raw].filter(
    (value): value is Record<string, unknown> => isRecord(value),
  )
  const configuredToolsets = configStringArray(config.value, ['toolsets'])
  const observedEnabledToolsets = explicitStringArray(evidenceSources, [
    'enabled_toolsets',
    'enabledToolsets',
    'configured_toolsets',
    'configuredToolsets',
    'active_toolsets',
    'activeToolsets',
  ])
  const knownConfiguredToolsets = new Set([
    ...configuredToolsets,
    ...observedEnabledToolsets,
  ])
  const disabledToolsets = new Set(
    configStringArray(config.value, ['agent', 'disabled_toolsets']),
  )
  const unusedToolsets = explicitStringArray(evidenceSources, [
    'unused_toolsets',
    'unusedToolsets',
  ]).filter(
    (name) => knownConfiguredToolsets.has(name) && !disabledToolsets.has(name),
  )
  const unusedSkills = explicitStringArray(evidenceSources, [
    'unused_skills',
    'unusedSkills',
  ])

  const input: HermesAnalysisInput = {
    agentRoot,
    hermesHome,
    hermesExecutable,
    bgosDoctorExecutable,
    configPath,
    soulPath,
    memoryPath,
    userPath,
    configRead,
    soulRead,
    memoryRead,
    userRead,
    projectSurfaces,
    config,
    prompt,
    promptCapture: commandCaptures[0]!,
    doctorCapture: commandCaptures[1]!,
    mcpCapture: commandCaptures[2]!,
    bgosCapture: commandCaptures[3]!,
    doctor,
    bgosDoctor,
    mcpList,
    runtimeContext,
    unusedToolsets,
    unusedSkills,
  }

  const contextRot = analyzeContextRot(input)
  const startingContext = analyzeStartingContext(input)
  const claudeMdRules = analyzeInstructionSurface(input)
  const brokenMcp = analyzeBrokenMcp(input)
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
    agent: { kind: 'hermes', root: agentRoot },
    categories: { contextRot, startingContext, claudeMdRules, brokenMcp },
    findings,
    summary: summarize(findings),
  }
}

function analyzeContextRot(input: HermesAnalysisInput): ContextRotCategory {
  const findings: Finding[] = []
  const promptContext = firstRecord([
    input.prompt?.raw.context_breakdown,
    input.prompt?.raw.contextBreakdown,
    input.prompt?.raw.session_context,
  ])
  const liveSources = [input.runtimeContext, promptContext].filter(
    (value): value is Record<string, unknown> => isRecord(value),
  )
  const promptSources = [input.prompt?.raw].filter(
    (value): value is Record<string, unknown> => isRecord(value),
  )
  const hasTopLevelLiveEvidence =
    promptSources.length > 0 &&
    [
      'context_percent',
      'context_pct',
      'context_used',
      'used_tokens',
      '_ineffective_compression_count',
      'ineffective_compression_count',
    ].some((key) => promptSources[0]![key] !== undefined)
  if (hasTopLevelLiveEvidence) liveSources.push(promptSources[0]!)
  const modelSources = [...liveSources, ...promptSources]
  const model =
    firstString([
      findDeepString(modelSources, ['model']),
      input.prompt?.model,
      configString(input.config.value, ['model', 'default']),
      configString(input.config.value, ['model', 'model']),
      typeof input.config.value.model === 'string' ? input.config.value.model : null,
    ]) ?? null
  const nominalWindowTokens = firstPositiveNumber([
    findDeepNumber(liveSources, [
      'context_max',
      'context_window_tokens',
      'contextWindowTokens',
      'window_tokens',
    ]),
    configNumber(input.config.value, ['model', 'context_length']),
    configNumber(input.config.value, ['context', 'context_length']),
    configNumber(input.config.value, ['context_length']),
  ])
  const explicitPct = findDeepNumber(liveSources, [
    'context_percent',
    'context_pct',
    'contextPct',
  ])
  const usedTokens = findDeepNumber(liveSources, [
    'context_used',
    'used_tokens',
    'contextUsed',
  ])
  const contextPct = boundedPercentage(
    explicitPct ??
      (usedTokens !== null && nominalWindowTokens !== null
        ? (usedTokens / nominalWindowTokens) * 100
        : null),
  )
  const ineffectiveCompressionCount = findDeepNumber(liveSources, [
    '_ineffective_compression_count',
    'ineffective_compression_count',
    'ineffectiveCompressionCount',
  ])
  const memoryCharLimit =
    configNumber(input.config.value, ['memory', 'memory_char_limit']) ??
    DEFAULT_MEMORY_CHAR_LIMIT
  const contextEngine =
    configString(input.config.value, ['context', 'engine']) ?? 'compressor'
  const configuredThreshold = firstFiniteNumber([
    configNumber(input.config.value, ['compression', 'threshold']),
    configNumber(input.config.value, ['context', 'threshold_percent']),
    configNumber(input.config.value, ['context', 'compressor', 'threshold_percent']),
  ])
  const threshold =
    contextEngine === 'compressor'
      ? configuredThreshold ?? DEFAULT_COMPRESSION_THRESHOLD
      : configuredThreshold
  const protectLastN = firstFiniteNumber([
    configNumber(input.config.value, ['compression', 'protect_last_n']),
    configNumber(input.config.value, ['context', 'protect_last_n']),
    configNumber(input.config.value, ['context', 'compressor', 'protect_last_n']),
  ])

  const hasLiveContextTelemetry = liveSources.some(
    (source) =>
      findDeepValue(source, [
        'context_percent',
        'context_pct',
        'context_used',
        'used_tokens',
        'categories',
        '_ineffective_compression_count',
        'ineffective_compression_count',
      ]) !== undefined,
  )
  if (!hasLiveContextTelemetry) {
    findings.push(
      makeFinding({
        id: 'live-context-telemetry-unavailable',
        category: 'context-rot',
        severity: 'info',
        explanation:
          'The fixed prompt was inspected, but no live context breakdown was available for this session.',
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'context'),
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-live-context-breakdown',
          operation: 'none',
          description:
            'Supply the read-only context breakdown from the live agent before judging session rot.',
          data: {},
        },
        whySafe:
          'The analyzer records missing evidence and does not compact, rotate, or rebuild the session.',
      }),
    )
  }

  if (ineffectiveCompressionCount !== null && ineffectiveCompressionCount >= 2) {
    findings.push(
      makeFinding({
        id: 'ineffective-compression',
        category: 'context-rot',
        severity: 'error',
        explanation:
          `Compression has failed to reclaim useful context ${Math.floor(ineffectiveCompressionCount)} consecutive times.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'compression'),
        classification: 'analyze-only',
        proposedChange: {
          kind: 'review-context-rebuild',
          operation: 'none',
          description:
            'Review a larger-context model or let the owner start /new when preserving the current session is no longer useful.',
          data: {
            ineffectiveCompressionCount: Math.floor(ineffectiveCompressionCount),
            recommendations: ['larger-context-model', '/new'],
          },
        },
        whySafe:
          'No session action is invoked. Compression rotates session_id and summary loss is irreversible, so the analyzer never forces compaction or clears live state.',
      }),
    )
  }

  if (contextPct !== null && contextPct >= 80) {
    findings.push(
      makeFinding({
        id: 'context-high',
        category: 'context-rot',
        severity: 'warning',
        explanation: `The live Hermes context breakdown reports ${Math.round(contextPct)} percent use.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'context'),
        classification: 'analyze-only',
        proposedChange: {
          kind: 'owner-controlled-new-session-review',
          operation: 'none',
          description:
            'Let the owner choose a larger-context model or start /new after preserving any durable facts.',
          data: { contextPct },
        },
        whySafe:
          'The current session remains untouched. Starting /new rotates session_id and is always an owner decision.',
      }),
    )
  }

  if (
    nominalWindowTokens !== null &&
    nominalWindowTokens <= SMALL_CONTEXT_WINDOW_TOKENS &&
    memoryCharLimit >= 2_000
  ) {
    findings.push(
      makeFinding({
        id: 'small-window-memory-pressure',
        category: 'context-rot',
        severity: 'warning',
        explanation:
          `The ${nominalWindowTokens.toLocaleString('en-US')}-token window also reserves up to ${memoryCharLimit.toLocaleString('en-US')} memory characters in every rebuilt session.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'memory_char_limit'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-model-or-memory-budget',
          operation: 'manual-action',
          description:
            'Review a larger-context model before reducing durable memory limits.',
          data: {
            contextWindowTokens: nominalWindowTokens,
            memoryCharLimit,
            preferredFirstReview: 'larger-context-model',
          },
        },
        whySafe:
          'No model or memory setting is changed. Both are cached at session construction and any approved change takes effect after /new.',
      }),
    )
  }

  if (contextEngine === 'compressor' && threshold !== null && threshold <= 0.5) {
    findings.push(
      makeFinding({
        id: 'compressor-threshold',
        category: 'context-rot',
        severity: 'warning',
        explanation: `The configured compressor threshold is ${Math.round(threshold * 100)} percent, which can summarize a session early.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'threshold'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-compressor-threshold',
          operation: 'edit-file',
          description:
            'Review a higher compression threshold while keeping the protected recent-message tail intact.',
          data: {
            currentThreshold: threshold,
            minimumProtectedRecentMessages: protectLastN ?? DEFAULT_PROTECT_LAST_N,
          },
        },
        whySafe:
          'This is data only. A threshold change applies after /new, and protect_last_n must never be lowered as part of the review.',
      }),
    )
  }

  if (protectLastN !== null && protectLastN < DEFAULT_PROTECT_LAST_N) {
    findings.push(
      makeFinding({
        id: 'compressor-tail-protection-reduced',
        category: 'context-rot',
        severity: 'warning',
        explanation: `The compressor protects only ${Math.floor(protectLastN)} recent messages instead of the shipped ${DEFAULT_PROTECT_LAST_N}.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'protect_last_n'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-protected-tail',
          operation: 'edit-file',
          description: 'Review restoring the shipped recent-message protection.',
          data: {
            currentProtectLastN: Math.floor(protectLastN),
            shippedProtectLastN: DEFAULT_PROTECT_LAST_N,
          },
        },
        whySafe:
          'No history is recompressed and no live setting is changed. Any approved restoration applies only after /new.',
      }),
    )
  }

  return {
    contextPct,
    model,
    nominalWindowTokens,
    binding: null,
    tmuxCompaction: { available: false, source: null },
    resting: { state: 'not-detected', resetAt: null },
    findings,
  }
}

function analyzeStartingContext(input: HermesAnalysisInput): StartingContextCategory {
  const findings: Finding[] = []
  const soul = budgetFor(input.soulPath, input.soulRead.text)
  const memory = budgetFor(input.memoryPath, input.memoryRead.text)
  const hint = input.prompt?.platformHint ?? emptySize()
  const hintMeasured = input.prompt?.platformHintMeasured ?? false
  const externalSkillDirs = configStringArray(input.config.value, [
    'skills',
    'external_dirs',
  ])
  const platformHints = budgetFromSize(input.configPath, hint)
  const total = addBudgets(soul, platformHints, memory)

  if (!input.prompt) {
    findings.push(
      makeFinding({
        id: 'prompt-size-unavailable',
        category: 'starting-context',
        severity: 'warning',
        explanation: 'hermes prompt-size did not return a valid JSON object.',
        file: input.hermesExecutable,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-prompt-size-diagnostic',
          operation: 'none',
          description: 'Inspect the read-only prompt-size diagnostic before trimming context.',
          data: { exitCode: input.promptCapture.exitCode },
        },
        whySafe:
          'No prompt file or config is changed when the measurement is unavailable.',
      }),
    )
  } else {
    const { stable, context, volatile } = input.prompt.sections
    findings.push(
      makeFinding({
        id: 'starting-context-breakdown',
        category: 'starting-context',
        severity: 'info',
        explanation:
          'Hermes fixed prompt tiers and tool schemas were measured for a fresh session.',
        file: input.configPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-starting-context',
          operation: 'none',
          description: 'Keep the tier measurements visible without changing cached prompt inputs.',
          data: {
            stableChars: stable.chars,
            stableBytes: stable.bytes,
            contextChars: context.chars,
            contextBytes: context.bytes,
            volatileChars: volatile.chars,
            volatileBytes: volatile.bytes,
            skillsIndexChars: input.prompt.skillsIndex.chars,
            skillsIndexBytes: input.prompt.skillsIndex.bytes,
            memoryChars: input.prompt.memory.chars,
            userProfileChars: input.prompt.userProfile.chars,
            toolCount: input.prompt.tools.count,
            toolSchemaBytes: input.prompt.tools.jsonBytes,
            bgosPlatformHintMeasured: hintMeasured,
            bgosPlatformHintBytes: hint.bytes,
          },
        },
        whySafe:
          'The offline diagnostic is observed only and no cached tier is rebuilt.',
      }),
    )

    if (input.prompt.skillsIndex.bytes >= LARGE_SKILLS_INDEX_BYTES) {
      const canReviewExternalDirs = externalSkillDirs.length > 0
      findings.push(
        makeFinding({
          id: 'skills-index-large',
          category: 'starting-context',
          severity: 'warning',
          explanation: `The always-on skills index is ${input.prompt.skillsIndex.bytes.toLocaleString('en-US')} bytes.`,
          file: input.configPath,
          line: lineOfYamlKey(input.configRead.text, 'skills'),
          classification: canReviewExternalDirs
            ? 'needs-approval'
            : 'analyze-only',
          proposedChange: {
            kind: 'review-skills-index',
            operation: canReviewExternalDirs ? 'edit-file' : 'none',
            description: canReviewExternalDirs
              ? 'Review which skills.external_dirs entries supply unused skills while preserving scheduled or standalone dependencies.'
              : 'Identify whether the large index comes from bundled or profile skills before proposing a config change.',
            data: {
              currentBytes: input.prompt.skillsIndex.bytes,
              externalDirCount: externalSkillDirs.length,
            },
          },
          whySafe:
            'No skill is removed automatically. Proven external directory changes require approval and take effect after /new.',
        }),
      )
    }

    if (!hintMeasured) {
      findings.push(
        makeFinding({
          id: 'bgos-platform-hints-unmeasured',
          category: 'starting-context',
          severity: 'info',
          explanation:
            'The real CLI prompt-size schema measures the CLI prompt and does not expose the BGOS platform hint as a separate tier.',
          file: input.hermesExecutable,
          line: 1,
          classification: 'analyze-only',
          proposedChange: {
            kind: 'observe-bgos-platform-hint',
            operation: 'none',
            description:
              'Supply a BGOS-scoped read-only prompt measurement before judging whether platform guidance can be trimmed.',
            data: {
              measured: false,
              promptPlatform: valueString(input.prompt.raw.platform) ?? 'unknown',
            },
          },
          whySafe:
            'The analyzer reports the measurement gap instead of treating zero as evidence. It does not trim capability syntax or rebuild a session.',
        }),
      )
    }
  }

  if (input.unusedToolsets.length > 0) {
    findings.push(
      makeFinding({
        id: 'unused-toolsets',
        category: 'starting-context',
        severity: 'warning',
        explanation: `Explicit usage evidence marks these configured toolsets unused in the observed path: ${input.unusedToolsets.join(', ')}.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'toolsets'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-disabled-toolsets',
          operation: 'edit-file',
          description: 'Review adding only confirmed unused entries to agent.disabled_toolsets.',
          data: { toolsets: input.unusedToolsets },
        },
        whySafe:
          'No toolset is disabled. Approval is required because cron and standalone paths may use tools absent from this observation, and changes apply after /new.',
      }),
    )
  }

  if (input.unusedSkills.length > 0) {
    const canReviewExternalDirs = externalSkillDirs.length > 0
    findings.push(
      makeFinding({
        id: 'unused-skills',
        category: 'starting-context',
        severity: 'warning',
        explanation: `Explicit usage evidence marks these indexed skills unused in the observed path: ${input.unusedSkills.join(', ')}.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'external_dirs'),
        classification: canReviewExternalDirs
          ? 'needs-approval'
          : 'analyze-only',
        proposedChange: {
          kind: 'review-external-skill-dirs',
          operation: canReviewExternalDirs ? 'edit-file' : 'none',
          description: canReviewExternalDirs
            ? 'Review which skills.external_dirs entries supply the unused skills without deleting skill files.'
            : 'Determine whether these are bundled or profile skills before proposing any external directory change.',
          data: {
            skills: input.unusedSkills,
            configuredExternalDirs: externalSkillDirs,
          },
        },
        whySafe:
          'No skill directory is edited or removed. Only a proven external directory change can be approval-gated, and it applies after /new.',
      }),
    )
  }

  if (hintMeasured && hint.bytes >= LARGE_BGOS_HINT_BYTES) {
    findings.push(
      makeFinding({
        id: 'platform-hints-large',
        category: 'starting-context',
        severity: 'warning',
        explanation: `The BGOS platform guidance contributes ${hint.bytes.toLocaleString('en-US')} bytes to stable context.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'platform_hints'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-bgos-platform-hints',
          operation: 'edit-file',
          description:
            'Review platform_hints.bgos.replace or append text while preserving the channel contract.',
          data: {
            chars: hint.chars,
            bytes: hint.bytes,
            preserveSyntax: ['MEDIA:', '[[BGOS_BUTTONS]]', 'approval', 'reply-quote'],
          },
        },
        whySafe:
          'No hint is trimmed automatically. MEDIA:, [[BGOS_BUTTONS]], approval, and reply-quote syntax are capability contracts; an approved change applies after /new.',
      }),
    )
  }

  return {
    budget: {
      claudeMd: soul,
      mcpInstructions: platformHints,
      memoryIndex: memory,
      total,
    },
    mcpInstructionsSourceChars: hint.chars,
    canonSource: 'unknown',
    canonSummaryDoubleLoad: false,
    cursorStore: {
      path: join(input.hermesHome, 'state.db'),
      status: 'unreadable',
      entries: 0,
    },
    findings,
  }
}

function analyzeInstructionSurface(input: HermesAnalysisInput): ClaudeMdRulesCategory {
  const findings: Finding[] = []
  const files: InstructionFileReport[] = [
    {
      ...budgetFor(input.soulPath, input.soulRead.text),
      kind: 'claude-md',
      frontmatter: 'not-applicable',
    },
    {
      ...budgetFor(input.memoryPath, input.memoryRead.text),
      kind: 'rule',
      frontmatter: 'absent',
    },
    {
      ...budgetFor(input.userPath, input.userRead.text),
      kind: 'rule',
      frontmatter: 'absent',
    },
  ]
  for (const surface of input.projectSurfaces) {
    if (surface.read.text === null) continue
    files.push({
      ...budgetFor(surface.path, surface.read.text),
      kind: 'rule',
      frontmatter: surface.label === '.hermes.md' ? detectFrontmatter(surface.read.text) : 'absent',
    })
  }

  if (input.soulRead.text === null) {
    findings.push(
      makeFinding({
        id: 'soul-unreadable',
        category: 'claude-md-rules',
        severity: 'warning',
        explanation: 'SOUL.md is absent or unreadable, so no owner persona was measured.',
        file: input.soulPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-soul-file',
          operation: 'none',
          description: 'Confirm owner intent before creating or replacing a persona.',
          data: { status: input.soulRead.error ?? 'unreadable' },
        },
        whySafe: 'The analyzer does not synthesize or write a replacement persona.',
      }),
    )
  } else {
    const exactShippedDefault = input.soulRead.text === HERMES_DEFAULT_SOUL_MD
    const legacyTemplate = isLegacySoul(input.soulRead.text)
    if (exactShippedDefault || legacyTemplate) {
      findings.push(
        makeFinding({
          id: 'default-soul',
          category: 'claude-md-rules',
          severity: 'warning',
          explanation: exactShippedDefault
            ? 'SOUL.md is byte-for-byte the shipped Hermes default, so this agent has no owner-specific persona or BGOS context.'
            : 'SOUL.md matches a shipped legacy comment-only scaffold, so it contains no owner-specific persona or BGOS context.',
          file: input.soulPath,
          line: 1,
          classification: 'analyze-only',
          proposedChange: {
            kind: 'review-tailored-hermes-persona',
            operation: 'none',
            description:
              'Draft an owner-reviewed persona that preserves security and operational constraints.',
            data: {
              currentBytes: Buffer.byteLength(input.soulRead.text, 'utf8'),
              exactShippedDefault,
              legacyTemplate,
            },
          },
          whySafe:
            'Persona substance is owner intent, so nothing is applied. Any later text must pass the Hermes security scan, stay below the character cap, and take effect after /new.',
        }),
      )
    }
  }

  const memoryCharLimit =
    configNumber(input.config.value, ['memory', 'memory_char_limit']) ??
    DEFAULT_MEMORY_CHAR_LIMIT
  const memoryChars = codePointLength(input.memoryRead.text ?? '')
  if (
    input.memoryRead.text !== null &&
    memoryCharLimit > 0 &&
    memoryChars / memoryCharLimit >= MEMORY_NEAR_CAP_RATIO
  ) {
    findings.push(
      makeFinding({
        id: 'memory-near-cap',
        category: 'claude-md-rules',
        severity: 'warning',
        explanation: `MEMORY.md uses ${memoryChars} of ${memoryCharLimit} configured characters and is near silent truncation.`,
        file: input.memoryPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-memory-condensation',
          operation: 'edit-file',
          description: 'Review deduplication or condensation of durable facts.',
          data: {
            currentChars: memoryChars,
            memoryCharLimit,
            ratio: Number((memoryChars / memoryCharLimit).toFixed(4)),
          },
        },
        whySafe:
          'No fact is selected or removed automatically. Approved memory changes are cached and take effect after /new.',
      }),
    )
  }

  const activeSurface = input.projectSurfaces.find(
    (surface) => Boolean(surface.read.text?.trim()),
  )
  const agents = input.projectSurfaces.find((surface) => surface.label === 'AGENTS.md')
  const claude = input.projectSurfaces.find((surface) => surface.label === 'CLAUDE.md')
  const agentsIntendedButInactive =
    agents !== undefined &&
    (agents.read.error === 'unreadable' || agents.read.text?.trim() === '')
  if (
    claude !== undefined &&
    activeSurface?.path === claude.path &&
    agentsIntendedButInactive &&
    claude.read.text?.trim()
  ) {
    findings.push(
      makeFinding({
        id: 'claude-md-shadowing-intended-agents',
        category: 'claude-md-rules',
        severity: 'warning',
        explanation:
          'AGENTS.md exists but supplies no readable rules, so first-match fallback makes CLAUDE.md the active project instruction surface.',
        file: claude.path,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'review-project-instruction-precedence',
          operation: 'none',
          description:
            'Confirm whether AGENTS.md or CLAUDE.md contains the intended project contract.',
          data: {
            intendedFile: agents.path,
            activeFallback: claude.path,
            precedence: ['.hermes.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'],
          },
        },
        whySafe:
          'Intent is ambiguous, so neither file is moved, merged, renamed, or deleted.',
      }),
    )
  }

  if (
    activeSurface &&
    claude?.read.text?.trim() &&
    activeSurface.path !== claude.path
  ) {
    const activeIsUpperAgents = activeSurface.label === 'AGENTS.md'
    findings.push(
      makeFinding({
        id: activeIsUpperAgents
          ? 'claude-md-shadowed-by-agents'
          : 'claude-md-shadowed-by-higher-priority',
        category: 'claude-md-rules',
        severity: 'info',
        explanation: `${activeSurface.label} and CLAUDE.md both contain rules. Under first-match precedence, ${activeSurface.label} loads and CLAUDE.md is shadowed.`,
        file: claude.path,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'review-shadowed-project-instructions',
          operation: 'none',
          description:
            'Confirm whether the shadowed CLAUDE.md is stale or intentionally retained for another framework.',
          data: {
            activeFile: activeSurface.path,
            shadowedFile: claude.path,
            precedence: ['.hermes.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'],
          },
        },
        whySafe:
          'The analyzer does not merge, delete, rename, or rewrite either instruction file because both may carry intent.',
      }),
    )
  }

  return { files, deadReferences: [], ruleBlocks: [], findings }
}

function analyzeBrokenMcp(input: HermesAnalysisInput): BrokenMcpCategory {
  const findings: Finding[] = []
  const configuredMcpNames = configObjectKeys(input.config.value, ['mcp_servers'])
  const bgosChecks = input.bgosDoctor.checks
  const configCheck = findCheck(bgosChecks, 'config')
  const authCheck = findCheck(bgosChecks, 'auth')
  const pairingCheck = findCheck(bgosChecks, 'pairing_live')

  if (input.config.status === 'malformed') {
    findings.push(
      makeFinding({
        id: 'hermes-config-malformed',
        category: 'broken-mcp',
        severity: 'error',
        explanation: 'Hermes config.yaml is not a readable YAML mapping.',
        file: input.configPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-hermes-yaml-parse',
          operation: 'manual-action',
          description:
            'Review the parse error against a backup before attempting a minimal YAML repair.',
          data: { status: 'malformed' },
        },
        whySafe:
          'The analyzer does not rewrite malformed bytes or guess owner intent from a partial parse.',
      }),
    )
  } else if (input.config.status === 'missing') {
    findings.push(
      makeFinding({
        id: 'hermes-config-missing',
        category: 'broken-mcp',
        severity: 'error',
        explanation: 'Hermes config.yaml is absent or unreadable.',
        file: input.configPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'review-new-hermes-config',
          operation: 'none',
          description: 'Confirm the intended model and capabilities before creating config.',
          data: { status: 'missing' },
        },
        whySafe:
          'Creating a config can add capabilities and change intent, so the analyzer does not create one.',
      }),
    )
  }

  if (input.doctorCapture.failedToStart || !input.doctor.recognized) {
    findings.push(
      diagnosticUnavailableFinding({
        id: 'hermes-doctor-unavailable',
        label: 'hermes doctor',
        file: input.hermesExecutable,
        exitCode: input.doctorCapture.exitCode,
      }),
    )
  } else {
    for (const check of input.doctor.checks) {
      if (check.status === 'OK') continue
      const isAction = /^recommended action \d+$/i.test(check.name)
      findings.push(
        makeFinding({
          id: isAction
            ? `hermes-doctor-action:${slug(check.name)}`
            : `hermes-doctor-issue:${slug(check.name)}`,
          category: 'broken-mcp',
          severity: severityForStatus(check.status),
          explanation: `hermes doctor reports ${check.status}: ${check.detail}`,
          file: input.hermesExecutable,
          line: 1,
          classification: 'needs-approval',
          proposedChange: diagnosticProposedChange('hermes-doctor', check),
          whySafe:
            'The built-in fix is preserved as report data only. The analyzer never passes a repair flag or changes the Hermes environment.',
        }),
      )
    }
  }

  if (input.mcpCapture.failedToStart || !input.mcpList.recognized) {
    findings.push(
      diagnosticUnavailableFinding({
        id: 'mcp-list-unavailable',
        label: 'hermes mcp list',
        file: input.hermesExecutable,
        exitCode: input.mcpCapture.exitCode,
      }),
    )
  } else {
    const listedNames = new Set(input.mcpList.servers.map((server) => server.name))
    for (const server of input.mcpList.servers) {
      if (server.issue) {
        findings.push(
          makeFinding({
            id: `mcp-list-issue:${slug(server.name)}`,
            category: 'broken-mcp',
            severity: severityForStatus(server.issue.status),
            explanation: `hermes mcp list reports ${server.issue.status} for ${server.name}: ${server.issue.detail}`,
            file: input.configPath,
            line: lineOfYamlKey(input.configRead.text, server.name),
            classification: 'needs-approval',
            proposedChange: {
              kind: 'review-mcp-list-diagnostic',
              operation: 'manual-action',
              description:
                server.issue.fix || `Review the ${server.name} MCP configuration.`,
              data: {
                serverName: server.name,
                status: server.issue.status,
                fix: server.issue.fix,
              },
            },
            whySafe:
              'The list output is reported as data only. The analyzer does not connect to the server, trigger OAuth, or change stored credentials.',
          }),
        )
      }
      if (server.enabled) continue
      findings.push(
        makeFinding({
          id: `mcp-server-disabled:${slug(server.name)}`,
          category: 'broken-mcp',
          severity: 'warning',
          explanation: `Configured MCP server ${server.name} is disabled.`,
          file: input.configPath,
          line: lineOfYamlKey(input.configRead.text, server.name),
          classification: 'needs-approval',
          proposedChange: {
            kind: 'review-disabled-mcp-server',
            operation: 'manual-action',
            description:
              'Confirm whether the server is intentionally disabled before changing it.',
            data: { serverName: server.name, enabled: false },
          },
          whySafe:
            'The analyzer lists config state only. It does not connect, authenticate, enable, disable, or remove the server.',
        }),
      )
    }
    for (const name of configuredMcpNames) {
      if (listedNames.has(name)) continue
      findings.push(
        makeFinding({
          id: `configured-mcp-not-listed:${slug(name)}`,
          category: 'broken-mcp',
          severity: 'warning',
          explanation: `MCP server ${name} exists in config.yaml but was absent from the read-only list output.`,
          file: input.configPath,
          line: lineOfYamlKey(input.configRead.text, name),
          classification: 'needs-approval',
          proposedChange: {
            kind: 'review-mcp-config-scope',
            operation: 'manual-action',
            description:
              'Confirm that the analyzer and gateway use the same HERMES_HOME before changing the server.',
            data: { serverName: name },
          },
          whySafe:
            'No connectivity test is run and the server remains configured exactly as found.',
        }),
      )
    }
  }

  if (input.bgosCapture.failedToStart || !input.bgosDoctor.recognized) {
    findings.push(
      diagnosticUnavailableFinding({
        id: 'bgos-doctor-unavailable',
        label: 'hermes-bgos-doctor',
        file: input.bgosDoctorExecutable,
        exitCode: input.bgosCapture.exitCode,
      }),
    )
  } else {
    for (const check of bgosChecks) {
      if (check.status === 'OK') continue
      if (check.name.toLowerCase() === 'registration') {
        findings.push(
          makeFinding({
            id: 'bgos-registration',
            category: 'broken-mcp',
            severity: severityForStatus(check.status),
            explanation: `BGOS registration diagnostic reports ${check.status}: ${check.detail}`,
            file: input.bgosDoctorExecutable,
            line: 1,
            classification: 'analyze-only',
            proposedChange: diagnosticProposedChange('bgos-doctor', check, 'none'),
            whySafe:
              'The in-process registration probe can false-fail across processes. Run it from the gateway environment and corroborate gateway behavior before any change.',
          }),
        )
        continue
      }
      if (
        check.name.toLowerCase() === 'auth' &&
        /neither\s+BGOS_ALLOW_ALL_USERS\s+nor\s+BGOS_ALLOWED_USERS\s+set/i.test(
          check.detail,
        )
      ) {
        findings.push(
          makeFinding({
            id: 'bgos-auth-gate-unset',
            category: 'broken-mcp',
            severity: severityForStatus(check.status),
            explanation:
              'Neither BGOS_ALLOW_ALL_USERS nor BGOS_ALLOWED_USERS is set, so inbound messages can be silently dropped by the auth gate.',
            file: join(input.hermesHome, '.env'),
            line: 1,
            classification: 'needs-approval',
            proposedChange: diagnosticProposedChange('bgos-doctor', check),
            whySafe:
              'Authorization scope changes access and requires owner approval. The analyzer does not set environment values or restart the gateway.',
          }),
        )
        continue
      }
      if (
        check.name.toLowerCase() === 'pairing_live' &&
        /\b0\s+assistants?\s+exposed\b/i.test(check.detail)
      ) {
        findings.push(
          makeFinding({
            id: 'bgos-no-assistants-exposed',
            category: 'broken-mcp',
            severity: severityForStatus(check.status),
            explanation:
              'The server is paired but zero assistants are exposed, so BGOS users cannot reach this agent.',
            file: input.bgosDoctorExecutable,
            line: 1,
            classification: 'analyze-only',
            proposedChange: diagnosticProposedChange('bgos-doctor', check, 'none'),
            whySafe:
              'Exposing an assistant adds user-facing capability, so the analyzer records guidance only and does not change pairing scope.',
          }),
        )
        continue
      }
      findings.push(
        makeFinding({
          id: `bgos-doctor-check:${slug(check.name)}`,
          category: 'broken-mcp',
          severity: severityForStatus(check.status),
          explanation: `hermes-bgos-doctor reports ${check.status}: ${check.detail}`,
          file: input.bgosDoctorExecutable,
          line: 1,
          classification:
            check.name.toLowerCase() === 'catalog' ? 'analyze-only' : 'needs-approval',
          proposedChange: diagnosticProposedChange(
            'bgos-doctor',
            check,
            check.name.toLowerCase() === 'catalog' ? 'none' : 'manual-action',
          ),
          whySafe:
            'The built-in fix is displayed as data only. Run the doctor from the gateway environment before acting because standalone process state can differ.',
        }),
      )
    }
  }

  if (input.unusedToolsets.length > 0) {
    findings.push(
      makeFinding({
        id: 'configured-toolset-unused',
        category: 'broken-mcp',
        severity: 'warning',
        explanation: `Configured toolsets were explicitly unused in the observed path: ${input.unusedToolsets.join(', ')}.`,
        file: input.configPath,
        line: lineOfYamlKey(input.configRead.text, 'toolsets'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-unused-toolset-health',
          operation: 'edit-file',
          description:
            'Review agent.disabled_toolsets only after checking every execution path.',
          data: { toolsets: input.unusedToolsets },
        },
        whySafe:
          'Nothing is disabled because cron and standalone paths can depend on tools unused in the live session. An approved cached-tier change takes effect after /new.',
      }),
    )
  }

  const doctorHasFail = input.doctor.checks.some((check) => check.status === 'FAIL')
  const bgosHasCorroboratedFail = bgosChecks.some(
    (check) =>
      check.status === 'FAIL' && check.name.toLowerCase() !== 'registration',
  )
  const mcpHasFail = input.mcpList.servers.some(
    (server) => server.issue?.status === 'FAIL',
  )
  const functionalBgosFailure =
    (configCheck !== undefined && configCheck.status !== 'OK') ||
    (authCheck !== undefined && authCheck.status !== 'OK') ||
    (pairingCheck !== undefined && pairingCheck.status !== 'OK')
  const hasUnhealthyState =
    input.config.status !== 'valid' ||
    doctorHasFail ||
    bgosHasCorroboratedFail ||
    mcpHasFail ||
    functionalBgosFailure
  const hasUnavailable =
    input.doctorCapture.failedToStart ||
    !input.doctor.recognized ||
    input.mcpCapture.failedToStart ||
    !input.mcpList.recognized ||
    input.bgosCapture.failedToStart ||
    !input.bgosDoctor.recognized
  const healthStatus: BrokenMcpCategory['health']['status'] = hasUnhealthyState
    ? 'unhealthy'
    : hasUnavailable
      ? 'unreachable'
      : 'healthy'
  const health: BrokenMcpCategory['health'] = {
    status: healthStatus,
    httpStatus: null,
    service:
      healthStatus === 'unhealthy' ? 'down' : healthStatus === 'healthy' ? 'up' : null,
    database: null,
  }
  const configOk = configCheck?.status === 'OK'
  const authOk = authCheck?.status === 'OK'
  const assistantsExposed =
    pairingCheck?.status === 'OK' &&
    !/\b0\s+assistants?\s+exposed\b/i.test(pairingCheck.detail)
  const commandAvailable = !input.promptCapture.failedToStart

  return {
    configPath: input.configPath,
    configStatus: input.config.status,
    serverName: configuredMcpNames[0] ?? null,
    bun: {
      found: commandAvailable,
      path: commandAvailable ? input.hermesExecutable : null,
    },
    serverEntry: {
      path: input.hermesExecutable,
      exists: commandAvailable,
    },
    requiredEnv: {
      BGOS_BACKEND_URL: configOk,
      BGOS_API_KEY: configOk,
      BGOS_USER_ID: authOk,
      BGOS_ASSISTANT_ID: assistantsExposed,
    },
    health,
    canonSource: 'unknown',
    authMode: configOk ? 'pairing' : 'missing',
    versionHeartbeat: 'unavailable',
    statusPatchActivity: 'unknown',
    findings,
  }
}

function diagnosticUnavailableFinding(input: {
  id: string
  label: string
  file: string
  exitCode: number
}): Finding {
  return makeFinding({
    id: input.id,
    category: 'broken-mcp',
    severity: 'warning',
    explanation: `${input.label} did not return recognizable read-only diagnostics.`,
    file: input.file,
    line: 1,
    classification: 'analyze-only',
    proposedChange: {
      kind: 'inspect-diagnostic-availability',
      operation: 'none',
      description: `Run ${input.label} from the same environment as the Hermes gateway.`,
      data: { diagnostic: input.label, exitCode: input.exitCode },
    },
    whySafe:
      'The analyzer reports unavailable evidence and does not substitute a mutating repair command.',
  })
}

function diagnosticProposedChange(
  source: string,
  check: DiagnosticCheck,
  operation: ProposedChange['operation'] = 'manual-action',
): ProposedChange {
  return {
    kind: 'review-diagnostic-fix',
    operation,
    description: check.fix || `Review the ${check.name} diagnostic with the owner.`,
    data: {
      source,
      check: check.name,
      status: check.status,
      fix: check.fix,
    },
  }
}

async function captureCommand(
  runCommand: (request: HermesCommandRequest) => Promise<HermesCommandResult>,
  request: HermesCommandRequest,
): Promise<CommandCapture> {
  try {
    const result = await runCommand(request)
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1,
      failedToStart: result.exitCode === 126 || result.exitCode === 127,
    }
  } catch {
    return { stdout: '', exitCode: 127, failedToStart: true }
  }
}

function parseConfig(read: TextRead): ParsedConfig {
  if (read.text === null) {
    return { status: 'missing', value: {} }
  }
  try {
    const parsed: unknown = Bun.YAML.parse(read.text)
    if (!isRecord(parsed)) return { status: 'malformed', value: {} }
    return { status: 'valid', value: parsed }
  } catch {
    return { status: 'malformed', value: {} }
  }
}

function parsePromptBreakdown(text: string): PromptBreakdown | null {
  const parsed = parseJsonObject(text)
  if (!parsed) return null
  const systemPrompt = requiredSizeObservation(parsed.system_prompt)
  const skillsIndex = requiredSizeObservation(parsed.skills_index)
  const memory = requiredSizeObservation(parsed.memory)
  const userProfile = requiredSizeObservation(parsed.user_profile)
  if (!systemPrompt || !skillsIndex || !memory || !userProfile) return null
  if (!isRecord(parsed.tools)) return null
  const toolCount = requiredNonNegativeNumber(parsed.tools.count)
  const toolSchemaBytes = requiredNonNegativeNumber(
    parsed.tools.json_bytes ?? parsed.tools.bytes,
  )
  if (
    toolCount === null ||
    !Number.isInteger(toolCount) ||
    toolSchemaBytes === null
  ) {
    return null
  }
  if (!Array.isArray(parsed.sections) && !isRecord(parsed.sections)) return null

  const sections = {
    stable: emptySize(),
    context: emptySize(),
    volatile: emptySize(),
  }
  const seenSections = { stable: false, context: false, volatile: false }
  let invalidSection = false
  if (Array.isArray(parsed.sections)) {
    for (const section of parsed.sections) {
      let label = ''
      let size: SizeObservation | null = null
      if (Array.isArray(section)) {
        label = typeof section[0] === 'string' ? section[0] : ''
        const chars = requiredNonNegativeNumber(section[1])
        const bytes = requiredNonNegativeNumber(section[2])
        if (chars !== null && bytes !== null) size = { chars, bytes }
      } else if (isRecord(section)) {
        label = firstString([
          valueString(section.id),
          valueString(section.name),
          valueString(section.label),
        ]) ?? ''
        size = requiredSizeObservation(section)
      }
      const normalized = label.toLowerCase()
      if (normalized.startsWith('stable')) {
        if (size) {
          sections.stable = size
          seenSections.stable = true
        } else {
          invalidSection = true
        }
      } else if (normalized.startsWith('context')) {
        if (size) {
          sections.context = size
          seenSections.context = true
        } else {
          invalidSection = true
        }
      } else if (normalized.startsWith('volatile')) {
        if (size) {
          sections.volatile = size
          seenSections.volatile = true
        } else {
          invalidSection = true
        }
      }
    }
  } else if (isRecord(parsed.sections)) {
    const stable = requiredSizeObservation(parsed.sections.stable)
    const context = requiredSizeObservation(parsed.sections.context)
    const volatile = requiredSizeObservation(parsed.sections.volatile)
    if (!stable || !context || !volatile) return null
    sections.stable = stable
    sections.context = context
    sections.volatile = volatile
    seenSections.stable = true
    seenSections.context = true
    seenSections.volatile = true
  }
  if (
    invalidSection ||
    !seenSections.stable ||
    !seenSections.context ||
    !seenSections.volatile
  ) {
    return null
  }

  const platformHint = platformHintObservation(parsed)
  return {
    raw: parsed,
    model: valueString(parsed.model),
    systemPrompt,
    skillsIndex,
    memory,
    userProfile,
    tools: {
      count: toolCount,
      jsonBytes: toolSchemaBytes,
    },
    sections,
    platformHint: platformHint.size,
    platformHintMeasured: platformHint.measured,
  }
}

function platformHintObservation(
  prompt: Record<string, unknown>,
): MeasuredSizeObservation {
  const containers = [prompt.platform_hints, prompt.platformHints]
  for (const container of containers) {
    if (!isRecord(container)) continue
    const bgos = container.bgos ?? container.BGOS
    const numeric = requiredNonNegativeNumber(bgos)
    if (numeric !== null) {
      return { size: { chars: numeric, bytes: numeric }, measured: true }
    }
    if (typeof bgos === 'string') {
      return {
        size: {
          chars: codePointLength(bgos),
          bytes: Buffer.byteLength(bgos, 'utf8'),
        },
        measured: true,
      }
    }
    const size = requiredSizeObservation(bgos)
    if (size) return { size, measured: true }
  }
  const chars = firstFiniteNumber([
    directNumber(prompt, 'platform_hints_bgos_chars'),
    directNumber(prompt, 'bgos_platform_hint_chars'),
  ])
  const bytes = firstFiniteNumber([
    directNumber(prompt, 'platform_hints_bgos_bytes'),
    directNumber(prompt, 'bgos_platform_hint_bytes'),
  ])
  if ((chars !== null && chars >= 0) || (bytes !== null && bytes >= 0)) {
    const normalizedChars = Math.max(0, chars ?? bytes ?? 0)
    return {
      size: {
        chars: normalizedChars,
        bytes: Math.max(0, bytes ?? normalizedChars),
      },
      measured: true,
    }
  }
  return { size: emptySize(), measured: false }
}

function parseDiagnostics(text: string): ParsedDiagnostics {
  const parsed = parseJsonObject(text)
  if (parsed) {
    const arrays = [parsed.checks, parsed.issues, parsed.results]
    for (const candidate of arrays) {
      if (!Array.isArray(candidate)) continue
      const checks = candidate
        .map(parseStructuredCheck)
        .filter((check): check is DiagnosticCheck => check !== null)
      return { recognized: checks.length > 0, checks }
    }
  }

  const clean = stripAnsi(text)
  const checks: DiagnosticCheck[] = []
  let last: DiagnosticCheck | null = null
  let inActionSummary = false
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^Found\s+\d+\s+issue\(s\)\s+to address:/i.test(line)) {
      inActionSummary = true
      last = null
      continue
    }
    if (inActionSummary) {
      const action = /^(\d+)\.\s+(.+)$/.exec(line)
      if (action) {
        const text = redactDiagnosticText(action[2] ?? '')
        const check: DiagnosticCheck = {
          name: `recommended action ${action[1]}`,
          status: 'WARN',
          detail: text,
          fix: text,
        }
        checks.push(check)
        last = check
        continue
      }
    }
    const fix = /^(?:fix\s*:|(?:-|=)>|→)\s*(.+)$/i.exec(line)
    if (fix && last) {
      last.fix = redactDiagnosticText(fix[1] ?? '')
      continue
    }
    const matched = matchDiagnosticLine(line)
    if (!matched) continue
    checks.push(matched)
    last = matched
  }
  return { recognized: checks.length > 0, checks }
}

function parseStructuredCheck(value: unknown): DiagnosticCheck | null {
  if (!isRecord(value)) return null
  const status = normalizeStatus(
    value.status ?? value.state ?? value.level ?? value.severity,
  )
  if (!status) return null
  const name =
    firstString([
      valueString(value.name),
      valueString(value.id),
      valueString(value.check),
      valueString(value.title),
    ]) ?? 'diagnostic'
  const detail =
    firstString([
      valueString(value.detail),
      valueString(value.message),
      valueString(value.description),
    ]) ?? name
  const fix =
    firstString([
      valueString(value.fix),
      valueString(value.recommendation),
      valueString(value.remediation),
      valueString(value.action),
    ]) ?? ''
  return {
    name: redactDiagnosticText(name),
    status,
    detail: redactDiagnosticText(detail),
    fix: redactDiagnosticText(fix),
  }
}

function matchDiagnosticLine(line: string): DiagnosticCheck | null {
  const patterns: Array<{
    status: DiagnosticCheck['status']
    pattern: RegExp
  }> = [
    { status: 'FAIL', pattern: /^(?:\[FAIL\]|FAIL\b|✗|x\s)\s*(.+)$/i },
    { status: 'WARN', pattern: /^(?:\[WARN(?:ING)?\]|WARN(?:ING)?\b|⚠|!\s)\s*(.+)$/i },
    { status: 'OK', pattern: /^(?:\[OK\]|OK\b|✓|✔)\s*(.+)$/i },
  ]
  for (const candidate of patterns) {
    const match = candidate.pattern.exec(line)
    if (!match) continue
    const body = redactDiagnosticText(match[1] ?? candidate.status)
    const colon = body.indexOf(':')
    const name = colon > 0 ? body.slice(0, colon).trim() : body
    const detail = colon > 0 ? body.slice(colon + 1).trim() : body
    return { name, status: candidate.status, detail, fix: '' }
  }
  return null
}

function normalizeStatus(value: unknown): DiagnosticCheck['status'] | null {
  if (typeof value !== 'string') return null
  const status = value.trim().toLowerCase()
  if (['ok', 'pass', 'passed', 'healthy', 'success'].includes(status)) return 'OK'
  if (['warn', 'warning', 'degraded', 'advisory'].includes(status)) return 'WARN'
  if (['fail', 'failed', 'error', 'unhealthy'].includes(status)) return 'FAIL'
  return null
}

function parseMcpList(text: string): McpListObservation {
  const parsed = parseJsonObject(text)
  if (parsed) {
    const rawServers = parsed.servers ?? parsed.mcp_servers
    if (Array.isArray(rawServers)) {
      const servers = rawServers
        .map((value) => {
          if (!isRecord(value)) return null
          const name = valueString(value.name)
          if (!name) return null
          const diagnostic = parseStructuredCheck(value)
          const enabled =
            typeof value.enabled === 'boolean'
              ? value.enabled
              : !/disabled|fail|error/i.test(valueString(value.status) ?? '')
          return {
            name: redactDiagnosticText(name),
            enabled,
            issue: diagnostic?.status === 'OK' ? null : diagnostic,
          }
        })
        .filter(
          (
            server,
          ): server is {
            name: string
            enabled: boolean
            issue: DiagnosticCheck | null
          } => server !== null,
        )
      return { recognized: true, servers }
    }
    if (isRecord(rawServers)) {
      const servers = Object.entries(rawServers).map(([name, config]) => {
        const diagnostic = parseStructuredCheck(config)
        return {
          name: redactDiagnosticText(name),
          enabled: !isRecord(config) || config.enabled !== false,
          issue: diagnostic?.status === 'OK' ? null : diagnostic,
        }
      })
      return { recognized: true, servers }
    }
  }

  const clean = stripAnsi(text)
  if (/\bNo MCP servers configured\./i.test(clean)) {
    return { recognized: true, servers: [] }
  }
  const servers: Array<{
    name: string
    enabled: boolean
    issue: DiagnosticCheck | null
  }> = []
  for (const line of clean.split(/\r?\n/)) {
    const match = /^\s*([^\s]+)\s+.+?\s+(?:✓|✗)?\s*(enabled|disabled)\s*$/i.exec(
      line,
    )
    if (!match || /^name$/i.test(match[1] ?? '')) continue
    servers.push({
      name: redactDiagnosticText(match[1]!),
      enabled: match[2]!.toLowerCase() === 'enabled',
      issue: null,
    })
  }
  return { recognized: servers.length > 0, servers }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const clean = stripAnsi(text).trim()
  if (!clean) return null
  try {
    const parsed: unknown = JSON.parse(clean)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function redactDiagnosticText(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(
      /\b(api[_-]?key|pairing[_-]?token|access[_-]?token|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi,
      '$1$2[redacted]',
    )
    .replace(
      /([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .trim()
}

function findCheck(
  checks: DiagnosticCheck[],
  name: string,
): DiagnosticCheck | undefined {
  return checks.find((check) => check.name.toLowerCase() === name.toLowerCase())
}

function severityForStatus(status: DiagnosticCheck['status']): FindingSeverity {
  return status === 'FAIL' ? 'error' : status === 'WARN' ? 'warning' : 'info'
}

function configValue(
  root: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = root
  for (const part of path) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function configString(
  root: Record<string, unknown>,
  path: readonly string[],
): string | null {
  return valueString(configValue(root, path))
}

function configNumber(
  root: Record<string, unknown>,
  path: readonly string[],
): number | null {
  return finiteNumber(configValue(root, path))
}

function configStringArray(
  root: Record<string, unknown>,
  path: readonly string[],
): string[] {
  const value = configValue(root, path)
  if (!Array.isArray(value)) return []
  return uniqueStrings(value)
}

function configObjectKeys(
  root: Record<string, unknown>,
  path: readonly string[],
): string[] {
  const value = configValue(root, path)
  return isRecord(value) ? Object.keys(value).sort() : []
}

function explicitStringArray(
  sources: Record<string, unknown>[],
  keys: readonly string[],
): string[] {
  for (const source of sources) {
    const value = findDeepValue(source, keys)
    if (Array.isArray(value)) return uniqueStrings(value)
  }
  return []
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort()
}

function findDeepNumber(
  sources: Record<string, unknown>[],
  keys: readonly string[],
): number | null {
  for (const source of sources) {
    const value = finiteNumber(findDeepValue(source, keys))
    if (value !== null) return value
  }
  return null
}

function findDeepString(
  sources: Record<string, unknown>[],
  keys: readonly string[],
): string | null {
  for (const source of sources) {
    const value = valueString(findDeepValue(source, keys))
    if (value !== null) return value
  }
  return null
}

function findDeepValue(
  root: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  const wanted = new Set(keys)
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  const seen = new Set<object>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth > 8 || current.value === null || typeof current.value !== 'object') {
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
    for (const value of values) queue.push({ value, depth: current.depth + 1 })
  }
  return undefined
}

function directNumber(record: Record<string, unknown>, key: string): number | null {
  return finiteNumber(record[key])
}

function valueString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  return clean || null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function nonNegativeNumber(value: unknown): number {
  const number = finiteNumber(value)
  return number === null ? 0 : Math.max(0, number)
}

function firstString(
  values: Array<string | null | undefined>,
): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function firstFiniteNumber(values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function firstPositiveNumber(values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return null
}

function boundedPercentage(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

function requiredSizeObservation(value: unknown): SizeObservation | null {
  if (!isRecord(value)) return null
  const chars = requiredNonNegativeNumber(value.chars ?? value.characters)
  const bytes = requiredNonNegativeNumber(value.bytes ?? value.json_bytes)
  if (chars === null || bytes === null) return null
  return { chars, bytes }
}

function requiredNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function emptySize(): SizeObservation {
  return { chars: 0, bytes: 0 }
}

function detectFrontmatter(
  text: string,
): InstructionFileReport['frontmatter'] {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return 'absent'
  return /\r?\n---(?:\r?\n|$)/.test(text.slice(3)) ? 'valid' : 'invalid'
}

async function loadProjectSurfaces(
  fs: HermesAnalyzerReadOnlyFs,
  agentRoot: string,
): Promise<ProjectSurface[]> {
  const gitRoot = await findGitRootReadOnly(fs, agentRoot)
  const hermesSearchDirs = gitRoot
    ? ancestorDirectories(agentRoot, gitRoot)
    : [agentRoot]
  let hermesSurface: ProjectSurface | null = null

  findHermesSurface: for (const directory of hermesSearchDirs) {
    for (const name of HERMES_PROJECT_NAMES) {
      const path = join(directory, name)
      const read = await readText(fs, path)
      if (read.error === 'missing') continue
      hermesSurface = { path, label: name, priority: 0, read }
      break findHermesSurface
    }
  }

  const localSurfaces = await Promise.all(
    LOCAL_PROJECT_SURFACES.map(async ([name, priority]) => ({
      path: join(agentRoot, name),
      label: name,
      priority,
      read: await readText(fs, join(agentRoot, name)),
    })),
  )
  return hermesSurface ? [hermesSurface, ...localSurfaces] : localSurfaces
}

async function findGitRootReadOnly(
  fs: HermesAnalyzerReadOnlyFs,
  agentRoot: string,
): Promise<string | null> {
  for (const directory of ancestorDirectories(agentRoot)) {
    const marker = await readText(fs, join(directory, '.git'))
    if (marker.error !== 'missing') return directory
  }
  return null
}

function ancestorDirectories(start: string, stopAt?: string): string[] {
  const result: string[] = []
  let current = normalize(resolve(start))
  const stop = stopAt ? normalize(resolve(stopAt)) : null
  while (true) {
    result.push(current)
    if (current === stop) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
}

async function readText(
  fs: HermesAnalyzerReadOnlyFs,
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

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null
  return typeof error.code === 'string' ? error.code : null
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

function budgetFromSize(path: string, size: SizeObservation): FileBudget {
  return {
    path,
    exists: size.chars > 0 || size.bytes > 0,
    chars: size.chars,
    utf8Bytes: size.bytes,
    lines: 0,
    estimatedTokens: estimateTokens(size.chars),
  }
}

function addBudgets(...budgets: FileBudget[]): Omit<FileBudget, 'path' | 'exists'> {
  const chars = budgets.reduce((total, budget) => total + budget.chars, 0)
  return {
    chars,
    utf8Bytes: budgets.reduce((total, budget) => total + budget.utf8Bytes, 0),
    lines: budgets.reduce((total, budget) => total + budget.lines, 0),
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

function lineOfYamlKey(text: string | null, key: string): number {
  if (!text) return 1
  const pattern = new RegExp(`^\\s*(?:["']?${escapeRegex(key)}["']?)\\s*:`, 'm')
  const match = pattern.exec(text)
  if (!match || match.index === undefined) return 1
  return text.slice(0, match.index).split('\n').length
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean || 'diagnostic'
}

function firstRecord(values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    if (isRecord(value)) return value
  }
  return null
}

function normalizeSoul(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\uFEFF/, '')
    .trim()
}

function isLegacySoul(text: string): boolean {
  const normalized = normalizeSoul(text)
  return HERMES_LEGACY_SOUL_TEMPLATES.some(
    (template) => normalizeSoul(template) === normalized,
  )
}

function codePointLength(text: string): number {
  return Array.from(text).length
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
    finding.id = `${base}:${ordinal}`
  }
}
