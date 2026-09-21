/**
 * lib/gate-block.tcl: the ONE copy of the rules for answering Claude Code's
 * first-run screens, shared by the hoai launcher (bin/hoai-core.mjs) and the
 * always-on supervisor (bin/bgos-agent).
 *
 * WHY THIS FILE EXISTS (2026-09-21, all measured against Claude Code 2.1.278).
 * Both launchers used to press Enter on the word "confirm". Folder trust and
 * the bypass warning list "No, exit" FIRST, so that Enter declined them: claude
 * exited in two seconds, expect exited 0, and nothing was printed. The
 * supervisor added up to two blind Enters on timeout. And the keys that DO
 * accept the trust gate (Down, Enter) select "Exit" on the dev-channels gate. So
 * there is no single key that is safe on every screen, and the only safe rule
 * is: read the screen, derive the key from it, send nothing otherwise.
 *
 * Two layers of test. The static ones pin the rules in the text. The
 * behavioural ones run the real file under a real `expect` against a simulator
 * that paints a screen and records the exact bytes it is sent, because a rule
 * that reads well and sends the wrong byte is the defect this replaces. They
 * return early where `expect` is not installed (a minimal Linux image).
 *
 * Run: npm test, or npx tsx --test test/gate-block.test.ts
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const blockPath = join(repoRoot, 'lib', 'gate-block.tcl')
const block = readFileSync(blockPath, 'utf8')
const code = block
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

// -- static rules -------------------------------------------------------------

test('gate block: every send lives inside hoai_answer, so no key is sent to a screen that was not read', () => {
  const procStart = code.indexOf('proc hoai_answer')
  assert.ok(procStart >= 0, 'hoai_answer must exist')
  const procEnd = code.indexOf('\n}\n', procStart)
  const outside = code.slice(0, procStart) + code.slice(procEnd)
  assert.doesNotMatch(outside, /\bsend\b/, 'a send outside hoai_answer is a key pressed without reading the screen')
  const inside = code.slice(procStart, procEnd)
  assert.equal((inside.match(/\bsend\b/g) ?? []).length, 2, 'exactly the Down and the Enter')
})

test('gate block: the timeout and the unrecognised-screen branches never send', () => {
  const lines = code.split('\n')
  const timeoutLines = lines.filter((line) => /^\s*timeout\b/.test(line))
  assert.ok(timeoutLines.length >= 1)
  for (const line of timeoutLines) assert.doesNotMatch(line, /send/, line)
  const catchAll = lines.filter((line) => /\{\(\.\*\)confirm\}/.test(line))
  assert.equal(catchAll.length, 1, 'one catch-all for a gate no rule recognises')
  assert.doesNotMatch(catchAll[0]!, /send|hoai_answer/, catchAll[0])
  assert.match(catchAll[0]!, /gate-unrecognised/)
})

test('gate block: the Down arrow is conditional on the DECLINING option being painted first', () => {
  // The order is read off the screen, never assumed, so a future Claude Code
  // that lists "Yes" first gets Enter alone instead of Down then Enter, which
  // would select "No, exit".
  assert.match(code, /if \{\$a >= 0 && \$a < \$w\} \{ send -- "\\x1b\\\[B"/)
  assert.match(code, /if \{\$w < 0\} \{\s*\n\s*set hoai_outcome "gate-unreadable:\$gate"/)
})

test('gate block: each gate is answered at most once, so a word in the live banner cannot type into the REPL', () => {
  // "channels" reappears in the live banner. Measured: a bare re-match sent five
  // Enters into a live session before this guard existed.
  assert.match(code, /lsearch -exact \$hoai_answered \$gate/)
  assert.match(code, /gate-repeated:\$gate/)
})

test('gate block: the option words are unique to the options, never words the prose above them uses', () => {
  // dev-channels prose says "for local channel development", session-age prose
  // says "resuming from a summary": keying on those would read the prose.
  assert.match(code, /hoai_answer channels \$expect_out\(1,string\) "using"\s+"Exit"/)
  assert.match(code, /hoai_answer resume\s+\$expect_out\(1,string\) "recommended"\s+"as-is"/)
  assert.match(code, /hoai_answer trust\s+\$expect_out\(1,string\) "Yes"\s+"exit"/)
  assert.match(code, /hoai_answer bypass\s+\$expect_out\(1,string\) "Yes"\s+"exit"/)
})

test('gate block: the live footer is matched as words with escapes allowed between them', () => {
  // Measured: the same footer arrives as "bypass permissions on" on one paint
  // and as bypass<ESC>[13Gpermissions<ESC>[25Gon on another.
  assert.match(code, /bypass\$\{hoai_gap\}permissions\$\{hoai_gap\}on/)
  assert.doesNotMatch(code, /\{\(\?i\)bypass permissions on\}/)
})

test('gate block: no em or en dashes', () => {
  assert.doesNotMatch(block, /[\u2013\u2014]/)
})

// -- behaviour, under a real expect --------------------------------------------

const expectBin = ['/usr/bin/expect', '/opt/homebrew/bin/expect', '/usr/local/bin/expect'].find((p) => existsSync(p))

const SIMULATOR = `
// SIMULATION, not Claude Code: paint one screen, record the raw bytes received for a
// while, then go "live" (or exit), so the block's decisions are visible byte for byte.
const fs = require('node:fs')
const [mode, keyFile] = process.argv.slice(2)
const M = '\\u276f'
const SCREENS = {
  'trust-no-first': 'Accessing workspace:\\r\\n Quick safety check: Is this a project you trust?\\r\\n ' + M + ' No, exit\\r\\n   Yes, I trust this folder\\r\\n Enter to confirm\\r\\n',
  'trust-yes-first': 'Accessing workspace:\\r\\n Quick safety check: Is this a project you trust?\\r\\n ' + M + ' Yes, I trust this folder\\r\\n   No, exit\\r\\n Enter to confirm\\r\\n',
  'bypass-no-first': 'WARNING: Claude Code running in Bypass Permissions mode\\r\\n ' + M + ' No, exit\\r\\n   Yes, I accept\\r\\n Enter to confirm\\r\\n',
  'channels': 'WARNING: Loading development channels\\r\\n is for local channel development only.\\r\\n ' + M + ' 1. I am using this for local development\\r\\n   2. Exit\\r\\n Enter to confirm\\r\\n',
  'channels-flipped': 'WARNING: Loading development channels\\r\\n is for local channel development only.\\r\\n ' + M + ' 1. Exit\\r\\n   2. I am using this for local development\\r\\n Enter to confirm\\r\\n',
  'unknown-gate': 'Claude Code would like to enable shiny new telemetry.\\r\\n ' + M + ' Decline\\r\\n   Allow\\r\\n Enter to confirm\\r\\n',
  'trust-reworded': 'Quick safety check: do you vouch for this place?\\r\\n ' + M + ' Nope\\r\\n   Sure thing\\r\\n Enter to confirm\\r\\n',
  'signed-out': '',
  'silent': '',
}
if (mode === 'dies') process.exit(0)
let got = Buffer.alloc(0)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => { got = Buffer.concat([got, d]) })
process.stdout.write(SCREENS[mode] ?? '')
const live = '\\r\\n\\x1b[3G\\x1b[6Gbypass\\x1b[13Gpermissions\\x1b[25Gon\\r\\n'
const answerable = /^(trust-(no|yes)-first|bypass-no-first|channels(-flipped)?)$/.test(mode)
setTimeout(() => {
  fs.writeFileSync(keyFile, got.toString('hex') || 'none')
  if (!answerable && mode !== 'signed-out') return
  process.stdout.write(live + (mode === 'signed-out' ? '\\x1b[53GNot\\x1b[57Glogged\\x1b[64Gin\\x1b[69GRun\\x1b[73G/login\\r\\n' : ''))
}, answerable ? 2800 : 1200)
setTimeout(() => process.exit(0), 12000)
`

function runBlock(
  mode: string,
  { recordsKeys = true }: { recordsKeys?: boolean } = {},
): Promise<{ outcome: string; answered: string; screen: string; keys: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-gate-'))
  const sim = join(dir, 'sim.cjs')
  const keyFile = join(dir, 'keys.hex')
  const statusFile = join(dir, 'status.txt')
  const harness = join(dir, 'harness.exp')
  writeFileSync(sim, SIMULATOR)
  writeFileSync(
    harness,
    [
      'log_user 0',
      `spawn {${process.execPath}} {${sim}} {${mode}} {${keyFile}}`,
      `source {${blockPath}}`,
      `set f [open {${statusFile}} w]`,
      'puts $f "$hoai_outcome|$hoai_answered|$hoai_screen"',
      'close $f',
      // The simulator writes what it was SENT 1.2 s after painting a screen the
      // block will not answer. Outlive that, or "nothing was sent" is vacuous.
      'sleep 2',
      'catch {close}',
      'catch {wait}',
    ].join('\n'),
  )
  return new Promise((resolve, reject) => {
    const child = spawn(expectBin!, ['-f', harness], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (status) => {
      try {
        assert.equal(status, 0, `expect exited ${status} for ${mode}`)
        const [outcome = '', answered = '', screen = ''] = readFileSync(statusFile, 'utf8').trim().split('|')
        if (recordsKeys) assert.ok(existsSync(keyFile), `the simulator never recorded its input for ${mode}`)
        resolve({ outcome, answered, screen, keys: recordsKeys ? readFileSync(keyFile, 'utf8') : '' })
      } catch (err) {
        reject(err)
      }
    })
  })
}

// Several seconds of real PTY time per run; the runner's default budget is 5 s.
const SLOW = { timeout: 90_000 }

const DOWN_ENTER = '1b5b420d'
const ENTER = '0d'
const NOTHING = 'none'

test('behaviour: a gate whose DECLINING option is first gets Down then Enter', SLOW, async () => {
  if (!expectBin) return
  const [trust, bypass] = await Promise.all([runBlock('trust-no-first'), runBlock('bypass-no-first')])
  assert.deepEqual([trust.outcome, trust.answered, trust.keys], ['live', 'trust', DOWN_ENTER])
  assert.deepEqual([bypass.outcome, bypass.answered, bypass.keys], ['live', 'bypass', DOWN_ENTER])
})

test('behaviour: the same gate with the WANTED option first gets Enter alone', SLOW, async () => {
  if (!expectBin) return
  const flipped = await runBlock('trust-yes-first')
  assert.deepEqual([flipped.outcome, flipped.answered, flipped.keys], ['live', 'trust', ENTER])
})

test('behaviour: the dev-channels gate gets Enter as painted today, and Down then Enter if the order ever flips', SLOW, async () => {
  if (!expectBin) return
  const [today, flipped] = await Promise.all([runBlock('channels'), runBlock('channels-flipped')])
  assert.deepEqual([today.outcome, today.answered, today.keys], ['live', 'channels', ENTER])
  // The prose above the options says "local", so a rule keyed on that word would
  // read the prose, call the wanted option first, and press Enter on "Exit".
  assert.deepEqual([flipped.outcome, flipped.answered, flipped.keys], ['live', 'channels', DOWN_ENTER])
})

test('behaviour: a gate no rule recognises is named with its words, and NOT ONE byte is sent', SLOW, async () => {
  if (!expectBin) return
  const unknown = await runBlock('unknown-gate')
  assert.equal(unknown.outcome, 'gate-unrecognised')
  assert.equal(unknown.answered, '')
  assert.equal(unknown.keys, NOTHING, 'nothing may be pressed on a screen that was not recognised')
  assert.match(unknown.screen, /shiny new telemetry/)
})

test('behaviour: a recognised gate whose options cannot be read is not answered either', SLOW, async () => {
  if (!expectBin) return
  const reworded = await runBlock('trust-reworded')
  assert.equal(reworded.outcome, 'gate-unreadable:trust')
  assert.equal(reworded.keys, NOTHING)
  assert.match(reworded.screen, /vouch/)
})

test('behaviour: a claude that exits during startup is named, and a signed-out TUI is told apart from a working one', SLOW, async () => {
  if (!expectBin) return
  const [died, signedOut] = await Promise.all([runBlock('dies', { recordsKeys: false }), runBlock('signed-out')])
  assert.equal(died.outcome, 'exited-during-startup')
  assert.equal(signedOut.outcome, 'live-but-not-signed-in')
  assert.equal(signedOut.keys, NOTHING)
})
