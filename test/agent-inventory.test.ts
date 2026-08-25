/**
 * lib/agent-inventory.mjs: the per-machine agent inventory the watcher plans
 * against, plus the launch recipe hoai-core writes at every supervised launch.
 *
 * Pins: path builders mirror bin/hoai-core.mjs, lib/update-readiness.ts and
 * bin/bgos-doctor.mjs (two state dirs, design 7.1); recipe parse/build is
 * strict (schema, digits-only id, string argv, launcher 'hoai') and NEVER
 * carries a session id; listAgents validates every recipe against the disk
 * (cwd exists, folder pin matches) and drops the recipe with a named note
 * rather than trusting it; supervisor detection needs a LIVE pid with the
 * relaunch capability, a stale supervisor.json is 'none'.
 *
 * Run: npx tsx --test test/agent-inventory.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LAUNCH_RECIPE_FILE_NAME,
  LAUNCH_RECIPE_SCHEMA_VERSION,
  LIVE_MARKER_FILE_NAME,
  PROBE_MARKER_FILE_NAME,
  RESTART_MARKER_FILE_NAME,
  SESSION_ID_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  agentDir,
  agentStateDir,
  buildLaunchRecipe,
  credentialsPath,
  detectSupervisor,
  joinDir,
  launchRecipePath,
  listAgents,
  listPairedAssistantIds,
  liveMarkerPathFor,
  parseLaunchRecipe,
  parseSupervisorFile,
  probeMarkerPath,
  readFolderPin,
  resolveAgentSupervisor,
  readLaunchRecipe,
  restartMarkerPath,
  serviceFilePath,
  serviceLabel,
  serviceUnit,
  supervisorPath,
  validAssistantId,
  writeLaunchRecipe,
} from '../lib/agent-inventory.mjs'
import {
  RESTART_MARKER_FILE_NAME as CORE_MARKER,
  SESSION_ID_FILE_NAME as CORE_SESSION,
  SUPERVISOR_FILE_NAME as CORE_SUPERVISOR,
  supervisorFileBody,
} from '../bin/hoai-core.mjs'

const HOME = '/home/kc'

/** An in-memory fs matching the inventory's read-only probe surface. */
function memFs(files: Record<string, string>, dirs: string[] = []) {
  const store = new Map(Object.entries(files))
  const dirSet = new Set(dirs)
  return {
    files: store,
    exists: (p: string) => store.has(p) || dirSet.has(p),
    readFile: (p: string) => store.get(p) ?? null,
    listDir: (p: string) => {
      const prefix = p.replace(/[\\/]+$/, '') + '/'
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
      for (const dir of dirSet) {
        if (dir.startsWith(prefix)) {
          const head = dir.slice(prefix.length).split('/')[0]
          if (head) names.add(head)
        }
      }
      return [...names]
    },
  }
}

// -- constants pinned against the other side ---------------------------------

test('file names mirror bin/hoai-core.mjs (the two files talk through these)', () => {
  assert.equal(SUPERVISOR_FILE_NAME, CORE_SUPERVISOR)
  assert.equal(RESTART_MARKER_FILE_NAME, CORE_MARKER)
  assert.equal(SESSION_ID_FILE_NAME, CORE_SESSION)
  assert.equal(LAUNCH_RECIPE_FILE_NAME, 'launch.json')
  assert.equal(PROBE_MARKER_FILE_NAME, 'probe-requested.json')
  assert.equal(LIVE_MARKER_FILE_NAME, 'channel-live.json')
  assert.equal(LAUNCH_RECIPE_SCHEMA_VERSION, 1)
})

// -- path builders -------------------------------------------------------------

test('joinDir preserves the separator style of the directory', () => {
  assert.equal(joinDir('/home/kc', '.bgos-agent'), '/home/kc/.bgos-agent')
  assert.equal(joinDir('/home/kc/', 'x'), '/home/kc/x')
  assert.equal(joinDir('C:\\Users\\kc', '.bgos-agent'), 'C:\\Users\\kc\\.bgos-agent')
  assert.equal(joinDir('C:', 'x'), 'C:\\x')
  assert.equal(joinDir('', 'x'), 'x')
})

