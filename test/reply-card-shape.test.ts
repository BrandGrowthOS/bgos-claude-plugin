/**
 * THE REPLY THAT SHOULD HAVE BEEN A CARD (lib/reply-card-shape.ts).
 *
 * Measured 2026-10-25, read only on production: 61 of 63 live Claude Code
 * daemons tell their agent it can send a ui_card, and none was sent in 14
 * days. KC asked Mark to draft an email and got a code block. A line on every
 * message is too heavy for a simple reply, so the reply tool names a card
 * only when the reply just sent is card shaped. This file holds the
 * classifier to its four shapes and to the near misses it must leave alone,
 * and the per chat memory to once in 30 minutes.
 *
 * Run with: npx tsx --test test/reply-card-shape.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CARD_NUDGE_WINDOW_MS,
  MIN_CARD_SHAPED_CHARS,
  ReplyCardNudges,
  UI_CARD,
  cardNudgeLine,
  classify,
} from '../lib/reply-card-shape.ts'
import { DECLARED_CAPABILITIES_BASE } from '../lib/declared-capabilities.ts'

// ── card shaped replies ──────────────────────────────────────────────────────

/** Mark's reply to KC, the shape of 2026-10-25: the draft in a code block. */
const EMAIL_IN_CODE_BLOCK = [
  'Here is the draft for Sarah, ready to paste:',
  '',
  '```',
  'To: sarah.lee@pjprestaurants.com',
  'Cc: ahmad@pjprestaurants.com',
  'Subject: October LTO results and the November plan',
  '',
  'Hi Sarah,',
  '',
  'The October LTO closed at 4.2 percent over plan across the 38 stores, with the',
  'strongest lift in the Dubai cluster. I have attached the store level sheet.',
  '',
  'For November I suggest we keep the same price point and move the spend to',
  'delivery apps. Can we review on Tuesday?',
  '',
  'Best,',
  'Kc',
  '```',
].join('\n')

/** The same draft as prose, the headers in bold and no code block. */
const EMAIL_IN_PROSE = [
  'Drafted it. Have a look before I send:',
  '',
  '**To:** marketing-team@pjprestaurants.com',
  '**Subject:** Store visit schedule for the week of 3 November',
  '',
  'Hi team,',
  '',
  'Next week I will visit the Marina, JLT and Al Barsha stores on Monday and',
  'Tuesday, then Sharjah on Wednesday. Please have the October P and L and the',
  'local marketing calendar ready for each visit, and flag anything that needs a',
  'decision on the spot so we can settle it in the store.',
  '',
  'Thanks,',
  'Kc',
].join('\n')

const TABLE = [
  'Here is how the four regions did last week against plan:',
  '',
  '| Region | Sales | Plan | Variance |',
  '| --- | ---: | ---: | ---: |',
  '| Dubai | 412,300 | 398,000 | +3.6% |',
  '| Abu Dhabi | 221,950 | 230,000 | -3.5% |',
  '| Sharjah | 133,400 | 128,000 | +4.2% |',
  '| Northern Emirates | 87,120 | 90,500 | -3.7% |',
  '',
  'Dubai and Sharjah carried the week; Abu Dhabi is down on delivery.',
].join('\n')

const STATUS_LIST = [
  'Where the launch checklist stands this morning:',
  '',
  '- ✅ Menu boards printed and delivered to all 38 stores',
  '- ✅ POS buttons configured and tested in the Marina store',
  '- ⏳ Delivery app listings, waiting on the Talabat account manager',
  '- ❌ Radio spot, the agency missed the Friday deadline',
  '- ✅ Staff briefing pack sent to every store manager',
  '- 🚧 Social calendar, two of the six posts still in design',
  '',
  'The radio spot is the only thing that can move the date.',
].join('\n')

const STATUS_LIST_WORDS = [
  'Ticket review for the sprint:',
  '',
  '1. **Done**: the export pack zips the session folder without the cache',
  '2. **Blocked**: the Windows relaunch, needs a signed helper from IT',
  '3. **Open**: the reply overdue sweep counts a room message twice',
  '4. **Pending**: the doctor RPC answer, waiting on the backend deploy',
  '5. **Failed**: the Linux watcher test, flaky on the CI runner again',
  '6. **Done**: the clone hooks follow the release now',
].join('\n')

