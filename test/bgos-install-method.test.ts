/**
 * bgos-install-method tests. Pure over injected fs hooks: every case supplies
 * `realpath`, `readFile` and `exists`, so a machine that happens to have hoai
 * installed can never change an answer here.
 *
 * The plugin runs from one of two installs and the Claude Code channel flag
 * differs per install: a marketplace install (files under
 * <configDir>/plugins/...) must launch with plugin:hoai@<marketplace>, a local
 * clone with server:bgos. Both wrong answers are SILENT, which is why this
 * suite pins the whole evidence chain: the config-dir resolution
 * (CLAUDE_CONFIG_DIR override), the segment-based plugins-dir membership test
 * (mixed separators, win32 case folding, the .claude/pluginsX prefix
 * collision), the CLAUDE_PLUGIN_ROOT authority order, the realpath hook for
 * symlinked shims, the bin/ walk-up that yields the plugin root, and the exact
 * launch command strings.
 *
 * Since 2026-08-24 it also pins the third answer, 'unknown'. An npx / bunx /
 * dlx unpack directory is where the code RUNS, not what the machine has
 * installed, and reading it as "not the plugins dir, therefore a clone" handed
 * a real marketplace user server:bgos and a permanently deaf agent. The npx
 * fixtures below are modelled on that user's own doctor output, not invented.
 *
 * Run: npm test (node --test) or node --test test/bgos-install-method.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MARKETPLACE_CHANNEL_SPEC,
  CLONE_CHANNEL_SPEC,
  DEFAULT_HOAI_MARKETPLACE,
  HOAI_PLUGIN_NAME,
  claudeConfigDir,
  isUnderPluginsDir,
  isEphemeralExecutionRoot,
  detectInstallMethod,
  marketplaceChannelSpec,
  readInstalledHoaiPlugins,
  pluginRootFromScriptPath,
  parsePath,
  launchCommand,
  launchCommandFor,
  launchFlagArgs,
  describeDetection,
  isRunAsMain,
} from '../bin/bgos-install-method.mjs'

const WIN_HOME = 'C:\\Users\\x'
const POSIX_HOME = '/home/kc'
/** Identity realpath so tests never touch the real filesystem. */
const identity = (p: string) => p
/** No config dir on disk: every fs probe answers "nothing there". Detection
 *  must never reach the REAL filesystem from a unit test, or a machine that
 *  happens to have hoai installed would change the answer. */
const noFiles = { readFile: () => '', exists: () => false }
/** The three load-bearing fields, so the diagnostic ones (executionRoot,
 *  evidence, reason, marketplace, ephemeralExecution) can grow without every
 *  assertion in this file turning into a shape test. */
