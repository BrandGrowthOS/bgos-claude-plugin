import { describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'

import {
  analyzeClaudeCodeAgent,
  extractMcpInstructionsFromSource,
  inspectTranscriptTail,
  type AnalyzerReadOnlyFs,
  type ClaudeAnalyzerDependencies,
  type SessionInspection,
} from '../lib/optimizer/claude-analyzer'
import type { Finding, FindingsReport } from '../lib/optimizer/types'

const AGENT_ROOT = '/agent'
const PLUGIN_ROOT = '/plugin'
const CLAUDE_HOME = '/home/test/.claude'
const MEMORY_PATH = '/memory/MEMORY.md'
const CURSOR_PATH = '/state/chat-cursors.json'
const LOG_PATH = '/logs/bgos.log'
const MCP_PATH = join(AGENT_ROOT, '.mcp.json')
const SERVER_PATH = join(PLUGIN_ROOT, 'server.ts')
const SECRET = 'live-secret-never-report-this'
const NOW_MS = Date.parse('2026-07-22T12:00:00.000Z')

const SERVER_SOURCE = `
const mcp = new Server(
  { name: 'bgos', version: '1.0.0' },
  {
    instructions: [
      'Offline fallback line one.',
      'Offline fallback line two.',
    ].join('\\n'),
  },
)
`

function validMcp(apiKey: string = SECRET): string {
  return JSON.stringify(
    {
      mcpServers: {
        bgos: {
          command: 'bun',
          args: [SERVER_PATH],
          env: {
            BGOS_BACKEND_URL: 'https://backend.example/api/v1',
            BGOS_API_KEY: apiKey,
            BGOS_USER_ID: 'user-1',
            BGOS_ASSISTANT_ID: '900',
          },
        },
      },
    },
    null,
    2,
  )
}

function baseFiles(): Record<string, string> {
  return {
    [join(AGENT_ROOT, 'CLAUDE.md')]: [
      '# Project',
      '## RULE - Preserve this contract',
      'Read `docs/existing.md` before changes.',
      '',
    ].join('\n'),
    [join(AGENT_ROOT, 'docs/existing.md')]: '# Existing\n',
    [join(AGENT_ROOT, '.claude/rules/backend.md')]: [
      '---',
      'paths:',
      '  - "backend/**"',
      '---',
      '# Backend',
      '',
    ].join('\n'),
    [MCP_PATH]: validMcp(),
    [SERVER_PATH]: SERVER_SOURCE,
    [join(PLUGIN_ROOT, 'package.json')]: JSON.stringify({ version: '0.29.0' }),
    [MEMORY_PATH]: '# Memory index\n- one\n- two\n',
    [CURSOR_PATH]: JSON.stringify({ v: 1, cursors: { '10': 22 } }),
    [LOG_PATH]:
      '2026-07-22T11:00:00.000Z [bgos] Capability canon ready: v7 (4000 chars) [source=backend]\n',
  }
}

class MockReadOnlyFs implements AnalyzerReadOnlyFs {
  readonly files = new Map<string, string>()
  readonly denied = new Set<string>()
  readonly mutations = {
    writeFile: 0,
    appendFile: 0,
    mkdir: 0,
    unlink: 0,
    rename: 0,
  }

  constructor(files: Record<string, string> = baseFiles()) {
    for (const [path, text] of Object.entries(files)) {
      this.files.set(normalize(path), text)
    }
  }

  set(path: string, text: string): void {
    this.files.set(normalize(path), text)
  }

  delete(path: string): void {
    this.files.delete(normalize(path))
  }

  async readFile(path: string): Promise<string> {
    const key = normalize(path)
    if (this.denied.has(key)) throw fsError('EACCES', key)
    const value = this.files.get(key)
    if (value === undefined) throw fsError('ENOENT', key)
    return value
  }

  async readdir(path: string): Promise<string[]> {
    const key = normalize(path)
    if (this.denied.has(key)) throw fsError('EACCES', key)
    const prefix = `${key}/`
    const names = new Set<string>()
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue
      const relative = file.slice(prefix.length)
      const first = relative.split('/')[0]
      if (first) names.add(first)
    }
    if (names.size === 0 && !this.hasDirectory(key)) throw fsError('ENOENT', key)
    return [...names].sort()
  }

  async stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }> {
    const key = normalize(path)
    if (this.denied.has(key)) throw fsError('EACCES', key)
    if (this.files.has(key)) {
      return { isFile: () => true, isDirectory: () => false }
    }
    if (this.hasDirectory(key)) {
      return { isFile: () => false, isDirectory: () => true }
    }
    throw fsError('ENOENT', key)
  }

  async access(path: string): Promise<void> {
    await this.stat(path)
  }

  writeFile(): void {
    this.mutations.writeFile += 1
  }

  appendFile(): void {
    this.mutations.appendFile += 1
  }

  mkdir(): void {
    this.mutations.mkdir += 1
  }

  unlink(): void {
    this.mutations.unlink += 1
  }

  rename(): void {
    this.mutations.rename += 1
  }

  private hasDirectory(path: string): boolean {
    const prefix = `${path}/`
    return [...this.files.keys()].some((file) => file.startsWith(prefix))
  }
}

