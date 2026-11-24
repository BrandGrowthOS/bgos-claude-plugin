/**
 * The PURE half of "the watcher frees an agent stuck on the usage limit screen" (lib/limit-screen.mjs).
 *
 * The screens are hand written in the shape Claude Code 2.1.316 paints its rate limit options dialog
 * (docs/notes/feat/watcher-frees-limit-stuck.md section 1): the limit line, then a box titled
 * "What do you want to do?", the options with ONE pointer, and the "Enter to confirm" footer. No real
 * session is read; every screen here is a literal.
 *
 * Run: npx tsx --test test/limit-screen.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LIMIT_ENTER_MIN_INTERVAL_MS,
  UNSAFE_DIALOG_REASONS,
  accountAtLimitFrom,
  createReadLog,
  decideLimitFree,
  limitNoticeText,
  parseLimitNotice,
  readLimitScreen,
  usageBackFrom,
} from '../lib/limit-screen.mjs'
import { seatToken } from './helpers/claude-auth-status.ts'

const T0 = Date.parse('2026-11-01T16:39:03.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const RESETS_AT = Date.parse('2026-11-06T16:00:00.000Z')

const LIMIT_LINE = "  ⎿  You've hit your weekly limit · resets Nov 6, 8pm (Asia/Dubai)"
const DEFAULT_OPTIONS = ['Stop and wait for limit to reset', 'Wait here, then continue automatically at Nov 6, 8pm', 'Add funds to continue with usage credits']

/** The dialog as tmux capture-pane prints it: box borders, one pointer, numbered options. */
function picker(opts: { options?: string[]; selected?: number[]; pointer?: string; limit?: string | null; title?: string | null; footer?: string | null; eol?: string } = {}) {
  const options = opts.options ?? DEFAULT_OPTIONS
  const selected = opts.selected ?? [0]
  const pointer = opts.pointer ?? '❯'
  const rows = [
    ...(opts.limit === null ? [] : [opts.limit ?? LIMIT_LINE, '']),
    '╭──────────────────────────────────────────────────────╮',
    ...(opts.title === null ? [] : [`│ ${opts.title ?? 'What do you want to do?'}                              │`]),
    '│                                                      │',
    ...options.map((o, i) => `│ ${selected.includes(i) ? pointer : ' '} ${i + 1}. ${o}  │`),
    '│                                                      │',
    ...(opts.footer === null ? [] : [`│ ${opts.footer ?? 'Enter to confirm · Esc to cancel'}                     │`]),
    '╰──────────────────────────────────────────────────────╯',
  ]
  return rows.join(opts.eol ?? '\n')
}

// -- readLimitScreen: only the limit dialog with the pointer on "Stop and wait" is a screen to press ----

