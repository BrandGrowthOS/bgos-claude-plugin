/** Sanitized composer and dialog crops from Claude Code 2.1.319 captures. No live agent or API is used. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readComposer, isModelSwitchDialog, isEffortSwitchDialog } from '../lib/model-effort-pane.ts'
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
  let effort = 'high'
  const keys: string[][] = []
  const target = { target: '%7', socketArgs: [], source: 'tmux-pane' as const }
  const control = new ModelEffortControl({
    optedIn: () => true, target: () => target, sessionId: () => 'test-session',
    turnState: () => 'idle', dialogOpen: () => false, otherInjectionBusy: () => false,
    ancestry: async () => [{ pid: 900, tty: 'ttys012', pgid: 800, tpgid: 800 }, { pid: 800, tty: 'ttys012', pgid: 800, tpgid: 800 }],
    helpText: async () => HELP,
    readObservation: () => ({ sessionId: 'test-session', modelId: model, modelDisplayName: 'Opus', effort, version: '2.1.319', seq, observedAtMs: now }),
    exec: async (argv) => {
      if (argv.includes('display-message')) return '%7:/dev/ttys012:0:0:800' + (argv.at(-1)!.includes('cursor_x') ? ':2:2:1' : '') + '\n'
      if (argv.includes('capture-pane')) return submitted ? activeScreen : [RULE, `❯\u00a0${typed || '\u001b[7m \u001b[0m'}`, RULE].join('\n')
      keys.push(argv)
      if (argv.includes('-l')) typed = argv.at(-1)!
      else if (argv.at(-1) === 'Enter' && !submitted) submitted = true
      else if (argv.at(-1) === 'Enter' && submitted && applies) { if (typed.startsWith('/effort ')) effort = typed.slice('/effort '.length); else model = typed.slice('/model '.length) === 'sonnet' ? 'claude-sonnet-5-5' : typed.slice('/model '.length); seq++ }
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
      if (sawQuestion && guard === 'mode' && argv.includes('display-message')) out = out.replace(':0:0:800', ':0:1:800')
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
        if (argv.includes('display-message')) return `%7:/dev/ttys012:0:0:800:${2 + (text === ' ' ? 1 : 0)}:2:${flag}\n`
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

function effortQuestion(level: string): string {
  return question(level).replace('Switch model?', 'Change effort level?').replace('current model.', 'current effort level.')
}

test('effort dialog requires the exact title, explanation, selected Yes and requested level', async () => {
  const screen = effortQuestion('xhigh')
  for (const bad of [screen.replace('xhigh means', 'high means'), screen.replace('Yes, switch to xhigh', 'Yes, switch to high'), screen.replace('current effort level', 'current model'), screen.replace('❯ 1.', '  1.'), screen + '\n' + empty, screen.replace('Your next response will be slower and use more tokens', 'A PreModelSwitch hook asked you to confirm')]) {
    assert.equal(isEffortSwitchDialog(bad, 'xhigh'), false, bad)
    const r = rig(bad)
    const out = await r.control.apply({ sessionId: 'test-session', model: 'claude-opus-5-5', effort: 'xhigh' }, { deadlineAtMs: Infinity })
    assert.equal(out.ok, false)
    assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 1)
  }
  const r = rig(screen)
  const out = await r.control.apply({ sessionId: 'test-session', model: 'claude-opus-5-5', effort: 'xhigh' }, { deadlineAtMs: Infinity })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 2)
})

test('M7 M19 M20: each confirmation recheck independently refuses a change in its own gap', async () => {
  for (const effort of [false, true]) for (const gap of ['first-idle', 'final-idle', 'final-session']) for (const signal of ['turn', 'permission', 'card']) {
    const screen = effort ? effortQuestion('xhigh') : dialog
    const r = rig(screen)
    const exec = r.control.deps.exec
    let captures = 0
    let armed = false
    r.control.deps.exec = async (argv) => {
      const out = await exec(argv)
      if (out === screen) {
        captures++
        if (captures === (gap === 'first-idle' ? 1 : 2)) armed = true
      }
      // A missed first check loses its signal as soon as the next pane read starts.
      if (gap === 'first-idle' && argv.includes('display-message') && captures > 0) armed = false
      return out
    }
    const consume = () => { const value = armed; armed = false; return value }
    if (gap === 'final-session') r.control.deps.sessionId = () => consume() ? 'changed-session' : 'test-session'
    else if (signal === 'turn') r.control.deps.turnState = () => consume() ? 'live' : 'idle'
    else if (signal === 'permission') r.control.deps.dialogOpen = () => consume()
    else r.control.deps.lastCardAtMs = () => consume() ? r.control.deps.now() : null
    const out = effort
      ? await r.control.apply({ sessionId: 'test-session', model: 'claude-opus-5-5', effort: 'xhigh' }, { deadlineAtMs: Infinity })
      : await r.apply('sonnet')
    assert.equal(out.ok, false, `${effort} ${gap} ${signal}`)
    assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 1, `${effort} ${gap} ${signal}`)
  }
})

test('M11: cursor moves during capture, so only the fresh pane state may license typing', async () => {
  const r = rig()
  const exec = r.control.deps.exec
  let captured = false
  r.control.deps.exec = async (argv) => {
    if (argv.includes('capture-pane') && !captured) { captured = true; return empty }
    const out = await exec(argv)
    return captured && argv.includes('display-message') ? out.replace(':2:2:1', ':3:2:1') : out
  }
  const out = await r.apply('sonnet')
  assert.equal(out.ok, false)
  assert.equal(r.keys.length, 0)
})

test('M3 M16: duplicate titles and unknown family labels are refused', () => {
  assert.equal(isModelSwitchDialog('Switch model?\n' + dialog, 'sonnet'), false)
  assert.equal(isModelSwitchDialog(question('Sonnet 99'), 'sonnet'), false)
})

test('M13: a version alone cannot enable exact ids without recognized model help', () => {
  for (const help of [HELP.split('\n')[0], HELP.replace("'fable', 'opus', or 'sonnet'", "'unknown'")]) {
    assert.deepEqual(parseHelpCatalog(help, '2.1.319').models, [])
  }
  assert.deepEqual(parseHelpCatalog(HELP, '2.1.320').models, ['fable', 'opus', 'sonnet'])
})

test('retired CLI registry spellings are excluded using the same release deprecation table', async () => {
  const { readFileSync } = await import('node:fs')
  const rows = JSON.parse(readFileSync(new URL('./fixtures/claude-2.1.319-deprecations.json', import.meta.url), 'utf8')) as Array<{ ids: string[]; status: string }>
  const { EXACT_MODEL_LITERALS } = await import('../lib/compact-inject.ts')
  const retired = Object.keys(EXACT_MODEL_LITERALS).filter((id) => rows.some((row) => row.status === 'retired' && row.ids.some((old) => old === id || old === `${id}-latest`)))
  assert.equal(retired.length, 6)
  const catalog = parseHelpCatalog(HELP, '2.1.319')
  assert.deepEqual(catalog.models, Object.keys(EXACT_MODEL_LITERALS).filter((id) => !retired.includes(id)))
  assert.ok(catalog.models.includes('claude-sonnet-4-5'), 'deprecated is not retired')
  for (const model of retired) {
    const r = rig()
    assert.equal((await r.apply(model)).ok, false, model)
    assert.equal(r.keys.length, 0, model)
  }
})
