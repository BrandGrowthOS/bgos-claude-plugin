/**
 * The restart route of the owner's model picker (lib/model-effort-restart.ts
 * and ModelEffortControl.apply): an agent with no tmux pane, Windows included,
 * is switched by a restart of that one agent through the Helper's launcher,
 * which relaunches its pinned session with --model and --effort
 * (lib/launch-choice.mjs, bin/hoai-core.mjs).
 *
 * Every effect is a fake: the files, the launcher, the marker, the timers,
 * the status line, the transcript and the clock. Nothing is restarted.
 *
 * Run: npx tsx --test test/model-effort-restart.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ModelEffortControl, REFUSAL_MESSAGES, type ControlDeps } from '../lib/model-effort-control.ts'
import {
  RESTART_DELAY_MS,
  RESTART_WATCH_MS,
  SWITCH_CONFIRM_MS,
  SWITCH_PENDING_MAX_MS,
  SWITCH_START_MAX_MS,
  finishPendingSwitch,
  modelMeets,
  switchPendingNow,
  type RestartRouteDeps,
} from '../lib/model-effort-restart.ts'
import { parseLaunchChoice, parseModelSwitch } from '../lib/launch-choice.mjs'
import type { ModelObservation } from '../lib/model-control-store.mjs'

const HELP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-help-2.1.309.txt'), 'utf8')
const SID = 'b1f3c0de-0000-4000-8000-0000c0ffee01'
const STATE = join('home', '.bgos-agent', '888')
const CHOICE = join(STATE, 'launch-choice.json')
const SWITCH = join(STATE, 'model-switch.json')
const T0 = 1_800_000_000_000

function rig(o: { choice?: string; target?: boolean; declared?: boolean; proven?: boolean; turn?: 'idle' | 'live' | 'unknown' } = {}) {
  const clock = { now: T0 }
  const files = new Map<string, string>()
  if (o.choice) files.set(CHOICE, o.choice)
  const obs: { model: string; effort: string | null; seq: number; at: number; sessionId: string } = {
    model: 'claude-opus-5-5',
    effort: 'high',
    seq: 7,
    at: T0,
    sessionId: SID,
  }
  const timers: { fn: () => void; ms: number; fired: boolean }[] = []
  const calls = { restart: 0, drain: [] as boolean[], notes: [] as { chatId: string; text: string }[], asks: [] as string[] }
  const state = {
    declared: o.declared ?? true,
    proven: o.proven ?? true,
    turn: o.turn ?? 'idle',
    sessionId: SID as string | null,
    restartOk: true,
    restartAsked: true,
    /** The model names the installed CLI's own file carries. */
    cliNames: new Set(['claude-opus-6']) as ReadonlySet<string> | null,
  }
  /** The session's transcript lines not read yet. */
  const transcript: string[] = []
  const restart: RestartRouteDeps = {
    stateDir: STATE,
    launcherDeclared: () => state.declared,
    launcherProven: async () => state.proven,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, text) => {
      files.set(p, text)
    },
    removeFile: (p) => {
      files.delete(p)
    },
    requestRestart: async () => {
      calls.restart++
      return state.restartAsked
    },
    drain: (on) => {
      calls.drain.push(on)
    },
    note: (chatId, text) => {
      calls.notes.push({ chatId, text })
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, fired: false })
    },
  }
  const observation = (sid: string): ModelObservation | null =>
    sid === obs.sessionId
      ? { sessionId: sid, modelId: obs.model, modelDisplayName: null, effort: obs.effort, version: '2.1.330', seq: obs.seq, observedAtMs: obs.at }
      : null
  const deps: ControlDeps = {
    optedIn: () => true,
    target: () => (o.target ? { socketArgs: [], target: '%1' } as never : null),
    sessionId: () => state.sessionId,
    turnState: () => state.turn,
    dialogOpen: () => false,
    otherInjectionBusy: () => false,
    ancestry: async () => [],
    readObservation: observation,
    cliModelNames: () => state.cliNames,
    helpText: async () => HELP,
    exec: async (argv) => {
      throw new Error(`no command is ever run on the restart route: ${argv.join(' ')}`)
    },
    sleep: async (ms) => {
      clock.now += ms
    },
    now: () => clock.now,
    log: () => {},
    restart,
  }
  const control = new ModelEffortControl(deps, { staleMs: 15_000 })
  /** Runs that timer as it would run, then lets what it started settle. */
  const fire = async (ms: number) => {
    const t = timers.find((x) => x.ms === ms && !x.fired)
    assert.ok(t, `a ${ms} ms timer is armed`)
    t.fired = true
    clock.now += ms
    t.fn()
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  return { control, files, obs, timers, calls, state, clock, fire, restart, observation, transcript }
}

