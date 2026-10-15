#!/usr/bin/env node
/**
 * hoai-agent-service: what bin/bgos-agent (bash) asks about an agent's own
 * service before it acts on it (board row d6198bb6, mission 154 goal 8), so
 * the installer judges a registration with the SAME code the watcher does
 * (lib/agent-service.mjs, #237's reader and judge in lib/watcher-service.mjs)
 * instead of a second copy in bash.
 *
 *   home-id --os <Darwin|Linux>
 *       The `home-<hid>` id of $HOME (#237's watcherHomeId): every agent
 *       service name carries it. One line, 8 hex characters.
 *   probe --assistant <id> --which own|legacy --os <Darwin|Linux> [--uid <n>]
 *       Read this agent's service back, read only (`launchctl print
 *       gui/<uid>/<label>`, `systemctl --user show <unit>` and the unit file
 *       the user manager loaded), under this HOME's own name or the OLD one
 *       (0.69.2 and earlier), and judge it against $HOME. Lines:
 *         state=own|absent|foreign|unknown
 *         home=<the HOME it records, or empty>
 *         active=1|0
 *         label=<the name read>
 *         say=<the sentence to report: why this HOME's name is refused, or
 *             why the old one is left alone; empty when there is nothing to say>
 *
 * Exit 0 whenever it answered (a refusal is an answer), 2 on a usage error.
 * Plain JavaScript, node >= 18 or bun, builtins only.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { agentHomeId, agentServiceNamesFor, validAssistantId } from '../lib/agent-inventory.mjs'
import { agentLeftAlone, posixAgentServiceSpec, readBackAgentService } from '../lib/agent-service.mjs'
import { nodeExec, nodeFs } from '../lib/watcher-bundle.mjs'

const PLATFORMS = Object.freeze({ Darwin: 'darwin', Linux: 'linux' })

function flags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i])
    if (m) out[m[1]] = argv[i + 1] ?? ''
    if (m) i += 1
  }
  return out
}

const oneLine = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ').trim()

export async function main(argv = process.argv.slice(2), { env = process.env, exec = nodeExec(), fs = nodeFs(), out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`), uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  const [command, ...rest] = argv
  const f = flags(rest)
  const platform = PLATFORMS[f.os]
  const home = String(env.HOME ?? '')
  if (!platform || !home.trim()) {
    err('hoai-agent-service: --os Darwin|Linux and a HOME are required')
    return 2
  }
  if (command === 'home-id') {
    out(agentHomeId(home, platform))
    return 0
  }
  if (command === 'probe') {
    const id = validAssistantId(f.assistant)
    const which = f.which
    if (!id || (which !== 'own' && which !== 'legacy')) {
      err('hoai-agent-service: probe --assistant <digits> --which own|legacy')
      return 2
    }
    const names = agentServiceNamesFor(id, home, platform)
    const side = which === 'own' ? names.current : names.legacy
    const handle = platform === 'darwin' ? side.launchdLabel : side.systemdUnit
    const uidValue = f.uid !== undefined && /^\d+$/.test(f.uid) ? Number(f.uid) : uid
    const read = await readBackAgentService({ platform, home, assistantId: id, uid: uidValue, handle }, { exec, fs })
    // The old name: what a caller says when it leaves it alone (#237's wording).
    const spec = { ...posixAgentServiceSpec({ platform, home, assistantId: id }), label: names.current[platform === 'darwin' ? 'launchdLabel' : 'systemdUnit'] }
    const say = which === 'own' ? read.refusal ?? '' : agentLeftAlone(spec, read).join('; ')
    out(`state=${read.state}`)
    out(`home=${oneLine(read.home ?? '')}`)
    out(`active=${read.artifacts?.some((a) => a.active) ? 1 : 0}`)
    out(`label=${handle}`)
    out(`say=${oneLine(say)}`)
    return 0
  }
  err('hoai-agent-service: home-id | probe')
  return 2
}

// Real paths on both sides: bgos-agent may call this through an aliased home (bin/hoai-select-claude.mjs's rule).
function isRunAsMain() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1)
  } catch {
    return import.meta.url === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`hoai-agent-service: ${String(error?.message ?? error)}\n`)
      process.exit(1)
    },
  )
}
