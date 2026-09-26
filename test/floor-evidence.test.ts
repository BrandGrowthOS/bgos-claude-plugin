/**
 * The floor's evidence fitted to a limit WITHOUT losing what matched
 * (lib/floor-evidence.mjs), and the three places that fit it: the hook's
 * record (lib/floor-state.mjs), the floor check's body (lib/floor-check.ts)
 * and the held card's lead (lib/permission-relay.ts).
 *
 * THE REVIEW (P2 stage 6, the plugin review after wave B1b). Each of the three
 * cut the evidence from its HEAD, and the listed part of a long simple command
 * is often at its END. With the owner's switch ON:
 *   - `echo "K=<4000 x>" > .env ; echo <2000 y>`: the record kept 3500 from
 *     the head, the redirect went, the body the server read was harmless, it
 *     answered hold:false and the relay auto approved the .env write;
 *   - `git push origin <300 branches> --force ; echo <2000 y>`: the same;
 *   - and on the card (lead cut to 1500): `echo "K=<1600 x>" > .env`,
 *     `rm dir0 ... dir499 -rf`, `cp f0.txt ... f399.txt .git/hooks/`, and a
 *     Write whose `content` comes before `file_path` (edit tools were never
 *     led): the card carried no command the server could stamp, so no pill,
 *     no floor line, no person only gate.
 *
 * The server's own readers (BGOS classifyFloor, kinds `request` and `card`)
 * were run over the same cases with the reviewer's probe; this file holds the
 * plugin's half in place with the plugin's reader, which is the same list
 * (the shared fixture pins that).
 *
 * MUTATION PROOF (applied to lib/floor-evidence.mjs, confirmed red, restored):
 * compactFloorEvidence made to return the head cut on every call (its first
 * line `if (measure(text) <= max)` followed by an unconditional
 * `return { evidence: cutToFit(text, max, measure), fits: false, compacted: false }`)
 * -> 7 of 12 red: the four fitting cases, the fast case, the record and body
 * case and the card case (the within limit case, the head cut case, the cap
 * pin and the two routing cases stay green, as they should).
 *
 * MUTATION PROOF, the edit tool lead (applied to lib/permission-relay.ts,
 * confirmed red, restored): floorLeadKey answering null for Write, Edit,
 * MultiEdit and NotebookEdit (edit tools never led, as before) -> the card
 * case red on the Write, 1 of 12. And the write key beside a led path
 * (FLOOR_LEAD_WRITE_KEY) dropped from the lead -> the card case red, 1 of 12
 * (the server's card reader counts a file_path as a write only beside one;
 * the reviewer's probe over BGOS's own classifyFloor read that case NONE
 * without it and env_file_write with it).
 *
 * Run with: npx tsx --test test/floor-evidence.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compactFloorEvidence, droppedWordsMarker } from '../lib/floor-evidence.mjs'
import {
  FLOOR_CHECK_INPUT_PREVIEW_MAX,
  buildFloorCheckBody,
  consultFloor,
  floorRouteFor,
  planFloorRequest,
  type FloorRecord,
} from '../lib/floor-check.ts'
import { FLOOR_RECORD_EVIDENCE_MAX, buildFloorRecord } from '../lib/floor-state.mjs'
import { FLOOR_EVIDENCE_LEAD_MAX, permissionCardTool } from '../lib/permission-relay.ts'
import {
  classifyCommand,
  classifyPath,
  classifyPermissionRequest,
  classifyToolCall,
  type HardFloorMatch,
} from '../lib/hard-floor.ts'

/** The CLI's preview (Claude Code 2.1.281 truncateForPreview), as test/floor-check.test.ts draws it. */
function cliElide(text: string): string {
  const points = Array.from(text)
  if (points.length <= 3500) return text
  const cut = points.length - 2000 - 1500
  return `${points.slice(0, 2000).join('')}\n⋯ ${cut} code points elided ⋯\n${points.slice(points.length - 1500).join('')}`
}
const cliT = (text: string) => cliElide(text.replace(/\s{2,}/g, ' '))
function cliPreview(input: Record<string, unknown>): string {
  return `{ ${Object.entries(input)
    .map(([k, v]) => `${cliT(JSON.stringify(k))}: ${cliT(JSON.stringify(v))}`)
    .join(', ')} }`
}

const x = (n: number, c = 'x') => c.repeat(n)
const TAIL = ` ; echo ${x(2000, 'y')}`
const names = (n: number, stem: string) => Array.from({ length: n }, (_, i) => `${stem}${i}`).join(' ')

