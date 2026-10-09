/**
 * Is this daemon's channel loaded (0.63.2, assistant 873)?
 *
 * Proven 2026-10-09 on macOS with Claude Code 2.1.295: the MCP initialize
 * request is identical for a channel server and a plain one, and only the
 * claude command line (`--channels` / `--dangerously-load-development-channels`)
 * tells them apart. These tests pin the parser, the decision table, the
 * ancestry walk over a fake ps, and (on posix) the real walk through a real
 * process named claude.
 *
 * Run with:  npx tsx --test test/channel-presence.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  CHANNEL_FLAGS,
  decideChannelLoaded,
  isClaudeCommandLine,
  parseChannelSpecs,
  probeChannelLoaded,
  readFullCommand,
  specMatches,
} from '../lib/channel-presence.ts'

// 873's real launch line (kc-server, 2026-10-09), session id elided.
const LAUNCH_873 =
  'claude --resume 0b6f1c2e-0000-4000-8000-000000000873 --dangerously-skip-permissions ' +
  '--dangerously-load-development-channels server:bgos'
const PLUGIN_SPEC = 'plugin:hoai@hoai'
const CLONE_SPEC = 'server:bgos'

// ── parseChannelSpecs ──────────────────────────────────────────────────────────

test('both channel flags are recognised', () => {
  assert.deepEqual([...CHANNEL_FLAGS], ['--channels', '--dangerously-load-development-channels'])
})

test('parseChannelSpecs reads 873s launch line', () => {
  assert.deepEqual(parseChannelSpecs(LAUNCH_873), ['server:bgos'])
})

test('parseChannelSpecs: variadic values stop at the next flag, both flags add up', () => {
  assert.deepEqual(
    parseChannelSpecs('claude --channels plugin:hoai@hoai plugin:tg@x --model opus --dangerously-load-development-channels server:a'),
    ['plugin:hoai@hoai', 'plugin:tg@x', 'server:a'],
  )
})

test('parseChannelSpecs: the --flag=value form carries one value', () => {
  assert.deepEqual(parseChannelSpecs('claude --channels=plugin:hoai@hoai --x'), ['plugin:hoai@hoai'])
})

test('parseChannelSpecs: no channel flag, nothing listed; an argv array works too', () => {
  assert.deepEqual(parseChannelSpecs('claude --resume abc'), [])
  assert.deepEqual(parseChannelSpecs(['claude', '--channels', 'server:bgos']), ['server:bgos'])
  assert.deepEqual(parseChannelSpecs(''), [])
})

// ── specMatches ───────────────────────────────────────────────────────────────

test('specMatches: exact, and a bare plugin name matches any marketplace', () => {
  assert.equal(specMatches('plugin:hoai@hoai', PLUGIN_SPEC), true)
  assert.equal(specMatches('plugin:hoai', PLUGIN_SPEC), true)
  assert.equal(specMatches('plugin:hoai@other', PLUGIN_SPEC), false)
  assert.equal(specMatches('server:bgos', CLONE_SPEC), true)
  assert.equal(specMatches('server:bgos2', CLONE_SPEC), false)
  assert.equal(specMatches('plugin:hoai', CLONE_SPEC), false)
})

// ── decideChannelLoaded: the table ──────────────────────────────────────────────

const TABLE: Array<{ name: string; ownSpec: string; command: string | null; loaded: boolean | null }> = [
  { name: '873 clone: server:bgos listed', ownSpec: CLONE_SPEC, command: LAUNCH_873, loaded: true },
  { name: '873 plugin: only server:bgos listed', ownSpec: PLUGIN_SPEC, command: LAUNCH_873, loaded: false },
  { name: 'plugin loaded via --channels', ownSpec: PLUGIN_SPEC, command: 'claude --channels plugin:hoai@hoai', loaded: true },
  { name: 'clone, session loads only the plugin', ownSpec: CLONE_SPEC, command: 'claude --channels plugin:hoai@hoai', loaded: false },
  { name: 'no channel flag at all', ownSpec: PLUGIN_SPEC, command: 'claude --resume x', loaded: false },
  { name: 'clone, no channel flag at all', ownSpec: CLONE_SPEC, command: 'claude --resume x --model opus', loaded: false },
  { name: 'a bare claude, argv possibly hidden by a title rewrite', ownSpec: PLUGIN_SPEC, command: 'claude', loaded: null },
  { name: 'a bare claude path, same', ownSpec: CLONE_SPEC, command: '/home/karim/.local/bin/claude', loaded: null },
  { name: 'clone, another server name listed: cannot tell', ownSpec: CLONE_SPEC, command: 'claude --dangerously-load-development-channels server:bgos-dev', loaded: null },
  { name: 'install not identified', ownSpec: '', command: LAUNCH_873, loaded: null },
  { name: 'claude command not readable', ownSpec: PLUGIN_SPEC, command: null, loaded: null },
]

for (const row of TABLE) {
  test(`decideChannelLoaded: ${row.name} -> ${row.loaded}`, () => {
    const out = decideChannelLoaded({ ownSpec: row.ownSpec, claudeCommand: row.command })
    assert.equal(out.loaded, row.loaded)
    assert.equal(typeof out.reason, 'string')
    assert.ok(out.reason.length > 0)
  })
}

// ── isClaudeCommandLine ────────────────────────────────────────────────────────

test('isClaudeCommandLine: native, versioned native, npm cli.js; not a log tail', () => {
  assert.equal(isClaudeCommandLine(LAUNCH_873), true)
  assert.equal(isClaudeCommandLine('/home/karim/.local/bin/claude --resume x'), true)
  assert.equal(isClaudeCommandLine('/Users/a/.local/share/claude/versions/2.1.295 --channels x'), true)
  assert.equal(isClaudeCommandLine('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --channels x'), true)
  assert.equal(isClaudeCommandLine('tail -f /tmp/claude.log'), false)
  assert.equal(isClaudeCommandLine('bun /home/karim/bgos-claude-plugin/server.ts'), false)
  assert.equal(isClaudeCommandLine(null), false)
})

// ── readFullCommand / probeChannelLoaded over a fake ps ─────────────────────────

/** A fake `ps` for a process table: answers `-o ppid=` and `-o command=`. */
function fakePs(table: Record<number, { ppid: number; command: string }>) {
  const calls: string[][] = []
  const execSync = (file: string, args: string[]) => {
    calls.push([file, ...args])
    const pid = Number(args[args.length - 1])
    const row = table[pid]
    if (file !== 'ps' || !row) return { code: 1, stdout: '' }
    if (args.includes('ppid=')) return { code: 0, stdout: `${row.ppid}\n` }
    if (args.includes('command=')) return { code: 0, stdout: `${row.command}\n` }
    return { code: 1, stdout: '' }
  }
  return { execSync, calls }
}

