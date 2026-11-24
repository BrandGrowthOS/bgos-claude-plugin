/**
 * lib/agent-kept.mjs: an agent its owner switched off stays off at the supervisor.
 *
 * Kept is Always on ON for the agent AND Keep agents running ON for its computer. The rules every
 * reader applies (the watcher's sweep, the agent's own daemon):
 *   1 the computer's switch off: no grace for anything, nothing installs, an existing supervisor goes;
 *   2 an install once seen kept that stops being kept: no grace, it goes at this read;
 *   3 an install never yet seen kept: 15 minutes of grace from its install, never longer;
 *   4 no answer (a failed or missing read) changes nothing;
 *   5 a removal never ends a running agent.
 * A never set switch, and a computer with no watcher at all, keep the meaning they have always had.
 *
 * Run: npx tsx --test test/agent-kept.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INSTALL_GRACE_MS,
  INSTALLED_AT_FILE_NAME,
  KEPT_CACHE_FRESH_MS,
  KEPT_CHECK_CAPABILITY,
  KEPT_SEEN_FILE_NAME,
  NOT_KEPT_FILE_NAME,
  NOT_KEPT_RUN_SH_MARK,
  NOT_KEPT_STUCK_FILE_NAME,
  decideKeptSupervisor,
  hasPairingFile,
  installGraceRemainingMs,
  keepAliveStanding,
  keepAliveCacheFile,
  keepAliveStandingFromCache,
  launchSupervisorGone,
  markInstallSeenKept,
  notKeptRunSh,
  olderLiveLauncher,
  releaseAgentTask,
  releasePosixSupervisor,
  seenKept,
  supervisorRemovedNotKept,
  watcherServiceFiles,
  watcherServiceInstalled,
} from '../lib/agent-kept.mjs'
import { buildKeepAliveCache, decideCreateLaunch, decideKeepAliveConsent, parseKeepAliveCache } from '../lib/keepalive-plan.mjs'
import { keepAliveCachePath } from '../lib/watcher-keepalive.mjs'
import { agentTaskRegistration } from '../lib/agent-task-win32.mjs'
import { agentTaskDescription } from '../lib/agent-service.mjs'
import { supervisorFileBody } from '../bin/hoai-core.mjs'
import { main as agentServiceMain } from '../bin/hoai-agent-service.mjs'
import { fakeAgentTasks } from './helpers/fake-agent-tasks.ts'
import { memoryFs } from './helpers/memory-fs.ts'
import { mkdtempSync, rmSync as rmTree } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { nodeFs } from '../lib/watcher-bundle.mjs'

const NOW = 1_800_000_000_000
const MIN = 60_000
/** The installed-at text bin/bgos-agent writes (`date +%s`), `msAgo` before NOW. */
const stamp = (msAgo: number) => `${Math.floor((NOW - msAgo) / 1000)}\n`

// -- what the keep-alive answer says about one agent ------------------------------------------------

test('the keep-alive answer, for one agent: kept only with the switch ON and the agent on the list', () => {
  const live = (enabled: boolean, ids: string[], switchState = enabled ? 'on' : 'off') => ({ enabled, enabledAt: null, assistantIds: ids, switchState, showAgentWindows: false, source: 'live' })
  assert.equal(keepAliveStanding(live(true, ['912', '7']), '912'), 'kept')
  // Left out of one read is no answer; two reads confirm it, and a read between that lists it does not.
  assert.equal(keepAliveStanding(live(true, ['7']), '912'), 'unknown')
  assert.equal(keepAliveStanding({ ...live(true, ['7']), listedRecently: ['7'] }, '912'), 'not_listed')
  assert.equal(keepAliveStanding({ ...live(true, ['7']), listedRecently: ['7', '912'] }, '912'), 'unknown')
  // A list that rides an OFF answer clears nobody (decision D2).
  assert.equal(keepAliveStanding(live(false, ['912']), '912'), 'switch_off')
  assert.equal(keepAliveStanding(live(false, [], 'never_set'), '912'), 'never_set')
  assert.equal(keepAliveStanding({ ...live(false, []), source: 'refused' }, '912'), 'unknown', 'a refusal (a revoked pairing, an auth incident) is no answer, never the owner\'s switch')
  assert.equal(keepAliveStanding({ ...live(false, []), source: 'none' }, '912'), 'unknown', 'no answer and no young cache')
  assert.equal(keepAliveStanding(null, '912'), 'unknown')
})

test('the daemon reads the watcher\'s cached answer: no file, a stale or a junk file is no answer', () => {
  const cache = (enabled: boolean, ids: string[], fetchedAgoMs: number, switchState?: string) =>
    buildKeepAliveCache({ enabled, enabledAt: null, assistantIds: ids, switchState: switchState ?? (enabled ? 'on' : 'off'), showAgentWindows: false }, NOW - fetchedAgoMs)
  assert.equal(keepAliveStandingFromCache(null, '912', NOW), 'unknown')
  assert.equal(keepAliveStandingFromCache(cache(true, ['912'], MIN), '912', NOW), 'kept')
  assert.equal(keepAliveStandingFromCache(cache(true, ['7'], MIN), '912', NOW), 'unknown', 'one read left it out: not confirmed')
  const confirmed = buildKeepAliveCache({ enabled: true, enabledAt: null, assistantIds: ['7'], switchState: 'on', showAgentWindows: false, listedRecently: ['7'] }, NOW - MIN)
  assert.equal(keepAliveStandingFromCache(confirmed, '912', NOW), 'not_listed')
  assert.equal(keepAliveStandingFromCache(cache(false, ['912'], MIN), '912', NOW), 'switch_off')
  assert.equal(keepAliveStandingFromCache(cache(false, [], MIN, 'never_set'), '912', NOW), 'never_set')
  // The cache's own 24 h rule (lib/keepalive-plan.mjs, untouched here): older is no answer at all.
  assert.equal(keepAliveStandingFromCache(cache(false, [], 25 * 60 * MIN), '912', NOW), 'unknown')
  assert.equal(keepAliveStandingFromCache('{not json', '912', NOW), 'unknown')
  assert.equal(keepAliveStandingFromCache('', '912', NOW), 'unknown')
  // The file the watcher writes, read by a reader that does not load the watcher.
  for (const home of ['/Users/user', 'C:\\Users\\user']) assert.equal(keepAliveCacheFile(home), keepAliveCachePath(home))
})

// -- seen kept is a fact of ONE install -------------------------------------------------------------

