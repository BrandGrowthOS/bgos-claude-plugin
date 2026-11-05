/**
 * PERSON LANES, the supervisor applying a person's own controls and the
 * share's policy (shared agents Phase 3, P5 and P7; design section 6, 7.2,
 * R9; lib/lane-supervisor.mjs). Driven end to end with a real scratch home
 * and a fake `expect` child:
 *
 *   - Before every launch the policy is read (an injected `launchFacts`),
 *     and the launch is exactly what it implies: the tool list, the settings
 *     rules, the owner's servers, `launch-policy.json`. Unread or failing:
 *     the locked base.
 *   - P5: every launch carries `--append-system-prompt-file` with the
 *     person's memory index, creates `work/memory/`, and passes the person's
 *     model and effort only while the owner's list still has them.
 *   - `/new` (a fresh restart request) relaunches on a NEW pin, never the old
 *     one, keeps the memory folder, and spends no crash budget; a pin that
 *     cannot be written stops the lane rather than resume the old one.
 *   - A TIGHTER policy (`when: now`) restarts while a turn is in flight, onto
 *     the stricter launch; a LOOSER one (`when: idle`) waits for no turn in
 *     flight and a quiet minute.
 *   - readAgentFolder lists a valid agent folder in the settings, never on
 *     the command line, and is refused for the home folder.
 *   - The default `launchFacts`: the stored session or one minted with the
 *     ticket, `lanes/me` for exactly this lane; anything else is locked, and
 *     with no session and no ticket nothing is fetched.
 *
 * Run with: npx tsx --test test/lane-supervisor-controls.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and the
// supervisor relies on POSIX link() locks and an expect child, so the file is
// skipped there (see test/lane-supervisor.test.ts).
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)

async function waitFor(cond: () => boolean, what: string, maxTicks = 200_000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${what}`)
}
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lanePaths, laneStateBody } from '../lib/lane-core.mjs'
import { LOCKED_TOOL_POLICY } from '../lib/lane-policy.mjs'
import { drainLaneEvents, sweepUnsafePersonLanes } from '../lib/lane-owner.ts'
import { defaultLaunchFacts, superviseLane } from '../lib/lane-supervisor.mjs'

const PIN = '11111111-2222-4333-8444-555555555555'
const PIN2 = '22222222-3333-4444-8555-666666666666'
const PIN3 = '33333333-4444-4555-8666-777777777777'
const GiB = 1024 ** 3

class FakeChild extends EventEmitter {
  pid: number
  kills: string[] = []
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  kill(signal: string): boolean {
    this.kills.push(signal)
    setImmediate(() => this.emit('exit', signal === 'SIGTERM' ? 143 : 137))
    return true
  }
}

interface Rig {
  home: string
  paths: ReturnType<typeof lanePaths>
  spawns: Array<{ script: string; child: FakeChild; env?: Record<string, string> }>
  notices: string[]
  clock: { t: number }
  events: () => Array<{ event: string }>
  cleanup: () => void
}

function rig(): Rig {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'lane-ctl-')))
  const paths = lanePaths({ home, assistantId: '1076', userId: 'user_ana' })
  return {
    home,
    paths,
    spawns: [],
    notices: [],
    clock: { t: Date.parse('2026-10-18T10:00:00Z') },
    events: () => {
      try {
        return readFileSync(paths.eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

function run(r: Rig, opts: {
  onSpawn?: (child: FakeChild, n: number) => void
  launchFacts?: () => Promise<{ policy: object; read: boolean }>
  ids?: string[]
  agentFolder?: string | null
  readClaudeJson?: () => unknown
  shellSandboxAvailable?: () => boolean
  runNotice?: (options: { env: Record<string, string> }) => Promise<number>
  loginMode?: 'inherit' | 'own_token'
} = {}) {
  const sleep = async (ms: number) => {
    r.clock.t += ms
    await new Promise((resolve) => setImmediate(resolve))
  }
  mkdirSync(r.paths.peopleDir, { recursive: true })
  writeFileSync(r.paths.loginModesPath, JSON.stringify({ modes: { user_ana: opts.loginMode ?? 'own_token' } }))
  mkdirSync(join(r.home, '.bgos-agent'), { recursive: true })
  const ids = [...(opts.ids ?? [PIN, PIN2, PIN3])]
  let pid = 7000
  return superviseLane({
    assistantId: '1076',
    userId: 'user_ana',
    home: r.home,
    launchContext: 'clean',
    ownerEnv: { PATH: '/usr/bin:/bin', HOME: r.home, USER: 'owner' },
    backendUrl: 'http://127.0.0.1:9/api/v1',
    pluginRoot: '/plugin',
    nodePath: '/usr/local/bin/node',
    claudePath: '/usr/local/bin/claude',
    platform: 'darwin',
    now: () => r.clock.t,
    sleep,
    selfPid: 1001,
    isAlive: (p: number) => p === 1001,
    availableBytes: () => 64 * GiB,
    tokenStore: { kind: 'fake', read: () => ({ ok: true, token: 'made-up-lane-token' }) } as never,
    watchMs: 5_000,
    stopGraceMs: 10_000,
    gateBlock: '# gate',
    generateId: () => ids.shift() ?? '',
    launchFacts: opts.launchFacts ?? (async () => ({ policy: { ...LOCKED_TOOL_POLICY }, read: true })),
    readClaudeJson: opts.readClaudeJson ?? (() => null),
    shellSandboxAvailable: opts.shellSandboxAvailable ?? (() => true),
    agentFolder: opts.agentFolder ?? null,
    spawnExpect: (script: string, options: { env: Record<string, string> }) => {
      const child = new FakeChild(pid++)
      r.spawns.push({ script, child, env: options.env })
      opts.onSpawn?.(child, r.spawns.length)
      return child as never
    },
    runNotice: opts.runNotice ?? (async ({ env }: { env: Record<string, string> }) => { r.notices.push(env.HOAI_LANE_NOTICE); return 0 }),
  } as never)
}

function stopAfter(r: Rig, n: number) {
  return (_c: FakeChild, count: number) => {
    if (count >= n) writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' }))
  }
}

function writeLaneJson(r: Rig, fields: { lastActivityAtMs: number | null; inFlight: boolean; inFlightSinceMs?: number | null }) {
  mkdirSync(r.paths.laneDir, { recursive: true })
  writeFileSync(r.paths.laneJsonPath, JSON.stringify(laneStateBody({ userId: 'user_ana', assistantId: '1076', loginMode: 'inherit', ...fields })))
}

function restart(r: Rig, body: Record<string, unknown>) {
  writeFileSync(r.paths.restartRequestPath, JSON.stringify(body))
}

test('the policy read before launch is the launch: tools, settings rules, launch-policy.json', async () => {
  const r = rig()
  try {
    await run(r, {
      launchFacts: async () => ({ policy: { v: 1, webFetch: true, shell: true }, read: true }),
      onSpawn: stopAfter(r, 1),
    })
    const { script } = r.spawns[0]!
    assert.ok(script.includes('{--tools} {Read,Edit,Write,Glob,Grep,WebFetch,WebSearch}'))
    assert.ok(!script.includes('skip-permissions'))
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.ok(settings.permissions.allow.includes('WebFetch'))
    assert.equal(settings.permissions.allow.includes('Bash'), false)
    const launched = JSON.parse(readFileSync(r.paths.launchPolicyPath, 'utf8'))
    assert.deepEqual(launched.policy, { v: 1, webFetch: true, readAgentFolder: false, browser: false, shell: false, ownerMcpServers: false })
    assert.equal(launched.policyRead, true)
    assert.deepEqual(launched.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
  } finally {
    r.cleanup()
  }
})

test('a policy that cannot be read launches the locked base', async () => {
  const r = rig()
  try {
    await run(r, { launchFacts: async () => { throw new Error('backend down') }, onSpawn: stopAfter(r, 1) })
    assert.ok(r.spawns[0]!.script.includes('{--tools} {Read,Edit,Write,Glob,Grep}'))
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.deepEqual(settings.permissions.deny, ['AskUserQuestion'])
    assert.equal(JSON.parse(readFileSync(r.paths.launchPolicyPath, 'utf8')).policyRead, false)
  } finally {
    r.cleanup()
  }
})

test('P5: the memory index reaches the model through the system prompt file; work/memory exists', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.memoryDir, { recursive: true })
    writeFileSync(join(r.paths.memoryDir, 'MEMORY.md'), '- [Fruit](fruit.md) - Ana likes a durian named KIWI-9953\n')
    await run(r, { onSpawn: stopAfter(r, 1) })
    assert.ok(r.spawns[0]!.script.includes(`{--append-system-prompt-file} {${r.paths.systemPromptPath}}`))
    const prompt = readFileSync(r.paths.systemPromptPath, 'utf8')
    assert.match(prompt, /KIWI-9953/)
    assert.ok(prompt.includes(r.paths.memoryDir))
    assert.match(prompt, /this person's own/)
    assert.doesNotMatch(prompt, /Run commands/, 'the locked base offers no shell')
    assert.ok(existsSync(r.paths.memoryDir))
  } finally {
    r.cleanup()
  }
})

test('P5 (K7): the person\'s model and effort are passed only while the owner\'s list has them', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.peopleDir, { recursive: true })
    mkdirSync(r.paths.laneDir, { recursive: true })
    writeFileSync(r.paths.allowedChoicesPath, JSON.stringify({ models: ['opus'], efforts: ['high'] }))
    writeFileSync(r.paths.choicesPath, JSON.stringify({ model: 'opus', effort: 'high', chatId: '5' }))
    await run(r, { onSpawn: stopAfter(r, 1) })
    assert.ok(r.spawns[0]!.script.includes('{--model} {opus} {--effort} {high}'))
    writeFileSync(r.paths.allowedChoicesPath, JSON.stringify({ models: ['sonnet'], efforts: [] }))
    try { rmSync(r.paths.launcherLockPath) } catch { /* released */ }
    await run(r, { onSpawn: stopAfter(r, 2) })
    assert.ok(!r.spawns[1]!.script.includes('--model') && !r.spawns[1]!.script.includes('--effort'), 'a choice the owner took off the list is not launched')
  } finally {
    r.cleanup()
  }
})

