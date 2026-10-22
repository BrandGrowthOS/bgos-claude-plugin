/**
 * The daemon's boot registration of a clone workspace's hooks (board row f83db4b7): whatever `hoai run` writes before a
 * launch, the daemon writes itself at EVERY boot, however the session was started. KC's Windows agents are started by
 * hoai-switch.ps1, which runs claude without `hoai run`, so this boot step was all they had, and it ran only while the
 * private turn hook was MISSING (server.ts `if (!PRIVATE_HOOK.registered ...)`): once a folder held that one entry,
 * no later hook change ever reached it.
 *
 * Real files on temp workspaces, the real lib/claude-preseed.mjs ensureHookEntries (what `hoai run` calls) and the
 * real lib/private-hook-presence.ts (what the daemon's gate read). At main this is red for the true reason: there is
 * no boot registration for a folder whose private turn hook is already registered.
 *
 * Run: npx tsx --test test/clone-hooks.boot.test.ts
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ensureHookEntries } from '../lib/claude-preseed.mjs'
import * as cloneHooks from '../lib/clone-hooks.mjs'
import { privateHookPresence } from '../lib/private-hook-presence'
import { linkFolder } from './helpers/links.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const FORWARDER = join(repoRoot, 'bin', 'hoai-hook.mjs')
const atBoot: any = (cloneHooks as Record<string, unknown>).registerCloneHooksAtBoot
const NO_BOOT =
  'lib/clone-hooks.mjs has no registerCloneHooksAtBoot: the daemon registers a clone workspace\'s hooks at boot only while ' +
  'the private turn hook is missing (server.ts `if (!PRIVATE_HOOK.registered && INSTALL_METHOD !== \'marketplace\')`), so a ' +
  'folder that has it never gets a later hook change'

/** A clone workspace of this checkout, with `settings` as its .claude/settings.local.json when given. */
function workspace(settings?: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-boot-')))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')] } } }))
  if (settings !== undefined) {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.local.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2))
  }
  return dir
}
const settingsPath = (dir: string) => join(dir, '.claude', 'settings.local.json')
const settingsText = (dir: string) => readFileSync(settingsPath(dir), 'utf8')
const hooksOf = (dir: string) => JSON.parse(settingsText(dir)).hooks

/** What `hoai run` leaves in a folder (bin/hoai-core.mjs hookRegistrationFor + ensureHookEntries): the full set, floor included. */
function whatHoaiRunWrites(stale: string): unknown {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-hoai-run-')))
  const path = join(scratch, 'settings.local.json')
  writeFileSync(path, stale)
  ensureHookEntries({ settingsPath: path, forwarderPath: FORWARDER })
  return JSON.parse(readFileSync(path, 'utf8')).hooks
}

/**
 * A folder registered by an older version: the private turn hook is there (so the daemon's gate counted it as
 * registered), but later changes are not: the private hook's old 3 s timeout, no SubagentStart helper guard, no
 * private tool guard on PreToolUse, no PostCompact event, no floor.
 */
function staleSettings(): string {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-stale-')))
  const path = join(scratch, 'settings.local.json')
  ensureHookEntries({ settingsPath: path, forwarderPath: FORWARDER })
  const settings = JSON.parse(readFileSync(path, 'utf8'))
  const hooks = settings.hooks
  delete hooks.SubagentStart
  delete hooks.PostCompact
  hooks.PreToolUse = hooks.PreToolUse.filter((m: { matcher?: string }) => !m.matcher)
  for (const matchers of Object.values(hooks) as Array<Array<{ hooks: Array<{ args: string[]; timeout: number }> }>>) {
    for (const matcher of matchers) for (const hook of matcher.hooks) if (hook.args[0].endsWith('hoai-private-turn-hook.mjs')) hook.timeout = 3
  }
  return JSON.stringify(settings, null, 2)
}

function presenceOf(dir: string) {
  return privateHookPresence({
    installMethod: 'clone',
    pluginRoot: repoRoot,
    folders: [dir],
    configDir: '',
    env: {},
    readFile: (p) => readFileSync(p, 'utf8'),
    exists: existsSync,
    join,
  })
}

test('a folder whose private turn hook is already registered gets the CURRENT hook set at boot, the set `hoai run` writes', () => {
  assert.equal(typeof atBoot, 'function', NO_BOOT)
  const stale = staleSettings()
  const dir = workspace(stale)
  // This is the folder the old gate skipped: the daemon counted the hook as registered.
  assert.equal(presenceOf(dir).registered, true)

  const boot = atBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: true })
  assert.deepEqual(boot.results.map((r: { outcome: string }) => r.outcome), ['registered'])
  assert.deepEqual(hooksOf(dir), whatHoaiRunWrites(stale))
  assert.match(JSON.stringify(hooksOf(dir).PreToolUse), /hoai-floor-hook\.mjs/, 'a folder that carries the rail keeps its full set')
  // The hook was already there, so this refresh serves the next launch and asks for no restart.
  assert.deepEqual(boot.restartOutcomes, [])
})

test('a second boot changes nothing: idempotent, byte for byte', () => {
  assert.equal(typeof atBoot, 'function', NO_BOOT)
  const dir = workspace(staleSettings())
  atBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: true })
  const before = settingsText(dir)
  const again = atBoot({ folders: [dir, dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: true })
  assert.deepEqual(again.results.map((r: { outcome: string }) => r.outcome), ['already'])
  assert.equal(settingsText(dir), before)
})

