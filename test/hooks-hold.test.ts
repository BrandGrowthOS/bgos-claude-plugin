/**
 * When do this plugin's hooks hold? Only when the CLI will really run each of them, every time, for this session.
 *
 * An entry runs exactly as written only in the plugin's own shape: node, its script, its timeout, async or not, and
 * no other key (the CLI also knows `if`, `once`, `shell`, `asyncRewake` and more, and each of them makes a hook run
 * less often, or as something else). And no hook runs at all while a settings file the CLI reads switches them off:
 * the folder's, the user's, or the machine's managed settings. A file hoai cannot read is a file that may say so, so
 * only a file that is not there counts as no file. The keep-alive asks again before every relaunch, and the daemon
 * takes no folder for this from its own environment, which the folder's `.mcp.json` can set.
 *
 * Run: npx tsx --test test/hooks-hold.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { EXIT_UNATTENDED_NEEDS_PERSON, LAUNCH_STATUS_FILE_NAME, main, superviseClaude } from '../bin/hoai-core.mjs'
import * as preseed from '../lib/claude-preseed.mjs'
import { FLOOR_HOOK_MATCHER, ensureHookEntries, switchesHooksOff } from '../lib/claude-preseed.mjs'
import * as cloneHooks from '../lib/clone-hooks.mjs'
import { floorHookPresence } from '../lib/floor-hook-presence.ts'
import { privateHookPresence } from '../lib/private-hook-presence.ts'
import { fileSymlinkRefused } from './helpers/links.ts'
import { scratchDir } from './helpers/scratch-dirs.ts'

const repoRoot = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'))
const BIN = join(repoRoot, 'bin')
const FORWARDER = join(BIN, 'hoai-hook.mjs')
const any = (value: unknown) => value as any

/** An agent folder whose .mcp.json starts this checkout. */
function agentFolder(): string {
  const dir = realpathSync.native(scratchDir('hooks-hold-agent-'))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')], env: { BGOS_ASSISTANT_ID: '7' } } } }))
  return dir
}
const localSettings = (dir: string) => join(dir, '.claude', 'settings.local.json')

/** The plugin's floor and private turn entries, running this checkout's scripts; `floor` and `turn` change one. */
function entries(floor: Record<string, unknown> = {}, turn: Record<string, unknown> = {}): string {
  const entry = (script: string, timeout: number, more: Record<string, unknown>) => ({ type: 'command', command: 'node', args: [join(BIN, script)], timeout, async: false, ...more })
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: FLOOR_HOOK_MATCHER, hooks: [entry('hoai-floor-hook.mjs', 3, floor)] }],
      UserPromptSubmit: [{ hooks: [entry('hoai-private-turn-hook.mjs', 5, turn)] }],
    },
  })
}

/** The daemon's two readers over real files, through the daemon's own file layer. */
function readers(dir: string, more: Record<string, unknown> = {}) {
  const input = { installMethod: 'clone' as const, pluginRoot: repoRoot, folders: [dir], configDir: '', env: {}, ...any(cloneHooks).hookPresenceFs(), ...more }
  return { floor: floorHookPresence(input), turn: privateHookPresence(input) }
}

/** A folder whose local settings hold `text`. */
function folderWith(text: string): string {
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  writeFileSync(localSettings(dir), text)
  return dir
}

/** Run `hoai <argv>` in `cwd`; starting claude fails the test. */
async function hoai(argv: string[], cwd: string, more: Record<string, unknown> = {}) {
  const said: string[] = []
  const errors: string[] = []
  const code = await main(argv, {
    env: {},
    home: realpathSync.native(scratchDir('hooks-hold-home-')),
    cwd,
    scriptDir: BIN,
    print: (line: string) => said.push(line),
    printError: (line: string) => errors.push(line),
    spawnImpl: (() => assert.fail('hoai hooks starts nothing')) as never,
    ...more,
  } as never)
  return { code, out: [...said, ...errors].join('\n') }
}

/** A plain launch of `hoai` in `cwd`: how many times it started claude, its code and what it said. */
async function launch(cwd: string, more: Record<string, unknown> = {}) {
  const spawns: string[] = []
  const errors: string[] = []
  const original = console.error
  console.error = (...parts: unknown[]) => void errors.push(parts.map(String).join(' '))
  try {
    const code = await main([], {
      platform: 'linux',
      env: {},
      home: realpathSync.native(scratchDir('hooks-hold-launch-')),
      cwd,
      scriptDir: BIN,
      listProcesses: () => [],
      print: () => {},
      hasExpect: true,
      healthyMs: 60_000,
      registerHooks: () => ({ changed: false, reason: 'already' }),
      preseedTrust: () => {},
      spawnImpl: ((file: string) => {
        spawns.push(file)
        const child = new EventEmitter() as EventEmitter & { kill: () => void; pid: number }
        child.pid = 4242
        child.kill = () => void child.emit('exit', null, 'SIGTERM')
        setImmediate(() => child.emit('exit', 0, null))
        return child
      }) as never,
      ...more,
    } as never)
    return { code, spawns: spawns.length, out: errors.join('\n') }
  } finally {
    console.error = original
  }
}

