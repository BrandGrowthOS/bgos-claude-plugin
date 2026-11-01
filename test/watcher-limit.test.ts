/**
 * The watcher's limit pass (lib/watcher-limit.mjs): an agent stuck on Claude Code's usage limit screen
 * gets ONE Enter the moment usage is available again, and the owner is told.
 *
 * Everything is a fake: an in memory HOME with agent 912 (paired, a live hoai launcher), its pinned
 * session's transcript in the CLI's own envelopes, a fake clock, and a fake tmux (or a fake Windows
 * helper) whose screen is a literal. No real session is read or pressed. Every tmux and PowerShell
 * call is recorded, and every test checks that none of them could type text.
 *
 * Run: npx tsx --test test/watcher-limit.test.ts
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agentServiceNamesFor, buildLaunchRecipe } from '../lib/agent-inventory.mjs'
import { LIMIT_NOTICE_FILE_NAME, LIMIT_WATCH_FILE_NAME, runLimitPass } from '../lib/watcher-limit.mjs'
import { parseLimitNotice } from '../lib/limit-screen.mjs'
import { supervisorFileBody } from '../bin/hoai-core.mjs'
import { memoryFs, type MemoryFs } from './helpers/memory-fs.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const SID = '8c1f0000-0000-4000-8000-000000000001'
// Ares, 2026-11-01: the weekly limit at 16:39:03, resetsAt 1793980800 (2026-11-06T16:00Z).
const LIMIT_AT = Date.parse('2026-11-01T16:39:03.000Z')
const RESETS_AT = 1_793_980_800_000
const SWAP_AT = Date.parse('2026-11-01T16:53:14.000Z')

const LIMIT_LINE = "  ⎿  You've hit your weekly limit · resets Nov 6, 8pm (Asia/Dubai)"
function picker(selected = 0, options = ['Stop and wait for limit to reset', 'Wait here, then continue automatically at Nov 6, 8pm', 'Add funds to continue with usage credits']) {
  return [
    LIMIT_LINE,
    '',
    '╭──────────────────────────────────────────────────────╮',
    '│ What do you want to do?                              │',
    '│                                                      │',
    ...options.map((o, i) => `│ ${i === selected ? '❯' : ' '} ${i + 1}. ${o}  │`),
    '│                                                      │',
    '│ Enter to confirm · Esc to cancel                     │',
    '╰──────────────────────────────────────────────────────╯',
  ].join('\n')
}
const IDLE = [LIMIT_LINE, '', '╭────────────────────────────╮', '│ > ', '╰────────────────────────────╯'].join('\n')

// -- the agent on disk ------------------------------------------------------------------------------

type Rig = { home: string; config: string; cwd: string; stateDir: string; transcript: string; credentials: string; platform: string }

function linuxRig(): Rig {
  const home = '/home/kc'
  const config = `${home}/.claude`
  const cwd = `${home}/hoai-agents/ava`
  return {
    home,
    config,
    cwd,
    stateDir: `${home}/.bgos-agent/912`,
    transcript: `${config}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${SID}.jsonl`,
    credentials: `${config}/.credentials.json`,
    platform: 'linux',
  }
}

function winRig(): Rig {
  const home = 'C:\\Users\\kc'
  const config = `${home}\\.claude`
  const cwd = 'E:\\001 Ava'
  return {
    home,
    config,
    cwd,
    stateDir: `${home}\\.bgos-agent\\912`,
    transcript: `${config}\\projects\\E--001-Ava\\${SID}.jsonl`,
    credentials: `${config}\\.credentials.json`,
    platform: 'win32',
  }
}

const join = (r: Rig, ...parts: string[]) => [r.stateDir.replace(/[\\/]912$/, ''), ...parts].join(r.platform === 'win32' ? '\\' : '/')

function agentFs(r: Rig): MemoryFs {
  const recipe = JSON.stringify(buildLaunchRecipe({ assistantId: '912', cwd: r.cwd, argv: ['--x'], installMethod: 'marketplace', pluginRoot: `${r.config}/plugins/cache/hoai/hoai/0.74.4`, node: 'node', startedAt: 'x', pid: 4242 }))
  const sep = r.platform === 'win32' ? '\\' : '/'
  const fs = memoryFs(
    {
      [join(r, 'credentials-912.json')]: JSON.stringify({ pairingToken: 'agent-secret-912', backendUrl: 'x' }),
      [`${r.stateDir}${sep}launch.json`]: recipe,
      [`${r.stateDir}${sep}supervisor.json`]: supervisorFileBody(4242, 'x'),
      [`${r.stateDir}${sep}session-id`]: `${SID}\n`,
      [`${r.cwd}${sep}.bgos-agent-id`]: '912\n',
      // A credential file whose CONTENT no test may ever see read: only its mtime counts.
      [r.credentials]: 'NEVER-READ-THIS-CREDENTIAL',
    },
    [r.cwd],
  )
  fs.touch(r.credentials, LIMIT_AT - 3 * HOUR)
  // The credential file is stat-ed, never opened: any read of it fails the test.
  const readFile = fs.readFile
  const readTail = fs.readTail
  fs.readFile = (p: string) => {
    if (/\.credentials\.json$/.test(p)) throw new Error(`the credential file was READ: ${p}`)
    return readFile(p)
  }
  fs.readTail = (p: string, n: number) => {
    if (/\.credentials\.json$/.test(p)) throw new Error(`the credential file was READ: ${p}`)
    return readTail(p, n)
  }
  return fs
}

const limitRecord = (atMs = LIMIT_AT) =>
  JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiError: 'usage_limit_reached',
    apiErrorStatus: 429,
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT / 1000, rateLimitType: 'seven_day', isUsingOverage: false } },
    timestamp: new Date(atMs).toISOString(),
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 6, 8pm (Asia/Dubai)" }] },
  })
const assistantTurn = (atMs: number) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(atMs).toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Back. Catching up.' }] } })

function writeTranscript(fs: MemoryFs, r: Rig, lines: string[]) {
  fs.writeFile(r.transcript, `${lines.join('\n')}\n`)
}
function appendTranscript(fs: MemoryFs, r: Rig, line: string) {
  fs.writeFile(r.transcript, `${fs.readFile(r.transcript) ?? ''}${line}\n`)
}

// -- the fakes ----------------------------------------------------------------------------------------

function fakeClock(start: number) {
  let nowMs = start
  const hooks: Array<(nowMs: number) => void> = []
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms
      for (const hook of hooks) hook(nowMs)
    },
    onSleep: (hook: (nowMs: number) => void) => hooks.push(hook),
    set: (ms: number) => {
      nowMs = ms
    },
  }
}

type ExecCall = { file: string; args: string[] }

/** A fake tmux server on the agent's own socket: its pane shows `screen()`, and an Enter is recorded. */
function fakeTmux(socket: string, screen: (state: { entered: number; captures: number }) => string, onEnter: () => void = () => {}) {
  const calls: ExecCall[] = []
  const state = { entered: 0, captures: 0 }
  const exec = async (file: string, args: string[]) => {
    calls.push({ file, args: [...args] })
    if (!/tmux$/.test(file)) return { code: 1, stdout: '', stderr: 'unexpected', error: null, timedOut: false }
    if (args[1] !== socket) return { code: 1, stdout: '', stderr: `no server running on /tmp/tmux-501/${args[1]}`, error: null, timedOut: false }
    if (args[2] === 'capture-pane') {
      state.captures += 1
      return { code: 0, stdout: `${screen(state)}\n`, stderr: '', error: null, timedOut: false }
    }
    if (args[2] === 'send-keys') {
      onEnter()
      state.entered += 1
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    }
    return { code: 1, stdout: '', stderr: 'unexpected', error: null, timedOut: false }
  }
  return { exec, calls, state }
}

