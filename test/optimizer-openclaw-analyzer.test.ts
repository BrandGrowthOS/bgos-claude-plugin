import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
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
  analyzeOpenClawAgent,
  computeOpenClawContextPct,
  openClawContextWindowForModel,
  type OpenClawAnalyzerOptions,
  type OpenClawAnalyzerReadOnlyFs,
  type OpenClawCommandRequest,
  type OpenClawCommandResult,
} from '../lib/optimizer/openclaw-analyzer'
import type { Finding, FindingsReport } from '../lib/optimizer/types'

const AGENT_ROOT = '/workspace/openclaw-agent'
const OPENCLAW_HOME = '/home/test/.openclaw'
const CONFIG_PATH = join(OPENCLAW_HOME, 'secrets', 'bgos.json')
const PEERS_TOKEN_PATH = join(OPENCLAW_HOME, 'secrets', 'bgos-peers-token')
const UPDATE_STATE_PATH = join(
  OPENCLAW_HOME,
  'state',
  'bgos-auto-update.json',
)
const CURSOR_PATH = join(OPENCLAW_HOME, 'state', 'bgos-cursor.json')
const LOG_PATH = join(OPENCLAW_HOME, 'state', 'bgos-daemon.log')
const DOCTOR_BIN = 'bgos-openclaw-daemon'
const NOW_MS = Date.parse('2026-07-22T12:00:00.000Z')
const SECRET = 'openclaw-secret-never-report'

function baseConfig(): string {
  return JSON.stringify({
    baseUrl: 'https://api.example.test',
    pairingToken: SECRET,
    gatewayUrl: 'http://127.0.0.1:31847',
    gatewayToken: 'gateway-secret-never-report',
  })
}

function baseState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    earlyCrashCount: 0,
    disabledAfterRollback: false,
    resetObserved: false,
    ...overrides,
  })
}

function baseFiles(): Record<string, string> {
  return {
    [CONFIG_PATH]: baseConfig(),
    [UPDATE_STATE_PATH]: baseState(),
    [CURSOR_PATH]: JSON.stringify({
      version: 2,
      lastEventId: 120,
      contextMessageIds: { '44': 119 },
    }),
    [LOG_PATH]: [
      '[bgos-daemon] openclaw capabilities {"dispatchPath":"gateway"}',
      '[bgos-daemon] fetched served capability canon {"version":18,"chars":16384,"source":"backend"}',
      '',
    ].join('\n'),
    [PEERS_TOKEN_PATH]: 'peer-secret-never-read',
  }
}

function baseRuntime(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contextPct: 61,
    promptTokens: 122_000,
    model: 'claude-sonnet-test',
    contextWindowTokens: 200_000,
    durableGatewaySession: true,
    dispatchPath: 'gateway',
    hintChars: 16_000,
    hintBytes: 16_384,
    hintLines: 400,
    hostWiredHints: false,
    canonSource: 'backend',
    servedCanonVersion: 18,
    bundledCanonVersion: 18,
    canonMarkersValid: true,
    peersTokenWired: true,
    ...overrides,
  }
}

function passDoctor(): string {
  return JSON.stringify({
    status: 'pass',
    checks: [
      {
        name: 'token-file perms',
        status: 'pass',
        detail: CONFIG_PATH + ' is 0600',
      },
      {
        name: 'secrets-dir perms',
        status: 'pass',
        detail: join(OPENCLAW_HOME, 'secrets') + ' is 0700',
      },
      {
        name: 'keepalive (restart survival)',
        status: 'pass',
        detail: 'keepalive is loaded',
      },
    ],
  })
}

interface MockStats {
  isFile(): boolean
  isDirectory(): boolean
  mode: number
}

class MockReadOnlyFs implements OpenClawAnalyzerReadOnlyFs {
  readonly files = new Map<string, string>()
  readonly denied = new Set<string>()
  readonly modes = new Map<string, number>()
  readonly reads: string[] = []
  readonly stats: string[] = []
  readonly mutations = {
    writeFile: 0,
    appendFile: 0,
    mkdir: 0,
    unlink: 0,
    rename: 0,
    rm: 0,
    truncate: 0,
    chmod: 0,
    copyFile: 0,
    cp: 0,
    open: 0,
    createWriteStream: 0,
  }

  constructor(files: Record<string, string> = baseFiles()) {
    for (const [path, text] of Object.entries(files)) {
      this.files.set(normalize(path), text)
    }
    this.modes.set(normalize(CONFIG_PATH), 0o100600)
    this.modes.set(normalize(PEERS_TOKEN_PATH), 0o100600)
  }

  set(path: string, text: string): void {
    this.files.set(normalize(path), text)
  }

  delete(path: string): void {
    this.files.delete(normalize(path))
  }

  async readFile(path: string): Promise<string> {
    const key = normalize(path)
    this.reads.push(key)
    if (this.denied.has(key)) throw fsError('EACCES', key)
    const text = this.files.get(key)
    if (text === undefined) throw fsError('ENOENT', key)
    return text
  }