/** One assistant entry of the session's transcript, as Claude Code writes it. */
function reply(o: { at: number; model?: string; error?: string; sidechain?: boolean }): string {
  const entry = o.error
    ? { type: 'assistant', isSidechain: false, isApiErrorMessage: true, error: o.error, timestamp: new Date(o.at).toISOString(), message: { model: '<synthetic>', role: 'assistant' } }
    : { type: 'assistant', isSidechain: o.sidechain ?? false, timestamp: new Date(o.at).toISOString(), message: { model: o.model, role: 'assistant' } }
  return `${JSON.stringify(entry)}\n`
}

const PICK = { sessionId: SID, model: 'claude-sonnet-5-5', effort: 'low' }
const apply = (r: ReturnType<typeof rig>, sel = PICK, opts: { restartOk?: boolean; serverModels?: string[] } = {}) =>
  r.control.apply(sel, { deadlineAtMs: r.clock.now + 15_000, chatId: '4821', restartOk: opts.restartOk ?? true, serverModels: opts.serverModels })

test('no pane and no launcher that reads the choice is still no_terminal, and nothing is written', async () => {
  const r = rig({ declared: false })
  const out = await apply(r)
  assert.equal(out.ok, false)
  assert.equal(out.ok === false && out.code, 'no_terminal')
  assert.equal(r.files.size, 0)
})

test('a backend or app that does not know the restarting answer keeps no_terminal', async () => {
  const r = rig()
  const out = await apply(r, PICK, { restartOk: false })
  assert.equal(out.ok === false && out.code, 'no_terminal')
  assert.equal(r.files.size, 0)
})

test('a launcher the process table does not prove our own is no_terminal', async () => {
  const r = rig({ proven: false })
  const out = await apply(r)
  assert.equal(out.ok === false && out.code, 'no_terminal')
  assert.equal(r.files.size, 0)
  assert.equal(r.control.busy, false)
})

test('a working agent is never restarted', async () => {
  const r = rig({ turn: 'live' })
  const out = await apply(r)
  assert.equal(out.ok === false && out.code, 'busy_turn')
  assert.equal(r.files.size, 0)
  assert.equal(r.timers.length, 0)
})

// The launcher proof reads the process table, slow on a busy Windows host. A proof that runs past
// the apply deadline must restart nothing: BGOS has already answered the app that it did not answer
// in time.
// An effort only change must not send the picker's choice, the family alias, as the launch model:
// `--model opus` could start another Opus than the one running, and pin it for good.
test('an effort only change keeps the exact model the agent runs, never its family alias', async () => {
  const r = rig()
  const out = await apply(r, { sessionId: SID, model: 'opus', effort: 'low' })
  assert.deepEqual(out.ok && out.restarting, { model: 'opus', effort: 'low' }, 'the answer echoes the pick')
  assert.deepEqual(parseLaunchChoice(r.files.get(CHOICE) ?? null), { model: 'claude-opus-5-5', effort: 'low' })
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.target.model, 'claude-opus-5-5')
})

// The daemon that comes back after the restart holds no lock, so without this an apply from another
// device could overwrite the switch still waiting for its confirmation.
test('an apply while a switch is still pending is busy, and the pending switch is untouched', async () => {
  const r = rig()
  r.files.set(SWITCH, pending({ requestedAtMs: T0, launchedAtMs: T0 }))
  const out = await apply(r)
  assert.equal(out.ok === false && out.code, 'switch_pending')
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.state, 'pending')
  assert.equal(r.files.has(CHOICE), false)
})

test('a launcher proof that runs past the deadline restarts nothing and answers out of time', async () => {
  const r = rig()
  r.restart.launcherProven = async () => {
    r.clock.now += 15_000
    return true
  }
  const out = await apply(r)
  assert.equal(out.ok === false && out.code, 'out_of_time')
  assert.equal(r.files.size, 0, 'no switch and no choice written')
  assert.equal(r.timers.length, 0)
  assert.equal(r.control.busy, false, 'the lock is open again')
})

