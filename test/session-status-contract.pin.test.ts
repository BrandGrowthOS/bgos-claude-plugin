/**
 * `lib/session-status-contract.ts` is COPIED byte for byte from BGOS
 * (backend/src/integrations/session-status-contract.ts) and into
 * codex-channel-bgos (src/session-status-contract.ts), HOAI board row
 * 9c3d6b2c, session liveness. If you change it here, the other two copies are
 * now wrong, and without this pin nothing would tell you.
 *
 * WHAT IS COPIED AND WHY. The file is the status report this daemon sends on
 * its heartbeat: the key it rides under, its fields, their types and limits,
 * the cadence the server's staleness rule depends on, the parser the server
 * runs on it, and the `postedBy: 'connection'` marker on this daemon's own
 * texts. A drift on either side is silent: a field spelled differently is
 * ignored as unknown, a limit changed on one side drops every report as bad,
 * a cadence changed on one side reads a healthy daemon as stopped. So the
 * bytes are held by a hash, and test/session-status.test.ts runs every report
 * this daemon builds through the shared parser.
 *
 * THE OTHER HALVES. BGOS
 * backend/src/integrations/session-status-contract.pin.spec.ts and
 * codex-channel-bgos test/session-status-contract.pin.spec.ts pin the SAME
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
 * WHY THE .gitattributes LINE: see test/session-controls-contract.pin.test.ts;
 * a CRLF checkout would change the bytes on exactly the machines that build
 * the plugin.
 *
 * Run: npx tsx --test test/session-status-contract.pin.test.ts
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import {
  POSTED_BY_CONNECTION,
  POSTED_BY_FIELD,
  SESSION_STATUS_KEY,
  SESSION_STATUS_VERSION,
} from '../lib/session-status-contract.ts'

/** The digest the BGOS and Codex pins hold too. */
const SHA256 = 'bdb3ece46b92634d29addf32511e0424d27ed357912f6a25433473b889082f3e'

const FILE = fileURLToPath(new URL('../lib/session-status-contract.ts', import.meta.url))
const GITATTRIBUTES = fileURLToPath(new URL('../.gitattributes', import.meta.url))

/** An en dash or an em dash, spelled as escapes so this file carries neither. */
const DASH = new RegExp('[\\u2013\\u2014]')

test('still has the bytes BGOS and the Codex plugin are pinned to', () => {
  const digest = createHash('sha256').update(readFileSync(FILE)).digest('hex')
  assert.deepEqual(
    { file: 'session-status-contract.ts', digest },
    { file: 'session-status-contract.ts', digest: SHA256 },
    'lib/session-status-contract.ts no longer hashes to the digest BGOS and codex-channel-bgos pin. ' +
      'Change all three copies and all three pins together, or put this copy back.',
  )
})

test('is LF, no BOM, no dash, and .gitattributes keeps it LF on Windows', () => {
  const bytes = readFileSync(FILE)
  assert.notEqual(bytes[0], 0xef)
  const text = bytes.toString('utf8')
  assert.equal(text.includes('\r'), false)
  assert.doesNotMatch(text, DASH)
  assert.match(readFileSync(GITATTRIBUTES, 'utf8'), /^lib\/session-status-contract\.ts text eol=lf$/m)
})

test('imports nothing and uses only erasable TypeScript, so node type stripping runs it', () => {
  const text = readFileSync(FILE, 'utf8')
  const source = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true)
  const banned: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isDecorator(node)
    ) {
      banned.push(ts.SyntaxKind[node.kind])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.deepEqual(banned, [])
})

test('names the heartbeat key, the version and the marker this daemon sends', () => {
  assert.equal(SESSION_STATUS_KEY, 'sessionStatus')
  assert.equal(SESSION_STATUS_VERSION, 1)
  assert.equal(POSTED_BY_FIELD, 'postedBy')
  assert.equal(POSTED_BY_CONNECTION, 'connection')
})
