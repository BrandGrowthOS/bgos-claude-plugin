import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAgent } from '../bin/hoai-vault-host.mjs'
import { resolveAuth, resolveCredentialsSelection, loadCredentialsFile } from '../lib/agent-credentials.ts'

const credentials = { assistantId: 42, userId: 'fixture-owner', backendUrl: 'https://paired.example.test', pairingToken: 'fixture-pairing-token' }
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'vault-resolver-'))
  const dir = join(home, '.bgos-agent')
  const cwd = join(home, 'agent')
  mkdirSync(dir); mkdirSync(cwd)
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value))
  return { home, cwd, dir, write }
}
for (const source of ['custom-path', 'environment', 'per-assistant', 'legacy', 'folder-pin', 'sole-file']) {
  test(`resolveAgent: matches daemon identity and backend from ${source}`, () => {
    const f = fixture()
    try {
      const env: Record<string, string> = {}
      let assistant = '42'
      if (source === 'custom-path') {
        const path = join(f.home, 'custom.json')
        f.write(path, credentials)
        env.BGOS_CREDENTIALS_PATH = ` ${path} `
        f.write(join(f.dir, 'credentials-42.json'), { ...credentials, backendUrl: 'https://stale.example.test', pairingToken: 'fixture-stale' })
      } else if (source === 'environment') {
        Object.assign(env, { BGOS_PAIRING_TOKEN: credentials.pairingToken, BGOS_ASSISTANT_ID: '42', BGOS_USER_ID: credentials.userId, BGOS_BACKEND_URL: credentials.backendUrl })
        f.write(join(f.dir, 'credentials-42.json'), { ...credentials, backendUrl: 'https://stale.example.test', pairingToken: 'fixture-stale' })
      } else if (source === 'legacy') {
        f.write(join(f.dir, 'credentials.json'), credentials)
      } else {
        f.write(join(f.dir, 'credentials-42.json'), credentials)
        if (source === 'folder-pin') writeFileSync(join(f.cwd, '.bgos-agent-id'), '42\n')
      }
      if (source === 'folder-pin' || source === 'sole-file' || source === 'legacy') assistant = ''
      const effectiveEnv = assistant ? { ...env, BGOS_ASSISTANT_ID: assistant } : env
      const selection = resolveCredentialsSelection({ env: effectiveEnv, cwd: f.cwd, defaultPath: join(f.dir, 'credentials.json') })
      assert.equal(selection.kind, 'ok')
      if (selection.kind !== 'ok') return
      const auth = resolveAuth({ env: effectiveEnv, creds: loadCredentialsFile(selection.path) })
      const actual = resolveAgent({ assistant, env, cwd: f.cwd, home: f.home })
      assert.equal(actual.error, undefined)
      assert.equal(actual.assistantId, Number(auth.assistantId))
      assert.equal(actual.ownerId === auth.userId, true)
      assert.equal(actual.pairingToken === auth.pairingToken, true)
      assert.equal(actual.apiBase, `${auth.backendUrl}/api/v1`)
      assert.equal(actual.stateDir, join(f.dir, '42', 'vault'))
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })
}
for (const source of ['custom-path', 'legacy', 'environment']) {
  test(`resolveAgent: refuses an assistant identity mismatch from ${source}`, () => {
    const f = fixture()
    try {
      const env: Record<string, string> = {}
      if (source === 'environment') Object.assign(env, { BGOS_PAIRING_TOKEN: credentials.pairingToken, BGOS_ASSISTANT_ID: '43', BGOS_USER_ID: credentials.userId, BGOS_BACKEND_URL: credentials.backendUrl })
      else {
        const path = join(f.dir, 'credentials.json')
        f.write(path, { ...credentials, assistantId: 43 })
        if (source === 'custom-path') env.BGOS_CREDENTIALS_PATH = path
      }
      assert.ok(resolveAgent({ assistant: '42', env, cwd: f.cwd, home: f.home }).error)
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })
}
test('resolveAgent: ambiguous agents, incomplete environment and API key auth are refused', () => {
  const f = fixture()
  try {
    f.write(join(f.dir, 'credentials-42.json'), credentials)
    f.write(join(f.dir, 'credentials-43.json'), { ...credentials, assistantId: 43 })
    assert.ok(resolveAgent({ env: {}, cwd: f.cwd, home: f.home }).error)
    assert.ok(resolveAgent({ assistant: '42', env: { BGOS_PAIRING_TOKEN: 'fixture-incomplete' }, cwd: f.cwd, home: f.home }).error)
    rmSync(join(f.dir, 'credentials-42.json')); rmSync(join(f.dir, 'credentials-43.json'))
    assert.ok(resolveAgent({ assistant: '42', env: { BGOS_API_KEY: 'fixture-api-key', BGOS_USER_ID: credentials.userId, BGOS_BACKEND_URL: credentials.backendUrl }, cwd: f.cwd, home: f.home }).error)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('resolveAgent: custom path determines identity without a default file or explicit assistant', () => {
  const f = fixture()
  try {
    const path = join(f.home, 'custom.json')
    f.write(path, { ...credentials, backendUrl: 'https://paired.example.test/api/v1/' })
    const result = resolveAgent({ env: { BGOS_CREDENTIALS_PATH: path }, cwd: f.cwd, home: f.home })
    assert.equal(result.error, undefined)
    assert.equal(result.assistantId, 42)
    assert.equal(result.apiBase, 'https://paired.example.test/api/v1')
    rmSync(path)
    f.write(join(f.dir, 'credentials-42.json'), credentials)
    assert.ok(resolveAgent({ assistant: '42', env: { BGOS_CREDENTIALS_PATH: path }, cwd: f.cwd, home: f.home }).error)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})