test('an idle agent is answered restarting, both files are written, and the restart waits for the answer to go out', async () => {
  const r = rig()
  const out = await apply(r)
  assert.equal(out.ok, true)
  assert.ok(out.ok && out.restarting, 'restarting')
  assert.deepEqual(out.ok && out.restarting, { model: 'claude-sonnet-5-5', effort: 'low' })
  assert.deepEqual(parseLaunchChoice(r.files.get(CHOICE) ?? null), { model: 'claude-sonnet-5-5', effort: 'low' })
  const sw = parseModelSwitch(r.files.get(SWITCH) ?? null)
  assert.equal(sw?.state, 'pending')
  assert.equal(sw?.sessionId, SID)
  assert.equal(sw?.chatId, '4821')
  assert.equal(sw?.previous, null)
  assert.deepEqual(sw?.from, { model: 'claude-opus-5-5', effort: 'high' })
  assert.equal(r.calls.restart, 0, 'not before the answer')
  assert.equal(r.control.busy, true, 'the lock stays held: no card may open a turn in a session about to restart')
  await r.fire(RESTART_DELAY_MS)
  assert.equal(r.calls.restart, 1)
  assert.deepEqual(r.calls.drain, [true])
  assert.equal(r.control.busy, true)
})

test('the previous choice is kept in the switch record', async () => {
  const r = rig({ choice: JSON.stringify({ version: 1, model: 'opus', effort: 'high' }) })
  await apply(r)
  assert.deepEqual(parseModelSwitch(r.files.get(SWITCH) ?? null)?.previous, { model: 'opus', effort: 'high' })
})

test('a launcher that never restarts the agent: the previous choice comes back, the switch fails, the chat is told, the lock opens', async () => {
  const r = rig({ choice: JSON.stringify({ version: 1, model: 'opus', effort: 'high' }) })
  await apply(r)
  await r.fire(RESTART_DELAY_MS)
  await r.fire(RESTART_WATCH_MS)
  assert.deepEqual(parseLaunchChoice(r.files.get(CHOICE) ?? null), { model: 'opus', effort: 'high' })
  const sw = parseModelSwitch(r.files.get(SWITCH) ?? null)
  assert.equal(sw?.state, 'failed')
  assert.equal(sw?.reason, 'not_restarted')
  assert.equal(sw?.noted, true)
  assert.deepEqual(r.calls.drain, [true, false])
  assert.equal(r.calls.notes.length, 1)
  assert.equal(r.calls.notes[0]!.chatId, '4821')
  assert.match(r.calls.notes[0]!.text, /^Could not switch to claude-sonnet-5-5\. The agent was not restarted, so it stays on claude-opus-5-5\.$/)
  assert.equal(r.control.busy, false)
})

test('a marker that could not be written fails at once, the same way', async () => {
  const r = rig()
  r.restart.requestRestart = async () => false
  await apply(r)
  await r.fire(RESTART_DELAY_MS)
  assert.equal(r.files.has(CHOICE), false, 'no previous choice: the file is removed')
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.state, 'failed')
  assert.equal(r.control.busy, false)
  assert.deepEqual(r.calls.drain, [])
})

test('the model and effort already running: ok, nothing restarted', async () => {
  const r = rig()
  const out = await apply(r, { sessionId: SID, model: 'claude-opus-5-5', effort: 'high' })
  assert.equal(out.ok, true)
  assert.equal(out.ok && out.applied, false)
  assert.equal(out.ok && out.restarting, undefined)
  assert.equal(r.files.size, 0)
  assert.equal(r.control.busy, false)
})

