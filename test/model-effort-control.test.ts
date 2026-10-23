/**
 * Owner model and effort control (Route A): the checked transaction
 * (lib/model-effort-control.ts), driven against a FAKE tmux pane.
 *
 * The fake plays both halves of the host: the tmux server (display-message,
 * capture-pane, send-keys) and the Claude Code session behind it, whose
 * status line writes a new numbered observation a little after a command
 * really applies. Nothing here touches a real terminal or a real session.
 *
 * Every precondition the proposal lists has a case, and each refusal is
 * checked to have typed NOTHING. Confirmation is checked against the false
 * successes the proposal names: echoed input, an observation that advances
 * without the change, a session that changes mid confirmation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { TmuxTarget } from '../lib/compact-inject.ts'
import { ModelEffortControl, type ControlDeps } from '../lib/model-effort-control.ts'
import type { ModelObservation } from '../lib/model-control-store.mjs'

const HELP = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-help-2.1.309.txt'),
  'utf8',
)
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TARGET: TmuxTarget = { target: '%7', socketArgs: ['-L', 'fake'], source: 'env-session' }
const RULE = '─'.repeat(50)

/** The tmux server and the Claude Code session behind one pane. */
class FakePane {
  composer = ''
  dead = false
  inMode = false
  tty = '/dev/ttys012'
  foregroundPgid = 800
  /** The pane's root process: the CLI, the daemon's parent. */
  rootPid = 800
  model = 'claude-opus-5-5'
  effort: string | null = 'high'
  sessionId = SID
  seq = 1
  observedAtMs = 0
  /** Does the CLI apply what is submitted? */
  applies = true
  /** Does Enter submit (false: the text only echoes in the composer)? */
  submits = true
  /** Status line ticks that report the OLD value before the new one lands. */
  staleTicks = 1
  /** Reads before the next status line tick writes. */
  private pending: { model: string; effort: string | null; ticksLeft: number } | null = null
  sendKeys: string[][] = []
  failSendKeys = false
  failDisplay = false
  clock: { now: number }

  constructor(clock: { now: number }) {
    this.clock = clock
    this.observedAtMs = clock.now
  }

  screen(): string {
    return ['● ready', RULE, `❯ ${this.composer}`, RULE, '  ? for shortcuts'].join('\n')
  }

  async exec(argv: string[]): Promise<string> {
    const verb = argv.find((a) => a === 'display-message' || a === 'capture-pane' || a === 'send-keys')
    if (verb === 'display-message') {
      if (this.failDisplay) throw new Error('no such pane')
      return `%7\t${this.tty}\t${this.dead ? 1 : 0}\t${this.inMode ? 1 : 0}\t${this.rootPid}\n`
    }
    if (verb === 'capture-pane') return this.screen()
    if (verb === 'send-keys') {
      this.sendKeys.push(argv)
      if (this.failSendKeys) throw new Error('send-keys failed')
      const key = argv.at(-1)!
      if (argv.includes('-l')) {
        this.composer += key
      } else if (key === 'Enter' && this.submits) {
        const line = this.composer
        this.composer = ''
        let model = this.model
        let effort = this.effort
        const m = /^\/model (\w+)$/.exec(line)
        const e = /^\/effort (\w+)$/.exec(line)
        if (m && this.applies) model = `claude-${m[1]}-5-5`
        if (e && this.applies) effort = e[1]!
        this.pending = { model, effort, ticksLeft: this.staleTicks }
      }
      return ''
    }
    throw new Error(`unexpected argv ${argv.join(' ')}`)
  }

  /** The status line bridge: each read is one refresh tick. */
  observation(sessionId: string): ModelObservation | null {
    if (sessionId !== this.sessionId) return null
    if (this.pending) {
      this.seq++
      this.observedAtMs = this.clock.now
      if (this.pending.ticksLeft > 0) {
        this.pending.ticksLeft--
      } else {
        this.model = this.pending.model
        this.effort = this.pending.effort
        this.pending = null
      }
    }
    return {
      sessionId: this.sessionId,
      modelId: this.model,
      modelDisplayName: this.model.split('-')[1] ?? this.model,
      effort: this.effort,
      version: '2.1.309',
      seq: this.seq,
      observedAtMs: this.observedAtMs,
    }
  }
}

