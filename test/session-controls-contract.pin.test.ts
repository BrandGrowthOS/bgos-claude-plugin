/**
 * `lib/session-controls-contract.ts` is COPIED byte for byte from BGOS
 * (backend/src/integrations/session-controls-contract.ts) and into
 * codex-channel-bgos (src/session-controls-contract.ts), P6 stage 3 (C-32),
 * spec section 6. If you change it here, the other two copies are now wrong,
 * and without this pin nothing would tell you.
 *
 * WHAT IS COPIED AND WHY. The file names the two tokens a daemon declares
 * (`sessions_library`, `stop_pauses_mission`), the three Sessions ops that
 * ride the voice_rpc frame, the reason this daemon writes when an owner Stop
 * pauses a mission, the two stop confirmations (this daemon posts the
 * cooperative one), the Resume sentence, the limits and the refusal codes. A
 * drift on either side is silent: a token spelled differently is stored and
 * never matched, an op spelled differently is dropped by a normalizer, and a
 * reason spelled differently is never resumed by this daemon and never
 * localised by the app. So the spelling is held by a hash.
 *
 * THE OTHER HALVES. BGOS
 * backend/src/integrations/session-controls-contract.pin.spec.ts and
 * codex-channel-bgos test/session-controls-contract.pin.spec.ts pin the SAME
 * digest on their copies. No repo's CI can read another, which is why each
 * side carries the literal.
 *
 * WHEN THIS FAILS, and it is meant to, the fix is not to silence it:
 *   1. Make the same edit to the BGOS copy and the Codex copy, so the three
 *      files are byte for byte identical (LF, no BOM).
 *   2. Put the new sha256 in SHA256 below AND in both other pin specs.
 *   3. Ship all three in one set of PRs. A change in one tree only is the
 *      defect this exists to catch.
 *
 * WHY THE .gitattributes LINE. This repo has no blanket eol rule, and a
 * Windows checkout with core.autocrlf=true hands every text file CRLF. Without
 * `lib/session-controls-contract.ts text eol=lf` the copy on such a machine
 * has different bytes and this pin reads red on exactly the machines that
 * build the plugin (the vendored browser shim has the same line, for the same
 * reason).
 *
 * MUTATION PROOF (recorded 2026-09-25 through the P6 test lock, file restored
 * byte for byte from a pristine copy and re-hashed to the digest below): one
 * byte flipped in THIS copy (`Stopped by you` to `Stopped by yon` in the
 * STOP_PAUSE_REASON literal, line 83) -> 2 of 9 red: "still has the bytes
 * BGOS and the Codex plugin are pinned to" and "carries the stop words and
 * the Resume sentence exactly".
 *
 * Run: npx tsx --test test/session-controls-contract.pin.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import * as contract from '../lib/session-controls-contract.ts'
import {
  LIST_SESSIONS,
  RENAME_SESSION,
  RESUME_SESSION,
  RESUME_TURN_TEXT,
  SESSION_BRANCH_MAX,
  SESSION_CONTROL_TOKENS,
  SESSION_ERROR_CODES,
  SESSION_ID_PATTERN,
  SESSION_OPS,
  SESSION_PREVIEW_MAX,
  SESSION_QUERY_MAX,
  SESSION_RENAME_MAX,
  SESSION_TITLE_MAX,
  SESSIONS_LIBRARY,
  SESSIONS_LIST_MAX,
  STOP_CONFIRMATION_COOPERATIVE,
  STOP_CONFIRMATION_HARD,
  STOP_PAUSE_REASON,
  STOP_PAUSES_MISSION,
} from '../lib/session-controls-contract.ts'

/** The digest the BGOS and Codex plugin pins hold too. */
const SHA256 = '5dccdd879c095f79c3b495fc26d39703dc8fb1454adc16f3fe991ebb6dd3e448'

const FILE = fileURLToPath(new URL('../lib/session-controls-contract.ts', import.meta.url))
const GITATTRIBUTES = fileURLToPath(new URL('../.gitattributes', import.meta.url))

