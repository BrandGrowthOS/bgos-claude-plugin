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

// Review of round 2 (PR #277): a line that names a choice names only the
// options directly under it, not every section after it.

/**
 * The review's input: one prose "p95 vs p50" line, then DIRECTLY findings
 * sharing Impact and Risk, no intro line between (round 3's fixture had one,
 * and passed only because of it).
 */
const MEASURED_FINDINGS = [
  'We measured p95 vs p50',
  '',
  '**1. The label regex backtracks on a run of spaces**',
  '- File: lib/reply-card-shape.ts:185',
  '- Impact: one long line holds the daemon for seconds',
  '- Risk: every reply the agent sends goes through it',
  '',
  '**2. The email check compares every pair of headers**',
  '- File: lib/reply-card-shape.ts:231',
  '- Impact: a pasted log of headers costs a few seconds',
  '- Risk: rare, it needs thousands of header lines',
  '',
  '**3. The cost tests time a cold regex**',
  '- File: test/reply-card-shape.test.ts:541',
  '- Impact: a slow CI runner could fail the bound',
  '- Risk: low, each input is warmed once first',
].join('\n')

test('classify: a "p95 vs p50" line does not make the findings after it options (measured)', () => {
  assert.ok(MEASURED_FINDINGS.length >= MIN_CARD_SHAPED_CHARS)
  assert.equal(classify(MEASURED_FINDINGS), null)
})

test('classify: a naming line inside a finding does not name the findings after it', () => {
  // In a field of the first finding, and in a prose note under it.
  const inField = MEASURED_FINDINGS.replace('We measured p95 vs p50\n\n', '').replace(
    '- Risk: every reply',
    '- Note: p95 vs p50 doubled\n- Risk: every reply',
  )
  assert.equal(classify(inField), null, 'a field line')
  const inBody = MEASURED_FINDINGS.replace('We measured p95 vs p50\n\n', '').replace(
    '- Risk: every reply the agent sends goes through it',
    '- Risk: every reply the agent sends goes through it\nWe measured p95 vs p50 on staging.',
  )
  assert.equal(classify(inBody), null, 'a prose note in the body')
})

test('classify: a heading that is not an option ends the naming line before it', () => {
  const underFindings = MEASURED_FINDINGS.replace(
    'We measured p95 vs p50\n\n',
    'We measured p95 vs p50\n\n## Findings\n\n',
  )
  assert.equal(classify(underFindings), null, 'a heading with no fields of its own')
  const sibling = [
    '## Postgres on the existing server vs a managed database',
    '',
    '### Postgres on the existing server',
    'Cost: nothing extra, it shares the box',
    'Setup: one migration, an hour of work',
    '',
    '## Review findings',
    '',
    '### The backup job',
    'Cost: an hour a week of someone checking it',
    'Setup: a cron line nobody owns',
    '',
    '### The restore drill',
    'Cost: half a day each quarter',
    'Setup: a staging box we do not have yet',
  ].join('\n')
  assert.equal(classify(sibling), null, 'a heading as high as the naming heading is beside it')
})

test('classify: options directly under the naming line still compare', () => {
  // A prose naming line, then the options, with a note in an option's body.
  const prose = UNNAMED_HEADINGS.replace(
    '### Postgres on the existing server',
    'Postgres on the existing server vs a managed database:\n\n### Postgres on the existing server\nThe one we run today.',
  )
  assert.equal(classify(prose), 'comparison')
  assert.equal(classify(COMPARISON_HEADINGS), 'comparison')
})

// Review of round 2 (PR #277): a real draft may carry merge fields and a
// recipient list over two lines.

const TEMPLATE_DRAFT = [
  'Here is the outreach template for the franchise prospects, the merge fields in braces:',
  '',
  'To: {{email}}',
  'Subject: Quick question for {company}',
  '',
  'Hi {{first_name}},',
  '',
  'I run marketing for 38 Papa Johns stores in the UAE and saw that {company} is opening',
  'in Dubai Hills next spring. We have a co-branded launch offer that has worked well for',
  'neighbours in Marina and JLT. Would a 15 minute call next week be useful?',
  '',
  'Best,',
  'Kc',
].join('\n')

const TWO_LINE_RECIPIENTS = [
  'Draft below, Sarah and Ahmad both on the To line as you asked:',
  '',
  'To: sarah.lee@pjprestaurants.com,',
  '    Ahmad Khan <ahmad@pjprestaurants.com>',
  'Subject: November LTO, the price point to settle on Tuesday',
  '',
  'Hi both,',
  '',
  'Before Tuesday, can you each send me the number you would hold the bundle at for',
  'November and the delivery mix you are assuming behind it? I would like us to walk in',
  'with one table rather than two opinions.',
  '',
  'Thanks,',
  'Kc',
].join('\n')

