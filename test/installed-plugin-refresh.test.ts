/**
 * One click Connect on a computer with an old hoai plugin (HOAI board row
 * 05893eed, finding A; the Helper production test on KC's MacBook,
 * 2026-11-12).
 *
 * The Connect script runs `claude plugin marketplace add` and then
 * `claude plugin install hoai@hoai`. On a computer that already had hoai
 * 0.31.0, the install answered "already installed" and left 0.31.0 in place,
 * so the doctor then started a plugin too old to have the launch shim and
 * the run failed at Verifying. The tester fixed it by hand with
 * `claude plugin marketplace update hoai` and `claude plugin update hoai@hoai`.
 *
 * Pairing runs the version the app expects (the npx package the Connect
 * script names), so pairing is where an older installed copy is brought up
 * to it. These tests pin that: an older install is updated with exactly those
 * two commands, an install at or past the expected version is left alone, and
 * a failure says what to run instead of passing silently.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compareVersions,
  refreshInstalledPlugin,
  refreshReportLines,
} from '../lib/installed-plugin-refresh.mjs'
import { main, PAIR_EXIT_CODES, PLUGIN_VERSION } from '../bin/bgos-pair.mjs'

type Call = string[]

/** An observation of the marketplace install, the shape observeMarketplaceInstall answers. */
function observed(version: string | null, present = true) {
  return {
    marketplaceRegistered: true,
    marketplaceInstallLocation: null,
    marketplaceLatest: null,
    installed: { present, version, installPath: present ? `/fake/cache/hoai/hoai/${version}` : null },
    enabled: true,
  }
}

/** A scripted claude CLI: every call is recorded, the answer comes from `script`. */
function fakeClaude(script: (args: string[]) => { code: number, stdout?: string, stderr?: string }) {
  const calls: Call[] = []
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args)
      const out = script(args)
      return { code: out.code, stdout: out.stdout ?? '', stderr: out.stderr ?? '', timedOut: false }
    },
  }
}

const MARKETPLACE_UPDATE = ['plugin', 'marketplace', 'update', 'hoai']
const PLUGIN_UPDATE = ['plugin', 'update', 'hoai@hoai', '--scope', 'user', '-y']

