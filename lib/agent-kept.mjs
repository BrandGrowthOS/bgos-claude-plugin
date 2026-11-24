/**
 * agent-kept: an agent its owner switched off stays off at the supervisor.
 *
 * KEPT is Always on ON for the agent AND Keep agents running ON for its computer. A supervisor
 * (the launchd job, the systemd --user unit, the Windows logon task) exists only while its agent
 * is kept. Two readers apply the same rules (decideKeptSupervisor): the watcher's sweep
 * (lib/watcher-keepalive.mjs: the keep-alive read once a minute, which carries the switch and the
 * list of agents the backend clears on this computer) and, on Mac and Linux, the agent's own daemon
 * (server.ts reconcileAlwaysOn: Always on, and the switch from the watcher's cached answer while it is
 * fresh, KEPT_CACHE_FRESH_MS).
 *
 *   1  The computer's switch OFF: no grace for anything. Nothing installs, and an existing
 *      supervisor goes at this read.
 *   2  An install once seen kept that is no longer kept (Always on off, or the agent off the
 *      list): no grace. It goes at this read.
 *   3  An install NEVER yet seen kept keeps a grace of 15 minutes from its install, never longer;
 *      after it, still not kept is removed. Why there is one at all (commit c8930d01): desktop
 *      one-click installs the supervisor first and the app records Always on only after it has
 *      seen the agent connect, and create_agent installs before the backend lists the new agent.
 *      Seen kept is a fact of ONE install: <statedir>/kept-seen holds the installed-at stamp it was
 *      seen with, written the first time a reader sees it kept. It is never inferred from Always on
 *      alone, and a reinstall (a new installed-at) starts never seen.
 *   4  A failed or missing read changes nothing: no install, no removal. A refusal (401/403: a revoked
 *      pairing, an auth incident) is no answer either, never the owner's switch. The sweep removes only
 *      on a live answer; the daemon reads the cache only while it is fresh.
 *   5  A removal never ends a running agent. It takes away what would START the agent next
 *      (releasePosixSupervisor here; the Windows task through releaseAgentTask), and
 *      bin/hoai-core.mjs does not launch for a supervisor that is gone (launchSupervisorGone).
 *
 * A never set switch (no owner choice yet) keeps the meaning it always had: the sweep does not
 * act, create_agent supervises a new agent, and the daemon follows Always on. So does a computer
 * with no watcher installed (watcherServiceInstalled: no service file of this HOME's watcher): it
 * has no switch. A watcher that is installed but has no answer cached yet is no answer.
 *
 * An agent with no pairing (connected with an API key) is on no keep-alive list, ever: the backend lists
 * only agents whose pairing names this computer. Being left out says nothing about it (`no_pairing`), so
 * the sweep does not act on it and the daemon follows its own Always on read. The computer's switch OFF
 * still applies to it.
 *
 * Plain JavaScript, node >= 18, import-safe; every effect is injected.
 */

import { AGENT_TASK_LAUNCHER_FILE_NAME, SUPERVISOR_FILE_NAME, SUPERVISOR_GENERATION_FILE_NAME, agentStateDir, credentialsPath, joinDir, parseSupervisorFile, validAssistantId } from './agent-inventory.mjs'
import { agentTaskRegistration, uninstallAgentTask } from './agent-task-win32.mjs'
import { KEEPALIVE_CACHE_FORMAT, decideKeepAliveConsent, parseKeepAliveCache } from './keepalive-plan.mjs'
import { watcherHome } from './watcher-bundle.mjs'
import { watcherServiceSpec } from './watcher-service.mjs'

/** How long an install never seen kept is left alone, from its install. */
export const INSTALL_GRACE_MS = 15 * 60_000
/** Epoch SECONDS of the install, as `date +%s` writes it (bin/bgos-agent; releaseAgentTask's twin for a task). */
export const INSTALLED_AT_FILE_NAME = 'installed-at'
/** The installed-at text of the install a reader first saw kept. */
export const KEPT_SEEN_FILE_NAME = 'kept-seen'
/** Written in the agent's state dir by a Windows task removal (releaseAgentTask): its launcher's absence is then a sign. */
export const NOT_KEPT_FILE_NAME = 'not-kept'
/**
 * What an agent with no pairing file is told once its supervisor was removed (review round 6 F1, round 7 M4): the
 * switch alone cannot bring it back. Said by hoai (bin/hoai-core.mjs) and written to agent.log by the not-kept
 * run.sh, which `hoai-agent status` and `hoai-agent logs` show.
 */
