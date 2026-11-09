/** Sanitized composer and dialog crops from Claude Code 2.1.319 captures. No live agent or API is used. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readComposer, isModelSwitchDialog } from '../lib/model-effort-pane.ts'
import { parseHelpCatalog, buildPickerCatalog } from '../lib/model-effort-catalog.ts'
import { EXACT_MODEL_LABELS } from '../lib/compact-inject.ts'
import { ModelEffortControl } from '../lib/model-effort-control.ts'

const RULE = '─'.repeat(60)
const empty = ['● Ready', RULE, '❯\u00a0', RULE, '  ? for shortcuts'].join('\n')
function question(name: string): string {
  return ['Switch model?', 'Your next response will be slower and use more tokens', '', `This conversation is cached for the current model. Switching to ${name} means the full history gets re-read.`, '', `❯ 1. Yes, switch to ${name}`, '  2. No, go back'].join('\n')
}
const dialog = question('Sonnet 5.5')
const HELP = `  --effort <level>  Effort (low, medium, high, xhigh, max)
  --model <model>   Provide an alias (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.`
const exact = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']

test('2.1.319: a terminal cursor proves an empty fresh prompt and an empty prompt after a turn', () => {
  assert.equal(readComposer(empty, { x: 2, y: 2, visible: true }), 'empty')
  assert.equal(readComposer('● A completed answer\n' + empty, { x: 2, y: 3, visible: true }), 'empty')
})

test('2.1.319: a terminal cursor never licenses a draft or an uncertain prompt', () => {
  for (const cursor of [undefined, { x: 3, y: 2, visible: true }, { x: 2, y: 1, visible: true }, { x: 2, y: 2, visible: false }]) {
    assert.equal(readComposer(empty, cursor), 'unknown')
  }
  for (const text of ['draft', ' ', '\u001b[2m[Pasted text #1]\u001b[22m', '\u001b[2mhint\u001b[22m']) {
    assert.notEqual(readComposer(empty.replace('❯\u00a0', '❯\u00a0' + text), { x: 2, y: 2, visible: true }), 'empty', JSON.stringify(text))
  }
})

function rig(screen?: string, applies = true) {
  let now = 1000
  let activeScreen = screen ?? dialog
  let typed = ''
  let submitted = false
  let seq = 1
  let model = 'claude-opus-5-5'
  const keys: string[][] = []
  const target = { target: '%7', socketArgs: [], source: 'tmux-pane' as const }
  const control = new ModelEffortControl({
    optedIn: () => true, target: () => target, sessionId: () => 'test-session',
    turnState: () => 'idle', dialogOpen: () => false, otherInjectionBusy: () => false,
    ancestry: async () => [{ pid: 900, tty: 'ttys012', pgid: 800, tpgid: 800 }, { pid: 800, tty: 'ttys012', pgid: 800, tpgid: 800 }],
    helpText: async () => HELP,
    readObservation: () => ({ sessionId: 'test-session', modelId: model, modelDisplayName: 'Opus', effort: 'high', version: '2.1.319', seq, observedAtMs: now }),
    exec: async (argv) => {
      if (argv.includes('display-message')) return '%7\t/dev/ttys012\t0\t0\t800' + (argv.at(-1)!.includes('cursor_x') ? '\t2\t2\t1' : '') + '\n'
      if (argv.includes('capture-pane')) return submitted ? activeScreen : [RULE, `❯\u00a0${typed || '\u001b[7m \u001b[0m'}`, RULE].join('\n')
      keys.push(argv)
      if (argv.includes('-l')) typed = argv.at(-1)!
      else if (argv.at(-1) === 'Enter' && !submitted) submitted = true
      else if (argv.at(-1) === 'Enter' && submitted && applies) { model = typed.slice('/model '.length) === 'sonnet' ? 'claude-sonnet-5-5' : typed.slice('/model '.length); seq++ }
      return ''
    },
    sleep: async (ms) => { now += ms }, now: () => now, log: () => {},
  }, { confirmTimeoutMs: 2000, pollMs: 100 })
  return { keys, control, apply: (model: string) => {
    if (screen === undefined) activeScreen = question(EXACT_MODEL_LABELS[model as keyof typeof EXACT_MODEL_LABELS] ?? 'Sonnet 5.5')
    return control.apply({ sessionId: 'test-session', model, effort: 'high' }, { deadlineAtMs: Infinity })
  } }
}

test('2.1.319: the exact Switch model dialog is answered Yes and confirmed from a newer status', async () => {
  const r = rig()
  const out = await r.apply('sonnet')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 2)
})

test('2.1.319: the switch question requires the recorded explanation and matching known target', () => {
  assert.equal(isModelSwitchDialog(dialog.replace('Switch model?', '\u001b[1mSwitch model?\u001b[0m')), true)
  assert.equal(isModelSwitchDialog(dialog.split('\n').slice(0, 4).join('\n')), false)
  assert.equal(isModelSwitchDialog(dialog, 'claude-opus-5'), false)
  assert.equal(isModelSwitchDialog(dialog + '\n' + empty), false, 'history before a composer is not the live question')
})

test('2.1.319: a switch dialog without a matching newer status never confirms', async () => {
  const r = rig(dialog, false)
  const out = await r.apply('sonnet')
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'not_confirmed')
  assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 2, 'answer once even if the dialog stays on screen')
})

test('2.1.319: other dialogs and a selected No receive no confirmation key', async () => {
  for (const screen of [dialog.replace('Switch model?', 'Allow this command?'), dialog.replace('Yes, switch', 'Yes, delete'), dialog.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.'), dialog + '\nDo you want to proceed?']) {
    const r = rig(screen)
    const out = await r.apply('sonnet')
    assert.equal(out.ok, false)
    assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 1, screen)
  }
})

test('2.1.319: every guard still applies before answering the switch question', async () => {
  for (const guard of ['turn', 'permission', 'session', 'injection', 'ownership', 'mode', 'changed-question']) {
    const r = rig()
    const original = r.control.deps.exec
    let sawQuestion = false
    r.control.deps.exec = async (argv) => {
      let out = await original(argv)
      if (sawQuestion && guard === 'mode' && argv.includes('display-message')) out = out.replace('\t0\t0\t800', '\t0\t1\t800')
      if (out === dialog) {
        if (sawQuestion && guard === 'changed-question') return 'Allow this command?'
        sawQuestion = true
        if (guard === 'turn') r.control.deps.turnState = () => 'live'
        if (guard === 'permission') r.control.deps.dialogOpen = () => true
        if (guard === 'session') r.control.deps.sessionId = () => 'other-session'
        if (guard === 'injection') r.control.deps.otherInjectionBusy = () => true
        if (guard === 'ownership') r.control.deps.ancestry = async () => []
      }
      return out
    }
    const out = await r.apply('sonnet')
    assert.equal(out.ok, false, guard)
    assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 1, guard)
    assert.equal(r.control.busy, false)
  }
})

test('2.1.319: the catalog offers distinct exact model ids under their family labels', () => {
  const catalog = parseHelpCatalog(HELP, '2.1.319')
  for (const id of exact) assert.ok(catalog.models.includes(id), id)
  const built = buildPickerCatalog({ catalog, sessionId: 'test-session', observation: { sessionId: 'test-session', modelId: 'claude-opus-5', modelDisplayName: 'Opus 5', effort: 'high', version: '2.1.319', seq: 1, observedAtMs: 1000 } })!
  assert.equal(built.current!.model, 'claude-opus-5')
  assert.equal(built.models.find((m) => m.id === 'claude-opus-5-5')!.label, 'Opus 5.5')
  assert.equal(built.models.find((m) => m.id === 'claude-opus-5')!.label, 'Opus 5')
})

test('2.1.319: an exact model is typed verbatim and confirmed exactly', async () => {
  const r = rig()
  const out = await r.apply('claude-opus-5')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(r.keys.find((a) => a.includes('-l'))!.at(-1), '/model claude-opus-5')
})

test('2.1.319: another version in the same family is never exact confirmation', async () => {
  const r = rig(dialog, false)
  const read = r.control.deps.readObservation
  r.control.deps.readObservation = (sid) => {
    const o = read(sid)!
    return { ...o, seq: o.seq + r.keys.length }
  }
  const out = await r.apply('claude-opus-5')
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'not_confirmed')
})

test('2.1.319: empty terminal cursors reach apply while drafts and missing cursors type nothing', async () => {
  for (const text of ['', 'draft', ' ', '\u001b[2m[Pasted text #1]\u001b[22m']) {
    for (const flag of [0, 1]) {
      const r = rig()
      const exec = r.control.deps.exec
      r.control.deps.exec = async (argv) => {
        if (argv.includes('display-message')) return `%7\t/dev/ttys012\t0\t0\t800\t${2 + (text === ' ' ? 1 : 0)}\t2\t${flag}\n`
        if (argv.includes('capture-pane') && r.keys.length === 0) return empty.replace('❯\u00a0', '❯\u00a0' + text)
        return exec(argv)
      }
      const out = await r.apply('sonnet')
      assert.equal(out.ok, text === '' && flag === 1, `${JSON.stringify(text)} cursor ${flag}: ${JSON.stringify(out)}`)
      if (!out.ok) assert.equal(r.keys.length, 0)
    }
  }
})

test('2.1.319: unoffered exact ids and free text never reach the pane', async () => {
  for (const model of ['claude-opus-5-5 ', 'claude-opus-5;whoami', 'claude-opus-99', '__proto__', 'claude-sonnet-5-5']) {
    const r = rig()
    if (model === 'claude-sonnet-5-5') {
      const read = r.control.deps.readObservation
      r.control.deps.readObservation = (sid) => ({ ...read(sid)!, version: '2.1.318' })
    }
    const out = await r.apply(model)
    assert.equal(out.ok, false, model)
    assert.equal(r.keys.length, 0, model)
  }
})

// Only the relevant UI rows are retained; source headers and session links are omitted.
const CAPTURED = {
  "fresh": "\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n\u001b[39m❯ \u001b[2mTry \"write a test for <filepath>\"\u001b[0m\n\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "afterTurn": "\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n\u001b[39m❯ \n\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "settled": "\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n\u001b[39m❯ \n\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "typed": "\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n\u001b[39m❯ \u001b[38;5;153m/model\u001b[39m claude-haiku-4-5\n\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "switch": "\u001b[39m   \u001b[1m\u001b[38;5;220mSwitch model?\u001b[0m\n   \u001b[38;5;246mYour next response will be slower and use more tokens\u001b[39m\n\n   This conversation is cached for the current model. Switching to \u001b[1mHaiku 4.5\u001b[0m means the full history gets re-read.\n\n   \u001b[38;5;153m❯\u001b[39m \u001b[38;5;246m1. \u001b[38;5;153mYes, switch to Haiku 4.5\u001b[39m\n     \u001b[38;5;246m2. \u001b[39mNo, go back"
}

test('2.1.319 captures: both blank after-turn prompts are empty only with the terminal cursor', () => {
  for (const screen of [CAPTURED.afterTurn, CAPTURED.settled]) {
    assert.equal(readComposer(screen), 'unknown')
    assert.equal(readComposer(screen, { x: 2, y: 1, visible: true }), 'empty')
    assert.equal(readComposer(screen, { x: 3, y: 1, visible: true }), 'unknown')
  }
  assert.equal(readComposer(CAPTURED.typed, { x: 2, y: 1, visible: true }), 'draft')
  assert.equal(readComposer(CAPTURED.fresh, { x: 2, y: 1, visible: true }), 'unknown', 'the row still holds a dim hint, so the blank-row fallback does not apply')
})

test('2.1.319 captures: the recorded model question is accepted and confirmed', async () => {
  const r = rig(CAPTURED.switch)
  const out = await r.apply('claude-haiku-4-5')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 2)
})
