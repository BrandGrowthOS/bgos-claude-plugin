/**
 * hoai-core starts an agent on its launch choice (lib/launch-choice.mjs): the
 * model and effort the owner picked in the app for an agent with no tmux pane,
 * Windows included. The daemon writes the choice and the restart marker; this
 * launcher relaunches the agent's OWN pinned session with `--model` and
 * `--effort`, and a relaunch that dies at once with them puts the previous
 * choice back and brings the same conversation back without them, before the
 * fresh session fallback could mint a new id.
 *
 * Every effect is a fake: claude (the cmd.exe of its npm shim), the gate
 * helper, the files and the clock. Nothing real is started or restarted.
 *
 * Run: npx tsx --test test/hoai-core.launch-choice.test.ts
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as core from '../bin/hoai-core.mjs'
import { parseLaunchChoice, parseModelSwitch } from '../lib/launch-choice.mjs'

const { FOLDER_PIN_FILE, RESTART_MARKER_FILE_NAME, SESSION_ID_FILE_NAME, sessionTranscriptPath, superviseClaude } = core

const HOME = 'C:\\Users\\mark'
const CWD = 'C:\\agents\\888'
const SCRIPT_DIR = 'C:\\Users\\mark\\.claude\\plugins\\cache\\hoai\\hoai\\0.91.0\\bin'
const COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
const STATE_DIR = `${HOME}\\.bgos-agent\\888`
const MARKER_PATH = `${STATE_DIR}\\${RESTART_MARKER_FILE_NAME}`
const PIN_PATH = `${STATE_DIR}\\${SESSION_ID_FILE_NAME}`
const CHOICE_PATH = `${STATE_DIR}\\launch-choice.json`
const SWITCH_PATH = `${STATE_DIR}\\model-switch.json`
const SUPERVISOR_PATH = `${STATE_DIR}\\supervisor.json`
const SUPERVISED = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '888', ComSpec: COMSPEC }
const BASE_ARGS = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'plugin:hoai@hoai']
const PIN = 'abcdabcd-abcd-4abc-8abc-abcdabcdabcd'
const FRESH = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
const HEALTHY_MS = 25_000
const T0 = Date.UTC(2026, 10, 21, 7, 0, 0)

class FakeProc extends EventEmitter {
  pid: number
  file: string
  spawnfile: string
  args: string[]
  ended = false
  constructor(pid: number, file: string, args: readonly string[]) {
    super()
    this.pid = pid
    this.file = file
    this.spawnfile = file
    this.args = [...args]
  }
  kill() {
    setImmediate(() => this.end(1, 'SIGTERM'))
    return true
  }
  end(code: number | null, signal: string | null) {
    if (this.ended) return
    this.ended = true
    this.emit('exit', code, signal)
  }
  exit(code: number) {
    this.end(code, null)
  }
}

class FakeHelper extends EventEmitter {
  pid: number
  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

function harness(files0: Record<string, string> = {}, o: { env?: Record<string, string>; keepAlive?: boolean } = {}) {
  const files = new Map<string, string>(Object.entries(files0))
  const claudes: FakeProc[] = []
  const helpers: FakeHelper[] = []
  const prints: string[] = []
  const clock = { now: T0 }
  const stop = new AbortController()
  const ids = [FRESH]
  let nextPid = 4184
  const procs = new Map<number, FakeProc>()
  const done = superviseClaude(BASE_ARGS, {
    platform: 'win32',
    env: o.env ?? SUPERVISED,
    home: HOME,
    cwd: CWD,
    scriptDir: SCRIPT_DIR,
    readFile: (p: string) => (p === `${CWD}\\${FOLDER_PIN_FILE}` ? '888' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: ((file: string, args: readonly string[]) => {
      const proc = new FakeProc(nextPid, file, args)
      nextPid += 4
      if (file !== COMSPEC) {
        setImmediate(() => proc.emit('error', Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })))
        return proc
      }
      procs.set(proc.pid, proc)
      claudes.push(proc)
      return proc
    }) as never,
    endProcessTree: (pid: number) => {
      const proc = procs.get(pid)
      if (proc) setImmediate(() => proc.end(1, null))
      return true
    },
    clearConsole: () => {},
    spawnGateHelper: () => {
      const helper = new FakeHelper(3000 + helpers.length)
      helpers.push(helper)
      return helper
    },
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    print: (line: string) => prints.push(line),
    now: () => clock.now,
    setTimer: (() => ({ unref() {} })) as never,
    clearTimer: (() => {}) as never,
    sleep: async () => {},
    pollMs: 5,
    healthyMs: HEALTHY_MS,
    keepAlive: o.keepAlive ?? true,
    signal: stop.signal,
    listProcesses: () => [],
    pidProcess: () => null,
    pidAlive: () => false,
    generateId: () => ids.shift() ?? FRESH,
  } as never)
  const end = async () => {
    stop.abort()
    return done
  }
  return { files, claudes, prints, clock, end, done }
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const launched = (h: ReturnType<typeof harness>, n: number) => waitUntil(() => h.claudes.length === n, `launch ${n}`)
const transcript = (id: string) => sessionTranscriptPath(HOME, CWD, id, '')
/** The claude argv after `/c claude.cmd`. */
const claudeArgs = (p: FakeProc) => p.args.slice(2)
const flagValue = (args: string[], flag: string) => {
  const at = args.indexOf(flag)
  return at < 0 ? null : args[at + 1] ?? null
}
const resumed = { [PIN_PATH]: PIN, [transcript(PIN)]: '{}\n' }
const choice = (model: string, effort: string | null) => JSON.stringify({ version: 1, model, effort })
const pendingSwitch = (previous: { model: string; effort: string | null } | null) => JSON.stringify({
  version: 1,
  state: 'pending',
  target: { model: 'claude-sonnet-5-5', effort: 'low' },
  previous,
  from: { model: 'claude-opus-5-5', effort: 'high' },
  sessionId: PIN,
  chatId: '4821',
  requestedAtMs: T0,
  launchedAtMs: null,
  reason: null,
  noted: false,
})

