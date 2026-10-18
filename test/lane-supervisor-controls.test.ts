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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lanePaths, laneStateBody } from '../lib/lane-core.mjs'
import { LOCKED_TOOL_POLICY } from '../lib/lane-policy.mjs'
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
  spawns: Array<{ script: string; child: FakeChild }>
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
} = {}) {
  const sleep = async (ms: number) => {
    r.clock.t += ms
    await new Promise((resolve) => setImmediate(resolve))
  }
  const ids = [...(opts.ids ?? [PIN, PIN2, PIN3])]
  let pid = 7000
  return superviseLane({
    assistantId: '1076',
    userId: 'user_ana',
    home: r.home,
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
    tokenStore: { kind: 'fake', read: () => ({ ok: false, reason: 'missing' }) } as never,
    watchMs: 5_000,
    stopGraceMs: 10_000,
    gateBlock: '# gate',
    generateId: () => ids.shift() ?? '',
    launchFacts: opts.launchFacts ?? (async () => ({ policy: { ...LOCKED_TOOL_POLICY }, read: true })),
    readClaudeJson: opts.readClaudeJson ?? (() => null),
    shellSandboxAvailable: opts.shellSandboxAvailable ?? (() => true),
    agentFolder: opts.agentFolder ?? null,
    spawnExpect: (script: string) => {
      const child = new FakeChild(pid++)
      r.spawns.push({ script, child })
      opts.onSpawn?.(child, r.spawns.length)
      return child as never
    },
    runNotice: async () => 0,
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
    assert.ok(script.includes('{--tools} {Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Bash}'))
    assert.ok(!script.includes('skip-permissions'))
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.ok(settings.permissions.allow.includes('WebFetch') && settings.permissions.allow.includes('Bash'))
    const launched = JSON.parse(readFileSync(r.paths.launchPolicyPath, 'utf8'))
    assert.deepEqual(launched.policy, { v: 1, webFetch: true, readAgentFolder: false, browser: false, shell: true, ownerMcpServers: false })
    assert.equal(launched.policyRead, true)
    assert.deepEqual(launched.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash'])
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
    const policies = [{ v: 1, shell: true, webFetch: true }, { v: 1, webFetch: true }]
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
    assert.ok(r.spawns[0]!.script.includes('Bash}'))
    assert.ok(r.spawns[1]!.script.includes('{--tools} {Read,Edit,Write,Glob,Grep,WebFetch,WebSearch}'), 'the stricter launch')
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

test('ownerMcpServers: the owner\'s own servers are loaded and allowed by name; off, none', async () => {
  const r = rig()
  try {
    const claudeJson = { mcpServers: { mail: { command: 'mail-mcp' }, bgos: { command: 'bun', args: ['server.ts'] } } }
    await run(r, { readClaudeJson: () => claudeJson, launchFacts: async () => ({ policy: { v: 1, ownerMcpServers: true }, read: true }), onSpawn: stopAfter(r, 1) })
    const mcp = JSON.parse(readFileSync(r.paths.mcpPath, 'utf8'))
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['bgos', 'mail'])
    assert.deepEqual(mcp.mcpServers.bgos.args, ['/plugin/bin/bgos-launch.mjs', '/plugin/lane-server.ts'])
    assert.ok(JSON.parse(readFileSync(r.paths.settingsPath, 'utf8')).permissions.allow.includes('mcp__mail'))
    try { rmSync(r.paths.launcherLockPath) } catch { /* released */ }
    await run(r, { readClaudeJson: () => claudeJson, onSpawn: stopAfter(r, 2) })
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(r.paths.mcpPath, 'utf8')).mcpServers), ['bgos'])
  } finally {
    r.cleanup()
  }
})

test('shell launches under the Bash sandbox with this machine\'s secrets, other lanes and the control files denied; off, no sandbox', async () => {
  const r = rig()
  try {
    const ben = join(r.home, '.bgos-agent', '1076', 'people', 'user_ben')
    const cy = join(r.home, '.bgos-agent', '900', 'people', 'user_cy')
    mkdirSync(ben, { recursive: true })
    mkdirSync(cy, { recursive: true })
    await run(r, { launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }), onSpawn: stopAfter(r, 1) })
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.deepEqual(settings.sandbox, { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false })
    for (const rule of [`Read(/${ben}/**)`, `Read(/${cy}/**)`, `Read(/${r.paths.mcpPath})`, `Read(/${join(r.home, '.bgos-plugin-state')}/**)`, `Read(/${join(r.home, '.bgos-agent')}/*.json)`]) {
      assert.ok(settings.permissions.deny.includes(rule), `${rule} is denied`)
    }
    assert.ok(!settings.permissions.deny.some((rule: string) => rule.includes(`${r.paths.laneDir}/**`)), 'the lane itself is not denied wholesale')
    assert.ok(settings.permissions.allow.includes('Bash'))
    try { rmSync(r.paths.launcherLockPath) } catch { /* released */ }
    await run(r, { onSpawn: stopAfter(r, 2) })
    const locked = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.equal('sandbox' in locked, false)
    assert.deepEqual(locked.permissions.deny, ['AskUserQuestion'])
  } finally {
    r.cleanup()
  }
})

test('shell on a host with no Bash sandbox: no Bash at all, never an unconfined one (round 2, N1)', async () => {
  const r = rig()
  try {
    await run(r, { shellSandboxAvailable: () => false, launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }), onSpawn: stopAfter(r, 1) })
    assert.ok(r.spawns[0]!.script.includes('{--tools} {Read,Edit,Write,Glob,Grep}'), 'no Bash')
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.ok(!settings.permissions.allow.includes('Bash'))
    assert.equal('sandbox' in settings, false)
    const launched = JSON.parse(readFileSync(r.paths.launchPolicyPath, 'utf8'))
    assert.equal(launched.shellRefused, 'no_sandbox')
    assert.equal(JSON.parse(JSON.parse(readFileSync(r.paths.mcpPath, 'utf8')).mcpServers.bgos.env.HOAI_LANE_LAUNCH_POLICY).shell, true, 'the served policy, so it is not taken for looser later')
  } finally {
    r.cleanup()
  }
})

test('a shell lane restarts at once when another person\'s lane appears, onto denials that name it (round 2, N2)', async () => {
  const r = rig()
  try {
    const ben = join(r.home, '.bgos-agent', '1076', 'people', 'user_ben')
    await run(r, {
      launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }),
      onSpawn: (_c, n) => {
        if (n === 1) mkdirSync(ben, { recursive: true })
        else writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' }))
      },
    })
    assert.equal(r.spawns.length, 2, 'restarted once the new lane appeared')
    assert.deepEqual(r.spawns[0]!.child.kills, ['SIGTERM'])
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.ok(settings.permissions.deny.includes(`Read(/${ben}/**)`), 'the new lane is now denied')
    assert.ok(!r.events().some((e) => e.event === 'lane_failed'))
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
