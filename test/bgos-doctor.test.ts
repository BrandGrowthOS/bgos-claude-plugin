/**
 * bgos-doctor tests (pure layer only, no child processes and no network).
 *
 * /hoai:doctor is the one-command diagnostic (fix 08) and the preflight gate
 * (fix 03) of the one-click onboarding design: a prerequisite table plus the
 * single fix command per failing row, and setup may only claim success when
 * the MCP initialize handshake succeeds AND `claude mcp list` reads
 * Connected. This suite pins:
 *   - buildDoctorRows: every probe-failure shape yields ok:false with a
 *     non-empty fix naming the right command (table driven)
 *   - renderDoctorTable: aligned plain-text columns, Fix lines only for
 *     failing rows, in row order, no box-drawing characters
 *   - parseMcpListOutput: Connected / Failed / Needs authentication / missing
 *     rows, plugin-prefixed names, unicode marks, ANSI-wrapped input
 *   - preflightVerdict: the truth table, including the backend exemption
 *   - the handshake wire helpers: encodeJsonRpcMessage newline framing and
 *     McpFrameParser across split chunks, joined chunks, CRLF, noise lines,
 *     and Content-Length framed fallback input
 *   - parseAuthStatusOutput / isSubscriptionAuth / doctorLogPath /
 *     readFolderPin support helpers
 *
 * Run: npm test (node --test) or node --test test/bgos-doctor.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  buildDoctorRows,
  renderDoctorTable,
  parseMcpListOutput,
  preflightVerdict,
  encodeJsonRpcMessage,
  McpFrameParser,
  parseAuthStatusOutput,
  isSubscriptionAuth,
  doctorLogPath,
  readFolderPin,
  parseDoctorArgs,
  DEFAULT_BACKEND_URL,
  isRunAsMain,
  liveMarkerPathFor,
  waitForLiveMarker,
} from '../bin/bgos-doctor.mjs'
import { bunInstallHint } from '../bin/bgos-launch.mjs'
import { launchCommand } from '../bin/bgos-install-method.mjs'

// ── Shared probe fixtures ────────────────────────────────────────────────────

/** Every probe green: the baseline the failure table mutates one row at a time. */
function healthyProbes(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'win32',
    claude: { found: true, version: '2.1.239 (Claude Code)', path: 'C:\\bin\\claude.exe' },
    auth: { ok: true, loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
    node: { found: true, version: 'v24.16.0' },
    bun: { found: true, path: 'C:\\Users\\x\\.bun\\bin\\bun.exe', via: 'home' },
    bunx: { found: true, path: 'C:\\Users\\x\\.bun\\bin\\bunx.exe' },
    method: { method: 'marketplace', channelSpec: 'plugin:hoai@hoai', pluginRoot: 'C:\\plug' },
    credentials: {
      path: 'C:\\Users\\x\\.bgos-agent\\credentials-871.json',
      exists: true,
      assistantId: 871,
      expectedAssistantId: '871',
    },
    handshake: { ok: true, detail: 'server bgos 0.36.0 answered initialize', command: 'node launch server' },
    mcpList: { ok: true, state: 'connected', raw: 'bgos: ... Connected' },
    backend: { ok: true, status: 200, url: 'https://api.brandgrowthos.ai/api/v1/service-options/health' },
    logPath: 'C:\\Users\\x\\.bgos-agent\\logs\\bgos-plugin-871.log',
    ...overrides,
  }
}

function rowById(rows: Array<{ id: string }>, id: string) {
  const row = rows.find((r) => r.id === id)
  assert.ok(row, `row ${id} missing`)
  return row as { id: string; label: string; ok: boolean | null; detail: string; fix: string }
}

// ── buildDoctorRows ──────────────────────────────────────────────────────────

