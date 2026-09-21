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
import { mkdtemp, mkdir, readFile, stat, rm, writeFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  main,
  isRunAsMain,
  DEFAULT_API_BASE,
  CLAUDE_INTEGRATION,
  CLAUDE_AGENT_ROUTE,
  CLAUDE_AGENT_NAME,
  CREDENTIALS_FILE_MODE,
  PAIR_EXIT_CODES,
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
  describeFileProtection,
  pairExitCode,
  win32AclCommand,
  dedupeLegacyAfterWrite,
  legacyWriteBlocked,
  writeAndVerifyCredentials,
  restartInstructions,
  writeCredentialsFile,
  bakeMcpPin,
  bakeLaunchPin,
  launchFolderLiveSafe,
  classifyPairCwd,
  pairCwdRefusalLines,
  FOLDER_PIN_FILE_NAME,
} from '../bin/bgos-pair.mjs'
import { detectInstallMethod } from '../bin/bgos-install-method.mjs'
import { runSetup } from '../bin/hoai-core.mjs'
import { resolveCredentialsSelection } from '../lib/agent-credentials.ts'

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

// Exchange contract (identical on the backend, PairExchangeDto): the body
// carries intended_assistant_id whenever --assistant-id / BGOS_ASSISTANT_ID
// pinned an identity, so the backend's mint-time overlap guard can scope its
// overlap unit to the pairing serving THAT assistant instead of the catalog
// (whose entry is identical across every Claude daemon and froze multi-agent
// accounts on 2026-08-04).
test('buildExchangeBody carries intended_assistant_id when an identity is pinned', () => {
  const body = buildExchangeBody({
    code: 'BGOS-7F3A-2K',
    deviceLabel: 'kc-server (Claude Code)',
    version: '0.33.1',
    intendedAssistantId: '871',
  })
  assert.equal(body.intended_assistant_id, 871)
  assert.equal(typeof body.intended_assistant_id, 'number')
})

test('buildExchangeBody omits intended_assistant_id when nothing was pinned', () => {
  const unpinned = buildExchangeBody({
    code: 'BGOS-7F3A-2K',
    deviceLabel: 'kc-server (Claude Code)',
    version: '0.33.1',
  })
  assert.equal('intended_assistant_id' in unpinned, false)

  const empty = buildExchangeBody({
    code: 'BGOS-7F3A-2K',
    deviceLabel: 'kc-server (Claude Code)',
    version: '0.33.1',
    intendedAssistantId: '',
  })
  assert.equal('intended_assistant_id' in empty, false)
})

