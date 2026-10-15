/**
 * agent-service: reading a per-agent service registration back before acting on
 * it (board row d6198bb6, mission 154 goal 8), with #237's reader and judge
 * (lib/watcher-service.mjs readProbe, classifyRegistration).
 *
 * The agent services used to be named by agent id alone: the Scheduled Task
 * "HOAI Agent <id>", the launchd label ai.bgos.agent.<id> and the systemd --user
 * unit bgos-agent-<id>, one name per user account. A daemon or watcher in a
 * scratch or second HOME holding credentials-<id>.json for the same agent then
 * re-registered, restarted, stopped or removed the owner's real service. The
 * names now carry the HOME (lib/agent-inventory.mjs agentServiceNames), the
 * registration records that HOME and the agent id, and before any act the
 * registration is read back: one that records another HOME, or none readable,
 * is refused and left exactly as it is.
 *
 * What an agent registration records (agentServiceRecord, for THIS agent id
 * only: another agent's launcher records nothing about this one):
 *   win32   the task description `HOAI agent <id>, installed from home=<HOME>`
 *           and the action `wscript.exe //B "<HOME>\.bgos-agent\<id>\run-agent.vbs"`
 *           (a 0.69.2 task has the action only); run-agent.vbs pins USERPROFILE
 *   darwin  the plist path <HOME>/Library/LaunchAgents/..., its HOME and its
 *           program `/bin/bash <HOME>/.bgos-agent/<id>/run.sh`
 *   linux   the unit's fragment path, its HOME and its
 *           `ExecStart=/bin/bash "<HOME>/.bgos-agent/<id>/run.sh"`
 *
 * Shared by the Windows task runners (lib/agent-task-win32.mjs), the restart
 * ladder's service tier (lib/agent-restart.mjs) and bin/bgos-agent (through
 * bin/hoai-agent-service.mjs). Plain JavaScript, node >= 18 builtins only.
 */

import { agentServiceNamesFor, validAssistantId } from './agent-inventory.mjs'
import { artifactName, kindArtifact, launcherPinsHome, leftAlone, probeRegistration, refusal } from './watcher-service.mjs'

/** The win32 task description; the HOME follows `installed from home=`. */
export function agentTaskDescription(assistantId, home) {
  return `HOAI agent ${validAssistantId(assistantId)}, installed from home=${home}`
}

/** The systemd properties #237's reader parses (readProbe 'systemd'). */
export const SYSTEMD_PROBE_PROPERTIES = 'LoadState,ActiveState,FragmentPath,WorkingDirectory,Environment'

// caveat false: #237's note on an old launcher that pins no HOME ends in how to remove that task.
// For an agent the reader is often a scratch HOME looking at the OWNER's real task (its 0.69.2
// launcher pins nothing and serves the owner, as it should): never tell it how to remove that.
const RECOGNIZES_NOTHING = Object.freeze({
  noun: 'agent',
  caveat: false,
  requireRun: false,
  taskHomes: () => ({ homes: [], path: null }),
  runHomes: () => ({ homes: [], path: null }),
  launchdHomes: () => [],
  systemdHomes: () => [],
  pinsHome: launcherPinsHome,
})

/**
 * What an agent's registration records beyond what every one does (#237's
 * RegistrationRecord), for one agent id. Only records naming THIS id count:
 * a launcher or run.sh of another agent's state dir yields no HOME, so such a
 * registration is never judged this HOME's (it is 'unknown', never acted on).
 * @param {string | number} assistantId
 * @returns {import('./watcher-service.mjs').RegistrationRecord}
 */
export function agentServiceRecord(assistantId) {
  const id = validAssistantId(assistantId)
  if (!id) return RECOGNIZES_NOTHING
  const prefix = `HOAI agent ${id}, installed from home=`
  const launcher = new RegExp(`([^"]*?)[\\\\/]\\.bgos-agent[\\\\/]${id}[\\\\/]run-agent\\.vbs`, 'i')
  const program = new RegExp(`^\\s*(.+?)/\\.bgos-agent/${id}/run\\.sh\\s*$`, 'm')
  const execStart = new RegExp(`^ExecStart=\\S+\\s+"?(.+?)/\\.bgos-agent/${id}/run\\.sh"?\\s*$`, 'm')
  return Object.freeze({
    noun: 'agent',
    caveat: false,
    requireRun: false,
    // The task's state rides along (taskState): a rename keeps a Disabled task disabled.
    taskHomes(description, actions, taskState = '') {
      const homes = []
      if (description.startsWith(prefix)) homes.push(description.slice(prefix.length).trim())
      const m = launcher.exec(String(actions ?? ''))
      const home = m ? m[1].trim() : ''
      if (home) homes.push(home)
      return { homes, path: home ? m[0].trim() : null, taskState: String(taskState ?? '') }
    },
    runHomes: () => ({ homes: [], path: null }),
    launchdHomes(text) {
      const home = program.exec(String(text ?? ''))?.[1]
      return home ? [home] : []
    },
    systemdHomes(_props, file) {
      const home = file != null ? execStart.exec(String(file))?.[1] : null
      return home ? [home] : []
    },
    pinsHome: launcherPinsHome,
  })
}