test('buildDoctorRows: healthy probes produce all-pass rows in the documented order', () => {
  const rows = buildDoctorRows(healthyProbes())
  assert.deepEqual(
    rows.map((r: { id: string }) => r.id),
    ['claude', 'auth', 'node', 'bun', 'bunx', 'method', 'credentials', 'handshake', 'mcp-list', 'backend', 'log'],
  )
  for (const row of rows) {
    assert.equal(row.ok, true, `row ${row.id} should pass, got ${row.ok} (${row.detail})`)
    assert.equal(row.fix, '', `passing row ${row.id} must not carry a fix`)
  }
  // The log row carries the path as its detail.
  assert.match(rowById(rows, 'log').detail, /bgos-plugin-871\.log/)
})

test('buildDoctorRows: every failure shape yields ok:false plus the right fix command (table driven)', () => {
  const cases: Array<{
    name: string
    overrides: Record<string, unknown>
    id: string
    fixIncludes: string[]
    detailIncludes?: string[]
  }> = [
    {
      name: 'claude missing on win32 gets the powershell one-liner',
      overrides: { claude: { found: false } },
      id: 'claude',
      fixIncludes: ['powershell -c "irm https://claude.ai/install.ps1 | iex"'],
    },
    {
      name: 'auth not logged in gets claude auth login',
      overrides: { auth: { ok: true, loggedIn: false } },
      id: 'auth',
      fixIncludes: ['claude auth login'],
    },
    {
      name: 'auth probe error gets claude auth login too',
      overrides: { auth: { ok: false, error: 'auth status did not parse' } },
      id: 'auth',
      fixIncludes: ['claude auth login'],
      detailIncludes: ['auth status did not parse'],
    },
    {
      name: 'API-key auth is a failing warn row naming the silent inbound drop, fix claude /login',
      overrides: { auth: { ok: true, loggedIn: true, authMethod: 'console' } },
      id: 'auth',
      fixIncludes: ['claude /login'],
      detailIncludes: ['silently drops inbound'],
    },
    {
      name: 'bun missing gets the platform install hint plus the BOTH-on-PATH reminder',
      overrides: { bun: { found: false } },
      id: 'bun',
      fixIncludes: [bunInstallHint('win32'), 'ensure BOTH bun and bunx are on PATH'],
    },
    {
      name: 'bunx missing gets the same hint even when bun itself resolved',
      overrides: { bunx: { found: false } },
      id: 'bunx',
      fixIncludes: [bunInstallHint('win32'), 'ensure BOTH bun and bunx are on PATH'],
    },
    {
      name: 'credentials missing gets hoai pair',
      overrides: {
        credentials: { path: 'C:\\Users\\x\\.bgos-agent\\credentials.json', exists: false },
      },
      id: 'credentials',
      fixIncludes: ['hoai pair <code from the HOAI app>'],
    },
    {
      name: 'assistant id mismatch says rerun pair with --assistant-id',
      overrides: {
        credentials: {
          path: 'C:\\Users\\x\\.bgos-agent\\credentials-871.json',
          exists: true,
          assistantId: 902,
          expectedAssistantId: '871',
        },
      },
      id: 'credentials',
      fixIncludes: ['hoai pair <code from the HOAI app> --assistant-id 871'],
      detailIncludes: ['902', '871'],
    },
    {
      name: 'handshake fail carries the exact spawn command it tried',
      overrides: {
        handshake: {
          ok: false,
          detail: 'server exited (code 1) before answering initialize',
          command: 'node C:\\plug\\bin\\bgos-launch.mjs C:\\plug\\server.ts',
        },
      },
      id: 'handshake',
      fixIncludes: [
        'node C:\\plug\\bin\\bgos-launch.mjs C:\\plug\\server.ts',
        'run hoai doctor again after fixing the row above',
      ],
    },
    {
      name: 'mcp list not Connected gets the launch command for the detected method',
      overrides: { mcpList: { ok: false, state: 'failed', raw: 'bgos: ... Failed to connect' } },
      id: 'mcp-list',
      fixIncludes: [launchCommand('marketplace')],
    },
    {
      name: 'backend down says check the internet connection',
      overrides: { backend: { ok: false, status: 0, url: 'https://api.brandgrowthos.ai/api/v1/service-options/health' } },
      id: 'backend',
      fixIncludes: ["check this computer's internet connection"],
    },
  ]
  for (const c of cases) {
    const rows = buildDoctorRows(healthyProbes(c.overrides))
    const row = rowById(rows, c.id)
    assert.equal(row.ok, false, `${c.name}: row ${c.id} should fail`)
    assert.ok(row.fix.length > 0, `${c.name}: fix must be non-empty`)
    for (const piece of c.fixIncludes) {
      assert.ok(row.fix.includes(piece), `${c.name}: fix "${row.fix}" should include "${piece}"`)
    }
    for (const piece of c.detailIncludes ?? []) {
      assert.ok(row.detail.includes(piece), `${c.name}: detail "${row.detail}" should include "${piece}"`)
    }
  }
})