export const START_ONCE_WORDS = 'Turn it back on, then start it once and it will be kept again (it has no pairing file here, so the switch alone cannot bring it back).'
/** The line every not-kept run.sh carries: hoai reads it as "this agent's supervisor was removed". */
export const NOT_KEPT_RUN_SH_MARK = '# hoai: this agent is not kept running'
/** A removal's own commands are quick; a hung systemctl must not hold a reader. */
export const RELEASE_EXEC_TIMEOUT_MS = 30_000
/** How long a Mac or Linux removal waits for an install of the same agent to let go of its lock (bin/bgos-agent UNINSTALL_LOCK_WAIT_S). */
export const RELEASE_LOCK_WAIT_MS = 30_000
const RELEASE_LOCK_POLL_MS = 1_000
/**
 * How old the watcher's cached answer may be for a reader that has only the cache (the daemon, and
 * bin/bgos-agent's install). The watcher rewrites it every minute while it runs: older means it is
 * not running, and its answer is no answer (the watcher's own 24 h bridge is for its own outages).
 */
export const KEPT_CACHE_FRESH_MS = 5 * 60_000
/** What a hoai launcher of this version declares in supervisor.json: it stops once its supervisor is removed (launchSupervisorGone). */
export const KEPT_CHECK_CAPABILITY = 'kept-check'
/** Written by a not-kept run.sh whose own removal failed (a bootout, a reload): it waits, and says so once. */
export const NOT_KEPT_STUCK_FILE_NAME = 'not-kept-stuck'
/** How long that run.sh waits before it tries again, and exits for launchd or systemd to run it again. */
export const NOT_KEPT_RETRY_SECONDS = 1800
/** How many times a removal runs systemctl --user daemon-reload while the unit still runs. */
export const RELOAD_TRIES = 3
/**
 * What the Helper says when a not kept agent's Windows start task stays, by why (lib/agent-task-win32.mjs
 * uninstallAgentTask `taskKept`): it could not be read (the maintainer's ruling: an unreadable task is
 * never half removed), or Windows refused to unregister it. Either way the task and its launcher stay and
 * may start the agent again. It rides the watcher's report as a `failed` watched entry
 * (lib/watcher-keepalive.mjs), no new kind.
 */
export const TASK_KEPT_WORDS = Object.freeze({
  unreadable: "I could not read this agent's start task on Windows, so I left it in place.",
  not_unregistered: "Windows would not let me remove this agent's start task, so I left it in place.",
})

function stampOf(text) {
  const t = String(text ?? '').trim()
  return /^\d{9,11}$/.test(t) ? t : null
}

/**
 * Milliseconds of grace left, 0 when there is none. Unreadable, or a stamp from the future, is no
 * grace at all: a guard that fails open would keep a supervisor the owner switched off.
 * @param {string | null | undefined} stamp the installed-at text
 * @param {number} nowMs
 */
export function installGraceRemainingMs(stamp, nowMs, graceMs = INSTALL_GRACE_MS) {
  const text = stampOf(stamp)
  if (!text) return 0
  const age = nowMs - Number(text) * 1000
  if (!Number.isFinite(age) || age < 0) return 0
  return age < graceMs ? graceMs - age : 0
}

/** The installed-at text for an install made at `nowMs`. */
export function installStampText(nowMs) {
  return `${Math.floor(nowMs / 1000)}\n`
}

/** Was THIS install (its installed-at text) seen kept? kept-seen must hold the same stamp. */
export function seenKept(installedAt, keptSeen) {
  const stamp = stampOf(installedAt)
  return stamp !== null && stampOf(keptSeen) === stamp
}

/**
 * What one keep-alive answer (lib/keepalive-plan.mjs decideKeepAliveConsent) says about one agent:
 *   kept        the switch is ON and the backend lists the agent (Always on, on this computer)
 *   not_listed  the switch is ON and the agent is not on the list, confirmed: two reads left it out a
 *               minute apart with none between listing it (the maintainer's rulings, an empty list or one
 *               agent left out alike; lib/keepalive-plan.mjs listedRecently). One such read is `unknown`,
 *               so one bad answer never removes a supervisor
 *   no_pairing  the switch is ON, the agent is not on the list, and it has no pairing the list could name
 *               it by (`paired: false`): the list says nothing about it
 *   switch_off  the switch is OFF: the owner's own switch, so it acts on one read (the ruling)
 *   never_set   the owner has never set it
 *   unknown     no answer and no young cache, or a refusal (401/403: the watcher's pairing revoked,
 *               or an auth incident): never the owner's switch, so nothing moves on it
 * @param {{ enabled?: boolean, assistantIds?: string[], switchState?: string, source?: string, listedRecently?: string[] } | null | undefined} consent
 * @param {string | number} assistantId
 * @param {{ paired?: boolean }} [opts] false: this agent has no pairing (agentHasPairing, or the daemon's own auth mode)
 */