test('validAssistantId accepts digits only', () => {
  assert.equal(validAssistantId('912'), '912')
  assert.equal(validAssistantId(' 912 '), '912')
  assert.equal(validAssistantId(912), '912')
  assert.equal(validAssistantId('912; rm -rf /'), null)
  assert.equal(validAssistantId('../x'), null)
  assert.equal(validAssistantId(''), null)
  assert.equal(validAssistantId(null), null)
})

test('agent-dir paths: ~/.bgos-agent/<id>/* (design 7.1, first state dir)', () => {
  assert.equal(agentDir(HOME), '/home/kc/.bgos-agent')
  assert.equal(agentStateDir(HOME, '912'), '/home/kc/.bgos-agent/912')
  assert.equal(credentialsPath(HOME, '912'), '/home/kc/.bgos-agent/credentials-912.json')
  assert.equal(launchRecipePath(HOME, '912'), '/home/kc/.bgos-agent/912/launch.json')
  assert.equal(supervisorPath(HOME, '912'), '/home/kc/.bgos-agent/912/supervisor.json')
  assert.equal(restartMarkerPath(HOME, '912'), '/home/kc/.bgos-agent/912/restart-requested.json')
  assert.equal(probeMarkerPath(HOME, '912'), '/home/kc/.bgos-agent/912/probe-requested.json')
  // Invalid ids build no path at all.
  assert.equal(agentStateDir(HOME, 'x'), null)
  assert.equal(launchRecipePath(HOME, '../x'), null)
  // win32 homes stay win32.
  assert.equal(launchRecipePath('C:\\Users\\kc', '912'), 'C:\\Users\\kc\\.bgos-agent\\912\\launch.json')
})

test('service naming mirrors bin/bgos-agent + lib/update-readiness.ts', () => {
  assert.equal(serviceLabel('912'), 'ai.bgos.agent.912')
  assert.equal(serviceUnit('912'), 'bgos-agent-912')
  assert.equal(
    serviceFilePath('darwin', HOME, '912'),
    '/home/kc/Library/LaunchAgents/ai.bgos.agent.912.plist',
  )
  assert.equal(
    serviceFilePath('linux', HOME, '912'),
    '/home/kc/.config/systemd/user/bgos-agent-912.service',
  )
  // Windows has no per-agent service (design 7.1).
  assert.equal(serviceFilePath('win32', 'C:\\Users\\kc', '912'), null)
  assert.equal(serviceFilePath('darwin', HOME, 'junk'), null)
})

test('liveMarkerPathFor mirrors bgos-doctor (second state dir, BGOS_PLUGIN_STATE_DIR override, cwd hash fallback)', () => {
  assert.equal(
    liveMarkerPathFor({ env: {}, home: HOME, assistantId: '912', cwd: '/x' }),
    '/home/kc/.bgos-plugin-state/912/channel-live.json',
  )
  assert.equal(
    liveMarkerPathFor({ env: { BGOS_PLUGIN_STATE_DIR: '/tmp/state' }, home: HOME, assistantId: '912', cwd: '/x' }),
    '/tmp/state/912/channel-live.json',
  )
  // No usable id: keyed by a cwd hash, exactly like the doctor and cursor-store.
  const hashed = liveMarkerPathFor({ env: {}, home: HOME, assistantId: '', cwd: '/agents/athena' })
  assert.match(hashed, /^\/home\/kc\/\.bgos-plugin-state\/cwd-[0-9a-f]{16}\/channel-live\.json$/)
})

// -- small readers ---------------------------------------------------------------

test('listPairedAssistantIds: credentials-<digits>.json only, ascending numerically', () => {
  const ids = listPairedAssistantIds(HOME, () => [
    'credentials-912.json',
    'credentials.json',
    'credentials-7.json',
    'credentials-abc.json',
    'credentials-1001.json',
    'watcher',
  ])
  assert.deepEqual(ids, ['7', '912', '1001'])
  assert.deepEqual(listPairedAssistantIds(HOME, () => []), [])
})

test('readFolderPin: digits only, else empty', () => {
  assert.equal(readFolderPin('/a', (p) => (p === '/a/.bgos-agent-id' ? '912\n' : null)), '912')
  assert.equal(readFolderPin('/a', () => 'nope'), '')
  assert.equal(readFolderPin('/a', () => null), '')
  assert.equal(readFolderPin('', () => '912'), '')
})

