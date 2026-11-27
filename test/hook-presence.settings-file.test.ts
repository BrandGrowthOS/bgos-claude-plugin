/**
 * The daemon's two readers of an agent folder's settings file (is the floor hook registered, is the private turn
 * hook registered) and what a refused private call says, for a file Windows wrote and for a file that is not JSON.
 *
 * A byte order mark: Windows PowerShell writes one, and a reader that hands the text straight to JSON.parse refuses
 * the whole file. The hooks were there and the daemon said they were not, at every boot.
 *
 * Not JSON: the hook writer leaves such a file exactly as it is, because it holds the owner's own hooks and
 * permissions. So the folder has no HOAI hook until the owner mends the file, and "restart this agent" is advice
 * that cannot work. The refusal has to name the file.
 *
 * Run: npx tsx --test test/hook-presence.settings-file.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { ensureHookEntries } from '../lib/claude-preseed.mjs'
import { floorHookPresence } from '../lib/floor-hook-presence.ts'
import * as privateHook from '../lib/private-hook-presence.ts'
import { PRIVATE_HOOK_MISSING_REFUSAL, createPrivateHookLiveness, privateHookBootLine, privateHookPresence } from '../lib/private-hook-presence.ts'

const SETTINGS = '/agent/.claude/settings.local.json'
const missingRefusal: any = (privateHook as Record<string, unknown>).privateHookMissingRefusal
const NO_REFUSAL = 'lib/private-hook-presence.ts has no privateHookMissingRefusal: a refused private call says "restart this agent" whatever the cause'

/** The full set of hooks, as the writer leaves it in a folder. */
function fullSet(): string {
  const files = new Map<string, string>()
  ensureHookEntries({
    settingsPath: SETTINGS,
    forwarderPath: '/plugin/bin/hoai-hook.mjs',
    fs: { readFile: (p: string) => files.get(p) ?? null, writeFile: (p: string, text: string) => void files.set(p, text) },
  } as never)
  return files.get(SETTINGS)!
}

/**
 * What the daemon looks at: one agent folder whose settings file holds `text` (no file when undefined). `folder`
 * and `slash` spell the folder as its own computer would.
 */
function session(text?: string, folder = '/agent', slash = '/') {
  const settings = [folder, '.claude', 'settings.local.json'].join(slash)
  return {
    installMethod: 'clone' as const,
    pluginRoot: '/plugin',
    folders: [folder],
    configDir: '',
    env: {},
    readFile: (path: string) => {
      if (path !== settings || text === undefined) throw new Error('ENOENT')
      return text
    },
    exists: () => true,
    join: (...parts: string[]) => parts.join(slash),
  }
}

/** Folders as two computers spell them, with names that appear in no sentence the daemon writes. */
const LOCAL_FOLDERS: Array<[folder: string, slash: string, parts: string[]]> = [
  ['/srv/zeta/quartz', '/', ['srv', 'zeta', 'quartz']],
  ['D:\\Zeta\\Quartz Folder', '\\', ['D:', 'Zeta', 'Quartz']],
]

test('both readers read past a byte order mark: hooks that are in the file are registered', () => {
  const text = fullSet()
  assert.equal(floorHookPresence(session(text)).registered, true)
  assert.equal(privateHookPresence(session(text)).registered, true)
  const marked = `\ufeff${text}`
  assert.equal(floorHookPresence(session(marked)).registered, true, 'the floor hook is in the file and the daemon says it is not')
  assert.equal(privateHookPresence(session(marked)).registered, true, 'the private turn hook is in the file and the daemon says it is not')
})

test('a settings file that is not JSON: no hook is registered, and the daemon knows which file is in the way', () => {
  for (const text of ['// my own notes\n{ "permissions": {} }', '{ "a": 1, }', '[]']) {
    const presence = privateHookPresence(session(text))
    assert.equal(presence.registered, false)
    assert.equal((presence as { unreadableSettings?: string }).unreadableSettings, SETTINGS, JSON.stringify(text))
    assert.equal(floorHookPresence(session(text)).registered, false)
  }
  // A folder with no settings file, an empty one, or one that simply has no hook in it has nothing in the way.
  for (const text of [undefined, '', '{}', '\ufeff{ "permissions": {} }']) {
    const presence = privateHookPresence(session(text))
    assert.equal(presence.registered, false)
    assert.equal((presence as { unreadableSettings?: string }).unreadableSettings, undefined, JSON.stringify(text))
  }
})

test('a refused private call names the file by its place in the agent folder, never by its full path, and says to fix or remove it', () => {
  assert.equal(typeof missingRefusal, 'function', NO_REFUSAL)
  // The refusal is read in a chat, and an agent answers in groups too: a folder name on the owner's computer is
  // not for them to read. The full path stays in the log (the boot line below).
  for (const [folder, slash, parts] of LOCAL_FOLDERS) {
    const text: string = missingRefusal(privateHookPresence(session('// my own notes\n{}', folder, slash)))
    assert.ok(text.includes('.claude/settings.local.json'), text)
    for (const part of parts) assert.ok(!text.includes(part), `the refusal carries "${part}" of the local path: ${text}`)
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\\/, `the refusal carries a local path: ${text}`)
    assert.match(text, /private turn hook is not registered/)
    assert.match(text, /fix or remove it/i)
    assert.doesNotMatch(text, /Ask the owner to restart this agent/, 'a restart cannot help while the file is not JSON')
    assert.doesNotMatch(text, /\n/)
  }
  // With nothing in the way the advice is the old one: the daemon writes the hook at boot, a restart loads it.
  assert.equal(missingRefusal(privateHookPresence(session())), PRIVATE_HOOK_MISSING_REFUSAL)
  assert.equal(missingRefusal(privateHookPresence(session('{}'))), PRIVATE_HOOK_MISSING_REFUSAL)
})

test('the boot line, which stays in the log, names the file by its full path and says to fix or remove it', () => {
  for (const [folder, slash] of LOCAL_FOLDERS) {
    const line = privateHookBootLine(privateHookPresence(session('// my own notes\n{}', folder, slash)))
    assert.match(line, /NOT registered/)
    assert.match(line, /Fix or remove that file/, `the boot line does not say what to do about a file that is not JSON: ${line}`)
    assert.ok(line.includes([folder, '.claude', 'settings.local.json'].join(slash)), line)
    assert.doesNotMatch(line, /it loads when this agent restarts/)
  }
  // With nothing in the way the boot line is the old one.
  assert.match(privateHookBootLine(privateHookPresence(session())), /it loads when this agent restarts/)
  assert.doesNotMatch(privateHookBootLine(privateHookPresence(session())), /Fix or remove/)
})

test('the running daemon carries the file through to the refusal it words, until the hook is live', () => {
  assert.equal(typeof missingRefusal, 'function', NO_REFUSAL)
  const [folder, slash, parts] = LOCAL_FOLDERS[0]!
  const hook = createPrivateHookLiveness({ atBoot: privateHookPresence(session('{ not json', folder, slash)) })
  const text = String(missingRefusal(hook.presence))
  assert.ok(text.includes('.claude/settings.local.json') && parts.every((part) => !text.includes(part)), text)
  hook.noteTurn({ markerPath: '/state/marker' })
  assert.equal((hook.presence as { unreadableSettings?: string }).unreadableSettings, undefined)
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  assert.match(server, /const PRIVATE_HOOK_MISSING_REFUSAL = privateHookMissingRefusal\(PRIVATE_HOOK\)\n/)
})