export function keepAliveStanding(consent, assistantId, { paired = true } = {}) {
  if (!consent || !consent.source || consent.source === 'none' || consent.source === 'refused') return 'unknown'
  if (consent.switchState === 'never_set') return 'never_set'
  if (consent.enabled !== true) return 'switch_off'
  const id = validAssistantId(assistantId)
  if (!id) return 'not_listed'
  if ((consent.assistantIds ?? []).map(String).includes(id)) return 'kept'
  if (paired === false) return 'no_pairing'
  return Array.isArray(consent.listedRecently) && !consent.listedRecently.map(String).includes(id) ? 'not_listed' : 'unknown'
}

/**
 * Could the backend's list name this inventory row? A row found only through the folder a loaded job
 * runs has no credentials file, so no pairing (lib/agent-inventory.mjs discoveredVia).
 * @param {{ discoveredVia?: string } | null | undefined} row
 */
export function agentHasPairing(row) {
  return row?.discoveredVia !== 'supervised-folder'
}

/**
 * The same rule from the files, for a reader with no inventory row (bin/hoai-core.mjs): does this agent have its
 * own pairing file here (~/.bgos-agent/credentials-<id>.json)? Presence only, never its content. Without one the
 * agent is found only through its loaded job, so a removal that takes the job takes it out of every sweep too: the
 * switch coming back on cannot bring it back, its own daemon can once it runs (review round 6 F1). Unreadable
 * counts as a pairing.
 * @param {{ home: string, assistantId: string | number, exists: (path: string) => boolean }} p
 */
export function hasPairingFile({ home, assistantId, exists }) {
  const path = credentialsPath(home, assistantId)
  if (!path) return true
  try {
    return exists(path) === true
  } catch {
    return true
  }
}

/**
 * The same, from the watcher's cached answer (~/.bgos-agent/watcher/keepalive.json), for a reader
 * that cannot ask the backend itself. A stale, junk or missing file is no answer, and so is a cached
 * refusal (the watcher marks it refused), and so is a cache without KEEPALIVE_CACHE_FORMAT: a watcher
 * from before that mark wrote a refusal as a plain OFF, which must never read as the switch off.
 * `maxAgeMs` is the reader's own limit (the daemon's: KEPT_CACHE_FRESH_MS); without one, the cache's
 * own 24 h rule. `watcherInstalled` false is a
 * computer with no watcher (watcherServiceInstalled): `no_watcher`, whatever file is left.
 * @param {string | null | undefined} cacheText
 * @param {string | number} assistantId
 * @param {number} now
 * @param {{ maxAgeMs?: number | null, watcherInstalled?: boolean, paired?: boolean }} [opts]
 */
export function keepAliveStandingFromCache(cacheText, assistantId, now, { maxAgeMs = null, watcherInstalled = true, paired = true } = {}) {
  if (watcherInstalled === false) return 'no_watcher'
  const cache = parseKeepAliveCache(cacheText)
  if (cache && !(Number(cache.format) >= KEEPALIVE_CACHE_FORMAT)) return 'unknown'
  if (cache && maxAgeMs != null && !(now - cache.fetchedAtMs < maxAgeMs)) return 'unknown'
  return keepAliveStanding(decideKeepAliveConsent({ live: null, cache, now }), assistantId, { paired })
}

/**
 * The service files of this HOME's watcher (lib/watcher-service.mjs, the same spec its install
 * writes): its own name's, then the OLD name's an older version used. Any one there is a watcher.
 * @param {{ platform: string, home: string, env?: Record<string, string | undefined> }} p
 * @returns {string[]}
 */
export function watcherServiceFiles({ platform, home, env = {} }) {
  try {
    // uid and username only name the launchd domain and the account inside the files, never a path.
    const spec = watcherServiceSpec({ platform, home, nodePath: 'node', bundleDir: watcherHome(home), uid: 0, username: 'user', env, exists: () => false })
    return [...spec.files.map((f) => f.path), ...(spec.legacy?.files ?? [])]
  } catch {
    return []
  }
}

/**
 * Is a watcher installed for this HOME (m2: "no watcher" is decided from its install, never from a
 * missing cache, which a fresh watcher before its first sweep has too)? Unreadable is a watcher: a
 * reader that guesses "none" installs on Always on alone, which the watcher then removes again.
 * @param {{ platform: string, home: string, env?: Record<string, string | undefined>, exists: (path: string) => boolean }} p
 */
export function watcherServiceInstalled({ platform, home, env = {}, exists }) {
  const files = watcherServiceFiles({ platform, home, env })
  if (files.length === 0) return true
  try {
    return files.some((path) => exists(path))
  } catch {
    return true
  }
}

/**
 * An install made because its agent is kept is seen kept at once (m1): kept-seen gets the
 * installed-at this install just wrote. No stamp, nothing marked. Never throws.
 * @param {{ stateDir: string, readFile: (path: string) => string | null, writeFile: (path: string, text: string) => void }} p
 */