const COMPARISON = [
  'Two ways to run the November promotion:',
  '',
  '**Option A: Bundle deal**',
  '- Price: AED 59 for two mediums and a side',
  '- Cost: about AED 18,000 in margin over the month',
  '- Expected lift: 6 to 8 percent in orders',
  '- Risk: cannibalises the existing two medium offer',
  '',
  '**Option B: Delivery free over AED 50**',
  '- Price: no change to the menu',
  '- Cost: about AED 24,000 in delivery subsidies',
  '- Expected lift: 4 to 5 percent, mostly on delivery',
  '- Risk: the aggregators may not co-fund it',
  '',
  'I lean to A because it is cheaper and easier to explain in store.',
].join('\n')

/** Options under plain headings, named as a choice by the heading above them. */
const COMPARISON_HEADINGS = [
  '## Postgres on the existing server vs a managed database',
  '',
  '### Postgres on the existing server',
  'Cost: nothing extra, it shares the box',
  'Setup: one migration, an hour of work',
  'Backups: the nightly dump we already run',
  '',
  '### Managed database',
  'Cost: about 40 dollars a month',
  'Setup: a new connection string and a data copy',
  'Backups: point in time restore, built in',
  '',
  'Either works; the managed one buys peace of mind for the price of a lunch.',
].join('\n')

const COMPARISON_PLANS = [
  'Two plans for the Ramadan push, same budget either way:',
  '',
  '**Plan 1**',
  '- Cost: AED 40,000 over four weeks',
  '- Reach: about 600,000 on Instagram and TikTok',
  '- Risk: creative fatigue by week three',
  '',
  '**Plan 2**',
  '- Cost: AED 40,000 over four weeks',
  '- Reach: about 350,000 on radio and outdoor',
  '- Risk: hard to measure, no click data',
].join('\n')

/** The same two headings and fields, with nothing that names them as a choice. */
const UNNAMED_HEADINGS = [
  '### Postgres on the existing server',
  'Cost: nothing extra, it shares the box',
  'Setup: one migration, an hour of work',
  'Backups: the nightly dump we already run',
  '',
  '### Managed database',
  'Cost: about 40 dollars a month',
  'Setup: a new connection string and a data copy',
  'Backups: point in time restore, built in',
  '',
  'Either works; the managed one buys peace of mind for the price of a lunch.',
].join('\n')

// ── near misses: each one stays prose ────────────────────────────────────────

const SHORT_REPLY = 'Done. The sheet is updated and I sent the link to Ahmad. Anything else?'

/** Card shaped, but under 300 characters: too small to be worth a card. */
const SHORT_TABLE = ['| A | B |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'].join('\n')

const SHELL_COMMANDS = [
  'Run these on the server to rotate the logs and restart the backend:',
  '',
  '```bash',
  'ssh deploy@backend.internal',
  'cd /srv/bgos && docker compose ps',
  'sudo logrotate --force /etc/logrotate.d/bgos',
  'docker compose restart backend',
  'docker compose logs --tail 200 backend | grep -i error',
  'curl -fsS https://backend.internal/api/v1/health | jq .',
  'exit',
  '```',
  '',
  'If the health check answers anything but ok, send me the last 200 lines.',
].join('\n')

const TWO_ROW_TABLE = [
  'The two stores you asked about, side by side for the last full week of trading:',
  '',
  '| Store | Sales | Orders | Average ticket |',
  '| --- | ---: | ---: | ---: |',
  '| Marina | 61,200 | 1,140 | 53.7 |',
  '| JLT | 48,900 | 1,002 | 48.8 |',
  '',
  'Marina is ahead on both orders and ticket, which matches the footfall data we saw.',
].join('\n')

const SHORT_STEPS = [
  'To reset it:',
  '1. Open Settings',
  '2. Tap Account',
  '3. Tap Sign out',
  '4. Sign back in',
  '5. Done',
].join('\n')

