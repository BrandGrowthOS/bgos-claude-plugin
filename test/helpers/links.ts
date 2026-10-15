/**
 * Links for tests that reach a folder or a file through an alias.
 *
 * Windows lets an account make a symbolic link only with Developer Mode on or
 * from an elevated token; anywhere else symlinkSync throws EPERM. GitHub's
 * Windows runner is elevated, a developer's own PC is usually neither, so a
 * test that made a bare symlink was green in CI and red on the PC (AlienAres,
 * board row 0b78f6a2: 48 of them in skills-inventory, skills-share,
 * entry-guard.symlink, clone-hooks, duplicate-copy, hoai-keepalive-marker).
 *
 * A FOLDER link falls back to a junction there: it needs no privilege, node
 * reports it as a symbolic link (lstat().isSymbolicLink()), realpath resolves
 * it, and it is the alias a Windows user's folder most often has. A FILE link
 * has no unprivileged form (a hard link is a different thing, tested as one),
 * so a test that needs one skips with `fileSymlinkRefused` as its reason.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const refused = (error: any) => process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EACCES')

/** A folder link at `path`: a symlink where this account may make one, else (Windows only) a junction. */
export function linkFolder(target: string, path: string): 'symlink' | 'junction' {
  try {
    symlinkSync(target, path, 'dir')
    return 'symlink'
  } catch (error) {
    if (!refused(error)) throw error
    symlinkSync(target, path, 'junction')
    return 'junction'
  }
}

/** false where this account can make a file symlink, else why a test that needs one skips. */
export const fileSymlinkRefused: string | false = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'file-link-probe-'))
  try {
    writeFileSync(join(dir, 'target'), '')
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'file')
    return false
  } catch (error) {
    if (!refused(error)) throw error
    return 'Windows refuses this account a file symlink (it needs Developer Mode or an elevated token), and a file link has no unprivileged form'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