/** The only two tmux argv shapes the pass may ever run: a read of the pane, and ONE Enter key by name. */
function assertOnlySafeTmux(calls: ExecCall[]) {
  for (const { file, args } of calls) {
    assert.match(file, /tmux$/, `only tmux runs: ${file}`)
    const [l, socket, verb, ...rest] = args
    assert.equal(l, '-L')
    assert.match(socket!, /^hoai-912(-home-[0-9a-f]{8})?$/)
    if (verb === 'capture-pane') assert.deepEqual(rest, ['-p', '-t', `=${socket}:`])
    else if (verb === 'send-keys') assert.deepEqual(rest, ['-t', `=${socket}:`, 'Enter'], 'a key NAME, never -l, never text')
    else assert.fail(`tmux ${verb} is not a verb the limit pass may run`)
  }
}
const enters = (calls: ExecCall[]) => calls.filter((c) => c.args.includes('send-keys') || c.args.includes('press'))

function ctxFor(r: Rig, fs: MemoryFs, clock: ReturnType<typeof fakeClock>, exec: any, over: Record<string, unknown> = {}) {
  const logs: string[] = []
  return {
    ctx: {
      home: r.home,
      env: { USER: 'kc' },
      platform: r.platform,
      fs,
      exec,
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      pidAlive: (pid: number) => pid === 4242,
      execSync: () => ({ code: 1, stdout: '' }),
      uid: 501,
      assistantIds: ['912'],
      tmuxPath: '/usr/bin/tmux',
      helperDir: 'C:\\hoai\\bin',
      ...over,
    },
    logs,
  }
}