const LONG_STEPS = [
  'Here is how to export the report from the dashboard:',
  '',
  '1. Open the Sales dashboard and pick the region filter at the top right.',
  '2. Set the date range to the last full month, not month to date.',
  '3. Open the three dot menu above the store table and choose Export.',
  '4. Pick CSV rather than Excel so the numbers keep their full precision.',
  '5. Open the file and check the totals row against the dashboard header.',
  '6. Upload it to the shared folder under Reports, then October.',
].join('\n')

const PROSE_WITH_SUBJECT = [
  'I read through the thread. The subject: whether we keep the bundle price in',
  'November. Sarah wants to hold it, Ahmad wants to cut it by five dirhams, and',
  'nobody has looked at the delivery mix yet, which is where most of the margin',
  'went last month. I would get the delivery split first, then decide. To: be',
  'fair to Ahmad, his number assumes the aggregators co-fund the cut, which they',
  'did in September.',
].join('\n')

const MIXED_LIST = [
  'Notes from the store visit this morning, in the order I saw them:',
  '',
  '- Done: the new menu boards are up and look good from the counter',
  '- The oven on the left runs hot, the manager has logged a ticket',
  '- Blocked: the delivery tablet will not update, needs IT',
  '- Two of the staff have not had the LTO briefing yet',
  '- Open: the drive through sign is still showing the September offer',
  '- The car park lights are out on the far side',
].join('\n')

const TABLE_IN_CODE = [
  'This is the markdown the template expects, paste it as is into the wiki page:',
  '',
  '```markdown',
  '| Field | Type | Required |',
  '| --- | --- | --- |',
  '| store_id | string | yes |',
  '| region | string | yes |',
  '| opened_at | date | no |',
  '```',
  '',
  'Keep the header row exactly as written, the importer matches on those names.',
].join('\n')

const UNLIKE_OPTIONS = [
  '**Option A**',
  '- Price: AED 59 for the bundle, two mediums and a side, all month long',
  '- Channel: in store and delivery both, with the same menu boards',
  '',
  '**Option B**',
  '- Audience: students only, verified at the counter with a card',
  '- Timing: weekday afternoons between two and five, for six weeks',
  '',
  'These are two different ideas, not two versions of one.',
].join('\n')

// Review 2026-10-25 (PR #277): code that SENDS email is not an email draft.

const NODEMAILER = [
  'This is the send in the signup handler, after the account row is written:',
  '',
  '```ts',
  "import nodemailer from 'nodemailer'",
  '',
  'const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: 587 })',
  '',
  'await transporter.sendMail({',
  '  from: SUPPORT_ADDRESS,',
  '  to: user.email,',
  "  subject: 'Welcome to HOAI, confirm your address',",
  '  html: renderWelcome(user),',
  '})',
  '```',
  '',
  'It runs after the commit, so a failed send never rolls back the signup.',
].join('\n')

const EMAIL_DTO = [
  'The draft endpoint takes this body; the backend validates it with class-validator:',
  '',
  '```ts',
  'export interface EmailDraftDto {',
  '  to: string[];',
  '  cc?: string[];',
  '  subject: string;',
  '  body: string;',
  '  sendAt?: string;',
  '}',
  '```',
  '',
  'An empty `to` array is a 400, and so is a subject over 200 characters, so the client',
  'must check both before it posts the draft.',
].join('\n')

const SEND_MAIL_STEP = [
  'Add this step at the end of the release job so the team hears about a failed build:',
  '',
  '```yaml',
  '- name: Send mail',
  '  if: failure()',
  '  uses: dawidd6/action-send-mail@v3',
  '  with:',
  '    server_address: smtp.gmail.com',
  '    to: ops@example.com',
  '    subject: Release ${{ github.ref_name }} failed',
  '    body: See ${{ github.server_url }}/${{ github.repository }}/actions',
  '```',
].join('\n')

// Review 2026-10-25 (PR #277): ordinary structured reports are not comparisons.

const REVIEW_FINDINGS = [
  'Three findings from the review, most severe first:',
  '',
  '**1. The pager skips the last page**',
  '- File: lib/pager.ts:88',
  '- Scenario: 41 items at a page size of 20 never show item 41',
  '- Confidence: high',
  '',
  '**2. The retry loop never backs off**',
  '- File: lib/retry.ts:23',
  '- Scenario: a 503 storm retries every 10 ms until the socket dies',
  '- Confidence: medium',
].join('\n')

