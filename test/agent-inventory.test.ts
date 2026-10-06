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
  AGENT_TASK_LAUNCHER_FILE_NAME,
  KEEPALIVE_MARKER_FILE_NAME,
  SUPERVISOR_GENERATION_FILE_NAME,
  agentTaskName,
  isKeepaliveSessionProcess,
  parseKeepaliveMarker,
  parseSupervisorGeneration,
  readDeclaredKeepalive,
  verifyKeepaliveMarker,
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
  discoverFolderAgents,
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
  // win32 with no agent task: a live launcher still counts.
  assert.equal(
    detectSupervisor({
      platform: 'win32',
      home: 'C:\\Users\\kc',
      assistantId: '912',
      exists: (p) => !p.endsWith('run-agent.vbs'),
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

// -- folder-declared agents: the machine has no single registry -------------------------

/**
 * An agent folder as `bgos-agent install --key --user` and `bgos-claim`
 * actually leave it: the API key and the assistant id live in the folder's
 * .mcp.json and there is NO ~/.bgos-agent/credentials-<id>.json at all. This
 * is the layout of agent 900 on the BGOS dev Mac, the agent the inventory used
 * to omit entirely.
 */
function apiKeyAgentFolder(dir: string, assistantId: string) {
  return {
    [`${dir}/.mcp.json`]: JSON.stringify({
      mcpServers: {
        bgos: {
          command: 'bun',
          args: ['/home/kc/bgos-claude-plugin/server.ts'],
          env: {
            BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1',
            BGOS_API_KEY: 'sk-live-do-not-leak-me',
            BGOS_USER_ID: 'user_abc',
            BGOS_ASSISTANT_ID: assistantId,
          },
        },
      },
    }),
  }
}

/** A loaded launchd job, the way plutil prints it, running in `cwd`. */
function loadedJob(handle: string, cwd: string, kind: 'launchd' | 'systemd' = 'launchd') {
  return {
    kind,
    handle,
    file: `/home/kc/Library/LaunchAgents/${handle}.plist`,
    job: {
      handle,
      workingDirectory: cwd,
      paths: ['/bin/bash', `/home/kc/.${handle}/keepalive.sh`, cwd],
    },
  }
}

test('discoverFolderAgents: an agent declared ONLY in its folder is found through the job that runs it', () => {
  const files = { ...apiKeyAgentFolder('/home/kc/BGOS', '900') }
  const fs = memFs(files, ['/home/kc/BGOS'])
  const found = discoverFolderAgents({
    home: HOME,
    jobs: [loadedJob('ai.bgos.claude.session', '/home/kc/BGOS')],
    readFile: fs.readFile,
  })
  assert.deepEqual([...found.keys()], ['900'])
  assert.equal(found.get('900')!.cwd, '/home/kc/BGOS')
  assert.deepEqual(found.get('900')!.notes, [])
})

test('discoverFolderAgents: the home directory, a silent folder and a conflicted folder declare nobody', () => {
  const fs = memFs({
    ...apiKeyAgentFolder(HOME, '900'),
    '/home/kc/quiet/.mcp.json': JSON.stringify({ mcpServers: { bgos: { command: 'bun' } } }),
    ...apiKeyAgentFolder('/home/kc/torn', '5'),
    '/home/kc/torn/.bgos-agent-id': '6\n',
  })
  const found = discoverFolderAgents({
    home: HOME,
    jobs: [
      // The home directory is shared by everything and identifies no agent.
      loadedJob('ai.bgos.home', HOME),
      loadedJob('ai.bgos.quiet', '/home/kc/quiet'),
      // A folder whose two identity sources disagree cannot be claimed.
      loadedJob('ai.bgos.torn', '/home/kc/torn'),
      // A job with no working directory at all.
      { kind: 'launchd' as const, handle: 'ai.bgos.nowd', file: '/x.plist', job: { handle: 'ai.bgos.nowd', workingDirectory: '', paths: [] } },
    ],
    readFile: fs.readFile,
  })
  assert.deepEqual([...found.keys()], [])
})

test('discoverFolderAgents: two folders claiming one agent still yield a ROW, just no cwd to restart into', () => {
  // Vanishing here would reintroduce the exact bug: a silent omission is worse
  // than an honest "manual restart required" step.
  const fs = memFs({
    ...apiKeyAgentFolder('/home/kc/one', '900'),
    ...apiKeyAgentFolder('/home/kc/two', '900'),
  })
  const found = discoverFolderAgents({
    home: HOME,
    jobs: [loadedJob('ai.bgos.one', '/home/kc/one'), loadedJob('ai.bgos.two', '/home/kc/two')],
    readFile: fs.readFile,
  })
  assert.deepEqual([...found.keys()], ['900'])
  assert.equal(found.get('900')!.cwd, null)
  assert.deepEqual(found.get('900')!.notes, ['ambiguous_supervised_folders:2'])
})

test('listAgents: an agent with NO credentials file is inventoried, and is restartable', () => {
  // The regression this closes: eight agents ran on the dev Mac, seven had
  // credentials files, and 900 got no row and therefore no step at all, so a
  // reconcile looked complete while skipping an agent.
  const plist = '/home/kc/Library/LaunchAgents/ai.bgos.claude.session.plist'
  const jobJson = JSON.stringify({
    Label: 'ai.bgos.claude.session',
    ProgramArguments: ['/bin/bash', '/home/kc/.bgos-claude-session/keepalive.sh'],
    WorkingDirectory: '/home/kc/BGOS',
  })
  const files: Record<string, string> = {
    // Exactly one credentials file, for the OTHER agent.
    '/home/kc/.bgos-agent/credentials-912.json': '{"pairingToken":"secret"}',
    ...apiKeyAgentFolder('/home/kc/BGOS', '900'),
    [plist]: jobJson,
  }
  const fs = memFs(files, ['/home/kc/BGOS'])
  const execSync = (file: string, args: string[]) => {
    if (file === 'launchctl' && args[0] === 'list') {
      return { code: 0, stdout: 'PID\tStatus\tLabel\n1\t0\tai.bgos.claude.session' }
    }
    if (file === 'plutil') {
      const path = args[args.length - 1]!
      return path in files ? { code: 0, stdout: files[path]! } : { code: 1, stdout: '' }
    }
    return { code: 127, stdout: '' }
  }
  const agents = listAgents({ home: HOME, env: {}, platform: 'darwin', fs, pidAlive: () => false, execSync })
  assert.deepEqual(agents.map((a) => a.assistantId), ['900', '912'])
  const orchestrator = agents[0]!
  assert.equal(orchestrator.discoveredVia, 'supervised-folder')
  assert.equal(orchestrator.cwd, '/home/kc/BGOS')
  assert.equal(orchestrator.supervisor, 'service')
  assert.equal(orchestrator.service?.handle, 'ai.bgos.claude.session')
  assert.equal(orchestrator.running, true)
  // The agent that DID have a credentials file is unchanged.
  assert.equal(agents[1]!.discoveredVia, 'credentials')
  assert.equal(agents[1]!.supervisor, 'none')
  // The API key that sits beside the id in .mcp.json never reaches a row.
  assert.equal(JSON.stringify(agents).includes('sk-live-do-not-leak-me'), false)
  assert.equal(JSON.stringify(agents).includes('secret'), false)
})

// -- keep-alive sweep inputs (design 4 and 5, G7, G11) ------------------------------------------

const KEEPALIVE_BODY = JSON.stringify({ kind: 'keepalive', pid: 33108, claudePid: 33200, tmuxSession: 'agent-912', capabilities: ['relaunch'], startedAt: 'x' })

/**
 * A sync exec that answers `ps -o comm= -p <pid>` from a table, the process
 * table `ps -A -o pid=,ppid=,uid=,etime=` from `procs`, a cwd lookup (lsof on
 * darwin, readlink on linux) from `cwds`, and fails everything else.
 */
function commExec(names: Record<number, string>, opts: { procs?: Array<[number, number, number, string]>; cwds?: Record<number, string> } = {}) {
  const calls: string[][] = []
  const execSync = (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (file === 'ps' && args[0] === '-o' && args[1] === 'comm=' && args[2] === '-p') {
      const name = names[Number(args[3])]
      return name ? { code: 0, stdout: `${name}\n` } : { code: 1, stdout: '' }
    }
    if (file === 'ps' && args[0] === '-A' && opts.procs) {
      return { code: 0, stdout: opts.procs.map(([pid, ppid, uid, etime]) => `${pid} ${ppid} ${uid} ${etime}`).join('\n') + '\n' }
    }
    if (file === 'lsof' && opts.cwds) {
      const pid = Number(args[args.indexOf('-p') + 1])
      return opts.cwds[pid] ? { code: 0, stdout: `p${pid}\nfcwd\nn${opts.cwds[pid]}\n` } : { code: 1, stdout: '' }
    }
    if (file === 'readlink' && opts.cwds) {
      const pid = Number(/\/proc\/(\d+)\/cwd/.exec(args[0] ?? '')?.[1])
      return opts.cwds[pid] ? { code: 0, stdout: `${opts.cwds[pid]}\n` } : { code: 1, stdout: '' }
    }
    return { code: 1, stdout: '' }
  }
  return { calls, execSync }
}

/** The script 33108 (started an hour ago) launched claude 33200 (10 min ago) directly. */
const OWN_CHAIN: Array<[number, number, number, string]> = [
  [1, 0, 0, '10-00:00:00'],
  [33108, 1, 501, '01:00:00'],
  [33200, 33108, 501, '10:00'],
]

test('parseKeepaliveMarker: the same table as the daemon side (lib/update-readiness.ts), so both trust one file the same way', async () => {
  const daemon = await import('../lib/update-readiness.ts')
  const full = { kind: 'keepalive', pid: 33108, claudePid: 33200, capabilities: ['relaunch'], tmuxSession: '  agent\n910  ' }
  const bodies = [
    JSON.stringify(full),
    JSON.stringify({ ...full, kind: 'launcher' }),
    JSON.stringify({ ...full, capabilities: [] }),
    JSON.stringify({ ...full, pid: 1 }),
    JSON.stringify({ ...full, pid: '33108' }),
    JSON.stringify({ ...full, claudePid: null }),
    JSON.stringify({ ...full, tmuxSession: 'x'.repeat(200) }),
    JSON.stringify({ ...full, tmuxSession: undefined }),
    'garbage',
    '[]',
    '',
  ]
  for (const body of bodies) {
    assert.deepEqual(parseKeepaliveMarker(body), daemon.parseKeepaliveMarker(body), body)
  }
  assert.deepEqual(parseKeepaliveMarker(JSON.stringify(full)), { pid: 33108, claudePid: 33200, tmuxSession: 'agent 910' })
  for (const comm of ['claude', '/Users/kc/.local/bin/claude', 'tmux', 'claude-helper', '', null]) {
    assert.equal(isKeepaliveSessionProcess(comm as any), daemon.isKeepaliveSessionProcess(comm as any), String(comm))
  }
  assert.equal(KEEPALIVE_MARKER_FILE_NAME, daemon.KEEPALIVE_MARKER_FILE)
})

test('verifyKeepaliveMarker: the script pid alive, claudePid alive AND named claude AND provably the script\'s (it descends from it); anything else is no keepalive', () => {
  const path = '/home/kc/.bgos-agent/912/keepalive.json'
  const readFile = (p: string) => (p === path ? KEEPALIVE_BODY : null)
  const alive = (pid: number) => pid === 33108 || pid === 33200
  const ok = commExec({ 33200: '/Users/kc/.local/bin/claude' }, { procs: OWN_CHAIN })
  assert.deepEqual(verifyKeepaliveMarker({ platform: 'darwin', home: HOME, assistantId: '912', readFile, pidAlive: alive, execSync: ok.execSync, uid: 501 }), {
    pid: 33108,
    claudePid: 33200,
    tmuxSession: 'agent-912',
  })
  // One table (the script's and claude's owner, start, parent), then claude's name.
  assert.deepEqual(ok.calls.map((c) => c.slice(0, 2)), [['ps', '-A'], ['ps', '-o']])
  const rows: Array<[string, Record<string, unknown>]> = [
    ['the keepalive script has exited', { pidAlive: (pid: number) => pid === 33200 }],
    ['the declared session is gone', { pidAlive: (pid: number) => pid === 33108 }],
    ['the declared pid is not a claude (a shared tmux server)', { execSync: commExec({ 33200: 'tmux' }).execSync }],
    ['ps cannot answer', { execSync: commExec({}).execSync }],
    ['no marker on disk', { readFile: () => null }],
    ['a malformed marker', { readFile: () => '{"kind":"keepalive"}' }],
    ['win32 has no ps: fail closed', { platform: 'win32' }],
    ['a junk id builds no path', { assistantId: '9x' }],
  ]
  for (const [name, patch] of rows) {
    const probe = { platform: 'darwin', home: HOME, assistantId: '912', readFile, pidAlive: alive, execSync: ok.execSync, ...patch }
    assert.equal(verifyKeepaliveMarker(probe as any), null, name)
  }
})

test('verifyKeepaliveMarker (F6): a live claude that is NOT provably this agent\'s (not under the script, not in the agent folder, not the one its own daemon names) is never a SIGTERM target', () => {
  const path = '/home/kc/.bgos-agent/912/keepalive.json'
  const statePath = '/home/kc/.bgos-plugin-state/912/agent-state.json'
  const NOW = Date.parse('2026-10-06T19:00:00.000Z')
  const startedAt = new Date(NOW - 5 * 60_000).toISOString()
  const marker = JSON.stringify({ kind: 'keepalive', pid: 33108, claudePid: 33200, tmuxSession: 'agent-912', capabilities: ['relaunch'], startedAt })
  const alive = (pid: number) => pid === 33108 || pid === 33200
  // 33200 runs under a tmux server (not the script) in ANOTHER folder: the old pid, reused by someone else's claude.
  const elsewhere: Array<[number, number, number, string]> = [
    [1, 0, 0, '10-00:00:00'],
    [33108, 1, 501, '01:00:00'],
    [4000, 1, 501, '02:00:00'],
    [33200, 4000, 501, '10:00'],
  ]
  const base = { platform: 'darwin', home: HOME, assistantId: '912', pidAlive: alive, uid: 501, now: NOW, cwd: '/home/kc/agents/guru', agentStatePath: statePath }
  const files = (extra: Record<string, string> = {}) => (p: string) => ({ [path]: marker, ...extra })[p] ?? null
  const reused = commExec({ 33200: 'claude' }, { procs: elsewhere, cwds: { 33200: '/home/kc/projects/other' } })
  assert.equal(verifyKeepaliveMarker({ ...base, readFile: files(), execSync: reused.execSync } as any), null, 'not under the script, not in the folder')
  // The same claude in the agent's own folder (a tmux keepalive: claude is not under the script) verifies.
  const inFolder = commExec({ 33200: 'claude' }, { procs: elsewhere, cwds: { 33200: '/home/kc/agents/guru' } })
  assert.equal(verifyKeepaliveMarker({ ...base, readFile: files(), execSync: inFolder.execSync } as any)?.claudePid, 33200, 'in the agent folder')
  // Or the agent's own live daemon names it as its claude (agent-state.json, fresh).
  const state = JSON.stringify({ schemaVersion: 1, assistantId: '912', pid: 33300, claudePid: 33200, runningVersion: '0.62.0', pendingRestartVersion: null, turnInFlight: false, pendingMessages: 0, pendingPermissions: 0, activeOperations: 0, lastActivityAt: null, sessionId: null, updatedAt: new Date(NOW - 5_000).toISOString() })
  const vouched = commExec({ 33200: 'claude' }, { procs: elsewhere })
  const withState = { ...base, pidAlive: (pid: number) => alive(pid) || pid === 33300 }
  assert.equal(verifyKeepaliveMarker({ ...withState, readFile: files({ [statePath]: state }), execSync: vouched.execSync } as any)?.claudePid, 33200, 'its own daemon names it')
  // A claude in the folder that STARTED AFTER the marker was written is not the one it named (pid reuse).
  const younger: Array<[number, number, number, string]> = [...elsewhere.slice(0, 3), [33200, 4000, 501, '01:00']]
  const late = commExec({ 33200: 'claude' }, { procs: younger, cwds: { 33200: '/home/kc/agents/guru' } })
  assert.equal(verifyKeepaliveMarker({ ...base, readFile: files(), execSync: late.execSync } as any), null, 'started 1 min ago, the marker is 5 min old')
  // Another user's process at that pid is never ours.
  const foreign: Array<[number, number, number, string]> = [...elsewhere.slice(0, 3), [33200, 4000, 502, '10:00']]
  const other = commExec({ 33200: 'claude' }, { procs: foreign, cwds: { 33200: '/home/kc/agents/guru' } })
  assert.equal(verifyKeepaliveMarker({ ...base, readFile: files(), execSync: other.execSync } as any), null, 'owned by uid 502')
})

test('verifyKeepaliveMarker (F6): the folder proof compares by realpath, since lsof reports the physical path of a folder recorded through a symlink', () => {
  const path = '/home/kc/.bgos-agent/912/keepalive.json'
  const NOW = Date.parse('2026-10-06T19:00:00.000Z')
  const marker = JSON.stringify({ kind: 'keepalive', pid: 33108, claudePid: 33200, tmuxSession: 'agent-912', capabilities: ['relaunch'], startedAt: new Date(NOW - 5 * 60_000).toISOString() })
  // claude runs under a tmux server, not the script: only the folder can prove it is this agent's.
  const procs: Array<[number, number, number, string]> = [[1, 0, 0, '10-00:00:00'], [33108, 1, 501, '01:00:00'], [4000, 1, 501, '02:00:00'], [33200, 4000, 501, '10:00']]
  const exec = commExec({ 33200: 'claude' }, { procs, cwds: { 33200: '/Volumes/Data/home/kc/agents/guru' } })
  const base = { platform: 'darwin', home: HOME, assistantId: '912', readFile: (p: string) => (p === path ? marker : null), pidAlive: (pid: number) => pid === 33108 || pid === 33200, execSync: exec.execSync, uid: 501, now: NOW, cwd: '/home/kc/agents/guru' }
  const realpath = (p: string) => (p === '/home/kc/agents/guru' ? '/Volumes/Data/home/kc/agents/guru' : p)
  assert.equal(verifyKeepaliveMarker({ ...base, realpath } as any)?.claudePid, 33200, 'the same folder under its physical path')
  assert.equal(verifyKeepaliveMarker({ ...base, realpath: (p: string) => p } as any), null, 'a folder that really is elsewhere')
})

test('readDeclaredKeepalive (F6): a script pid now held by a process that started AFTER the marker, or by another user, is a reused pid: not declared (the product supervisor is installed after all)', () => {
  const path = '/home/kc/.bgos-agent/912/keepalive.json'
  const NOW = Date.parse('2026-10-06T19:00:00.000Z')
  const marker = JSON.stringify({ kind: 'keepalive', pid: 33108, claudePid: 33200, capabilities: ['relaunch'], startedAt: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString() })
  const readFile = (p: string) => (p === path ? marker : null)
  const base = { platform: 'darwin', home: HOME, assistantId: '912', readFile, pidAlive: (pid: number) => pid === 33108, uid: 501, now: NOW }
  // After a reboot the pid went to a daemon that started an hour ago; the marker is 3 days old.
  const rebooted = commExec({}, { procs: [[33108, 1, 501, '01:00:00']] })
  assert.equal(readDeclaredKeepalive({ ...base, execSync: rebooted.execSync } as any), null)
  const root = commExec({}, { procs: [[33108, 1, 0, '5-00:00:00']] })
  assert.equal(readDeclaredKeepalive({ ...base, execSync: root.execSync } as any), null, 'a root process at that pid')
  const real = commExec({}, { procs: [[33108, 1, 501, '4-00:00:00']] })
  assert.equal(readDeclaredKeepalive({ ...base, execSync: real.execSync } as any)?.pid, 33108, 'the script that wrote it, still running')
  // No table, or a marker with no startedAt: nothing proves reuse, the declaration stands.
  assert.equal(readDeclaredKeepalive({ ...base, execSync: commExec({}).execSync } as any)?.pid, 33108)
  assert.equal(readDeclaredKeepalive({ ...base, readFile: (p: string) => (p === path ? KEEPALIVE_BODY : null), execSync: rebooted.execSync } as any)?.pid, 33108)
})

test('readDeclaredKeepalive: a marker that PARSES and whose script is ALIVE is a declared keepalive, even while its claude is gone between two relaunches (G11); the restart still needs the full verification', () => {
  const path = '/home/kc/.bgos-agent/912/keepalive.json'
  const readFile = (p: string) => (p === path ? KEEPALIVE_BODY : null)
  const scriptOnly = (pid: number) => pid === 33108
  const probe = { platform: 'darwin', home: HOME, assistantId: '912', readFile, pidAlive: scriptOnly }
  assert.deepEqual(readDeclaredKeepalive(probe), { pid: 33108, claudePid: 33200, tmuxSession: 'agent-912' })
  assert.equal(readDeclaredKeepalive({ ...probe, platform: 'linux' })?.pid, 33108)
  // The same marker does NOT verify, so it can never be the target of a SIGTERM.
  assert.equal(verifyKeepaliveMarker({ ...probe, execSync: commExec({ 33200: 'claude' }).execSync }), null)
  const rows: Array<[string, Record<string, unknown>]> = [
    ['the keepalive script has exited', { pidAlive: (pid: number) => pid === 33200 }],
    ['no marker on disk', { readFile: () => null }],
    ['a malformed marker', { readFile: () => '{"kind":"keepalive"}' }],
    ['no relaunch promise', { readFile: () => JSON.stringify({ kind: 'keepalive', pid: 33108, claudePid: 33200, capabilities: [] }) }],
    ['win32 has no keepalive scripts: a live pid there is a reused one', { platform: 'win32' }],
    ['a junk id builds no path', { assistantId: '9x' }],
  ]
  for (const [name, patch] of rows) {
    assert.equal(readDeclaredKeepalive({ ...probe, ...patch } as any), null, name)
  }
})

test('listAgents: a keepalive whose claude is between relaunches is DECLARED on the row (no second supervisor) but not verified (no SIGTERM)', () => {
  const fs = memFs({
    '/home/kc/.bgos-agent/credentials-912.json': '{}',
    '/home/kc/.bgos-agent/912/keepalive.json': KEEPALIVE_BODY,
  })
  const between = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: (pid) => pid === 33108, execSync: commExec({}).execSync })
  assert.equal(between[0]!.keepalive, null)
  assert.equal(between[0]!.keepaliveDeclared, true)
  const both = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: (pid) => [33108, 33200].includes(pid), execSync: commExec({ 33200: 'claude' }, { procs: OWN_CHAIN }).execSync, uid: 501 })
  assert.equal(both[0]!.keepaliveDeclared, true)
  assert.notEqual(both[0]!.keepalive, null)
  const gone = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: () => false, execSync: commExec({}).execSync })
  assert.equal(gone[0]!.keepaliveDeclared, false)
})

