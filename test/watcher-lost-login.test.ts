/**
 * A lost login file is a login problem, not an agent that lives elsewhere (board row 23415823).
 *
 * Found 2026-11-13 by the Helper test on Windows: with credentials-<id>.json moved aside for a paired
 * agent, the watcher's check up refused with `agent_not_on_this_machine:<id>` and the server row read
 * offline, not seen, refused. The 13 Nov wipe on a Mac deleted every agent's login file the same way.
 * The machine test (lib/watcher-core.mjs runCheckupJob and runOwnerRestartJob) read only the
 * inventory, and the inventory starts from the login files, so the one cause it could name was the
 * wrong one.
 *
 * Pinned here, on all three platforms' path rules, in a fake HOME (nothing real is read or touched):
 *   - a missing login with an install record of its own reads `login_file_missing`, with the card words
 *     and the pairing fix, and nothing is restarted;
 *   - no record of the agent at all stays `agent_not_on_this_machine`;
 *   - a present login is unchanged: the check up runs as before.
 *
 * Run: npx tsx --test test/watcher-lost-login.test.ts
 */

// First: any real process listing, signal or launch fails this file instead of acting on the computer.
import './helpers/real-os-sentinel.ts'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runCheckupJob, runOwnerRestartJob } from '../lib/watcher-core.mjs'
import { agentHomeId, buildLaunchRecipe, serviceFilePath } from '../lib/agent-inventory.mjs'
import { LOGIN_FILE_MISSING, LOGIN_FILE_MISSING_WORDS, localAgentEvidence } from '../lib/lost-login.mjs'
import { memoryFs, type MemoryFs } from './helpers/memory-fs.ts'

const T0 = Date.parse('2026-11-13T09:00:00.000Z')
const ID = '912'
const CARD = "This agent's login file is missing on this computer. Pair it again to fix it."

type Platform = 'linux' | 'darwin' | 'win32'

/** Each platform's own HOME and separator: the paths the watcher builds there. */
const PLATFORMS: Array<{ platform: Platform; home: string; sep: string }> = [
  { platform: 'linux', home: '/home/kc', sep: '/' },
  { platform: 'darwin', home: '/Users/kc', sep: '/' },
  { platform: 'win32', home: 'C:\\Users\\kc', sep: '\\' },
]

function paths(home: string, sep: string, id = ID) {
  const agentDir = `${home}${sep}.bgos-agent`
  const stateDir = `${agentDir}${sep}${id}`
  return {
    agentDir,
    stateDir,
    credentials: `${agentDir}${sep}credentials-${id}.json`,
    folder: `${home}${sep}hoai-agents${sep}ava`,
    pluginState: `${home}${sep}.bgos-plugin-state${sep}${id}`,
    keepAliveState: `${agentDir}${sep}watcher${sep}keepalive-state.json`,
    file: (name: string) => `${stateDir}${sep}${name}`,
  }
}

/** Agent 912 as pairing and a supervised launch leave it, with the login file present or not. */
function agentFs(home: string, sep: string, opts: { login: boolean; records?: boolean }): MemoryFs {
  const p = paths(home, sep)
  const files: Record<string, string> = {}
  if (opts.login) files[p.credentials] = JSON.stringify({ pairingToken: 'agent-secret-912', backendUrl: 'x', assistantId: ID })
  if (opts.records !== false) {
    files[p.file('launch.json')] = JSON.stringify(
      buildLaunchRecipe({ assistantId: ID, cwd: p.folder, argv: ['--x'], installMethod: 'marketplace', pluginRoot: `${home}${sep}plugin`, node: 'node', startedAt: 'x', pid: 4242 }),
    )
    files[p.file('session-id')] = '8c1f0000-0000-4000-8000-000000000001\n'
    files[`${p.folder}${sep}.bgos-agent-id`] = `${ID}\n`
  }
  return memoryFs(files, [p.folder])
}

/** The job context runWatcher hands a job, with every process and service layer faked. */
/**
 * The server's live keep-alive answer to this watcher (GET integrations/watchers/keep-alive). Its
 * `agentWindows` map is keyed by every agent the server places on THIS computer: one whose current
 * ACTIVE pairing reports this machine (backend keep-alive.model.ts windowAgents, isProvenOnMachine).
 * An agent re-paired onto another computer is not in it. By default it places agent 912 here.
 */
