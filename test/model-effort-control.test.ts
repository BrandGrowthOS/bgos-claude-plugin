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
/** A tmux session name, as a supervised agent's BGOS_TMUX_SESSION gives it. */
const SESSION_NAME = 'agent-session'

/** The tmux server and the Claude Code session behind one pane. */
class FakePane {
  composer = ''
  /** Where the CLI's cursor sits in the composer: null is at the end. */
  cursor: number | null = null
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
  /** Every tmux call, in order: its verb and the target it named. */
  calls: Array<{ verb: string; target: string }> = []
  /** The pane SESSION_NAME resolves to right now. */
  activePane = '%7'
  /** Keys that reached a pane other than the agent's. */
  otherPaneKeys: string[][] = []
  /** Something the owner, a human or the CLI does right after a tmux call. */
  after: ((what: 'display-message' | 'capture-pane' | 'literal') => void) | null = null
  /** The screen shows a menu or a question instead of the composer. */
  dialog = false
  failSendKeys = false
  failDisplay = false
  clock: { now: number }

  constructor(clock: { now: number }) {
    this.clock = clock
    this.observedAtMs = clock.now
  }

  screen(): string {
    if (this.dialog) return ['● ready', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'].join('\n')
    return ['● ready', RULE, `❯\u00a0${this.drawComposer()}`, RULE, '  ? for shortcuts'].join('\n')
  }

  /** As Claude Code 2.1.310 draws it (test/fixtures/claude-2.1.310-composer):
   *  the cursor an inverse cell, an empty composer's placeholder dim with the
   *  cursor on its first letter. */
  private drawComposer(): string {
    if (this.composer === '') return '\u001b[7mT\u001b[0;2mry "fix lint errors"\u001b[0m'
    const at = this.at()
    const under = this.composer[at] ?? ' '
    return `${this.composer.slice(0, at)}\u001b[7m${under}\u001b[0m${this.composer.slice(at + 1)}`
  }

  private at(): number {
    return this.cursor === null ? this.composer.length : Math.max(0, Math.min(this.cursor, this.composer.length))
  }

  /** What the owner's or the daemon's keys do, at the cursor. */
  private insert(text: string): void {
    const at = this.at()
    this.composer = this.composer.slice(0, at) + text + this.composer.slice(at)
    if (this.cursor !== null) this.cursor = at + text.length
  }

  async exec(argv: string[]): Promise<string> {
    const verb = argv.find((a) => a === 'display-message' || a === 'capture-pane' || a === 'send-keys')
    const named = argv[argv.indexOf('-t') + 1]!
    this.calls.push({ verb: verb ?? '', target: named })
    // tmux resolves a session name to its active pane on EVERY call.
    const paneId = named === SESSION_NAME ? this.activePane : named
    if (paneId !== '%7') return this.otherPane(verb, argv, paneId)
    if (verb === 'display-message') {
      if (this.failDisplay) throw new Error('no such pane')
      const out = `%7\t${this.tty}\t${this.dead ? 1 : 0}\t${this.inMode ? 1 : 0}\t${this.rootPid}\n`
      this.after?.('display-message')
      return out
    }
    if (verb === 'capture-pane') {
      const out = this.screen()
      this.after?.('capture-pane')
      return out
    }
    if (verb === 'send-keys') {
      this.sendKeys.push(argv)
      if (this.failSendKeys) throw new Error('send-keys failed')
      const key = argv.at(-1)!
      if (argv.includes('-l')) {
        this.insert(key)
        this.after?.('literal')
      } else if (key === 'BSpace') {
        const n = argv.filter((a) => a === 'BSpace').length
        const at = this.at()
        const from = Math.max(0, at - n)
        this.composer = this.composer.slice(0, from) + this.composer.slice(at)
        if (this.cursor !== null) this.cursor = from
      } else if (key === 'Enter' && this.submits) {
        const line = this.composer
        this.composer = ''
        this.cursor = null
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

  /** Another pane of the same tmux session: a shell the agent never ran in. */
  private otherPane(verb: string | undefined, argv: string[], paneId: string): string {
    if (verb === 'display-message') return `${paneId}\t/dev/ttys013\t0\t0\t5555\n`
    if (verb === 'capture-pane') return 'kc@mac ~ % '
    if (verb === 'send-keys') {
      this.otherPaneKeys.push(argv)
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

test('snapshot reports the proven session, its observation and the host catalog without typing', async () => {
  const { control, pane } = rig()
  const snap = await control.snapshot()
  assert.equal(snap.optedIn, true)
  assert.equal(snap.sessionId, SID)
  assert.equal(snap.observation?.modelId, 'claude-opus-5-5')
  assert.deepEqual(snap.catalog.models, ['fable', 'opus', 'sonnet'])
  assert.deepEqual(snap.catalog.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(pane.sendKeys.length, 0)
  assert.equal(pane.calls.length, 0, 'not even a pane read')
})

test('snapshot while not opted in says so, and still types nothing', async () => {
  const { control, state, pane } = rig()
  state.optedIn = false
  const snap = await control.snapshot()
  assert.equal(snap.optedIn, false)
  assert.equal(pane.sendKeys.length, 0)
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

// Security review M2 (REVIEW-275.md): a session name resolves to that
// session's active pane on every tmux call, so a pane proven through the name
// is not the pane a later call through the name reaches. The proof reads the
// pane's own id (%N) and every later read and key names that id.
test('M2: a session name target is proven once, then every read and key goes to the proven pane id', async () => {
  const r = rig()
  r.state.target = { target: SESSION_NAME, socketArgs: ['-L', 'fake'], source: 'env-session' }
  // A human attached to the session opens another window right after the
  // control read the agent's screen: the name now resolves to a shell.
  r.pane.after = (what) => {
    if (what === 'capture-pane') r.pane.activePane = '%9'
  }
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.deepEqual(r.pane.otherPaneKeys, [], 'keys typed into a pane that was never proven')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(typed(r.pane), ['/model sonnet', 'Enter'])
  const [proof, ...later] = r.pane.calls
  assert.deepEqual(proof, { verb: 'display-message', target: SESSION_NAME }, 'the id is read through the configured target')
  assert.ok(later.length > 0)
  for (const call of later) assert.equal(call.target, '%7', `${call.verb} named ${call.target}`)
})

test('M2: the window switching before the screen read reads and types the proven pane only', async () => {
  const r = rig()
  r.state.target = { target: SESSION_NAME, socketArgs: ['-L', 'fake'], source: 'env-session' }
  r.pane.after = (what) => {
    if (what === 'display-message') r.pane.activePane = '%9'
  }
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.deepEqual(r.pane.otherPaneKeys, [])
  assert.equal(out.ok, true, JSON.stringify(out))
})

// Security review L5 (REVIEW-275.md): the Enter used to follow the literal
// 400 ms later with nothing read in between, so a key pressed or a dialog
// opened in that gap was submitted with it. Now the composer is read again and
// must hold EXACTLY the literal, else what was typed is cleared (only where
// that is certain) and the request refused, with no Enter.
test('L5: the composer is read again between the literal and the Enter', async () => {
  const r = rig()
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const at = r.pane.calls.findIndex((c) => c.verb === 'send-keys')
  const order = r.pane.calls.slice(at).map((c) => c.verb)
  assert.deepEqual(order.slice(0, 3), ['send-keys', 'capture-pane', 'send-keys'], JSON.stringify(order))
})

test('L5: an owner key that lands before the literal is cleared off it, never submitted', async () => {
  const r = rig()
  r.pane.after = (what) => {
    if (what === 'literal') r.pane.composer = 'q' + r.pane.composer
  }
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false, JSON.stringify(out))
  if (out.ok) return
  assert.equal(out.code, 'composer_changed')
  assert.match(out.message, /cleared/)
  assert.ok(!typed(r.pane).includes('Enter'), 'no Enter after a composer that changed')
  assert.equal(r.pane.composer, 'q', 'the owner\'s key is left, the literal is gone')
  assertNoEscape(r.pane)
})

test('L5: an owner key that lands after the literal is left as it is, never submitted', async () => {
  const r = rig()
  r.pane.after = (what) => {
    if (what === 'literal') r.pane.composer += 'k'
  }
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false, JSON.stringify(out))
  if (out.ok) return
  assert.equal(out.code, 'composer_changed')
  assert.match(out.message, /still in the agent's message box/)
  assert.deepEqual(typed(r.pane), ['/model sonnet'], 'no Enter, and no key that would eat the owner\'s')
  assert.equal(r.pane.composer, '/model sonnetk')
})

test('L5: a dialog that opens in the gap gets no Enter and no other key', async () => {
  const r = rig()
  r.pane.after = (what) => {
    if (what === 'literal') r.pane.dialog = true
  }
  const out = await r.control.handle({ op: 'set_effort', value: 'max' })
  assert.equal(out.ok, false, JSON.stringify(out))
  if (out.ok) return
  assert.equal(out.code, 'composer_changed')
  assert.deepEqual(typed(r.pane), ['/effort max'])
  assert.doesNotMatch(out.message, /[\u2013\u2014]/u)
  assert.ok(out.message.length <= 300)
})

// Round 2 on PR #275, Low 1: the clear sent one BSpace per character of the
// command wherever the cursor was. An arrow key the owner pressed in the
// 400 ms gap moved it, and the BSpaces deleted the owner's characters. Now the
// screen is read again and the BSpaces go only when the cursor is drawn right
// after the command at the end of the composer; otherwise nothing is sent.
test('L1: an arrow key in the gap: nothing of the owner\'s is deleted, no BSpace, no Enter', async () => {
  const r = rig()
  r.pane.after = (what) => {
    if (what !== 'literal') return
    // The owner's key lands before the command, then they press Left twice.
    r.pane.composer = 'q' + r.pane.composer
    r.pane.cursor = r.pane.composer.length - 2
  }
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false, JSON.stringify(out))
  if (out.ok) return
  assert.equal(out.code, 'composer_changed')
  assert.equal(r.pane.composer, 'q/model sonnet', 'the owner\'s key and the command are left as they are')
  assert.deepEqual(typed(r.pane), ['/model sonnet'], 'no BSpace and no Enter')
  assert.match(out.message, /still in the agent's message box/)
  assertNoEscape(r.pane)
})

test('L1: the cursor moved to the start: nothing is deleted', async () => {
  const r = rig()
  r.pane.after = (what) => {
    if (what !== 'literal') return
    r.pane.composer = 'q' + r.pane.composer
    r.pane.cursor = 1
  }
  const out = await r.control.handle({ op: 'set_effort', value: 'max' })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(r.pane.composer, 'q/effort max')
  assert.deepEqual(typed(r.pane), ['/effort max'])
})

test('L1: the cursor moved between the check and the clear is caught by a fresh read right before it', async () => {
  const r = rig()
  let reads = 0
  r.pane.after = (what) => {
    if (what === 'literal') r.pane.composer = 'q' + r.pane.composer
    // The read between the literal and the Enter sees the cursor at the end;
    // the owner presses Left right after it.
    if (what === 'capture-pane' && ++reads === 2) r.pane.cursor = r.pane.composer.length - 1
  }
  const out = await r.control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(r.pane.composer, 'q/model sonnet')
  assert.deepEqual(typed(r.pane), ['/model sonnet'])
})

// ── apply: the BGOS picker's one selection, { sessionId, model, effort } ─────
// One lock across both steps (a delivery, compact, goal typing or a steer
// never lands between the model and the effort), each step the same checked
// transaction as above, and one deadline for the whole answer.

const SELECT = { sessionId: SID, model: 'sonnet', effort: 'xhigh' }

test('apply switches the model, then the effort, each confirmed, under one lock', async () => {
  const { control, pane, clock } = rig()
  const busyAt: boolean[] = []
  pane.after = () => busyAt.push(control.busy)
  const out = await control.apply(SELECT, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, true, JSON.stringify(out))
  if (!out.ok) return
  assert.equal(out.applied, true)
  assert.deepEqual(typed(pane), ['/model sonnet', 'Enter', '/effort xhigh', 'Enter'])
  assert.equal(out.report.model, 'claude-sonnet-5-5')
  assert.equal(out.report.effort, 'xhigh')
  assert.ok(busyAt.length > 4 && busyAt.every(Boolean), 'the lock is held through both steps')
  assert.equal(control.busy, false, 'and released after')
  assertNoEscape(pane)
})

test('apply with the model already running types only the effort', async () => {
  const { control, pane, clock } = rig()
  const out = await control.apply({ ...SELECT, model: 'opus' }, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(typed(pane), ['/effort xhigh', 'Enter'])
})

test('apply with the effort already running types only the model', async () => {
  const { control, pane, clock } = rig()
  const out = await control.apply({ ...SELECT, effort: 'high' }, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(typed(pane), ['/model sonnet', 'Enter'])
})

test('apply of what already runs types nothing and says it applied nothing', async () => {
  const { control, pane, clock } = rig()
  const out = await control.apply({ ...SELECT, model: 'opus', effort: 'high' }, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, true)
  if (out.ok) assert.equal(out.applied, false)
  assert.equal(pane.sendKeys.length, 0)
})

test('apply for a session the picker read before a restart is refused: open the picker again', async () => {
  const { control, pane, clock } = rig()
  const out = await control.apply({ ...SELECT, sessionId: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'session_mismatch')
  assert.equal(pane.sendKeys.length, 0)
  assert.equal(pane.calls.length, 0)
})

test('apply refuses Ultra Code, a value off the frozen tables and a model it cannot type', async () => {
  for (const [selection, code] of [
    [{ ...SELECT, effort: 'ultracode' }, 'ultracode_unconfirmable'],
    [{ ...SELECT, effort: '/effort max' }, 'unsupported_value'],
    [{ ...SELECT, effort: 'constructor' }, 'unsupported_value'],
    [{ ...SELECT, model: 'claude-sonnet-5-5' }, 'unsupported_value'],
    [{ ...SELECT, model: 'sonnet; /goal x' }, 'unsupported_value'],
    [{ ...SELECT, model: '__proto__' }, 'unsupported_value'],
  ] as const) {
    const { control, pane, clock } = rig()
    const out = await control.apply(selection, { deadlineAtMs: clock.now + 15_000 })
    assert.equal(out.ok, false, JSON.stringify(selection))
    if (!out.ok) assert.equal(out.code, code, JSON.stringify(selection))
    assert.equal(pane.sendKeys.length, 0, JSON.stringify(selection))
    assert.equal(control.busy, false)
  }
})

test('apply on a model outside the frozen table may change the effort by naming that model', async () => {
  const { control, pane, clock } = rig()
  pane.model = 'claude-mythic-9'
  const out = await control.apply({ ...SELECT, model: 'claude-mythic-9' }, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(typed(pane), ['/effort xhigh', 'Enter'])
})

test('apply checks every precondition again before the effort step: a turn that starts after the model is refused', async () => {
  const { control, pane, state, clock } = rig({})
  const read = pane.observation.bind(pane)
  control.deps.readObservation = (sid) => {
    const o = read(sid)
    if (o?.modelId === 'claude-sonnet-5-5') state.turn = 'live'
    return o
  }
  const out = await control.apply(SELECT, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.code, 'busy_turn')
  assert.deepEqual(typed(pane), ['/model sonnet', 'Enter'], 'no effort typed into a live turn')
  assert.equal(out.report?.model, 'claude-sonnet-5-5', 'the answer carries what really runs now')
})

test('apply onto a model that reports no effort stops after the model and says so', async () => {
  const { control, pane, clock } = rig()
  const read = pane.observation.bind(pane)
  control.deps.readObservation = (sid) => {
    const o = read(sid)
    return o && o.modelId === 'claude-sonnet-5-5' ? { ...o, effort: null } : o
  }
  const out = await control.apply(SELECT, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'effort_unsupported')
  assert.deepEqual(typed(pane), ['/model sonnet', 'Enter'])
})

test('apply waits for confirmation no longer than its deadline', async () => {
  const { control, pane, clock } = rig()
  pane.applies = false
  const start = clock.now
  const out = await control.apply(SELECT, { deadlineAtMs: start + 3_000 })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'not_confirmed')
  assert.ok(clock.now - start <= 3_000 + 1_000, `waited ${clock.now - start} ms`)
  assert.deepEqual(typed(pane), ['/model sonnet', 'Enter'], 'nothing typed after an unconfirmed step')
})

test('apply does not start the effort step without the time to confirm it', async () => {
  const { control, pane, clock } = rig()
  pane.staleTicks = 8
  const out = await control.apply(SELECT, { deadlineAtMs: clock.now + 3_500 })
  assert.equal(out.ok, false, JSON.stringify(out))
  if (out.ok) return
  assert.equal(out.code, 'out_of_time')
  assert.deepEqual(typed(pane), ['/model sonnet', 'Enter'])
  assert.equal(out.report?.model, 'claude-sonnet-5-5')
})

test('apply is refused while another change holds the lock, and while compact or a steer types', async () => {
  const { control, state, pane, clock } = rig()
  state.otherBusy = true
  const out = await control.apply(SELECT, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'control_busy')
  state.otherBusy = false
  pane.staleTicks = 3
  const first = control.apply(SELECT, { deadlineAtMs: clock.now + 15_000 })
  const second = await control.apply({ ...SELECT, effort: 'low' }, { deadlineAtMs: clock.now + 15_000 })
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.code, 'control_busy')
  assert.equal((await first).ok, true)
})
