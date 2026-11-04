#!/usr/bin/env node
/**
 * hoai-attach-scope: read this computer's attach scope tally (board row
 * bab90cdb, design BGOS #1244, lib/attach-scope.mjs). The measurement to take
 * BEFORE flipping the setting: how many session starts each mode would have
 * refused, and why.
 *
 *   node <plugin>/bin/hoai-attach-scope.mjs [--days N] [--json]
 *
 * Reads only: the events file under the plugin state dir
 * (BGOS_PLUGIN_STATE_DIR, else ~/.bgos-plugin-state) and the setting
 * (HOAI_ATTACH_SCOPE_MODE, else ~/.bgos-agent/attach-scope.json). Writes nothing.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detectInstallMethod } from './bgos-install-method.mjs'

import {
  ATTACH_SCOPE_SETTINGS_FILE,
  effectiveAttachScopeMode,
  formatAttachScopeSummary,
  readAttachScopeEvents,
  resolveAttachScopeMode,
  summarizeAttachScopeEvents,
} from '../lib/attach-scope.mjs'

const DAY_MS = 24 * 3600_000

export function main(argv = process.argv.slice(2), { env = process.env, home = homedir(), write = (s) => process.stdout.write(s), now = Date.now() } = {}) {
  let days = 7
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') json = true
    else if (argv[i] === '--days') {
      const n = Number(argv[i + 1])
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write('hoai-attach-scope: --days needs a positive number\n')
        return 2
      }
      days = n
      i += 1
    } else {
      process.stderr.write('usage: hoai-attach-scope [--days N] [--json]\n')
      return 2
    }
  }
  const dir = String(env.BGOS_PLUGIN_STATE_DIR ?? '').trim() || join(home, '.bgos-plugin-state')
  const setting = resolveAttachScopeMode({
    env,
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch (err) {
        if (err?.code === 'ENOENT') return null
        throw err
      }
    },
    settingsPath: join(home, '.bgos-agent', ATTACH_SCOPE_SETTINGS_FILE),
  })
  const installMethod = detectInstallMethod({ scriptPath: fileURLToPath(import.meta.url), env, home }).method
  const mode = effectiveAttachScopeMode(setting, installMethod)
  const summary = summarizeAttachScopeEvents(readAttachScopeEvents({ dir }), { now, windowMs: days * DAY_MS })
  write(json ? `${JSON.stringify({ mode, setting, installMethod, summary, eventsDir: dir }, null, 2)}\n`
    : `${formatAttachScopeSummary(summary, mode)}; setting ${setting.mode} (${setting.source}); install ${installMethod}\n`)
  return 0
}

/** Run as a script (through a symlink too), never on import. */
function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  process.exitCode = main()
}
