/**
 * agent-credentials tests: resolve the plugin's auth mode (pairing token vs the
 * legacy raw account API key) and produce the right HTTP header + WebSocket
 * handshake for each. Precedence: BGOS_PAIRING_TOKEN env, then an
 * identity-compatible pairing credentials file, then the legacy BGOS_API_KEY
 * env. The legacy path must stay byte identical so existing agents keep
 * working.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveAuth,
  resolveCredentialsPath,
  resolveCredentialsSelection,
  formatCredentialsRefusal,
  formatAuthResolution,
  formatPairingRejection,
  loadCredentialsFile,
  authHeaders,
  wsAuthOptions,
  missingCredsMessage,
} from '../lib/agent-credentials.ts'
import {
  resolveReadCredentialsPath,
  writeCredentialsFile,
  buildCredentials,
} from '../bin/bgos-pair.mjs'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('legacy api-key env resolves to apikey mode (Echo path, unchanged)', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1',
      BGOS_API_KEY: 'raw_key',
      BGOS_USER_ID: 'user_abc',
      BGOS_ASSISTANT_ID: '1234',
    },
    creds: null,
  })
  assert.equal(auth.mode, 'apikey')
  assert.equal(auth.apiKey, 'raw_key')
  assert.equal(auth.pairingToken, '')
  assert.equal(auth.backendUrl, 'https://api.brandgrowthos.ai/api/v1')
  assert.equal(auth.userId, 'user_abc')
  assert.equal(auth.assistantId, '1234')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-API-Key': 'raw_key' })
  assert.deepEqual(wsAuthOptions(auth), { auth: { apiKey: 'raw_key', assistantId: '1234' } })
})

test('credentials file resolves to pairing mode with X-BGOS-Pairing + query token', () => {
  const auth = resolveAuth({
    env: {},
    creds: {
      backendUrl: 'https://api.brandgrowthos.ai/api/v1',
      pairingToken: 'pair_secret',
      pairingId: 42,
      userId: 'user_abc',
      assistantId: 1234,
      pairedAt: '2026-07-11T00:00:00.000Z',
    },
  })
  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.pairingToken, 'pair_secret')
  assert.equal(auth.apiKey, '')
  assert.equal(auth.assistantId, '1234', 'numeric assistant id becomes a string')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-BGOS-Pairing': 'pair_secret' })
  assert.deepEqual(wsAuthOptions(auth), { query: { pairingToken: 'pair_secret' } })
})

test('BGOS_PAIRING_TOKEN env takes precedence over the credentials file', () => {
  const auth = resolveAuth({
    env: {
      BGOS_PAIRING_TOKEN: 'env_token',
      BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '99',
    },
    creds: { pairingToken: 'file_token', userId: 'user_file', assistantId: 1, backendUrl: 'x' },
  })
  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.pairingToken, 'env_token')
  assert.equal(auth.userId, 'user_env')
  assert.equal(auth.assistantId, '99')
})

test('mismatched pairing file cannot override an explicitly configured assistant', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_API_KEY: 'env_key',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '888',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })

  assert.equal(auth.mode, 'apikey')
  assert.equal(auth.source, 'apikey-env')
  assert.equal(auth.backendUrl, 'https://env.example/api/v1')
  assert.equal(auth.userId, 'user_env')
  assert.equal(auth.assistantId, '888')
  assert.equal(auth.apiKey, 'env_key')
  assert.equal(auth.pairingToken, '')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-API-Key': 'env_key' })
  assert.deepEqual(wsAuthOptions(auth), {
    auth: { apiKey: 'env_key', assistantId: '888' },
  })
})

test('mismatched pairing file fails closed when no env api key is available', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '888',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })

  assert.equal(auth.mode, 'apikey')
  assert.equal(auth.source, 'none')
  assert.equal(auth.assistantId, '888')
  assert.equal(auth.pairingToken, '')
  assert.equal(auth.apiKey, '')
  assert.equal(auth.complete, false)
  assert.deepEqual(auth.missing, ['apiKey'])
})

test('matching configured and file assistant ids keep pairing file auth', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_API_KEY: 'env_key',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '888',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 888,
    },
  })

  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.source, 'pairing-file')
  assert.equal(auth.backendUrl, 'https://file.example/api/v1')
  assert.equal(auth.userId, 'user_file')
  assert.equal(auth.assistantId, '888')
  assert.equal(auth.pairingToken, 'pair_secret')
  assert.equal(auth.apiKey, '')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-BGOS-Pairing': 'pair_secret' })
  assert.deepEqual(wsAuthOptions(auth), { query: { pairingToken: 'pair_secret' } })
})

test('unsubstituted assistant config placeholder keeps pairing file auth', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: '${user_config.backend_url}',
      BGOS_API_KEY: '${user_config.api_key}',
      BGOS_USER_ID: '${user_config.user_id}',
      BGOS_ASSISTANT_ID: '${user_config.assistant_id}',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })

  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.source, 'pairing-file')
  assert.equal(auth.assistantId, '972')
  assert.equal(auth.pairingToken, 'pair_secret')
})

test('pairing file keeps precedence when no assistant id is configured', () => {
  const auth = resolveAuth({
    env: {
      BGOS_API_KEY: 'env_key',
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_USER_ID: 'user_env',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })

  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.source, 'pairing-file')
  assert.equal(auth.backendUrl, 'https://file.example/api/v1')
  assert.equal(auth.userId, 'user_file')
  assert.equal(auth.assistantId, '972')
  assert.equal(auth.pairingToken, 'pair_secret')
  assert.equal(auth.apiKey, '')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-BGOS-Pairing': 'pair_secret' })
  assert.deepEqual(wsAuthOptions(auth), { query: { pairingToken: 'pair_secret' } })
})

test('missing everything is incomplete and names the missing fields', () => {
  const auth = resolveAuth({ env: {}, creds: null })
  assert.equal(auth.complete, false)
  assert.ok(auth.missing.length > 0)
  assert.match(missingCredsMessage(auth), /pair/i)
})

test('pairing file lacking an assistant id is incomplete (binding not finished)', () => {
  const auth = resolveAuth({
    env: {},
    creds: { pairingToken: 'pair_secret', userId: 'user_abc', assistantId: null, backendUrl: 'https://api.brandgrowthos.ai/api/v1' },
  })
  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.complete, false)
  assert.ok(auth.missing.includes('assistantId'))
})

test('BGOS_CREDENTIALS_PATH overrides the default pairing credentials path', () => {
  assert.equal(
    resolveCredentialsPath({
      env: { BGOS_CREDENTIALS_PATH: '/agents/888/credentials.json' },
      defaultPath: '/home/kc/.bgos-agent/credentials.json',
    }),
    '/agents/888/credentials.json',
  )
})

test('credentials path keeps the existing default when no override is set', () => {
  assert.equal(
    resolveCredentialsPath({
      env: {},
      defaultPath: '/home/kc/.bgos-agent/credentials.json',
      exists: () => true,
    }),
    '/home/kc/.bgos-agent/credentials.json',
  )
})

// ── Defect 2 (read side): per-assistant file, strict total precedence ───────

test('per-assistant credentials file is preferred when it exists for the configured id', () => {
  assert.equal(
    resolveCredentialsPath({
      env: { BGOS_ASSISTANT_ID: '871' },
      defaultPath: '/home/kc/.bgos-agent/credentials.json',
      exists: (p) => p === '/home/kc/.bgos-agent/credentials-871.json',
    }),
    '/home/kc/.bgos-agent/credentials-871.json',
  )
})

test('legacy single credentials file still resolves when no per-assistant file exists (fleet backward compat)', () => {
  // Mirrors kc-server TODAY: Guru (872) authenticates off the legacy
  // ~/.bgos-agent/credentials.json with no BGOS_CREDENTIALS_PATH and no
  // per-assistant file; this machine's assistant 900 is the identical shape.
  // If this fallback regresses, those agents silently drop to api-key.
  const path = resolveCredentialsPath({
    env: { BGOS_ASSISTANT_ID: '872' },
    defaultPath: '/home/kc/.bgos-agent/credentials.json',
    exists: () => false,
  })
  assert.equal(path, '/home/kc/.bgos-agent/credentials.json')
  const auth = resolveAuth({
    env: { BGOS_ASSISTANT_ID: '872' },
    creds: {
      backendUrl: 'https://api.brandgrowthos.ai/api/v1',
      pairingToken: 'pair_secret',
      pairingId: 42,
      userId: 'user_abc',
      assistantId: 872,
      pairedAt: '2026-07-11T00:00:00.000Z',
    },
  })
  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.source, 'pairing-file')
  assert.equal(auth.assistantId, '872')
  assert.equal(auth.complete, true)
})

test('legacy file with no configured assistant id keeps resolving (single-agent hosts)', () => {
  assert.equal(
    resolveCredentialsPath({
      env: {},
      defaultPath: '/home/kc/.bgos-agent/credentials.json',
      exists: () => true,
    }),
    '/home/kc/.bgos-agent/credentials.json',
  )
})

test('BGOS_CREDENTIALS_PATH wins outright over an existing per-assistant file', () => {
  assert.equal(
    resolveCredentialsPath({
      env: { BGOS_CREDENTIALS_PATH: '/agents/871/credentials.json', BGOS_ASSISTANT_ID: '871' },
      defaultPath: '/home/kc/.bgos-agent/credentials.json',
      exists: () => true,
    }),
    '/agents/871/credentials.json',
  )
})

test('unsubstituted assistant id placeholder never selects a per-assistant path', () => {
  assert.equal(
    resolveCredentialsPath({
      env: { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' },
      defaultPath: '/home/kc/.bgos-agent/credentials.json',
      exists: () => true,
    }),
    '/home/kc/.bgos-agent/credentials.json',
  )
})

test('read order in lib and the bgos-pair mirror never drift apart', () => {
  const home = '/home/kc'
  const defaultPath = '/home/kc/.bgos-agent/credentials.json'
  const cases = [
    { env: { BGOS_CREDENTIALS_PATH: '/x/c.json', BGOS_ASSISTANT_ID: '871' }, exists: () => true },
    { env: { BGOS_ASSISTANT_ID: '871' }, exists: (p: string) => p.endsWith('credentials-871.json') },
    { env: { BGOS_ASSISTANT_ID: '871' }, exists: () => false },
    { env: {}, exists: () => true },
    { env: { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' }, exists: () => true },
    // Whitespace padding must not make the write path and the read path diverge.
    { env: { BGOS_CREDENTIALS_PATH: '  /x/c.json  ', BGOS_ASSISTANT_ID: '871' }, exists: () => true },
    { env: { BGOS_CREDENTIALS_PATH: '   ' }, exists: () => true },
    { env: { BGOS_ASSISTANT_ID: ' 871 ' }, exists: (p: string) => p.endsWith('credentials-871.json') },
  ]
  for (const c of cases) {
    assert.equal(
      resolveCredentialsPath({ env: c.env, defaultPath, exists: c.exists }),
      resolveReadCredentialsPath({ env: c.env, home, exists: c.exists }),
      `mirror drift for env ${JSON.stringify(c.env)}`,
    )
  }
})

test('when both the per-assistant and legacy files exist, exactly one (per-assistant) is used', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bgos-creds-both-'))
  try {
    const legacyPath = join(dir, '.bgos-agent', 'credentials.json')
    const perAssistantPath = join(dir, '.bgos-agent', 'credentials-871.json')
    await writeCredentialsFile(
      legacyPath,
      buildCredentials({
        backendUrl: 'https://api.brandgrowthos.ai/api/v1',
        pairingToken: 'legacy_token_stale',
        pairingId: 1,
        userId: 'user_abc',
        assistantId: 871,
        nowIso: '2026-07-01T00:00:00.000Z',
      }),
    )
    await writeCredentialsFile(
      perAssistantPath,
      buildCredentials({
        backendUrl: 'https://api.brandgrowthos.ai/api/v1',
        pairingToken: 'per_assistant_token_fresh',
        pairingId: 2,
        userId: 'user_abc',
        assistantId: 871,
        nowIso: '2026-08-04T00:00:00.000Z',
      }),
    )
    const env = { BGOS_ASSISTANT_ID: '871' }
    const resolvedPath = resolveCredentialsPath({ env, defaultPath: legacyPath })
    assert.equal(resolvedPath, perAssistantPath)
    const auth = resolveAuth({ env, creds: loadCredentialsFile(resolvedPath) })
    assert.equal(auth.mode, 'pairing')
    assert.equal(auth.pairingToken, 'per_assistant_token_fresh')
    // The startup log names WHICH file resolved, so ambiguity is visible.
    assert.equal(
      formatAuthResolution(auth, resolvedPath),
      `Credential source: pairing-file at ${perAssistantPath}; assistantId: 871`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Defect 3: a rejected pairing file must be loud, not silent ──────────────

test('a mismatch-rejected pairing file surfaces rejection info with both ids', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_API_KEY: 'env_key',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '871',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 872,
    },
  })
  assert.equal(auth.source, 'apikey-env')
  assert.deepEqual(auth.pairingFileRejection, {
    fileAssistantId: '872',
    configuredAssistantId: '871',
  })
  const warn = formatPairingRejection(auth, '/home/kc/.bgos-agent/credentials.json')
  assert.ok(warn, 'rejection warn must be non-null')
  assert.match(String(warn), /\/home\/kc\/\.bgos-agent\/credentials\.json/)
  assert.match(String(warn), /IGNORED/)
  assert.match(String(warn), /872/)
  assert.match(String(warn), /871/)
  assert.match(String(warn), /falling back to api key/)
})

test('a mismatch-rejected pairing file with no api key says there is no fallback', () => {
  const auth = resolveAuth({
    env: { BGOS_ASSISTANT_ID: '871', BGOS_BACKEND_URL: 'https://env.example/api/v1' },
    creds: { pairingToken: 'pair_secret', userId: 'user_file', assistantId: 872, backendUrl: 'x' },
  })
  assert.equal(auth.source, 'none')
  assert.ok(auth.pairingFileRejection)
  const warn = String(formatPairingRejection(auth, '/p/credentials.json'))
  assert.match(warn, /no fallback api key/i)
})

test('no rejection info when the file matches, is absent, or env pairing wins', () => {
  const matching = resolveAuth({
    env: { BGOS_ASSISTANT_ID: '871' },
    creds: { pairingToken: 't', userId: 'u', assistantId: 871, backendUrl: 'b' },
  })
  assert.equal(matching.pairingFileRejection, null)
  assert.equal(formatPairingRejection(matching, '/p'), null)

  const absent = resolveAuth({ env: { BGOS_API_KEY: 'k' }, creds: null })
  assert.equal(absent.pairingFileRejection, null)

  const envWins = resolveAuth({
    env: { BGOS_PAIRING_TOKEN: 'env_tok', BGOS_ASSISTANT_ID: '871' },
    creds: { pairingToken: 't', userId: 'u', assistantId: 872, backendUrl: 'b' },
  })
  assert.equal(envWins.pairingFileRejection, null)
})

test('server startup threads the pairing rejection warn into the log', () => {
  assert.equal(/formatPairingRejection\(AUTH, CREDENTIALS_PATH\)/.test(serverSource), true)
  // Reaches both the incomplete-creds stderr path and the normal startup log.
  assert.equal(
    serverSource.includes(
      'process.stderr.write(`[bgos] WARN ${PAIRING_REJECTION_WARN}\\n`)',
    ),
    true,
    'failed-startup stderr path must carry the warn',
  )
  assert.equal(
    serverSource.includes('if (PAIRING_REJECTION_WARN) log(`WARN ${PAIRING_REJECTION_WARN}`)'),
    true,
    'normal startup log must carry the warn',
  )
})

test('server loads credentials from the folder-scoped selection and refuses the ambiguous case', () => {
  // The default path literal stays pinned (0.33.0 extracted it to a named
  // const so the auth divergence recheck re-resolves the SAME default).
  assert.equal(
    /const DEFAULT_CREDENTIALS_FILE = joinPath\(homedir\(\), '\.bgos-agent', 'credentials\.json'\)/.test(
      serverSource,
    ),
    true,
  )
  // Phase two: boot resolves via the folder-scoped selection (with cwd), so a
  // <cwd>/.bgos-agent-id pin or a sole file self-resolves with no env var.
  assert.equal(
    /const CREDENTIALS_SELECTION = resolveCredentialsSelection\(\{\s*env: process\.env,\s*defaultPath: DEFAULT_CREDENTIALS_FILE,\s*cwd: process\.cwd\(\),\s*\}\)/.test(
      serverSource,
    ),
    true,
  )
  // The ambiguous many-agent-no-pin case REFUSES loudly and exits, never
  // silently falling back to the shared legacy file.
  assert.equal(
    /if \(CREDENTIALS_SELECTION\.kind === 'refuse'\) \{[\s\S]*?formatCredentialsRefusal\(CREDENTIALS_SELECTION\)[\s\S]*?process\.exit\(1\)/.test(
      serverSource,
    ),
    true,
  )
  assert.equal(/const CREDENTIALS_PATH = CREDENTIALS_SELECTION\.path/.test(serverSource), true)
  assert.equal(/creds: loadCredentialsFile\(CREDENTIALS_PATH\)/.test(serverSource), true)
})

test('auth resolution log identifies the credential source and assistant id', () => {
  const envAuth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_API_KEY: 'env_key',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '888',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })
  const pairingAuth = resolveAuth({
    env: { BGOS_ASSISTANT_ID: '888' },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 888,
    },
  })

  assert.equal(
    formatAuthResolution(envAuth, '/agents/888/credentials.json'),
    'Credential source: env-apikey; assistantId: 888',
  )
  assert.equal(
    formatAuthResolution(pairingAuth, '/agents/888/credentials.json'),
    'Credential source: pairing-file at /agents/888/credentials.json; assistantId: 888',
  )
})

test('server logs the auth resolution for failed and complete startup', () => {
  assert.equal(
    /if \(!AUTH\.complete\) \{\s*process\.stderr\.write\(`\[bgos\] \$\{formatAuthResolution\(AUTH, CREDENTIALS_PATH\)\}\\n`\)/.test(
      serverSource,
    ),
    true,
  )
  assert.equal(
    serverSource.includes('log(formatAuthResolution(AUTH, CREDENTIALS_PATH))'),
    true,
  )
})

// ── Phase two: resolveCredentialsSelection (the folder-scoped auto-pin) ──────
//
// server.ts boot consumes this. With NO env pin it (1) reads a <cwd>/.bgos-agent-id
// folder pin, (2) else uses a sole per-assistant file when there is no legacy,
// (3) else REFUSES when several per-assistant files exist with no pin, so a
// multi-agent host never silently collapses to one identity.

// A stub agent dir: exists/listDir/readText driven from an in-memory map.
function stubHost(opts: {
  agentDir: string
  perAssistantIds?: number[]
  hasLegacy?: boolean
  folderPin?: { cwd: string; id: string } | null
}) {
  const files = new Set<string>()
  for (const id of opts.perAssistantIds ?? []) {
    files.add(join(opts.agentDir, `credentials-${id}.json`))
  }
  if (opts.hasLegacy) files.add(join(opts.agentDir, 'credentials.json'))
  const pinPath = opts.folderPin ? join(opts.folderPin.cwd, '.bgos-agent-id') : null
  return {
    exists: (p: string) => files.has(p),
    listDir: (p: string) =>
      p === opts.agentDir
        ? (opts.perAssistantIds ?? []).map((id) => `credentials-${id}.json`).concat(opts.hasLegacy ? ['credentials.json'] : [])
        : [],
    readText: (p: string) => (pinPath && p === pinPath ? opts.folderPin!.id : null),
  }
}

const AGENT_DIR = '/home/kc/.bgos-agent'
const DEFAULT_PATH = '/home/kc/.bgos-agent/credentials.json'

test('selection: BGOS_CREDENTIALS_PATH override wins as ok/env-path', () => {
  const sel = resolveCredentialsSelection({
    env: { BGOS_CREDENTIALS_PATH: '/x/c.json' },
    defaultPath: DEFAULT_PATH,
  })
  assert.deepEqual(sel, { kind: 'ok', path: '/x/c.json', via: 'env-path' })
})

test('selection: configured BGOS_ASSISTANT_ID with a matching file is ok/env-assistant', () => {
  const host = stubHost({ agentDir: AGENT_DIR, perAssistantIds: [1017, 1019], hasLegacy: true })
  const sel = resolveCredentialsSelection({
    env: { BGOS_ASSISTANT_ID: '1017' },
    defaultPath: DEFAULT_PATH,
    ...host,
  })
  assert.equal(sel.kind, 'ok')
  assert.equal(sel.path, join(AGENT_DIR, 'credentials-1017.json'))
  assert.equal(sel.via, 'env-assistant')
})

test('selection: an env pin suppresses the refusal even on a many-file host', () => {
  const host = stubHost({ agentDir: AGENT_DIR, perAssistantIds: [1013, 1017, 1019], hasLegacy: true })
  const sel = resolveCredentialsSelection({
    env: { BGOS_ASSISTANT_ID: '1017' },
    defaultPath: DEFAULT_PATH,
    ...host,
  })
  assert.equal(sel.kind, 'ok')
})

test('selection: NO env, a folder pin resolves that agents own file (folder-pin)', () => {
  const host = stubHost({
    agentDir: AGENT_DIR,
    perAssistantIds: [1013, 1015, 1017, 1019],
    hasLegacy: true,
    folderPin: { cwd: '/work/agent-1017', id: '1017' },
  })
  const sel = resolveCredentialsSelection({
    env: {},
    defaultPath: DEFAULT_PATH,
    cwd: '/work/agent-1017',
    ...host,
  })
  assert.deepEqual(sel, { kind: 'ok', path: join(AGENT_DIR, 'credentials-1017.json'), via: 'folder-pin' })
})

test('selection: NO env, seven paired agents (Alexs host) REFUSE, listing the ids', () => {
  const ids = [1013, 1015, 1016, 1017, 1018, 1019, 1020]
  const host = stubHost({ agentDir: AGENT_DIR, perAssistantIds: ids, hasLegacy: true })
  const sel = resolveCredentialsSelection({ env: {}, defaultPath: DEFAULT_PATH, cwd: '/work/nowhere', ...host })
  assert.equal(sel.kind, 'refuse')
  assert.deepEqual(sel.candidateIds, ids.map(String))
  assert.equal(sel.agentDir, AGENT_DIR)
})

test('selection: NO env, a folder pin still wins over the many-file refusal', () => {
  const ids = [1013, 1015, 1017]
  const host = stubHost({
    agentDir: AGENT_DIR,
    perAssistantIds: ids,
    hasLegacy: true,
    folderPin: { cwd: '/work/agent-1015', id: '1015' },
  })
  const sel = resolveCredentialsSelection({ env: {}, defaultPath: DEFAULT_PATH, cwd: '/work/agent-1015', ...host })
  assert.equal(sel.kind, 'ok')
  assert.equal(sel.via, 'folder-pin')
  assert.equal(sel.path, join(AGENT_DIR, 'credentials-1015.json'))
})

test('selection: NO env, a folder pin pointing at a missing file is ignored, not obeyed', () => {
  const host = stubHost({
    agentDir: AGENT_DIR,
    perAssistantIds: [1013, 1017],
    hasLegacy: true,
    folderPin: { cwd: '/work/agent-9999', id: '9999' },
  })
  const sel = resolveCredentialsSelection({ env: {}, defaultPath: DEFAULT_PATH, cwd: '/work/agent-9999', ...host })
  // 9999 has no file, so it falls through to the many-file refusal.
  assert.equal(sel.kind, 'refuse')
})

test('selection: NO env, exactly one per-assistant file and no legacy is ok/sole-per-assistant', () => {
  const host = stubHost({ agentDir: AGENT_DIR, perAssistantIds: [1017], hasLegacy: false })
  const sel = resolveCredentialsSelection({ env: {}, defaultPath: DEFAULT_PATH, cwd: '/work/solo', ...host })
  assert.deepEqual(sel, { kind: 'ok', path: join(AGENT_DIR, 'credentials-1017.json'), via: 'sole-per-assistant' })
})

test('selection: fresh single-agent host (one per-assistant + legacy) does NOT regress: ok/legacy, never refuse', () => {
  const host = stubHost({ agentDir: AGENT_DIR, perAssistantIds: [963], hasLegacy: true })
  const sel = resolveCredentialsSelection({ env: {}, defaultPath: DEFAULT_PATH, cwd: '/work/solo', ...host })
  assert.deepEqual(sel, { kind: 'ok', path: DEFAULT_PATH, via: 'legacy' })
})

test('selection: NO env, no files at all falls back to legacy (unchanged)', () => {
  const host = stubHost({ agentDir: AGENT_DIR, perAssistantIds: [], hasLegacy: false })
  const sel = resolveCredentialsSelection({ env: {}, defaultPath: DEFAULT_PATH, cwd: '/work/empty', ...host })
  assert.deepEqual(sel, { kind: 'ok', path: DEFAULT_PATH, via: 'legacy' })
})

test('formatCredentialsRefusal names the count, the ids, and both pin routes', () => {
  const sel = resolveCredentialsSelection({
    env: {},
    defaultPath: DEFAULT_PATH,
    cwd: '/work/nowhere',
    ...stubHost({ agentDir: AGENT_DIR, perAssistantIds: [1013, 1017, 1019], hasLegacy: true }),
  })
  const msg = formatCredentialsRefusal(sel)
  assert.match(msg, /REFUSING to start/)
  assert.match(msg, /1013, 1017, 1019/)
  assert.match(msg, /BGOS_ASSISTANT_ID=1013/)
  assert.match(msg, /hoai-pair/)
  assert.doesNotMatch(msg, /[–—]/) // no en or em dashes
})

test('resolveCredentialsPath keeps its string contract: the refuse case maps to the legacy path', () => {
  const host = stubHost({ agentDir: AGENT_DIR, perAssistantIds: [1013, 1017, 1019], hasLegacy: true })
  const path = resolveCredentialsPath({ env: {}, defaultPath: DEFAULT_PATH, cwd: '/work/nowhere', ...host })
  assert.equal(path, DEFAULT_PATH)
})