test('parseSupervisorFile: fail-closed mirror of lib/update-readiness.ts', () => {
  assert.deepEqual(parseSupervisorFile(supervisorFileBody(42, 'x')), {
    pid: 42,
    capabilities: ['relaunch'],
  })
  assert.equal(parseSupervisorFile(null), null)
  assert.equal(parseSupervisorFile(''), null)
  assert.equal(parseSupervisorFile('junk'), null)
  assert.equal(parseSupervisorFile('[]'), null)
  assert.equal(parseSupervisorFile('{"pid":"42"}'), null)
  assert.equal(parseSupervisorFile('{"pid":0}'), null)
})

// -- launch recipe -----------------------------------------------------------------

const RECIPE_INPUT = {
  assistantId: '912',
  cwd: '/home/kc/hoai-agents/ava',
  argv: ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'plugin:hoai@hoai'],
  installMethod: 'marketplace',
  pluginRoot: '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3',
  node: '/usr/local/bin/node',
  startedAt: '2026-08-25T00:00:00.000Z',
  pid: 4242,
}

test('buildLaunchRecipe: exact schema, launcher hoai, session args stripped', () => {
  const recipe = buildLaunchRecipe({
    ...RECIPE_INPUT,
    argv: [...RECIPE_INPUT.argv, '--resume', '11111111-1111-4111-8111-111111111111'],
  })
  assert.deepEqual(recipe, {
    schemaVersion: 1,
    assistantId: '912',
    cwd: '/home/kc/hoai-agents/ava',
    argv: RECIPE_INPUT.argv,
    installMethod: 'marketplace',
    pluginRoot: '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3',
    node: '/usr/local/bin/node',
    startedAt: '2026-08-25T00:00:00.000Z',
    claudeConfigDir: null,
    launcher: 'hoai',
    pid: 4242,
  })
  const text = JSON.stringify(recipe)
  assert.equal(text.includes('--resume'), false)
  assert.equal(text.includes('--session-id'), false)
  assert.equal(text.includes('--continue'), false)
  assert.equal(text.includes('11111111-1111'), false)
})

test('buildLaunchRecipe: a --session-id pair and --continue are stripped too', () => {
  const recipe = buildLaunchRecipe({
    ...RECIPE_INPUT,
    argv: ['--continue', ...RECIPE_INPUT.argv, '--session-id', 'abc'],
  })
  assert.deepEqual(recipe.argv, RECIPE_INPUT.argv)
})

test('parseLaunchRecipe: round trips a built recipe and rejects every malformed shape', () => {
  const recipe = buildLaunchRecipe(RECIPE_INPUT)
  assert.deepEqual(parseLaunchRecipe(JSON.stringify(recipe)), recipe)
  assert.equal(parseLaunchRecipe(null), null)
  assert.equal(parseLaunchRecipe('junk'), null)
  assert.equal(parseLaunchRecipe('[]'), null)
  assert.equal(parseLaunchRecipe(JSON.stringify({ ...recipe, schemaVersion: 2 })), null)
  assert.equal(parseLaunchRecipe(JSON.stringify({ ...recipe, assistantId: 'ava' })), null)
  assert.equal(parseLaunchRecipe(JSON.stringify({ ...recipe, cwd: '' })), null)
  assert.equal(parseLaunchRecipe(JSON.stringify({ ...recipe, argv: 'x' })), null)
  assert.equal(parseLaunchRecipe(JSON.stringify({ ...recipe, argv: [1] })), null)
  assert.equal(parseLaunchRecipe(JSON.stringify({ ...recipe, launcher: 'other' })), null)
  // Optional fields tolerate absence (an older recipe still parses).
  const minimal = { schemaVersion: 1, assistantId: '912', cwd: '/x', argv: [], launcher: 'hoai' }
  assert.deepEqual(parseLaunchRecipe(JSON.stringify(minimal)), {
    schemaVersion: 1,
    assistantId: '912',
    cwd: '/x',
    argv: [],
    installMethod: null,
    pluginRoot: null,
    node: null,
    startedAt: null,
    claudeConfigDir: null,
    launcher: 'hoai',
    pid: null,
  })
})