test('seen kept belongs to one install: kept-seen holds the installed-at it was seen with, so a reinstall starts never seen', () => {
  assert.equal(INSTALLED_AT_FILE_NAME, 'installed-at')
  assert.equal(KEPT_SEEN_FILE_NAME, 'kept-seen')
  assert.equal(seenKept(stamp(MIN), stamp(MIN)), true)
  assert.equal(seenKept(stamp(MIN), stamp(60 * MIN)), false, 'seen with an EARLIER install')
  assert.equal(seenKept(stamp(MIN), null), false)
  assert.equal(seenKept(null, stamp(MIN)), false, 'no install stamp, nothing to have seen')
  assert.equal(seenKept('junk', 'junk'), false)
})

test('the grace is 15 minutes from the install and fails closed: no stamp, junk or a future stamp is no grace', () => {
  assert.equal(INSTALL_GRACE_MS, 15 * MIN)
  assert.ok(installGraceRemainingMs(stamp(MIN), NOW) > 13 * MIN)
  assert.equal(installGraceRemainingMs(stamp(16 * MIN), NOW), 0)
  for (const bad of [null, '', 'soon', String(Math.floor(NOW / 1000) + 3600)]) assert.equal(installGraceRemainingMs(bad, NOW), 0, String(bad))
})

// -- the decision ------------------------------------------------------------------------------------

const daemon = (over: Record<string, unknown>) => decideKeptSupervisor({ alwaysOn: true, standing: 'kept', installed: true, installedAt: stamp(5 * MIN), keptSeen: null, now: NOW, ...over } as any)
const sweep = (over: Record<string, unknown>) => decideKeptSupervisor({ standing: 'not_listed', installed: true, installedAt: stamp(5 * MIN), keptSeen: null, now: NOW, ...over } as any)

test('brief case 1: the computer switch OFF with Always on ON removes the supervisor at once, even inside the old grace, and never installs', () => {
  assert.equal(daemon({ standing: 'switch_off' }).action, 'remove')
  assert.equal(daemon({ standing: 'switch_off', installedAt: stamp(MIN) }).action, 'remove', 'no grace for anything with the switch off')
  assert.equal(daemon({ standing: 'switch_off', installed: false }).action, 'none', 'nothing to remove, and nothing is installed')
  assert.equal(sweep({ standing: 'switch_off', installedAt: stamp(MIN) }).action, 'remove')
})

test('brief case 2 and round 2: Always on OFF for an install once seen kept goes at once, inside the old 15 minutes too', () => {
  const s = stamp(3 * MIN)
  assert.equal(daemon({ alwaysOn: false, installedAt: s, keptSeen: s }).action, 'remove')
  // Dropped from the keep-alive list (the sweep's own view of Always on off) is the same.
  assert.equal(sweep({ installedAt: s, keptSeen: s }).action, 'remove')
  // Seen kept for an EARLIER install does not count for this one.
  assert.equal(daemon({ alwaysOn: false, installedAt: s, keptSeen: stamp(90 * MIN) }).action, 'grace')
})

test('round 2: a once-kept agent whose computer is switched off inside 15 minutes of its install is removed at once', () => {
  const s = stamp(2 * MIN)
  assert.equal(daemon({ standing: 'switch_off', installedAt: s, keptSeen: s }).action, 'remove')
  assert.equal(sweep({ standing: 'switch_off', installedAt: s, keptSeen: s }).action, 'remove')
})

test('round 2: an install never yet seen kept keeps its grace inside 15 minutes, and is removed after them', () => {
  // Desktop one-click: installed first, Always on recorded only after the agent connects.
  const inside = daemon({ alwaysOn: false, installedAt: stamp(4 * MIN) })
  assert.equal(inside.action, 'grace')
  assert.ok(inside.graceLeftMs > 10 * MIN && inside.graceLeftMs <= 11 * MIN)
  // create_agent: installed before the backend lists the new agent.
  assert.equal(sweep({ installedAt: stamp(4 * MIN) }).action, 'grace')
  assert.equal(daemon({ alwaysOn: false, installedAt: stamp(16 * MIN) }).action, 'remove')
  assert.equal(sweep({ installedAt: stamp(16 * MIN) }).action, 'remove')
  // An install with no stamp has no grace (fail closed, as before).
  assert.equal(sweep({ installedAt: null }).action, 'remove')
})

test('brief case 4: a kept agent keeps its supervisor, and the first read that sees it kept marks THIS install seen', () => {
  const first = daemon({})
  assert.equal(first.action, 'leave')
  assert.equal(first.markSeen, true)
  const s = stamp(5 * MIN)
  assert.equal(daemon({ installedAt: s, keptSeen: s }).markSeen, false, 'marked once')
  assert.equal(daemon({ installedAt: null }).markSeen, false, 'no install stamp: nothing to mark')
  assert.deepEqual(
    [daemon({ installed: false }).action, sweep({ standing: 'kept' }).action, sweep({ standing: 'kept' }).markSeen],
    ['install', 'leave', true],
  )
})

test('a failed or missing read changes nothing: no install, no removal, nothing marked', () => {
  for (const d of [daemon({ standing: 'unknown' }), daemon({ standing: 'unknown', installed: false }), sweep({ standing: 'unknown', installedAt: stamp(60 * MIN) })]) {
    assert.equal(d.action, 'none')
    assert.equal(d.markSeen, false)
  }
})

test('never set keeps today\'s meaning: the sweep does not act, the daemon follows Always on; so does a computer with no watcher', () => {
  assert.equal(sweep({ standing: 'never_set', installedAt: stamp(60 * MIN) }).action, 'none')
  for (const standing of ['never_set', 'no_watcher']) {
    assert.equal(daemon({ standing }).action, 'leave', standing)
    assert.equal(daemon({ standing, installed: false }).action, 'install', standing)
    assert.equal(daemon({ standing, alwaysOn: false, installedAt: stamp(60 * MIN) }).action, 'remove', standing)
    assert.equal(daemon({ standing, alwaysOn: false, installedAt: stamp(MIN) }).action, 'grace', standing)
  }
})

test('Always on OFF is an answer whatever the switch read says: not kept, so a supervisor goes once its grace is over', () => {
  assert.equal(daemon({ alwaysOn: false, standing: 'unknown', installedAt: stamp(60 * MIN) }).action, 'remove')
  assert.equal(daemon({ alwaysOn: false, standing: 'unknown', installed: false }).action, 'none', 'and nothing is installed')
})

// -- removal without ending what runs ------------------------------------------------------------------

const HOME = '/home/user'
const UNIT = 'bgos-agent-912-home-5156882f'
const UNIT_FILE = `${HOME}/.config/systemd/user/${UNIT}.service`
const LABEL = 'ai.bgos.agent.912.home-5156882f'
const PLIST = `${HOME}/Library/LaunchAgents/${LABEL}.plist`
const RUN_SH = `${HOME}/.bgos-agent/912/run.sh`