/** backend/src/dto/integrations/pair-exchange.dto.ts CAPABILITY_TOKEN_REGEX */
const TOKEN_GRAMMAR = /^[a-z][a-z0-9_]{0,63}$/

/** An en dash or an em dash, spelled as escapes so this file carries neither. */
const DASH = new RegExp('[\\u2013\\u2014]')

test('still has the bytes BGOS and the Codex plugin are pinned to', () => {
  const digest = createHash('sha256').update(readFileSync(FILE)).digest('hex')
  assert.deepEqual(
    { file: 'session-controls-contract.ts', digest },
    { file: 'session-controls-contract.ts', digest: SHA256 },
    'lib/session-controls-contract.ts no longer hashes to the digest BGOS and codex-channel-bgos pin. ' +
      'Change all three copies and all three pins together, or put this copy back.',
  )
})

test('names exactly sessions_library and stop_pauses_mission, in that order, in the token grammar', () => {
  assert.deepEqual([...SESSION_CONTROL_TOKENS], ['sessions_library', 'stop_pauses_mission'])
  assert.equal(SESSIONS_LIBRARY, 'sessions_library')
  assert.equal(STOP_PAUSES_MISSION, 'stop_pauses_mission')
  assert.ok(Object.isFrozen(SESSION_CONTROL_TOKENS))
  for (const token of SESSION_CONTROL_TOKENS) {
    assert.match(token, TOKEN_GRAMMAR, `"${token}" is not a legal capability token`)
  }
})

test('spells the three ops, and nothing else rides the list', () => {
  assert.deepEqual([...SESSION_OPS], ['list_sessions', 'resume_session', 'rename_session'])
  assert.deepEqual(
    [LIST_SESSIONS, RESUME_SESSION, RENAME_SESSION],
    ['list_sessions', 'resume_session', 'rename_session'],
  )
  assert.ok(Object.isFrozen(SESSION_OPS))
})

test('carries the stop words and the Resume sentence exactly, with no dash in any of them', () => {
  assert.equal(STOP_PAUSE_REASON, 'Stopped by you')
  assert.equal(STOP_CONFIRMATION_HARD, 'Stopped.')
  assert.equal(STOP_CONFIRMATION_COOPERATIVE, 'Asked to stop.')
  assert.equal(RESUME_TURN_TEXT, 'Continue from where you stopped.')
  // Plain text on every channel: a leading slash would make it a command,
  // and this daemon's slash router would take it instead of the model.
  assert.equal(RESUME_TURN_TEXT.startsWith('/'), false)
  for (const words of [
    STOP_PAUSE_REASON,
    STOP_CONFIRMATION_HARD,
    STOP_CONFIRMATION_COOPERATIVE,
    RESUME_TURN_TEXT,
  ]) {
    assert.doesNotMatch(words, DASH)
  }
})

test('holds the limits and the refusal codes both sides validate against', () => {
  assert.deepEqual(
    {
      SESSIONS_LIST_MAX,
      SESSION_TITLE_MAX,
      SESSION_PREVIEW_MAX,
      SESSION_BRANCH_MAX,
      SESSION_RENAME_MAX,
      SESSION_QUERY_MAX,
    },
    {
      SESSIONS_LIST_MAX: 50,
      SESSION_TITLE_MAX: 120,
      SESSION_PREVIEW_MAX: 200,
      SESSION_BRANCH_MAX: 60,
      SESSION_RENAME_MAX: 80,
      SESSION_QUERY_MAX: 80,
    },
  )
  assert.deepEqual([...SESSION_ERROR_CODES], ['busy', 'not_found', 'unsupported', 'invalid', 'failed'])
  assert.ok(Object.isFrozen(SESSION_ERROR_CODES))
  // The id grammar at its edges: a Codex thread id and a Claude session UUID
  // pass; a space, a slash and a 129th character do not.
  assert.equal(SESSION_ID_PATTERN.test('thr_019a:abc-DEF.1'), true)
  assert.equal(SESSION_ID_PATTERN.test('0b9f5a52-7a0e-4c1f-9d7e-3f2c1b0a9e8d'), true)
  assert.equal(SESSION_ID_PATTERN.test('a'.repeat(128)), true)
  assert.equal(SESSION_ID_PATTERN.test('a'.repeat(129)), false)
  assert.equal(SESSION_ID_PATTERN.test(''), false)
  assert.equal(SESSION_ID_PATTERN.test('a b'), false)
  assert.equal(SESSION_ID_PATTERN.test('../etc'), false)
})

