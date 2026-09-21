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
 *   - the four LAUNCH rows (defect F7, 2026-09-21): folder trust, the bypass
 *     prompt, the startup-gate strategy and an incumbent session, each of
 *     which stops a launch dead while every channel row stays green, plus
 *     their probes against injected files and an injected process list
 *   - UNPROVEN: the status for a check that applies and has no evidence yet,
 *     rendered UNPROVEN and not SKIP, gating preflight exactly as ok:null did,
 *     for the liveness row and (defect F5) for a handshake or an mcp-list
 *     that never ran, each of which now says WHY instead of 'skipped'
 *   - probeFolderTrust across BOTH spellings of a cwd, literal and realpath
 *     (defect F1): the seed keys the entry on process.cwd(), a realpath, and
 *     a symlinked home made the lookup miss it and abort a first install
 *   - ADVISORY_ROW_IDS: the startup-gate and incumbent rows report without
 *     gating (defect F2), while trust and bypass still gate
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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

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
  UNPROVEN,
  EXPECT_PROBE_PATHS,
  expectInstallHint,
  probeFolderTrust,
  ancestorDirs,
  resolveLaunchFolder,
  provePairedTopology,
  pairedTopologyLine,
  supervisedEnv,
  PAIRED_TOPOLOGY_REASONS,
  main as doctorMain,
  probeBypassPrompt,
  probeGateStrategy,
  probeIncumbent,
} from '../bin/bgos-doctor.mjs'
import { bunInstallHint } from '../bin/bgos-launch.mjs'
import { launchCommand, MARKETPLACE_CHANNEL_SPEC, CLONE_CHANNEL_SPEC } from '../bin/bgos-install-method.mjs'

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
    route: { spec: 'plugin:hoai@hoai', source: 'install-method', method: 'marketplace', serverName: '', conflict: false, reason: '' },
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

/** A row status as buildDoctorRows may emit it: PASS, FAIL, SKIP or UNPROVEN. */
type RowStatus = boolean | null | typeof UNPROVEN

function rowById(rows: Array<{ id: string }>, id: string) {
  const row = rows.find((r) => r.id === id)
  assert.ok(row, `row ${id} missing`)
  return row as { id: string; label: string; ok: RowStatus; detail: string; fix: string }
}

// ── buildDoctorRows ──────────────────────────────────────────────────────────