test('/new relaunches on a NEW pin, never the old one, keeps the memory, and spends no crash budget', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.memoryDir, { recursive: true })
    writeFileSync(join(r.paths.memoryDir, 'MEMORY.md'), '- [Fact](fact.md) - kept across /new\n')
    const done = run(r, {
      ids: [PIN, PIN2, PIN3, '44444444-5555-4666-8777-888888888888', '55555555-6666-4777-8888-999999999999'],
      onSpawn: (_c, n) => {
        if (n <= 4) restart(r, { reasons: ['new'], when: 'now', fresh: true, chatId: '5' })
        else writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' }))
      },
    })
    assert.deepEqual(await done, { outcome: 'stopped', reason: 'requested' })
    assert.equal(r.spawns.length, 5, 'four /new restarts, then the stop: no crash budget spent')
    assert.ok(r.spawns[0]!.script.includes(`{--session-id} {${PIN}}`))
    assert.ok(r.spawns[1]!.script.includes(`{--session-id} {${PIN2}}`), 'the new conversation has the new pin')
    assert.ok(!r.spawns[1]!.script.includes(PIN), 'never the old one')
    assert.equal(readFileSync(r.paths.sessionIdPath, 'utf8').trim(), '55555555-6666-4777-8888-999999999999', 'repinned on disk')
    assert.match(readFileSync(join(r.paths.memoryDir, 'MEMORY.md'), 'utf8'), /kept across \/new/)
    assert.ok(!r.events().some((e) => e.event === 'lane_failed'))
    assert.equal(existsSync(r.paths.restartRequestPath), false, 'the request is consumed')
  } finally {
    r.cleanup()
  }
})