/** The review's cases, each with the rule the list must still read wherever it is sent. */
const REVIEW_CASES: Array<[string, string, Record<string, unknown>, string]> = [
  ['a 4000 character value redirected into .env', 'Bash', { command: `echo "K=${x(4000)}" > .env${TAIL}` }, 'env_file_write'],
  ['a 1600 character value redirected into .env', 'Bash', { command: `echo "K=${x(1600)}" > .env${TAIL}` }, 'env_file_write'],
  ['a force push after 300 branch names', 'Bash', { command: `git push origin ${names(300, 'branch')} --force${TAIL}` }, 'force_push'],
  ['rm of 500 folders with -rf last', 'Bash', { command: `rm ${names(500, 'dir')} -rf${TAIL}` }, 'recursive_delete'],
  ['cp of 400 files into .git/hooks/', 'Bash', { command: `cp ${names(400, 'f')} .git/hooks/${TAIL}` }, 'git_dir_write'],
  ['sed -i with a 4000 character script on .env', 'Bash', { command: `sed -i 's/a/${x(4000)}/' .env${TAIL}` }, 'env_file_write'],
  ['a Write whose content comes before file_path', 'Write', { content: x(2500, 'c'), file_path: '/repo/.env' }, 'env_file_write'],
  ['an Edit whose old_string comes first', 'Edit', { old_string: x(2500, 'o'), new_string: 'n', file_path: '/repo/.git/config' }, 'git_dir_write'],
  ['a NotebookEdit whose source comes first', 'NotebookEdit', { new_source: x(2500, 's'), notebook_path: '/repo/.git/x.ipynb' }, 'git_dir_write'],
  ['a Write to .env under a 5000 character folder', 'Write', { file_path: `/repo/${x(5000, 'd')}/.env`, content: 'x' }, 'env_file_write'],
]

// ── The fitting itself ───────────────────────────────────────────────────────

test('an evidence within the limit comes back as it is', () => {
  const fitted = compactFloorEvidence({ toolName: 'Bash', ruleId: 'recursive_delete', evidence: 'rm -rf build', max: 100 })
  assert.deepEqual(fitted, { evidence: 'rm -rf build', fits: true, compacted: false })
})

test('the redirect at the END of a long command survives the fitting, and a marker says what went', () => {
  const evidence = classifyToolCall('Bash', { command: `echo "K=${x(4000)}" > .env` })!.evidence
  assert.ok(evidence.length > 4000)
  const fitted = compactFloorEvidence({ toolName: 'Bash', ruleId: 'env_file_write', evidence, max: 3500 })
  assert.equal(fitted.fits, true)
  assert.ok(fitted.evidence.length <= 3500)
  assert.equal(classifyCommand(fitted.evidence), 'env_file_write')
  assert.match(fitted.evidence, /> \.env$/)
  assert.ok(fitted.evidence.includes(droppedWordsMarker(1)), fitted.evidence)
})

test('a --force after hundreds of branch names, and -rf after hundreds of folders, are kept', () => {
  for (const [command, rule, operator] of [
    [`git push origin ${names(300, 'branch')} --force`, 'force_push', '--force'],
    [`rm ${names(500, 'dir')} -rf`, 'recursive_delete', '-rf'],
  ] as const) {
    const evidence = classifyToolCall('Bash', { command })!.evidence
    const fitted = compactFloorEvidence({ toolName: 'Bash', ruleId: rule, evidence, max: 1000 })
    assert.equal(fitted.fits, true, command.slice(0, 40))
    assert.ok(fitted.evidence.length <= 1000)
    assert.equal(classifyCommand(fitted.evidence), rule)
    assert.ok(fitted.evidence.split(' ').includes(operator), fitted.evidence.slice(-80))
    // The head of the command, what a person reads first, is kept longest.
    assert.ok(fitted.evidence.startsWith(command.split(' ').slice(0, 3).join(' ')), fitted.evidence.slice(0, 60))
  }
})

test('a word the rule needs is kept because dropping it changes the reading: the cp destination, the sudo -u value', () => {
  const cp = classifyToolCall('Bash', { command: `cp ${names(400, 'f')} .git/hooks/` })!.evidence
  const fittedCp = compactFloorEvidence({ toolName: 'Bash', ruleId: 'git_dir_write', evidence: cp, max: 600 })
  assert.equal(fittedCp.fits, true)
  assert.match(fittedCp.evidence, / \.git\/hooks\/$/)
  assert.equal(classifyCommand(fittedCp.evidence), 'git_dir_write')

  const sudo = `sudo -u root rm -rf ${names(400, 'dir')}`
  const evidence = classifyToolCall('Bash', { command: sudo })!.evidence
  const fitted = compactFloorEvidence({ toolName: 'Bash', ruleId: 'recursive_delete', evidence, max: 300 })
  assert.equal(fitted.fits, true)
  assert.ok(fitted.evidence.startsWith('sudo -u root rm -rf'), fitted.evidence.slice(0, 40))
})

test('a long path keeps its file name and its .git folder, dropping middle folders', () => {
  const path = `/repo/${x(5000, 'd')}/.env`
  const fitted = compactFloorEvidence({ toolName: 'Write', ruleId: 'env_file_write', evidence: path, max: 200 })
  assert.equal(fitted.fits, true)
  assert.equal(fitted.evidence, '/repo/.../.env')
  assert.equal(classifyPath(fitted.evidence), 'env_file_write')
})

test('when what the rule needs is itself over the limit, it says so (fits: false) and cuts from the head as before', () => {
  const evidence = `echo x > ${x(5000, 'n')}/.env`
  const fitted = compactFloorEvidence({ toolName: 'Bash', ruleId: 'env_file_write', evidence, max: 1000 })
  assert.equal(fitted.fits, false)
  assert.equal(fitted.evidence, evidence.slice(0, 1000))
})