test('the first launch carries the launch choice, between the channel args and the session args', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('claude-sonnet-5-5', 'low') })
  await launched(h, 1)
  const args = claudeArgs(h.claudes[0]!)
  assert.equal(flagValue(args, '--model'), 'claude-sonnet-5-5')
  assert.equal(flagValue(args, '--effort'), 'low')
  assert.deepEqual(args.slice(-2), ['--resume', PIN], 'the session args stay last')
  assert.ok(args.indexOf('--model') > args.indexOf('plugin:hoai@hoai'), 'after the channel')
  await h.end()
})

test('a launch choice with no effort passes the model alone', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('haiku', null) })
  await launched(h, 1)
  const args = claudeArgs(h.claudes[0]!)
  assert.equal(flagValue(args, '--model'), 'haiku')
  assert.equal(args.includes('--effort'), false)
  await h.end()
})

test('a junk or hostile launch choice adds nothing', async () => {
  for (const junk of ['not json', choice('claude-x&calc', 'low'), choice('opus', 'ultracode'), choice('--dangerously', 'low')]) {
    const h = harness({ ...resumed, [CHOICE_PATH]: junk })
    await launched(h, 1)
    const args = claudeArgs(h.claudes[0]!)
    assert.equal(args.includes('--model'), false, junk)
    assert.equal(args.includes('--effort'), false, junk)
    await h.end()
  }
})

test('no launch choice is the launch of today', async () => {
  const h = harness(resumed)
  await launched(h, 1)
  assert.equal(claudeArgs(h.claudes[0]!).includes('--model'), false)
  await h.end()
})

test('supervisor.json says this launcher reads the launch choice', async () => {
  const h = harness(resumed)
  await launched(h, 1)
  const body = JSON.parse(h.files.get(SUPERVISOR_PATH) ?? '{}')
  assert.deepEqual(body.capabilities, ['relaunch', 'launch-choice'])
  await h.end()
})

