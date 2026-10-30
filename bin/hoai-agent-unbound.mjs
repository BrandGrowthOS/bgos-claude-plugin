#!/usr/bin/env node
/**
 * hoai-agent-unbound: remove what a DELETED agent left on this computer
 * (board row 5b45611f6b0d). The daemon starts it once the paired server has
 * confirmed the agent is gone (lib/agent-unbound.mjs createUnboundNoticeHandler);
 * the work itself is lib/agent-unbound.mjs cleanUpUnboundAgent.
 *
 *   --stage launch --assistant <id> --home <HOME>
 *       What the daemon spawns (detached). Starts the run stage OUT of the
 *       agent's process tree (unboundRunStageCommands: its own transient
 *       systemd unit on Linux when it can, else a detached child) and exits at
 *       once, so stopping the agent, which ends the daemon and its children,
 *       never ends the cleanup half way.
 *   --stage run --assistant <id> --home <HOME>
 *       Stops the agent's session, removes its auto start, archives
 *       ~/.bgos-agent/<id> under ~/.bgos-agent/.removed and removes its
 *       credentials file. Logs to ~/.bgos-agent/.removed/<id>-unbound.log.
 *
 * Exit 0 when it ran (the log says what happened), 1 when the cleanup could
 * not do everything, 2 on a usage error. Plain JavaScript, node >= 18 or bun.
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { agentDir, defaultPidAlive, joinDir, listAgents, parseSupervisorFile, supervisorPath, validAssistantId } from '../lib/agent-inventory.mjs'
import { REMOVED_DIR_NAME, cleanUpUnboundAgent, unboundRunStageCommands } from '../lib/agent-unbound.mjs'
import { nodeExec, nodeFs } from '../lib/watcher-bundle.mjs'

const HERE = fileURLToPath(import.meta.url)
const PLUGIN_ROOT = join(dirname(HERE), '..')

function parseArgs(argv) {
  const out = { stage: 'launch', assistant: '', home: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1] ?? ''
    if (flag === '--stage') out.stage = value
    else if (flag === '--assistant') out.assistant = value
    else if (flag === '--home') out.home = value
    else return null
    i += 1
  }
  if (!['launch', 'run'].includes(out.stage) || !validAssistantId(out.assistant) || !out.home) return null
  return out
}

/** Start the run stage out of this process tree; the first command that starts wins. */
function launch({ assistant, home }) {
  for (const cmd of unboundRunStageCommands({ platform: process.platform, execPath: process.execPath, helperPath: HERE, assistantId: assistant, home })) {
    if (cmd.how === 'systemd-run') {
      const res = spawnSync(cmd.file, cmd.args, { stdio: 'ignore', timeout: 15_000 })
      if (res.status === 0) return 0
      continue
    }
    try {
      const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
      if (child.pid) return 0
    } catch {
      // the next command, or none
    }
  }
  return 1
}

/** The live hoai launcher of this agent (its supervisor.json pid, proven the writer), or null. */
function readLauncher(home, assistant) {
  const row = listAgents({ home, includeIds: [assistant] }).find((a) => a.assistantId === assistant)
  if (!row?.launcherLive) return null
  const record = parseSupervisorFile(nodeFs().readFile(supervisorPath(home, assistant)))
  return record ? { pid: record.pid, supervisor: row.supervisor } : null
}

async function run({ assistant, home }) {
  const logDir = joinDir(agentDir(home), REMOVED_DIR_NAME)
  const logPath = joinDir(logDir, `${assistant}-unbound.log`)
  const log = (line) => {
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      // a log that cannot be written never stops the cleanup
    }
  }
  log(`agent ${assistant} was deleted in HOAI; removing what it left on this computer (pid ${process.pid})`)
  const report = await cleanUpUnboundAgent({
    platform: process.platform,
    home,
    assistantId: assistant,
    fs: nodeFs(),
    exec: nodeExec(),
    bgosAgentBin: join(PLUGIN_ROOT, 'bin', 'bgos-agent'),
    readLauncher: () => readLauncher(home, assistant),
    pidAlive: defaultPidAlive,
    log,
  })
  log(report.ok ? `agent ${assistant}: done` : `agent ${assistant}: done, with the problems above`)
  return report.ok ? 0 : 1
}

function isRunAsMain() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return realpathSync(HERE) === realpathSync(argv1)
  } catch {
    return import.meta.url === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    process.stderr.write('usage: hoai-agent-unbound.mjs --stage launch|run --assistant <id> --home <HOME>\n')
    process.exit(2)
  }
  if (args.stage === 'launch') process.exit(launch(args))
  else run(args).then((code) => process.exit(code), () => process.exit(1))
}

export { parseArgs }
