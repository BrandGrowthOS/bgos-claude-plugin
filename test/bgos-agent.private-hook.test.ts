/**
 * Board bbbf3438 follow-up. Since 0.67.0 boards, schedule and browser tools run
 * only inside a turn whose marker bin/hoai-private-turn-hook.mjs wrote. A CLONE
 * workspace gets that hook only from its own .claude/settings.local.json, and
 * `bgos-agent update` refreshed only a workspace that already named
 * hoai-hook.mjs. KC's Mac had nine agents with no entry at all, so every
 * private call refused ("its current sender could not be verified") on any
 * turn, and no update could have fixed that.
 *
 * Part 1 runs the REAL shell functions (cut out of bin/bgos-agent, run in bash
 * with stand-ins for the log helpers) on a temp workspace:
 *   - a clone workspace with no hoai entry ends with the private turn hook
 *     registered on UserPromptSubmit, Stop, SessionEnd, SubagentStart and the
 *     narrowed PreToolUse, and NO floor hook (a held action is the owner's call);
 *   - the same through a symlinked checkout path (the .mcp.json may spell
 *     either side of an aliased home);
 *   - a workspace that already carries the rail keeps its floor hook;
 *   - a workspace whose .mcp.json names another checkout, or has none (a
 *     marketplace install), is left untouched.
 * Part 2 pins the daemon's presence check and its loud boot line.
 *
 * Run: npx tsx --test test/bgos-agent.private-hook.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PRIVATE_HOOK_MISSING_REFUSAL,
  privateHookBootLine,
  privateHookPresence,
  registersPrivateHook,
} from '../lib/private-hook-presence.ts'
import { resolvePosixBash } from './helpers/posix-bash.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const script = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')

function fn(name: string): string {
  const start = script.indexOf(`\n${name}() {`)
  assert.ok(start >= 0, `${name} is defined`)
  const end = script.indexOf('\n}\n', start)
  return script.slice(start + 1, end + 3)
}

const FUNCTIONS = [
  'plugin_cache_key',
  'install_hook_entries',
  'workdir_names_this_clone',
  'register_hooks_for_clone_workdir',
].map(fn).join('\n')

function register(workdir: string, pluginDir: string) {
  const harness = [
    'info() { :; }; ok() { :; }; warn() { :; }',
    `PLUGIN_DIR=${JSON.stringify(pluginDir)}`,
    FUNCTIONS,
    `register_hooks_for_clone_workdir ${JSON.stringify(workdir)}`,
  ].join('\n')
  return spawnSync(BASH!, ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(workdir, '.no-claude-config') },
  })
}

function workspace(mcp: unknown | null, settings?: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'phook-ws-')))
  if (mcp) writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcp))
  if (settings) {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(settings))
  }
  return dir
}

const mcpFor = (serverTs: string) => ({ mcpServers: { bgos: { command: 'bun', args: [serverTs] } } })
const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))
const text = (value: unknown) => JSON.stringify(value)
const SKIP = BASH ? false : 'needs a posix bash'

test('a clone workspace with no hoai entry gets the private turn hook on every private event, and no floor hook', { skip: SKIP }, () => {
  const dir = workspace(mcpFor(join(repoRoot, 'server.ts')))
  const res = register(dir, repoRoot)
  assert.equal(res.status, 0, res.stderr)
  const hooks = settingsOf(dir).hooks
  for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd', 'SubagentStart']) {
    assert.match(text(hooks[event]), /hoai-private-turn-hook\.mjs/, `${event} carries the private turn hook`)
  }
  assert.match(text(hooks.PreToolUse), /hoai-private-turn-hook\.mjs/)
  assert.doesNotMatch(text(hooks), /hoai-floor-hook\.mjs/, 'no floor hook for a folder that never had one')
  assert.match(text(hooks.UserPromptSubmit), /hoai-hook\.mjs/, 'the activity forwarder comes with it')
})

test('the same through a symlinked checkout: the .mcp.json may spell either side of an aliased home', { skip: SKIP }, () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'phook-alias-')))
  const alias = join(scratch, 'alias')
  symlinkSync(repoRoot, alias)
  const dir = workspace(mcpFor(join(alias, 'server.ts')))
  const res = register(dir, repoRoot)
  assert.equal(res.status, 0, res.stderr)
  assert.match(text(settingsOf(dir).hooks.UserPromptSubmit), /hoai-private-turn-hook\.mjs/)
})

test('a folder that already carries the rail keeps its floor hook', { skip: SKIP }, () => {
  const dir = workspace(mcpFor(join(repoRoot, 'server.ts')), {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: [join(repoRoot, 'bin', 'hoai-hook.mjs')], timeout: 3, async: true }] }] },
  })
  const res = register(dir, repoRoot)
  assert.equal(res.status, 0, res.stderr)
  const hooks = settingsOf(dir).hooks
  assert.match(text(hooks.UserPromptSubmit), /hoai-private-turn-hook\.mjs/)
  assert.match(text(hooks.PreToolUse), /hoai-floor-hook\.mjs/)
})

test('a workspace that names another checkout, or has no .mcp.json, is left untouched', { skip: SKIP }, () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'phook-other-')))
  writeFileSync(join(other, 'server.ts'), '')
  const named = workspace(mcpFor(join(other, 'server.ts')))
  const none = workspace(null)
  for (const dir of [named, none]) {
    const res = register(dir, repoRoot)
    assert.equal(res.status, 0, res.stderr)
    assert.equal(existsSync(join(dir, '.claude', 'settings.local.json')), false, `${dir} was not written`)
  }
})

test('update reaches an agent a keepalive job supervises: its declared folder is registered without a bgos-agent service', () => {
  const update = fn('cmd_update')
  assert.match(update, /service\.json/)
  assert.match(update, /register_hooks_for_clone_workdir "\$declared"/)
  const refresh = fn('refresh_hook_entries')
  assert.match(refresh, /register_hooks_for_clone_workdir "\$workdir"/)
})

test('presence: a synchronous UserPromptSubmit entry counts, an async one or another event does not', () => {
  const entry = (extra: Record<string, unknown> = {}) => ({
    type: 'command',
    command: 'node',
    args: ['/x/bin/hoai-private-turn-hook.mjs'],
    timeout: 3,
    async: false,
    ...extra,
  })
  const opts = { exists: () => true, pluginRootVariable: false }
  assert.equal(registersPrivateHook({ hooks: { UserPromptSubmit: [{ hooks: [entry()] }] } }, opts), true)
  assert.equal(registersPrivateHook({ hooks: { UserPromptSubmit: [{ hooks: [entry({ async: true })] }] } }, opts), false)
  assert.equal(registersPrivateHook({ hooks: { Stop: [{ hooks: [entry()] }] } }, opts), false)
  assert.equal(registersPrivateHook({ hooks: { UserPromptSubmit: [{ hooks: [entry()] }] } }, { ...opts, exists: () => false }), false)
})

test('presence: KC\'s case, a clone folder with a bgos-send-gate hook and nothing else, reads as not registered, and the boot line is loud', () => {
  const files: Record<string, string> = {
    '/ws/.claude/settings.local.json': JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'mcp__bgos__reply', hooks: [{ type: 'command', command: 'python3', args: ['/g.py'] }] }] },
    }),
  }
  const presence = privateHookPresence({
    installMethod: 'clone',
    pluginRoot: '/p',
    folders: ['/ws'],
    configDir: '/cfg',
    env: {},
    readFile: (p) => {
      if (p in files) return files[p]!
      throw new Error('ENOENT')
    },
    exists: () => true,
    join: (...parts) => parts.join('/'),
  })
  assert.equal(presence.registered, false)
  const line = privateHookBootLine(presence)
  assert.match(line, /NOT registered/)
  // It no longer sends the owner to `bgos-agent update`, which resets a clone to the head of origin/main (board row
  // 84c23fab): the daemon writes the hook itself at boot (board row f83db4b7), so a restart loads it.
  assert.doesNotMatch(line, /bgos-agent update/)
  assert.match(line, /writes it into its workspace at boot/)
  assert.doesNotMatch(PRIVATE_HOOK_MISSING_REFUSAL, /bgos-agent update/)
  assert.match(PRIVATE_HOOK_MISSING_REFUSAL, /restart this agent/)
  assert.match(PRIVATE_HOOK_MISSING_REFUSAL, /private turn hook is not registered/)
})

test('the daemon logs the line at boot and keeps the gate closed: the refusal path is not a fallback', () => {
  const server = readFileSync(join(repoRoot, 'server.ts'), 'utf8')
  assert.match(server, /log\(privateHookBootLine\(PRIVATE_HOOK\)\)/)
  assert.match(server, /requirePrivateTurn\(privateTurns, PRIVATE_MARKER_PATHS, USER_ID\)/)
  const catchAt = server.indexOf('PRIVATE_HOOK_MISSING_REFUSAL', server.indexOf('requirePrivateTurn(privateTurns'))
  assert.ok(catchAt > 0, 'the missing hook text is used where the call is refused')
  const around = server.slice(catchAt - 200, catchAt + 300)
  assert.match(around, /isError: true/)
})