/** The read-only probe of one launchd job or systemd unit by name (#237's probe commands). */
export function agentServiceProbeCommand(kind, handle, uid) {
  if (kind === 'launchd') return { file: 'launchctl', args: ['print', `gui/${uid}/${handle}`], ignoreFailure: true }
  if (kind === 'systemd') return { file: 'systemctl', args: ['--user', 'show', `--property=${SYSTEMD_PROBE_PROPERTIES}`, handle], ignoreFailure: true }
  return null
}

/**
 * The spec #237's helpers judge a posix agent registration against: this
 * HOME, this agent's record, its own name and its old one.
 * @param {{ platform: string, home: string, assistantId: string | number, handle?: string | null }} params
 */
export function posixAgentServiceSpec({ platform, home, assistantId, handle = null }) {
  const kind = platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : null
  const id = validAssistantId(assistantId)
  if (!kind || !id || !String(home ?? '').trim()) return null
  const names = agentServiceNamesFor(id, home, platform)
  const nameOf = (side) => (kind === 'launchd' ? side.launchdLabel : side.systemdUnit)
  return {
    kind,
    platform,
    home,
    assistantId: id,
    homeId: names.current.homeId,
    label: handle ?? nameOf(names.current),
    legacy: { label: nameOf(names.legacy) },
    record: agentServiceRecord(id),
    noun: 'agent',
  }
}

/**
 * Read one agent service registration back (launchctl print / systemctl
 * --user show, and the unit file the manager loaded) and judge it against
 * this HOME: { state: 'own' | 'absent' | 'foreign' | 'unknown', home,
 * artifacts, detail?, refusal }. `refusal` is the sentence a caller reports
 * when it does not act (null when it may). The caller bounds the exec (a hung
 * user bus is an unreadable probe, never a sweep held for good).
 * @param {{ platform: string, home: string, assistantId: string | number, uid: number | null, handle: string }} params
 * @param {{ exec: import('./watcher-bundle.mjs').Exec, fs?: import('./watcher-bundle.mjs').WatcherFs | null }} deps
 */
export async function readBackAgentService({ platform, home, assistantId, uid, handle }, { exec, fs = null }) {
  const spec = posixAgentServiceSpec({ platform, home, assistantId, handle })
  const ran = []
  if (!spec) return { state: 'unknown', home: null, artifacts: [], detail: 'no agent service on this platform', refusal: 'refused: no agent service can be read back on this platform', ran }
  if (spec.kind === 'launchd' && !(Number.isInteger(uid) && uid >= 0)) {
    const judged = { state: 'unknown', home: null, artifacts: [], detail: 'no numeric uid for the gui/<uid> domain' }
    return { ...judged, refusal: refusal(spec, judged), ran }
  }
  const judged = await probeRegistration(spec, agentServiceProbeCommand(spec.kind, handle, uid), exec, ran, fs)
  return { ...judged, refusal: judged.state === 'foreign' || judged.state === 'unknown' ? refusal(spec, judged) : null, ran }
}

/** The sentences for an OLD registration this HOME does not own (it is left alone), #237's wording. */
export function agentLeftAlone(spec, judged, fs = null) {
  return leftAlone(spec, judged, fs)
}

/** The `service note: ...` lines bin/bgos-agent prints about a registration it left alone, renamed or removed. */
export function serviceNotesFrom(text) {
  const notes = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /service note: (.*)$/.exec(line)
    if (m && m[1].trim()) notes.push(m[1].trim())
  }
  return notes
}

/** The refusal bin/bgos-agent stopped with (`refused: ...`, a registration it would not touch), or null. */
export function serviceRefusalFrom(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /(?:^|\s)(refused: .*)$/.exec(line)
    if (m && !/service note: /.test(line)) return m[1].trim()
  }
  return null
}

export { artifactName, kindArtifact }
