/**
 * Attach scope (board row bab90cdb; design: BGOS #1244, "MCP daemon attach
 * gating: attach on explicit intent, not on folder residency").
 *
 * THE DEFECT. On a computer that runs several agents, the machine wide
 * marketplace copy of the plugin starts a daemon for EVERY Claude Code session,
 * and that daemon becomes whichever agent the env, the folder pin or the
 * credentials resolve to. A session launched for one agent (an inherited
 * BGOS_ASSISTANT_ID, a worker started from an agent's Bash tool) can attach as
 * another agent and answer in its name. Nothing in the daemon knows which agent
 * the LAUNCHER meant.
 *
 * STEP ONE, which is all this ships: the launcher names the agent it launches
 * (HOAI_ATTACH_SCOPE=<assistant id>), the daemon compares it with the agent it
 * resolved, and a setting that starts OFF decides whether a mismatch is refused.
 * With the setting off nothing changes for anyone; the daemon only records what
 * it WOULD have done, so the flip can be measured before it is made.
 *
 * The properties pinned here:
 *   - the right agent always attaches, in every mode;
 *   - a wrong agent is refused only when the setting says so;
 *   - a scope that cannot be read FAILS OPEN, in every mode, strict included;
 *   - an unreadable or unknown setting is OFF;
 *   - every evaluation is counted, and the count says how many it WOULD refuse;
 *   - telemetry never throws.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ATTACH_SCOPE_ENV,
  ATTACH_SCOPE_MODE_ENV,
  ATTACH_SCOPE_EVENTS_FILE,
  DEFAULT_ATTACH_SCOPE_MODE,
  readAttachScope,
  resolveAttachScopeMode,
  decideAttachScope,
  recordAttachScopeEvent,
  readAttachScopeEvents,
  summarizeAttachScopeEvents,
  attachScopeDoctorCheck,
  formatAttachScopeBootLine,
  formatAttachScopeRefusal,
} from '../lib/attach-scope.mjs'

const MODES = ['off', 'wrong-agent', 'strict'] as const

// ── readAttachScope ─────────────────────────────────────────────────────────

test('readAttachScope: no variable is an unscoped session', () => {
  assert.deepEqual(readAttachScope({}), { state: 'absent' })
  assert.deepEqual(readAttachScope({ [ATTACH_SCOPE_ENV]: '' }), { state: 'absent' })
  assert.deepEqual(readAttachScope({ [ATTACH_SCOPE_ENV]: '   ' }), { state: 'absent' })
})

test('readAttachScope: digits name the agent the launcher meant', () => {
  assert.deepEqual(readAttachScope({ [ATTACH_SCOPE_ENV]: '900' }), { state: 'scoped', assistantId: '900' })
  assert.deepEqual(readAttachScope({ [ATTACH_SCOPE_ENV]: ' 901\n' }), { state: 'scoped', assistantId: '901' })
})

test('readAttachScope: anything else is unreadable, never a guess', () => {
  for (const raw of ['abc', '900,901', '9 00', '-1', '0x10', '1e3', '9'.repeat(40)]) {
    assert.deepEqual(readAttachScope({ [ATTACH_SCOPE_ENV]: raw }), { state: 'unreadable' }, raw)
  }
})

test('readAttachScope: an env object that throws is unreadable', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom') } })
  assert.deepEqual(readAttachScope(hostile), { state: 'unreadable' })
})

// ── decideAttachScope: the scope decision ───────────────────────────────────

test('right agent attaches in every mode', () => {
  for (const mode of MODES) {
    const d = decideAttachScope({ mode, env: { [ATTACH_SCOPE_ENV]: '900' }, assistantId: '900' })
    assert.equal(d.verdict, 'attach', mode)
    assert.equal(d.outcome, 'match', mode)
    assert.equal(d.refusedFrom, null, `${mode}: a match is refused by no mode`)
  }
})

test('wrong agent is REFUSED when the setting is on (wrong-agent and strict)', () => {
  for (const mode of ['wrong-agent', 'strict'] as const) {
    const d = decideAttachScope({ mode, env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' })
    assert.equal(d.verdict, 'refuse', mode)
    assert.equal(d.outcome, 'wrong-agent', mode)
    assert.equal(d.scopeId, '901')
    assert.equal(d.assistantId, '900')
  }
})

test('wrong agent still attaches when the setting is OFF, and is counted as a would-refuse', () => {
  const d = decideAttachScope({ mode: 'off', env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' })
  assert.equal(d.verdict, 'attach')
  assert.equal(d.outcome, 'wrong-agent')
  assert.equal(d.refusedFrom, 'wrong-agent', 'the first mode that would refuse it')
})

test('an unscoped session is refused only in strict, and counted as a strict would-refuse', () => {
  const off = decideAttachScope({ mode: 'off', env: {}, assistantId: '900' })
  const wrong = decideAttachScope({ mode: 'wrong-agent', env: {}, assistantId: '900' })
  const strict = decideAttachScope({ mode: 'strict', env: {}, assistantId: '900' })
  assert.equal(off.verdict, 'attach')
  assert.equal(wrong.verdict, 'attach')
  assert.equal(strict.verdict, 'refuse')
  for (const d of [off, wrong, strict]) {
    assert.equal(d.outcome, 'unscoped')
    assert.equal(d.refusedFrom, 'strict')
  }
})

test('FAIL OPEN: a scope that cannot be read attaches in every mode, strict included', () => {
  for (const mode of MODES) {
    const d = decideAttachScope({ mode, env: { [ATTACH_SCOPE_ENV]: 'not-an-id' }, assistantId: '900' })
    assert.equal(d.verdict, 'attach', mode)
    assert.equal(d.outcome, 'unreadable', mode)
    assert.equal(d.refusedFrom, null, `${mode}: unreadable is never a would-refuse`)
  }
})

test('FAIL OPEN: an env that throws attaches in every mode', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom') } })
  for (const mode of MODES) {
    const d = decideAttachScope({ mode, env: hostile, assistantId: '900' })
    assert.equal(d.verdict, 'attach', mode)
    assert.equal(d.outcome, 'unreadable', mode)
  }
})

test('FAIL OPEN: an agent identity that cannot be read attaches, even with a scope, in every mode', () => {
  for (const mode of MODES) {
    for (const assistantId of ['', '  ', 'abc', undefined as unknown as string]) {
      const d = decideAttachScope({ mode, env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId })
      assert.equal(d.verdict, 'attach', `${mode} ${String(assistantId)}`)
      assert.equal(d.outcome, 'unreadable', `${mode} ${String(assistantId)}`)
    }
  }
})

test('an unknown mode is OFF: nothing is refused', () => {
  for (const mode of ['', 'on', 'STRICT ', 'true', undefined as unknown as string]) {
    const wrong = decideAttachScope({ mode, env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' })
    const unscoped = decideAttachScope({ mode, env: {}, assistantId: '900' })
    assert.equal(wrong.verdict, 'attach', String(mode))
    assert.equal(unscoped.verdict, 'attach', String(mode))
  }
})

test('the default mode is off, so shipping this changes nothing for anyone', () => {
  assert.equal(DEFAULT_ATTACH_SCOPE_MODE, 'off')
})

// ── resolveAttachScopeMode: the setting ─────────────────────────────────────

const noFile = () => null

test('resolveAttachScopeMode: nothing set is the default, off', () => {
  assert.deepEqual(resolveAttachScopeMode({ env: {}, readText: noFile, settingsPath: '/x/attach-scope.json' }), {
    mode: 'off',
    source: 'default',
  })
})

test('resolveAttachScopeMode: the env var sets it for one process', () => {
  for (const mode of MODES) {
    const r = resolveAttachScopeMode({ env: { [ATTACH_SCOPE_MODE_ENV]: mode }, readText: noFile, settingsPath: '/x' })
    assert.deepEqual(r, { mode, source: 'env' })
  }
  const spaced = resolveAttachScopeMode({ env: { [ATTACH_SCOPE_MODE_ENV]: ' Strict\n' }, readText: noFile, settingsPath: '/x' })
  assert.deepEqual(spaced, { mode: 'strict', source: 'env' })
})

test('resolveAttachScopeMode: the machine file sets it for every agent on this computer', () => {
  const r = resolveAttachScopeMode({ env: {}, readText: () => '{"mode":"wrong-agent"}', settingsPath: '/x' })
  assert.deepEqual(r, { mode: 'wrong-agent', source: 'file' })
})

test('resolveAttachScopeMode: the env var wins over the file', () => {
  const r = resolveAttachScopeMode({
    env: { [ATTACH_SCOPE_MODE_ENV]: 'off' },
    readText: () => '{"mode":"strict"}',
    settingsPath: '/x',
  })
  assert.deepEqual(r, { mode: 'off', source: 'env' })
})

test('resolveAttachScopeMode: an unreadable setting is OFF and says why', () => {
  const badEnv = resolveAttachScopeMode({ env: { [ATTACH_SCOPE_MODE_ENV]: 'yes' }, readText: noFile, settingsPath: '/x' })
  assert.equal(badEnv.mode, 'off')
  assert.equal(badEnv.source, 'env')
  assert.match(String(badEnv.invalid), /yes/)
  for (const text of ['{not json', '[]', '{"mode":3}', '{"mode":"loud"}', 'null']) {
    const r = resolveAttachScopeMode({ env: {}, readText: () => text, settingsPath: '/x' })
    assert.equal(r.mode, 'off', text)
    assert.equal(r.source, 'file', text)
    assert.ok(r.invalid, text)
  }
  const throws = resolveAttachScopeMode({
    env: {},
    readText: () => {
      throw new Error('EACCES')
    },
    settingsPath: '/x',
  })
  assert.equal(throws.mode, 'off')
})

// ── Telemetry: the count of what it WOULD have refused ──────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'attach-scope-'))
}

test('recordAttachScopeEvent appends one line per evaluation, and the summary counts would-refuses', () => {
  const dir = tmp()
  const now = Date.now()
  const cases = [
    { env: { [ATTACH_SCOPE_ENV]: '900' }, assistantId: '900' },
    { env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' },
    { env: { [ATTACH_SCOPE_ENV]: '902' }, assistantId: '900' },
    { env: {}, assistantId: '900' },
    { env: { [ATTACH_SCOPE_ENV]: 'x' }, assistantId: '900' },
  ]
  for (const c of cases) {
    const decision = decideAttachScope({ mode: 'off', ...c })
    assert.equal(recordAttachScopeEvent({ dir, decision, mode: 'off', route: 'folder-pin', version: '0.81.0', now }), true)
  }
  const raw = readFileSync(join(dir, ATTACH_SCOPE_EVENTS_FILE), 'utf8').trim().split('\n')
  assert.equal(raw.length, 5)
  const first = JSON.parse(raw[0]!)
  assert.equal(first.outcome, 'match')
  assert.equal(first.verdict, 'attach')
  assert.equal(first.mode, 'off')
  assert.equal(first.route, 'folder-pin')
  assert.equal(typeof first.at, 'string')

  const summary = summarizeAttachScopeEvents(readAttachScopeEvents({ dir }), { now, windowMs: 60_000 })
  assert.equal(summary.total, 5)
  assert.equal(summary.match, 1)
  assert.equal(summary.wrongAgent, 2)
  assert.equal(summary.unscoped, 1)
  assert.equal(summary.unreadable, 1)
  assert.equal(summary.refused, 0, 'off refuses nothing')
  assert.equal(summary.wouldRefuseWrongAgent, 2, 'flipping to wrong-agent would refuse the two mismatches')
  assert.equal(summary.wouldRefuseStrict, 3, 'flipping to strict would also refuse the unscoped one')
})

test('summarizeAttachScopeEvents counts only the window, and counts real refusals', () => {
  const now = Date.now()
  const old = new Date(now - 10 * 24 * 3600_000).toISOString()
  const recent = new Date(now - 60_000).toISOString()
  const events = [
    { at: old, outcome: 'wrong-agent', verdict: 'attach', mode: 'off' },
    { at: recent, outcome: 'wrong-agent', verdict: 'refuse', mode: 'wrong-agent' },
    { at: recent, outcome: 'unscoped', verdict: 'attach', mode: 'wrong-agent' },
    { at: 'garbage', outcome: 'wrong-agent', verdict: 'attach', mode: 'off' },
    { nonsense: true },
  ]
  const s = summarizeAttachScopeEvents(events, { now, windowMs: 7 * 24 * 3600_000 })
  assert.equal(s.total, 2)
  assert.equal(s.refused, 1)
  assert.equal(s.wouldRefuseWrongAgent, 1)
  assert.equal(s.wouldRefuseStrict, 2)
})

test('readAttachScopeEvents skips torn lines and reads a missing file as empty', () => {
  const dir = tmp()
  assert.deepEqual(readAttachScopeEvents({ dir }), [])
  writeFileSync(join(dir, ATTACH_SCOPE_EVENTS_FILE), '{"outcome":"match","at":"x"}\n{torn\n\n{"outcome":"unscoped","at":"y"}\n')
  const events = readAttachScopeEvents({ dir })
  assert.equal(events.length, 2)
})

test('the events file is rotated at its cap, so it can never grow without bound', () => {
  const dir = tmp()
  const path = join(dir, ATTACH_SCOPE_EVENTS_FILE)
  writeFileSync(path, 'x'.repeat(2048))
  const decision = decideAttachScope({ mode: 'off', env: {}, assistantId: '900' })
  assert.equal(recordAttachScopeEvent({ dir, decision, mode: 'off', now: Date.now(), maxBytes: 1024 }), true)
  assert.ok(existsSync(`${path}.1`), 'the full file moved aside')
  assert.ok(statSync(path).size < 1024, 'the live file restarted')
  assert.equal(readAttachScopeEvents({ dir }).length, 1)
})

test('telemetry NEVER throws: an unwritable folder answers false', () => {
  const dir = tmp()
  const blocker = join(dir, 'file')
  writeFileSync(blocker, '')
  const decision = decideAttachScope({ mode: 'off', env: {}, assistantId: '900' })
  assert.equal(recordAttachScopeEvent({ dir: join(blocker, 'sub'), decision, mode: 'off', now: Date.now() }), false)
})

// ── What people read ────────────────────────────────────────────────────────

test('the boot line names the mode, the scope, the agent and what it would do', () => {
  const d = decideAttachScope({ mode: 'off', env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' })
  const line = formatAttachScopeBootLine(d, { mode: 'off', source: 'default' })
  assert.match(line, /attach scope/)
  assert.match(line, /mode=off/)
  assert.match(line, /901/)
  assert.match(line, /900/)
  assert.match(line, /WOULD refuse/)
})

test('the refusal names both agents and the way out', () => {
  const d = decideAttachScope({ mode: 'wrong-agent', env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' })
  const text = formatAttachScopeRefusal(d)
  assert.match(text, /901/)
  assert.match(text, /900/)
  assert.match(text, new RegExp(ATTACH_SCOPE_MODE_ENV))
  const u = formatAttachScopeRefusal(decideAttachScope({ mode: 'strict', env: {}, assistantId: '900' }))
  assert.match(u, new RegExp(ATTACH_SCOPE_ENV))
})

test('the check up row is OK for a match, WARN for a wrong agent, and carries the machine tally', () => {
  const now = Date.now()
  const summary = summarizeAttachScopeEvents(
    [
      { at: new Date(now).toISOString(), outcome: 'wrong-agent', verdict: 'attach', mode: 'off' },
      { at: new Date(now).toISOString(), outcome: 'unscoped', verdict: 'attach', mode: 'off' },
    ],
    { now, windowMs: 60_000 },
  )
  const ok = attachScopeDoctorCheck({
    decision: decideAttachScope({ mode: 'off', env: { [ATTACH_SCOPE_ENV]: '900' }, assistantId: '900' }),
    mode: 'off',
    summary,
  })
  assert.equal(ok.status, 'OK')
  assert.equal(ok.name, 'Attach scope')
  assert.match(ok.detail, /1 wrong agent/)
  const warn = attachScopeDoctorCheck({
    decision: decideAttachScope({ mode: 'off', env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' }),
    mode: 'off',
    summary,
  })
  assert.equal(warn.status, 'WARN')
  assert.ok(warn.fix)
})

test('nothing a person reads carries an em or en dash', () => {
  const d1 = decideAttachScope({ mode: 'off', env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' })
  const d2 = decideAttachScope({ mode: 'strict', env: {}, assistantId: '900' })
  const s = summarizeAttachScopeEvents([], { now: Date.now(), windowMs: 1 })
  const texts = [
    formatAttachScopeBootLine(d1, { mode: 'off', source: 'default' }),
    formatAttachScopeBootLine(d2, { mode: 'strict', source: 'env' }),
    formatAttachScopeRefusal(d1),
    formatAttachScopeRefusal(d2),
    JSON.stringify(attachScopeDoctorCheck({ decision: d1, mode: 'off', summary: s })),
  ]
  for (const t of texts) assert.doesNotMatch(t, /[\u2013\u2014]/)
})

// ── The measurement, before the flip ────────────────────────────────────────

test('bin/hoai-attach-scope.mjs prints the machine tally: what each mode WOULD refuse', async () => {
  const { spawnSync } = await import('node:child_process')
  const home = tmp()
  const stateDir = join(home, '.bgos-plugin-state')
  const now = Date.now()
  for (const c of [
    { env: { [ATTACH_SCOPE_ENV]: '900' }, assistantId: '900' },
    { env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' },
    { env: {}, assistantId: '900' },
  ]) {
    recordAttachScopeEvent({ dir: stateDir, decision: decideAttachScope({ mode: 'off', ...c }), mode: 'off', now })
  }
  const script = new URL('../bin/hoai-attach-scope.mjs', import.meta.url).pathname
  const text = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /mode off \(default\)/)
  assert.match(text.stdout, /3 starts, 1 right agent, 1 wrong agent, 1 unscoped/)
  assert.match(text.stdout, /mode wrong-agent would refuse 1, strict would refuse 2/)
  assert.doesNotMatch(text.stdout, /[\u2013\u2014]/)
  const json = spawnSync(process.execPath, [script, '--json', '--days', '1'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, [ATTACH_SCOPE_MODE_ENV]: 'wrong-agent' },
  })
  assert.equal(json.status, 0, json.stderr)
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.mode.mode, 'wrong-agent')
  assert.equal(parsed.summary.total, 3)
  assert.equal(parsed.summary.wouldRefuseStrict, 2)
  assert.equal(parsed.summary.windowMs, 24 * 3600_000)
})

// ── Review round: the scope's folder, the folder pin, the launcher, ids ─────
//
// The scope rides the env, which every child inherits: a plain `claude` a
// worker starts from agent A's Bash tool, in agent B's folder, inherits BOTH
// A's scope and A's BGOS_ASSISTANT_ID, resolves A, and would read as a match.
// So the launcher also names the folder it launched (HOAI_ATTACH_SCOPE_DIR):
// a scope seen in another folder was inherited, not given to this session.
// And a folder pin that names another agent than the resolved one is the
// wrong agent whatever the env says.

import { ATTACH_SCOPE_DIR_ENV } from '../lib/attach-scope.mjs'

const realpathSame = (p: string) => p

test('a scope carried into ANOTHER folder was inherited: unscoped, launcher inherited, a strict would-refuse', () => {
  for (const mode of MODES) {
    const d = decideAttachScope({
      mode,
      env: { [ATTACH_SCOPE_ENV]: '900', [ATTACH_SCOPE_DIR_ENV]: '/agents/a' },
      assistantId: '900',
      cwd: '/agents/b',
      realpath: realpathSame,
    })
    assert.equal(d.outcome, 'unscoped', mode)
    assert.equal(d.launcher, 'inherited', mode)
    assert.equal(d.refusedFrom, 'strict', mode)
    assert.equal(d.verdict, mode === 'strict' ? 'refuse' : 'attach', mode)
  }
})

test('the scope folder compares as a folder: trailing separator, and case on macOS and Windows', () => {
  const same = (dir: string, cwd: string, platform: string) =>
    decideAttachScope({
      mode: 'strict',
      env: { [ATTACH_SCOPE_ENV]: '900', [ATTACH_SCOPE_DIR_ENV]: dir },
      assistantId: '900',
      cwd,
      platform,
      realpath: realpathSame,
    })
  assert.equal(same('/agents/a/', '/agents/a', 'linux').outcome, 'match')
  assert.equal(same('/Agents/A', '/agents/a', 'darwin').outcome, 'match')
  assert.equal(same('C:\\Agents\\A\\', 'c:\\agents\\a', 'win32').outcome, 'match')
  assert.equal(same('/Agents/A', '/agents/a', 'linux').launcher, 'inherited')
})

test('the scope folder compares through realpath (a symlinked spelling is the same folder)', () => {
  const real = (p: string) => (p === '/tmp/agent' ? '/private/tmp/agent' : p)
  const d = decideAttachScope({
    mode: 'strict',
    env: { [ATTACH_SCOPE_ENV]: '900', [ATTACH_SCOPE_DIR_ENV]: '/tmp/agent' },
    assistantId: '900',
    cwd: '/private/tmp/agent',
    realpath: real,
  })
  assert.equal(d.outcome, 'match')
  assert.equal(d.launcher, 'hoai')
})

test('a folder pin naming ANOTHER agent is the wrong agent, even when the inherited scope agrees with the env', () => {
  // Worker in agent B's folder (pin 901), inheriting A's scope and A's env pin.
  const on = decideAttachScope({
    mode: 'wrong-agent',
    env: { [ATTACH_SCOPE_ENV]: '900', [ATTACH_SCOPE_DIR_ENV]: '/agents/a' },
    assistantId: '900',
    cwd: '/agents/b',
    folderPinId: '901',
    realpath: realpathSame,
  })
  assert.equal(on.outcome, 'wrong-agent')
  assert.equal(on.by, 'folder')
  assert.equal(on.verdict, 'refuse')
  const off = decideAttachScope({ mode: 'off', env: {}, assistantId: '900', cwd: '/agents/b', folderPinId: '901' })
  assert.equal(off.outcome, 'wrong-agent')
  assert.equal(off.by, 'folder')
  assert.equal(off.verdict, 'attach')
  assert.equal(off.refusedFrom, 'wrong-agent')
  assert.match(formatAttachScopeRefusal(on), /folder/)
  assert.match(formatAttachScopeRefusal(on), /901/)
})

test('a folder pin naming THIS agent, or no usable pin, changes nothing', () => {
  for (const folderPinId of ['900', '0900', '', 'garbage', undefined as unknown as string]) {
    const d = decideAttachScope({ mode: 'strict', env: { [ATTACH_SCOPE_ENV]: '900' }, assistantId: '900', folderPinId })
    assert.equal(d.outcome, 'match', String(folderPinId))
  }
})

test('the scope names a wrong agent "by scope"', () => {
  const d = decideAttachScope({ mode: 'off', env: { [ATTACH_SCOPE_ENV]: '901' }, assistantId: '900' })
  assert.equal(d.by, 'scope')
})

test('ids compare as numbers: a leading zero is the same agent', () => {
  const d = decideAttachScope({ mode: 'strict', env: { [ATTACH_SCOPE_ENV]: '0900' }, assistantId: '900' })
  assert.equal(d.outcome, 'match')
})

test('the launcher is recorded: hoai (its folder), generation one (BGOS_CONTINUE), or none', () => {
  const hoai = decideAttachScope({
    mode: 'off',
    env: { [ATTACH_SCOPE_DIR_ENV]: '/agents/a' },
    assistantId: '900',
    cwd: '/agents/a',
    realpath: realpathSame,
  })
  assert.equal(hoai.launcher, 'hoai', 'hoai launched it but could not name the agent')
  assert.equal(hoai.outcome, 'match')
  assert.equal(decideAttachScope({ mode: 'off', env: { BGOS_CONTINUE: '1' }, assistantId: '900' }).launcher, 'gen1')
  assert.equal(decideAttachScope({ mode: 'off', env: {}, assistantId: '900' }).launcher, 'none')
})

test('market3 scope: folder-only launch intent uses the resolved agent without bypassing wrong-agent checks', () => {
  for (const row of [
    { dir: '/work', cwd: '/work', scope: '', pin: '', outcome: 'match', verdict: 'attach', by: null },
    { dir: '/parent', cwd: '/work', scope: '', pin: '', outcome: 'unscoped', verdict: 'refuse', by: null },
    { dir: '', cwd: '/work', scope: '', pin: '', outcome: 'unscoped', verdict: 'refuse', by: null },
    { dir: '/work', cwd: '', scope: '', pin: '', outcome: 'unscoped', verdict: 'refuse', by: null },
    { dir: '/work', cwd: '/work', scope: '41', pin: '', outcome: 'wrong-agent', verdict: 'refuse', by: 'scope' },
    { dir: '/work', cwd: '/work', scope: '', pin: '41', outcome: 'wrong-agent', verdict: 'refuse', by: 'folder' },
  ]) {
    const decision = decideAttachScope({ mode: 'strict', assistantId: '42', cwd: row.cwd,
      env: { HOAI_ATTACH_SCOPE_DIR: row.dir, HOAI_ATTACH_SCOPE: row.scope },
      folderPinId: row.pin, realpath: realpathSame })
    assert.equal(decision.outcome, row.outcome, JSON.stringify(row))
    assert.equal(decision.verdict, row.verdict, JSON.stringify(row))
    assert.equal(decision.by, row.by, JSON.stringify(row))
  }
})

test('the summary splits by launcher and by signal, and counts distinct sessions, not boots', () => {
  const dir = tmp()
  const now = Date.now()
  const add = (input: Record<string, unknown>, cwd: string) =>
    recordAttachScopeEvent({ dir, decision: decideAttachScope({ mode: 'off', realpath: realpathSame, ...input } as never), mode: 'off', cwd, now })
  // One crash looping stray, 3 boots in one folder: 3 boots, 1 distinct session.
  for (let i = 0; i < 3; i += 1) add({ env: {}, assistantId: '900' }, '/x')
  add({ env: { BGOS_CONTINUE: '1' }, assistantId: '901' }, '/agents/b')
  add({ env: {}, assistantId: '900', folderPinId: '902', cwd: '/agents/c' }, '/agents/c')
  add({ env: { [ATTACH_SCOPE_ENV]: '903' }, assistantId: '900' }, '/agents/d')
  const s = summarizeAttachScopeEvents(readAttachScopeEvents({ dir }), { now, windowMs: 60_000 })
  assert.equal(s.unscoped, 4)
  assert.deepEqual(s.unscopedByLauncher, { hoai: 0, gen1: 1, inherited: 0, none: 3, env: 0 })
  assert.deepEqual(s.wrongAgentBy, { scope: 1, folder: 1 })
  assert.equal(s.wouldRefuseStrict, 6)
  assert.equal(s.distinctWouldRefuseStrict, 4, 'the three boots in /x are one session')
  assert.equal(s.distinctWouldRefuseWrongAgent, 2)
})

test('no source file of this change carries an em or en dash', () => {
  const files = [
    '../lib/attach-scope.mjs',
    '../bin/hoai-attach-scope.mjs',
    './attach-scope.test.ts',
    './attach-scope.launcher.test.ts',
    './attach-scope.e2e.test.ts',
  ]
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /[\u2013\u2014]/, f)
  }
})