test('buildExchangeBody omits intended_assistant_id when the pin is not a positive integer id', () => {
  for (const junk of ['abc', '-3', '0', '12.5', '${user_config.assistant_id}']) {
    const body = buildExchangeBody({
      code: 'BGOS-7F3A-2K',
      deviceLabel: 'kc-server (Claude Code)',
      version: '0.33.1',
      intendedAssistantId: junk,
    })
    assert.equal('intended_assistant_id' in body, false, `junk pin ${JSON.stringify(junk)} must not be sent`)
  }
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

/** Compare paths in posix spelling. The path helpers build with node:path
 *  join, which uses the PLATFORM separator, so on win32 these literal
 *  expectations would fail on '\' vs '/' alone while every segment is right.
 *  Normalizing only the separator keeps the full literal pinned. */
const asPosix = (path: string) => path.replaceAll('\\', '/')

test('credentialsPath is ~/.bgos-agent/credentials.json', () => {
  assert.equal(asPosix(credentialsPath('/home/kc')), '/home/kc/.bgos-agent/credentials.json')
})

// ── Defect 2: one credentials slot per assistant, not per OS user ───────────

test('credentialsWritePath defaults to a per-assistant file', () => {
  assert.equal(
    asPosix(credentialsWritePath({ home: '/home/kc', assistantId: 871, env: {} })),
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
    asPosix(credentialsWritePath({ home: '/home/kc', assistantId: null, env: {} })),
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
  // Per-assistant file wins when present for the configured id. The exists
  // probe compares in posix spelling too: the resolver hands it a
  // platform-separator path.
  assert.equal(
    asPosix(
      resolveReadCredentialsPath({
        env: { BGOS_ASSISTANT_ID: '871' },
        home,
        exists: (p) => asPosix(p) === '/home/kc/.bgos-agent/credentials-871.json',
      }),
    ),
    '/home/kc/.bgos-agent/credentials-871.json',
  )
  // Absent per-assistant file falls back to the legacy single file.
  assert.equal(
    asPosix(
      resolveReadCredentialsPath({
        env: { BGOS_ASSISTANT_ID: '871' },
        home,
        exists: () => false,
      }),
    ),
    '/home/kc/.bgos-agent/credentials.json',
  )
  // No configured assistant id reads the legacy single file.
  assert.equal(
    asPosix(resolveReadCredentialsPath({ env: {}, home, exists: () => true })),
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

// ── Legacy single-slot dedupe: a fresh single-agent host (packaged plugin, no
//    BGOS_ASSISTANT_ID configured) must still come up after pairing. The
//    empty-env daemon resolves via the folder-aware boot resolver's rule 4
//    (a SOLE credentials-<id>.json with NO legacy file next to it), so pairing
//    DELETES a junk or stale same-agent credentials.json after the
//    per-assistant write instead of co-writing it. The co-write it replaces
//    kept a second live copy of the token, which was itself the single-slot
//    identity trap (KC-WINSAMSUNG, Mark, 888, 2026-08-06: four pairings, four
//    behaviours, and deleting the file by hand was exactly the absence that
//    made the next pairing rewrite it). Another agent's live pairing in the
//    legacy slot is still never touched. ─────────────────────────────────────

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

/**
 * The install-cli step, stubbed. Every main() test injects one: the real step
 * writes a shim and a PATH line into a home directory, and a test may never
 * reach for a real one. Records its calls so a test can prove what pairing
 * handed it.
 */
function fakeInstallCli(
  result: { ok: boolean; binDir: string } | Error = { ok: true, binDir: '/tmp/fake-bin' },
) {
  const calls: Array<Record<string, unknown>> = []
  const impl = async (opts: Record<string, unknown>) => {
    calls.push(opts)
    if (result instanceof Error) throw result
    return result
  }
  impl.calls = calls
  return impl
}

test('dedupeLegacyAfterWrite: unbound keeps, junk deletes, same agent deletes, another agent keeps', () => {
  // Rule 1: an unbound write (no assistantId) writes the legacy slot itself
  // and owns it; deleting here would eat its own write.
  assert.equal(dedupeLegacyAfterWrite({ legacyCreds: mkCreds(872), assistantId: null }), 'keep')
  assert.equal(dedupeLegacyAfterWrite({ legacyCreds: null, assistantId: '' }), 'keep')
  // Rule 2: junk (unparsable -> null, or tokenless) shadows the boot
  // resolver's sole-per-assistant rule, so it goes.
  assert.equal(dedupeLegacyAfterWrite({ legacyCreds: null, assistantId: 901 }), 'delete')
  assert.equal(dedupeLegacyAfterWrite({ legacyCreds: { assistantId: 901 }, assistantId: 901 }), 'delete')
  // Rule 3: this same agent's stale copy; the per-assistant file just written
  // is the single source of truth.
  assert.equal(
    dedupeLegacyAfterWrite({ legacyCreds: mkCreds(901, 'old_token'), assistantId: 901 }),
    'delete',
  )
  // Rule 4: another agent's live pairing is not ours to remove.
  assert.equal(dedupeLegacyAfterWrite({ legacyCreds: mkCreds(872), assistantId: 871 }), 'keep')
})

test('legacyWriteBlocked: a live pairing for a bound assistant blocks the unbound legacy write', () => {
  assert.equal(legacyWriteBlocked(mkCreds(872)), true)
  assert.equal(legacyWriteBlocked(mkCreds(null)), false)
  assert.equal(legacyWriteBlocked(null), false)
  assert.equal(legacyWriteBlocked({ assistantId: 872 }), false, 'no token, nothing to protect')
})

test('fresh single-agent pairing resolves for a daemon with an EMPTY env (folder-aware rule 4)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-fresh-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    const r = await writeAndVerifyCredentials({ creds: mkCreds(901), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.path, join(home, '.bgos-agent', 'credentials-901.json'))
    // No legacy file existed, so nothing was deduped and nothing is co-written:
    // the per-assistant file stands alone from the first write.
    assert.equal(r.legacyDeduped, null)
    assert.equal(existsSync(legacyPath), false)
    // Exit-affecting: the string-mirror probe alone would demand a pin here,
    // but the daemon's folder-aware boot resolver does not need one (rule 4),
    // and writeAndVerifyCredentials must answer for the resolver that actually
    // runs at boot.
    assert.equal(r.needsEnvPin, false)
    // The end-to-end check, against the REAL boot resolver: empty env, cwd
    // holding no folder pin, and rule 4 still finds the sole per-assistant file.
    const selection = resolveCredentialsSelection({
      env: {},
      defaultPath: legacyPath,
      cwd: home,
    })
    assert.equal(selection.kind, 'ok')
    assert.equal(selection.kind === 'ok' && selection.via, 'sole-per-assistant')
    assert.equal(selection.kind === 'ok' && selection.path, r.path)
    const daemonCreds = JSON.parse(await readFile(r.path, 'utf8'))
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
    // The dedupe judged the legacy slot and KEPT it: it holds another agent's
    // live pairing, and the result names whose so main() can say it out loud.
    assert.equal(r.legacyDeduped, null)
    assert.equal(r.legacyKeptForOtherAgent, '872')
    assert.equal(await readFile(legacyPath, 'utf8'), before, 'legacy slot must be byte identical')
    // Without an env pin the daemon would read the OTHER agent's file, so the
    // operator must be told to set BGOS_ASSISTANT_ID.
    assert.equal(r.needsEnvPin, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('same-agent re-pair DELETES the stale legacy slot; the per-assistant file is the single source of truth', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-repair-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    await writeCredentialsFile(legacyPath, mkCreds(901, 'old_token'))
    const r = await writeAndVerifyCredentials({ creds: mkCreds(901, 'new_token'), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    // Deduped: the stale same-agent copy is gone, the result reports it, and
    // main() can print what actually happened (a same-agent removal, not junk).
    assert.equal(r.legacyDeduped, legacyPath)
    assert.equal(r.legacyDedupedHeldSameAgent, true)
    assert.equal(existsSync(legacyPath), false)
    // THE read-side invariant behind the delete: with the legacy file gone and
    // credentials-901.json the sole candidate, an EMPTY-env daemon launched
    // from an unpinned cwd resolves the per-assistant file via the boot
    // resolver's rule 4, so the exit-affecting needsEnvPin must be false.
    assert.equal(r.needsEnvPin, false)
    const selection = resolveCredentialsSelection({
      env: {},
      defaultPath: legacyPath,
      cwd: home,
    })
    assert.equal(selection.kind, 'ok')
    assert.equal(selection.kind === 'ok' && selection.via, 'sole-per-assistant')
    assert.equal(selection.kind === 'ok' && selection.path, r.path)
    const daemonCreds = JSON.parse(await readFile(r.path, 'utf8'))
    assert.equal(daemonCreds.pairingToken, 'new_token')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('junk legacy credentials.json is deleted at write time (it would shadow rule 4)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-junk-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    await mkdir(join(home, '.bgos-agent'), { recursive: true })
    await writeFile(legacyPath, 'not json {')
    const r = await writeAndVerifyCredentials({ creds: mkCreds(901), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.legacyDeduped, legacyPath)
    // Honest reporting input: junk is NOT a same-agent pairing, so main()
    // must not claim "(same agent)" about a file that held garbage.
    assert.equal(r.legacyDedupedHeldSameAgent, false)
    assert.equal(existsSync(legacyPath), false)
    assert.equal(r.needsEnvPin, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('multi-agent host: dedupe still fires, but the pin requirement is untouched (exit 3 path)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-multi-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    // Another agent already lives here, and a stale same-agent legacy copy sits
    // in the shared slot.
    await writeCredentialsFile(join(home, '.bgos-agent', 'credentials-935.json'), mkCreds(935, 'other_token'))
    await writeCredentialsFile(legacyPath, mkCreds(871, 'stale_token'))
    const r = await writeAndVerifyCredentials({ creds: mkCreds(871, 'new_token'), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.legacyDeduped, legacyPath)
    assert.equal(existsSync(legacyPath), false)
    // NOT weakened: with credentials-935.json next door the sole-per-assistant
    // rule cannot apply, so the pin stays required and pairExitCode still
    // refuses to call the pairing done.
    assert.equal(r.needsEnvPin, true)
    assert.equal(
      pairExitCode({ needsEnvPin: r.needsEnvPin, otherAgentCount: 1 }),
      PAIR_EXIT_CODES.PIN_REQUIRED,
    )
    // And the boot resolver REFUSES rather than guessing between the two ids.
    const selection = resolveCredentialsSelection({
      env: {},
      defaultPath: legacyPath,
      cwd: home,
    })
    assert.equal(selection.kind, 'refuse')
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

test('unbound pairing may overwrite an unbound placeholder legacy file, and never deletes it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-placeholder-'))
  try {
    const legacyPath = join(home, '.bgos-agent', 'credentials.json')
    await writeCredentialsFile(legacyPath, mkCreds(null, 'old_token'))
    const r = await writeAndVerifyCredentials({ creds: mkCreds(null, 'new_token'), env: {}, home })
    assert.equal(r.ok, true, r.reason)
    // The unbound flow's write target IS the legacy slot: the dedupe never
    // runs against it (dedupeLegacyAfterWrite rule 1), so the file it just
    // wrote survives.
    assert.equal(r.legacyDeduped, null)
    assert.equal(existsSync(legacyPath), true)
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
    assert.equal(legacy.pairingToken, 'new_token')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── Defect 4 (revised by fix 02, then superseded 2026-08-25): pairing used to
//    print a raw claude launch line, choosing the channel spec from detection
//    when it had one and offering BOTH forms when it did not. The spec is
//    load-bearing (a marketplace install launched with the clone spec drops
//    every inbound message silently, 2026-08-21), so the both-forms branch was
//    a coin flip handed to an operator. `hoai` removes the choice instead of
//    improving it: it re-detects on every launch, so the instruction is now
//    one line, the same for every install shape. ─────────────────────────────

test('restartInstructions: the whole instruction is /exit then hoai, with NO channel spec to get wrong', () => {
  const marketplace = detectInstallMethod({
    env: { CLAUDE_PLUGIN_ROOT: '/home/kc/.claude/plugins/cache/hoai/hoai/0.34.0' },
    home: '/home/kc',
  })
  assert.equal(marketplace.method, 'marketplace')
  const clone = detectInstallMethod({
    env: { CLAUDE_PLUGIN_ROOT: '/home/kc/bgos-claude-plugin' },
    home: '/home/kc',
  })
  assert.equal(clone.method, 'clone')

  // Every shape, INCLUDING no detection at all, gets the same instruction. The
  // old "known channel forms" coin flip is gone.
  for (const detection of [marketplace, clone, null, undefined]) {
    const text = restartInstructions(detection as never).join('\n')
    assert.match(text, /type \/exit in its Claude Code session/i)
    assert.match(text, /^ {2}hoai$/m, 'the command to type is exactly hoai')
    // No raw launch line, and neither channel spec, is ever handed to a user.
    assert.doesNotMatch(text, /--dangerously-load-development-channels/)
    assert.doesNotMatch(text, /plugin:hoai@hoai/)
    assert.doesNotMatch(text, /server:bgos/)
    assert.doesNotMatch(text, /--channels/)
    // And it warns off the alias that would freeze a spec back in.
    assert.match(text, /Do NOT put a hoai alias/)
    // The non-circular escape hatch for a machine with no hoai on PATH. It must
    // be install-cli, never a launch: run under npx, install-method detection
    // sees the npx temp dir and would hand a marketplace install the clone spec.
    assert.match(text, /npx --yes --package \S+ hoai install-cli/)
  }
})

test('restartInstructions: a detection still reports HOW it was detected, as a diagnostic', () => {
  const marketplace = detectInstallMethod({
    env: { CLAUDE_PLUGIN_ROOT: '/home/kc/.claude/plugins/cache/hoai/hoai/0.34.0' },
    home: '/home/kc',
  })
  const clone = detectInstallMethod({
    env: { CLAUDE_PLUGIN_ROOT: '/home/kc/bgos-claude-plugin' },
    home: '/home/kc',
  })
  assert.match(restartInstructions(marketplace).join('\n'), /detected: marketplace install/i)
  assert.match(restartInstructions(clone).join('\n'), /detected: local checkout/i)
  // With no detection there is simply no such line, and nothing is guessed.
  assert.doesNotMatch(restartInstructions(null).join('\n'), /detected:/i)
})

test('isRunAsMain matches through a symlinked bin (npx/npm shim, /tmp on macOS)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-main-'))
  try {
    const real = join(dir, 'real.mjs')
    const link = join(dir, 'shim.mjs')
    await writeFile(real, '// entry\n')
    const moduleUrl = pathToFileURL(real).href
    // Invoked directly: true. These direct-path checks run on every platform,
    // before the symlink half, so a failure here still fails the test even
    // where the symlink cannot be created.
    assert.equal(isRunAsMain(real, moduleUrl), true)
    // A different file is not the entry point.
    const other = join(dir, 'other.mjs')
    await writeFile(other, '// other\n')
    assert.equal(isRunAsMain(other, moduleUrl), false)
    // Non-string argv[1] (imported, not executed).
    assert.equal(isRunAsMain(undefined, moduleUrl), false)
    try {
      await symlink(real, link)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        // win32 denies symlink creation to non-elevated users without
        // Developer Mode, so the shim half of this test cannot run here.
        // Honest skip, not a red test: the direct-path assertions above
        // already ran, and the shim path is exercised on posix CI.
        t.skip('win32 refused symlink creation (needs elevation or Developer Mode)')
        return
      }
      throw err
    }
    // Invoked via the symlink shim: argv[1] is the link, module url is the real
    // path. A plain href compare would return false and main() would never run.
    assert.equal(isRunAsMain(link, moduleUrl), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeCredentialsFile pins mode 600 (posix) and round-trips the JSON', async () => {
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
    if (process.platform !== 'win32') {
      // Only where chmod actually works: on win32 fs.chmod(0o600) is a no-op
      // (the mode reads back 0o666) and the real protection is the icacls ACL,
      // which the dedicated win32 tests below pin via an injected runner.
      // Asserting 0o600 here on Windows would test the platform, not the code.
      const st = await stat(path)
      assert.equal(st.mode & 0o777, CREDENTIALS_FILE_MODE)
    }
    const back = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(back, creds)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * "REQUIRED: set BGOS_ASSISTANT_ID" was prose in a stream of output, and the
 * command still exited 0. So a pairing that CANNOT work reported success, and
 * the operator found out at the next restart when the daemon resolved a
 * different agent's file. Ava (871) named it on 2026-08-05: the note carries
 * the whole correctness burden and nothing enforces it.
 *
 * 2026-08-06 supplied the evidence. On a twelve-agent host, two agents had
 * valid pairing rows and no usable local credentials; both looked healthy
 * until one restarted. A pairing whose runtime resolution points elsewhere is
 * not a success, and exit 0 is a claim that it was.
 *
 * Single-agent hosts keep the old behaviour: there is no other file to
 * resolve, so the warning is enough and refusing would be theatre.
 */
test('pairExitCode: a multi-agent host refuses to call an unpinned pairing a success', () => {
  // The failure this exists to stop: other agents live here, and the daemon
  // would read one of their files instead of the one just written.
  assert.equal(
    pairExitCode({ needsEnvPin: true, otherAgentCount: 11 }),
    PAIR_EXIT_CODES.PIN_REQUIRED,
  )
})

test('pair exit codes distinguish safe completion, unexpected errors, refusal, and pinning', () => {
  // Each meaning gets its own number, never an overload: a caller (the app's
  // one-click script, `hoai setup`) has to be able to tell "wrong folder,
  // nothing spent" from "something broke" without reading the prose.
  assert.deepEqual(PAIR_EXIT_CODES, {
    DONE: 0,
    UNEXPECTED_ERROR: 1,
    SERVER_REFUSED: 2,
    PIN_REQUIRED: 3,
    UNSAFE_FOLDER: 4,
  })
})

test('pairExitCode: a single-agent host is unchanged', () => {
  // Nothing else to resolve to, so the warning stands on its own and exit 0
  // remains honest.
  assert.equal(pairExitCode({ needsEnvPin: true, otherAgentCount: 0 }), 0)
})

test('pairExitCode: a correctly pinned pairing succeeds anywhere', () => {
  assert.equal(pairExitCode({ needsEnvPin: false, otherAgentCount: 11 }), 0)
  assert.equal(pairExitCode({ needsEnvPin: false, otherAgentCount: 0 }), 0)
})

test('pairExitCode: an explicit override lets an operator proceed knowingly', () => {
  // The refusal must be escapable, or a legitimate flow that sets the env
  // afterwards has no way through. Knowing beats blocked.
  assert.equal(
    pairExitCode({ needsEnvPin: true, otherAgentCount: 11, allowUnpinned: true }),
    0,
  )
})

// --- pairing pre-seeds the one-time prompts (2026-09-21) ---------------------
// bgos-pair ends by telling the user to run `hoai` in this folder. Until now
// nothing on that path had ever pre-seeded Claude Code's one-time prompts:
// preseedClaudeTrust's only production caller was the watcher's create-agent
// job, which a hand-paired machine never runs. So the very next thing the user
// was told to do stopped on a full-screen trust dialog, on a fresh install,
// with every line printed above it reporting success.
//
// Driven against the REAL function and a real throwaway home, because the
// point of the fix is that the unmocked production path does this.

test('main: a completed pairing pre-seeds the one-time prompts for the folder it just pinned', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-preseed-'))
  const folder = join(home, 'hoai-agents', 'ava')
  const output: string[] = []
  const originalLog = console.log
  const originalError = console.error
  try {
    await mkdir(folder, { recursive: true })
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 77, user_id: 'user_mark' },
          { status: 201 },
        )
      }
      if (url.endsWith('/integrations/me')) {
        return Response.json({
          assistants: [{ assistant_id: 936, agent_route: 'claude', name: 'Mark' }],
        })
      }
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = () => {}

    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      { env: {}, home, cwd: folder, fetchImpl, isInteractive: () => true, installCliImpl: fakeInstallCli() },
    )
    assert.equal(code, PAIR_EXIT_CODES.DONE)

    // The trust entry is keyed on the folder the pin was baked into, byte for
    // byte: any other key leaves the dialog exactly where it was.
    const cfg = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))
    assert.equal(cfg.projects[folder].hasTrustDialogAccepted, true)
    assert.equal(cfg.hasCompletedOnboarding, true)
    // Written to the file Claude Code actually reads with CLAUDE_CONFIG_DIR
    // unset, not to one inside the config dir.
    assert.equal(existsSync(join(home, '.claude', '.claude.json')), false)
    // The bypass warning's default answer is exit, so it is suppressed in
    // settings.json, which really does live in the config dir.
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
    assert.equal(settings.skipDangerousModePermissionPrompt, true)
    // And it SAYS so: a seed nobody can see is one nobody can check.
    assert.match(output.join('\n'), /pre-seeded Claude Code's one-time prompts/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})

test('main reaches the post-success pin check without a home ReferenceError', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-main-success-'))
  // The agent's OWN folder, never $HOME itself: pairing from the home
  // directory is refused before the exchange now (see the folder guard tests
  // below), because the folder pairing runs in becomes the agent folder.
  const folder = join(home, 'hoai-agents', 'mark')
  const output: string[] = []
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  try {
    await mkdir(folder, { recursive: true })
    await writeCredentialsFile(
      join(home, '.bgos-agent', 'credentials-935.json'),
      mkCreds(935, 'existing_agent_token'),
    )
    const requests: string[] = []
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 77, user_id: 'user_mark' },
          { status: 201 },
        )
      }
      if (url.endsWith('/integrations/me')) {
        return Response.json({
          assistants: [{ assistant_id: 936, agent_route: 'claude', name: 'Mark' }],
        })
      }
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = (...values: unknown[]) => errors.push(values.join(' '))

    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      { env: {}, home, cwd: folder, fetchImpl, isInteractive: () => true, installCliImpl: fakeInstallCli() },
    )

    // CONTRACT CHANGE (2026-08-23, MacBook-Air-2 one-click failure): a
    // successfully baked launch-folder pin now makes a multi-agent pairing
    // live-safe, so this is DONE, not PIN_REQUIRED. The one-click script
    // launches the agent from exactly this cwd, so the pin genuinely
    // resolves it; exit 3 for this shape is what broke onboarding on a
    // ten-agent host while the server side had paired fine.
    assert.equal(code, PAIR_EXIT_CODES.DONE)
    assert.equal(requests.length, 4)
    assert.match(output.join('\n'), /verified: this file resolves to assistant 936/)
    assert.match(output.join('\n'), /live-safe via the launch-folder pin/)
    assert.match(output.join('\n'), /done\. To go live/)
    assert.doesNotMatch(errors.join('\n'), /NOT DONE/)
    const written = JSON.parse(
      await readFile(join(home, '.bgos-agent', 'credentials-936.json'), 'utf8'),
    )
    assert.equal(written.assistantId, 936)
    // The bake dropped a launch-folder pin so a bare launch from cwd resolves 936.
    assert.equal((await readFile(join(folder, FOLDER_PIN_FILE_NAME), 'utf8')).trim(), '936')
    assert.match(output.join('\n'), /baked .*\.bgos-agent-id/)

    output.length = 0
    errors.length = 0
    requests.length = 0
    const safeCode = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      {
        env: { BGOS_ASSISTANT_ID: '936' },
        home,
        cwd: folder,
        fetchImpl,
        isInteractive: () => true, installCliImpl: fakeInstallCli(),
      },
    )
    assert.equal(safeCode, PAIR_EXIT_CODES.DONE)
    assert.equal(requests.length, 4)
    assert.match(output.join('\n'), /done\. To go live/)
    assert.doesNotMatch(errors.join('\n'), /NOT DONE/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})

test('main returns the documented server-refusal exit code', async () => {
  const originalLog = console.log
  const originalError = console.error
  try {
    console.log = () => {}
    console.error = () => {}
    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      {
        env: {},
        home: '/unused',
        fetchImpl: async () => Response.json({ status: 'access_denied' }),
      },
    )
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED)
  } finally {
    console.log = originalLog
    console.error = originalError
  }
})

/**
 * WINDOWS CREDENTIALS ARE NOT PROTECTED BY chmod, and the tool said they were.
 *
 * Mark (888) found it running the suite on KC-WINSAMSUNG, 2026-08-05:
 * fs.chmod(0o600) is a no-op on win32, the mode reads back 0o666, and after
 * the migration twelve pairing-token files sat at default ACLs. He also caught
 * the second half, which is the part that matters more: the success line
 * prints "(chmod 600)" UNCONDITIONALLY, so on Windows the tool asserted a
 * protection that had not happened. Same shape as last_seen and the .in_use
 * markers, a message promising more than its write path delivers.
 *
 * His workaround was icacls by hand after every pairing, verified by reading
 * the ACL back. That is a control which fails on attempt nine.
 *
 * Two rules here. The tool applies the protection itself on win32, and it
 * describes what actually happened rather than what it intended: if the ACL
 * call fails, the operator is told the file is UNPROTECTED, never that it is
 * fine.
 */
test('describeFileProtection: posix reports the mode it really set', () => {
  assert.equal(
    describeFileProtection({ platform: 'darwin', aclApplied: null }),
    'chmod 600',
  )
  assert.equal(
    describeFileProtection({ platform: 'linux', aclApplied: null }),
    'chmod 600',
  )
})

test('describeFileProtection: win32 reports the ACL, not a mode it cannot set', () => {
  assert.equal(
    describeFileProtection({ platform: 'win32', aclApplied: true }),
    'locked to your Windows user',
  )
})

test('describeFileProtection: a FAILED win32 lock says unprotected, never fine', () => {
  // The whole point. A tool that cannot protect the file must not claim it
  // did; the operator has to know to fix it by hand.
  assert.equal(
    describeFileProtection({ platform: 'win32', aclApplied: false }),
    'UNPROTECTED, the Windows ACL could not be applied, restrict it by hand',
  )
  assert.equal(
    describeFileProtection({
      platform: 'win32',
      aclApplied: false,
      aclError: 'cmd.exe failed: spawn cmd.exe ENOENT',
    }),
    'UNPROTECTED, the Windows ACL could not be applied, restrict it by hand: ' +
      'cmd.exe failed: spawn cmd.exe ENOENT',
  )
})

test('win32AclCommand: direct icacls argv, no cmd.exe string to re-parse', () => {
  // The old `cmd.exe /c "<whole line>"` form double-quoted the grant
  // (execFile quotes the array element, cmd re-parses it) and icacls saw
  // `""karim:F""`: Invalid parameter, exit 87, file left world-readable
  // (found live by the 2026-08-22 one-click E2E). Direct argv cannot be
  // re-parsed, so the grant arrives exactly as built.
  const args = [
    'C:\\Users\\karim\\.bgos-agent\\credentials-935.json',
    '/inheritance:r',
    '/grant:r',
    'karim:F',
  ]
  assert.deepEqual(
    win32AclCommand('C:\\Users\\karim\\.bgos-agent\\credentials-935.json', 'karim'),
    { file: 'icacls', args },
  )
  assert.deepEqual(
    win32AclCommand(
      'C:\\Users\\karim\\.bgos-agent\\credentials-935.json',
      'karim',
      'C:\\Windows\\System32\\icacls.exe',
    ),
    { file: 'C:\\Windows\\System32\\icacls.exe', args },
  )
})

test('win32AclCommand: refuses to build a command without a username', () => {
  // Granting to an empty principal would silently produce a file nobody can
  // read, or worse, one everyone can.
  assert.equal(win32AclCommand('C:\\x\\y.json', ''), null)
  assert.equal(win32AclCommand('C:\\x\\y.json', undefined), null)
})

test('writeCredentialsFile retries an absent icacls through SystemRoot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-acl-fallback-'))
  try {
    const calls: Array<{ file: string, args: string[] }> = []
    const result = await writeCredentialsFile(join(dir, 'credentials.json'), mkCreds(936), {
      platform: 'win32',
      username: 'karim',
      systemRoot: 'C:\\Windows',
      run: async (file: string, args: string[]) => {
        calls.push({ file, args })
        if (file === 'icacls') {
          throw Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' })
        }
      },
    })
    assert.equal(result.aclApplied, true)
    assert.deepEqual(calls.map((call) => call.file), [
      'icacls',
      'C:\\Windows\\System32\\icacls.exe',
    ])
    assert.deepEqual(calls[1].args, calls[0].args)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeCredentialsFile reports an icacls exit without retrying a resolved icacls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-acl-exit-'))
  try {
    const calls: string[] = []
    const result = await writeCredentialsFile(join(dir, 'credentials-935.json'), mkCreds(935), {
      platform: 'win32',
      username: 'karim',
      systemRoot: 'C:\\Windows',
      run: async (file: string) => {
        calls.push(file)
        throw Object.assign(
          new Error('Command failed for credentials-935.json: Access is denied.'),
          { code: 5 },
        )
      },
    })
    assert.equal(result.aclApplied, false)
    assert.deepEqual(calls, ['icacls'])
    assert.match(String(result.aclError), /Access is denied/)
    assert.match(String(result.aclError), /code 5/)
    assert.match(describeFileProtection(result), /^UNPROTECTED.*code 5/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeCredentialsFile reports both icacls failures when the ACL stays unprotected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-acl-error-'))
  try {
    const calls: string[] = []
    const result = await writeCredentialsFile(join(dir, 'credentials.json'), mkCreds(936), {
      platform: 'win32',
      username: 'karim',
      systemRoot: 'C:\\Windows',
      run: async (file: string) => {
        calls.push(file)
        if (file === 'icacls') {
          throw Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' })
        }
        throw Object.assign(new Error('icacls: Access is denied.'), { code: 5 })
      },
    })
    assert.equal(result.aclApplied, false)
    assert.deepEqual(calls, ['icacls', 'C:\\Windows\\System32\\icacls.exe'])
    assert.match(String(result.aclError), /spawn icacls ENOENT/)
    assert.match(String(result.aclError), /Access is denied/)
    assert.match(String(result.aclError), /code 5/)
    const description = describeFileProtection(result)
    assert.match(description, /^UNPROTECTED/)
    assert.match(description, /spawn icacls ENOENT/)
    assert.match(description, /Access is denied/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Phase two: the launch-folder auto-pin bake ──────────────────────────────
//
// After the verified credentials-<id>.json write, pairing bakes the pin into
// the agent's own working folder so a bare launch from there self-resolves with
// no env var: a <cwd>/.bgos-agent-id file (the load-bearing anchor server.ts
// reads), and, when the folder already has a bgos MCP server configured, that
// server's env.BGOS_ASSISTANT_ID. It must NOT clobber unrelated keys or servers
// and must never fabricate a partial (command-less) bgos server.

test('bakeMcpPin sets the bgos server env id and preserves command, args, other env keys, and sibling servers', () => {
  const current = {
    mcpServers: {
      other: { command: 'node', args: ['x.js'] },
      bgos: { command: 'bun', args: ['server.ts'], env: { BGOS_BACKEND_URL: 'https://api.example/api/v1' } },
    },
    someTopLevelKey: true,
  }
  const { changed, next } = bakeMcpPin(current, 1017)
  assert.equal(changed, true)
  assert.equal(next.mcpServers.bgos.env.BGOS_ASSISTANT_ID, '1017')
  // preserved:
  assert.equal(next.mcpServers.bgos.command, 'bun')
  assert.deepEqual(next.mcpServers.bgos.args, ['server.ts'])
  assert.equal(next.mcpServers.bgos.env.BGOS_BACKEND_URL, 'https://api.example/api/v1')
  assert.deepEqual(next.mcpServers.other, { command: 'node', args: ['x.js'] })
  assert.equal(next.someTopLevelKey, true)
})

test('bakeMcpPin is idempotent: a second bake reports no change', () => {
  const current = { mcpServers: { bgos: { command: 'bun', args: ['server.ts'], env: { BGOS_ASSISTANT_ID: '1017' } } } }
  const { changed } = bakeMcpPin(current, 1017)
  assert.equal(changed, false)
})

test('bakeMcpPin never fabricates a bgos server when the folder config has none (no clobber of other servers)', () => {
  const current = { mcpServers: { other: { command: 'node', args: ['x.js'] } } }
  const { changed, next } = bakeMcpPin(current, 1017)
  assert.equal(changed, false)
  assert.equal(next.mcpServers.bgos, undefined)
  assert.deepEqual(next.mcpServers.other, { command: 'node', args: ['x.js'] })
})

test('bakeLaunchPin writes the .bgos-agent-id folder pin with just the id', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bgos-bake-pin-'))
  try {
    const result = await bakeLaunchPin({ cwd, assistantId: 1017 })
    assert.equal(result.folderPinWritten, true)
    const pin = await readFile(join(cwd, FOLDER_PIN_FILE_NAME), 'utf8')
    assert.equal(pin.trim(), '1017')
    // no .mcp.json in this folder, so none is fabricated
    assert.equal(result.mcpUpdated, false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('bakeLaunchPin patches an existing .mcp.json bgos server env and leaves the rest intact', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bgos-bake-mcp-'))
  try {
    const original = {
      mcpServers: {
        other: { command: 'node', args: ['keep.js'] },
        bgos: { command: 'bun', args: ['server.ts'], env: { BGOS_BACKEND_URL: 'https://api.example/api/v1' } },
      },
    }
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify(original, null, 2))
    const result = await bakeLaunchPin({ cwd, assistantId: 1019 })
    assert.equal(result.folderPinWritten, true)
    assert.equal(result.mcpUpdated, true)
    const patched = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'))
    assert.equal(patched.mcpServers.bgos.env.BGOS_ASSISTANT_ID, '1019')
    assert.equal(patched.mcpServers.bgos.env.BGOS_BACKEND_URL, 'https://api.example/api/v1')
    assert.deepEqual(patched.mcpServers.other, { command: 'node', args: ['keep.js'] })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('bakeLaunchPin does not fabricate a bgos server in a .mcp.json that only has other servers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bgos-bake-noclobber-'))
  try {
    const original = { mcpServers: { other: { command: 'node', args: ['keep.js'] } } }
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify(original, null, 2))
    const result = await bakeLaunchPin({ cwd, assistantId: 1019 })
    assert.equal(result.folderPinWritten, true)
    assert.equal(result.mcpUpdated, false)
    const after = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'))
    assert.deepEqual(after, original) // untouched
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('bakeLaunchPin is idempotent: running it twice leaves identical files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bgos-bake-idem-'))
  try {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['server.ts'] } } }, null, 2),
    )
    await bakeLaunchPin({ cwd, assistantId: 1017 })
    const first = await readFile(join(cwd, '.mcp.json'), 'utf8')
    const firstPin = await readFile(join(cwd, FOLDER_PIN_FILE_NAME), 'utf8')
    const second = await bakeLaunchPin({ cwd, assistantId: 1017 })
    assert.equal(second.mcpUpdated, false)
    assert.equal(await readFile(join(cwd, '.mcp.json'), 'utf8'), first)
    assert.equal(await readFile(join(cwd, FOLDER_PIN_FILE_NAME), 'utf8'), firstPin)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// ── Launch-folder live-safety (the MacBook-Air-2 one-click failure) ─────────
//
// 2026-08-23: on a TEN-agent host, one-click paired successfully server-side
// (exchange 201, rebind 201) and then hoai-pair exited 3 (pin required), which
// the app's script read as pair-failed; the retry then hit the mint guard's
// 409 because the first pairing WAS live. But the pairing IS live-safe when
// the agent launches from the folder the pin was just baked into (the
// daemon's folder-aware resolver, lib/agent-credentials.ts rule 3). The exit
// verdict must account for the pin it just baked.

test('launchFolderLiveSafe: baked pin + per-assistant file + clean env is live-safe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-pair-pinlive-'))
  try {
    const home = join(dir, 'home')
    const cwd = join(dir, 'ws')
    await mkdir(join(home, '.bgos-agent'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(join(home, '.bgos-agent', 'credentials-1035.json'), '{"pairingToken":"t","assistantId":1035}')
    await writeFile(join(cwd, FOLDER_PIN_FILE_NAME), '1035\n')
    assert.equal(launchFolderLiveSafe({ cwd, assistantId: 1035, env: {}, home }), true)
    // A pin for a DIFFERENT agent is not live-safe for this pairing.
    await writeFile(join(cwd, FOLDER_PIN_FILE_NAME), '999\n')
    assert.equal(launchFolderLiveSafe({ cwd, assistantId: 1035, env: {}, home }), false)
    // Restore the pin; a BGOS_CREDENTIALS_PATH override outranks the pin.
    await writeFile(join(cwd, FOLDER_PIN_FILE_NAME), '1035\n')
    assert.equal(
      launchFolderLiveSafe({ cwd, assistantId: 1035, env: { BGOS_CREDENTIALS_PATH: '/elsewhere.json' }, home }),
      false,
    )
    // A CONFLICTING env id outranks the pin; a matching one keeps it safe.
    assert.equal(
      launchFolderLiveSafe({ cwd, assistantId: 1035, env: { BGOS_ASSISTANT_ID: '999' }, home }),
      false,
    )
    assert.equal(
      launchFolderLiveSafe({ cwd, assistantId: 1035, env: { BGOS_ASSISTANT_ID: '1035' }, home }),
      true,
    )
    // No credentials file, no safety.
    await rm(join(home, '.bgos-agent', 'credentials-1035.json'))
    assert.equal(launchFolderLiveSafe({ cwd, assistantId: 1035, env: {}, home }), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pairExitCode: a live-safe launch folder downgrades PIN_REQUIRED to DONE', () => {
  // The multi-agent refusal stands without the pin...
  assert.equal(
    pairExitCode({ needsEnvPin: true, otherAgentCount: 10, allowUnpinned: false }),
    PAIR_EXIT_CODES.PIN_REQUIRED,
  )
  // ...and stands when the pin bake failed or landed elsewhere...
  assert.equal(
    pairExitCode({ needsEnvPin: true, otherAgentCount: 10, allowUnpinned: false, folderPinLiveSafe: false }),
    PAIR_EXIT_CODES.PIN_REQUIRED,
  )
  // ...but a verified live-safe folder pin IS a pin: the daemon launched from
  // that folder resolves this pairing, so the pairing is done.
  assert.equal(
    pairExitCode({ needsEnvPin: true, otherAgentCount: 10, allowUnpinned: false, folderPinLiveSafe: true }),
    PAIR_EXIT_CODES.DONE,
  )
  // Single-agent hosts and --allow-unpinned keep their existing verdicts.
  assert.equal(
    pairExitCode({ needsEnvPin: true, otherAgentCount: 0, allowUnpinned: false, folderPinLiveSafe: false }),
    PAIR_EXIT_CODES.DONE,
  )
})

test('main still exits PIN_REQUIRED on a multi-agent host when the pin cannot bake', async () => {
  // The exit-3 path is still real: when the launch-folder pin cannot land
  // (here: cwd points at a FILE, so the bake's mkdir/write fails), an
  // unpinned multi-agent pairing remains not live-safe and must refuse to
  // claim done. This preserves the coverage the live-safe contract change
  // removed from the happy-bake test above.
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-main-nobake-'))
  const originalLog = console.log
  const originalError = console.error
  const output: string[] = []
  const errors: string[] = []
  try {
    await writeCredentialsFile(
      join(home, '.bgos-agent', 'credentials-935.json'),
      mkCreds(935, 'existing_agent_token'),
    )
    const fileAsCwd = join(home, 'not-a-directory')
    await writeFile(fileAsCwd, 'occupied')
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 78, user_id: 'user_mark' },
          { status: 201 },
        )
      }
      if (url.endsWith('/integrations/me')) {
        return Response.json({
          assistants: [{ assistant_id: 936, agent_route: 'claude', name: 'Mark' }],
        })
      }
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = (...values: unknown[]) => errors.push(values.join(' '))
    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      { env: {}, home, cwd: fileAsCwd, fetchImpl, isInteractive: () => true, installCliImpl: fakeInstallCli() },
    )
    assert.equal(code, PAIR_EXIT_CODES.PIN_REQUIRED)
    assert.match(errors.join('\n'), /NOT DONE/)
    assert.match(output.join('\n'), /REQUIRED: set BGOS_ASSISTANT_ID=936/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})

test('main: an exit-3 pairing still puts hoai on PATH, and prints the fallback when it cannot', async () => {
  // F1 asked for install-cli to run as THE LAST STEP OF PAIRING, and the first
  // cut put the call after the PIN_REQUIRED early return, so this path skipped
  // it entirely. Exit 3 is "paired but not live-safe": the credentials file is
  // written and verified and only the environment pin is missing. The user is
  // sent off to set that pin and then run `hoai`, so leaving them with no such
  // command, and no fallback line either, is the exact pre-fix state this
  // release exists to end.
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-exit3-installcli-'))
  const originalLog = console.log
  const originalError = console.error
  const output: string[] = []
  const errors: string[] = []
  try {
    await writeCredentialsFile(
      join(home, '.bgos-agent', 'credentials-935.json'),
      mkCreds(935, 'existing_agent_token'),
    )
    const fileAsCwd = join(home, 'not-a-directory')
    await writeFile(fileAsCwd, 'occupied')
    const installCli = fakeInstallCli({ ok: false, binDir: '' })
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 78, user_id: 'user_mark' },
          { status: 201 },
        )
      }
      if (url.endsWith('/integrations/me')) {
        return Response.json({
          assistants: [{ assistant_id: 936, agent_route: 'claude', name: 'Mark' }],
        })
      }
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = (...values: unknown[]) => errors.push(values.join(' '))

    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      { env: {}, home, cwd: fileAsCwd, platform: 'linux', fetchImpl, isInteractive: () => true, installCliImpl: installCli },
    )

    assert.equal(code, PAIR_EXIT_CODES.PIN_REQUIRED)
    // THE point: it ran, on the path that used to return before reaching it.
    assert.equal(installCli.calls.length, 1)
    assert.equal(installCli.calls[0]!.home, home)
    const text = output.join('\n')
    // And a failed install is a printed fallback here, because this path never
    // reaches the restart block that carries one on the DONE path.
    assert.match(text, /the hoai command could NOT be installed automatically/)
    assert.match(text, /npx --yes --package github:BrandGrowthOS\/bgos-claude-plugin hoai install-cli/)
    // Never fatal: the exit code is still the pin verdict, not an error.
    assert.match(errors.join('\n'), /NOT DONE/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})

test('main: a pairing whose agent is not bound YET still puts hoai on PATH', async () => {
  // The second path the first cut of F1 missed. A user who pairs before
  // finishing "Add agent" in the app gets "paired, but no agent is bound yet"
  // and exit 0, and is then told to go start Claude Code: a completed pairing,
  // sent to a terminal, with nothing on PATH to type and no fallback printed.
  //
  // bindTimeoutMs is why this path had no test before: the bind poll is a
  // wall-clock minute in production, so reaching the unbound branch meant
  // waiting one out.
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-unbound-installcli-'))
  const folder = join(home, 'hoai-agents', 'ava')
  const output: string[] = []
  const originalLog = console.log
  const originalError = console.error
  try {
    await mkdir(folder, { recursive: true })
    const installCli = fakeInstallCli({ ok: true, binDir: join(home, '.local', 'bin') })
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 94, user_id: 'user_kc' },
          { status: 201 },
        )
      }
      // Nothing bound: the app has not finished "Add agent".
      if (url.endsWith('/integrations/me')) return Response.json({ assistants: [] })
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = () => {}

    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      {
        env: {},
        home,
        cwd: folder,
        platform: 'linux',
        fetchImpl,
        isInteractive: () => true, installCliImpl: installCli,
        bindTimeoutMs: 0,
      },
    )

    assert.equal(code, PAIR_EXIT_CODES.DONE)
    const text = output.join('\n')
    // The branch really is the unbound one, not the verified one.
    assert.match(text, /paired, but no agent is bound yet/)
    assert.doesNotMatch(text, /verified: this file resolves to assistant/)
    // THE point: it ran here too, with the injected home.
    assert.equal(installCli.calls.length, 1)
    assert.equal(installCli.calls[0]!.home, home)
    assert.deepEqual(installCli.calls[0]!.env, {})
    assert.match(text, new RegExp(`the hoai command is on your PATH now \\(${join(home, '.local', 'bin')}\\)`))
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})

// -- Ask or announce, never silently replace: the PATH half ------------------
//
// KC's ruling, 2026-09-21. Putting `hoai` on PATH writes ~/.local/bin and
// appends a line to the owner's shell profiles. That is right when the owner
// asked and is watching. It is wrong from the watcher's background
// create-agent job, where nobody is at a terminal to read the notes and a
// machine with generated profiles (nix home-manager, a managed image) silently
// loses or reverts the write.

async function installCliGateCase(
  argv: string[],
  isInteractive: () => boolean,
): Promise<{ calls: number; text: string; code: number }> {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-gate-'))
  const folder = join(home, 'hoai-agents', 'ava')
  const output: string[] = []
  const originalLog = console.log
  const originalError = console.error
  try {
    await mkdir(folder, { recursive: true })
    const installCli = fakeInstallCli({ ok: true, binDir: join(home, '.local', 'bin') })
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 91, user_id: 'user_kc' },
          { status: 201 },
        )
      }
      if (url.endsWith('/integrations/me')) {
        return Response.json({ assistants: [{ assistant_id: 941, agent_route: 'claude', name: 'Ava' }] })
      }
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = (...values: unknown[]) => output.push(values.join(' '))
    const code = await main(argv, {
      env: {},
      home,
      cwd: folder,
      platform: 'linux',
      fetchImpl,
      isInteractive,
      installCliImpl: installCli,
    })
    return { calls: installCli.calls.length, text: output.join('\n'), code }
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
}

test('main: --no-install-cli pairs fully but never touches PATH, and says so with the remedy', async () => {
  const seen = await installCliGateCase(
    ['BGOS-7F3A-2K', '--backend', 'https://pair.test', '--no-install-cli'],
    () => true,
  )
  assert.equal(seen.code, PAIR_EXIT_CODES.DONE, 'the pairing itself still succeeds')
  assert.equal(seen.calls, 0, 'the daemon path must not write a shell profile')
  assert.match(seen.text, /leaving your PATH alone/)
  assert.match(seen.text, /--no-install-cli was passed/)
  // Skipping is never silent: the one command that does it by hand is printed.
  assert.match(seen.text, /npx --yes --package .* hoai install-cli/)
})

test('main: a pairing with no terminal attached skips the PATH step on its own', async () => {
  // The belt to --no-install-cli's braces. A future non-interactive caller
  // that nobody remembered to update still does not edit the owner's dotfiles.
  const seen = await installCliGateCase(['BGOS-7F3A-2K', '--backend', 'https://pair.test'], () => false)
  assert.equal(seen.code, PAIR_EXIT_CODES.DONE)
  assert.equal(seen.calls, 0)
  assert.match(seen.text, /no terminal is attached/)
  assert.match(seen.text, /npx --yes --package .* hoai install-cli/)
})

test('main: the owner at a terminal is the path that DOES install, so the gate cannot swallow everything', async () => {
  // The control. Without this a gate that always skipped would look correct.
  const seen = await installCliGateCase(['BGOS-7F3A-2K', '--backend', 'https://pair.test'], () => true)
  assert.equal(seen.calls, 1)
  assert.doesNotMatch(seen.text, /leaving your PATH alone/)
})

test('parsePairArgs reads --no-install-cli without disturbing the other flags', () => {
  const { args, errors } = parsePairArgs([
    'BGOS-7F3A-2K',
    '--no-install-cli',
    '--assistant-id',
    '941',
    '--allow-unpinned',
  ])
  assert.deepEqual(errors, [])
  assert.equal(args.noInstallCli, true)
  assert.equal(args.assistantId, '941')
  assert.equal(args.allowUnpinned, true)
  assert.equal(args.code, 'BGOS-7F3A-2K')
  // Absent means false, never undefined: the gate reads it directly.
  assert.equal(parsePairArgs(['BGOS-7F3A-2K']).args.noInstallCli, false)
})

test('main: install-cli never runs on a pairing that FAILED outright', async () => {
  // The other half of the contract. "Every path where the pairing succeeded"
  // must not quietly become "every path": a server that refused the exchange
  // wrote nothing, so there is no agent here to put a command on PATH for, and
  // touching the user's shell profiles on the way out of a failure would be a
  // side effect nobody asked for.
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  try {
    console.log = () => {}
    console.error = (...values: unknown[]) => errors.push(values.join(' '))
    const installCli = fakeInstallCli()
    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      {
        env: {},
        home: '/home/kc',
        cwd: '/home/kc/hoai-agents/ava',
        platform: 'linux',
        fetchImpl: (async () => Response.json({ error: 'nope' }, { status: 403 })) as never,
        isInteractive: () => true, installCliImpl: installCli,
      },
    )
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED)
    assert.equal(installCli.calls.length, 0)
  } finally {
    console.log = originalLog
    console.error = originalError
  }
})

