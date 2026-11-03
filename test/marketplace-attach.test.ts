import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateMarketplaceAttach } from '../lib/marketplace-attach.js'
import { attachScopeDoctorCheck, recordAttachScopeEvent, readAttachScopeEvents, summarizeAttachScopeEvents } from '../lib/attach-scope.mjs'

const credentials: Record<string, string> = {
  '/home/.bgos-agent/credentials-41.json': JSON.stringify({ assistantId: 41, pairingToken: 'TEST41', homeDir: '/agents/a' }),
  '/home/.bgos-agent/credentials-42.json': JSON.stringify({ assistantId: 42, pairingToken: 'TEST42', homeDir: '/agents/b' }),
}
function evaluate(cwd: string, env: Record<string, string | undefined> = {}, extra: Record<string, string> = {}) {
  const files = { ...credentials, ...extra }
  return evaluateMarketplaceAttach({ cwd, env, home: '/home',
    readText: (path: string) => files[path] ?? null,
    listDir: () => ['credentials-41.json', 'credentials-42.json'],
    realpath: (path: string) => path,
  })
}

test('marketplace: a non agent folder is dormant even with an inherited agent identity', () => {
  for (const env of [{}, { BGOS_ASSISTANT_ID: '41' }]) {
    assert.equal(evaluate('/work', env).decision.verdict, 'refuse')
  }
})

test('marketplace: the agent home attaches without launcher scope', () => {
  const result = evaluate('/agents/a', { BGOS_ASSISTANT_ID: '41' })
  assert.equal(result.decision.verdict, 'attach')
  assert.equal(result.decision.outcome, 'match')
})

test('marketplace: two agents attach only in their own home', () => {
  for (const [id, folder, other] of [['41', '/agents/a', '/agents/b'], ['42', '/agents/b', '/agents/a']]) {
    assert.equal(evaluate(folder, { BGOS_ASSISTANT_ID: id }).decision.verdict, 'attach')
    assert.equal(evaluate(other, { BGOS_ASSISTANT_ID: id }).decision.verdict, 'refuse')
    const pinned = evaluate(folder, {}, { [`${folder}/.bgos-agent-id`]: id })
    assert.equal(pinned.decision.assistantId, id)
    assert.equal(pinned.decision.verdict, 'attach')
  }
})

test('marketplace: a matching launcher scope opts in outside the home, inherited scope does not', () => {
  const env = { BGOS_ASSISTANT_ID: '41', HOAI_ATTACH_SCOPE: '41', HOAI_ATTACH_SCOPE_DIR: '/work' }
  assert.equal(evaluate('/work', env).decision.verdict, 'attach')
  assert.equal(evaluate('/elsewhere', env).decision.verdict, 'refuse')
  assert.equal(evaluate('/work', { ...env, HOAI_ATTACH_SCOPE: '42' }).decision.verdict, 'refuse')
})

test('marketplace: explicit opt-ins and malformed settings fail open', () => {
  for (const env of [{ BGOS_ALLOW_ANY_FOLDER: '1' }, { BGOS_ALLOW_ANY_FOLDER: 'true' },
    { HOAI_ATTACH_SCOPE_MODE: 'off' }, { HOAI_ATTACH_SCOPE_MODE: 'invalid' }]) {
    assert.equal(evaluate('/work', { BGOS_ASSISTANT_ID: '41', ...env }).decision.verdict, 'attach')
  }
  assert.equal(evaluate('/work', { BGOS_ASSISTANT_ID: '41' }, {
    '/home/.bgos-agent/attach-scope.json': '{broken',
  }).decision.verdict, 'attach')
})

test('marketplace: unreadable evidence fails open and symlink homes match', () => {
  const unreadable = evaluateMarketplaceAttach({ cwd: '/work', home: '/home', env: {},
    readText: () => { throw new Error('EACCES') }, listDir: () => [], realpath: (p: string) => p })
  assert.equal(unreadable.decision.verdict, 'attach')
  assert.equal(unreadable.decision.outcome, 'unreadable')
  const linked = evaluateMarketplaceAttach({ cwd: '/alias', home: '/home', env: { BGOS_ASSISTANT_ID: '41' },
    readText: (p: string) => credentials[p] ?? null, listDir: () => ['credentials-41.json'],
    realpath: (p: string) => p === '/alias' ? '/agents/a' : p })
  assert.equal(linked.decision.verdict, 'attach')
})

