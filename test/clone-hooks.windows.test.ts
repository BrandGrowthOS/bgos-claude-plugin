/**
 * The hook registration rule on Windows (lib/clone-hooks.mjs workspaceNamesThisClone).
 *
 * The rule touches only a workspace whose .mcp.json starts THIS checkout, and it asked that by comparing two real
 * paths as text. On Windows a real path is not one spelling. fs.realpathSync resolves a junction and keeps the rest
 * as the caller wrote it: the drive letter's case, each name's case, an 8.3 short name (measured with node 24 and
 * with bun 1.3, the daemon's runtime). The daemon knows its own folder by the volume's spelling. So a workspace whose
 * .mcp.json spells the checkout any other way was "not this checkout's": the boot wrote no hook, an update wrote no
 * hook, and nothing was logged. Such a folder has no floor hook because it never got a registration at all, not
 * because one ran and withheld it.
 *
 * Two families. On every platform: real temp folders behind a file layer that answers as a Windows volume does.
 * On Windows only: the real file system, under the spellings Windows itself accepts for one folder.
 *
 * Run: npx tsx --test test/clone-hooks.windows.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ensureHookEntries } from '../lib/claude-preseed.mjs'
import * as cloneHooks from '../lib/clone-hooks.mjs'
import { registerCloneHooks, registerCloneHooksAtBoot, workspaceNamesThisClone } from '../lib/clone-hooks.mjs'
import { linkFolder } from './helpers/links.ts'
import { scratchDir } from './helpers/scratch-dirs.ts'

const onWindows = process.platform === 'win32'
const NOT_WINDOWS = 'the real spellings of one folder (drive letter case, 8.3 short names, the \\\\?\\ prefix) exist on Windows only'

/** A folder as the volume itself spells it, which is how the daemon knows its own checkout. */
function volumeSpelling(dir: string): string {
  return realpathSync.native(dir)
}

/** A folder that stands for a checkout: a name with spaces and capitals, a server.ts and a forwarder. */
function checkout(name = 'Plugin Checkout Long Name'): string {
  const dir = join(volumeSpelling(scratchDir('clone-hooks-win-')), name)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'server.ts'), '')
  writeFileSync(join(dir, 'bin', 'hoai-hook.mjs'), '')
  return dir
}

type Form = 'server' | 'launch shim' | 'cmd wrapper' | 'stable wrapper'
const FORMS: Form[] = ['server', 'launch shim', 'cmd wrapper', 'stable wrapper']

/** The `bgos` server entry of a workspace, in each form a Windows folder really carries. */
function serverEntry(spelled: string, form: Form) {
  const server = `${spelled.replace(/[\\/]+$/, '')}${sep}server.ts`
  if (form === 'server') return { command: 'bun', args: [server] }
  // bin/hoai-bootstrap.ps1: the node shim first, then the server.
  if (form === 'launch shim') return { command: 'node', args: [`${spelled.replace(/[\\/]+$/, '')}${sep}bin${sep}bgos-launch.mjs`, server] }
  if (form === 'cmd wrapper') return { command: 'cmd', args: ['/c', 'bun', 'run', server] }
  // bin/bgos-claim.mjs buildMcpJson: the checkout is --plugin-dir, no server.ts in the args.
  return { command: 'bun', args: [join(volumeSpelling(scratchDir('clone-hooks-win-runtime-')), 'bgos-daemon-wrapper.mjs'), '--plugin-dir', spelled] }
}

/** A workspace whose .mcp.json starts `spelled`, with `settings` as its .claude/settings.local.json when given. */
function workspace(spelled: string, form: Form = 'server', settings?: string): string {
  const dir = volumeSpelling(scratchDir('clone-hooks-win-ws-'))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: serverEntry(spelled, form) } }))
  if (settings !== undefined) {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.local.json'), settings)
  }
  return dir
}
const settingsPath = (dir: string) => join(dir, '.claude', 'settings.local.json')
const settingsText = (dir: string) => readFileSync(settingsPath(dir), 'utf8')
const outcomes = (boot: { results: Array<{ outcome: string }> }) => boot.results.map((r) => r.outcome)