test('classify: a draft with template braces in its header values counts', () => {
  assert.equal(classify(TEMPLATE_DRAFT), 'email_draft')
  assert.equal(classify(TEMPLATE_DRAFT.replace('To: {{email}}', 'To: {{ email }}')), 'email_draft', 'padded')
  assert.equal(
    classify(TEMPLATE_DRAFT.replace('To: {{email}}', 'To: prospects@example.com').replace('{company}', '{{name}}')),
    'email_draft',
    'a {{name}} subject',
  )
  assert.equal(classify(TEMPLATE_DRAFT.replace(/^(To|Subject)/gm, '**$1:**').replace(/\*\*:/g, '**')), 'email_draft', 'bold headers')
})

test('classify: a To line ending in a comma before the next address counts', () => {
  assert.equal(classify(TWO_LINE_RECIPIENTS), 'email_draft')
  assert.equal(
    classify(TWO_LINE_RECIPIENTS.replace('    Ahmad Khan <ahmad@pjprestaurants.com>', 'ahmad@pjprestaurants.com')),
    'email_draft',
    'a bare address',
  )
})

test('classify: code shaped headers outside a fence stay null', () => {
  // The round 2 code, pasted with no fence at all.
  for (const text of [NODEMAILER, EMAIL_DTO, SEND_MAIL_STEP]) {
    const unfenced = text.replace(/^```\w*$/gm, '')
    assert.notEqual(unfenced, text)
    assert.equal(classify(unfenced), null, unfenced.slice(0, 60))
  }
  const lines = (to: string, subject: string) =>
    ['The payload, as the worker logs it before the send:', '', to, subject, 'html: body,', '', 'x'.repeat(300)].join('\n')
  assert.equal(classify(lines('to: user.email,', "subject: 'Welcome',")), null, 'key: value, shapes')
  assert.equal(classify(lines('"To": "ops@example.com",', '"Subject": "Deploy"')), null, 'quotes before the colon')
  assert.equal(classify(lines('To: string[];', 'Subject: string;')), null, 'semicolons')
  assert.equal(classify(lines('To: { name, address }', 'Subject: { text }')), null, 'an object, not a merge field')
  assert.equal(classify(lines('{to}: ops@example.com', 'Subject: Deploy finished')), null, 'braces before the colon')
  assert.equal(classify(lines('To: {', 'Subject: Deploy finished')), null, 'a value that is only a brace')
  assert.equal(classify(lines('To: ${user.email}', 'Subject: Deploy finished')), null, 'interpolation, not a merge field')
  assert.equal(classify(lines('To: ops@example.com,', 'Subject: Deploy finished')), null, 'a trailing comma with no address after it')
  assert.equal(classify(lines('To: ops@example.com', 'Subject: Deploy finished,')), null, 'a Subject never ends in a comma')
})

// Review of round 3 (PR #277): the same naming line, with the findings
// directly under it, and the same header rules inside a prose fence.

test('classify: a naming line names only options whose heading words are on one side of it', () => {
  // The p95 and p50 findings share Impact and Risk, but no finding is p95 or p50.
  assert.equal(classify(MEASURED_FINDINGS), null)
  assert.equal(classify(MEASURED_FINDINGS.replace('We measured p95 vs p50', 'p95 or p50?')), null, 'an "or" line')
  assert.equal(classify(MEASURED_FINDINGS.replace('We measured p95 vs p50', '## p95 vs p50')), null, 'a naming heading')
  // Two findings both about p95 are on the same side: one choice, not two.
  const bothP95 = MEASURED_FINDINGS.replace('**1. The label', '**1. p95: the label').replace('**2. The email', '**2. p95: the email')
  assert.notEqual(bothP95, MEASURED_FINDINGS)
  assert.equal(classify(bothP95), null, 'two options on one side')
  // And one on each side do compare: that is the choice the line names.
  const eachSide = MEASURED_FINDINGS.replace('**1. The label', '**1. p95: the label').replace('**2. The email', '**2. p50: the email')
  assert.equal(classify(eachSide), 'comparison', 'one option on each side')
})

/** Pros and cons of two choices, under a heading naming them with "or". */
const PROS_CONS = [
  '## React Native or Flutter for the driver app?',
  '',
  '### React Native',
  '- Pros: the team already writes TypeScript, and we share the API client',
  '- Cons: the map view needs a native module we would maintain',
  '- Effort: about six weeks for the first release',
  '',
  '### Flutter',
  '- Pros: one rendering engine, the map and charts look the same everywhere',
  '- Cons: nobody here writes Dart yet',
  '- Effort: about nine weeks, with the ramp up',
].join('\n')

test('classify: real choices under a naming line still compare', () => {
  assert.equal(classify(COMPARISON_HEADINGS), 'comparison', 'an "A vs B" heading')
  assert.equal(classify(PROS_CONS), 'comparison', 'pros and cons under an "or" heading')
  assert.equal(
    classify(PROS_CONS.replace('## React Native or Flutter for the driver app?', 'React Native vs Flutter for the driver app:')),
    'comparison',
    'a prose "vs" line',
  )
  assert.equal(
    classify(COMPARISON_HEADINGS.replace('## Postgres', '## Choosing a database: Postgres').replace('a managed database', 'a managed one')),
    'comparison',
    'a lead in before the colon names neither side',
  )
  const letters = COMPARISON_HEADINGS.replace('## Postgres on the existing server vs a managed database', '## A vs B')
    .replace('### Postgres on the existing server', '### A')
    .replace('### Managed database', '### B')
  assert.ok(letters.length >= MIN_CARD_SHAPED_CHARS)
  assert.equal(classify(letters), 'comparison', 'a literal "A vs B" heading over A and B')
  assert.equal(classify(COMPARISON), 'comparison', 'Option A and Option B')
  assert.equal(classify(COMPARISON_PLANS), 'comparison', 'Plan 1 and Plan 2')
})

const fenceOf = (tag: string, body: string[]) =>
  ['Here is the draft, ready to paste into Outlook:', '', '```' + tag, ...body, '```', '', 'x'.repeat(300)].join('\n')

const FENCED_TEMPLATE = ['To: prospects@example.com', 'Subject: Quick question for {company}', '', 'Hi {{first_name}},']
const FENCED_TWO_LINE_TO = ['To: Sarah Lee <sarah@x.com>,', 'Ahmad Khan <ahmad@x.com>', 'Subject: November LTO', '', 'Hi both,']

test('classify: a draft in an untagged or prose fence may carry merge fields and a two line To', () => {
  assert.equal(classify(fenceOf('', FENCED_TEMPLATE)), 'email_draft', 'merge field, untagged fence')
  assert.equal(classify(fenceOf('', FENCED_TWO_LINE_TO)), 'email_draft', 'two line To, untagged fence')
  assert.equal(classify(fenceOf('text', FENCED_TEMPLATE)), 'email_draft', 'merge field, text fence')
  assert.equal(classify(fenceOf('text', FENCED_TWO_LINE_TO)), 'email_draft', 'two line To, text fence')
  assert.equal(classify(fenceOf('', ['To: {{email}}', 'Subject: Hi {company}'])), 'email_draft', 'merge fields in both')
})

test('classify: the same lines in a code fence, or code shaped in a prose fence, stay null', () => {
  for (const tag of ['ts', 'js', 'yaml']) {
    assert.equal(classify(fenceOf(tag, FENCED_TEMPLATE)), null, `merge field, ${tag} fence`)
    assert.equal(classify(fenceOf(tag, FENCED_TWO_LINE_TO)), null, `two line To, ${tag} fence`)
  }
  const subject = 'Subject: Deploy finished'
  assert.equal(classify(fenceOf('', ['To: ${user.email}', subject])), null, 'interpolation')
  assert.equal(classify(fenceOf('', ['To: { name, address }', subject])), null, 'an object')
  assert.equal(classify(fenceOf('', ['To: {', subject])), null, 'a value that is only a brace')
  assert.equal(classify(fenceOf('', ['{to}: ops@example.com', subject])), null, 'braces before the colon')
  assert.equal(classify(fenceOf('', ['To: ops@example.com,', subject])), null, 'a trailing comma with no address after it')
  assert.equal(classify(fenceOf('', ['To: ops@example.com,', 'html: body,', subject])), null, 'a comma before a code line')
  assert.equal(classify(fenceOf('', ['To: ops@example.com', 'Subject: Deploy finished,'])), null, 'a Subject never ends in a comma')
})

// Review of round 4 (PR #277 at 98ffb31): two false positives, and tests
// that fail when a rule they guard is taken out.

test('classify: a comma in one side of a prose "vs" line is not a side of its own', () => {
  // The review's exact input: the line names p95 and p50; "the label regex, and
  // the email check" are what was measured, not two more choices.
  const listed = MEASURED_FINDINGS.replace('We measured p95 vs p50', 'We measured p95 vs p50 for the label regex, and the email check.')
  assert.notEqual(listed, MEASURED_FINDINGS)
  assert.equal(classify(listed), null)
  assert.equal(classify(listed.replace(', and', ' and')), null, 'and without the comma')
})

/** A three way choice named "A, B or C", every option with the same fields. */
const THREE_WAY = [
  '## Self hosted, managed or serverless?',
  '',
  '### Self hosted',
  '- Cost: nothing extra, it shares the box we already pay for',
  '- Setup: one migration and an hour of work',
  '- Backups: the nightly dump we already run',
  '',
  '### Managed',
  '- Cost: about 40 dollars a month for the small tier',
  '- Setup: a new connection string and a data copy',
  '- Backups: point in time restore, built in',
  '',
  '### Serverless',
  '- Cost: pay per request, near zero at our volume',
  '- Setup: a new driver and a pooled connection string',
  '- Backups: built in, seven days of history',
].join('\n')

test('classify: a real "A, B or C" choice still compares, and its comma makes the sides', () => {
  assert.equal(classify(THREE_WAY), 'comparison')
  // Only Self hosted and Managed share fields, and only the comma puts them on
  // different sides: without it they are one side, "self hosted managed".
  const twoComparable = THREE_WAY.replace(
    '- Cost: pay per request, near zero at our volume\n- Setup: a new driver and a pooled connection string\n- Backups: built in, seven days of history',
    '- Cold starts: a second on the first request of the day\n- Vendor: one more account and its own dashboard',
  )
  assert.notEqual(twoComparable, THREE_WAY)
  assert.equal(classify(twoComparable), 'comparison', 'the pair the comma separates')
})

/** Review findings, the first one's bold title saying "vs", each with its own fields. */
const VS_IN_A_FINDING_TITLE = [
  '**1. p95 vs p50 gap on the reply path**',
  '- Impact: the slowest replies take four times the median, all of it in the classifier',
  '- Risk: grows with reply length, so the long drafts suffer most',
  '',
  '**2. The reply path drops commas**',
  '- Impact: a To line over two lines loses its second recipient',
  '- Risk: only drafts with more than one recipient',
  '',
  '**3. p95 tail on staging**',
  '- Impact: staging runs a cold cache, so its tail is not production',
  '- Risk: low, a measurement problem rather than a bug',
].join('\n')

test('classify: a finding title saying "vs" does not name the findings after it', () => {
  assert.ok(VS_IN_A_FINDING_TITLE.length >= MIN_CARD_SHAPED_CHARS)
  assert.equal(classify(VS_IN_A_FINDING_TITLE), null, 'bold titles')
  assert.equal(classify(VS_IN_A_FINDING_TITLE.replace(/^\*\*(.*)\*\*$/gm, '### $1')), null, '### titles')
})

test('classify: the stop words name no side', () => {
  // Without the stop words "the" is on the p95 side and "a" on the p50 side,
  // so finding 1 ("The ...") and finding 2 ("A ...") would be the two choices.
  const articles = MEASURED_FINDINGS.replace('We measured p95 vs p50', 'The p95 vs a p50.')
    .replace('**1. The label regex backtracks on a run of spaces**', '**1. The label regex backtracks on long space runs**')
    .replace('**2. The email check compares every pair of headers**', '**2. A loop over every pair of headers**')
  assert.notEqual(articles, MEASURED_FINDINGS)
  assert.equal(classify(articles), null, 'articles name nothing')
})

test('classify: a title as much on one side as on the other is on neither', () => {
  // "path" is on both sides: a title whose words are as much on one side as
  // on the other is on neither, so it is not the reply path choice.
  const tie = MEASURED_FINDINGS.replace('We measured p95 vs p50', 'We measured the reply path vs the email path.').replace(
    '**1. The label regex backtracks on a run of spaces**',
    '**1. The path cache is cold**',
  )
  assert.notEqual(tie, MEASURED_FINDINGS)
  assert.equal(classify(tie), null, 'a tie is on no side')
})

test('classify: a To line ending in a comma before a padded address still counts', () => {
  for (const next of ['ahmad@pjprestaurants.com   ', 'ahmad@pjprestaurants.com ,  ', 'Ahmad Khan <ahmad@pjprestaurants.com>;']) {
    assert.equal(classify(TWO_LINE_RECIPIENTS.replace('    Ahmad Khan <ahmad@pjprestaurants.com>', next)), 'email_draft', JSON.stringify(next))
  }
})

// ── cost: the inputs the review measured, each under the bound ───────────────
// The pathologies cost 89 ms to 9.5 s on a Mac; a linear scan costs about 14 ms.
// A bound in ms alone reads a slow or busy runner as a regression: the Linux CI
// runner read 52.8 ms against 50 on the fastest of three runs (#284's first
// run), for a text that costs 18 ms on a quiet Windows machine. So the bound is
// also relative: a plain pass over the same text (its lines cut to 160
// characters, each matched with one anchored regex), made eight times so it
// runs about as long as classify and a busy runner slows both alike, timed in
// the same test and in turn with classify. A linear classify costs 0.2 to 1.3
// times the eight passes on the large texts, quiet or loaded; round 5's address
// regex put back costs about 20 times, more on a busy machine. Under 50 ms
// passes outright, as before, since no pathology was that cheap and the passes
// over a short text are too quick to time.
const COST_FLOOR_MS = 50
const COST_RATIO = 5
const PLAIN_PASSES = 8

const PREFIX = 'Here is the summary you asked for, with the details below. '.repeat(6) + '\n'

function costOf(text: string): number {
  const started = performance.now()
  classify(text)
  return performance.now() - started
}

const PLAIN_LINE = /^[ \t]*([A-Za-z][\w -]{0,40}):[ \t]*(\S.*)?$/

function plainPassesCost(text: string): number {
  const started = performance.now()
  for (let pass = 0; pass < PLAIN_PASSES; pass++) {
    for (const line of text.split('\n')) PLAIN_LINE.test(line.slice(0, 160))
  }
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
  // Round 3: the merge field and next address checks, and the naming scope.
  { name: '500 To lines of open braces and 1,000 spaces', text: PREFIX + Array.from({ length: 500 }, () => 'To: {{' + ' '.repeat(1000) + 'x}},').join('\n') },
  {
    name: '500 To lines with a comma, each before a long name line',
    text: PREFIX + Array.from({ length: 500 }, () => 'To: a@b.co,\n' + 'Sarah' + ' '.repeat(1000) + 'x@y').join('\n'),
  },
  // Round 5: the next address check had two space runs around its optional
  // comma (514 ms here on 98ffb31 for this text).
  {
    name: '20,000 To lines with a comma, each before an address, 150 spaces and x',
    text: 'Draft:\n' + Array.from({ length: 20_000 }, () => 'To: x,\n' + 'a@b.co' + ' '.repeat(150) + 'x').join('\n'),
  },
  { name: '20,000 naming lines and headings', text: Array.from({ length: 20_000 }, (_, i) => (i % 2 ? '### A vs B' : 'X vs Y\n\nCost: 1')).join('\n') },
  // Round 4: a naming line of 80 choices over 10,000 options of 50 words each
  // (89 ms here when every heading was matched to the sides as it was read).
  {
    name: 'a naming line of 80 choices over 10,000 long headings',
    text: [
      '## z or ' + Array.from({ length: 80 }, (_, i) => `w${i}`).join(', '),
      ...Array.from({ length: 10_000 }, () => `### ${Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')}\nCost: 1\nRisk: 2`),
    ].join('\n'),
  },
]

for (const c of COSTLY) {
  test(`classify: ${c.name} costs under the bound`, (t) => {
    classify(c.text) // warm the regexes, so the bound is the scan, not the compile
    plainPassesCost(c.text)
    // The fastest of three of each, taken in turn, so a GC pause is not read as a regression.
    let ms = Infinity
    let plain = Infinity
    for (let run = 0; run < 3; run++) {
      plain = Math.min(plain, plainPassesCost(c.text))
      ms = Math.min(ms, costOf(c.text))
    }
    const bound = Math.max(COST_FLOOR_MS, COST_RATIO * plain)
    const ratio = `${(ms / plain).toFixed(2)} times the plain passes (${plain.toFixed(1)} ms)`
    t.diagnostic(`${ms.toFixed(1)} ms, ${ratio}, bound ${bound.toFixed(1)} ms`)
    assert.ok(ms < bound, `took ${ms.toFixed(1)} ms, ${ratio}; bound ${COST_FLOOR_MS} ms or ${COST_RATIO} times the passes`)
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
