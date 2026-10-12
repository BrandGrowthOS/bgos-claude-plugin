/**
 * lib/clone-hooks.mjs and bin/hoai-register-hooks.mjs (board bbbf3438 follow-up).
 *
 * A daemon that updates itself, or that boots without the private turn hook, registers the hooks of its CLONE
 * workspace itself: the CLI reads them once at launch and `bgos-agent update` was the only writer. These run the
 * real functions and the real CLI on temp workspaces.
 *
 * Run: npx tsx --test test/clone-hooks.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { registerCloneHooks, workspaceNamesThisClone } from '../lib/clone-hooks.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function workspace(serverTs: string | null, settings?: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-ws-')))
  if (serverTs) writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [serverTs] } } }))
  if (settings) {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(settings))
  }
  return dir
}
const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))
const text = (value: unknown) => JSON.stringify(value)
const aliasOf = (target: string) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-alias-')))
  const alias = join(scratch, 'alias')
  symlinkSync(target, alias)
  return alias
}

test('a clone workspace that names this checkout is recognised, through an alias too', () => {
  const direct = workspace(join(repoRoot, 'server.ts'))
  const viaAlias = workspace(join(aliasOf(repoRoot), 'server.ts'))
  assert.equal(workspaceNamesThisClone({ workdir: direct, pluginDir: repoRoot }), true)
  assert.equal(workspaceNamesThisClone({ workdir: viaAlias, pluginDir: repoRoot }), true)
})

test('another checkout, no .mcp.json and a junk .mcp.json are not clone workspaces', () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'clone-hooks-other-')))
  writeFileSync(join(other, 'server.ts'), '')
  assert.equal(workspaceNamesThisClone({ workdir: workspace(join(other, 'server.ts')), pluginDir: repoRoot }), false)
  assert.equal(workspaceNamesThisClone({ workdir: workspace(null), pluginDir: repoRoot }), false)
  const junk = workspace(null)
  writeFileSync(join(junk, '.mcp.json'), '{ not json')
  assert.equal(workspaceNamesThisClone({ workdir: junk, pluginDir: repoRoot }), false)
})

test('a clone workspace with no hoai entry gets the rail and the private turn hook, and NOT the floor hook', () => {
  const dir = workspace(join(repoRoot, 'server.ts'), {
    hooks: { PreToolUse: [{ matcher: 'mcp__bgos__reply', hooks: [{ type: 'command', command: 'python3', args: ['/gate.py'] }] }] },
  })
  const result = registerCloneHooks({ workdir: dir, pluginDir: repoRoot })
  assert.equal(result.outcome, 'registered')
  const hooks = settingsOf(dir).hooks
  for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd', 'SubagentStart']) assert.match(text(hooks[event]), /hoai-private-turn-hook\.mjs/)
  assert.match(text(hooks.UserPromptSubmit), /hoai-hook\.mjs/)
  assert.doesNotMatch(text(hooks), /hoai-floor-hook\.mjs/)
  assert.match(text(hooks.PreToolUse), /gate\.py/, "the owner's own hook is kept")
})

test('a folder that already carries the rail keeps its floor hook, and a second run changes nothing', () => {
  const dir = workspace(join(repoRoot, 'server.ts'), {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: [join(repoRoot, 'bin', 'hoai-hook.mjs')], timeout: 3, async: true }] }] },
  })
  assert.equal(registerCloneHooks({ workdir: dir, pluginDir: repoRoot }).outcome, 'registered')
  assert.match(text(settingsOf(dir).hooks.PreToolUse), /hoai-floor-hook\.mjs/)
  const before = readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')
  assert.equal(registerCloneHooks({ workdir: dir, pluginDir: repoRoot }).outcome, 'already')
  assert.equal(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'), before)
})

test('a workspace that is not this checkout is left untouched', () => {
  const dir = workspace(null)
  assert.equal(registerCloneHooks({ workdir: dir, pluginDir: repoRoot }).outcome, 'not_clone')
  assert.equal(existsSync(join(dir, '.claude', 'settings.local.json')), false)
})

test('the registrar CLI writes the hooks when run by real path and through a symlinked checkout, one line per workdir', () => {
  for (const root of [repoRoot, aliasOf(repoRoot)]) {
    const dir = workspace(join(repoRoot, 'server.ts'))
    const none = workspace(null)
    const res = spawnSync(process.execPath, [join(root, 'bin', 'hoai-register-hooks.mjs'), '--plugin-dir', repoRoot, '--workdir', dir, '--workdir', none], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, new RegExp(`registered ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(res.stdout, /not_clone/)
    assert.match(text(settingsOf(dir).hooks.UserPromptSubmit), /hoai-private-turn-hook\.mjs/)
    assert.equal(existsSync(join(none, '.claude', 'settings.local.json')), false)
  }
})

test('the registrar CLI refuses a call with no workdir', () => {
  const res = spawnSync(process.execPath, [join(repoRoot, 'bin', 'hoai-register-hooks.mjs'), '--plugin-dir', repoRoot], { encoding: 'utf8' })
  assert.equal(res.status, 1)
})

test('the daemon registers at boot only when the hook is missing, and the self-updater runs the registrar before it asks for a restart', () => {
  const server = readFileSync(join(repoRoot, 'server.ts'), 'utf8')
  assert.match(server, /if \(!PRIVATE_HOOK\.registered && INSTALL_METHOD !== 'marketplace'\) \{/)
  assert.match(server, /registerCloneHooks\(\{ workdir: folder, pluginDir: import\.meta\.dir \}\)/)
  assert.match(server, /workspaceDirs: FLOOR_FOLDERS/)
  const updater = readFileSync(join(repoRoot, 'lib', 'self-update.ts'), 'utf8')
  const install = updater.indexOf('await this.registerWorkspaceHooks()')
  const triggered = updater.indexOf("if (mode === 'triggered') {", install)
  assert.ok(install > 0 && triggered > install, 'registration sits after the install and before the restart branches')
})