/** What an older registration left in a folder that never had the rail: the rail and the private turn hook, no floor. */
function railWithoutFloor(forwarder: string): string {
  const path = join(volumeSpelling(scratchDir('clone-hooks-win-stale-')), 'settings.local.json')
  ensureHookEntries({ settingsPath: path, forwarderPath: forwarder, floorHookPath: null })
  const text = readFileSync(path, 'utf8')
  assert.match(text, /hoai-hook\.mjs/)
  assert.doesNotMatch(text, /hoai-floor-hook\.mjs/)
  return text
}

/** The same path with every letter in the other case: one folder on a Windows volume, another spelling. */
function otherCase(path: string): string {
  return path.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
}

/**
 * A file layer over the real temp folders that answers as a Windows volume does. A name matches in any case, and
 * realpath says "it is there" in the caller's own spelling: that is what node and bun do on Windows for anything
 * but a link. `identity` is the volume's word for one folder, the same under every spelling (fs.stat's volume and
 * file id). `withIdentity: false` is a volume that cannot say.
 */
function windowsVolume({ withIdentity = true } = {}) {
  const onDisk = (spelled: string): string | null => {
    const full = resolve(spelled)
    const { root } = parse(full)
    let at = root
    for (const name of full.slice(root.length).split(sep).filter(Boolean)) {
      let names: string[]
      try {
        names = readdirSync(at)
      } catch {
        // A folder that may be entered but not listed: only the exact name can be found in it.
        names = existsSync(join(at, name)) ? [name] : []
      }
      const found = names.find((n) => n === name) ?? names.find((n) => n.toLowerCase() === name.toLowerCase())
      if (found === undefined) return null
      at = join(at, found)
    }
    return at
  }
  const read = (path: string) => {
    const real = onDisk(path)
    try {
      return real === null ? null : readFileSync(real, 'utf8')
    } catch {
      return null
    }
  }
  const identity = (path: string) => {
    const real = onDisk(path)
    if (real === null) return null
    const stat = statSync(real, { bigint: true })
    return `${stat.dev}:${stat.ino}`
  }
  return { readFile: read, realpath: (path: string) => (onDisk(path) === null ? null : resolve(path)), ...(withIdentity ? { identity } : {}) }
}

const boot = (folder: string, pluginDir: string, privateHookRegistered: boolean, fs?: unknown) =>
  registerCloneHooksAtBoot({ folders: [folder], pluginDir, installMethod: 'clone', privateHookRegistered, ...(fs ? { fs } : {}) } as never)

// -- every platform: a Windows volume behind the injectable file layer --------------------------------------------

for (const form of FORMS) {
  test(`a workspace that spells its checkout in another case is this checkout's, and the boot registers its hooks (${form})`, () => {
    const ours = checkout()
    const dir = workspace(otherCase(ours), form)
    const fs = windowsVolume()
    assert.equal(workspaceNamesThisClone({ workdir: dir, pluginDir: ours, fs }), true, 'one folder under two spellings is not another checkout')
    const first = boot(dir, ours, false, fs)
    assert.deepEqual(outcomes(first), ['registered'], 'the boot answered that this folder is not its own, so it wrote nothing')
    assert.match(settingsText(dir), /hoai-private-turn-hook\.mjs/)
    assert.match(settingsText(dir), /hoai-hook\.mjs/)
    assert.deepEqual(first.restartOutcomes, ['registered'])
  })
}

test('why a Windows folder never got the floor hook: its registration never ran. Once it runs, the folder that carries the rail gets the floor', () => {
  const ours = checkout()
  // The folder as it is found: the rail and the private turn hook from an older registration, and no floor.
  const dir = workspace(otherCase(ours), 'launch shim', railWithoutFloor(join(ours, 'bin', 'hoai-hook.mjs')))
  const before = settingsText(dir)
  const fs = windowsVolume()
  const first = boot(dir, ours, true, fs)
  assert.deepEqual(
    outcomes(first),
    ['registered'],
    `the boot answered ${outcomes(first)[0]} and left the settings ${settingsText(dir) === before ? 'untouched' : 'changed'}: the registration never ran for this folder`,
  )
  assert.match(settingsText(dir), /hoai-floor-hook\.mjs/, 'a folder that carries the rail gets the full set, floor included')
  // The private turn hook was there, so this serves the next launch and asks for no restart.
  assert.deepEqual(first.restartOutcomes, [])
  const settled = settingsText(dir)
  assert.deepEqual(outcomes(boot(dir, ours, true, fs)), ['already'])
  assert.equal(settingsText(dir), settled)
})