test('buildDoctorRows: posix platform swaps the claude install one-liner', () => {
  const rows = buildDoctorRows(healthyProbes({ platform: 'linux', claude: { found: false } }))
  assert.ok(rowById(rows, 'claude').fix.includes('curl -fsSL https://claude.ai/install.sh | bash'))
})

test('buildDoctorRows: null handshake and mcpList probes render as not probed (ok null), no fix', () => {
  const rows = buildDoctorRows(healthyProbes({ handshake: null, mcpList: null }))
  assert.equal(rowById(rows, 'handshake').ok, null)
  assert.equal(rowById(rows, 'mcp-list').ok, null)
  assert.equal(rowById(rows, 'handshake').fix, '')
  assert.equal(rowById(rows, 'mcp-list').fix, '')
})

// Superseded 2026-08-25. This used to assert that an UNPROBED install method
// made the mcp-list fix line fall back to the CLONE launch command. That was
// the fail-open direction: on a marketplace install it hands the user the one
// spec that connects nothing and drops every message in silence, which is the
// exact failure a real user hit through `npx ... hoai doctor` on 2026-08-24.
// With no method there is no command to give, and saying so is the fix.
test('buildDoctorRows: with no probed install method the mcp list fix names NO channel spec', () => {
  const rows = buildDoctorRows(
    healthyProbes({ method: null, mcpList: { ok: false, state: 'failed' } }),
  )
  const fix = rowById(rows, 'mcp-list').fix
  assert.doesNotMatch(fix, /--dangerously-load-development-channels/)
  assert.doesNotMatch(fix, /server:bgos/)
  assert.doesNotMatch(fix, /plugin:hoai@/)
  assert.match(fix, /Install method row/i)
})

test('buildDoctorRows: the mcp list fix uses the spec DETECTION resolved, marketplace name included', () => {
  const rows = buildDoctorRows(
    healthyProbes({
      method: {
        method: 'marketplace',
        channelSpec: 'plugin:hoai@hoai-latest',
        pluginRoot: '/home/kc/.claude/plugins/cache/hoai-latest/hoai/0.34.3',
      },
      mcpList: { ok: false, state: 'failed' },
    }),
  )
  // Not the hardcoded default: the machine's own marketplace name travels
  // through, because plugin:hoai@hoai on a hoai-latest machine is just as deaf.
  assert.match(rowById(rows, 'mcp-list').fix, /--dangerously-load-development-channels plugin:hoai@hoai-latest/)
})

test('buildDoctorRows: an UNDETERMINED install method is a FAIL row carrying its reason', () => {
  const rows = buildDoctorRows(
    healthyProbes({
      method: {
        method: 'unknown',
        channelSpec: '',
        pluginRoot: '',
        reason: 'this command is running from a temporary package-runner directory',
      },
    }),
  )
  const row = rowById(rows, 'method')
  assert.equal(row.ok, false, 'undetermined must never render as PASS')
  assert.match(row.detail, /temporary package-runner directory/)
  assert.match(row.fix, /not through npx/i)
})

test('buildDoctorRows: the log row is always ok with the path as detail', () => {
  const rows = buildDoctorRows(healthyProbes({ logPath: '/home/kc/.bgos-agent/logs/bgos-plugin-7.log' }))
  const row = rowById(rows, 'log')
  assert.equal(row.ok, true)
  assert.equal(row.detail, '/home/kc/.bgos-agent/logs/bgos-plugin-7.log')
})