type ServerAnswer = { status: number; json?: any } | 'throws'
const placesHere = (ids: string[] = [ID]): ServerAnswer => ({
  status: 200,
  json: { enabled: false, enabledAt: null, assistantIds: [], switchState: 'off', showAgentWindows: false, agentWindows: Object.fromEntries(ids.map((id) => [id, false])) },
})

function ctxFor(fs: MemoryFs, platform: Platform, home: string, alive: number[] = [], server: ServerAnswer = placesHere()) {
  const posts: any[] = []
  const gets: string[] = []
  const logs: string[] = []
  const spawns: unknown[] = []
  const kills: unknown[] = []
  const live = new Set(alive)
  const ctx = {
    client: {
      progress: async (_rpcId: string, body: any) => void posts.push(body),
      get: async (path: string) => {
        gets.push(path)
        if (server === 'throws') throw new Error('network down')
        return { ok: server.status < 400, status: server.status, json: server.json ?? null }
      },
    },
    log: (line: string) => void logs.push(line),
    now: () => T0,
    sleep: async () => {},
    fs,
    exec: async () => ({ code: 1, stdout: '', stderr: '', error: null, timedOut: false }),
    env: {},
    home,
    platform,
    uid: 501,
    pidAlive: (pid: number) => live.has(pid),
    execSync: () => ({ code: 1, stdout: '' }),
    kill: (...args: unknown[]) => void kills.push(args),
    spawnDetached: (...args: unknown[]) => {
      spawns.push(args)
      return { pid: 4343 }
    },
    modules: {
      observeMarketplaceInstall: async () => ({ marketplaceRegistered: true, marketplaceLatest: { version: '0.87.5' }, installed: { present: true, version: '0.87.5', installPath: `${home}/plugin` }, enabled: true }),
    },
    manifest: null,
    checkupDeadlineMs: 5_000,
    verifyTimeoutMs: 0,
  }
  return { ctx, posts, logs, spawns, kills, gets }
}

const checkupJob = (id = ID) => ({ op: 'checkup', targets: [{ pairingId: 3, assistantId: Number(id) }] })
const restartJob = (id = ID) => ({ op: 'restart_agent', requestedBy: 'owner', targets: [{ assistantId: Number(id) }] })

function assertNoPrivatePaths(texts: string[], home: string) {
  for (const text of texts) {
    assert.equal(text.includes(home), false, `a HOME path reached the server: ${text}`)
    assert.equal(text.includes('agent-secret-912'), false, 'the agent secret reached the server')
    assert.equal(/[\u2013\u2014]/.test(text), false, `a dash: ${text}`)
  }
}

