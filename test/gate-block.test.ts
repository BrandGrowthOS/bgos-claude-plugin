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
  const catchAll = lines.filter((line) => /-re "\(\.\*\)\$\{hoai_footer\}"/.test(line))
  assert.equal(catchAll.length, 1, 'one catch-all for a gate no rule recognises')
  assert.doesNotMatch(catchAll[0]!, /send|hoai_answer/, catchAll[0])
  assert.match(catchAll[0]!, /hoai_unrecognised/)
  const proc = code.slice(code.indexOf('proc hoai_unrecognised'), code.indexOf('while {$hoai_outcome eq ""}'))
  assert.doesNotMatch(proc, /\bsend\b/)
  assert.match(proc, /gate-unrecognised/)
})

test('gate block: a gate is its FOOTER phrase, not the bare word, and the match buffer is big enough to hold one', () => {
  // Found by review: hoai resumes sessions, so a transcript that says "can you
  // confirm the booking" is painted above the prompt. Keyed on the bare word,
  // the supervisor called that an unanswerable gate and killed a healthy agent.
  assert.match(code, /set hoai_footer "Enter\$\{hoai_gap\}to\$\{hoai_gap\}confirm"/)
  assert.doesNotMatch(code, /\)confirm\}/, 'no rule may key on the bare word any more')
  for (const gate of ['safety', 'Bypass', 'channels', 'Resuming']) {
    assert.match(code, new RegExp(`-re "${gate}\\(\\.\\*\\?\\)\\$\\{hoai_footer\\}"`), gate)
  }
  // The default buffer is 2000 bytes; a long paint pushed the gate word out before its footer arrived.
  assert.match(code, /^match_max 100000$/m)
  // Signed out is the PHRASE with gaps. The supervisor exits on it, and "/login" alone shows up in tips.
  assert.match(code, /-re "Not\$\{hoai_gap\}logged\$\{hoai_gap\}in"/)
  assert.doesNotMatch(code, /-re \{\/login\}/)
})

