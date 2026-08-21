/**
 * bgos-install-method tests (pure detection, no fs beyond the default
 * realpath fallback).
 *
 * The plugin runs from one of two installs, and the Claude Code channel flag
 * differs per install: a marketplace install (files under
 * <configDir>/plugins/...) must launch with plugin:hoai@hoai, a local clone
 * with server:bgos. On 2026-08-21 a marketplace install launched with
 * server:bgos dropped every inbound message silently, so this suite pins the
 * whole evidence chain: the config-dir resolution (CLAUDE_CONFIG_DIR
 * override), the segment-based plugins-dir membership test (mixed separators,
 * win32 case folding, the .claude/pluginsX prefix collision), the
 * CLAUDE_PLUGIN_ROOT authority order, the realpath hook for symlinked shims,
 * the bin/ walk-up that yields the plugin root, and the exact launch command
 * strings.
 *
 * Run: npm test (node --test) or node --test test/bgos-install-method.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MARKETPLACE_CHANNEL_SPEC,
  CLONE_CHANNEL_SPEC,
  claudeConfigDir,
  isUnderPluginsDir,
  detectInstallMethod,
  pluginRootFromScriptPath,
  parsePath,
  launchCommand,
  describeDetection,
  isRunAsMain,
} from '../bin/bgos-install-method.mjs'

const WIN_HOME = 'C:\\Users\\x'
const POSIX_HOME = '/home/kc'
/** Identity realpath so tests never touch the real filesystem. */
const identity = (p: string) => p

test('channel spec constants are the two known launch targets', () => {
  assert.equal(MARKETPLACE_CHANNEL_SPEC, 'plugin:hoai@hoai')
  assert.equal(CLONE_CHANNEL_SPEC, 'server:bgos')
})

test('claudeConfigDir: CLAUDE_CONFIG_DIR (trimmed) wins, else <home>/.claude in the home path style', () => {
  assert.equal(
    claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '  D:\\claude-config  ' }, home: WIN_HOME }),
    'D:\\claude-config',
  )
  // Empty / whitespace override falls through to the default.
  assert.equal(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '   ' }, home: WIN_HOME }), 'C:\\Users\\x\\.claude')
  assert.equal(claudeConfigDir({ env: {}, home: WIN_HOME }), 'C:\\Users\\x\\.claude')
  assert.equal(claudeConfigDir({ env: {}, home: POSIX_HOME }), '/home/kc/.claude')
  // A trailing separator on home does not double up.
  assert.equal(claudeConfigDir({ env: {}, home: 'C:\\Users\\x\\' }), 'C:\\Users\\x\\.claude')
  assert.equal(claudeConfigDir({ env: {}, home: '/home/kc/' }), '/home/kc/.claude')
})

test('isUnderPluginsDir: true for both marketplace layouts, in either separator style', () => {
  assert.equal(
    isUnderPluginsDir('C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.37.0', {
      env: {},
      home: WIN_HOME,
    }),
    true,
  )
  assert.equal(
    isUnderPluginsDir('/home/kc/.claude/plugins/marketplaces/hoai/plugins/hoai', {
      env: {},
      home: POSIX_HOME,
    }),
    true,
  )
  // Mixed separators in the same path still match a win32 home.
  assert.equal(
    isUnderPluginsDir('C:/Users/x/.claude/plugins/cache/hoai/hoai/0.37.0', { env: {}, home: WIN_HOME }),
    true,
  )
})

test('isUnderPluginsDir: case insensitive for win32 style paths', () => {
  assert.equal(
    isUnderPluginsDir('c:\\users\\X\\.CLAUDE\\Plugins\\Cache\\hoai\\hoai\\0.37.0', {
      env: {},
      home: WIN_HOME,
    }),
    true,
  )
})

test('isUnderPluginsDir: the prefix collision .claude/pluginsX never matches', () => {
  assert.equal(
    isUnderPluginsDir('C:\\Users\\x\\.claude\\pluginsX\\cache\\hoai\\hoai\\0.37.0', {
      env: {},
      home: WIN_HOME,
    }),
    false,
  )
  assert.equal(
    isUnderPluginsDir('/home/kc/.claude/pluginsX/cache/hoai', { env: {}, home: POSIX_HOME }),
    false,
  )
})

test('isUnderPluginsDir: the plugins dir itself, unrelated paths, and cross-root paths do not count', () => {
  // The plugins dir itself is not "under" the plugins dir.
  assert.equal(isUnderPluginsDir('C:\\Users\\x\\.claude\\plugins', { env: {}, home: WIN_HOME }), false)
  assert.equal(isUnderPluginsDir('C:\\Users\\x\\bgos-claude-plugin', { env: {}, home: WIN_HOME }), false)
  // A posix path can never sit under a win32 config dir (different roots).
  assert.equal(
    isUnderPluginsDir('/home/kc/.claude/plugins/cache/hoai', { env: {}, home: WIN_HOME }),
    false,
  )
  assert.equal(isUnderPluginsDir('', { env: {}, home: WIN_HOME }), false)
})