// -- 1. an entry with a key beyond the plugin's own five is not the plugin's entry as it stands -----------------------

const MORE_KEYS: Record<string, unknown> = {
  if: 'Bash(zz)',
  once: true,
  asyncRewake: true,
  shell: 'powershell',
  onFailure: 'ignore',
  statusMessage: 'x',
  rewakeMessage: 'x',
  rewakeSummary: 'x',
}

test('a floor or private turn entry with one more key (`if`, `once`, `shell` ...) is not counted by the daemon', () => {
  for (const [key, value] of Object.entries(MORE_KEYS)) {
    const floor = readers(folderWith(entries({ [key]: value }))).floor
    assert.equal(floor.registered, false, `a floor entry with "${key}" declared the floor: ${floor.where}`)
    assert.equal(readers(folderWith(entries({}, { [key]: value }))).turn.registered, false, `a private turn entry with "${key}" counted`)
  }
  // The entries in the plugin's own shape count.
  const both = readers(folderWith(entries()))
  assert.equal(both.floor.registered, true, both.floor.where)
  assert.equal(both.turn.registered, true, both.turn.where)
})

test('the writer rewrites an entry of the plugin\'s that carries one more key: the floor runs on every listed tool again', () => {
  for (const [key, value] of Object.entries(MORE_KEYS)) {
    const files = new Map<string, string>()
    const fs = { readFile: (p: string) => files.get(p) ?? null, writeFile: (p: string, text: string) => void files.set(p, text) }
    ensureHookEntries({ settingsPath: '/a/.claude/settings.local.json', forwarderPath: '/p/bin/hoai-hook.mjs', fs } as never)
    const settings = JSON.parse(files.get('/a/.claude/settings.local.json')!)
    const floorGroup = settings.hooks.PreToolUse.find((g: { matcher?: string }) => g.matcher === FLOOR_HOOK_MATCHER)
    floorGroup.hooks[0][key] = value
    files.set('/a/.claude/settings.local.json', JSON.stringify(settings))
    const result = ensureHookEntries({ settingsPath: '/a/.claude/settings.local.json', forwarderPath: '/p/bin/hoai-hook.mjs', fs } as never)
    assert.equal(result.changed, true, `a floor entry with "${key}" was taken as current`)
    const after = JSON.parse(files.get('/a/.claude/settings.local.json')!)
    const floors = after.hooks.PreToolUse.flatMap((g: { hooks: Array<{ args: string[] }> }) => g.hooks).filter((h: { args: string[] }) => h.args[0].endsWith('hoai-floor-hook.mjs'))
    assert.equal(floors.length, 1, key)
    assert.deepEqual(Object.keys(floors[0]).sort(), ['args', 'async', 'command', 'timeout', 'type'], key)
  }
})

// -- 2. the daemon counts an entry only as the writer writes it: `node`, and the hook's own timeout -------------------

test('a floor entry run by another node, or with another timeout, or with no async key, is not counted by the daemon', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['a node.exe elsewhere', { command: 'C:\\x\\node.exe' }],
    ['a node elsewhere', { command: '/opt/x/node' }],
    ['node.exe by name', { command: 'node.exe' }],
    ['a timeout of a millisecond', { timeout: 0.001 }],
    ['no timeout', { timeout: undefined }],
    ['no async key', { async: undefined }],
  ]
  for (const [what, change] of cases) {
    const floor = readers(folderWith(entries(change))).floor
    assert.equal(floor.registered, false, `${what}: the floor was declared (${floor.where})`)
    assert.equal(readers(folderWith(entries({}, change))).turn.registered, false, `${what}: the private turn hook counted`)
  }
  // The definition the daemon goes by is the writer's own.
  assert.equal(typeof any(preseed).exactOwnedHookOf, 'function', 'lib/claude-preseed.mjs has no exact entry check to share')
})

// -- 3 and 8. fail closed: only a file that is not there is no file ----------------------------------------------------

