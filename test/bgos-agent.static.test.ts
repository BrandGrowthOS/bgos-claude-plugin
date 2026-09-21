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
 * plugin. bgos-agent does not guess which world it is in, it GUARANTEES it (and,
 * since 2026-09-22, for a folder with NO .mcp.json it demands PROOF of the
 * paired marketplace topology from the shared resolver, or refuses):
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

test('install still refuses a workspace with no .mcp.json, unless the paired topology is PROVEN', () => {
  // This gate is load bearing for the spec above: it is what guarantees the
  // session has a `bgos` MCP server to load. It was relaxed ONCE, on purpose
  // (2026-09-22), and only like this: with no .mcp.json the install goes ahead
  // when `bgos-doctor --prove-paired-topology` proves the folder pin, the
  // agent credentials and the marketplace install record, and takes the channel
  // THE RESOLVER proved. Anything else still dies, with the old words first so
  // nobody mistakes it for a new failure. A deaf agent is worse than a refused
  // install (2026-08-21).
  assert.ok(
    /die "no \.mcp\.json in \$workdir and no creds given/.test(code),
    'cmd_install must still die when the workspace has no .mcp.json, no creds, and no proof',
  )
  const branch = code.slice(code.indexOf('elif [ ! -f "$mcp" ]; then'), code.indexOf('info "using existing $mcp'))
  assert.ok(branch.length > 0, 'the no-.mcp.json branch must exist')
  // The die is reached through a FAILED proof, and the channel is assigned from the proof and from nothing else.
  assert.match(branch, /if ! proven="\$\(prove_paired_topology "\$workdir" "\$ASSISTANT_ID"\)"; then\s*\n\s*die "no \.mcp\.json/)
  assert.deepEqual(branch.match(/^\s*channel=.*$/gm)?.map((l) => l.trim()), ['channel="$proven"'])
  // The guard must EXIST and come first. Comparing two indexOf results alone passed with the guard
  // deleted, because -1 is lower than anything (a mutation found that).
  const guardAt = branch.indexOf('valid_paired_channel "$proven" || die')
  assert.ok(guardAt >= 0, 'the proven spec must be validated')
  assert.ok(branch.indexOf('channel="$proven"') > guardAt, 'and validated BEFORE it is used')
  // node is resolved inside this arm too, before anything is written
  assert.match(branch, /paired_node_bin="\$\(command -v node \|\| true\)"\s*\n\s*\[ -n "\$paired_node_bin" \] \|\| die "paired-topology:node-not-found/)
  // An explicit --channel that disagrees with the proof is refused, never obeyed.
  assert.match(branch, /if \[ -n "\$\{CHANNEL:-\}" \] && \[ "\$CHANNEL" != "\$proven" \]; then\s*\n\s*die "paired-topology:channel-mismatch/)
})

test('the prover wrapper never guesses: only its own OK line is a proof, everything else is a refusal', () => {
  const start = code.indexOf('prove_paired_topology() {')
  assert.ok(start >= 0, 'prove_paired_topology must exist')
  // `code` has its comment lines stripped, so the function ends at its own closing brace.
  const fn = code.slice(start, code.indexOf('\n}\n', start) + 3)
  assert.match(fn, /bgos-doctor\.mjs" --prove-paired-topology --workdir "\$1" --assistant-id "\$2"/)
  // exactly one way to return 0, and it is the OK line
  assert.deepEqual(fn.match(/return 0/g)?.length, 1)
  assert.match(fn, /"HOAI_TOPOLOGY_OK "\*\)\s+printf '%s' "\$\{line#HOAI_TOPOLOGY_OK \}"; return 0 ;;/)
  // a prover that crashed, printed nothing, or printed something else is a named refusal too
  assert.match(fn, /paired-topology:prover-failed/)
  assert.match(fn, /return 1\n\}\n$/, 'and the function falls through to a refusal, never to a guess')
})

test('a workspace that DOES carry a .mcp.json takes exactly the path it always took', () => {
  // The ruling that allowed the relaxation above: clone-style folders must
  // behave exactly as they did. The two other arms of the same if are pinned
  // here word for word, and neither may mention the prover.
  const writes = code.slice(code.indexOf('if [ -n "${API_KEY:-}" ] && [ -n "${USER_ID:-}" ]; then'), code.indexOf('elif [ ! -f "$mcp" ]; then'))
  assert.match(writes, /write_mcp_json "\$mcp" "\$backend" "\$API_KEY" "\$USER_ID" "\$ASSISTANT_ID" "\$auto" "\$\{OPENAI_VOICE_KEY:-\}"/)
  assert.doesNotMatch(writes, /prove_paired_topology|proven/)
  const existing = code.slice(code.indexOf('  else\n    info "using existing $mcp'), code.indexOf('  if [ ! -f "$workdir/CLAUDE.md" ]'))
  assert.match(existing, /^  else\n    info "using existing \$mcp \(pass --key\/--user to regenerate\)"\n  fi\n$/)
  // and the default those two arms launch on is still the constant built from MCP_SERVER_NAME
  assert.ok(/local channel="\$\{CHANNEL:-\$DEFAULT_CHANNEL\}"/.test(code))
})

test('both supervisors run claude in the workspace, which is what loads that .mcp.json', () => {
  assert.ok(/<key>WorkingDirectory<\/key><string>\$x_wd<\/string>/.test(code), 'launchd plist')
  assert.ok(/^WorkingDirectory=\$workdir$/m.test(code), 'systemd unit')
})