const socketOf = (r: Rig) => agentServiceNamesFor('912', r.home, r.platform)!.current.tmuxSocket
const limitWatch = (fs: MemoryFs, r: Rig) => JSON.parse(fs.readFile(join(r, 'watcher', LIMIT_WATCH_FILE_NAME)) ?? '{"agents":{}}').agents['912'] ?? null
const noticeOf = (fs: MemoryFs, r: Rig) => {
  const raw = fs.readFile(`${r.stateDir}${r.platform === 'win32' ? '\\' : '/'}${LIMIT_NOTICE_FILE_NAME}`)
  return raw == null ? null : parseLimitNotice(raw)
}

// -- the brief's cases ---------------------------------------------------------------------------------

test('a fake stuck screen, still limited: no key, and the screen is not even read', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [assistantTurn(LIMIT_AT - 5 * MIN), limitRecord()])
  const clock = fakeClock(LIMIT_AT + 30 * MIN)
  const tmux = fakeTmux(socketOf(r), () => picker())
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const out = await runLimitPass(ctx)
  assert.deepEqual(out.agents.map((a: any) => [a.id, a.outcome]), [['912', 'limited']])
  assert.deepEqual(tmux.calls, [], 'nothing is read or pressed while the limit is still on')
  assert.equal(noticeOf(fs, r), null, 'the watcher says nothing new while the limit holds (C9 is reported elsewhere)')
})

test('usage back (the login changed after the limit): exactly ONE Enter, verified by a fresh turn, and the owner is told', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [assistantTurn(LIMIT_AT - 5 * MIN), limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  let recordAtEnter: any = 'unset'
  const tmux = fakeTmux(socketOf(r), (s) => (s.entered ? IDLE : picker()), () => {
    recordAtEnter = limitWatch(fs, r)
  })
  // The queue drains once the picker closes: the first real turn lands a few seconds after the Enter.
  clock.onSleep((nowMs) => {
    if (tmux.state.entered === 1 && !/Catching up/.test(fs.readFile(r.transcript)!.split('\n').slice(-2).join(''))) appendTranscript(fs, r, assistantTurn(nowMs))
  })
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const pressAt = clock.now()
  const out = await runLimitPass(ctx)
  assertOnlySafeTmux(tmux.calls)
  assert.equal(enters(tmux.calls).length, 1, 'exactly one Enter')
  assert.equal(recordAtEnter?.lastEnterAt, new Date(pressAt).toISOString(), 'the Enter is on disk BEFORE the key is sent')
  assert.deepEqual(out.agents.map((a: any) => [a.id, a.outcome]), [['912', 'freed']])
  const n = noticeOf(fs, r)!
  assert.deepEqual([n.outcome, n.how, n.limitAt, n.pressedAt], ['freed', 'login_changed', new Date(LIMIT_AT).toISOString(), new Date(pressAt).toISOString()])
})

