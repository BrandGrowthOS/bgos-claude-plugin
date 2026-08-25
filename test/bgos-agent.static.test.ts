/**
 * Static invariants for bin/bgos-agent, the installer + always-on supervisor.
 *
 * Same rationale as bootstrap-sh.static.test.ts: the script is bash and cannot
 * be unit tested the way the .mjs engines are, so these tests pin its contract
 * surface against the source text instead.
 *
 * The invariant this file exists for is the channel spec, because getting it
 * wrong is the worst failure this repo has: the agent starts, `claude mcp list`
 * says Connected, and not one inbound message is ever delivered. Silence, under
 * a supervisor that keeps restarting it (2026-08-21).
 *
 * `server:<name>` names a channel that comes from an MCP SERVER ENTRY;
 * `plugin:<plugin>@<marketplace>` names one that comes from a marketplace
 * plugin. bgos-agent does not guess which world it is in, it GUARANTEES it:
 * cmd_install refuses to continue without a workspace .mcp.json, it writes that
 * file itself, and both supervisors run claude with WorkingDirectory set to
 * that workspace. So the emitted spec must be `server:` plus the name of the
 * server that this same script writes. Those are two strings in two places, a
 * hundred lines apart, in two different languages (bash and an inline bun -e
 * script). That is exactly the shape that drifts, and drift here is silent.
 *
 * Run: npm test, or npx tsx --test test/bgos-agent.static.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLONE_CHANNEL_SPEC, MARKETPLACE_CHANNEL_SPEC } from '../bin/bgos-install-method.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentPath = join(repoRoot, 'bin', 'bgos-agent')
const sh = readFileSync(agentPath, 'utf8')

/** Source with every full-line `#` comment removed, so an assertion about what
 *  the script EMITS is never satisfied (or tripped) by prose explaining it. */
const code = sh
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

test('bash parses the script cleanly (bash -n)', (t) => {
  const check = spawnSync('bash', ['-n', agentPath], { encoding: 'utf8', timeout: 60_000 })
  if (check.error && (check.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('bash is not installed on this machine')
    return
  }
  assert.strictEqual(check.status, 0, `bash -n errors: ${check.stdout} ${check.stderr}`)
})

test('no em dashes or en dashes anywhere in the script', () => {
  // Code points spelled numerically so this test file stays free of the
  // characters it bans (U+2014 em dash, U+2013 en dash).
  assert.ok(!sh.includes(String.fromCharCode(0x2014)), 'found an em dash')
  assert.ok(!sh.includes(String.fromCharCode(0x2013)), 'found an en dash')
})

// ── The channel-spec invariant ───────────────────────────────────────────────

/** The single MCP server name declaration: MCP_SERVER_NAME="bgos" */
function declaredServerName(): string {
  const match = /^MCP_SERVER_NAME="([^"]+)"$/m.exec(code)
  assert.ok(match, 'bin/bgos-agent must declare MCP_SERVER_NAME once, at the top')
  return match![1]!
}