// ── F1: after a marketplace install, `hoai` was not on the user's PATH ───────
//
// Claude Code injects a plugin's bin/ into its OWN session PATH (three official
// plugins' bin dirs are on this machine's session PATH right now, all of the
// form ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/bin), so `hoai`
// resolved inside Claude Code and answered command not found in the terminal
// the person actually types in. The only thing that puts it on the real PATH is
// installWrapper, through installHoaiCli, and nothing on the plugin-install
// path called it: pairing merely MENTIONED it, in a conditional footnote under
// a line that had just declared setup complete, and charged a full npx round
// trip to anyone who read that far. Pairing now runs it.

test('main: pairing runs install-cli itself, with the injected home, and says where it landed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-installcli-'))
  const folder = join(home, 'hoai-agents', 'ava')
  const output: string[] = []
  const originalLog = console.log
  const originalError = console.error
  try {
    await mkdir(folder, { recursive: true })
    const installCli = fakeInstallCli({ ok: true, binDir: join(home, '.local', 'bin') })
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 91, user_id: 'user_kc' },
          { status: 201 },
        )
      }
      if (url.endsWith('/integrations/me')) {
        return Response.json({ assistants: [{ assistant_id: 941, agent_route: 'claude', name: 'Ava' }] })
      }
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = () => {}

    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      { env: {}, home, cwd: folder, platform: 'linux', fetchImpl, isInteractive: () => true, installCliImpl: installCli },
    )

    assert.equal(code, PAIR_EXIT_CODES.DONE)
    // It RAN, once, rather than telling the user to run it.
    assert.equal(installCli.calls.length, 1)
    // And it ran against the injected home and env, never a real one.
    assert.equal(installCli.calls[0]!.home, home)
    assert.deepEqual(installCli.calls[0]!.env, {})
    const text = output.join('\n')
    assert.match(text, new RegExp(`the hoai command is on your PATH now \\(${join(home, '.local', 'bin')}\\)`))
    // The closing block reports the install instead of handing back a chore.
    assert.match(text, /was just installed for you in/)
    assert.doesNotMatch(text, /hoai install-cli/)
    // The hard-won warning is untouched: an alias freezes ONE channel spec and
    // the wrong spec drops every inbound message in silence (2026-08-21).
    assert.match(text, /Do NOT put a hoai alias in your/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})

