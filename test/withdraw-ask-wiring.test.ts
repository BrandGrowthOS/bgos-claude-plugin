/**
 * withdraw_ask retires every row of ONE question card the agent no longer
 * needs, as codex-channel-bgos does on a timeout or a Stop (PATCH
 * messages/{id} { options: [], renderMode: "inline" }), and forgets the group
 * only once every row is retired, so a failed PATCH can be retried by calling
 * the tool again and a half retired card never goes silent.
 *
 * server.ts is a monolith no test can import, so this reads the source, the
 * repo idiom (test/session-status-wiring.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function toolCase(name: string): string {
  const at = server.indexOf(`\n    case '${name}': {`)
  assert.ok(at >= 0, `the ${name} case exists`)
  const next = server.indexOf('\n    case \'', at + 10)
  return server.slice(at, next)
}

test('withdraw_ask is a listed tool that takes the ask_id', () => {
  const at = server.indexOf("name: 'withdraw_ask',")
  assert.ok(at >= 0, 'withdraw_ask is in the tool list')
  const decl = server.slice(at, server.indexOf("\n    {\n      name: '", at))
  assert.match(decl, /required: \['ask_id'\]/)
})

test('every row of the group is PATCHed with the retire body', () => {
  const body = toolCase('withdraw_ask')
  assert.match(body, /for \(const q of ask\.questions\)/)
  assert.match(body, /bgosPatch\(`messages\/\$\{q\.messageId\}`, askRetireBody\(\)\)/)
})

test('the group is forgotten only after every row is retired', () => {
  const body = toolCase('withdraw_ask')
  const patch = body.indexOf('bgosPatch(')
  const failedCheck = body.indexOf('if (failed.length > 0)')
  const forget = body.indexOf('askTracker.withdraw(askId)')
  assert.ok(patch >= 0 && failedCheck > patch && forget > failedCheck, 'PATCH, then the failure check, then forget')
})

test('a withdrawn group never announces later: its ids join the shared announced set', () => {
  const body = toolCase('withdraw_ask')
  const forget = body.indexOf('askTracker.withdraw(askId)')
  assert.match(body.slice(forget), /rememberAnnouncedClick\(q\.messageId\)/)
})