test('parseSupervisorGeneration: absent is generation 1 (run.expect, fresh session, no tmux); a v2 stamp is 2; junk is 1', () => {
  assert.equal(SUPERVISOR_GENERATION_FILE_NAME, 'supervisor-generation')
  assert.equal(parseSupervisorGeneration(null), 1)
  assert.equal(parseSupervisorGeneration('2\n'), 2)
  assert.equal(parseSupervisorGeneration(' 3 '), 3)
  assert.equal(parseSupervisorGeneration('two'), 1)
  assert.equal(parseSupervisorGeneration('0'), 1)
})

test('win32: the canonical agent task (HOAI Agent <id>, its run-agent.vbs in the state dir) counts as the agent service', () => {
  const vbs = 'C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs'
  const resolved = resolveAgentSupervisor({ platform: 'win32', home: 'C:\\Users\\kc', assistantId: '912', exists: (p) => p === vbs, readFile: () => null, pidAlive: () => false })
  assert.deepEqual(resolved, { supervisor: 'service', service: { kind: 'schtasks', handle: 'HOAI Agent 912', via: 'canonical-file', file: vbs } })
  assert.equal(agentTaskName('912'), 'HOAI Agent 912')
  assert.equal(agentTaskName('9 12'), null)
  assert.equal(AGENT_TASK_LAUNCHER_FILE_NAME, 'run-agent.vbs')
  // posix never reads the vbs.
  assert.equal(resolveAgentSupervisor({ platform: 'linux', home: HOME, assistantId: '912', exists: (p) => p.endsWith('run-agent.vbs'), readFile: () => null, pidAlive: () => false }).supervisor, 'none')
})

