import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// Enumerate the filesystem, not git status: ignored files, empty directories,
// and directories containing only an empty .git must all remain visible.
// A folder it cannot read throws, unless onUnreadable takes the error, and then the
// rest of the tree is still read, so the paths it did find can still be named.
/** @param {(error: any) => unknown} [onUnreadable] */
export function snapshotWorkingTree(root, onUnreadable = (error) => { throw error }) {
  const paths = new Set()
  function walk(directory, prefix) {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      onUnreadable(error)
      return
    }
    for (const entry of entries) {
      const path = prefix + entry.name
      paths.add(path)
      // Keep the boundary itself, including a newly created nested .git, but
      // never traverse dependency trees, git internals, or symlink targets.
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(join(directory, entry.name), `${path}/`)
      }
    }
  }
  walk(root, '')
  return paths
}
