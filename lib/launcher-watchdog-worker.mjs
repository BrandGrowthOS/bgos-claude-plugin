/**
 * The launcher watchdog's worker thread (lib/launcher-liveness.mjs
 * startLauncherWatchdog says why it exists). It runs on its own event loop,
 * so it keeps looking when the launcher's main loop has stopped: the main
 * thread stores process.hrtime into `beat` about every second, and this
 * thread reads how long ago that was. Past the wedge window, and with no live
 * child under the launcher, it releases the claim and ends the launcher.
 */

import { workerData } from 'node:worker_threads'

import { decideWatchdogAction, readChildProcesses, releaseWedgedLauncher } from './launcher-liveness.mjs'

const { beat, claimPath, statusPath, pid, platform, wedgeMs, checkMs } = workerData
const beats = new BigInt64Array(beat)

setInterval(() => {
  const beatAgeMs = Number((process.hrtime.bigint() - Atomics.load(beats, 0)) / 1_000_000n)
  if (beatAgeMs < wedgeMs) return
  const children = readChildProcesses({ platform, pid })
  if (decideWatchdogAction({ beatAgeMs, wedgeMs, children }) !== 'release') return
  releaseWedgedLauncher({ claimPath, statusPath, pid, beatAgeMs, children: children ?? [] })
}, checkMs)
