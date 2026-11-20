// acctbuild3 security round: one test per finding, each red on park/acctbuild-watcher (b9fbac9).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyHelperAccount, profileEnvOf } from '../lib/helper-account-launch.mjs'
import { readAccountRegistry } from '../lib/helper-accounts.mjs'
import { atLimitSafe, createAccountWatcher } from '../lib/helper-account-watcher.mjs'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'
import { nodeFs } from '../lib/watcher-bundle.mjs'

function write(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function machine(t: any, targets: (a: string, b: string) => object) {
  const home = mkdtempSync(join(tmpdir(), 'acct-sec-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const a = randomUUID(),
    b = randomUUID()
  const root = join(home, '.bgos-agent', 'helper-accounts')
  for (const id of [a, b]) mkdirSync(join(root, id), { recursive: true, mode: 0o700 })
  const registry = (value: object) =>
    write(
      join(root, 'registry.json'),
      JSON.stringify({
        version: 1,
        machineId: 'machine-12345',
        pairingId: 23,
        ownerUserId: 'owner',
        accounts: [
          { id: a, label: 'Account A' },
          { id: b, label: 'Account B' },
        ],
        ...value,
      }),
    )
  registry({ targets: targets(a, b) })
  write(join(home, '.bgos-agent', 'watcher', 'credentials.json'), JSON.stringify({ machineId: 'machine-12345', pairingId: 23, backendUrl: 'http://127.0.0.1:1' }))
  write(join(home, '.bgos-agent', 'credentials-41.json'), JSON.stringify({ assistantId: 41, userId: 'owner', pairingId: 13, backendUrl: 'http://127.0.0.1:1' }))
  const apply = (env: any, extra: object = {}) =>
    applyHelperAccount({ home, cwd: join(home, 'work'), env, assistantId: '41', sessionId: null, sessionTranscriptPath, ...extra })
  return { home, a, b, root, registry, apply }
}

test('F1 a saved login keeps the owner guardrails: deny rules, hooks, sandbox and CLAUDE.md follow the source settings', async (t) => {
  const m = machine(t, (a) => ({ computer: { choice: a } }))
  const guard = {
    permissions: { deny: ['Bash(git push:*)'], disableBypassPermissionsMode: 'disable' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] },
    sandbox: { enabled: true },
  }
  write(join(m.home, '.claude', 'settings.json'), JSON.stringify({ ...guard, model: 'opus', env: { SECRET_FIXTURE: '1' } }))
  write(join(m.home, '.claude', 'CLAUDE.md'), '# Never push to main\n')
  const env: any = {}
  m.apply(env)
  const profile = join(m.root, m.a)
  assert.equal(env.CLAUDE_CONFIG_DIR, profile)
  const copied = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
  assert.deepEqual(copied.permissions, guard.permissions)
  assert.deepEqual(copied.hooks, guard.hooks)
  assert.deepEqual(copied.sandbox, guard.sandbox)
  // Only guardrails travel: not the source env block or its other preferences.
  assert.equal(copied.env, undefined)
  assert.equal(readFileSync(join(profile, 'CLAUDE.md'), 'utf8'), '# Never push to main\n')

  // A guardrail the owner removes at the source is removed from the saved login at the next start.
  write(join(m.home, '.claude', 'settings.json'), JSON.stringify({ permissions: guard.permissions }))
  rmSync(join(m.home, '.claude', 'CLAUDE.md'))
  m.apply({})
  const again = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
  assert.equal(again.hooks, undefined)
  assert.equal(again.sandbox, undefined)
  assert.equal(existsSync(join(profile, 'CLAUDE.md')), false)

  // Source settings that cannot be read never start an agent without its guardrails.
  write(join(m.home, '.claude', 'settings.json'), '{ not json')
  assert.throws(() => m.apply({}), /account_profile_unavailable/)
})

test('F2 going back to the launch login restores its provider settings instead of the default subscription', async (t) => {
  const custom = mkdtempSync(join(tmpdir(), 'acct-sec-custom-'))
  t.after(() => rmSync(custom, { recursive: true, force: true }))
  const m = machine(t, (_a, b) => ({ '41': { pairingId: 13, choice: b } }))
  const launch = { ANTHROPIC_BASE_URL: 'https://gateway.fixture', ANTHROPIC_API_KEY: 'fixture-key', CLAUDE_CONFIG_DIR: custom, PATH: '/bin' }
  const env: any = { ...launch }
  const launchEnv = profileEnvOf(env)
  m.apply(env, { launchEnv })
  assert.equal(env.CLAUDE_CONFIG_DIR, join(m.root, m.b))
  assert.equal(env.ANTHROPIC_BASE_URL, undefined)

  // Rollback to the launch login (choice null) in the same supervisor.
  m.registry({ targets: { '41': { pairingId: 13, choice: null, originalDir: custom } } })
  m.apply(env, { launchEnv })
  assert.deepEqual(env, launch)

  // The owner's assignment removed: the agent runs exactly as launched.
  m.registry({ targets: {} })
  const second: any = { ...launch }
  m.apply(second, { launchEnv })
  assert.deepEqual(second, launch)
  m.apply(env, { launchEnv })
  assert.deepEqual(env, launch)
})

test('F3 a damaged registry or a lost profile never stops agents it does not own from starting', async (t) => {
  const m = machine(t, (a) => ({ computer: { choice: a } }))
  // Unreadable registry: an unassigned agent starts on its own login.
  write(join(m.root, 'registry.json'), '{ broken')
  const env: any = { PATH: '/bin' }
  assert.equal(m.apply(env), false)
  assert.deepEqual(env, { PATH: '/bin' })

  // One bad account entry (a later, stricter label rule) hides that account only.
  m.registry({ targets: { computer: { choice: m.a } } })
  const raw = JSON.parse(readFileSync(join(m.root, 'registry.json'), 'utf8'))
  raw.accounts.push({ id: 'not-a-uuid', label: 'x' }, { id: randomUUID(), label: 'sk-ant-fixture-not-a-label' })
  write(join(m.root, 'registry.json'), JSON.stringify(raw))
  assert.deepEqual(readAccountRegistry(m.home)?.accounts.map((x: any) => x.label), ['Account A', 'Account B'])

  // The computer default's folder is gone: agents fall back to their own login.
  rmSync(join(m.root, m.a), { recursive: true })
  const fallback: any = {}
  assert.equal(m.apply(fallback), false)
  assert.equal(fallback.CLAUDE_CONFIG_DIR, undefined)

  // The owner's own choice for THIS agent is still never silently replaced by another login.
  m.registry({ targets: { '41': { pairingId: 13, choice: m.a } } })
  assert.throws(() => m.apply({}), /account_profile_unavailable/)
})

test('an automatic switch at a limit never cuts a permission question, thread work or a background job', () => {
  const now = Date.now()
  const state = { turnInFlight: true, pendingMessages: 2, activeOperations: 1, pendingPermissions: 0, threadWork: 0, turnSignal: 'hooks' }
  const seen = (extra: object = {}, stateExtra: object = {}) => ({
    claudeAlive: true, stateFresh: true, descendants: [], agentState: { ...state, ...stateExtra }, ...extra,
  })
  // Held only by the limit: the owed message and the picker's turn flag do not stop it.
  assert.equal(atLimitSafe(seen(), now), true)
  assert.equal(atLimitSafe({ claudeAlive: false }, now), true)
  assert.equal(atLimitSafe(seen({}, { pendingPermissions: 1 }), now), false)
  assert.equal(atLimitSafe(seen({}, { threadWork: 1 }), now), false)
  assert.equal(atLimitSafe(seen({ descendants: ['bash -c source ~/.claude/shell-snapshots/snapshot-zsh-1.sh && sleep 900'] }), now), false)
  assert.equal(atLimitSafe(seen({ descendants: null }), now), false)
  assert.equal(atLimitSafe(seen({ stateFresh: false }), now), false)
  assert.equal(atLimitSafe(seen({ claudeAlive: null }), now), false)
})

test('F4 the sign-in check never runs from inside a saved login folder', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'acct-sec-probe-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const id = randomUUID()
  const root = join(home, '.bgos-agent', 'helper-accounts')
  mkdirSync(join(root, id), { recursive: true, mode: 0o700 })
  write(join(root, 'registry.json'), JSON.stringify({ version: 1, machineId: 'm-1', pairingId: 23, ownerUserId: 'owner', accounts: [{ id, label: 'A' }], targets: {} }))
  const seen: string[] = []
  const watcher = createAccountWatcher(
    { home, fs: nodeFs(), env: { PATH: '/bin' }, credentials: { pairingId: 23, machineId: 'm-1', backendUrl: 'http://x' }, now: () => Date.now(), pidAlive: () => true },
    { list: () => [], probe: async (_env: any, cwd: string) => { seen.push(cwd); return true } },
  )
  await watcher.snapshot()
  assert.equal(seen.length, 1)
  assert.equal(seen[0], home)
})
