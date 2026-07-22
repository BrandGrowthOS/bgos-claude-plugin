/**
 * Claude Code agent analyzer for optimizer milestone 1.
 *
 * This module is read-only by construction. Its filesystem dependency exposes
 * read operations only, its process dependency can only locate an executable,
 * and its network dependency accepts GET requests only. Findings contain
 * proposed changes as data. There is no apply path in this module.
 */

import { execFile } from 'node:child_process'
import {
  access as nodeAccess,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  stat as nodeStat,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import {
  resolveAuth,
  type CredentialsFile,
  type ResolvedAuth,
} from '../agent-credentials.js'
import { resolveTmuxTarget } from '../compact-inject.js'
import {
  loadCursorFile,
  resolveCursorFilePath,
  type LoadedCursors,
} from '../cursor-store.js'
import {
  extractRestingSignal,
  RestingWatcher,
  type RestingSignal,
} from '../resting.js'
import {
  type Binding,
  SessionTranscriptBinder,
} from '../session-binding.js'
import {
  contextPctOfAssistantEntry,
  mungeCwd,
  windowForModel,
} from '../usage-report.js'
import { shouldSendVersionHeartbeat } from '../version-heartbeat.js'
import type {
  BrokenMcpCategory,
  ClaudeMdRulesCategory,
  ContextRotCategory,
  DeadReference,
  FileBudget,
  Finding,
  FindingCategory,
  FindingClassification,
  FindingsReport,
  FindingSeverity,
  InstructionFileReport,
  ProposedChange,
  RuleBlock,
  StartingContextCategory,
} from './types.js'

const LARGE_CLAUDE_MD_CHARS = 20_000
const HEALTH_TIMEOUT_MS = 5_000
const HEALTH_MAX_BYTES = 64 * 1024

export interface AnalyzerReadOnlyFs {
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{
    isFile(): boolean
    isDirectory(): boolean
  }>
  access(path: string): Promise<void>
}

export interface HttpGetRequest {
  url: string
  method: 'GET'
}

export interface HttpGetResponse {
  status: number
  body: unknown
}

export interface SessionInspection {
  binding: Binding | null
  transcriptPath?: string | null
  contextPct: number | null
  tail: string | null
  restingSignal: RestingSignal | null
}

export interface SessionInspectionRequest {
  agentRoot: string
  claudeHome: string
  env: Record<string, string | undefined>
  nowMs: number
}

export interface ClaudeAnalyzerDependencies {
  fs?: AnalyzerReadOnlyFs
  which?: (command: string) => Promise<string | null>
  httpGet?: (request: HttpGetRequest) => Promise<HttpGetResponse>
  inspectSession?: (request: SessionInspectionRequest) => Promise<SessionInspection>
  loadCursorFile?: (path: string) => LoadedCursors
  homeDir?: string
  tempDir?: string
}

export interface ClaudeAnalyzerOptions {
  agentRoot: string
  pluginRoot?: string
  claudeHome?: string
  mcpPath?: string
  memoryIndexPath?: string
  cursorFilePath?: string
  pluginLogPath?: string
  env?: Record<string, string | undefined>
  nowMs?: number
}

export interface TranscriptTailInspection {
  contextPct: number | null
  model: string | null
  nominalWindowTokens: number | null
  restingSignal: RestingSignal | null
}

export interface McpInstructionsExtraction {
  text: string
  line: number
  sourceChars: number
}

interface ParsedMcpServer {
  name: string
  command: string | null
  args: string[]
  env: Record<string, string | undefined>
  line: number
}

interface ParsedMcpConfig {
  status: 'valid' | 'missing' | 'malformed'
  server: ParsedMcpServer | null
}

interface FrontmatterResult {
  state: 'valid' | 'invalid' | 'absent'
  paths: string[]
}

interface StaticSourceToken {
  kind: 'identifier' | 'string' | 'punctuation' | 'other'
  value: string
  start: number
  end: number
}

interface ReferenceCandidate {
  reference: string
  file: string
  line: number
}

const defaultFs: AnalyzerReadOnlyFs = {
  readFile: async (path) => nodeReadFile(path, 'utf8'),
  readdir: async (path) => nodeReaddir(path),
  stat: async (path) => nodeStat(path),
  access: async (path) => nodeAccess(path),
}

const execFileAsync = promisify(execFile)

async function defaultWhich(command: string): Promise<string | null> {
  try {
    const result = await execFileAsync('which', [command], { encoding: 'utf8' })
    const output = String(result.stdout).trim()
    return output || null
  } catch {
    return null
  }
}

async function defaultHttpGet(request: HttpGetRequest): Promise<HttpGetResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  })
  const body = await readBoundedJson(response, HEALTH_MAX_BYTES)
  return { status: response.status, body }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('health response exceeds read limit')
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    total += result.value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('health response exceeds read limit')
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

async function defaultInspectSession(
  request: SessionInspectionRequest,
): Promise<SessionInspection> {
  const binder = new SessionTranscriptBinder(request.agentRoot, {
    claudeHome: request.claudeHome,
    envSessionId: request.env.CLAUDE_CODE_SESSION_ID ?? null,
  })
  const resolved = binder.resolve(request.nowMs)
  const tail = binder.readBoundTail()
  const contextPct = binder.readContextPct()

  const watcher = new RestingWatcher(request.agentRoot, request.claudeHome)
  const restingSignal = watcher.scan(request.nowMs)

  return {
    binding: resolved?.binding ?? null,
    transcriptPath: resolved?.path ?? null,
    contextPct,
    tail,
    restingSignal,
  }
}

/**
 * Inspect a transcript tail with the existing usage and resting classifiers.
 * Percentage arithmetic remains exclusively in contextPctOfAssistantEntry.
 */
export function inspectTranscriptTail(
  tail: string,
  nowMs: number = Date.now(),
): TranscriptTailInspection {
  let contextPct: number | null = null
  let model: string | null = null
  let nominalWindowTokens: number | null = null

  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]!.trim()
    if (!text) continue
    let entry: unknown
    try {
      entry = JSON.parse(text)
    } catch {
      continue
    }
    const pct = contextPctOfAssistantEntry(entry)
    if (pct === null) continue
    contextPct = pct
    if (entry !== null && typeof entry === 'object') {
      const message = (entry as { message?: unknown }).message
      if (message !== null && typeof message === 'object') {
        const rawModel = (message as { model?: unknown }).model
        if (typeof rawModel === 'string') {
          model = rawModel
          nominalWindowTokens = windowForModel(rawModel)
        }
      }
    }
    break
  }

  return {
    contextPct,
    model,
    nominalWindowTokens,
    restingSignal: extractRestingSignal(tail, nowMs),
  }
}

/**
 * Read the static MCP instructions expression without importing server.ts.
 * Importing server.ts would start the daemon and cross the read-only boundary.
 */