test('the limit dialog with the pointer on "Stop and wait for limit to reset" is the screen one Enter frees', () => {
  const seen = readLimitScreen(picker())
  assert.equal(seen.ok, true, seen.reason)
  assert.match(String(seen.limitLine), /You've hit your weekly limit/)
})

test('the Windows console paint: the ">" pointer fallback, CRLF rows, trailing spaces trimmed', () => {
  const text = picker({ pointer: '>', eol: '\r\n' })
    .split('\r\n')
    .map((row) => row.replace(/\s+$/, ''))
    .join('\r\n')
  assert.equal(readLimitScreen(text).ok, true)
})

test('the flipped order (flag tengu_jade_anvil_4): the pointer on "Add funds" is NOT pressed', () => {
  const seen = readLimitScreen(picker({ options: ['Add funds to continue with usage credits', 'Upgrade your plan', 'Stop and wait for limit to reset'], selected: [0] }))
  assert.equal(seen.ok, false)
  assert.equal(seen.reason, 'selection_elsewhere')
})

test('the pointer on "Wait here, then continue automatically" is not pressed either', () => {
  const seen = readLimitScreen(picker({ selected: [1] }))
  assert.deepEqual([seen.ok, seen.reason], [false, 'selection_elsewhere'])
})

test('two pointers, or none, inside the dialog: the selection cannot be read, no key', () => {
  assert.deepEqual(pick(readLimitScreen(picker({ selected: [0, 2] }))), [false, 'selection_unreadable'])
  assert.deepEqual(pick(readLimitScreen(picker({ selected: [] }))), [false, 'selection_unreadable'])
})

test('the dialog without the limit line above it is not called the limit screen', () => {
  assert.deepEqual(pick(readLimitScreen(picker({ limit: null }))), [false, 'no_limit_line'])
})

test('the limit line at an idle prompt (no dialog) is not the picker: no key', () => {
  const idle = [LIMIT_LINE, '', '╭────────────────────────────╮', '│ > ', '╰────────────────────────────╯', '  bypass permissions on'].join('\n')
  assert.deepEqual(pick(readLimitScreen(idle)), [false, 'no_picker'])
})

test('the spend limit menu (same title, other options) is not the usage limit picker', () => {
  const spend = picker({
    limit: "  ⎿  You've hit your monthly spend limit · your limit resets Dec 1",
    options: ['Adjust monthly spend limit: $50', 'Wait for limit to reset'],
    selected: [1],
  })
  assert.deepEqual(pick(readLimitScreen(spend)), [false, 'no_safe_option'])
})

test('no "Enter to confirm" footer: the words alone (an agent quoting the dialog in a reply) are not a screen to press', () => {
  const quoted = [LIMIT_LINE, '', '● The dialog said:', '  What do you want to do?', '  ❯ 1. Stop and wait for limit to reset'].join('\n')
  assert.deepEqual(pick(readLimitScreen(quoted)), [false, 'no_footer'])
})

test('an empty, missing or non text screen is never a screen to press', () => {
  for (const text of ['', '   \n  ', null, undefined, 42]) {
    assert.deepEqual(pick(readLimitScreen(text as any)), [false, 'empty'], String(text))
  }
})

test('the automatic continue line ("continuing automatically ... esc to cancel") is not the picker', () => {
  const armed = [LIMIT_LINE, '', '  Usage limit reached · continuing automatically at Nov 6, 8pm · esc to cancel'].join('\n')
  assert.equal(readLimitScreen(armed).ok, false)
})

// Review 1, item 2: the dialog must be the newest thing under the newest limit line, close to it,
// with nothing dialog-like below its footer.

test('a full quoted dialog, footer and all, ABOVE the newest limit line is not the picker', () => {
  const quoted = picker()
  const screen = [quoted, '', '● Here is the dialog you asked about.', '', LIMIT_LINE, '', '╭────────────────────────────╮', '│ > ', '╰────────────────────────────╯'].join('\n')
  assert.deepEqual(pick(readLimitScreen(screen)), [false, 'no_picker'])
})

test('the dialog far below the newest limit line is not taken for its picker', () => {
  const rows = picker().split('\n')
  const far = [rows[0], ...Array.from({ length: 12 }, (_, i) => `  line ${i} of something else`), ...rows.slice(1)].join('\n')
  assert.deepEqual(pick(readLimitScreen(far)), [false, 'limit_line_far'])
})

test('anything dialog like below the footer (another choice list, another footer) is not pressed', () => {
  const second = ['╭──────────────────────────╮', '│ Do you trust this folder? │', '│ ❯ 1. Yes                  │', '│   2. No                   │', '│ Enter to confirm          │', '╰──────────────────────────╯']
  assert.deepEqual(pick(readLimitScreen([picker(), ...second].join('\n'))), [false, 'below_footer'])
  assert.deepEqual(pick(readLimitScreen([picker(), '  Esc to cancel'].join('\n'))), [false, 'below_footer'])
})

test('two limit dialogs on one screen are never pressed: the newest copy could hide the real one (pointer on "Add funds")', () => {
  // A real picker with the flipped order and its pointer on "Add funds", and under it a copy with its
  // own limit line and its pointer on "Stop and wait" (text painted below an open dialog).
  const flipped = picker({ options: ['Add funds to continue with usage credits', 'Upgrade your plan', 'Stop and wait for limit to reset'], selected: [0] })
  const screen = [flipped, picker()].join('\n')
  assert.deepEqual(pick(readLimitScreen(screen)), [false, 'two_dialogs'])
  assert.ok(UNSAFE_DIALOG_REASONS.includes('two_dialogs'), 'the owner is told, not left with a silent "not up"')
  // A title alone (a reply quoting it) above the real picker is a second dialog too: refused, never guessed.
  assert.deepEqual(pick(readLimitScreen(['  The CLI asks: What do you want to do?', picker()].join('\n'))), [false, 'two_dialogs'])
})

test('the composer and the status line below the picker do not count as a dialog', () => {
  const screen = [picker(), '', '╭────────────────────────────╮', '│ > ', '╰────────────────────────────╯', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
  assert.equal(readLimitScreen(screen).ok, true, readLimitScreen(screen).reason)
})

function pick(seen: { ok: boolean; reason: string }) {
  return [seen.ok, seen.reason]
}

// -- usageBackFrom: usage is back only on proof, never a guess -------------------------------------------

// The proof a login gives is the ACCOUNT (lib/claude-account-id.mjs tokens), never a file's mtime.
// Two seats of one Team organization, in the CLI's real key set (orgId and email).
const ACCT_A = seatToken('a')
const ACCT_B = seatToken('b')

test('usage is back once the reset time from the transcript has passed (with a minute of grace)', () => {
  const limit = { atMs: T0, resetsAtMs: RESETS_AT }
  assert.deepEqual(usageBackFrom({ now: RESETS_AT + 30_000, limit, accountAtLimit: null, accountNow: null }), { back: false, how: null })
  assert.deepEqual(usageBackFrom({ now: RESETS_AT + 61_000, limit, accountAtLimit: null, accountNow: null }), { back: true, how: 'reset_passed' })
})

test('usage is back on a login only when the signed in ACCOUNT differs from the one at the limit', () => {
  const limit = { atMs: T0, resetsAtMs: RESETS_AT }
  const now = T0 + 20 * MIN
  assert.deepEqual(usageBackFrom({ now, limit, accountAtLimit: ACCT_A, accountNow: ACCT_B }), { back: true, how: 'login_changed' })
  // The same account again, or a token refresh that rewrote the credential file: no proof.
  assert.deepEqual(usageBackFrom({ now, limit, accountAtLimit: ACCT_A, accountNow: ACCT_A }), { back: false, how: null })
})

test('a failed or timed out status read (no account now, or none seen at the limit) is no proof: wait for the reset', () => {
  const limit = { atMs: T0, resetsAtMs: RESETS_AT }
  assert.deepEqual(usageBackFrom({ now: T0 + 20 * MIN, limit, accountAtLimit: ACCT_A, accountNow: null }), { back: false, how: null })
  assert.deepEqual(usageBackFrom({ now: T0 + 20 * MIN, limit, accountAtLimit: null, accountNow: ACCT_B }), { back: false, how: null })
  assert.deepEqual(usageBackFrom({ now: RESETS_AT + 2 * MIN, limit, accountAtLimit: ACCT_A, accountNow: null }), { back: true, how: 'reset_passed' })
})

test('no reset time and no account read: still limited, on every platform', () => {
  assert.deepEqual(usageBackFrom({ now: T0 + 30 * 24 * HOUR, limit: { atMs: T0, resetsAtMs: null }, accountAtLimit: null, accountNow: null }), { back: false, how: null })
})

// Ares's ruling (option A, 2026-11-02): once a press on the login proof was followed by the limit
// again, only the reset time counts for that agent until the reset passes.
test('a spent login proof is not proof: another account does not count, the reset time still does', () => {
  const limit = { atMs: T0, resetsAtMs: RESETS_AT }
  const moved = T0 + 2 * HOUR
  assert.deepEqual(usageBackFrom({ now: moved + MIN, limit, accountAtLimit: ACCT_A, accountNow: ACCT_B, loginProofSpent: true }), { back: false, how: null })
  assert.deepEqual(usageBackFrom({ now: moved + MIN, limit, accountAtLimit: ACCT_A, accountNow: ACCT_B, loginProofSpent: false }), { back: true, how: 'login_changed' })
  assert.deepEqual(usageBackFrom({ now: RESETS_AT + 2 * MIN, limit, accountAtLimit: ACCT_A, accountNow: ACCT_B, loginProofSpent: true }), { back: true, how: 'reset_passed' })
})

test('usageBackFrom takes no file time: an mtime alone is never proof', () => {
  const limit = { atMs: T0, resetsAtMs: RESETS_AT }
  assert.deepEqual(usageBackFrom({ now: T0 + 20 * MIN, limit, credentialsMtimeMs: T0 + 10 * MIN } as any), { back: false, how: null })
})

// -- decideLimitFree: the gates, in order ----------------------------------------------------------------

const LIMIT = { atMs: T0, resetsAtMs: RESETS_AT }
const BACK = { back: true, how: 'login_changed' }
const TMUX = { ok: true, kind: 'tmux' }
const SAFE = { ok: true, reason: 'limit_picker_on_safe_option' }

test('no limit in the transcript: nothing to do', () => {
  assert.equal(decideLimitFree({ now: T0, limit: null, usage: BACK, lastEnterAtMs: null, keyPath: TMUX, screen: SAFE }).act, 'none')
})

test('the limit is still on: C9 is reported, the screen is not even read, no key', () => {
  const d = decideLimitFree({ now: T0 + MIN, limit: LIMIT, usage: { back: false, how: null }, lastEnterAtMs: null, keyPath: TMUX, screen: undefined })
  assert.deepEqual([d.act, d.reason], ['report', 'still_limited'])
})

test('usage back and nothing read yet: read the screen first', () => {
  assert.equal(decideLimitFree({ now: T0 + MIN, limit: LIMIT, usage: BACK, lastEnterAtMs: null, keyPath: TMUX, screen: undefined }).act, 'read_screen')
})

test('usage back and the limit dialog on the safe choice: press ONE Enter', () => {
  const d = decideLimitFree({ now: T0 + MIN, limit: LIMIT, usage: BACK, lastEnterAtMs: null, keyPath: TMUX, screen: SAFE })
  assert.deepEqual([d.act, d.reason], ['press', 'login_changed'])
})

test('usage back, but the screen is unclear or unreadable: no key, the owner is told', () => {
  const unclear = decideLimitFree({ now: T0 + MIN, limit: LIMIT, usage: BACK, lastEnterAtMs: null, keyPath: TMUX, screen: { ok: false, reason: 'selection_elsewhere' } })
  assert.deepEqual([unclear.act, unclear.reason], ['report', 'screen_unclear:selection_elsewhere'])
  const unread = decideLimitFree({ now: T0 + MIN, limit: LIMIT, usage: BACK, lastEnterAtMs: null, keyPath: TMUX, screen: null })
  assert.deepEqual([unread.act, unread.reason], ['report', 'screen_unreadable'])
})

test('usage back but no way to send a key here (no tmux): no key, the owner gets the one tap fix', () => {
  const d = decideLimitFree({ now: T0 + MIN, limit: LIMIT, usage: BACK, lastEnterAtMs: null, keyPath: { ok: false, reason: 'no_tmux' }, screen: undefined })
  assert.deepEqual([d.act, d.reason], ['report', 'no_key_path:no_tmux'])
})

test('a clock that is not a number never opens the hour gate: wait, nothing read, no key', () => {
  for (const now of [Number.NaN, undefined, Number.POSITIVE_INFINITY]) {
    for (const lastEnterAtMs of [null, T0]) {
      const d = decideLimitFree({ now: now as any, limit: LIMIT, usage: BACK, lastEnterAtMs, keyPath: TMUX, screen: SAFE })
      assert.deepEqual([d.act, d.reason], ['wait', 'no_clock'], `now ${now}, last Enter ${lastEnterAtMs}`)
    }
  }
})

test('a second Enter inside the hour is refused, with the time the next one is allowed; at the hour it is allowed', () => {
  const pressedAt = T0 + 10 * MIN
  const held = decideLimitFree({ now: pressedAt + 59 * MIN, limit: LIMIT, usage: BACK, lastEnterAtMs: pressedAt, keyPath: TMUX, screen: SAFE })
  assert.deepEqual([held.act, held.reason, held.retryAtMs], ['wait', 'one_enter_per_hour', pressedAt + HOUR])
  const again = decideLimitFree({ now: pressedAt + HOUR, limit: LIMIT, usage: BACK, lastEnterAtMs: pressedAt, keyPath: TMUX, screen: SAFE })
  assert.equal(again.act, 'press')
  assert.equal(LIMIT_ENTER_MIN_INTERVAL_MS, HOUR)
})

test('invariant: press is decided ONLY with a limit, usage back, a key path, a safe screen and the hour spent (every combination)', () => {
  const limits = [null, LIMIT]
  const usages = [{ back: false, how: null }, BACK, { back: true, how: 'reset_passed' }]
  const enters = [null, T0, T0 - 2 * HOUR]
  const paths = [TMUX, { ok: true, kind: 'console' }, { ok: false, reason: 'no_tmux' }]
  const screens = [undefined, null, SAFE, { ok: false, reason: 'no_picker' }, { ok: false, reason: 'selection_elsewhere' }]
  let presses = 0
  for (const limit of limits)
    for (const usage of usages)
      for (const lastEnterAtMs of enters)
        for (const keyPath of paths)
          for (const screen of screens) {
            const d = decideLimitFree({ now: T0 + 5 * MIN, limit, usage, lastEnterAtMs, keyPath, screen })
            if (d.act !== 'press') continue
            presses += 1
            assert.ok(limit && usage.back && keyPath.ok && screen && (screen as any).ok === true, JSON.stringify({ limit, usage, lastEnterAtMs, keyPath, screen }))
            assert.ok(lastEnterAtMs === null || T0 + 5 * MIN - lastEnterAtMs >= HOUR)
          }
  assert.ok(presses > 0, 'some combination presses')
})

// -- the owner's notice: fixed words, built from tokens and times only ------------------------------------

const notice = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  key: '912:2026-11-01T16:54:00.000Z',
  outcome: 'freed',
  how: 'login_changed',
  why: null,
  limitAt: '2026-11-01T16:39:03.000Z',
  resetsAt: '2026-11-06T16:00:00.000Z',
  pressedAt: '2026-11-01T16:54:00.000Z',
  ...over,
})