test('buildDoctorRows: healthy probes produce all-pass rows in the documented order', () => {
  const rows = buildDoctorRows(healthyProbes())
  assert.deepEqual(
    rows.map((r: { id: string }) => r.id),
    ['claude', 'auth', 'node', 'bun', 'bunx', 'method', 'route', 'credentials', 'handshake', 'mcp-list', 'backend', 'log'],
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

// Superseded 2026-09-21 (defect F5). This used to assert ok:null and the
// detail 'skipped' for both rows. "Render a never-run check as UNPROVEN
// rather than SKIP" reached the liveness row and stopped there, and these two
// are never-run checks in exactly the sense that clause describes: they are
// the pair the whole preflight gate is built on, and a reader who sees SKIP
// beside them takes it for "not applicable on this machine" and reads past the
// only two rows that could have told him the channel is dead. The gate is
// unchanged, and the test below this one pins that.
test('buildDoctorRows: a handshake and an mcp-list that never ran render UNPROVEN, saying WHY', () => {
  const rows = buildDoctorRows(healthyProbes({ handshake: null, mcpList: null }))
  const handshake = rowById(rows, 'handshake')
  const mcpList = rowById(rows, 'mcp-list')
  for (const row of [handshake, mcpList]) {
    assert.strictEqual(row.ok, UNPROVEN, `${row.id} never ran, so it is UNPROVEN, not SKIP`)
    assert.notStrictEqual(row.ok, null, `${row.id} must no longer render as SKIP`)
    assert.notEqual(row.detail, 'skipped', `${row.id} must say why it did not run, not just that it did not`)
    assert.match(row.detail, /not run/i, `${row.id} must say plainly that it did not run`)
    assert.equal(row.fix, '', 'a check that never ran has no fix of its own to offer')
  }
  assert.match(handshake.detail, /skipped/, 'the handshake names the flag that skipped it')
  assert.match(handshake.detail, /speak MCP/, 'and says what is therefore unproven')
  const table = renderDoctorTable(rows)
  assert.ok(table.includes('UNPROVEN  MCP handshake (initialize)'), table)
  assert.ok(table.includes('UNPROVEN  claude mcp list'), table)
  assert.ok(!table.includes('SKIP'), 'neither row may print SKIP any more')
})

test('buildDoctorRows: an mcp-list that never ran because the claude CLI is missing names that reason', () => {
  // main() only asks `claude mcp list` when the CLI was found, so an absent
  // CLI is the honest WHY, and the row points at the one that carries its fix.
  const rows = buildDoctorRows(healthyProbes({ claude: { found: false }, mcpList: null }))
  const row = rowById(rows, 'mcp-list')
  assert.strictEqual(row.ok, UNPROVEN)
  assert.match(row.detail, /claude CLI was not found/)
  assert.match(row.detail, /Claude Code CLI row/)
})

test('preflightVerdict: an UNPROVEN handshake or mcp-list gates exactly as the old ok:null did', () => {
  // F5 changed a STATUS WORD, never the gate. handshake and mcp-list are both
  // REQUIRED rows and only ok:true satisfies a required row, so a machine that
  // skipped the handshake still fails preflight, byte for byte as it did when
  // the row carried null. Anything else would have turned a cosmetic fix into
  // a bootstrap that claims success without ever speaking to the server.
  const rows = buildDoctorRows(launchProbes({ handshake: null, mcpList: null }))
  assert.strictEqual(rowById(rows, 'handshake').ok, UNPROVEN)
  assert.strictEqual(rowById(rows, 'mcp-list').ok, UNPROVEN)
  const verdict = preflightVerdict(rows)
  assert.equal(verdict.ok, false, 'a required row with no evidence is not green')
  assert.ok(verdict.failing.includes('handshake'))
  assert.ok(verdict.failing.includes('mcp-list'))
  const asNull = rows.map((r: { id: string; ok: RowStatus }) =>
    r.id === 'handshake' || r.id === 'mcp-list' ? { ...r, ok: null as RowStatus } : r,
  )
  assert.deepEqual(preflightVerdict(asNull), verdict, 'UNPROVEN gates identically to the null it replaced')
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

function verdictRows(okById: Record<string, RowStatus>) {
  return buildDoctorRows(healthyProbes()).map((row: { id: string; ok: RowStatus }) => ({
    ...row,
    ok: okById[row.id] !== undefined ? okById[row.id] : row.ok,
  }))
}

/** verdictRows, but over a probe set that actually CONTAINS the four launch
 *  rows: healthyProbes supplies none of them, so overriding an absent row is a
 *  test that silently asserts nothing. */
function launchVerdictRows(okById: Record<string, RowStatus>) {
  return buildDoctorRows(launchProbes()).map((row: { id: string; ok: RowStatus }) => ({
    ...row,
    ok: okById[row.id] !== undefined ? okById[row.id] : row.ok,
  }))
}

test('preflightVerdict: a failing startup-gate row reports but does NOT abort the install', () => {
  // bin/hoai-bootstrap.sh line 611 runs this gate and calls fail
  // 'preflight-failed' on a false, so every FAIL-capable row is also a way for
  // a first-time install to stop dead. The startup-gate row is about a FUTURE
  // unattended relaunch: it fails when the expect wrapper will be used and
  // expect is not installed. macOS ships /usr/bin/expect so it never shows
  // there, but a minimal Linux image does not and the bootstrap never installs
  // it, so gating on it would turn "your restarts may stall" into "your
  // install failed" on every such host. That is the exact opposite of what
  // this release is for.
  const rows = launchVerdictRows({ gate: false })
  assert.ok(rows.some((r: { id: string }) => r.id === 'gate'), 'the gate row must exist for this to mean anything')
  const verdict = preflightVerdict(rows)
  assert.equal(verdict.ok, true, 'a missing expect must not abort an otherwise complete install')
  assert.deepEqual(verdict.failing, [])
})

test('preflightVerdict: the advisory exemption is narrow, trust and bypass still gate', () => {
  // The exemption must not become a blanket. Trust and bypass each describe
  // something that stops THIS launch dead with nobody there to answer it, and
  // neither is fixed by anything the bootstrap does next, so each one still
  // fails. (incumbent left this list on 2026-09-21; see the test below.)
  for (const id of ['trust', 'bypass']) {
    const verdict = preflightVerdict(launchVerdictRows({ [id]: false }))
    assert.equal(verdict.ok, false, `${id}=false must still fail preflight`)
    assert.ok(verdict.failing.includes(id), `${id} must be named among the failures`)
  }
})

test('preflightVerdict: an incumbent claude reports but does NOT abort the install', () => {
  // Defect F2, 2026-09-21. An always-on agent's service keeps a claude running
  // with cwd set to its workspace permanently, so re-running the one-click
  // installer on a HEALTHY machine hit this row every time. With the row
  // gating, that re-run stopped at `preflight FAILED: incumbent` after the
  // one-time pair code had already been spent. The bootstrap LAUNCHES after
  // preflight and that launch does its own incumbent handling, so refusing to
  // FINISH an install over a session the next step already knows about helps
  // nobody.
  const rows = launchVerdictRows({ incumbent: false })
  assert.ok(rows.some((r: { id: string }) => r.id === 'incumbent'), 'the incumbent row must exist for this to mean anything')
  const verdict = preflightVerdict(rows)
  assert.equal(verdict.ok, true, 'a claude already running in this folder must not abort an otherwise complete install')
  assert.deepEqual(verdict.failing, [])

  // It still REPORTS: FAIL, the pid, and the line that clears it.
  const real = buildDoctorRows(
    launchProbes({ incumbent: { cwd: '/agents/ava', hit: { pid: 4242, reason: 'same-cwd' }, blocks: true } }),
  )
  const row = rowById(real, 'incumbent')
  assert.strictEqual(row.ok, false, 'reporting rather than gating is not the same as passing')
  assert.match(row.detail, /4242/)
  assert.match(row.fix, /kill 4242/)
  assert.equal(preflightVerdict(real).ok, true, 'and the same rows still pass the gate')
})

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

// ---------------------------------------------------------------------------
// Channel route row (board row 01a0404b, third field instance 2026-09-02).
// The runner (hoai) resolves the channel WORKSPACE-FIRST: a .mcp.json server
// named bgos wins and the install method is only the fallback. The doctor used
// to print the install method alone, so on a host that has BOTH a folder clone
// (live, carrying traffic) and a marketplace install (deaf, unpaired) it named
// the deaf route and never said a second one existed. These tests pin the row
// that names both routes and which one the agent actually launches through.

test('doctor route row: two routes on one host, workspace wins, the other is named as the duplicate', () => {
  const rows = buildDoctorRows(
    healthyProbes({
      method: { method: 'marketplace', channelSpec: 'plugin:hoai@hoai', pluginRoot: '/home/alex/.claude/plugins/cache/hoai/hoai/0.38.4' },
      route: { spec: 'server:bgos', source: 'workspace', method: 'marketplace', serverName: 'bgos', conflict: false, reason: '' },
    }),
  )
  const r = rows.find((x) => x.id === 'route')
  assert.ok(r, 'a Channel route row exists')
  assert.strictEqual(r.ok, false)
  assert.match(r.detail, /two routes/i)
  assert.match(r.detail, /server:bgos/)
  assert.match(r.detail, /plugin:hoai@hoai/)
  assert.match(r.detail, /\.mcp\.json/)
  assert.match(r.fix, /\.mcp\.json/)
  assert.match(r.fix, /duplicate/i)
})

test('doctor route row: workspace and a clone install agree on one spec, PASS naming the workspace route', () => {
  const rows = buildDoctorRows(
    healthyProbes({
      method: { method: 'clone', channelSpec: 'server:bgos', pluginRoot: '/Users/kc/bgos-claude-plugin' },
      route: { spec: 'server:bgos', source: 'workspace', method: 'clone', serverName: 'bgos', conflict: false, reason: '' },
    }),
  )
  const r = rows.find((x) => x.id === 'route')
  assert.ok(r)
  assert.strictEqual(r.ok, true)
  assert.match(r.detail, /\.mcp\.json/)
  assert.match(r.detail, /server:bgos/)
  assert.doesNotMatch(r.detail, /two routes/i)
})

test('doctor route row: no workspace server, the install method is the only route, PASS', () => {
  const rows = buildDoctorRows(
    healthyProbes({
      method: { method: 'marketplace', channelSpec: 'plugin:hoai@hoai', pluginRoot: '/home/u/.claude/plugins/cache/hoai/hoai/0.38.8' },
      route: { spec: 'plugin:hoai@hoai', source: 'install-method', method: 'marketplace', serverName: '', conflict: false, reason: '' },
    }),
  )
  const r = rows.find((x) => x.id === 'route')
  assert.ok(r)
  assert.strictEqual(r.ok, true)
  assert.match(r.detail, /plugin:hoai@hoai/)
  assert.match(r.detail, /no workspace/i)
})

test('doctor route row: a .mcp.json that declares more than one HOAI server is a FAIL with a fix', () => {
  const rows = buildDoctorRows(
    healthyProbes({
      method: { method: 'clone', channelSpec: 'server:bgos', pluginRoot: '/Users/kc/bgos-claude-plugin' },
      route: { spec: 'server:bgos', source: 'install-method', method: 'clone', serverName: '', conflict: true, reason: '' },
    }),
  )
  const r = rows.find((x) => x.id === 'route')
  assert.ok(r)
  assert.strictEqual(r.ok, false)
  assert.match(r.detail, /more than one/i)
  assert.match(r.fix, /\.mcp\.json/)
})

test('doctor route row: without a route probe the row is SKIP, never a guess', () => {
  const rows = buildDoctorRows(healthyProbes({ route: null }))
  const r = rows.find((x) => x.id === 'route')
  assert.ok(r)
  assert.strictEqual(r.ok, null)
})

// ---------------------------------------------------------------------------
// The launch rows (defect F7, 2026-09-21).
//
// A real machine printed 12 PASS and 1 SKIP while EVERY `hoai` invocation
// exited instantly. Every row validated the CHANNEL; not one validated the
// LAUNCH. These four rows are the launch: a folder Claude Code does not trust,
// a bypass warning whose default answer is exit, a relaunch that needs the
// expect wrapper on a host with no expect, and a claude already holding the
// cwd. Each can FAIL, and the FAIL branch plus its fix text is what these
// tests pin, because a row that can only pass is the defect all over again.

/** healthyProbes plus the four launch probes, all green. */
function launchProbes(overrides: Record<string, unknown> = {}) {
  return healthyProbes({
    platform: 'linux',
    trust: {
      cwd: '/agents/ava',
      configPath: '/home/kc/.claude.json',
      accepted: true,
      reason: 'accepted',
      matchedKey: '/agents/ava',
    },
    bypass: { settingsPath: '/home/kc/.claude/settings.json', accepted: true, reason: 'accepted' },
    gate: { needed: true, method: 'clone', helper: 'expect', expectPath: '/usr/bin/expect' },
    incumbent: { cwd: '/agents/ava', hit: null, blocks: false },
    ...overrides,
  })
}

test('buildDoctorRows: the four launch rows appear together between the route and the credentials rows', () => {
  const rows = buildDoctorRows(launchProbes())
  assert.deepEqual(
    rows.map((r: { id: string }) => r.id),
    [
      'claude', 'auth', 'node', 'bun', 'bunx', 'method', 'route',
      'trust', 'bypass', 'gate', 'incumbent',
      'credentials', 'handshake', 'mcp-list', 'backend', 'log',
    ],
  )
  for (const id of ['trust', 'bypass', 'gate', 'incumbent']) {
    const row = rowById(rows, id)
    assert.equal(row.ok, true, `${id} should pass on a healthy host, got ${row.ok} (${row.detail})`)
    assert.equal(row.fix, '', `passing row ${id} must not carry a fix`)
  }
})

test('buildDoctorRows: an older caller that passes no launch probes still gets its old table', () => {
  // The four keys are optional by design: absent means no row at all, never a
  // guessed one, so the bootstrap's preflight cannot start failing on a probe
  // it never ran.
  const ids = buildDoctorRows(healthyProbes()).map((r: { id: string }) => r.id)
  for (const id of ['trust', 'bypass', 'gate', 'incumbent']) {
    assert.ok(!ids.includes(id), `${id} must not appear when its probe was not supplied`)
  }
})

// ── Folder trust row ─────────────────────────────────────────────────────────

test('doctor trust row: no entry for this folder is a FAIL whose fix names the command that seeds it', () => {
  const rows = buildDoctorRows(
    launchProbes({
      trust: { cwd: '/agents/ava', configPath: '/home/kc/.claude.json', accepted: false, reason: 'no-entry', matchedKey: '' },
    }),
  )
  const row = rowById(rows, 'trust')
  assert.strictEqual(row.ok, false, 'an untrusted folder must never render as PASS')
  assert.match(row.detail, /\/home\/kc\/\.claude\.json/)
  assert.match(row.detail, /\/agents\/ava/)
  assert.match(row.detail, /trust dialog/i)
  assert.match(row.fix, /hoai pair <code from the HOAI app>/)
})

test('doctor trust row: an entry whose hasTrustDialogAccepted is not true is still a FAIL', () => {
  const rows = buildDoctorRows(
    launchProbes({
      trust: {
        cwd: '/agents/ava',
        configPath: '/home/kc/.claude.json',
        accepted: false,
        reason: 'not-accepted',
        matchedKey: '/agents/ava',
      },
    }),
  )
  const row = rowById(rows, 'trust')
  assert.strictEqual(row.ok, false)
  assert.match(row.detail, /hasTrustDialogAccepted is not true/)
  assert.ok(row.fix.length > 0, 'a failing row always carries a fix')
})

test('doctor trust row: a config file that is not there at all fails naming the path it looked at', () => {
  const rows = buildDoctorRows(
    launchProbes({
      trust: { cwd: '/agents/ava', configPath: '/home/kc/.claude.json', accepted: false, reason: 'no-config-file', matchedKey: '' },
    }),
  )
  const row = rowById(rows, 'trust')
  assert.strictEqual(row.ok, false)
  assert.match(row.detail, /no config file at \/home\/kc\/\.claude\.json/)
})

test('doctor trust row: a config file that could not be LOCATED at all is a FAIL, not a pass', () => {
  // Found by mutation, not by design: flipping this branch's status from false
  // to true left the whole suite green, so nothing stood between it and a
  // regression. It is the worst branch to get wrong. "could not locate the
  // config file" means the trust state is unknown, and an unknown trust state
  // is exactly the 0.42.1 shape where every log line said success while the
  // launch sat on a full-screen dialog nobody was there to answer.
  const rows = buildDoctorRows(
    launchProbes({
      trust: { cwd: '/agents/ava', configPath: '', accepted: false, reason: 'no-config-path', error: 'no CLAUDE_CONFIG_DIR and no home directory', matchedKey: '' },
    }),
  )
  const row = rowById(rows, 'trust')
  assert.strictEqual(row.ok, false, 'an unlocatable config file must never render as PASS')
  assert.match(row.detail, /could not be located/i)
  assert.ok(row.fix.length > 0, 'a failing row always carries a fix')
})

test('doctor trust row: a config file that is not readable JSON is a FAIL, not a pass', () => {
  // The other branch mutation found unguarded. Unreadable JSON means the trust
  // state cannot be confirmed either way, and "cannot confirm" has to read as
  // FAIL here: a diagnostic that resolves its own uncertainty in favour of
  // green is the failure mode this whole row exists to end.
  const rows = buildDoctorRows(
    launchProbes({
      trust: { cwd: '/agents/ava', configPath: '/home/kc/.claude.json', accepted: false, reason: 'unreadable-config', matchedKey: '' },
    }),
  )
  const row = rowById(rows, 'trust')
  assert.strictEqual(row.ok, false, 'an unreadable config must never render as PASS')
  assert.match(row.detail, /not readable JSON/)
  assert.match(row.detail, /\/agents\/ava/)
  assert.ok(row.fix.length > 0, 'a failing row always carries a fix')
})

test('probeFolderTrust: the trust flag is read from the file BESIDE the config dir, not the one inside it', () => {
  // The 0.42.1 incident, read side. With CLAUDE_CONFIG_DIR unset Claude Code
  // opens $HOME/.claude.json; $HOME/.claude/.claude.json is the decoy nothing
  // reads, and answering from it is a silent wrong answer in either direction.
  const files: Record<string, string> = {
    '/home/kc/.claude.json': JSON.stringify({ projects: { '/agents/ava': { hasTrustDialogAccepted: true } } }),
    '/home/kc/.claude/.claude.json': JSON.stringify({ projects: { '/agents/ava': { hasTrustDialogAccepted: false } } }),
  }
  const readFile = (p: string) => (files[p] === undefined ? null : files[p])
  const live = probeFolderTrust({ env: {}, home: '/home/kc', cwd: '/agents/ava', readFile })
  assert.equal(live.configPath, '/home/kc/.claude.json')
  assert.equal(live.accepted, true)
  // And when CLAUDE_CONFIG_DIR IS set, the file really does live in there.
  const overridden = probeFolderTrust({
    env: { CLAUDE_CONFIG_DIR: '/home/kc/.claude' },
    home: '/home/kc',
    cwd: '/agents/ava',
    readFile,
  })
  assert.equal(overridden.configPath, '/home/kc/.claude/.claude.json')
  assert.equal(overridden.accepted, false)
  assert.equal(overridden.reason, 'not-accepted')
})

test('probeFolderTrust: a win32 cwd counts as trusted under either slash spelling', () => {
  const raw = JSON.stringify({ projects: { 'C:/agents/ava': { hasTrustDialogAccepted: true } } })
  const probe = probeFolderTrust({
    env: { CLAUDE_CONFIG_DIR: 'C:\\Users\\kc\\.claude' },
    home: 'C:\\Users\\kc',
    cwd: 'C:\\agents\\ava',
    readFile: () => raw,
  })
  assert.equal(probe.accepted, true, 'the seed writes both spellings, so either one is the answer')
  assert.equal(probe.matchedKey, 'C:/agents/ava')
})

test('probeFolderTrust: an absent or corrupt config file reports why, never a cheerful false pass', () => {
  const absent = probeFolderTrust({ env: {}, home: '/home/kc', cwd: '/w', readFile: () => null })
  assert.equal(absent.accepted, false)
  assert.equal(absent.reason, 'no-config-file')
  const corrupt = probeFolderTrust({ env: {}, home: '/home/kc', cwd: '/w', readFile: () => 'not json{' })
  assert.equal(corrupt.accepted, false)
  assert.equal(corrupt.reason, 'unreadable-config')
})

test('probeFolderTrust: a config path that cannot even be NAMED reports the unknown, never an acceptance', () => {
  // Defect F4, 2026-09-21. The ROW rendering for this reason was pinned; the
  // PROBE was not, and a mutation making this branch return
  // {accepted:true, reason:'accepted'} left all 75 doctor tests green. That is
  // the exact shape this whole row exists to end: a diagnostic resolving its
  // own unknown in favour of green. With no CLAUDE_CONFIG_DIR and no home
  // there is no file to read, so claudeConfigFilePath refuses to guess.
  let reads = 0
  const probe = probeFolderTrust({
    env: {},
    home: '',
    cwd: '/agents/ava',
    // A config file that WOULD say yes, to make the wrong answer available.
    readFile: () => {
      reads++
      return JSON.stringify({ projects: { '/agents/ava': { hasTrustDialogAccepted: true } } })
    },
  })
  assert.strictEqual(probe.accepted, false, 'an unlocatable config file is an unknown, never an acceptance')
  assert.equal(probe.reason, 'no-config-path')
  assert.notEqual(probe.reason, 'accepted')
  assert.equal(probe.configPath, '', 'there is no path to name')
  assert.match(String(probe.error), /CLAUDE_CONFIG_DIR/, 'it says what was missing')
  assert.equal(reads, 0, 'nothing is read when the file could not even be named')
})

// ── The trust lookup and the two spellings of a cwd (defect F1) ──────────────
//
// preseedClaudeTrust keys the entry on the cwd it is handed, and on the write
// path that is process.cwd(), which node reports as a REALPATH. probeFolderTrust
// was handed whatever a caller typed at --workdir. On any host whose home or
// workspace runs through a symlink those two strings differ, the lookup missed
// a row sitting right there, and the row rendered FAIL on a folder Claude Code
// trusts. `trust` gates preflightVerdict, so hoai-bootstrap.sh line 611 turned
// that miss into `fail 'preflight-failed'` and stopped a first install dead,
// after the one-time pair code had already been spent.
//
// Reproduced with HOME=/tmp/hoai-symhome-NNN (realpath /private/tmp/...): the
// seed wrote /private/tmp/.../936-workspace and the probe, asked about
// /tmp/.../936-workspace, answered {accepted:false, reason:'no-entry'}.

test('probeFolderTrust: the entry the seed wrote under the REALPATH is found from the symlinked spelling', () => {
  const raw = JSON.stringify({
    projects: { '/private/tmp/hoai-symhome-936/936-workspace': { hasTrustDialogAccepted: true } },
  })
  const probe = probeFolderTrust({
    env: {},
    home: '/tmp/hoai-symhome-936',
    cwd: '/tmp/hoai-symhome-936/936-workspace',
    readFile: () => raw,
    // The macOS /tmp symlink, injected: no test touches a real filesystem.
    resolvePath: (p: string) => p.replace(/^\/tmp\//, '/private/tmp/'),
  })
  assert.strictEqual(probe.accepted, true, 'the folder IS trusted; the two strings are one folder')
  assert.equal(probe.reason, 'accepted')
  assert.equal(probe.matchedKey, '/private/tmp/hoai-symhome-936/936-workspace')
  assert.equal(probe.cwd, '/tmp/hoai-symhome-936/936-workspace', 'the row still names the folder the caller asked about')
})

test('probeFolderTrust: the literal spelling still wins when the config carries it', () => {
  // The fix accepts EITHER spelling. It must not have swapped one miss for the
  // other: a config written from the literal path stays readable on a host
  // whose realpath differs.
  const raw = JSON.stringify({ projects: { '/tmp/w/936': { hasTrustDialogAccepted: true } } })
  const probe = probeFolderTrust({
    env: {},
    home: '/tmp/w',
    cwd: '/tmp/w/936',
    readFile: () => raw,
    resolvePath: () => '/private/tmp/w/936',
  })
  assert.strictEqual(probe.accepted, true)
  assert.equal(probe.matchedKey, '/tmp/w/936')
})

test('probeFolderTrust: a resolved entry that is NOT accepted reports not-accepted, not no-entry', () => {
  // The reason word drives the row's sentence, so a present-but-unaccepted
  // entry under the resolved spelling has to read as the dialog that is still
  // waiting, not as a folder nobody ever seeded.
  const raw = JSON.stringify({ projects: { '/private/tmp/w/936': { hasTrustDialogAccepted: false } } })
  const probe = probeFolderTrust({
    env: {},
    home: '/tmp/w',
    cwd: '/tmp/w/936',
    readFile: () => raw,
    resolvePath: (p: string) => p.replace(/^\/tmp\//, '/private/tmp/'),
  })
  assert.strictEqual(probe.accepted, false)
  assert.equal(probe.reason, 'not-accepted')
  assert.equal(probe.matchedKey, '/private/tmp/w/936')
})

test('probeFolderTrust: an unresolvable cwd compares as itself, and the default resolver never throws', () => {
  // The contract the pair-side guard set in 9090363: a path that cannot be
  // resolved (it does not exist yet, or is not readable through) is simply
  // compared as itself. Anything else would make an absent folder crash the
  // one diagnostic that is supposed to explain it. The readFile is injected,
  // so this reads no real config; only the absent path itself is resolved.
  const raw = JSON.stringify({ projects: { '/no/such/folder/hoai-f1': { hasTrustDialogAccepted: true } } })
  let probe: ReturnType<typeof probeFolderTrust> | null = null
  assert.doesNotThrow(() => {
    probe = probeFolderTrust({ env: {}, home: '/home/kc', cwd: '/no/such/folder/hoai-f1', readFile: () => raw })
  })
  assert.strictEqual(probe!.accepted, true, 'the literal spelling is still the answer when nothing resolves')
})

test('doctor trust row: a symlinked workdir no longer renders FAIL, so preflight no longer aborts the install', () => {
  // The whole incident, end to end: probe, row, verdict. Before the fix this
  // produced {ok:false, failing:['trust']} and hoai-bootstrap.sh:611 turned it
  // into `fail 'preflight-failed'` on a machine with nothing wrong with it.
  const raw = JSON.stringify({
    projects: { '/private/tmp/hoai-symhome-936/936-workspace': { hasTrustDialogAccepted: true } },
  })
  const trust = probeFolderTrust({
    env: {},
    home: '/tmp/hoai-symhome-936',
    cwd: '/tmp/hoai-symhome-936/936-workspace',
    readFile: () => raw,
    resolvePath: (p: string) => p.replace(/^\/tmp\//, '/private/tmp/'),
  })
  const rows = buildDoctorRows(launchProbes({ trust }))
  assert.strictEqual(rowById(rows, 'trust').ok, true, 'a trusted folder must never render FAIL')
  const verdict = preflightVerdict(rows)
  assert.equal(verdict.ok, true, 'and a correctly trusted folder must never abort an install')
  assert.deepEqual(verdict.failing, [])
})

// ── Bypass prompt row ────────────────────────────────────────────────────────

test('doctor bypass row: an unsuppressed bypass warning is a FAIL naming settings.json and the fix', () => {
  const rows = buildDoctorRows(
    launchProbes({
      bypass: { settingsPath: '/home/kc/.claude/settings.json', accepted: false, reason: 'not-set' },
    }),
  )
  const row = rowById(rows, 'bypass')
  assert.strictEqual(row.ok, false, 'an unsuppressed prompt must never render as PASS')
  assert.match(row.detail, /skipDangerousModePermissionPrompt/)
  assert.match(row.detail, /\/home\/kc\/\.claude\/settings\.json/)
  assert.match(row.detail, /default answer is exit/)
  assert.match(row.fix, /hoai/)
})

test('probeBypassPrompt: settings.json is read from the config dir, CLAUDE_CONFIG_DIR included', () => {
  const seen: string[] = []
  const readFile = (p: string) => {
    seen.push(p)
    return null
  }
  assert.equal(
    probeBypassPrompt({ env: {}, home: '/home/kc', readFile }).settingsPath,
    '/home/kc/.claude/settings.json',
  )
  assert.equal(
    probeBypassPrompt({ env: { CLAUDE_CONFIG_DIR: '/etc/claude' }, home: '/home/kc', readFile }).settingsPath,
    '/etc/claude/settings.json',
  )
  assert.deepEqual(seen, ['/home/kc/.claude/settings.json', '/etc/claude/settings.json'])
})

test('probeBypassPrompt: only skipDangerousModePermissionPrompt === true counts as suppressed', () => {
  const at = (value: unknown) =>
    probeBypassPrompt({
      env: {},
      home: '/home/kc',
      readFile: () => JSON.stringify(value === undefined ? {} : { skipDangerousModePermissionPrompt: value }),
    })
  assert.equal(at(true).accepted, true)
  assert.equal(at(false).accepted, false)
  assert.equal(at('true').accepted, false, 'a string is not the boolean Claude Code checks')
  assert.equal(at(undefined).accepted, false)
  assert.equal(at(undefined).reason, 'not-set')
  assert.equal(probeBypassPrompt({ env: {}, home: '/home/kc', readFile: () => null }).reason, 'no-settings-file')
})

// ── Startup gate row ─────────────────────────────────────────────────────────

test('doctor gate row: a posix install that needs the wrapper with no expect is a FAIL naming the install command', () => {
  const rows = buildDoctorRows(
    launchProbes({
      platform: 'linux',
      gate: { needed: true, method: 'clone', helper: 'expect', expectPath: '' },
    }),
  )
  const row = rowById(rows, 'gate')
  assert.strictEqual(row.ok, false, 'a needed wrapper with no expect must FAIL, not warn')
  assert.match(row.detail, /expect wrapper/)
  assert.match(row.detail, /not installed/)
  assert.match(row.detail, /unattended relaunch/)
  assert.equal(row.fix, 'sudo apt install expect')
  // darwin gets the brew line instead, from the same branch.
  const onMac = buildDoctorRows(
    launchProbes({ platform: 'darwin', gate: { needed: true, method: 'marketplace', helper: 'expect', expectPath: '' } }),
  )
  assert.equal(rowById(onMac, 'gate').fix, 'brew install expect')
})

test('doctor gate row: expect present on posix PASSes and says plainly that the expect wrapper is the one used', () => {
  const rows = buildDoctorRows(
    launchProbes({ gate: { needed: true, method: 'clone', helper: 'expect', expectPath: '/opt/homebrew/bin/expect' } }),
  )
  const row = rowById(rows, 'gate')
  assert.strictEqual(row.ok, true)
  assert.match(row.detail, /expect wrapper/)
  assert.match(row.detail, /\/opt\/homebrew\/bin\/expect/)
  assert.equal(row.fix, '')
})

test('doctor gate row: win32 names the console helper and never fails for a missing expect', () => {
  const rows = buildDoctorRows(
    launchProbes({ platform: 'win32', gate: { needed: true, method: 'marketplace', helper: 'win32-console', expectPath: '' } }),
  )
  const row = rowById(rows, 'gate')
  assert.strictEqual(row.ok, true, 'there is no expect on win32, so its absence is not a failure')
  assert.match(row.detail, /console input helper/)
  assert.doesNotMatch(row.detail, /install expect/)
})

test('doctor gate row: an undetermined install method is SKIP, because the strategy is not known', () => {
  const rows = buildDoctorRows(
    launchProbes({ gate: { needed: false, method: 'unknown', helper: 'expect', expectPath: '' } }),
  )
  const row = rowById(rows, 'gate')
  assert.strictEqual(row.ok, null, 'not knowing is SKIP here; the Install method row is the one that fails')
  assert.match(row.detail, /Install method row/)
})

test('expectInstallHint: brew on darwin, apt everywhere else', () => {
  assert.equal(expectInstallHint('darwin'), 'brew install expect')
  assert.equal(expectInstallHint('linux'), 'sudo apt install expect')
})

test('probeGateStrategy: the decision is relaunchNeedsGateAutoAccept and the paths are the ones hoai-core probes', () => {
  const probed: string[] = []
  const exists = (p: string) => {
    probed.push(p)
    return p === '/usr/local/bin/expect'
  }
  const clone = probeGateStrategy({ platform: 'linux', method: { method: 'clone' }, exists })
  assert.equal(clone.needed, true)
  assert.equal(clone.helper, 'expect')
  assert.equal(clone.expectPath, '/usr/local/bin/expect')
  assert.deepEqual(probed, EXPECT_PROBE_PATHS.slice(0, 3), 'probed in hoai-core order, stopping at the hit')
  // An undetermined install method uses no wrapper, so nothing is needed.
  assert.equal(probeGateStrategy({ platform: 'linux', method: { method: 'unknown' }, exists: () => false }).needed, false)
  assert.equal(probeGateStrategy({ platform: 'linux', method: { method: 'marketplace' }, exists: () => false }).needed, true)
})

test('probeGateStrategy: win32 reports the console helper and never looks for expect', () => {
  let looked = false
  const gate = probeGateStrategy({
    platform: 'win32',
    method: { method: 'marketplace' },
    exists: () => {
      looked = true
      return true
    },
  })
  assert.equal(gate.helper, 'win32-console')
  assert.equal(gate.expectPath, '')
  assert.equal(looked, false, 'there is no expect on win32 to look for')
})

// ── Incumbent session row ────────────────────────────────────────────────────

test('doctor incumbent row: a blocking same-cwd claude is a FAIL naming the pid and how to clear it', () => {
  const rows = buildDoctorRows(
    launchProbes({
      incumbent: { cwd: '/agents/ava', hit: { pid: 4242, reason: 'same-cwd' }, blocks: true },
    }),
  )
  const row = rowById(rows, 'incumbent')
  assert.strictEqual(row.ok, false, 'a held folder must never render as PASS')
  assert.match(row.detail, /4242/)
  assert.match(row.detail, /\/agents\/ava/)
  assert.match(row.fix, /kill 4242/)
})

test('doctor incumbent row: an unreadable-cwd hit does NOT fail the row and is mentioned in the detail', () => {
  const rows = buildDoctorRows(
    launchProbes({
      incumbent: { cwd: '/agents/ava', hit: { pid: 77, reason: 'unreadable-cwd' }, blocks: false },
    }),
  )
  const row = rowById(rows, 'incumbent')
  assert.strictEqual(row.ok, true, 'an unknown is not a conflict; only same-cwd blocks')
  assert.match(row.detail, /77/)
  assert.match(row.detail, /unreadable cwd/)
  assert.equal(row.fix, '')
})

test('doctor incumbent row: the unreadable-cwd branch never promises a wait, because F8 removed it', () => {
  // Defect F3, 2026-09-21. This row's non-blocking branch, and the comment
  // above it, said "so hoai may still wait for it" and "an unreadable cwd
  // makes the launcher wait too (it fails toward waiting)". F8 made
  // incumbentBlocks return false for 'unreadable-cwd' in this same branch, so
  // the launcher warns once and launches immediately: it never waits. The one
  // row a user consults to explain a launch that seems to do nothing was
  // predicting the exact symptom F8 had just removed, and pointing at a pid to
  // kill for no reason.
  const rows = buildDoctorRows(
    launchProbes({ incumbent: { cwd: '/agents/ava', hit: { pid: 77, reason: 'unreadable-cwd' }, blocks: false } }),
  )
  const row = rowById(rows, 'incumbent')
  assert.strictEqual(row.ok, true)
  assert.doesNotMatch(row.detail, /wait/i, 'nothing waits on an unreadable cwd any more, so the row must not say so')
  assert.match(row.detail, /launches anyway/i, 'it must say what actually happens instead')
  assert.equal(row.fix, '', 'and it must not hand out a pid to kill')

  // The BLOCKING branch is the one that still waits, and it still says so.
  const blocked = buildDoctorRows(
    launchProbes({ incumbent: { cwd: '/agents/ava', hit: { pid: 4242, reason: 'same-cwd' }, blocks: true } }),
  )
  assert.match(rowById(blocked, 'incumbent').detail, /hoai waits for it/)
})

test('probeIncumbent: an injected process table classifies through incumbentBlocks', () => {
  const holding = probeIncumbent({
    cwd: '/agents/ava',
    uid: 501,
    ownPid: 9,
    listProcesses: () => [{ pid: 4242, uid: 501, comm: 'claude', cwd: '/agents/ava' }],
  })
  assert.deepEqual(holding.hit, { pid: 4242, reason: 'same-cwd' })
  assert.equal(holding.blocks, true)
  // An unreadable cwd is a hit that does not block.
  const unknown = probeIncumbent({
    cwd: '/agents/ava',
    uid: 501,
    ownPid: 9,
    listProcesses: () => [{ pid: 77, uid: 501, comm: 'claude', cwd: null }],
  })
  assert.equal(unknown.hit?.reason, 'unreadable-cwd')
  assert.equal(unknown.blocks, false)
  // Nothing at all.
  const clear = probeIncumbent({ cwd: '/agents/ava', uid: 501, ownPid: 9, listProcesses: () => [] })
  assert.equal(clear.hit, null)
  assert.equal(clear.blocks, false)
})

test('probeIncumbent: the doctor never reports its OWN claude session as the incumbent', () => {
  // Defect F6, 2026-09-21. `hoai doctor` is normally typed INTO a claude
  // session whose cwd is the folder being screened, so the node process
  // running this probe has a claude ANCESTOR sitting right there. Excluding
  // only ownPid left that ancestor looking like a same-cwd incumbent: a
  // reviewer measured the probe naming the pid of the claude running it, and
  // the row then told the operator to kill the session they were typing into.
  // The ancestry walk (hoai-core selfAndAncestorPids, over the ppid
  // defaultListProcesses now reports) is what tells the caller apart from a
  // rival, so the list it is given has to CONTAIN the caller's own row.
  const ownSession = [
    { pid: 77299, ppid: 1, uid: 501, comm: 'claude', cwd: '/agents/ava' },
    { pid: 77400, ppid: 77299, uid: 501, comm: 'bash', cwd: '/agents/ava' },
    { pid: 8100, ppid: 77400, uid: 501, comm: 'node', cwd: '/agents/ava' },
  ]
  const mine = probeIncumbent({
    cwd: '/agents/ava',
    uid: 501,
    ownPid: 8100,
    listProcesses: () => ownSession,
  })
  assert.equal(mine.hit, null, 'our own claude ancestor is the caller, not a rival for the pin')
  assert.equal(mine.blocks, false)

  // A stranger in the same folder is still found, so the exclusion is not a
  // way of never seeing anything.
  const rival = probeIncumbent({
    cwd: '/agents/ava',
    uid: 501,
    ownPid: 8100,
    listProcesses: () => [...ownSession, { pid: 9001, ppid: 1, uid: 501, comm: 'claude', cwd: '/agents/ava' }],
  })
  assert.deepEqual(rival.hit, { pid: 9001, reason: 'same-cwd' }, 'a claude that is not ours still blocks')
  assert.equal(rival.blocks, true)
})

test('probeIncumbent: a process list that cannot be read is not evidence of an incumbent', () => {
  const probe = probeIncumbent({
    cwd: '/agents/ava',
    uid: 501,
    ownPid: 9,
    listProcesses: () => {
      throw new Error('ps unavailable')
    },
  })
  assert.equal(probe.hit, null)
  assert.equal(probe.blocks, false)
  assert.match(String(probe.error), /ps unavailable/)
})

// ── UNPROVEN (the row that lied) ─────────────────────────────────────────────

test('renderDoctorTable: an UNPROVEN row prints UNPROVEN, never SKIP, and the columns stay aligned', () => {
  const rows = [
    { id: 'a', label: 'Alpha check', ok: true, detail: 'fine', fix: '' },
    { id: 'b', label: 'Beta', ok: UNPROVEN, detail: 'never proven', fix: '' },
    { id: 'c', label: 'Gamma', ok: null, detail: 'did not run', fix: '' },
    { id: 'd', label: 'Delta', ok: false, detail: 'broken', fix: 'run delta-fix' },
  ]
  const out = renderDoctorTable(rows)
  const lines = out.split('\n')
  const checkCol = lines[0].indexOf('CHECK')
  assert.ok(lines[3].startsWith('UNPROVEN'), `expected UNPROVEN, got: ${lines[3]}`)
  assert.equal(lines[3].indexOf('Beta'), checkCol, 'the widest status still sets the column')
  // SKIP keeps its exact old meaning and its own row.
  assert.ok(lines[4].startsWith('SKIP'))
  assert.equal(lines[4].indexOf('Gamma'), checkCol)
  assert.ok(lines[2].startsWith('PASS'))
  assert.equal(lines[2].indexOf('Alpha check'), checkCol)
  assert.ok(lines[5].startsWith('FAIL'))
  // An unproven row is not a failure, so it gets no Fix line.
  assert.equal(lines.filter((l: string) => l.startsWith('Fix')).length, 1)
  assert.ok(!/[\u2500-\u257f\u2013\u2014]/.test(out), 'plain spaces and dashes only')
})

test('doctor live row: UNPROVEN when never proven, PASS once a session has acted on a channel event', () => {
  const never = buildDoctorRows(launchProbes({ liveMarker: { exists: false, ageMs: null } }))
  const unproven = rowById(never, 'live')
  assert.strictEqual(unproven.ok, UNPROVEN, 'never proven is UNPROVEN, not SKIP: SKIP reads as not applicable')
  assert.notStrictEqual(unproven.ok, null)
  assert.match(unproven.detail, /never proven/)
  assert.ok(unproven.fix.length > 0, 'the unproven row still names the next action')
  assert.ok(renderDoctorTable(never).includes('UNPROVEN  Channel liveness'))

  const proven = buildDoctorRows(launchProbes({ liveMarker: { exists: true, ageMs: 120_000 } }))
  const live = rowById(proven, 'live')
  assert.strictEqual(live.ok, true)
  assert.match(live.detail, /acted on a channel event/)
  assert.ok(!renderDoctorTable(proven).includes('UNPROVEN'))
})

test('preflightVerdict: an UNPROVEN row gates exactly as ok:null always did', () => {
  // Unchanged for every existing row: the truth table above still holds, and a
  // machine that has simply never launched must not fail the bootstrap gate.
  const withUnprovenLive = buildDoctorRows(launchProbes({ liveMarker: { exists: false, ageMs: null } }))
  assert.strictEqual(rowById(withUnprovenLive, 'live').ok, UNPROVEN)
  const verdict = preflightVerdict(withUnprovenLive)
  assert.equal(verdict.ok, true, 'an unproven optional row must never fail preflight')
  assert.deepEqual(verdict.failing, [])
  // And it is identical to the ok:null the row used to carry.
  const asNull = withUnprovenLive.map((r: { id: string; ok: RowStatus }) =>
    r.id === 'live' ? { ...r, ok: null as RowStatus } : r,
  )
  assert.deepEqual(preflightVerdict(asNull), verdict)
  // A REQUIRED row that is merely unproven is still not green, exactly as null.
  for (const id of ['claude', 'auth', 'handshake', 'mcp-list']) {
    const rows = withUnprovenLive.map((r: { id: string; ok: RowStatus }) =>
      r.id === id ? { ...r, ok: UNPROVEN as RowStatus } : r,
    )
    const bad = preflightVerdict(rows)
    assert.equal(bad.ok, false, `${id} unproven must fail preflight`)
    assert.ok(bad.failing.includes(id))
  }
})

test('preflightVerdict: a failing launch row fails the gate like any other non-required row', () => {
  const rows = buildDoctorRows(
    launchProbes({
      trust: { cwd: '/agents/ava', configPath: '/home/kc/.claude.json', accepted: false, reason: 'no-entry', matchedKey: '' },
    }),
  )
  const verdict = preflightVerdict(rows)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.failing, ['trust'])
})

test('buildDoctorRows: no em or en dashes in the launch rows or an unproven table', () => {
  const broken = launchProbes({
    trust: { cwd: '/agents/ava', configPath: '/home/kc/.claude.json', accepted: false, reason: 'not-accepted', matchedKey: '/agents/ava' },
    bypass: { settingsPath: '/home/kc/.claude/settings.json', accepted: false, reason: 'no-settings-file' },
    gate: { needed: true, method: 'clone', helper: 'expect', expectPath: '' },
    incumbent: { cwd: '/agents/ava', hit: { pid: 4242, reason: 'same-cwd' }, blocks: true },
    liveMarker: { exists: false, ageMs: null },
  })
  for (const probes of [launchProbes({ liveMarker: { exists: false, ageMs: null } }), broken]) {
    const rows = buildDoctorRows(probes)
    assert.ok(!/[\u2013\u2014]/.test(JSON.stringify(rows)), 'rows must not contain em or en dashes')
    assert.ok(!/[\u2013\u2014]/.test(renderDoctorTable(rows)), 'the table must not contain em or en dashes')
  }
})


// -- the desktop one-click preflight, and trust as Claude Code really applies it (2026-09-22) --
//
// Measured end to end on 2026-09-21 against plugin main (0.42.2): the desktop
// app runs `hoai doctor --preflight --assistant-id N --backend URL` from the
// HOME directory with NO --workdir. The Folder trust row probed $HOME, which
// pairing never seeds, the row gates the preflight, and the run ended
// "[bgos-doctor] preflight FAILED: trust" AFTER the one time pair code was
// spent. Every desktop install, on every machine whose home is not a trusted
// Claude Code folder, which is every non-technical owner's machine.

test('ancestorDirs: nearest first, root included, in the path own separator style', () => {
  assert.deepEqual(ancestorDirs('/Users/kc/.bgos-agent/12-workspace'), ['/Users/kc/.bgos-agent', '/Users/kc', '/Users', '/'])
  assert.deepEqual(ancestorDirs('/Users/kc/'), ['/Users', '/'])
  assert.deepEqual(ancestorDirs('C:\\Users\\kc\\agent'), ['C:\\Users\\kc', 'C:\\Users', 'C:\\'])
  assert.deepEqual(ancestorDirs('C:/Users/kc'), ['C:/Users', 'C:/'])
  // Nothing above a root, and a bare name has no ancestors to claim.
  assert.deepEqual(ancestorDirs('/'), [])
  assert.deepEqual(ancestorDirs('relative'), [])
  assert.deepEqual(ancestorDirs(''), [])
})

test('probeFolderTrust: a folder under a TRUSTED ANCESTOR is trusted, because that is how Claude Code behaves', () => {
  // Measured on 2.1.278: a brand new folder under a trusted /private/tmp went
  // straight past the trust dialog, while a sibling outside it still got one.
  const raw = JSON.stringify({ projects: { '/Users/kc/hoai-agents': { hasTrustDialogAccepted: true } } })
  const probe = probeFolderTrust({
    env: {},
    home: '/Users/kc',
    cwd: '/Users/kc/hoai-agents/athena',
    readFile: () => raw,
    resolvePath: (p: string) => p,
  })
  assert.strictEqual(probe.accepted, true)
  assert.equal(probe.reason, 'accepted')
  assert.equal(probe.inheritedFrom, '/Users/kc/hoai-agents')
  assert.equal(probe.cwd, '/Users/kc/hoai-agents/athena', 'the row still names the folder that was asked about')
})

test('probeFolderTrust: a trusted ancestor wins even over an EXPLICIT false entry on the folder itself', () => {
  // Also measured: child seeded false beside a parent seeded true, no dialog.
  // Claude Code writes a false entry for every folder it opens, so without
  // this rule the row FAILs most folders under any trusted parent.
  const raw = JSON.stringify({
    projects: {
      '/private/tmp': { hasTrustDialogAccepted: true },
      '/private/tmp/work': { hasTrustDialogAccepted: false },
    },
  })
  const probe = probeFolderTrust({ env: {}, home: '/h', cwd: '/private/tmp/work', readFile: () => raw, resolvePath: (p: string) => p })
  assert.strictEqual(probe.accepted, true)
  assert.equal(probe.inheritedFrom, '/private/tmp')
})

test('probeFolderTrust: the ancestor walk also runs on the RESOLVED spelling, and a merely SIBLING folder inherits nothing', () => {
  const raw = JSON.stringify({ projects: { '/private/tmp/agents': { hasTrustDialogAccepted: true } } })
  const viaSymlink = probeFolderTrust({
    env: {},
    home: '/h',
    cwd: '/tmp/agents/a',
    readFile: () => raw,
    resolvePath: (p: string) => p.replace(/^\/tmp\//, '/private/tmp/'),
  })
  assert.strictEqual(viaSymlink.accepted, true)
  assert.equal(viaSymlink.inheritedFrom, '/private/tmp/agents')
  const sibling = probeFolderTrust({ env: {}, home: '/h', cwd: '/private/tmp/agents-other/a', readFile: () => raw, resolvePath: (p: string) => p })
  assert.strictEqual(sibling.accepted, false, 'a name that merely STARTS WITH a trusted path is not inside it')
  assert.equal(sibling.reason, 'no-entry')
})

test('probeFolderTrust: an ancestor that is present but NOT accepted grants nothing', () => {
  const raw = JSON.stringify({ projects: { '/a': { hasTrustDialogAccepted: false }, '/a/b': {} } })
  const probe = probeFolderTrust({ env: {}, home: '/h', cwd: '/a/b', readFile: () => raw, resolvePath: (p: string) => p })
  assert.strictEqual(probe.accepted, false)
  assert.equal(probe.reason, 'not-accepted')
  assert.equal(probe.inheritedFrom, undefined)
})

test('resolveLaunchFolder: flag, then a cwd pinned to THIS agent, then the pinned default workspace for the id, else an unnamed cwd', () => {
  const pins: Record<string, string> = { '/agents/a': '7', '/h/.bgos-agent/12-workspace': '12', '/h/.bgos-agent/99-workspace': '12' }
  const readPin = (dir: string) => pins[dir] ?? ''
  assert.deepEqual(resolveLaunchFolder({ workdirFlag: '/x', cwd: '/agents/a', home: '/h', assistantId: '12', readPin }), { dir: '/x', source: 'flag' })
  // No id asked about: the folder's own pin names the subject.
  assert.deepEqual(resolveLaunchFolder({ cwd: '/agents/a', home: '/h', readPin }), { dir: '/agents/a', source: 'cwd-pin' })
  // The id asked about IS this folder's agent.
  assert.deepEqual(resolveLaunchFolder({ cwd: '/agents/a', home: '/h', assistantId: '7', readPin }), { dir: '/agents/a', source: 'cwd-pin' })
  // THE DESKTOP CASE: standing in HOME, only the id is known.
  assert.deepEqual(resolveLaunchFolder({ cwd: '/h', home: '/h', assistantId: '12', readPin }), {
    dir: '/h/.bgos-agent/12-workspace',
    source: 'default-workspace',
  })
  // A workspace pinned to a DIFFERENT agent is not this agent's folder.
  assert.deepEqual(resolveLaunchFolder({ cwd: '/h', home: '/h', assistantId: '99', readPin }), { dir: '/h', source: 'cwd-unpinned' })
  // No id, or an id that is not a plain number, never builds a path.
  assert.deepEqual(resolveLaunchFolder({ cwd: '/h', home: '/h', readPin }), { dir: '/h', source: 'cwd-unpinned' })
  assert.deepEqual(resolveLaunchFolder({ cwd: '/h', home: '/h', assistantId: '../../etc', readPin }), { dir: '/h', source: 'cwd-unpinned' })
})

test('resolveLaunchFolder: a STALE pin in cwd for another agent does not outrank the id that was asked about', () => {
  // Found by review. A HOME that still carries a pin from a pairing made there
  // (what F9 now refuses) would otherwise drag the desktop preflight straight
  // back to probing HOME, the exact failure this resolution exists to end.
  const pins: Record<string, string> = { '/h': '5', '/h/.bgos-agent/12-workspace': '12' }
  const readPin = (dir: string) => pins[dir] ?? ''
  assert.deepEqual(resolveLaunchFolder({ cwd: '/h', home: '/h', assistantId: '12', readPin }), {
    dir: '/h/.bgos-agent/12-workspace',
    source: 'default-workspace',
  })
  // And with no workspace for that id, another agent's folder is NOT passed off as this agent's.
  assert.deepEqual(resolveLaunchFolder({ cwd: '/h', home: '/h', assistantId: '44', readPin }), { dir: '/h', source: 'cwd-unpinned' })
})

test('doctor trust row: an UNNAMED folder renders UNPROVEN with what was seen, and does not abort the install', () => {
  const trust = { cwd: '/Users/kc', configPath: '/Users/kc/.claude.json', accepted: false, reason: 'no-entry', matchedKey: '' }
  const rows = buildDoctorRows(healthyProbes({ trust, launchFolder: { dir: '/Users/kc', source: 'cwd-unpinned' } }))
  const row = rows.find((r) => r.id === 'trust')!
  assert.strictEqual(row.ok, UNPROVEN)
  assert.match(row.detail, /no agent folder was named/)
  assert.match(row.detail, /\/Users\/kc/)
  assert.match(row.detail, /no-entry/, 'what was actually seen stays on the record')
  // The table prints Fix lines for FAIL rows only, so the remedy must live in the detail.
  assert.match(row.detail, /Pass --workdir <the agent folder>/)
  assert.match(renderDoctorTable(rows), /Pass --workdir/)
  const green = ['claude', 'auth', 'handshake', 'mcp-list'].map((id) => ({ id, ok: true }))
  assert.deepEqual(preflightVerdict([...green, row]), { ok: true, failing: [] })
  assert.match(renderDoctorTable(rows), /UNPROVEN\s+Folder trust/)
})

test('doctor trust row: a NAMED folder that is not trusted still FAILs and still gates, whatever named it', () => {
  // The exemption is narrow. The three sources that name a real agent folder
  // keep the gate exactly as it was.
  const trust = { cwd: '/agents/a', configPath: '/h/.claude.json', accepted: false, reason: 'no-entry', matchedKey: '' }
  const green = ['claude', 'auth', 'handshake', 'mcp-list'].map((id) => ({ id, ok: true }))
  for (const source of ['flag', 'cwd-pin', 'default-workspace'] as const) {
    const row = buildDoctorRows(healthyProbes({ trust, launchFolder: { dir: '/agents/a', source } })).find((r) => r.id === 'trust')!
    assert.strictEqual(row.ok, false, source)
    assert.deepEqual(preflightVerdict([...green, row]), { ok: false, failing: ['trust'] }, source)
  }
  // An older caller that passes no launchFolder at all keeps the old behaviour.
  const legacy = buildDoctorRows(healthyProbes({ trust })).find((r) => r.id === 'trust')!
  assert.strictEqual(legacy.ok, false)
})

test('doctor trust row: inherited trust PASSes and says which parent it came through', () => {
  const trust = {
    cwd: '/Users/kc/hoai-agents/athena',
    configPath: '/Users/kc/.claude.json',
    accepted: true,
    reason: 'accepted',
    matchedKey: '/Users/kc/hoai-agents',
    inheritedFrom: '/Users/kc/hoai-agents',
  }
  const row = buildDoctorRows(healthyProbes({ trust, launchFolder: { dir: trust.cwd, source: 'cwd-pin' } })).find((r) => r.id === 'trust')!
  assert.strictEqual(row.ok, true)
  assert.match(row.detail, /through its trusted parent \/Users\/kc\/hoai-agents/)
})

test('the desktop one-click preflight, end to end through the pure parts: HOME as cwd, only the id known, workspace seeded by pairing', () => {
  const home = '/Users/kc'
  const workspace = `${home}/.bgos-agent/936-workspace`
  const launchFolder = resolveLaunchFolder({ cwd: home, home, assistantId: '936', readPin: (dir: string) => (dir === workspace ? '936' : '') })
  assert.equal(launchFolder.dir, workspace, 'the doctor must check the agent folder, not the folder it happens to stand in')
  const trust = probeFolderTrust({
    env: {},
    home,
    cwd: launchFolder.dir,
    readFile: () => JSON.stringify({ projects: { [workspace]: { hasTrustDialogAccepted: true } } }),
    resolvePath: (p: string) => p,
  })
  const row = buildDoctorRows(healthyProbes({ trust, launchFolder })).find((r) => r.id === 'trust')!
  assert.strictEqual(row.ok, true)
  const green = ['claude', 'auth', 'handshake', 'mcp-list'].map((id) => ({ id, ok: true }))
  assert.deepEqual(preflightVerdict([...green, row]), { ok: true, failing: [] })
})


// -- the paired topology: a folder with NO .mcp.json that the supervisor may launch (2026-09-22) --
//
// `hoai-agent install --always-on` refused every workspace with no .mcp.json,
// which made desktop one-click impossible on a fresh workspace (measured: "no
// .mcp.json ... and no creds given"). The gate exists because an agent once came
// back DEAF on the wrong channel spec, so it is not skipped: the launch is
// allowed only when the folder pin, the agent's credentials and the marketplace
// install record all agree, as read by the verifiers the repo already has.

const TOPO = { workdir: '/h/.bgos-agent/12-workspace', assistantId: '12', home: '/h', env: {} }
const allGood = {
  readPin: () => '12',
  exists: () => true,
  liveSafe: () => true,
  route: () => ({ spec: 'plugin:hoai@some-marketplace', source: 'install-method', method: 'marketplace', serverName: '', conflict: false, reason: '' }),
}

test('provePairedTopology: pin, credentials and a marketplace route together prove it, and the channel is the RESOLVER spec, never one typed here', () => {
  const verdict = provePairedTopology({ ...TOPO, ...allGood })
  assert.deepEqual([verdict.ok, verdict.channel, verdict.reason], [true, 'plugin:hoai@some-marketplace', ''])
  assert.equal(pairedTopologyLine(verdict), 'HOAI_TOPOLOGY_OK plugin:hoai@some-marketplace')
})

test('provePairedTopology: each missing proof is a NAMED refusal, and no channel is ever returned with one', () => {
  const R = PAIRED_TOPOLOGY_REASONS
  const cases: Array<[string, Record<string, unknown>, string, RegExp]> = [
    ['never paired', { readPin: () => '' }, R.NO_FOLDER_PIN, /carries no \.bgos-agent-id pin/],
    ['pinned to another agent', { readPin: () => '7' }, R.PIN_MISMATCH, /pinned to agent 7, not 12/],
    ['no credentials for that id', { exists: () => false }, R.NO_AGENT_CREDENTIALS, /credentials-12\.json/],
    ['pairing verifier says no', { liveSafe: () => false }, R.NOT_LIVE_SAFE, /would not resolve agent 12/],
    ['the folder publishes its own server', { route: () => ({ spec: 'server:bgos', source: 'workspace', method: 'marketplace', serverName: 'bgos', conflict: false, reason: '' }) }, R.WORKSPACE_DECLARES_SERVER, /declares its own MCP server bgos/],
    ['the running code is a clone', { route: () => ({ spec: CLONE_CHANNEL_SPEC, source: 'install-method', method: 'clone', serverName: '', conflict: false, reason: '' }) }, R.INSTALLER_IS_A_CLONE, /running from a plugin clone/],
    ['no install record', { route: () => ({ spec: '', source: 'install-method', method: 'unknown', serverName: '', conflict: false, reason: 'records no HOAI plugin install' }) }, R.PLUGIN_NOT_INSTALLED, /not installed where the background agent will look.*records no HOAI plugin install/],
    ['a marketplace method with no plugin spec', { route: () => ({ spec: 'server:bgos', source: 'install-method', method: 'marketplace', serverName: '', conflict: false, reason: '' }) }, R.PLUGIN_NOT_INSTALLED, /not installed/],
  ]
  for (const [name, override, reason, detail] of cases) {
    const verdict = provePairedTopology({ ...TOPO, ...allGood, ...override })
    assert.equal(verdict.ok, false, name)
    assert.equal(verdict.reason, reason, name)
    assert.equal(verdict.channel, '', `${name}: a refusal must never carry a channel someone could launch on`)
    assert.match(verdict.detail, detail, name)
    assert.match(pairedTopologyLine(verdict), new RegExp(`^HOAI_TOPOLOGY_REFUSED ${reason} `), name)
    assert.doesNotMatch(pairedTopologyLine(verdict), /\n/, 'one line, because bash parses it')
  }
  assert.equal(provePairedTopology({ ...TOPO, ...allGood, assistantId: '../etc' }).reason, R.NO_ASSISTANT_ID)
  assert.equal(provePairedTopology({ ...TOPO, ...allGood, workdir: '' }).reason, R.NO_ASSISTANT_ID)
})

test('provePairedTopology: both verifiers are asked about the SUPERVISED environment, not the installing shell', () => {
  // The launchd plist and the systemd unit carry no CLAUDE_CONFIG_DIR. A plugin
  // installed only under the installing shell's custom config dir is a plugin
  // the background session never loads: that must read as NOT installed.
  const seen: Array<Record<string, string | undefined>> = []
  const env = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/custom', CLAUDE_PLUGIN_ROOT: '/custom/plugins/x', BGOS_ASSISTANT_ID: '99', BGOS_CREDENTIALS_PATH: '/elsewhere.json' }
  provePairedTopology({
    ...TOPO,
    ...allGood,
    env,
    liveSafe: (o: { env: Record<string, string | undefined> }) => (seen.push(o.env), true),
    route: (o: { env: Record<string, string | undefined> }) => (seen.push(o.env), allGood.route()),
  })
  assert.equal(seen.length, 2)
  for (const e of seen) {
    assert.deepEqual(Object.keys(e), ['PATH'])
  }
  assert.deepEqual(supervisedEnv(env), { PATH: '/usr/bin' })
  assert.equal(env.CLAUDE_CONFIG_DIR, '/custom', 'the caller env is not mutated')
  // And the refusal says so, in words the owner can act on.
  const refused = provePairedTopology({ ...TOPO, ...allGood, env, route: () => ({ spec: '', source: 'install-method', method: 'unknown', serverName: '', conflict: false, reason: '' }) })
  assert.match(refused.detail, /CLAUDE_CONFIG_DIR=\/custom, which the background service does not inherit/)
})

function pairedHome(): { home: string; workspace: string; npxBin: string } {
  const home = mkdtempSync(join(tmpdir(), 'hoai-topology-'))
  const workspace = join(home, '.bgos-agent', '936-workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, '.bgos-agent-id'), '936\n')
  writeFileSync(join(home, '.bgos-agent', 'credentials-936.json'), JSON.stringify({ assistantId: 936 }))
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath: join(home, '.claude/plugins/cache/hoai/hoai/0.42.3'), version: '0.42.3' }] } }),
  )
  // where npx really unpacks the package the desktop launch line runs
  return { home, workspace, npxBin: join(home, '.npm', '_npx', 'abc123', 'node_modules', 'claude-channel-bgos', 'bin') }
}

test('provePairedTopology, with the REAL verifiers on a real folder: what pairing and the plugin step leave behind is proven, from where npx runs it', () => {
  const { home, workspace, npxBin } = pairedHome()
  const verdict = provePairedTopology({ workdir: workspace, assistantId: '936', env: {}, home, scriptDir: npxBin })
  assert.deepEqual([verdict.ok, verdict.channel], [true, MARKETPLACE_CHANNEL_SPEC], verdict.detail)
})

test('provePairedTopology, with the REAL verifiers: the same folder is refused when any one of the three is taken away', () => {
  const R = PAIRED_TOPOLOGY_REASONS
  const noPlugin = pairedHome()
  writeFileSync(join(noPlugin.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }))
  assert.equal(provePairedTopology({ workdir: noPlugin.workspace, assistantId: '936', env: {}, home: noPlugin.home, scriptDir: noPlugin.npxBin }).reason, R.PLUGIN_NOT_INSTALLED)

  const clone = pairedHome()
  assert.equal(
    provePairedTopology({ workdir: clone.workspace, assistantId: '936', env: {}, home: clone.home, scriptDir: join(clone.home, 'bgos-claude-plugin', 'bin') }).reason,
    R.INSTALLER_IS_A_CLONE,
    'the launcher resolver calls code outside the plugins dir a clone, and this function must not disagree with it',
  )

  const declares = pairedHome()
  writeFileSync(join(declares.workspace, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['x'], env: { BGOS_ASSISTANT_ID: '936' } } } }))
  const v = provePairedTopology({ workdir: declares.workspace, assistantId: '936', env: {}, home: declares.home, scriptDir: declares.npxBin })
  assert.equal(v.reason, R.WORKSPACE_DECLARES_SERVER, v.detail)

  const otherAgent = pairedHome()
  assert.equal(provePairedTopology({ workdir: otherAgent.workspace, assistantId: '937', env: {}, home: otherAgent.home, scriptDir: otherAgent.npxBin }).reason, R.PIN_MISMATCH)

  const customConfig = pairedHome()
  // the plugin exists ONLY under a custom config dir the installing shell exports
  const custom = join(customConfig.home, 'custom-claude')
  mkdirSync(join(custom, 'plugins'), { recursive: true })
  writeFileSync(join(custom, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath: join(custom, 'plugins/cache/hoai/hoai/0.42.3'), version: '0.42.3' }] } }))
  writeFileSync(join(customConfig.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }))
  const c = provePairedTopology({ workdir: customConfig.workspace, assistantId: '936', env: { CLAUDE_CONFIG_DIR: custom }, home: customConfig.home, scriptDir: customConfig.npxBin })
  assert.equal(c.reason, R.PLUGIN_NOT_INSTALLED, 'installed for the shell, invisible to the background service: that is a deaf agent, so it is a refusal')
  assert.match(c.detail, /does not inherit/)
})

test('bgos-doctor --prove-paired-topology: one line, exit 0 or 1, and none of the doctor table machinery runs', async () => {
  const parsed = parseDoctorArgs(['--prove-paired-topology', '--workdir', '/w', '--assistant-id', '5'])
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.args.provePairedTopology, true)
  assert.equal(parseDoctorArgs([]).args.provePairedTopology, false)

  const { home, workspace, npxBin } = pairedHome()
  const lines: string[] = []
  const ok = await doctorMain(['--prove-paired-topology', '--workdir', workspace, '--assistant-id', '936'], { env: {}, home, scriptDir: npxBin, print: (l: string) => lines.push(l) })
  assert.equal(ok, 0)
  assert.deepEqual(lines, [`HOAI_TOPOLOGY_OK ${MARKETPLACE_CHANNEL_SPEC}`])

  lines.length = 0
  const refused = await doctorMain(['--prove-paired-topology', '--workdir', join(home, 'nowhere'), '--assistant-id', '936'], { env: {}, home, scriptDir: npxBin, print: (l: string) => lines.push(l) })
  assert.equal(refused, 1)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^HOAI_TOPOLOGY_REFUSED paired-topology:no-folder-pin /)
})
