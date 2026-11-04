/**
 * Wait until a file written now is stamped later than `after` (a Date.now()).
 *
 * The private turn tracker orders a moment taken with Date.now() (a delivery, a Stop forwarder's process start)
 * against a marker file's mtime (lib/private-turn.mjs). Linux stamps files from a coarse clock that runs a few ms
 * behind Date.now(), so on a fast Linux box a marker a test wrote AFTER such a moment could carry an EARLIER time,
 * and the tests that order the two read the wrong turn (seen on a Debian 12 arm64 VM and in a Docker VM, at clean
 * HEAD c636ded; CI's x86 runner happened to pass). On a real machine a hook's cold start keeps the two seconds apart.
 * Bounded at a second; instant where file times are fine (macOS).
 */
import { realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const probe = join(realpathSync(tmpdir()), `hoai-file-clock-${process.pid}`)
process.on('exit', () => rmSync(probe, { force: true }))

export function fileClockPast(after: number): void {
  const until = Date.now() + 1000
  do {
    writeFileSync(probe, '')
    if (statSync(probe).mtimeMs > after) return
  } while (Date.now() < until)
}