export function extractMcpInstructionsFromSource(
  source: string,
): McpInstructionsExtraction | null {
  for (const candidate of source.matchAll(/\binstructions\s*:\s*\[/g)) {
    const sourceOffset = candidate.index ?? 0
    const tokens = tokenizeStaticSource(source.slice(sourceOffset))
    for (let index = 0; index < tokens.length - 2; index += 1) {
      if (tokens[index]!.start > candidate[0].length) break
      if (
        tokens[index]!.kind !== 'identifier' ||
        tokens[index]!.value !== 'instructions' ||
        tokens[index + 1]!.value !== ':' ||
        tokens[index + 2]!.value !== '['
      ) {
        continue
      }
      const parsed = parseStaticJoinedArray(tokens, index + 2)
      if (!parsed) break
      return {
        text: parsed.parts.join(parsed.separator),
        line: lineAtIndex(source, sourceOffset + tokens[index]!.start),
        sourceChars: parsed.end - tokens[index + 2]!.start,
      }
    }
  }
  return null
}

function parseStaticJoinedArray(
  tokens: StaticSourceToken[],
  arrayStart: number,
): { parts: string[]; separator: string; end: number } | null {
  const parts: string[] = []
  let cursor = arrayStart + 1
  while (cursor < tokens.length && tokens[cursor]!.value !== ']') {
    const parsed = parseStaticStringConcat(tokens, cursor)
    if (!parsed) return null
    parts.push(parsed.value)
    cursor = parsed.next
    if (tokens[cursor]?.value === ',') {
      cursor += 1
      continue
    }
    if (tokens[cursor]?.value !== ']') return null
  }
  if (tokens[cursor]?.value !== ']') return null
  if (
    tokens[cursor + 1]?.value !== '.' ||
    tokens[cursor + 2]?.kind !== 'identifier' ||
    tokens[cursor + 2]?.value !== 'join' ||
    tokens[cursor + 3]?.value !== '('
  ) {
    return null
  }
  const separator = tokens[cursor + 4]
  if (!separator || separator.kind !== 'string') return null
  if (tokens[cursor + 5]?.value !== ')') return null
  return {
    parts,
    separator: separator.value,
    end: tokens[cursor + 5]!.end,
  }
}

function parseStaticStringConcat(
  tokens: StaticSourceToken[],
  start: number,
): { value: string; next: number } | null {
  const first = tokens[start]
  if (!first || first.kind !== 'string') return null
  let value = first.value
  let cursor = start + 1
  while (tokens[cursor]?.value === '+') {
    const next = tokens[cursor + 1]
    if (!next || next.kind !== 'string') return null
    value += next.value
    cursor += 2
  }
  return { value, next: cursor }
}

function tokenizeStaticSource(source: string): StaticSourceToken[] {
  const tokens: StaticSourceToken[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close < 0 ? source.length : close + 2
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index
      index += 1
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) {
        index += 1
      }
      tokens.push({
        kind: 'identifier',
        value: source.slice(start, index),
        start,
        end: index,
      })
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const parsed = readStaticString(source, index, char)
      if (parsed) {
        tokens.push({
          kind: 'string',
          value: parsed.value,
          start: index,
          end: parsed.end,
        })
        index = parsed.end
        continue
      }
    }
    const kind = ':[],.()+'.includes(char) ? 'punctuation' : 'other'
    tokens.push({ kind, value: char, start: index, end: index + 1 })
    index += 1
  }
  return tokens
}

function readStaticString(
  source: string,
  start: number,
  quote: string,
): { value: string; end: number } | null {
  let value = ''
  let index = start + 1
  while (index < source.length) {
    const char = source[index]!
    if (char === quote) return { value, end: index + 1 }
    if (quote === '`' && char === '$' && source[index + 1] === '{') return null
    if (char !== '\\') {
      if ((char === '\n' || char === '\r') && quote !== '`') return null
      value += char
      index += 1
      continue
    }
    index += 1
    if (index >= source.length) return null
    const escaped = source[index]!
    const simple: Record<string, string> = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '0': '\0',
      '\\': '\\',
      "'": "'",
      '"': '"',
      '`': '`',
    }
    if (escaped === '\n') {
      index += 1
      continue
    }
    if (escaped === '\r') {
      index += source[index + 1] === '\n' ? 2 : 1
      continue
    }
    if (escaped === 'x') {
      const raw = source.slice(index + 1, index + 3)
      if (!/^[0-9A-Fa-f]{2}$/.test(raw)) return null
      value += String.fromCharCode(Number.parseInt(raw, 16))
      index += 3
      continue
    }
    if (escaped === 'u') {
      if (source[index + 1] === '{') {
        const close = source.indexOf('}', index + 2)
        if (close < 0) return null
        const raw = source.slice(index + 2, close)
        if (!/^[0-9A-Fa-f]{1,6}$/.test(raw)) return null
        const codePoint = Number.parseInt(raw, 16)
        if (codePoint > 0x10ffff) return null
        value += String.fromCodePoint(codePoint)
        index = close + 1
        continue
      }
      const raw = source.slice(index + 1, index + 5)
      if (!/^[0-9A-Fa-f]{4}$/.test(raw)) return null
      value += String.fromCharCode(Number.parseInt(raw, 16))
      index += 5
      continue
    }
    if (escaped === '0' && /[0-9]/.test(source[index + 1] ?? '')) return null
    value += simple[escaped] ?? escaped
    index += 1
  }
  return null
}

