/**
 * The home claim (HOAI board row 01a072c5): on a host paired for ONE agent,
 * the session that boots first must not keep the agent's channel unless it is
 * that agent.
 *
 * THE RESIDUAL AFTER #119 AND 0.65.0. The pairing lock (`<credentials>.lock`,
 * the per host record of which session is the agent's live daemon) records
 * how its holder found its identity, and a pinned daemon takes it back from a
 * holder that came by elimination. Two holes were left, and both are about
 * the agent id the pairing was made for, which the lock never looked at:
 *
 *   1. The shared legacy file. On a host paired with `credentials.json` (the
 *      layout from before per agent files, still read on old hosts and by
 *      bgos-claim agents), the real agent started from its pinned folder, or by
 *      hoai with BGOS_ASSISTANT_ID, resolves through ownOrNothing to that file
 *      with via 'legacy'. Its lock route is then 'elimination', the same word a
 *      stray in any other folder records, so a stray that booted first keeps
 *      the channel and the real agent runs passive behind it, as a guest. Its
 *      home binding also treats it as an elimination start: it can never
 *      confirm its folder as home, and a home recorded elsewhere refuses it.
 *   2. A session that names a DIFFERENT agent. A worker that inherited
 *      BGOS_CREDENTIALS_PATH (the agent's file) but runs with its own
 *      BGOS_ASSISTANT_ID resolves to the agent's file by the env path, records
 *      route 'env' (pinned), and takes the lock. The real agent, pinned to
 *      the agent, never takes a lock from a pinned holder (Data's guard), so
 *      it stays passive for as long as the worker lives.
 *
 * THE RULE. The claim requires the agent id the host was paired for, the
 * assistantId in the pairing credentials. A session that names an agent
 * (BGOS_ASSISTANT_ID, else its folder pin, in the resolver's own order) and
 * names a different one never takes or overwrites the lock. A session that
 * names the paired agent is pinned to it even through the shared file, so it
 * takes the lock back from a stray holder. Two sessions that both name it
 * keep today's rule: neither takes the lock from the other.
 *
 * WHAT THIS DRIVES. The same lib calls server.ts makes, in its order, over
 * real temp files: resolveCredentialsSelection, loadCredentialsFile,
 * decideSessionClaim, decideHomeBinding, acquirePairingLock, then per held
 * tick refreshPairingLockDetailed and homeStepWhileHolding. Only the pid probe
 * is a stand-in. The credentials lib is imported as a namespace so the same
 * file runs on main, where decideSessionClaim is undefined and the boot falls
 * back to main's wiring (the resolver's via, lockRouteFor): there the race
 * assertions fail on behaviour, which is the red run.
 *
 * Run: npx tsx --test test/home-claim.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as credentials from '../lib/agent-credentials.ts'
import * as pairingLock from '../lib/pairing-lock.ts'
import {
  acquirePairingLock,
  defaultLockIo,
  pairingLockPath,
  refreshPairingLockDetailed,
  type LockIo,
} from '../lib/pairing-lock.ts'

const AGENT_ID = '1040'
const OTHER_ID = '2077'
const STRAY_PID = 51001
const AGENT_PID = 51002
const SECOND_PID = 51003
const T0 = 1_770_000_000_000

type Lib = Record<string, any>
const lib = credentials as unknown as Lib
const lockLib = pairingLock as unknown as Lib
type Env = Record<string, string | undefined>

/**
 * One computer paired for one agent. `layout` 'legacy' writes the shared
 * ~/.bgos-agent/credentials.json; 'per-agent' writes credentials-<id>.json.
 */