test('main: an install-cli that fails is a printed fallback, never a failed pairing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-installcli-fail-'))
  const folder = join(home, 'hoai-agents', 'ava')
  const output: string[] = []
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  try {
    await mkdir(folder, { recursive: true })
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 92, user_id: 'user_kc' },
          { status: 201 },
        )
      }
      if (url.endsWith('/integrations/me')) {
        return Response.json({ assistants: [{ assistant_id: 942, agent_route: 'claude', name: 'Ava' }] })
      }
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = (...values: unknown[]) => errors.push(values.join(' '))

    // A shim that could not be written is a note, not a failure: the pairing
    // above it is already written, verified and baked.
    const refused = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      {
        env: {},
        home,
        cwd: folder,
        platform: 'linux',
        fetchImpl,
        isInteractive: () => true, installCliImpl: fakeInstallCli({ ok: false, binDir: '' }),
      },
    )
    assert.equal(refused, PAIR_EXIT_CODES.DONE)
    assert.match(output.join('\n'), /the hoai command could NOT be installed automatically/)
    // The honest fallback, the npx line that has always been there, survives
    // for exactly this case. install-cli, never a launch: under npx the
    // install-method detection sees the temp dir and picks the wrong spec.
    assert.match(output.join('\n'), /npx --yes --package \S+ hoai install-cli/)

    // Same when it throws outright.
    output.length = 0
    errors.length = 0
    const threw = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      {
        env: {},
        home,
        cwd: folder,
        platform: 'linux',
        fetchImpl,
        isInteractive: () => true, installCliImpl: fakeInstallCli(new Error('EACCES: read-only home')),
      },
    )
    assert.equal(threw, PAIR_EXIT_CODES.DONE)
    assert.match(errors.join('\n'), /could not install the hoai command \(EACCES: read-only home\)/)
    assert.match(output.join('\n'), /npx --yes --package \S+ hoai install-cli/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})