function recordingExec(codes: Record<string, number> = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    return { code: codes[`${file} ${args.join(' ')}`] ?? 0, stdout: '', stderr: '', error: null, timedOut: false }
  }
  return { calls, exec }
}

test('Linux removal is exactly the measured one: disable, delete the unit file, daemon-reload; never a stop or a kill', async () => {
  const fs = memoryFs({ [UNIT_FILE]: '[Service]\nRestart=always\n', [RUN_SH]: '#!/usr/bin/env bash\n' })
  const rec = recordingExec()
  const out = await releasePosixSupervisor({ platform: 'linux', service: { kind: 'systemd', handle: UNIT, file: UNIT_FILE }, assistantId: '912', home: HOME, exec: rec.exec, fs, env: {} } as any)
  assert.equal(out.ok, true, out.message)
  assert.deepEqual(rec.calls.map((c) => [c.file, ...c.args]), [
    ['systemctl', '--user', 'disable', UNIT],
    ['systemctl', '--user', 'daemon-reload'],
  ])
  assert.equal(fs.files.has(UNIT_FILE), false, 'the unit file is gone before the reload')
  // The running bash keeps the run.sh it opened (moved over, never written in place); a later read of
  // run.sh by hoai finds the not-kept one, so a run.sh still waiting to start the agent starts nothing.
  const runSh = fs.files.get(RUN_SH) ?? ''
  assert.ok(runSh.includes(NOT_KEPT_RUN_SH_MARK), runSh)
  assert.doesNotMatch(runSh, /hoai-core|tmux|claude|exec |launchctl|systemctl --user (start|restart|enable)/)
  assert.equal([...fs.files.keys()].some((p) => p.endsWith('.tmp')), false)
})

test('Linux removal: a disable that fails removes nothing, so the next read tries again', async () => {
  const fs = memoryFs({ [UNIT_FILE]: '[Service]\n' })
  const rec = recordingExec({ [`systemctl --user disable ${UNIT}`]: 1 })
  const out = await releasePosixSupervisor({ platform: 'linux', service: { kind: 'systemd', handle: UNIT, file: UNIT_FILE }, assistantId: '912', home: HOME, exec: rec.exec, fs, env: {} } as any)
  assert.equal(out.ok, false)
  assert.equal(fs.files.has(UNIT_FILE), true)
  assert.equal(fs.files.has(RUN_SH), false, 'run.sh is not touched either: the unit still runs it')
  assert.deepEqual(rec.calls.map((c) => c.args[1]), ['disable'])
})