test('writeLaunchRecipe / readLaunchRecipe: written under ~/.bgos-agent/<id>/launch.json, pretty JSON + LF', () => {
  const files = new Map<string, string>()
  const ok = writeLaunchRecipe({
    home: HOME,
    assistantId: '912',
    recipe: buildLaunchRecipe(RECIPE_INPUT),
    writeFile: (p, c) => {
      files.set(p, c)
      return true
    },
  })
  assert.equal(ok, true)
  const text = files.get('/home/kc/.bgos-agent/912/launch.json')!
  assert.equal(typeof text, 'string')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.includes('\r'), false)
  assert.equal(text.includes('\n  "schemaVersion": 1,'), true)
  const back = readLaunchRecipe({ home: HOME, assistantId: '912', readFile: (p) => files.get(p) ?? null })
  assert.deepEqual(back, buildLaunchRecipe(RECIPE_INPUT))
  // A bad id writes nothing and reads nothing.
  assert.equal(writeLaunchRecipe({ home: HOME, assistantId: 'x', recipe: buildLaunchRecipe(RECIPE_INPUT), writeFile: () => true }), false)
  assert.equal(readLaunchRecipe({ home: HOME, assistantId: 'x', readFile: () => '{}' }), null)
  // A failed write is reported, never thrown.
  assert.equal(writeLaunchRecipe({ home: HOME, assistantId: '912', recipe: buildLaunchRecipe(RECIPE_INPUT), writeFile: () => false }), false)
})

// -- detectSupervisor ---------------------------------------------------------------

test('detectSupervisor: service file beats launcher beats none; stale launcher is none', () => {
  const svc = '/home/kc/Library/LaunchAgents/ai.bgos.agent.912.plist'
  const sup = '/home/kc/.bgos-agent/912/supervisor.json'
  assert.equal(
    detectSupervisor({ platform: 'darwin', home: HOME, assistantId: '912', exists: (p) => p === svc, readFile: () => null, pidAlive: () => false }),
    'service',
  )
  assert.equal(
    detectSupervisor({
      platform: 'linux',
      home: HOME,
      assistantId: '912',
      exists: () => false,
      readFile: (p) => (p === sup ? supervisorFileBody(77, 'x') : null),
      pidAlive: (pid) => pid === 77,
    }),
    'launcher-live',
  )
  // Dead pid: the supervisor.json is stale, so no authority.
  assert.equal(
    detectSupervisor({
      platform: 'linux',
      home: HOME,
      assistantId: '912',
      exists: () => false,
      readFile: (p) => (p === sup ? supervisorFileBody(77, 'x') : null),
      pidAlive: () => false,
    }),
    'none',
  )
  // Live pid but no relaunch capability: not an authority either.
  assert.equal(
    detectSupervisor({
      platform: 'linux',
      home: HOME,
      assistantId: '912',
      exists: () => false,
      readFile: (p) => (p === sup ? JSON.stringify({ pid: 77, capabilities: [] }) : null),
      pidAlive: () => true,
    }),
    'none',
  )
  // win32 never reports a service, but a live launcher still counts.
  assert.equal(
    detectSupervisor({
      platform: 'win32',
      home: 'C:\\Users\\kc',
      assistantId: '912',
      exists: () => true,
      readFile: (p) => (p === 'C:\\Users\\kc\\.bgos-agent\\912\\supervisor.json' ? supervisorFileBody(5, 'x') : null),
      pidAlive: () => true,
    }),
    'launcher-live',
  )
})

// -- listAgents -----------------------------------------------------------------------

function recipeFor(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify(buildLaunchRecipe({ ...RECIPE_INPUT, assistantId: id, cwd, ...extra }))
}