test('/new whose new pin cannot be written stops the lane rather than resume the old conversation', async () => {
  const r = rig()
  try {
    const outcome = await run(r, { ids: [PIN, ''], onSpawn: (_c, n) => { if (n === 1) restart(r, { reasons: ['new'], when: 'now', fresh: true, chatId: '5' }) } })
    assert.deepEqual(outcome, { outcome: 'failed', reason: 'repin_failed' })
    assert.equal(r.spawns.length, 1, 'no relaunch on the old pin')
    assert.deepEqual(r.events().map((e) => e.event), ['lane_failed'])
  } finally {
    r.cleanup()
  }
})

test('a TIGHTER policy restarts NOW, a turn in flight or not, onto the stricter launch', async () => {
  const r = rig()
  try {
    const policies = [{ v: 1, webFetch: true }, { v: 1 }]
    const done = run(r, {
      launchFacts: async () => ({ policy: policies.shift() ?? { v: 1 }, read: true }),
      onSpawn: (_c, n) => {
        if (n === 1) {
          writeLaneJson(r, { lastActivityAtMs: r.clock.t, inFlight: true, inFlightSinceMs: r.clock.t })
          restart(r, { reasons: ['policy_tightened'], when: 'now', fresh: false })
        } else writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' }))
      },
    })
    await done
    assert.equal(r.spawns.length, 2)
    assert.deepEqual(r.spawns[0]!.child.kills, ['SIGTERM'], 'the running Claude was stopped')
    assert.ok(r.spawns[0]!.script.includes('{--tools} {Read,Edit,Write,Glob,Grep,WebFetch,WebSearch}'))
    assert.ok(r.spawns[1]!.script.includes('{--tools} {Read,Edit,Write,Glob,Grep}'), 'the stricter launch')
    assert.ok(r.spawns[1]!.script.includes(`{--session-id} {${PIN}}`), 'the same conversation (no transcript in this scratch home)')
    assert.ok(!r.events().some((e) => e.event === 'lane_failed'))
  } finally {
    r.cleanup()
  }
})

test('a LOOSER policy waits for the lane\'s next idle moment, then restarts onto the looser launch', async () => {
  const r = rig()
  try {
    const policies = [{ v: 1 }, { v: 1, webFetch: true }]
    let restartedAt = 0
    let quietFrom = 0
    const done = run(r, {
      launchFacts: async () => ({ policy: policies.shift() ?? { v: 1 }, read: true }),
      onSpawn: (_c, n) => {
        if (n === 1) {
          writeLaneJson(r, { lastActivityAtMs: r.clock.t, inFlight: true, inFlightSinceMs: r.clock.t })
          restart(r, { reasons: ['policy_loosened'], when: 'idle', fresh: false })
          // The turn ends ten minutes later.
          const endAt = r.clock.t + 10 * 60_000
          let ticks = 0
          const tick = () => {
            if (r.spawns.length > 1 || ++ticks > 200_000) return
            if (r.clock.t >= endAt) {
              quietFrom = r.clock.t
              writeLaneJson(r, { lastActivityAtMs: r.clock.t, inFlight: false })
            } else setImmediate(tick)
          }
          setImmediate(tick)
        } else {
          restartedAt = r.clock.t
          writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' }))
        }
      },
    })
    await done
    assert.equal(r.spawns.length, 2)
    assert.ok(quietFrom > 0, 'the turn ended first')
    assert.ok(restartedAt - quietFrom >= 60_000, 'not before a quiet minute with no turn in flight')
    assert.ok(restartedAt - quietFrom < 2 * 60_000)
    assert.ok(r.spawns[1]!.script.includes('{--tools} {Read,Edit,Write,Glob,Grep,WebFetch,WebSearch}'))
  } finally {
    r.cleanup()
  }
})

