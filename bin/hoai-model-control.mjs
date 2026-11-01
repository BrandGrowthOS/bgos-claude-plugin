#!/usr/bin/env node
/**
 * hoai-model-control: the owner's own switch for remote model and effort
 * control of one agent (Route A). Run on the agent's machine:
 *
 *   hoai-model-control on     --assistant <id>   turn it on for that agent
 *   hoai-model-control off    --assistant <id>   turn it off again
 *   hoai-model-control status --assistant <id>   say which it is
 *
 * `on` is the whole consent: it records the opt in AND puts the status line
 * bridge in front of the owner's status line in Claude Code's user settings
 * ($CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json), keeping
 * the owner's own line, which the bridge still runs and prints. `off` for the
 * last agent that had it on puts the owner's line back. The compact permission
 * does not count, and nothing on the wire can turn this on.
 *
 * A running session reads the new status line on its own; the daemon starts
 * offering control once the bridge's first observation lands.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bridgeInstalled,
  installBridge,
  listOptedIn,
  modelControlDir,
  readOptIn,
  uninstallBridge,
  writeBridgeCopy,
  writeOptIn,
} from '../lib/model-control-store.mjs'

const USAGE = 'usage: hoai-model-control on|off|status --assistant <agent id>'

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

const [verb, ...rest] = process.argv.slice(2)
const at = rest.indexOf('--assistant')
const assistantId = at >= 0 ? rest[at + 1] : undefined
if (!['on', 'off', 'status'].includes(verb ?? '') || !assistantId || !/^[A-Za-z0-9_-]{1,64}$/.test(assistantId)) {
  console.error(USAGE)
  process.exit(2)
}

const dir = modelControlDir()
const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
const settingsPath = join(configDir, 'settings.json')
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

if (verb === 'on') {
  // The status line runs a stable copy of the bridge in the owner only
  // folder, so a plugin update that moves this file does not break it.
  const bridgePath = writeBridgeCopy(dir, pluginRoot)
  const bridgeCommand = `${shellQuote(process.execPath)} ${shellQuote(bridgePath)}`
  const out = installBridge({ settingsPath, dir, bridgeCommand })
  if (!out.installed) {
    console.error(`Not turned on: ${out.reason}. The settings file was left as it is.`)
    process.exit(1)
  }
  writeOptIn(dir, assistantId, true, Date.now())
  console.log(
    `Remote model and effort control is on for agent ${assistantId}. ` +
      `The status line bridge is in ${settingsPath}` +
      (out.wrapped ? ', and your own status line still runs behind it.' : '.'),
  )
} else if (verb === 'off') {
  writeOptIn(dir, assistantId, false, Date.now())
  let note = ''
  if (listOptedIn(dir).length === 0) {
    const out = uninstallBridge({ settingsPath, dir })
    note = out.removed ? ' The status line bridge is removed and your own status line is back.' : ''
  }
  console.log(`Remote model and effort control is off for agent ${assistantId}.${note}`)
} else {
  const on = readOptIn(dir, assistantId)
  const bridge = bridgeInstalled(settingsPath)
  console.log(
    `Remote model and effort control is ${on ? 'on' : 'off'} for agent ${assistantId}; ` +
      `the status line bridge is ${bridge ? '' : 'not '}installed in ${settingsPath}.`,
  )
}
