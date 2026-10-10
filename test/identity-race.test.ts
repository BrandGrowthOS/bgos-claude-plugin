/**
 * The identity race (HOAI board fc75c7c3), end to end over real files.
 *
 * THE RACE. On a computer with ONE paired agent, every Claude Code session
 * starts a bgos daemon (the plugin is installed for every session), and a
 * session in a folder with no pin resolves to that agent by elimination. Up
 * to 0.64.3, if such a stray booted while the agent was down, it took the
 * pairing lock (the lock picks whoever came first), answered in the agent's
 * chats, and after 60 s holding the channel wrote ITS OWN folder into the
 * agent's credentials file as homeDir. From then on strays in that folder
 * passed the home check, and the stray could repoint the agent's resume pin.
 * Ares lived it on 2026-09-19 (homeDir recorded as the BGOS repo).
 *
 * WHAT THIS DRIVES. The same lib functions server.ts calls, in the order it
 * calls them: resolveCredentialsSelection, loadCredentialsFile and
 * decideHomeBinding at boot, acquirePairingLock at boot, then on every held
 * tick refreshPairingLockDetailed and homeStepWhileHolding, and the session
 * pin keeper. Every file is real and lives in a temp folder: the credentials
 * file, both folders and their pins, the lock and the resume pin. Only the
 * pid liveness probe is a stand-in, because the two "daemons" here are not
 * processes.
 *
 * The lib is imported as a namespace on purpose: the helpers this fix adds
 * (the lock route, the home check) read as undefined on 0.64.3, so the same
 * file runs there and fails on its assertions, which is the red run this
 * test was written to show.
 *
 * Run: npx tsx --test test/identity-race.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as credentials from '../lib/agent-credentials.ts'
import {
  acquirePairingLock,
  defaultLockIo,
  pairingLockPath,
  refreshPairingLockDetailed,
  type LockIo,
} from '../lib/pairing-lock.ts'
import { SessionPinKeeper, liveTranscriptPath, sessionPinPath } from '../lib/session-pin.ts'

const AGENT_ID = '1040'
const STRAY_PID = 41001
const ARES_PID = 41002
const LATER_STRAY_PID = 41003
const STRAY_SESSION = '0f0f0f0f-1111-4222-8333-444455556666'
const OLD_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000'
const T0 = 1_760_000_000_000

type Lib = Record<string, any>
const lib = credentials as unknown as Lib

/** One computer: a home folder holding ~/.bgos-agent, the agent's pinned
 *  folder, and a repo with no pin where strays start. */