test('an id outside the CLI catalog is refused unless the server catalog names it, and junk never passes', async () => {
  const r = rig()
  const out = await apply(r, { sessionId: SID, model: 'claude-opus-6', effort: 'high' })
  assert.equal(out.ok, false)
  assert.equal(r.files.size, 0)
  const r2 = rig()
  const ok = await apply(r2, { sessionId: SID, model: 'claude-opus-6', effort: 'high' }, { serverModels: ['claude-opus-6'] })
  assert.ok(ok.ok && ok.restarting)
  assert.equal(parseLaunchChoice(r2.files.get(CHOICE) ?? null)?.model, 'claude-opus-6')
  const r3 = rig()
  const bad = await apply(r3, { sessionId: SID, model: 'claude-x&calc', effort: 'high' }, { serverModels: ['claude-x&calc'] })
  assert.equal(bad.ok, false)
  assert.equal(r3.files.size, 0)
})

test('a server id the installed CLI does not name is refused, and never listed, even when the server names it', async () => {
  for (const names of [new Set<string>(), null]) {
    const r = rig()
    r.state.cliNames = names
    const out = await apply(r, { sessionId: SID, model: 'claude-opus-6', effort: 'high' }, { serverModels: ['claude-opus-6'] })
    assert.equal(out.ok === false && out.code, 'unsupported_value')
    assert.equal(r.files.size, 0, 'nothing written, nothing restarted')
    const snap = await r.control.snapshot({ serverModels: ['claude-opus-6'] })
    assert.equal(snap.catalog.models.includes('claude-opus-6'), false)
  }
})

test('the server catalog never reaches the typing route', async () => {
  const r = rig({ target: true })
  const out = await apply(r, { sessionId: SID, model: 'claude-opus-6', effort: 'high' }, { serverModels: ['claude-opus-6'] })
  assert.equal(out.ok, false)
  assert.equal(r.files.size, 0)
})

test('ultracode is never a launch choice', async () => {
  const r = rig()
  const out = await apply(r, { sessionId: SID, model: 'claude-sonnet-5-5', effort: 'ultracode' })
  assert.equal(out.ok === false && out.code, 'ultracode_unconfirmable')
})

test('a second apply while the restart is in flight is busy', async () => {
  const r = rig()
  await apply(r)
  const again = await apply(r)
  assert.equal(again.ok === false && again.code, 'control_busy')
})

test('the list reads the switch as pending while it is in flight, and not once it is old', async () => {
  const r = rig()
  await apply(r)
  assert.equal(switchPendingNow(r.restart, r.clock.now), true)
  assert.equal(switchPendingNow(r.restart, r.clock.now + SWITCH_PENDING_MAX_MS), false)
  const snap = await r.control.snapshot()
  assert.equal(snap.switchPending, true)
})

test('the refusals added for the restart route are plain and dash free', () => {
  for (const code of ['restart_failed', 'switch_pending'] as const) {
    const text = REFUSAL_MESSAGES[code]
    assert.ok(text && text.length <= 300)
    assert.doesNotMatch(text, /[\u2013\u2014]/)
  }
})

// -- the daemon that comes back -----------------------------------------------------------------

function pending(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    state: 'pending',
    target: { model: 'claude-sonnet-5-5', effort: 'low' },
    previous: { model: 'opus', effort: 'high' },
    from: { model: 'claude-opus-5-5', effort: 'high' },
    sessionId: SID,
    chatId: '4821',
    requestedAtMs: T0,
    launchedAtMs: T0 + 3_000,
    reason: null,
    noted: false,
    ...over,
  })
}

const finish = (r: ReturnType<typeof rig>) =>
  finishPendingSwitch({
    deps: r.restart,
    sessionId: () => r.state.sessionId,
    readObservation: r.observation,
    readTranscript: () => r.transcript.splice(0).join(''),
    askForReply: (chatId) => {
      r.calls.asks.push(chatId)
    },
    now: () => r.clock.now,
    sleep: async (ms) => {
      r.clock.now += ms
    },
    log: () => {},
  })

test('the new session on the target model confirms the switch and tells the chat', async () => {
  const r = rig({ choice: JSON.stringify({ version: 1, model: 'claude-sonnet-5-5', effort: 'low' }) })
  r.files.set(SWITCH, pending())
  r.clock.now = T0 + 10_000
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: T0 + 9_000 })
  r.transcript.push(reply({ at: T0 + 9_500, model: 'claude-sonnet-5-5' }))
  assert.equal(await finish(r), 'confirmed')
  const sw = parseModelSwitch(r.files.get(SWITCH) ?? null)
  assert.equal(sw?.state, 'confirmed')
  assert.equal(sw?.noted, true)
  assert.deepEqual(r.calls.notes, [{ chatId: '4821', text: 'Switched to claude-sonnet-5-5, effort Low.' }])
  assert.deepEqual(parseLaunchChoice(r.files.get(CHOICE) ?? null), { model: 'claude-sonnet-5-5', effort: 'low' }, 'the choice stays')
})

