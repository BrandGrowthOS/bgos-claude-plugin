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
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { USAGE, buildRunPlan, hookScriptDirFor, main, resolveHoaiAction } from '../bin/hoai-core.mjs'
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

test('the marketplace hoai writes nothing in a clone folder, fails, and names the command to run instead', async () => {
  // A marketplace install is never touched: its hooks come from the plugin, and a second set would run each hook
  // twice. But a launcher line that wrote nothing must not look like success.
  const dir = agentFolder()
  const home = realpathSync.native(scratchDir('hoai-hooks-cmd-market-'))
  const marketplaceBin = join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai', '1.2.3', 'bin')
  const errors: string[] = []
  const { code, said } = await hoai(['hooks'], dir, { home, scriptDir: marketplaceBin, printError: (line: string) => errors.push(line) })
  assert.equal(code, 1, `it wrote nothing and ended ${code}, saying: ${said}`)
  assert.equal(existsSync(settingsPath(dir)), false)
  assert.equal(errors.length, 1, errors.join('\n'))
  assert.match(errors[0]!, /marketplace/)
  assert.ok(errors[0]!.includes(`node "${join(repoRoot, 'bin', 'hoai-core.mjs')}" hooks`), errors[0])
  assert.doesNotMatch(errors[0]!, /\n/)

  // A folder whose checkout cannot be found gets the same refusal, without a command that would not run.
  const gone = agentFolder(undefined, join(home, 'no such checkout'))
  errors.length = 0
  const lost = await hoai(['hooks'], gone, { home, scriptDir: marketplaceBin, printError: (line: string) => errors.push(line) })
  assert.equal(lost.code, 1)
  assert.equal(existsSync(settingsPath(gone)), false)
  assert.match(errors.join('\n'), /marketplace/)
  assert.doesNotMatch(errors.join('\n'), /no such checkout[\\/]bin/)
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

test('a settings file with a byte order mark (PowerShell writes one) keeps the owner\'s own hooks and permissions', async () => {
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'), { recursive: true })
  const owners = {
    permissions: { deny: ['AskUserQuestion'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3', args: ['/gate.py'] }] }] },
  }
  writeFileSync(settingsPath(dir), `\ufeff${JSON.stringify(owners, null, 2)}`)
  const { code, said } = await hoai(['hooks'], dir)
  assert.equal(code, 0, said)
  const after = JSON.parse(settingsText(dir).replace(/^\ufeff/, ''))
  assert.deepEqual(after.permissions, owners.permissions, 'the owner\'s permissions are gone')
  assert.match(JSON.stringify(after.hooks.PreToolUse), /gate\.py/, 'the owner\'s own hook is gone')
  assert.match(JSON.stringify(after.hooks.PreToolUse), /hoai-floor-hook\.mjs/)
  const again = await hoai(['hooks'], dir)
  assert.equal(again.code, 0)
  assert.match(again.said, /already/)
})

test('a settings file that is not JSON (a comment in it) is left exactly as it is, and the command fails with its path', async () => {
  for (const text of ['// my own notes\n{\n  "permissions": { "deny": ["AskUserQuestion"] }\n}\n', '{ "permissions": { "deny": ["AskUserQuestion"] }, }', '[]']) {
    const dir = agentFolder()
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(settingsPath(dir), text)
    const errors: string[] = []
    const { code, said } = await hoai(['hooks'], dir, { printError: (line: string) => errors.push(line) })
    assert.equal(code, 1, `it ended ${code} and said: ${said}`)
    assert.equal(settingsText(dir), text, 'the owner\'s file was replaced')
    assert.ok(errors.join('\n').includes(settingsPath(dir)), errors.join('\n'))
  }
})

test('the home folder is not an agent\'s folder: nothing is written there, even with a server entry in it', async () => {
  const home = realpathSync.native(scratchDir('hoai-hooks-cmd-athome-'))
  writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')], env: { BGOS_ASSISTANT_ID: '7' } } } }))
  const spellings = [home, `${home}${sep}`, ...(process.platform === 'win32' ? [home.toLowerCase(), home.toUpperCase(), home.replace(/\\/g, '/')] : [])]
  for (const cwd of spellings) {
    const errors: string[] = []
    const { code, said } = await hoai(['hooks'], cwd, { home, printError: (line: string) => errors.push(line) })
    assert.equal(code, 1, `${cwd}: it ended ${code} and said: ${said}`)
    assert.match(errors.join('\n'), /home folder/)
    assert.equal(existsSync(join(home, '.claude', 'settings.local.json')), false, cwd)
  }
})

test('a folder with no .mcp.json, or one that starts no HOAI server, is not an agent\'s folder: nothing is written', async () => {
  const folders: Array<[string, string | null]> = [
    ['no .mcp.json', null],
    ['another tool\'s .mcp.json', JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'some-file-server'] } } })],
    ['a .mcp.json that is not JSON', '{ not json'],
  ]
  for (const [name, mcp] of folders) {
    const dir = realpathSync.native(scratchDir('hoai-hooks-cmd-noagent-'))
    if (mcp !== null) writeFileSync(join(dir, '.mcp.json'), mcp)
    const errors: string[] = []
    const { code, said } = await hoai(['hooks'], dir, { printError: (line: string) => errors.push(line) })
    assert.equal(code, 1, `${name}: it ended ${code} and said: ${said}`)
    assert.equal(existsSync(settingsPath(dir)), false, name)
    assert.match(errors.join('\n'), /\.mcp\.json/, name)
  }
  // A `bgos` entry that starts a checkout is an agent's folder, with or without an id in it.
  const plain = realpathSync.native(scratchDir('hoai-hooks-cmd-plain-'))
  writeFileSync(join(plain, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')] } } }))
  assert.equal((await hoai(['hooks'], plain)).code, 0)
  assert.match(settingsText(plain), /hoai-floor-hook\.mjs/)
  // So is any entry named bgos, even one whose command the boot cannot read (a whole command line in one string):
  // the line that boot logs sends the owner to this command, so it must not refuse them.
  const oneString = realpathSync.native(scratchDir('hoai-hooks-cmd-onestring-'))
  writeFileSync(join(oneString, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'cmd', args: ['/c', `bun "${join(repoRoot, 'server.ts')}"`] } } }))
  const sent = await hoai(['hooks'], oneString)
  assert.equal(sent.code, 0, `the folder the boot's own line points at was refused: ${sent.said}`)
  assert.match(settingsText(oneString), /hoai-floor-hook\.mjs/)
})