test('isUnderPluginsDir: CLAUDE_CONFIG_DIR override moves the plugins dir', () => {
  const env = { CLAUDE_CONFIG_DIR: 'D:\\claude-config' }
  assert.equal(
    isUnderPluginsDir('D:\\claude-config\\plugins\\cache\\hoai\\hoai\\1.0.0', { env, home: WIN_HOME }),
    true,
  )
  // With the override in force, the default-home plugins dir no longer counts.
  assert.equal(
    isUnderPluginsDir('C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\1.0.0', { env, home: WIN_HOME }),
    false,
  )
})

test('detectInstallMethod: cache layout (win32) is a marketplace install with the version dir as root', () => {
  const result = detectInstallMethod({
    scriptPath: 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.37.0\\bin\\bgos-install-method.mjs',
    env: {},
    home: WIN_HOME,
    realpath: identity,
  })
  assert.deepEqual(result, {
    method: 'marketplace',
    channelSpec: MARKETPLACE_CHANNEL_SPEC,
    pluginRoot: 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.37.0',
  })
})

test('detectInstallMethod: marketplaces layout (posix) is a marketplace install with the plugin dir as root', () => {
  const result = detectInstallMethod({
    scriptPath: '/home/kc/.claude/plugins/marketplaces/hoai/plugins/hoai/bin/bgos-install-method.mjs',
    env: {},
    home: POSIX_HOME,
    realpath: identity,
  })
  assert.deepEqual(result, {
    method: 'marketplace',
    channelSpec: MARKETPLACE_CHANNEL_SPEC,
    pluginRoot: '/home/kc/.claude/plugins/marketplaces/hoai/plugins/hoai',
  })
})

test('detectInstallMethod: a local clone is a clone install, both path styles', () => {
  const posix = detectInstallMethod({
    scriptPath: '/home/kc/bgos-claude-plugin/bin/bgos-install-method.mjs',
    env: {},
    home: POSIX_HOME,
    realpath: identity,
  })
  assert.deepEqual(posix, {
    method: 'clone',
    channelSpec: CLONE_CHANNEL_SPEC,
    pluginRoot: '/home/kc/bgos-claude-plugin',
  })

  const win = detectInstallMethod({
    scriptPath: 'C:\\Users\\x\\bgos-claude-plugin\\bin\\bgos-install-method.mjs',
    env: {},
    home: WIN_HOME,
    realpath: identity,
  })
  assert.deepEqual(win, {
    method: 'clone',
    channelSpec: CLONE_CHANNEL_SPEC,
    pluginRoot: 'C:\\Users\\x\\bgos-claude-plugin',
  })
})

