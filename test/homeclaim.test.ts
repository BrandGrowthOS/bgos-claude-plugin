/**
 * homeclaim (HOAI board 01a072c5): a stray session that boots first on a
 * single agent host can no longer keep the agent's home record.
 *
 * THE RESIDUAL (after plugin #119 and 0.65.0's route takeover). The pairing
 * lock lets a daemon pinned to the agent take the channel back from one that
 * found the agent by elimination, and only a pinned start writes the home.
 * Both rules read the ROUTE the credentials resolver reported, and on a host
 * whose pairing lives in the shared legacy credentials.json (paired before
 * per agent files existed, or a bgos-claim agent) the resolver reports
 * 'legacy' for EVERY session, the real agent included: a folder pin or a
 * BGOS_ASSISTANT_ID that names the legacy file's own agent still comes back
 * via 'legacy' (agent-credentials-core.mjs, ownOrNothing). So the real agent
 * started from its pinned folder looked exactly like a bare `claude` in some
 * other folder. Whichever booted first held the pairing lock, the real agent
 * sat passive behind a stray (a guest on its own channel), and when a stray
 * under 0.64.3 had recorded its own folder as the home, the real agent was
 * REFUSED outright and told to pin a folder that was already pinned.
 *
 * THE FIX. The claim now asks for the agent id the host was paired for (the
 * credentials file's assistantId) and compares it with the id the session
 * names for itself (BGOS_ASSISTANT_ID, else the folder pin):
 *   - a session naming the paired agent is that agent, however the resolver
 *     found the file: it records a pinned route, takes the lock back from a
 *     stray and confirms its own folder as the home;
 *   - a session naming a DIFFERENT agent never takes or overwrites the lock;
 *   - a session naming no agent keeps today's rule (it still starts and takes
 *     a free lock, writes no home, and yields to the agent);
 *   - two sessions naming the paired agent keep today's rule (neither takes
 *     the lock from the other).
 *
 * WHAT THIS DRIVES. The lib functions server.ts calls, in its order:
 * resolveCredentialsSelection, loadCredentialsFile, the session identity
 * (identityViaFor, sessionAgentId), decideHomeBinding and acquirePairingLock
 * at boot, then refreshPairingLockDetailed and homeStepWhileHolding on each
 * held tick. Every file is real and lives in a temp folder; only the pid
 * liveness probe is a stand-in. The lib is imported as a namespace so the
 * helpers this fix adds read as undefined on main: the same file runs there
 * and fails on its assertions, which is the red run.
 *
 * Run: npx tsx --test test/homeclaim.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as credentials from '../lib/agent-credentials.ts'
import * as pairingLock from '../lib/pairing-lock.ts'

type Lib = Record<string, any>
const lib = credentials as unknown as Lib
const lockLib = pairingLock as unknown as Lib

const AGENT_ID = '888'
const OTHER_AGENT_ID = '999'
const STRAY_PID = 52001
const AGENT_PID = 52002
const LATER_PID = 52003
const T0 = 1_770_000_000_000

type Layout = 'legacy' | 'per-agent'

/** One computer under one OS user: ~/.bgos-agent, the agent's pinned folder,
 *  and a repo with no pin where stray sessions start. */
