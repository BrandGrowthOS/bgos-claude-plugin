/**
 * A fake file system for the folder identity checks, shared by the skills tests.
 *
 * It answers like a real one: whole numbers when the stat is asked for bigint, and plain numbers, rounded past
 * 2^53, when it is not. A check that forgets to ask for bigint therefore sees the rounded numbers. A folder not
 * listed in `given` answers with its real numbers.
 */

import { lstatSync, statSync } from 'node:fs'

import type { IdentFs, IdentStat } from '../../lib/skills-inventory.ts'

/** The device and file number a fake file system gives for one folder, and its birth time where it gives one. */
export type FolderNumbers = { dev?: bigint; ino?: bigint; birthtimeNs?: bigint }

/**
 * `fileSystem`, when given, is the name every volume reports (lib/file-numbers.mjs): 'ReFS' makes the fake a Dev
 * Drive, where every file number is unknown. Left out, the fake has no volume look and the numbers count as they come.
 */
export function fakeIdentFs(given: Map<string, FolderNumbers>, fileSystem?: string): IdentFs {
  const plain = (v: bigint | undefined) => (v === undefined ? undefined : Number(v))
  const answer = (path: string, options: { bigint?: boolean } | undefined, follow: boolean): IdentStat => {
    const mine = given.get(path) ?? (follow ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true }))
    return options?.bigint ? mine : { dev: plain(mine.dev as bigint | undefined), ino: plain(mine.ino as bigint | undefined) }
  }
  return {
    statSync: (path: string, options?: { bigint?: boolean }) => answer(path, options, true),
    lstatSync: (path: string, options?: { bigint?: boolean }) => answer(path, options, false),
    ...(fileSystem === undefined ? {} : { fileSystem: () => fileSystem }),
  }
}