test('Mac removal: the job stays loaded (a bootout would end the agent), run.sh becomes one that starts nothing and boots its own job out, and the plist goes', async () => {
  const fs = memoryFs({ [PLIST]: '<plist/>', [RUN_SH]: '#!/usr/bin/env bash\nexec hoai\n' })
  const rec = recordingExec()
  const out = await releasePosixSupervisor({ platform: 'darwin', service: { kind: 'launchd', handle: LABEL, file: PLIST }, assistantId: '912', home: HOME, exec: rec.exec, fs, env: {} } as any)
  assert.equal(out.ok, true, out.message)
  assert.deepEqual(rec.calls, [], 'no launchctl call now: the bootout waits for the agent to exit')
  assert.equal(fs.files.has(PLIST), false, 'no login loads it again')
  const runSh = fs.files.get(RUN_SH) ?? ''
  assert.doesNotMatch(runSh, /hoai-core|tmux|claude|exec /, 'starts nothing')
  assert.match(runSh, /^#!\/usr\/bin\/env bash\n/)
  assert.match(runSh, /launchctl bootout "gui\/\$\(id -u\)\/\$label"/)
  assert.ok(runSh.includes(NOT_KEPT_RUN_SH_MARK))
  assert.ok(runSh.includes(`label='${LABEL}'`), runSh)
  assert.equal([...fs.files.keys()].some((p) => p.endsWith('.tmp')), false, 'written beside and moved into place')
})

test('Mac removal: a run.sh that cannot be replaced leaves the plist too, so the next read tries again', async () => {
  const fs = memoryFs({ [PLIST]: '<plist/>' })
  const failing = { ...fs, rename: () => { throw new Error('EACCES') } }
  const out = await releasePosixSupervisor({ platform: 'darwin', service: { kind: 'launchd', handle: LABEL, file: PLIST }, assistantId: '912', home: HOME, exec: recordingExec().exec, fs: failing, env: {} } as any)
  assert.equal(out.ok, false)
  assert.equal(fs.files.has(PLIST), true)
})

// -- what runs does not bring it back --------------------------------------------------------------------

test('a supervised launch asks whether its supervisor is gone: Windows by the task launcher, Mac and Linux by a not-kept run.sh; a launch by hand is never asked', () => {
  const SD = '/home/user/.bgos-agent/912'
  const files = new Map<string, string>()
  const io = { stateDir: SD, exists: (p: string) => files.has(p), readFile: (p: string) => files.get(p) ?? null }
  files.set(`${SD}/run-agent.vbs`, 'x')
  assert.equal(launchSupervisorGone({ platform: 'win32', supervised: true, keepAlive: true, ...io }), null)
  // A launcher missing with no removal behind it is not a sign: only the removal's own marker is.
  files.delete(`${SD}/run-agent.vbs`)
  assert.equal(launchSupervisorGone({ platform: 'win32', supervised: true, keepAlive: true, ...io }), null)
  files.set(`${SD}/${NOT_KEPT_FILE_NAME}`, 'x')
  assert.equal(launchSupervisorGone({ platform: 'win32', supervised: true, keepAlive: true, ...io }), 'task_removed')
  // Installed again: its launcher is back, whatever marker is left.
  files.set(`${SD}/run-agent.vbs`, 'x')
  assert.equal(launchSupervisorGone({ platform: 'win32', supervised: true, keepAlive: true, ...io }), null)
  files.delete(`${SD}/run-agent.vbs`)
  // The restart ladder's own hidden launch (supervised, no --keep-alive) and a person's --keep-alive are no task's.
  assert.equal(launchSupervisorGone({ platform: 'win32', supervised: true, keepAlive: false, ...io }), null)
  assert.equal(launchSupervisorGone({ platform: 'win32', supervised: false, keepAlive: true, ...io }), null)
  for (const platform of ['darwin', 'linux']) {
    files.set(`${SD}/run.sh`, '#!/usr/bin/env bash\n# Auto-generated by bgos-agent: the always-on supervisor, generation 2.\n')
    assert.equal(launchSupervisorGone({ platform, supervised: true, keepAlive: false, ...io }), null, platform)
    files.delete(`${SD}/run.sh`)
    assert.equal(launchSupervisorGone({ platform, supervised: true, keepAlive: false, ...io }), null, `${platform}: no run.sh is no answer`)
    files.set(`${SD}/run.sh`, notKeptRunSh({ platform, assistantId: '912', label: 'x', stateDir: SD }))
    assert.equal(launchSupervisorGone({ platform, supervised: true, keepAlive: false, ...io }), 'service_removed', platform)
    assert.equal(launchSupervisorGone({ platform, supervised: false, keepAlive: false, ...io }), null, `${platform}: by hand`)
  }
})

// -- round 3: what a reader may trust, and what it says ------------------------------------------------

const offCache = (agoMs: number, extra: Record<string, unknown> = {}) =>
  buildKeepAliveCache({ enabled: false, enabledAt: null, assistantIds: [], switchState: 'off', showAgentWindows: false, ...extra }, NOW - agoMs)

test('B1: a refusal (401/403) is no answer, never the owner\'s switch: the watcher caches it marked refused, and every reader of that cache reads no answer', () => {
  const text = offCache(MIN, { refused: true })
  assert.equal(JSON.parse(text).refused, true)
  const parsed = parseKeepAliveCache(text)
  assert.equal(parsed?.refused, true)
  const consent = decideKeepAliveConsent({ live: null, cache: parsed, now: NOW })
  assert.equal(consent.source, 'refused', 'the watcher\'s own fallback reads it as the refusal it was')
  assert.equal(consent.enabled, false, 'and acts on nothing')
  assert.equal(keepAliveStandingFromCache(text, '912', NOW), 'unknown')
  assert.equal(keepAliveStandingFromCache(text, '912', NOW, { maxAgeMs: KEPT_CACHE_FRESH_MS, watcherInstalled: true }), 'unknown')
  assert.deepEqual(decideCreateLaunch(consent), { mode: 'once', reason: 'no_answer' }, 'create_agent reads it as a live refusal: no answer')
  // Not marked: the owner's own switch, as before.
  const off = offCache(MIN)
  assert.equal('refused' in JSON.parse(off), false)
  assert.equal(keepAliveStandingFromCache(off, '912', NOW), 'switch_off')
})

test('M1: the daemon trusts the watcher\'s cache only while it is fresh: older than 5 minutes is no answer (the watcher rewrites it every minute while it runs)', () => {
  assert.equal(KEPT_CACHE_FRESH_MS, 5 * MIN)
  const fresh = { maxAgeMs: KEPT_CACHE_FRESH_MS, watcherInstalled: true }
  assert.equal(keepAliveStandingFromCache(offCache(4 * MIN), '912', NOW, fresh), 'switch_off')
  assert.equal(keepAliveStandingFromCache(offCache(6 * MIN), '912', NOW, fresh), 'unknown')
  assert.equal(keepAliveStandingFromCache(offCache(-MIN), '912', NOW, fresh), 'unknown', 'a cache from the future is no answer')
  assert.equal(keepAliveStandingFromCache(offCache(6 * MIN), '912', NOW), 'switch_off', 'a reader that sets no limit keeps the cache\'s own 24 h rule')
})

test('m2: "no watcher" is read from the watcher\'s install (its service file, this HOME\'s or the old name), never from a missing cache', () => {
  for (const platform of ['darwin', 'linux']) {
    const home = platform === 'darwin' ? '/Users/user' : '/home/user'
    const files = watcherServiceFiles({ platform, home, env: {} })
    assert.match(files[0] ?? '', platform === 'darwin' ? /\/Library\/LaunchAgents\/ai\.bgos\.watcher\.home-[0-9a-f]{8}\.plist$/ : /\/\.config\/systemd\/user\/bgos-watcher-home-[0-9a-f]{8}\.service$/)
    for (const file of files) {
      const fs = memoryFs()
      assert.equal(watcherServiceInstalled({ platform, home, env: {}, exists: fs.exists }), false, `${platform}: no watcher`)
      fs.writeFile(file, 'x')
      assert.equal(watcherServiceInstalled({ platform, home, env: {}, exists: fs.exists }), true, `${platform}: ${file}`)
    }
    assert.ok(files.some((f) => /ai\.bgos\.watcher\.plist$|bgos-watcher\.service$/.test(f)), `${platform}: the old name counts too`)
  }
  assert.equal(keepAliveStandingFromCache(null, '912', NOW, { watcherInstalled: true }), 'unknown', 'a fresh watcher before its first sweep: no answer, nothing moves')
  assert.equal(keepAliveStandingFromCache(null, '912', NOW, { watcherInstalled: false }), 'no_watcher')
  assert.equal(keepAliveStandingFromCache(offCache(MIN), '912', NOW, { watcherInstalled: false }), 'no_watcher', 'a cache an uninstalled watcher left behind is no switch')
})

test('m1: an install made because the agent is kept is seen kept at once: kept-seen gets the new installed-at', () => {
  const SD = '/Users/user/.bgos-agent/912'
  const fs = memoryFs({ [`${SD}/${INSTALLED_AT_FILE_NAME}`]: stamp(0) })
  assert.equal(markInstallSeenKept({ stateDir: SD, readFile: fs.readFile, writeFile: fs.writeFile }), true)
  assert.equal(seenKept(fs.readFile(`${SD}/${INSTALLED_AT_FILE_NAME}`), fs.readFile(`${SD}/${KEPT_SEEN_FILE_NAME}`)), true)
  for (const bad of ['soon', null]) {
    const bare = memoryFs(bad === null ? {} : { [`${SD}/${INSTALLED_AT_FILE_NAME}`]: bad })
    assert.equal(markInstallSeenKept({ stateDir: SD, readFile: bare.readFile, writeFile: bare.writeFile }), false, String(bad))
    assert.equal(bare.files.has(`${SD}/${KEPT_SEEN_FILE_NAME}`), false, 'no install stamp: nothing to mark')
  }
})

test('m4: a self-removal that fails does not loop unseen: the run.sh left behind waits 30 minutes after a failed bootout (Mac) or reload (Linux), and says so once', () => {
  const SD = '/Users/user/.bgos-agent/912'
  const mac = notKeptRunSh({ platform: 'darwin', assistantId: '912', label: LABEL, stateDir: SD })
  const linux = notKeptRunSh({ platform: 'linux', assistantId: '912', label: UNIT, stateDir: SD })
  assert.ok(mac.includes('if ! launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1; then'), mac)
  // Linux: the unit runs this only while the manager still holds its old Restart, so it reloads it itself.
  assert.ok(linux.includes('if ! systemctl --user daemon-reload >/dev/null 2>&1; then'), linux)
  assert.ok(linux.includes('export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"'), linux)
  assert.doesNotMatch(linux, /launchctl/)
  for (const sh of [mac, linux]) {
    assert.ok(sh.includes(`stuck="$sd/${NOT_KEPT_STUCK_FILE_NAME}"`), sh)
    // The failure is said once: only while its marker is not there yet, which the same branch writes.
    assert.match(sh, /  if \[ ! -e "\$stuck" \]; then\n    : > "\$stuck" 2>\/dev\/null\n    echo "[^\n]*failed[^\n]*" >> "\$sd\/agent\.log" 2>\/dev\/null\n  fi\n  sleep 1800\nfi\nexit 0\n$/)
    // And the every-run line is quiet once it is stuck: a wait of 30 minutes is not a line every 30 minutes.
    assert.match(sh, /\[ -e "\$stuck" \] \|\| echo "[^\n]*not kept running: not starting it/)
  }
})

test('m4: a new removal starts with no stuck marker, so a failure is said again for it', async () => {
  const stuck = `${HOME}/.bgos-agent/912/${NOT_KEPT_STUCK_FILE_NAME}`
  const fs = memoryFs({ [PLIST]: '<plist/>', [stuck]: '' })
  const out = await releasePosixSupervisor({ platform: 'darwin', service: { kind: 'launchd', handle: LABEL, file: PLIST }, assistantId: '912', home: HOME, exec: recordingExec().exec, fs, env: {} } as any)
  assert.equal(out.ok, true, out.message)
  assert.equal(fs.files.has(stuck), false)
})

test('m4: Linux: a daemon-reload that fails is tried again while the unit still runs, and said plainly when it never works', async () => {
  const run = async (reloadCodes: number[], activeOut: string) => {
    const fs = memoryFs({ [UNIT_FILE]: '[Service]\nRestart=always\n', [RUN_SH]: '#!/usr/bin/env bash\n' })
    const verbs: string[] = []
    let reloads = 0
    const exec = async (file: string, args: readonly string[]) => {
      verbs.push(args[1]!)
      if (args[1] === 'daemon-reload') return { code: reloadCodes[reloads++] ?? 1, stdout: '', stderr: 'Failed to reload daemon: Connection timed out', error: null, timedOut: false }
      if (args[1] === 'is-active') return { code: activeOut === 'active' ? 0 : 3, stdout: `${activeOut}\n`, stderr: '', error: null, timedOut: false }
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    }
    const out = await releasePosixSupervisor({ platform: 'linux', service: { kind: 'systemd', handle: UNIT, file: UNIT_FILE }, assistantId: '912', home: HOME, exec, fs, env: {} } as any)
    return { out, verbs, fs }
  }
  const second = await run([1, 0], 'active')
  assert.equal(second.out.ok, true)
  assert.deepEqual(second.verbs, ['disable', 'daemon-reload', 'is-active', 'daemon-reload'])
  assert.equal((second.out as any).note ?? null, null, 'reloaded on the second try: nothing to say')
  const never = await run([1, 1, 1], 'active')
  assert.equal(never.out.ok, true, 'disabled and its file gone: no login starts it again')
  assert.deepEqual(never.verbs, ['disable', 'daemon-reload', 'is-active', 'daemon-reload', 'is-active', 'daemon-reload'])
  assert.match((never.out as any).note ?? '', /daemon-reload failed .*Connection timed out.*run\.sh reloads it itself/)
  assert.equal(never.fs.files.has(UNIT_FILE), false)
  const stopped = await run([1], 'inactive')
  assert.deepEqual(stopped.verbs, ['disable', 'daemon-reload', 'is-active'], 'not running: nothing left to restart it, no more tries')
})

test('m3: a Windows task that cannot be read back, or whose Unregister fails, is not "removed": nothing is deleted, so the next sweep sees it and tries again', async () => {
  const WHOME = 'C:\\Users\\user'
  const reg = agentTaskRegistration({ assistantId: '912', home: WHOME })
  const scene = (opts: Record<string, unknown>) => {
    const fs = memoryFs({ [reg.launcherPath]: 'Set shell = CreateObject("WScript.Shell")\r\n' })
    const tasks = fakeAgentTasks({ fs, ...opts } as any)
    tasks.seed.task(reg.taskName, reg.launcherPath, { description: agentTaskDescription('912', WHOME), running: true })
    return { fs, tasks }
  }
  const unread = scene({ queryErrors: [{ action: 'probe', times: 1 }] })
  const a = await releaseAgentTask({ assistantId: '912', home: WHOME, exec: unread.tasks.exec, fs: unread.fs } as any)
  assert.equal(a.ok, false)
  assert.match(a.message, /could not be read back/)
  assert.equal(unread.tasks.tasks.has(reg.taskName), true)
  assert.equal(unread.fs.files.has(reg.launcherPath), true, 'its launcher stays: the inventory still sees the task')
  assert.equal(unread.tasks.calls.some((c) => c.includes('-Action uninstall')), false)
  const refused = scene({ fail: [{ match: '-Action uninstall', code: 1, stderr: 'task not unregistered: Access is denied.' }] })
  const b = await releaseAgentTask({ assistantId: '912', home: WHOME, exec: refused.tasks.exec, fs: refused.fs } as any)
  assert.equal(b.ok, false)
  assert.match(b.message, /not unregistered.*Access is denied/)
  assert.equal(refused.fs.files.has(reg.launcherPath), true)
  const fine = scene({})
  const c = await releaseAgentTask({ assistantId: '912', home: WHOME, exec: fine.tasks.exec, fs: fine.fs } as any)
  assert.equal(c.ok, true, c.message)
  assert.equal(fine.tasks.tasks.has(reg.taskName), false)
  assert.equal(fine.tasks.instances.has(reg.taskName), true, 'what it runs now is not ended')
  assert.equal(fine.fs.files.has(reg.launcherPath), false)
})

test('m3: the task script\'s uninstall no longer swallows an Unregister error: it exits 1 and says why; only a task already gone is fine', () => {
  const ps1 = agentTaskRegistration({ assistantId: '912', home: 'C:\\Users\\user' }).script.content
  const block = ps1.slice(ps1.indexOf('"uninstall" {'), ps1.indexOf('"status" {'))
  assert.ok(block.length > 0, ps1)
  assert.doesNotMatch(block, /catch \{\}/)
  assert.match(block, /ObjectNotFound/)
  assert.match(block, /Write-Output \("task not unregistered: " \+ \$_\.Exception\.Message\); exit 1/)
})

test('m5: a hoai launcher of this version says it stops once its supervisor is removed; a live one that does not say so is from an older version', () => {
  assert.deepEqual(JSON.parse(supervisorFileBody(42, 'S')).capabilities, ['relaunch', KEPT_CHECK_CAPABILITY])
  const SD = 'C:\\Users\\user\\.bgos-agent\\912'
  const file = `${SD}\\supervisor.json`
  const fs = memoryFs({ [file]: JSON.stringify({ pid: 4242, capabilities: ['relaunch'], startedAt: 'S' }) })
  assert.equal(olderLiveLauncher({ launcherLive: true, stateDir: SD, readFile: fs.readFile }), 4242)
  assert.equal(olderLiveLauncher({ launcherLive: false, stateDir: SD, readFile: fs.readFile }), null, 'not live: nothing relaunches')
  fs.writeFile(file, supervisorFileBody(4243, 'S'))
  assert.equal(olderLiveLauncher({ launcherLive: true, stateDir: SD, readFile: fs.readFile }), null)
})

// The cache a watcher from before the format mark wrote: the same body without `format`.
const unmarked = (text: string) => `${JSON.stringify({ ...JSON.parse(text), format: undefined }, null, 2)}\n`

test('round 4 m2: every cache the watcher writes carries its format mark; one without it (a watcher from before the mark wrote a 401 as a plain OFF) is no answer for every kept reader, never the switch off', async () => {
  const on = buildKeepAliveCache({ enabled: true, enabledAt: 'e', assistantIds: ['912'], switchState: 'on', showAgentWindows: false }, NOW - MIN)
  for (const text of [offCache(MIN), offCache(MIN, { refused: true }), on]) assert.equal(JSON.parse(text).format, 2, 'live and refused alike')
  const fresh = { maxAgeMs: KEPT_CACHE_FRESH_MS, watcherInstalled: true }
  // An older watcher's refusal: OFF, fresh, not marked refused, no format mark.
  const old = unmarked(offCache(MIN))
  assert.equal('format' in JSON.parse(old), false)
  assert.equal(keepAliveStandingFromCache(old, '912', NOW, fresh), 'unknown', 'the daemon')
  assert.equal(keepAliveStandingFromCache(old, '912', NOW), 'unknown', 'the restart handoff (the cache\'s own 24 h rule)')
  assert.equal(keepAliveStandingFromCache(unmarked(on), '912', NOW, fresh), 'unknown', 'unmarked is no answer whatever it says')
  assert.equal(keepAliveStandingFromCache(offCache(MIN), '912', NOW, fresh), 'switch_off', 'the same OFF with the mark is the owner\'s switch')
  // The installer's question (kept-switch) reads it the same way.
  const home = '/Users/user'
  const fs = memoryFs()
  fs.writeFile(watcherServiceFiles({ platform: 'darwin', home, env: {} })[0]!, 'x')
  fs.writeFile(keepAliveCacheFile(home), old)
  const lines: string[] = []
  const code = await agentServiceMain(['kept-switch', '--assistant', '912', '--os', 'Darwin'], { env: { HOME: home }, fs, out: (l: string) => void lines.push(l), err: () => undefined, now: () => NOW } as any)
  assert.deepEqual([code, ...lines], [0, 'unknown'])
})

test('round 4 m5: "cannot tell" is a watcher, never none: a watcher spec that cannot be built, or a service file that cannot be checked, reads as installed, so the switch read still counts', () => {
  const absent = () => false
  assert.equal(watcherServiceFiles({ platform: 'sunos', home: '/home/user', env: {} }).length, 0, 'no spec for that platform')
  assert.equal(watcherServiceInstalled({ platform: 'sunos', home: '/home/user', env: {}, exists: absent }), true, 'a spec that cannot be built')
  assert.equal(watcherServiceInstalled({ platform: 'linux', home: '', env: {}, exists: absent }), true, 'no HOME to name it by')
  const unreadable = () => {
    throw new Error('EACCES: permission denied')
  }
  for (const platform of ['darwin', 'linux']) {
    const home = platform === 'darwin' ? '/Users/user' : '/home/user'
    assert.equal(watcherServiceInstalled({ platform, home, env: {}, exists: unreadable }), true, `${platform}: a check that throws`)
  }
  // What it guards: with a watcher read as installed, a fresh OFF is the switch, never "no watcher" (which installs on Always on alone).
  assert.equal(keepAliveStandingFromCache(offCache(MIN), '912', NOW, { maxAgeMs: KEPT_CACHE_FRESH_MS, watcherInstalled: watcherServiceInstalled({ platform: 'linux', home: '/home/user', env: {}, exists: unreadable }) }), 'switch_off')
})

test('m7: hoai-agent install --always-on asks first (bin/hoai-agent-service.mjs kept-switch): a fresh cache saying this computer\'s switch is off is "switch_off"; stale, refused or no watcher is not', async () => {
  const home = '/Users/user'
  const fs = memoryFs()
  const [watcherFile] = watcherServiceFiles({ platform: 'darwin', home, env: {} })
  fs.writeFile(watcherFile!, 'x')
  const ask = async () => {
    const lines: string[] = []
    const code = await agentServiceMain(['kept-switch', '--assistant', '912', '--os', 'Darwin'], { env: { HOME: home }, fs, out: (l: string) => void lines.push(l), err: () => undefined, now: () => NOW } as any)
    return [code, ...lines]
  }
  const put = (text: string) => fs.writeFile(keepAliveCacheFile(home), text)
  put(offCache(MIN))
  assert.deepEqual(await ask(), [0, 'switch_off'])
  put(offCache(6 * MIN))
  assert.deepEqual(await ask(), [0, 'unknown'], 'stale')
  put(offCache(MIN, { refused: true }))
  assert.deepEqual(await ask(), [0, 'unknown'], 'refused')
  put(offCache(MIN, { switchState: 'never_set' }))
  assert.deepEqual(await ask(), [0, 'never_set'])
  put(buildKeepAliveCache({ enabled: true, enabledAt: null, assistantIds: ['912'], switchState: 'on', showAgentWindows: false }, NOW - MIN))
  assert.deepEqual(await ask(), [0, 'kept'])
  put(offCache(MIN))
  fs.rm(watcherFile!)
  assert.deepEqual(await ask(), [0, 'no_watcher'])
})

test('r5 B2: an agent with no pairing is not judged by the list: left out is no answer, and the daemon follows Always on', () => {
  const on = { source: 'live', enabled: true, switchState: 'on', assistantIds: ['7'], listedRecently: ['7'] }
  assert.equal(keepAliveStanding(on, '912'), 'not_listed', 'an agent the list could name, confirmed left out')
  assert.equal(keepAliveStanding(on, '912', { paired: false }), 'no_pairing')
  assert.equal(keepAliveStanding({ ...on, listedRecently: undefined }, '912', { paired: false }), 'no_pairing', 'one read or two, the list cannot speak for it')
  assert.equal(keepAliveStanding({ ...on, assistantIds: ['912'] }, '912', { paired: false }), 'kept', 'a list that does name it still counts')
  assert.equal(keepAliveStanding({ ...on, enabled: false, switchState: 'off' }, '912', { paired: false }), 'switch_off', "the computer's switch is still the owner's")
  assert.equal(keepAliveStanding({ ...on, enabled: false, switchState: 'never_set' }, '912', { paired: false }), 'never_set')
  assert.equal(keepAliveStanding({ source: 'refused', enabled: false }, '912', { paired: false }), 'unknown')

  const stamp = String(Math.floor(T_R5 / 1000) - 3600)
  const base = { standing: 'no_pairing', installedAt: stamp, keptSeen: stamp, now: T_R5 }
  assert.equal(decideKeptSupervisor({ ...base, installed: true }).action, 'none', 'the sweep cannot read Always on, so it moves nothing')
  assert.equal(decideKeptSupervisor({ ...base, alwaysOn: true, installed: true }).action, 'leave')
  assert.equal(decideKeptSupervisor({ ...base, alwaysOn: true, installed: false, keptSeen: null }).action, 'install')
  const off = decideKeptSupervisor({ ...base, alwaysOn: false, installed: true })
  assert.equal(off.action, 'remove')
  assert.equal(off.reason, 'always_on_off:was_kept')
})

const T_R5 = 1_800_000_000_000

// -- review round 7 --------------------------------------------------------------------------------------

const SD_912 = `${HOME}/.bgos-agent/912`
const MARKER_912 = `${SD_912}/${NOT_KEPT_FILE_NAME}`
const LINUX_SERVICE = { kind: 'systemd', handle: UNIT, file: UNIT_FILE }

test('r7 M1: Linux, a removal whose not-kept run.sh cannot be written is not success; the unit still goes, so systemd does not start it again, and the not-kept marker is left as the sign', async () => {
  const fs = memoryFs({ [UNIT_FILE]: '[Service]\nRestart=always\n', [RUN_SH]: '#!/usr/bin/env bash\nexec hoai-core\n' })
  const failing = {
    ...fs,
    writeFile: (p: string, text: string, opts?: { mode?: number }) => {
      if (p.endsWith('.not-kept.tmp')) throw new Error('EACCES: permission denied')
      fs.writeFile(p, text, opts)
    },
  }
  const out = await releasePosixSupervisor({ platform: 'linux', service: LINUX_SERVICE, assistantId: '912', home: HOME, exec: recordingExec().exec, fs: failing, env: {} } as any)
  assert.equal(out.ok, false, out.message)
  assert.equal((out as { partial?: boolean }).partial, true)
  assert.equal(fs.files.has(UNIT_FILE), false, 'the unit file is gone')
  assert.match(fs.files.get(RUN_SH) ?? '', /hoai-core/, 'run.sh is still the real one')
  assert.equal(fs.files.has(MARKER_912), true, 'the sign the sweep reads')
  assert.match(out.message, /could not be replaced \(EACCES/)
  assert.match(out.message, /no cached list puts it back/)
  assert.equal(supervisorRemovedNotKept({ platform: 'linux', stateDir: SD_912, exists: fs.exists, readFile: fs.readFile }), true)
})

test('r7 M1: when the marker cannot be written either, the removal says plainly that a cached list can put it back', async () => {
  const fs = memoryFs({ [UNIT_FILE]: '[Service]\n', [RUN_SH]: '#!/usr/bin/env bash\nexec hoai-core\n' })
  const failing = {
    ...fs,
    writeFile: (p: string, text: string, opts?: { mode?: number }) => {
      if (p.startsWith(`${SD_912}/`)) throw new Error('EACCES: permission denied')
      fs.writeFile(p, text, opts)
    },
  }
  const out = await releasePosixSupervisor({ platform: 'linux', service: LINUX_SERVICE, assistantId: '912', home: HOME, exec: recordingExec().exec, fs: failing, env: {} } as any)
  assert.equal(out.ok, false)
  assert.equal(fs.files.has(MARKER_912), false)
  assert.match(out.message, /could not be written either/)
  assert.match(out.message, /a cached list can put it back until a live one is read/)
})

test('r7 M1: on Mac and Linux the not-kept marker alone reads as removed; with neither the marker nor the not-kept run.sh, nothing does', () => {
  const files = new Map<string, string>([[RUN_SH, '#!/usr/bin/env bash\nexec hoai-core\n']])
  const io = { stateDir: SD_912, exists: (p: string) => files.has(p), readFile: (p: string) => files.get(p) ?? null }
  for (const platform of ['linux', 'darwin']) assert.equal(supervisorRemovedNotKept({ platform, ...io }), false, platform)
  files.set(MARKER_912, 'not_kept\n')
  for (const platform of ['linux', 'darwin']) assert.equal(supervisorRemovedNotKept({ platform, ...io }), true, platform)
})

const LOCK_912 = `${HOME}/.bgos-agent/912.install.lock`
const MAC_SERVICE = { kind: 'launchd', handle: LABEL, file: PLIST }

test('r7 M3 (r7rev P5): a removal waits for an install of the same agent that holds bin/bgos-agent\'s lock, then removes what that install wrote, and lets go of the lock', async () => {
  const fs = memoryFs({ [PLIST]: '<plist/>', [RUN_SH]: '#!/usr/bin/env bash\nexec hoai-core\n' })
  // cmd_install holds its lock: it passed its switch check while the agent was kept, and is still writing.
  fs.mkdirExclusive(LOCK_912)
  let waits = 0
  const removal = releasePosixSupervisor({ platform: 'darwin', service: MAC_SERVICE, assistantId: '912', home: HOME, exec: recordingExec().exec, fs, env: {}, sleep: async () => void (waits += 1) } as any)
  // The install writes its run.sh and plist, then exits and lets go of its lock.
  fs.writeFile(RUN_SH, '#!/usr/bin/env bash\nexec hoai-core\n')
  fs.writeFile(PLIST, '<plist/>')
  fs.rmdir(LOCK_912)
  const out = await removal
  assert.equal(out.ok, true, out.message)
  assert.ok(waits >= 1, 'it waited for the install')
  assert.equal(fs.files.has(PLIST), false, 'the plist the install wrote is gone')
  assert.ok((fs.files.get(RUN_SH) ?? '').includes(NOT_KEPT_RUN_SH_MARK), 'and so is its run.sh')
  assert.equal(fs.exists(LOCK_912), false, 'the lock is let go')
})

test('r7 M3: a lock still held after 30 seconds does not keep the supervisor: the removal goes ahead, as uninstall does, says so, and leaves the install its own lock', async () => {
  const fs = memoryFs({ [PLIST]: '<plist/>' })
  fs.mkdirExclusive(LOCK_912)
  let waited = 0
  const out = await releasePosixSupervisor({ platform: 'darwin', service: MAC_SERVICE, assistantId: '912', home: HOME, exec: recordingExec().exec, fs, env: {}, sleep: async (ms: number) => void (waited += ms) } as any)
  assert.equal(out.ok, true, out.message)
  assert.equal(waited, 30_000)
  assert.equal(fs.files.has(PLIST), false)
  assert.match(out.note ?? '', /still held .*912\.install\.lock after 30s, so it was removed anyway/)
  assert.equal(fs.exists(LOCK_912), true, 'not taken from the install that holds it')
})

test('r7 M3: the removal holds the lock while it works and lets go of it whatever the outcome', async () => {
  const fs = memoryFs({ [UNIT_FILE]: '[Service]\n' })
  let heldDuring = false
  const exec = async (file: string, args: readonly string[]) => {
    heldDuring = fs.exists(LOCK_912)
    return { code: args[1] === 'disable' ? 1 : 0, stdout: '', stderr: 'no bus', error: null, timedOut: false }
  }
  const out = await releasePosixSupervisor({ platform: 'linux', service: LINUX_SERVICE, assistantId: '912', home: HOME, exec, fs, env: {}, sleep: async () => {} } as any)
  assert.equal(out.ok, false, 'the disable failed')
  assert.equal(heldDuring, true, 'an install would stand down meanwhile')
  assert.equal(fs.exists(LOCK_912), false, 'let go after a failure too')
})

test('r7 M3: the real adapter takes the lock as bin/bgos-agent does: mkdir of one directory, EEXIST when it is there, never a recursive mkdir', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'r7-lock-'))
  try {
    const real = nodeFs()
    const lock = joinPath(dir, '912.install.lock')
    real.mkdirExclusive!(lock)
    assert.throws(() => real.mkdirExclusive!(lock), (err: any) => err?.code === 'EEXIST')
    real.rmdir!(lock)
    assert.equal(real.exists(lock), false)
    real.mkdirExclusive!(lock)
  } finally {
    rmTree(dir, { recursive: true, force: true })
  }
})