test('buildDoctorRows: no em or en dashes anywhere in rows', () => {
  const shapes = [
    healthyProbes(),
    healthyProbes({
      claude: { found: false },
      auth: { ok: false, error: 'x' },
      bun: { found: false },
      bunx: { found: false },
      credentials: { path: 'p', exists: false },
      handshake: { ok: false, detail: 'died', command: 'node x' },
      mcpList: { ok: false, state: 'failed' },
      backend: { ok: false, status: 0, url: 'u' },
    }),
  ]
  for (const probes of shapes) {
    const text = JSON.stringify(buildDoctorRows(probes))
    assert.ok(!/[\u2013\u2014]/.test(text), 'rows must not contain em or en dashes')
  }
})

// ── renderDoctorTable ────────────────────────────────────────────────────────

test('renderDoctorTable: aligned columns, PASS/FAIL/SKIP statuses, fixes only for failing rows in order', () => {
  const rows = [
    { id: 'a', label: 'Alpha check', ok: true, detail: 'fine', fix: '' },
    { id: 'b', label: 'Beta', ok: false, detail: 'broken', fix: 'run beta-fix' },
    { id: 'c', label: 'Gamma longer label', ok: null, detail: '', fix: '' },
    { id: 'd', label: 'Delta', ok: false, detail: 'also broken', fix: 'run delta-fix' },
  ]
  const out = renderDoctorTable(rows)
  const lines = out.split('\n')
  assert.match(lines[0], /^STATUS\s+CHECK\s+DETAIL$/)
  // Every data line starts its CHECK column at the same offset.
  const checkCol = lines[0].indexOf('CHECK')
  assert.ok(lines[2].startsWith('PASS'))
  assert.equal(lines[2].indexOf('Alpha check'), checkCol)
  assert.ok(lines[3].startsWith('FAIL'))
  assert.equal(lines[3].indexOf('Beta'), checkCol)
  assert.ok(lines[4].startsWith('SKIP'))
  assert.equal(lines[4].indexOf('Gamma longer label'), checkCol)
  // Empty detail renders as a placeholder dash.
  assert.match(lines[4], /\s-\s*$/)
  // Fix lines: only the two failing rows, in row order.
  const fixLines = lines.filter((l: string) => l.startsWith('Fix'))
  assert.equal(fixLines.length, 2)
  assert.ok(fixLines[0].includes('run beta-fix'))
  assert.ok(fixLines[1].includes('run delta-fix'))
  // No box-drawing characters anywhere.
  assert.ok(!/[\u2500-\u257f\u2013\u2014]/.test(out), 'plain spaces and dashes only')
})

test('renderDoctorTable: a healthy table has no Fix lines at all', () => {
  const out = renderDoctorTable(buildDoctorRows(healthyProbes()))
  assert.ok(!out.includes('Fix'), 'no fixes when everything passes')
})

// ── parseMcpListOutput ───────────────────────────────────────────────────────

test('parseMcpListOutput: a Connected line for bgos', () => {
  const text = 'Checking MCP server health...\n\nbgos: node C:\\plug\\bin\\bgos-launch.mjs C:\\plug\\server.ts - \u2714 Connected\n'
  assert.deepEqual(parseMcpListOutput(text, ['bgos', 'plugin:hoai:bgos']).state, 'connected')
  assert.equal(parseMcpListOutput(text, ['bgos']).found, true)
})

test('parseMcpListOutput: plugin-prefixed name with colons still matches as the name before the separator', () => {
  const text = 'plugin:hoai:bgos: bun run server.ts - \u2714 Connected\n'
  const parsed = parseMcpListOutput(text, ['bgos', 'plugin:hoai:bgos'])
  assert.equal(parsed.found, true)
  assert.equal(parsed.state, 'connected')
  assert.ok(parsed.line && parsed.line.includes('plugin:hoai:bgos'))
})

test('parseMcpListOutput: Failed and Needs authentication classify correctly', () => {
  assert.equal(
    parseMcpListOutput('bgos: bun server.ts - \u2716 Failed to connect\n', ['bgos']).state,
    'failed',
  )
  assert.equal(
    parseMcpListOutput('bgos: bun server.ts - Error: spawn ENOENT\n', ['bgos']).state,
    'failed',
  )
  assert.equal(
    parseMcpListOutput('bgos: bun server.ts - \u26a0 Needs authentication\n', ['bgos']).state,
    'needs-auth',
  )
})

