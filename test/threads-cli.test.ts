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
  type ThreadsCliAnswer,
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
    assert.deepEqual(threadsCliSupport({ platform: 'darwin', claudePath: bin, cachePath, probe }), { ok: true, missing: [], version: '2.1.317', cached: false })
    assert.deepEqual(threadsCliSupport({ platform: 'darwin', claudePath: bin, cachePath, probe }), { ok: true, missing: [], version: '2.1.317', cached: true })
    assert.equal(probes, 1)
    // An updated binary (another size or time) is asked again.
    writeFileSync(bin, '#!/bin/sh\n# 2.1.250\n')
    utimesSync(bin, new Date(), new Date(Date.now() + 5_000))
    next = { ok: false, missing: ['version 2.1.301 or later'], version: '2.1.250' }
    assert.equal(threadsCliSupport({ platform: 'darwin', claudePath: bin, cachePath, probe }).ok, false)
    assert.equal(probes, 2)
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).version, '2.1.250')
    // A probe that read no version (a timeout) is not kept: the next call asks again.
    writeFileSync(bin, '#!/bin/sh\n# again\n')
    utimesSync(bin, new Date(), new Date(Date.now() + 10_000))
    next = { ok: false, missing: ['a readable version'], version: null }
    threadsCliSupport({ platform: 'darwin', claudePath: bin, cachePath, probe })
    threadsCliSupport({ platform: 'darwin', claudePath: bin, cachePath, probe })
    assert.equal(probes, 4)
    assert.deepEqual(threadsCliSupport({ platform: 'darwin', claudePath: null, cachePath, probe }), { ok: false, missing: [], version: null, cached: false, reason: 'no_claude' })
    assert.deepEqual(threadsCliSupport({ claudePath: bin, cachePath, probe, platform: 'win32' }), { ok: false, missing: [], version: null, cached: false, reason: 'platform' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a CLI that cannot run threads gives a plain sentence with the real cause, for a turn and for a side question', () => {
  const old = { ok: false, missing: ['version 2.1.301 or later'], version: '2.1.250' }
  assert.equal(
    threadsCliProblem(old, 'turn'),
    'Claude Code on this computer cannot run threads: it is version 2.1.250 and threads need 2.1.301 or later. Update Claude Code, then send your reply again.',
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

// -- follow up (Data, item 2): the probe never blocks the event loop, and a failed or hung one is kept --

import { ThreadsCliGate, THREADS_FAILED_RETRY_MS, probeThreadsCliAsync } from '../lib/threads-cli.ts'

function gateRig(probe: (path: string) => Promise<{ ok: boolean; missing: string[]; version: string | null }>) {
  const dir = mkdtempSync(join(tmpdir(), 'threads-gate-'))
  const bin = join(dir, 'claude')
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)
  const clock = { now: 1_000_000 }
  let probes = 0
  const make = (onAnswer?: (answer: ThreadsCliAnswer) => void) => new ThreadsCliGate({
    // These are probe/cache unit cases, separate from the Windows platform gate.
    platform: 'darwin',
    claudePath: () => bin,
    cachePath: join(dir, 'state', 'threads-cli-probe.json'),
    probe: (p) => { probes++; return probe(p) },
    now: () => clock.now,
    onAnswer,
  })
  return { dir, bin, clock, make, probes: () => probes, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the gate answers at once while the probe runs, shares one probe, and keeps its answer', async () => {
  let finish: (a: { ok: boolean; missing: string[]; version: string | null }) => void = () => {}
  const r = gateRig(() => new Promise((done) => { finish = done }))
  try {
    const gate = r.make()
    const t0 = Date.now()
    assert.deepEqual(gate.current(), { ok: false, missing: [], version: null, reason: 'probing' }, 'not yet: threads stay undeclared until the answer')
    assert.ok(Date.now() - t0 < 50, 'never waits on the probe')
    const a = gate.ready()
    const b = gate.ready()
    gate.current()
    assert.equal(r.probes(), 1, 'one probe, shared')
    finish({ ok: true, missing: [], version: '2.1.317' })
    assert.deepEqual(await a, { ok: true, missing: [], version: '2.1.317', cached: false })
    assert.equal((await b).ok, true)
    assert.equal(gate.current().ok, true)
    assert.equal(r.probes(), 1)
  } finally {
    r.cleanup()
  }
})

test('a probe that read nothing (it hung, or failed) is kept for a while: no turn waits on it again, also after a restart', async () => {
  const r = gateRig(async () => ({ ok: false, missing: ['a readable version'], version: null }))
  try {
    const gate = r.make()
    assert.equal((await gate.ready()).version, null)
    for (let i = 0; i < 5; i++) {
      gate.current()
      assert.match(String(threadsCliProblem(await gate.ready(), 'turn')), /version could not be read/)
    }
    assert.equal(r.probes(), 1, 'every later turn answered from the kept failure')
    assert.equal(r.make().current().reason, undefined, 'a restarted daemon reads the kept failure from disk')
    assert.equal(r.probes(), 1)
    r.clock.now += THREADS_FAILED_RETRY_MS + 1
    await r.make().ready()
    assert.equal(r.probes(), 2, 'asked again once the wait is over')
  } finally {
    r.cleanup()
  }
})

test('the real probe runs its questions off the event loop, at once, and a hung claude ends at the timeout', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threads-hang-'))
  try {
    const bin = join(dir, 'claude')
    writeFileSync(bin, '#!/bin/sh\nsleep 30\n')
    chmodSync(bin, 0o755)
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 10)
    const t0 = Date.now()
    const answer = await probeThreadsCliAsync(bin, { timeoutMs: 300 })
    clearInterval(timer)
    const took = Date.now() - t0
    assert.deepEqual(answer, { ok: false, missing: ['a readable version'], version: null })
    assert.ok(took < 1_000, `four questions at once, each cut at 300 ms (one after another would take 1,200): ${took} ms`)
    assert.ok(ticks >= 15, `the loop kept turning: ${ticks} ticks`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the real probe answers yes for a claude that has everything', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threads-good-'))
  try {
    const bin = join(dir, 'claude')
    const help = HELP.replace(/'/g, '')
    writeFileSync(bin, `#!/bin/sh
case "$1" in
  --version) echo "2.1.317 (Claude Code)" ;;
  --help) cat <<'H'
${help}
H
;;
  --permission-mode) echo "${MODES.stderr.trim()}" >&2; exit 1 ;;
  --max-turns) echo "error: option '--max-turns <turns>' argument missing" >&2; exit 1 ;;
esac
`)
    chmodSync(bin, 0o755)
    assert.deepEqual(await probeThreadsCliAsync(bin), { ok: true, missing: [], version: '2.1.317' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the heartbeat alone starts the probe (an updated claude is asked again without any turn), and declares once it answers', async () => {
  const r = gateRig(async () => ({ ok: true, missing: [], version: '2.1.317' }))
  try {
    const gate = r.make()
    assert.equal(gate.current().reason, 'probing')
    assert.equal(r.probes(), 1, 'started by current() itself')
    await new Promise((done) => setImmediate(done))
    assert.equal(gate.current().ok, true, 'the next beat declares')
    // claude updated: another binary, asked again from current() alone.
    writeFileSync(r.bin, '#!/bin/sh\n# updated\n')
    utimesSync(r.bin, new Date(), new Date(Date.now() + 5_000))
    assert.equal(gate.current().reason, 'probing')
    assert.equal(r.probes(), 2)
    assert.equal((await gate.ready()).ok, true, 'the updated probe finishes before fixture cleanup')
  } finally {
    r.cleanup()
  }
})

test('a stale timed-out probe cannot overwrite the updated binary success or withdraw its capabilities', async () => {
  type Result = { ok: boolean; missing: string[]; version: string | null }
  const finish: Array<(result: Result) => void> = []
  const r = gateRig(() => new Promise((done) => { finish.push(done) }))
  try {
    const published: ThreadsCliAnswer[] = []
    const gate = r.make((answer) => published.push(answer))
    const old = gate.ready()
    writeFileSync(r.bin, '#!/bin/sh\n# updated binary B\n')
    const current = gate.ready()
    finish[1]!({ ok: true, missing: [], version: '2.1.318' })
    assert.equal((await current).ok, true)
    const cachePath = join(r.dir, 'state', 'threads-cli-probe.json')
    const verifiedCache = readFileSync(cachePath, 'utf8')
    finish[0]!({ ok: false, missing: ['a readable version'], version: null })
    assert.equal((await old).ok, false, 'the old waiter still receives its own result')
    assert.equal(gate.current().ok, true, 'B remains declared after A times out')
    assert.equal(readFileSync(cachePath, 'utf8'), verifiedCache, 'A cannot replace B on disk')
    assert.equal(r.make().current().ok, true, 'a restart also retains B verification')
    assert.equal(r.probes(), 2, 'no third probe for a binary that was already verified')
    assert.deepEqual(published.map((answer) => answer.version), ['2.1.318'], 'stale results cannot notify capability consumers')
  } finally {
    r.cleanup()
  }
})

test('a superseded probe finishing first cannot publish or displace the pending current probe', async () => {
  type Result = { ok: boolean; missing: string[]; version: string | null }
  const finish: Array<(result: Result) => void> = []
  const r = gateRig(() => new Promise((done) => { finish.push(done) }))
  try {
    const published: ThreadsCliAnswer[] = []
    const gate = r.make((answer) => published.push(answer))
    const old = gate.ready()
    writeFileSync(r.bin, '#!/bin/sh\n# binary B\n')
    const current = gate.ready()
    finish[0]!({ ok: true, missing: [], version: '2.1.317' })
    await old
    assert.equal(published.length, 0, 'A does not notify while B is being verified')
    assert.equal(gate.current().reason, 'probing')
    assert.equal(r.probes(), 2, 'the B probe is still shared')
    finish[1]!({ ok: true, missing: [], version: '2.1.318' })
    assert.equal((await current).version, '2.1.318')
    assert.deepEqual(published.map((answer) => answer.version), ['2.1.318'])
  } finally {
    r.cleanup()
  }
})

test('returning to a cached binary invalidates the other binary pending probe', async () => {
  type Result = { ok: boolean; missing: string[]; version: string | null }
  const finish: Array<(result: Result) => void> = []
  const r = gateRig(() => new Promise((done) => { finish.push(done) }))
  try {
    const originalTime = new Date('2026-01-01T00:00:00Z')
    utimesSync(r.bin, originalTime, originalTime)
    const published: ThreadsCliAnswer[] = []
    const gate = r.make((answer) => published.push(answer))
    const first = gate.ready()
    finish[0]!({ ok: true, missing: [], version: '2.1.317' })
    await first
    writeFileSync(r.bin, '#!/bin/sh\n# binary B\n')
    const other = gate.ready()
    writeFileSync(r.bin, '#!/bin/sh\n')
    utimesSync(r.bin, originalTime, originalTime)
    assert.equal(gate.current().ok, true, 'A is already cached when the binary switches back')
    finish[1]!({ ok: false, missing: ['a readable version'], version: null })
    await other
    assert.equal(gate.current().ok, true, 'B cannot displace the current cached A')
    assert.equal(r.make().current().ok, true, 'the cache on disk still belongs to A')
    assert.equal(r.probes(), 2)
    assert.deepEqual(published.map((answer) => answer.version), ['2.1.317'])
  } finally {
    r.cleanup()
  }
})


test('the Windows CLI gate remains disabled without probing a binary', async () => {
  const gate = new ThreadsCliGate({
    platform: 'win32', claudePath: () => 'C:\\claude.exe', cachePath: 'unused',
    probe: async () => { throw new Error('the Windows gate must not probe') },
  })
  assert.deepEqual(gate.current(), { ok: false, missing: [], version: null, reason: 'platform' })
  assert.deepEqual(await gate.ready(), { ok: false, missing: [], version: null, reason: 'platform' })
})