test('restartInstructions: reports what install-cli did instead of handing back a chore', () => {
  const installed = restartInstructions(null, { ok: true, binDir: '/home/kc/.local/bin' }).join('\n')
  assert.match(installed, /was just installed for you in \/home\/kc\/\.local\/bin/)
  // Nothing left to run: the conditional footnote is gone on this branch.
  assert.doesNotMatch(installed, /hoai install-cli/)
  // A shell reads its PATH once, so the only real instruction left is said.
  assert.match(installed, /open a new one/i)

  // A failed install keeps the npx fallback, and so does no outcome at all.
  for (const outcome of [{ ok: false, binDir: '' }, { ok: true, binDir: '' }, null]) {
    const text = restartInstructions(null, outcome as never).join('\n')
    assert.match(text, /npx --yes --package \S+ hoai install-cli/)
    assert.doesNotMatch(text, /was just installed for you/)
  }
})

test('hoai setup puts the hoai command on PATH BEFORE it pairs', async () => {
  // `hoai setup` already did this (step 3 of 4) and needs no behaviour change;
  // this pins the ORDER, which is the load-bearing part: pairing's closing
  // instruction says "run hoai from this folder", so the command has to exist
  // by the time that line is read. Asserted through the injected effects, so no
  // marketplace, no plugin install and no real home is touched.
  const order: string[] = []
  const installCli = async (opts: Record<string, unknown>) => {
    order.push('install-cli')
    return { ok: true, binDir: String(opts.home ?? '') }
  }
  const spawnImpl = () => {
    order.push('pair')
    const child = {
      on(event: string, handler: (...values: unknown[]) => void) {
        if (event === 'exit') setTimeout(() => handler(0, null), 0)
        return child
      },
    }
    return child
  }
  const code = await runSetup(['BGOS-7F3A-2K'], {
    platform: 'linux',
    env: {},
    home: '/tmp/not-a-real-home',
    scriptDir: '/tmp/not-a-real-plugin/bin',
    spawnImpl: spawnImpl as never,
    spawnClaudeImpl: async () => 0,
    // NOT isInteractive: runSetup does not take it and never consults it.
    // `hoai setup` already ran install-cli at step 3 of 4, so the
    // interactive gate belongs to bgos-pair's path, not this one.
    installCliImpl: installCli as never,
    ensureAutoUpdateImpl: () => ({ changed: false }) as never,
    print: () => {},
    // writeErr mirrors process.stderr.write, which answers a boolean. The
    // double says true rather than void so it is the same shape as the thing
    // it stands in for.
    writeErr: () => true,
  })
  assert.equal(code, 0)
  assert.deepEqual(order, ['install-cli', 'pair'])
})

