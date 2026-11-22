#!/usr/bin/env node
/**
 * hoai-model-control: the owner's own switch for remote model and effort
 * control of one agent (Route A). Run on the agent's machine:
 *
 *   hoai-model-control on     --assistant <id> [--folder <path>]   turn it on for that agent
 *   hoai-model-control off    --assistant <id> [--folder <path>]   turn it off again
 *   hoai-model-control status --assistant <id> [--folder <path>]   say which it is
 *
 * The Helper's agent launcher turns it on by itself when it starts the agent
 * (lib/model-control-store.mjs ensureHelperModelControl), so `on` is only for
 * doing it now, or after an `off`. `on` records the opt in AND puts the status
 * line bridge in that agent's OWN folder settings
 * (<folder>/.claude/settings.local.json), keeping the line that file would
 * hide (its own, else the owner's project or user line), which the bridge
 * still runs and prints. The shared ~/.claude/settings.json is never written,
 * by any verb: an older version's bridge left there is named, for the owner
 * to remove, and the file is left as it is. A folder that is the home folder
 * is refused (its .claude is Claude Code's own). `off` is remembered (the
 * Helper never turns it on again) and puts the line back. The folder is --folder, else the one the agent was last launched in
 * (~/.bgos-agent/<id>/launch.json); with neither, `on` refuses rather than
 * guess. Nothing on the wire can turn this on.
 *
 * A running session reads the new status line on its own; the daemon starts
 * offering control once the bridge's first observation lands.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bridgeInstalled,
  ensureHelperModelControl,
  isHomeFolder,
  modelControlDir,
  readOptIn,
  readWrappedStatusLine,
  uninstallAgentBridge,
  writeOptIn,
} from '../lib/model-control-store.mjs'

const USAGE = 'usage: hoai-model-control on|off|status --assistant <agent id> [--folder <agent folder>]'

const [verb, ...rest] = process.argv.slice(2)
const flag = (name) => {
  const at = rest.indexOf(name)
  return at >= 0 ? rest[at + 1] : undefined
}
const assistantId = flag('--assistant')
if (!['on', 'off', 'status'].includes(verb ?? '') || !assistantId || !/^[A-Za-z0-9_-]{1,64}$/.test(assistantId)) {
  console.error(USAGE)
  process.exit(2)
}

// A `~` the shell did not turn into a home folder (quoted, or passed on by a program), alone, as
// `~/...` or as `~name`, would be a folder named so under wherever this runs, and `on` would create
// it there. Any folder that starts with `~` is refused.
const folderArg = flag('--folder')
if (folderArg !== undefined && folderArg.startsWith('~')) {
  console.error(
    `The folder ${folderArg} starts with ~, which was not turned into your home folder. ` +
      'Give the full path, for example --folder "$HOME/my-agent". Nothing was changed.',
  )
  process.exit(2)
}

/** The folder the agent was last launched in, from its launch recipe, or null. */
function recipeFolder(id) {
  try {
    const recipe = JSON.parse(readFileSync(join(homedir(), '.bgos-agent', id, 'launch.json'), 'utf8'))
    return recipe && typeof recipe.cwd === 'string' && recipe.cwd !== '' ? recipe.cwd : null
  } catch {
    return null
  }
}

const home = homedir()
const dir = modelControlDir()
const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
// Read only: never written by this command.
const sharedSettingsPath = join(configDir, 'settings.json')
const folder = folderArg || recipeFolder(assistantId)
const atHome = folder ? isHomeFolder(folder, home, configDir, process.platform) : false
const settingsPath = folder && !atHome ? join(folder, '.claude', 'settings.local.json') : null
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const NOT_ON = {
  own_status_line:
    'Not turned on: on Windows your own status line would stop printing behind the bridge. Nothing was changed.',
  unquotable_path:
    'Not turned on: the path to node or to the bridge has a character the status line shell would change. Nothing was changed.',
  settings_unreadable: `Not turned on: ${settingsPath} is not plain JSON, so it was left as it is.`,
  home_folder:
    `Not turned on: ${folder} is your home folder. Its .claude folder holds Claude Code's own settings for every ` +
    'session on this computer, so nothing is written there. Run the agent in a folder of its own. Nothing was changed.',
}

/** An older version's bridge in the shared user settings, named for the owner to remove; the file is never changed here. */
function olderSharedBridgeNote() {
  if (!bridgeInstalled(sharedSettingsPath)) return ''
  const own = readWrappedStatusLine(dir)
  return (
    ` An older version left its status line bridge in ${sharedSettingsPath}. You can remove it from that file yourself:` +
    ` take out its "statusLine" entry${own ? `, or put your own line back (it was: ${own.command})` : ''}.` +
    ' This command did not change that file.'
  )
}

if (verb === 'on' && !folder) {
  console.error(
    `Not turned on: this computer has no record of where agent ${assistantId} runs. ` +
      'Run it again with --folder <the agent\'s folder>. Nothing was changed.',
  )
  process.exit(1)
} else if (verb === 'on') {
  // The same steps the Helper takes when it starts the agent (the status line
  // runs a stable copy of the bridge in the owner only folder, so a plugin
  // update that moves this file does not break it), and it undoes an `off`.
  const out = ensureHelperModelControl({
    cwd: folder,
    assistantId,
    dir,
    pluginRoot,
    nodePath: process.execPath,
    platform: process.platform,
    configDir,
    nowMs: Date.now(),
    owner: true,
    home,
  })
  if (!out.on) {
    console.error(NOT_ON[out.reason] ?? 'Not turned on. Nothing was changed.')
    process.exit(1)
  }
  console.log(`Remote model and effort control is on for agent ${assistantId}. The status line bridge is in ${settingsPath}, for this agent only.`)
} else if (verb === 'off') {
  writeOptIn(dir, assistantId, false, Date.now(), { home })
  // Only the agent's own folder file is written; a home folder's is Claude Code's own and left alone.
  const out = settingsPath ? uninstallAgentBridge({ settingsPath, dir, assistantId }) : { removed: false }
  const note = (out.removed ? ' The status line bridge is removed from this agent\'s folder.' : '') + olderSharedBridgeNote()
  console.log(`Remote model and effort control is off for agent ${assistantId}; the Helper will not turn it on again.${note}`)
} else {
  const on = readOptIn(dir, assistantId)
  const where = atHome
    ? 'its folder is your home folder, where nothing is written.'
    : settingsPath
      ? `the status line bridge is ${bridgeInstalled(settingsPath) ? '' : 'not '}installed in ${settingsPath}.`
      : 'this computer has no record of where the agent runs (give --folder).'
  console.log(`Remote model and effort control is ${on ? 'on' : 'off'} for agent ${assistantId}; ${where}`)
}