const INSTALL_STEPS = [
  'Install it the same way on both machines, only the package manager differs:',
  '',
  '### macOS',
  '- Install: brew install hoai',
  '- Configure: hoai init --token $HOAI_TOKEN',
  '- Verify: hoai doctor, every row should read OK',
  '',
  '### Windows',
  '- Install: winget install hoai',
  '- Configure: hoai init --token %HOAI_TOKEN%',
  '- Verify: hoai doctor, every row should read OK',
].join('\n')

const BEFORE_AFTER = [
  'The cache change, before and after, measured on the same staging box:',
  '',
  '**Before**',
  '- Load time: 4.1 s on a cold cache',
  '- Bundle: 2.3 MB of JavaScript',
  '- Requests: 48 on the first paint',
  '',
  '**After**',
  '- Load time: 1.6 s on a cold cache',
  '- Bundle: 1.1 MB of JavaScript',
  '- Requests: 19 on the first paint',
  '',
  'Most of the win is the vendor chunk, which now loads after the first paint.',
].join('\n')

const PR_STATUS = [
  'Where the open pull requests stand this morning:',
  '',
  '### #271 doctor RPC answers',
  '- Status: merged',
  '- CI: green on Linux and Windows',
  '- Reviewer: Ares',
  '',
  '### #268 clone follows the release',
  '- Status: open, one change requested',
  '- CI: red, the Windows watcher test',
  '- Reviewer: Data',
  '',
  'Only #268 needs you: the Windows watcher test has failed on the last three runs.',
].join('\n')

/** "Plan a" is a verb and an article, not Plan A. */
const PLAN_A_VERB = [
  'Two things to set up before the launch week:',
  '',
  'Plan a site visit to every Dubai store',
  '- Cost: AED 2,000 in fuel and parking',
  '- Effort: two days for one area manager',
  '- Risk: the Marina manager is on leave',
  '',
  'Plan a training session for the new delivery staff',
  '- Cost: AED 1,500 for the room and lunch',
  '- Effort: half a day for the trainer',
  '- Risk: the night shift cannot attend',
].join('\n')

/** Task boxes render as task boxes since app 5.9.0; a checklist is not a status list. */
const CHECKLIST = [
  'The launch checklist as it stands this morning:',
  '',
  '- [x] Menu boards printed and delivered to all 38 stores',
  '- [x] POS buttons configured and tested in the Marina store',
  '- [ ] Delivery app listings, waiting on the Talabat account manager',
  '- [ ] Radio spot, the agency missed the Friday deadline',
  '- [x] Staff briefing pack sent to every store manager',
  '- [ ] Social calendar, two of the six posts still in design',
].join('\n')