/** Put `value` (default `{ "disableAllHooks": true }`) at one level, as text. */
function putAt(level: 'local' | 'project' | 'user', dir: string, home: string, text: string) {
  const file = level === 'user' ? join(home, '.claude', 'settings.json') : join(dir, '.claude', level === 'local' ? 'settings.local.json' : 'settings.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}
const PADDED = JSON.stringify({ disableAllHooks: true, notes: 'x'.repeat(1_100_000) })

test('"disableAllHooks" padded past 1 MiB in the project or the user settings: hoai hooks ends 1 and a launch does not start', async () => {
  for (const level of ['project', 'user'] as const) {
    const home = realpathSync.native(scratchDir('hooks-hold-pad-home-'))
    const dir = agentFolder()
    putAt(level, dir, home, PADDED)
    const hooks = await hoai(['hooks'], dir, { home })
    assert.equal(hooks.code, 1, `${level}: hoai hooks ended ${hooks.code}: ${hooks.out}`)
    assert.match(hooks.out, /cannot tell|could not read/i, level)
    const started = await launch(dir, { home })
    assert.equal(started.spawns, 0, `${level}: the launch started claude`)
    assert.notEqual(started.code, 0, level)
  }
})

test('a settings file hoai cannot read (too big, a folder, not JSON) counts as one that may switch every hook off', () => {
  const unreadable: Array<[string, (dir: string) => void]> = [
    ['padded past 1 MiB', (dir) => writeFileSync(join(dir, '.claude', 'settings.json'), PADDED)],
    ['a folder', (dir) => mkdirSync(join(dir, '.claude', 'settings.json'))],
    ['not JSON', (dir) => writeFileSync(join(dir, '.claude', 'settings.json'), '{ "disableAllHooks": true, // mine\n }')],
  ]
  for (const [what, put] of unreadable) {
    const dir = folderWith(entries())
    put(dir)
    const off = any(cloneHooks).hooksSwitchedOffIn({ folder: dir })
    assert.ok(off, `${what}: read as no file`)
    const { floor, turn } = readers(dir)
    assert.equal(floor.registered, false, `${what}: the floor was declared (${floor.where})`)
    assert.equal(turn.registered, false, `${what}: the private turn hook counted`)
    assert.throws(() => any(cloneHooks).registerTrustedHooks({ settingsPath: localSettings(dir), forwarderPath: FORWARDER }), what)
  }
  // A file that is not there, or is empty, is no switch at all.
  const plain = folderWith(entries())
  assert.equal(any(cloneHooks).hooksSwitchedOffIn({ folder: plain }), null)
  writeFileSync(join(plain, '.claude', 'settings.json'), '')
  assert.equal(any(cloneHooks).hooksSwitchedOffIn({ folder: plain }), null)
})

test('the string "true" switches every hook off, as any value but false does', async () => {
  for (const value of ['true', 1, 'yes', {}]) assert.equal(switchesHooksOff({ disableAllHooks: value }), true, JSON.stringify(value))
  assert.equal(switchesHooksOff({ disableAllHooks: false }), false)
  assert.equal(switchesHooksOff({}), false)
  const dir = agentFolder()
  const home = realpathSync.native(scratchDir('hooks-hold-string-'))
  putAt('project', dir, home, JSON.stringify({ disableAllHooks: 'true' }))
  const hooks = await hoai(['hooks'], dir, { home })
  assert.equal(hooks.code, 1, hooks.out)
  assert.match(hooks.out, /disableAllHooks/)
  const both = readers(folderWith(entries()))
  assert.equal(both.floor.registered, true)
  const off = folderWith(entries())
  writeFileSync(join(off, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: 'true' }))
  assert.equal(readers(off).floor.registered, false)
})

// -- 4. the keep-alive asks before every relaunch ---------------------------------------------------------------------

const HOME = '/home/kc'
const CWD = '/agents/athena'
const STATE_DIR = `${HOME}/.bgos-agent/871`
const BASE = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:bgos']

class FakeChild extends EventEmitter {
  kill() {
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 1)
    return true
  }
  exit(code: number) {
    this.emit('exit', code, null)
  }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test('the keep-alive does not relaunch claude once a settings file switched every hook off during the session', { timeout: 20_000 }, async () => {
  for (const file of [`${CWD}/.claude/settings.json`, `${CWD}/.claude/settings.local.json`, `${HOME}/.claude/settings.json`]) {
    const files = new Map<string, string>()
    const spawns: FakeChild[] = []
    const prints: string[] = []
    const clock = { t: 1_000_000_000 }
    const stop = new AbortController()
    const key = (p: string) => p.replace(/\\/g, '/')
    const done = superviseClaude(BASE, {
      platform: 'linux',
      env: {},
      home: HOME,
      cwd: CWD,
      scriptDir: '/home/kc/bgos-claude-plugin/bin',
      readFile: (p: string) => (key(p) === `${CWD}/.bgos-agent-id` ? '871' : files.get(key(p)) ?? null),
      listDir: () => [],
      spawnImpl: (() => {
        const child = new FakeChild()
        spawns.push(child)
        return child
      }) as never,
      writeErr: () => {},
      exists: (p: string) => files.has(key(p)),
      writeFile: (p: string, c: string) => {
        files.set(key(p), c)
        return true
      },
      removeFile: (p: string) => files.delete(key(p)),
      pollMs: 5,
      print: (l: string) => prints.push(l),
      now: () => clock.t,
      sleep: async () => {},
      listProcesses: () => [],
      hasExpect: false,
      setTimer: (() => 0) as never,
      clearTimer: () => {},
      keepAlive: true,
      signal: stop.signal,
    } as never)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await until(() => spawns.length === 1, 'the first launch')
      files.set(file, JSON.stringify({ disableAllHooks: true }))
      clock.t += 60_000
      spawns[0]!.exit(0)
      const late = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('still running'), 2_000)
      })
      const code = await Promise.race([done, late])
      assert.equal(spawns.length, 1, `${file}: claude was relaunched with every hook off`)
      assert.equal(code, EXIT_UNATTENDED_NEEDS_PERSON, `${file}: ${code}`)
      assert.match(prints.join('\n'), /disableAllHooks/, file)
      assert.match(files.get(`${STATE_DIR}/${LAUNCH_STATUS_FILE_NAME}`) ?? '', /outcome=hooks-switched-off/, file)
    } finally {
      clearTimeout(timer)
      stop.abort()
      await done.catch(() => {})
    }
  }
})