export async function analyzeClaudeCodeAgent(
  options: ClaudeAnalyzerOptions,
  dependencies: ClaudeAnalyzerDependencies = {},
): Promise<FindingsReport> {
  const fs = dependencies.fs ?? defaultFs
  const which = dependencies.which ?? defaultWhich
  const httpGet = dependencies.httpGet ?? defaultHttpGet
  const inspectSession = dependencies.inspectSession ?? defaultInspectSession
  const cursorLoader = dependencies.loadCursorFile ?? loadCursorFile
  const homeDir = dependencies.homeDir ?? homedir()
  const tempDir = dependencies.tempDir ?? tmpdir()
  const nowMs = options.nowMs ?? Date.now()
  const agentRoot = normalize(resolve(options.agentRoot))
  const mcpPath = options.mcpPath ?? join(agentRoot, '.mcp.json')
  const claudePath = join(agentRoot, 'CLAUDE.md')
  const claudeHome = options.claudeHome ?? join(homeDir, '.claude')

  const mcpRead = await readText(fs, mcpPath)
  const parsedMcp = parseMcpConfig(mcpRead.text, mcpRead.error)
  const mcpEnv = parsedMcp.server?.env ?? {}
  const credentialsPath = join(homeDir, '.bgos-agent', 'credentials.json')
  const credentialsRead = await readText(fs, credentialsPath)
  const auth = resolveAnalyzerAuth(mcpEnv, parseCredentials(credentialsRead.text))
  const runtimeEnv = options.env ?? process.env
  const envValue = (key: string): string | undefined =>
    mcpEnv[key] ?? runtimeEnv[key]
  const sessionEnv = {
    CLAUDE_CODE_SESSION_ID: envValue('CLAUDE_CODE_SESSION_ID'),
  }
  const tmuxEnv = {
    BGOS_REMOTE_COMPACT: envValue('BGOS_REMOTE_COMPACT'),
    BGOS_TMUX_SESSION: envValue('BGOS_TMUX_SESSION'),
    BGOS_TMUX_SOCKET: envValue('BGOS_TMUX_SOCKET'),
    TMUX: envValue('TMUX'),
    TMUX_PANE: envValue('TMUX_PANE'),
  }
  const cursorEnv = {
    BGOS_PLUGIN_STATE_DIR: envValue('BGOS_PLUGIN_STATE_DIR'),
  }

  const configuredServerPath = resolveServerPath(parsedMcp.server?.args ?? [], agentRoot)
  const explicitPluginRoot = options.pluginRoot
    ? normalize(resolve(options.pluginRoot))
    : null
  const pluginRoot = explicitPluginRoot
    ? explicitPluginRoot
    : configuredServerPath
      ? dirname(configuredServerPath)
      : null
  const analyzedServerPath = explicitPluginRoot
    ? join(explicitPluginRoot, 'server.ts')
    : configuredServerPath
  const serverSourceRead = analyzedServerPath
    ? await readText(fs, analyzedServerPath)
    : { text: null, error: 'missing' as const }
  const mcpInstructions = serverSourceRead.text
    ? extractMcpInstructionsFromSource(serverSourceRead.text)
    : null

  const assistantId = cleanValue(auth.assistantId) || 'unknown'
  const pluginLogPath =
    options.pluginLogPath ??
    cleanValue(envValue('BGOS_LOG_FILE')) ??
    join(tempDir, `bgos-plugin-${assistantId}.log`)
  const pluginLogRead = await readText(fs, pluginLogPath)
  const canonSource = detectCanonSource(pluginLogRead.text)

  const memoryIndexPath =
    options.memoryIndexPath ??
    join(claudeHome, 'projects', mungeCwd(agentRoot), 'memory', 'MEMORY.md')
  const cursorFilePath =
    options.cursorFilePath ??
    resolveCursorFilePath({
      assistantId: cleanValue(auth.assistantId),
      cwd: agentRoot,
      env: cursorEnv,
      home: homeDir,
    })

  const [claudeRead, memoryRead, cursorInspection, session] = await Promise.all([
    readText(fs, claudePath),
    readText(fs, memoryIndexPath),
    inspectCursorStore(fs, cursorFilePath, cursorLoader),
    inspectSession({ agentRoot, claudeHome, env: sessionEnv, nowMs }).catch(
      (): SessionInspection => ({
        binding: null,
        transcriptPath: null,
        contextPct: null,
        tail: null,
        restingSignal: null,
      }),
    ),
  ])

  const tailInspection = session.tail
    ? inspectTranscriptTail(session.tail, nowMs)
    : {
        contextPct: null,
        model: null,
        nominalWindowTokens: null,
        restingSignal: null,
      }
  const effectiveSession: SessionInspection = {
    ...session,
    contextPct: session.contextPct ?? tailInspection.contextPct,
    restingSignal: session.restingSignal ?? tailInspection.restingSignal,
  }

  const contextRot = analyzeContextRot({
    agentRoot,
    session: effectiveSession,
    model: tailInspection.model,
    nominalWindowTokens: tailInspection.nominalWindowTokens,
    env: tmuxEnv,
  })
  const startingContext = analyzeStartingContext({
    agentRoot,
    claudePath,
    claudeText: claudeRead.text,
    memoryIndexPath,
    memoryText: memoryRead.text,
    serverPath: analyzedServerPath,
    instructions: mcpInstructions,
    canonSource,
    cursorInspection,
    pluginLogPath,
  })
  const claudeMdRules = await analyzeClaudeMdAndRules({
    fs,
    agentRoot,
    claudePath,
    claudeText: claudeRead.text,
  })
  const brokenMcp = await analyzeBrokenMcp({
    fs,
    which,
    httpGet,
    mcpPath,
    mcpText: mcpRead.text,
    parsedMcp,
    auth,
    configuredServerPath,
    pluginRoot,
    pluginLogText: pluginLogRead.text,
    canonSource,
  })

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
    agent: { kind: 'claude-code', root: agentRoot },
    categories: {
      contextRot,
      startingContext,
      claudeMdRules,
      brokenMcp,
    },
    findings,
    summary: summarize(findings),
  }
}

function analyzeContextRot(input: {
  agentRoot: string
  session: SessionInspection
  model: string | null
  nominalWindowTokens: number | null
  env: Record<string, string | undefined>
}): ContextRotCategory {
  const findings: Finding[] = []
  const tmux = resolveTmuxTarget(input.env)
  const binding = input.session.binding
    ? {
        file: input.session.binding.name,
        source: input.session.binding.source,
        verified: input.session.binding.source !== 'newest-mtime',
      }
    : null
  const location = input.session.transcriptPath ?? join(input.agentRoot, 'CLAUDE.md')

  if (binding?.source === 'newest-mtime') {
    findings.push(
      makeFinding({
        id: 'context-binding-unverified',
        category: 'context-rot',
        severity: 'warning',
        explanation:
          'The transcript binding uses newest-mtime and is unverified until a positive session signal is observed.',
        file: location,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'await-positive-session-binding',
          operation: 'none',
          description: 'Wait for marker or session-id evidence before trusting the reading.',
          data: { currentSource: 'newest-mtime' },
        },
        whySafe:
          'The analyzer labels uncertainty only. It does not rebind, clear, or mutate the live session.',
      }),
    )
  }

  let resting: ContextRotCategory['resting'] = {
    state: 'not-detected',
    resetAt: null,
  }
  if (input.session.restingSignal?.type === 'limit') {
    resting = {
      state: 'resting',
      resetAt: input.session.restingSignal.resetAt,
    }
    findings.push(
      makeFinding({
        id: 'agent-resting',
        category: 'context-rot',
        severity: 'info',
        explanation:
          'A genuine usage or session cap was detected. Resting is an expected availability state, not a defect.',
        file: location,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-resting-state',
          operation: 'none',
          description: 'Keep the resting state visible until its reset horizon or new activity.',
          data: { resetAt: input.session.restingSignal.resetAt },
        },
        whySafe:
          'No repair is proposed and no status is changed. The finding prevents a healthy resting state from being misdiagnosed.',
      }),
    )
  } else if (input.session.restingSignal?.type === 'activity') {
    resting = { state: 'activity', resetAt: null }
  }

  const pct = input.session.contextPct
  if (pct !== null && pct >= 80) {
    findings.push(
      makeFinding({
        id: 'context-high',
        category: 'context-rot',
        severity: 'warning',
        explanation: `The bound transcript reports ${Math.round(pct)} percent context use.`,
        file: location,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'user-controlled-compaction-review',
          operation: 'none',
          description: 'Let the user decide whether and when to compact or start a new session.',
          data: { contextPct: pct, tmuxAvailable: tmux !== null },
        },
        whySafe:
          'The analyzer never sends compact or clear commands and never changes live-session state.',
      }),
    )
  }

  return {
    contextPct: pct,
    model: input.model,
    nominalWindowTokens: input.nominalWindowTokens,
    binding,
    tmuxCompaction: {
      available: tmux !== null,
      source: tmux?.source ?? null,
    },
    resting,
    findings,
  }
}