test('parseMcpListOutput: a missing row reports found:false', () => {
  const parsed = parseMcpListOutput('otherserver: cmd - \u2714 Connected\n', ['bgos', 'plugin:hoai:bgos'])
  assert.equal(parsed.found, false)
  assert.equal(parsed.state, 'unknown')
})

test('parseMcpListOutput: ANSI escape codes are stripped before matching', () => {
  const text = '\u001b[32mbgos\u001b[0m: node launch - \u001b[32m\u2714 Connected\u001b[0m\n'
  const parsed = parseMcpListOutput(text, ['bgos'])
  assert.equal(parsed.found, true)
  assert.equal(parsed.state, 'connected')
})

test('parseMcpListOutput: a name match with no recognized status word is unknown but found', () => {
  const parsed = parseMcpListOutput('bgos: node launch - starting...\n', ['bgos'])
  assert.equal(parsed.found, true)
  assert.equal(parsed.state, 'unknown')
})

test('parseMcpListOutput: bgosX is not bgos (the name must end at the separator)', () => {
  const parsed = parseMcpListOutput('bgosX: cmd - \u2714 Connected\n', ['bgos'])
  assert.equal(parsed.found, false)
})

// ── preflightVerdict ─────────────────────────────────────────────────────────

function verdictRows(okById: Record<string, boolean | null>) {
  return buildDoctorRows(healthyProbes()).map((row: { id: string; ok: boolean | null }) => ({
    ...row,
    ok: okById[row.id] !== undefined ? okById[row.id] : row.ok,
  }))
}

test('preflightVerdict: all green passes', () => {
  const verdict = preflightVerdict(verdictRows({}))
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.failing, [])
})

test('preflightVerdict: each required row failing (or skipped) fails the gate', () => {
  for (const id of ['claude', 'auth', 'handshake', 'mcp-list']) {
    for (const value of [false, null]) {
      const verdict = preflightVerdict(verdictRows({ [id]: value }))
      assert.equal(verdict.ok, false, `${id}=${value} must fail preflight`)
      assert.ok(verdict.failing.includes(id))
    }
  }
})

test('preflightVerdict: a non-required row failing fails the gate too', () => {
  const verdict = preflightVerdict(verdictRows({ bun: false }))
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.failing, ['bun'])
})

test('preflightVerdict: backend failure is exempt when handshake AND mcp list passed', () => {
  const verdict = preflightVerdict(verdictRows({ backend: false }))
  assert.equal(verdict.ok, true, 'reachability is implied by a live handshake')
  assert.deepEqual(verdict.failing, [])
})

test('preflightVerdict: backend failure is NOT exempt when the handshake also failed', () => {
  const verdict = preflightVerdict(verdictRows({ backend: false, handshake: false }))
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failing.includes('handshake'))
  assert.ok(verdict.failing.includes('backend'))
})

// ── Handshake wire helpers ───────────────────────────────────────────────────

test('encodeJsonRpcMessage: one JSON document per newline-terminated line (MCP stdio framing)', () => {
  const encoded = encodeJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  assert.ok(encoded.endsWith('\n'))
  assert.ok(!encoded.slice(0, -1).includes('\n'), 'the body itself must be a single line')
  assert.deepEqual(JSON.parse(encoded), { jsonrpc: '2.0', id: 1, method: 'initialize' })
})

test('McpFrameParser: parses joined messages in one chunk', () => {
  const parser = new McpFrameParser()
  const messages = parser.feed(
    encodeJsonRpcMessage({ id: 1, result: {} }) + encodeJsonRpcMessage({ id: 2, result: {} }),
  )
  assert.equal(messages.length, 2)
  assert.equal(messages[0].id, 1)
  assert.equal(messages[1].id, 2)
})