test('usage back (the reset time passed): one Enter, and the notice says the limit reset', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  const clock = fakeClock(RESETS_AT + 2 * MIN)
  const tmux = fakeTmux(socketOf(r), (s) => (s.entered ? IDLE : picker()))
  clock.onSleep((nowMs) => {
    if (tmux.state.entered === 1 && !fs.readFile(r.transcript)!.includes('Catching up')) appendTranscript(fs, r, assistantTurn(nowMs))
  })
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const out = await runLimitPass(ctx)
  assertOnlySafeTmux(tmux.calls)
  assert.equal(enters(tmux.calls).length, 1)
  assert.equal(out.agents[0].outcome, 'freed')
  assert.equal(noticeOf(fs, r)!.how, 'reset_passed')
})

test('screen unclear (the pointer sits on "Add funds"): no key; the owner is told once, not every sweep', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const flipped = ['Add funds to continue with usage credits', 'Upgrade your plan', 'Stop and wait for limit to reset']
  const tmux = fakeTmux(socketOf(r), () => picker(0, flipped))
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const first = await runLimitPass(ctx)
  assertOnlySafeTmux(tmux.calls)
  assert.equal(enters(tmux.calls).length, 0, 'no key on a screen whose selection is not "Stop and wait"')
  assert.deepEqual([first.agents[0].outcome, noticeOf(fs, r)?.outcome, noticeOf(fs, r)?.why], ['cannot_press', 'cannot_press', 'selection_elsewhere'])
  // The daemon took the notice; the next sweep finds the same screen and writes no second one.
  fs.rm(`${r.stateDir}/${LIMIT_NOTICE_FILE_NAME}`)
  clock.set(SWAP_AT + 2 * MIN)
  await runLimitPass(ctx)
  assert.equal(enters(tmux.calls).length, 0)
  assert.equal(noticeOf(fs, r), null, 'one notice per limit episode and reason')
})

test('a second Enter inside the hour is refused; the next one is allowed only once the hour is spent', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  // The Enter "does not take": the picker stays (a measured CLI quirk would look like this).
  const tmux = fakeTmux(socketOf(r), () => picker())
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const first = await runLimitPass(ctx)
  assert.equal(enters(tmux.calls).length, 1)
  assert.equal(first.agents[0].outcome, 'not_taken')
  for (const later of [5 * MIN, 30 * MIN, 59 * MIN]) {
    clock.set(SWAP_AT + MIN + later)
    const again = await runLimitPass(ctx)
    assert.equal(again.agents[0].outcome, 'waiting', `at +${later / MIN} min`)
  }
  assert.equal(enters(tmux.calls).length, 1, 'still exactly one Enter inside the hour')
  clock.set(SWAP_AT + MIN + HOUR)
  await runLimitPass(ctx)
  assert.equal(enters(tmux.calls).length, 2, 'the hour is spent: one more is allowed')
  assertOnlySafeTmux(tmux.calls)
})

// -- the record of the Enter: whole on disk, and a record that is lost or not saved never allows a key ----
// The fake tmux only records the Enter it would get; no test here can reach a real window.

const watchPathOf = (r: Rig) => join(r, 'watcher', LIMIT_WATCH_FILE_NAME)
// The agent's own copy of its last Enter, beside the notice: a second witness if the watcher's file goes.
const enterCopyOf = (r: Rig) => `${r.stateDir}${r.platform === 'win32' ? '\\' : '/'}limit-enter.json`

function usageBackRig() {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  return { r, fs, clock: fakeClock(SWAP_AT + MIN) }
}