function fsError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${path}`), { code, path })
}

function snapshotTree(root: string): Array<[string, string]> {
  const result: Array<[string, string]> = []
  const visit = (path: string): void => {
    const stats = statSync(path)
    const relative = path.slice(root.length) || '/'
    if (stats.isDirectory()) {
      result.push([relative, 'directory'])
      for (const name of readdirSync(path).sort()) visit(join(path, name))
      return
    }
    result.push([relative, readFileSync(path).toString('base64')])
  }
  visit(root)
  return result
}

const DEFAULT_SESSION: SessionInspection = {
  binding: { name: 'session.jsonl', source: 'marker' },
  contextPct: 45,
  tail: null,
  restingSignal: null,
}

interface HarnessOverrides {
  session?: SessionInspection
  sessionError?: Error
  whichResult?: string | null
  whichError?: Error
  health?: { status: number; body: unknown }
  healthError?: Error
  cursorFileExisted?: boolean
  cursorError?: Error
}

function harness(
  fs: MockReadOnlyFs,
  overrides: HarnessOverrides = {},
): {
  deps: ClaudeAnalyzerDependencies
  networkCalls: Array<{ url: string; method: 'GET' }>
  whichCalls: string[]
} {
  const networkCalls: Array<{ url: string; method: 'GET' }> = []
  const whichCalls: string[] = []
  return {
    networkCalls,
    whichCalls,
    deps: {
      fs,
      which: async (command) => {
        whichCalls.push(command)
        if (overrides.whichError) throw overrides.whichError
        return overrides.whichResult === undefined ? '/opt/bin/bun' : overrides.whichResult
      },
      httpGet: async (request) => {
        networkCalls.push(request)
        if (overrides.healthError) throw overrides.healthError
        return overrides.health ?? {
          status: 200,
          body: { service: 'up', database: 'up' },
        }
      },
      inspectSession: async () => {
        if (overrides.sessionError) throw overrides.sessionError
        return overrides.session ?? DEFAULT_SESSION
      },
      loadCursorFile: () => {
        if (overrides.cursorError) throw overrides.cursorError
        return {
          fileExisted: overrides.cursorFileExisted ?? true,
          cursors: new Map([['10', 22]]),
        }
      },
      homeDir: '/home/test',
      tempDir: '/tmp',
    },
  }
}

function options() {
  return {
    agentRoot: AGENT_ROOT,
    claudeHome: CLAUDE_HOME,
    memoryIndexPath: MEMORY_PATH,
    cursorFilePath: CURSOR_PATH,
    pluginLogPath: LOG_PATH,
    nowMs: NOW_MS,
    env: {},
  }
}

function finding(report: FindingsReport, id: string): Finding {
  const result = report.findings.find(
    (item) => item.id === id || item.id.startsWith(`${id}:`),
  )
  expect(result, `missing finding ${id}`).toBeDefined()
  return result!
}

describe('transcript analysis reuses the guarded context helpers', () => {
  test('unmarked 1M usage uses the existing overflow inference', () => {
    const tail = `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-22T11:59:00.000Z',
      message: {
        model: 'claude-fable-5',
        usage: {
          input_tokens: 300_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    })}\n`
    const inspected = inspectTranscriptTail(tail, NOW_MS)
    expect(inspected.contextPct).toBe(30)
    expect(inspected.model).toBe('claude-fable-5')
    expect(inspected.nominalWindowTokens).toBe(200_000)
  })

  test('genuine caps are resting while transient 429s are not', () => {
    const genuine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-22T11:59:00.000Z',
      error: 'rate_limit',
      isApiErrorMessage: true,
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your session limit" }],
      },
    })
    const transient = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-22T11:59:00.000Z',
      error: 'rate_limit',
      isApiErrorMessage: true,
      message: {
        model: '<synthetic>',
        content: [
          {
            type: 'text',
            text: 'API Error: Server is temporarily limiting requests (not your usage limit)',
          },
        ],
      },
    })
    expect(inspectTranscriptTail(`${genuine}\n`, NOW_MS).restingSignal?.type).toBe(
      'limit',
    )
    expect(inspectTranscriptTail(`${transient}\n`, NOW_MS).restingSignal).toBeNull()
  })

  test('uses the latest usage entry and reports a marked 1M nominal window', () => {
    const older = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-fable-5',
        usage: { input_tokens: 100_000 },
      },
    })
    const latest = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-fable-5[1m]',
        usage: { input_tokens: 250_000 },
      },
    })
    const inspected = inspectTranscriptTail(`${older}\n${latest}\n`, NOW_MS)
    expect(inspected.contextPct).toBe(25)
    expect(inspected.nominalWindowTokens).toBe(1_000_000)
  })
})

describe('context rot analyzer', () => {
  test('newest-mtime binding is reported as unverified', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs, {
      session: {
        ...DEFAULT_SESSION,
        binding: { name: 'maybe-ours.jsonl', source: 'newest-mtime' },
      },
    })
    const report = await analyzeClaudeCodeAgent(options(), h.deps)

    expect(report.categories.contextRot.binding).toEqual({
      file: 'maybe-ours.jsonl',
      source: 'newest-mtime',
      verified: false,
    })
    const item = finding(report, 'context-binding-unverified')
    expect(item.classification).toBe('analyze-only')
    expect(item.severity).toBe('warning')
  })

  test('resting is state, never a broken-agent defect', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs, {
      session: {
        ...DEFAULT_SESSION,
        restingSignal: {
          type: 'limit',
          resetAt: '2026-07-22T12:30:00.000Z',
          at: NOW_MS - 60_000,
          afterActivity: false,
        },
      },
    })
    const report = await analyzeClaudeCodeAgent(options(), h.deps)

    expect(report.categories.contextRot.resting.state).toBe('resting')
    const item = finding(report, 'agent-resting')
    expect(item.severity).toBe('info')
    expect(item.explanation.toLowerCase()).not.toContain('broken')
    expect(
      report.findings.some(
        (entry) => entry.severity === 'error' && entry.id.includes('resting'),
      ),
    ).toBe(false)
  })

  test('reports env, inherited pane, and explicit tmux opt-out states', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs)

    const envTarget = await analyzeClaudeCodeAgent(
      { ...options(), env: { BGOS_TMUX_SESSION: 'agent-900' } },
      h.deps,
    )
    expect(envTarget.categories.contextRot.tmuxCompaction).toEqual({
      available: true,
      source: 'env-session',
    })

    const inherited = await analyzeClaudeCodeAgent(
      {
        ...options(),
        env: { TMUX: '/tmp/tmux/default,1,0', TMUX_PANE: '%9' },
      },
      h.deps,
    )
    expect(inherited.categories.contextRot.tmuxCompaction).toEqual({
      available: true,
      source: 'tmux-pane',
    })

    const disabled = await analyzeClaudeCodeAgent(
      {
        ...options(),
        env: {
          BGOS_REMOTE_COMPACT: 'off',
          BGOS_TMUX_SESSION: 'agent-900',
        },
      },
      h.deps,
    )
    expect(disabled.categories.contextRot.tmuxCompaction).toEqual({
      available: false,
      source: null,
    })
  })
})

describe('starting context analyzer', () => {
  test('budgets the trio and detects backend canon plus fallback double load', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs)
    const report = await analyzeClaudeCodeAgent(options(), h.deps)
    const start = report.categories.startingContext

    expect(start.budget.claudeMd.chars).toBe(
      (await fs.readFile(join(AGENT_ROOT, 'CLAUDE.md'))).length,
    )
    expect(start.budget.mcpInstructions.chars).toBe(
      'Offline fallback line one.\nOffline fallback line two.'.length,
    )
    expect(start.budget.memoryIndex.chars).toBe(
      (await fs.readFile(MEMORY_PATH)).length,
    )
    expect(start.budget.total.estimatedTokens).toBeGreaterThan(0)
    expect(start.canonSource).toBe('backend')
    expect(start.canonSummaryDoubleLoad).toBe(true)
    expect(finding(report, 'canon-summary-double-load').classification).toBe(
      'needs-approval',
    )
    expect(start.cursorStore.status).toBe('readable')
  })

  test('bundled canon is graceful degradation and is never an error', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      LOG_PATH,
      '2026-07-22T11:00:00.000Z [bgos] Capability canon ready: vbundled (100 chars) [source=fallback]\n',
    )
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)

    expect(report.categories.startingContext.canonSource).toBe('bundled')
    expect(report.categories.startingContext.canonSummaryDoubleLoad).toBe(false)
    expect(report.categories.brokenMcp.canonSource).toBe('bundled')
    const item = finding(report, 'canon-bundled-fallback')
    expect(item.severity).toBe('info')
    expect(item.classification).toBe('analyze-only')
  })

  test('canon source ignores unrelated source labels after the canon-ready log', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      LOG_PATH,
      [
        'Capability canon ready: v7 (4000 chars) [source=backend]',
        'background diagnostic source=bundled',
        '',
      ].join('\n'),
    )
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)

    expect(report.categories.startingContext.canonSource).toBe('backend')
    expect(report.categories.startingContext.canonSummaryDoubleLoad).toBe(true)
    expect(report.categories.brokenMcp.canonSource).toBe('backend')
  })

  test('missing, unreadable, and corrupt cursors are reported without repair', async () => {
    const missingFs = new MockReadOnlyFs()
    missingFs.delete(CURSOR_PATH)
    const missing = await analyzeClaudeCodeAgent(options(), harness(missingFs).deps)
    expect(missing.categories.startingContext.cursorStore.status).toBe('missing')

    const deniedFs = new MockReadOnlyFs()
    deniedFs.denied.add(CURSOR_PATH)
    const denied = await analyzeClaudeCodeAgent(options(), harness(deniedFs).deps)
    expect(denied.categories.startingContext.cursorStore.status).toBe('unreadable')

    const corruptFs = new MockReadOnlyFs()
    const corrupt = await analyzeClaudeCodeAgent(
      options(),
      harness(corruptFs, { cursorFileExisted: false }).deps,
    )
    expect(corrupt.categories.startingContext.cursorStore.status).toBe('corrupt')
    for (const fs of [missingFs, deniedFs, corruptFs]) {
      expect(fs.mutations).toEqual({
        writeFile: 0,
        appendFile: 0,
        mkdir: 0,
        unlink: 0,
        rename: 0,
      })
    }
  })
})

describe('CLAUDE.md and rules analyzer', () => {
  test('reports dead references at the citation line and protects RULE blocks', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      join(AGENT_ROOT, 'CLAUDE.md'),
      [
        '# Project',
        '## \u{1F6A8} RULE \u2014 Preserve this contract',
        'Keep the protected `docs/rule-missing.md` reference.',
        '## Other guidance',
        'Read `docs/missing.md` before changes.',
        'Ignore `https://example.com/doc`, `/api/v1/health`, and `src/**/*`.',
        'Resolve `app/_layout.tsx`, but ignore the action id `dorny/paths-filter`.',
        '## \u{1F6A8} RULE \u2014 Preserve another contract',
        '',
      ].join('\n'),
    )
    fs.set(
      join(AGENT_ROOT, 'frontend/expo-app/app/_layout.tsx'),
      'export default function Layout() {}\n',
    )
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    const instruction = report.categories.claudeMdRules

    expect(instruction.deadReferences).toHaveLength(2)
    expect(instruction.deadReferences.find((item) => item.reference === 'docs/missing.md')).toMatchObject({
      reference: 'docs/missing.md',
      file: join(AGENT_ROOT, 'CLAUDE.md'),
      line: 5,
    })
    const deadFindings = report.findings.filter((item) =>
      item.id.startsWith('dead-reference'),
    )
    expect(
      deadFindings.find((item) =>
        JSON.stringify(item.proposedChange.data).includes('docs/missing.md'),
      )?.classification,
    ).toBe('needs-approval')
    expect(
      deadFindings.find((item) =>
        JSON.stringify(item.proposedChange.data).includes('docs/rule-missing.md'),
      )?.classification,
    ).toBe('analyze-only')
    const rules = report.findings.filter((item) =>
      item.id.startsWith('protected-rule-block'),
    )
    expect(rules).toHaveLength(2)
    expect(rules.every((item) => item.classification === 'analyze-only')).toBe(true)
    expect(rules.every((item) => item.proposedChange.kind === 'preserve-rule-block')).toBe(
      true,
    )
    expect(JSON.stringify(report)).not.toMatch(/[\u2013\u2014]/)
    expect(new Set(report.findings.map((item) => item.id)).size).toBe(
      report.findings.length,
    )
  })

  test('invalid rule frontmatter is an auto-apply parse repair proposal only', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      join(AGENT_ROOT, '.claude/rules/backend.md'),
      ['---', 'paths:', '  - "backend/**', '---', '# Backend', ''].join('\n'),
    )
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    const item = finding(report, 'invalid-rules-frontmatter')

    expect(item.classification).toBe('auto-apply')
    expect(item.proposedChange.kind).toBe('repair-frontmatter-parse')
    expect(fs.mutations).toEqual({
      writeFile: 0,
      appendFile: 0,
      mkdir: 0,
      unlink: 0,
      rename: 0,
    })
  })

  test('reports char and line counts for CLAUDE.md and every scoped rule', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      join(AGENT_ROOT, '.claude/rules/frontend.md'),
      ['---', 'paths:', '  - "frontend/**"', '---', '# Frontend'].join('\n'),
    )
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    const files = report.categories.claudeMdRules.files
    expect(files.map((item) => item.path).sort()).toEqual(
      [
        join(AGENT_ROOT, 'CLAUDE.md'),
        join(AGENT_ROOT, '.claude/rules/backend.md'),
        join(AGENT_ROOT, '.claude/rules/frontend.md'),
      ].sort(),
    )
    for (const item of files) {
      const source = await fs.readFile(item.path)
      expect(item.chars).toBe(source.length)
      expect(item.lines).toBe(source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length)
    }
  })

  test('an intentional always-on rule without frontmatter is not auto-repaired', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      join(AGENT_ROOT, '.claude/rules/always.md'),
      '# Always-on guidance\nKeep this instruction.\n',
    )
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    const file = report.categories.claudeMdRules.files.find((item) =>
      item.path.endsWith('/always.md'),
    )
    expect(file?.frontmatter).toBe('absent')
    expect(
      report.findings.some(
        (item) =>
          item.id.startsWith('invalid-rules-frontmatter') &&
          item.file.endsWith('/always.md'),
      ),
    ).toBe(false)
  })

  test('scans rule files, bare filenames, and directory references for missing paths', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      join(AGENT_ROOT, 'CLAUDE.md'),
      [
        '# Project',
        'Read `MISSING.md` before release.',
        'Run `ci.yml` for verification.',
        'Inspect `docs/missing-directory` before deployment.',
        '',
      ].join('\n'),
    )
    fs.set(
      join(AGENT_ROOT, '.claude/rules/backend.md'),
      [
        '---',
        'paths:',
        '  - "backend/**"',
        '---',
        '# Backend',
        'Follow `DeepExisting.ts` for implementation details.',
        'Follow `docs/rule-missing.md` for recovery.',
        '',
      ].join('\n'),
    )
    fs.set(join(AGENT_ROOT, '.github/workflows/ci.yml'), 'name: CI\n')
    fs.set(
      join(AGENT_ROOT, 'backend/src/deep/nested/DeepExisting.ts'),
      'export const ok = true\n',
    )

    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    expect(
      report.categories.claudeMdRules.deadReferences.map((item) => ({
        reference: item.reference,
        file: item.file,
        line: item.line,
      })),
    ).toEqual([
      {
        reference: 'MISSING.md',
        file: join(AGENT_ROOT, 'CLAUDE.md'),
        line: 2,
      },
      {
        reference: 'docs/missing-directory',
        file: join(AGENT_ROOT, 'CLAUDE.md'),
        line: 4,
      },
      {
        reference: 'docs/rule-missing.md',
        file: join(AGENT_ROOT, '.claude/rules/backend.md'),
        line: 7,
      },
    ])
  })

  test('rejects present frontmatter when paths is not a string list', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      join(AGENT_ROOT, '.claude/rules/backend.md'),
      ['---', 'paths: "backend/**"', '---', '# Backend', ''].join('\n'),
    )
    fs.set(
      join(AGENT_ROOT, '.claude/rules/malformed.md'),
      ['---', 'paths:', '  - "frontend/**"', 'metadata: [broken', '---', ''].join(
        '\n',
      ),
    )

    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    const invalidFiles = report.findings
      .filter((item) => item.id.startsWith('invalid-rules-frontmatter'))
      .map((item) => item.file)
      .sort()
    expect(invalidFiles).toEqual(
      [
        join(AGENT_ROOT, '.claude/rules/backend.md'),
        join(AGENT_ROOT, '.claude/rules/malformed.md'),
      ].sort(),
    )
  })
})

