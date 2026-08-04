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
  selectAssistantBinding,
  resolveRequestedAssistantId,
  buildCredentials,
  credentialsPath,
  credentialsWritePath,
  resolveReadCredentialsPath,
  verifyWrittenCredentials,
  shouldCoWriteLegacy,
  legacyWriteBlocked,
  writeAndVerifyCredentials,
  restartInstructions,
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

// ── Defect 1: never guess the assistant on a many-agent account ─────────────

test('parsePairArgs reads --assistant-id', () => {
  const a = parsePairArgs(['BGOS-7F3A-2K', '--assistant-id', '871'])
  assert.equal(a.errors.length, 0)
  assert.equal(a.args.assistantId, '871')

  const b = parsePairArgs(['BGOS-7F3A-2K', '--assistant-id'])
  assert.ok(b.errors.length > 0, '--assistant-id without a value is an error')
})

test('resolveRequestedAssistantId: flag beats env, placeholder env is ignored', () => {
  assert.equal(
    resolveRequestedAssistantId({ argAssistantId: '871', env: { BGOS_ASSISTANT_ID: '872' } }),
    '871',
  )
  assert.equal(
    resolveRequestedAssistantId({ argAssistantId: '', env: { BGOS_ASSISTANT_ID: '872' } }),
    '872',
  )
  assert.equal(
    resolveRequestedAssistantId({
      argAssistantId: '',
      env: { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' },
    }),
    '',
  )
  assert.equal(resolveRequestedAssistantId({}), '')
})

test('selectAssistantBinding: a single bound assistant resolves without a request', () => {
  const r = selectAssistantBinding({ assistants: [{ assistant_id: 7, agent_route: 'claude' }] })
  assert.equal(r.kind, 'ok')
  assert.equal(r.assistantId, 7)
})

test('selectAssistantBinding: a requested id that is bound resolves to exactly that id', () => {
  const r = selectAssistantBinding(
    { assistants: [{ assistant_id: 871, agent_route: 'claude' }, { assistant_id: 872, agent_route: 'claude' }] },
    '871',
  )
  assert.equal(r.kind, 'ok')
  assert.equal(r.assistantId, 871)
})

test('selectAssistantBinding: a requested id that is NOT bound is a mismatch naming both sides', () => {
  const r = selectAssistantBinding(
    { assistants: [{ assistant_id: 872, agent_route: 'claude' }] },
    '871',
  )
  assert.equal(r.kind, 'mismatch')
  assert.equal(r.requestedId, '871')
  assert.deepEqual(r.boundIds, ['872'])
})

test('selectAssistantBinding: multiple candidates with no request never guess; they are listed', () => {
  const r = selectAssistantBinding({
    assistants: [
      { assistant_id: 871, agent_route: 'claude', name: 'Ava' },
      { assistant_id: 872, agent_route: 'claude', name: 'Guru' },
    ],
  })
  assert.equal(r.kind, 'ambiguous')
  assert.deepEqual(
    r.candidates.map((c: { assistant_id: number | string }) => String(c.assistant_id)),
    ['871', '872'],
  )
})

test('selectAssistantBinding: empty list is none', () => {
  assert.equal(selectAssistantBinding({ assistants: [] }).kind, 'none')
  assert.equal(selectAssistantBinding({}).kind, 'none')
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

// ── Defect 2: one credentials slot per assistant, not per OS user ───────────

test('credentialsWritePath defaults to a per-assistant file', () => {
  assert.equal(
    credentialsWritePath({ home: '/home/kc', assistantId: 871, env: {} }),
    '/home/kc/.bgos-agent/credentials-871.json',
  )
})

test('credentialsWritePath honours BGOS_CREDENTIALS_PATH outright', () => {
  assert.equal(
    credentialsWritePath({
      home: '/home/kc',
      assistantId: 871,
      env: { BGOS_CREDENTIALS_PATH: '/agents/ava/credentials.json' },
    }),
    '/agents/ava/credentials.json',
  )
})

test('credentialsWritePath falls back to the legacy file when no assistant is bound yet', () => {
  assert.equal(
    credentialsWritePath({ home: '/home/kc', assistantId: null, env: {} }),
    '/home/kc/.bgos-agent/credentials.json',
  )
})

test('resolveReadCredentialsPath mirrors the read order: override, per-assistant, legacy', () => {
  const home = '/home/kc'
  // BGOS_CREDENTIALS_PATH wins outright, even when a per-assistant file exists.
  assert.equal(
    resolveReadCredentialsPath({
      env: { BGOS_CREDENTIALS_PATH: '/x/c.json', BGOS_ASSISTANT_ID: '871' },
      home,
      exists: () => true,
    }),
    '/x/c.json',
  )
  // Per-assistant file wins when present for the configured id.
  assert.equal(
    resolveReadCredentialsPath({
      env: { BGOS_ASSISTANT_ID: '871' },
      home,
      exists: (p) => p === '/home/kc/.bgos-agent/credentials-871.json',
    }),
    '/home/kc/.bgos-agent/credentials-871.json',
  )
  // Absent per-assistant file falls back to the legacy single file.
  assert.equal(
    resolveReadCredentialsPath({
      env: { BGOS_ASSISTANT_ID: '871' },
      home,
      exists: () => false,
    }),
    '/home/kc/.bgos-agent/credentials.json',
  )
  // No configured assistant id reads the legacy single file.
  assert.equal(
    resolveReadCredentialsPath({ env: {}, home, exists: () => true }),
    '/home/kc/.bgos-agent/credentials.json',
  )
})

// ── Post-write verification: pairing may not exit 0 on a file that will not
//    resolve to the intended assistant (the wrong-assistant write of 2026-08-04
//    passed as success precisely because nothing validated the written file). ─

test('verifyWrittenCredentials passes when the written file resolves to the intended id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-verify-'))
  try {
    const path = join(dir, '.bgos-agent', 'credentials-871.json')
    await writeCredentialsFile(
      path,
      buildCredentials({
        backendUrl: 'https://api.brandgrowthos.ai/api/v1',
        pairingToken: 'pair_secret',
        pairingId: 42,
        userId: 'user_abc',
        assistantId: 871,
        nowIso: '2026-08-04T00:00:00.000Z',
      }),
    )
    const r = verifyWrittenCredentials({ path, expectedAssistantId: '871', home: dir, env: {} })
    assert.equal(r.ok, true, r.reason)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyWrittenCredentials fails loudly on the old wrong-id write, naming both ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-verify-'))
  try {
    // Simulate the historical failure: intended 871 (Ava), file carries 872 (Guru).
    const path = join(dir, '.bgos-agent', 'credentials-871.json')
    await writeCredentialsFile(
      path,
      buildCredentials({
        backendUrl: 'https://api.brandgrowthos.ai/api/v1',
        pairingToken: 'pair_secret',
        pairingId: 42,
        userId: 'user_abc',
        assistantId: 872,
        nowIso: '2026-08-04T00:00:00.000Z',
      }),
    )
    const r = verifyWrittenCredentials({ path, expectedAssistantId: '871', home: dir, env: {} })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /871/)
    assert.match(String(r.reason), /872/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyWrittenCredentials fails when the written path is not the one reads resolve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-verify-'))
  try {
    const path = join(dir, '.bgos-agent', 'credentials-871.json')
    await writeCredentialsFile(
      path,
      buildCredentials({
        backendUrl: 'https://api.brandgrowthos.ai/api/v1',
        pairingToken: 'pair_secret',
        pairingId: 42,
        userId: 'user_abc',
        assistantId: 871,
        nowIso: '2026-08-04T00:00:00.000Z',
      }),
    )
    // A conflicting BGOS_CREDENTIALS_PATH means the daemon would read elsewhere.
    const r = verifyWrittenCredentials({
      path,
      expectedAssistantId: '871',
      home: dir,
      env: { BGOS_CREDENTIALS_PATH: '/somewhere/else.json' },
    })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /somewhere\/else\.json/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Review fix 1: a fresh single-agent host (packaged plugin, no
//    BGOS_ASSISTANT_ID configured) must still come up after pairing. The
//    daemon with an empty env reads the legacy credentials.json, so pairing
//    co-writes it when that cannot clobber another agent. ──────────────────

function mkCreds(assistantId: number | string | null, token = 'pair_secret') {
  return buildCredentials({
    backendUrl: 'https://api.brandgrowthos.ai/api/v1',
    pairingToken: token,
    pairingId: 42,
    userId: 'user_abc',
    assistantId,
    nowIso: '2026-08-04T00:00:00.000Z',
  })
}

test('shouldCoWriteLegacy: absent or same-agent legacy is refreshed, another agent is never touched', () => {
  assert.equal(shouldCoWriteLegacy({ legacyCreds: null, assistantId: 901 }), true)
  assert.equal(
    shouldCoWriteLegacy({ legacyCreds: mkCreds(901, 'old_token'), assistantId: 901 }),
    true,
  )
  assert.equal(shouldCoWriteLegacy({ legacyCreds: mkCreds(872), assistantId: 871 }), false)
  assert.equal(shouldCoWriteLegacy({ legacyCreds: null, assistantId: null }), false)
})

test('legacyWriteBlocked: a live pairing for a bound assistant blocks the unbound legacy write', () => {
  assert.equal(legacyWriteBlocked(mkCreds(872)), true)
  assert.equal(legacyWriteBlocked(mkCreds(null)), false)
  assert.equal(legacyWriteBlocked(null), false)
  assert.equal(legacyWriteBlocked({ assistantId: 872 }), false, 'no token, nothing to protect')
})

test('fresh single-agent pairing resolves for a daemon with an EMPTY env (0.31.0 flow preserved)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-fresh-'))
  try {
    const r = await writeAndVerifyCredentials({ creds: mkCreds(901), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.path, join(home, '.bgos-agent', 'credentials-901.json'))
    assert.equal(r.legacyCoWritePath, join(home, '.bgos-agent', 'credentials.json'))
    assert.equal(r.needsEnvPin, false)
    // The reviewer's end-to-end check: resolve exactly as the daemon would,
    // with no BGOS_ASSISTANT_ID and no BGOS_CREDENTIALS_PATH, and find the token.
    const daemonPath = resolveReadCredentialsPath({ env: {}, home })
    const daemonCreds = JSON.parse(await readFile(daemonPath, 'utf8'))
    assert.equal(daemonCreds.pairingToken, 'pair_secret')
    assert.equal(daemonCreds.assistantId, 901)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('pairing a second agent NEVER touches the first agent\'s legacy slot (kc-server shape)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-second-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    await writeCredentialsFile(legacyPath, mkCreds(872, 'guru_token'))
    const before = await readFile(legacyPath, 'utf8')
    const r = await writeAndVerifyCredentials({ creds: mkCreds(871, 'ava_token'), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.path, join(home, '.bgos-agent', 'credentials-871.json'))
    assert.equal(r.legacyCoWritePath, null)
    assert.equal(await readFile(legacyPath, 'utf8'), before, 'legacy slot must be byte identical')
    // Without an env pin the daemon would read the OTHER agent's file, so the
    // operator must be told to set BGOS_ASSISTANT_ID.
    assert.equal(r.needsEnvPin, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('same-agent re-pair refreshes the legacy slot too', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-repair-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    await writeCredentialsFile(legacyPath, mkCreds(901, 'old_token'))
    const r = await writeAndVerifyCredentials({ creds: mkCreds(901, 'new_token'), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.legacyCoWritePath, legacyPath)
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
    assert.equal(legacy.pairingToken, 'new_token')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── Review fix 2: the unbound (assistantId null) legacy write may not clobber
//    a live pairing, the exact overwrite class this branch exists to kill. ──

test('unbound pairing refuses to overwrite a live legacy pairing, naming the bound assistant', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-clobber-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    await writeCredentialsFile(legacyPath, mkCreds(872, 'guru_token'))
    const before = await readFile(legacyPath, 'utf8')
    const r = await writeAndVerifyCredentials({ creds: mkCreds(null, 'new_token'), env: {}, home })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /872/)
    assert.equal(await readFile(legacyPath, 'utf8'), before, 'live pairing must survive')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('unbound pairing may overwrite an unbound placeholder legacy file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-placeholder-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    await writeCredentialsFile(legacyPath, mkCreds(null, 'old_token'))
    const r = await writeAndVerifyCredentials({ creds: mkCreds(null, 'new_token'), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
    assert.equal(legacy.pairingToken, 'new_token')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── Defect 4: the restart instruction must be honest for both topologies ────

test('restartInstructions names both channel forms and when each applies', () => {
  const text = restartInstructions().join('\n')
  assert.match(text, /restart your agent process the way it normally starts/i)
  assert.match(text, /plugin:hoai@hoai/)
  assert.match(text, /server:bgos/)
  assert.match(text, /packaged/i)
  assert.match(text, /checkout|multi-agent/i)
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