test('detectInstallMethod: CLAUDE_PLUGIN_ROOT under the plugins dir wins over a clone-looking scriptPath', () => {
  const env = { CLAUDE_PLUGIN_ROOT: 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.37.0' }
  const result = detectInstallMethod({
    scriptPath: 'C:\\Users\\x\\bgos-claude-plugin\\bin\\bgos-install-method.mjs',
    env,
    home: WIN_HOME,
    realpath: identity,
  })
  assert.deepEqual(result, {
    method: 'marketplace',
    channelSpec: MARKETPLACE_CHANNEL_SPEC,
    pluginRoot: 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.37.0',
  })
})

test('detectInstallMethod: CLAUDE_PLUGIN_ROOT outside the plugins dir means clone with that root', () => {
  const env = { CLAUDE_PLUGIN_ROOT: '/home/kc/bgos-claude-plugin' }
  const result = detectInstallMethod({
    // Even a marketplace-looking scriptPath does not override the env root.
    scriptPath: '/home/kc/.claude/plugins/cache/hoai/hoai/0.37.0/bin/bgos-install-method.mjs',
    env,
    home: POSIX_HOME,
    realpath: identity,
  })
  assert.deepEqual(result, {
    method: 'clone',
    channelSpec: CLONE_CHANNEL_SPEC,
    pluginRoot: '/home/kc/bgos-claude-plugin',
  })
})

test('detectInstallMethod: CLAUDE_CONFIG_DIR override decides where the plugins dir is', () => {
  const scriptPath = 'D:\\claude-config\\plugins\\cache\\hoai\\hoai\\1.0.0\\bin\\bgos-install-method.mjs'
  const withOverride = detectInstallMethod({
    scriptPath,
    env: { CLAUDE_CONFIG_DIR: 'D:\\claude-config' },
    home: WIN_HOME,
    realpath: identity,
  })
  assert.equal(withOverride.method, 'marketplace')
  assert.equal(withOverride.pluginRoot, 'D:\\claude-config\\plugins\\cache\\hoai\\hoai\\1.0.0')
  // The same path with no override sits outside <home>/.claude/plugins: clone.
  const withoutOverride = detectInstallMethod({
    scriptPath,
    env: {},
    home: WIN_HOME,
    realpath: identity,
  })
  assert.equal(withoutOverride.method, 'clone')
})

test('detectInstallMethod: the .claude/pluginsX prefix collision detects as clone', () => {
  const result = detectInstallMethod({
    scriptPath: 'C:\\Users\\x\\.claude\\pluginsX\\cache\\hoai\\hoai\\1.0.0\\bin\\bgos-install-method.mjs',
    env: {},
    home: WIN_HOME,
    realpath: identity,
  })
  assert.equal(result.method, 'clone')
  assert.equal(result.channelSpec, CLONE_CHANNEL_SPEC)
  assert.equal(result.pluginRoot, 'C:\\Users\\x\\.claude\\pluginsX\\cache\\hoai\\hoai\\1.0.0')
})

test('detectInstallMethod: realpath resolves a symlinked shim into the plugins dir', () => {
  const target = '/home/kc/.claude/plugins/cache/hoai/hoai/0.37.0/bin/bgos-install-method.mjs'
  const result = detectInstallMethod({
    scriptPath: '/usr/local/bin/bgos-install-method.mjs',
    env: {},
    home: POSIX_HOME,
    realpath: () => target,
  })
  assert.deepEqual(result, {
    method: 'marketplace',
    channelSpec: MARKETPLACE_CHANNEL_SPEC,
    pluginRoot: '/home/kc/.claude/plugins/cache/hoai/hoai/0.37.0',
  })
})

test('detectInstallMethod: default realpath falls back to the raw path when it does not exist, and a throwing injected realpath does too', () => {
  // No realpath injected: the default realpathSync throws on this fake path
  // and the raw path must still detect correctly.
  const viaDefault = detectInstallMethod({
    scriptPath: 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\9.9.9\\bin\\bgos-install-method.mjs',
    env: {},
    home: WIN_HOME,
  })
  assert.equal(viaDefault.method, 'marketplace')
  assert.equal(viaDefault.pluginRoot, 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\9.9.9')

  const viaThrow = detectInstallMethod({
    scriptPath: '/home/kc/bgos-claude-plugin/bin/bgos-install-method.mjs',
    env: {},
    home: POSIX_HOME,
    realpath: () => {
      throw new Error('boom')
    },
  })
  assert.equal(viaThrow.method, 'clone')
  assert.equal(viaThrow.pluginRoot, '/home/kc/bgos-claude-plugin')
})

test('pluginRootFromScriptPath: walks up to the directory containing the LAST bin/ before the file', () => {
  // A nested file below bin/ still resolves the same root.
  assert.equal(
    pluginRootFromScriptPath('/home/kc/.claude/plugins/cache/hoai/hoai/0.37.0/bin/nested/tool.mjs'),
    '/home/kc/.claude/plugins/cache/hoai/hoai/0.37.0',
  )
  // A bin/ higher in the tree does not hijack the walk: the last one wins.
  assert.equal(
    pluginRootFromScriptPath('/opt/bin/checkouts/bgos-claude-plugin/bin/bgos-install-method.mjs'),
    '/opt/bin/checkouts/bgos-claude-plugin',
  )
  // No bin/ ancestor: the containing directory is the root.
  assert.equal(pluginRootFromScriptPath('/home/kc/tools/detect.mjs'), '/home/kc/tools')
  // Dot segments are resolved before the walk.
  assert.equal(
    pluginRootFromScriptPath('C:\\Users\\x\\repo\\.\\bin\\..\\bin\\detect.mjs'),
    'C:\\Users\\x\\repo',
  )
})

test('parsePath keeps the root and separator style of the input', () => {
  assert.deepEqual(parsePath('C:\\Users\\x\\bin\\a.mjs'), {
    prefix: 'C:\\',
    sep: '\\',
    segments: ['Users', 'x', 'bin', 'a.mjs'],
  })
  assert.deepEqual(parsePath('/home/kc/bin/a.mjs'), {
    prefix: '/',
    sep: '/',
    segments: ['home', 'kc', 'bin', 'a.mjs'],
  })
})

test('launchCommand: the exact strings, one per install method', () => {
  assert.equal(
    launchCommand('marketplace'),
    'claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:hoai@hoai',
  )
  assert.equal(
    launchCommand('clone'),
    'claude --dangerously-skip-permissions --dangerously-load-development-channels server:bgos',
  )
})

test('describeDetection: one line carrying method, root, and the paste-ready command', () => {
  assert.equal(
    describeDetection({ method: 'marketplace', pluginRoot: 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.37.0' }),
    'install method: marketplace (plugin root C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.37.0), ' +
      'launch with: claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:hoai@hoai',
  )
  assert.equal(
    describeDetection({ method: 'clone', pluginRoot: '/home/kc/bgos-claude-plugin' }),
    'install method: clone (plugin root /home/kc/bgos-claude-plugin), ' +
      'launch with: claude --dangerously-skip-permissions --dangerously-load-development-channels server:bgos',
  )
})

test('isRunAsMain is false when imported by the test runner', () => {
  assert.equal(isRunAsMain(), false)
})