describe('broken MCP analyzer', () => {
  test('checks bun, server, public health, auth mode, and never reports the key', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      LOG_PATH,
      [
        'Capability canon ready: v7 (4000 chars) [source=backend]',
        'Resting self-report sent (resetAt=2026-07-22T12:30:00.000Z)',
        '',
      ].join('\n'),
    )
    const h = harness(fs)
    const report = await analyzeClaudeCodeAgent(options(), h.deps)
    const mcp = report.categories.brokenMcp

    expect(h.whichCalls).toEqual(['bun'])
    expect(h.networkCalls).toEqual([
      {
        url: 'https://backend.example/api/v1/service-options/health',
        method: 'GET',
      },
    ])
    expect(mcp.configStatus).toBe('valid')
    expect(mcp.bun.path).toBe('/opt/bin/bun')
    expect(mcp.serverEntry.exists).toBe(true)
    expect(mcp.health).toMatchObject({
      status: 'healthy',
      service: 'up',
      database: 'up',
    })
    expect(mcp.authMode).toBe('apikey')
    expect(mcp.versionHeartbeat).toBe('suppressed')
    expect(mcp.statusPatchActivity).toBe('observed')
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  test('malformed .mcp.json proposes a JSON repair but never writes it', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(MCP_PATH, '{ bad json')
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    const item = finding(report, 'malformed-mcp-json')

    expect(report.categories.brokenMcp.configStatus).toBe('malformed')
    expect(item.classification).toBe('auto-apply')
    expect(item.proposedChange.kind).toBe('repair-json-parse')
    expect(fs.mutations.writeFile).toBe(0)
  })

  test('missing bun and unhealthy database are actionable without mutation', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs, {
      whichResult: null,
      health: { status: 200, body: { service: 'up', database: 'down' } },
    })
    const report = await analyzeClaudeCodeAgent(options(), h.deps)

    expect(finding(report, 'bun-not-found').classification).toBe('needs-approval')
    expect(finding(report, 'backend-health-failing').severity).toBe('error')
    expect(fs.mutations.writeFile).toBe(0)
  })

  test('flags missing placeholders and a missing configured server entry', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      MCP_PATH,
      JSON.stringify({
        mcpServers: {
          bgos: {
            command: 'bun',
            args: ['/missing/server.ts'],
            env: {
              BGOS_BACKEND_URL: '<backend-url>',
              BGOS_API_KEY: 'changeme',
              BGOS_USER_ID: '',
              BGOS_ASSISTANT_ID: 'your-assistant-id',
            },
          },
        },
      }),
    )
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    expect(Object.values(report.categories.brokenMcp.requiredEnv)).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(finding(report, 'missing-required-mcp-env').classification).toBe(
      'needs-approval',
    )
    expect(finding(report, 'mcp-server-entry-missing').severity).toBe('error')
  })

  test('pairing auth enables heartbeat when the plugin version is readable', async () => {
    const fs = new MockReadOnlyFs()
    const parsed = JSON.parse(validMcp())
    delete parsed.mcpServers.bgos.env.BGOS_API_KEY
    parsed.mcpServers.bgos.env.BGOS_PAIRING_TOKEN = 'pairing-secret'
    fs.set(MCP_PATH, JSON.stringify(parsed))
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    expect(report.categories.brokenMcp.authMode).toBe('pairing')
    expect(report.categories.brokenMcp.versionHeartbeat).toBe('enabled')
    expect(
      report.findings.some((item) => item.id.startsWith('missing-required-mcp-env')),
    ).toBe(false)
    expect(JSON.stringify(report)).not.toContain('pairing-secret')
  })

  test('pairing credentials file takes precedence over a legacy API key', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      '/home/test/.bgos-agent/credentials.json',
      JSON.stringify({
        backendUrl: 'https://paired.example/api/v1',
        pairingToken: 'file-pairing-secret',
        userId: 'paired-user',
        assistantId: 901,
      }),
    )
    const h = harness(fs)
    const report = await analyzeClaudeCodeAgent(options(), h.deps)

    expect(report.categories.brokenMcp.authMode).toBe('pairing')
    expect(report.categories.brokenMcp.versionHeartbeat).toBe('enabled')
    expect(h.networkCalls).toEqual([
      {
        url: 'https://paired.example/api/v1/service-options/health',
        method: 'GET',
      },
    ])
    expect(
      report.findings.some((item) => item.id.startsWith('missing-required-mcp-env')),
    ).toBe(false)
    expect(JSON.stringify(report)).not.toContain('file-pairing-secret')
  })

  test('a malformed backend URL is not treated as configured', async () => {
    const fs = new MockReadOnlyFs()
    const parsed = JSON.parse(validMcp())
    parsed.mcpServers.bgos.env.BGOS_BACKEND_URL = 'not-a-valid-url'
    fs.set(MCP_PATH, JSON.stringify(parsed))
    const h = harness(fs)
    const report = await analyzeClaudeCodeAgent(options(), h.deps)

    expect(report.categories.brokenMcp.requiredEnv.BGOS_BACKEND_URL).toBe(false)
    expect(report.categories.brokenMcp.health.status).toBe('not-configured')
    expect(h.networkCalls).toEqual([])
    const item = finding(report, 'missing-required-mcp-env')
    expect(item.proposedChange.data).toEqual({
      missingKeys: ['BGOS_BACKEND_URL'],
    })
  })

  test('a rejected health GET degrades to an unreachable observation', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeClaudeCodeAgent(
      options(),
      harness(fs, { healthError: new Error('offline') }).deps,
    )
    expect(report.categories.brokenMcp.health.status).toBe('unreachable')
    expect(finding(report, 'backend-health-failing').classification).toBe(
      'needs-approval',
    )
  })

  test('pluginRoot never masks a wrong configured server path', async () => {
    const fs = new MockReadOnlyFs()
    const parsed = JSON.parse(validMcp())
    parsed.mcpServers.bgos.args = ['/wrong/missing-server.ts']
    fs.set(MCP_PATH, JSON.stringify(parsed))
    const report = await analyzeClaudeCodeAgent(
      { ...options(), pluginRoot: PLUGIN_ROOT },
      harness(fs).deps,
    )
    expect(report.categories.brokenMcp.serverEntry).toEqual({
      path: '/wrong/missing-server.ts',
      exists: false,
    })
    expect(finding(report, 'mcp-server-entry-missing').severity).toBe('error')
  })

  test('a bgos entry without command is reported as unstartable', async () => {
    const fs = new MockReadOnlyFs()
    const parsed = JSON.parse(validMcp())
    delete parsed.mcpServers.bgos.command
    fs.set(MCP_PATH, JSON.stringify(parsed))
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)
    expect(finding(report, 'mcp-command-missing').severity).toBe('error')
    expect(finding(report, 'mcp-command-missing').classification).toBe(
      'needs-approval',
    )
  })

  test('common credential and identity placeholders are treated as missing', async () => {
    const fs = new MockReadOnlyFs()
    const parsed = JSON.parse(validMcp())
    parsed.mcpServers.bgos.env = {
      BGOS_BACKEND_URL: 'CHANGE_ME',
      BGOS_API_KEY: '${BGOS_API_KEY}',
      BGOS_USER_ID: 'undefined',
      BGOS_ASSISTANT_ID: 'null',
      BGOS_PAIRING_TOKEN: 'REPLACE_ME',
    }
    fs.set(MCP_PATH, JSON.stringify(parsed))
    const h = harness(fs)

    const report = await analyzeClaudeCodeAgent(options(), h.deps)
    expect(report.categories.brokenMcp.requiredEnv).toEqual({
      BGOS_BACKEND_URL: false,
      BGOS_API_KEY: false,
      BGOS_USER_ID: false,
      BGOS_ASSISTANT_ID: false,
    })
    expect(report.categories.brokenMcp.authMode).toBe('missing')
    expect(report.categories.brokenMcp.versionHeartbeat).toBe('unavailable')
    expect(h.networkCalls).toEqual([])
    const item = finding(report, 'missing-required-mcp-env')
    expect(item.proposedChange.data).toEqual({
      missingKeys: [
        'BGOS_BACKEND_URL',
        'BGOS_USER_ID',
        'BGOS_ASSISTANT_ID',
        'BGOS_API_KEY',
      ],
    })
    expect(JSON.stringify(report)).not.toContain('${BGOS_API_KEY}')
    expect(JSON.stringify(report)).not.toContain('REPLACE_ME')
  })
})