const CREDS_912 = `${HOME}/.bgos-agent/credentials-912.json`

test('r7 M4: an agent with no pairing file gets a not-kept run.sh that writes the start-once words to agent.log, the place hoai-agent status and logs show; a paired one keeps the switch words', async () => {
  const unpaired = memoryFs({ [PLIST]: '<plist/>' })
  await releasePosixSupervisor({ platform: 'darwin', service: MAC_SERVICE, assistantId: '912', home: HOME, exec: recordingExec().exec, fs: unpaired, env: {}, sleep: async () => {} } as any)
  const told = unpaired.files.get(RUN_SH) ?? ''
  assert.match(told, /\[ -e "\$stuck" \] \|\| echo "[^"\n]*not kept running: not starting it[^"\n]*Turn it back on, then start it once and it will be kept again \(it has no pairing file here, so the switch alone cannot bring it back\)\." >> "\$sd\/agent\.log"/)
  assert.doesNotMatch(told, /Turning it back on installs the real supervisor again/, 'which is not true for it')
  assert.match(told, /# It has no pairing file here, so turning it back on does not install it again: start it once and it is kept again\./)
  const paired = memoryFs({ [PLIST]: '<plist/>', [CREDS_912]: '{}' })
  await releasePosixSupervisor({ platform: 'darwin', service: MAC_SERVICE, assistantId: '912', home: HOME, exec: recordingExec().exec, fs: paired, env: {}, sleep: async () => {} } as any)
  const switchWords = paired.files.get(RUN_SH) ?? ''
  assert.doesNotMatch(switchWords, /start it once/)
  assert.match(switchWords, /# Turning it back on installs the real supervisor again/)
})

test('r7 M4: the start-once words sit inside the double quotes of the echo, so they hold nothing bash would read there ($, a backtick, a quote or a backslash)', () => {
  const sh = notKeptRunSh({ platform: 'linux', assistantId: '912', label: UNIT, stateDir: SD_912, paired: false })
  const line = sh.split('\n').find((l) => l.includes('echo') && l.includes('start it once')) ?? ''
  const words = line.slice(line.indexOf('Turn it back on'), line.indexOf('" >> "$sd/agent.log"'))
  assert.match(words, /^Turn it back on, then start it once and it will be kept again/)
  assert.doesNotMatch(words, /[$`"\\]/)
})

test('r7 M5: kept only by the list, a supervisor a removal took waits for a live list; kept by Always on alone it is installed as before', () => {
  const base = { alwaysOn: true, installed: false, installedAt: stamp(60 * MIN), keptSeen: stamp(60 * MIN), now: NOW, removedNotKept: true }
  const held = decideKeptSupervisor({ ...base, standing: 'kept' })
  assert.deepEqual([held.action, held.reason], ['none', 'removed:waits_for_live_list'])
  for (const standing of ['no_pairing', 'never_set', 'no_watcher']) assert.equal(decideKeptSupervisor({ ...base, standing }).action, 'install', standing)
  assert.equal(decideKeptSupervisor({ ...base, standing: 'kept', removedNotKept: false }).action, 'install', 'never removed')
  assert.equal(decideKeptSupervisor({ ...base, standing: 'kept', installed: true }).action, 'leave', 'installed: nothing to hold')
})

test('r7 N3 (mutants X14, X15): a pairing file that cannot be looked for counts as a pairing: no path for the id, or a check that throws', () => {
  const none = () => false
  assert.equal(hasPairingFile({ home: HOME, assistantId: '912', exists: none }), false, 'looked for and not there: no pairing (control)')
  assert.equal(hasPairingFile({ home: HOME, assistantId: '912', exists: (p: string) => p === CREDS_912 }), true, 'there (control)')
  assert.equal(hasPairingFile({ home: HOME, assistantId: 'not-an-id', exists: none }), true, 'no path to look at')
  assert.equal(hasPairingFile({ home: HOME, assistantId: '912', exists: () => { throw new Error('EACCES') } }), true, 'the check threw')
})