test('a marker relaunch takes a choice written after the launch, keeps the pin, and records the launch on the pending switch', async () => {
  const h = harness(resumed)
  await launched(h, 1)
  assert.equal(claudeArgs(h.claudes[0]!).includes('--model'), false)
  // The daemon's restart route: the switch, the choice, then the marker.
  h.files.set(SWITCH_PATH, pendingSwitch(null))
  h.files.set(CHOICE_PATH, choice('claude-sonnet-5-5', 'low'))
  h.clock.now = T0 + 60_000
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  const args = claudeArgs(h.claudes[1]!)
  assert.equal(flagValue(args, '--model'), 'claude-sonnet-5-5')
  assert.equal(flagValue(args, '--effort'), 'low')
  assert.deepEqual(args.slice(-2), ['--resume', PIN], 'the same conversation')
  const sw = parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)
  assert.equal(sw?.state, 'pending')
  assert.equal(sw?.launchedAtMs, T0 + 60_000)
  await h.end()
})

test('a switch relaunch that dies at once puts the previous choice back and resumes the same pin without the new flags', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('opus', 'high') })
  await launched(h, 1)
  h.files.set(SWITCH_PATH, pendingSwitch({ model: 'opus', effort: 'high' }))
  h.files.set(CHOICE_PATH, choice('claude-sonnet-5-5', 'low'))
  h.clock.now = T0 + 60_000
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  // Dies inside the health window: the CLI refused the new model.
  h.claudes[1]!.exit(1)
  await launched(h, 3)
  const args = claudeArgs(h.claudes[2]!)
  assert.deepEqual(args.slice(-2), ['--resume', PIN], 'never a fresh session')
  assert.equal(flagValue(args, '--model'), 'opus', 'back on the previous choice')
  assert.equal(flagValue(args, '--effort'), 'high')
  assert.deepEqual(parseLaunchChoice(h.files.get(CHOICE_PATH) ?? null), { model: 'opus', effort: 'high' })
  const sw = parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)
  assert.equal(sw?.state, 'failed')
  assert.equal(sw?.reason, 'start_failed')
  assert.ok(h.prints.some((l) => /stays on the model it had/.test(l)), h.prints.join('\n'))
  await h.end()
})

// Every pick on an agent with no pane is a marker restart. The update marker budget (3 an hour, for
// a daemon stuck in an update loop) latches for good once spent, so a pick must never depend on it:
// a switch the owner asked for has a budget of its own on a rolling hour, which update markers
// never spend.
test('an owner can switch more than three times in an hour, even after the update budget is spent', async () => {
  const h = harness(resumed)
  try {
    await launched(h, 1)
    for (let i = 0; i < 3; i++) {
      h.clock.now = T0 + (i + 1) * 60_000
      h.files.set(MARKER_PATH, '{}')
      await launched(h, i + 2)
    }
    // The old update budget is unchanged: a fourth update marker in the hour is refused.
    h.clock.now = T0 + 5 * 60_000
    h.files.set(MARKER_PATH, '{}')
    await waitUntil(() => h.prints.some((l) => /restart marker ignored/.test(l)), 'the update budget')
    assert.equal(h.claudes.length, 4)
    const picks: Array<[string, string | null]> = [
      ['claude-sonnet-5-5', 'low'],
      ['claude-opus-5-5', 'high'],
      ['claude-haiku-5-5', null],
      ['claude-sonnet-5-5', 'high'],
    ]
    for (const [i, [model, effort]] of picks.entries()) {
      h.clock.now = T0 + (10 + i) * 60_000
      h.files.set(SWITCH_PATH, JSON.stringify({ ...JSON.parse(pendingSwitch(null)), target: { model, effort }, requestedAtMs: h.clock.now }))
      h.files.set(CHOICE_PATH, choice(model, effort))
      h.files.set(MARKER_PATH, '{}')
      await launched(h, 5 + i)
      assert.equal(flagValue(claudeArgs(h.claudes[4 + i]!), '--model'), model, `pick ${i + 1}`)
    }
  } finally {
    await h.end()
  }
})