test('listAgents: two agents, one launcher-live with a valid recipe, one recipe-only; ascending ids; full row shape', () => {
  const fs = memFs(
    {
      '/home/kc/.bgos-agent/credentials-912.json': '{"pairingToken":"secret"}',
      '/home/kc/.bgos-agent/credentials-7.json': '{"pairingToken":"secret"}',
      '/home/kc/.bgos-agent/credentials.json': '{}',
      '/home/kc/.bgos-agent/912/launch.json': recipeFor('912', '/home/kc/hoai-agents/ava'),
      '/home/kc/.bgos-agent/912/supervisor.json': supervisorFileBody(4242, 'x'),
      '/home/kc/.bgos-agent/912/session-id': '11111111-1111-4111-8111-111111111111\n',
      '/home/kc/hoai-agents/ava/.bgos-agent-id': '912\n',
      '/home/kc/.bgos-agent/7/launch.json': recipeFor('7', '/home/kc/hoai-agents/old'),
      '/home/kc/hoai-agents/old/.bgos-agent-id': '7\n',
    },
    ['/home/kc/hoai-agents/ava', '/home/kc/hoai-agents/old'],
  )
  const agents = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: (pid) => pid === 4242 })
  assert.deepEqual(
    agents.map((a) => a.assistantId),
    ['7', '912'],
  )
  const ava = agents[1]!
  assert.equal(ava.cwd, '/home/kc/hoai-agents/ava')
  assert.equal(ava.recipe?.assistantId, '912')
  assert.equal(ava.supervisor, 'launcher-live')
  assert.equal(ava.running, true)
  assert.equal(ava.serviceFile, null)
  assert.equal(ava.sessionId, '11111111-1111-4111-8111-111111111111')
  assert.equal(ava.stateDir, '/home/kc/.bgos-agent/912')
  assert.equal(ava.pluginStateDir, '/home/kc/.bgos-plugin-state/912')
  assert.equal(ava.liveMarkerPath, '/home/kc/.bgos-plugin-state/912/channel-live.json')
  assert.equal(ava.credentialsPath, '/home/kc/.bgos-agent/credentials-912.json')
  assert.deepEqual(ava.notes, [])
  const old = agents[0]!
  assert.equal(old.supervisor, 'none')
  assert.equal(old.running, false)
  assert.equal(old.recipe?.cwd, '/home/kc/hoai-agents/old')
  assert.equal(old.sessionId, null)
  // Nothing in a row is a secret: the credentials CONTENT is never read.
  assert.equal(JSON.stringify(agents).includes('secret'), false)
})

test('listAgents: a recipe whose cwd is gone is dropped and named', () => {
  const fs = memFs({
    '/home/kc/.bgos-agent/credentials-912.json': '{}',
    '/home/kc/.bgos-agent/912/launch.json': recipeFor('912', '/home/kc/hoai-agents/gone'),
  })
  const [agent] = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: () => false })
  assert.equal(agent!.recipe, null)
  assert.equal(agent!.cwd, null)
  assert.deepEqual(agent!.notes, ['recipe_cwd_missing:/home/kc/hoai-agents/gone'])
})

test('listAgents: a recipe whose cwd pin names ANOTHER agent is dropped and named (never launched as the wrong identity)', () => {
  const fs = memFs(
    {
      '/home/kc/.bgos-agent/credentials-912.json': '{}',
      '/home/kc/.bgos-agent/credentials-7.json': '{}',
      '/home/kc/.bgos-agent/912/launch.json': recipeFor('912', '/home/kc/hoai-agents/old'),
      '/home/kc/hoai-agents/old/.bgos-agent-id': '7\n',
    },
    ['/home/kc/hoai-agents/old'],
  )
  const agents = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: () => false })
  const ava = agents.find((a) => a.assistantId === '912')!
  assert.equal(ava.recipe, null)
  assert.equal(ava.cwd, null)
  assert.deepEqual(ava.notes, ['recipe_cwd_pinned_to_other_agent:7'])
})

test('listAgents: an unpinned recipe cwd is kept only on a single-agent host', () => {
  const single = memFs(
    {
      '/home/kc/.bgos-agent/credentials-912.json': '{}',
      '/home/kc/.bgos-agent/912/launch.json': recipeFor('912', '/home/kc/hoai-agents/ava'),
    },
    ['/home/kc/hoai-agents/ava'],
  )
  const [sole] = listAgents({ home: HOME, env: {}, platform: 'linux', fs: single, pidAlive: () => false })
  assert.equal(sole!.recipe?.cwd, '/home/kc/hoai-agents/ava')
  assert.deepEqual(sole!.notes, [])
  const multi = memFs(
    {
      '/home/kc/.bgos-agent/credentials-912.json': '{}',
      '/home/kc/.bgos-agent/credentials-7.json': '{}',
      '/home/kc/.bgos-agent/912/launch.json': recipeFor('912', '/home/kc/hoai-agents/ava'),
    },
    ['/home/kc/hoai-agents/ava'],
  )
  const ava = listAgents({ home: HOME, env: {}, platform: 'linux', fs: multi, pidAlive: () => false }).find(
    (a) => a.assistantId === '912',
  )!
  assert.equal(ava.recipe, null)
  assert.deepEqual(ava.notes, ['recipe_cwd_unpinned_on_multi_agent_host'])
})