function rig(over: Partial<ControlDeps> = {}) {
  const clock = { now: 1_000_000 }
  const pane = new FakePane(clock)
  const state = {
    optedIn: true,
    target: TARGET as TmuxTarget | null,
    sessionId: SID as string | null,
    turn: 'idle' as 'idle' | 'live' | 'unknown',
    dialogOpen: false,
    otherBusy: false,
    ancestryCalls: 0,
  }
  const logs: string[] = []
  const deps: ControlDeps = {
    optedIn: () => state.optedIn,
    target: () => state.target,
    sessionId: () => state.sessionId,
    turnState: () => state.turn,
    dialogOpen: () => state.dialogOpen,
    otherInjectionBusy: () => state.otherBusy,
    ancestry: async () => {
      state.ancestryCalls++
      return [
        { pid: 900, tty: 'ttys012', pgid: 800, tpgid: pane.foregroundPgid },
        { pid: 800, tty: 'ttys012', pgid: 800, tpgid: pane.foregroundPgid },
      ]
    },
    readObservation: (sid) => pane.observation(sid),
    helpText: async () => HELP,
    exec: (argv) => pane.exec(argv),
    sleep: async (ms) => {
      clock.now += ms
    },
    now: () => clock.now,
    log: (m) => logs.push(m),
    ...over,
  }
  const control = new ModelEffortControl(deps, { confirmTimeoutMs: 10_000, pollMs: 250, staleMs: 15_000 })
  return { control, pane, state, clock, logs }
}

function typed(pane: FakePane): string[] {
  return pane.sendKeys.map((argv) => argv.at(-1)!)
}

function assertNoEscape(pane: FakePane): void {
  for (const argv of pane.sendKeys) {
    assert.ok(!argv.includes('Escape'), 'never an Escape: a draft is never discarded')
    assert.ok(!argv.includes('C-u') && !argv.includes('C-c'), 'never a clearing key')
  }
}

test('set_model types the fixed literal, confirms from a NEWER observation and reports the applied model', async () => {
  const { control, pane } = rig()
  const out = await control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, true, JSON.stringify(out))
  if (!out.ok) return
  assert.equal(out.applied, true)
  assert.deepEqual(typed(pane), ['/model sonnet', 'Enter'])
  assert.equal(out.report.model, 'claude-sonnet-5-5')
  assert.equal(out.report.modelFamily, 'sonnet')
  assert.equal(out.report.effort, 'high')
  assert.equal(control.busy, false, 'the lock is released')
  assertNoEscape(pane)
})

test('set_effort types the fixed literal and confirms the live effort', async () => {
  const { control, pane } = rig()
  const out = await control.handle({ op: 'set_effort', value: 'xhigh' })
  assert.equal(out.ok, true, JSON.stringify(out))
  if (!out.ok) return
  assert.deepEqual(typed(pane), ['/effort xhigh', 'Enter'])
  assert.equal(out.report.effort, 'xhigh')
  assert.equal(out.report.model, 'claude-opus-5-5')
})

test('a request for what already runs types nothing and reports it', async () => {
  const { control, pane } = rig()
  const out = await control.handle({ op: 'set_model', value: 'opus' })
  assert.equal(out.ok, true)
  if (out.ok) assert.equal(out.applied, false)
  assert.equal(pane.sendKeys.length, 0)
})