function analyzeStartingContext(input: {
  agentRoot: string
  claudePath: string
  claudeText: string | null
  memoryIndexPath: string
  memoryText: string | null
  serverPath: string | null
  instructions: McpInstructionsExtraction | null
  canonSource: 'backend' | 'bundled' | 'unknown'
  cursorInspection: StartingContextCategory['cursorStore']
  pluginLogPath: string
}): StartingContextCategory {
  const findings: Finding[] = []
  const claudeMd = budgetFor(input.claudePath, input.claudeText)
  const memoryIndex = budgetFor(input.memoryIndexPath, input.memoryText)
  const instructionsPath = input.serverPath ?? join(input.agentRoot, '.mcp.json')
  const mcpInstructions = budgetFor(
    instructionsPath,
    input.instructions?.text ?? null,
  )
  const total = addBudgets(claudeMd, mcpInstructions, memoryIndex)
  const doubleLoad =
    input.canonSource === 'backend' &&
    mcpInstructions.exists &&
    containsBundledCapabilitySummary(input.instructions?.text ?? '')

  if (doubleLoad) {
    findings.push(
      makeFinding({
        id: 'canon-summary-double-load',
        category: 'starting-context',
        severity: 'warning',
        explanation:
          'The served backend canon is available while the bundled MCP summary is also loaded into every session.',
        file: instructionsPath,
        line: input.instructions?.line ?? 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'slim-mcp-offline-fallback',
          operation: 'edit-file',
          description:
            'Review a smaller fallback summary while preserving enough offline capability guidance.',
          data: {
            currentRenderedChars: mcpInstructions.chars,
            preserveOfflineFallback: true,
          },
        },
        whySafe:
          'This is report data only. Any later edit requires approval and must preserve the offline fallback.',
      }),
    )
  }

  if (input.canonSource === 'bundled') {
    findings.push(
      makeFinding({
        id: 'canon-bundled-fallback',
        category: 'starting-context',
        severity: 'info',
        explanation:
          'The plugin logged its bundled canon fallback. This is graceful degradation and does not hard-fail MCP.',
        file: input.pluginLogPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'observe-canon-fallback',
          operation: 'none',
          description: 'Correlate the fallback with the read-only backend health result.',
          data: { canonSource: 'bundled' },
        },
        whySafe:
          'The analyzer neither replaces the fallback nor restarts the daemon.',
      }),
    )
  }

  if (!claudeMd.exists) {
    findings.push(
      missingAlwaysOnFinding('CLAUDE.md', input.claudePath, 'starting-context'),
    )
  }
  if (!memoryIndex.exists) {
    findings.push(
      makeFinding({
        id: 'memory-index-unreadable',
        category: 'starting-context',
        severity: 'info',
        explanation: 'The user memory index is absent or unreadable, so it contributes no measured starting context.',
        file: input.memoryIndexPath,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-memory-index',
          operation: 'none',
          description: 'Review memory availability without creating or rewriting the index.',
          data: {},
        },
        whySafe: 'No memory file is created, changed, or deleted.',
      }),
    )
  }
  if (!mcpInstructions.exists) {
    findings.push(
      makeFinding({
        id: 'mcp-instructions-unreadable',
        category: 'starting-context',
        severity: 'warning',
        explanation: 'The static MCP instructions block could not be measured from the configured server entry.',
        file: instructionsPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'inspect-mcp-instructions-source',
          operation: 'manual-action',
          description: 'Confirm that the configured server entry contains a static instructions block.',
          data: {},
        },
        whySafe: 'The analyzer reports the missing measurement and does not alter server code.',
      }),
    )
  }

  if (input.cursorInspection.status !== 'readable') {
    findings.push(
      makeFinding({
        id: 'cursor-store-not-readable',
        category: 'starting-context',
        severity: input.cursorInspection.status === 'missing' ? 'warning' : 'error',
        explanation:
          `The cursor store is ${input.cursorInspection.status}. Missing or corrupt state can affect first-poll backlog handling.`,
        file: input.cursorInspection.path,
        line: 1,
        classification: 'analyze-only',
        proposedChange: {
          kind: 'inspect-cursor-store',
          operation: 'none',
          description: 'Inspect cursor ownership and recovery options without rewriting or deleting the store.',
          data: { status: input.cursorInspection.status },
        },
        whySafe:
          'The cursor store is read only. The analyzer never creates, repairs, truncates, or deletes it.',
      }),
    )
  }

  return {
    budget: {
      claudeMd,
      mcpInstructions,
      memoryIndex,
      total,
    },
    mcpInstructionsSourceChars: input.instructions?.sourceChars ?? 0,
    canonSource: input.canonSource,
    canonSummaryDoubleLoad: doubleLoad,
    cursorStore: input.cursorInspection,
    findings,
  }
}