test('marketplace: an unsubstituted assistant setting is absent on unpaired and multi-agent hosts', () => {
  for (const files of [{}, credentials]) {
    const result = evaluateMarketplaceAttach({ cwd: '/work', home: '/home',
      env: { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' },
      readText: (path: string) => (files as Record<string, string>)[path] ?? null,
      listDir: () => Object.keys(files).map((path) => path.split('/').at(-1)!), realpath: (path: string) => path })
    assert.equal(result.decision.verdict, 'refuse')
    assert.equal(result.decision.outcome, 'unscoped')
  }
})

test('marketplace: a rejected credentials file cannot lend its home to another agent', () => {
  for (const explicit of [false, true]) {
    const path = '/home/.bgos-agent/credentials.json'
    const result = evaluateMarketplaceAttach({ cwd: '/agents/a', home: '/home',
      env: { BGOS_ASSISTANT_ID: '42', BGOS_API_KEY: 'TEST', BGOS_USER_ID: 'u',
        BGOS_BACKEND_URL: 'http://127.0.0.1:9', ...(explicit ? { BGOS_CREDENTIALS_PATH: path } : {}) },
      readText: (p: string) => p === path ? credentials['/home/.bgos-agent/credentials-41.json']! : null,
      listDir: () => [], realpath: (p: string) => p })
    assert.equal(result.decision.verdict, 'refuse')
  }
})

test('marketplace: two recorded homes resolve without pins or environment, but a shared home is ambiguous', () => {
  for (const [id, folder] of [['41', '/agents/a'], ['42', '/agents/b']]) {
    const result = evaluate(folder)
    assert.equal(result.decision.verdict, 'attach')
    assert.equal(result.decision.assistantId, id)
    assert.equal(result.selection?.kind, 'ok')
  }
  const ambiguous = evaluate('/agents/a', {}, {
    '/home/.bgos-agent/credentials-42.json': JSON.stringify({ assistantId: 42, pairingToken: 'TEST42', homeDir: '/agents/a' }),
  })
  assert.equal(ambiguous.decision.verdict, 'refuse')
})

test('marketplace: canonical home proof reaches downstream home confirmation', () => {
  const linked = evaluateMarketplaceAttach({ cwd: '/alias', home: '/home', env: { BGOS_ASSISTANT_ID: '41' },
    readText: (p: string) => credentials[p] ?? null, listDir: () => ['credentials-41.json'],
    realpath: (p: string) => p === '/alias' ? '/agents/a' : p })
  assert.equal(linked.homeMatched, true)
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  assert.match(source, /const HOME_CONFIRMED = homeCheckPassed\(HOME_BINDING\) \|\| MARKETPLACE_ATTACH\?\.homeMatched === true/)
})

for (const evidence of ['pin', 'recorded home'] as const) {
  test(`market2 forecast: ${evidence} admission still forecasts its strict refusal`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'market2-forecast-'))
    try {
      const extra: Record<string, string> = evidence === 'pin' ? { '/work/.bgos-agent-id': '41' } : {}
      const cwd = evidence === 'pin' ? '/work' : '/agents/a'
      const home = evaluate(cwd, { BGOS_ASSISTANT_ID: '41' }, extra)
      assert.equal(home.decision.verdict, 'attach')
      assert.equal(home.decision.outcome, 'match')
      const now = Date.now()
      assert.equal(recordAttachScopeEvent({ dir, decision: home.decision, mode: home.modeInfo.mode, cwd, now }), true)
      const recorded = readAttachScopeEvents({ dir })
      const forecast = summarizeAttachScopeEvents(recorded, { now })
      assert.equal(forecast.wouldRefuseStrict, 1, 'home admission must not hide strict rollout risk')
      assert.equal(recorded[0]!.refusedFrom, 'strict')
      assert.equal(forecast.distinctWouldRefuseStrict, 1)
      assert.equal(forecast.match, 1)
      assert.equal(forecast.refused, 0)
      assert.equal(forecast.wouldRefuseWrongAgent, 0)
      const strict = evaluate(cwd, { BGOS_ASSISTANT_ID: '41', HOAI_ATTACH_SCOPE_MODE: 'strict' }, extra)
      assert.equal(strict.decision.verdict, 'refuse', 'the forecast matches the same input in strict mode')
      assert.equal(strict.decision.refusedFrom, 'strict')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('market2 diagnostics: doctor preserves the effective marketplace home mode', () => {
  const result = evaluate('/agents/a', { BGOS_ASSISTANT_ID: '41' })
  const row = attachScopeDoctorCheck({ decision: result.decision, mode: result.modeInfo.mode,
    summary: summarizeAttachScopeEvents([]) })
  assert.equal(row.status, 'OK')
  assert.match(row.detail, /^Mode home;/)
})