test('freed: the owner reads when it stopped, why usage is back, that ONE Enter was pressed, and that it works again', () => {
  const text = limitNoticeText(parseLimitNotice(JSON.stringify(notice()))!)
  assert.match(text, /2026-11-01 16:39 UTC/)
  assert.match(text, /login on this computer changed/)
  assert.match(text, /pressed Enter once/)
  assert.match(text, /16:54 UTC/)
  assert.match(text, /working again/)
})

test('still limited after the Enter: the owner is told Claude still refuses and when the limit resets', () => {
  const text = limitNoticeText(parseLimitNotice(JSON.stringify(notice({ outcome: 'still_limited' })))!)
  assert.match(text, /still/)
  assert.match(text, /2026-11-06 16:00 UTC/)
  assert.doesNotMatch(text, /working again/)
})

test('still limited after a press on the login proof: the owner is told the watcher now waits for the reset time, and is never asked to resend', () => {
  const text = limitNoticeText(parseLimitNotice(JSON.stringify(notice({ outcome: 'still_limited', how: 'login_changed' })))!)
  assert.match(text, /waits for the limit to reset at 2026-11-06 16:00 UTC/)
  assert.doesNotMatch(text, /send|another Claude account|sign it in/i)
  const unknown = limitNoticeText(parseLimitNotice(JSON.stringify(notice({ outcome: 'still_limited', how: 'login_changed', resetsAt: null })))!)
  assert.match(unknown, /waits for the limit to reset/)
})