async function analyzeClaudeMdAndRules(input: {
  fs: AnalyzerReadOnlyFs
  agentRoot: string
  claudePath: string
  claudeText: string | null
}): Promise<ClaudeMdRulesCategory> {
  const files: InstructionFileReport[] = []
  const findings: Finding[] = []
  const deadReferences: DeadReference[] = []
  const ruleBlocks: RuleBlock[] = []
  const basenameIndexes = new Map<string, Promise<Map<string, string>>>()

  if (input.claudeText !== null) {
    files.push({
      ...budgetFor(input.claudePath, input.claudeText),
      kind: 'claude-md',
      frontmatter: 'not-applicable',
    })
  } else {
    files.push({
      ...budgetFor(input.claudePath, null),
      kind: 'claude-md',
      frontmatter: 'not-applicable',
    })
    findings.push(missingAlwaysOnFinding('CLAUDE.md', input.claudePath, 'claude-md-rules'))
  }

  const rulesDir = join(input.agentRoot, '.claude', 'rules')
  let ruleNames: string[] = []
  try {
    ruleNames = (await input.fs.readdir(rulesDir)).filter((name) => name.endsWith('.md'))
  } catch {
    ruleNames = []
  }

  const sources: Array<{
    file: string
    text: string
    kind: 'claude-md' | 'rule'
    scopePaths: string[]
  }> = []
  if (input.claudeText !== null) {
    sources.push({
      file: input.claudePath,
      text: input.claudeText,
      kind: 'claude-md',
      scopePaths: [],
    })
  }

  for (const name of ruleNames) {
    const path = join(rulesDir, name)
    const read = await readText(input.fs, path)
    const frontmatter = parseRulesFrontmatter(read.text ?? '')
    files.push({
      ...budgetFor(path, read.text),
      kind: 'rule',
      frontmatter: frontmatter.state,
    })
    if (read.text === null) continue
    sources.push({
      file: path,
      text: read.text,
      kind: 'rule',
      scopePaths: frontmatter.paths,
    })
    if (frontmatter.state === 'invalid') {
      findings.push(
        makeFinding({
          id: 'invalid-rules-frontmatter',
          category: 'claude-md-rules',
          severity: 'error',
          explanation: 'The scoped rule does not have a valid paths frontmatter block.',
          file: path,
          line: 1,
          classification: 'auto-apply',
          proposedChange: {
            kind: 'repair-frontmatter-parse',
            operation: 'edit-file',
            description: 'Repair only the unambiguous frontmatter parse structure.',
            data: { requiredKey: 'paths' },
          },
          whySafe:
            'Milestone 1 only records the parse repair. A later apply must snapshot, validate, and revert on failure.',
        }),
      )
    }
  }

  for (const source of sources) {
    const blocks = findRuleBlocks(source.text, source.file)
    ruleBlocks.push(...blocks)
    for (const block of blocks) {
      findings.push(
        makeFinding({
          id: 'protected-rule-block',
          category: 'claude-md-rules',
          severity: 'info',
          explanation: `Behavioral RULE block detected: ${block.heading}`,
          file: block.file,
          line: block.line,
          classification: 'analyze-only',
          proposedChange: {
            kind: 'preserve-rule-block',
            operation: 'none',
            description: 'Keep this behavioral contract out of all automatic edits.',
            data: { heading: block.heading },
          },
          whySafe:
            'The block is explicitly marked analyze-only and no edit payload is executable.',
        }),
      )
    }

    const candidates = extractPathReferences(source.text, source.file)
    for (const candidate of candidates) {
      const resolution = await resolveReference(
        input.fs,
        input.agentRoot,
        candidate.reference,
        source.kind === 'rule' ? source.scopePaths : [],
        basenameIndexes,
      )
      if (resolution.exists) continue
      const dead: DeadReference = {
        reference: candidate.reference,
        resolvedPath: resolution.reportPath,
        file: candidate.file,
        line: candidate.line,
      }
      deadReferences.push(dead)
      const insideRuleBlock = blocks.some(
        (block) => candidate.line >= block.line && candidate.line <= block.endLine,
      )
      findings.push(
        makeFinding({
          id: 'dead-reference',
          category: 'claude-md-rules',
          severity: 'warning',
          explanation: `Referenced project path does not exist: ${candidate.reference}`,
          file: candidate.file,
          line: candidate.line,
          classification: insideRuleBlock ? 'analyze-only' : 'needs-approval',
          proposedChange: {
            kind: insideRuleBlock
              ? 'review-protected-missing-reference'
              : 'review-missing-reference',
            operation: insideRuleBlock ? 'none' : 'manual-action',
            description: insideRuleBlock
              ? 'Keep the RULE block unchanged and review the reference as intent only.'
              : 'Confirm whether the path is stale, misspelled, or aspirational before editing.',
            data: {
              reference: candidate.reference,
              resolvedPath: resolution.reportPath,
            },
          },
          whySafe: insideRuleBlock
            ? 'The missing reference is inside a behavioral RULE block, so the finding cannot be applied or edited automatically.'
            : 'A missing path is not auto-removed because it may describe planned work or an external prerequisite.',
        }),
      )
    }
  }

  const claudeBudget = files.find((file) => file.kind === 'claude-md')
  if (claudeBudget && claudeBudget.chars >= LARGE_CLAUDE_MD_CHARS) {
    findings.push(
      makeFinding({
        id: 'claude-md-large',
        category: 'claude-md-rules',
        severity: 'warning',
        explanation: `CLAUDE.md is ${claudeBudget.chars} characters and loads in every session.`,
        file: claudeBudget.path,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'relocate-nonessential-sections',
          operation: 'edit-file',
          description: 'Review nonessential runbook material for a move to on-demand documentation.',
          data: { preserveRuleBlocks: true, preserveScopedRules: true },
        },
        whySafe:
          'No section is selected or moved automatically. RULE blocks and path-scoped rules stay protected.',
      }),
    )
  }

  return { files, deadReferences, ruleBlocks, findings }
}