// 873's tree: the plugin's server.ts sits under bgos-launch.mjs; the clone's
// server.ts is claude's direct child.
const TREE_873 = {
  3732258: { ppid: 3732250, command: 'bun /home/karim/.claude/plugins/cache/hoai/hoai/0.62.3/server.ts' },
  3732250: { ppid: 3732200, command: 'node /home/karim/.claude/plugins/cache/hoai/hoai/0.62.3/bin/bgos-launch.mjs /home/karim/.claude/plugins/cache/hoai/hoai/0.62.3/server.ts' },
  3732285: { ppid: 3732200, command: 'bun /home/karim/bgos-claude-plugin/server.ts' },
  3732200: { ppid: 3732100, command: LAUNCH_873 },
  3732100: { ppid: 1, command: '-bash' },
}

test('readFullCommand asks ps for the WIDE command line (-ww), so a long launch line is not cut', () => {
  const ps = fakePs(TREE_873)
  assert.equal(readFullCommand(3732200, ps.execSync), LAUNCH_873)
  assert.deepEqual(ps.calls[0], ['ps', '-ww', '-o', 'command=', '-p', '3732200'])
  assert.equal(readFullCommand(1, ps.execSync), null)
  assert.equal(readFullCommand(999, ps.execSync), null)
})

test('probeChannelLoaded on 873s tree: the plugin daemon is false, the clone is true', () => {
  const ps = fakePs(TREE_873)
  const plugin = probeChannelLoaded({ platform: 'linux', ownPid: 3732258, ownSpec: PLUGIN_SPEC, execSync: ps.execSync })
  const clone = probeChannelLoaded({ platform: 'linux', ownPid: 3732285, ownSpec: CLONE_SPEC, execSync: ps.execSync })
  assert.equal(plugin.loaded, false)
  assert.equal(clone.loaded, true)
})