// A model the API refuses takes the agent back to its previous choice by a
// second restart. That restart is part of the switch the owner asked for: it spends the switch
// budget, and it is stamped on the record, so the daemon that comes back reads its own launch.
test('a restore restart after a refused model spends the switch budget and is stamped on its record', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('opus', 'high') })
  try {
    await launched(h, 1)
    for (let i = 0; i < 3; i++) {
      h.clock.now = T0 + (i + 1) * 60_000
      h.files.set(MARKER_PATH, '{}')
      await launched(h, i + 2)
    }
    h.clock.now = T0 + 5 * 60_000
    h.files.set(MARKER_PATH, '{}')
    await waitUntil(() => h.prints.some((l) => /restart marker ignored/.test(l)), 'the update budget')
    // The daemon read a refusal: the previous choice is back and the record says restoring.
    h.clock.now = T0 + 10 * 60_000
    const restoring = { ...JSON.parse(pendingSwitch({ model: 'opus', effort: 'high' })), state: 'restoring', reason: 'model_refused', requestedAtMs: T0 + 9 * 60_000 }
    h.files.set(SWITCH_PATH, JSON.stringify(restoring))
    h.files.set(CHOICE_PATH, choice('opus', 'high'))
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 5)
    const args = claudeArgs(h.claudes[4]!)
    assert.equal(flagValue(args, '--model'), 'opus', 'back on the previous choice')
    assert.deepEqual(args.slice(-2), ['--resume', PIN])
    const sw = parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)
    assert.equal(sw?.state, 'restoring')
    assert.equal(sw?.launchedAtMs, T0 + 10 * 60_000)
    // Stamped, it is no switch any more: a later update marker meets the spent update budget.
    h.clock.now = T0 + 11 * 60_000
    h.files.set(MARKER_PATH, '{}')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.claudes.length, 5)
  } finally {
    await h.end()
  }
})

// A go back is the end of a switch already counted: refusing it left the agent on the model that
// did not work until something else restarted it. Never refused; it still counts for later switches.
test('a restart back onto the previous choice is never refused by a spent switch budget', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('opus', 'high') })
  try {
    await launched(h, 1)
    for (let i = 0; i < 12; i++) {
      h.clock.now = T0 + (i + 1) * 60_000
      const model = i % 2 === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5'
      h.files.set(SWITCH_PATH, JSON.stringify({ ...JSON.parse(pendingSwitch(null)), target: { model, effort: 'low' }, requestedAtMs: h.clock.now }))
      h.files.set(CHOICE_PATH, choice(model, 'low'))
      h.files.set(MARKER_PATH, '{}')
      await launched(h, i + 2)
    }
    // The last switch did not work: the daemon put the previous choice back and asks for the restart back.
    h.clock.now = T0 + 20 * 60_000
    const restoring = { ...JSON.parse(pendingSwitch({ model: 'opus', effort: 'high' })), state: 'restoring', reason: 'model_refused', requestedAtMs: T0 + 12 * 60_000 }
    h.files.set(SWITCH_PATH, JSON.stringify(restoring))
    h.files.set(CHOICE_PATH, choice('opus', 'high'))
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 14)
    assert.equal(flagValue(claudeArgs(h.claudes[13]!), '--model'), 'opus', 'back on the previous choice')
    assert.ok(!h.prints.some((l) => /switches in the last hour/.test(l)), 'the go back was not refused')
    // A new switch in the same hour is refused: the budget is spent.
    h.clock.now = T0 + 21 * 60_000
    h.files.set(SWITCH_PATH, JSON.stringify({ ...JSON.parse(pendingSwitch(null)), requestedAtMs: h.clock.now }))
    h.files.set(CHOICE_PATH, choice('claude-sonnet-5-5', 'low'))
    h.files.set(MARKER_PATH, '{}')
    await waitUntil(() => h.prints.some((l) => /switches in the last hour/.test(l)), 'the switch budget')
    assert.equal(h.claudes.length, 14)
  } finally {
    await h.end()
  }
})