  async stat(path: string): Promise<MockStats> {
    const key = normalize(path)
    this.stats.push(key)
    if (this.denied.has(key)) throw fsError('EACCES', key)
    if (this.files.has(key)) {
      return {
        isFile: () => true,
        isDirectory: () => false,
        mode: this.modes.get(key) ?? 0o100600,
      }
    }
    const prefix = key + '/'
    if ([...this.files.keys()].some((file) => file.startsWith(prefix))) {
      return {
        isFile: () => false,
        isDirectory: () => true,
        mode: 0o40700,
      }
    }
    throw fsError('ENOENT', key)
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

  chmod(): void {
    this.mutations.chmod += 1
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
  return Object.assign(new Error(code + ': ' + path), { code, path })
}

interface HarnessOverrides {
  help?: string
  helpExit?: number
  helpError?: Error
  doctor?: string
  doctorExit?: number
  doctorError?: Error
  stderr?: string
  runtime?: unknown
  runtimeError?: Error
}

function harness(
  fs: MockReadOnlyFs,
  overrides: HarnessOverrides = {},
): {
  deps: {
    fs: MockReadOnlyFs
    runCommand: (
      request: OpenClawCommandRequest,
    ) => Promise<OpenClawCommandResult>
    inspectRuntime: () => Promise<unknown>
    homeDir: string
  }
  calls: OpenClawCommandRequest[]
} {
  const calls: OpenClawCommandRequest[] = []
  return {
    calls,
    deps: {
      fs,
      homeDir: '/home/test',
      runCommand: async (request) => {
        calls.push(request)
        if (request.args.join(' ') === '--help') {
          if (overrides.helpError) throw overrides.helpError
          return {
            stdout:
              overrides.help ??
              'Usage: bgos-openclaw-daemon [options]\n  --doctor  Run health checks and exit\n',
            stderr: overrides.stderr ?? '',
            exitCode: overrides.helpExit ?? 0,
          }
        }
        if (request.args.join(' ') !== '--doctor') {
          throw new Error('unexpected command: ' + request.args.join(' '))
        }
        if (overrides.doctorError) throw overrides.doctorError
        return {
          stdout: overrides.doctor ?? passDoctor(),
          stderr: overrides.stderr ?? '',
          exitCode: overrides.doctorExit ?? 0,
        }
      },
      inspectRuntime: async () => {
        if (overrides.runtimeError) throw overrides.runtimeError
        return overrides.runtime ?? baseRuntime()
      },
    },
  }
}

function options(overrides: Partial<OpenClawAnalyzerOptions> = {}) {
  return {
    agentRoot: AGENT_ROOT,
    openclawHome: OPENCLAW_HOME,
    configPath: CONFIG_PATH,
    updateStatePath: UPDATE_STATE_PATH,
    cursorFilePath: CURSOR_PATH,
    daemonLogPath: LOG_PATH,
    env: {
      OPENCLAW_HISTORY_LIMIT: '50',
      OPENCLAW_CONTEXT_WINDOW: '200000',
      BGOS_DISABLE_AUTO_HINTS: '0',
      BGOS_PEERS_AUTH_TOKEN: 'pinned-but-never-reported',
      BGOS_PEERS_REQUIRE_AUTH: '1',
      BGOS_AUTO_UPDATE: 'on',
    },
    nowMs: NOW_MS,
    ...overrides,
  }
}

function finding(report: FindingsReport, id: string): Finding {
  const item = report.findings.find(
    (candidate) => candidate.id === id || candidate.id.startsWith(id + ':'),
  )
  expect(item, 'missing finding ' + id).toBeDefined()
  return item!
}

function hasFinding(report: FindingsReport, id: string): boolean {
  return report.findings.some(
    (candidate) => candidate.id === id || candidate.id.startsWith(id + ':'),
  )
}

describe('OpenClaw context rot', () => {
  test('uses the coarse OpenClaw context calculation and model map', () => {
    expect(computeOpenClawContextPct(100_000, 200_000)).toBe(50)
    expect(computeOpenClawContextPct(250_000, 200_000)).toBe(100)
    expect(computeOpenClawContextPct(-1, 200_000)).toBeNull()
    expect(
      openClawContextWindowForModel('gpt-4.1-mini', {}),
    ).toBe(1_000_000)
    expect(
      openClawContextWindowForModel('unknown-model', {
        OPENCLAW_CONTEXT_WINDOW: '64000',
      }),
    ).toBe(64_000)
  })

  test('surfaces high context and both stores without invoking a reset', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs, {
      runtime: baseRuntime({
        contextPct: 87,
        promptTokens: 174_000,
        durableGatewaySession: true,
      }),
    })
    const report = await analyzeOpenClawAgent(options(), h.deps)

    expect(report.categories.contextRot.contextPct).toBe(87)
    const dual = finding(report, 'openclaw-dual-context-store')
    expect(dual.classification).toBe('analyze-only')
    expect(dual.proposedChange.operation).toBe('none')
    expect(dual.proposedChange.data).toMatchObject({
      daemonReplayRowCap: 50,
      durableGatewaySession: true,
    })
    const halfReset = finding(report, 'openclaw-new-half-reset')
    expect(halfReset.classification).toBe('analyze-only')
    expect(halfReset.whySafe).toContain('opaque gateway session')
    const high = finding(report, 'openclaw-context-pressure')
    expect(high.proposedChange.operation).toBe('none')
    expect(high.proposedChange.data).toMatchObject({ contextPct: 87, coarse: true })

    const invoked = h.calls.map((call) => call.args.join(' ')).join('\n')
    expect(invoked).not.toMatch(/(?:^|\s)\/new(?:\s|$)/)
    expect(invoked).not.toMatch(/reset|clear/i)
  })

  test('flags measured replay pressure and never raises history', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs, {
      runtime: baseRuntime({
        contextPct: 90,
        promptTokens: 57_600,
        contextWindowTokens: 64_000,
        replayedHistoryTokens: 50_000,
      }),
    })
    const report = await analyzeOpenClawAgent(
      options({
        env: {
          OPENCLAW_HISTORY_LIMIT: '50',
          OPENCLAW_CONTEXT_WINDOW: '64000',
        },
      }),
      h.deps,
    )

    const item = finding(report, 'openclaw-history-window-mismatch')
    expect(item.classification).toBe('needs-approval')
    expect(item.proposedChange.data).toMatchObject({
      historyLimit: 50,
      contextWindowTokens: 64_000,
      retainedRowCap: 50,
      measuredTokenPressure: true,
      coarse: false,
    })
    expect(item.whySafe).toContain('never raises OPENCLAW_HISTORY_LIMIT')
  })

  test('models zero history limit as replaying every retained row', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options({
        env: {
          OPENCLAW_HISTORY_LIMIT: '0',
          OPENCLAW_CONTEXT_WINDOW: '200000',
        },
      }),
      harness(fs).deps,
    )

    expect(
      finding(report, 'openclaw-dual-context-store').proposedChange.data,
    ).toMatchObject({ daemonReplayRowCap: 50 })
    const zero = finding(report, 'openclaw-history-zero-replays-all')
    expect(zero.severity).toBe('warning')
    expect(zero.classification).toBe('needs-approval')
    expect(zero.proposedChange.data).toMatchObject({
      configuredHistoryLimit: 0,
      effectiveReplayRowCap: 50,
    })
    expect(hasFinding(report, 'openclaw-history-limit-invalid')).toBe(false)
  })

  test('keeps effective replay rows unknown for an invalid history limit', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options({ env: { OPENCLAW_HISTORY_LIMIT: '-1' } }),
      harness(fs).deps,
    )

    expect(
      finding(report, 'openclaw-dual-context-store').proposedChange.data,
    ).toMatchObject({ daemonReplayRowCap: null })
    expect(hasFinding(report, 'openclaw-history-limit-invalid')).toBe(true)
  })

  test('does not claim the opaque session is present without evidence', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        runtime: baseRuntime({ durableGatewaySession: undefined }),
      }).deps,
    )

    expect(hasFinding(report, 'openclaw-new-half-reset')).toBe(false)
    expect(
      finding(report, 'openclaw-dual-context-store').proposedChange.data,
    ).toMatchObject({ durableGatewaySession: null })
  })
})