describe('MCP instruction extraction', () => {
  test('evaluates only the static string array and reports rendered and source chars', () => {
    const result = extractMcpInstructionsFromSource(SERVER_SOURCE)
    expect(result).not.toBeNull()
    expect(result?.text).toBe(
      'Offline fallback line one.\nOffline fallback line two.',
    )
    expect(result?.line).toBeGreaterThan(1)
    expect(result?.sourceChars).toBeGreaterThan(result!.text.length)
  })

  test('preserves escaped static text and refuses dynamic expressions without evaluating', () => {
    const escaped = `const mcp = new Server({}, { instructions: ['don\\'t', 'C:\\\\tmp'].join('\\n') })`
    expect(extractMcpInstructionsFromSource(escaped)?.text).toBe("don't\nC:\\tmp")

    ;(globalThis as Record<string, unknown>).__optimizerProbe = 0
    const dynamic = `const mcp = new Server({}, { instructions: [(() => { globalThis.__optimizerProbe = 1; return 'bad' })()].join('\\n') })`
    expect(extractMcpInstructionsFromSource(dynamic)).toBeNull()
    expect((globalThis as Record<string, unknown>).__optimizerProbe).toBe(0)
    delete (globalThis as Record<string, unknown>).__optimizerProbe
  })
})

describe('report shape and strict read-only proof', () => {
  test('full analysis returns all four categories and every finding has required data', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeClaudeCodeAgent(options(), harness(fs).deps)

    expect(report.schemaVersion).toBe(1)
    expect(report.readOnly).toBe(true)
    expect(report.agent).toEqual({ kind: 'claude-code', root: AGENT_ROOT })
    expect(Object.keys(report.categories).sort()).toEqual([
      'brokenMcp',
      'claudeMdRules',
      'contextRot',
      'startingContext',
    ])
    expect(report.summary.total).toBe(report.findings.length)
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
    expect(new Set(report.findings.map((item) => item.id)).size).toBe(
      report.findings.length,
    )
    expect(report.categories.startingContext.budget.total.chars).toBe(
      report.categories.startingContext.budget.claudeMd.chars +
        report.categories.startingContext.budget.mcpInstructions.chars +
        report.categories.startingContext.budget.memoryIndex.chars,
    )
    for (const item of report.findings) {
      expect(item.id.length).toBeGreaterThan(0)
      expect(['context-rot', 'starting-context', 'claude-md-rules', 'broken-mcp']).toContain(
        item.category,
      )
      expect(['info', 'warning', 'error']).toContain(item.severity)
      expect(item.explanation.length).toBeGreaterThan(0)
      expect(item.file.length).toBeGreaterThan(0)
      expect(Number.isInteger(item.line)).toBe(true)
      expect(item.line).toBeGreaterThan(0)
      expect(item.proposedChange).toBeObject()
      expect(item.proposedChange.kind.length).toBeGreaterThan(0)
      expect(JSON.stringify(item.proposedChange)).not.toContain('function')
      expect(['auto-apply', 'needs-approval', 'analyze-only']).toContain(
        item.classification,
      )
      expect(item.whySafe.length).toBeGreaterThan(0)
    }
  })

  test('mocked full run performs zero filesystem or process mutations', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs)
    const before = [...fs.files.entries()]
    const report = await analyzeClaudeCodeAgent(options(), h.deps)

    expect(report.readOnly).toBe(true)
    expect(fs.mutations).toEqual({
      writeFile: 0,
      appendFile: 0,
      mkdir: 0,
      unlink: 0,
      rename: 0,
    })
    expect(h.whichCalls).toEqual(['bun'])
    expect(h.networkCalls).toEqual([
      {
        url: 'https://backend.example/api/v1/service-options/health',
        method: 'GET',
      },
    ])
    expect([...fs.files.entries()]).toEqual(before)

    const source = readFileSync(
      new URL('../lib/optimizer/claude-analyzer.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/from ['"]node:fs['"]/)
    expect(source).not.toMatch(
      /\b(?:writeFile|appendFile|mkdir|unlink|rename|rm|rmdir|truncate|kill)(?:Sync)?\s*\(/,
    )
    expect(source).not.toContain('process.kill')
    expect(source).not.toContain("method: 'POST'")
    expect(source).not.toContain("method: 'PATCH'")
    expect(source).not.toContain("method: 'DELETE'")
    expect(source).not.toMatch(/from ['"]typescript['"]/)
  })

  test('credentials never cross the session or health dependency boundaries', async () => {
    const fs = new MockReadOnlyFs()
    const parsed = JSON.parse(validMcp())
    parsed.mcpServers.bgos.env.BGOS_PAIRING_TOKEN = 'pairing-secret-never-pass'
    fs.set(MCP_PATH, JSON.stringify(parsed))
    const h = harness(fs)
    const sessionEnvs: Array<Record<string, string | undefined>> = []
    let healthRequest: unknown = null

    const report = await analyzeClaudeCodeAgent(
      {
        ...options(),
        env: {
          CLAUDE_CODE_SESSION_ID: 'session-7',
          BGOS_TMUX_SESSION: 'agent-900',
        },
      },
      {
        ...h.deps,
        inspectSession: async (request) => {
          sessionEnvs.push(request.env)
          return DEFAULT_SESSION
        },
        httpGet: async (request) => {
          healthRequest = request
          return { status: 200, body: { service: 'up', database: 'up' } }
        },
      },
    )

    expect(sessionEnvs).toEqual([{ CLAUDE_CODE_SESSION_ID: 'session-7' }])
    expect(healthRequest).toEqual({
      url: 'https://backend.example/api/v1/service-options/health',
      method: 'GET',
    })
    const serializedBoundaries = JSON.stringify({ sessionEnvs, healthRequest })
    expect(serializedBoundaries).not.toContain(SECRET)
    expect(serializedBoundaries).not.toContain('pairing-secret-never-pass')
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(JSON.stringify(report)).not.toContain('pairing-secret-never-pass')
  })

  test('default binder, resting watcher, and cursor loader leave real fixture bytes unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'optimizer-readonly-'))
    const agentRoot = join(root, 'agent')
    const pluginRoot = join(root, 'plugin')
    const claudeHome = join(root, 'claude-home')
    const statePath = join(root, 'state', 'chat-cursors.json')
    const memoryPath = join(root, 'memory', 'MEMORY.md')
    const logPath = join(root, 'plugin.log')
    const projectDir = join(
      claudeHome,
      'projects',
      agentRoot.replace(/[^a-zA-Z0-9]/g, '-'),
    )
    mkdirSync(join(agentRoot, '.claude', 'rules'), { recursive: true })
    mkdirSync(pluginRoot, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(root, 'state'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(agentRoot, 'CLAUDE.md'), '# Fixture\n')
    writeFileSync(
      join(agentRoot, '.claude', 'rules', 'readme.md'),
      '---\npaths:\n  - "src/**"\n---\n# Rule\n',
    )
    writeFileSync(join(pluginRoot, 'server.ts'), SERVER_SOURCE)
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '0.29.0' }))
    writeFileSync(memoryPath, '# Memory\n')
    writeFileSync(statePath, JSON.stringify({ v: 1, cursors: { '1': 2 } }))
    writeFileSync(
      logPath,
      'Capability canon ready: v7 (4000 chars) [source=backend]\n',
    )
    writeFileSync(
      join(agentRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bgos: {
            command: 'bun',
            args: [join(pluginRoot, 'server.ts')],
            env: {
              BGOS_BACKEND_URL: 'https://backend.example/api/v1',
              BGOS_API_KEY: SECRET,
              BGOS_USER_ID: 'user-1',
              BGOS_ASSISTANT_ID: '900',
            },
          },
        },
      }),
    )
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-22T11:58:00.000Z',
        message: {
          model: 'claude-fable-5',
          usage: { input_tokens: 80_000 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-22T11:59:00.000Z',
        error: 'rate_limit',
        isApiErrorMessage: true,
        message: {
          model: '<synthetic>',
          content: [{ type: 'text', text: "You've hit your session limit" }],
        },
      }),
      '',
    ].join('\n')
    writeFileSync(join(projectDir, 'session.jsonl'), transcript)
    const before = snapshotTree(root)

    const report = await analyzeClaudeCodeAgent(
      {
        agentRoot,
        claudeHome,
        memoryIndexPath: memoryPath,
        cursorFilePath: statePath,
        pluginLogPath: logPath,
        nowMs: NOW_MS,
        env: {},
      },
      {
        which: async () => '/opt/bin/bun',
        httpGet: async () => ({
          status: 200,
          body: { service: 'up', database: 'up' },
        }),
        homeDir: root,
        tempDir: root,
      },
    )

    expect(report.categories.contextRot.contextPct).toBe(40)
    expect(report.categories.contextRot.resting.state).toBe('resting')
    expect(report.categories.startingContext.cursorStore.status).toBe('readable')
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(snapshotTree(root)).toEqual(before)
  })

  test('a fully degraded run returns findings instead of throwing', async () => {
    const fs = new MockReadOnlyFs({})
    const h = harness(fs, {
      whichError: new Error('which unavailable'),
      sessionError: new Error('transcript unavailable'),
      cursorError: new Error('cursor unavailable'),
      healthError: new Error('network unavailable'),
    })
    const report = await analyzeClaudeCodeAgent(options(), h.deps)
    expect(report.readOnly).toBe(true)
    expect(report.categories.contextRot.contextPct).toBeNull()
    expect(report.categories.brokenMcp.bun.found).toBe(false)
    expect(report.categories.brokenMcp.configStatus).toBe('missing')
    expect(report.findings.length).toBeGreaterThan(0)
  })
})
