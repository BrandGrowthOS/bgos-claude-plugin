import { randomUUID } from 'node:crypto'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The clock moves on past this instant, on Date.now() and on the file clock both, so a marker written before it and a
 * time stamped after it never share a moment, and neither do a time stamped before it and a marker written after it
 * (the private turn rules compare the two: entry.at < writtenAt, verifiedAt > at; on a real machine a hook's cold start
 * keeps them far apart). The two clocks differ: Linux stamps an mtime from the kernel's coarse clock, one tick behind
 * Date.now() at worst (4 ms at HZ 250, measured 4.32 ms on WSL2 ext4), so a fixed two milliseconds did not pass it and a
 * Stop written right after a delivery read as written before it. Hence a real file, in the folder the markers live under.
 */
export function settle() {
  const at = Date.now()
  while (Date.now() < at + 2) { /* spin */ }
  const probe = join(tmpdir(), `hoai-settle-${randomUUID()}`)
  try {
    do writeFileSync(probe, 'x')
    while (statSync(probe).mtimeMs <= at)
  } finally {
    rmSync(probe, { force: true })
  }
}