test('gate block: the Down arrow is sent only while the selection marker is NOT on the wanted option', () => {
  // The state is read off the screen (the option that follows the LAST marker),
  // never assumed, so a future Claude Code that lists "Yes" first gets Enter
  // alone instead of Down then Enter, which would select "No, exit".
  assert.match(code, /if \{\$state eq "avoid"\} \{[\s\S]{0,260}?send -- "\\x1b\\\[B"/)
  assert.match(code, /proc hoai_selected \{text want avoid\}/)
  assert.match(code, /foreach hit \[regexp -all -inline -indices -- \$hoai_mark \$text\] \{ set last/, 'the LAST marker wins: a repaint supersedes the first paint')
  // BOTH option words must be on the screen before any key goes out.
  assert.match(code, /if \{\[string first \$want \$body\] < 0 \|\| \[string first \$avoid \$body\] < 0\} \{\s*\n\s*set hoai_outcome "gate-unreadable:\$gate"/)
  // A selection that will not move is a named outcome, not an endless loop of Downs.
  assert.match(code, /if \{\$downs >= 4\} \{\s*\n\s*set hoai_outcome "gate-selection-stuck:\$gate"/)
})

test('gate block: no key goes out until the screen has been quiet, and the supervisor can ask for longer', () => {
  // MEASURED 2026-09-22 on a signed-in config: a Down sent within about 100 ms of
  // the footer painting is painted and NOT honoured, and the Enter a second
  // later declines. So the first key waits for a quiet second, not a fixed delay.
  const answer = code.slice(code.indexOf('proc hoai_answer'))
  assert.ok(answer.indexOf('hoai_wait_quiet') > 0, 'hoai_answer must wait for quiet')
  assert.ok(answer.indexOf('hoai_wait_quiet') < answer.indexOf('send --'), 'and it must do so BEFORE the first key')
  assert.doesNotMatch(answer.slice(0, answer.indexOf('send --')), /\bsleep 1\b/, 'a fixed settle is the timing bet this replaced')
  assert.match(code, /proc hoai_wait_quiet \{\} \{[\s\S]*?-timeout 1[\s\S]*?if \{\$hoai_extra_settle > 0\} \{ sleep \$hoai_extra_settle \}/)
  assert.match(code, /if \{!\[info exists hoai_extra_settle\]\} \{ set hoai_extra_settle 0 \}/, 'a consumer that sets nothing gets no extra wait')
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

/**
 * These tests return early where expect is not installed, and an early return reports PASS. So CI
 * sets HOAI_REQUIRE_EXPECT=1 (and installs expect), which turns a missing expect into a failure
 * instead of a green run that executed none of the tests that prove which byte is sent.
 */
function requireExpect(): void {
  assert.notEqual(process.env.HOAI_REQUIRE_EXPECT, '1', 'HOAI_REQUIRE_EXPECT=1 but expect is not installed')
}

const SIMULATOR = `
// SIMULATION, not Claude Code: paint one gate, repaint the selection marker on every Down the way
// the real TUI does, record the raw bytes received, and go "live" only if Enter lands on the
// WANTED option (otherwise leave, as the real CLI does), so the block's decisions are visible.
const fs = require('node:fs')
const [mode, keyFile] = process.argv.slice(2)
const M = '\\u276f'
const GATES = {
  'trust-no-first':   { head: 'Accessing workspace:\\r\\n Quick safety check: Is this a project you trust?', opts: ['No, exit', 'Yes, I trust this folder'], want: 1 },
  'trust-yes-first':  { head: 'Accessing workspace:\\r\\n Quick safety check: Is this a project you trust?', opts: ['Yes, I trust this folder', 'No, exit'], want: 0 },
  'trust-reset':      { head: 'Accessing workspace:\\r\\n Quick safety check: Is this a project you trust?', opts: ['No, exit', 'Yes, I trust this folder'], want: 1 },
  'trust-no-repaint': { head: 'Accessing workspace:\\r\\n Quick safety check: Is this a project you trust?', opts: ['No, exit', 'Yes, I trust this folder'], want: 1 },
  'bypass-no-first':  { head: 'WARNING: Claude Code running in Bypass Permissions mode', opts: ['No, exit', 'Yes, I accept'], want: 1 },
  'channels':         { head: 'WARNING: Loading development channels\\r\\n is for local channel development only.', opts: ['1. I am using this for local development', '2. Exit'], want: 0 },
  'channels-flipped': { head: 'WARNING: Loading development channels\\r\\n is for local channel development only.', opts: ['1. Exit', '2. I am using this for local development'], want: 1 },
  'trust-twice':      { head: 'Accessing workspace:\\r\\n Quick safety check: Is this a project you trust?', opts: ['No, exit', 'Yes, I trust this folder'], want: 1 },
  'decline-reworded': { head: 'Quick safety check: Is this a project you trust?', opts: ['No, leave', 'Yes, I trust this folder'], want: -1 },
  'resume':           { head: 'Resuming the full session will consume a substantial portion. We recommend resuming from a summary.', opts: ['1. Resume from summary (recommended)', '2. Resume full session as-is'], want: 0 },
  'resume-flipped':   { head: 'Resuming the full session will consume a substantial portion. We recommend resuming from a summary.', opts: ['1. Resume full session as-is', '2. Resume from summary (recommended)'], want: 1 },
  'unknown-gate':     { head: 'Claude Code would like to enable shiny new telemetry.', opts: ['Decline', 'Allow'], want: -1 },
  'trust-reworded':   { head: 'Quick safety check: do you vouch for this place?', opts: ['Nope', 'Sure thing'], want: -1 },
}
if (mode === 'dies') process.exit(0)
const LIVE = '\\r\\n\\x1b[3G\\x1b[6Gbypass\\x1b[13Gpermissions\\x1b[25Gon\\r\\n'
const gate = GATES[mode]
let sel = 0, downs = 0, got = Buffer.alloc(0)
const lines = () => gate.opts.map((o, i) => ' ' + (i === sel ? M : ' ') + ' ' + o).join('\\r\\n')
const save = () => fs.writeFileSync(keyFile, got.toString('hex') || 'none')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let enters = 0
process.stdin.on('data', (d) => {
  got = Buffer.concat([got, d])
  save()
  const text = d.toString('latin1')
  if (gate && text.includes('\\x1b[B')) {
    sel = (sel + 1) % gate.opts.length
    downs += 1
    if (mode !== 'trust-no-repaint') process.stdout.write('\\x1b[2A' + lines() + '\\r\\n')
    // a VISIBLE reset: the marker goes back to the declining option once, with no key pressed
    if (mode === 'trust-reset' && downs === 1) setTimeout(() => { sel = 0; process.stdout.write('\\x1b[2A' + lines() + '\\r\\n') }, 300)
  }
  if (text.includes('\\r')) {
    enters += 1
    // the SAME gate painted again after it was answered: the block must not answer it twice
    if (mode === 'trust-twice' && enters === 1) { sel = 0; setTimeout(() => process.stdout.write(gate.head + '\\r\\n' + lines() + '\\r\\n Enter to confirm\\r\\n'), 200); return }
    if (gate && sel === gate.want) setTimeout(() => process.stdout.write(LIVE), 200)
    else setTimeout(() => process.exit(0), 100)
  }
})
if (gate) process.stdout.write(gate.head + '\\r\\n' + lines() + '\\r\\n Enter to confirm\\r\\n')
// a resumed transcript that SAYS confirm, then a perfectly healthy live footer a moment later
if (mode === 'resumed-transcript') { process.stdout.write('> Can you confirm the booking for Friday? Press Enter to confirm it.\\r\\n'); setTimeout(() => process.stdout.write(LIVE), 400) }
// signed IN, with a tip line that merely mentions /login
if (mode === 'login-tip') setTimeout(() => process.stdout.write(LIVE + ' Tip: run /login to switch accounts\\r\\n'), 200)
if (mode === 'signed-out') setTimeout(() => process.stdout.write(LIVE + '\\x1b[53GNot\\x1b[57Glogged\\x1b[64Gin\\x1b[69GRun\\x1b[73G/login\\r\\n'), 200)
// a screen the block will not answer: say what was SENT (nothing, if the rule holds) once it has had its chance
if (!gate || gate.want < 0) setTimeout(save, 2500)
setTimeout(save, 1500)
setTimeout(() => process.exit(0), 20000)
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
      // The simulator writes what it was SENT 2.5 s after painting a screen the
      // block will not answer. Outlive that, or "nothing was sent" is vacuous.
      'sleep 3',
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
  if (!expectBin) return requireExpect()
  const [trust, bypass] = await Promise.all([runBlock('trust-no-first'), runBlock('bypass-no-first')])
  assert.deepEqual([trust.outcome, trust.answered, trust.keys], ['live', 'trust', DOWN_ENTER])
  assert.deepEqual([bypass.outcome, bypass.answered, bypass.keys], ['live', 'bypass', DOWN_ENTER])
})

test('behaviour: the same gate with the WANTED option first gets Enter alone', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const flipped = await runBlock('trust-yes-first')
  assert.deepEqual([flipped.outcome, flipped.answered, flipped.keys], ['live', 'trust', ENTER])
})

test('behaviour: the dev-channels gate gets Enter as painted today, and Down then Enter if the order ever flips', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const [today, flipped] = await Promise.all([runBlock('channels'), runBlock('channels-flipped')])
  assert.deepEqual([today.outcome, today.answered, today.keys], ['live', 'channels', ENTER])
  // The prose above the options says "local", so a rule keyed on that word would
  // read the prose, call the wanted option first, and press Enter on "Exit".
  assert.deepEqual([flipped.outcome, flipped.answered, flipped.keys], ['live', 'channels', DOWN_ENTER])
})

test('behaviour: a selection that visibly goes BACK to the declining option is moved again, never confirmed there', SLOW, async () => {
  if (!expectBin) return requireExpect()
  // The marker returns to "No, exit" 300 ms after the first Down, with no key
  // pressed. Two options wrap, so getting back to "Yes" from there takes one more
  // Down; from the block's side that is Down (Yes), reset (No), Down (Yes).
  const reset = await runBlock('trust-reset')
  assert.equal(reset.outcome, 'live')
  assert.equal(reset.answered, 'trust')
  assert.equal(reset.keys, '1b5b421b5b420d', 'Down, then Down again after the reset, then Enter')
})

test('behaviour: a Down that draws no readable repaint is taken at its word, once, as a timed answer always was', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const blind = await runBlock('trust-no-repaint')
  assert.deepEqual([blind.outcome, blind.answered, blind.keys], ['live', 'trust', DOWN_ENTER])
})

test('behaviour: a gate painted AGAIN after it was answered is not answered twice', SLOW, async () => {
  if (!expectBin) return requireExpect()
  // The rule that stops a recurring word from typing Enters into a live REPL.
  // Review showed it was pinned by a regex over the source only: with the guard
  // dead but its words still present the whole suite stayed green.
  const twice = await runBlock('trust-twice')
  assert.equal(twice.outcome, 'gate-repeated:trust')
  assert.equal(twice.keys, DOWN_ENTER, 'one answer, and not one byte more')
})

test('behaviour: with only the WANTED option readable nothing is pressed, because "it is painted first" would be a guess', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const reworded = await runBlock('decline-reworded')
  assert.equal(reworded.outcome, 'gate-unreadable:trust')
  assert.equal(reworded.keys, NOTHING)
})

test('behaviour: the session-age gate gets "Resume from summary" in either option order', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const [today, flipped] = await Promise.all([runBlock('resume'), runBlock('resume-flipped')])
  assert.deepEqual([today.outcome, today.answered, today.keys], ['live', 'resume', ENTER])
  assert.deepEqual([flipped.outcome, flipped.answered, flipped.keys], ['live', 'resume', DOWN_ENTER])
})

test('behaviour: a resumed transcript that SAYS "confirm", and a tip that mentions /login, do not get a healthy session killed', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const [transcript, tip] = await Promise.all([runBlock('resumed-transcript'), runBlock('login-tip')])
  assert.deepEqual([transcript.outcome, transcript.answered, transcript.keys], ['live', '', NOTHING])
  assert.deepEqual([tip.outcome, tip.keys], ['live', NOTHING])
})

test('behaviour: a gate no rule recognises is named with its words, and NOT ONE byte is sent', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const unknown = await runBlock('unknown-gate')
  assert.equal(unknown.outcome, 'gate-unrecognised')
  assert.equal(unknown.answered, '')
  assert.equal(unknown.keys, NOTHING, 'nothing may be pressed on a screen that was not recognised')
  assert.match(unknown.screen, /shiny new telemetry/)
})

test('behaviour: a recognised gate whose options cannot be read is not answered either', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const reworded = await runBlock('trust-reworded')
  assert.equal(reworded.outcome, 'gate-unreadable:trust')
  assert.equal(reworded.keys, NOTHING)
  assert.match(reworded.screen, /vouch/)
})

test('behaviour: a claude that exits during startup is named, and a signed-out TUI is told apart from a working one', SLOW, async () => {
  if (!expectBin) return requireExpect()
  const [died, signedOut] = await Promise.all([runBlock('dies', { recordsKeys: false }), runBlock('signed-out')])
  assert.equal(died.outcome, 'exited-during-startup')
  assert.equal(signedOut.outcome, 'live-but-not-signed-in')
  assert.equal(signedOut.keys, NOTHING)
})
