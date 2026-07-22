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
  analyzeHermesAgent,
  HERMES_DEFAULT_SOUL_MD,
  type HermesAnalyzerOptions,
  type HermesAnalyzerReadOnlyFs,
  type HermesCommandRequest,
  type HermesCommandResult,
} from '../lib/optimizer/hermes-analyzer'
import type { Finding, FindingsReport } from '../lib/optimizer/types'

const AGENT_ROOT = '/workspace/agent'
const HERMES_HOME = '/home/test/.hermes'
const HERMES_BIN = '/home/test/.local/bin/hermes'
const BGOS_DOCTOR_BIN =
  '/home/test/.hermes/hermes-agent/venv/bin/hermes-bgos-doctor'
const CONFIG_PATH = join(HERMES_HOME, 'config.yaml')
const SOUL_PATH = join(HERMES_HOME, 'SOUL.md')
const MEMORY_PATH = join(HERMES_HOME, 'memories', 'MEMORY.md')
const USER_PATH = join(HERMES_HOME, 'memories', 'USER.md')
const NOW_MS = Date.parse('2026-07-22T12:00:00.000Z')
const SECRET = 'sentinel-secret-never-report'

function baseConfig(overrides: string = ''): string {
  return [
    'model:',
    '  default: test-large',
    '  context_length: 262144',
    'toolsets:',
    '  - terminal',
    '  - browser',
    'agent:',
    '  disabled_toolsets: []',
    'context:',
    '  engine: compressor',
    'compression:',
    '  threshold: 0.60',
    '  protect_last_n: 20',
    'memory:',
    '  memory_char_limit: 1000',
    '  user_char_limit: 700',
    'skills:',
    '  external_dirs: []',
    'mcp_servers: {}',
    overrides,
    '',
  ].join('\n')
}

function basePrompt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    platform: 'bgos',
    model: 'test-large',
    system_prompt: { chars: 15_000, bytes: 15_100 },
    skills_index: { chars: 2_000, bytes: 2_020 },
    memory: { chars: 500, bytes: 510 },
    user_profile: { chars: 300, bytes: 305 },
    tools: { count: 8, json_bytes: 4_000 },
    sections: [
      ['stable (identity/guidance/skills)', 12_000, 12_100],
      ['context (AGENTS.md/cwd files)', 500, 500],
      ['volatile (memory/profile/timestamp)', 2_500, 2_500],
    ],
    context_breakdown: {
      context_max: 262_144,
      context_percent: 40,
      context_used: 104_858,
      estimated_total: 104_858,
      _ineffective_compression_count: 0,
      categories: [
        { id: 'system_prompt', tokens: 3_000 },
        { id: 'conversation', tokens: 90_000 },
      ],
    },
    platform_hints: { bgos: { chars: 1_000, bytes: 1_020 } },
    usage: { unused_toolsets: [], unused_skills: [] },
    ...overrides,
  })
}

function okDoctor(): string {
  return JSON.stringify({
    checks: [{ name: 'python', status: 'OK', detail: 'Python available', fix: '' }],
  })
}

function okBgosDoctor(): string {
  return JSON.stringify({
    result: 'ok',
    checks: [
      { name: 'package', status: 'OK', detail: 'package available', fix: '' },
      { name: 'registration', status: 'OK', detail: 'registered', fix: '' },
      { name: 'config', status: 'OK', detail: 'token resolved', fix: '' },
      {
        name: 'auth',
        status: 'OK',
        detail: 'BGOS_ALLOW_ALL_USERS=true',
        fix: '',
      },
      { name: 'catalog', status: 'OK', detail: '1 configured', fix: '' },
      {
        name: 'pairing_live',
        status: 'OK',
        detail: 'paired; exposed: 42:default(Test)',
        fix: '',
      },
      { name: 'gateway_process', status: 'OK', detail: 'running', fix: '' },
    ],
  })
}

function baseFiles(): Record<string, string> {
  return {
    [CONFIG_PATH]: baseConfig(),
    [SOUL_PATH]: HERMES_DEFAULT_SOUL_MD,
    [MEMORY_PATH]: 'Remember project facts.\n',
    [USER_PATH]: 'User prefers concise answers.\n',
    [join(AGENT_ROOT, 'AGENTS.md')]: '# Agent rules\nUse the project tests.\n',
  }
}

