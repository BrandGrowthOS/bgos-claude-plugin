/**
 * lib/agent-kept.mjs: an agent its owner switched off stays off at the supervisor (ruling 2026-11-22).
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
  KEPT_SEEN_FILE_NAME,
  NOT_KEPT_FILE_NAME,
  NOT_KEPT_RUN_SH_MARK,
  decideKeptSupervisor,
  installGraceRemainingMs,
  keepAliveStanding,
  keepAliveCacheFile,
  keepAliveStandingFromCache,
  launchSupervisorGone,
  notKeptRunSh,
  releasePosixSupervisor,
  seenKept,
} from '../lib/agent-kept.mjs'
import { buildKeepAliveCache } from '../lib/keepalive-plan.mjs'
import { keepAliveCachePath } from '../lib/watcher-keepalive.mjs'
import { memoryFs } from './helpers/memory-fs.ts'

const NOW = 1_800_000_000_000
const MIN = 60_000
/** The installed-at text bin/bgos-agent writes (`date +%s`), `msAgo` before NOW. */
const stamp = (msAgo: number) => `${Math.floor((NOW - msAgo) / 1000)}\n`

// -- what the keep-alive answer says about one agent ------------------------------------------------

test('the keep-alive answer, for one agent: kept only with the switch ON and the agent on the list', () => {
  const live = (enabled: boolean, ids: string[], switchState = enabled ? 'on' : 'off') => ({ enabled, enabledAt: null, assistantIds: ids, switchState, showAgentWindows: false, source: 'live' })
  assert.equal(keepAliveStanding(live(true, ['912', '7']), '912'), 'kept')
  assert.equal(keepAliveStanding(live(true, ['7']), '912'), 'not_listed')
  // A list that rides an OFF answer clears nobody (decision D2).
  assert.equal(keepAliveStanding(live(false, ['912']), '912'), 'switch_off')
  assert.equal(keepAliveStanding(live(false, [], 'never_set'), '912'), 'never_set')
  assert.equal(keepAliveStanding({ ...live(false, []), source: 'refused' }, '912'), 'switch_off', 'a revoked pairing is an answer: off')
  assert.equal(keepAliveStanding({ ...live(false, []), source: 'none' }, '912'), 'unknown', 'no answer and no young cache')
  assert.equal(keepAliveStanding(null, '912'), 'unknown')
})

test('the daemon reads the watcher\'s cached answer: no file is a computer with no watcher, a stale or junk file is no answer', () => {
  const cache = (enabled: boolean, ids: string[], fetchedAgoMs: number, switchState?: string) =>
    buildKeepAliveCache({ enabled, enabledAt: null, assistantIds: ids, switchState: switchState ?? (enabled ? 'on' : 'off'), showAgentWindows: false }, NOW - fetchedAgoMs)
  assert.equal(keepAliveStandingFromCache(null, '912', NOW), 'no_watcher')
  assert.equal(keepAliveStandingFromCache(cache(true, ['912'], MIN), '912', NOW), 'kept')
  assert.equal(keepAliveStandingFromCache(cache(true, ['7'], MIN), '912', NOW), 'not_listed')
  assert.equal(keepAliveStandingFromCache(cache(false, ['912'], MIN), '912', NOW), 'switch_off')
  assert.equal(keepAliveStandingFromCache(cache(false, [], MIN, 'never_set'), '912', NOW), 'never_set')
  // The cache's own 24 h rule (lib/keepalive-plan.mjs, untouched here): older is no answer at all.
  assert.equal(keepAliveStandingFromCache(cache(false, [], 25 * 60 * MIN), '912', NOW), 'unknown')
  assert.equal(keepAliveStandingFromCache('{not json', '912', NOW), 'unknown')
  assert.equal(keepAliveStandingFromCache('', '912', NOW), 'unknown')
  // The file the watcher writes, read by a reader that does not load the watcher.
  for (const home of ['/Users/kc', 'C:\\Users\\kc']) assert.equal(keepAliveCacheFile(home), keepAliveCachePath(home))
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

const HOME = '/home/kc'
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
  assert.doesNotMatch(runSh, /hoai-core|tmux|claude|exec |launchctl|systemctl/)
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
  const SD = '/home/kc/.bgos-agent/912'
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