test('the fitting stays fast on a long command (the relay is holding the CLI while it runs)', () => {
  const evidence = classifyToolCall('Bash', { command: `rm ${names(20_000, 'dir')} -rf` })!.evidence
  const started = Date.now()
  const fitted = compactFloorEvidence({ toolName: 'Bash', ruleId: 'recursive_delete', evidence, max: 3500 })
  assert.equal(fitted.fits, true)
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`)
})

// ── The record, the body and the card, end to end ────────────────────────────

test('THE REVIEW: the record keeps the whole matched command, and the body the server reads still reads the rule', () => {
  for (const [label, tool, input, rule] of REVIEW_CASES) {
    const hook = classifyToolCall(tool, input) as HardFloorMatch
    assert.equal(hook?.ruleId, rule, label)
    const record = buildFloorRecord({ toolName: tool, toolInput: input, match: hook, payload: { permission_mode: 'bypassPermissions' } }) as FloorRecord
    assert.equal(record.evidence, hook.evidence, `${label}: the record keeps the evidence whole`)
    const preview = cliPreview(input)
    const plan = planFloorRequest({ autoApprove: true, toolName: tool, inputPreview: preview, record, previewMatch: null })
    assert.equal(plan.action, 'consult', label)
    if (plan.action !== 'consult') continue
    const body = buildFloorCheckBody(tool, preview, plan.match)
    assert.ok(body.inputPreview.length <= FLOOR_CHECK_INPUT_PREVIEW_MAX, label)
    assert.equal(classifyPermissionRequest(body.toolName, body.inputPreview)?.ruleId, rule, `${label}: the body still reads ${rule}`)
  }
})

test('THE REVIEW: a held card leads with a command or a path the card reader matches, within the lead limit', () => {
  for (const [label, tool, input, rule] of REVIEW_CASES) {
    const hook = classifyToolCall(tool, input) as HardFloorMatch
    const card = permissionCardTool({ toolName: tool, inputPreview: cliPreview(input), floorEvidence: hook.evidence })
    const firstLine = card.split('\n', 1)[0]!
    const lead = JSON.parse(firstLine) as Record<string, string>
    assert.ok(firstLine.length <= FLOOR_EVIDENCE_LEAD_MAX, `${label}: ${firstLine.length}`)
    // The card reader takes the FIRST such key of the card's text, which is the lead.
    assert.equal(classifyToolCall(tool, lead)?.ruleId, rule, `${label}: ${firstLine.slice(0, 80)}`)
    // And it reads a file_path as a WRITE only beside a write key, which the
    // lead carries itself: the preview's own can be past the cap.
    if ('file_path' in lead) {
      assert.ok(['content', 'new_string', 'edits'].some((k) => k in lead), `${label}: ${firstLine}`)
    }
  }
})

test('the record cap is the whole command up to 64 KiB, not 3500 from its head', () => {
  assert.equal(FLOOR_RECORD_EVIDENCE_MAX, 64 * 1024)
})

// ── The belt: a body the list cannot read is not answered by a hold:false ────

/**
 * MUTATION PROOF (applied to lib/floor-check.ts, confirmed red, restored):
 * floorRouteFor's `if (context.bodyReadable === false) return 'owner'` removed
 * -> the first case below red (the route read 'auto_approve'), 1 of 12.
 */
test('a hold:false about a body the list no longer reads goes to the owner, never auto approved', async () => {
  const command = `echo x > ${x(5000, 'n')}/.env`
  const match = classifyToolCall('Bash', { command }) as HardFloorMatch
  assert.equal(match.ruleId, 'env_file_write')
  let sent = ''
  const decision = await consultFloor({
    toolName: 'Bash',
    inputPreview: cliPreview({ command }),
    requestId: 'belt1',
    match,
    path: 'integrations/assistants/7/floor-check',
    send: async (_path, body) => {
      sent = body.inputPreview
      return { status: 200, text: JSON.stringify({ hold: false, rulesVersion: 1 }) }
    },
    autoApprove: true,
  })
  assert.equal(classifyPermissionRequest('Bash', sent), null, 'the probe needs a body the list cannot read')
  assert.equal(decision.route, 'owner')
  assert.match(decision.line, /did not fit/)
  assert.equal(floorRouteFor({ kind: 'proceed', rulesVersion: 1 }, { autoApprove: true, bodyReadable: false }), 'owner')
})

test('a readable body still proceeds on hold:false, and a hold still holds either way', () => {
  assert.equal(floorRouteFor({ kind: 'proceed', rulesVersion: 1 }, { autoApprove: true, bodyReadable: true }), 'auto_approve')
  assert.equal(floorRouteFor({ kind: 'hold', ruleId: 'env_file_write', rulesVersion: 1 }, { bodyReadable: false }), 'hold')
  // An error still refuses on an auto approve install, readable or not.
  assert.equal(floorRouteFor({ kind: 'error', reason: 'x' }, { autoApprove: true, bodyReadable: false }), 'refuse')
})