async function analyzeBrokenMcp(input: {
  fs: AnalyzerReadOnlyFs
  which: (command: string) => Promise<string | null>
  httpGet: (request: HttpGetRequest) => Promise<HttpGetResponse>
  mcpPath: string
  mcpText: string | null
  parsedMcp: ParsedMcpConfig
  auth: ResolvedAuth
  configuredServerPath: string | null
  pluginRoot: string | null
  pluginLogText: string | null
  canonSource: 'backend' | 'bundled' | 'unknown'
}): Promise<BrokenMcpCategory> {
  const findings: Finding[] = []
  let bunPath: string | null = null
  try {
    bunPath = await input.which('bun')
  } catch {
    bunPath = null
  }
  const serverExists = input.configuredServerPath
    ? await pathExists(input.fs, input.configuredServerPath)
    : false

  if (input.parsedMcp.status === 'missing') {
    findings.push(
      makeFinding({
        id: 'missing-mcp-config',
        category: 'broken-mcp',
        severity: 'error',
        explanation: 'The agent has no readable .mcp.json configuration.',
        file: input.mcpPath,
        line: 1,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-mcp-configuration',
          operation: 'manual-action',
          description: 'Confirm the intended MCP server and identities before creating configuration.',
          data: {},
        },
        whySafe: 'The analyzer does not create a config or infer user and assistant identities.',
      }),
    )
  } else if (input.parsedMcp.status === 'malformed') {
    findings.push(
      makeFinding({
        id: 'malformed-mcp-json',
        category: 'broken-mcp',
        severity: 'error',
        explanation: '.mcp.json is not valid JSON.',
        file: input.mcpPath,
        line: 1,
        classification: 'auto-apply',
        proposedChange: {
          kind: 'repair-json-parse',
          operation: 'edit-file',
          description: 'Repair only the unambiguous JSON syntax error.',
          data: {},
        },
        whySafe:
          'Milestone 1 does not write. A later apply must snapshot the file and validate MCP boot before keeping a repair.',
      }),
    )
  } else if (!input.parsedMcp.server) {
    findings.push(
      makeFinding({
        id: 'bgos-mcp-server-missing',
        category: 'broken-mcp',
        severity: 'error',
        explanation: '.mcp.json is valid JSON but has no bgos server entry.',
        file: input.mcpPath,
        line: lineOf(input.mcpText, 'mcpServers'),
        classification: 'analyze-only',
        proposedChange: {
          kind: 'review-new-mcp-capability',
          operation: 'none',
          description: 'Decide whether adding a BGOS server matches the agent owner intent.',
          data: {},
        },
        whySafe: 'Adding a server changes capabilities, so this remains analyze-only.',
      }),
    )
  }

  if (!bunPath) {
    findings.push(
      makeFinding({
        id: 'bun-not-found',
        category: 'broken-mcp',
        severity: 'error',
        explanation: 'The bun executable was not found on PATH, so the configured MCP command cannot start.',
        file: input.mcpPath,
        line: lineOf(input.mcpText, 'command'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'fix-mcp-command-path',
          operation: 'edit-file',
          description: 'Review an absolute bun path or host installation with the owner.',
          data: { command: 'bun' },
        },
        whySafe: 'No command path is guessed or rewritten automatically.',
      }),
    )
  }

  if (input.parsedMcp.server?.command && input.parsedMcp.server.command !== 'bun') {
    findings.push(
      makeFinding({
        id: 'unexpected-mcp-command',
        category: 'broken-mcp',
        severity: 'warning',
        explanation: 'The bgos MCP server command is not bun.',
        file: input.mcpPath,
        line: lineOf(input.mcpText, 'command'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-mcp-command-path',
          operation: 'manual-action',
          description: 'Confirm the configured launcher before changing it.',
          data: { expectedCommand: 'bun' },
        },
        whySafe: 'The configured launcher is reported without execution or rewrite.',
      }),
    )
  }

  if (input.parsedMcp.server && !input.parsedMcp.server.command) {
    findings.push(
      makeFinding({
        id: 'mcp-command-missing',
        category: 'broken-mcp',
        severity: 'error',
        explanation: 'The bgos MCP server entry has no command and cannot start.',
        file: input.mcpPath,
        line: input.parsedMcp.server.line,
        classification: 'needs-approval',
        proposedChange: {
          kind: 'fix-mcp-command-path',
          operation: 'edit-file',
          description: 'Confirm the intended launcher before adding a command.',
          data: { expectedCommand: 'bun' },
        },
        whySafe: 'The analyzer reports the missing launcher and does not guess or write it.',
      }),
    )
  }

  if (!input.configuredServerPath || !serverExists) {
    findings.push(
      makeFinding({
        id: 'mcp-server-entry-missing',
        category: 'broken-mcp',
        severity: 'error',
        explanation: 'The configured BGOS server.ts entry does not exist.',
        file: input.mcpPath,
        line: lineOf(input.mcpText, 'args'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'fix-mcp-command-path',
          operation: 'edit-file',
          description: 'Confirm the intended plugin checkout before changing the server path.',
          data: { configuredPath: input.configuredServerPath },
        },
        whySafe: 'The analyzer never rewrites .mcp.json or selects another checkout on its own.',
      }),
    )
  }

  const auth = input.auth
  const requiredEnv = {
    BGOS_BACKEND_URL: isValidBackendUrl(auth.backendUrl),
    BGOS_API_KEY: auth.mode === 'apikey' && isConfiguredValue(auth.apiKey),
    BGOS_USER_ID: isConfiguredValue(auth.userId),
    BGOS_ASSISTANT_ID: isConfiguredValue(auth.assistantId),
  }
  const missingEnv: string[] = [
    'BGOS_BACKEND_URL',
    'BGOS_USER_ID',
    'BGOS_ASSISTANT_ID',
  ].filter((key) => !requiredEnv[key as keyof typeof requiredEnv])
  if (auth.mode === 'pairing') {
    if (!isConfiguredValue(auth.pairingToken)) {
      missingEnv.push('BGOS_PAIRING_TOKEN')
    }
  } else if (!requiredEnv.BGOS_API_KEY) {
    missingEnv.push('BGOS_API_KEY')
  }
  if (missingEnv.length > 0) {
    findings.push(
      makeFinding({
        id: 'missing-required-mcp-env',
        category: 'broken-mcp',
        severity: 'error',
        explanation: `Required MCP environment fields are missing, invalid, or placeholders: ${missingEnv.join(', ')}.`,
        file: input.mcpPath,
        line: lineOf(input.mcpText, missingEnv[0] ?? 'env'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'review-mcp-identity-env',
          operation: 'edit-file',
          description: 'Ask the owner to confirm every identity and credential field before editing.',
          data: { missingKeys: [...missingEnv] },
        },
        whySafe:
          'No secret value is included in the report and no identity is inferred or rewritten.',
      }),
    )
  }

  const authMode: BrokenMcpCategory['authMode'] =
    auth.source === 'none' ? 'missing' : auth.mode
  const packageVersion = input.pluginRoot
    ? await readPackageVersion(input.fs, join(input.pluginRoot, 'package.json'))
    : null
  const versionHeartbeat: BrokenMcpCategory['versionHeartbeat'] =
    authMode === 'missing'
      ? 'unavailable'
      : shouldSendVersionHeartbeat(auth.mode, packageVersion)
        ? 'enabled'
        : auth.mode === 'apikey'
          ? 'suppressed'
          : 'unavailable'

  if (authMode === 'apikey') {
    findings.push(
      makeFinding({
        id: 'apikey-version-heartbeat-suppressed',
        category: 'broken-mcp',
        severity: 'warning',
        explanation:
          'X-API-Key authentication suppresses the pairing-only version heartbeat, so stale plugin detection is unavailable.',
        file: input.mcpPath,
        line: lineOf(input.mcpText, 'BGOS_API_KEY'),
        classification: 'analyze-only',
        proposedChange: {
          kind: 'manual-plugin-freshness-check',
          operation: 'none',
          description: 'Review plugin freshness without changing auth or restarting the daemon.',
          data: { heartbeat: 'suppressed' },
        },
        whySafe:
          'The API key is never printed or transmitted by this finding, and authentication is not changed.',
      }),
    )
  }

  const health = await probeHealth(input.httpGet, auth.backendUrl)
  if (health.status === 'unhealthy' || health.status === 'unreachable') {
    findings.push(
      makeFinding({
        id: 'backend-health-failing',
        category: 'broken-mcp',
        severity: 'error',
        explanation:
          health.status === 'unreachable'
            ? 'The read-only backend health GET was unreachable.'
            : `Backend health is not fully up (service=${health.service ?? 'unknown'}, database=${health.database ?? 'unknown'}).`,
        file: input.mcpPath,
        line: lineOf(input.mcpText, 'BGOS_BACKEND_URL'),
        classification: 'needs-approval',
        proposedChange: {
          kind: 'investigate-backend-health',
          operation: 'manual-action',
          description: 'Investigate reachability before considering any MCP server change.',
          data: {
            healthStatus: health.status,
            httpStatus: health.httpStatus,
            service: health.service,
            database: health.database,
          },
        },
        whySafe:
          'The probe uses GET without credentials, and the analyzer neither disables MCP nor mutates the daemon.',
      }),
    )
  }

  const statusPatchActivity: BrokenMcpCategory['statusPatchActivity'] =
    input.pluginLogText === null
      ? 'unknown'
      : /Resting self-report sent|PATCH[^\n]*assistants\/[^\n]*\/status|Status set/i.test(
            input.pluginLogText,
          )
        ? 'observed'
        : 'not-observed'

  return {
    configPath: input.mcpPath,
    configStatus: input.parsedMcp.status,
    serverName: input.parsedMcp.server?.name ?? null,
    bun: { found: bunPath !== null, path: bunPath },
    serverEntry: {
      path: input.configuredServerPath,
      exists: serverExists,
    },
    requiredEnv,
    health,
    canonSource: input.canonSource,
    authMode,
    versionHeartbeat,
    statusPatchActivity,
    findings,
  }
}

function parseMcpConfig(
  text: string | null,
  _readError: 'missing' | 'unreadable' | null,
): ParsedMcpConfig {
  if (text === null) {
    return { status: 'missing', server: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { status: 'malformed', server: null }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'malformed', server: null }
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return { status: 'valid', server: null }
  }
  const raw = (servers as Record<string, unknown>).bgos
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'valid', server: null }
  }
  const record = raw as Record<string, unknown>
  const rawArgs = Array.isArray(record.args) ? record.args : []
  const rawEnv =
    record.env !== null && typeof record.env === 'object' && !Array.isArray(record.env)
      ? (record.env as Record<string, unknown>)
      : {}
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string') env[key] = value
  }
  return {
    status: 'valid',
    server: {
      name: 'bgos',
      command: typeof record.command === 'string' ? record.command : null,
      args: rawArgs.filter((value): value is string => typeof value === 'string'),
      env,
      line: lineOf(text, 'bgos'),
    },
  }
}

function parseCredentials(text: string | null): CredentialsFile | null {
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as CredentialsFile)
      : null
  } catch {
    return null
  }
}