test('the floor rule is not what kept the floor out: where the checkout is spelled as the volume spells it, the second boot writes it', () => {
  const ours = checkout()
  const dir = workspace(ours)
  const fs = windowsVolume()
  assert.deepEqual(outcomes(boot(dir, ours, false, fs)), ['registered'])
  assert.doesNotMatch(settingsText(dir), /hoai-floor-hook\.mjs/, 'a folder that never had the rail gets no floor from the registration that writes the rail')
  assert.deepEqual(outcomes(boot(dir, ours, true, fs)), ['registered'])
  assert.match(settingsText(dir), /hoai-floor-hook\.mjs/)
})

test('a folder that never had the rail still gets no floor from the registration that writes the rail, under any spelling', () => {
  const ours = checkout()
  const dir = workspace(otherCase(ours), 'stable wrapper')
  const first = boot(dir, ours, false, windowsVolume())
  assert.deepEqual(outcomes(first), ['registered'])
  assert.equal(first.results[0]!.floor, false)
  assert.doesNotMatch(settingsText(dir), /hoai-floor-hook\.mjs/)
})

test('hooks that name this checkout\'s forwarder in another spelling are current: a boot does not rewrite them', () => {
  const ours = checkout()
  const dir = workspace(ours)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  // What a launcher that reached the checkout by another spelling wrote: the full set, its own spelling.
  ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: join(otherCase(ours), 'bin', 'hoai-hook.mjs') })
  const written = settingsText(dir)
  assert.deepEqual(outcomes(boot(dir, ours, true, windowsVolume())), ['already'], 'the boot and the launcher would rewrite each other\'s hooks at every start')
  assert.equal(settingsText(dir), written)
})

test('another checkout is still not this one: a different folder, the same name elsewhere, a folder that is not there', () => {
  const ours = checkout()
  const fs = windowsVolume()
  const other = checkout()
  const sibling = join(resolve(ours, '..'), 'Plugin Checkout Long Name 2')
  mkdirSync(sibling)
  for (const spelled of [other, otherCase(other), sibling, otherCase(sibling), join(ours, 'bin'), resolve(ours, '..'), join(resolve(ours, '..'), 'gone')]) {
    for (const form of FORMS) {
      const dir = workspace(spelled, form)
      assert.equal(workspaceNamesThisClone({ workdir: dir, pluginDir: ours, fs }), false, `${form}: ${spelled}`)
      assert.deepEqual(outcomes(boot(dir, ours, false, fs)), ['not_clone'], `${form}: ${spelled}`)
      assert.equal(existsSync(settingsPath(dir)), false, `${form}: ${spelled}`)
    }
  }
})

test('one id is not enough: folders with different names are different checkouts even when the volume gives both one id (a cloned disk)', () => {
  const ours = checkout()
  const copy = checkout()
  const cloned = { ...windowsVolume(), identity: () => 'one id for every folder' }
  for (const form of FORMS) {
    const dir = workspace(copy, form)
    assert.deepEqual(outcomes(boot(dir, ours, false, cloned)), ['not_clone'], form)
    assert.equal(existsSync(settingsPath(dir)), false, form)
  }
})

test('a file layer that gives no answer for a path matches nothing: two paths with no answer are not one folder', () => {
  const ours = checkout()
  const dir = workspace(checkout())
  const silent = { ...windowsVolume(), realpath: () => undefined }
  assert.equal(workspaceNamesThisClone({ workdir: dir, pluginDir: ours, fs: silent as never }), false)
  assert.deepEqual(outcomes(boot(dir, ours, false, silent)), ['not_clone'])
  assert.equal(existsSync(settingsPath(dir)), false)
})