// ── F9: pairing from $HOME made the whole home directory the agent folder ────
//
// bakeLaunchPin writes <cwd>/.bgos-agent-id and that folder becomes the agent
// folder: `hoai` launches there and the session runs with permissions skipped
// across everything under it. $HOME is exactly where someone is standing when
// they paste the line the app gave them, so the default mistake handed a
// permissions-skipped agent every key, document and repo on the machine.
//
// The guard is a pure classifier plus an EARLY refusal: a pair code is one time
// use and expires in ten minutes, so refusing after spending it would be worse
// than the defect.

test('classifyPairCwd refuses home even when cwd and $HOME spell it differently', () => {
  // The guard was FAILING OPEN here, found by running it rather than reading
  // it. process.cwd() returns a realpath and os.homedir() returns $HOME
  // verbatim, so on any machine whose home runs through a symlink the two
  // describe ONE directory with two strings and a plain compare answers "not
  // home". Reproduced on macOS with HOME under /tmp, whose realpath is
  // /private/tmp: pairing from the home directory sailed straight through the
  // check that exists to stop exactly that.
  const resolvePath = (path: string) => (path.startsWith('/tmp/') ? path.replace('/tmp/', '/private/tmp/') : path)

  // cwd already resolved, home still the symlinked spelling: the real case.
  assert.deepEqual(
    classifyPairCwd({ cwd: '/private/tmp/kc', home: '/tmp/kc', platform: 'darwin', resolvePath }),
    { ok: false, case: 'home' },
  )
  // And the mirror, in case the two are ever read the other way round.
  assert.deepEqual(
    classifyPairCwd({ cwd: '/tmp/kc', home: '/private/tmp/kc', platform: 'darwin', resolvePath }),
    { ok: false, case: 'home' },
  )
  // A symlinked ROOT is still a root.
  assert.deepEqual(
    classifyPairCwd({ cwd: '/tmp/', home: '/home/kc', platform: 'darwin', resolvePath: () => '/' }),
    { ok: false, case: 'root' },
  )
  // The hardening must not start refusing ordinary folders: a real subfolder
  // of home resolves to a real subfolder of home and still pairs.
  assert.deepEqual(
    classifyPairCwd({ cwd: '/private/tmp/kc/hoai-agents/ava', home: '/tmp/kc', platform: 'darwin', resolvePath }),
    { ok: true, case: 'ok' },
  )
})

