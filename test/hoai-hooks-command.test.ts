/**
 * `hoai hooks`: the hook step of a `hoai` launch as a command of its own.
 *
 * `hoai` writes a clone folder's agent hooks right before it starts claude, the full set, floor hook included. A
 * launcher that starts claude itself skipped that step, and nothing else writes the hooks BEFORE a launch: the
 * daemon's own registration runs after the CLI has read them, and its first one in a folder that had no rail leaves
 * the floor out. So such a folder could run without the hook that asks before a risky action. This command is that
 * one step and nothing more: it starts nothing, it is safe to run before every launch, and a marketplace install is
 * left alone exactly as a launch leaves it.
 *
 * Real files on temp workspaces, the real ensureHookEntries, this checkout's own bin as the launcher's folder.
 *
 * Run: npx tsx --test test/hoai-hooks-command.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { USAGE, buildRunPlan, main, resolveHoaiAction } from '../bin/hoai-core.mjs'
import { ensureHookEntries } from '../lib/claude-preseed.mjs'
import { registerCloneHooksAtBoot } from '../lib/clone-hooks.mjs'
import { scratchDir } from './helpers/scratch-dirs.ts'

const repoRoot = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'))
const BIN = join(repoRoot, 'bin')
const FORWARDER = join(BIN, 'hoai-hook.mjs')

/** An agent folder of this checkout, as `spelled` names it, with `settings` as its settings.local.json when given. */
function agentFolder(settings?: unknown, spelled = repoRoot): string {
  const dir = realpathSync.native(scratchDir('hoai-hooks-cmd-'))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(spelled, 'server.ts')], env: { BGOS_ASSISTANT_ID: '7' } } } }))
  if (settings !== undefined) {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(settings, null, 2))
  }
  return dir
}
const settingsPath = (dir: string) => join(dir, '.claude', 'settings.local.json')
const settingsText = (dir: string) => readFileSync(settingsPath(dir), 'utf8')
const hooksOf = (dir: string) => JSON.parse(settingsText(dir)).hooks

/** Run `hoai <argv>` in `cwd` as this checkout's own launcher. Starting claude fails the test. */
async function hoai(argv: string[], cwd: string, more: Record<string, unknown> = {}) {
  const said: string[] = []
  const home = realpathSync.native(scratchDir('hoai-hooks-cmd-home-'))
  const code = await main(argv, {
    env: {},
    home,
    cwd,
    scriptDir: BIN,
    print: (line: string) => said.push(line),
    spawnImpl: (() => assert.fail('hoai hooks starts nothing')) as never,
    ...more,
  } as never)
  return { code, said: said.join('\n') }
}

test('hoai hooks is a command, and so is hoai hooks register', () => {
  assert.deepEqual(resolveHoaiAction(['hooks']), { action: 'hooks', rest: [], fresh: false, force: false })
  assert.deepEqual(resolveHoaiAction(['hooks', 'register']), { action: 'hooks', rest: ['register'], fresh: false, force: false })
  assert.deepEqual(resolveHoaiAction(['HOOKS']), { action: 'hooks', rest: [], fresh: false, force: false })
  assert.match(USAGE, /hoai hooks/)
})

test('in a folder that never had a hook it writes the full set, floor hook included, and starts nothing', async () => {
  const dir = agentFolder()
  const { code, said } = await hoai(['hooks'], dir)
  assert.equal(code, 0, said)
  assert.equal(existsSync(settingsPath(dir)), true, `hoai hooks wrote nothing. It said:\n${said}`)
  const hooks = hooksOf(dir)
  assert.match(JSON.stringify(hooks.PreToolUse), /hoai-floor-hook\.mjs/, 'the owner ran it, so the blocking floor hook is written too')
  assert.match(JSON.stringify(hooks.UserPromptSubmit), /hoai-private-turn-hook\.mjs/)
  assert.match(JSON.stringify(hooks.UserPromptSubmit), /hoai-hook\.mjs/)
  assert.match(said, /settings\.local\.json/)
})

test('it writes exactly what a hoai launch writes, to the same file', async () => {
  const dir = agentFolder()
  const plan = buildRunPlan({ cwd: dir, env: {}, home: realpathSync.native(scratchDir('hoai-hooks-cmd-home-')), scriptDir: BIN })
  assert.ok(plan.ok, JSON.stringify(plan))
  const asked: unknown[] = []
  const { code } = await hoai(['hooks'], dir, {
    registerHooks: (hooks: { settingsPath: string; forwarderPath: string }) => {
      asked.push(hooks)
      return ensureHookEntries(hooks)
    },
  })
  assert.equal(code, 0)
  assert.deepEqual(asked, [plan.hooks])
  assert.equal(plan.hooks!.forwarderPath, FORWARDER)
})

test('a second run changes nothing, byte for byte, and hoai hooks register is the same command', async () => {
  const dir = agentFolder()
  assert.equal((await hoai(['hooks', 'register'], dir)).code, 0)
  const written = settingsText(dir)
  assert.match(written, /hoai-floor-hook\.mjs/)
  for (const argv of [['hooks'], ['hooks', 'register'], ['hooks', 'REGISTER']]) {
    const again = await hoai(argv, dir)
    assert.equal(again.code, 0, again.said)
    assert.match(again.said, /already/)
    assert.equal(settingsText(dir), written)
  }
})