const CASES: Array<{ name: string; text: string; shape: string | null }> = [
  { name: 'an email draft in a code block (Mark, 2026-10-25)', text: EMAIL_IN_CODE_BLOCK, shape: 'email_draft' },
  { name: 'an email draft in prose with bold headers', text: EMAIL_IN_PROSE, shape: 'email_draft' },
  { name: 'a markdown table of four rows', text: TABLE, shape: 'table' },
  { name: 'a status list led by emoji', text: STATUS_LIST, shape: 'status_list' },
  { name: 'a status list led by bold status words', text: STATUS_LIST_WORDS, shape: 'status_list' },
  { name: 'two options with the same labelled fields', text: COMPARISON, shape: 'comparison' },
  { name: 'two options under headings named as a choice (A vs B)', text: COMPARISON_HEADINGS, shape: 'comparison' },
  { name: 'Plan 1 and Plan 2 with the same fields', text: COMPARISON_PLANS, shape: 'comparison' },
  { name: 'a short reply', text: SHORT_REPLY, shape: null },
  { name: 'a card shaped table under 300 characters', text: SHORT_TABLE, shape: null },
  { name: 'a code block of shell commands', text: SHELL_COMMANDS, shape: null },
  { name: 'a two row table', text: TWO_ROW_TABLE, shape: null },
  { name: 'a plain numbered list of steps under 300 characters', text: SHORT_STEPS, shape: null },
  { name: 'a long numbered list of steps (Open is a verb here)', text: LONG_STEPS, shape: null },
  { name: 'prose that says subject: and To: mid sentence', text: PROSE_WITH_SUBJECT, shape: null },
  { name: 'a list where only some items carry a status', text: MIXED_LIST, shape: null },
  { name: 'a markdown table inside a code block', text: TABLE_IN_CODE, shape: null },
  { name: 'two options with different fields', text: UNLIKE_OPTIONS, shape: null },
  { name: 'empty text', text: '', shape: null },
  { name: 'nodemailer sendMail code in a ts fence', text: NODEMAILER, shape: null },
  { name: 'a TypeScript EmailDraftDto interface', text: EMAIL_DTO, shape: null },
  { name: 'a GitHub Actions send mail step', text: SEND_MAIL_STEP, shape: null },
  { name: 'review findings (File, Scenario, Confidence)', text: REVIEW_FINDINGS, shape: null },
  { name: 'install steps per platform', text: INSTALL_STEPS, shape: null },
  { name: 'a before and after summary', text: BEFORE_AFTER, shape: null },
  { name: 'per pull request status (Status, CI)', text: PR_STATUS, shape: null },
  { name: 'two headings with the same fields and no choice named', text: UNNAMED_HEADINGS, shape: null },
  { name: '"Plan a ..." is not Plan A', text: PLAN_A_VERB, shape: null },
  { name: 'a task box checklist', text: CHECKLIST, shape: null },
]

for (const c of CASES) {
  test(`classify: ${c.name} -> ${c.shape ?? 'null'}`, () => {
    if (c.shape) {
      assert.ok(c.text.length >= MIN_CARD_SHAPED_CHARS, `fixture is at least ${MIN_CARD_SHAPED_CHARS} characters`)
    }
    assert.equal(classify(c.text), c.shape)
  })
}

test('classify: the near misses that are long enough are long enough', () => {
  // So a null above is the classifier's judgement, not the length floor.
  for (const text of [
    SHELL_COMMANDS,
    TWO_ROW_TABLE,
    LONG_STEPS,
    PROSE_WITH_SUBJECT,
    MIXED_LIST,
    TABLE_IN_CODE,
    UNLIKE_OPTIONS,
    NODEMAILER,
    EMAIL_DTO,
    SEND_MAIL_STEP,
    REVIEW_FINDINGS,
    INSTALL_STEPS,
    BEFORE_AFTER,
    PR_STATUS,
    UNNAMED_HEADINGS,
    PLAN_A_VERB,
    CHECKLIST,
  ]) {
    assert.ok(text.length >= MIN_CARD_SHAPED_CHARS, text.slice(0, 40))
  }
  assert.ok(SHORT_STEPS.length < MIN_CARD_SHAPED_CHARS)
  assert.ok(SHORT_TABLE.length < MIN_CARD_SHAPED_CHARS)
})

test('classify: email code stays null without its language tag too', () => {
  // The line rule holds on its own: indented, lower case, braces, a trailing
  // comma or semicolon. A fence with no tag is where Mark's draft was.
  for (const text of [NODEMAILER, EMAIL_DTO, SEND_MAIL_STEP]) {
    const untagged = text.replace(/^```\w+$/m, '```')
    assert.notEqual(untagged, text)
    assert.equal(classify(untagged), null, untagged.slice(0, 60))
  }
})

test('classify: unindented code key lines in an untagged fence are not headers', () => {
  const lines = (to: string, subject: string) =>
    ['The payload, as the worker logs it before the send:', '', '```', to, subject, 'html: body,', '```', '', 'x'.repeat(300)].join('\n')
  assert.equal(classify(lines('to: user.email,', "subject: 'Welcome',")), null, 'key: value, shapes')
  assert.equal(classify(lines('"To": "ops@example.com",', '"Subject": "Deploy"')), null, 'quotes before the colon')
  assert.equal(classify(lines('To: string[];', 'Subject: string;')), null, 'semicolons')
  assert.equal(classify(lines('To: { name, address }', 'Subject: { text }')), null, 'braces')
  // And the real draft shape in that fence still counts.
  assert.equal(classify(lines('To: ops@example.com', 'Subject: Deploy finished')), 'email_draft')
})

test('classify: an email draft in a text fence still counts', () => {
  assert.equal(classify(EMAIL_IN_CODE_BLOCK.replace('```\nTo:', '```text\nTo:')), 'email_draft')
})

test('classify: a checklist with a status word after the box is still not a status list', () => {
  assert.equal(classify(CHECKLIST.replace(/\] /g, '] Done: ')), null)
})

