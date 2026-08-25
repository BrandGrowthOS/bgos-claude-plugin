/**
 * Sandbox for the zero-terminal lifecycle tests: a throwaway HOME and
 * CLAUDE_CONFIG_DIR under the OS temp dir plus a runner that spawns the
 * scripted fake CLI (test/fixtures/fake-claude.mjs) as a real child process
 * with the sandbox environment. Nothing here touches the real ~/.claude.
 *
 *   const sandbox = makeSandbox()
 *   sandbox.writeScenario({ state: { version: '0.38.3' } })
 *   const result = await runClaudeCli(installArgs(), { runner: cliRunnerFor(sandbox) })
 *   sandbox.readCallLog()   // every fake invocation, in order
 *   sandbox.cleanup()
 *
 * Paths are built with node:path so they are valid on Windows and posix.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { spawnCollect, type CliRunner } from '../../lib/plugin-cli.mjs'
import {
  CALL_LOG_FILE,
  configPaths,
  defaultMarketplaceJson,
  writeInstalledFiles,
  writeJson,
  writeMarketplaceFiles,
} from '../fixtures/fake-claude.mjs'

/** Absolute path of the fake CLI script. */
export const FAKE_CLAUDE_PATH = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))

export type FakeOutcome = 'success' | 'failure' | 'garbage' | 'hang' | 'success_wrong_version'

export interface FakeClaudeCommand {
  outcome?: FakeOutcome
  code?: number
  stdout?: string
  stderr?: string
  delayMs?: number
  version?: string
}

export interface FakeClaudeState {
  version?: string
  nextVersion?: string | null
  wrongVersion?: string
  marketplaceJson?: Record<string, unknown>
}

export interface FakeClaudeScenario {
  commands?: Record<string, FakeClaudeCommand>
  default?: FakeClaudeCommand
  state?: FakeClaudeState
}

export interface CallLogEntry {
  at: string
  argv: string[]
  outcome: FakeOutcome
  delayMs: number
}

export interface Sandbox {
  /** The temp root everything lives under. */
  root: string
  /** Fake HOME / USERPROFILE. */
  home: string
  /** Fake CLAUDE_CONFIG_DIR. */
  configDir: string
  /** Where writeScenario writes (FAKE_CLAUDE_SCENARIO points here). */
  scenarioPath: string
  /** The env overlay the fake CLI needs (HOME, USERPROFILE, CLAUDE_CONFIG_DIR, FAKE_CLAUDE_SCENARIO). */
  env: Record<string, string>
  /** The config dir file layout, as the fake CLI computes it. */
  paths: ReturnType<typeof configPaths>
  /** Write (or replace) the scenario; returns its path. */
  writeScenario(scenario: FakeClaudeScenario): string
  /** Every fake CLI invocation so far, oldest first. */
  readCallLog(): CallLogEntry[]
  /** Parse a JSON file under the sandbox (absolute path). */
  readJson<T = unknown>(path: string): T
  /** Register the marketplace declaring `version`, as `marketplace add` would. */
  seedMarketplace(version: string, marketplaceJson?: Record<string, unknown>): void
  /** Install `version`, as `plugin install` would (cache dir + entry + enabledPlugins). */
  seedInstalled(version: string, opts?: { enabled?: boolean }): string
  /**
   * Write (or rewrite) a local DIRECTORY marketplace under the sandbox root
   * declaring `version` (source = file:// url, as the E2E marketplace does)
   * and return its path, for `claude plugin marketplace add <dir>`.
   */
  writeLocalMarketplace(version: string): string
  /** Remove the temp root. Safe to call twice. */
  cleanup(): void
}

/** Create a fresh sandbox. */
export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'hoai-sandbox-'))
  const home = join(root, 'home')
  const configDir = join(root, 'claude-config')
  const scenarioPath = join(root, 'scenario.json')
  mkdirSync(home, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const env = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDir,
    FAKE_CLAUDE_SCENARIO: scenarioPath,
  }
  const paths = configPaths(configDir)
  return {
    root,
    home,
    configDir,
    scenarioPath,
    env,
    paths,
    writeScenario(scenario) {
      writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`)
      return scenarioPath
    },
    readCallLog() {
      const logPath = join(configDir, CALL_LOG_FILE)
      if (!existsSync(logPath)) return []
      return readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as CallLogEntry)
    },
    readJson<T>(path: string): T {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    },
    seedMarketplace(version, marketplaceJson) {
      writeMarketplaceFiles(configDir, { version, marketplaceJson })
    },
    seedInstalled(version, opts) {
      return writeInstalledFiles(configDir, version, opts)
    },
    writeLocalMarketplace(version) {
      const dir = join(root, 'local-marketplace')
      const url = pathToFileURL(join(root, 'plugin.git')).href
      writeJson(join(dir, '.claude-plugin', 'marketplace.json'), defaultMarketplaceJson(version, { url }))
      return dir
    },
    cleanup() {
      // Windows can hold a handle for a moment after a child exits.
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

/**
 * A runClaudeCli runner that executes the fake CLI (node + the fixture
 * script) with the sandbox environment layered over the runner's env (and
 * `env` overrides layered over that), using the same spawn/collect/timeout
 * machinery as the real default runner.
 */
export function cliRunnerFor(sandbox: Sandbox, { env = {} }: { env?: Record<string, string> } = {}): CliRunner {
  return (args, opts) =>
    spawnCollect(process.execPath, [FAKE_CLAUDE_PATH, ...args], {
      env: { ...opts.env, ...sandbox.env, ...env },
      timeoutMs: opts.timeoutMs,
    })
}
