/**
 * lib/claude-stamp.mjs: each agent's claude carries its agent's id, so the watcher can tell a stopped
 * agent from one whose claude it merely cannot place, when the same person runs several agents.
 *
 *   buildClaudeStamp / parseClaudeStamp   the file the agent's daemon writes (lock holder only) and the
 *                                         watcher reads: the agent id, its claude's pid and start time;
 *                                         anything else is no stamp at all (fail closed)
 *   readClaudeStartMs                     the claude's start time from `ps -o lstart=` (only that column)
 *                                         or, on Windows, from the ancestor walk the daemon already made
 *   decideClaudesAccounted                every claude in the listing carries exactly one stamp of ANOTHER
 *                                         agent, pid AND start time equal; anything less is "not sure"
 *   createClaudeStamper                   the daemon side: write once per claude, never as a non holder
 *
 * Run: npx tsx --test test/claude-stamp.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  CLAUDE_STAMP_FILE_NAME,
  CLAUDE_STAMP_REFRESH_MS,
  buildClaudeStamp,
  claudeStartCommand,
  createClaudeStamper,
  decideClaudesAccounted,
  parseClaudeStamp,
  readClaudeStartMs,
} from '../lib/claude-stamp.mjs'

const T0 = Date.parse('2026-10-06T19:00:00.000Z')
const UP = T0 - 3 * 60 * 60_000

const row = (pid: number, startedAtMs: number | null, command = 'claude') => ({ pid, ppid: 1, uid: 501, startedAtMs, command })
const stamp = (assistantId: string, pid: number, startedAtMs: number) => ({ assistantId, pid, startedAtMs })

test('the stamp file: built from a digits id, a real pid and a start time; anything else is no stamp', () => {
  assert.equal(CLAUDE_STAMP_FILE_NAME, 'claude-stamp.json')
  const body = buildClaudeStamp({ assistantId: '300', claudePid: 5300, claudeStartedAtMs: UP, nowMs: T0 })
  assert.deepEqual(body, { schemaVersion: 1, assistantId: '300', claudePid: 5300, claudeStartedAtMs: UP, stampedAt: new Date(T0).toISOString() })
  // No token, no path, no command line: exactly these five keys.
  assert.deepEqual(Object.keys(body!).sort(), ['assistantId', 'claudePid', 'claudeStartedAtMs', 'schemaVersion', 'stampedAt'])
  for (const bad of [
    { assistantId: 'abc', claudePid: 5300, claudeStartedAtMs: UP },
    { assistantId: null, claudePid: 5300, claudeStartedAtMs: UP },
    { assistantId: '300', claudePid: 1, claudeStartedAtMs: UP },
    { assistantId: '300', claudePid: 53.5, claudeStartedAtMs: UP },
    { assistantId: '300', claudePid: null, claudeStartedAtMs: UP },
    { assistantId: '300', claudePid: 5300, claudeStartedAtMs: null },
    { assistantId: '300', claudePid: 5300, claudeStartedAtMs: Number.NaN },
  ]) {
    assert.equal(buildClaudeStamp({ ...bad, nowMs: T0 } as any), null, JSON.stringify(bad))
  }
})

test('parseClaudeStamp: a stamp counts only in its own agent\'s folder, whole and well formed', () => {
  const good = JSON.stringify(buildClaudeStamp({ assistantId: '300', claudePid: 5300, claudeStartedAtMs: UP, nowMs: T0 }))
  assert.deepEqual(parseClaudeStamp(good, '300'), stamp('300', 5300, UP))
  // A stamp copied into another agent's folder names nobody.
  assert.equal(parseClaudeStamp(good, '301'), null, 'another folder')
  for (const [name, text] of [
    ['missing', null],
    ['empty', ''],
    ['not json', '{"schemaVersion":1,'],
    ['an array', '[]'],
    ['another schema', JSON.stringify({ ...JSON.parse(good), schemaVersion: 2 })],
    ['no start', JSON.stringify({ ...JSON.parse(good), claudeStartedAtMs: null })],
    ['a text start', JSON.stringify({ ...JSON.parse(good), claudeStartedAtMs: String(UP) })],
    ['a text pid', JSON.stringify({ ...JSON.parse(good), claudePid: '5300' })],
    ['pid 1', JSON.stringify({ ...JSON.parse(good), claudePid: 1 })],
  ] as const) {
    assert.equal(parseClaudeStamp(text, '300'), null, name)
  }
})

test('decideClaudesAccounted: several agents of one person, each claude stamped by its own agent, prove the stopped one runs no claude', () => {
  const listing = [row(1, UP, '/sbin/launchd'), row(57, UP), row(5300, UP), row(5913, UP)]
  const claudes = listing.slice(1)
  const stamps = [stamp('7', 57, UP), stamp('300', 5300, UP), stamp('913', 5913, UP)]
  assert.deepEqual(decideClaudesAccounted({ listing, claudes, stamps, assistantId: '301' }), { ok: true, reason: 'stamped_elsewhere' })
  // No claude at all needs no stamp (today's rule).
  assert.deepEqual(decideClaudesAccounted({ listing: [listing[0]], claudes: [], stamps: [], assistantId: '301' }), { ok: true, reason: 'no_claude' })
})

test('decideClaudesAccounted fails closed: no stamp, another start, two stamps, an unreadable start, a stamp naming this agent', () => {
  const listing = [row(1, UP, '/sbin/launchd'), row(57, UP), row(5300, UP)]
  const claudes = listing.slice(1)
  const decide = (stamps: ReturnType<typeof stamp>[], over: Partial<Parameters<typeof decideClaudesAccounted>[0]> = {}) =>
    decideClaudesAccounted({ listing, claudes, stamps, assistantId: '301', ...over })
  // An older plugin, a person's own session, the desktop app: a claude nobody stamped.
  assert.deepEqual(decide([stamp('7', 57, UP)]), { ok: false, reason: 'claude_unstamped' })
  assert.deepEqual(decide([]), { ok: false, reason: 'claude_unstamped' })
  // A reused pid: the stamp was of an older process with that number.
  assert.deepEqual(decide([stamp('7', 57, UP), stamp('300', 5300, UP + 1_000)]), { ok: false, reason: 'claude_unstamped' })
  // Two agents claim one claude: nobody can say whose it is.
  assert.deepEqual(decide([stamp('7', 57, UP), stamp('300', 5300, UP), stamp('913', 5300, UP)]), { ok: false, reason: 'claude_two_stamps' })
  // A claude whose start the listing could not read matches no stamp.
  const blind = [row(1, UP, '/sbin/launchd'), row(57, UP), row(5300, null)]
  assert.deepEqual(decide([stamp('7', 57, UP), stamp('300', 5300, UP)], { listing: blind, claudes: blind.slice(1) }), { ok: false, reason: 'claude_unstamped' })
  // The stopped agent's own stamp on a live claude: its claude runs.
  assert.deepEqual(decide([stamp('7', 57, UP), stamp('301', 5300, UP)]), { ok: false, reason: 'stamp_names_this_agent' })
  // Even on a process the listing does not call a claude (its stamp is the proof, not the name).
  const other = [row(1, UP, '/sbin/launchd'), row(57, UP), row(5300, UP, 'node something')]
  assert.deepEqual(decide([stamp('7', 57, UP), stamp('301', 5300, UP)], { listing: other, claudes: other.slice(1, 2) }), { ok: false, reason: 'stamp_names_this_agent' })
})

test('readClaudeStartMs: posix asks ps for the start column of that one pid and nothing else; win32 takes the ancestor walk\'s and runs nothing', () => {
  assert.deepEqual(claudeStartCommand(5300), { file: 'env', args: ['LC_ALL=C', 'ps', '-o', 'lstart=', '-p', '5300'] })
  const calls: Array<{ file: string; args: string[] }> = []
  const d = new Date(UP)
  const two = (n: number) => String(n).padStart(2, '0')
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  const lstart = `${WD} ${MO} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}\n`
  const exec = (file: string, args: string[]) => {
    calls.push({ file, args })
    return { code: 0, stdout: lstart }
  }
  assert.equal(readClaudeStartMs({ platform: 'darwin', pid: 5300, execSync: exec, win32StartedAtMs: null }), UP)
  assert.equal(readClaudeStartMs({ platform: 'linux', pid: 5300, execSync: exec, win32StartedAtMs: null }), UP)
  assert.deepEqual(calls, [claudeStartCommand(5300), claudeStartCommand(5300)])
  // Never the command line or the environment of the claude.
  for (const call of calls) assert.ok(!call.args.some((a) => /command|args|^-e$|^e$|environ/.test(a)), JSON.stringify(call))
  assert.equal(readClaudeStartMs({ platform: 'darwin', pid: 5300, execSync: () => ({ code: 1, stdout: '' }), win32StartedAtMs: null }), null, 'ps failed')
  assert.equal(readClaudeStartMs({ platform: 'darwin', pid: 5300, execSync: () => ({ code: 0, stdout: 'Tue Okt  6 18:00:00 2026\n' }), win32StartedAtMs: null }), null, 'not C locale')
  assert.equal(readClaudeStartMs({ platform: 'darwin', pid: 5300, execSync: () => { throw new Error('spawn') }, win32StartedAtMs: null }), null, 'spawn threw')
  const none: unknown[] = []
  assert.equal(readClaudeStartMs({ platform: 'win32', pid: 5300, execSync: (...a: unknown[]) => { none.push(a); return { code: 0, stdout: '' } }, win32StartedAtMs: UP }), UP)
  assert.equal(readClaudeStartMs({ platform: 'win32', pid: 5300, execSync: (...a: unknown[]) => { none.push(a); return { code: 0, stdout: '' } }, win32StartedAtMs: null }), null)
  assert.deepEqual(none, [], 'no call on win32')
})

function stamperFor(over: Record<string, unknown> = {}) {
  let t = T0
  let pid: number | null = 5300
  let holder = true
  const writes: Array<{ path: string; body: any }> = []
  const execs: unknown[] = []
  let startOk = true
  const s = createClaudeStamper({
    path: '/Users/x/.bgos-plugin-state/300/claude-stamp.json',
    platform: 'win32',
    now: () => t,
    assistantId: () => '300',
    claudePid: () => pid,
    win32StartedAtMs: () => (startOk ? UP : null),
    shouldStamp: () => holder,
    execSync: (...a: unknown[]) => { execs.push(a); return { code: 1, stdout: '' } },
    write: (path: string, body: string) => { writes.push({ path, body: JSON.parse(body) }); return true },
    ...over,
  })
  return {
    s, writes, execs,
    set: (o: { pid?: number | null; holder?: boolean; startOk?: boolean; advance?: number }) => {
      if ('pid' in o) pid = o.pid ?? null
      if ('holder' in o) holder = o.holder!
      if ('startOk' in o) startOk = o.startOk!
      if (o.advance) t += o.advance
    },
  }
}

test('createClaudeStamper: the lock holder writes its claude\'s stamp once, again only for another claude, and a non holder never writes', () => {
  const { s, writes, set } = stamperFor()
  assert.equal(s.tick(), 'written')
  assert.deepEqual(writes.map((w) => w.body), [{ schemaVersion: 1, assistantId: '300', claudePid: 5300, claudeStartedAtMs: UP, stampedAt: new Date(T0).toISOString() }])
  assert.equal(writes[0]!.path, '/Users/x/.bgos-plugin-state/300/claude-stamp.json')
  set({ advance: 60_000 })
  assert.equal(s.tick(), 'unchanged', 'the same claude is not stamped every second')
  assert.equal(writes.length, 1)
  // Lost the lock: another daemon of this agent stamps its own claude, this one writes nothing.
  set({ holder: false })
  assert.equal(s.tick(), 'skipped')
  assert.equal(writes.length, 1)
  // Back as holder: the file may now name the other claude, so this one stamps again.
  set({ holder: true })
  assert.equal(s.tick(), 'written')
  assert.equal(writes.length, 2)
  // Its claude not found yet, or its start not known: nothing written, tried again later.
  set({ pid: null })
  assert.equal(s.tick(), 'skipped')
  set({ pid: 6000, startOk: false })
  assert.equal(s.tick(), 'skipped')
  set({ startOk: true })
  assert.equal(s.tick(), 'written')
  assert.equal(writes.at(-1)!.body.claudePid, 6000)
})

test('createClaudeStamper on posix: one ps for the claude\'s start, retried after a failure but not every tick', () => {
  let answer = { code: 1, stdout: '' }
  const execs: Array<{ file: string; args: string[] }> = []
  const d = new Date(UP)
  const two = (n: number) => String(n).padStart(2, '0')
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  const lstart = `${WD} ${MO} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}\n`
  const { s, writes, set } = stamperFor({
    platform: 'darwin',
    execSync: (file: string, args: string[]) => { execs.push({ file, args }); return answer },
  })
  assert.equal(s.tick(), 'skipped', 'ps failed')
  set({ advance: 1_000 })
  assert.equal(s.tick(), 'skipped')
  assert.equal(execs.length, 1, 'not asked again a second later')
  answer = { code: 0, stdout: lstart }
  set({ advance: 30_000 })
  assert.equal(s.tick(), 'written')
  assert.equal(execs.length, 2)
  assert.equal(writes[0]!.body.claudeStartedAtMs, UP)
  set({ advance: 60_000 })
  assert.equal(s.tick(), 'unchanged')
  assert.equal(execs.length, 2, 'a stamped claude is never asked about again')
})

test('createClaudeStamper refreshes every 5 minutes: the start is read again (a Linux clock step moves it) and the file written again (another daemon of this agent may have written last)', () => {
  let start = UP
  const execs: unknown[] = []
  const lstartOf = (ms: number) => {
    const d = new Date(ms)
    const two = (n: number) => String(n).padStart(2, '0')
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
    return `${WD} ${MO} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}\n`
  }
  const { s, writes, set } = stamperFor({
    platform: 'linux',
    execSync: (...a: unknown[]) => { execs.push(a); return { code: 0, stdout: lstartOf(start) } },
  })
  assert.equal(s.tick(), 'written')
  set({ advance: CLAUDE_STAMP_REFRESH_MS - 1_000 })
  assert.equal(s.tick(), 'unchanged')
  assert.equal(execs.length, 1)
  // The wall clock stepped a second: ps now shows this claude one second later, as the watcher's listing does.
  start = UP + 1_000
  set({ advance: 1_000 })
  assert.equal(s.tick(), 'written')
  assert.equal(execs.length, 2)
  assert.equal(writes.at(-1)!.body.claudeStartedAtMs, UP + 1_000)
  // Nothing moved: still written again, so a stale holder's file is replaced within 5 minutes.
  set({ advance: CLAUDE_STAMP_REFRESH_MS })
  assert.equal(s.tick(), 'written')
  assert.equal(writes.length, 3)
  assert.equal(writes.at(-1)!.body.claudeStartedAtMs, UP + 1_000)
  // A refresh whose read fails keeps the 30 s retry wait: not one ps a second.
  const before = execs.length
  start = Number.NaN
  set({ advance: CLAUDE_STAMP_REFRESH_MS })
  assert.equal(s.tick(), 'skipped')
  set({ advance: 1_000 })
  assert.equal(s.tick(), 'skipped')
  assert.equal(execs.length, before + 1)
})

test('createClaudeStamper never throws: a failed write is reported and tried again', () => {
  let ok = false
  const { s } = stamperFor({ write: () => ok })
  assert.equal(s.tick(), 'failed')
  ok = true
  assert.equal(s.tick(), 'written')
  const thrower = stamperFor({ assistantId: () => { throw new Error('boom') } })
  assert.equal(thrower.s.tick(), 'failed')
})

test('server.ts stamps: the stamper is built on the lock, ticks beside the agent state, and the win32 walk hands it the claude\'s start', () => {
  const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  assert.match(src, /createClaudeStamper\(\{/)
  assert.match(src, /shouldStamp: \(\) => lockHeld/)
  assert.match(src, /claudePid: \(\) => agentClaudePid\(\)/)
  assert.match(src, /setInterval\(\(\) => \{ agentStatePublisher\.tick\(\); claudeStamper\.tick\(\);/)
  assert.match(src, /pathJoin\(pathDirname\(CURSOR_FILE_PATH\), CLAUDE_STAMP_FILE_NAME\)/)
})