test('classifyPairCwd survives a BARE throwing resolver on every path that consults it', () => {
  // realpath fails on a path that does not exist or cannot be read. That must
  // degrade to the literal compare, never to an exception in front of a user
  // holding a ten minute code.
  //
  // THIS TEST WAS FAKE until 2026-09-21. It defined a throwing resolver, then
  // wrapped it in the test's OWN try/catch and passed the safe wrapper to
  // classifyPairCwd, so it exercised the wrapper and asserted nothing about
  // production code. Meanwhile classifyPairCwd called resolvePath() unguarded,
  // and resolvePath is an EXPORTED, DOCUMENTED parameter: only the default
  // resolver had a try/catch, so any caller injecting a bare realpathSync (the
  // obvious thing to inject) really did get an exception. The resolver is now
  // passed bare, with no wrapper anywhere in this test.
  const throwing = () => {
    throw new Error('ENOENT')
  }
  assert.throws(() => throwing(), /ENOENT/)

  // The home compare. Bare resolver, no wrapper: unguarded call sites throw
  // here instead of returning a verdict.
  assert.deepEqual(
    classifyPairCwd({ cwd: '/home/kc', home: '/home/kc', platform: 'linux', resolvePath: throwing }),
    { ok: false, case: 'home' },
  )
  // The ROOT branch consults the resolver too, and it runs BEFORE the home
  // compare, so it is a second unguarded call site and needs its own proof.
  assert.deepEqual(
    classifyPairCwd({ cwd: '/', home: '/home/kc', platform: 'linux', resolvePath: throwing }),
    { ok: false, case: 'root' },
  )
  // Degrading must not start refusing the normal case: a folder of the agent's
  // own still pairs when nothing can be resolved.
  assert.deepEqual(
    classifyPairCwd({
      cwd: '/home/kc/hoai-agents/ava',
      home: '/home/kc',
      platform: 'linux',
      resolvePath: throwing,
    }),
    { ok: true, case: 'ok' },
  )
  // And the degrade is PER CALL SITE, not a blanket bail: here the cwd cannot
  // be resolved (it falls back to itself) while $HOME resolves through the
  // symlink to that same directory, which is precisely the fail-open case the
  // resolver was added for. It must still refuse.
  const throwsOnCwd = (path: string) => {
    if (path === '/private/tmp/kc') throw new Error('EACCES')
    return path.startsWith('/tmp/') ? path.replace('/tmp/', '/private/tmp/') : path
  }
  assert.deepEqual(
    classifyPairCwd({
      cwd: '/private/tmp/kc',
      home: '/tmp/kc',
      platform: 'linux',
      resolvePath: throwsOnCwd,
    }),
    { ok: false, case: 'home' },
  )
})