// ── cost: the inputs the review measured, each under 50 ms ───────────────────

const PREFIX = 'Here is the summary you asked for, with the details below. '.repeat(6) + '\n'

function costOf(text: string): number {
  const started = performance.now()
  classify(text)
  return performance.now() - started
}

const COSTLY: Array<{ name: string; text: string }> = [
  // 9.5 s in the review, 6.1 s here on 619746f (the label regex).
  { name: 'one line of done and 20,000 spaces', text: PREFIX + 'done' + ' '.repeat(20_000) },
  // 6.9 s in the review, 8.8 s here on 619746f.
  { name: '500 lines with 1,000 trailing spaces', text: Array.from({ length: 500 }, () => 'done' + ' '.repeat(1000)).join('\n') },
  // Every Subject compared with every recipient: 1.7 s here on 619746f.
  {
    name: '20,000 Subject lines and 20,000 recipient lines',
    text: [...Array(20_000).fill('Subject: x'), ...Array(8).fill(''), ...Array(20_000).fill('To: y')].join('\n'),
  },
  // The email header regex with no colon after the word: 8.8 s here on 619746f.
  { name: '500 lines of Subject and 1,000 spaces', text: PREFIX + Array.from({ length: 500 }, () => 'Subject' + ' '.repeat(1000)).join('\n') },
  { name: '500 lines of Subject: and 1,000 spaces', text: PREFIX + Array.from({ length: 500 }, () => 'Subject:' + ' '.repeat(1000)).join('\n') },
  { name: '500 lines of 1,000 leading spaces', text: PREFIX + Array.from({ length: 500 }, () => ' '.repeat(1000) + 'x').join('\n') },
  { name: '500 list items of a bracket and 1,000 spaces', text: PREFIX + Array.from({ length: 500 }, () => '- [' + ' '.repeat(1000) + 'x').join('\n') },
  { name: '500 bold lines and 1,000 spaces', text: PREFIX + Array.from({ length: 500 }, () => '**Option A**' + ' '.repeat(1000) + 'x').join('\n') },
  { name: '500 table separators and 1,000 spaces', text: PREFIX + Array.from({ length: 500 }, () => '| --- |' + ' '.repeat(1000) + 'x').join('\n') },
  // Lines that name a choice but say before and after, again and again.
  { name: '20,000 lines of before vs before', text: Array.from({ length: 20_000 }, () => 'before vs before '.repeat(10)).join('\n') },
]