test('the record of the Enter is written whole: a temp file, then a rename, never in place', async () => {
  const { r, fs, clock } = usageBackRig()
  const watchPath = watchPathOf(r)
  fs.writeFile(watchPath, `${JSON.stringify({ schemaVersion: 1, agents: { 913: { lastEnterAt: '2026-10-30T09:00:00.000Z' } } })}\n`)
  const inPlace: string[] = []
  const landed: string[] = []
  const writeFile = fs.writeFile
  const rename = fs.rename
  fs.writeFile = (p, t, o) => {
    if (p === watchPath || p === enterCopyOf(r)) inPlace.push(p)
    writeFile(p, t, o)
  }
  fs.rename = (a, b) => {
    if (a !== b && (b === watchPath || b === enterCopyOf(r))) landed.push(b)
    rename(a, b)
  }
  const tmux = fakeTmux(socketOf(r), (s) => (s.entered ? IDLE : picker()))
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  await runLimitPass(ctx)
  assert.equal(enters(tmux.calls).length, 1)
  assert.deepEqual(inPlace, [], 'neither record is ever written in place (a crash mid write would tear it)')
  assert.ok(landed.includes(watchPath) && landed.includes(enterCopyOf(r)), `both land by rename: ${landed.join(', ')}`)
  assert.equal(JSON.parse(fs.readFile(watchPath)!).agents['913'].lastEnterAt, '2026-10-30T09:00:00.000Z', 'the other agents are kept')
  assert.equal(JSON.parse(fs.readFile(enterCopyOf(r))!).lastEnterAt, new Date(SWAP_AT + MIN).toISOString())
})

test('a corrupt record (torn, empty, or the wrong shape): no Enter for an hour, the bad copy is kept aside, then one Enter', async () => {
  const torn = '{"schemaVersion":1,"agents":{"912":{"lastEnterAt":"2026-11-01T16:5'
  for (const [label, path, body] of [
    ['torn watch file', 'watch', torn],
    ['empty watch file', 'watch', ''],
    ['watch file of the wrong shape', 'watch', '{"agents":[]}'],
    ['torn agent copy', 'copy', '{"schemaVersion":1,"lastEnt'],
  ] as const) {
    const { r, fs, clock } = usageBackRig()
    const target = path === 'watch' ? watchPathOf(r) : enterCopyOf(r)
    fs.writeFile(target, body)
    const tmux = fakeTmux(socketOf(r), (s) => (s.entered ? IDLE : picker()))
    const { ctx, logs } = ctxFor(r, fs, clock, tmux.exec)
    const first = await runLimitPass(ctx)
    assert.equal(first.agents[0].outcome, 'waiting', `${label}: a record that cannot be read blocks the key`)
    assert.equal(enters(tmux.calls).length, 0, label)
    assert.equal(fs.readFile(`${target}.lost`), body, `${label}: the unreadable copy is kept for a person`)
    assert.ok(logs.some((l) => /record .*could not be read/.test(l)), `${label}: logged`)
    clock.set(SWAP_AT + MIN + 59 * MIN)
    assert.equal((await runLimitPass(ctx)).agents[0].outcome, 'waiting', `${label}: still inside the hour`)
    assert.equal(enters(tmux.calls).length, 0, label)
    clock.set(SWAP_AT + MIN + HOUR)
    await runLimitPass(ctx)
    assert.equal(enters(tmux.calls).length, 1, `${label}: an hour after the loss was seen, one Enter`)
    assertOnlySafeTmux(tmux.calls)
  }
})