test('compareVersions orders strict semver and refuses anything else', () => {
  assert.equal(compareVersions('0.31.0', '0.87.5'), -1)
  assert.equal(compareVersions('0.87.5', '0.87.5'), 0)
  assert.equal(compareVersions('0.88.0', '0.87.5'), 1)
  assert.equal(compareVersions('0.87.10', '0.87.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('v0.87.5', '0.87.5'), 0)
  assert.equal(compareVersions(null, '0.87.5'), null)
  assert.equal(compareVersions('0.87', '0.87.5'), null)
  assert.equal(compareVersions('0.87.5-beta', '0.87.5'), null)
})

test('A: an installed plugin older than the expected one is updated, with exactly the two commands the tester ran by hand', async () => {
  let installed = '0.31.0'
  const claude = fakeClaude((args) => {
    if (args.join(' ') === MARKETPLACE_UPDATE.join(' ')) return { code: 0, stdout: 'Successfully updated marketplace: hoai' }
    if (args.join(' ') === PLUGIN_UPDATE.join(' ')) {
      installed = '0.87.5'
      return { code: 0, stdout: 'Plugin "hoai" updated from 0.31.0 to 0.87.5 for scope user. Restart to apply changes.' }
    }
    return { code: 1, stderr: `unexpected call: ${args.join(' ')}` }
  })
  const result = await refreshInstalledPlugin({
    expectedVersion: '0.87.5',
    observe: async () => observed(installed),
    runClaude: claude.run,
  })
  assert.deepEqual(claude.calls, [MARKETPLACE_UPDATE, PLUGIN_UPDATE])
  assert.equal(result.kind, 'updated')
  assert.equal(result.fromVersion, '0.31.0')
  assert.equal(result.toVersion, '0.87.5')
  const lines = refreshReportLines(result, '0.87.5').join('\n')
  assert.match(lines, /0\.31\.0/)
  assert.match(lines, /0\.87\.5/)
  assert.match(lines, /updated/i)
})

test('A: an install at the expected version, or newer, is left alone and runs no command', async () => {
  for (const version of ['0.87.5', '0.88.0']) {
    const claude = fakeClaude(() => ({ code: 1, stderr: 'must not run' }))
    const result = await refreshInstalledPlugin({
      expectedVersion: '0.87.5',
      observe: async () => observed(version),
      runClaude: claude.run,
    })
    assert.equal(result.kind, 'current', version)
    assert.deepEqual(claude.calls, [], version)
    assert.deepEqual(refreshReportLines(result, '0.87.5'), [], 'nothing to say about a current install')
  }
})

test('A: no marketplace install (a clone install, or none yet) runs no command', async () => {
  const claude = fakeClaude(() => ({ code: 1, stderr: 'must not run' }))
  const result = await refreshInstalledPlugin({
    expectedVersion: '0.87.5',
    observe: async () => observed(null, false),
    runClaude: claude.run,
  })
  assert.equal(result.kind, 'not_installed')
  assert.deepEqual(claude.calls, [])
})

test('A: an expected version that is not a version updates nothing', async () => {
  const claude = fakeClaude(() => ({ code: 1, stderr: 'must not run' }))
  const result = await refreshInstalledPlugin({
    expectedVersion: '0.0.0-dev',
    observe: async () => observed('0.31.0'),
    runClaude: claude.run,
  })
  assert.equal(result.kind, 'skipped')
  assert.deepEqual(claude.calls, [])
})

test('A: an install whose version cannot be read is treated as old and updated', async () => {
  let installed: string | null = null
  const claude = fakeClaude((args) => {
    if (args[1] === 'marketplace') return { code: 0, stdout: 'Successfully updated marketplace: hoai' }
    installed = '0.87.5'
    return { code: 0, stdout: 'Plugin "hoai" updated from unknown to 0.87.5 for scope user. Restart to apply changes.' }
  })
  const result = await refreshInstalledPlugin({
    expectedVersion: '0.87.5',
    observe: async () => observed(installed),
    runClaude: claude.run,
  })
  assert.deepEqual(claude.calls, [MARKETPLACE_UPDATE, PLUGIN_UPDATE])
  assert.equal(result.kind, 'updated')
  assert.equal(result.toVersion, '0.87.5')
})

test('A: a failed update is reported with the two commands to run, never as current', async () => {
  const claude = fakeClaude((args) => {
    if (args[1] === 'marketplace') return { code: 0, stdout: 'Successfully updated marketplace: hoai' }
    return { code: 1, stderr: 'Failed to update plugin "hoai@hoai": network unreachable' }
  })
  const result = await refreshInstalledPlugin({
    expectedVersion: '0.87.5',
    observe: async () => observed('0.31.0'),
    runClaude: claude.run,
  })
  assert.equal(result.kind, 'failed')
  assert.equal(result.fromVersion, '0.31.0')
  const lines = refreshReportLines(result, '0.87.5').join('\n')
  assert.match(lines, /network unreachable/)
  assert.match(lines, /claude plugin marketplace update hoai/)
  assert.match(lines, /claude plugin update hoai@hoai/)
})

test('A: a marketplace refresh that fails still tries the plugin update, and its failure is named', async () => {
  let installed = '0.31.0'
  const claude = fakeClaude((args) => {
    if (args[1] === 'marketplace') return { code: 1, stderr: 'could not reach github.com' }
    installed = '0.87.5'
    return { code: 0, stdout: 'Plugin "hoai" updated from 0.31.0 to 0.87.5 for scope user. Restart to apply changes.' }
  })
  const result = await refreshInstalledPlugin({
    expectedVersion: '0.87.5',
    observe: async () => observed(installed),
    runClaude: claude.run,
  })
  assert.deepEqual(claude.calls, [MARKETPLACE_UPDATE, PLUGIN_UPDATE])
  assert.equal(result.kind, 'updated')
})

test('A: when the marketplace has nothing newer, the answer says the install is the newest published one', async () => {
  const claude = fakeClaude((args) => {
    if (args[1] === 'marketplace') return { code: 0, stdout: 'Successfully updated marketplace: hoai' }
    return { code: 0, stdout: 'Plugin "hoai" is already at the latest version (0.86.0).' }
  })
  const result = await refreshInstalledPlugin({
    expectedVersion: '0.87.5',
    observe: async () => observed('0.86.0'),
    runClaude: claude.run,
  })
  assert.equal(result.kind, 'latest_published')
  assert.equal(result.fromVersion, '0.86.0')
  assert.match(refreshReportLines(result, '0.87.5').join('\n'), /newest published/)
})

// -- Through bgos-pair, in a fake HOME with a real installed_plugins.json ------

async function writeInstalled(configDir: string, version: string) {
  await mkdir(join(configDir, 'plugins'), { recursive: true })
  await writeFile(
    join(configDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'hoai@hoai': [{ scope: 'user', version, installPath: join(configDir, 'plugins', 'cache', 'hoai', 'hoai', version) }],
      },
    }),
  )
}