test('exports exactly the values named above, so a new one cannot slip in beside the pin', () => {
  assert.deepEqual(
    Object.keys(contract).sort(),
    [
      'LIST_SESSIONS',
      'RENAME_SESSION',
      'RESUME_SESSION',
      'RESUME_TURN_TEXT',
      'SESSION_BRANCH_MAX',
      'SESSION_CONTROL_TOKENS',
      'SESSION_ERROR_CODES',
      'SESSION_ID_PATTERN',
      'SESSION_OPS',
      'SESSION_PREVIEW_MAX',
      'SESSION_QUERY_MAX',
      'SESSION_RENAME_MAX',
      'SESSION_TITLE_MAX',
      'SESSIONS_LIBRARY',
      'SESSIONS_LIST_MAX',
      'STOP_CONFIRMATION_COOPERATIVE',
      'STOP_CONFIRMATION_HARD',
      'STOP_PAUSE_REASON',
      'STOP_PAUSES_MISSION',
    ].sort(),
  )
})

test('is erasable TypeScript only, because this plugin can strip its copy with node', () => {
  // Every top level statement is an exported const, an interface or a type
  // alias, and nothing else: no enum, namespace, decorator or class.
  const source = ts.createSourceFile(
    FILE,
    readFileSync(FILE, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  )
  const offenders: string[] = []
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const exported = (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    const allowed =
      exported &&
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        (ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0))
    if (!allowed) {
      offenders.push(`${ts.SyntaxKind[statement.kind]}: ${statement.getText(source).slice(0, 60)}`)
    }
  }
  assert.deepEqual(offenders, [])
  // Positive control: the walk saw the file, not an empty parse.
  assert.ok(source.statements.length > 20)
  // And node's own stripper agrees, where this node has one (22.13 and later;
  // CI runs 24). Strip mode throws on anything that would emit code.
  const strip = (nodeModule as { stripTypeScriptTypes?: (code: string, opts?: { mode?: string }) => string })
    .stripTypeScriptTypes
  if (typeof strip === 'function') {
    const text = readFileSync(FILE, 'utf8')
    const stripped = strip(text, { mode: 'strip' })
    // Strip mode blanks the types in place, so the positions do not move.
    assert.equal(stripped.length, text.length)
    assert.ok(stripped.includes(`export const STOP_PAUSE_REASON = '${STOP_PAUSE_REASON}';`))
  }
})

test('has no imports, no CR and no BOM, and .gitattributes keeps a Windows checkout that way', () => {
  const bytes = readFileSync(FILE)
  assert.equal(bytes.includes(0x0d), false, 'a CRLF copy has a different sha256 and cannot be verified on disk')
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false)
  const code = bytes
    .toString('utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert.doesNotMatch(code, /\bimport\b/)
  assert.doesNotMatch(code, /\brequire\s*\(/)
  assert.match(
    readFileSync(GITATTRIBUTES, 'utf8'),
    /^lib\/session-controls-contract\.ts text eol=lf\r?$/m,
    'without this line core.autocrlf hands a Windows checkout CRLF and the pinned hash stops matching',
  )
})

test('hashes the very file this test imports, not a copy that merely matches', () => {
  const text = readFileSync(FILE, 'utf8')
  assert.ok(text.includes(`export const STOP_PAUSE_REASON = '${STOP_PAUSE_REASON}';`))
  assert.ok(text.includes(`export const SESSIONS_LIBRARY = '${SESSIONS_LIBRARY}';`))
  assert.ok(text.includes(`export const STOP_PAUSES_MISSION = '${STOP_PAUSES_MISSION}';`))
  assert.ok(text.includes(`export const STOP_CONFIRMATION_COOPERATIVE = '${STOP_CONFIRMATION_COOPERATIVE}';`))
})