export function markInstallSeenKept({ stateDir, readFile, writeFile }) {
  try {
    const stamp = stampOf(readFile(joinDir(stateDir, INSTALLED_AT_FILE_NAME)))
    if (!stamp) return false
    writeFile(joinDir(stateDir, KEPT_SEEN_FILE_NAME), `${stamp}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * The pid of a LIVE hoai launcher whose supervisor.json does not declare KEPT_CHECK_CAPABILITY, or
 * null: one from an older version, which relaunches claude after it exits whatever happened to its
 * supervisor, until it is restarted once (m5: said, never acted on).
 * @param {{ launcherLive: boolean, stateDir: string | null | undefined, readFile: (path: string) => string | null }} p
 */
export function olderLiveLauncher({ launcherLive, stateDir, readFile }) {
  if (!launcherLive || !stateDir) return null
  try {
    const sup = parseSupervisorFile(readFile(joinDir(stateDir, SUPERVISOR_FILE_NAME)))
    return sup && !sup.capabilities.includes(KEPT_CHECK_CAPABILITY) ? sup.pid : null
  } catch {
    return null
  }
}

/** Where the watcher caches its keep-alive answer (lib/watcher-keepalive.mjs keepAliveCachePath, the same file). */
export function keepAliveCacheFile(home) {
  return joinDir(watcherHome(home), 'keepalive.json')
}

const STANDINGS = new Set(['kept', 'not_listed', 'no_pairing', 'switch_off', 'never_set', 'unknown', 'no_watcher'])
/** decideKeptSupervisor's reason when a supervisor a removal took waits for a live list (review round 7 M5). */
export const WAITS_FOR_LIVE_LIST = 'removed:waits_for_live_list'

/**
 * What a reader does with one agent's supervisor.
 *   install  kept, and none is installed (the daemon installs; the sweep's own install path does)
 *   leave    kept, and it is installed
 *   grace    not kept, installed, never seen kept, inside its 15 minutes: left alone
 *   remove   not kept and installed: remove it without ending what runs
 *   none     nothing to do, or nothing CAN be decided (no answer; a never set switch for the sweep)
 * `markSeen`: write kept-seen (this install's stamp) now.
 * `removedNotKept` (supervisorRemovedNotKept): a removal took this agent's supervisor. Kept only by the list,
 * it then installs nothing (`none`, WAITS_FOR_LIVE_LIST): the daemon reads the watcher's cached list, which can
 * be older than the removal, so the sweep puts it back once a LIVE list names it (review round 6 F2, round 7
 * M5). Kept by Always on alone (no pairing, a never set switch, no watcher), it installs as before.
 * @param {{ alwaysOn?: boolean, standing: string, installed: boolean, installedAt?: string | null,
 *   keptSeen?: string | null, now: number, removedNotKept?: boolean }} input
 *   `alwaysOn` only from a reader that reads it (the daemon); the sweep sees it through the list.
 * @returns {{ kept: boolean | null, action: 'install' | 'leave' | 'grace' | 'remove' | 'none', reason: string, graceLeftMs: number, markSeen: boolean }}
 */
export function decideKeptSupervisor(input) {
  const readsAlwaysOn = typeof input.alwaysOn === 'boolean'
  const standing = STANDINGS.has(input.standing) ? input.standing : 'unknown'
  const out = (kept, action, reason, extra = {}) => ({ kept, action, reason, graceLeftMs: 0, markSeen: false, ...extra })
  let kept
  // Always on OFF is an answer of its own: whatever the switch says, the agent is not kept.
  if (input.alwaysOn === false) kept = false
  else if (standing === 'unknown') return out(null, 'none', 'no_answer')
  else if (standing === 'kept') kept = true
  else if (standing === 'never_set' || standing === 'no_watcher' || standing === 'no_pairing') {
    // The sweep does not act, the daemon follows Always on (on, here).
    if (!readsAlwaysOn) return out(null, 'none', standing)
    kept = true
  } else kept = false
  const installed = input.installed === true
  if (kept) {
    if (!installed && standing === 'kept' && input.removedNotKept === true) return out(true, 'none', WAITS_FOR_LIVE_LIST)
    const markSeen = installed && stampOf(input.installedAt) !== null && !seenKept(input.installedAt, input.keptSeen)
    return out(true, installed ? 'leave' : 'install', standing, { markSeen })
  }
  const cause = input.alwaysOn === false && standing !== 'switch_off' ? 'always_on_off' : standing
  if (!installed) return out(false, 'none', cause)
  if (standing === 'switch_off') return out(false, 'remove', 'switch_off')
  if (seenKept(input.installedAt, input.keptSeen)) return out(false, 'remove', `${cause}:was_kept`)
  const left = installGraceRemainingMs(input.installedAt, input.now)
  if (left > 0) return out(false, 'grace', `${cause}:never_kept`, { graceLeftMs: left })
  return out(false, 'remove', `${cause}:grace_over`)
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
}

/** A bash single quoted word. */
function sq(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'"
}

/**
 * What a removal writes through (a subset of lib/watcher-bundle.mjs WatcherFs). `mkdirExclusive` (throws when
 * the directory is there) and `rmdir` take and let go of bin/bgos-agent's install lock; without them none is taken.
 * @typedef {{ exists: (path: string) => boolean, writeFile: (path: string, text: string, opts?: { mode?: number }) => void,
 *   rename: (from: string, to: string) => void, rm: (path: string) => void,
 *   mkdirExclusive?: (path: string) => void, rmdir?: (path: string) => void }} ReleaseFs
 */

/** bin/bgos-agent install_lock_for: the per-agent install lock, a directory BESIDE the state dir. */
export function installLockPath(home, assistantId) {
  return `${agentStateDir(home, assistantId)}.install.lock`
}

/**
 * Take the lock bin/bgos-agent install holds from before its switch check until it has written run.sh and the
 * service (review round 7 M3): an install that passed its check while the agent was kept would otherwise put
 * them back right after this removal. Waited for as cmd_uninstall does, never refused: after `waitMs` the
 * removal goes ahead anyway and says so (the install then asks the switch again before it writes).
 * @returns {Promise<{ lock: string | null, note: string | null }>} `lock` when this removal now holds it
 */
async function takeInstallLock({ home, assistantId, fs, sleep, waitMs }) {
  if (typeof fs.mkdirExclusive !== 'function') return { lock: null, note: null }
  const lock = installLockPath(home, assistantId)
  for (let waited = 0; ; waited += RELEASE_LOCK_POLL_MS) {
    try {
      fs.mkdirExclusive(lock)
      return { lock, note: null }
    } catch (err) {
      if (err?.code !== 'EEXIST') return { lock: null, note: `its install lock ${lock} could not be taken (${String(err?.message ?? err)}), so it was removed without it` }
    }
    if (waited >= waitMs) return { lock: null, note: `an install of agent ${assistantId} still held ${lock} after ${Math.round(waitMs / 1000)}s, so it was removed anyway` }
    await sleep(RELEASE_LOCK_POLL_MS)
  }
}

/**
 * The run.sh a removed supervisor leaves behind. It starts nothing. A run.sh that was already running
 * keeps the one it opened (this one is moved into place, never written over it), and hoai, which that
 * run.sh may still start, reads this one and starts nothing either (launchSupervisorGone).
 *   darwin  launchd runs it only after the run.sh that was running has exited, so after the agent
 *           has exited: it boots its own job out, which then ends nothing but itself.
 *   linux   the unit is disabled and its file deleted; systemd runs this only while the user manager
 *           still holds the unit's old Restart (the removal's daemon-reload failed), so it reloads the
 *           manager itself: the unit is then gone, and this exit is its last.
 * Its own removal failing (the bootout, the reload) must not loop unseen (m4): it says so once (the
 * NOT_KEPT_STUCK_FILE_NAME marker) and waits NOT_KEPT_RETRY_SECONDS before it exits and is run again.
 * An agent with no pairing file (`paired` false) is told START_ONCE_WORDS in agent.log, the one place this
 * run.sh writes to: the switch coming back on does not install it again (review round 7 M4).
 * @param {{ platform?: string, assistantId: string, label: string, stateDir: string, paired?: boolean }} p
 */
export function notKeptRunSh({ platform = 'darwin', assistantId, label, stateDir, paired = true }) {
  const mac = platform === 'darwin'
  const ts = "[$(date '+%Y-%m-%d %H:%M:%S')]"
  const remove = mac ? 'launchctl bootout "gui/$(id -u)/$label"' : 'systemctl --user daemon-reload'
  const failed = mac
    ? `launchctl bootout of $label failed, so launchd may start this again; it tries again every ${NOT_KEPT_RETRY_SECONDS / 60} minutes. To end it now: launchctl bootout gui/$(id -u)/$label`
    : `systemctl --user daemon-reload failed, so the removed unit $label may start this again; it tries again every ${NOT_KEPT_RETRY_SECONDS / 60} minutes. To end it now: systemctl --user daemon-reload`
  return [
    '#!/usr/bin/env bash',
    NOT_KEPT_RUN_SH_MARK,
    `# Written by HOAI (lib/agent-kept.mjs) when agent ${assistantId} stopped being kept running: Keep agents`,
    '# running is off for this computer, or Always on is off for this agent. It starts nothing.',
    ...(mac
      ? [
          '# launchd runs it only after the run.sh that was running has exited, so after the agent has exited;',
          '# it removes this launchd job, so the agent is not brought back.',
        ]
      : [
          '# systemd runs it only while the user manager still holds the removed unit (its reload failed);',
          '# it reloads the manager, so the unit is gone and this exit is its last.',
        ]),
    '# A removal of its own that fails is said once, and tried again after a long wait.',
    paired
      ? '# Turning it back on installs the real supervisor again (hoai-agent install --always-on).'
      : '# It has no pairing file here, so turning it back on does not install it again: start it once and it is kept again.',
    `sd=${sq(stateDir)}`,
    `label=${sq(label)}`,
    `stuck="$sd/${NOT_KEPT_STUCK_FILE_NAME}"`,
    `[ -e "$stuck" ] || echo "${ts} agent ${assistantId} is not kept running: not starting it${mac ? '; removing the launchd job $label' : ''}${paired ? '' : `. ${START_ONCE_WORDS}`}" >> "$sd/agent.log" 2>/dev/null`,
    ...(mac ? [] : ['export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"']),
    `if ! ${remove} >/dev/null 2>&1; then`,
    '  if [ ! -e "$stuck" ]; then',
    '    : > "$stuck" 2>/dev/null',
    `    echo "${ts} agent ${assistantId}: ${failed}" >> "$sd/agent.log" 2>/dev/null`,
    '  fi',
    `  sleep ${NOT_KEPT_RETRY_SECONDS}`,
    'fi',
    'exit 0',
    '',
  ].join('\n')
}

/** Move a not-kept run.sh into place (written beside, then renamed: a running bash keeps its own). */
function placeNotKeptRunSh({ platform, assistantId, label, home, fs }) {
  const stateDir = agentStateDir(home, assistantId)
  const runSh = joinDir(stateDir, 'run.sh')
  const tmp = `${runSh}.not-kept.tmp`
  // A stuck marker of an earlier removal: this one starts with nothing said yet.
  try {
    const stuck = joinDir(stateDir, NOT_KEPT_STUCK_FILE_NAME)
    if (fs.exists(stuck)) fs.rm(stuck)
  } catch {}
  try {
    const paired = hasPairingFile({ home, assistantId, exists: (p) => fs.exists(p) })
    fs.writeFile(tmp, notKeptRunSh({ platform, assistantId, label, stateDir, paired }), { mode: 0o755 })
    fs.rename(tmp, runSh)
    return null
  } catch (err) {
    try {
      if (fs.exists(tmp)) fs.rm(tmp)
    } catch {}
    return `${runSh} could not be replaced (${String(err?.message ?? err)})`
  }
}

/**
 * Was this launch started by a supervisor that has since been removed because its agent is not kept?
 * Then it starts nothing (bin/hoai-core.mjs). Asked of supervised launches only, never of a person's:
 *   win32   the agent task's own `hoai-core --keep-alive` (supervised AND keep-alive; the restart
 *           ladder's hidden launch is supervised without it): a removal's marker is there AND its
 *           launcher, run-agent.vbs, is gone (installed again, the launcher is back).
 *   posix   run.sh's hoai (supervised): run.sh is now the not-kept one.
 * A file that cannot be read says nothing: only a positive sign stops a launch.
 * @param {{ platform: string, supervised: boolean, keepAlive: boolean, stateDir: string,
 *   exists: (path: string) => boolean, readFile: (path: string) => string | null }} p
 * @returns {'task_removed' | 'service_removed' | null}
 */
export function launchSupervisorGone({ platform, supervised, keepAlive, stateDir, exists, readFile }) {
  if (!supervised || !stateDir) return null
  try {
    if (platform === 'win32') {
      if (!keepAlive) return null
      if (!exists(joinDir(stateDir, NOT_KEPT_FILE_NAME))) return null
      return exists(joinDir(stateDir, AGENT_TASK_LAUNCHER_FILE_NAME)) ? null : 'task_removed'
    }
    const runSh = readFile(joinDir(stateDir, 'run.sh'))
    return typeof runSh === 'string' && runSh.includes(NOT_KEPT_RUN_SH_MARK) ? 'service_removed' : null
  } catch {
    return null
  }
}

/**
 * Is this agent's run.sh the not-kept one a removal moved into place (Mac and Linux)? A unit or plist still
 * there running it is a removal that stopped half way (review round 6 F6). A file that cannot be read says nothing.
 * @param {{ stateDir: string | null | undefined, readFile: (path: string) => string | null }} p
 */
export function runShNotKept({ stateDir, readFile }) {
  if (!stateDir) return false
  try {
    const runSh = readFile(joinDir(stateDir, 'run.sh'))
    return typeof runSh === 'string' && runSh.includes(NOT_KEPT_RUN_SH_MARK)
  } catch {
    return false
  }
}

/**
 * Did a removal here take this agent's supervisor, with no install since? The removal's not-kept marker is
 * there: a Windows task removal writes it first, and a Linux removal leaves it when it could not write the
 * not-kept run.sh (review round 7 M1); an install deletes it (installProductSupervisor on Windows,
 * bin/bgos-agent install on Mac and Linux). Or, Mac and Linux, run.sh is the not-kept one (an install writes a
 * real one). The sweep then installs only on a LIVE list naming the agent: a cached list may be older than the
 * removal (review round 6 F2). A file that cannot be read says nothing.
 * @param {{ platform: string, stateDir: string | null | undefined, exists: (path: string) => boolean, readFile: (path: string) => string | null }} p
 */
export function supervisorRemovedNotKept({ platform, stateDir, exists, readFile }) {
  if (!stateDir) return false
  let marked = false
  try {
    marked = exists(joinDir(stateDir, NOT_KEPT_FILE_NAME)) === true
  } catch {}
  if (marked || platform === 'win32') return marked
  return runShNotKept({ stateDir, readFile })
}

/**
 * The sign a Linux removal leaves when its not-kept run.sh could not be moved into place (review round 7 M1):
 * the not-kept marker, which supervisorRemovedNotKept reads. Null when written, else what went wrong.
 */
function leaveNotKeptMarker({ home, assistantId, fs }) {
  const marker = joinDir(agentStateDir(home, assistantId), NOT_KEPT_FILE_NAME)
  try {
    fs.writeFile(marker, 'not_kept\n')
    return null
  } catch (err) {
    return `${marker} could not be written either (${String(err?.message ?? err)})`
  }
}

/**
 * Remove an agent's canonical Mac or Linux supervisor WITHOUT ending what it runs now (rule 5).
 *   linux   systemctl --user disable <unit>, the not-kept run.sh moved into place, the unit file
 *           deleted, systemctl --user daemon-reload.
 *           Measured on systemd 255 (WSL, a throwaway unit): the running process stays up
 *           (LoadState=not-found, ActiveState=active, Restart=no), is NOT restarted when it
 *           exits, and the unit is gone after that. A disable that fails removes nothing, so the
 *           next read tries again. A reload that fails is tried again while the unit still runs
 *           (RELOAD_TRIES), and when it never works that is said (`note`): the not-kept run.sh,
 *           which the old Restart would run, reloads the manager itself.
 *   darwin  launchd keeps a loaded job's KeepAlive until the job is booted out, and a bootout ends
 *           what it runs (run.sh's TERM trap ends the agent's tmux server). So the job stays
 *           loaded; its run.sh is replaced by notKeptRunSh (written beside and moved into place: a
 *           running bash keeps reading the file it opened), and then the plist goes, so no login
 *           loads it again. A run.sh that cannot be replaced leaves the plist too. On both, a run.sh
 *           still waiting to start the agent finds hoai starting nothing (launchSupervisorGone).
 * Either way it first takes bin/bgos-agent's install lock for the agent, waiting up to RELEASE_LOCK_WAIT_MS for
 * an install that holds it (review round 7 M3), and lets go of it after.
 *   linux, a run.sh that cannot be replaced (review round 7 M1): the unit still goes (kept, it would start
 *           the agent at its next exit), but that is no success (`ok` false, `partial`): the not-kept
 *           marker is left instead as the sign the sweep reads, and `note` says which.
 * `service` is the inventory's canonical service (lib/agent-inventory.mjs): this HOME's file.
 * @param {{ platform: string, service: { kind: string, handle: string, file: string }, assistantId: string,
 *   home: string, exec: Function, fs: ReleaseFs, env?: Record<string, string | undefined>,
 *   sleep?: (ms: number) => Promise<void>, lockWaitMs?: number }} p
 * @returns {Promise<{ ok: boolean, partial?: boolean, message: string, note?: string, ran: Array<{ file: string, args: string[], code: number | null }> }>}
 */
export async function releasePosixSupervisor({ platform, service, assistantId, home, exec, fs, env, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), lockWaitMs = RELEASE_LOCK_WAIT_MS }) {
  const id = validAssistantId(assistantId)
  if (!id || !service?.handle || !service?.file) return { ok: false, message: 'no canonical supervisor named', ran: [] }
  if (platform !== 'linux' && platform !== 'darwin') return { ok: false, message: `no ${platform} supervisor here`, ran: [] }
  const held = await takeInstallLock({ home, assistantId: id, fs, sleep, waitMs: lockWaitMs })
  try {
    const out = await releaseUnderLock({ platform, service, id, home, exec, fs, env })
    return held.note ? { ...out, note: [out.note, held.note].filter(Boolean).join('; ') } : out
  } finally {
    if (held.lock) {
      try {
        fs.rmdir?.(held.lock)
      } catch {}
    }
  }
}