test('readAgentFolder: a valid folder is listed in the settings, never argv; the home folder is refused', async () => {
  const r = rig()
  try {
    const project = join(r.home, 'agents', 'cho')
    mkdirSync(project, { recursive: true })
    await run(r, { agentFolder: project, launchFacts: async () => ({ policy: { v: 1, readAgentFolder: true }, read: true }), onSpawn: stopAfter(r, 1) })
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.deepEqual(settings.permissions.additionalDirectories, [project])
    assert.ok(settings.permissions.allow.includes(`Read(/${project}/**)`))
    assert.ok(settings.permissions.deny.includes(`Edit(/${project}/**)`))
    assert.ok(!r.spawns[0]!.script.includes(project) && !r.spawns[0]!.script.includes('--add-dir'))
    try { rmSync(r.paths.launcherLockPath) } catch { /* released */ }
    await run(r, { agentFolder: r.home, launchFacts: async () => ({ policy: { v: 1, readAgentFolder: true }, read: true }), onSpawn: stopAfter(r, 2) })
    const refused = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.equal('additionalDirectories' in refused.permissions, false, 'the home folder is never opened')
    assert.ok(!refused.permissions.allow.some((rule: string) => rule.includes(r.home) && !rule.includes('/work/')))
  } finally {
    r.cleanup()
  }
})

test('ownerMcpServers: the owner\'s own servers stay unavailable even with a grant', async () => {
  const r = rig()
  try {
    const claudeJson = { mcpServers: { mail: { command: 'mail-mcp' }, bgos: { command: 'bun', args: ['server.ts'] } } }
    await run(r, { readClaudeJson: () => claudeJson, launchFacts: async () => ({ policy: { v: 1, ownerMcpServers: true }, read: true }), onSpawn: stopAfter(r, 1) })
    const mcp = JSON.parse(readFileSync(r.paths.mcpPath, 'utf8'))
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['bgos'])
    assert.deepEqual(mcp.mcpServers.bgos.args, ['/plugin/bin/bgos-launch.mjs', '/plugin/lane-server.ts'])
    assert.equal(JSON.parse(readFileSync(r.paths.settingsPath, 'utf8')).permissions.allow.includes('mcp__mail'), false)
    assert.deepEqual(r.notices, ['owner_mcp_refused'])
    try { rmSync(r.paths.launcherLockPath) } catch { /* released */ }
    await run(r, { readClaudeJson: () => claudeJson, onSpawn: stopAfter(r, 2) })
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(r.paths.mcpPath, 'utf8')).mcpServers), ['bgos'])
  } finally {
    r.cleanup()
  }
})

test('a refused shell grant needs neither a shell scrub nor a shell hook', async () => {
  const r = rig()
  try {
    await run(r, { launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }), shellSandboxAvailable: () => false, onSpawn: stopAfter(r, 1) })
    assert.equal(r.spawns[0]!.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined)
    assert.equal('PermissionRequest' in JSON.parse(readFileSync(r.paths.settingsPath, 'utf8')).hooks, false)
  } finally {
    r.cleanup()
  }
})

test('a refused shell grant never adds Bash or a sandbox', async () => {
  const r = rig()
  try {
    await run(r, { shellSandboxAvailable: () => false, launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }), onSpawn: stopAfter(r, 1) })
    assert.ok(r.spawns[0]!.script.includes('{--tools} {Read,Edit,Write,Glob,Grep}'), 'no Bash')
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.ok(!settings.permissions.allow.includes('Bash'))
    assert.equal('sandbox' in settings, false)
    const launched = JSON.parse(readFileSync(r.paths.launchPolicyPath, 'utf8'))
    assert.equal(launched.shellRefused, 'unavailable')
    assert.equal(JSON.parse(JSON.parse(readFileSync(r.paths.mcpPath, 'utf8')).mcpServers.bgos.env.HOAI_LANE_LAUNCH_POLICY).shell, false, 'the effective policy ignores refused options')
  } finally {
    r.cleanup()
  }
})

test('the launch facts ride in the lane daemon\'s own environment (mcp.json), where the lane cannot rewrite them (review M1)', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.peopleDir, { recursive: true })
    mkdirSync(r.paths.laneDir, { recursive: true })
    writeFileSync(r.paths.allowedChoicesPath, JSON.stringify({ models: ['haiku'], efforts: ['low'] }))
    writeFileSync(r.paths.choicesPath, JSON.stringify({ model: 'haiku', effort: 'low', chatId: '5' }))
    await run(r, { launchFacts: async () => ({ policy: { v: 1, webFetch: true }, read: true }), onSpawn: stopAfter(r, 1) })
    const env = JSON.parse(readFileSync(r.paths.mcpPath, 'utf8')).mcpServers.bgos.env
    assert.deepEqual(JSON.parse(env.HOAI_LANE_LAUNCH_POLICY), { v: 1, webFetch: true, readAgentFolder: false, browser: false, shell: false, ownerMcpServers: false })
    assert.equal(env.HOAI_LANE_LAUNCH_MODEL, 'haiku')
    assert.equal(env.HOAI_LANE_LAUNCH_EFFORT, 'low')
  } finally {
    r.cleanup()
  }
})