test('listAgents: a recipe whose assistantId disagrees with its own state dir is dropped', () => {
  const fs = memFs(
    {
      '/home/kc/.bgos-agent/credentials-912.json': '{}',
      '/home/kc/.bgos-agent/912/launch.json': recipeFor('7', '/home/kc/hoai-agents/ava'),
      '/home/kc/hoai-agents/ava/.bgos-agent-id': '912\n',
    },
    ['/home/kc/hoai-agents/ava'],
  )
  const [agent] = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: () => false })
  assert.equal(agent!.recipe, null)
  assert.deepEqual(agent!.notes, ['recipe_assistant_mismatch:7'])
})

test('listAgents: junk recipe is dropped with a note; a service file marks the agent as service-supervised', () => {
  const fs = memFs({
    '/home/kc/.bgos-agent/credentials-55.json': '{}',
    '/home/kc/.bgos-agent/55/launch.json': 'not json',
    '/home/kc/.config/systemd/user/bgos-agent-55.service': '[Unit]',
  })
  const [agent] = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: () => false })
  assert.equal(agent!.recipe, null)
  assert.deepEqual(agent!.notes, ['recipe_unreadable'])
  assert.equal(agent!.supervisor, 'service')
  assert.equal(agent!.serviceFile, '/home/kc/.config/systemd/user/bgos-agent-55.service')
  assert.equal(agent!.running, true)
})

test('listAgents: no agent dir means an empty fleet, never a throw', () => {
  const fs = memFs({})
  assert.deepEqual(listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: () => false }), [])
})

test('listAgents: BGOS_PLUGIN_STATE_DIR moves the live marker path for every agent', () => {
  const fs = memFs({ '/home/kc/.bgos-agent/credentials-912.json': '{}' })
  const [agent] = listAgents({
    home: HOME,
    env: { BGOS_PLUGIN_STATE_DIR: '/var/state' },
    platform: 'linux',
    fs,
    pidAlive: () => false,
  })
  assert.equal(agent!.liveMarkerPath, '/var/state/912/channel-live.json')
  assert.equal(agent!.pluginStateDir, '/var/state/912')
})

// -- detectSupervisor: the discovery tier ---------------------------------------------

/** A fake launchd host: plists on disk plus the labels launchctl reports loaded. */
function launchdHost(files: Record<string, string>, loaded: string[]) {
  const listDir = (dir: string) =>
    Object.keys(files)
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => p.slice(dir.length + 1))
  const readFile = (p: string) => (p in files ? files[p]! : null)
  const execSync = (file: string, args: string[]) => {
    if (file === 'launchctl' && args[0] === 'list') {
      return { code: 0, stdout: ['PID\tStatus\tLabel', ...loaded.map((l) => `1\t0\t${l}`)].join('\n') }
    }
    if (file === 'plutil') {
      const path = args[args.length - 1]!
      return path in files ? { code: 0, stdout: files[path]! } : { code: 1, stdout: '' }
    }
    return { code: 127, stdout: '' }
  }
  return { files, listDir, readFile, execSync }
}

const BESPOKE_PLIST = '/home/kc/Library/LaunchAgents/ai.bgos.session.912.plist'
const BESPOKE_JOB = JSON.stringify({
  Label: 'ai.bgos.session.912',
  ProgramArguments: ['/bin/bash', '/home/kc/.bgos-session-912/keepalive.sh'],
  WorkingDirectory: '/home/kc/hoai-agents/ava',
})

