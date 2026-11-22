/**
 * The model names the installed Claude Code knows, read from its own file.
 *
 * The CLI has no command that lists its models, and `--model` takes any name:
 * a name outside the CLI's own table starts all the same, and the CLI flags
 * it as unrecognized. The table is in the CLI's file as quoted strings (the
 * native build and the npm bundle alike), so the names are the quoted
 * `claude-` ids found there. A server catalog id (lib/model-effort-catalog.ts
 * mergeServerModels) is offered only when this table names it.
 *
 * Read once per CLI file (its path, size and change time), in the background,
 * in chunks, never the whole file at once. Unknown (null) until read, while no
 * CLI is found, and when the file cannot be read: then nothing from the
 * server is offered.
 */

import { isModelFamily } from './compact-inject.ts'
import { isLaunchModel } from './launch-choice.mjs'

const OPEN = Buffer.from('"claude-', 'latin1')
const QUOTE = 0x22
/** The longest id the launch pattern takes, plus its two quotes. */
const NAME_SPAN = 48 + 2
/** No CLI carries more model names than this; a file with more is not read as a table. */
export const CLI_MODEL_NAMES_MAX = 200

/** A catalog id the launch pattern takes, with a version number in it, never a family alias. */
function isModelName(name: string): boolean {
  return isLaunchModel(name) && !isModelFamily(name) && name.split('-').some((part) => /^\d+$/.test(part))
}

/** Every quoted model name in a file read as chunks. */
export async function collectModelNames(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Set<string>> {
  const names = new Set<string>()
  let carry: Buffer = Buffer.alloc(0)
  for await (const chunk of chunks) {
    const buf = carry.length > 0 ? Buffer.concat([carry, Buffer.from(chunk)]) : Buffer.from(chunk)
    let at = buf.indexOf(OPEN)
    while (at !== -1) {
      const end = buf.indexOf(QUOTE, at + 1)
      if (end === -1) break
      if (end - at <= NAME_SPAN) {
        const name = buf.toString('latin1', at + 1, end)
        if (isModelName(name)) names.add(name)
      }
      at = buf.indexOf(OPEN, at + 1)
    }
    if (names.size > CLI_MODEL_NAMES_MAX) return new Set()
    // A name cut by the chunk's end is read whole with the next chunk; one read twice is one name.
    carry = buf.subarray(Math.max(0, buf.length - NAME_SPAN))
  }
  return names
}

export interface CliModelNamesDeps {
  /** The installed CLI's own file (server.ts resolveClaude), or null. */
  exe: () => string | null
  stat: (path: string) => { size: number; mtimeMs: number } | null
  /** The file in chunks. May throw. */
  read: (path: string) => AsyncIterable<Uint8Array> | Iterable<Uint8Array>
  log?: (line: string) => void
}

export class CliModelNames {
  private readonly deps: CliModelNamesDeps
  private key: string | null = null
  private names: ReadonlySet<string> | null = null
  private reading: Promise<ReadonlySet<string> | null> | null = null

  constructor(deps: CliModelNamesDeps) {
    this.deps = deps
  }

  private fileKey(): { path: string; key: string } | null {
    const path = this.deps.exe()
    if (!path) return null
    const st = this.deps.stat(path)
    return st ? { path, key: `${path}\u0000${st.size}\u0000${st.mtimeMs}` } : null
  }

  /** The names for the CLI file as it is now, or null; starts a read when they are not known. Never throws. */
  now(): ReadonlySet<string> | null {
    try {
      const file = this.fileKey()
      if (!file) return null
      if (file.key === this.key && !this.reading) return this.names
      void this.ready()
      return null
    } catch {
      return null
    }
  }

  /** The names once read (null when they cannot be). Never rejects. */
  ready(): Promise<ReadonlySet<string> | null> {
    let file: { path: string; key: string } | null
    try {
      file = this.fileKey()
    } catch {
      file = null
    }
    if (!file) return Promise.resolve(null)
    if (file.key === this.key) return this.reading ?? Promise.resolve(this.names)
    this.key = file.key
    this.names = null
    const key = file.key
    const reading = (async () => {
      try {
        const names = await collectModelNames(this.deps.read(file.path))
        return names.size > 0 ? names : null
      } catch {
        this.deps.log?.('model control: the CLI file could not be read for its model names')
        return null
      }
    })().then((names) => {
      if (this.key === key) {
        this.names = names
        this.reading = null
      }
      return names
    })
    this.reading = reading
    return reading
  }
}