test('a family alias confirms on any model of that family', async () => {
  const r = rig()
  r.files.set(SWITCH, pending({ target: { model: 'sonnet', effort: 'low' } }))
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: T0 + 9_000 })
  r.transcript.push(reply({ at: T0 + 9_500, model: 'claude-sonnet-5-5' }))
  assert.equal(await finish(r), 'confirmed')
  assert.equal(r.calls.notes[0]!.text, 'Switched to Sonnet, effort Low.')
})

test('a model that reports no effort confirms on the model alone', async () => {
  const r = rig()
  r.files.set(SWITCH, pending({ target: { model: 'claude-haiku-4-5', effort: 'low' } }))
  Object.assign(r.obs, { model: 'claude-haiku-4-5', effort: null, seq: 1, at: T0 + 9_000 })
  r.transcript.push(reply({ at: T0 + 9_500, model: 'claude-haiku-4-5' }))
  assert.equal(await finish(r), 'confirmed')
})

test('an observation from before the launch never confirms; the deadline takes the agent back to its previous choice', async () => {
  const r = rig({ choice: JSON.stringify({ version: 1, model: 'claude-sonnet-5-5', effort: 'low' }) })
  r.files.set(SWITCH, pending())
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 9, at: T0 + 1_000 })
  r.transcript.push(reply({ at: T0 + 9_500, model: 'claude-sonnet-5-5' }))
  assert.equal(await finish(r), 'restoring')
  assert.ok(r.clock.now >= T0 + 3_000 + SWITCH_CONFIRM_MS - 5_000, 'it waited for the deadline')
  const sw = parseModelSwitch(r.files.get(SWITCH) ?? null)
  assert.equal(sw?.state, 'restoring')
  assert.equal(sw?.reason, 'not_confirmed')
  assert.deepEqual(parseLaunchChoice(r.files.get(CHOICE) ?? null), { model: 'opus', effort: 'high' })
  assert.equal(r.calls.restart, 1, 'restarted back onto the previous choice')
  assert.equal(r.calls.notes.length, 0, 'the chat is told once the agent is back')
})

// The status line only repeats --model, so it proves the flag and not the model: a model the API
// refuses would read "Switched to X", then every turn would error and the choice would stick. Only
// a real reply on the new model confirms; a refusal or no reply goes back.
test('the API refuses the model: the agent goes back to its old model, and nothing says Switched to', async () => {
  const r = rig({ choice: JSON.stringify({ version: 1, model: 'claude-sonnet-5-5', effort: 'low' }) })
  r.files.set(SWITCH, pending())
  r.clock.now = T0 + 10_000
  // The status line repeats the flag: it reads the target model all the same.
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: T0 + 9_000 })
  r.transcript.push(reply({ at: T0 + 9_500, error: 'model_not_found' }))
  assert.equal(await finish(r), 'restoring')
  const sw = parseModelSwitch(r.files.get(SWITCH) ?? null)
  assert.equal(sw?.state, 'restoring')
  assert.equal(sw?.reason, 'model_refused')
  assert.deepEqual(parseLaunchChoice(r.files.get(CHOICE) ?? null), { model: 'opus', effort: 'high' }, 'the old choice is back')
  assert.equal(r.calls.restart, 1, 'the agent is restarted onto it')
  assert.deepEqual(r.calls.drain, [true])
  assert.equal(switchPendingNow(r.restart, r.clock.now), true, 'the picker stays busy: the session still reads the refused model')
  assert.equal((await r.control.snapshot()).switchPending, true)

  // The daemon that comes back from that restart: the launcher stamped it, the session reads the old model.
  r.files.set(SWITCH, JSON.stringify({ ...JSON.parse(r.files.get(SWITCH)!), launchedAtMs: T0 + 20_000 }))
  r.clock.now = T0 + 25_000
  Object.assign(r.obs, { model: 'claude-opus-5-5', effort: 'high', seq: 1, at: T0 + 24_000 })
  assert.equal(await finish(r), 'failed')
  const done = parseModelSwitch(r.files.get(SWITCH) ?? null)
  assert.equal(done?.state, 'failed')
  assert.equal(done?.noted, true)
  assert.equal(switchPendingNow(r.restart, r.clock.now), false)
  assert.deepEqual(r.calls.notes, [
    { chatId: '4821', text: 'Could not switch to claude-sonnet-5-5: the model was refused. The agent stays on claude-opus-5-5.' },
  ])
  assert.ok(r.calls.notes.every((n) => !/Switched to/.test(n.text)))
  assert.equal(await finish(r), null, 'told once')
})

