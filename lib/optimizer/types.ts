import type { BindingSource } from '../session-binding'

export type FindingCategory =
  | 'context-rot'
  | 'starting-context'
  | 'claude-md-rules'
  | 'broken-mcp'

export type FindingSeverity = 'info' | 'warning' | 'error'

export type FindingClassification =
  | 'auto-apply'
  | 'needs-approval'
  | 'analyze-only'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface ProposedChange {
  kind: string
  operation: 'none' | 'edit-file' | 'manual-action'
  description: string
  data: { [key: string]: JsonValue }
}

export interface Finding {
  id: string
  category: FindingCategory
  severity: FindingSeverity
  explanation: string
  file: string
  /** One-based source line. Use 1 when the whole file or runtime state applies. */
  line: number
  proposedChange: ProposedChange
  classification: FindingClassification
  whySafe: string
}

export interface FileBudget {
  path: string
  exists: boolean
  chars: number
  utf8Bytes: number
  lines: number
  estimatedTokens: number
}

export interface ContextRotCategory {
  contextPct: number | null
  model: string | null
  nominalWindowTokens: number | null
  binding: {
    file: string
    source: BindingSource
    verified: boolean
  } | null
  tmuxCompaction: {
    available: boolean
    source: 'env-session' | 'tmux-pane' | null
  }
  resting: {
    state: 'resting' | 'activity' | 'not-detected'
    resetAt: string | null
  }
  findings: Finding[]
}

export interface StartingContextCategory {
  budget: {
    claudeMd: FileBudget
    mcpInstructions: FileBudget
    memoryIndex: FileBudget
    total: Omit<FileBudget, 'path' | 'exists'>
  }
  mcpInstructionsSourceChars: number
  canonSource: 'backend' | 'bundled' | 'unknown'
  canonSummaryDoubleLoad: boolean
  cursorStore: {
    path: string
    status: 'readable' | 'missing' | 'unreadable' | 'corrupt'
    entries: number
  }
  findings: Finding[]
}

export interface DeadReference {
  reference: string
  resolvedPath: string
  file: string
  line: number
}

export interface RuleBlock {
  heading: string
  file: string
  line: number
  endLine: number
}

export interface InstructionFileReport extends FileBudget {
  kind: 'claude-md' | 'rule'
  frontmatter: 'valid' | 'invalid' | 'absent' | 'not-applicable'
}

export interface ClaudeMdRulesCategory {
  files: InstructionFileReport[]
  deadReferences: DeadReference[]
  ruleBlocks: RuleBlock[]
  findings: Finding[]
}

export interface HealthObservation {
  status: 'healthy' | 'unhealthy' | 'unreachable' | 'not-configured'
  httpStatus: number | null
  service: string | null
  database: string | null
}

export interface BrokenMcpCategory {
  configPath: string
  configStatus: 'valid' | 'missing' | 'malformed'
  serverName: string | null
  bun: {
    found: boolean
    path: string | null
  }
  serverEntry: {
    path: string | null
    exists: boolean
  }
  requiredEnv: Record<
    'BGOS_BACKEND_URL' | 'BGOS_API_KEY' | 'BGOS_USER_ID' | 'BGOS_ASSISTANT_ID',
    boolean
  >
  health: HealthObservation
  canonSource: 'backend' | 'bundled' | 'unknown'
  authMode: 'pairing' | 'apikey' | 'missing'
  versionHeartbeat: 'enabled' | 'suppressed' | 'unavailable'
  statusPatchActivity: 'observed' | 'not-observed' | 'unknown'
  findings: Finding[]
}

export interface FindingsReport {
  schemaVersion: 1
  analyzedAt: string
  readOnly: true
  agent: {
    kind: 'claude-code' | 'hermes'
    root: string
  }
  categories: {
    contextRot: ContextRotCategory
    startingContext: StartingContextCategory
    claudeMdRules: ClaudeMdRulesCategory
    brokenMcp: BrokenMcpCategory
  }
  findings: Finding[]
  summary: {
    total: number
    byCategory: Record<FindingCategory, number>
    bySeverity: Record<FindingSeverity, number>
    byClassification: Record<FindingClassification, number>
  }
}