for (const { platform, home, sep } of PLATFORMS) {
  test(`${platform}: a missing login file with the agent's own install record reads login_file_missing, with the card words and the pairing fix`, async () => {
    const fs = agentFs(home, sep, { login: false })
    const run = ctxFor(fs, platform, home)
    const out = await runCheckupJob(run.ctx as any, 'chk-1', checkupJob())
    const terminal = run.posts.at(-1)
    assert.equal(out.state, 'done')
    assert.equal(terminal.state, 'done')
    assert.doesNotMatch(terminal.message, /agent_not_on_this_machine/)
    assert.match(terminal.message, /login_file_missing/)
    assert.deepEqual(
      terminal.findings.map((f: any) => [f.cause, f.status, f.target, f.fix]),
      [['login_file_missing', 'FAIL', ID, CARD]],
    )
    assert.match(terminal.findings[0].detail, /launch\.json/)
    assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome, a.target]), [['login_file_missing', 'report', 'not_fixed', ID]])
    assert.ok(terminal.actions[0].detail.startsWith(CARD))
    assert.match(terminal.actions[0].detail, /hoai pair <code from the HOAI app>/)
    assert.deepEqual(
      terminal.steps.map((s: any) => [s.id, s.state]),
      [
        ['observe', 'ok'],
        ['a1-report', 'ok'],
      ],
    )
    // Nothing touched: a restart without a login only adds a failed launch.
    assert.deepEqual(run.spawns, [])
    assert.deepEqual(run.kills, [])
    assert.equal(fs.files.has(paths(home, sep).file('restart-requested.json')), false)
    assert.equal(fs.files.has(paths(home, sep).credentials), false, 'the watcher never writes a login file')
    assertNoPrivatePaths(run.posts.flatMap((b) => [b.message ?? '', ...(b.findings ?? []).flatMap((f: any) => [f.detail, f.fix ?? '']), ...(b.actions ?? []).map((a: any) => a.detail)]), home)
    assert.ok(run.logs.some((l) => l.includes('login_file_missing')), 'the log names it')
  })

  test(`${platform}: an agent with no record on this computer at all stays agent_not_on_this_machine`, async () => {
    const fs = agentFs(home, sep, { login: false, records: false })
    const run = ctxFor(fs, platform, home)
    const out = await runCheckupJob(run.ctx as any, 'chk-1', checkupJob())
    const terminal = run.posts.at(-1)
    assert.equal(out.state, 'failed')
    assert.equal(terminal.state, 'failed')
    assert.equal(terminal.message, `agent_not_on_this_machine:${ID}`)
    assert.equal(terminal.findings, undefined)
    assert.deepEqual(run.spawns, [])
  })

  test(`${platform}: a present login file is unchanged: the check up passes the machine test and runs`, async () => {
    const fs = agentFs(home, sep, { login: true })
    const run = ctxFor(fs, platform, home)
    await runCheckupJob(run.ctx as any, 'chk-1', checkupJob())
    const terminal = run.posts.at(-1)
    assert.doesNotMatch(terminal.message, /agent_not_on_this_machine|login_file_missing/)
    assert.equal((terminal.findings ?? []).some((f: any) => f.cause === LOGIN_FILE_MISSING), false)
    assert.ok(run.logs.some((l) => l.startsWith(`checkup ${ID}: claude=`)), 'the full observation ran')
  })

  test(`${platform}: the owner's Restart of an agent whose login file is missing is refused by that name, and nothing is restarted`, async () => {
    const lost = ctxFor(agentFs(home, sep, { login: false }), platform, home)
    await runOwnerRestartJob(lost.ctx as any, 'rst-1', restartJob())
    assert.equal(lost.posts.at(-1).state, 'failed')
    assert.equal(lost.posts.at(-1).message, `login_file_missing:${ID}`)
    assert.deepEqual(lost.spawns, [])
    assert.deepEqual(lost.kills, [])

    const away = ctxFor(agentFs(home, sep, { login: false, records: false }), platform, home)
    await runOwnerRestartJob(away.ctx as any, 'rst-1', restartJob())
    assert.equal(away.posts.at(-1).message, `agent_not_on_this_machine:${ID}`)
  })

  test(`${platform}: each record the agent keeps here counts on its own; what a removal or the watcher leaves behind does not`, () => {
    const p = paths(home, sep)
    const evidence = (files: Record<string, string>, alive: number[] = []) =>
      localAgentEvidence({ home, env: {}, platform, fs: memoryFs(files), assistantId: ID, now: T0, pidAlive: (pid: number) => alive.includes(pid) })

    // The agent's own records, one at a time.
    for (const name of ['launch.json', 'supervisor.json', 'session-id', 'service.json', 'keepalive.json', 'supervisor-generation', 'run-agent.vbs']) {
      assert.deepEqual(evidence({ [p.file(name)]: 'x' }), [name], name)
    }
    // Its service file, by this HOME's name or the old one (macOS and Linux; Windows keeps run-agent.vbs).
    if (platform !== 'win32') {
      for (const hid of [agentHomeId(home, platform), '']) {
        assert.deepEqual(evidence({ [serviceFilePath(platform, home, ID, hid)!]: 'x' }), ['service_file'], `service ${hid || 'legacy'}`)
      }
    }
    // A daemon of this agent running now: a fresh agent-state.json from a live pid.
    const state = JSON.stringify({ schemaVersion: 1, assistantId: ID, pid: 4912, claudePid: 5912, turnInFlight: false, pendingMessages: 0, pendingPermissions: 0, activeOperations: 0, updatedAt: new Date(T0 - 5_000).toISOString() })
    assert.deepEqual(evidence({ [`${p.pluginState}${sep}agent-state.json`]: state }, [4912]), ['running_daemon'])
    // ...or the pairing lock beside the moved file, still stamped by a live daemon.
    assert.deepEqual(evidence({ [`${p.credentials}.lock`]: JSON.stringify({ pid: 4912, heartbeatAt: T0 - 5_000 }) }, [4912]), ['running_daemon'])

    // Not evidence: the same daemon files from a dead pid, the watcher's own keep-alive record (kept
    // after a removal), the markers the watcher itself writes, the archive a removal leaves, an empty
    // folder, another agent's records, and a junk id.
    assert.deepEqual(evidence({ [`${p.pluginState}${sep}agent-state.json`]: state }), [])
    assert.deepEqual(evidence({ [p.keepAliveState]: JSON.stringify({ agents: { [ID]: { attempts: 1 } } }) }), [])
    assert.deepEqual(evidence({ [p.file('restart-requested.json')]: '{}', [p.file('probe-requested.json')]: '{}' }), [])
    assert.deepEqual(evidence({ [`${p.agentDir}${sep}.removed${sep}${ID}-2026-11-13${sep}launch.json`]: 'x' }), [])
    assert.deepEqual(localAgentEvidence({ home, env: {}, platform, fs: memoryFs({}, [p.stateDir]), assistantId: ID, now: T0, pidAlive: () => false }), [])
    assert.deepEqual(evidence({ [paths(home, sep, '913').file('launch.json')]: 'x' }), [])
    assert.deepEqual(localAgentEvidence({ home, env: {}, platform, fs: memoryFs({ [p.file('launch.json')]: 'x' }), assistantId: '../912', now: T0, pidAlive: () => false }), [])
  })

  test(`${platform}: an agent whose login is its folder's .mcp.json key never had a login file, so it is not a lost login`, async () => {
    const p = paths(home, sep)
    const mcp = (env: Record<string, string>) => JSON.stringify({ mcpServers: { hoai: { command: 'bun', args: [], env: { BGOS_ASSISTANT_ID: ID, ...env } } } })
    const otherPath = `${home}${sep}elsewhere${sep}login.json`
    const rows: Array<[string, Record<string, string>, string]> = [
      ['an Agent Pack key', { [`${p.folder}${sep}.mcp.json`]: mcp({ BGOS_API_KEY: 'bgos_key_value' }) }, 'agent_not_on_this_machine'],
      ['a credentials path to a file that exists', { [`${p.folder}${sep}.mcp.json`]: mcp({ BGOS_CREDENTIALS_PATH: otherPath }), [otherPath]: '{}' }, 'agent_not_on_this_machine'],
      // Still lost: an empty key, a credentials path to a file that is gone, or a .mcp.json naming another agent.
      ['an empty key', { [`${p.folder}${sep}.mcp.json`]: mcp({ BGOS_API_KEY: '' }) }, 'login_file_missing'],
      ['a credentials path to a missing file', { [`${p.folder}${sep}.mcp.json`]: mcp({ BGOS_CREDENTIALS_PATH: otherPath }) }, 'login_file_missing'],
      ['a key for another agent', { [`${p.folder}${sep}.mcp.json`]: mcp({ BGOS_API_KEY: 'k', BGOS_ASSISTANT_ID: '913' }) }, 'login_file_missing'],
    ]
    for (const [what, extra, want] of rows) {
      const fs = agentFs(home, sep, { login: false })
      for (const [path, text] of Object.entries(extra)) fs.writeFile(path, text)
      const run = ctxFor(fs, platform, home)
      await runCheckupJob(run.ctx as any, 'chk-1', checkupJob())
      assert.match(run.posts.at(-1).message, new RegExp(want), what)
      assertNoPrivatePaths(run.posts.map((b) => JSON.stringify(b)), home)
      assert.equal(run.posts.some((b) => JSON.stringify(b).includes('bgos_key_value')), false, 'the key never leaves')
    }
  })
}

