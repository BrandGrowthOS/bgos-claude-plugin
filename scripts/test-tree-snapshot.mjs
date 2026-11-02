import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// Enumerate the filesystem, not git status: ignored files, empty directories,
// and directories containing only an empty .git must all remain visible.
export function snapshotWorkingTree(root) {
  const paths = new Set()
  function walk(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
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