test('the watcher record deleted after an Enter: the agent copy still holds the hour (and the other way round)', async () => {
  for (const gone of ['watch', 'copy'] as const) {
    const { r, fs, clock } = usageBackRig()
    // The Enter "does not take": the picker stays up, so every pass would press again if it could.
    const tmux = fakeTmux(socketOf(r), () => picker())
    const { ctx } = ctxFor(r, fs, clock, tmux.exec)
    assert.equal((await runLimitPass(ctx)).agents[0].outcome, 'not_taken')
    assert.equal(enters(tmux.calls).length, 1)
    fs.rm(gone === 'watch' ? watchPathOf(r) : enterCopyOf(r))
    clock.set(SWAP_AT + MIN + 10 * MIN)
    assert.equal((await runLimitPass(ctx)).agents[0].outcome, 'waiting', `${gone} gone: the other record holds the hour`)
    assert.equal(enters(tmux.calls).length, 1, `${gone} gone: still one Enter`)
    clock.set(SWAP_AT + MIN + HOUR)
    await runLimitPass(ctx)
    assert.equal(enters(tmux.calls).length, 2, `${gone} gone: the hour is spent, one more`)
    assertOnlySafeTmux(tmux.calls)
  }
})

test('the Enter cannot be put on disk (a write throws, or does not land): no key', async () => {
  const breakers: Array<[string, (fs: MemoryFs, r: Rig) => void]> = [
    ['the watch file rename throws', (fs, r) => {
      const rename = fs.rename
      fs.rename = (a, b) => (b === watchPathOf(r) ? (() => { throw new Error('EPERM') })() : rename(a, b))
    }],
    ['the watch file write is lost', (fs, r) => {
      const writeFile = fs.writeFile
      fs.writeFile = (p, t, o) => (p.startsWith(watchPathOf(r)) ? undefined : writeFile(p, t, o))
    }],
    ['the agent copy write throws', (fs, r) => {
      const writeFile = fs.writeFile
      fs.writeFile = (p, t, o) => (p.startsWith(enterCopyOf(r)) ? (() => { throw new Error('ENOSPC') })() : writeFile(p, t, o))
    }],
  ]
  for (const [label, breakIt] of breakers) {
    const { r, fs, clock } = usageBackRig()
    breakIt(fs, r)
    const tmux = fakeTmux(socketOf(r), (s) => (s.entered ? IDLE : picker()))
    const { ctx } = ctxFor(r, fs, clock, tmux.exec)
    const out = await runLimitPass(ctx)
    assert.deepEqual([out.agents[0].outcome, out.agents[0].reason], ['not_pressed', 'record_unsaved'], label)
    assert.equal(enters(tmux.calls).length, 0, `${label}: no key without the record on disk`)
    assertOnlySafeTmux(tmux.calls)
  }
})

// -- the press itself ------------------------------------------------------------------------------------

test('the screen changed between the read and the press: no key is sent', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  // The second read (the one right before the key) shows another screen: someone pressed already.
  const tmux = fakeTmux(socketOf(r), (s) => (s.captures >= 2 ? IDLE : picker()))
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const out = await runLimitPass(ctx)
  assertOnlySafeTmux(tmux.calls)
  assert.equal(enters(tmux.calls).length, 0)
  assert.equal(out.agents[0].outcome, 'not_pressed')
})

test('still limited after the Enter (the login changed but to the same capped account): the owner is told Claude still refuses', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const tmux = fakeTmux(socketOf(r), (s) => (s.entered ? IDLE : picker()))
  clock.onSleep((nowMs) => {
    if (tmux.state.entered === 1 && fs.readFile(r.transcript)!.split('\n').filter(Boolean).length === 1) appendTranscript(fs, r, limitRecord(nowMs))
  })
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const out = await runLimitPass(ctx)
  assert.equal(enters(tmux.calls).length, 1)
  assert.equal(out.agents[0].outcome, 'still_limited')
  assert.equal(noticeOf(fs, r)!.outcome, 'still_limited')
})

test('closed but no turn yet (nothing was waiting): the picker is gone, the notice says it answers the next message', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const tmux = fakeTmux(socketOf(r), (s) => (s.entered ? IDLE : picker()))
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const out = await runLimitPass(ctx)
  assert.equal(enters(tmux.calls).length, 1)
  assert.equal(out.agents[0].outcome, 'closed')
  assert.equal(noticeOf(fs, r)!.outcome, 'closed')
})