function makeHost(opts: { layout: Layout; recordedHomeDir?: (h: { agent: string; repo: string }) => string }) {
  const root = mkdtempSync(join(tmpdir(), 'homeclaim-'))
  const agentDir = join(root, 'home', '.bgos-agent')
  const agent = join(root, 'agents', 'ava')
  const repo = join(root, 'code', 'some-repo')
  const elsewhere = join(root, 'code', 'other-repo')
  for (const dir of [agentDir, agent, repo, elsewhere]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(agent, '.bgos-agent-id'), `${AGENT_ID}\n`)
  const defaultPath = join(agentDir, 'credentials.json')
  const credentialsPath = opts.layout === 'legacy' ? defaultPath : join(agentDir, `credentials-${AGENT_ID}.json`)
  const file: Record<string, unknown> = {
    backendUrl: 'https://backend.invalid/api/v1',
    pairingToken: 'homeclaim-test-token',
    pairingId: 91,
    userId: 'user_homeclaim',
    assistantId: Number(AGENT_ID),
    pairedAt: '2026-06-01T00:00:00.000Z',
  }
  if (opts.recordedHomeDir) file.homeDir = opts.recordedHomeDir({ agent, repo })
  writeFileSync(credentialsPath, `${JSON.stringify(file, null, 2)}\n`)
  const alive = new Set<number>()
  const io = { ...pairingLock.defaultLockIo, isProcessAlive: (pid: number) => alive.has(pid) }
  return {
    root,
    defaultPath,
    credentialsPath,
    lockPath: pairingLock.pairingLockPath(credentialsPath),
    agent,
    repo,
    elsewhere,
    alive,
    io,
    readFile: () => JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>,
    readLock: () => pairingLock.parseLockRecord(readFileSync(pairingLock.pairingLockPath(credentialsPath), 'utf8')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

type Host = ReturnType<typeof makeHost>

/**
 * A daemon booting in `cwd`, as server.ts boots one (the order and the inputs
 * of the CREDENTIALS_SELECTION, HOME_BINDING, LOCK_ROUTE and acquire sites).
 * On main the identity helpers are absent, so the session's identity falls
 * back to the resolver's route, exactly as server.ts used it there.
 */
function bootDaemon(
  host: Host,
  cwd: string,
  pid: number,
  nowMs: number,
  env: Record<string, string> = {},
  channelLoaded: boolean | null = null,
) {
  host.alive.add(pid)
  const selection = credentials.resolveCredentialsSelection({ env, defaultPath: host.defaultPath, cwd })
  assert.equal(selection.kind, 'ok', 'a one agent computer never refuses at selection')
  if (selection.kind !== 'ok') throw new Error('unreachable')
  const file = credentials.loadCredentialsFile(selection.path)
  const folderPinId = credentials.readFolderPinId(cwd)
  const pairedAgentId = String(file?.assistantId ?? '')
  const identityVia = lib.identityViaFor
    ? lib.identityViaFor({ via: selection.via, env, folderPinId, pairedAgentId })
    : selection.via
  const agentId: string = lib.sessionAgentId ? lib.sessionAgentId({ env, folderPinId }) : ''
  const binding = credentials.decideHomeBinding({
    via: identityVia,
    cwd,
    recordedHomeDir: file?.homeDir ?? null,
    recordedHomeSource: (file as Record<string, unknown> | null)?.homeSource ?? null,
    folderPinId,
    assistantId: pairedAgentId,
    env,
  })
  const route = credentials.lockRouteFor(identityVia)
  const daemon = {
    cwd,
    pid,
    bootedAt: nowMs,
    via: selection.via,
    identityVia,
    path: selection.path,
    binding,
    route,
    agentId,
    pairedAgentId,
    channelLoaded,
    held: false,
    homeDone: false,
    lockReason: undefined as string | undefined,
  }
  if (binding.action === 'refuse') return daemon
  const lock = pairingLock.acquirePairingLock({
    lockPath: host.lockPath,
    selfPid: pid,
    now: nowMs,
    bootedAt: nowMs,
    route,
    channelLoaded,
    agentId,
    pairedAgentId,
    io: host.io,
  } as Parameters<typeof pairingLock.acquirePairingLock>[0])
  daemon.held = lock.acquired
  daemon.lockReason = lock.reason
  return daemon
}

type Daemon = ReturnType<typeof bootDaemon>

/** One held poll tick: the lock refresh first, then the home step. */
function heldTick(host: Host, daemon: Daemon, nowMs: number): void {
  if (!daemon.held) return
  const refreshed = pairingLock.refreshPairingLockDetailed({
    lockPath: host.lockPath,
    selfPid: daemon.pid,
    now: nowMs,
    bootedAt: daemon.bootedAt,
    route: daemon.route,
    channelLoaded: daemon.channelLoaded,
    io: host.io,
  })
  if (!refreshed.held) {
    daemon.held = false
    return
  }
  if (daemon.homeDone) return
  daemon.homeDone = credentials.homeStepWhileHolding({ binding: daemon.binding, path: daemon.path }).done
}

function holdChannel(host: Host, daemon: Daemon, fromMs: number, toMs: number): void {
  for (let now = fromMs; now <= toMs; now += 5_000) heldTick(host, daemon, now)
}

// ── The race: stray first, real agent second ─────────────────────────────────

test('the race on a legacy-file host: a stray boots first, the agent started from its pinned folder takes the lock and the home back', () => {
  const host = makeHost({ layout: 'legacy' })
  try {
    // 1. The agent is down. A bare claude in an unrelated repo boots first.
    const stray = bootDaemon(host, host.repo, STRAY_PID, T0)
    assert.equal(stray.via, 'legacy', 'the stray finds the agent by elimination (the legacy file)')
    assert.equal(stray.route, 'elimination')
    assert.equal(stray.held, true, 'the lock is free, so the stray takes it (today\'s rule, kept)')
    holdChannel(host, stray, T0 + 5_000, T0 + 65_000)
    assert.equal(host.readFile().homeDir, undefined, 'a stray never writes the home')

    // 2. The real agent starts from its pinned folder. The resolver still says
    //    'legacy' (no credentials-888.json), but the session names agent 888,
    //    which is the agent this file was paired for.
    const agent = bootDaemon(host, host.agent, AGENT_PID, T0 + 70_000)
    assert.equal(agent.via, 'legacy', 'the resolver route is unchanged: the file is the shared legacy one')
    assert.notEqual(agent.binding.action, 'refuse')
    assert.equal(agent.held, true, 'the real agent takes the pairing lock back from the stray')
    assert.equal(agent.lockReason, 'route-takeover')
    assert.equal(agent.agentId, AGENT_ID, 'the session names its own agent from the folder pin')
    assert.equal(agent.route, 'pin', 'a session naming the paired agent records a pinned route')

    // 3. The stray learns it on its next heartbeat and stands down.
    heldTick(host, stray, T0 + 75_000)
    assert.equal(stray.held, false, 'the stray stands down')
    assert.equal(host.readLock()?.pid, AGENT_PID)

    // 4. Holding the channel, the agent confirms its own folder as the home.
    holdChannel(host, agent, T0 + 75_000, T0 + 80_000)
    const after = host.readFile()
    assert.equal(after.homeDir, host.agent)
    assert.equal(after.homeSource, 'pin')
    assert.equal(after.pairingToken, 'homeclaim-test-token', 'the token is carried through untouched')

    // 5. From now on a stray in the repo, or anywhere else, is refused.
    for (const folder of [host.repo, host.elsewhere]) {
      const later = bootDaemon(host, folder, LATER_PID, T0 + 90_000)
      assert.equal(later.binding.action, 'refuse', `a stray in ${folder} is refused`)
      assert.equal(later.held, false)
    }
  } finally {
    host.cleanup()
  }
})

test('the race on a legacy-file host, env pinned: an agent named by BGOS_ASSISTANT_ID takes the lock back from a stray', () => {
  const host = makeHost({ layout: 'legacy' })
  try {
    const stray = bootDaemon(host, host.repo, STRAY_PID, T0)
    assert.equal(stray.held, true)
    // A bgos-claim style agent: BGOS_ASSISTANT_ID names it, it runs in a folder with no pin.
    const agent = bootDaemon(host, host.elsewhere, AGENT_PID, T0 + 10_000, { BGOS_ASSISTANT_ID: AGENT_ID })
    assert.equal(agent.via, 'legacy')
    assert.equal(agent.held, true, 'the env-named agent takes the lock back')
    assert.equal(agent.lockReason, 'route-takeover')
    assert.equal(agent.route, 'env')
    heldTick(host, stray, T0 + 15_000)
    assert.equal(stray.held, false)
    holdChannel(host, agent, T0 + 15_000, T0 + 20_000)
    assert.equal(host.readFile().homeDir, undefined, 'an env var names an agent, never a home: nothing is written')
  } finally {
    host.cleanup()
  }
})

test('a home a stray recorded under 0.64.3 on a legacy-file host no longer refuses the real agent; its pinned start takes the home back', () => {
  // 0.64.3's 60 s self-record left the stray's folder as an unconfirmed home.
  const host = makeHost({ layout: 'legacy', recordedHomeDir: (h) => h.repo })
  try {
    const stray = bootDaemon(host, host.repo, STRAY_PID, T0)
    assert.equal(stray.binding.action, 'allow', 'a stray matching the unconfirmed home still starts (today\'s rule)')
    assert.equal(stray.held, true)

    const agent = bootDaemon(host, host.agent, AGENT_PID, T0 + 10_000)
    assert.notEqual(agent.binding.action, 'refuse', 'the agent in its own pinned folder is never refused as a stray')
    assert.equal(agent.held, true, 'and it takes the channel back')
    heldTick(host, stray, T0 + 15_000)
    assert.equal(stray.held, false)
    holdChannel(host, agent, T0 + 15_000, T0 + 20_000)
    assert.equal(host.readFile().homeDir, host.agent, 'the stray\'s home is replaced by the agent\'s own folder')
    assert.equal(host.readFile().homeSource, 'pin')

    const next = bootDaemon(host, host.repo, LATER_PID, T0 + 30_000)
    assert.equal(next.binding.action, 'refuse', 'the repo no longer passes as the agent\'s home')
  } finally {
    host.cleanup()
  }
})

// ── A stray alone: no claim ──────────────────────────────────────────────────

test('a session naming a DIFFERENT agent never takes or overwrites the lock, even a free or stale one, and writes no home', () => {
  const host = makeHost({ layout: 'per-agent' })
  try {
    // A worker of agent 999, pointed at agent 888's file by an inherited
    // BGOS_CREDENTIALS_PATH, in a folder pinned to 999.
    const otherFolder = join(host.root, 'agents', 'other')
    mkdirSync(otherFolder, { recursive: true })
    writeFileSync(join(otherFolder, '.bgos-agent-id'), `${OTHER_AGENT_ID}\n`)
    const env = { BGOS_CREDENTIALS_PATH: host.credentialsPath }
    const stray = bootDaemon(host, otherFolder, STRAY_PID, T0, env)
    assert.equal(stray.via, 'env-path')
    assert.equal(stray.held, false, 'the lock is free, and still a session naming another agent does not take it')
    assert.equal(stray.agentId, OTHER_AGENT_ID)
    assert.throws(() => readFileSync(host.lockPath, 'utf8'), /ENOENT/, 'nothing is written to the lock')

    // A stale record left by a dead holder is not overwritten by it either.
    writeFileSync(host.lockPath, pairingLock.serializeLockRecord({ pid: 7, heartbeatAt: T0 - 600_000, route: 'pin' }))
    const again = bootDaemon(host, otherFolder, STRAY_PID, T0 + 5_000, env)
    assert.equal(again.held, false)
    assert.equal(host.readLock()?.pid, 7, 'the stale record is left for the agent to reclaim')

    // An env id naming another agent does the same.
    const envStray = bootDaemon(host, host.repo, LATER_PID, T0 + 6_000, { ...env, BGOS_ASSISTANT_ID: OTHER_AGENT_ID })
    assert.equal(envStray.agentId, OTHER_AGENT_ID)
    assert.equal(envStray.held, false)
    assert.equal(host.readFile().homeDir, undefined, 'no home is written')

    // The agent itself reclaims the stale lock as before.
    const agent = bootDaemon(host, host.agent, AGENT_PID, T0 + 10_000)
    assert.equal(agent.held, true)
    assert.equal(agent.lockReason, 'stale')
  } finally {
    host.cleanup()
  }
})

test('the lock decision: a disagreeing agent id is passive in every state, a matching or absent one decides as before', () => {
  const decide = (existing: pairingLock.LockRecord | null, agentId: string, pairedAgentId: string) =>
    lockLib.decideLockAction({
      existing,
      now: T0,
      selfPid: AGENT_PID,
      stalenessMs: 15_000,
      isHolderAlive: (pid: number) => pid === STRAY_PID,
      selfRoute: 'pin',
      agentId,
      pairedAgentId,
    })
  const live = { pid: STRAY_PID, heartbeatAt: T0 - 1_000, route: 'elimination' as const }
  const stale = { pid: STRAY_PID, heartbeatAt: T0 - 60_000, route: 'elimination' as const }
  const dead = { pid: 4242, heartbeatAt: T0 - 1_000, route: 'elimination' as const }
  for (const existing of [null, live, stale, dead]) {
    assert.equal(decide(existing, OTHER_AGENT_ID, AGENT_ID).action, 'passive', `mismatch over ${JSON.stringify(existing)}`)
  }
  assert.equal(decide(null, AGENT_ID, AGENT_ID).action, 'acquire')
  assert.equal(decide(live, AGENT_ID, AGENT_ID).reason, 'route-takeover')
  assert.equal(decide(stale, '', AGENT_ID).reason, 'stale', 'a session naming no agent decides exactly as today')
  assert.equal(decide(live, AGENT_ID, '').reason, 'route-takeover', 'a file with no paired id decides exactly as today')
  // The passive answer says why, so the banner can.
  assert.equal(decide(null, OTHER_AGENT_ID, AGENT_ID).agentMismatch, true)
})

test('an unpinned stray never borrows the agent\'s identity: it stays an elimination start and writes no home', () => {
  for (const layout of ['legacy', 'per-agent'] as const) {
    const host = makeHost({ layout })
    try {
      const stray = bootDaemon(host, host.repo, STRAY_PID, T0)
      assert.equal(stray.agentId, '')
      assert.equal(stray.route, 'elimination', `${layout}: no pin and no env id is never upgraded`)
      assert.equal(stray.identityVia, stray.via)
      holdChannel(host, stray, T0 + 5_000, T0 + 120_000)
      assert.equal(host.readFile().homeDir, undefined, `${layout}: a stray holding the lock for two minutes writes no home`)
    } finally {
      host.cleanup()
    }
  }
})

// ── Unchanged: one session, and two sessions naming the agent ────────────────

test('the single session path is unchanged: a lone daemon takes a free lock on every layout and route', () => {
  const cases: Array<{ layout: Layout; where: 'agent' | 'repo'; env?: Record<string, string>; route: string; via: string }> = [
    { layout: 'per-agent', where: 'agent', route: 'pin', via: 'folder-pin' },
    { layout: 'per-agent', where: 'repo', route: 'elimination', via: 'sole-per-assistant' },
    { layout: 'per-agent', where: 'repo', env: { BGOS_ASSISTANT_ID: AGENT_ID }, route: 'env', via: 'env-assistant' },
    { layout: 'legacy', where: 'repo', route: 'elimination', via: 'legacy' },
  ]
  for (const c of cases) {
    const host = makeHost({ layout: c.layout })
    try {
      const d = bootDaemon(host, c.where === 'agent' ? host.agent : host.repo, AGENT_PID, T0, c.env ?? {})
      const label = `${c.layout} ${c.where} ${JSON.stringify(c.env ?? {})}`
      assert.equal(d.via, c.via, label)
      assert.equal(d.route, c.route, label)
      assert.equal(d.held, true, `${label}: takes the free lock`)
      assert.equal(d.lockReason, 'unlocked', label)
    } finally {
      host.cleanup()
    }
  }
})

test('two sessions naming the paired agent keep today\'s rule: neither takes the lock from the other', () => {
  for (const layout of ['legacy', 'per-agent'] as const) {
    const host = makeHost({ layout })
    try {
      const first = bootDaemon(host, host.agent, AGENT_PID, T0)
      assert.equal(first.held, true)
      // A worker in the agent's own folder (pin), and one carrying the env id elsewhere.
      const pinned = bootDaemon(host, host.agent, LATER_PID, T0 + 1_000)
      assert.equal(pinned.held, false, `${layout}: a second pinned session stays passive`)
      const envNamed = bootDaemon(host, host.repo, LATER_PID + 1, T0 + 2_000, { BGOS_ASSISTANT_ID: AGENT_ID })
      assert.equal(envNamed.held, false, `${layout}: an env-named session does not take it from a pinned holder`)
      heldTick(host, first, T0 + 5_000)
      assert.equal(first.held, true, `${layout}: the first holder keeps the channel`)
    } finally {
      host.cleanup()
    }
  }
})
