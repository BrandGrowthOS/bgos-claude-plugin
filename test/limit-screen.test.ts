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
  decideLimitFree,
  limitNoticeText,
  parseLimitNotice,
  readLimitScreen,
  usageBackFrom,
} from '../lib/limit-screen.mjs'

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

function pick(seen: { ok: boolean; reason: string }) {
  return [seen.ok, seen.reason]
}

// -- usageBackFrom: usage is back only on proof, never a guess -------------------------------------------

test('usage is back once the reset time from the transcript has passed (with a minute of grace)', () => {
  const limit = { atMs: T0, resetsAtMs: RESETS_AT }
  assert.deepEqual(usageBackFrom({ now: RESETS_AT + 30_000, limit, credentialsMtimeMs: null }), { back: false, how: null })
  assert.deepEqual(usageBackFrom({ now: RESETS_AT + 61_000, limit, credentialsMtimeMs: null }), { back: true, how: 'reset_passed' })
})

test('usage is back when the Claude credential file changed AFTER the limit (a different login), by mtime only', () => {
  const limit = { atMs: T0, resetsAtMs: RESETS_AT }
  // Ares, 2026-11-01: the limit at 16:39:03, the credential file rewritten at 16:53:14.
  const swap = Date.parse('2026-11-01T16:53:14.966Z')
  assert.deepEqual(usageBackFrom({ now: swap + MIN, limit, credentialsMtimeMs: swap }), { back: true, how: 'login_changed' })
  assert.deepEqual(usageBackFrom({ now: swap + MIN, limit, credentialsMtimeMs: T0 - MIN }), { back: false, how: null })
  assert.deepEqual(usageBackFrom({ now: swap + MIN, limit, credentialsMtimeMs: T0 }), { back: false, how: null })
})

test('no reset time and no credential file (macOS keeps the login in the Keychain): still limited', () => {
  assert.deepEqual(usageBackFrom({ now: T0 + 30 * 24 * HOUR, limit: { atMs: T0, resetsAtMs: null }, credentialsMtimeMs: null }), { back: false, how: null })
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
