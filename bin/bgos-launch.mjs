#!/usr/bin/env node
/**
 * bgos-launch: node launch shim for the plugin's bun MCP server.
 *
 * Why it exists: .claude-plugin/plugin.json used to launch the MCP server with
 * a bare `bun` command. On a machine where bun is installed but NOT on the
 * PATH Claude Code captured at launch, that spawn died with a silent ENOENT
 * and the channel simply never connected (real failure, 2026-08-21). node is
 * always present (Claude Code runs on it), so the manifest launches THIS shim
 * with node, and the shim finds bun in the places a stale PATH misses, then
 * spawns it with the exact argv it was given.
 *
 * Probe order, first hit wins:
 *   1. $BUN_INSTALL/bin/bun   (the installer's own env var)
 *   2. <home>/.bun/bin/bun    (the installer's default location)
 *   3. every PATH entry, joined with bun
 * then the same three again for bunx as a last resort. On win32 the .exe
 * names are probed alongside the bare ones (some shims ship without .exe).
 *
 * When nothing resolves, the user gets a plain install hint on stderr and
 * exit 127. A raw ENOENT stack is never the user-visible error.
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports from
 * the TS plugin sources. Import-safe: every helper is exported and main() only
 * runs when the file is executed directly, so tests can import the pure pieces.
 */

import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 as win32Path, posix as posixPath } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

/** POSIX convention for "command not found"; scripts and humans both read it. */
export const LAUNCH_EXIT_NOT_FOUND = 127

/** Exit codes for a child that died on a signal (128 + signal number). */
export const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
})

// ── Small pure helpers ───────────────────────────────────────────────────────

/** The node:path flavor for a platform, so tests exercise both on one OS. */
export function pathFlavor(platform) {
  return platform === 'win32' ? win32Path : posixPath
}

/**
 * The executable names to probe for a tool on a platform. win32 gets the .exe
 * name first (the canonical shape) AND the bare name (some shims exist without
 * .exe); everything else gets only the bare name.
 */
export function executableNames(tool, platform) {
  return platform === 'win32' ? [`${tool}.exe`, tool] : [tool]
}

/**
 * Find a runnable bun (or, failing that, bunx) without trusting PATH alone.
 *
 * Returns { path, via } where via names which probe hit:
 *   'bun-install' | 'home' | 'path' for bun,
 *   'bunx-install' | 'bunx-home' | 'bunx-path' for the bunx fallback.
 * Returns null when nothing exists anywhere.
 *
 * Pure given its inputs: env, home, platform, and the exists probe are all
 * injectable, and path joining/splitting uses the node:path flavor for the
 * REQUESTED platform, so tests can exercise win32 and posix on one OS.
 * pathSeparator overrides the flavor's PATH delimiter only when a test needs
 * a nonstandard one.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   pathSeparator?: string,
 * }} [opts]
 * @returns {{ path: string, via: string } | null}
 */
export function resolveBunPath({
  env = {},
  home = '',
  platform = process.platform,
  exists = existsSync,
  pathSeparator,
} = {}) {
  const p = pathFlavor(platform)
  const delimiter = pathSeparator ?? p.delimiter
  const tools = [
    { tool: 'bun', vias: { install: 'bun-install', home: 'home', path: 'path' } },
    { tool: 'bunx', vias: { install: 'bunx-install', home: 'bunx-home', path: 'bunx-path' } },
  ]
  for (const { tool, vias } of tools) {
    /** @type {Array<{ dir: string, via: string }>} */
    const dirs = []
    const bunInstall = String(env.BUN_INSTALL ?? '').trim()
    if (bunInstall) dirs.push({ dir: p.join(bunInstall, 'bin'), via: vias.install })
    const homeDir = String(home ?? '').trim()
    if (homeDir) dirs.push({ dir: p.join(homeDir, '.bun', 'bin'), via: vias.home })
    for (const entry of String(env.PATH ?? '').split(delimiter)) {
      const dir = entry.trim()
      if (dir) dirs.push({ dir, via: vias.path })
    }
    for (const { dir, via } of dirs) {
      for (const name of executableNames(tool, platform)) {
        const candidate = p.join(dir, name)
        if (exists(candidate)) return { path: candidate, via }
      }
    }
  }
  return null
}

/** The one-line install command for a platform, straight from bun.sh. */
export function bunInstallHint(platform) {
  return platform === 'win32'
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : 'curl -fsSL https://bun.sh/install | bash'
}

/**
 * The full stderr message shown when bun cannot be found. It names bun, says
 * why the plugin needs it, gives the exact install command, and tells the user
 * that both bun and bunx must be on PATH afterwards. This message is the whole
 * user-visible error; a raw ENOENT never is.
 */