test('no tmux on this computer: no key; the owner gets the one tap fix (Restart now), once', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const tmux = fakeTmux(socketOf(r), () => picker())
  const { ctx } = ctxFor(r, fs, clock, tmux.exec, { tmuxPath: null })
  const out = await runLimitPass(ctx)
  assert.deepEqual(tmux.calls, [])
  assert.deepEqual([out.agents[0].outcome, noticeOf(fs, r)?.why], ['cannot_press', 'no_tmux'])
})

test('a real turn after the limit (the agent already came back): nothing to do', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord(), assistantTurn(LIMIT_AT + 20 * MIN)])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + 30 * MIN)
  const tmux = fakeTmux(socketOf(r), () => picker())
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const out = await runLimitPass(ctx)
  assert.deepEqual(tmux.calls, [])
  assert.equal(out.agents[0].outcome, 'none')
})

test('an agent the keep-alive switch did not clear is never looked at', async () => {
  const r = linuxRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const tmux = fakeTmux(socketOf(r), () => picker())
  const { ctx } = ctxFor(r, fs, clock, tmux.exec, { assistantIds: [] })
  const out = await runLimitPass(ctx)
  assert.deepEqual([out.agents, tmux.calls], [[], []])
})

test('macOS keeps the login in the Keychain: a credential file there is not evidence, only the reset time is', async () => {
  const r = { ...linuxRig(), platform: 'darwin' }
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const tmux = fakeTmux(agentServiceNamesFor('912', r.home, 'darwin')!.current.tmuxSocket, () => picker())
  const { ctx } = ctxFor(r, fs, clock, tmux.exec)
  const out = await runLimitPass(ctx)
  assert.deepEqual([out.agents[0].outcome, tmux.calls.length], ['limited', 0])
})

// -- Windows: the helper reads the hidden console, and presses only on the screen it was shown ------------

function fakeHelper(screen: (state: { pressed: number; reads: number }) => string) {
  const calls: ExecCall[] = []
  const state = { pressed: 0, reads: 0 }
  const hashOf = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
  const exec = async (file: string, args: string[]) => {
    calls.push({ file, args: [...args] })
    if (file !== 'powershell.exe') return { code: 1, stdout: '', stderr: 'unexpected', error: null, timedOut: false }
    const mode = args[args.indexOf('-Mode') + 1]
    const text = screen(state)
    if (mode === 'read') {
      state.reads += 1
      return { code: 0, stdout: `HOAI-SCREEN ${hashOf(text)} ${Buffer.from(text, 'utf8').toString('base64')}\r\n`, stderr: '', error: null, timedOut: false }
    }
    if (mode === 'press') {
      if (args[args.indexOf('-ExpectHash') + 1] !== hashOf(text)) return { code: 7, stdout: '', stderr: '', error: null, timedOut: false }
      state.pressed += 1
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    }
    return { code: 1, stdout: '', stderr: 'unexpected', error: null, timedOut: false }
  }
  return { exec, calls, state, hashOf }
}

function assertOnlySafeHelper(calls: ExecCall[]) {
  for (const { file, args } of calls) {
    assert.equal(file, 'powershell.exe')
    const head = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\hoai\\bin\\win32-limit-screen.ps1', '-ConsolePid', '4242', '-Mode']
    assert.deepEqual(args.slice(0, head.length), head)
    const rest = args.slice(head.length)
    if (rest[0] === 'read') assert.deepEqual(rest, ['read'])
    else {
      assert.equal(rest[0], 'press')
      assert.equal(rest[1], '-ExpectHash')
      assert.match(rest[2]!, /^[0-9a-f]{64}$/, 'the only other argument is a hash, never text or a key')
      assert.equal(rest.length, 3)
    }
  }
}

