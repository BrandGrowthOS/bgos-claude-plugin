/**
 * The always-on reconcile decision (server.ts reconcileAlwaysOn), pure.
 *
 * WHY (design G11, 2026-10-06). "Installed" used to mean `bgos-agent
 * is-installed`, which checks only the CANONICAL service file
 * (ai.bgos.agent.<id> / bgos-agent-<id>). An agent already kept alive by
 * something else, this Mac's bespoke `ai.bgos.session.<id>` keepalive jobs or
 * a hand-written systemd unit on kc-server, therefore got a SECOND supervisor
 * from its own daemon the moment always_on turned true. Two supervisors then
 * race to relaunch the same agent: the second waits behind the first, takes
 * over when the first ends a session, and the agent comes back twice. Turning
 * on "Keep agents running" for a computer sets always_on for every agent on
 * it, so the switch would have triggered this on every bespoke agent at once.
 *
 * The fix reuses the detection the update ladder already trusts
 * (lib/update-readiness.ts resolveSupervision): when the canonical supervisor
 * is absent but that detection names ANOTHER live, reboot-surviving
 * supervisor, the reconcile installs nothing. What counts:
 *   - a verified keepalive.json (the 'keepalive' tier: a live script that
 *     declared a relaunch promise and whose claude session is our ancestor);
 *   - a service-manager job found by discovery (lib/service-supervision.mjs:
 *     a loaded launchd job / systemd --user unit whose recipe names this
 *     agent's state dir or working directory);
 *   - a declared service-manager job (supervisor.json written at boot). The
 *     declared tier sits ABOVE discovery in the ladder, and a daemon that
 *     discovered a bespoke job at boot writes it there (decideSupervisorWrite
 *     'detected-launchd'), so ignoring it would leave G11 open for exactly the
 *     agents it is about.
 * A job whose handle IS the canonical label/unit is ours, not another one: a
 * supervisor.json declared from the canonical job keeps naming it after
 * `bgos-agent uninstall` removed the file, and it must never block its own
 * reinstall. A live hoai launcher (supervisor.json 'launcher') does NOT count:
 * it relaunches claude on request but does not survive a reboot, which is the
 * whole point of always-on, so the canonical supervisor is still installed.
 *
 * Removal on always_on=false is unchanged and touches only the canonical
 * supervisor: a bespoke job was installed by someone else, for their reasons.
 */

import { serviceLabel, serviceUnit, validAssistantId, type Supervision } from './update-readiness.js'

/** The other supervisor a reconcile deferred to. `via` is the evidence. */
export interface OtherSupervisor {
  kind: 'keepalive' | 'launchd' | 'systemd'
  /** The launchd label / systemd unit, or the keepalive's tmux session name
   *  (log only, never acted on); null when none was declared. */
  handle: string | null
  via: 'keepalive-marker' | 'state-dir' | 'working-directory' | 'declared'
}

export type AlwaysOnReconcileDecision =
  | { action: 'install' }
  | { action: 'remove' }
  | { action: 'leave' }
  | { action: 'defer'; other: OtherSupervisor }

/** Is `handle` this agent's canonical bin/bgos-agent job? systemd discovery
 *  reports `<unit>.service`, the canonical name has no suffix, so the suffix
 *  is dropped before comparing. */
function isCanonicalHandle(kind: 'launchd' | 'systemd', handle: string, assistantId: string | null): boolean {
  if (!assistantId) return false
  if (kind === 'launchd') return handle === serviceLabel(assistantId)
  return handle.replace(/\.service$/, '') === serviceUnit(assistantId)
}

/**
 * The live, reboot-surviving supervisor OTHER than the canonical one that the
 * shared detection resolved for this agent, or null. Null for: no detection
 * (unreadable, which keeps the pre-G11 behaviour of installing), 'none', a
 * live hoai launcher, and any job that is the canonical one itself.
 */
export function otherLiveSupervisor(
  supervision: Supervision | null | undefined,
  assistantId: string | number | null | undefined,
): OtherSupervisor | null {
  if (!supervision) return null
  if (supervision.supervised === 'keepalive') {
    return { kind: 'keepalive', handle: supervision.keepalive?.tmuxSession ?? null, via: 'keepalive-marker' }
  }
  const service = supervision.service
  if (!service) return null
  if (service.via !== 'state-dir' && service.via !== 'working-directory' && service.via !== 'declared') return null
  if (isCanonicalHandle(service.kind, service.handle, validAssistantId(assistantId))) return null
  return { kind: service.kind, handle: service.handle, via: service.via }
}

/**
 * What the reconcile does this cycle.
 *   desired + canonical installed      leave
 *   not desired + canonical installed  remove (the caller still applies the
 *                                      install grace, lib/always-on-grace.ts)
 *   not desired + not installed        leave
 *   desired + not installed            defer when another live supervisor
 *                                      holds the agent, else install
 * `supervision` is only consulted on the last row, so a caller may pass null
 * everywhere else and skip the platform query.
 */
export function decideAlwaysOnReconcile(input: {
  desired: boolean
  canonicalInstalled: boolean
  supervision: Supervision | null
  assistantId: string | number | null | undefined
}): AlwaysOnReconcileDecision {
  if (input.canonicalInstalled) return input.desired ? { action: 'leave' } : { action: 'remove' }
  if (!input.desired) return { action: 'leave' }
  const other = otherLiveSupervisor(input.supervision, input.assistantId)
  return other ? { action: 'defer', other } : { action: 'install' }
}

/** The supervisor named in one human sentence, for the log line. */
export function describeOtherSupervisor(other: OtherSupervisor): string {
  if (other.kind === 'keepalive') {
    return `a keepalive script (keepalive.json${other.handle ? `, tmux ${other.handle}` : ''})`
  }
  const what = other.kind === 'launchd' ? 'launchd job' : 'systemd unit'
  return `the ${what} ${other.handle ?? '(unnamed)'} (found by ${other.via})`
}
