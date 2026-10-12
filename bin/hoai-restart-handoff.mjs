#!/usr/bin/env node
/**
 * hoai-restart-handoff: the detached, hidden helper a Windows daemon starts
 * when its hoai launcher left a fresh restart-requested.json unanswered
 * (lib/marker-takeover.mjs). It proves the session, ends claude and brings the
 * agent back on its pinned session; every rule is in lib/restart-handoff.mjs,
 * this file only wires the real process, filesystem and ladder in.
 *
 * Never run by hand. Arguments are the daemon's handoffArgv; anything else
 * exits 0 without doing anything. It writes its lines into the daemon's log
 * (`<ISO> [bgos] restart takeover helper (pid N): ...`) and always exits 0.
 */

import { appendFileSync } from 'node:fs'

import { isRunAsMain } from './bgos-install-method.mjs'
import { defaultPidAlive, listAgents, readLauncherProcesses } from '../lib/agent-inventory.mjs'
import { restartAgent } from '../lib/agent-restart.mjs'
import { parseHandoffArgv } from '../lib/marker-takeover.mjs'
import { listProcesses } from '../lib/process-tree.mjs'
import { hiddenExecSync, nodeHandoffFs, runRestartHandoff } from '../lib/restart-handoff.mjs'
import { nodeExec, nodeFs, nodeSpawnDetached } from '../lib/watcher-bundle.mjs'

/** @param {string[]} argv */
export async function main(argv) {
  const params = parseHandoffArgv(argv)
  if (!params) {
    // Say so where the daemon's ACT line went, when that path is usable at all.
    const at = argv.indexOf('--log')
    const logPath = at >= 0 ? String(argv[at + 1] ?? '') : ''
    if (/^[A-Za-z]:[\\/]/.test(logPath)) {
      try {
        appendFileSync(logPath, `${new Date().toISOString()} [bgos] restart takeover helper (pid ${process.pid}): NOT started: its arguments did not parse; nothing was changed\n`)
      } catch {}
    }
    return 0
  }
  if (process.platform !== 'win32') return 0
  const log = (text) => {
    try {
      appendFileSync(params.logPath, `${new Date().toISOString()} [bgos] restart takeover helper (pid ${process.pid}): ${text}\n`)
    } catch {
      // No log is no reason to stop.
    }
  }
  try {
    await runRestartHandoff(params, {
      ownPid: process.pid,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log,
      pidAlive: defaultPidAlive,
      kill: (pid, signal) => process.kill(pid, signal),
      fs: nodeHandoffFs(),
      env: process.env,
      listProcesses: () => listProcesses({ platform: 'win32', exec: nodeExec(), env: process.env }),
      listAgents: ({ includeIds }) => listAgents({ home: params.home, env: process.env, platform: 'win32', execSync: hiddenExecSync, includeIds }),
      readLauncherProcesses: (pids) => readLauncherProcesses({ platform: 'win32', pids, execSync: hiddenExecSync }),
      restartAgent,
      restartDeps: { exec: nodeExec(), spawnDetached: nodeSpawnDetached(), fs: nodeFs() },
    })
  } catch (err) {
    log(`HANDOFF FAILED: ${err?.stack ?? err?.message ?? err}`)
  }
  return 0
}

if (isRunAsMain(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(0),
  )
}
