/**
 * Where group lanes work, and whether the host can fence them (round 4).
 *
 * ensureGroupLaneRoot: the lanes' own root, OUTSIDE the home folder, so a
 * lane below Full can be refused the whole home folder and still work in its
 * own: <base>/hoai-group-lanes-<uid>/<assistantId>, made 0700. A top folder
 * that is a link, not a folder, or another user's is refused (the lane then
 * starts nothing); one others can open is made 0700 again.
 *
 * groupSandboxWorks: the CLI's Bash sandbox, checked by STARTING it, not by
 * finding its binaries: on CLI 2.1.319 a sandbox the settings ask for but the
 * host cannot run is skipped with a warning, and Bash then runs unfenced
 * (measured). So a host where this answers false runs With approvals as Talk
 * only (lib/group-lanes.ts).
 *
 * Every effect is injected. Erasable TypeScript only.
 */

import { join } from 'node:path'

export interface GroupLaneRootFs {
  mkdir(path: string, mode: number): void
  lstat(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean; uid: number; mode: number }
  chmod(path: string, mode: number): void
}

export function ensureGroupLaneRoot(input: { base: string; uid: number; assistantId: string; fs: GroupLaneRootFs }): string {
  const top = join(input.base, `hoai-group-lanes-${input.uid}`)
  input.fs.mkdir(top, 0o700)
  const st = input.fs.lstat(top)
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== input.uid) throw new Error('the group lanes folder is not this user\'s own')
  if ((st.mode & 0o077) !== 0) input.fs.chmod(top, 0o700)
  const root = join(top, input.assistantId)
  input.fs.mkdir(root, 0o700)
  return root
}

/** Runs a command and answers whether it exited 0 (false, never a throw, when it cannot start). */
export type RunCheck = (command: string, args: string[]) => Promise<boolean>

export async function groupSandboxWorks(input: { platform: NodeJS.Platform; run: RunCheck }): Promise<boolean> {
  const ok = async (command: string, args: string[]): Promise<boolean> => {
    try {
      return await input.run(command, args)
    } catch {
      return false
    }
  }
  if (input.platform === 'darwin') {
    return ok('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])
  }
  if (input.platform === 'linux') {
    // What the CLI starts: bubblewrap with a read only root, and socat for its proxy.
    const bwrap = await ok('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', 'true'])
    return bwrap && (await ok('socat', ['-V']))
  }
  return false
}