test('still limited never contradicts itself or promises a press: usage only LOOKED available, and the watcher waits before it presses again', () => {
  for (const how of ['reset_passed', 'login_changed'] as const) {
    const text = limitNoticeText(parseLimitNotice(JSON.stringify(notice({ outcome: 'still_limited', how })))!)
    assert.doesNotMatch(text, /usage is available again/, how)
    assert.match(text, /looked available again/, how)
    assert.match(text, /waits for the limit to reset at 2026-11-06 16:00 UTC before it presses again/, how)
    assert.doesNotMatch(text, /then presses|presses Enter once more/, `${how}: no promise the sweep may not keep (keep-alive off, the picker gone)`)
  }
})

test('cannot press (no tmux): the owner gets the one tap fix, Restart now, or Enter in the window', () => {
  const text = limitNoticeText(parseLimitNotice(JSON.stringify(notice({ outcome: 'cannot_press', why: 'no_tmux', pressedAt: null })))!)
  assert.match(text, /Restart now/)
  assert.match(text, /Stop and wait for limit to reset/)
  assert.doesNotMatch(text, /pressed Enter/)
})

test('a notice with an unknown token or a bad time is refused whole, so no text ever comes from the file', () => {
  for (const bad of [
    notice({ outcome: 'typed /login' }),
    notice({ how: 'guess' }),
    notice({ why: 'anything at all' , outcome: 'cannot_press' }),
    notice({ limitAt: 'yesterday' }),
    notice({ schemaVersion: 2 }),
    notice({ key: '' }),
  ]) {
    assert.equal(parseLimitNotice(JSON.stringify(bad)), null, JSON.stringify(bad))
  }
  assert.equal(parseLimitNotice('not json'), null)
  assert.equal(parseLimitNotice(null), null)
})