describe('OpenClaw starting context', () => {
  test('measures the re-billed hint block as the shared starting budget', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(options(), harness(fs).deps)
    const start = report.categories.startingContext

    expect(start.budget.claudeMd.exists).toBe(false)
    expect(start.budget.mcpInstructions).toMatchObject({
      chars: 16_000,
      utf8Bytes: 16_384,
      lines: 400,
    })
    expect(start.mcpInstructionsSourceChars).toBe(16_000)
    expect(start.canonSource).toBe('backend')
    const item = finding(report, 'openclaw-hints-rebilled-per-turn')
    expect(item.classification).toBe('analyze-only')
    expect(item.proposedChange.data).toMatchObject({
      hintBytes: 16_384,
      statelessDispatch: true,
      everyTurn: true,
    })
    expect(item.whySafe).toContain('never strips hint sections')
  })

  test('recommends disabling auto hints only with host-wiring evidence', async () => {
    const fs = new MockReadOnlyFs()
    const hostWired = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        runtime: baseRuntime({ hostWiredHints: true }),
      }).deps,
    )
    const item = finding(hostWired, 'openclaw-host-wired-auto-hints')
    expect(item.classification).toBe('needs-approval')
    expect(item.proposedChange.operation).toBe('manual-action')
    expect(item.proposedChange.data).toMatchObject({
      envKey: 'BGOS_DISABLE_AUTO_HINTS',
      proposedValue: '1',
      hostWired: true,
    })

    const unproven = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        runtime: baseRuntime({ hostWiredHints: undefined }),
      }).deps,
    )
    expect(hasFinding(unproven, 'openclaw-host-wired-auto-hints')).toBe(false)
  })

  test('reports disabled hints without host wiring as capability risk', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options({ env: { BGOS_DISABLE_AUTO_HINTS: '1' } }),
      harness(fs, {
        runtime: baseRuntime({ hostWiredHints: false }),
      }).deps,
    )
    const item = finding(report, 'openclaw-hints-disabled-without-host-wiring')
    expect(item.severity).toBe('error')
    expect(item.classification).toBe('analyze-only')
    expect(item.proposedChange.operation).toBe('none')
  })

  test('reports measured host hints even when daemon auto hints are disabled', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options({ env: { BGOS_DISABLE_AUTO_HINTS: '1' } }),
      harness(fs, {
        runtime: baseRuntime({ hostWiredHints: true }),
      }).deps,
    )

    expect(hasFinding(report, 'openclaw-hints-rebilled-per-turn')).toBe(true)
    expect(hasFinding(report, 'openclaw-host-wired-auto-hints')).toBe(false)
  })

  test('does not invent the approximate hint size when telemetry is absent', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      LOG_PATH,
      '[bgos-daemon] openclaw capabilities {"dispatchPath":"gateway"}\n',
    )
    const report = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        runtime: baseRuntime({
          hintChars: undefined,
          hintBytes: undefined,
          hintLines: undefined,
        }),
      }).deps,
    )

    expect(report.categories.startingContext.budget.mcpInstructions).toMatchObject({
      exists: false,
      chars: 0,
      utf8Bytes: 0,
      lines: 0,
    })
    expect(hasFinding(report, 'openclaw-hints-unmeasured')).toBe(true)
    expect(JSON.stringify(report)).not.toContain('16384')
  })
})

