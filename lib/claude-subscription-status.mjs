import { spawnSync } from 'node:child_process'

const CLAUDE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/

/** Is this a version answer at all? A notice or garbage is not, and says nothing about the login. */
export function isClaudeVersion(output) {
  return CLAUDE_VERSION.test(String(output ?? '').trim())
}

export function supportsSafeAuthStatus(output) {
  const match = CLAUDE_VERSION.exec(String(output ?? '').trim())
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return [major, minor, patch].every(Number.isSafeInteger) &&
    (major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 317))))
}

export function subscriptionSignedIn(output) {
  const status = JSON.parse(String(output ?? ''))
  return status?.loggedIn === true && status?.authMethod === 'claude.ai'
}

/** A non interactive status probe of this launch's credential store. No credential file or Keychain
 *  item is opened here, and neither CLI output nor account details escape this boolean probe.
 *  A failed command, unknown format or non subscription login cannot lift a held login failure.
 *  Keep CLAUDE_CONFIG_DIR exactly as launched: setting it only for the probe could select another
 *  account file or Keychain store, even when the supplied directory is the default one.
 *  Only stable CLI releases >= 2.1.317 may run auth status: older releases can abandon an OAuth
 *  refresh before saving its replacement and invalidate the shared login. Recheck on every probe
 *  so an update or downgrade takes effect without restarting the supervisor.
 *  @param {{ env?: Record<string, string | undefined>, run?: typeof spawnSync,
 *    onUnsupportedVersion?: () => void }} input */
export function probeClaudeSignedIn({ env = process.env, run = spawnSync, onUnsupportedVersion = () => {} }) {
  try {
    const options = {
      env: { ...env },
      encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true,
    }
    let version
    try {
      version = run('claude', ['--version'], options)
    } catch {
      // Missing CLI and failed version reads leave the hold in place, with update guidance.
    }
    if (version?.error || version?.status !== 0 || !supportsSafeAuthStatus(version.stdout)) {
      onUnsupportedVersion()
      return false
    }
    const result = run('claude', ['auth', 'status', '--json'], options)
    if (result?.error || result?.status !== 0) return false
    return subscriptionSignedIn(result.stdout)
  } catch {
    return false
  }
}
