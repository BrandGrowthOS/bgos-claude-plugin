/**
 * The threads CLI probe (gate review finding 2): message_threads,
 * thread_sessions and asides are declared only where the claude binary can run
 * a confined lane and a tool-less aside: --restricted (2.1.301 and later),
 * --tools, --fork-session, the stream json flags, the acceptEdits and dontAsk
 * permission modes, and the hidden --max-turns. The answer is cached per
 * binary, and a turn or a side question on a CLI that cannot says why.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  THREADS_HELP_FLAGS,
  THREADS_MIN_CLI,
  classifyThreadsCliProbe,
  parseCliVersion,
  probeThreadsCli,
  threadsCliProblem,
  threadsCliSupport,
} from '../lib/threads-cli.ts'

/** What CLI 2.1.317 prints, cut to the option lines the probe reads. */
const HELP = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Options:',
  '  --fork-session                                    When resuming, create a new session ID',
  '  --include-partial-messages                        Include partial message chunks',
  '  --input-format <format>                           Input format',
  '  --mcp-config <configs...>                         Load MCP servers',
  '  --output-format <format>                          Output format',
  '  --permission-mode <mode>                          Permission mode',
  '  --restricted                                      Ignore user, project and local settings',
  '  -r, --resume [value]                              Resume a conversation',
  '  --settings <file-or-json>                         Load additional settings',
  '  --strict-mcp-config                               Only use MCP servers from --mcp-config',
  '  --tools <tools...>                                Specify the list of available tools',
  '  --verbose                                         Override verbose mode setting',
].join('\n')
const MODES = { stderr: "error: option '--permission-mode <mode>' argument 'hoai-x' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.\n" }
const MAX_TURNS = { stderr: "error: option '--max-turns <turns>' argument missing\n" }
const good = (over: Partial<Parameters<typeof classifyThreadsCliProbe>[0]> = {}) =>
  classifyThreadsCliProbe({ version: { stdout: '2.1.317 (Claude Code)\n' }, help: { stdout: HELP }, mode: MODES, hidden: { '--max-turns': MAX_TURNS }, ...over })

test('a CLI with every flag, both permission modes and version 2.1.301 or later can run threads', () => {
  assert.equal(THREADS_MIN_CLI, '2.1.301')
  assert.deepEqual(good(), { ok: true, missing: [], version: '2.1.317' })
  assert.deepEqual(good({ version: { stdout: '2.1.301 (Claude Code)' } }).ok, true)
  assert.deepEqual(good({ version: { stdout: '2.2.0 (Claude Code)' } }).ok, true)
  assert.deepEqual(good({ version: { stdout: '3.0.0' } }).ok, true)
})

test('an older CLI, one without --restricted or --tools, or without dontAsk, cannot', () => {
  assert.deepEqual(good({ version: { stdout: '2.1.300 (Claude Code)' } }), { ok: false, missing: ['version 2.1.301 or later'], version: '2.1.300' })
  assert.deepEqual(good({ version: { stdout: '2.0.99 (Claude Code)' } }).ok, false)
  assert.deepEqual(good({ version: { stdout: '1.9.999' } }).ok, false)
  for (const flag of THREADS_HELP_FLAGS) {
    const help = HELP.split('\n').filter((l) => !new RegExp(`^\\s+(?:-r, )?${flag}[ ,<\\[]`).test(l)).join('\n')
    assert.deepEqual(good({ help: { stdout: help } }).missing, [flag], flag)
  }
  // A flag named only inside another option's description is not defined.
  assert.deepEqual(good({ help: { stdout: HELP.replace('  --restricted   ', '  --other   ').concat('\n  --x  see --restricted') } }).missing, ['--restricted'])
  assert.deepEqual(good({ mode: { stderr: 'Allowed choices are acceptEdits, default, plan.' } }).missing, ['--permission-mode dontAsk'])
  assert.deepEqual(good({ mode: { stderr: 'Allowed choices are default, dontAsk, plan.' } }).missing, ['--permission-mode acceptEdits'])
  assert.deepEqual(good({ hidden: { '--max-turns': { stderr: "error: unknown option '--max-turns'" } } }).missing, ['--max-turns'])
  assert.deepEqual(good({ version: { stdout: '', stderr: 'spawn ETIMEDOUT' } }), { ok: false, missing: ['a readable version'], version: null })
})