test('every notice is plain words: bounded, one paragraph, no dashes', () => {
  const outcomes = ['freed', 'closed', 'still_limited', 'not_taken']
  const whys = ['no_tmux', 'no_console', 'screen_unreadable', 'screen_unclear', 'selection_elsewhere', 'unsupported']
  const all = [...outcomes.map((outcome) => notice({ outcome })), ...whys.map((why) => notice({ outcome: 'cannot_press', why, pressedAt: null })), notice({ how: 'reset_passed' }), notice({ resetsAt: null })]
  for (const n of all) {
    const parsed = parseLimitNotice(JSON.stringify(n))
    assert.ok(parsed, JSON.stringify(n))
    const text = limitNoticeText(parsed)
    assert.ok(text.length > 40 && text.length <= 600, `${text.length}: ${text}`)
    assert.doesNotMatch(text, new RegExp('[\\u2013\\u2014]'))
    assert.doesNotMatch(text, /\n/)
  }
})

test('house style: no em or en dashes in the module or this test', () => {
  for (const path of ['../lib/limit-screen.mjs', './limit-screen.test.ts']) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, new RegExp('[\\u2013\\u2014]'), path)
  }
})

test('purity: the module imports nothing and touches no file, process, clock or network', () => {
  const source = readFileSync(fileURLToPath(new URL('../lib/limit-screen.mjs', import.meta.url)), 'utf8')
  assert.deepEqual([...source.matchAll(/^\s*import\s/gm)], [])
  assert.doesNotMatch(source, /child_process|node:fs|fetch\(|process\.|Date\.now\(|setTimeout|require\(/)
})

test('M2 (r4): the read log answers the last read started BEFORE a time, the newest answer of it, at most ten minutes back', () => {
  const log = createReadLog()
  const L = Date.UTC(2026, 10, 19, 12)
  log.note('k', L - 60_000, 'seat-a')
  log.note('k', L, 'seat-b') // started at the limit itself: a read since it, never one from before
  assert.deepEqual(log.before('k', L), { readAt: L - 60_000, account: 'seat-a' })
  log.note('k', L - 60_000, null) // a later answer of the same read (signed out) is the one that counts
  assert.deepEqual(log.before('k', L), { readAt: L - 60_000, account: null })
  assert.deepEqual(log.before('k', L + 9 * 60_000), { readAt: L, account: 'seat-b' })
  assert.equal(log.before('k', L + 10 * 60_000 + 1), null, 'over ten minutes old: no proof')
  assert.equal(log.before('other', L), null)
  log.note('k', Number.NaN, 'seat-c')
  assert.deepEqual(log.before('k', L), { readAt: L - 60_000, account: null }, 'a read with no time is never logged')
})

test('R5 (m-C): a read counts as from before a limit only if it ANSWERED before it, not only began before it', () => {
  const log = createReadLog()
  const L = Date.UTC(2026, 10, 24, 12)
  log.note('k', L - 120_000, 'seat-a', L - 118_000)
  log.note('k', L - 1000, 'seat-b', L + 2000) // began a second before the limit, answered after the owner changed login
  assert.deepEqual(log.before('k', L), { readAt: L - 120_000, account: 'seat-a' })
  assert.deepEqual(log.before('k', L + 3000), { readAt: L - 1000, account: 'seat-b' }, 'it answered before this later time')
  log.note('k', L - 60_000, 'seat-c') // no landing time: as before, its start dates it
  assert.deepEqual(log.before('k', L), { readAt: L - 60_000, account: 'seat-c' })
})

test('R5 (m-C): one read noted twice (by the reader and by the switcher, on the one shared log) keeps its FIRST landing', () => {
  const log = createReadLog()
  const L = Date.UTC(2026, 10, 24, 12)
  log.note('k', L - 60_000, 'seat-a', L - 50_000)
  log.note('k', L - 60_000, 'seat-a', L + 30_000) // the same read, handed on after the limit
  assert.deepEqual(log.before('k', L), { readAt: L - 60_000, account: 'seat-a' }, 'it answered before the limit')
})

test('R5 (M-A): the read log answers the FIRST read started since a limit, within five minutes of it', () => {
  const log = createReadLog()
  const L = Date.UTC(2026, 10, 24, 12)
  log.note('k', L - 1000, 'seat-a', L - 500)
  assert.equal(log.after('k', L), null, 'none started since the limit')
  log.note('k', L + 5 * 60_000 + 1, 'seat-a')
  assert.equal(log.after('k', L), null, 'one started past the window says nothing about the limit')
  log.note('k', L + 80_000, 'seat-b')
  log.note('k', L + 20_000, null) // signed out: an answer too
  log.note('k', L + 140_000, 'seat-c')
  assert.deepEqual(log.after('k', L), { readAt: L + 20_000, account: null })
  assert.deepEqual(log.after('k', L + 21_000), { readAt: L + 80_000, account: 'seat-b' })
  assert.equal(log.after('other', L), null)
})

test('R5: the account at a limit needs both reads to name the same account; a signed out or missing one is unknown', () => {
  const at = (account: string | null) => ({ readAt: 1, account })
  assert.equal(accountAtLimitFrom(at('seat-a'), at('seat-a')), 'seat-a')
  assert.equal(accountAtLimitFrom(at('seat-a'), at('seat-b')), null)
  assert.equal(accountAtLimitFrom(null, at('seat-a')), null, 'no read from before the limit')
  assert.equal(accountAtLimitFrom(at('seat-a'), null), null)
  assert.equal(accountAtLimitFrom(at(null), at(null)), null, 'signed out (or no email) on both: still unknown')
  assert.equal(accountAtLimitFrom(at('seat-a'), at(null)), null, 'the first read since it found the login signed out')
})