// -- Round 2: a login that MOVED to another computer is not a lost login (review, blocking finding) --
//
// An agent re-paired onto another computer can leave its records here (a re-pair by the same owner
// removes nothing on the computer it left: lib/agent-unbound.mjs), and the server still lists it on
// both computers. If its old login file here is then gone too, the records alone would say "Pair it
// again", and pairing here would pull the agent back from the computer it now lives on. Only the
// server knows which computer holds its pairing, so it is asked, live, before a lost login is named;
// anything it cannot vouch for keeps agent_not_on_this_machine.

for (const { platform, home, sep } of PLATFORMS) {
  test(`${platform}: records here, no login file, and the server places the agent's pairing on another computer: agent_not_on_this_machine, never a lost login`, async () => {
    // The server's map for THIS computer names other agents, not 912: its pairing is elsewhere now.
    for (const [what, server] of [
      ['other agents placed here', placesHere(['913', '914'])],
      ['no agent placed here', placesHere([])],
    ] as const) {
      const fs = agentFs(home, sep, { login: false })
      const run = ctxFor(fs, platform, home, [], server)
      const out = await runCheckupJob(run.ctx as any, 'chk-1', checkupJob())
      const terminal = run.posts.at(-1)
      assert.equal(out.state, 'failed', what)
      assert.equal(terminal.message, `agent_not_on_this_machine:${ID}`, what)
      assert.equal(terminal.findings, undefined, what)
      assert.equal(JSON.stringify(run.posts).includes('Pair it again'), false, `${what}: never told to pair here`)
      assert.deepEqual(run.gets, ['integrations/watchers/keep-alive'], `${what}: the server was asked`)
      assert.ok(run.logs.some((l) => l.includes('the server does not place')), `${what}: the log says why`)
      assert.deepEqual(run.spawns, [])

      const restart = ctxFor(agentFs(home, sep, { login: false }), platform, home, [], server)
      await runOwnerRestartJob(restart.ctx as any, 'rst-1', restartJob())
      assert.equal(restart.posts.at(-1).message, `agent_not_on_this_machine:${ID}`, `${what}: restart`)
      assert.deepEqual(restart.spawns, [])
    }
  })

  test(`${platform}: when the server cannot say where the pairing is, the answer stays agent_not_on_this_machine`, async () => {
    const rows: Array<[string, ServerAnswer]> = [
      ['the call fails', 'throws'],
      ['a server error', { status: 503, json: { message: 'down' } }],
      ['the watcher refused', { status: 403, json: { message: 'Only a watcher pairing may read its machine keep-alive list.' } }],
      ['an older server with no map', { status: 200, json: { enabled: true, enabledAt: null, assistantIds: [912], switchState: 'on' } }],
      ['an answer that is not one', { status: 200, json: { hello: 'world' } }],
    ]
    for (const [what, server] of rows) {
      const run = ctxFor(agentFs(home, sep, { login: false }), platform, home, [], server)
      await runCheckupJob(run.ctx as any, 'chk-1', checkupJob())
      assert.equal(run.posts.at(-1).message, `agent_not_on_this_machine:${ID}`, what)
    }
  })

  test(`${platform}: the server is asked only when this computer keeps the agent's records, and never for a present login`, async () => {
    const away = ctxFor(agentFs(home, sep, { login: false, records: false }), platform, home)
    await runCheckupJob(away.ctx as any, 'chk-1', checkupJob())
    assert.deepEqual(away.gets, [], 'no records: nothing to ask')
    const present = ctxFor(agentFs(home, sep, { login: true }), platform, home)
    await runCheckupJob(present.ctx as any, 'chk-1', checkupJob())
    assert.equal(present.gets.includes('integrations/watchers/keep-alive'), false, 'a present login is unchanged')
  })
}

test('the card words are exactly the board row\'s, and the reason is a token the backend takes', () => {
  assert.equal(LOGIN_FILE_MISSING_WORDS, CARD)
  assert.match(LOGIN_FILE_MISSING, /^[a-z][a-z0-9_]{0,39}$/)
})