/** releasePosixSupervisor's work, under the install lock. */
async function releaseUnderLock({ platform, service, id, home, exec, fs, env }) {
  const ran = []
  const run = async (file, args) => {
    let res
    try {
      res = await exec(file, args, { env, timeoutMs: RELEASE_EXEC_TIMEOUT_MS })
    } catch (err) {
      res = { code: null, stdout: '', stderr: String(err?.message ?? err) }
    }
    ran.push({ file, args: [...args], code: res?.code ?? null })
    return res
  }
  const why = (res) => firstLine(res?.stderr) || firstLine(res?.stdout) || `rc ${res?.code ?? 'null'}`
  if (platform === 'linux') {
    const disabled = await run('systemctl', ['--user', 'disable', service.handle])
    if (disabled?.code !== 0) return { ok: false, message: `systemctl --user disable ${service.handle} failed (${why(disabled)}); nothing was removed`, ran }
    // A run.sh still waiting to start the agent (behind an incumbent) then finds hoai starting nothing.
    const notPlaced = placeNotKeptRunSh({ platform, assistantId: id, label: service.handle, home, fs })
    try {
      fs.rm(service.file)
    } catch (err) {
      return { ok: false, message: `${service.file} could not be removed: ${String(err?.message ?? err)}`, ran }
    }
    // Review round 7 M1: the unit is gone, but without the not-kept run.sh the sweep would read no removal: the marker says it.
    const unmarked = notPlaced ? leaveNotKeptMarker({ home, assistantId: id, fs }) : null
    let reloaded = await run('systemctl', ['--user', 'daemon-reload'])
    // Still running, the unit keeps its old Restart in the manager until a reload: tried again while it runs.
    for (let tries = 1; reloaded?.code !== 0 && tries < RELOAD_TRIES; tries++) {
      const active = await run('systemctl', ['--user', 'is-active', service.handle])
      if (!/^(active|activating|reloading)$/.test(firstLine(active?.stdout))) break
      reloaded = await run('systemctl', ['--user', 'daemon-reload'])
    }
    if (notPlaced) {
      const marker = joinDir(agentStateDir(home, id), NOT_KEPT_FILE_NAME)
      const sign = unmarked ? `${unmarked}, so a cached list can put it back until a live one is read` : `left ${marker} instead, so no cached list puts it back`
      const reload = reloaded?.code === 0 ? 'reloaded' : `daemon-reload failed (${why(reloaded)}), so until a reload the unit may run the real run.sh once more`
      return { ok: false, partial: true, message: `${notPlaced}; ${service.handle} is disabled and its unit file deleted (${reload}); ${sign}`, note: sign, ran }
    }
    if (reloaded?.code !== 0) {
      const note = `systemctl --user daemon-reload failed (${why(reloaded)}) after ${service.file} was removed: until a reload the unit may run its run.sh once more, and that run.sh reloads it itself and starts nothing`
      return { ok: true, message: `removed ${service.handle} (disabled, unit file deleted; ${note}); what it runs now is left to finish`, note, ran }
    }
    return { ok: true, message: `removed ${service.handle} (disabled, unit file deleted, reloaded); what it runs now is left to finish`, ran }
  }
  if (platform === 'darwin') {
    // The job stays loaded (a bootout now would end the agent): its next run is the not-kept run.sh.
    const notPlaced = placeNotKeptRunSh({ platform, assistantId: id, label: service.handle, home, fs })
    if (notPlaced) return { ok: false, message: `${notPlaced}; nothing was removed`, ran }
    try {
      fs.rm(service.file)
    } catch (err) {
      return { ok: false, message: `${service.file} could not be removed: ${String(err?.message ?? err)}`, ran }
    }
    return { ok: true, message: `removed ${service.handle} (plist deleted; the job boots itself out once what it runs now has exited)`, ran }
  }
  return { ok: false, message: `no ${platform} supervisor here`, ran }
}