test('the version is read from what claude --version prints', () => {
  assert.deepEqual(parseCliVersion('2.1.317 (Claude Code)\n'), [2, 1, 317])
  assert.deepEqual(parseCliVersion('claude 2.1.301'), [2, 1, 301])
  assert.equal(parseCliVersion(''), null)
  assert.equal(parseCliVersion('Claude Code'), null)
})

test('the probe asks the binary for its version, its help, its modes and the hidden --max-turns', () => {
  const asked: string[][] = []
  const answer = probeThreadsCli('/bin/claude', {
    run: ((_cmd: string, args: string[]) => {
      asked.push(args)
      if (args[0] === '--version') return { status: 0, stdout: '2.1.317 (Claude Code)\n', stderr: '' }
      if (args[0] === '--help') return { status: 0, stdout: HELP, stderr: '' }
      if (args[0] === '--permission-mode') return { status: 1, stdout: '', stderr: MODES.stderr }
      return { status: 1, stdout: '', stderr: MAX_TURNS.stderr }
    }) as never,
  })
  assert.deepEqual(answer, { ok: true, missing: [], version: '2.1.317' })
  assert.deepEqual(asked, [['--version'], ['--help'], ['--permission-mode', 'hoai-lane-probe'], ['--max-turns']])
})

test('the answer is cached per binary, asked again when the binary changes, never cached when the probe read nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threads-cli-'))
  try {
    const bin = join(dir, 'claude')
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    const cachePath = join(dir, 'state', 'threads-cli-probe.json')
    let probes = 0
    let next = { ok: true, missing: [] as string[], version: '2.1.317' as string | null }
    const probe = () => { probes++; return next }
    assert.deepEqual(threadsCliSupport({ claudePath: bin, cachePath, probe }), { ok: true, missing: [], version: '2.1.317', cached: false })
    assert.deepEqual(threadsCliSupport({ claudePath: bin, cachePath, probe }), { ok: true, missing: [], version: '2.1.317', cached: true })
    assert.equal(probes, 1)
    // An updated binary (another size or time) is asked again.
    writeFileSync(bin, '#!/bin/sh\n# 2.1.250\n')
    utimesSync(bin, new Date(), new Date(Date.now() + 5_000))
    next = { ok: false, missing: ['version 2.1.301 or later'], version: '2.1.250' }
    assert.equal(threadsCliSupport({ claudePath: bin, cachePath, probe }).ok, false)
    assert.equal(probes, 2)
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).version, '2.1.250')
    // A probe that read no version (a timeout) is not kept: the next call asks again.
    writeFileSync(bin, '#!/bin/sh\n# again\n')
    utimesSync(bin, new Date(), new Date(Date.now() + 10_000))
    next = { ok: false, missing: ['a readable version'], version: null }
    threadsCliSupport({ claudePath: bin, cachePath, probe })
    threadsCliSupport({ claudePath: bin, cachePath, probe })
    assert.equal(probes, 4)
    assert.deepEqual(threadsCliSupport({ claudePath: null, cachePath, probe }), { ok: false, missing: [], version: null, cached: false, reason: 'no_claude' })
    assert.deepEqual(threadsCliSupport({ claudePath: bin, cachePath, probe, platform: 'win32' }), { ok: false, missing: [], version: null, cached: false, reason: 'platform' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a CLI that cannot run threads gives a plain sentence with the real cause, for a turn and for a side question', () => {
  const old = { ok: false, missing: ['version 2.1.301 or later'], version: '2.1.250' }
  assert.equal(
    threadsCliProblem(old, 'turn'),
    'This turn failed because Claude Code on this computer cannot run threads: it is version 2.1.250 and threads need 2.1.301 or later. Update Claude Code, then send your reply again.',
  )
  assert.equal(
    threadsCliProblem(old, 'aside'),
    'Claude Code on this computer cannot answer side questions: it is version 2.1.250 and they need 2.1.301 or later. Update Claude Code, then ask again.',
  )
  assert.match(String(threadsCliProblem({ ok: false, missing: ['a readable version'], version: null }, 'turn')), /its version could not be read/)
  assert.equal(threadsCliProblem({ ok: true, missing: [], version: '2.1.317' }, 'turn'), null)
  // No binary at all has its own sentence where it is checked.
  assert.equal(threadsCliProblem({ ok: false, missing: [], version: null, reason: 'no_claude' }, 'turn'), null)
})
