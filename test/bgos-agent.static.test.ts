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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLONE_CHANNEL_SPEC, HOAI_PLUGIN_NAME, MARKETPLACE_CHANNEL_SPEC } from '../bin/bgos-install-method.mjs'
import { assertBashParses, bashOrSkip } from './helpers/posix-bash.ts'

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
  // Git for Windows' bash on Windows, never the WSL launcher (test/helpers/posix-bash.ts).
  const bash = bashOrSkip(t)
  if (!bash) return
  assertBashParses(bash, agentPath)
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
  // human hint and the supervisor) take that resolved value.
  assert.ok(
    /local channel="\$\{CHANNEL:-\$DEFAULT_CHANNEL\}"/.test(code),
    '--channel must still be able to override the default',
  )
  assert.ok(
    /say_launch_hint "\$workdir" "\$channel"/.test(code),
    'the foreground hint must print the RESOLVED channel',
  )
  // Supervisor generation 2 types no channel at all: it runs hoai, which
  // resolves the folder's channel itself at every launch (workspace .mcp.json
  // first, then the install it is started from). What the RESOLVED channel
  // still decides is which plugin root run.sh starts hoai from: a marketplace
  // channel names its own install record, anything else is this checkout.
  assert.match(
    code,
    /case "\$channel" in\n\s+plugin:\*\) topology="marketplace"; plugin_key="\$\{channel#plugin:\}" ;;\n\s+\*\)\s+topology="clone" ;;\n\s+esac/,
  )
  assert.match(
    code,
    /write_run_sh "\$statedir\/run\.sh" "\$statedir" "\$ASSISTANT_ID" "\$node_bin" "\$topology" "\$plugin_key" "\$PLUGIN_DIR"/,
  )
  // And no supervisor line spells a channel flag of its own any more.
  assert.doesNotMatch(code, /spawn .*--dangerously-load-development-channels/)
  assert.doesNotMatch(code, /^write_run_expect\(\)/m, 'run.expect is no longer generated')
})