// -- 5. the daemon follows a link in place of a settings file, as the CLI does ----------------------------------------

test('the daemon reads a settings file through a link, as the CLI does', { skip: fileSymlinkRefused }, () => {
  const dir = folderWith(entries())
  const elsewhere = join(realpathSync.native(scratchDir('hooks-hold-link-')), 'real.json')
  writeFileSync(elsewhere, JSON.stringify({ disableAllHooks: true }))
  symlinkSync(elsewhere, join(dir, '.claude', 'settings.json'), 'file')
  assert.equal(readers(dir).floor.registered, false, 'a linked settings file that switches every hook off was skipped')
  // A link to nothing is no file, as for the CLI.
  const dangling = folderWith(entries())
  symlinkSync(join(dangling, 'gone.json'), join(dangling, '.claude', 'settings.json'), 'file')
  assert.equal(readers(dangling).floor.registered, true)
})

test('the daemon\'s file layer does not refuse a link that the CLI follows', () => {
  const source = readFileSync(join(repoRoot, 'lib', 'clone-hooks.mjs'), 'utf8')
  const body = source.slice(source.indexOf('export function hookPresenceFs()'), source.indexOf('\n}\n', source.indexOf('export function hookPresenceFs()')))
  assert.ok(body.length > 0)
  assert.doesNotMatch(body, /followLinks: false/, 'the daemon reads a settings file the CLI follows as no file')
})

// -- 6. the daemon takes no config folder from its own environment ----------------------------------------------------

test('a config folder only named by the environment is read for the switch alone: a floor in it does not count', () => {
  const dir = folderWith(entries())
  const named = realpathSync.native(scratchDir('hooks-hold-named-cfg-'))
  // A floor in a folder the environment names, and no floor where the session runs: not registered.
  const bare = agentFolder()
  writeFileSync(join(named, 'settings.json'), entries())
  const elsewhere = readers(bare, { otherConfigDirs: [named] }).floor
  assert.equal(elsewhere.registered, false, elsewhere.where)
  // The switch in such a folder is read: it may be the CLI's own.
  writeFileSync(join(named, 'settings.json'), JSON.stringify({ disableAllHooks: true }))
  const off = readers(dir, { otherConfigDirs: [named] })
  assert.equal(off.floor.registered, false, `a switch in a config folder from the environment was missed: ${off.floor.where}`)
  assert.equal(off.turn.registered, false)
})

test('server.ts hands the readers no config folder from its environment to count entries in', () => {
  const server = readFileSync(join(repoRoot, 'server.ts'), 'utf8')
  for (const reader of ['floorHookPresence', 'privateHookPresence']) {
    const at = server.indexOf(`return ${reader}({`)
    assert.ok(at > 0, reader)
    const call = server.slice(at, server.indexOf('})', at))
    assert.doesNotMatch(call, /configDir: CLAUDE_CONFIG_DIR/, `${reader} counts entries in the config folder the environment names`)
    assert.match(call, /configDir: ''/, reader)
    assert.match(call, /otherConfigDirs: HOOK_SWITCH_CONFIG_DIRS/, reader)
    assert.match(call, /managedFiles: MANAGED_SETTINGS_FILES/, reader)
  }
  assert.match(server, /const HOOK_SWITCH_CONFIG_DIRS = /)
})

