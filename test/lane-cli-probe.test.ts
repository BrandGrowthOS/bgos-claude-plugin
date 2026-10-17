/**
 * PERSON LANES, the CLI probe and the `person_lanes` declaration (shared
 * agents Phase 3, P3; design 4.4).
 *
 * `person_lanes` is declared only when the INSTALLED CLI has every flag the
 * locked launch needs; otherwise the plugin behaves exactly as today and the
 * backend keeps the agent's single mind. The probe:
 *   - reads `claude --help` for the flags it lists, `--permission-mode
 *     <bogus>` for the `dontAsk` mode, and a bare
 *     `--dangerously-load-development-channels` (hidden from the help) for
 *     "argument missing" versus "unknown option";
 *   - is CACHED per binary (real path, size, modification time): asked once,
 *     asked again only when the binary changes;
 *   - never says yes on Windows or without `expect`.
 *
 * The outputs below are the CLI's own wording, as measured on Claude Code
 * 2.1.302 on 2026-10-17.
 *
 * Run with: npx tsx --test test/lane-cli-probe.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and these
// tests assume POSIX hosts (an expect binary, 0600 modes, symlink realpaths), so the
// file is skipped there. Each platform rule is still asserted through the injected
// platform on the macOS and Linux runners.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyLaneCliProbe, PERSON_LANES_TOKEN } from '../lib/lane-core.mjs'
import { laneCliSupport, probeLaneCli } from '../lib/lane-cli-probe.mjs'
import { declaredCapabilities } from '../lib/declared-capabilities.ts'

const HELP_2_1_302 = [
  'Usage: claude [options] [command] [prompt]',
  '  --debug-file <path>                   Write debug logs to a specific file path (implicitly enables debug mode)',
  '  --mcp-config <configs...>             Load MCP servers from JSON files or strings (space-separated)',
  '  --permission-mode <mode>              Permission mode to use for the session',
  '  --restricted                          Restricted mode: removes the built-in',
  '  -r, --resume [value]                  Resume a conversation by session ID',
  '  --session-id <uuid>                   Use a specific session ID for the conversation',
  '  --setting-sources <sources>           Comma-separated list of setting sources',
  '  --settings <file-or-json>             Path to a settings JSON file',
  '  --strict-mcp-config                   Only use MCP servers from --mcp-config,',
  '  --tools <tools...>                    Specify the list of available tools from',
  '  --disallowed-tools <tools...>',
].join('\n')
const MODES_2_1_302 = "error: option '--permission-mode <mode>' argument 'hoai-lane-probe' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan."
const DEV_KNOWN = "error: option '--dangerously-load-development-channels <servers...>' argument missing"
const DEV_UNKNOWN = "error: unknown option '--dangerously-load-development-channels'"

function outs(help = HELP_2_1_302, modes = MODES_2_1_302, dev = DEV_KNOWN) {
  return {
    help: { stdout: help, stderr: '' },
    mode: { stdout: '', stderr: modes },
    hidden: { '--dangerously-load-development-channels': { stdout: '', stderr: dev } },
  }
}

test('the measured 2.1.302 outputs say yes', () => {
  assert.deepEqual(classifyLaneCliProbe(outs()), { ok: true, missing: [] })
})

test('each missing piece says no, and names itself', () => {
  assert.deepEqual(classifyLaneCliProbe(outs(HELP_2_1_302.replace('--restricted ', '--safe-mode   '))).missing, ['--restricted'])
  assert.deepEqual(classifyLaneCliProbe(outs(HELP_2_1_302.replace('  --tools <tools...>', '  --toolz <tools...>'))).missing, ['--tools'])
  // --disallowed-tools and --strict-mcp-config do not stand in for --tools and --mcp-config.
  const noMcp = HELP_2_1_302.split('\n').filter((l) => !l.startsWith('  --mcp-config')).join('\n')
  assert.deepEqual(classifyLaneCliProbe(outs(noMcp)).missing, ['--mcp-config'])
  assert.deepEqual(classifyLaneCliProbe(outs(HELP_2_1_302, MODES_2_1_302.replace('dontAsk, ', ''))).missing, ['--permission-mode dontAsk'])
  assert.deepEqual(classifyLaneCliProbe(outs(HELP_2_1_302, MODES_2_1_302, DEV_UNKNOWN)).missing, ['--dangerously-load-development-channels'])
  assert.equal(classifyLaneCliProbe(outs('', '', '')).ok, false)
})

test('probeLaneCli asks exactly the three kinds of question, none of which starts a session', () => {
  const asked: string[][] = []
  const run = ((_path: string, args: string[]) => {
    asked.push(args)
    if (args[0] === '--help') return { status: 0, stdout: HELP_2_1_302, stderr: '' }
    if (args[0] === '--permission-mode') return { status: 1, stdout: '', stderr: MODES_2_1_302 }
    return { status: 1, stdout: '', stderr: DEV_KNOWN }
  }) as never
  assert.deepEqual(probeLaneCli('/bin/claude', { run }), { ok: true, missing: [] })
  assert.deepEqual(asked, [['--dangerously-load-development-channels'], ['--help'], ['--permission-mode', 'hoai-lane-probe']])
})

function fakeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, '#!/bin/sh\n')
  chmodSync(p, 0o755)
  return p
}

test('the answer is cached per binary and asked again only when the binary changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-probe-'))
  try {
    const bin = join(dir, 'bin')
    const claude = fakeBin(bin, 'claude')
    fakeBin(bin, 'expect')
    const cachePath = join(dir, 'state', 'lane-cli-probe.json')
    let probes = 0
    const probe = () => {
      probes += 1
      return { ok: true, missing: [] }
    }
    const ask = () => laneCliSupport({ claudePath: claude, cachePath, platform: 'darwin', pathVar: bin, probe })
    assert.deepEqual(ask(), { ok: true, missing: [], cached: false })
    assert.deepEqual(ask(), { ok: true, missing: [], cached: true })
    assert.equal(probes, 1, 'asked once')
    utimesSync(claude, new Date(), new Date(Date.now() + 60_000))
    assert.equal(ask().cached, false, 'a new binary is asked again')
    assert.equal(probes, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('never yes on Windows, without expect, or without a claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-probe-'))
  try {
    const bin = join(dir, 'bin')
    const claude = fakeBin(bin, 'claude')
    const probe = () => ({ ok: true, missing: [] })
    assert.equal(laneCliSupport({ claudePath: claude, cachePath: join(dir, 'c.json'), platform: 'darwin', pathVar: bin, probe }).reason, 'no_expect')
    fakeBin(bin, 'expect')
    assert.equal(laneCliSupport({ claudePath: claude, cachePath: join(dir, 'c.json'), platform: 'win32', pathVar: bin, probe }).reason, 'platform')
    assert.equal(laneCliSupport({ claudePath: null, cachePath: join(dir, 'c.json'), platform: 'darwin', pathVar: bin, probe }).reason, 'no_claude')
    assert.equal(laneCliSupport({ claudePath: join(dir, 'gone'), cachePath: join(dir, 'c.json'), platform: 'darwin', pathVar: bin, probe }).reason, 'no_claude')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('person_lanes is declared only with a passing probe, and only on a pairing', () => {
  const base = { canInjectGoal: false, floorHook: true } as const
  assert.ok(declaredCapabilities({ ...base, personLanes: true, authMode: 'pairing' }).includes(PERSON_LANES_TOKEN))
  assert.ok(!declaredCapabilities({ ...base, personLanes: false, authMode: 'pairing' }).includes(PERSON_LANES_TOKEN))
  assert.ok(!declaredCapabilities({ ...base, authMode: 'pairing' }).includes(PERSON_LANES_TOKEN), 'absent means no')
  assert.ok(!declaredCapabilities({ ...base, personLanes: true, authMode: 'apikey' }).includes(PERSON_LANES_TOKEN))
  // Without it, the list is exactly today's.
  assert.deepEqual(
    declaredCapabilities({ ...base, personLanes: false, authMode: 'pairing' }),
    declaredCapabilities({ ...base, authMode: 'pairing' }),
  )
  assert.equal(PERSON_LANES_TOKEN, 'person_lanes')
})