test('a folder with no hoai entry at all: the rail and the private turn hook, not the floor, and the ONE restart is armed', () => {
  assert.equal(typeof atBoot, 'function', NO_BOOT)
  const dir = workspace({ hooks: { PreToolUse: [{ matcher: 'mcp__bgos__reply', hooks: [{ type: 'command', command: 'python3', args: ['/gate.py'] }] }] } })
  const boot = atBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: false })
  assert.deepEqual(boot.restartOutcomes, ['registered'])
  const hooks = hooksOf(dir)
  assert.match(JSON.stringify(hooks.UserPromptSubmit), /hoai-private-turn-hook\.mjs/)
  assert.match(JSON.stringify(hooks.UserPromptSubmit), /hoai-hook\.mjs/)
  // lib/clone-hooks.mjs keeps its rule: a registration that finds no rail does not add the blocking floor hook.
  assert.doesNotMatch(JSON.stringify(hooks), /hoai-floor-hook\.mjs/)
  assert.match(JSON.stringify(hooks.PreToolUse), /gate\.py/, "the owner's own hook is kept")
  assert.equal(presenceOf(dir).registered, true)
})

test('the rule is per registration: the boot after the rail was written finds it and writes the full set, as the next update already did', () => {
  assert.equal(typeof atBoot, 'function', NO_BOOT)
  const dir = workspace()
  atBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: false })
  assert.doesNotMatch(settingsText(dir), /hoai-floor-hook\.mjs/)
  const next = atBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: true })
  assert.deepEqual(next.results.map((r: { outcome: string }) => r.outcome), ['registered'])
  assert.match(JSON.stringify(hooksOf(dir).PreToolUse), /hoai-floor-hook\.mjs/)
  assert.deepEqual(next.restartOutcomes, [])
})

test('a marketplace install, and a folder that is not this checkout\'s, are never touched', () => {
  assert.equal(typeof atBoot, 'function', NO_BOOT)
  const clone = workspace()
  const market = atBoot({ folders: [clone], pluginDir: repoRoot, installMethod: 'marketplace', privateHookRegistered: false })
  assert.deepEqual(market, { results: [], restartOutcomes: [] })
  assert.equal(existsSync(settingsPath(clone)), false)
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-boot-other-')))
  const boot = atBoot({ folders: [other], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: false })
  assert.deepEqual(boot.results.map((r: { outcome: string }) => r.outcome), ['not_clone'])
  assert.equal(existsSync(settingsPath(other)), false)
})

test('it never throws: no folders, junk folders, an unreadable disk, a write that fails', () => {
  assert.equal(typeof atBoot, 'function', NO_BOOT)
  for (const folders of [undefined, null, [], [''], [null]]) {
    assert.deepEqual(atBoot({ folders, pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: true }), { results: [], restartOutcomes: [] })
  }
  const dir = workspace(staleSettings())
  const exploding = {
    readFile: () => {
      throw new Error('EIO: the disk went away')
    },
    realpath: () => {
      throw new Error('EIO: the disk went away')
    },
  }
  const unreadable = atBoot({ folders: [dir], pluginDir: repoRoot, installMethod: 'clone', privateHookRegistered: false, fs: exploding })
  assert.equal(unreadable.results[0].outcome, 'failed')
  const unwritable = atBoot({
    folders: [dir],
    pluginDir: repoRoot,
    installMethod: 'clone',
    privateHookRegistered: false,
    register: () => {
      throw new Error('EACCES: settings.local.json is read only')
    },
  })
  assert.equal(unwritable.results[0].outcome, 'failed')
  assert.match(unwritable.results[0].detail, /EACCES/)
})

test('a folder `hoai run` wrote through another spelling of this checkout is already current: a boot does not rewrite it', () => {
  // `hoai run` writes its own path to the forwarder (bin/hoai-core.mjs hookRegistrationFor, from its scriptDir); the
  // daemon knows the checkout by import.meta.dir. Through an aliased home those are two spellings of one file, and
  // ensureHookEntries compares strings: before this, every boot rewrote the block and every `hoai run` wrote it back.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-boot-alias-')))
  const alias = join(scratch, 'checkout')
  linkFolder(repoRoot, alias)
  const dir = workspace()
  mkdirSync(join(dir, '.claude'), { recursive: true })
  ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: join(alias, 'bin', 'hoai-hook.mjs') })
  const written = settingsText(dir)
  assert.equal(cloneHooks.registerCloneHooks({ workdir: dir, pluginDir: repoRoot }).outcome, 'already')
  assert.equal(settingsText(dir), written)
  // A forwarder of ANOTHER checkout is still replaced with this one.
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-boot-othercheckout-')))
  mkdirSync(join(other, 'bin'))
  copyFileSync(FORWARDER, join(other, 'bin', 'hoai-hook.mjs'))
  const elsewhere = workspace()
  mkdirSync(join(elsewhere, '.claude'), { recursive: true })
  ensureHookEntries({ settingsPath: settingsPath(elsewhere), forwarderPath: join(other, 'bin', 'hoai-hook.mjs') })
  assert.equal(cloneHooks.registerCloneHooks({ workdir: elsewhere, pluginDir: repoRoot }).outcome, 'registered')
  const forwarders = (Object.values(hooksOf(elsewhere)) as Array<Array<{ hooks: Array<{ args?: string[] }> }>>)
    .flat()
    .flatMap((matcher) => matcher.hooks)
    .map((hook) => hook.args?.[0] ?? '')
    .filter((arg) => arg.endsWith('hoai-hook.mjs'))
  assert.ok(forwarders.length > 0 && forwarders.every((arg) => arg === FORWARDER), forwarders.join(', '))
})
