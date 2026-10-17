#!/usr/bin/env node
/**
 * hoai-lane: the person lanes command (shared agents Phase 3, P3).
 *
 *   hoai-lane run    --assistant <id> --lane <userId>
 *       Supervise one person's lane until it stops (lib/lane-supervisor.mjs).
 *       The owner's daemon starts this, detached, on a `lane_wake`; it is not
 *       meant to be typed.
 *   hoai-lane login  --assistant <id> --lane <userId> --mode inherit|own_token
 *       Choose whose Claude sign in that person's lane uses (decision K2):
 *       `inherit` (the default) signs in exactly as the agent does;
 *       `own_token` uses the person's own long lived token from the credential
 *       store, and never the agent's.
 *   hoai-lane token set   --assistant <id> --lane <userId>    (token on stdin)
 *   hoai-lane token clear --assistant <id> --lane <userId>
 *       Keep or remove that person's token in the operating system's
 *       credential store. The token is read from standard input, never argv,
 *       and is never printed.
 *   hoai-lane status --assistant <id>
 *       The lanes running for an agent, each share's login mode, and whether a
 *       token is stored (yes or no, never the token).
 *
 * No em or en dashes in this file.
 */
import { appendFileSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { claudeCandidates } from '../lib/claude-binary.mjs'
import { findOnPath } from '../lib/lane-cli-probe.mjs'
import {
  isSafeAssistantId,
  isSafeLaneUserId,
  LANE_LOGIN_MODES,
  lanePaths,
  peopleDirOf,
} from '../lib/lane-core.mjs'
import { laneTokenStore, readLoginModes, writeLoginMode } from '../lib/lane-login.mjs'
import { readRegistry } from '../lib/lane-registry.mjs'
import { superviseLane } from '../lib/lane-supervisor.mjs'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export function parseLaneArgs(argv) {
  const out = { command: argv[0] ?? '', sub: '', flags: {} }
  let i = 1
  if (out.command === 'token') {
    out.sub = argv[1] ?? ''
    i = 2
  }
  for (; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        out.flags[arg.slice(2)] = value
        i += 1
      } else {
        out.flags[arg.slice(2)] = ''
      }
    }
  }
  return out
}

function fail(message, code = 1) {
  process.stderr.write(`hoai-lane: ${message}\n`)
  return code
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

export async function main(argv = process.argv.slice(2), { env = process.env, home = env.HOME || homedir(), platform = process.platform } = {}) {
  const args = parseLaneArgs(argv)
  const assistantId = args.flags.assistant
  const userId = args.flags.lane
  if (!['run', 'login', 'token', 'status'].includes(args.command)) {
    process.stdout.write('usage: hoai-lane run|login|token set|token clear|status --assistant <id> [--lane <userId>]\n')
    return args.command === '' || args.command === 'help' ? 0 : 1
  }
  if (!isSafeAssistantId(assistantId)) return fail('--assistant must be the agent\'s id')

  if (args.command === 'status') {
    const registry = readRegistry(join(home, '.bgos-agent', 'lanes-machine.json'))
    const modes = readLoginModes(join(peopleDirOf({ home, assistantId, platform }), 'login-modes.json'))
    const store = laneTokenStore({ platform, fileStoreDir: (a, u) => lanePaths({ home, assistantId: a, userId: u, stateRoot: env.BGOS_PLUGIN_STATE_DIR, platform }).stateDir })
    const running = registry.lanes.filter((l) => String(l.assistantId) === String(assistantId))
    const people = new Set([...running.map((l) => l.userId), ...Object.keys(modes)])
    process.stdout.write(`agent ${assistantId}: ${running.length} lane(s) running\n`)
    for (const person of people) {
      const mode = modes[person] ?? 'inherit'
      const token = mode === 'own_token' ? (store.read(String(assistantId), person).ok ? 'stored' : 'MISSING') : 'n/a'
      const live = running.some((l) => l.userId === person) ? 'running' : 'stopped'
      process.stdout.write(`  ${person}: ${live}, login ${mode}, token ${token}\n`)
    }
    return 0
  }

  if (!isSafeLaneUserId(userId)) return fail('--lane must be the person\'s user id')
  const paths = lanePaths({ home, assistantId, userId, stateRoot: env.BGOS_PLUGIN_STATE_DIR, platform })

  if (args.command === 'login') {
    const mode = args.flags.mode
    if (!LANE_LOGIN_MODES.includes(mode)) return fail(`--mode must be one of ${LANE_LOGIN_MODES.join(', ')}`)
    writeLoginMode(paths.loginModesPath, userId, mode)
    process.stdout.write(`${userId}'s lane on agent ${assistantId} now signs in with: ${mode}\n`)
    if (mode === 'own_token') {
      const store = laneTokenStore({ platform, fileStoreDir: () => paths.stateDir })
      if (!store.read(String(assistantId), userId).ok) {
        process.stdout.write('No token is stored for this person yet: their lane will not start, and they will be told, until one is added with `hoai-lane token set`.\n')
      }
    }
    return 0
  }

  if (args.command === 'token') {
    const store = laneTokenStore({ platform, fileStoreDir: () => paths.stateDir })
    if (args.sub === 'set') {
      const token = await readStdin()
      try {
        store.write(String(assistantId), userId, token)
      } catch (err) {
        return fail(String(err?.message ?? err))
      }
      process.stdout.write(`Stored ${userId}'s token for agent ${assistantId} in the ${store.kind} store.\n`)
      return 0
    }
    if (args.sub === 'clear') {
      process.stdout.write(store.remove(String(assistantId), userId) ? 'Removed.\n' : 'Nothing was stored.\n')
      return 0
    }
    return fail('token takes set or clear')
  }

  // run
  const log = (line) => {
    try {
      appendFileSync(paths.launcherLogPath, `${new Date().toISOString()} [supervisor ${process.pid}] ${line}\n`, { mode: 0o600 })
    } catch { /* best effort */ }
  }
  const backendUrl = String(env.BGOS_BACKEND_URL ?? '').trim()
  if (!/^https?:\/\//.test(backendUrl)) {
    log('no BGOS_BACKEND_URL; cannot start a lane')
    return fail('BGOS_BACKEND_URL is required')
  }
  const claudePath = claudeCandidates({ pathVar: env.PATH ?? '', home })[0] ?? findOnPath('claude', { pathVar: env.PATH ?? '' })
  if (!claudePath) {
    log('no claude binary found')
    return fail('no claude binary found')
  }
  const nodePath = findOnPath('node', { pathVar: env.PATH ?? '' }) ?? process.execPath
  // A signal to the supervisor stops the lane cleanly (the watch loop sees
  // the request and stops Claude), never orphans it.
  const askStop = (reason) => {
    try {
      mkdirSync(paths.laneDir, { recursive: true, mode: 0o700 })
      const tmp = `${paths.stopRequestPath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ reason, at: new Date().toISOString(), by: 'supervisor' })}\n`, { mode: 0o600 })
      renameSync(tmp, paths.stopRequestPath)
    } catch { /* the lane still stops at idle */ }
  }
  process.on('SIGTERM', () => askStop('requested'))
  process.on('SIGINT', () => askStop('requested'))
  process.on('SIGHUP', () => {})
  const result = await superviseLane({
    assistantId: String(assistantId),
    userId,
    home,
    ownerEnv: env,
    backendUrl,
    pluginRoot: PLUGIN_ROOT,
    nodePath,
    claudePath,
    platform,
    log,
  })
  log(`supervisor done: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`)
  return 0
}

function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  const code = await main()
  process.exit(code)
}