test('the status line alone never confirms: with no reply on the new model the deadline takes the agent back', async () => {
  const r = rig({ choice: JSON.stringify({ version: 1, model: 'claude-sonnet-5-5', effort: 'low' }) })
  r.files.set(SWITCH, pending())
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: T0 + 9_000 })
  assert.equal(await finish(r), 'restoring')
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.reason, 'not_confirmed')
  assert.equal(r.calls.restart, 1)
  assert.ok(r.calls.notes.every((n) => !/Switched to/.test(n.text)))
})

test('a reply from before the launch, from a side chain or on another model never confirms', async () => {
  const r = rig()
  r.files.set(SWITCH, pending())
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: T0 + 9_000 })
  r.transcript.push(
    reply({ at: T0 + 1_000, model: 'claude-sonnet-5-5' }),
    reply({ at: T0 + 9_500, model: 'claude-sonnet-5-5', sidechain: true }),
    reply({ at: T0 + 9_600, model: 'claude-opus-5-5' }),
    '{ not json\n',
  )
  assert.equal(await finish(r), 'restoring')
})

// A reply may name its model by the dated snapshot: a session started with `--model
// claude-haiku-4-5` can answer as claude-haiku-4-5-20251001. That snapshot is the target; any
// other ending is not.
test('a reply on the dated snapshot of the target confirms, and nothing looser does', async () => {
  const r = rig()
  r.files.set(SWITCH, pending({ target: { model: 'claude-haiku-4-5', effort: 'low' } }))
  Object.assign(r.obs, { model: 'claude-haiku-4-5', effort: null, seq: 1, at: T0 + 9_000 })
  r.transcript.push(reply({ at: T0 + 9_500, model: 'claude-haiku-4-5-20251001' }))
  assert.equal(await finish(r), 'confirmed')
  assert.equal(r.calls.restart, 0)
  assert.equal(modelMeets('claude-haiku-4-5', 'claude-haiku-4-5-20251001'), true)
  assert.equal(modelMeets('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'), true)
  const notADate = `claude-haiku-4-5-${'1'.repeat(9)}`
  for (const [target, observed] of [
    ['claude-haiku-4-5', notADate],
    ['claude-haiku-4-5', 'claude-haiku-4-5-1'],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001x'],
    ['claude-haiku-4', 'claude-haiku-4-5'],
    ['claude-haiku-4', 'claude-haiku-4-5-20251001'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-haiku-4-5-20251001', `claude-haiku-4-5-20251001-${'1'.repeat(8)}`],
  ] as const) {
    assert.equal(modelMeets(target, observed), false, `${target} is not met by ${observed}`)
  }
})

test('a passing API error is no refusal: a later reply on the new model confirms', async () => {
  const r = rig()
  r.files.set(SWITCH, pending())
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: T0 + 9_000 })
  r.transcript.push(reply({ at: T0 + 9_500, error: 'rate_limit' }), reply({ at: T0 + 9_800, model: 'claude-sonnet-5-5' }))
  assert.equal(await finish(r), 'confirmed')
  assert.equal(r.calls.restart, 0)
})

test('the daemon asks the session for one reply, once, when the session is proven', async () => {
  const r = rig()
  r.files.set(SWITCH, pending())
  r.state.sessionId = null
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: T0 + 9_000 })
  let polls = 0
  const run = finishPendingSwitch({
    deps: r.restart,
    sessionId: () => r.state.sessionId,
    readObservation: r.observation,
    readTranscript: () => r.transcript.splice(0).join(''),
    askForReply: (chatId) => {
      r.calls.asks.push(chatId)
    },
    now: () => r.clock.now,
    sleep: async (ms) => {
      r.clock.now += ms
      polls++
      if (polls === 2) assert.deepEqual(r.calls.asks, [], 'not before the session is proven')
      if (polls === 3) r.state.sessionId = SID
      if (polls === 6) r.transcript.push(reply({ at: r.clock.now, model: 'claude-sonnet-5-5' }))
    },
    log: () => {},
  })
  assert.equal(await run, 'confirmed')
  assert.deepEqual(r.calls.asks, ['4821'])
})