// -- 7. managed settings ----------------------------------------------------------------------------------------------

/** A managed settings folder holding `json` in managed-settings.json, or in a drop-in. */
function managedWith(text: string, where: 'file' | 'drop-in' = 'file'): string {
  const dir = realpathSync.native(scratchDir('hooks-hold-managed-'))
  if (where === 'file') writeFileSync(join(dir, 'managed-settings.json'), text)
  else {
    mkdirSync(join(dir, 'managed-settings.d'))
    writeFileSync(join(dir, 'managed-settings.d', '10-org.json'), text)
  }
  return dir
}

test('the managed settings folder is where the CLI looks for it on each system', () => {
  const dirOf: any = any(cloneHooks).managedSettingsDir
  assert.equal(typeof dirOf, 'function', 'lib/clone-hooks.mjs does not know where managed settings live')
  assert.equal(dirOf('darwin'), '/Library/Application Support/ClaudeCode')
  assert.equal(dirOf('win32'), 'C:\\Program Files\\ClaudeCode')
  assert.equal(dirOf('linux'), '/etc/claude-code')
})

test('managed settings that switch hooks off, or allow only managed ones, stop hoai hooks, a launch and the daemon', async () => {
  const off: Array<[string, string, 'file' | 'drop-in']> = [
    ['disableAllHooks', JSON.stringify({ disableAllHooks: true }), 'file'],
    ['allowManagedHooksOnly', JSON.stringify({ allowManagedHooksOnly: true }), 'file'],
    ['strictPluginOnlyCustomization', JSON.stringify({ strictPluginOnlyCustomization: true }), 'file'],
    ['strictPluginOnlyCustomization', JSON.stringify({ strictPluginOnlyCustomization: ['hooks'] }), 'file'],
    ['disableAllHooks', JSON.stringify({ disableAllHooks: true }), 'drop-in'],
    ['managed-settings.json', 'x'.repeat(1_100_000), 'file'],
  ]
  for (const [key, text, where] of off) {
    const managed = managedWith(text, where)
    const what = `${key} (${where})`
    const dir = agentFolder()
    const hooks = await hoai(['hooks'], dir, { managedSettingsDir: managed })
    assert.equal(hooks.code, 1, `${what}: hoai hooks ended ${hooks.code}: ${hooks.out}`)
    assert.ok(hooks.out.includes(key) || /cannot tell|could not read/i.test(hooks.out), `${what}: ${hooks.out}`)
    const started = await launch(dir, { managedSettingsDir: managed })
    assert.equal(started.spawns, 0, `${what}: the launch started claude`)
    const files = any(cloneHooks).managedSettingsFiles(managed)
    const { floor, turn } = readers(folderWith(entries()), { managedFiles: files })
    assert.equal(floor.registered, false, `${what}: the floor was declared (${floor.where})`)
    assert.equal(turn.registered, false, what)
  }
  // Managed settings that switch nothing off change nothing.
  const quiet = managedWith(JSON.stringify({ permissions: { deny: ['WebFetch'] }, allowManagedHooksOnly: false }))
  assert.equal((await hoai(['hooks'], agentFolder(), { managedSettingsDir: quiet })).code, 0)
  assert.equal(readers(folderWith(entries()), { managedFiles: any(cloneHooks).managedSettingsFiles(quiet) }).floor.registered, true)
})

test('a plugin-only rule leaves the hooks of an installed plugin running: the marketplace floor still counts', () => {
  const managed = managedWith(JSON.stringify({ strictPluginOnlyCustomization: ['hooks'] }))
  const input = {
    installMethod: 'marketplace' as const,
    pluginRoot: repoRoot,
    folders: [],
    configDir: '',
    env: {},
    ...any(cloneHooks).hookPresenceFs(),
    managedFiles: any(cloneHooks).managedSettingsFiles(managed),
  }
  assert.equal(floorHookPresence(input).registered, true, floorHookPresence(input).where)
  const all = managedWith(JSON.stringify({ allowManagedHooksOnly: true }))
  assert.equal(floorHookPresence({ ...input, managedFiles: any(cloneHooks).managedSettingsFiles(all) }).registered, false)
  assert.equal(existsSync(join(repoRoot, 'hooks', 'hooks.json')), true)
})