test('McpFrameParser: reassembles a message split across chunks', () => {
  const parser = new McpFrameParser()
  const encoded = encodeJsonRpcMessage({ jsonrpc: '2.0', id: 7, result: { serverInfo: { name: 'bgos' } } })
  const cut = Math.floor(encoded.length / 2)
  assert.deepEqual(parser.feed(encoded.slice(0, cut)), [])
  const messages = parser.feed(encoded.slice(cut))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].result.serverInfo.name, 'bgos')
})

test('McpFrameParser: tolerates CRLF line endings and skips non-JSON noise lines', () => {
  const parser = new McpFrameParser()
  const messages = parser.feed('starting up...\r\n{"id":3,"result":{}}\r\nnot json either\n')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, 3)
})

test('McpFrameParser: also accepts a Content-Length framed message (LSP-style fallback)', () => {
  const body = JSON.stringify({ id: 9, result: { ok: true } })
  const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  const parser = new McpFrameParser()
  // Split mid-body to prove the byte-count path buffers too.
  const cut = framed.length - 4
  assert.deepEqual(parser.feed(framed.slice(0, cut)), [])
  const messages = parser.feed(framed.slice(cut))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, 9)
})

// ── Support helpers ──────────────────────────────────────────────────────────

test('parseAuthStatusOutput: real claude auth status JSON', () => {
  const parsed = parseAuthStatusOutput(
    '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}\n',
  )
  assert.ok(parsed)
  assert.equal(parsed.loggedIn, true)
  assert.equal(parsed.authMethod, 'claude.ai')
  assert.equal(parsed.subscriptionType, 'max')
})

test('parseAuthStatusOutput: JSON with a non-JSON preamble still parses', () => {
  const parsed = parseAuthStatusOutput('checking...\nwarn: something\n{"loggedIn":false}\n')
  assert.ok(parsed)
  assert.equal(parsed.loggedIn, false)
})

test('parseAuthStatusOutput: plain-text outputs fall back to heuristics', () => {
  const loggedOut = parseAuthStatusOutput('Not logged in. Run claude auth login.')
  assert.ok(loggedOut)
  assert.equal(loggedOut.loggedIn, false)
  const loggedIn = parseAuthStatusOutput('Logged in as kc via claude.ai')
  assert.ok(loggedIn)
  assert.equal(loggedIn.loggedIn, true)
  assert.equal(parseAuthStatusOutput(''), null)
})

test('isSubscriptionAuth: claude.ai counts, API key / console do not', () => {
  assert.equal(isSubscriptionAuth('claude.ai'), true)
  assert.equal(isSubscriptionAuth('Claude.AI (subscription)'), true)
  assert.equal(isSubscriptionAuth('console'), false)
  assert.equal(isSubscriptionAuth('apiKey'), false)
  assert.equal(isSubscriptionAuth(''), false)
  assert.equal(isSubscriptionAuth(undefined), false)
})

test('doctorLogPath: BGOS_LOG_FILE wins, else the stable home-rooted default keyed by assistant id', () => {
  assert.equal(
    doctorLogPath({ env: { BGOS_LOG_FILE: ' /var/log/bgos.log ' }, home: '/home/kc', assistantId: '7' }),
    '/var/log/bgos.log',
  )
  const fallback = doctorLogPath({ env: {}, home: '/home/kc', assistantId: '7' })
  assert.ok(fallback.endsWith('bgos-plugin-7.log'), fallback)
  const unknown = doctorLogPath({ env: {}, home: '/home/kc', assistantId: '' })
  assert.ok(unknown.endsWith('bgos-plugin-unknown.log'), unknown)
})

test('readFolderPin: numeric pin file wins, junk and absence read as empty', () => {
  // Key the fake filesystem by the host's own join so the test passes on
  // both separator styles.
  const pinPath = join('/w', '.bgos-agent-id')
  const files: Record<string, string> = { [pinPath]: ' 871 \n' }
  const read = (p: string) => {
    if (files[p] === undefined) throw new Error('ENOENT')
    return files[p]
  }
  assert.equal(readFolderPin('/w', read), '871')
  files[pinPath] = 'not a number'
  assert.equal(readFolderPin('/w', read), '')
  assert.equal(readFolderPin('/nope', read), '')
})