test('a restore the launcher will not do: the chat is told, and the picker stays busy while the session reads the refused model', async () => {
  const r = rig()
  r.files.set(SWITCH, pending())
  r.state.restartAsked = false
  r.transcript.push(reply({ at: T0 + 9_500, error: 'model_not_found' }))
  assert.equal(await finish(r), 'restoring')
  const sw = parseModelSwitch(r.files.get(SWITCH) ?? null)
  assert.equal(sw?.state, 'restoring')
  assert.equal(sw?.noted, true)
  assert.deepEqual(r.calls.drain, [])
  assert.deepEqual(r.calls.notes, [
    { chatId: '4821', text: 'Could not switch to claude-sonnet-5-5: the model was refused. The agent could not be restarted, so it starts on claude-opus-5-5 next time.' },
  ])
  assert.equal(switchPendingNow(r.restart, r.clock.now), true)
  assert.equal(await finish(r), null, 'the next daemon says nothing more')
})

test('a restore the launcher never does in time opens intake again and tells the chat once', async () => {
  const r = rig()
  r.files.set(SWITCH, pending())
  r.transcript.push(reply({ at: T0 + 9_500, error: 'model_not_found' }))
  assert.equal(await finish(r), 'restoring')
  assert.equal(r.calls.notes.length, 0)
  await r.fire(RESTART_WATCH_MS)
  assert.deepEqual(r.calls.drain, [true, false])
  assert.equal(r.calls.notes.length, 1)
  // The restart was asked for and may still come: the words say it has not happened yet, not that it cannot.
  assert.equal(
    r.calls.notes[0]!.text,
    'Could not switch to claude-sonnet-5-5: the model was refused. The agent has not restarted yet, and starts on claude-opus-5-5 when it does.',
  )
  // A restart that comes later is the one the note named: the next daemon says nothing more.
  r.files.set(SWITCH, JSON.stringify({ ...JSON.parse(r.files.get(SWITCH)!), launchedAtMs: T0 + 90_000 }))
  assert.equal(await finish(r), null)
  assert.equal(r.calls.notes.length, 1)
})

test('the daemon after a restore that never reads the old model still tells the chat once', async () => {
  const r = rig()
  r.files.set(SWITCH, pending({ state: 'restoring', reason: 'not_confirmed', launchedAtMs: T0 + 20_000 }))
  Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: T0 + 24_000 })
  assert.equal(await finish(r), 'failed')
  assert.deepEqual(r.calls.notes, [
    { chatId: '4821', text: 'Could not switch to claude-sonnet-5-5: the agent did not answer on it in time. The agent was started again on claude-opus-5-5, and has not reported its model since.' },
  ])
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.noted, true)
})

// A cold start (a Windows boot) can take minutes before the session is up. The wait for its reply
// runs from the session being up, so a good model is not undone because the machine was slow.
test('a cold start: the session comes up after the confirm wait and its reply still confirms', async () => {
  const r = rig()
  r.files.set(SWITCH, pending())
  r.state.sessionId = null
  r.clock.now = T0 + 3_000
  const upAt = T0 + 3_000 + SWITCH_CONFIRM_MS + 30_000
  const run = finishPendingSwitch({
    deps: r.restart,
    sessionId: () => r.state.sessionId,
    readObservation: r.observation,
    readTranscript: () => r.transcript.splice(0).join(''),
    askForReply: (chatId) => {
      r.calls.asks.push(chatId)
    },
    now: () => r.clock.now,
    sleep: async (ms) => {
      r.clock.now += ms
      if (r.state.sessionId === null && r.clock.now >= upAt) {
        r.state.sessionId = SID
        Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: r.clock.now })
      }
      // The reply takes most of the wait the session has once it is up.
      if (r.calls.asks.length === 1 && r.transcript.length === 0 && r.clock.now >= upAt + SWITCH_CONFIRM_MS - 10_000) {
        r.transcript.push(reply({ at: r.clock.now, model: 'claude-sonnet-5-5' }))
      }
    },
    log: () => {},
  })
  assert.equal(await run, 'confirmed')
  assert.equal(r.calls.restart, 0, 'nothing undone')
  assert.equal(r.calls.notes[0]!.text, 'Switched to claude-sonnet-5-5, effort Low.')
})