/**
 * Remove an agent's Windows logon task (rule 5, Windows): the task is unregistered and its
 * launcher files removed (lib/agent-task-win32.mjs uninstallAgentTask, read back first). A running
 * agent is not ended by this; its `hoai-core --keep-alive` finds the marker written first and its
 * launcher gone, and does not relaunch claude again (launchSupervisorGone). Strict (m3): a task that
 * cannot be read back, or whose Unregister fails, is NOT removed and nothing of it is deleted, so
 * the inventory still sees it and the next read tries again.
 * @param {{ assistantId: string, home: string, exec: Function, fs: import('./watcher-bundle.mjs').WatcherFs, timeoutMs?: number, why?: string }} p
 */
export async function releaseAgentTask({ assistantId, home, exec, fs, timeoutMs = RELEASE_EXEC_TIMEOUT_MS, why = 'not_kept' }) {
  const reg = agentTaskRegistration({ assistantId, home })
  try {
    fs.writeFile(joinDir(reg.stateDir, NOT_KEPT_FILE_NAME), `${why}\n`)
  } catch (err) {
    return { ok: false, message: `${joinDir(reg.stateDir, NOT_KEPT_FILE_NAME)} could not be written (${String(err?.message ?? err)}); nothing was removed`, ran: [] }
  }
  const files = [
    { path: reg.launcherPath },
    reg.script,
    { path: joinDir(reg.stateDir, SUPERVISOR_GENERATION_FILE_NAME) },
  ]
  return uninstallAgentTask({ ...reg, files }, { exec, fs, timeoutMs, strict: true })
}
