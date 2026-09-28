/**
 * The grace a freshly installed always-on supervisor gets before this daemon
 * may remove it for "always-on is off in BGOS".
 *
 * WHY (found by review, 2026-09-22). Desktop one-click installs the supervisor
 * FIRST and records alwaysOn:true in BGOS only AFTER it has seen the agent
 * connect. A new assistant's flag defaults to false. So the supervised session's
 * own daemon booted, read alwaysOn:false with a supervisor installed, and ran
 * `bgos-agent uninstall`: it booted out the very job it was running in. The
 * agent connected, the panel said Connected and closed, and the agent was gone.
 * That branch was unreachable for one-click only because the launch step never
 * succeeded before.
 *
 * `hoai-agent install --always-on` now stamps <statedir>/installed-at for a
 * paired folder, and the reconcile leaves a supervisor younger than the grace
 * alone. After it, a flag that is still false is a real "off" and is honoured
 * exactly as before.
 */
export const ALWAYS_ON_INSTALL_GRACE_MS = 15 * 60_000
export const ALWAYS_ON_INSTALLED_AT_FILE = 'installed-at'

/**
 * Milliseconds of grace left, 0 when there is none. `stamp` is the file's text:
 * epoch SECONDS, as `date +%s` writes it. Anything unreadable, or a stamp from
 * the future, is no grace at all: a guard that fails open would keep a
 * supervisor the owner switched off.
 */
export function alwaysOnGraceRemainingMs(stamp: string | null | undefined, nowMs: number, graceMs = ALWAYS_ON_INSTALL_GRACE_MS): number {
  const text = String(stamp ?? '').trim()
  if (!/^\d{9,11}$/.test(text)) return 0
  const installedAtMs = Number(text) * 1000
  const age = nowMs - installedAtMs
  if (!Number.isFinite(age) || age < 0) return 0
  return age < graceMs ? graceMs - age : 0
}