test('the default launch facts: stored session or a minted one, lanes/me for exactly this lane, else locked', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.stateDir, { recursive: true })
    const calls: string[] = []
    const fetchFor = (me: Record<string, unknown>) => (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push(`${init.method} ${url.replace('http://127.0.0.1:9/api/v1/', '')}`)
      if (url.endsWith('/lanes/session')) {
        assert.deepEqual(JSON.parse(init.body!), { laneTicket: 'tkt_1' })
        return { ok: true, status: 201, json: async () => ({ sessionToken: 'lsess_abcdefgh123', expiresAt: '2099-01-01T00:00:00Z', lane: { pairingId: 1, assistantId: 1076, actorUserId: 'user_ana', stamp: 'person:user_ana' } }) }
      }
      assert.equal(init.headers['X-BGOS-Session'], 'lsess_abcdefgh123')
      assert.equal(init.headers['X-BGOS-Pairing'], undefined)
      return { ok: true, status: 200, json: async () => me }
    }) as never
    // No session and no ticket: nothing is fetched.
    assert.deepEqual(await defaultLaunchFacts({ paths: r.paths, assistantId: '1076', userId: 'user_ana', backendUrl: 'http://127.0.0.1:9/api/v1', fetch: fetchFor({}) }), { policy: { ...LOCKED_TOOL_POLICY }, read: false })
    assert.deepEqual(calls, [])
    writeFileSync(r.paths.ticketPath, JSON.stringify({ laneTicket: 'tkt_1', ticketExpiresAt: '2099-01-01T00:00:00Z' }))
    const me = { pairingId: 1, assistantId: 1076, actorUserId: 'user_ana', lane: 'person:user_ana', toolPolicy: { v: 1, shell: true } }
    const facts = await defaultLaunchFacts({ paths: r.paths, assistantId: '1076', userId: 'user_ana', backendUrl: 'http://127.0.0.1:9/api/v1', fetch: fetchFor(me) })
    assert.deepEqual(facts, { policy: { ...LOCKED_TOOL_POLICY, shell: true }, read: true })
    assert.deepEqual(calls, ['POST integrations/lanes/session', 'GET integrations/lanes/me'])
    assert.equal(existsSync(r.paths.ticketPath), false, 'the single use ticket is spent')
    assert.equal(JSON.parse(readFileSync(r.paths.sessionPath, 'utf8')).sessionToken, 'lsess_abcdefgh123', 'stored for the lane daemon to reuse')
    // The stored session is reused; an answer for another person is locked.
    const other = await defaultLaunchFacts({ paths: r.paths, assistantId: '1076', userId: 'user_ana', backendUrl: 'http://127.0.0.1:9/api/v1', fetch: fetchFor({ ...me, actorUserId: 'user_ben', lane: 'person:user_ben' }) })
    assert.deepEqual(other, { policy: { ...LOCKED_TOOL_POLICY }, read: false })
    assert.equal(calls.filter((c: string) => c.endsWith('lanes/session')).length, 1, 'no second mint')
  } finally {
    r.cleanup()
  }
})

test('the supervisor enables unattended permission handling', async () => {
  const r = rig()
  try {
    await run(r, { onSpawn: stopAfter(r, 1) })
    assert.match(r.spawns[0]!.script, /permission-pending/)
    assert.doesNotMatch(r.spawns[0]!.script, /inFlight/)
  } finally { r.cleanup() }
})

test('the supervisor refuses shell under inherit', async () => {
  const r = rig()
  try {
    await run(r, {
      loginMode: 'inherit',
      launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }),
      onSpawn: stopAfter(r, 1),
    })
    assert.ok(r.spawns[0]!.script.includes('{--tools} {Read,Edit,Write,Glob,Grep}'))
    assert.equal(r.spawns[0]!.env?.HOAI_LANE_LOGIN_MODE, 'inherit')
    assert.equal(r.spawns[0]!.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined)
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.equal(settings.permissions.allow.includes('Bash'), false)
    assert.equal('PermissionRequest' in settings.hooks, false)
    const launched = JSON.parse(readFileSync(r.paths.launchPolicyPath, 'utf8'))
    assert.equal(launched.policy.shell, false)
    assert.equal(launched.shellRefused, 'unavailable')
    assert.deepEqual(r.notices, ['shell_refused'])
  } finally { r.cleanup() }
})

test('a pending approval ends the launch without a crash loop', async () => {
  const r = rig()
  try {
    const result = await run(r, {
      launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }),
      onSpawn: (child) => setImmediate(() => child.emit('exit', 88)),
    })
    assert.equal(r.spawns.length, 1)
    assert.deepEqual(result, { outcome: 'failed', reason: 'permission_unavailable' })
    assert.deepEqual(r.notices, ['shell_refused', 'permission_unavailable'])
  } finally { r.cleanup() }
})