test('a session that never comes up is taken back once the start wait is over, not before', async () => {
  const r = rig()
  r.files.set(SWITCH, pending())
  r.state.sessionId = null
  r.clock.now = T0 + 3_000
  assert.equal(await finish(r), 'restoring')
  assert.ok(r.clock.now >= T0 + 3_000 + SWITCH_START_MAX_MS, 'it waited the whole start wait')
  assert.ok(r.clock.now < T0 + 3_000 + SWITCH_START_MAX_MS + 5_000)
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.reason, 'not_confirmed')
  // The picker stays busy for the whole of it, and for the restart back after it.
  assert.ok(SWITCH_PENDING_MAX_MS >= 2 * (SWITCH_START_MAX_MS + SWITCH_CONFIRM_MS) + RESTART_WATCH_MS)
})

test('a slow start after the restart back still reads the old model, and the chat says it stays on it', async () => {
  const r = rig()
  const since = T0 + 20_000
  r.files.set(SWITCH, pending({ state: 'restoring', reason: 'model_refused', launchedAtMs: since }))
  r.state.sessionId = null
  r.clock.now = since
  const upAt = since + 200_000
  const run = finishPendingSwitch({
    deps: r.restart,
    sessionId: () => r.state.sessionId,
    readObservation: r.observation,
    readTranscript: () => '',
    askForReply: () => {},
    now: () => r.clock.now,
    sleep: async (ms) => {
      r.clock.now += ms
      if (r.state.sessionId === null && r.clock.now >= upAt) {
        r.state.sessionId = SID
        Object.assign(r.obs, { model: 'claude-sonnet-5-5', effort: 'low', seq: 1, at: r.clock.now })
      }
      // Its first status line on the old model comes 100 s after it is up.
      if (r.clock.now >= upAt + 100_000 && r.obs.model !== 'claude-opus-5-5') {
        Object.assign(r.obs, { model: 'claude-opus-5-5', effort: 'high', seq: 2, at: r.clock.now })
      }
    },
    log: () => {},
  })
  assert.equal(await run, 'failed')
  assert.deepEqual(r.calls.notes, [
    { chatId: '4821', text: 'Could not switch to claude-sonnet-5-5: the model was refused. The agent stays on claude-opus-5-5.' },
  ])
})

test('a different session is no confirmation', async () => {
  const r = rig()
  r.files.set(SWITCH, pending())
  r.state.sessionId = 'aaaaaaaa-0000-4000-8000-0000c0ffee02'
  assert.equal(await finish(r), 'failed')
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.reason, 'session_changed')
})

test('a pending switch the launcher never relaunched for fails as not restarted', async () => {
  const r = rig()
  r.files.set(SWITCH, pending({ launchedAtMs: null }))
  assert.equal(await finish(r), 'failed')
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.reason, 'not_restarted')
})

test('a start that failed in the launcher is told once in the chat', async () => {
  const r = rig()
  r.files.set(SWITCH, pending({ state: 'failed', reason: 'start_failed' }))
  assert.equal(await finish(r), 'failed')
  assert.match(r.calls.notes[0]!.text, /^Could not switch to claude-sonnet-5-5\. The agent did not start on it, so it was started again on the model it had\.$/)
  assert.equal(parseModelSwitch(r.files.get(SWITCH) ?? null)?.noted, true)
  r.calls.notes.length = 0
  assert.equal(await finish(r), null, 'told once')
  assert.equal(r.calls.notes.length, 0)
})

test('no switch, or one already finished, does nothing', async () => {
  const r = rig()
  assert.equal(await finish(r), null)
  r.files.set(SWITCH, pending({ state: 'confirmed', noted: true }))
  assert.equal(await finish(r), null)
  assert.equal(r.calls.notes.length, 0)
})
