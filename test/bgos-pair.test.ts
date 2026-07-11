/**
 * bgos-pair tests (pure helpers + a tiny real-fs creds-file check).
 *
 * bgos-pair is the pairing installer: it exchanges a one time pair code for a
 * pairing token (POST /integrations/pair-exchange), pushes a one entry agent
 * catalog so the app can bind the agent, discovers the bound assistant id via
 * GET /integrations/me, and writes ~/.bgos-agent/credentials.json (0600). This
 * suite pins the pure pieces: arg parsing, api-base normalization, the request
 * bodies, response classification (app-first 201 body AND RFC 8628 200-status
 * bodies), assistant selection, the credentials shape, and the 0600 mode.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  isRunAsMain,
  DEFAULT_API_BASE,
  CLAUDE_INTEGRATION,
  CLAUDE_AGENT_ROUTE,
  CLAUDE_AGENT_NAME,
  CREDENTIALS_FILE_MODE,
  normalizeApiBase,
  extractPairCode,
  parsePairArgs,
  buildExchangeBody,
  buildCatalogBody,
  classifyExchangeResponse,
  pickAssistantId,
  buildCredentials,
  credentialsPath,
  writeCredentialsFile,
} from '../bin/bgos-pair.mjs'

test('normalizeApiBase always yields a single /api/v1 suffix', () => {
  assert.equal(normalizeApiBase('https://api.brandgrowthos.ai'), 'https://api.brandgrowthos.ai/api/v1')
  assert.equal(normalizeApiBase('https://api.brandgrowthos.ai/'), 'https://api.brandgrowthos.ai/api/v1')
  assert.equal(normalizeApiBase('https://api.brandgrowthos.ai/api/v1'), 'https://api.brandgrowthos.ai/api/v1')
  assert.equal(normalizeApiBase('https://api.brandgrowthos.ai/api/v1/'), 'https://api.brandgrowthos.ai/api/v1')
})

test('extractPairCode accepts a bare code and a pasted command, rejects junk', () => {
  assert.equal(extractPairCode('BGOS-7F3A-2K'), 'BGOS-7F3A-2K')
  assert.equal(extractPairCode('  bgos-7f3a-2k  '), 'BGOS-7F3A-2K')
  assert.equal(extractPairCode('bgos-pair BGOS-7F3A-2K'), 'BGOS-7F3A-2K')
  assert.equal(extractPairCode('npx bgos-pair OC-4H7-Q2N'), 'OC-4H7-Q2N')
  assert.equal(extractPairCode('not a code with spaces!'), '')
  assert.equal(extractPairCode('has spaces here'), '')
  assert.equal(extractPairCode(''), '')
})

test('parsePairArgs reads the code, default backend, and --backend override', () => {
  const a = parsePairArgs(['BGOS-7F3A-2K'])
  assert.equal(a.errors.length, 0)
  assert.equal(a.args.code, 'BGOS-7F3A-2K')
  assert.equal(a.args.apiBase, DEFAULT_API_BASE)

  const b = parsePairArgs(['BGOS-7F3A-2K', '--backend', 'https://staging.example.com'])
  assert.equal(b.errors.length, 0)
  assert.equal(b.args.apiBase, 'https://staging.example.com/api/v1')

  const c = parsePairArgs(['--help'])
  assert.equal(c.args.help, true)

  const d = parsePairArgs([])
  assert.ok(d.errors.length > 0, 'missing code is an error')
})

test('buildExchangeBody carries the claude-code integration and a one entry catalog', () => {
  const body = buildExchangeBody({
    code: 'BGOS-7F3A-2K',
    deviceLabel: 'mac-mini (Claude Code)',
    version: '0.20.0',
  })
  assert.equal(body.code, 'BGOS-7F3A-2K')
  assert.equal(body.deviceLabel, 'mac-mini (Claude Code)')
  assert.equal(body.integration, CLAUDE_INTEGRATION)
  assert.equal(body.daemonVersion, '0.20.0')
  assert.deepEqual(body.agentCatalog, [{ agent_route: CLAUDE_AGENT_ROUTE, name: CLAUDE_AGENT_NAME }])
})

test('buildCatalogBody is the single claude agent, matching the exchange catalog', () => {
  assert.deepEqual(buildCatalogBody(), {
    agents: [{ agent_route: CLAUDE_AGENT_ROUTE, name: CLAUDE_AGENT_NAME }],
  })
})

test('classifyExchangeResponse: app-first 201 body yields ok with the token', () => {
  const r = classifyExchangeResponse(201, {
    pairing_token: 'pair_secret',
    pairing_id: 42,
    user_id: 'user_abc',
  })
  assert.equal(r.kind, 'ok')
  assert.equal(r.pairingToken, 'pair_secret')
  assert.equal(r.pairingId, 42)
  assert.equal(r.userId, 'user_abc')
})

test('classifyExchangeResponse: RFC 8628 200-status bodies map to poll states', () => {
  assert.equal(classifyExchangeResponse(200, { status: 'authorization_pending' }).kind, 'pending')
  assert.equal(classifyExchangeResponse(200, { status: 'slow_down' }).kind, 'slow_down')
  assert.equal(classifyExchangeResponse(200, { status: 'access_denied' }).kind, 'denied')
  assert.equal(classifyExchangeResponse(200, { status: 'expired_token' }).kind, 'expired')
})

test('classifyExchangeResponse: error status yields error with a message', () => {
  const r = classifyExchangeResponse(400, { message: 'Invalid code' })
  assert.equal(r.kind, 'error')
  assert.match(String(r.message), /Invalid code/)
})

test('pickAssistantId prefers the claude route, else the first, null when empty', () => {
  assert.equal(
    pickAssistantId({ assistants: [{ assistant_id: 1, agent_route: 'other' }, { assistant_id: 2, agent_route: 'claude' }] }),
    2,
  )
  assert.equal(pickAssistantId({ assistants: [{ assistant_id: 7, agent_route: 'solo' }] }), 7)
  assert.equal(pickAssistantId({ assistants: [] }), null)
  assert.equal(pickAssistantId({}), null)
})

test('buildCredentials is the exact durable shape server.ts reads', () => {
  const creds = buildCredentials({
    backendUrl: 'https://api.brandgrowthos.ai/api/v1',
    pairingToken: 'pair_secret',
    pairingId: 42,
    userId: 'user_abc',
    assistantId: 1234,
    nowIso: '2026-07-11T00:00:00.000Z',
  })
  assert.deepEqual(creds, {
    backendUrl: 'https://api.brandgrowthos.ai/api/v1',
    pairingToken: 'pair_secret',
    pairingId: 42,
    userId: 'user_abc',
    assistantId: 1234,
    pairedAt: '2026-07-11T00:00:00.000Z',
  })
})

test('credentialsPath is ~/.bgos-agent/credentials.json', () => {
  assert.equal(credentialsPath('/home/kc'), '/home/kc/.bgos-agent/credentials.json')
})

test('isRunAsMain matches through a symlinked bin (npx/npm shim, /tmp on macOS)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-main-'))
  try {
    const real = join(dir, 'real.mjs')
    const link = join(dir, 'shim.mjs')
    await writeFile(real, '// entry\n')
    await symlink(real, link)
    const moduleUrl = pathToFileURL(real).href
    // Invoked via the symlink shim: argv[1] is the link, module url is the real
    // path. A plain href compare would return false and main() would never run.
    assert.equal(isRunAsMain(link, moduleUrl), true)
    // Invoked directly: also true.
    assert.equal(isRunAsMain(real, moduleUrl), true)
    // A different file is not the entry point.
    const other = join(dir, 'other.mjs')
    await writeFile(other, '// other\n')
    assert.equal(isRunAsMain(other, moduleUrl), false)
    // Non-string argv[1] (imported, not executed).
    assert.equal(isRunAsMain(undefined, moduleUrl), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeCredentialsFile pins mode 600 and round-trips the JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-'))
  try {
    const path = join(dir, '.bgos-agent', 'credentials.json')
    const creds = buildCredentials({
      backendUrl: 'https://api.brandgrowthos.ai/api/v1',
      pairingToken: 'pair_secret',
      pairingId: 42,
      userId: 'user_abc',
      assistantId: 1234,
      nowIso: '2026-07-11T00:00:00.000Z',
    })
    await writeCredentialsFile(path, creds)
    const st = await stat(path)
    assert.equal(st.mode & 0o777, CREDENTIALS_FILE_MODE)
    const back = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(back, creds)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