test('describe reports the current model and the host catalog without typing', async () => {
  const { control, pane } = rig()
  const out = await control.handle({ op: 'describe' })
  assert.equal(out.ok, true)
  if (!out.ok) return
  assert.equal(out.report.model, 'claude-opus-5-5')
  assert.deepEqual(out.report.availableModels, ['fable', 'opus', 'sonnet'])
  assert.deepEqual(out.report.availableEfforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(out.report.canChange, true)
  assert.equal(pane.sendKeys.length, 0)
})

test('describe while not opted in still reports the truth, and says it cannot change it', async () => {
  const { control, state } = rig()
  state.optedIn = false
  const out = await control.handle({ op: 'describe' })
  assert.equal(out.ok, true)
  if (!out.ok) return
  assert.equal(out.report.canChange, false)
  assert.equal(out.report.cannotChangeCode, 'not_opted_in')
})

async function refused(
  setup: (r: ReturnType<typeof rig>) => void,
  request: { op: unknown; value?: unknown },
  code: string,
) {
  const r = rig()
  setup(r)
  const out = await r.control.handle(request)
  assert.equal(out.ok, false, `${code}: ${JSON.stringify(out)}`)
  if (out.ok) return r
  assert.equal(out.code, code)
  assert.ok(out.message.length > 0 && out.message.length <= 300)
  assert.doesNotMatch(out.message, /[–—]/)
  assert.equal(r.pane.sendKeys.length, 0, `${code}: nothing may be typed`)
  assert.equal(r.control.busy, false)
  return r
}

test('no owner opt in: refused before the terminal is even looked at', async () => {
  const r = await refused((r) => { r.state.optedIn = false }, { op: 'set_model', value: 'sonnet' }, 'not_opted_in')
  assert.equal(r.state.ancestryCalls, 0)
})

test('an op outside the two typed operations is refused', async () => {
  for (const op of ['set_permissions', 'slash_command', 'type', 'SET_MODEL', '', null, 7]) {
    await refused(() => {}, { op, value: 'sonnet' }, 'unsupported_op')
  }
})

test('every value outside the frozen tables is refused, injection attempts included', async () => {
  for (const value of ['Sonnet', 'sonnet ', 'sonnet\n', '/model sonnet', 'sonnet; /effort max', 'claude-sonnet-5-5', '__proto__', 'toString', '', null, 1, ['sonnet']]) {
    await refused(() => {}, { op: 'set_model', value }, 'unsupported_value')
  }
  for (const value of ['HIGH', 'off', 'auto', 'high\r', '/effort high', 'max && x', 'constructor']) {
    await refused(() => {}, { op: 'set_effort', value }, 'unsupported_value')
  }
})

test('Ultra Code is refused with the proposal\'s own sentence', async () => {
  const r = rig()
  const out = await r.control.handle({ op: 'set_effort', value: 'ultracode' })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.code, 'ultracode_unconfirmable')
  assert.equal(out.message, 'This host cannot confirm Ultra Code remotely.')
  assert.equal(r.pane.sendKeys.length, 0)
})

test('no terminal, no bound session, no status source, a stale status source', async () => {
  await refused((r) => { r.state.target = null }, { op: 'set_model', value: 'sonnet' }, 'no_terminal')
  await refused((r) => { r.state.sessionId = null }, { op: 'set_model', value: 'sonnet' }, 'session_unknown')
  await refused((r) => { r.pane.sessionId = 'some-other-session' }, { op: 'set_model', value: 'sonnet' }, 'no_status_source')
  await refused((r) => { r.clock.now += 60_000 }, { op: 'set_model', value: 'sonnet' }, 'stale_status')
})

test('a family the installed CLI does not name is not offered', async () => {
  await refused(() => {}, { op: 'set_model', value: 'haiku' }, 'not_in_catalog')
  const r = rig({ helpText: async () => null })
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'not_in_catalog')
})

test('an effort on a model that reports none is refused (it could never be confirmed)', async () => {
  await refused((r) => { r.pane.effort = null }, { op: 'set_effort', value: 'high' }, 'effort_unsupported')
})

test('a running turn, an unknown turn state, an open permission dialog, another injection', async () => {
  await refused((r) => { r.state.turn = 'live' }, { op: 'set_model', value: 'sonnet' }, 'busy_turn')
  await refused((r) => { r.state.turn = 'unknown' }, { op: 'set_model', value: 'sonnet' }, 'turn_unknown')
  await refused((r) => { r.state.dialogOpen = true }, { op: 'set_model', value: 'sonnet' }, 'dialog_open')
  await refused((r) => { r.state.otherBusy = true }, { op: 'set_model', value: 'sonnet' }, 'control_busy')
})

test('a lost pane, a dead pane, a pane in a tmux mode', async () => {
  await refused((r) => { r.pane.failDisplay = true }, { op: 'set_model', value: 'sonnet' }, 'pane_lost')
  await refused((r) => { r.pane.dead = true }, { op: 'set_model', value: 'sonnet' }, 'pane_lost')
  await refused((r) => { r.pane.inMode = true }, { op: 'set_model', value: 'sonnet' }, 'pane_in_mode')
})