function resolveAnalyzerAuth(
  env: Record<string, string | undefined>,
  credentials: CredentialsFile | null,
): ResolvedAuth {
  const sanitizedCredentials: CredentialsFile | null = credentials
    ? {
        ...credentials,
        backendUrl: configuredString(credentials.backendUrl),
        pairingToken: configuredString(credentials.pairingToken),
        userId: configuredString(credentials.userId),
        assistantId: configuredString(credentials.assistantId),
      }
    : null
  return resolveAuth({
    env: {
      ...env,
      BGOS_BACKEND_URL: configuredString(env.BGOS_BACKEND_URL),
      BGOS_API_KEY: configuredString(env.BGOS_API_KEY),
      BGOS_USER_ID: configuredString(env.BGOS_USER_ID),
      BGOS_ASSISTANT_ID: configuredString(env.BGOS_ASSISTANT_ID),
      BGOS_PAIRING_TOKEN: configuredString(env.BGOS_PAIRING_TOKEN),
    },
    creds: sanitizedCredentials,
  })
}

function resolveServerPath(
  args: string[],
  agentRoot: string,
): string | null {
  const candidate = args.find((arg) => /(?:^|[\\/])server\.tsx?$/.test(arg)) ?? args[0]
  if (!candidate) return null
  return normalize(isAbsolute(candidate) ? candidate : resolve(agentRoot, candidate))
}

function detectCanonSource(
  logText: string | null,
): 'backend' | 'bundled' | 'unknown' {
  if (!logText) return 'unknown'
  const matches = [
    ...logText.matchAll(
      /Capability canon ready:[^\r\n]*\bsource=(backend|bundled|fallback)\b/gi,
    ),
  ]
  const last = matches.at(-1)?.[1]?.toLowerCase()
  if (last === 'backend') return 'backend'
  if (last === 'bundled' || last === 'fallback') return 'bundled'
  if (/Capability canon ready:\s*vbundled/i.test(logText)) return 'bundled'
  return 'unknown'
}

function containsBundledCapabilitySummary(text: string): boolean {
  if (!text) return false
  return (
    /capability summary below/i.test(text) ||
    /offline fallback/i.test(text) ||
    (/bgos_capabilities/i.test(text) && /supersedes/i.test(text))
  )
}

async function inspectCursorStore(
  fs: AnalyzerReadOnlyFs,
  path: string,
  loader: (path: string) => LoadedCursors,
): Promise<StartingContextCategory['cursorStore']> {
  const read = await readText(fs, path)
  if (read.text === null) {
    return {
      path,
      status: read.error === 'missing' ? 'missing' : 'unreadable',
      entries: 0,
    }
  }
  let loaded: LoadedCursors
  try {
    loaded = loader(path)
  } catch {
    return { path, status: 'corrupt', entries: 0 }
  }
  if (!loaded.fileExisted) return { path, status: 'corrupt', entries: 0 }
  return { path, status: 'readable', entries: loaded.cursors.size }
}

async function probeHealth(
  httpGet: (request: HttpGetRequest) => Promise<HttpGetResponse>,
  backendUrl: string | undefined,
): Promise<BrokenMcpCategory['health']> {
  const base = healthBaseUrl(backendUrl)
  if (!base) {
    return {
      status: 'not-configured',
      httpStatus: null,
      service: null,
      database: null,
    }
  }
  try {
    const response = await httpGet({
      url: `${base}/service-options/health`,
      method: 'GET',
    })
    const body =
      response.body !== null && typeof response.body === 'object'
        ? (response.body as Record<string, unknown>)
        : {}
    const service = typeof body.service === 'string' ? body.service : null
    const database = typeof body.database === 'string' ? body.database : null
    const healthy =
      response.status >= 200 &&
      response.status < 300 &&
      service === 'up' &&
      database === 'up'
    return {
      status: healthy ? 'healthy' : 'unhealthy',
      httpStatus: response.status,
      service,
      database,
    }
  } catch {
    return {
      status: 'unreachable',
      httpStatus: null,
      service: null,
      database: null,
    }
  }
}

function healthBaseUrl(value: string | undefined): string | null {
  if (!isConfiguredValue(value)) return null
  try {
    const url = new URL(value!)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function parseRulesFrontmatter(text: string): FrontmatterResult {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { state: 'absent', paths: [] }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close < 2) return { state: 'invalid', paths: [] }
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(lines.slice(1, close).join('\n'))
  } catch {
    return { state: 'invalid', paths: [] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'invalid', paths: [] }
  }
  const rawPaths = (parsed as Record<string, unknown>).paths
  if (rawPaths === undefined) return { state: 'valid', paths: [] }
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    return { state: 'invalid', paths: [] }
  }
  const paths: string[] = []
  for (const path of rawPaths) {
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { state: 'invalid', paths: [] }
    }
    paths.push(path.trim())
  }
  return { state: 'valid', paths }
}

function findRuleBlocks(text: string, file: string): RuleBlock[] {
  const headings: Array<{ heading: string; line: number; level: number }> = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+)$/.exec(lines[index]!)
    if (!match || !/\bRULE\b/i.test(match[2]!)) continue
    headings.push({
      heading: match[2]!.trim(),
      line: index + 1,
      level: match[1]!.length,
    })
  }
  return headings.map((heading) => {
    let endLine = lines.length
    for (let index = heading.line; index < lines.length; index += 1) {
      const next = /^(#{1,6})\s+/.exec(lines[index]!)
      if (next && next[1]!.length <= heading.level) {
        endLine = index
        break
      }
    }
    return {
      heading: heading.heading.replace(/[\u2013\u2014]/g, '-'),
      file,
      line: heading.line,
      endLine,
    }
  })
}

function extractPathReferences(text: string, file: string): ReferenceCandidate[] {
  const results: ReferenceCandidate[] = []
  const seen = new Set<string>()
  const patterns = [/`([^`\n]+)`/g, /\]\(([^)\s]+)\)/g]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const reference = normalizeReference(match[1] ?? '')
      if (!reference) continue
      const line = lineAtIndex(text, match.index ?? 0)
      const key = `${line}:${reference}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ reference, file, line })
    }
  }
  return results
}