test('generation 2 is stamped on every always-on install, with the grace stamp (fact 3), and run.sh runs hoai under HOAI_SUPERVISED', () => {
  // `code` has its comment lines stripped, so the section is anchored on its first statement.
  const section = code.slice(code.indexOf('info "Installing always-on supervisor'), code.indexOf('cmd_link >/dev/null 2>&1 || true'))
  assert.ok(section.length > 0)
  // Unconditional: at the function's own indentation, not inside an if.
  assert.match(section, /^  date \+%s > "\$statedir\/installed-at"$/m)
  assert.match(section, /^  printf '%s\\n' "\$SUPERVISOR_GENERATION" > "\$statedir\/supervisor-generation"$/m)
  assert.match(code, /^SUPERVISOR_GENERATION=2$/m)
  // node is required for an always-on install, before anything is written; tmux only warned about.
  assert.match(code, /if \[ "\$\{ALWAYS_ON:-\}" = "1" \]; then\n(?:\s*#.*\n)*\s*command -v node >\/dev\/null 2>&1 \\\n\s*\|\| die "supervisor:node-not-found/)
  assert.match(code, /command -v tmux >\/dev\/null 2>&1 \\\n\s*\|\| warn "tmux not found: the agent will run without it and remote compact will be OFF/)
  const runSh = code.slice(code.indexOf('write_run_sh() {'), code.indexOf("\nSH\n", code.indexOf('write_run_sh() {')))
  assert.match(runSh, /HOAI_SUPERVISED=1/)
  assert.match(runSh, /"\$node_bin" "\$root\/bin\/hoai-core\.mjs"/)
  assert.match(runSh, /trap on_stop TERM INT HUP/)
})

test('run.sh\'s pruned-checkout fallback looks for the plugin by the name the install-method reader uses, and never types a marketplace spec', () => {
  const runSh = code.slice(code.indexOf('write_run_sh() {'), code.indexOf("\nSH\n", code.indexOf('write_run_sh() {')))
  const names = [...runSh.matchAll(/k\.slice\(0, k\.lastIndexOf\("@"\)\) === "([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(names, [HOAI_PLUGIN_NAME])
  assert.ok(!runSh.includes(MARKETPLACE_CHANNEL_SPEC))
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

/**
 * `bgos-agent update` re-registers a clone workspace's hook entries before
 * the restart (P2 stage 6, the plugin review).
 *
 * THE REVIEW: the CLI reads a clone's hooks only from the workspace settings
 * file, and only install wrote it, so an always on agent installed at 0.48.0
 * and updated to 0.53.0 restarted `claude` with no floor entry at all: no
 * request is ever raised for a listed action under full access, and the
 * unattended agent was the one with no floor. The daemon no longer declares
 * hard_floor without the hook (lib/floor-hook-presence.ts); this is the half
 * that gives the updated agent the hook.
 *
 * MUTATION PROOF (applied to bin/bgos-agent, confirmed red, restored): the
 * `refresh_hook_entries "$id"` line removed from restart_after_update -> this
 * case red, 2 of 10 with the baseline Windows red (bash -n) beside it.
 */
test('update re-registers a clone workspace\'s hooks (the floor hook included) before it restarts the agent', () => {
  const restart = sh.slice(sh.indexOf('restart_after_update() {'), sh.indexOf('\n}\n', sh.indexOf('restart_after_update() {')))
  assert.match(restart, /^restart_after_update\(\) \{ # \$1 assistant id\n  local id="\$1"\n  refresh_hook_entries "\$id"\n/)
  const refresh = sh.slice(sh.indexOf('refresh_hook_entries() {'), sh.indexOf('\n}\n', sh.indexOf('refresh_hook_entries() {')))
  assert.ok(refresh.length > 0, 'refresh_hook_entries is defined')
  // The workspace is read off the service each supervisor was installed with.
  assert.match(refresh, /sed -n 's\/\^WorkingDirectory=\/\/p' "\$service_file"/)
  assert.match(refresh, /<key>WorkingDirectory<\/key><string>/)
  // Only a workspace that already carries the rail, so a marketplace channel is left alone.
  assert.match(refresh, /grep -q 'hoai-hook\\\.mjs' "\$settings"/)
  assert.match(refresh, /install_hook_entries "\$workdir" "\$PLUGIN_DIR"/)
  // And ensureHookEntries is what writes the floor entry beside the forwarder.
  const writer = sh.slice(sh.indexOf('install_hook_entries() {'), sh.indexOf('\n}\n', sh.indexOf('install_hook_entries() {')))
  assert.match(writer, /m\.ensureHookEntries\(\{/)
})

test('the README documents supervisor generation 2, with every supervised exit code hoai really uses, and no longer describes run.expect', async () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  const start = readme.indexOf('### What the always-on service runs (supervisor generation 2)')
  assert.ok(start >= 0, 'the section exists')
  const section = readme.slice(start, readme.indexOf('\n## ', start))
  for (const needle of ['tmux -L hoai-<id>', 'claude --resume', 'session-id', 'BGOS_TMUX_SESSION=hoai-<id>', 'compact=off reason=no-tmux', 'hoai-agent attach --assistant <id>', '`hoai --keep-alive`', '`HOAI_SERVICE_NAMESPACE`', 'install already in progress', 'supervisor-generation']) {
    assert.ok(section.includes(needle), `the section says ${needle}`)
  }
  // One table row per supervised exit, numbered by hoai's own constants and named by its outcomes.
  const core = await import('../bin/hoai-core.mjs')
  const rows: Array<[number, RegExp]> = [
    [core.EXIT_UNATTENDED_NEEDS_PERSON, /`identity-conflict`/],
    [core.EXIT_SUPERVISED_IDENTITY_MISMATCH, /`identity-mismatch`/],
    [core.EXIT_SUPERVISED_NO_EXPECT, /`expect-missing`/],
    [core.EXIT_SUPERVISED_GATE, /`gate-unrecognised`/],
    [core.EXIT_SUPERVISED_STARTUP_EXIT, /`exited-during-startup`/],
    [core.EXIT_SUPERVISED_SIGNED_OUT, /`live-but-not-signed-in`/],
  ]
  assert.deepEqual(rows.map(([code]) => code), [6, 7, 8, 9, 10, 11])
  for (const [code, outcome] of rows) {
    const row = section.split('\n').find((l) => l.startsWith(`| ${code} |`))
    assert.ok(row, `a row for exit ${code}`)
    assert.match(row!, outcome)
  }
  // The generation 1 description is gone, from the README and from the gate block's header.
  assert.doesNotMatch(readme, /auto-accepts the\s+two `--dangerously-\*` prompts/)
  assert.doesNotMatch(readme, /`run\.expect` behaviour tests/)
  const gateHeader = readFileSync(join(repoRoot, 'lib', 'gate-block.tcl'), 'utf8').split('\n').filter((l) => l.startsWith('#')).join('\n')
  assert.doesNotMatch(gateHeader, /copies it into the supervisor's\s*#?\s*run\.expect/)
  assert.doesNotMatch(gateHeader, /which run\.expect derives/)
})