const verdict = (result: {
  method: string
  channelSpec: string
  pluginRoot: string
}) => ({ method: result.method, channelSpec: result.channelSpec, pluginRoot: result.pluginRoot })

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
  assert.deepEqual(verdict(result), {
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
  assert.deepEqual(verdict(result), {
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
  assert.deepEqual(verdict(posix), {
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
  assert.deepEqual(verdict(win), {
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
  assert.deepEqual(verdict(result), {
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
  assert.deepEqual(verdict(result), {
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
  assert.deepEqual(verdict(result), {
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

// ── The npx execution root (2026-08-24) ──────────────────────────────────────
//
// A real user ran `npx -y --package github:BrandGrowthOS/bgos-claude-plugin
// hoai doctor` and got two contradicting lines out of one run:
//   PASS Install method  clone install, channel server:bgos,
//        root /Users/alex/.npm/_npx/c00bcfc5e22688dd/node_modules/claude-channel-bgos
//   PASS claude mcp list plugin:hoai:bgos: bun
//        /Users/alex/.claude/plugins/cache/hoai-latest/hoai/0.34.3/server.ts - Connected
// His install is a marketplace one. Detection had concluded "clone" from where
// the code was EXECUTING, and on a marketplace install the clone spec connects
// nothing and drops every message with no error anywhere.
//
// Both fixtures below are modelled on those two real paths, not invented.

/** The exact shape npm unpacks `npx --package <git repo>` into. */
const NPX_SCRIPT =
  '/Users/alex/.npm/_npx/c00bcfc5e22688dd/node_modules/claude-channel-bgos/bin/bgos-install-method.mjs'
const ALEX_HOME = '/Users/alex'
/** The marketplace install that same machine really has, from `claude mcp list`. */
const ALEX_INSTALL_PATH = '/Users/alex/.claude/plugins/cache/hoai-latest/hoai/0.34.3'
/** installed_plugins.json as Claude Code 2.x writes it (version 2, array per
 *  id, user scope), matching a real file read off this machine. */
const alexInstalledPlugins = JSON.stringify({
  version: 2,
  plugins: {
    'hoai@hoai-latest': [
      {
        scope: 'user',
        installPath: ALEX_INSTALL_PATH,
        version: '0.34.3',
        installedAt: '2026-07-30T09:12:04.115Z',
        lastUpdated: '2026-08-13T04:00:41.900Z',
      },
    ],
  },
})

/** An fs whose only readable file is installed_plugins.json for `home`. */
function installedPluginsFs(home: string, text: string) {
  const path = `${home}/.claude/plugins/installed_plugins.json`
  return {
    exists: (p: string) => p === path,
    readFile: (p: string) => (p === path ? text : ''),
  }
}

test('isEphemeralExecutionRoot: the real npx shape, and the other package runners', () => {
  assert.equal(isEphemeralExecutionRoot(NPX_SCRIPT), true)
  // Windows npm cache spelling of the same thing.
  assert.equal(
    isEphemeralExecutionRoot(
      'C:\\Users\\alex\\AppData\\Local\\npm-cache\\_npx\\c00bcfc5\\node_modules\\claude-channel-bgos',
    ),
    true,
  )
  // bun, yarn, pnpm.
  assert.equal(
    isEphemeralExecutionRoot('/private/tmp/bunx-501-claude-channel-bgos@0.38.3/node_modules/claude-channel-bgos'),
    true,
  )
  assert.equal(
    isEphemeralExecutionRoot('/private/var/folders/ab/xfs-9c1/dlx-40412/node_modules/claude-channel-bgos'),
    true,
  )
  assert.equal(
    isEphemeralExecutionRoot('/Users/alex/Library/Caches/pnpm/dlx/9f1c/node_modules/claude-channel-bgos'),
    true,
  )
  // Any node_modules tree under a temp root, for the runners not named above.
  assert.equal(
    isEphemeralExecutionRoot('/private/tmp/some-runner-xyz/node_modules/claude-channel-bgos', {
      tempRoots: ['/private/tmp'],
    }),
    true,
  )
})

test('isEphemeralExecutionRoot: persistent installs are NOT ephemeral, in either direction', () => {
  // The Mac fleet: a plain checkout. This is the population that must not break.
  assert.equal(isEphemeralExecutionRoot('/Users/fitecho/bgos-claude-plugin/bin/bgos-install-method.mjs'), false)
  // A marketplace install.
  assert.equal(isEphemeralExecutionRoot(`${ALEX_INSTALL_PATH}/bin/bgos-install-method.mjs`), false)
  // A global npm install is a persistent directory a user chose, node_modules
  // or not, and keeps detecting exactly as it does today.
  assert.equal(isEphemeralExecutionRoot('/usr/local/lib/node_modules/claude-channel-bgos/bin/x.mjs'), false)
  // A checkout that merely happens to live in /tmp is still a checkout: the
  // temp rule only fires inside a node_modules tree.
  assert.equal(
    isEphemeralExecutionRoot('/private/tmp/scratch/bgos-claude-plugin/bin/x.mjs', { tempRoots: ['/private/tmp'] }),
    false,
  )
  assert.equal(isEphemeralExecutionRoot(''), false)
})

test('detectInstallMethod: an npx root with a marketplace install on disk detects MARKETPLACE, with the real marketplace name', () => {
  const result = detectInstallMethod({
    scriptPath: NPX_SCRIPT,
    env: {},
    home: ALEX_HOME,
    realpath: identity,
    ...installedPluginsFs(ALEX_HOME, alexInstalledPlugins),
  })
  assert.equal(result.method, 'marketplace')
  // The machine's OWN marketplace name, read off installed_plugins.json. The
  // hardcoded plugin:hoai@hoai would be just as silently deaf on this machine.
  assert.equal(result.channelSpec, 'plugin:hoai@hoai-latest')
  assert.equal(result.marketplace, 'hoai-latest')
  assert.equal(result.pluginRoot, ALEX_INSTALL_PATH)
  assert.equal(result.evidence, 'installed-plugins')
  // The npx dir is still reported as where the code ran, it is just not the
  // verdict any more.
  assert.equal(result.ephemeralExecution, true)
  assert.equal(result.executionRoot, '/Users/alex/.npm/_npx/c00bcfc5e22688dd/node_modules/claude-channel-bgos')
  assert.equal(result.reason, '')
})

test('detectInstallMethod: an npx root with NOTHING installed is UNDETERMINED, never a guessed clone', () => {
  const result = detectInstallMethod({
    scriptPath: NPX_SCRIPT,
    env: {},
    home: ALEX_HOME,
    realpath: identity,
    ...noFiles,
  })
  assert.equal(result.method, 'unknown')
  assert.equal(result.channelSpec, '', 'an undetermined install must carry NO spec')
  assert.equal(result.pluginRoot, '')
  assert.equal(result.evidence, 'none')
  assert.match(result.reason, /temporary package-runner directory/)
  assert.match(result.reason, /installed_plugins\.json/)
  // The whole point: the old code answered 'clone' here.
  assert.notEqual(result.method, 'clone')
})

test('detectInstallMethod: an npx root with TWO HOAI plugins installed is UNDETERMINED and names both', () => {
  const two = JSON.stringify({
    version: 2,
    plugins: {
      'hoai@hoai': [{ scope: 'user', installPath: `${ALEX_HOME}/.claude/plugins/cache/hoai/hoai/0.38.3`, version: '0.38.3' }],
      'hoai@hoai-latest': [{ scope: 'user', installPath: ALEX_INSTALL_PATH, version: '0.34.3' }],
    },
  })
  const result = detectInstallMethod({
    scriptPath: NPX_SCRIPT,
    env: {},
    home: ALEX_HOME,
    realpath: identity,
    ...installedPluginsFs(ALEX_HOME, two),
  })
  assert.equal(result.method, 'unknown')
  assert.equal(result.channelSpec, '')
  assert.match(result.reason, /hoai@hoai, hoai@hoai-latest/)
})

test('detectInstallMethod: a genuine clone checkout still detects as clone even with a marketplace install ALSO on disk', () => {
  // The Mac fleet case, and the one that must not regress: the user ran the
  // checkout's own hoai, so the checkout is what they meant, whatever else the
  // machine happens to have installed.
  const result = detectInstallMethod({
    scriptPath: '/Users/fitecho/bgos-claude-plugin/bin/bgos-install-method.mjs',
    env: {},
    home: '/Users/fitecho',
    realpath: identity,
    ...installedPluginsFs('/Users/fitecho', alexInstalledPlugins),
  })
  assert.equal(result.method, 'clone')
  assert.equal(result.channelSpec, CLONE_CHANNEL_SPEC)
  assert.equal(result.pluginRoot, '/Users/fitecho/bgos-claude-plugin')
  assert.equal(result.evidence, 'script-path')
  assert.equal(result.ephemeralExecution, false)
})

test('detectInstallMethod: a marketplace install running IN PLACE reads its marketplace name off its own path', () => {
  const result = detectInstallMethod({
    scriptPath: `${ALEX_INSTALL_PATH}/bin/bgos-install-method.mjs`,
    env: {},
    home: ALEX_HOME,
    realpath: identity,
    ...noFiles,
  })
  assert.equal(result.method, 'marketplace')
  assert.equal(result.channelSpec, 'plugin:hoai@hoai-latest')
  assert.equal(result.evidence, 'script-path')
  // The marketplaces layout carries the name in the same position.
  const other = detectInstallMethod({
    scriptPath: '/Users/alex/.claude/plugins/marketplaces/hoai/plugins/hoai/bin/bgos-install-method.mjs',
    env: {},
    home: ALEX_HOME,
    realpath: identity,
    ...noFiles,
  })
  assert.equal(other.channelSpec, 'plugin:hoai@hoai')
})

test('detectInstallMethod: an EMPTY or relative script path is no evidence, not a clone', () => {
  for (const scriptPath of ['', 'bgos-install-method.mjs', './bin/bgos-install-method.mjs']) {
    const result = detectInstallMethod({ scriptPath, env: {}, home: ALEX_HOME, realpath: identity, ...noFiles })
    assert.equal(result.method, 'unknown', `${scriptPath || '<empty>'} must not be read as a clone`)
    assert.equal(result.channelSpec, '')
  }
  // With an install on disk, the same nowhere-path resolves positively.
  const resolved = detectInstallMethod({
    scriptPath: '',
    env: {},
    home: ALEX_HOME,
    realpath: identity,
    ...installedPluginsFs(ALEX_HOME, alexInstalledPlugins),
  })
  assert.equal(resolved.method, 'marketplace')
  assert.equal(resolved.channelSpec, 'plugin:hoai@hoai-latest')
})

test('detectInstallMethod: CLAUDE_PLUGIN_ROOT pointing INTO an npx dir is not treated as an install either', () => {
  const result = detectInstallMethod({
    scriptPath: NPX_SCRIPT,
    env: { CLAUDE_PLUGIN_ROOT: '/Users/alex/.npm/_npx/c00bcfc5e22688dd/node_modules/claude-channel-bgos' },
    home: ALEX_HOME,
    realpath: identity,
    ...installedPluginsFs(ALEX_HOME, alexInstalledPlugins),
  })
  assert.equal(result.method, 'marketplace')
  assert.equal(result.channelSpec, 'plugin:hoai@hoai-latest')
})

test('readInstalledHoaiPlugins: real v2 shape, the legacy object shape, and every unreadable case', () => {
  assert.deepEqual(
    readInstalledHoaiPlugins({
      configDir: `${ALEX_HOME}/.claude`,
      ...installedPluginsFs(ALEX_HOME, alexInstalledPlugins),
    }),
    [{ id: 'hoai@hoai-latest', marketplace: 'hoai-latest', version: '0.34.3', installPath: ALEX_INSTALL_PATH }],
  )
  // Older single-object-per-id shape.
  const legacy = JSON.stringify({
    plugins: { 'hoai@hoai': { installPath: '/p', version: '0.30.0' } },
  })
  assert.deepEqual(readInstalledHoaiPlugins({ configDir: `${ALEX_HOME}/.claude`, ...installedPluginsFs(ALEX_HOME, legacy) }), [
    { id: 'hoai@hoai', marketplace: 'hoai', version: '0.30.0', installPath: '/p' },
  ])
  // Other people's plugins are not ours.
  const others = JSON.stringify({
    version: 2,
    plugins: { 'telegram@claude-plugins-official': [{ scope: 'user', installPath: '/t', version: '0.0.7' }] },
  })
  assert.deepEqual(readInstalledHoaiPlugins({ configDir: `${ALEX_HOME}/.claude`, ...installedPluginsFs(ALEX_HOME, others) }), [])
  // Missing, unparseable, wrong-shaped, and throwing all read as "nothing".
  assert.deepEqual(readInstalledHoaiPlugins({ configDir: `${ALEX_HOME}/.claude`, ...noFiles }), [])
  assert.deepEqual(
    readInstalledHoaiPlugins({ configDir: `${ALEX_HOME}/.claude`, ...installedPluginsFs(ALEX_HOME, '{ not json') }),
    [],
  )
  assert.deepEqual(
    readInstalledHoaiPlugins({ configDir: `${ALEX_HOME}/.claude`, ...installedPluginsFs(ALEX_HOME, '{"plugins":[]}') }),
    [],
  )
  assert.deepEqual(
    readInstalledHoaiPlugins({
      configDir: `${ALEX_HOME}/.claude`,
      exists: () => true,
      readFile: () => {
        throw new Error('EACCES')
      },
    }),
    [],
  )
})

test('marketplaceChannelSpec: the machine name travels, the default fills a blank', () => {
  assert.equal(marketplaceChannelSpec('hoai-latest'), 'plugin:hoai@hoai-latest')
  assert.equal(marketplaceChannelSpec(''), MARKETPLACE_CHANNEL_SPEC)
  assert.equal(marketplaceChannelSpec(undefined), MARKETPLACE_CHANNEL_SPEC)
})

test('launchFlagArgs THROWS on an undetermined method instead of spelling a plausible flag', () => {
  assert.throws(() => launchFlagArgs('unknown' as never), /undetermined/)
  // The known methods are untouched.
  assert.deepEqual(launchFlagArgs('clone'), ['--dangerously-load-development-channels', 'server:bgos'])
})

test('launchCommandFor: uses the resolved spec, and gives NO command for an undetermined install', () => {
  assert.equal(
    launchCommandFor({ method: 'marketplace', channelSpec: 'plugin:hoai@hoai-latest' }),
    'claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:hoai@hoai-latest',
  )
  assert.equal(launchCommandFor({ method: 'unknown', channelSpec: '' }), '')
  assert.equal(launchCommandFor({ method: 'clone', channelSpec: '' }), '')
})

test('describeDetection: an undetermined install says UNDETERMINED and carries the reason, with no command', () => {
  const line = describeDetection({ method: 'unknown', channelSpec: '', pluginRoot: '', reason: 'no install recorded.' })
  assert.match(line, /UNDETERMINED/)
  assert.match(line, /no install recorded\./)
  assert.doesNotMatch(line, /--dangerously-load-development-channels/)
  assert.doesNotMatch(line, /server:bgos/)
})

test('drift guard: the plugin identity constants agree with lib/plugin-cli', async () => {
  // plugin-cli imports FROM this module, so the constants cannot be shared by
  // import without a cycle. They are pinned against each other instead.
  const cli = await import('../lib/plugin-cli.mjs')
  assert.equal(cli.HOAI_PLUGIN_NAME, HOAI_PLUGIN_NAME)
  assert.equal(cli.HOAI_MARKETPLACE, DEFAULT_HOAI_MARKETPLACE)
  assert.equal(cli.HOAI_PLUGIN_ID, `${HOAI_PLUGIN_NAME}@${DEFAULT_HOAI_MARKETPLACE}`)
  assert.equal(MARKETPLACE_CHANNEL_SPEC, `plugin:${cli.HOAI_PLUGIN_ID}`)
})

test('no em or en dashes in any message this module produces', () => {
  const undetermined = detectInstallMethod({
    scriptPath: NPX_SCRIPT,
    env: {},
    home: ALEX_HOME,
    realpath: identity,
    ...noFiles,
  })
  const texts = [
    undetermined.reason,
    describeDetection(undetermined),
    describeDetection({ method: 'clone', pluginRoot: '/p', channelSpec: CLONE_CHANNEL_SPEC }),
  ]
  for (const text of texts) assert.doesNotMatch(text, /[\u2013\u2014]/, text)
})