function makeHost(opts: { recordedHomeDir?: (h: { ares: string; repo: string }) => string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'identity-race-'))
  const agentDir = join(root, 'home', '.bgos-agent')
  const ares = join(root, 'agents', 'ares')
  const repo = join(root, 'code', 'bgos-repo')
  const elsewhere = join(root, 'code', 'other-repo')
  for (const dir of [agentDir, ares, repo, elsewhere]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(ares, '.bgos-agent-id'), `${AGENT_ID}\n`)
  const credentialsPath = join(agentDir, `credentials-${AGENT_ID}.json`)
  const file: Record<string, unknown> = {
    backendUrl: 'https://backend.invalid/api/v1',
    pairingToken: 'race-test-token',
    pairingId: 77,
    userId: 'user_race',
    assistantId: Number(AGENT_ID),
    pairedAt: '2026-08-01T00:00:00.000Z',
  }
  if (opts.recordedHomeDir) file.homeDir = opts.recordedHomeDir({ ares, repo })
  writeFileSync(credentialsPath, `${JSON.stringify(file, null, 2)}\n`)
  const alive = new Set<number>()
  const io: LockIo = { ...defaultLockIo, isProcessAlive: (pid) => alive.has(pid) }
  return {
    root,
    home: join(root, 'home'),
    configDir: join(root, 'home', '.claude'),
    defaultPath: join(agentDir, 'credentials.json'),
    credentialsPath,
    lockPath: pairingLockPath(credentialsPath),
    ares,
    repo,
    elsewhere,
    alive,
    io,
    readFile: () => JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

type Host = ReturnType<typeof makeHost>

/** A daemon booting in `cwd`, as server.ts boots one. `channelLoaded` is
 *  what lib/channel-presence.ts read off its claude command line. */
function bootDaemon(host: Host, cwd: string, pid: number, nowMs: number, channelLoaded: boolean | null = null) {
  host.alive.add(pid)
  const selection = credentials.resolveCredentialsSelection({
    env: {},
    defaultPath: host.defaultPath,
    cwd,
  })
  assert.equal(selection.kind, 'ok', 'a one agent computer never refuses at selection')
  if (selection.kind !== 'ok') throw new Error('unreachable')
  const file = credentials.loadCredentialsFile(selection.path)
  const binding = credentials.decideHomeBinding({
    via: selection.via,
    cwd,
    recordedHomeDir: file?.homeDir ?? null,
    recordedHomeSource: (file as Record<string, unknown> | null)?.homeSource ?? null,
    folderPinId: lib.readFolderPinId?.(cwd) ?? '',
    assistantId: String(file?.assistantId ?? ''),
    env: {},
  } as Parameters<typeof credentials.decideHomeBinding>[0])
  const route = lib.lockRouteFor?.(selection.via)
  const daemon = {
    cwd,
    pid,
    bootedAt: nowMs,
    via: selection.via,
    path: selection.path,
    binding,
    route,
    homeConfirmed: lib.homeCheckPassed ? Boolean(lib.homeCheckPassed(binding)) : binding.action === 'allow',
    held: false,
    homeDone: false,
    lockReason: undefined as string | undefined,
    channelLoaded,
  }
  if (binding.action === 'refuse') return daemon
  const lock = acquirePairingLock({
    lockPath: host.lockPath,
    selfPid: pid,
    now: nowMs,
    bootedAt: nowMs,
    route,
    channelLoaded,
    io: host.io,
  } as Parameters<typeof acquirePairingLock>[0])
  daemon.held = lock.acquired
  daemon.lockReason = lock.reason
  return daemon
}

type Daemon = ReturnType<typeof bootDaemon>

/** One held poll tick: the lock refresh first, then the home step. */
function heldTick(host: Host, daemon: Daemon, nowMs: number): void {
  if (!daemon.held) return
  const refreshed = refreshPairingLockDetailed({
    lockPath: host.lockPath,
    selfPid: daemon.pid,
    now: nowMs,
    bootedAt: daemon.bootedAt,
    route: daemon.route,
    channelLoaded: daemon.channelLoaded,
    io: host.io,
  } as Parameters<typeof refreshPairingLockDetailed>[0])
  if (!refreshed.held) {
    daemon.held = false
    return
  }
  if (daemon.homeDone) return
  const step = credentials.homeStepWhileHolding({ binding: daemon.binding, path: daemon.path })
  daemon.homeDone = step.done
}

/** Hold the channel from `fromMs` to `toMs`, ticking every 5 s like the lock heartbeat. */
function holdChannel(host: Host, daemon: Daemon, fromMs: number, toMs: number): void {
  for (let now = fromMs; now <= toMs; now += 5_000) heldTick(host, daemon, now)
}

/** The resume pin keeper the stray's daemon runs every 30 s. */
function pinKeeperFor(host: Host, daemon: Daemon): SessionPinKeeper {
  return new SessionPinKeeper({
    home: host.home,
    cwd: daemon.cwd,
    configDir: host.configDir,
    assistantId: AGENT_ID,
    exists: existsSync,
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
  })
}

function writeTranscript(host: Host, cwd: string, sessionId: string): void {
  const path = liveTranscriptPath({ home: host.home, cwd, sessionId, configDir: host.configDir })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{"type":"user"}\n')
}

test('the race: one agent, no home, a stray boots first and holds the channel past 60 s', () => {
  const host = makeHost()
  try {
    // The agent's resume pin names its real conversation, under its own folder.
    const pinPath = sessionPinPath(host.home, AGENT_ID)!
    mkdirSync(dirname(pinPath), { recursive: true })
    writeFileSync(pinPath, OLD_SESSION)
    writeTranscript(host, host.ares, OLD_SESSION)

    // 1. The agent is down. A bare claude in the BGOS repo boots first.
    const stray = bootDaemon(host, host.repo, STRAY_PID, T0)
    assert.equal(stray.via, 'sole-per-assistant', 'the stray finds the agent by elimination')
    assert.notEqual(stray.binding.action, 'refuse', 'with no home anywhere, today\'s rule lets it start')
    assert.equal(stray.held, true, 'the channel is free, so the stray takes the pairing lock')

    // 2. It holds the channel well past the 60 s filter.
    holdChannel(host, stray, T0 + 5_000, T0 + 65_000)
    assert.equal(stray.held, true)
    assert.equal(
      host.readFile().homeDir,
      undefined,
      'a daemon that found its identity by elimination never writes homeDir',
    )

    // 3. Its own session settles past the pin keeper's window: it must not repoint the resume pin.
    writeTranscript(host, host.repo, STRAY_SESSION)
    const keeper = pinKeeperFor(host, stray)
    keeper.check(
      {
        holdsChannel: stray.held,
        sessionId: STRAY_SESSION,
        seenAtMs: T0,
        printMode: false,
        homeConfirmed: stray.homeConfirmed,
      } as Parameters<SessionPinKeeper['check']>[0],
      T0 + 400_000,
    )
    assert.equal(
      readFileSync(pinPath, 'utf8'),
      OLD_SESSION,
      'a stray that has not passed the home check never repoints the agent\'s resume pin',
    )

    // 4. The agent starts from its pinned folder and takes the channel back.
    const agent = bootDaemon(host, host.ares, ARES_PID, T0 + 70_000)
    assert.equal(agent.via, 'folder-pin')
    assert.equal(agent.held, true, 'the pinned agent wins the lock from the stray')
    assert.equal(agent.lockReason, 'route-takeover')

    // 5. The stray learns it on its next heartbeat and stands down.
    heldTick(host, stray, T0 + 75_000)
    assert.equal(stray.held, false, 'the stray stands down')

    // 6. Holding the channel, the agent confirms its own folder as home.
    holdChannel(host, agent, T0 + 75_000, T0 + 80_000)
    const after = host.readFile()
    assert.equal(after.homeDir, host.ares)
    assert.equal(after.homeSource, 'pin')
    assert.equal(after.pairingToken, 'race-test-token', 'the token is carried through untouched')

    // 7. From now on a stray in the repo, or anywhere else, is refused.
    for (const folder of [host.repo, host.elsewhere]) {
      const later = bootDaemon(host, folder, LATER_STRAY_PID, T0 + 90_000)
      assert.equal(later.binding.action, 'refuse', `a stray in ${folder} is refused`)
    }
    // And a second session in the agent's folder (a subagent) is never
    // refused, and never takes the lock from the agent, which still holds it.
    holdChannel(host, agent, T0 + 85_000, T0 + 95_000)
    const sub = bootDaemon(host, host.ares, LATER_STRAY_PID + 1, T0 + 96_000)
    assert.notEqual(sub.binding.action, 'refuse')
    assert.equal(sub.held, false, 'two daemons pinned to the same agent never take the lock from each other')
  } finally {
    host.cleanup()
  }
})

test('the Ares case: a home a stray claimed under 0.64.3 is repaired by the agent\'s next pinned start', () => {
  // Written by 0.64.3's 60 s self-record: a homeDir and no homeSource.
  const host = makeHost({ recordedHomeDir: (h) => h.repo })
  try {
    // A stray in that folder matches the unconfirmed home and still starts (today's rule, kept).
    const stray = bootDaemon(host, host.repo, STRAY_PID, T0)
    assert.equal(stray.binding.action, 'allow')
    assert.equal(stray.held, true)
    // KEPT ON PURPOSE (Kc's choice 2, "keep today's rule for them, marked
    // unconfirmed"): a match against an unconfirmed home passes the home
    // check, so until the agent's next pinned start this stray could still
    // repoint the resume pin and serve Memory and Changes. Unpinned real
    // agents whose home 0.64.3 recorded correctly (a Keep agents running
    // recipe folder, a one-click whose pin bake failed, a legacy file agent)
    // rely on exactly this. The window closes at the agent's next pinned
    // start, which also takes the channel back (below).
    assert.equal(stray.homeConfirmed, true)

    const agent = bootDaemon(host, host.ares, ARES_PID, T0 + 10_000)
    assert.equal(agent.held, true, 'the pinned agent takes the channel back')
    heldTick(host, stray, T0 + 15_000)
    assert.equal(stray.held, false)
    holdChannel(host, agent, T0 + 15_000, T0 + 20_000)
    assert.equal(host.readFile().homeDir, host.ares, 'the claimed home is replaced by the agent\'s own folder')
    assert.equal(host.readFile().homeSource, 'pin')

    const next = bootDaemon(host, host.repo, LATER_STRAY_PID, T0 + 30_000)
    assert.equal(next.binding.action, 'refuse', 'the repo no longer passes as the agent\'s home')
  } finally {
    host.cleanup()
  }
})

test('paired in its pinned folder, relaunched from an unpinned one: a bare claude in the pinned folder never takes its channel', () => {
  // The review of fc75c7c3. 0.64.3 recorded the unpinned relaunch folder as
  // the home. The agent runs there by elimination, matching it, with its
  // channel loaded (hoai launches it with the channel). The owner opens a bare
  // `claude` in the pinned folder: pinned, but its channel reads unknown, and
  // taking the lock would drop every message into a session that never
  // registered the channel.
  const host = makeHost({ recordedHomeDir: (h) => h.repo })
  try {
    const agentInRepo = bootDaemon(host, host.repo, STRAY_PID, T0, true)
    assert.equal(agentInRepo.via, 'sole-per-assistant')
    assert.equal(agentInRepo.held, true)
    const bare = bootDaemon(host, host.ares, ARES_PID, T0 + 10_000, null)
    assert.equal(bare.held, false, 'the bare session stays passive')
    heldTick(host, agentInRepo, T0 + 15_000)
    assert.equal(agentInRepo.held, true, 'the agent keeps its channel')
    assert.equal(host.readFile().homeDir, host.repo, 'and its recorded home is left alone')
    assert.equal(host.readFile().homeSource, undefined)
    // A start that is proven to deliver (hoai, with the channel on its command
    // line) is the agent and takes it, as the race fix intends.
    const launched = bootDaemon(host, host.ares, LATER_STRAY_PID, T0 + 20_000, true)
    assert.equal(launched.held, true)
    assert.equal(launched.lockReason, 'route-takeover')
  } finally {
    host.cleanup()
  }
})
