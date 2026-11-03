import { randomUUID } from 'node:crypto'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The clock moves on past this instant, on Date.now() and on the file clock both, so a marker written before it and a
 * time stamped after it never share a moment, and neither do a time stamped before it and a marker written after it
 * (the private turn rules compare the two: entry.at < writtenAt, verifiedAt > at; on a real machine a hook's cold start
 * keeps them far apart). The two clocks differ: Linux stamps an mtime from the kernel's coarse clock, which lags
 * Date.now() by about a tick or more (measured up to 6.84 ms on WSL2 ext4 at HZ 250, under load), so a fixed two
 * milliseconds did not pass it and a Stop written right after a delivery read as written before it. Hence a real file, in
 * the folder the markers live under. It gives up after 5 s, as this loop blocks the thread and no test timeout could
 * fire: a file clock that stands still, or a file an antivirus holds, leaves this moment its two milliseconds.
 */
export function settle() {
  const at = Date.now()
  while (Date.now() < at + 2) { /* spin */ }
  const probe = join(tmpdir(), `hoai-settle-${randomUUID()}`)
  try {
    do writeFileSync(probe, 'x')
    while (statSync(probe).mtimeMs <= at && Date.now() < at + 5000)
  } catch { /* See above. */ }
  try { rmSync(probe, { force: true }) } catch { /* In the temp folder, and named for what left it. */ }
}