test('a marketplace install is never touched, whatever the workspace names and however it spells it', () => {
  const ours = checkout()
  for (const spelled of [ours, otherCase(ours)]) {
    const dir = workspace(spelled)
    const result = registerCloneHooksAtBoot({ folders: [dir], pluginDir: ours, installMethod: 'marketplace', privateHookRegistered: false, fs: windowsVolume() } as never)
    assert.deepEqual(result, { results: [], restartOutcomes: [] })
    assert.equal(existsSync(settingsPath(dir)), false)
  }
})

test('a volume that cannot say which folder a path is leaves another spelling alone: in doubt, nothing is written', () => {
  const ours = checkout()
  const dir = workspace(otherCase(ours))
  assert.deepEqual(outcomes(boot(dir, ours, false, windowsVolume({ withIdentity: false }))), ['not_clone'])
  assert.equal(existsSync(settingsPath(dir)), false)
  // The same spelling needs no second opinion.
  const same = workspace(ours)
  assert.deepEqual(outcomes(boot(same, ours, false, windowsVolume({ withIdentity: false }))), ['registered'])
})

test('a boot that wrote no hooks because no folder starts this checkout says so, with what each folder names', () => {
  const skippedLine: any = (cloneHooks as Record<string, unknown>).cloneHooksSkippedLine
  assert.equal(typeof skippedLine, 'function', 'a boot that takes every folder for another checkout logs nothing at all: the skip is silent')
  const ours = checkout()
  const other = checkout()
  const named = workspace(other)
  const bare = volumeSpelling(scratchDir('clone-hooks-win-bare-'))
  const fs = windowsVolume()
  const skipped = registerCloneHooksAtBoot({ folders: [named, bare], pluginDir: ours, installMethod: 'clone', privateHookRegistered: false, fs } as never)
  assert.deepEqual(outcomes(skipped), ['not_clone', 'not_clone'])
  const line: string = skippedLine(skipped.results)
  assert.match(line, /^hooks: /)
  for (const part of [named, bare, other]) assert.ok(line.includes(part), `${part} is not in: ${line}`)
  assert.match(line, /hoai hooks/)
  // The checkout's own folder is one of a daemon's folders (it runs there) and is not an agent's folder: it is not
  // listed, and a checkout with a .mcp.json of its own does not speak for an agent folder that was skipped.
  const withOwnFolder = registerCloneHooksAtBoot({ folders: [named, ours], pluginDir: ours, installMethod: 'clone', privateHookRegistered: false, fs } as never)
  assert.deepEqual(outcomes(withOwnFolder), ['not_clone', 'not_clone'])
  const withoutIt: string = skippedLine(withOwnFolder.results)
  assert.ok(withoutIt.includes(named) && !withoutIt.includes(`${ours}:`), withoutIt)
  writeFileSync(join(ours, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: serverEntry(ours, 'server') } }))
  const withItsOwnEntry = registerCloneHooksAtBoot({ folders: [named, ours], pluginDir: ours, installMethod: 'clone', privateHookRegistered: false, fs } as never)
  assert.deepEqual(outcomes(withItsOwnEntry), ['not_clone', 'registered'])
  const stillSaid: string = skippedLine(withItsOwnEntry.results)
  assert.ok(stillSaid !== null && stillSaid.includes(named) && !stillSaid.includes(`${ours}:`), String(stillSaid))
  // Nothing more to say when a folder was registered or was current, or failed (that has its own line), or on a marketplace install.
  const mixed = registerCloneHooksAtBoot({ folders: [workspace(ours), bare], pluginDir: ours, installMethod: 'clone', privateHookRegistered: false, fs } as never)
  assert.deepEqual(outcomes(mixed), ['registered', 'not_clone'])
  assert.equal(skippedLine(mixed.results), null)
  assert.equal(skippedLine([{ folder: named, outcome: 'failed', detail: 'EACCES', floor: false }]), null)
  assert.equal(skippedLine([]), null)
  assert.equal(skippedLine(undefined), null)
  // The daemon logs it at boot.
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'), 'utf8')
  assert.match(server, /cloneHooksSkippedLine\(bootHooks\.results\)/)
})