for (const shell of [false, true]) {
  test(`unattended handling is wired for ${shell ? 'shell' : 'locked'} launches`, async () => {
    const r = rig()
    try {
      mkdirSync(r.paths.laneDir, { recursive: true })
      const marker = join(r.paths.laneDir, 'permission-pending')
      writeFileSync(marker, '1')
      await run(r, {
        launchFacts: async () => ({ policy: { v: 1, shell }, read: true }),
        onSpawn: (child, n) => {
          assert.equal(existsSync(marker), false)
          assert.match(r.spawns[n - 1]!.script, /permission-pending/)
          if (n === 1) {
            writeFileSync(marker, '1')
            restart(r, { when: 'now', reasons: ['policy_tightened'], fresh: false })
          } else stopAfter(r, 2)(child, n)
        },
      })
      assert.equal(r.spawns.length, 2)
      const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
      assert.match(settings.hooks.Notification[0].matcher, /elicitation_dialog/)
      assert.match(settings.hooks.Notification[0].matcher, /elicitation_url_dialog/)
      assert.equal('PermissionRequest' in settings.hooks, false)
    } finally { r.cleanup() }
  })
}

test('unattended completion is handled once for a locked launch', async () => {
  const r = rig()
  try {
    const result = await run(r, { onSpawn: (child) => setImmediate(() => child.emit('exit', 88)) })
    assert.equal(r.spawns.length, 1)
    assert.deepEqual(result, { outcome: 'failed', reason: 'permission_unavailable' })
    assert.deepEqual(r.notices, ['permission_unavailable'])
  } finally { r.cleanup() }
})

test('locked launch settings keep their original denials', async () => {
  const r = rig()
  try {
    await run(r, { onSpawn: stopAfter(r, 1) })
    const locked = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.equal('sandbox' in locked, false)
    assert.deepEqual(locked.permissions.deny, ['AskUserQuestion'])
  } finally { r.cleanup() }
})

test('each restart keeps dontAsk and locked settings when shell is requested', async () => {
  const r = rig()
  try {
    const policies = [{ v: 1 }, { v: 1, shell: true }, { v: 1 }]
    const hookLog: boolean[] = []
    await run(r, {
      launchFacts: async () => ({ policy: policies.shift() ?? { v: 1 }, read: true }),
      onSpawn: (_c, n) => {
        hookLog.push('PermissionRequest' in JSON.parse(readFileSync(r.paths.settingsPath, 'utf8')).hooks)
        if (n < 3) restart(r, { reasons: [n === 1 ? 'policy_loosened' : 'policy_tightened'], when: 'now', fresh: false })
        else writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' }))
      },
    })
    assert.equal(r.spawns.length, 3)
    assert.deepEqual(r.spawns.map((s) => s.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB), [undefined, undefined, undefined])
    assert.deepEqual(hookLog, [false, false, false])
    for (const spawn of r.spawns) {
      assert.ok(spawn.script.includes('{--permission-mode} {dontAsk}'))
      assert.ok(spawn.script.includes('{--tools} {Read,Edit,Write,Glob,Grep}'))
    }
    assert.deepEqual(r.notices, ['shell_refused'])
  } finally { r.cleanup() }
})