/** The MCP server key the inline `bun -e` writer actually puts in .mcp.json. */
function writtenServerKey(): string {
  const match = /const cfg = \{ mcpServers: \{ \[e\.(\w+)\]:/.exec(code)
  assert.ok(
    match,
    'write_mcp_json must build mcpServers with a COMPUTED key, so the name has one source',
  )
  return match![1]!
}

test('the default channel spec is server:<the very server this script writes>', () => {
  const name = declaredServerName()

  // 1. The default spec is built from that name, never retyped.
  assert.ok(
    /^DEFAULT_CHANNEL="server:\$MCP_SERVER_NAME"$/m.test(code),
    'DEFAULT_CHANNEL must be built from $MCP_SERVER_NAME, not spelled out again',
  )

  // 2. The .mcp.json writer uses the SAME variable, passed through the env of
  //    the inline bun script. This is the half that used to be a bare literal.
  assert.strictEqual(writtenServerKey(), 'BGOS_MCP_NAME')
  assert.ok(
    /BGOS_MCP_NAME="\$MCP_SERVER_NAME"/.test(code),
    'the bun writer must receive $MCP_SERVER_NAME, so both halves move together',
  )

  // 3. And the resulting spec is the one the rest of the repo agrees on.
  assert.strictEqual(`server:${name}`, CLONE_CHANNEL_SPEC)
})

test('no marketplace spec is ever emitted by this script', () => {
  // If this ever fires, someone has "fixed" the constant into detection. Read
  // the comment block above DEFAULT_CHANNEL first: this script launches claude
  // in a workspace whose .mcp.json it controls, so the marketplace spec names a
  // channel that does not exist there, and the agent goes silently deaf.
  assert.ok(
    !code.includes(MARKETPLACE_CHANNEL_SPEC),
    `bin/bgos-agent must not emit ${MARKETPLACE_CHANNEL_SPEC}: it launches into a workspace .mcp.json`,
  )
})

test('the clone spec literal appears nowhere in the code, only via the variable', () => {
  // The whole point of MCP_SERVER_NAME: one source. A second hand typed
  // `server:bgos` is how the two halves drift apart in the first place.
  assert.ok(
    !code.includes(CLONE_CHANNEL_SPEC),
    `bin/bgos-agent must not hand type ${CLONE_CHANNEL_SPEC}; build it from $MCP_SERVER_NAME`,
  )
})

test('every consumer of the channel takes the resolved value, never the constant', () => {
  // cmd_install resolves once, honouring --channel, and both consumers (the
  // human hint and the generated run.expect) take that resolved value.
  assert.ok(
    /local channel="\$\{CHANNEL:-\$DEFAULT_CHANNEL\}"/.test(code),
    '--channel must still be able to override the default',
  )
  assert.ok(
    /say_launch_hint "\$workdir" "\$channel"/.test(code),
    'the foreground hint must print the RESOLVED channel',
  )
  assert.ok(
    /write_run_expect "\$statedir\/run\.expect" "\$statedir" "\$claude_bin" "\$channel"/.test(code),
    'the supervisor must spawn with the RESOLVED channel',
  )
  // The spawn line itself interpolates the argument, never a literal.
  assert.ok(
    /spawn "\$3" \$\{cont\}--dangerously-skip-permissions --dangerously-load-development-channels "\$4"/.test(
      code,
    ),
    'run.expect must spawn with the passed channel argument',
  )
})

test('the approved-sounding --channels flag is never used', () => {
  // Verified live on 2.1.239: `--channels` loads a marketplace plugin's tools
  // promptlessly, `claude mcp list` even says Connected, and it wires NO
  // inbound delivery for a channel that is not on Anthropic's allowlist. It is
  // a third silent-drop vector. See bin/bgos-install-method.mjs launchFlagArgs.
  assert.ok(
    !/(^|[^-])--channels\b/.test(code),
    'bin/bgos-agent must use --dangerously-load-development-channels, never --channels',
  )
})

// ── The .mcp.json gate that makes the invariant true ─────────────────────────

test('install refuses to proceed without a workspace .mcp.json', () => {
  // This gate is load bearing for the spec above: it is what guarantees the
  // session has a `bgos` MCP server to load. If it is ever relaxed so the
  // supervisor can be installed for a workspace with no .mcp.json, the spec
  // stops being correct by construction and this whole file needs rethinking.
  assert.ok(
    /die "no \.mcp\.json in \$workdir and no creds given/.test(code),
    'cmd_install must die when the workspace has no .mcp.json and no creds were given',
  )
})

test('both supervisors run claude in the workspace, which is what loads that .mcp.json', () => {
  assert.ok(/<key>WorkingDirectory<\/key><string>\$x_wd<\/string>/.test(code), 'launchd plist')
  assert.ok(/^WorkingDirectory=\$workdir$/m.test(code), 'systemd unit')
})