// The daemon tells the chat 45 s after it asked for the restart back ("has not restarted yet")
// and marks the record told; the launcher may pick the restart up after that. It is still the go
// back: it never spends the update budget, so a spent one never refuses it, and it is stamped.
test('a restart back picked up after the chat was told it is late never spends the update budget', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('opus', 'high') })
  try {
    await launched(h, 1)
    for (let i = 0; i < 3; i++) {
      h.clock.now = T0 + (i + 1) * 60_000
      h.files.set(MARKER_PATH, '{}')
      await launched(h, i + 2)
    }
    h.clock.now = T0 + 5 * 60_000
    h.files.set(MARKER_PATH, '{}')
    await waitUntil(() => h.prints.some((l) => /restart marker ignored/.test(l)), 'the update budget')
    const ignored = h.prints.filter((l) => /restart marker ignored/.test(l)).length
    h.clock.now = T0 + 10 * 60_000
    const late = { ...JSON.parse(pendingSwitch({ model: 'opus', effort: 'high' })), state: 'restoring', reason: 'model_refused', noted: true, requestedAtMs: T0 + 9 * 60_000 }
    h.files.set(SWITCH_PATH, JSON.stringify(late))
    h.files.set(CHOICE_PATH, choice('opus', 'high'))
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 5)
    assert.equal(flagValue(claudeArgs(h.claudes[4]!), '--model'), 'opus', 'back on the previous choice')
    assert.equal(h.prints.filter((l) => /restart marker ignored/.test(l)).length, ignored)
    assert.equal(parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)?.launchedAtMs, T0 + 10 * 60_000, 'stamped: one restart back only')
    // Stamped, a later marker is an update marker again, and meets the spent update budget.
    h.clock.now = T0 + 11 * 60_000
    h.files.set(MARKER_PATH, '{}')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.claudes.length, 5)
  } finally {
    await h.end()
  }
})

// The switch record is a file the agent itself can write. The restart budgets live in the
// launcher's memory, so the record cannot reset them, and it must not stand in for them either: a
// record this launcher already launched is spent, whatever the file says later, and a missing or
// unreadable one is no switch. Its marker then meets the update budget, which stays spent.
test('a switch record set back to unlaunched, deleted or broken after its launch buys no restart', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('opus', 'high') })
  try {
    await launched(h, 1)
    for (let i = 0; i < 3; i++) {
      h.clock.now = T0 + (i + 1) * 60_000
      h.files.set(MARKER_PATH, '{}')
      await launched(h, i + 2)
    }
    h.clock.now = T0 + 5 * 60_000
    h.files.set(MARKER_PATH, '{}')
    await waitUntil(() => h.prints.some((l) => /restart marker ignored/.test(l)), 'the update budget')
    // A real pick: its own budget, launched and stamped.
    h.clock.now = T0 + 10 * 60_000
    h.files.set(SWITCH_PATH, JSON.stringify({ ...JSON.parse(pendingSwitch(null)), requestedAtMs: h.clock.now }))
    h.files.set(CHOICE_PATH, choice('claude-sonnet-5-5', 'low'))
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 5)
    const pick = parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)
    assert.equal(pick?.launchedAtMs, T0 + 10 * 60_000)
    // It did not work: the daemon asks for the restart back, which runs once and is stamped.
    h.clock.now = T0 + 11 * 60_000
    h.files.set(SWITCH_PATH, JSON.stringify({ version: 1, ...pick, state: 'restoring', reason: 'model_refused', launchedAtMs: null }))
    h.files.set(CHOICE_PATH, choice('opus', 'high'))
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 6)
    const back = parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)
    assert.equal(back?.launchedAtMs, T0 + 11 * 60_000)
    const tries: Array<[string, string]> = [
      ['the pick set back to unlaunched', JSON.stringify({ version: 1, ...pick, launchedAtMs: null })],
      ['the go back set back to unlaunched', JSON.stringify({ version: 1, ...back, launchedAtMs: null })],
      ['a broken record', 'not json'],
    ]
    for (const [i, [what, body]] of tries.entries()) {
      h.clock.now = T0 + (12 + i) * 60_000
      h.files.set(SWITCH_PATH, body)
      h.files.set(MARKER_PATH, '{}')
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(h.claudes.length, 6, what)
    }
    h.files.delete(SWITCH_PATH)
    h.files.set(MARKER_PATH, '{}')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.claudes.length, 6, 'no record at all')
  } finally {
    await h.end()
  }
})

