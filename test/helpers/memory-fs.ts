/**
 * An in-memory implementation of the WatcherFs surface (lib/watcher-bundle.mjs
 * nodeFs) for the watcher test files. Paths are plain strings; directories are
 * implicit (a path is a directory when some file lives under it) or explicit
 * (declared via `dirs`). Separator agnostic: '/' and '\\' both split.
 */

export type MemoryFs = {
  files: Map<string, string>
  modes: Map<string, number>
  dirs: Set<string>
  exists: (path: string) => boolean
  readFile: (path: string) => string | null
  writeFile: (path: string, text: string, opts?: { mode?: number }) => void
  // Present so this fs matches the production adapter. The logger prefers appendFile and falls back
  // to read-then-write; both paths need a home somewhere, so one test strips these off again.
  appendFile: (path: string, text: string) => void
  size: (path: string) => number | null
  mkdir: (path: string) => void
  listDir: (path: string) => string[]
  stat: (path: string) => { mtimeMs: number; isDirectory: boolean } | null
  rm: (path: string) => void
  rename: (from: string, to: string) => void
  copyFile: (from: string, to: string) => void
  chmod: (path: string, mode: number) => void
  /** Test-only: set the mtime a stat() reports for a file. */
  touch: (path: string, mtimeMs: number) => void
}

function norm(path: string): string {
  return String(path).replace(/[\\/]+$/, '')
}

function isUnder(key: string, dir: string): boolean {
  return key.startsWith(dir + '/') || key.startsWith(dir + '\\')
}

export function memoryFs(initial: Record<string, string> = {}, dirs: string[] = []): MemoryFs {
  const files = new Map(Object.entries(initial))
  const modes = new Map<string, number>()
  const mtimes = new Map<string, number>()
  const dirSet = new Set(dirs.map(norm))
  const isDir = (p: string) => {
    const dir = norm(p)
    if (dirSet.has(dir)) return true
    for (const key of files.keys()) if (isUnder(key, dir)) return true
    for (const d of dirSet) if (isUnder(d, dir)) return true
    return false
  }
  const fs: MemoryFs = {
    files,
    modes,
    dirs: dirSet,
    exists: (p) => files.has(norm(p)) || isDir(p),
    readFile: (p) => files.get(norm(p)) ?? null,
    writeFile: (p, text, opts) => {
      files.set(norm(p), text)
      if (opts?.mode != null) modes.set(norm(p), opts.mode)
      mtimes.set(norm(p), Date.now())
    },
    appendFile: (p, text) => {
      files.set(norm(p), (files.get(norm(p)) ?? '') + text)
      mtimes.set(norm(p), Date.now())
    },
    size: (p) => {
      const text = files.get(norm(p))
      return text === undefined ? null : Buffer.byteLength(text, 'utf8')
    },
    mkdir: (p) => {
      dirSet.add(norm(p))
    },
    listDir: (p) => {
      const dir = norm(p)
      const names = new Set<string>()
      const collect = (key: string) => {
        if (!isUnder(key, dir)) return
        const head = key.slice(dir.length + 1).split(/[\\/]/)[0]
        if (head) names.add(head)
      }
      for (const key of files.keys()) collect(key)
      for (const d of dirSet) collect(d)
      return [...names].sort()
    },
    stat: (p) => {
      const key = norm(p)
      if (files.has(key)) return { mtimeMs: mtimes.get(key) ?? 0, isDirectory: false }
      if (isDir(p)) return { mtimeMs: 0, isDirectory: true }
      return null
    },
    rm: (p) => {
      const key = norm(p)
      files.delete(key)
      modes.delete(key)
      dirSet.delete(key)
      for (const k of [...files.keys()]) if (isUnder(k, key)) files.delete(k)
      for (const d of [...dirSet]) if (isUnder(d, key)) dirSet.delete(d)
    },
    rename: (from, to) => {
      const src = norm(from)
      const dst = norm(to)
      if (!fs.exists(src)) throw new Error(`ENOENT: rename ${src}`)
      if (files.has(src)) {
        files.set(dst, files.get(src)!)
        files.delete(src)
        return
      }
      for (const k of [...files.keys()]) {
        if (isUnder(k, src)) {
          files.set(dst + k.slice(src.length), files.get(k)!)
          files.delete(k)
        }
      }
      for (const d of [...dirSet]) {
        if (d === src || isUnder(d, src)) {
          dirSet.delete(d)
          dirSet.add(dst + d.slice(src.length))
        }
      }
    },
    copyFile: (from, to) => {
      const text = files.get(norm(from))
      if (text == null) throw new Error(`ENOENT: copy ${from}`)
      files.set(norm(to), text)
      mtimes.set(norm(to), Date.now())
    },
    chmod: (p, mode) => {
      modes.set(norm(p), mode)
    },
    touch: (p, mtimeMs) => {
      mtimes.set(norm(p), mtimeMs)
    },
  }
  return fs
}