describe('OpenClaw instruction surface', () => {
  test('states the gateway prompt boundary and does not invent CLAUDE.md', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(options(), harness(fs).deps)
    const instruction = report.categories.claudeMdRules

    expect(instruction.deadReferences).toEqual([])
    expect(instruction.ruleBlocks).toEqual([])
    expect(instruction.files).toHaveLength(1)
    expect(instruction.files[0]).toMatchObject({
      path: join(AGENT_ROOT, 'CLAUDE.md'),
      exists: false,
      kind: 'claude-md',
      frontmatter: 'not-applicable',
    })
    const absent = finding(report, 'openclaw-no-claude-md')
    expect(absent.severity).toBe('info')
    expect(absent.explanation).toContain('not an OpenClaw instruction surface')
    const opaque = finding(report, 'openclaw-gateway-prompt-opaque')
    expect(opaque.classification).toBe('analyze-only')
    expect(opaque.proposedChange.operation).toBe('none')
    expect(opaque.explanation).toContain('cannot read or edit')
    expect(opaque.whySafe).toContain('no complete instruction-surface claim')
  })

  test('flags canon drift while preserving the size and marker gates', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      LOG_PATH,
      '[bgos-daemon] capability canon fetch failed (using bundled fallback)\n',
    )
    const report = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        runtime: baseRuntime({
          canonSource: 'bundled',
          servedCanonVersion: 19,
          bundledCanonVersion: 18,
        }),
      }).deps,
    )

    expect(report.categories.startingContext.canonSource).toBe('bundled')
    expect(report.categories.brokenMcp.canonSource).toBe('bundled')
    const drift = finding(report, 'openclaw-canon-drift')
    expect(drift.classification).toBe('needs-approval')
    expect(drift.proposedChange.data).toMatchObject({
      servedVersion: '19',
      bundledVersion: '18',
      maxCanonBytes: 262_144,
      requiredMarkers: ['BGOS Channel', 'Agent Capabilities'],
    })
    expect(drift.whySafe).toContain('256 KB')
    expect(drift.whySafe).toContain('exact markers')
  })

  test('treats failed canon markers as analyze-only fallback evidence', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      LOG_PATH,
      '[bgos-daemon] served capability canon empty or rejected, using bundled fallback\n',
    )
    const report = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        runtime: baseRuntime({
          canonSource: 'bundled',
          canonMarkersValid: false,
        }),
      }).deps,
    )
    const item = finding(report, 'openclaw-canon-marker-gate')
    expect(item.severity).toBe('warning')
    expect(item.classification).toBe('analyze-only')
    expect(item.proposedChange.operation).toBe('none')
    expect(item.whySafe).toContain('frozen')
  })

  test('keeps an oversized served canon behind the 256 KB gate', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        runtime: baseRuntime({
          canonSource: 'bundled',
          servedCanonChars: 262_145,
          canonMarkersValid: true,
        }),
      }).deps,
    )

    const item = finding(report, 'openclaw-canon-marker-gate')
    expect(item.severity).toBe('warning')
    expect(item.proposedChange.data).toMatchObject({
      maxCanonBytes: 262_144,
      observedServedCanonChars: 262_145,
      overLimit: true,
    })
    expect(item.proposedChange.operation).toBe('none')
  })
})