test('a pane whose foreground is not the agent (a shell, a suspended CLI) is refused', async () => {
  await refused((r) => { r.pane.foregroundPgid = 700 }, { op: 'set_model', value: 'sonnet' }, 'pane_not_agent')
  await refused((r) => { r.pane.tty = '/dev/ttys099' }, { op: 'set_model', value: 'sonnet' }, 'pane_not_agent')
  await refused((r) => { r.pane.rootPid = 4242 }, { op: 'set_model', value: 'sonnet' }, 'pane_not_agent')
})

test('an occupied composer is refused and the owner\'s draft is left exactly as it was', async () => {
  const r = await refused((r) => { r.pane.composer = 'half a thought' }, { op: 'set_model', value: 'sonnet' }, 'composer_not_empty')
  assert.equal(r.pane.composer, 'half a thought')
  assertNoEscape(r.pane)
})

test('a screen with no recognisable composer is refused', async () => {
  const r = rig({
    exec: async (argv) => (argv.includes('capture-pane') ? 'Do you want to proceed?\n❯ 1. Yes\n  2. No' : r.pane.exec(argv)),
  })
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'composer_unknown')
  assert.equal(r.pane.sendKeys.length, 0)
})

test('a turn that starts while the pane is being checked stops the typing', async () => {
  const r = rig()
  r.control = new ModelEffortControl({
    ...(r.control as unknown as { deps: ControlDeps }).deps,
    ancestry: async () => {
      r.state.turn = 'live'
      return [
        { pid: 900, tty: 'ttys012', pgid: 800, tpgid: 800 },
        { pid: 800, tty: 'ttys012', pgid: 800, tpgid: 800 },
      ]
    },
  }, { confirmTimeoutMs: 10_000, pollMs: 250, staleMs: 15_000 })
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'busy_turn')
  assert.equal(r.pane.sendKeys.length, 0)
})

test('FALSE SUCCESS: echoed input is not confirmation; the literal left in the composer is said', async () => {
  const r = rig()
  r.pane.submits = false
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.code, 'not_confirmed')
  assert.match(out.message, /still in the agent's message box/)
  assert.equal(out.report!.model, 'claude-opus-5-5', 'the report is the truth, not the request')
  assert.deepEqual(typed(r.pane), ['/model sonnet', 'Enter'], 'typed once, never retried')
})

test('FALSE SUCCESS: status ticks that advance without the change do not confirm it', async () => {
  const r = rig()
  r.pane.applies = false
  r.pane.staleTicks = 0
  const out = await r.control.handle({ op: 'set_effort', value: 'max' })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.code, 'not_confirmed')
  assert.equal(out.report!.effort, 'high')
  assert.equal(r.pane.sendKeys.length, 2)
})

test('a slow status line still confirms within the window', async () => {
  const r = rig()
  r.pane.staleTicks = 5
  const out = await r.control.handle({ op: 'set_model', value: 'fable' })
  assert.equal(out.ok, true, JSON.stringify(out))
})

test('a session that changes during confirmation is reported, never claimed', async () => {
  const r = rig()
  let reads = 0
  r.control = new ModelEffortControl({
    ...(r.control as unknown as { deps: ControlDeps }).deps,
    sessionId: () => (reads++ > 3 ? 'a-new-session' : SID),
  }, { confirmTimeoutMs: 10_000, pollMs: 250, staleMs: 15_000 })
  r.pane.staleTicks = 50
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'session_changed')
})

test('a failed keystroke is reported once and never retried into an uncertain terminal', async () => {
  const r = rig()
  r.pane.failSendKeys = true
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'inject_failed')
  assert.equal(r.pane.sendKeys.length, 1)
  assert.equal(r.control.busy, false)
})

test('the control lock is exclusive: a second request while one is in flight is refused', async () => {
  const r = rig()
  r.pane.staleTicks = 3
  const first = r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(r.control.busy, true, 'held from the first await')
  const second = await r.control.handle({ op: 'set_effort', value: 'max' })
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.code, 'control_busy')
  const done = await first
  assert.equal(done.ok, true)
  assert.deepEqual(typed(r.pane), ['/model sonnet', 'Enter'], 'only the first request typed')
})

test('the outcome logs carry the code, never the screen', async () => {
  const r = rig()
  r.pane.composer = 'my secret draft'
  await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.ok(r.logs.some((l) => l.includes('composer_not_empty')))
  assert.ok(!r.logs.some((l) => l.includes('my secret draft')))
})
