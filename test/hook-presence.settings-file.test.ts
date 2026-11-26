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

/** What the daemon looks at: one agent folder whose settings file holds `text` (no file when undefined). */
function session(text?: string) {
  return {
    installMethod: 'clone' as const,
    pluginRoot: '/plugin',
    folders: ['/agent'],
    configDir: '',
    env: {},
    readFile: (path: string) => {
      if (path !== SETTINGS || text === undefined) throw new Error('ENOENT')
      return text
    },
    exists: () => true,
    join: (...parts: string[]) => parts.join('/'),
  }
}

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

test('a refused private call names the file that is not JSON and says to fix or remove it, not to restart', () => {
  assert.equal(typeof missingRefusal, 'function', NO_REFUSAL)
  const blocked = privateHookPresence(session('// my own notes\n{}'))
  const text: string = missingRefusal(blocked)
  assert.ok(text.includes(SETTINGS), text)
  assert.match(text, /private turn hook is not registered/)
  assert.match(text, /fix/i)
  assert.match(text, /remove/i)
  assert.doesNotMatch(text, /Ask the owner to restart this agent/, 'a restart cannot help while the file is not JSON')
  assert.doesNotMatch(text, /\n/)
  // The boot line says the same thing, once.
  const line = privateHookBootLine(blocked)
  assert.ok(line.includes(SETTINGS), line)
  assert.match(line, /NOT registered/)
  assert.doesNotMatch(line, /it loads when this agent restarts/)
  // With nothing in the way the advice is the old one: the daemon writes the hook at boot, a restart loads it.
  assert.equal(missingRefusal(privateHookPresence(session())), PRIVATE_HOOK_MISSING_REFUSAL)
  assert.equal(missingRefusal(privateHookPresence(session('{}'))), PRIVATE_HOOK_MISSING_REFUSAL)
  assert.match(privateHookBootLine(privateHookPresence(session())), /it loads when this agent restarts/)
})

test('the running daemon carries the file through to the refusal it words, until the hook is live', () => {
  assert.equal(typeof missingRefusal, 'function', NO_REFUSAL)
  const hook = createPrivateHookLiveness({ atBoot: privateHookPresence(session('{ not json')) })
  assert.ok(String(missingRefusal(hook.presence)).includes(SETTINGS))
  hook.noteTurn({ markerPath: '/state/marker' })
  assert.equal((hook.presence as { unreadableSettings?: string }).unreadableSettings, undefined)
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  assert.match(server, /const PRIVATE_HOOK_MISSING_REFUSAL = privateHookMissingRefusal\(PRIVATE_HOOK\)\n/)
})