class MockReadOnlyFs implements HermesAnalyzerReadOnlyFs {
  readonly files = new Map<string, string>()
  readonly denied = new Set<string>()
  readonly mutations = {
    writeFile: 0,
    appendFile: 0,
    mkdir: 0,
    unlink: 0,
    rename: 0,
    rm: 0,
    truncate: 0,
    copyFile: 0,
    cp: 0,
    open: 0,
    createWriteStream: 0,
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
    const text = this.files.get(key)
    if (text === undefined) throw fsError('ENOENT', key)
    return text
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

  rm(): void {
    this.mutations.rm += 1
  }

  truncate(): void {
    this.mutations.truncate += 1
  }

  copyFile(): void {
    this.mutations.copyFile += 1
  }

  cp(): void {
    this.mutations.cp += 1
  }

  open(): void {
    this.mutations.open += 1
  }

  createWriteStream(): void {
    this.mutations.createWriteStream += 1
  }
}

function fsError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${path}`), { code, path })
}

interface OutputOverrides {
  prompt?: string
  doctor?: string
  mcp?: string
  bgosDoctor?: string
  promptExit?: number
  doctorExit?: number
  mcpExit?: number
  bgosExit?: number
  reject?: string
  stderr?: string
}

function harness(
  fs: MockReadOnlyFs,
  overrides: OutputOverrides = {},
): {
  deps: {
    fs: MockReadOnlyFs
    runCommand: (request: HermesCommandRequest) => Promise<HermesCommandResult>
    homeDir: string
  }
  calls: HermesCommandRequest[]
} {
  const calls: HermesCommandRequest[] = []
  return {
    calls,
    deps: {
      fs,
      homeDir: '/home/test',
      runCommand: async (request) => {
        calls.push(request)
        const key = request.args.join(' ')
        if (overrides.reject === key) throw new Error('command unavailable')
        if (key === 'prompt-size --json') {
          return {
            stdout: overrides.prompt ?? basePrompt(),
            stderr: overrides.stderr ?? '',
            exitCode: overrides.promptExit ?? 0,
          }
        }
        if (key === 'doctor') {
          return {
            stdout: overrides.doctor ?? okDoctor(),
            stderr: overrides.stderr ?? '',
            exitCode: overrides.doctorExit ?? 0,
          }
        }
        if (key === 'mcp list') {
          return {
            stdout: overrides.mcp ?? 'No MCP servers configured.\n',
            stderr: overrides.stderr ?? '',
            exitCode: overrides.mcpExit ?? 0,
          }
        }
        if (key === '--json') {
          return {
            stdout: overrides.bgosDoctor ?? okBgosDoctor(),
            stderr: overrides.stderr ?? '',
            exitCode: overrides.bgosExit ?? 0,
          }
        }
        throw new Error(`unexpected command: ${request.executable} ${key}`)
      },
    },
  }
}

function options() {
  return {
    agentRoot: AGENT_ROOT,
    hermesHome: HERMES_HOME,
    nowMs: NOW_MS,
  }
}

function finding(report: FindingsReport, id: string): Finding {
  const item = report.findings.find(
    (candidate) => candidate.id === id || candidate.id.startsWith(`${id}:`),
  )
  expect(item, `missing finding ${id}`).toBeDefined()
  return item!
}

function hasFinding(report: FindingsReport, id: string): boolean {
  return report.findings.some(
    (candidate) => candidate.id === id || candidate.id.startsWith(`${id}:`),
  )
}

describe('Hermes context rot', () => {
  test('flags the strongest ineffective compression signal without a reset action', async () => {
    const fs = new MockReadOnlyFs()
    const prompt = JSON.parse(basePrompt())
    prompt.context_breakdown._ineffective_compression_count = 2
    prompt.context_breakdown.context_percent = 88
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )

    const item = finding(report, 'ineffective-compression')
    expect(item.severity).toBe('error')
    expect(item.classification).toBe('analyze-only')
    expect(item.proposedChange.operation).toBe('none')
    expect(item.proposedChange.data).toMatchObject({
      ineffectiveCompressionCount: 2,
    })
    expect(item.whySafe).toContain('session_id')
    expect(item.whySafe.toLowerCase()).toContain('irreversible')
    expect(JSON.stringify(item.proposedChange)).not.toContain('/reset')
  })

  test('does not flag one ineffective pass and warns on a small window plus memory cap', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      CONFIG_PATH,
      baseConfig().replace('context_length: 262144', 'context_length: 64000').replace(
        'memory_char_limit: 1000',
        'memory_char_limit: 2200',
      ),
    )
    const prompt = JSON.parse(basePrompt())
    prompt.context_breakdown.context_max = 64_000
    prompt.context_breakdown._ineffective_compression_count = 1
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )

    expect(hasFinding(report, 'ineffective-compression')).toBe(false)
    const item = finding(report, 'small-window-memory-pressure')
    expect(item.classification).toBe('needs-approval')
    expect(item.proposedChange.data).toMatchObject({
      contextWindowTokens: 64_000,
      memoryCharLimit: 2_200,
    })
  })

  test('approval-gates compressor threshold advice and preserves the recent tail', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(CONFIG_PATH, baseConfig().replace('threshold: 0.60', 'threshold: 0.45'))
    const report = await analyzeHermesAgent(options(), harness(fs).deps)

    const item = finding(report, 'compressor-threshold')
    expect(item.classification).toBe('needs-approval')
    expect(item.whySafe).toContain('/new')
    expect(item.whySafe).toContain('protect_last_n')
    expect(item.proposedChange.data).toMatchObject({ currentThreshold: 0.45 })
  })

  test('reviews the shipped 0.50 threshold and accepts separate live context evidence', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(CONFIG_PATH, baseConfig().replace('threshold: 0.60', 'threshold: 0.50'))
    const prompt = JSON.parse(basePrompt())
    delete prompt.context_breakdown
    const h = harness(fs, { prompt: JSON.stringify(prompt) })
    const report = await analyzeHermesAgent(options(), {
      ...h.deps,
      inspectContext: async () => ({
        context_max: 262_144,
        context_percent: 70,
        _ineffective_compression_count: 2,
      }),
    })

    expect(finding(report, 'compressor-threshold').proposedChange.data).toMatchObject({
      currentThreshold: 0.5,
    })
    expect(finding(report, 'ineffective-compression').proposedChange.data).toMatchObject({
      ineffectiveCompressionCount: 2,
    })
  })

  test('keeps missing live telemetry visible even when config declares a window', async () => {
    const fs = new MockReadOnlyFs()
    const prompt = JSON.parse(basePrompt())
    delete prompt.context_breakdown
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )
    expect(hasFinding(report, 'live-context-telemetry-unavailable')).toBe(true)
    expect(report.categories.contextRot.contextPct).toBeNull()
  })

  test('prefers the cached live session model over a fresh prompt measurement', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeHermesAgent(options(), {
      ...harness(fs).deps,
      inspectContext: async () => ({
        model: 'cached-small-model',
        context_max: 64_000,
        context_percent: 50,
      }),
    })

    expect(report.categories.contextRot.model).toBe('cached-small-model')
    expect(report.categories.contextRot.nominalWindowTokens).toBe(64_000)
  })
})

describe('Hermes starting context', () => {
  test('reports tiers and recommends only evidence-backed toolset and skill trimming', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      CONFIG_PATH,
      baseConfig().replace(
        '  external_dirs: []',
        '  external_dirs:\n    - /opt/hermes/legacy-skills',
      ),
    )
    const prompt = JSON.parse(basePrompt())
    prompt.skills_index = { chars: 9_000, bytes: 9_100 }
    prompt.platform_hints = { bgos: { chars: 4_200, bytes: 4_250 } }
    prompt.usage = {
      unused_toolsets: ['browser'],
      unused_skills: ['legacy-deploy'],
    }
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )

    const breakdown = finding(report, 'starting-context-breakdown')
    expect(breakdown.proposedChange.data).toMatchObject({
      stableChars: 12_000,
      contextChars: 500,
      volatileChars: 2_500,
      toolCount: 8,
      toolSchemaBytes: 4_000,
    })
    expect(finding(report, 'unused-toolsets').classification).toBe('needs-approval')
    expect(finding(report, 'unused-toolsets').proposedChange.description).toContain(
      'agent.disabled_toolsets',
    )
    expect(finding(report, 'unused-skills').proposedChange.description).toContain(
      'skills.external_dirs',
    )
    expect(finding(report, 'unused-skills').classification).toBe('needs-approval')
    const hint = finding(report, 'platform-hints-large')
    expect(hint.classification).toBe('needs-approval')
    expect(hint.whySafe).toContain('MEDIA:')
    expect(hint.whySafe).toContain('[[BGOS_BUTTONS]]')
    expect(hint.whySafe).toContain('approval')
    expect(hint.whySafe).toContain('reply-quote')
  })

  test('does not infer unused toolsets when no usage evidence exists', async () => {
    const fs = new MockReadOnlyFs()
    const prompt = JSON.parse(basePrompt())
    delete prompt.usage
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )
    expect(hasFinding(report, 'unused-toolsets')).toBe(false)
    expect(hasFinding(report, 'configured-toolset-unused')).toBe(false)
  })

  test('ignores explicit unused names that are not configured toolsets', async () => {
    const fs = new MockReadOnlyFs()
    const prompt = JSON.parse(basePrompt())
    prompt.usage.unused_toolsets = ['not-configured']
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )
    expect(hasFinding(report, 'unused-toolsets')).toBe(false)
    expect(hasFinding(report, 'configured-toolset-unused')).toBe(false)
  })

  test('accepts effective toolset evidence for tools expanded from a composite', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      CONFIG_PATH,
      baseConfig().replace('  - terminal\n  - browser', '  - hermes-cli'),
    )
    const prompt = JSON.parse(basePrompt())
    prompt.enabled_toolsets = ['terminal', 'browser']
    prompt.usage.unused_toolsets = ['browser']
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )
    expect(finding(report, 'unused-toolsets').proposedChange.data).toMatchObject({
      toolsets: ['browser'],
    })
  })

  test('reports BGOS platform hints as unmeasured for the exact real CLI schema', async () => {
    const fs = new MockReadOnlyFs()
    const prompt = JSON.parse(basePrompt())
    prompt.platform = 'cli'
    delete prompt.context_breakdown
    delete prompt.platform_hints
    delete prompt.usage
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )

    const item = finding(report, 'bgos-platform-hints-unmeasured')
    expect(item.classification).toBe('analyze-only')
    expect(item.proposedChange.operation).toBe('none')
    expect(hasFinding(report, 'platform-hints-large')).toBe(false)
  })

  test('does not propose external directory edits for unproven bundled skills', async () => {
    const fs = new MockReadOnlyFs()
    const prompt = JSON.parse(basePrompt())
    prompt.usage.unused_skills = ['bundled-skill']
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )

    const item = finding(report, 'unused-skills')
    expect(item.classification).toBe('analyze-only')
    expect(item.proposedChange.operation).toBe('none')
  })
})

describe('Hermes instruction surface', () => {
  test('detects the exact shipped SOUL as the highest-value analyze-only finding', async () => {
    expect(Buffer.byteLength(HERMES_DEFAULT_SOUL_MD, 'utf8')).toBe(513)
    const fs = new MockReadOnlyFs()
    const report = await analyzeHermesAgent(options(), harness(fs).deps)
    const item = finding(report, 'default-soul')

    expect(item.file).toBe(SOUL_PATH)
    expect(item.line).toBe(1)
    expect(item.classification).toBe('analyze-only')
    expect(item.proposedChange.operation).toBe('none')
    expect(item.whySafe.toLowerCase()).toContain('security scan')
    expect(item.whySafe.toLowerCase()).toContain('character cap')
    expect(item.whySafe).toContain('/new')
  })

  test('one customized byte suppresses the default SOUL finding', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(SOUL_PATH, `${HERMES_DEFAULT_SOUL_MD}!`)
    const report = await analyzeHermesAgent(options(), harness(fs).deps)
    expect(hasFinding(report, 'default-soul')).toBe(false)
  })

  test('detects the shipped legacy comment-only SOUL scaffold', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      SOUL_PATH,
      [
        '# Hermes Agent Persona',
        '',
        '<!--',
        'This file defines the agent\'s personality and tone.',
        'The agent will embody whatever you write here.',
        'Edit this to customize how Hermes communicates with you.',
        '',
        'This file is loaded fresh each message -- no restart needed.',
        'Delete the contents (or this file) to use the default personality.',
        '-->',
      ].join('\r\n'),
    )
    const report = await analyzeHermesAgent(options(), harness(fs).deps)
    expect(finding(report, 'default-soul').proposedChange.data).toMatchObject({
      legacyTemplate: true,
    })
  })

  test('flags MEMORY near its cap without including memory content', async () => {
    const fs = new MockReadOnlyFs()
    const privateMemory = `private-${SECRET}-${'x'.repeat(885)}`
    fs.set(MEMORY_PATH, privateMemory)
    const report = await analyzeHermesAgent(options(), harness(fs).deps)
    const item = finding(report, 'memory-near-cap')

    expect(item.file).toBe(MEMORY_PATH)
    expect(item.classification).toBe('needs-approval')
    expect(item.whySafe).toContain('/new')
    expect(JSON.stringify(item)).not.toContain(privateMemory)
    expect(JSON.stringify(item)).not.toContain(SECRET)
  })

  test('uses the shipped 2200 cap and counts Unicode code points like Hermes', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      CONFIG_PATH,
      baseConfig().replace('  memory_char_limit: 1000\n', ''),
    )
    fs.set(MEMORY_PATH, 'x'.repeat(1_980))
    const nearCap = await analyzeHermesAgent(options(), harness(fs).deps)
    expect(finding(nearCap, 'memory-near-cap').proposedChange.data).toMatchObject({
      currentChars: 1_980,
      memoryCharLimit: 2_200,
    })

    fs.set(MEMORY_PATH, '😀'.repeat(1_000))
    const codePoints = await analyzeHermesAgent(options(), harness(fs).deps)
    expect(hasFinding(codePoints, 'memory-near-cap')).toBe(false)
  })

  test('detects a CLAUDE fallback only when an intended AGENTS file is empty', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(join(AGENT_ROOT, 'AGENTS.md'), '')
    fs.set(join(AGENT_ROOT, 'CLAUDE.md'), '# Stray fallback\n')
    const report = await analyzeHermesAgent(options(), harness(fs).deps)
    expect(
      finding(report, 'claude-md-shadowing-intended-agents').classification,
    ).toBe('analyze-only')

    fs.set(join(AGENT_ROOT, 'AGENTS.md'), '# Intended rules\n')
    const healthy = await analyzeHermesAgent(options(), harness(fs).deps)
    expect(hasFinding(healthy, 'claude-md-shadowing-intended-agents')).toBe(false)
  })

  test('reports a nonempty CLAUDE file shadowed by higher-priority AGENTS rules', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(join(AGENT_ROOT, 'CLAUDE.md'), '# Stale alternate rules\n')
    const report = await analyzeHermesAgent(options(), harness(fs).deps)
    const item = finding(report, 'claude-md-shadowed-by-agents')
    expect(item.classification).toBe('analyze-only')
    expect(item.explanation).toContain('first-match')
  })

  test('uses the full project instruction precedence including case variants', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(join(AGENT_ROOT, '.hermes.md'), '# Hermes-specific rules\n')
    fs.set(join(AGENT_ROOT, 'CLAUDE.md'), '# Stale alternate rules\n')
    let report = await analyzeHermesAgent(options(), harness(fs).deps)
    expect(
      finding(report, 'claude-md-shadowed-by-higher-priority').proposedChange.data,
    ).toMatchObject({ activeFile: join(AGENT_ROOT, '.hermes.md') })

    fs.delete(join(AGENT_ROOT, '.hermes.md'))
    fs.set(join(AGENT_ROOT, 'AGENTS.md'), '')
    fs.set(join(AGENT_ROOT, 'agents.md'), '# Lowercase agent rules\n')
    report = await analyzeHermesAgent(options(), harness(fs).deps)
    expect(
      finding(report, 'claude-md-shadowed-by-higher-priority').proposedChange.data,
    ).toMatchObject({ activeFile: join(AGENT_ROOT, 'agents.md') })
    expect(hasFinding(report, 'claude-md-shadowing-intended-agents')).toBe(false)
  })

  test('inherits the nearest Hermes project file only up to the Git root', async () => {
    const fs = new MockReadOnlyFs()
    const nestedRoot = '/workspace/repo/packages/agent'
    fs.set('/workspace/repo/.git', 'gitdir: /workspace/repo-git\n')
    fs.set('/workspace/repo/.hermes.md', '# Inherited Hermes rules\n')
    fs.set(join(nestedRoot, 'CLAUDE.md'), '# Local Claude fallback\n')
    const report = await analyzeHermesAgent(
      { ...options(), agentRoot: nestedRoot },
      harness(fs).deps,
    )

    expect(
      finding(report, 'claude-md-shadowed-by-higher-priority').proposedChange.data,
    ).toMatchObject({ activeFile: '/workspace/repo/.hermes.md' })

    fs.delete('/workspace/repo/.hermes.md')
    fs.set('/workspace/.hermes.md', '# Must not cross the Git root\n')
    const bounded = await analyzeHermesAgent(
      { ...options(), agentRoot: nestedRoot },
      harness(fs).deps,
    )
    expect(hasFinding(bounded, 'claude-md-shadowed-by-higher-priority')).toBe(false)
  })
})

describe('Hermes broken MCP and tools', () => {
  test('surfaces BGOS WARN and FAIL checks with built-in fixes and caveats', async () => {
    const fs = new MockReadOnlyFs()
    const bgosDoctor = JSON.stringify({
      result: 'fail',
      checks: [
        {
          name: 'registration',
          status: 'FAIL',
          detail: 'in-process discovery did not register BGOS',
          fix: 'Run from the Hermes gateway environment.',
        },
        {
          name: 'auth',
          status: 'WARN',
          detail: 'neither BGOS_ALLOW_ALL_USERS nor BGOS_ALLOWED_USERS set',
          fix: 'Set an explicit inbound authorization policy.',
        },
        {
          name: 'pairing_live',
          status: 'WARN',
          detail: 'paired but 0 assistants exposed',
          fix: 'Expose an existing agent in BGOS Integrations.',
        },
      ],
    })
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { bgosDoctor, bgosExit: 1 }).deps,
    )

    const registration = finding(report, 'bgos-registration')
    expect(registration.severity).toBe('error')
    expect(registration.proposedChange.data).toMatchObject({
      check: 'registration',
      status: 'FAIL',
      fix: 'Run from the Hermes gateway environment.',
    })
    expect(registration.whySafe).toContain('false-fail')
    expect(registration.whySafe).toContain('gateway environment')
    expect(finding(report, 'bgos-auth-gate-unset').severity).toBe('warning')
    expect(finding(report, 'bgos-auth-gate-unset').explanation).toContain(
      'silently dropped',
    )
    expect(finding(report, 'bgos-no-assistants-exposed').classification).toBe(
      'analyze-only',
    )
    expect(report.categories.brokenMcp.health.status).toBe('unhealthy')
  })

  test('parses plain doctor warnings and MCP list without connecting', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      CONFIG_PATH,
      baseConfig(
        [
          'mcp_servers:',
          '  docs:',
          '    url: https://mcp.example.test',
          '    enabled: false',
        ].join('\n'),
      ).replace('mcp_servers: {}\n', ''),
    )
    const doctor = [
      'Hermes Doctor',
      '  [OK] Python Environment: ready',
      '  [WARN] Provider key missing',
      '    fix: Configure the provider key manually.',
    ].join('\n')
    const mcp = [
      'MCP Servers:',
      'Name             Transport                      Tools        Status',
      'docs             https://mcp.example.test       all          disabled',
    ].join('\n')
    const h = harness(fs, { doctor, mcp })
    const report = await analyzeHermesAgent(options(), h.deps)

    expect(finding(report, 'hermes-doctor-issue').proposedChange.data).toMatchObject({
      status: 'WARN',
      fix: 'Configure the provider key manually.',
    })
    expect(finding(report, 'mcp-server-disabled').classification).toBe(
      'needs-approval',
    )
    const calls = h.calls.map((call) => call.args.join(' ')).sort()
    expect(calls).toEqual(['--json', 'doctor', 'mcp list', 'prompt-size --json'])
  })

  test('configured but explicitly unused toolsets appear in tool health too', async () => {
    const fs = new MockReadOnlyFs()
    const prompt = JSON.parse(basePrompt())
    prompt.usage.unused_toolsets = ['browser']
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { prompt: JSON.stringify(prompt) }).deps,
    )
    const item = finding(report, 'configured-toolset-unused')
    expect(item.classification).toBe('needs-approval')
    expect(item.whySafe).toContain('cron')
    expect(item.whySafe).toContain('standalone')
  })

  test('surfaces structured MCP WARN output without running a connection test', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      CONFIG_PATH,
      baseConfig(
        [
          'mcp_servers:',
          '  docs:',
          '    url: https://mcp.example.test',
        ].join('\n'),
      ).replace('mcp_servers: {}\n', ''),
    )
    const mcp = JSON.stringify({
      servers: [
        {
          name: 'docs',
          enabled: true,
          status: 'WARN',
          detail: 'configuration is incomplete',
          fix: 'Review the docs server configuration.',
        },
      ],
    })
    const report = await analyzeHermesAgent(options(), harness(fs, { mcp }).deps)
    const item = finding(report, 'mcp-list-issue')
    expect(item.severity).toBe('warning')
    expect(item.proposedChange.data).toMatchObject({
      serverName: 'docs',
      status: 'WARN',
      fix: 'Review the docs server configuration.',
    })
  })

  test('captures numbered remediation from real hermes doctor text', async () => {
    const fs = new MockReadOnlyFs()
    const doctor = [
      'Hermes Doctor',
      '  ✓ Python 3.11',
      '  ⚠ Config version outdated (new settings available)',
      '',
      '  Found 1 issue(s) to address:',
      '',
      "  1. Run 'hermes doctor --fix' or 'hermes setup' to migrate config",
    ].join('\n')
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { doctor }).deps,
    )
    const item = finding(report, 'hermes-doctor-action')
    expect(item.proposedChange.data).toMatchObject({
      status: 'WARN',
      fix: "Run 'hermes doctor --fix' or 'hermes setup' to migrate config",
    })
  })
})

describe('Hermes report contract and strict read-only proof', () => {
  test('matches the shared FindingsReport shape and summary contract', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeHermesAgent(options(), harness(fs).deps)
    const typed: FindingsReport = report

    expect(typed.schemaVersion).toBe(1)
    expect(typed.readOnly).toBe(true)
    expect(typed.agent).toEqual({ kind: 'hermes', root: AGENT_ROOT })
    expect(typed.analyzedAt).toBe('2026-07-22T12:00:00.000Z')
    expect(Object.keys(typed.categories).sort()).toEqual([
      'brokenMcp',
      'claudeMdRules',
      'contextRot',
      'startingContext',
    ])
    expect(typed.summary.total).toBe(typed.findings.length)
    expect(JSON.parse(JSON.stringify(typed))).toEqual(typed)
    expect(new Set(typed.findings.map((item) => item.id)).size).toBe(
      typed.findings.length,
    )
    expect([
      ...typed.categories.contextRot.findings,
      ...typed.categories.startingContext.findings,
      ...typed.categories.claudeMdRules.findings,
      ...typed.categories.brokenMcp.findings,
    ]).toEqual(typed.findings)
    const budget = typed.categories.startingContext.budget
    expect(budget.total).toEqual({
      chars:
        budget.claudeMd.chars +
        budget.mcpInstructions.chars +
        budget.memoryIndex.chars,
      utf8Bytes:
        budget.claudeMd.utf8Bytes +
        budget.mcpInstructions.utf8Bytes +
        budget.memoryIndex.utf8Bytes,
      lines:
        budget.claudeMd.lines +
        budget.mcpInstructions.lines +
        budget.memoryIndex.lines,
      estimatedTokens: Math.ceil(
        (budget.claudeMd.chars +
          budget.mcpInstructions.chars +
          budget.memoryIndex.chars) /
          4,
      ),
    })
    expect(typed.categories.startingContext.cursorStore.status).toBe('unreadable')

    for (const item of typed.findings) {
      expect(item.id.length).toBeGreaterThan(0)
      expect(['context-rot', 'starting-context', 'claude-md-rules', 'broken-mcp']).toContain(
        item.category,
      )
      expect(['info', 'warning', 'error']).toContain(item.severity)
      expect(['auto-apply', 'needs-approval', 'analyze-only']).toContain(
        item.classification,
      )
      expect(item.file.startsWith('/')).toBe(true)
      expect(item.line).toBeGreaterThan(0)
      expect(item.explanation.length).toBeGreaterThan(0)
      expect(item.whySafe.length).toBeGreaterThan(0)
      expect(JSON.stringify(item.proposedChange)).not.toContain('undefined')
      expect(JSON.stringify(item.proposedChange)).not.toContain('function')
    }
  })

  test('degrades malformed and rejected diagnostics without throwing', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(CONFIG_PATH, ': malformed: [yaml')
    const h = harness(fs, {
      prompt: '{bad json',
      doctor: 'not structured output',
      mcp: 'not structured output',
      bgosDoctor: '{bad json',
      reject: 'doctor',
    })
    const report = await analyzeHermesAgent(options(), h.deps)

    expect(report.readOnly).toBe(true)
    expect(report.categories.brokenMcp.configStatus).toBe('malformed')
    expect(hasFinding(report, 'hermes-config-malformed')).toBe(true)
    expect(report.categories.brokenMcp.health.status).toBe('unhealthy')
    expect(hasFinding(report, 'prompt-size-unavailable')).toBe(true)
    expect(hasFinding(report, 'hermes-doctor-unavailable')).toBe(true)
    expect(hasFinding(report, 'bgos-doctor-unavailable')).toBe(true)
    expect(hasFinding(report, 'mcp-list-unavailable')).toBe(true)
  })

  test('redacts secrets from config and diagnostic boundaries', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      CONFIG_PATH,
      `${baseConfig()}\nprovider_api_key: ${SECRET}\nmcp_servers:\n  private:\n    headers:\n      Authorization: Bearer ${SECRET}\n`,
    )
    const doctor = JSON.stringify({
      checks: [
        {
          name: 'provider',
          status: 'WARN',
          detail: `token=${SECRET}`,
          fix: `password=${SECRET}`,
        },
      ],
    })
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, { doctor, stderr: SECRET }).deps,
    )
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  test('rejects structurally empty prompt and diagnostic JSON', async () => {
    const fs = new MockReadOnlyFs()
    const invalidPrompt = JSON.parse(basePrompt())
    invalidPrompt.system_prompt = {}
    const report = await analyzeHermesAgent(
      options(),
      harness(fs, {
        prompt: JSON.stringify(invalidPrompt),
        doctor: '{"checks":[]}',
        bgosDoctor: '{"checks":[]}',
      }).deps,
    )
    expect(hasFinding(report, 'prompt-size-unavailable')).toBe(true)
    expect(hasFinding(report, 'hermes-doctor-unavailable')).toBe(true)
    expect(hasFinding(report, 'bgos-doctor-unavailable')).toBe(true)
  })

  test('full run invokes only the four allowed commands and performs zero writes', async () => {
    const fs = new MockReadOnlyFs()
    const before = [...fs.files.entries()]
    const h = harness(fs)
    const report = await analyzeHermesAgent(options(), h.deps)

    expect(report.readOnly).toBe(true)
    expect(fs.mutations).toEqual({
      writeFile: 0,
      appendFile: 0,
      mkdir: 0,
      unlink: 0,
      rename: 0,
      rm: 0,
      truncate: 0,
      copyFile: 0,
      cp: 0,
      open: 0,
      createWriteStream: 0,
    })
    expect([...fs.files.entries()]).toEqual(before)
    expect(
      h.calls
        .map((call) => `${call.executable}\0${call.args.join('\0')}`)
        .sort(),
    ).toEqual(
      [
        `${BGOS_DOCTOR_BIN}\0--json`,
        `${HERMES_BIN}\0doctor`,
        `${HERMES_BIN}\0mcp\0list`,
        `${HERMES_BIN}\0prompt-size\0--json`,
      ].sort(),
    )
    for (const call of h.calls) {
      expect(call.env).toEqual({ HERMES_HOME })
    }
    const invoked = h.calls.map((call) => call.args.join(' ')).join('\n')
    expect(invoked).not.toMatch(/mcp\s+(?:test|reauth)/)
    expect(invoked).not.toMatch(/doctor\s+--fix/)
    expect(invoked).not.toMatch(/mcp\s+(?:add|remove|configure)/)
    expect(invoked).not.toMatch(/(?:^|\s)(?:reset|write|set|edit|delete)(?:\s|$)/)

    const source = readFileSync(
      new URL('../lib/optimizer/hermes-analyzer.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain(
      "import { readFile as nodeReadFile } from 'node:fs/promises'",
    )
    expect(source).not.toContain("from 'node:fs'")
    expect(source).not.toMatch(
      /\b(?:writeFile|appendFile|mkdir|unlink|rename|rm|rmdir|truncate|chmod|copyFile|cp|open|createWriteStream)(?:Sync)?\s*\(/,
    )
    expect(source).not.toContain('Bun.write')
    expect(source).not.toContain('shell: true')
    expect(source).not.toMatch(/[\u2013\u2014]/)
  })

  test('does not let analysis options replace the fixed Hermes executables', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs)
    const untrustedOptions = {
      ...options(),
      hermesExecutable: '/tmp/hermes',
      bgosDoctorExecutable: '/tmp/hermes-bgos-doctor',
    } as unknown as HermesAnalyzerOptions
    await analyzeHermesAgent(untrustedOptions, h.deps)

    expect(new Set(h.calls.map((call) => call.executable))).toEqual(
      new Set([HERMES_BIN, BGOS_DOCTOR_BIN]),
    )
  })

  test('default filesystem reads leave a real fixture tree byte-for-byte unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'optimizer-hermes-readonly-'))
    const agentRoot = join(root, 'agent')
    const hermesHome = join(root, '.hermes')
    mkdirSync(join(hermesHome, 'memories'), { recursive: true })
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(hermesHome, 'config.yaml'), baseConfig())
    writeFileSync(join(hermesHome, 'SOUL.md'), HERMES_DEFAULT_SOUL_MD)
    writeFileSync(join(hermesHome, 'memories', 'MEMORY.md'), 'fixture memory\n')
    writeFileSync(join(hermesHome, 'memories', 'USER.md'), 'fixture user\n')
    writeFileSync(join(agentRoot, 'AGENTS.md'), '# Fixture rules\n')
    const before = snapshotTree(root)
    const commandHarness = harness(new MockReadOnlyFs())

    await analyzeHermesAgent(
      {
        agentRoot,
        hermesHome,
        nowMs: NOW_MS,
      },
      { runCommand: commandHarness.deps.runCommand, homeDir: root },
    )

    expect(snapshotTree(root)).toEqual(before)
  })
})

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