for (const option of ['shell', 'ownerMcpServers']) {
  test(`a refused ${option} notice survives crashes, wakes and a login mode change without repeating`, async () => {
    const r = rig()
    const policy = { v: 1, [option]: true }
    const notice = option === 'shell' ? 'shell_refused' : 'owner_mcp_refused'
    try {
      await run(r, { launchFacts: async () => ({ policy, read: true }), onSpawn: (child, n) => { if (n < 3) setImmediate(() => child.emit('exit', 1)); else stopAfter(r, 3)(child, n) } })
      assert.equal(r.spawns.length, 3)
      assert.deepEqual(r.notices, [notice])
      await run(r, { loginMode: 'inherit', launchFacts: async () => ({ policy, read: true }), onSpawn: stopAfter(r, 4) })
      assert.deepEqual(r.notices, [notice])
      assert.equal(r.spawns[0]!.env?.CLAUDE_CODE_OAUTH_TOKEN, 'made-up-lane-token')
      assert.equal(r.spawns[3]!.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the wake really switched to inherited login')
      await run(r, { launchFacts: async () => ({ policy: { v: 1 }, read: true }), onSpawn: stopAfter(r, 5) })
      await run(r, { launchFacts: async () => ({ policy, read: true }), onSpawn: stopAfter(r, 6) })
      assert.deepEqual(r.notices, [notice, notice], 'a new grant gets one new notice')
    } finally { r.cleanup() }
  })
}


for (const option of ['shell', 'ownerMcpServers']) {
  test(`the update sweep ends an active legacy ${option} supervisor before its next wake`, async () => {
    const r = rig()
    try {
      const result = await run(r, { onSpawn: (child) => {
        writeFileSync(r.paths.launchPolicyPath, JSON.stringify({ at: 'old-launch', policy: { v: 1, [option]: true }, tools: option === 'shell' ? ['Bash'] : ['Read'], ownerServers: option === 'ownerMcpServers' ? ['runner'] : [] }))
        writeLaneJson(r, { inFlight: true, lastActivityAtMs: r.clock.t })
        assert.equal(sweepUnsafePersonLanes({ assistantId: '1076', home: r.home, log: () => {}, isSupervised: () => child.pid }), 1)
      } })
      assert.deepEqual(result, { outcome: 'stopped', reason: 'sharing_update' })
      assert.equal(r.spawns.length, 1, 'the old supervisor exits instead of relaunching its old code')
      assert.deepEqual(r.spawns[0]!.child.kills, ['SIGTERM'])
      assert.ok(r.events().some((e) => e.event === 'notice'))
      await run(r, { launchFacts: async () => ({ policy: { v: 1, shell: true, ownerMcpServers: true }, read: true }), onSpawn: stopAfter(r, 2) })
      const launch = JSON.parse(readFileSync(r.paths.launchPolicyPath, 'utf8'))
      assert.equal(launch.tools.includes('Bash'), false)
      assert.deepEqual(launch.ownerServers, [])
    } finally { r.cleanup() }
  })
}

test('a marked locked supervisor survives the owner sweep and continues its turn', async () => {
  const r = rig()
  try {
    await run(r, { onSpawn: () => {
      const launch = JSON.parse(readFileSync(r.paths.launchPolicyPath, 'utf8'))
      assert.equal(launch.supervisorVersion, 2)
      assert.equal(sweepUnsafePersonLanes({ assistantId: '1076', home: r.home, log: () => {}, isSupervised: () => 1001 }), 0)
      assert.equal(existsSync(r.paths.stopRequestPath), false)
      writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' }))
    } })
    assert.equal(r.spawns.length, 1)
  } finally { r.cleanup() }
})

for (const option of ['shell', 'ownerMcpServers']) {
  test(`a generated ${option} refusal survives failed delivery and a later wake`, async () => {
    const r = rig()
    const policy = { v: 1, [option]: true }
    try {
      let generated = 0
      const runNotice = async ({ env }: { env: Record<string, string> }) => {
        generated += 1
        const { laneEventLine } = await import('../lib/lane-core.mjs')
        writeFileSync(r.paths.eventsPath, laneEventLine({ event: 'notice', notice: env.HOAI_LANE_NOTICE, chatIds: [777] }))
        return 0
      }
      await run(r, { launchFacts: async () => ({ policy, read: true }), runNotice, onSpawn: stopAfter(r, 1) })
      const pending = JSON.parse(readFileSync(join(r.paths.laneDir, 'refused-grants.json'), 'utf8'))
      const notice = option === 'shell' ? 'shell_refused' : 'owner_mcp_refused'
      assert.equal(pending[notice], true, 'generation is recorded separately from delivery')
      let attempts = 0
      const delivered: number[] = []
      const deps = { assistantId: '1076', home: r.home, log: () => {} }
      const sinks = { report: async () => {}, notify: async (id: number) => {
        if (++attempts === 1) throw new Error('made-up temporary outage')
        delivered.push(id)
      } }
      await drainLaneEvents(deps, sinks)
      await run(r, { launchFacts: async () => ({ policy, read: true }), runNotice, onSpawn: stopAfter(r, 2) })
      await drainLaneEvents(deps, sinks)
      await drainLaneEvents(deps, sinks)
      assert.equal(generated, 1)
      assert.equal(attempts, 2)
      assert.deepEqual(delivered, [777])
    } finally { r.cleanup() }
  })
}

for (const sweep of [false, true]) {
  test(`a process with the old supervisor loaded ${sweep ? 'is retired before a later idle launch' : 'really loads a granted fixture server without the sweep'}`, async () => {
    const r = rig()
    const child = fork(join(import.meta.dirname, 'fixtures/lane-legacy/hoai-lane.mjs'), [r.home], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''
    child.stderr!.on('data', (data) => { stderr += String(data) })
    const messages: any[] = []
    child.on('message', (message) => messages.push(message))
    const finished = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`legacy fixture exited ${code}: ${stderr}`)))
    })
    // Attach a rejection handler before assertions, so cleanup cannot leave an unhandled rejection.
    void finished.catch(() => {})
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
    try {
      await waitFor(() => messages.some((m) => m.kind === 'ready'), 'old supervisor launch')
      const ready = messages.find((m) => m.kind === 'ready')
      assert.equal(ready.launch.supervisorVersion, undefined)
      assert.equal(ready.launch.policy.ownerMcpServers, false)
      assert.deepEqual(ready.launch.ownerServers, [])
      // This is the real lock file of an already running old process.
      let stopped = 0
      if (sweep) stopped = sweepUnsafePersonLanes({ assistantId: '1076', home: r.home, log: () => {} })
      child.send('grant-and-idle')
      await finished
      const done = messages.find((m) => m.kind === 'done')
      assert.equal(done.comparison, 'looser', 'the old comparison remains loaded in the process')
      if (sweep) {
        assert.equal(stopped, 1)
        assert.equal(done.launches, 1, 'no second child may load the old launch implementation')
        assert.deepEqual(done.result, { outcome: 'stopped', reason: 'sharing_update' })
        assert.deepEqual(done.servers, ['bgos'])
      } else {
        assert.equal(done.launches, 2, 'the positive control exercises the historical launch')
        assert.ok(done.servers.includes('fixture_server'))
      }
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await finished.catch(() => {})
      r.cleanup()
    }
  })
}

