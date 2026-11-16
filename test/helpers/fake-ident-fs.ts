/**
 * A fake file system for the folder identity checks, shared by the skills tests.
 *
 * It answers like a real one: whole numbers when the stat is asked for bigint, and plain numbers, rounded past
 * 2^53, when it is not. A check that forgets to ask for bigint therefore sees the rounded numbers. A folder not
 * listed in `given` answers with its real numbers.
 */

import { lstatSync, statSync } from 'node:fs'

import type { IdentFs, IdentStat } from '../../lib/skills-inventory.ts'

/** The device and file number a fake file system gives for one folder. */
export type FolderNumbers = { dev?: bigint; ino?: bigint }

export function fakeIdentFs(given: Map<string, FolderNumbers>): IdentFs {
  const plain = (v: bigint | undefined) => (v === undefined ? undefined : Number(v))
  const answer = (path: string, options: { bigint?: boolean } | undefined, follow: boolean): IdentStat => {
    const mine = given.get(path) ?? (follow ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true }))
    return options?.bigint ? mine : { dev: plain(mine.dev as bigint | undefined), ino: plain(mine.ino as bigint | undefined) }
  }
  return {
    statSync: (path: string, options?: { bigint?: boolean }) => answer(path, options, true),
    lstatSync: (path: string, options?: { bigint?: boolean }) => answer(path, options, false),
  }
}