function makeHost(layout: 'legacy' | 'per-agent') {
  const root = mkdtempSync(join(tmpdir(), 'home-claim-'))
  const agentDir = join(root, 'home', '.bgos-agent')
  const agentFolder = join(root, 'agents', 'ares')
  const repo = join(root, 'code', 'bgos-repo')
  const workerFolder = join(root, 'code', 'worker')
  for (const dir of [agentDir, agentFolder, repo, workerFolder]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(agentFolder, '.bgos-agent-id'), `${AGENT_ID}\n`)
  const defaultPath = join(agentDir, 'credentials.json')
  const credentialsPath = layout === 'legacy' ? defaultPath : join(agentDir, `credentials-${AGENT_ID}.json`)
  writeFileSync(
    credentialsPath,
    `${JSON.stringify(
      {
        backendUrl: 'https://backend.invalid/api/v1',
        pairingToken: 'home-claim-token',
        pairingId: 91,
        userId: 'user_claim',
        assistantId: Number(AGENT_ID),
        pairedAt: '2026-08-01T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
  )
  const alive = new Set<number>()
  const io: LockIo = { ...defaultLockIo, isProcessAlive: (pid) => alive.has(pid) }
  return {
    root,
    defaultPath,
    credentialsPath,
    lockPath: pairingLockPath(credentialsPath),
    agentFolder,
    repo,
    workerFolder,
    alive,
    io,
    readFile: () => JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

type Host = ReturnType<typeof makeHost>

/** A daemon booting in `cwd` with `env`, wired as server.ts wires it. */
function bootDaemon(host: Host, cwd: string, pid: number, nowMs: number, env: Env = {}) {
  host.alive.add(pid)
  const selection = credentials.resolveCredentialsSelection({ env, defaultPath: host.defaultPath, cwd })
  assert.equal(selection.kind, 'ok', 'a one agent computer never refuses at selection')
  if (selection.kind !== 'ok') throw new Error('unreachable')
  const file = credentials.loadCredentialsFile(selection.path)
  const folderPinId = credentials.readFolderPinId(cwd)
  const claim = lib.decideSessionClaim?.({
    via: selection.via,
    env,
    folderPinId,
    pairedAssistantId: file?.assistantId,
  })
  const via = claim?.via ?? selection.via
  const route = claim?.lockRoute ?? credentials.lockRouteFor(selection.via)
  const binding = credentials.decideHomeBinding({
    via,
    cwd,
    recordedHomeDir: file?.homeDir ?? null,
    recordedHomeSource: file?.homeSource ?? null,
    folderPinId,
    assistantId: String(file?.assistantId ?? ''),
    env,
  })
  const daemon = {
    cwd,
    pid,
    env,
    bootedAt: nowMs,
    resolvedVia: selection.via,
    path: selection.path,
    binding,
    route,
    held: false,
    homeDone: false,
    lockReason: undefined as string | undefined,
  }
  if (binding.action === 'refuse') return daemon
  const lock = acquirePairingLock({
    lockPath: pairingLockPath(selection.path),
    selfPid: pid,
    now: nowMs,
    bootedAt: nowMs,
    route,
    io: host.io,
  } as Parameters<typeof acquirePairingLock>[0])
  daemon.held = lock.acquired
  daemon.lockReason = lock.reason
  return daemon
}

type Daemon = ReturnType<typeof bootDaemon>

/** A passive daemon's recheck (server.ts resumeLockRecheck), every 5 s. */
function recheck(host: Host, daemon: Daemon, nowMs: number): void {
  if (daemon.held || daemon.binding.action === 'refuse') return
  const lock = acquirePairingLock({
    lockPath: pairingLockPath(daemon.path),
    selfPid: daemon.pid,
    now: nowMs,
    bootedAt: daemon.bootedAt,
    route: daemon.route,
    io: host.io,
  } as Parameters<typeof acquirePairingLock>[0])
  if (lock.acquired) {
    daemon.held = true
    daemon.lockReason = lock.reason
  }
}

/** One held poll tick: the lock refresh, then the home step. */
function heldTick(host: Host, daemon: Daemon, nowMs: number): void {
  if (!daemon.held) return
  const refreshed = refreshPairingLockDetailed({
    lockPath: pairingLockPath(daemon.path),
    selfPid: daemon.pid,
    now: nowMs,
    bootedAt: daemon.bootedAt,
    route: daemon.route,
    io: host.io,
  } as Parameters<typeof refreshPairingLockDetailed>[0])
  if (!refreshed.held) {
    daemon.held = false
    return
  }
  if (daemon.homeDone) return
  daemon.homeDone = credentials.homeStepWhileHolding({ binding: daemon.binding, path: daemon.path }).done
}

/** Run every daemon's tick (held or recheck) from `fromMs` to `toMs`, every 5 s. */
function run(host: Host, daemons: Daemon[], fromMs: number, toMs: number): void {
  for (let now = fromMs; now <= toMs; now += 5_000) {
    for (const d of daemons) {
      if (d.held) heldTick(host, d, now)
      else recheck(host, d, now)
    }
  }
}

function lockHolderPid(host: Host): number | null {
  if (!existsSync(host.lockPath)) return null
  return pairingLock.parseLockRecord(readFileSync(host.lockPath, 'utf8'))?.pid ?? null
}

// ── 1. The race on the shared legacy file: stray first, real agent second ────

for (const start of [
  { name: 'from its pinned folder', env: {} as Env, route: 'pin' },
  { name: 'by hoai with BGOS_ASSISTANT_ID', env: { BGOS_ASSISTANT_ID: AGENT_ID } as Env, route: 'env' },
]) {
  test(`legacy file race: a stray boots first, the real agent started ${start.name} takes the channel back`, () => {
    const host = makeHost('legacy')
    try {
      // 1. The agent is down. A bare claude in the repo boots first and holds the channel.
      const stray = bootDaemon(host, host.repo, STRAY_PID, T0)
      assert.equal(stray.resolvedVia, 'legacy')
      assert.equal(stray.route, 'elimination', 'the stray names no agent: it found this one by elimination')
      assert.equal(stray.held, true, 'the channel is free, so the stray takes it (today\'s rule)')
      run(host, [stray], T0 + 5_000, T0 + 65_000)
      assert.equal(host.readFile().homeDir, undefined, 'a stray never writes the home')

      // 2. The real agent starts. It names the agent the host was paired for.
      const agent = bootDaemon(host, host.agentFolder, AGENT_PID, T0 + 70_000, start.env)
      assert.equal(agent.resolvedVia, 'legacy', 'the resolver reaches the shared file through ownOrNothing')
      assert.notEqual(agent.binding.action, 'refuse')
      assert.equal(agent.held, true, 'the real agent takes the channel back from the stray')
      assert.equal(agent.lockReason, 'route-takeover')
      assert.equal(agent.route, start.route, 'it is pinned to the paired agent, not an elimination start')

      // 3. The stray learns it on its next heartbeat, stands down, and cannot take it back.
      run(host, [stray, agent], T0 + 75_000, T0 + 120_000)
      assert.equal(stray.held, false, 'the stray stands down')
      assert.equal(agent.held, true, 'and the agent keeps the channel')
      assert.equal(lockHolderPid(host), AGENT_PID)

      // 4. Started from its pinned folder, it confirms that folder as its home.
      if (start.route === 'pin') {
        assert.equal(host.readFile().homeDir, host.agentFolder)
        assert.equal(host.readFile().homeSource, 'pin')
        assert.equal(host.readFile().pairingToken, 'home-claim-token', 'the token is carried through untouched')
      }
    } finally {
      host.cleanup()
    }
  })
}

test('legacy file: a home a stray recorded under 0.64.3 no longer refuses the real agent, which replaces it', () => {
  const host = makeHost('legacy')
  try {
    // 0.64.3's 60 s self record: the stray's folder, no source.
    const file = host.readFile()
    writeFileSync(host.credentialsPath, `${JSON.stringify({ ...file, homeDir: host.repo }, null, 2)}\n`)
    const stray = bootDaemon(host, host.repo, STRAY_PID, T0)
    assert.equal(stray.held, true, 'the stray matches the unconfirmed home and starts (kept, as in identity-race)')
    const agent = bootDaemon(host, host.agentFolder, AGENT_PID, T0 + 10_000)
    assert.notEqual(agent.binding.action, 'refuse', 'the agent started from its own pinned folder is not refused')
    assert.equal(agent.held, true, 'and takes the channel back')
    run(host, [stray, agent], T0 + 15_000, T0 + 25_000)
    assert.equal(stray.held, false)
    assert.equal(host.readFile().homeDir, host.agentFolder, 'its own folder replaces the stray\'s')
    assert.equal(host.readFile().homeSource, 'pin')
    const later = bootDaemon(host, host.repo, SECOND_PID, T0 + 30_000)
    assert.equal(later.binding.action, 'refuse', 'and the repo no longer passes as its home')
  } finally {
    host.cleanup()
  }
})

// ── 2. A stray that names a different agent boots first ──────────────────────

test('a worker that names a different agent boots first on the agent\'s file: it never takes the lock, the real agent does', () => {
  const host = makeHost('per-agent')
  try {
    // A worker that inherited the agent's BGOS_CREDENTIALS_PATH but runs as another agent.
    const workerEnv: Env = { BGOS_CREDENTIALS_PATH: host.credentialsPath, BGOS_ASSISTANT_ID: OTHER_ID }
    const worker = bootDaemon(host, host.workerFolder, STRAY_PID, T0, workerEnv)
    assert.equal(worker.resolvedVia, 'env-path')
    assert.equal(worker.path, host.credentialsPath, 'it resolves to the agent\'s own file')
    assert.equal(worker.held, false, 'a session naming another agent never takes the lock, even a free one')
    assert.equal(existsSync(host.lockPath), false, 'and never writes it')

    const agent = bootDaemon(host, host.agentFolder, AGENT_PID, T0 + 10_000)
    assert.equal(agent.route, 'pin')
    assert.equal(agent.held, true, 'the real agent takes the channel')
    run(host, [worker, agent], T0 + 15_000, T0 + 75_000)
    assert.equal(worker.held, false)
    assert.equal(agent.held, true)
    assert.equal(lockHolderPid(host), AGENT_PID)
    assert.equal(host.readFile().homeDir, host.agentFolder, 'the agent confirms its own folder')
  } finally {
    host.cleanup()
  }
})

test('a session naming another agent never overwrites the lock: not a stale one, not a dead holder\'s', () => {
  const host = makeHost('per-agent')
  try {
    const agent = bootDaemon(host, host.agentFolder, AGENT_PID, T0)
    assert.equal(agent.held, true)
    const before = readFileSync(host.lockPath, 'utf8')
    const worker = bootDaemon(host, host.workerFolder, STRAY_PID, T0 + 1_000, {
      BGOS_CREDENTIALS_PATH: host.credentialsPath,
      BGOS_ASSISTANT_ID: OTHER_ID,
    })
    assert.equal(worker.held, false)
    // The agent dies without releasing: its record goes stale and its pid is gone.
    host.alive.delete(AGENT_PID)
    run(host, [worker], T0 + 60_000, T0 + 120_000)
    assert.equal(worker.held, false, 'a dead or stale holder is still not this worker\'s to take')
    assert.equal(readFileSync(host.lockPath, 'utf8'), before, 'the lock file is byte for byte the agent\'s')
  } finally {
    host.cleanup()
  }
})

// ── 3. A stray alone ─────────────────────────────────────────────────────────

test('stray only: a session naming another agent, alone on the host, claims nothing', () => {
  const host = makeHost('per-agent')
  try {
    const worker = bootDaemon(host, host.workerFolder, STRAY_PID, T0, {
      BGOS_CREDENTIALS_PATH: host.credentialsPath,
      BGOS_ASSISTANT_ID: OTHER_ID,
    })
    run(host, [worker], T0 + 5_000, T0 + 120_000)
    assert.equal(worker.held, false, 'no channel, however long it runs')
    assert.equal(existsSync(host.lockPath), false, 'no lock record')
    assert.equal(host.readFile().homeDir, undefined, 'no home record')
    assert.equal(host.readFile().homeSource, undefined)
  } finally {
    host.cleanup()
  }
})

test('stray only, legacy file: a session naming another agent finds no pairing and claims the shared file\'s nothing', () => {
  const host = makeHost('legacy')
  try {
    // Pinned to another agent: the resolver never hands it this agent's shared file.
    writeFileSync(join(host.workerFolder, '.bgos-agent-id'), `${OTHER_ID}\n`)
    const worker = bootDaemon(host, host.workerFolder, STRAY_PID, T0)
    assert.notEqual(worker.path, host.credentialsPath)
    run(host, [worker], T0 + 5_000, T0 + 65_000)
    assert.equal(existsSync(host.lockPath), false, 'the agent\'s lock is never written')
    assert.equal(host.readFile().homeDir, undefined, 'the agent\'s home is never written')
  } finally {
    host.cleanup()
  }
})

// ── 4. The single session path and two matching sessions: unchanged ─────────

test('one session alone keeps today\'s path: pinned, unpinned, legacy and per agent', () => {
  for (const layout of ['per-agent', 'legacy'] as const) {
    // The pinned agent alone takes a free lock and confirms its folder.
    const pinned = makeHost(layout)
    try {
      const agent = bootDaemon(pinned, pinned.agentFolder, AGENT_PID, T0)
      assert.equal(agent.held, true, `${layout}: the pinned agent takes the free lock`)
      assert.equal(agent.lockReason, 'unlocked')
      run(pinned, [agent], T0 + 5_000, T0 + 10_000)
      if (layout === 'per-agent') {
        assert.equal(pinned.readFile().homeDir, pinned.agentFolder)
        assert.equal(pinned.readFile().homeSource, 'pin')
      }
    } finally {
      pinned.cleanup()
    }
    // An unpinned agent alone (no pin, no env) still starts and holds its channel, and writes no home.
    const unpinned = makeHost(layout)
    try {
      const agent = bootDaemon(unpinned, unpinned.repo, AGENT_PID, T0)
      assert.equal(agent.route, 'elimination')
      assert.equal(agent.held, true, `${layout}: an unpinned single agent keeps its channel`)
      run(unpinned, [agent], T0 + 5_000, T0 + 65_000)
      assert.equal(agent.held, true)
      assert.equal(unpinned.readFile().homeDir, undefined)
    } finally {
      unpinned.cleanup()
    }
  }
})

test('two sessions that both name the paired agent keep today\'s rule: neither takes the lock from the other', () => {
  for (const layout of ['per-agent', 'legacy'] as const) {
    const host = makeHost(layout)
    try {
      const first = bootDaemon(host, host.agentFolder, AGENT_PID, T0)
      assert.equal(first.held, true)
      // A subagent in the same pinned folder, and a worker with the agent's id in its env.
      const sub = bootDaemon(host, host.agentFolder, SECOND_PID, T0 + 1_000)
      const envWorker = bootDaemon(host, host.workerFolder, STRAY_PID, T0 + 2_000, { BGOS_ASSISTANT_ID: AGENT_ID })
      run(host, [first, sub, envWorker], T0 + 5_000, T0 + 60_000)
      assert.equal(first.held, true, `${layout}: the first matching holder keeps it`)
      assert.equal(sub.held, false)
      assert.equal(envWorker.held, false)
      // And the env worker, holding first, is not displaced by the pinned agent (Data's guard).
      host.alive.delete(AGENT_PID)
      host.alive.delete(SECOND_PID)
      run(host, [envWorker], T0 + 65_000, T0 + 70_000)
      assert.equal(envWorker.held, true, `${layout}: the env worker takes the lock its dead peer left`)
      const late = bootDaemon(host, host.agentFolder, AGENT_PID + 10, T0 + 75_000)
      assert.equal(late.held, false, `${layout}: a pinned session never takes it from a matching env holder`)
    } finally {
      host.cleanup()
    }
  }
})

// ── 5. The pure rule ─────────────────────────────────────────────────────────

test('decideSessionClaim: the id the session names, against the id the pairing was made for', () => {
  const decide = lib.decideSessionClaim as (input: Record<string, unknown>) => Record<string, unknown>
  assert.equal(typeof decide, 'function', 'agent-credentials exports decideSessionClaim')
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    // [name, input, effective via, lock route]
    ['elimination, no name', { via: 'sole-per-assistant', env: {}, folderPinId: '', pairedAssistantId: 1040 }, 'sole-per-assistant', 'elimination'],
    ['legacy, no name', { via: 'legacy', env: {}, folderPinId: '', pairedAssistantId: 1040 }, 'legacy', 'elimination'],
    ['legacy, pin names it', { via: 'legacy', env: {}, folderPinId: '1040', pairedAssistantId: 1040 }, 'folder-pin', 'pin'],
    ['legacy, env names it', { via: 'legacy', env: { BGOS_ASSISTANT_ID: '1040' }, folderPinId: '', pairedAssistantId: '1040' }, 'env-assistant', 'env'],
    ['legacy, env wins over a pin', { via: 'legacy', env: { BGOS_ASSISTANT_ID: '1040' }, folderPinId: '2077', pairedAssistantId: 1040 }, 'env-assistant', 'env'],
    ['folder pin matches', { via: 'folder-pin', env: {}, folderPinId: '1040', pairedAssistantId: 1040 }, 'folder-pin', 'pin'],
    ['folder pin, file of another agent', { via: 'folder-pin', env: {}, folderPinId: '1040', pairedAssistantId: 2077 }, 'folder-pin', 'not-this-agent'],
    ['env id, file of another agent', { via: 'env-assistant', env: { BGOS_ASSISTANT_ID: '2077' }, folderPinId: '', pairedAssistantId: 1040 }, 'env-assistant', 'not-this-agent'],
    ['env path plus another env id', { via: 'env-path', env: { BGOS_CREDENTIALS_PATH: '/x', BGOS_ASSISTANT_ID: '2077' }, folderPinId: '', pairedAssistantId: 1040 }, 'env-path', 'not-this-agent'],
    ['env path, no id', { via: 'env-path', env: { BGOS_CREDENTIALS_PATH: '/x' }, folderPinId: '', pairedAssistantId: 1040 }, 'env-path', 'env'],
    ['env path ignores a folder pin, as the resolver does', { via: 'env-path', env: { BGOS_CREDENTIALS_PATH: '/x' }, folderPinId: '2077', pairedAssistantId: 1040 }, 'env-path', 'env'],
    ['no paired id: nothing to compare', { via: 'env-assistant', env: { BGOS_ASSISTANT_ID: '2077' }, folderPinId: '', pairedAssistantId: null }, 'env-assistant', 'env'],
    ['the placeholder names nobody', { via: 'legacy', env: { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' }, folderPinId: '', pairedAssistantId: 1040 }, 'legacy', 'elimination'],
    ['leading zeros are the same agent', { via: 'legacy', env: {}, folderPinId: '01040', pairedAssistantId: 1040 }, 'folder-pin', 'pin'],
  ]
  for (const [name, input, via, lockRoute] of cases) {
    const out = decide(input)
    assert.equal(out.via, via, `${name}: via`)
    assert.equal(out.lockRoute, lockRoute, `${name}: lock route`)
  }
})

test('decideLockAction: a session that is not this agent is passive in every lock state', () => {
  const decide = pairingLock.decideLockAction
  const base = { now: T0, selfPid: STRAY_PID, stalenessMs: pairingLock.lockStalenessMs(), selfRoute: 'not-this-agent' } as Record<string, unknown>
  const fresh = { pid: AGENT_PID, heartbeatAt: T0 - 1_000, route: 'elimination' as const }
  const states: Array<[string, unknown, (pid: number) => boolean]> = [
    ['unlocked', null, () => true],
    ['stale', { ...fresh, heartbeatAt: T0 - 60_000 }, () => true],
    ['holder dead', fresh, () => false],
    ['live elimination holder', fresh, () => true],
    ['live holder, channel unloaded', { ...fresh, channelLoaded: false }, () => true],
  ]
  for (const [name, existing, isHolderAlive] of states) {
    const out = decide({ ...base, existing, isHolderAlive, selfChannelLoaded: true } as Parameters<typeof decide>[0])
    assert.equal(out.action, 'passive', `${name}: passive`)
  }
  assert.match(
    String(lockLib.formatLockYieldReason?.({ holderRoute: undefined, selfRoute: 'not-this-agent' })),
    /names a different agent/,
  )
})

// ── 6. server.ts wires the claim into the home binding and the lock ──────────

test('server.ts decides the session claim once and feeds both the home binding and LOCK_ROUTE from it', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(server, /\nconst SESSION_CLAIM = decideSessionClaim\(\{/)
  assert.match(server, /pairedAssistantId: CREDENTIALS_FILE\?\.assistantId,/)
  assert.match(server, /\n {2}via: CREDENTIALS_SELECTION\.via === 'recorded-home' \? 'sole-per-assistant' : SESSION_CLAIM\.via,\n/)
  assert.match(server, /\nconst LOCK_ROUTE = CREDENTIALS_SELECTION\.via === 'recorded-home' \? 'pin' : SESSION_CLAIM\.lockRoute\n/)
})
