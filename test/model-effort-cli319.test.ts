/** Regression shapes described in BRIEF.md. No live agent or API is used. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readComposer } from '../lib/model-effort-pane.ts'
import { parseHelpCatalog, buildPickerCatalog } from '../lib/model-effort-catalog.ts'
import { ModelEffortControl } from '../lib/model-effort-control.ts'

const RULE = '─'.repeat(60)
const empty = ['● Ready', RULE, '❯\u00a0', RULE, '  ? for shortcuts'].join('\n')
const dialog = ['Switch model?', '', '❯ 1. Yes, switch', '  2. No, go back', '', 'Enter to confirm · Esc to cancel'].join('\n')
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

function rig(screen = dialog, applies = true) {
  let now = 1000
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
      if (argv.includes('capture-pane')) return submitted ? screen : [RULE, `❯\u00a0${typed || '\u001b[7m \u001b[0m'}`, RULE].join('\n')
      keys.push(argv)
      if (argv.includes('-l')) typed = argv.at(-1)!
      else if (argv.at(-1) === 'Enter' && !submitted) submitted = true
      else if (argv.at(-1) === 'Enter' && submitted && applies) { model = typed.slice('/model '.length) === 'sonnet' ? 'claude-sonnet-5-5' : typed.slice('/model '.length); seq++ }
      return ''
    },
    sleep: async (ms) => { now += ms }, now: () => now, log: () => {},
  }, { confirmTimeoutMs: 2000, pollMs: 100 })
  return { keys, control, apply: (model: string) => control.apply({ sessionId: 'test-session', model, effort: 'high' }, { deadlineAtMs: Infinity }) }
}

test('2.1.319: the exact Switch model dialog is answered Yes and confirmed from a newer status', async () => {
  const r = rig()
  const out = await r.apply('sonnet')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(r.keys.filter((a) => a.at(-1) === 'Enter').length, 2)
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