test('the skip line is one line, and what it quotes from a .mcp.json is cut at 200 characters', () => {
  const skippedLine: any = (cloneHooks as Record<string, unknown>).cloneHooksSkippedLine
  assert.equal(typeof skippedLine, 'function')
  const ours = checkout()
  const dir = volumeSpelling(scratchDir('clone-hooks-win-long-'))
  // A server path of 50,000 characters with line breaks and a terminal escape in it.
  const hostile = `${sep}x${sep}${'evil\n\r\u001b[2Jline '.repeat(3000)}${sep}server.ts`
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [hostile] } } }))
  const skipped = registerCloneHooksAtBoot({ folders: [dir], pluginDir: ours, installMethod: 'clone', privateHookRegistered: false, fs: windowsVolume() } as never)
  assert.deepEqual(outcomes(skipped), ['not_clone'])
  const line: string = skippedLine(skipped.results)
  assert.doesNotMatch(line, /[\u0000-\u001f\u007f]/, 'a line break or a control character reached the log')
  const quoted = line.slice(line.indexOf(dir) + dir.length)
  assert.ok(quoted.length <= 200 + 120, `the folder's part of the line is ${quoted.length} characters`)
  assert.ok(String(skipped.results[0]!.detail).length <= 200 + 40, `the detail is ${String(skipped.results[0]!.detail).length} characters`)
})