test('legacy generated flags stay generated without another event', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.laneDir, { recursive: true })
    writeFileSync(join(r.paths.laneDir, 'refused-grants.json'), JSON.stringify({ owner_mcp_refused: true }))
    const policy = { v: 1, ownerMcpServers: true }
    await run(r, { launchFacts: async () => ({ policy, read: true }), onSpawn: stopAfter(r, 1) })
    await run(r, { launchFacts: async () => ({ policy, read: true }), onSpawn: stopAfter(r, 2) })
    assert.deepEqual(r.notices, [])
    const generated = JSON.parse(readFileSync(join(r.paths.laneDir, 'refused-grants.json'), 'utf8')).owner_mcp_refused
    assert.equal(generated, true)
  } finally { r.cleanup() }
})

test('laneenv9: saved true flags do not generate another refusal event', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.laneDir, { recursive: true })
    writeFileSync(join(r.paths.laneDir, 'refused-grants.json'), JSON.stringify({ shell_refused: true, owner_mcp_refused: true }))
    await run(r, { launchFacts: async () => ({ policy: { v: 1, shell: true, ownerMcpServers: true }, read: true }), onSpawn: stopAfter(r, 1) })
    assert.deepEqual(r.notices, [])
  } finally { r.cleanup() }
})

test('laneenv9: a hundred grant and revoke cycles notify again once and keep two receipts per lane', async () => {
  const r = rig()
  try {
    const { laneEventLine } = await import('../lib/lane-core.mjs')
    const receiptPath = join(r.paths.laneDir, 'notice-delivery.json')
    const sent: string[] = []
    const owners: string[] = []
    const sinks = { report: async () => {}, notifyOwner: async (text: string) => { owners.push(text) }, notify: async (id: number, text: string) => { sent.push(`${id}:${text}`) } }
    const deps = { assistantId: '1076', home: r.home, log: () => {} }
    for (let cycle = 0; cycle < 100; cycle++) {
      const runNotice = async ({ env }: { env: Record<string, string> }) => {
        const event = laneEventLine({ event: 'notice', notice: env.HOAI_LANE_NOTICE, chatIds: [777] })
        // Two copies must still reach each recipient only once this grant.
        const { appendFileSync } = await import('node:fs')
        appendFileSync(r.paths.eventsPath, event + event)
        return 0
      }
      const policy = { v: 1, shell: true, ownerMcpServers: true }
      await run(r, { launchFacts: async () => ({ policy, read: true }), runNotice, onSpawn: stopAfter(r, r.spawns.length + 1) })
      await drainLaneEvents(deps, sinks)
      assert.equal(sent.length, (cycle + 1) * 2, 'each new grant reaches the person once per refusal kind')
      assert.equal(owners.length, (cycle + 1) * 2)
      const receipts = JSON.parse(readFileSync(receiptPath, 'utf8'))
      assert.ok(Object.keys(receipts).length <= 2, `cycle ${cycle}: at most two receipts`)
      assert.ok(readFileSync(receiptPath).length < 512, 'receipt bytes stay bounded')
      // Revoking only one grant must leave the other kind delivered.
      await run(r, { launchFacts: async () => ({ policy: { v: 1, ownerMcpServers: true }, read: true }), runNotice, onSpawn: stopAfter(r, r.spawns.length + 1) })
      const remaining = JSON.parse(readFileSync(receiptPath, 'utf8'))
      assert.deepEqual(Object.keys(remaining), ['owner_mcp_refused'])
      await run(r, { launchFacts: async () => ({ policy: { v: 1 }, read: true }), onSpawn: stopAfter(r, r.spawns.length + 1) })
      assert.deepEqual(JSON.parse(readFileSync(receiptPath, 'utf8')), {})
    }
  } finally { r.cleanup() }
})

for (const saved of ['false', { generated: 'true' }, { generated: false }]) {
  test(`invalid generation flag ${JSON.stringify(saved)} still generates a refusal`, async () => {
    const r = rig()
    try {
      mkdirSync(r.paths.laneDir, { recursive: true })
      writeFileSync(join(r.paths.laneDir, 'refused-grants.json'), JSON.stringify({ shell_refused: saved }))
      await run(r, { launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }), onSpawn: stopAfter(r, 1) })
      assert.deepEqual(r.notices, ['shell_refused'])
    } finally { r.cleanup() }
  })
}

test('an unread policy preserves receipts and revocation clears old id receipts for only its kind', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.laneDir, { recursive: true })
    const path = join(r.paths.laneDir, 'notice-delivery.json')
    writeFileSync(path, JSON.stringify({ oldShell: { notice: 'shell_refused', ownerDelivered: true, chatIds: [777] }, oldMcp: { notice: 'owner_mcp_refused', personDelivered: true, chatIds: [] } }))
    await run(r, { launchFacts: async () => ({ policy: { v: 1 }, read: false }), onSpawn: stopAfter(r, 1) })
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['oldMcp', 'oldShell'])
    writeFileSync(join(r.paths.laneDir, 'refused-grants.json'), JSON.stringify({ owner_mcp_refused: { generated: true, noticeId: 'oldMcp' } }))
    await run(r, { launchFacts: async () => ({ policy: { v: 1, ownerMcpServers: true }, read: true }), onSpawn: stopAfter(r, 2) })
    assert.deepEqual(r.notices, [], 'old object generation flag is retained')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { owner_mcp_refused: { ownerDelivered: false, personDelivered: true, chatIds: [] } })
  } finally { r.cleanup() }
})