describe('OpenClaw broken tools and integrations', () => {
  test('parses token, secrets, and keepalive doctor checks without applying fixes', async () => {
    const fs = new MockReadOnlyFs()
    const doctor = [
      'bgos-openclaw-daemon doctor',
      '',
      '  [FAIL] token-file perms: ' + CONFIG_PATH + ' is 0644; want 0600',
      '  [WARN] secrets-dir perms: ' +
        join(OPENCLAW_HOME, 'secrets') +
        ' is 0755; want 0700',
      '  [WARN] keepalive (restart survival): No BGOS keepalive unit is loaded.',
      '',
      'Overall: FAIL',
    ].join('\n')
    const h = harness(fs, { doctor, doctorExit: 1 })
    const report = await analyzeOpenClawAgent(options(), h.deps)

    const token = finding(report, 'openclaw-token-permissions')
    expect(token.severity).toBe('error')
    expect(token.classification).toBe('needs-approval')
    expect(token.whySafe).toContain('live token')
    const secrets = finding(report, 'openclaw-secrets-permissions')
    expect(secrets.severity).toBe('warning')
    expect(secrets.classification).toBe('needs-approval')
    const keepalive = finding(report, 'openclaw-keepalive-not-loaded')
    expect(keepalive.classification).toBe('needs-approval')
    expect(keepalive.proposedChange.operation).toBe('manual-action')
    expect(report.categories.brokenMcp.health.status).toBe('unhealthy')

    expect(h.calls).toEqual([
      {
        executable: DOCTOR_BIN,
        args: ['--help'],
        cwd: AGENT_ROOT,
        env: {},
      },
      {
        executable: DOCTOR_BIN,
        args: ['--doctor'],
        cwd: AGENT_ROOT,
        env: {},
      },
    ])
  })

  test('parses a top-level structured DoctorCheck array', async () => {
    const fs = new MockReadOnlyFs()
    const doctor = JSON.stringify([
      {
        name: 'token-file perms',
        status: 'warn',
        detail: CONFIG_PATH + ' is 0640; want 0600',
      },
      {
        name: 'keepalive (restart survival)',
        status: 'pass',
        detail: 'keepalive is loaded',
      },
    ])
    const report = await analyzeOpenClawAgent(
      options(),
      harness(fs, { doctor }).deps,
    )

    expect(finding(report, 'openclaw-token-permissions').severity).toBe(
      'warning',
    )
    expect(hasFinding(report, 'openclaw-doctor-unavailable')).toBe(false)
  })

  test('dispatchPath none is fully broken and no MCP is expected', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        runtime: baseRuntime({ dispatchPath: 'none' }),
      }).deps,
    )
    const broken = finding(report, 'openclaw-dispatch-none')
    expect(broken.severity).toBe('error')
    expect(broken.classification).toBe('needs-approval')
    expect(broken.proposedChange.data).toEqual({ dispatchPath: 'none' })
    const noMcp = finding(report, 'openclaw-no-mcp')
    expect(noMcp.severity).toBe('info')
    expect(noMcp.classification).toBe('analyze-only')
    expect(noMcp.explanation).toContain('does not use MCP servers')
    expect(report.categories.brokenMcp.serverName).toBeNull()
    expect(report.categories.brokenMcp.health.status).toBe('unhealthy')
  })

  test('reports missing peers wiring without reading the token file body', async () => {
    const fs = new MockReadOnlyFs()
    fs.delete(PEERS_TOKEN_PATH)
    const report = await analyzeOpenClawAgent(
      options({
        env: {
          BGOS_PEERS_REQUIRE_AUTH: '1',
          BGOS_PEERS_AUTH_TOKEN: undefined,
        },
      }),
      harness(fs, {
        runtime: baseRuntime({ peersTokenWired: undefined }),
      }).deps,
    )
    const item = finding(report, 'openclaw-peers-token-missing')
    expect(item.severity).toBe('error')
    expect(item.classification).toBe('needs-approval')
    expect(item.explanation).toContain('401')
    expect(item.whySafe).toContain('does not read or print')
    expect(fs.reads).not.toContain(normalize(PEERS_TOKEN_PATH))
    expect(fs.stats).toContain(normalize(PEERS_TOKEN_PATH))
  })

  test('keeps inaccessible peers wiring unknown and reports explicit auth opt-out', async () => {
    const deniedFs = new MockReadOnlyFs()
    deniedFs.denied.add(normalize(PEERS_TOKEN_PATH))
    const unknown = await analyzeOpenClawAgent(
      options({
        env: {
          BGOS_PEERS_REQUIRE_AUTH: '1',
          BGOS_PEERS_AUTH_TOKEN: undefined,
        },
      }),
      harness(deniedFs, {
        runtime: baseRuntime({ peersTokenWired: undefined }),
      }).deps,
    )
    expect(hasFinding(unknown, 'openclaw-peers-token-unknown')).toBe(true)
    expect(hasFinding(unknown, 'openclaw-peers-token-missing')).toBe(false)

    const disabledFs = new MockReadOnlyFs()
    const disabled = await analyzeOpenClawAgent(
      options({ env: { BGOS_PEERS_REQUIRE_AUTH: '0' } }),
      harness(disabledFs, {
        runtime: baseRuntime({ peersTokenWired: undefined }),
      }).deps,
    )
    expect(hasFinding(disabled, 'openclaw-peers-auth-disabled')).toBe(true)
    expect(hasFinding(disabled, 'openclaw-peers-token-missing')).toBe(false)
  })

  test('keeps env-only peers wiring unknown without shared-process proof', async () => {
    const fs = new MockReadOnlyFs()
    fs.delete(PEERS_TOKEN_PATH)
    const report = await analyzeOpenClawAgent(
      options({
        env: {
          BGOS_PEERS_REQUIRE_AUTH: '1',
          BGOS_PEERS_AUTH_TOKEN: 'present-in-analyzer-env-only',
        },
      }),
      harness(fs, {
        runtime: baseRuntime({ peersTokenWired: undefined }),
      }).deps,
    )

    expect(hasFinding(report, 'openclaw-peers-token-unknown')).toBe(true)
    expect(hasFinding(report, 'openclaw-peers-token-missing')).toBe(false)
    expect(report.categories.brokenMcp.health.status).toBe('unreachable')
  })

  test('reports actual peers metadata when runtime says wiring is broken', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options({
        env: {
          BGOS_PEERS_REQUIRE_AUTH: '1',
          BGOS_PEERS_AUTH_TOKEN: 'present-but-not-shared',
        },
      }),
      harness(fs, {
        runtime: baseRuntime({ peersTokenWired: false }),
      }).deps,
    )

    const item = finding(report, 'openclaw-peers-token-missing')
    expect(item.explanation).toContain('runtime reports')
    expect(item.proposedChange.data).toMatchObject({
      pinnedEnvPresent: true,
      tokenFilePresent: true,
      runtimeWired: false,
    })
  })

  test('surfaces the rollback latch and protocol-only tool progress gap', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      UPDATE_STATE_PATH,
      baseState({
        previousVersion: '0.16.0',
        targetVersion: '0.16.1',
        earlyCrashCount: 2,
        disabledAfterRollback: true,
        pinnedVersion: '0.16.0',
        selectedVersion: '0.16.0',
        handoffAttemptedFromVersion: '0.16.0',
      }),
    )
    const report = await analyzeOpenClawAgent(options(), harness(fs).deps)

    const latch = finding(report, 'openclaw-rollback-latch-set')
    expect(latch.severity).toBe('error')
    expect(latch.classification).toBe('analyze-only')
    expect(latch.proposedChange.operation).toBe('none')
    expect(latch.proposedChange.data).toMatchObject({
      disabledAfterRollback: true,
      earlyCrashCount: 2,
      pinnedVersion: '0.16.0',
    })
    expect(latch.whySafe).toContain('re-arm the crashing release')
    const gap = finding(report, 'openclaw-tool-progress-gap')
    expect(gap.classification).toBe('analyze-only')
    expect(gap.proposedChange.operation).toBe('none')
    expect(gap.proposedChange.data).toMatchObject({
      marker: '[[BGOS_TOOL_PROGRESS]]',
      protocolLimit: true,
    })
    expect(
      finding(report, 'openclaw-protocol-markers-frozen').proposedChange.data,
    ).toMatchObject({
      protocolMarkers: [
        'ea:<decision>:<reqId>',
        '[[BGOS_TOOL_PROGRESS]]',
        '[[/BGOS_TOOL_PROGRESS]]',
      ],
    })
  })

  test('rejects an impossible rollback transition as corrupt state', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(
      UPDATE_STATE_PATH,
      baseState({
        previousVersion: '0.16.0',
        targetVersion: '0.16.1',
        earlyCrashCount: 0,
        disabledAfterRollback: true,
        pinnedVersion: '0.16.0',
        selectedVersion: '0.16.0',
        handoffAttemptedFromVersion: '0.16.0',
      }),
    )
    const report = await analyzeOpenClawAgent(options(), harness(fs).deps)

    expect(hasFinding(report, 'openclaw-update-state-corrupt')).toBe(true)
    expect(hasFinding(report, 'openclaw-rollback-latch-set')).toBe(false)
  })

  test('CLI fallback does not fabricate gateway usage telemetry', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(
      options({ env: {} }),
      harness(fs, {
        runtime: baseRuntime({
          dispatchPath: 'cli',
          contextPct: undefined,
          promptTokens: undefined,
          model: undefined,
          contextWindowTokens: undefined,
        }),
      }).deps,
    )

    expect(report.categories.contextRot.contextPct).toBeNull()
    expect(report.categories.brokenMcp.statusPatchActivity).toBe('not-observed')
    expect(
      finding(report, 'openclaw-dispatch-path').proposedChange.data,
    ).toMatchObject({
      dispatchPath: 'cli',
      usageTelemetryAvailable: false,
    })
  })
})