test('parseDoctorArgs: flags parse, defaults hold, unknown flags error', () => {
  const { args, errors } = parseDoctorArgs([
    '--preflight',
    '--assistant-id',
    '871',
    '--workdir',
    'C:\\w',
    '--backend',
    'https://x.example',
    '--json',
    '--skip-handshake',
  ])
  assert.deepEqual(errors, [])
  assert.equal(args.preflight, true)
  assert.equal(args.assistantId, '871')
  assert.equal(args.workdir, 'C:\\w')
  assert.ok(args.backend.startsWith('https://x.example'))
  assert.equal(args.json, true)
  assert.equal(args.skipHandshake, true)

  const defaults = parseDoctorArgs([])
  assert.deepEqual(defaults.errors, [])
  assert.equal(defaults.args.backend, DEFAULT_BACKEND_URL)
  assert.equal(defaults.args.preflight, false)
  assert.equal(defaults.args.skipHandshake, false)

  const bad = parseDoctorArgs(['--frobnicate'])
  assert.ok(bad.errors.length > 0)
})

test('isRunAsMain: importing the module does not run main', () => {
  // The fact this suite runs at all proves the guard held; pin the predicate too.
  assert.equal(isRunAsMain(undefined as unknown as string), false)
  assert.equal(isRunAsMain('/some/other/file.mjs'), false)
})

// ── Channel-live marker wait (fix 09) ────────────────────────────────────────

test('liveMarkerPathFor: assistant id keys the state dir, junk falls to cwd hash', () => {
  const byId = liveMarkerPathFor({
    env: {},
    home: '/home/kc',
    assistantId: '1032',
    cwd: '/x',
  })
  assert.ok(byId.endsWith(join('.bgos-plugin-state', '1032', 'channel-live.json')))
  const byCwd = liveMarkerPathFor({ env: {}, home: '/home/kc', assistantId: '', cwd: '/agents/ava' })
  assert.match(byCwd, /cwd-[0-9a-f]{16}/)
  const overridden = liveMarkerPathFor({
    env: { BGOS_PLUGIN_STATE_DIR: '/custom' },
    home: '/home/kc',
    assistantId: '7',
    cwd: '/x',
  })
  assert.ok(overridden.startsWith(join('/custom', '7')))
})

test('waitForLiveMarker: resolves on a fresh mtime, times out on stale or absent', async () => {
  let clock = 1_000_000
  const sleeps = []
  const mk = (mtimes: Array<number | null>) => {
    let call = 0
    return {
      path: 'X',
      sinceMs: 1_000_000,
      timeoutMs: 10_000,
      pollMs: 1_000,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        clock += ms
      },
      statImpl: () => {
        const value = mtimes[Math.min(call++, mtimes.length - 1)]
        if (value == null) throw new Error('ENOENT')
        return { mtimeMs: value }
      },
    }
  }
  // Fresh marker on the third poll.
  const fresh = await waitForLiveMarker(mk([null, 999_999, 1_000_500]))
  assert.deepEqual(fresh, { ok: true, mtimeMs: 1_000_500 })
  // Only a stale marker: times out with the stale mtime reported.
  clock = 1_000_000
  const stale = await waitForLiveMarker(mk([999_999]))
  assert.equal(stale.ok, false)
  assert.equal(stale.mtimeMs, 999_999)
  // Never any marker: times out with null.
  clock = 1_000_000
  const absent = await waitForLiveMarker(mk([null]))
  assert.deepEqual(absent, { ok: false, mtimeMs: null })
})

test('parseDoctorArgs: wait-live flags parse and validate', () => {
  const ok = parseDoctorArgs(['--wait-live-since', '1755800000000', '--wait-live-timeout', '90'])
  assert.equal(ok.errors.length, 0)
  assert.equal(ok.args.waitLiveSince, 1755800000000)
  assert.equal(ok.args.waitLiveTimeoutS, 90)
  const bad = parseDoctorArgs(['--wait-live-since', 'soon'])
  assert.ok(bad.errors.length > 0)
})
