/**
 * A backend refusal reaches the model whole (HOAI board row 81a68f4).
 *
 * WHY: every REST helper in server.ts cut the error body with text.slice(0, 200), so a share
 * recipient's 403 mission refusal reached the model as "...works in that person's chat ins". And the
 * MCP server declared version 0.19.0 while package.json said 0.69.x.
 *
 * Run with: npm test  (node --test via tsx, no network)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ERROR_MESSAGE_MAX, errorBodyText } from '../lib/error-body.ts'
import { mcpServerInfo } from '../lib/mcp-server-info.ts'
import { readOwnVersion } from '../lib/version-heartbeat.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverSource = readFileSync(join(repoRoot, 'server.ts'), 'utf8')

const MISSION_REFUSAL =
  "Missions belong to this agent's owner for now, so a shared agent cannot start, change or stop one for you. " +
  "Ask the owner, or describe what you want done in this chat and the agent will do it where it works in that person's chat instead."

test('the real 403 mission refusal reaches the error whole', () => {
  const body = JSON.stringify({ message: MISSION_REFUSAL, error: 'Forbidden', statusCode: 403 })
  assert.ok(MISSION_REFUSAL.length > 200 && MISSION_REFUSAL.length <= ERROR_MESSAGE_MAX)
  const out = errorBodyText(body)
  assert.equal(out, MISSION_REFUSAL)
  assert.ok(out.endsWith("works in that person's chat instead."))
})

test('a string-array message is joined', () => {
  const body = JSON.stringify({ message: ['name must be a string', 'goal should not be empty'], statusCode: 400 })
  assert.equal(errorBodyText(body), 'name must be a string; goal should not be empty')
})

test('a message longer than the bound is cut at the bound', () => {
  const out = errorBodyText(JSON.stringify({ message: 'x'.repeat(5000) }))
  assert.equal(out.length, ERROR_MESSAGE_MAX)
})

test('a non-JSON body stays bounded', () => {
  const out = errorBodyText('<html>' + 'a'.repeat(100000) + '</html>')
  assert.ok(out.length <= 200, `got ${out.length}`)
  assert.ok(out.startsWith('<html>'))
})

test('a mid-size non-JSON body (a proxy error page) stays bounded', () => {
  const out = errorBodyText('<html>' + 'a'.repeat(5000) + '</html>')
  assert.equal(out.length, 200)
})

test('a huge JSON body without a usable message stays bounded', () => {
  const out = errorBodyText(JSON.stringify({ items: 'y'.repeat(100000) }))
  assert.ok(out.length <= 200, `got ${out.length}`)
  assert.equal(errorBodyText(JSON.stringify({ message: 42 })).length <= 200, true)
  assert.equal(errorBodyText(''), '')
})

test('every error site in server.ts goes through the helper', () => {
  assert.equal(/text\.slice\(0, 200\)/.test(serverSource), false)
  const uses = serverSource.match(/errorBodyText\(text\)/g) ?? []
  assert.equal(uses.length, 9, `expected the 9 error sites, got ${uses.length}`)
})

test('serverInfo carries the real package version', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  assert.deepEqual(mcpServerInfo(readOwnVersion(repoRoot)), { name: 'bgos', version: pkg.version })
  assert.equal(mcpServerInfo(null).version, '0.0.0')
  assert.equal(/version: '0\.19\.0'/.test(serverSource), false)
  assert.match(serverSource, /new Server\(\s*mcpServerInfo\(RUNNING_VERSION\)/)
})

test('odd message shapes fall back to the bounded raw body', () => {
  for (const message of [null, 42, {}, [], [1, 2], '', '   ']) {
    const body = JSON.stringify({ message, pad: 'z'.repeat(500) })
    const out = errorBodyText(body)
    assert.equal(out, body.slice(0, 200), JSON.stringify(message))
  }
  assert.equal(errorBodyText('[1,2]'), '[1,2]')
  assert.equal(errorBodyText('"just a string"'), '"just a string"')
})

test('a cut through an emoji leaves no lone surrogate', () => {
  const out = errorBodyText(JSON.stringify({ message: 'x'.repeat(599) + '\u{1F600}' }))
  assert.equal(out, 'x'.repeat(599))
  assert.equal(errorBodyText(JSON.stringify({ message: 'x'.repeat(598) + '\u{1F600}' })).length, 600)
})
