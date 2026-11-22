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
 * `hoai-agent install --always-on` stamps <statedir>/installed-at for a paired
 * folder. Since the switched-off-stays-off ruling (2026-11-22) the grace is
 * one rule of lib/agent-kept.mjs decideKeptSupervisor, the only place it is
 * applied: an install never yet seen kept keeps it, never longer; a computer
 * switched off and an install once seen kept get none. These names stay for
 * their readers and are that module's, so there is one grace.
 */
export {
  INSTALL_GRACE_MS as ALWAYS_ON_INSTALL_GRACE_MS,
  INSTALLED_AT_FILE_NAME as ALWAYS_ON_INSTALLED_AT_FILE,
  installGraceRemainingMs as alwaysOnGraceRemainingMs,
} from './agent-kept.mjs'