for (const c of COSTLY) {
  test(`classify: ${c.name} costs under 50 ms`, () => {
    classify(c.text) // warm the regexes, so the bound is the scan, not the compile
    const ms = costOf(c.text)
    assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`)
  })
}

test('classify: thousands of unlike options stay cheap', () => {
  // Options are compared pair by pair; uncapped, this text took about 290 ms
  // of the daemon's one thread.
  const many = Array.from({ length: 5000 }, (_, i) => `### O${i}\nAlpha${i}: 1\nBeta${i}: 2`).join('\n')
  const started = performance.now()
  assert.equal(classify(many), null)
  assert.ok(performance.now() - started < 100, `took ${(performance.now() - started).toFixed(1)} ms`)
})

test('classify: never throws on odd input', () => {
  for (const odd of [undefined, null, 42, {}, '|'.repeat(5000), '```'.repeat(400), '- ✅\n'.repeat(400)]) {
    assert.doesNotThrow(() => classify(odd as unknown as string))
  }
})

// ── the line ─────────────────────────────────────────────────────────────────

test('cardNudgeLine: one line, the brief words, the shape named, no dashes', () => {
  const email = cardNudgeLine('email_draft')
  assert.ok(email.startsWith('This reply would read better as a card'))
  assert.ok(email.includes('an email draft: a keyvalue block for To, Cc and Subject, then the body'))
  assert.ok(email.endsWith('Next time call show_component with kind ui_card (see Cards you compose in bgos_capabilities).'))
  for (const shape of ['email_draft', 'table', 'status_list', 'comparison'] as const) {
    const line = cardNudgeLine(shape)
    assert.ok(!line.includes('\n'), `${shape} is one line`)
    assert.ok(!/[\u2013\u2014]/.test(line), `${shape} has no em or en dash`)
    assert.ok(line.includes('show_component with kind ui_card'), shape)
  }
  assert.ok(cardNudgeLine('table').includes('a table block'))
  assert.ok(cardNudgeLine('status_list').includes('a list block'))
  assert.ok(cardNudgeLine('comparison').includes('a compare block'))
})

test('the gate token is the one this daemon declares', () => {
  assert.equal(UI_CARD, 'ui_card')
  assert.ok(DECLARED_CAPABILITIES_BASE.includes(UI_CARD))
})

// ── the per chat memory ──────────────────────────────────────────────────────

function nudges() {
  let clock = Date.UTC(2026, 9, 25, 9, 0, 0)
  const logs: string[] = []
  const memory = new ReplyCardNudges({ now: () => clock })
  return {
    memory,
    logs,
    advance: (ms: number) => {
      clock += ms
    },
    ask: (chatId: string, text: string, declared = true) =>
      memory.forReply({ chatId, text, declared: () => declared, log: (line) => logs.push(line) }),
  }
}

test('ReplyCardNudges: once per chat per 30 minutes', () => {
  const n = nudges()
  assert.equal(n.ask('101', TABLE), cardNudgeLine('table'))
  assert.equal(n.ask('101', EMAIL_IN_CODE_BLOCK), null, 'a second card shaped reply inside the window')
  n.advance(CARD_NUDGE_WINDOW_MS - 1)
  assert.equal(n.ask('101', TABLE), null, 'still inside the window')
  assert.equal(n.ask('202', TABLE), cardNudgeLine('table'), 'another chat has its own window')
  n.advance(1)
  assert.equal(n.ask('101', STATUS_LIST), cardNudgeLine('status_list'), 'the window has passed')
})

test('ReplyCardNudges: a prose reply neither nudges nor spends the window', () => {
  const n = nudges()
  assert.equal(n.ask('101', SHORT_REPLY), null)
  assert.equal(n.ask('101', LONG_STEPS), null)
  assert.equal(n.ask('101', TABLE), cardNudgeLine('table'))
})

test('ReplyCardNudges: an undeclared daemon never gets it and spends nothing', () => {
  const n = nudges()
  assert.equal(n.ask('101', TABLE, false), null)
  assert.equal(n.ask('101', EMAIL_IN_PROSE, false), null)
  assert.equal(n.ask('101', TABLE, true), cardNudgeLine('table'))
})

test('ReplyCardNudges: a classify or gate error is swallowed and logged', () => {
  const n = nudges()
  const thrown = n.memory.forReply({
    chatId: '101',
    text: TABLE,
    declared: () => {
      throw new Error('declared list unreadable')
    },
    log: (line) => n.logs.push(line),
  })
  assert.equal(thrown, null)
  assert.equal(n.logs.length, 1)
  assert.match(n.logs[0], /declared list unreadable/)
  assert.equal(n.ask('101', TABLE), cardNudgeLine('table'), 'the failed call spent no window')
})

test('ReplyCardNudges: the memory stays bounded', () => {
  let clock = 0
  const memory = new ReplyCardNudges({ now: () => clock, maxChats: 4 })
  for (let i = 0; i < 50; i++) {
    clock += 1
    memory.forReply({ chatId: String(i), text: TABLE, declared: () => true, log: () => undefined })
  }
  assert.ok(memory.size <= 4, `kept ${memory.size}`)
  // The newest chat is still inside its window.
  assert.equal(memory.forReply({ chatId: '49', text: TABLE, declared: () => true, log: () => undefined }), null)
})