test('a folder that carries the rail without the floor gets the floor, and the owner\'s own hooks and settings stay', async () => {
  const stale = realpathSync.native(scratchDir('hoai-hooks-cmd-stale-'))
  ensureHookEntries({ settingsPath: join(stale, 's.json'), forwarderPath: FORWARDER, floorHookPath: null })
  const settings = JSON.parse(readFileSync(join(stale, 's.json'), 'utf8'))
  settings.permissions = { deny: ['AskUserQuestion'] }
  settings.hooks.PreToolUse.unshift({ matcher: 'mcp__bgos__reply', hooks: [{ type: 'command', command: 'python3', args: ['/gate.py'] }] })
  const dir = agentFolder(settings)
  assert.doesNotMatch(settingsText(dir), /hoai-floor-hook\.mjs/)
  assert.equal((await hoai(['hooks'], dir)).code, 0)
  assert.match(JSON.stringify(hooksOf(dir).PreToolUse), /hoai-floor-hook\.mjs/)
  assert.match(JSON.stringify(hooksOf(dir).PreToolUse), /gate\.py/)
  assert.deepEqual(JSON.parse(settingsText(dir)).permissions, { deny: ['AskUserQuestion'] })
})

test('a marketplace install is never touched: its hooks come from the plugin, and a second set would run each hook twice', async () => {
  const dir = agentFolder()
  const home = realpathSync.native(scratchDir('hoai-hooks-cmd-market-'))
  const marketplaceBin = join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai', '1.2.3', 'bin')
  const { code, said } = await hoai(['hooks'], dir, { home, scriptDir: marketplaceBin })
  assert.equal(code, 0, said)
  assert.equal(existsSync(settingsPath(dir)), false)
  assert.match(said, /marketplace/)
})

test('it does not ask which agent the folder is: where a launch refuses to pick one of several agents, the hooks are still written', async () => {
  // A launcher of its own names the agent itself, often only for the claude it starts. Two agents are paired on this
  // computer and the folder names neither, so `hoai` refuses to launch here.
  const home = realpathSync.native(scratchDir('hoai-hooks-cmd-two-agents-'))
  mkdirSync(join(home, '.bgos-agent'), { recursive: true })
  for (const id of ['7', '8']) writeFileSync(join(home, '.bgos-agent', `credentials-${id}.json`), '{}')
  const dir = realpathSync.native(scratchDir('hoai-hooks-cmd-unnamed-'))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')], env: { BGOS_BACKEND_URL: 'https://example.invalid' } } } }))
  const plan = buildRunPlan({ cwd: dir, env: {}, home, scriptDir: BIN })
  assert.equal(plan.ok, false)
  assert.equal((plan as { code?: string }).code, 'identity-ambiguous')
  const { code, said } = await hoai(['hooks'], dir, { home })
  assert.equal(code, 0, said)
  assert.match(settingsText(dir), /hoai-floor-hook\.mjs/)
})

test('hoai hooks --help says what it does and writes nothing', async () => {
  const dir = agentFolder()
  for (const word of ['--help', '-h', 'help']) {
    const { code, said } = await hoai(['hooks', word], dir)
    assert.equal(code, 0)
    assert.match(said, /starts nothing/)
  }
  assert.equal(existsSync(settingsPath(dir)), false)
})

test('a folder with no channel to name gets no hooks, as a launch there is refused, and the command says why and fails', async () => {
  // Reached through a package runner on a machine with no install record: no channel can be named (hoai refuses to launch).
  const dir = realpathSync.native(scratchDir('hoai-hooks-cmd-nowhere-'))
  const home = realpathSync.native(scratchDir('hoai-hooks-cmd-nohome-'))
  const errors: string[] = []
  const { code } = await hoai(['hooks'], dir, { home, scriptDir: join(home, '.npm', '_npx', 'abc', 'node_modules', 'claude-channel-bgos', 'bin'), printError: (line: string) => errors.push(line) })
  assert.equal(code, 1)
  assert.equal(existsSync(settingsPath(dir)), false)
  assert.match(errors.join('\n'), /hooks/)
})

test('a write that fails, a write that did not hold and a word it does not know all fail without a hook half written', async () => {
  const errors: string[] = []
  const printError = (line: string) => errors.push(line)
  const dir = agentFolder()
  const thrown = await hoai(['hooks'], dir, {
    printError,
    registerHooks: () => {
      throw new Error('EACCES: settings.local.json is read only')
    },
  })
  assert.equal(thrown.code, 1)
  assert.match(errors.join('\n'), /EACCES/)
  const lost = await hoai(['hooks'], dir, { printError, registerHooks: () => ({ changed: false, reason: 'not_persisted' }) })
  assert.equal(lost.code, 1)
  const unknown = await hoai(['hooks', 'remove'], dir, { printError })
  assert.equal(unknown.code, 1)
  assert.match(errors.join('\n'), /remove/)
  assert.equal(existsSync(settingsPath(dir)), false)
})

test('the daemon\'s own boot finds what hoai hooks wrote current and leaves it alone', async () => {
  const dir = agentFolder()
  assert.equal((await hoai(['hooks'], dir)).code, 0)
  const written = settingsText(dir)
  const boot = registerCloneHooksAtBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: true })
  assert.deepEqual(boot.results.map((r) => r.outcome), ['already'])
  assert.equal(settingsText(dir), written)
})

test('Windows: a folder that spells its checkout another way gets that checkout\'s hooks, and the boot leaves them alone', { skip: process.platform === 'win32' ? false : 'drive letter and name case are one folder on Windows only' }, async () => {
  const dir = agentFolder(undefined, repoRoot.toLowerCase() === repoRoot ? repoRoot.toUpperCase() : repoRoot.toLowerCase())
  assert.equal((await hoai(['hooks'], dir)).code, 0)
  const written = settingsText(dir)
  assert.match(written, /hoai-floor-hook\.mjs/)
  const boot = registerCloneHooksAtBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: true })
  assert.deepEqual(boot.results.map((r) => r.outcome), ['already'], 'the boot and the launcher would rewrite each other\'s hooks at every start')
  assert.equal(settingsText(dir), written)
})