test('hooks that hold behind a byte order mark are written again without it, and the command says it wrote', async () => {
  const dir = agentFolder()
  assert.equal((await hoai(['hooks'], dir)).code, 0)
  const current = settingsText(dir)
  writeFileSync(settingsPath(dir), `\ufeff${current}`)
  const { code, said } = await hoai(['hooks'], dir)
  assert.equal(code, 0, said)
  assert.equal(settingsText(dir), current, 'the mark is still in the file, where the daemon\'s own readers refuse it')
  assert.doesNotMatch(said, /already/)
  assert.match((await hoai(['hooks'], dir)).said, /already/)
})

test('a checkout named with the \\\\?\\ prefix gives hook paths without it: node cannot start a script named with the prefix', () => {
  const dirFor = (server: string) =>
    hookScriptDirFor({
      cwd: '/agent',
      scriptDir: '/own/bin',
      serverName: 'bgos',
      readFile: () => JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [server], env: { BGOS_ASSISTANT_ID: '7' } } } }),
      exists: () => true,
    })
  assert.equal(dirFor('C:/plugin/server.ts'), 'C:/plugin/bin')
  assert.equal(dirFor('//?/C:/plugin/server.ts'), 'C:/plugin/bin')
  assert.equal(dirFor('//?/UNC/host/share/plugin/server.ts'), '//host/share/plugin/bin')
})

test('Windows: a folder that names its checkout with the \\\\?\\ prefix gets hook paths node can start, and the boot leaves them alone', { skip: process.platform === 'win32' ? false : 'the prefix is a Windows spelling' }, async () => {
  const dir = agentFolder(undefined, `\\\\?\\${repoRoot}`)
  const { code, said } = await hoai(['hooks'], dir)
  assert.equal(code, 0, said)
  const forwarders = (Object.values(hooksOf(dir)) as Array<Array<{ hooks: Array<{ args?: string[] }> }>>).flat().flatMap((m) => m.hooks).map((h) => h.args?.[0] ?? '')
  assert.ok(forwarders.length > 0 && forwarders.every((path) => !path.startsWith('\\\\?\\')), forwarders.join(', '))
  assert.ok(forwarders.includes(FORWARDER), forwarders.join(', '))
  const written = settingsText(dir)
  assert.deepEqual(registerCloneHooksAtBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: true }).results.map((r) => r.outcome), ['already'])
  assert.equal(settingsText(dir), written)
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
