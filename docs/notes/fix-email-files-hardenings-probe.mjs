// mailharden probe (board row 84f19b9f): can a trick file freeze readOutboundFile, and is a hard link read?
// Usage, from anywhere, on macOS or Linux:
//   node --import tsx docs/notes/fix-email-files-hardenings-probe.mjs <plugin dir>
//   bun docs/notes/fix-email-files-hardenings-probe.mjs <plugin dir>
// It writes only inside one new folder under the OS temp folder, removes that folder at the end, and reads no
// real file of the owner. On 70b93259eb the swap case prints BLOCKED and the hard link prints READ; with the
// hardening every line returns at once with a plain refusal.
import { execFileSync } from 'node:child_process'
import { closeSync, constants, linkSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.argv[2], 'lib', 'email-outbound-files.ts')).href)
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`
const root = mkdtempSync(join(tmpdir(), 'mailharden-probe-'))
const PDF = '%PDF-1.7\n%%EOF\n'

/** Runs one read with a 3 s limit; a read that hangs on a FIFO is freed by a writer so the probe can go on. */
async function timed(label, path, ctx) {
  const started = performance.now()
  let timer
  const out = await Promise.race([lib.readOutboundFile(path, ctx), new Promise((done) => { timer = setTimeout(() => done('BLOCKED'), 3000) })])
  clearTimeout(timer)
  if (out === 'BLOCKED') {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK))
    } catch {
      // nothing waits on it
    }
    console.log(`${runtime} ${label}: BLOCKED for 3 s (freed by a writer)`)
    return
  }
  const ms = Math.round(performance.now() - started)
  console.log(`${runtime} ${label}: returned in ${ms} ms: ${out.ok ? 'READ' : out.error.replace(root, '<tmp>')}`)
}

try {
  const home = join(root, 'home')
  mkdirSync(join(home, 'docs'), { recursive: true })

  // 1. A regular file swapped for a FIFO between the lstat and the open.
  const swapped = join(home, 'docs', 'q3.pdf')
  writeFileSync(swapped, PDF)
  let done = false
  const fs = {
    lstat: async (p) => {
      const st = await lstat(p)
      if (!done) {
        done = true
        rmSync(p)
        execFileSync('mkfifo', [p])
      }
      return st
    },
  }
  await timed('FIFO swapped in after the lstat', swapped, { home, fs })

  // 2. A FIFO at the path from the start: realpath and lstat meet it before any open. On macOS this line answers
  //    whether the runtime's realpath.native opens the last part of the path.
  const pipe = join(home, 'docs', 'pipe.pdf')
  execFileSync('mkfifo', [pipe])
  await timed('FIFO from the start', pipe, { home })

  // 3. A second name, in a plain folder, of a file in a key folder.
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(home, '.ssh', 'k.pdf'), PDF)
  linkSync(join(home, '.ssh', 'k.pdf'), join(home, 'docs', 'k.pdf'))
  await timed('hard link into .ssh', join(home, 'docs', 'k.pdf'), { home })
} finally {
  rmSync(root, { recursive: true, force: true })
}
// The content Worker is unref'd; this only ends a run whose freed FIFO read is still settling.
setTimeout(() => process.exit(0), 200)