test('detectSupervisor: a launchd job under a NON-CANONICAL label is a service, resolved to its own handle', () => {
  // The bug this closes: bin/bgos-agent installs ai.bgos.agent.<id>, so an
  // agent some other launcher put under its own label reported 'none' and the
  // app withheld the one-click update button from a restartable daemon.
  const host = launchdHost({ [BESPOKE_PLIST]: BESPOKE_JOB }, ['ai.bgos.session.912'])
  const probe = {
    platform: 'darwin',
    home: HOME,
    assistantId: '912',
    cwd: '/home/kc/hoai-agents/ava',
    exists: (p: string) => p in host.files,
    readFile: host.readFile,
    listDir: host.listDir,
    execSync: host.execSync,
    pidAlive: () => false,
  }
  assert.equal(detectSupervisor(probe), 'service')
  const resolved = resolveAgentSupervisor(probe)
  assert.equal(resolved.service?.kind, 'launchd')
  assert.equal(resolved.service?.handle, 'ai.bgos.session.912')
  assert.equal(resolved.service?.via, 'working-directory')
})

test('detectSupervisor: an agent nothing supervises is still none, with every probe wired', () => {
  const host = launchdHost({ [BESPOKE_PLIST]: BESPOKE_JOB }, ['ai.bgos.session.912'])
  const unsupervised = {
    platform: 'darwin',
    home: HOME,
    // A different agent, whose folder no loaded job declares.
    assistantId: '7',
    cwd: '/home/kc/hoai-agents/old',
    exists: (p: string) => p in host.files,
    readFile: host.readFile,
    listDir: host.listDir,
    execSync: host.execSync,
    pidAlive: () => false,
  }
  assert.equal(detectSupervisor(unsupervised), 'none')
  assert.equal(resolveAgentSupervisor(unsupervised).service, null)
  // And the same agent when the job exists on disk but launchd has not loaded
  // it: an unloaded plist cannot bring anything back.
  const dormant = launchdHost({ [BESPOKE_PLIST]: BESPOKE_JOB }, ['com.apple.mdworker'])
  assert.equal(
    detectSupervisor({
      platform: 'darwin',
      home: HOME,
      assistantId: '912',
      cwd: '/home/kc/hoai-agents/ava',
      exists: (p: string) => p in dormant.files,
      readFile: dormant.readFile,
      listDir: dormant.listDir,
      execSync: dormant.execSync,
      pidAlive: () => false,
    }),
    'none',
  )
})

test('detectSupervisor: a live hoai launcher still wins over no service, and the canonical file still wins over both', () => {
  const sup = '/home/kc/.bgos-agent/912/supervisor.json'
  const host = launchdHost({}, [])
  const withLauncher = {
    platform: 'darwin',
    home: HOME,
    assistantId: '912',
    cwd: '/home/kc/hoai-agents/ava',
    exists: () => false,
    readFile: (p: string) => (p === sup ? supervisorFileBody(77, 'x') : null),
    listDir: host.listDir,
    execSync: host.execSync,
    pidAlive: (pid: number) => pid === 77,
  }
  assert.equal(detectSupervisor(withLauncher), 'launcher-live')
  assert.equal(resolveAgentSupervisor(withLauncher).service, null)
  const canonical = serviceFilePath('darwin', HOME, '912')!
  const withCanonical = { ...withLauncher, exists: (p: string) => p === canonical }
  assert.equal(detectSupervisor(withCanonical), 'service')
  assert.equal(resolveAgentSupervisor(withCanonical).service?.handle, 'ai.bgos.agent.912')
  assert.equal(resolveAgentSupervisor(withCanonical).service?.via, 'canonical-file')
})

test('listAgents: a discovered service reaches the row, so the restart is addressed to that job', () => {
  const files: Record<string, string> = {
    '/home/kc/.bgos-agent/credentials-912.json': '{"pairingToken":"secret"}',
    '/home/kc/.bgos-agent/912/launch.json': recipeFor('912', '/home/kc/hoai-agents/ava'),
    [BESPOKE_PLIST]: BESPOKE_JOB,
  }
  const host = launchdHost(files, ['ai.bgos.session.912'])
  const fs = {
    exists: (p: string) => p in files || p === '/home/kc/hoai-agents/ava',
    readFile: host.readFile,
    listDir: host.listDir,
  }
  const [agent] = listAgents({
    home: HOME,
    env: {},
    platform: 'darwin',
    fs,
    pidAlive: () => false,
    execSync: host.execSync,
  })
  assert.equal(agent!.supervisor, 'service')
  assert.equal(agent!.running, true)
  assert.equal(agent!.service?.handle, 'ai.bgos.session.912')
  assert.equal(agent!.serviceFile, BESPOKE_PLIST)
  assert.equal(JSON.stringify(agent).includes('secret'), false)
})
