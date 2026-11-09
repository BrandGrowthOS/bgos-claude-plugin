/**
 * Every assistant write that carries a client key needs a proof this plugin
 * does not hold (test/helpers/keyed-assistant-rule.ts), so one that gains a
 * clientId is refused with a 403 on every send. The only clientId in shipped
 * code is the browser relay's own session id, which never reaches a message route.
 */
import { strict as assert } from 'node:assert'
import { createHmac } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'

import { threadReplyRefused } from './helpers/keyed-assistant-rule.ts'

const ROOT = join(import.meta.dirname, '..')
const BROWSER_RELAY_ONLY = [
  'bin/hoai-browser-host.mjs',
  'bin/hoai-browser-mcp.mjs',
  'lib/browser-profile-core/runtime-endpoint.js',
  'lib/browser-profile-pairing-client.mjs',
  'lib/browser-profile-permission-client.mjs',
]

function shipped(path: string): string[] {
  if (statSync(path).isFile()) return /\.(ts|mjs|cjs|js)$/.test(path) ? [path] : []
  return readdirSync(path).flatMap((name) => (name === 'node_modules' ? [] : shipped(join(path, name))))
}

test('no sender in the plugin puts a client key on an assistant write', () => {
  const senders = ['server.ts', 'lane-server.ts', 'lib', 'bin', 'hooks']
    .flatMap((entry) => shipped(join(ROOT, entry)))
    .filter((file) => /\bclientId\b/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file).split(sep).join('/'))
    .sort()
  assert.deepEqual(senders, BROWSER_RELAY_ONLY)
})

test('the fixture follows the server: a key needs the matching secret, and no key needs nothing', () => {
  const hash = createHmac('sha256', 'bgos-assistant-credential').update('right').digest('hex')
  const keyed = { clientId: 'k' }
  assert.equal(threadReplyRefused({}, { text: 'x' }), false)
  assert.equal(threadReplyRefused({ 'x-bgos-pairing': 't' }, keyed, hash), true)
  assert.equal(threadReplyRefused({ 'x-bgos-a2a-signature': 'v1=x' }, keyed, hash), true)
  assert.equal(threadReplyRefused({ 'x-caller-assistant-secret': 'wrong' }, keyed, hash), true)
  assert.equal(threadReplyRefused({ 'x-caller-assistant-secret': 'right' }, keyed, null), true)
  assert.equal(threadReplyRefused({ 'x-caller-assistant-secret': 'right' }, keyed, hash), false)
})