test('classifyPairCwd refuses $HOME itself and every filesystem root, and passes a folder inside home', () => {
  // The home directory itself, with and without a trailing separator.
  assert.deepEqual(classifyPairCwd({ cwd: '/home/kc', home: '/home/kc', platform: 'linux' }), {
    ok: false,
    case: 'home',
  })
  assert.deepEqual(classifyPairCwd({ cwd: '/home/kc/', home: '/home/kc', platform: 'linux' }), {
    ok: false,
    case: 'home',
  })
  // A folder INSIDE home is the correct shape and is never refused.
  for (const cwd of ['/home/kc/hoai-agents/ava', '/home/kc/.hidden', '/home/kc2']) {
    assert.deepEqual(classifyPairCwd({ cwd, home: '/home/kc', platform: 'linux' }), {
      ok: true,
      case: 'ok',
    })
  }
  // Roots, posix.
  for (const cwd of ['/', '//']) {
    assert.deepEqual(classifyPairCwd({ cwd, home: '/home/kc', platform: 'linux' }), {
      ok: false,
      case: 'root',
    })
  }
  // Roots, win32: a drive in either spelling, and a UNC root (server or share).
  for (const cwd of ['C:\\', 'C:/', 'C:', '\\\\server\\share', '\\\\server\\share\\', '\\\\server']) {
    assert.deepEqual(classifyPairCwd({ cwd, home: 'C:\\Users\\kc', platform: 'win32' }), {
      ok: false,
      case: 'root',
    })
  }
  // win32 compares case insensitively, because the filesystem does: this is
  // the same folder, and a case-sensitive compare would wave it through.
  assert.deepEqual(
    classifyPairCwd({ cwd: 'C:\\USERS\\KC\\', home: 'c:/users/kc', platform: 'win32' }),
    { ok: false, case: 'home' },
  )
  // posix does not: two different folders can differ only in case.
  assert.deepEqual(classifyPairCwd({ cwd: '/home/KC', home: '/home/kc', platform: 'linux' }), {
    ok: true,
    case: 'ok',
  })
  // A folder under a UNC share is a folder, not a root.
  assert.deepEqual(
    classifyPairCwd({ cwd: '\\\\server\\share\\ava', home: 'C:\\Users\\kc', platform: 'win32' }),
    { ok: true, case: 'ok' },
  )
  // An unknown cwd is not evidence of a bad one.
  assert.deepEqual(classifyPairCwd({ cwd: '', home: '/home/kc', platform: 'linux' }), {
    ok: true,
    case: 'ok',
  })
})

test('pairCwdRefusalLines: the mkdir line is PowerShell-shaped on win32, posix-shaped elsewhere', () => {
  // The win32 half of this split had NO test: a reviewer replaced the whole
  // ternary with the posix form alone and the file stayed at 75 pass 0 fail,
  // because the only assertion on it lived in a main() test pinned to linux.
  // It matters because PowerShell's mkdir is New-Item, which creates
  // intermediate directories and REJECTS -p outright, so a Windows owner
  // pasting the refusal's very first line gets a red error on the one screen
  // whose entire job is to be pasteable. The code comment beside the line
  // calls that risk out; nothing held it.
  const win = pairCwdRefusalLines({
    verdict: 'home',
    cwd: 'C:\\Users\\kc',
    home: 'C:\\Users\\kc',
    platform: 'win32',
  })
  const winText = win.join('\n')
  assert.match(winText, /^ {2}mkdir C:\\Users\\kc\\hoai-agents\\my-agent$/m)
  // The assertion that actually catches the collapse: no -p anywhere on win32.
  assert.doesNotMatch(winText, /mkdir -p/)
  // The separator is the platform's too, in the cd line and the naming hint.
  assert.match(winText, /^ {2}cd C:\\Users\\kc\\hoai-agents\\my-agent$/m)
  assert.match(winText, /hoai-agents\\<name>/)

  // And the posix half is unchanged: mkdir there NEEDS -p, because the parent
  // hoai-agents directory does not exist yet on a first pairing.
  const posix = pairCwdRefusalLines({
    verdict: 'home',
    cwd: '/home/kc',
    home: '/home/kc',
    platform: 'linux',
  })
  const posixText = posix.join('\n')
  assert.match(posixText, /^ {2}mkdir -p \/home\/kc\/hoai-agents\/my-agent$/m)
  assert.match(posixText, /^ {2}cd \/home\/kc\/hoai-agents\/my-agent$/m)

  // A home with a space is quoted on both, or the paste breaks in two.
  assert.match(
    pairCwdRefusalLines({ verdict: 'home', home: 'C:\\Users\\Kc Smith', platform: 'win32' }).join('\n'),
    /^ {2}mkdir "C:\\Users\\Kc Smith\\hoai-agents\\my-agent"$/m,
  )
  assert.match(
    pairCwdRefusalLines({ verdict: 'home', home: '/home/kc smith', platform: 'linux' }).join('\n'),
    /^ {2}mkdir -p "\/home\/kc smith\/hoai-agents\/my-agent"$/m,
  )
})

test('main refuses a home-directory pairing BEFORE the code is spent, with the lines that fix it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-home-guard-'))
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const requests: string[] = []
  try {
    console.log = () => {}
    console.error = (...values: unknown[]) => errors.push(values.join(' '))
    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      {
        env: {},
        home,
        cwd: home,
        platform: 'linux',
        fetchImpl: (async (input: string | URL | Request) => {
          requests.push(String(input))
          return Response.json({})
        }) as never,
        isInteractive: () => true, installCliImpl: fakeInstallCli(),
      },
    )

    assert.equal(code, PAIR_EXIT_CODES.UNSAFE_FOLDER)
    // THE point: the exchange never happened, so the code is still good.
    assert.deepEqual(requests, [])
    assert.equal(existsSync(join(home, FOLDER_PIN_FILE_NAME)), false)
    const text = errors.join('\n')
    assert.match(text, /refusing to pair from/)
    assert.match(text, /that is your home directory/)
    assert.match(text, /pair code was NOT spent/)
    // Actionable, not a scold: the exact folder, and the exact lines to paste.
    assert.match(text, new RegExp(`mkdir -p ${join(home, 'hoai-agents', 'my-agent')}`))
    assert.match(text, new RegExp(`cd ${join(home, 'hoai-agents', 'my-agent')}`))
    // The same pair command, carrying the same code, ready to run there.
    assert.match(text, /BGOS-7F3A-2K --backend https:\/\/pair\.test/)
    assert.match(text, /--allow-home/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})

test('main refuses a filesystem root the same way, and exits the documented code', async () => {
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const requests: string[] = []
  try {
    console.log = () => {}
    console.error = (...values: unknown[]) => errors.push(values.join(' '))
    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test'],
      {
        env: {},
        home: '/home/kc',
        cwd: '/',
        platform: 'linux',
        fetchImpl: (async (input: string | URL | Request) => {
          requests.push(String(input))
          return Response.json({})
        }) as never,
        isInteractive: () => true, installCliImpl: fakeInstallCli(),
      },
    )
    assert.equal(code, PAIR_EXIT_CODES.UNSAFE_FOLDER)
    assert.equal(PAIR_EXIT_CODES.UNSAFE_FOLDER, 4)
    assert.deepEqual(requests, [])
    assert.match(errors.join('\n'), /that is a filesystem root/)
  } finally {
    console.log = originalLog
    console.error = originalError
  }
})

test('parsePairArgs reads --allow-home without disturbing the other flags', () => {
  const a = parsePairArgs(['BGOS-7F3A-2K', '--allow-home'])
  assert.equal(a.errors.length, 0)
  assert.equal(a.args.allowHome, true)
  assert.equal(a.args.allowUnpinned, false)
  assert.equal(a.args.code, 'BGOS-7F3A-2K')
  // Default off: the guard only yields when it is asked to.
  assert.equal(parsePairArgs(['BGOS-7F3A-2K']).args.allowHome, false)
  // And the two overrides are independent.
  const b = parsePairArgs(['BGOS-7F3A-2K', '--allow-unpinned'])
  assert.equal(b.args.allowHome, false)
  assert.equal(b.args.allowUnpinned, true)
})

test('main --allow-home proceeds with the pairing and still warns what it means', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-pair-allow-home-'))
  const output: string[] = []
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  try {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/integrations/pair-exchange')) {
        return Response.json(
          { pairing_token: 'new_pair_token', pairing_id: 93, user_id: 'user_kc' },
          { status: 201 },
        )
      }
      if (url.endsWith('/integrations/me')) {
        return Response.json({ assistants: [{ assistant_id: 943, agent_route: 'claude', name: 'Ava' }] })
      }
      return Response.json({})
    }
    console.log = (...values: unknown[]) => output.push(values.join(' '))
    console.error = (...values: unknown[]) => errors.push(values.join(' '))

    const code = await main(
      ['BGOS-7F3A-2K', '--backend', 'https://pair.test', '--allow-home'],
      { env: {}, home, cwd: home, platform: 'linux', fetchImpl, isInteractive: () => true, installCliImpl: fakeInstallCli() },
    )

    // It proceeds: the flag is an override, exactly like --allow-unpinned.
    assert.equal(code, PAIR_EXIT_CODES.DONE)
    assert.equal((await readFile(join(home, FOLDER_PIN_FILE_NAME), 'utf8')).trim(), '943')
    // And it never suppresses the warning, because the consequence outlives
    // the terminal that chose it.
    const text = output.join('\n')
    assert.match(text, /--allow-home: pairing from/)
    assert.match(text, /which is your home directory/)
    assert.match(text, /permissions skipped/)
    assert.doesNotMatch(errors.join('\n'), /refusing to pair/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await rm(home, { recursive: true, force: true })
  }
})