export function missingBunMessage(platform) {
  return [
    '[bgos-launch] bun was not found on this machine (checked BUN_INSTALL, ~/.bun/bin, and every PATH entry, for both bun and bunx).',
    '[bgos-launch] The HOAI channel plugin runs its MCP server with bun, so it cannot start until bun is installed.',
    '[bgos-launch] Install it with:',
    `[bgos-launch]   ${bunInstallHint(platform)}`,
    '[bgos-launch] After installing, make sure both bun and bunx are on the PATH of the process that starts Claude Code, then restart Claude Code.',
  ].join('\n')
}

/**
 * The cwd for the spawned bun. When the first arg is the server entry
 * (ends with server.ts), bun runs from the directory containing it, because
 * bun auto-installs the server's dependencies relative to cwd. Any other argv
 * shape (a wrapper .mjs with flags) keeps the inherited cwd.
 * @param {readonly string[]} argv
 * @returns {string | undefined}
 */
export function resolveLaunchCwd(argv, platform = process.platform) {
  const first = String(argv?.[0] ?? '')
  if (!first.endsWith('server.ts')) return undefined
  return pathFlavor(platform).dirname(first)
}

/** Map a child's (code, signal) exit to this process's exit code. */
export function exitCodeForChild(code, signal) {
  if (signal) return SIGNAL_EXIT_CODES[signal] ?? 1
  return code ?? 1
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * Resolve bun and hand it the exact argv this shim received. Resolves with the
 * exit code this process should report: the child's own code (128 + n when it
 * died on a signal), or 127 with the install hint on stderr when bun cannot be
 * found or spawned.
 * @param {string[]} [argv]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   spawnImpl?: typeof spawn,
 *   writeErr?: (text: string) => void,
 *   onSignal?: (signal: string, handler: () => void) => void,
 * }} [opts]
 * @returns {Promise<number>}
 */
export function main(argv = process.argv.slice(2), opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  const exists = opts.exists ?? existsSync
  const spawnImpl = opts.spawnImpl ?? spawn
  const writeErr = opts.writeErr ?? ((text) => process.stderr.write(text))
  const onSignal = opts.onSignal ?? ((signal, handler) => process.on(signal, handler))

  return new Promise((resolve) => {
    const resolved = resolveBunPath({ env, home, platform, exists })
    if (!resolved) {
      writeErr(`${missingBunMessage(platform)}\n`)
      resolve(LAUNCH_EXIT_NOT_FOUND)
      return
    }
    const cwd = resolveLaunchCwd(argv, platform)
    // Carry the ORIGINAL working directory across the relocation.
    //
    // 2026-08-27: relocating cwd (so bun can resolve the server's dependencies)
    // silently broke the folder pin for every marketplace install. Claude Code
    // launches us as `node bgos-launch.mjs <plugin>/server.ts`, so the server's
    // process.cwd() became the PLUGIN CACHE directory, and the identity lookup
    // read `<plugin>/.bgos-agent-id` instead of the user's own folder. The pin
    // could never be found, and the refusal then told the user to create the
    // very file it had just made unreadable. A partner did exactly that, twice,
    // correctly, and lost an evening to it.
    //
    // We could not simply stop relocating: the relocation is what makes bun
    // resolve dependencies. So the original directory travels in the
    // environment, which survives the switch, and the server prefers it for
    // the pin lookup only. Everything else still runs from the plugin dir.
    const child = spawnImpl(resolved.path, argv, {
      stdio: 'inherit',
      ...(cwd ? { cwd } : {}),
      ...(cwd
        ? { env: { ...env, BGOS_LAUNCH_CWD: env.BGOS_LAUNCH_CWD || process.cwd() } }
        : {}),
    })
    // Forward termination to the child so a stopped shim never strands a bun
    // process holding the MCP stdio pipes. Signal listeners do not hold the
    // event loop open, so the shim still exits when the child does.
    const forward = (signal) => {
      try {
        child.kill(signal)
      } catch {
        // already gone; nothing to forward to.
      }
    }
    onSignal('SIGTERM', () => forward('SIGTERM'))
    onSignal('SIGINT', () => forward('SIGINT'))
    child.on('error', (err) => {
      // A resolved path that still fails to spawn (EACCES, a broken install)
      // gets the same guidance as a missing bun, never a bare stack.
      writeErr(`[bgos-launch] could not start ${resolved.path}: ${err?.message ?? err}\n`)
      writeErr(`${missingBunMessage(platform)}\n`)
      resolve(LAUNCH_EXIT_NOT_FOUND)
    })
    child.on('exit', (code, signal) => {
      resolve(exitCodeForChild(code, signal))
    })
  })
}

/**
 * True when this file is the process entry point. Compares REAL paths on both
 * sides so a symlinked bin (npm/npx puts a shim in node_modules/.bin, and paths
 * under /tmp resolve through /private/tmp on macOS) still runs main(); a plain
 * href compare would fail those and silently do nothing.
 */
export function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`[bgos-launch] fatal: ${err?.message ?? err}`)
      process.exitCode = LAUNCH_EXIT_NOT_FOUND
    })
}