function pairFetch() {
  return async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/integrations/pair-exchange')) {
      return Response.json({ pairing_token: 'fresh_token', pairing_id: 284, user_id: 'user_kc' }, { status: 201 })
    }
    if (url.endsWith('/integrations/me')) {
      return Response.json({ assistants: [{ assistant_id: 1175, agent_route: 'claude', name: 'Helper Test Mac' }] })
    }
    return Response.json({})
  }
}

async function runPair(argv: string[], home: string, folder: string, claudeRunner: (args: string[]) => Promise<unknown>) {
  const output: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...values: unknown[]) => output.push(values.join(' '))
  console.error = (...values: unknown[]) => output.push(values.join(' '))
  try {
    const code = await main(argv, {
      env: {},
      home,
      cwd: folder,
      fetchImpl: pairFetch(),
      isInteractive: () => false,
      claudeRunner,
    })
    return { code, output: output.join('\n') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

test('A, end to end: hoai-pair on a computer with hoai 0.31.0 installed brings it up to the version it runs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oldconnect-a-'))
  try {
    const configDir = join(home, '.claude')
    const folder = join(home, '.bgos-agent', '1175-workspace')
    await mkdir(folder, { recursive: true })
    await writeInstalled(configDir, '0.31.0')
    const calls: string[][] = []
    const claudeRunner = async (args: string[]) => {
      calls.push(args)
      if (args[1] === 'marketplace') return { code: 0, stdout: 'Successfully updated marketplace: hoai' }
      if (args[1] === 'update') {
        await writeInstalled(configDir, PLUGIN_VERSION)
        return { code: 0, stdout: `Plugin "hoai" updated from 0.31.0 to ${PLUGIN_VERSION} for scope user. Restart to apply changes.` }
      }
      return { code: 1, stderr: 'unexpected' }
    }
    const { code, output } = await runPair(['BGOS-7F3A-2K', '--assistant-id', '1175', '--backend', 'https://pair.test'], home, folder, claudeRunner)
    assert.equal(code, PAIR_EXIT_CODES.DONE, output)
    assert.deepEqual(calls, [MARKETPLACE_UPDATE, PLUGIN_UPDATE])
    assert.match(output, new RegExp(`updated the installed hoai plugin from 0\\.31\\.0 to ${PLUGIN_VERSION.replace(/\./g, '\\.')}`))
    const after = JSON.parse(await readFile(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    assert.equal(after.plugins['hoai@hoai'][0].version, PLUGIN_VERSION)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('A, end to end: a current install is not touched, and --no-install-cli (a background caller) never runs claude', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oldconnect-a2-'))
  try {
    const configDir = join(home, '.claude')
    const folder = join(home, '.bgos-agent', '1175-workspace')
    await mkdir(folder, { recursive: true })
    await writeInstalled(configDir, PLUGIN_VERSION)
    const calls: string[][] = []
    const claudeRunner = async (args: string[]) => {
      calls.push(args)
      return { code: 1, stderr: 'must not run' }
    }
    const current = await runPair(['BGOS-7F3A-2K', '--assistant-id', '1175', '--backend', 'https://pair.test'], home, folder, claudeRunner)
    assert.equal(current.code, PAIR_EXIT_CODES.DONE, current.output)
    assert.deepEqual(calls, [])

    await writeInstalled(configDir, '0.31.0')
    const background = await runPair(
      ['BGOS-7F3A-2K', '--assistant-id', '1175', '--backend', 'https://pair.test', '--no-install-cli'],
      home,
      folder,
      claudeRunner,
    )
    assert.equal(background.code, PAIR_EXIT_CODES.DONE, background.output)
    assert.deepEqual(calls, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// Round 2 (Data, finding 2): the flag was parsed and read, and nothing failed
// when a caller passing it still got `claude plugin update`.
test('A, end to end: --no-plugin-update leaves an older install alone and runs no claude command', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oldconnect-a3-'))
  try {
    const configDir = join(home, '.claude')
    const folder = join(home, '.bgos-agent', '1175-workspace')
    await mkdir(folder, { recursive: true })
    await writeInstalled(configDir, '0.31.0')
    const calls: string[][] = []
    const claudeRunner = async (args: string[]) => {
      calls.push(args)
      return { code: 1, stderr: 'must not run' }
    }
    const { code, output } = await runPair(
      ['BGOS-7F3A-2K', '--assistant-id', '1175', '--backend', 'https://pair.test', '--no-plugin-update'],
      home,
      folder,
      claudeRunner,
    )
    assert.equal(code, PAIR_EXIT_CODES.DONE, output)
    assert.deepEqual(calls, [])
    const after = JSON.parse(await readFile(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    assert.equal(after.plugins['hoai@hoai'][0].version, '0.31.0')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