// Only the restart back from a switch this launcher launched skips the switch budget, once. Any
// other go back record (written by hand, or made up again and again) counts like a switch, so a
// spent switch budget refuses it.
test('a go back for a switch this launcher never launched is refused once the switch budget is spent', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('opus', 'high') })
  try {
    await launched(h, 1)
    // The update budget spent first, so a marker that is no switch cannot restart either.
    for (let i = 0; i < 3; i++) {
      h.clock.now = T0 + (i + 1) * 1_000
      h.files.set(MARKER_PATH, '{}')
      await launched(h, i + 2)
    }
    h.clock.now = T0 + 5_000
    h.files.set(MARKER_PATH, '{}')
    await waitUntil(() => h.prints.some((l) => /restart marker ignored/.test(l)), 'the update budget')
    for (let i = 0; i < 12; i++) {
      h.clock.now = T0 + (i + 1) * 60_000
      const model = i % 2 === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5'
      h.files.set(SWITCH_PATH, JSON.stringify({ ...JSON.parse(pendingSwitch(null)), target: { model, effort: 'low' }, requestedAtMs: h.clock.now }))
      h.files.set(CHOICE_PATH, choice(model, 'low'))
      h.files.set(MARKER_PATH, '{}')
      await launched(h, i + 5)
    }
    const goBack = (requestedAtMs: number) =>
      JSON.stringify({ ...JSON.parse(pendingSwitch({ model: 'opus', effort: 'high' })), state: 'restoring', reason: 'model_refused', requestedAtMs })
    h.files.set(CHOICE_PATH, choice('opus', 'high'))
    for (const [i, at] of [T0 + 30 * 60_000, T0 + 31 * 60_000].entries()) {
      h.clock.now = T0 + (20 + i) * 60_000
      h.files.set(SWITCH_PATH, goBack(at))
      h.files.set(MARKER_PATH, '{}')
      await waitUntil(() => h.prints.filter((l) => /switches in the last hour/.test(l)).length === i + 1, `made up go back ${i + 1}`)
      assert.equal(h.claudes.length, 16)
    }
    // The go back from the last switch it launched still restarts, and only once.
    h.clock.now = T0 + 25 * 60_000
    h.files.set(SWITCH_PATH, goBack(T0 + 12 * 60_000))
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 17)
    assert.equal(flagValue(claudeArgs(h.claudes[16]!), '--model'), 'opus')
    h.clock.now = T0 + 26 * 60_000
    h.files.set(SWITCH_PATH, goBack(T0 + 12 * 60_000))
    h.files.set(MARKER_PATH, '{}')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.claudes.length, 17, 'the same go back again')
  } finally {
    await h.end()
  }
})

// The failed start record is built from the record on disk, read again, never from the launcher's
// own copy: a switch the new daemon already confirmed (and told the chat) must not be undone.
test('a switch the new daemon already confirmed is never undone by a later fast exit', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('opus', 'high') })
  try {
    await launched(h, 1)
    h.files.set(SWITCH_PATH, pendingSwitch({ model: 'opus', effort: 'high' }))
    h.files.set(CHOICE_PATH, choice('claude-sonnet-5-5', 'low'))
    h.clock.now = T0 + 60_000
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 2)
    const sw = JSON.parse(h.files.get(SWITCH_PATH)!)
    h.files.set(SWITCH_PATH, JSON.stringify({ ...sw, state: 'confirmed', noted: true }))
    h.claudes[1]!.exit(1)
    await launched(h, 3)
    assert.equal(flagValue(claudeArgs(h.claudes[2]!), '--model'), 'claude-sonnet-5-5', 'still on the confirmed pick')
    assert.deepEqual(parseLaunchChoice(h.files.get(CHOICE_PATH) ?? null), { model: 'claude-sonnet-5-5', effort: 'low' })
    assert.equal(parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)?.state, 'confirmed')
    assert.ok(!h.prints.some((l) => /stays on the model it had/.test(l)), h.prints.join('\n'))
  } finally {
    await h.end()
  }
})