test('a settings file with a byte order mark keeps what the owner put in it when a boot registers the hooks', () => {
  const ours = checkout()
  const owners = { permissions: { deny: ['AskUserQuestion'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3', args: ['/gate.py'] }] }] } }
  const dir = workspace(ours, 'launch shim', `\ufeff${JSON.stringify(owners, null, 2)}`)
  assert.deepEqual(outcomes(boot(dir, ours, false, windowsVolume())), ['registered'])
  const after = JSON.parse(settingsText(dir).replace(/^\ufeff/, ''))
  assert.deepEqual(after.permissions, owners.permissions, 'the owner\'s permissions are gone')
  assert.match(JSON.stringify(after.hooks.PreToolUse), /gate\.py/, 'the owner\'s own hook is gone')
  assert.match(settingsText(dir), /hoai-private-turn-hook\.mjs/)
})

test('a settings file that is not JSON is left exactly as it is by a boot, which says the write failed and why', () => {
  const ours = checkout()
  const text = '// my own notes\n{ "permissions": { "deny": ["AskUserQuestion"] } }\n'
  const dir = workspace(ours, 'launch shim', text)
  const result = boot(dir, ours, false, windowsVolume())
  assert.deepEqual(outcomes(result), ['failed'])
  assert.equal(settingsText(dir), text, 'the owner\'s file was replaced')
  assert.ok(String(result.results[0]!.detail).includes(settingsPath(dir)), String(result.results[0]!.detail))
  // A write that failed arms no restart.
  assert.deepEqual(result.restartOutcomes, ['failed'])
})

// -- Windows only: the real file system ---------------------------------------------------------------------------

/** The 8.3 short spelling of a path, or the path itself on a volume that keeps no short names. */
function shortSpelling(path: string): string {
  const asked = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true })
  return (asked.status === 0 && asked.stdout.trim()) || path
}

/** Every spelling Windows accepts for one folder, by name. A null spelling does not exist on this volume. */
function windowsSpellings(ours: string): Array<[string, string | null]> {
  const alias = join(volumeSpelling(scratchDir('clone-hooks-win-alias-')), 'alias to the checkout')
  linkFolder(ours, alias)
  const short = shortSpelling(ours)
  const drive = ours[0]!
  return [
    ['as the volume spells it', ours],
    ['the drive letter in the other case', (drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()) + ours.slice(1)],
    ['every name in upper case', ours.toUpperCase()],
    ['every name in lower case', ours.toLowerCase()],
    ['forward slashes', ours.replace(/\\/g, '/')],
    ['forward slashes and the other case', otherCase(ours).replace(/\\/g, '/')],
    ['a trailing separator', `${ours}\\`],
    ['its 8.3 short name', short === ours ? null : short],
    ['the \\\\?\\ prefix', `\\\\?\\${ours}`],
    ['the \\\\?\\ prefix and another case', `\\\\?\\${ours.toLowerCase()}`],
    ['through a junction', alias],
    ['through a junction, in the other case', otherCase(alias)],
  ]
}

test('Windows: every spelling of this checkout is this checkout, in every form a workspace carries, and the boot registers its hooks', { skip: onWindows ? false : NOT_WINDOWS }, (t) => {
  const ours = checkout()
  const missed: string[] = []
  for (const [name, spelled] of windowsSpellings(ours)) {
    if (spelled === null) {
      t.diagnostic(`${name}: this volume keeps none, not checked here`)
      continue
    }
    for (const form of FORMS) {
      const dir = workspace(spelled, form)
      const named = workspaceNamesThisClone({ workdir: dir, pluginDir: ours })
      const outcome = registerCloneHooksAtBoot({ folders: [dir], pluginDir: ours, installMethod: 'clone', privateHookRegistered: false }).results[0]!.outcome
      if (!named || outcome !== 'registered') missed.push(`${name} (${form}): ${outcome}`)
    }
  }
  assert.deepEqual(missed, [], `these spellings were taken for another checkout, so no hook was written:\n${missed.join('\n')}`)
})

test('Windows: the checkout may be the one spelled another way (an updater hands the registrar its own spelling)', { skip: onWindows ? false : NOT_WINDOWS }, () => {
  const ours = checkout()
  const missed: string[] = []
  for (const [name, spelled] of windowsSpellings(ours)) {
    if (spelled === null) continue
    const dir = workspace(ours)
    const outcome = registerCloneHooks({ workdir: dir, pluginDir: spelled }).outcome
    if (outcome !== 'registered') missed.push(`${name}: ${outcome}`)
  }
  assert.deepEqual(missed, [])
})

test('Windows: a folder that carries the rail without the floor gets the floor at the next boot, whatever the spelling', { skip: onWindows ? false : NOT_WINDOWS }, () => {
  const ours = checkout()
  const dir = workspace(ours.toLowerCase(), 'launch shim', railWithoutFloor(join(ours, 'bin', 'hoai-hook.mjs')))
  const first = registerCloneHooksAtBoot({ folders: [dir], pluginDir: ours, installMethod: 'clone', privateHookRegistered: true })
  assert.deepEqual(outcomes(first), ['registered'], `the boot answered ${outcomes(first)[0]}: the registration never ran for this folder`)
  assert.match(settingsText(dir), /hoai-floor-hook\.mjs/)
  assert.deepEqual(outcomes(registerCloneHooksAtBoot({ folders: [dir], pluginDir: ours, installMethod: 'clone', privateHookRegistered: true })), ['already'])
})

test('Windows: another folder is never this checkout, under any spelling of it', { skip: onWindows ? false : NOT_WINDOWS }, () => {
  const ours = checkout()
  const sibling = join(resolve(ours, '..'), 'Plugin Checkout Long Name 2')
  mkdirSync(join(sibling, 'bin'), { recursive: true })
  writeFileSync(join(sibling, 'server.ts'), '')
  const taken: string[] = []
  for (const [name, spelled] of windowsSpellings(sibling)) {
    if (spelled === null) continue
    for (const form of FORMS) {
      const dir = workspace(spelled, form)
      const outcome = registerCloneHooksAtBoot({ folders: [dir], pluginDir: ours, installMethod: 'clone', privateHookRegistered: false }).results[0]!.outcome
      if (outcome !== 'not_clone' || existsSync(settingsPath(dir))) taken.push(`${name} (${form}): ${outcome}`)
    }
  }
  assert.deepEqual(taken, [])
})

test('Windows: hooks a launcher wrote under another spelling of this checkout are left as they are', { skip: onWindows ? false : NOT_WINDOWS }, () => {
  const ours = checkout()
  writeFileSync(join(ours, 'bin', 'hoai-floor-hook.mjs'), '')
  const dir = workspace(ours)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: join(ours.toLowerCase(), 'bin', 'hoai-hook.mjs') })
  const written = settingsText(dir)
  assert.equal(registerCloneHooks({ workdir: dir, pluginDir: ours }).outcome, 'already')
  assert.equal(settingsText(dir), written)
})