test('probeChannelLoaded fails open: Windows, no claude above, no identity, a throwing exec', () => {
  const ps = fakePs(TREE_873)
  assert.equal(probeChannelLoaded({ platform: 'win32', ownPid: 3732285, ownSpec: CLONE_SPEC, execSync: ps.execSync }).loaded, null)
  assert.equal(probeChannelLoaded({ platform: 'linux', ownPid: 3732100, ownSpec: CLONE_SPEC, execSync: ps.execSync }).loaded, null)
  assert.equal(probeChannelLoaded({ platform: 'linux', ownPid: 3732285, ownSpec: '', execSync: ps.execSync }).loaded, null)
  const boom = () => {
    throw new Error('ps exploded')
  }
  assert.equal(probeChannelLoaded({ platform: 'darwin', ownPid: 3732285, ownSpec: CLONE_SPEC, execSync: boom }).loaded, null)
})

// ── The real walk: a real process named claude, a real child daemon ─────────────

const REPO = fileURLToPath(new URL('..', import.meta.url))

test('real processes: a child under a process named claude reads that claude command line', { skip: process.platform === 'win32' ? 'ps based; Windows fails open by design' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'chan-presence-'))
  try {
    // A node binary reachable under the name `claude`, so ps shows argv0
    // `<dir>/claude` exactly as it shows the native binary.
    const fakeClaude = join(dir, 'claude')
    symlinkSync(process.execPath, fakeClaude)
    const child = join(dir, 'daemon.ts')
    const lib = pathToFileURL(join(REPO, 'lib', 'channel-presence.ts')).href
    const execMod = pathToFileURL(join(REPO, 'lib', 'service-supervision.mjs')).href
    writeFileSync(
      child,
      `import { probeChannelLoaded } from ${JSON.stringify(lib)}\n` +
        `import { defaultExecSync } from ${JSON.stringify(execMod)}\n` +
        `const spec = process.argv[2]\n` +
        `process.stdout.write(JSON.stringify(probeChannelLoaded({ platform: process.platform, ownPid: process.pid, ownSpec: spec, execSync: defaultExecSync })))\n`,
    )
    const parent = join(dir, 'session.mjs')
    writeFileSync(
      parent,
      `import { spawnSync } from 'node:child_process'\n` +
        `const out = []\n` +
        `for (const spec of ['server:bgos', 'plugin:hoai@hoai']) {\n` +
        `  const r = spawnSync(${JSON.stringify(process.execPath)}, ['--import', 'tsx', ${JSON.stringify(child)}, spec], { cwd: ${JSON.stringify(REPO)}, encoding: 'utf8' })\n` +
        `  out.push(r.stdout || ('ERR ' + r.stderr))\n` +
        `}\n` +
        `process.stdout.write(JSON.stringify(out))\n`,
    )
    const run = spawnSync(
      fakeClaude,
      [parent, '--resume', 'abc', '--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:bgos'],
      { cwd: REPO, encoding: 'utf8', timeout: 60_000 },
    )
    assert.equal(run.status, 0, run.stderr)
    const [clone, plugin] = (JSON.parse(run.stdout) as string[]).map((s) => JSON.parse(s))
    assert.equal(clone.loaded, true, clone.reason)
    assert.equal(plugin.loaded, false, plugin.reason)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