// A saved choice the CLI will not start on (a CLI older than --effort back on PATH) is passed on
// every launch; without a way to drop it, the agent would never come back.
test('a saved choice the CLI no longer starts on is left out after two fast exits, until a restart is asked for', async () => {
  const h = harness({ ...resumed, [CHOICE_PATH]: choice('claude-opus-5-5', 'xhigh') })
  try {
    await launched(h, 1)
    assert.equal(flagValue(claudeArgs(h.claudes[0]!), '--effort'), 'xhigh')
    h.claudes[0]!.exit(1)
    await launched(h, 2)
    h.claudes[1]!.exit(1)
    await launched(h, 3)
    const args = claudeArgs(h.claudes[2]!)
    assert.equal(args.includes('--model'), false)
    assert.equal(args.includes('--effort'), false)
    assert.deepEqual(args.slice(-2), ['--resume', PIN], 'its own conversation, not a new one')
    // Kept, only left out: two fast exits can have another cause (a network outage under keep alive).
    assert.deepEqual(parseLaunchChoice(h.files.get(CHOICE_PATH) ?? null), { model: 'claude-opus-5-5', effort: 'xhigh' })
    assert.ok(h.prints.some((l) => /without the model the owner picked/.test(l)), h.prints.join('\n'))
    // A restart someone asks for (an update, a new pick) tries the pick again.
    h.clock.now = T0 + 60_000
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 4)
    assert.equal(flagValue(claudeArgs(h.claudes[3]!), '--effort'), 'xhigh')
  } finally {
    await h.end()
  }
})

test('a failed switch with no previous choice removes the choice file', async () => {
  const h = harness(resumed)
  await launched(h, 1)
  h.files.set(SWITCH_PATH, pendingSwitch(null))
  h.files.set(CHOICE_PATH, choice('claude-sonnet-5-5', 'low'))
  h.clock.now = T0 + 60_000
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  h.claudes[1]!.exit(1)
  await launched(h, 3)
  const args = claudeArgs(h.claudes[2]!)
  assert.deepEqual(args.slice(-2), ['--resume', PIN])
  assert.equal(args.includes('--model'), false)
  assert.equal(h.files.has(CHOICE_PATH), false)
  assert.equal(parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)?.state, 'failed')
  await h.end()
})

test('a person who quits their own hoai right after a switch is not started again, and the choice stands', async () => {
  // Not the Helper's service and no --keep-alive: a person at a terminal.
  const h = harness(resumed, { env: { ComSpec: COMSPEC }, keepAlive: false })
  try {
    await launched(h, 1)
    h.files.set(SWITCH_PATH, pendingSwitch({ model: 'opus', effort: 'high' }))
    h.files.set(CHOICE_PATH, choice('claude-sonnet-5-5', 'low'))
    h.clock.now = T0 + 60_000
    h.files.set(MARKER_PATH, '{}')
    await launched(h, 2)
    // They type /exit at once: a clean exit, inside the health window.
    h.claudes[1]!.exit(0)
    // A bounded wait: a launcher that starts claude again fails here rather
    // than hold the test open (the finally below stops it either way).
    let timer: ReturnType<typeof setTimeout> | undefined
    const ended = await Promise.race([
      h.done.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3000) }),
    ]).finally(() => clearTimeout(timer))
    assert.equal(h.claudes.length, 2, 'nothing is started again')
    assert.equal(ended, true, 'the launcher ends with the person\'s exit')
    assert.deepEqual(parseLaunchChoice(h.files.get(CHOICE_PATH) ?? null), { model: 'claude-sonnet-5-5', effort: 'low' })
    assert.equal(parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)?.state, 'pending', 'not a failed start')
    assert.ok(!h.prints.some((l) => /stays on the model it had/.test(l)), h.prints.join('\n'))
  } finally {
    await h.end()
  }
})

test('a switch relaunch that outlives the health window is left alone when it ends later', async () => {
  const h = harness(resumed)
  await launched(h, 1)
  h.files.set(SWITCH_PATH, pendingSwitch(null))
  h.files.set(CHOICE_PATH, choice('claude-sonnet-5-5', 'low'))
  h.clock.now = T0 + 60_000
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  h.clock.now = T0 + 60_000 + HEALTHY_MS + 1
  h.claudes[1]!.exit(0)
  await launched(h, 3)
  assert.equal(flagValue(claudeArgs(h.claudes[2]!), '--model'), 'claude-sonnet-5-5', 'the choice sticks')
  assert.equal(parseModelSwitch(h.files.get(SWITCH_PATH) ?? null)?.state, 'pending', 'confirming is the daemon\'s')
  await h.end()
})