test('Windows: the helper reads the agent console, and presses ONE Enter only for the screen hash it was shown', async () => {
  const r = winRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const helper = fakeHelper((s) => (s.pressed ? IDLE : picker()))
  clock.onSleep((nowMs) => {
    if (helper.state.pressed === 1 && !fs.readFile(r.transcript)!.includes('Catching up')) appendTranscript(fs, r, assistantTurn(nowMs))
  })
  const { ctx } = ctxFor(r, fs, clock, helper.exec)
  const out = await runLimitPass(ctx)
  assertOnlySafeHelper(helper.calls)
  const presses = helper.calls.filter((c) => c.args.includes('press'))
  assert.equal(presses.length, 1)
  assert.equal(presses[0]!.args.at(-1), helper.hashOf(picker()), 'the hash of the screen the pass approved')
  assert.equal(out.agents[0].outcome, 'freed')
})

test('Windows: a dead launcher (no console to attach to) is never pressed; the owner gets the one tap fix', async () => {
  const r = winRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const helper = fakeHelper(() => picker())
  const { ctx } = ctxFor(r, fs, clock, helper.exec, { pidAlive: () => false })
  const out = await runLimitPass(ctx)
  assert.deepEqual(helper.calls, [])
  assert.deepEqual([out.agents[0].outcome, noticeOf(fs, r)?.why], ['cannot_press', 'no_console'])
})

test('Windows: a helper answer that does not hash to its own text is unreadable, never pressed', async () => {
  const r = winRig()
  const fs = agentFs(r)
  writeTranscript(fs, r, [limitRecord()])
  fs.touch(r.credentials, SWAP_AT)
  const clock = fakeClock(SWAP_AT + MIN)
  const calls: ExecCall[] = []
  const exec = async (file: string, args: string[]) => {
    calls.push({ file, args })
    return { code: 0, stdout: `HOAI-SCREEN ${'0'.repeat(64)} ${Buffer.from(picker(), 'utf8').toString('base64')}\r\n`, stderr: '', error: null, timedOut: false }
  }
  const { ctx } = ctxFor(r, fs, clock, exec)
  const out = await runLimitPass(ctx)
  assert.equal(calls.filter((c) => c.args.includes('press')).length, 0)
  assert.deepEqual([out.agents[0].outcome, noticeOf(fs, r)?.why], ['cannot_press', 'screen_unreadable'])
})

// -- the module's own guarantees ------------------------------------------------------------------------

test('structure: the only key the watcher modules can send is one Enter; no path types text', () => {
  for (const path of ['../lib/watcher-limit.mjs', '../lib/limit-keys.mjs']) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, /send-keys'[^\n]*'-l'|'-l',/, `${path}: no literal typing`)
    assert.doesNotMatch(source, /\/login/, `${path}: never /login`)
    assert.doesNotMatch(source, /'Escape'|'C-[a-z]'|'BSpace'/, `${path}: no other key`)
  }
  const helper = readFileSync(fileURLToPath(new URL('../bin/win32-limit-screen.ps1', import.meta.url)), 'utf8')
  assert.equal((helper.match(/WriteConsoleInputW\(/g) ?? []).length, 2, 'one declaration and one call of the key writer')
  assert.match(helper, /VirtualKeyCode = 0x0D/)
  assert.doesNotMatch(helper, /SendKeys|keybd_event|SendInput/)
})

test('the watcher bundle carries the limit pass, its pure rules, the key module and the Windows helper', async () => {
  const { WATCHER_BUNDLE_FILES } = await import('../lib/watcher-bundle.mjs')
  for (const rel of ['lib/watcher-limit.mjs', 'lib/limit-screen.mjs', 'lib/limit-keys.mjs', 'bin/win32-limit-screen.ps1']) {
    assert.ok(WATCHER_BUNDLE_FILES.includes(rel), rel)
  }
})

test('house style: no em or en dashes in the new modules, the helper or this test', () => {
  for (const path of ['../lib/watcher-limit.mjs', '../lib/limit-keys.mjs', '../bin/win32-limit-screen.ps1', './watcher-limit.test.ts']) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, new RegExp('[\\u2013\\u2014]'), path)
  }
})
