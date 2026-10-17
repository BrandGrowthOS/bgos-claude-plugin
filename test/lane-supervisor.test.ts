/**
 * PERSON LANES, the supervisor of one lane (shared agents Phase 3, P3;
 * design 4.2, decisions K2 and K6). Driven end to end with a real scratch
 * home and a fake `expect` child, so every rule is held without a CLI:
 *
 *   - two wakes for ONE person start ONE Claude (the singleton);
 *   - IDLE STOP: 20 minutes with no turn in flight stops the lane, keeps its
 *     pin, reports `lane_stopped`; a turn in flight keeps it running;
 *   - CRASH RELAUNCH: Claude exiting on its own is relaunched with the SAME
 *     pin, `--resume` once the transcript exists, at most 3 times an hour,
 *     then `lane_failed`;
 *   - a stop request (revoke, eviction, the lane daemon) stops it cleanly;
 *   - K2 (a) inherit: the lane signs in exactly as the owner, CLAUDE_CONFIG_DIR
 *     only if the owner had it;
 *   - K2 (b) own token: the lane's own config folder and the token from the
 *     store; a MISSING token never starts Claude and never falls back to the
 *     owner's login (notice mode, then `lane_failed`); a token Claude refuses
 *     (signed out) is a notice and `lane_failed`, never a retry;
 *   - caps: busy answers `lane_busy` without a Claude; over the agent cap the
 *     least recently used idle lane is asked to stop.
 *
 * Run with: npx tsx --test test/lane-supervisor.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lanePaths, laneStateBody } from '../lib/lane-core.mjs'
import { writeLoginMode } from '../lib/lane-login.mjs'
import { laneArgsTclSafe, superviseLane } from '../lib/lane-supervisor.mjs'
import { EXIT_SUPERVISED_SIGNED_OUT, sessionTranscriptPath } from '../bin/hoai-core.mjs'

const PIN = '11111111-2222-4333-8444-555555555555'
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
  exitOnItsOwn(code: number): void {
    setImmediate(() => this.emit('exit', code))
  }
}

interface Rig {
  home: string
  paths: ReturnType<typeof lanePaths>
  spawns: Array<{ script: string; env: Record<string, string>; child: FakeChild }>
  notices: Array<Record<string, string>>
  clock: { t: number }
  events: () => Array<{ event: string }>
  cleanup: () => void
}

function rig(userId = 'user_ana', assistantId = '1076'): Rig {
  const home = mkdtempSync(join(tmpdir(), 'lane-sup-'))
  const paths = lanePaths({ home, assistantId, userId })
  return {
    home,
    paths,
    spawns: [],
    notices: [],
    clock: { t: Date.parse('2026-10-17T10:00:00Z') },
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
  selfPid?: number
  ownerEnv?: Record<string, string>
  onSpawn?: (child: FakeChild, n: number) => void
  tokenStore?: { kind: string; read: () => { ok: boolean; token?: string; reason?: string } }
  isAlive?: (pid: number) => boolean
  userId?: string
  availableBytes?: number
} = {}) {
  const sleep = async (ms: number) => {
    r.clock.t += ms
    await new Promise((resolve) => setImmediate(resolve))
  }
  let pid = 5000
  return superviseLane({
    assistantId: '1076',
    userId: opts.userId ?? 'user_ana',
    home: r.home,
    ownerEnv: opts.ownerEnv ?? { PATH: '/usr/bin:/bin', HOME: r.home, USER: 'owner' },
    backendUrl: 'http://127.0.0.1:8971/api/v1',
    pluginRoot: '/plugin',
    nodePath: '/usr/local/bin/node',
    claudePath: '/usr/local/bin/claude',
    platform: 'darwin',
    now: () => r.clock.t,
    sleep,
    selfPid: opts.selfPid ?? 1001,
    isAlive: opts.isAlive ?? ((p: number) => p === 1001 || p === 1002 || p === (opts.selfPid ?? 1001)),
    availableBytes: () => opts.availableBytes ?? 64 * GiB,
    tokenStore: (opts.tokenStore ?? { kind: 'fake', read: () => ({ ok: false, reason: 'missing' }) }) as never,
    watchMs: 5_000,
    stopGraceMs: 10_000,
    gateBlock: '# gate',
    generateId: () => PIN,
    spawnExpect: (script: string, { env }: { env: Record<string, string> }) => {
      const child = new FakeChild(pid++)
      r.spawns.push({ script, env, child })
      opts.onSpawn?.(child, r.spawns.length)
      return child as never
    },
    runNotice: async ({ env }: { env: Record<string, string> }) => {
      r.notices.push(env)
      return 0
    },
  })
}

function writeLaneJson(r: Rig, fields: { lastActivityAtMs: number | null; inFlight: boolean; inFlightSinceMs?: number | null }) {
  mkdirSync(r.paths.laneDir, { recursive: true })
  writeFileSync(r.paths.laneJsonPath, JSON.stringify(laneStateBody({ userId: 'user_ana', assistantId: '1076', loginMode: 'inherit', ...fields })))
}

test('two wakes for one person start ONE Claude: the second supervisor leaves', async () => {
  const r = rig()
  try {
    const first = run(r, { selfPid: 1001, onSpawn: (_c, n) => { if (n === 1) writeLaneJson(r, { lastActivityAtMs: r.clock.t, inFlight: true, inFlightSinceMs: r.clock.t }) } })
    while (r.spawns.length === 0) await new Promise((resolve) => setImmediate(resolve))
    const second = await run(r, { selfPid: 1002 })
    assert.deepEqual(second, { outcome: 'already_running' })
    assert.equal(r.spawns.length, 1, 'one Claude for one lane')
    writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'revoked' }))
    assert.deepEqual(await first, { outcome: 'stopped', reason: 'revoked' })
    assert.deepEqual(r.spawns[0].child.kills, ['SIGTERM'])
    assert.deepEqual(r.events().map((e) => e.event), ['lane_stopped'])
    assert.ok(!existsSync(r.paths.stopRequestPath), 'the request is consumed')
    assert.ok(!existsSync(r.paths.launcherLockPath), 'the lock is released')
  } finally {
    r.cleanup()
  }
})

test('the locked launch is what the supervisor runs: never skip permissions, the lane files in place', async () => {
  const r = rig()
  try {
    const done = run(r, { onSpawn: () => writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' })) })
    await done
    const { script } = r.spawns[0]
    assert.ok(script.includes('spawn "/usr/local/bin/claude" {--restricted} {--strict-mcp-config}'), 'the claude path Tcl quoted')
    assert.ok(!script.includes('skip-permissions'))
    assert.ok(script.includes('{--permission-mode} {dontAsk}'))
    assert.ok(script.includes(`{--session-id} {${PIN}}`), 'no transcript yet: --session-id with the pin')
    const settings = JSON.parse(readFileSync(r.paths.settingsPath, 'utf8'))
    assert.equal(settings.remoteControlAtStartup, false)
    assert.equal((statSync(r.paths.settingsPath).mode & 0o077), 0, 'lane files are private')
    const mcp = JSON.parse(readFileSync(r.paths.mcpPath, 'utf8'))
    assert.deepEqual(Object.keys(mcp.mcpServers), ['bgos'])
    assert.equal(mcp.mcpServers.bgos.env.BGOS_LANE_USER_ID, 'user_ana')
    assert.equal(readFileSync(r.paths.sessionIdPath, 'utf8').trim(), PIN)
  } finally {
    r.cleanup()
  }
})

test('IDLE STOP: 20 minutes with no turn in flight stops the lane and keeps its pin', async () => {
  const r = rig()
  try {
    const started = r.clock.t
    const outcome = await run(r, { onSpawn: () => writeLaneJson(r, { lastActivityAtMs: started, inFlight: false }) })
    assert.deepEqual(outcome, { outcome: 'stopped', reason: 'idle' })
    assert.ok(r.clock.t - started >= 20 * 60_000, 'not before 20 minutes')
    assert.ok(r.clock.t - started < 21 * 60_000, 'and soon after')
    assert.deepEqual(r.spawns[0].child.kills, ['SIGTERM'])
    assert.deepEqual(r.events().map((e) => e.event), ['lane_stopped'])
    assert.equal(readFileSync(r.paths.sessionIdPath, 'utf8').trim(), PIN, 'the pin survives, so the next message resumes')
  } finally {
    r.cleanup()
  }
})

test('IDLE STOP: a turn in flight keeps the lane running past 20 minutes', async () => {
  const r = rig()
  try {
    const started = r.clock.t
    let settled = false
    const outcome = run(r, { onSpawn: () => writeLaneJson(r, { lastActivityAtMs: started, inFlight: true, inFlightSinceMs: started }) })
    void outcome.then(() => { settled = true })
    // The fake clock only moves while the supervisor watches; a lane that
    // stopped early settles the run and ends this wait.
    while (!settled && r.clock.t - started < 30 * 60_000) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false, 'the lane must not stop while a turn is in flight')
    assert.deepEqual(r.spawns[0].child.kills, [], 'still running at 30 minutes with a turn in flight')
    writeLaneJson(r, { lastActivityAtMs: r.clock.t, inFlight: false })
    assert.deepEqual(await outcome, { outcome: 'stopped', reason: 'idle' })
  } finally {
    r.cleanup()
  }
})

test('CRASH RELAUNCH: the same pin, --resume once the transcript exists, 3 an hour, then lane_failed', async () => {
  const r = rig()
  try {
    const transcript = sessionTranscriptPath(r.home, r.paths.workDir, PIN, '')
    const outcome = await run(r, {
      onSpawn: (child, n) => {
        if (n === 1) {
          // The first turn wrote the transcript, then Claude crashed.
          mkdirSync(join(transcript, '..'), { recursive: true })
          writeFileSync(transcript, '{}\n')
        }
        child.exitOnItsOwn(1)
      },
    })
    assert.deepEqual(outcome, { outcome: 'failed', reason: 'crash_loop' })
    assert.equal(r.spawns.length, 4, 'the first launch and three relaunches')
    assert.ok(r.spawns[0].script.includes(`{--session-id} {${PIN}}`))
    for (const s of r.spawns.slice(1)) assert.ok(s.script.includes(`{--resume} {${PIN}}`), 'relaunched with the SAME pin')
    assert.deepEqual(r.events().map((e) => e.event), ['lane_failed'])
  } finally {
    r.cleanup()
  }
})

test('CRASH RELAUNCH: a crash an hour after the last ones is relaunched again', async () => {
  const r = rig()
  try {
    let n = 0
    const outcome = run(r, {
      onSpawn: (child) => {
        n += 1
        if (n <= 3) child.exitOnItsOwn(1)
        else if (n === 4) {
          r.clock.t += 61 * 60_000
          child.exitOnItsOwn(1)
        } else writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'requested' }))
      },
    })
    assert.deepEqual(await outcome, { outcome: 'stopped', reason: 'requested' })
    assert.equal(r.spawns.length, 5)
  } finally {
    r.cleanup()
  }
})

test('K2 (a) inherit: the lane signs in as the owner; CLAUDE_CONFIG_DIR only if the owner had it', async () => {
  const r = rig()
  try {
    await run(r, { onSpawn: () => writeFileSync(r.paths.stopRequestPath, '{"reason":"requested"}') })
    assert.equal('CLAUDE_CONFIG_DIR' in r.spawns[0].env, false)
    assert.equal(r.spawns[0].env.HOAI_LANE_LOGIN_MODE, 'inherit')
    assert.ok(!r.spawns[0].script.includes('--debug-file'), 'no debug log under the owner\'s login')
    const r2 = rig()
    try {
      await run(r2, {
        ownerEnv: { PATH: '/usr/bin', HOME: r2.home, CLAUDE_CONFIG_DIR: '/Users/owner/.claude-x' },
        onSpawn: () => writeFileSync(r2.paths.stopRequestPath, '{"reason":"requested"}'),
      })
      assert.equal(r2.spawns[0].env.CLAUDE_CONFIG_DIR, '/Users/owner/.claude-x')
    } finally {
      r2.cleanup()
    }
  } finally {
    r.cleanup()
  }
})

test('K2 (b) own token: the lane\'s own config folder and the stored token, never the owner\'s login', async () => {
  const r = rig()
  try {
    writeLoginMode(r.paths.loginModesPath, 'user_ana', 'own_token')
    const token = 'sk-ant-oat01-STANDIN-not-a-real-token'
    await run(r, {
      ownerEnv: { PATH: '/usr/bin', HOME: r.home, ANTHROPIC_API_KEY: 'owner-key', CLAUDE_CODE_OAUTH_TOKEN: 'owner-token' },
      tokenStore: { kind: 'fake', read: () => ({ ok: true, token }) },
      onSpawn: () => writeFileSync(r.paths.stopRequestPath, '{"reason":"requested"}'),
    })
    const env = r.spawns[0].env
    assert.ok(r.spawns[0].script.includes(`{--debug-file} {${r.paths.claudeDebugPath}}`), 'where the CLI names a refused token')
    assert.equal(env.CLAUDE_CONFIG_DIR, r.paths.configDir)
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token)
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.HOAI_LANE_LOGIN_MODE, 'own_token')
    const seed = JSON.parse(readFileSync(join(r.paths.configDir, '.claude.json'), 'utf8'))
    assert.equal(seed.hasCompletedOnboarding, true)
    assert.equal(seed.projects[r.paths.workDir].hasTrustDialogAccepted, true)
    assert.ok(!readFileSync(join(r.paths.configDir, '.claude.json'), 'utf8').includes(token), 'the token is never written to disk')
    assert.ok(!readFileSync(r.paths.mcpPath, 'utf8').includes(token), 'nor into the lane\'s mcp config')
  } finally {
    r.cleanup()
  }
})

test('K2 (b) own token MISSING: Claude never starts, the owner\'s login is never used, the person is told', async () => {
  const r = rig()
  try {
    writeLoginMode(r.paths.loginModesPath, 'user_ana', 'own_token')
    const outcome = await run(r, {
      ownerEnv: { PATH: '/usr/bin', HOME: r.home, CLAUDE_CODE_OAUTH_TOKEN: 'owner-token', ANTHROPIC_API_KEY: 'owner-key' },
      tokenStore: { kind: 'fake', read: () => ({ ok: false, reason: 'missing' }) },
    })
    assert.deepEqual(outcome, { outcome: 'failed', reason: 'login_token_missing' })
    assert.equal(r.spawns.length, 0, 'no Claude at all, so no silent fallback to the owner\'s login')
    assert.equal(r.notices.length, 1)
    const env = r.notices[0]
    assert.equal(env.HOAI_LANE_NOTICE, 'login_token_missing')
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']) assert.equal(env[name], undefined)
    assert.deepEqual(r.events().map((e) => e.event), ['lane_failed'])
  } finally {
    r.cleanup()
  }
})

test('K2 (b) a token Claude refuses (signed out): a notice and lane_failed, never a retry', async () => {
  const r = rig()
  try {
    writeLoginMode(r.paths.loginModesPath, 'user_ana', 'own_token')
    const outcome = await run(r, {
      tokenStore: { kind: 'fake', read: () => ({ ok: true, token: 'sk-ant-oat01-STANDIN-expired-token' }) },
      onSpawn: (child) => child.exitOnItsOwn(EXIT_SUPERVISED_SIGNED_OUT),
    })
    assert.deepEqual(outcome, { outcome: 'failed', reason: 'signed_out' })
    assert.equal(r.spawns.length, 1, 'not relaunched on any other login')
    assert.equal(r.notices[0].HOAI_LANE_NOTICE, 'login_token_failed')
    assert.deepEqual(r.events().map((e) => e.event), ['lane_failed'])
  } finally {
    r.cleanup()
  }
})

test('K2 (b) the lane daemon saw the token refused: the stop is lane_failed, not lane_stopped', async () => {
  const r = rig()
  try {
    const outcome = await run(r, { onSpawn: () => writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'login_failed', by: 'lane-daemon' })) })
    assert.deepEqual(outcome, { outcome: 'failed', reason: 'login_failed' })
    assert.deepEqual(r.events().map((e) => e.event), ['lane_failed'])
  } finally {
    r.cleanup()
  }
})

test('a revoke that landed while the supervisor was starting: it does not start (the marker only a fresh wake clears)', async () => {
  const r = rig()
  try {
    mkdirSync(r.paths.laneDir, { recursive: true })
    writeFileSync(r.paths.revokedPath, JSON.stringify({ reason: 'revoked' }))
    writeFileSync(r.paths.stopRequestPath, JSON.stringify({ reason: 'revoked' }))
    assert.deepEqual(await run(r), { outcome: 'stopped', reason: 'revoked' })
    assert.equal(r.spawns.length, 0)
    assert.ok(!existsSync(r.paths.launcherLockPath))
  } finally {
    r.cleanup()
  }
})

test('a lane argument a Tcl brace word cannot carry is refused, never launched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lane-sup-{brace}-'))
  const base = rig()
  base.cleanup()
  const r = { ...base, home, paths: lanePaths({ home, assistantId: '1076', userId: 'user_ana' }) } as Rig
  try {
    const outcome = await run(r)
    assert.deepEqual(outcome, { outcome: 'failed', reason: 'unsafe_args' })
    assert.equal(r.spawns.length, 0)
    assert.equal(laneArgsTclSafe(['--x', '/a b/c']), true)
    assert.equal(laneArgsTclSafe(['/a}b']), false)
    assert.equal(laneArgsTclSafe(['C:\\x']), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function seedRegistry(r: Rig, entries: Array<{ userId: string; pid: number; inFlight: boolean; last: number }>) {
  mkdirSync(join(r.home, '.bgos-agent'), { recursive: true })
  writeFileSync(r.paths.machineRegistryPath, JSON.stringify({
    v: 1,
    lanes: entries.map((e) => ({ assistantId: '1076', userId: e.userId, supervisorPid: e.pid, startedAt: '2026-10-17T09:00:00Z' })),
  }))
  for (const e of entries) {
    const p = lanePaths({ home: r.home, assistantId: '1076', userId: e.userId })
    mkdirSync(p.laneDir, { recursive: true })
    writeFileSync(p.laneJsonPath, JSON.stringify(laneStateBody({ userId: e.userId, assistantId: '1076', lastActivityAtMs: e.last, inFlight: e.inFlight, loginMode: 'inherit' })))
  }
}

test('caps: with both lanes of the agent busy, lane_busy and no Claude', async () => {
  const r = rig('user_cy')
  try {
    seedRegistry(r, [
      { userId: 'user_ana', pid: 2001, inFlight: true, last: r.clock.t },
      { userId: 'user_ben', pid: 2002, inFlight: true, last: r.clock.t },
    ])
    const outcome = await run(r, { userId: 'user_cy', isAlive: (p) => [1001, 2001, 2002].includes(p) })
    assert.deepEqual(outcome, { outcome: 'busy', reason: 'agent' })
    assert.equal(r.spawns.length, 0)
    assert.deepEqual(r.events().map((e) => e.event), ['lane_busy'])
  } finally {
    r.cleanup()
  }
})

test('caps: over the agent cap, the least recently used IDLE lane is asked to stop and the new one starts', async () => {
  const r = rig('user_cy')
  try {
    seedRegistry(r, [
      { userId: 'user_ana', pid: 2001, inFlight: false, last: r.clock.t - 60_000 },
      { userId: 'user_ben', pid: 2002, inFlight: false, last: r.clock.t - 600_000 },
    ])
    const outcome = await run(r, {
      userId: 'user_cy',
      isAlive: (p) => [1001, 2001, 2002].includes(p),
      onSpawn: () => writeFileSync(r.paths.stopRequestPath, '{"reason":"requested"}'),
    })
    assert.equal(outcome.outcome, 'stopped')
    const ben = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ben' })
    const ana = lanePaths({ home: r.home, assistantId: '1076', userId: 'user_ana' })
    assert.equal(JSON.parse(readFileSync(ben.stopRequestPath, 'utf8')).reason, 'evicted')
    assert.ok(!existsSync(ana.stopRequestPath))
    assert.equal(r.spawns.length, 1)
  } finally {
    r.cleanup()
  }
})
