/** BGOS 1048 msg 219939 (2026-11-12): Autonomee's picker refused every switch with composer_unknown. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readComposer } from '../lib/model-effort-pane.ts'
import { parseHelpCatalog } from '../lib/model-effort-catalog.ts'
import { buildGateAutoAcceptExpect, readGateBlock } from '../bin/hoai-core.mjs'

const pane = readFileSync(new URL('./fixtures/claude-2.1.319-autonomee/pane.ansi', import.meta.url), 'utf8')
const repaired = pane.replace('[hoai] launch: outcome=live answered=[channels] compact=on', '─'.repeat(58))
const cursor = { x: 2, y: 3, visible: true }

test('the captured pane: the launch line over the frame hides the message box (fail closed, as before)', () => {
  assert.equal(readComposer(pane, cursor), 'unknown')
})

test('2.1.319: a prompt holding only a dim hint, with the terminal cursor at its first column, is empty', () => {
  assert.equal(readComposer(repaired, cursor), 'empty')
})

test('2.1.319: the same dim hint is not empty when the cursor is anywhere else, hidden or unknown', () => {
  for (const c of [undefined, { x: 3, y: 3, visible: true }, { x: 2, y: 2, visible: true }, { x: 2, y: 3, visible: false }]) {
    assert.equal(readComposer(repaired, c), 'unknown', JSON.stringify(c))
  }
})

test('2.1.319: typed text before a dim hint, a reference tag and a non-dim word stay a draft or unknown', () => {
  const hint = '\u001b[2mrestart the session to load it\u001b[0m'
  assert.ok(repaired.includes(hint))
  assert.notEqual(readComposer(repaired.replace(hint, 'x' + hint), cursor), 'empty')
  assert.notEqual(readComposer(repaired.replace(hint, '\u001b[2m[Pasted text #1]\u001b[22m'), cursor), 'empty')
  assert.notEqual(readComposer(repaired.replace(hint, 'restart'), cursor), 'empty')
})

test('the supervised launcher never prints its launch line into a live session (it would land on the frame)', () => {
  const script = buildGateAutoAcceptExpect({ claudePath: 'claude', args: [], supervised: { stateDir: '/s', interactive: true, compact: 'compact=on' } })
  const tail = script.slice(script.indexOf(readGateBlock()) + readGateBlock().length)
  const puts = tail.split('\n').filter((l) => l.includes('\\[hoai\\] launch:'))
  assert.equal(puts.length, 1)
  assert.match(puts[0]!, /^if \{\$hoai_outcome ne "live"\} \{ puts /)
  // The status file still records every outcome, live included.
  assert.match(tail, /open "\$hoai_statedir\/launch-status" w/)
})

const HELP = `  --effort <level>  Effort (low, medium, high, xhigh, max)
  --model <model>   Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.`

test('the exact catalog is not frozen to 2.1.319: 2.1.322 offers the exact models, Fable 5.2 included', () => {
  const at322 = parseHelpCatalog(HELP, '2.1.322').models
  assert.ok(at322.includes('claude-opus-5-5') && at322.includes('claude-haiku-5-5') && at322.includes('claude-fable-5-2'), at322.join())
  const at319 = parseHelpCatalog(HELP, '2.1.319').models
  assert.ok(at319.includes('claude-opus-5-5'))
  assert.ok(!at319.includes('claude-fable-5-2'), '2.1.319 does not know Fable 5.2: typing it would fail')
  // An older or unparseable CLI keeps the help's aliases.
  assert.deepEqual(parseHelpCatalog(HELP, '2.1.309').models, ['fable', 'opus', 'sonnet'])
  assert.deepEqual(parseHelpCatalog(HELP, null).models, ['fable', 'opus', 'sonnet'])
})