describe('OpenClaw degraded paths, contract, and read-only proof', () => {
  test('does not run an unsupported doctor flag on an older daemon', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs, {
      help: 'Usage: bgos-openclaw-daemon [options]\n  --help  Show help\n',
    })
    const report = await analyzeOpenClawAgent(options(), h.deps)

    expect(hasFinding(report, 'openclaw-doctor-unavailable')).toBe(true)
    expect(report.categories.brokenMcp.bun).toEqual({
      found: true,
      path: DOCTOR_BIN,
    })
    expect(h.calls).toEqual([
      {
        executable: DOCTOR_BIN,
        args: ['--help'],
        cwd: AGENT_ROOT,
        env: {},
      },
    ])
  })

  test('degrades cleanly when OpenClaw is not installed', async () => {
    const fs = new MockReadOnlyFs({})
    const h = harness(fs, {
      help: '',
      helpExit: 127,
      doctor: '',
      doctorExit: 127,
      runtimeError: new Error('runtime unavailable'),
    })
    const report = await analyzeOpenClawAgent(options(), h.deps)

    expect(report.readOnly).toBe(true)
    expect(report.categories.contextRot.contextPct).toBeNull()
    expect(report.categories.brokenMcp.health.status).toBe('unreachable')
    expect(report.categories.brokenMcp.configStatus).toBe('missing')
    expect(report.categories.brokenMcp.bun).toEqual({
      found: false,
      path: null,
    })
    expect(
      report.categories.brokenMcp.requiredEnv.BGOS_BACKEND_URL,
    ).toBe(false)
    expect(report.categories.startingContext.canonSource).toBe('unknown')
    const item = finding(report, 'openclaw-doctor-unavailable')
    expect(item.classification).toBe('analyze-only')
    expect(item.proposedChange.operation).toBe('none')
    expect(item.proposedChange.data).toMatchObject({ exitCode: 127 })
    expect(hasFinding(report, 'openclaw-dispatch-none')).toBe(false)
    expect(hasFinding(report, 'openclaw-new-half-reset')).toBe(false)
    expect(hasFinding(report, 'openclaw-canon-bundled-fallback')).toBe(false)
    expect(hasFinding(report, 'openclaw-canon-marker-gate')).toBe(false)
    expect(hasFinding(report, 'openclaw-rollback-latch-set')).toBe(false)
    expect(
      finding(report, 'openclaw-dual-context-store').proposedChange.data,
    ).toMatchObject({ durableGatewaySession: null })
  })

  test('does not fabricate checks from malformed config, state, or doctor data', async () => {
    const fs = new MockReadOnlyFs()
    fs.set(CONFIG_PATH, '{bad json')
    fs.set(UPDATE_STATE_PATH, '{bad state')
    const report = await analyzeOpenClawAgent(
      options(),
      harness(fs, {
        doctor: '{"checks":[]}',
        runtime: null,
      }).deps,
    )

    expect(report.categories.brokenMcp.configStatus).toBe('malformed')
    expect(hasFinding(report, 'openclaw-doctor-unavailable')).toBe(true)
    expect(hasFinding(report, 'openclaw-update-state-corrupt')).toBe(true)
    expect(hasFinding(report, 'openclaw-token-permissions')).toBe(false)
    expect(hasFinding(report, 'openclaw-secrets-permissions')).toBe(false)
    expect(hasFinding(report, 'openclaw-keepalive-not-loaded')).toBe(false)
    expect(hasFinding(report, 'openclaw-rollback-latch-set')).toBe(false)
  })

  test('reports unreadable config without claiming it is absent', async () => {
    const fs = new MockReadOnlyFs()
    fs.denied.add(normalize(CONFIG_PATH))
    const report = await analyzeOpenClawAgent(options(), harness(fs).deps)

    expect(report.categories.brokenMcp.configStatus).toBe('malformed')
    expect(hasFinding(report, 'openclaw-config-unreadable')).toBe(true)
    expect(hasFinding(report, 'openclaw-config-missing')).toBe(false)
  })

  test('degrades when the runtime observer throws synchronously', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs)
    const report = await analyzeOpenClawAgent(options(), {
      ...h.deps,
      inspectRuntime: () => {
        throw new Error('synchronous runtime failure')
      },
    })

    expect(report.readOnly).toBe(true)
    expect(report.categories.contextRot.contextPct).toBeNull()
    expect(hasFinding(report, 'openclaw-dispatch-none')).toBe(false)
  })

  test('matches the shared FindingsReport shape and JSON contract', async () => {
    const fs = new MockReadOnlyFs()
    const report = await analyzeOpenClawAgent(options(), harness(fs).deps)
    const typed: FindingsReport = report

    expect(typed.schemaVersion).toBe(1)
    expect(typed.readOnly).toBe(true)
    expect(typed.agent).toEqual({ kind: 'openclaw', root: AGENT_ROOT })
    expect(typed.analyzedAt).toBe('2026-07-22T12:00:00.000Z')
    expect(Object.keys(typed.categories).sort()).toEqual([
      'brokenMcp',
      'claudeMdRules',
      'contextRot',
      'startingContext',
    ])
    expect(typed.summary.total).toBe(typed.findings.length)
    expect(
      Object.values(typed.summary.byCategory).reduce((sum, count) => sum + count, 0),
    ).toBe(typed.findings.length)
    expect(
      Object.values(typed.summary.bySeverity).reduce((sum, count) => sum + count, 0),
    ).toBe(typed.findings.length)
    expect(
      Object.values(typed.summary.byClassification).reduce(
        (sum, count) => sum + count,
        0,
      ),
    ).toBe(typed.findings.length)
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
    expect(budget.total.chars).toBe(
      budget.claudeMd.chars +
        budget.mcpInstructions.chars +
        budget.memoryIndex.chars,
    )

    for (const item of typed.findings) {
      expect(item.id.length).toBeGreaterThan(0)
      expect([
        'context-rot',
        'starting-context',
        'claude-md-rules',
        'broken-mcp',
      ]).toContain(item.category)
      expect(['info', 'warning', 'error']).toContain(item.severity)
      expect(['auto-apply', 'needs-approval', 'analyze-only']).toContain(
        item.classification,
      )
      expect(item.classification).not.toBe('auto-apply')
      expect(item.file.startsWith('/')).toBe(true)
      expect(Number.isInteger(item.line)).toBe(true)
      expect(item.line).toBeGreaterThan(0)
      expect(item.explanation.length).toBeGreaterThan(0)
      expect(item.whySafe.length).toBeGreaterThan(0)
      expect(['none', 'edit-file', 'manual-action']).toContain(
        item.proposedChange.operation,
      )
      expect(item.proposedChange.kind.length).toBeGreaterThan(0)
      expect(item.proposedChange.description.length).toBeGreaterThan(0)
      expect(JSON.stringify(item.proposedChange)).not.toContain('undefined')
      expect(JSON.stringify(item.proposedChange)).not.toContain('function')
    }
    expect(JSON.stringify(typed)).not.toMatch(/[\u2013\u2014]/)
  })

  test('redacts every secret at config, env, doctor, and runtime boundaries', async () => {
    const fs = new MockReadOnlyFs()
    const doctor = JSON.stringify({
      checks: [
        {
          name: 'gateway auth',
          status: 'warn',
          detail: 'token=' + SECRET,
        },
      ],
    })
    const report = await analyzeOpenClawAgent(
      options({
        env: {
          BGOS_PAIRING_TOKEN: SECRET,
          OPENCLAW_GATEWAY_TOKEN: SECRET,
          BGOS_PEERS_AUTH_TOKEN: SECRET,
        },
      }),
      harness(fs, {
        doctor,
        stderr: SECRET,
        runtime: {
          ...baseRuntime(),
          gatewayToken: SECRET,
          pairingToken: SECRET,
        },
      }).deps,
    )
    const diagnostic = finding(report, 'openclaw-doctor-check')
    expect(diagnostic.explanation).toContain('[redacted]')
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(JSON.stringify(report)).not.toContain('gateway-secret-never-report')
    expect(JSON.stringify(report)).not.toContain('pinned-but-never-reported')
    expect(JSON.stringify(report)).not.toContain('peer-secret-never-read')
  })

  test('full run invokes only the help gate and doctor with zero mutations', async () => {
    const fs = new MockReadOnlyFs()
    const before = [...fs.files.entries()]
    const h = harness(fs)
    const report = await analyzeOpenClawAgent(options(), h.deps)

    expect(report.readOnly).toBe(true)
    expect(fs.reads).not.toContain(normalize(PEERS_TOKEN_PATH))
    expect(fs.mutations).toEqual({
      writeFile: 0,
      appendFile: 0,
      mkdir: 0,
      unlink: 0,
      rename: 0,
      rm: 0,
      truncate: 0,
      chmod: 0,
      copyFile: 0,
      cp: 0,
      open: 0,
      createWriteStream: 0,
    })
    expect([...fs.files.entries()]).toEqual(before)
    expect(h.calls).toEqual([
      {
        executable: DOCTOR_BIN,
        args: ['--help'],
        cwd: AGENT_ROOT,
        env: {},
      },
      {
        executable: DOCTOR_BIN,
        args: ['--doctor'],
        cwd: AGENT_ROOT,
        env: {},
      },
    ])
    const invoked = h.calls
      .map((call) => call.executable + ' ' + call.args.join(' '))
      .join('\n')
    expect(invoked).not.toMatch(/--install|--fix|chmod|clear|reset|latch/i)
    expect(invoked).not.toMatch(/(?:^|\s)\/new(?:\s|$)/)
    expect(invoked).not.toMatch(/kill|signal|restart/i)

    const source = readFileSync(
      new URL('../lib/optimizer/openclaw-analyzer.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain(
      "import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises'",
    )
    expect(source).not.toMatch(/from ['"]node:fs['"]/)
    expect(source).not.toMatch(
      /\b(?:writeFile|appendFile|mkdir|unlink|rename|rm|rmdir|truncate|chmod|copyFile|cp|open|createWriteStream)(?:Sync)?\s*\(/,
    )
    expect(source).not.toContain('Bun.write')
    expect(source).not.toMatch(/shell\s*:\s*true/)
    expect(source).not.toContain('process.kill')
    expect(source).not.toMatch(
      /method:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/,
    )
    expect(source).not.toMatch(/[\u2013\u2014]/)
  })

  test('analysis options cannot replace the fixed doctor executable', async () => {
    const fs = new MockReadOnlyFs()
    const h = harness(fs)
    const unsafe = {
      ...options(),
      doctorExecutable: '/tmp/mutating-doctor',
      doctorArgs: ['--fix'],
    } as unknown as OpenClawAnalyzerOptions
    await analyzeOpenClawAgent(unsafe, h.deps)

    expect(h.calls).toEqual([
      {
        executable: DOCTOR_BIN,
        args: ['--help'],
        cwd: AGENT_ROOT,
        env: {},
      },
      {
        executable: DOCTOR_BIN,
        args: ['--doctor'],
        cwd: AGENT_ROOT,
        env: {},
      },
    ])
  })

  test('default filesystem leaves a real fixture tree byte for byte unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'optimizer-openclaw-readonly-'))
    const agentRoot = join(root, 'agent')
    const openclawHome = join(root, '.openclaw')
    const configPath = join(openclawHome, 'secrets', 'bgos.json')
    const peersPath = join(openclawHome, 'secrets', 'bgos-peers-token')
    const statePath = join(openclawHome, 'state', 'bgos-auto-update.json')
    const cursorPath = join(openclawHome, 'state', 'bgos-cursor.json')
    const logPath = join(openclawHome, 'state', 'bgos-daemon.log')
    mkdirSync(agentRoot, { recursive: true })
    mkdirSync(join(openclawHome, 'secrets'), { recursive: true })
    mkdirSync(join(openclawHome, 'state'), { recursive: true })
    writeFileSync(configPath, baseConfig())
    writeFileSync(peersPath, 'fixture-peer-token')
    chmodSync(peersPath, 0o600)
    writeFileSync(statePath, baseState())
    writeFileSync(cursorPath, '{"version":2,"lastEventId":8}')
    writeFileSync(
      logPath,
      '[bgos-daemon] openclaw capabilities {"dispatchPath":"gateway"}\n',
    )
    const before = snapshotTree(root)
    const commandHarness = harness(new MockReadOnlyFs())

    await analyzeOpenClawAgent(
      {
        agentRoot,
        openclawHome,
        configPath,
        updateStatePath: statePath,
        cursorFilePath: cursorPath,
        daemonLogPath: logPath,
        env: {},
        nowMs: NOW_MS,
      },
      {
        runCommand: commandHarness.deps.runCommand,
        inspectRuntime: async () => baseRuntime(),
        homeDir: root,
      },
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
      result.push([relative, 'directory:' + (stats.mode & 0o777).toString(8)])
      for (const name of readdirSync(path).sort()) visit(join(path, name))
      return
    }
    result.push([
      relative,
      (stats.mode & 0o777).toString(8) + ':' + readFileSync(path).toString('base64'),
    ])
  }
  visit(root)
  return result
}