function normalizeReference(raw: string): string | null {
  let value = raw.trim()
  if (!value || /\s/.test(value)) return null
  if (/^(?:https?:|mailto:|data:|#)/i.test(value)) return null
  if (value.startsWith('/') || value.startsWith('~')) return null
  if (/[?*{}<>$|]/.test(value)) return null
  value = value.split('#')[0] ?? ''
  value = value.replace(/[),.;:]+$/, '')
  value = value.replace(/^\.\//, '')
  if (!value || value === '.' || value === '..') return null
  const standaloneFile = /^(?:\.[A-Za-z0-9_-]+|[A-Za-z0-9_@+-]+\.(?:md|mdx|ts|tsx|js|jsx|json|ya?ml|toml|sql|sh|html?|css|scss|png|jpe?g|svg|env))$/i.test(
    value,
  )
  if (!value.includes('/') && !standaloneFile) return null
  if (!/^[A-Za-z0-9_.@+\-/]+$/.test(value)) return null
  return value
}

async function resolveReference(
  fs: AnalyzerReadOnlyFs,
  agentRoot: string,
  reference: string,
  scopePaths: string[],
  basenameIndexes: Map<string, Promise<Map<string, string>>>,
): Promise<{ exists: boolean; reportPath: string }> {
  const candidates: string[] = [resolve(agentRoot, reference)]
  const isBareFilename = !reference.includes('/')
  const firstSegment = reference.split('/')[0] ?? ''
  const firstSegmentExists = firstSegment
    ? await pathExists(fs, resolve(agentRoot, firstSegment))
    : false
  const looksLikeFile = /(?:^|\/)[^/]+\.[A-Za-z0-9]{1,12}$/.test(reference)
  const looksLikeDirectory = reference.endsWith('/')
  if (!firstSegmentExists && !looksLikeFile && !looksLikeDirectory) {
    return { exists: true, reportPath: resolve(agentRoot, reference) }
  }
  for (const scope of scopePaths) {
    const prefix = staticScopePrefix(scope)
    if (!prefix) continue
    const scopeRoot = resolve(agentRoot, prefix)
    candidates.push(resolve(scopeRoot, reference))
    let children: string[] = []
    try {
      children = await fs.readdir(scopeRoot)
    } catch {
      children = []
    }
    for (const child of children) {
      candidates.push(resolve(scopeRoot, child, reference))
    }
  }

  if (!firstSegmentExists && looksLikeFile && !isBareFilename) {
    const searchRoots = await projectSearchRoots(fs, agentRoot, 2)
    for (const root of searchRoots) {
      candidates.push(resolve(root, reference))
    }
  }

  const rootWithSep = agentRoot.endsWith(sep) ? agentRoot : `${agentRoot}${sep}`
  const unique = [...new Set(candidates.map((candidate) => normalize(candidate)))].filter(
    (candidate) => candidate === agentRoot || candidate.startsWith(rootWithSep),
  )
  for (const candidate of unique) {
    if (await pathExists(fs, candidate)) {
      return { exists: true, reportPath: candidate }
    }
  }

  if (isBareFilename) {
    const scopedRoots = scopePaths
      .map(staticScopePrefix)
      .filter((prefix): prefix is string => prefix !== null)
      .map((prefix) => resolve(agentRoot, prefix))
    const searchRoots = scopedRoots.length > 0 ? scopedRoots : [agentRoot]
    const cacheKey = [...searchRoots].sort().join('\0')
    let index = basenameIndexes.get(cacheKey)
    if (!index) {
      index = indexProjectBasenames(fs, searchRoots)
      basenameIndexes.set(cacheKey, index)
    }
    const match = (await index).get(reference)
    if (match) return { exists: true, reportPath: match }
  }
  return { exists: false, reportPath: unique[0] ?? resolve(agentRoot, reference) }
}

async function indexProjectBasenames(
  fs: AnalyzerReadOnlyFs,
  roots: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  const queue = roots.map((path) => ({ path, depth: 0 }))
  const visited = new Set<string>()
  const skipped = new Set([
    '.git',
    '.next',
    '.expo',
    'build',
    'coverage',
    'dist',
    'node_modules',
  ])
  const maxDepth = 10
  const maxEntries = 50_000
  let examined = 0

  while (queue.length > 0 && examined < maxEntries) {
    const current = queue.shift()!
    const normalized = normalize(current.path)
    if (visited.has(normalized)) continue
    visited.add(normalized)
    let names: string[] = []
    try {
      names = await fs.readdir(normalized)
    } catch {
      continue
    }
    for (const name of names) {
      if (examined >= maxEntries) break
      examined += 1
      if (skipped.has(name)) continue
      const path = resolve(normalized, name)
      try {
        const stats = await fs.stat(path)
        if (stats.isFile()) {
          if (!index.has(name)) index.set(name, path)
        } else if (stats.isDirectory() && current.depth < maxDepth) {
          queue.push({ path, depth: current.depth + 1 })
        }
      } catch {
        continue
      }
    }
  }
  return index
}

async function projectSearchRoots(
  fs: AnalyzerReadOnlyFs,
  agentRoot: string,
  maxDepth: number,
): Promise<string[]> {
  const roots: string[] = []
  let current = [agentRoot]
  const skipped = new Set(['.git', 'node_modules', 'dist', 'build'])
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: string[] = []
    for (const root of current) {
      let names: string[] = []
      try {
        names = await fs.readdir(root)
      } catch {
        names = []
      }
      for (const name of names) {
        if (name.startsWith('.') || skipped.has(name)) continue
        const path = resolve(root, name)
        try {
          const stats = await fs.stat(path)
          if (!stats.isDirectory()) continue
        } catch {
          continue
        }
        roots.push(path)
        next.push(path)
      }
    }
    current = next
  }
  return roots
}

function staticScopePrefix(pattern: string): string | null {
  const special = pattern.search(/[?*{[]/)
  const raw = (special === -1 ? pattern : pattern.slice(0, special)).replace(/\/$/, '')
  if (!raw) return null
  return raw
}

function isConfiguredValue(value: string | undefined): boolean {
  const clean = cleanValue(value)
  if (!clean) return false
  return !/^(?:<.*>|your(?:[_-].*)?|change[_-]?me|replace[_-]?me|placeholder|todo|tbd|xxx+|undefined|null|none|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*)$/i.test(
    clean,
  )
}

function configuredString(value: unknown): string | undefined {
  const stringValue =
    typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
  return isConfiguredValue(stringValue) ? stringValue!.trim() : undefined
}

function isValidBackendUrl(value: string | undefined): boolean {
  return healthBaseUrl(value) !== null
}

function cleanValue(value: string | undefined): string | null {
  const clean = value?.trim() ?? ''
  return clean || null
}

async function readPackageVersion(
  fs: AnalyzerReadOnlyFs,
  path: string,
): Promise<string | null> {
  const read = await readText(fs, path)
  if (!read.text) return null
  try {
    const parsed = JSON.parse(read.text) as { version?: unknown }
    return typeof parsed.version === 'string' && /^\d+\.\d+\.\d+$/.test(parsed.version)
      ? parsed.version
      : null
  } catch {
    return null
  }
}

async function pathExists(fs: AnalyzerReadOnlyFs, path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function readText(
  fs: AnalyzerReadOnlyFs,
  path: string,
): Promise<{
  text: string | null
  error: 'missing' | 'unreadable' | null
}> {
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
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : null
  }
  return null
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
  if (text.length === 0) return 0
  const newlines = text.match(/\n/g)?.length ?? 0
  return text.endsWith('\n') ? newlines : newlines + 1
}

function estimateTokens(chars: number): number {
  return chars === 0 ? 0 : Math.ceil(chars / 4)
}

function lineAtIndex(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split('\n').length
}

function lineOf(text: string | null, needle: string): number {
  if (!text) return 1
  const index = text.indexOf(`"${needle}"`)
  if (index < 0) return 1
  return lineAtIndex(text, index)
}

function missingAlwaysOnFinding(
  label: string,
  file: string,
  category: FindingCategory,
): Finding {
  return makeFinding({
    id: 'always-on-file-unreadable',
    category,
    severity: 'warning',
    explanation: `${label} is absent or unreadable.`,
    file,
    line: 1,
    classification: 'analyze-only',
    proposedChange: {
      kind: 'inspect-always-on-file',
      operation: 'none',
      description: `Review ${label} availability without creating replacement instructions.`,
      data: { label },
    },
    whySafe: 'The analyzer records the missing surface and does not create or replace it.',
  })
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