test('listAgents: rows carry the verified keepalive, the supervisor generation (canonical only) and whether the hoai launcher is live', () => {
  const fs = memFs(
    {
      '/home/kc/.bgos-agent/credentials-912.json': '{}',
      '/home/kc/.bgos-agent/credentials-7.json': '{}',
      '/home/kc/.bgos-agent/credentials-5.json': '{}',
      '/home/kc/.config/systemd/user/bgos-agent-7.service': '[Service]',
      '/home/kc/.config/systemd/user/bgos-agent-5.service': '[Service]',
      '/home/kc/.bgos-agent/5/supervisor-generation': '2\n',
      '/home/kc/.bgos-agent/5/supervisor.json': supervisorFileBody(5555, 'x'),
      '/home/kc/.bgos-agent/912/keepalive.json': KEEPALIVE_BODY,
    },
  )
  const exec = commExec({ 33200: 'claude' }, { procs: OWN_CHAIN })
  const agents = listAgents({ home: HOME, env: {}, platform: 'linux', fs, pidAlive: (pid) => [33108, 33200, 5555].includes(pid), execSync: exec.execSync, uid: 501 })
  const byId = Object.fromEntries(agents.map((a) => [a.assistantId, a]))
  assert.deepEqual(byId['912']!.keepalive, { pid: 33108, claudePid: 33200, tmuxSession: 'agent-912' })
  assert.equal(byId['912']!.supervisorGeneration, null, 'not canonical: no generation')
  assert.equal(byId['912']!.launcherLive, false)
  assert.equal(byId['7']!.supervisorGeneration, 1, 'canonical with no stamp is generation 1')
  assert.equal(byId['7']!.keepalive, null)
  assert.equal(byId['5']!.supervisorGeneration, 2)
  assert.equal(byId['5']!.launcherLive, true, 'a v2 supervisor runs hoai, whose supervisor.json is live')
})
